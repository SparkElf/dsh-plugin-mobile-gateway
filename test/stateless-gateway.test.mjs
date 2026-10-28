// Stateless entry relay tests.
//
// These run a real WebSocket upstream and a real proxy process. They cover the
// four properties the stateless migration promises:
//   1. history is read from the desktop when no cache is configured;
//   2. live traffic is forwarded in both directions;
//   3. authentication and split-channel headers reach the upstream unchanged;
//   4. a restart starts from zero and leaves no files behind.
//
// The optional in-memory cache is exercised separately: it must hit on a
// repeated immutable page, stay bounded, expire, and vanish on restart.

process.on('unhandledRejection', (error) => { console.error('unhandled:', error); process.exit(1) })
const guard = setTimeout(() => { console.error('test timed out'); process.exit(3) }, 120_000)

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')
const { WebSocketServer } = require('ws')

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin')
const PROXY = path.join(BIN, 'stateless-gateway.mjs')
const TOKEN = 'test-device-token'
const AUTH = 'Bearer ' + TOKEN
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stateless-'))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/**
 * A stand-in desktop gateway. It refuses any handshake without the test device
 * token, records what reached it, and answers history/live requests so the
 * proxy's forwarding can be observed end to end.
 */
function createUpstream() {
  const state = {
    handshakes: [],
    messages: [],
    historyRequests: 0,
    sockets: new Set(),
  }
  const server = http.createServer((_request, response) => { response.writeHead(404).end() })
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const protocol of protocols) if (protocol === 'dsh-mobile-v1') return protocol
      return false
    },
  })
  server.on('upgrade', (request, socket, head) => {
    state.handshakes.push({ url: request.url, headers: { ...request.headers } })
    const pairing = String(request.headers['sec-websocket-protocol'] ?? '').includes('dsh-pair.')
    if (request.headers.authorization !== AUTH && !pairing) {
      const body = JSON.stringify({ kind: 'error', code: 'unauthorized', message: 'pair first' })
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n'
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: ' + Buffer.byteLength(body) + '\r\n'
        + 'Connection: close\r\n\r\n'
        + body,
      )
      socket.end()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      state.sockets.add(ws)
      ws.on('close', () => state.sockets.delete(ws))
      ws.on('error', () => {})
      ws.on('message', (data) => {
        const text = data.toString('utf8')
        state.messages.push(text)
        let message
        try { message = JSON.parse(text) } catch { return }
        if (message?.type === 'history') {
          state.historyRequests += 1
          const seq = Number.isSafeInteger(message.beforeSeq) ? message.beforeSeq : 10
          const answer = JSON.stringify({
            kind: 'history',
            sessionId: message.sessionId,
            events: [{
              type: 'user/message',
              seq: Math.max(0, seq - 1),
              time: 1,
              data: { content: [{ type: 'text', text: 'page ' + String(seq) }] },
            }],
            cursor: seq,
            historyFormatVersion: Number.isSafeInteger(message.historyFormatVersion) ? message.historyFormatVersion : 3,
            view: message.view,
            hasMore: false,
          })
          // Optional test hook: let a test reorder two responses for the same Session.
          const delay = Number.isSafeInteger(message.testDelayMs) ? message.testDelayMs : 0
          if (delay > 0) setTimeout(() => ws.send(answer), delay)
          else ws.send(answer)
        } else if (message?.type === 'sessions') {
          ws.send(JSON.stringify({ kind: 'sessions', sessions: [] }))
        } else if (message?.type === 'message') {
          ws.send(JSON.stringify({
            kind: 'sent',
            sessionId: message.sessionId ?? 'new-session',
            mode: message.mode ?? 'queue',
          }))
        }
      })
    })
  })
  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    async close() {
      for (const ws of state.sockets) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    },
    broadcast(value) {
      for (const ws of state.sockets) if (ws.readyState === 1) ws.send(JSON.stringify(value))
    },
  }
}

async function waitHealth(port, timeout = 8_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return await response.json()
      lastError = new Error('health HTTP ' + String(response.status))
    } catch (error) {
      lastError = error
    }
    await sleep(50)
  }
  throw new Error('proxy did not become healthy: ' + String(lastError?.message ?? 'timeout'))
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 4_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

async function startProxy(upstreamPort, { cacheArgs = [], cwd = temp, env = {} } = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [
    PROXY,
    '--port', String(port),
    '--upstream', 'http://127.0.0.1:' + String(upstreamPort),
    '--upstream-host', 'dsh.tokensfree.eu.cc',
    ...cacheArgs,
  ], {
    cwd,
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: path.join(cwd, '.cache'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const health = await waitHealth(port).catch((error) => {
    child.kill('SIGKILL')
    throw new Error(error.message + '; stdout=' + stdout + '; stderr=' + stderr)
  })
  return {
    child,
    port,
    health,
    get stdout() { return stdout },
    get stderr() { return stderr },
    stop: () => stopChild(child),
  }
}

function connect(port, {
  headers = { authorization: AUTH, 'x-dsh-device-id': 'device-1', 'x-dsh-channel': 'conversation' },
  protocols = ['dsh-mobile-v1'],
} = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mobile`, protocols, { headers })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('connect timed out')) }, 6_000)
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('error', (error) => { clearTimeout(timer); reject(error) })
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      reject(new Error('unexpected HTTP ' + String(response.statusCode)))
    })
  })
}

function connectExpect401(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mobile`, ['dsh-mobile-v1'], { headers })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('401 wait timed out')) }, 6_000)
    ws.once('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    ws.once('open', () => { clearTimeout(timer); reject(new Error('expected the upstream to reject')) })
    ws.once('error', () => { /* consumed by unexpected-response on this path */ })
  })
}

function nextMessage(ws, predicate = () => true, timeout = 6_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('no matching frame')) }, timeout)
    const onMessage = (data) => {
      let message
      try { message = JSON.parse(data.toString('utf8')) } catch { return }
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onClose = () => { cleanup(); reject(new Error('closed before the expected frame')) }
    const onError = (error) => { cleanup(); reject(error) }
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function closeClient(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
    const timer = setTimeout(() => { ws.terminate(); resolve() }, 1_000)
    ws.once('close', () => { clearTimeout(timer); resolve() })
    ws.close()
  })
}

function historyRequest(sessionId, beforeSeq, extra = {}) {
  return JSON.stringify({
    type: 'history',
    sessionId,
    beforeSeq,
    historyFormatVersion: 3,
    view: 'conversation',
    ...extra,
  })
}

const upstream = createUpstream()
const upstreamPort = await upstream.listen()
const proxies = []
try {
  // ---------------------------------------------------------------------
  // 1. Default: no cache, history and live traffic both forwarded.
  // ---------------------------------------------------------------------
  const stateDir = fs.mkdtempSync(path.join(temp, 'state-'))
  const ignoredCacheRoot = path.join(stateDir, 'ignored-cache-root')
  const stateless = await startProxy(upstreamPort, {
    cwd: stateDir,
    env: { DSH_CACHE_ROOT: ignoredCacheRoot },
  })
  proxies.push(stateless)

  assert.equal(stateless.health.mode, 'stateless')
  assert.equal(stateless.health.cache.enabled, false)
  assert.equal(stateless.health.upstream.host, 'dsh.tokensfree.eu.cc')
  assert.equal(stateless.health.upstream.path, '/ws/mobile')

  const client = await connect(stateless.port)
  assert.equal(client.protocol, 'dsh-mobile-v1')

  const handshake = upstream.state.handshakes.at(-1)
  assert.equal(handshake.url, '/ws/mobile')
  assert.equal(handshake.headers.authorization, AUTH)
  assert.equal(handshake.headers['x-dsh-device-id'], 'device-1')
  assert.equal(handshake.headers['x-dsh-channel'], 'conversation')
  assert.equal(handshake.headers.host, 'dsh.tokensfree.eu.cc')
  assert.match(String(handshake.headers['sec-websocket-protocol']), /dsh-mobile-v1/)

  const baseRequests = upstream.state.historyRequests
  const firstAnswer = nextMessage(client, (message) => message.kind === 'history')
  client.send(historyRequest('session-a', 100))
  assert.equal((await firstAnswer).cursor, 100)
  assert.equal(upstream.state.historyRequests, baseRequests + 1, 'history reached the desktop')

  // Repeating the same immutable page is forwarded again: no cache is on by default.
  const secondAnswer = nextMessage(client, (message) => message.kind === 'history')
  client.send(historyRequest('session-a', 100))
  assert.equal((await secondAnswer).cursor, 100)
  assert.equal(upstream.state.historyRequests, baseRequests + 2, 'default mode never answers from a cache')

  // Upstream -> phone live event.
  const liveEvent = nextMessage(client, (message) => message.kind === 'event')
  upstream.broadcast({ kind: 'event', sessionId: 'session-a', seq: 101, time: 2, event: { type: 'user/message' } })
  assert.equal((await liveEvent).seq, 101)

  // Phone -> upstream live message.
  const sent = nextMessage(client, (message) => message.kind === 'sent')
  client.send(JSON.stringify({ type: 'message', sessionId: 'session-a', text: 'hello' }))
  assert.equal((await sent).kind, 'sent')
  assert.ok(
    upstream.state.messages.some((text) => {
      try { return JSON.parse(text).type === 'message' } catch { return false }
    }),
    'a live message reached the desktop',
  )

  await closeClient(client)
  assert.deepEqual(fs.readdirSync(stateDir), [], 'the stateless proxy wrote no files')
  assert.equal(fs.existsSync(ignoredCacheRoot), false, 'DSH_CACHE_ROOT is ignored rather than recreated')

  // ---------------------------------------------------------------------
  // 2. Authentication: refusal relayed, device/channel headers preserved.
  // ---------------------------------------------------------------------
  const rejected = await connectExpect401(stateless.port)
  assert.equal(rejected.status, 401)
  assert.match(rejected.body, /unauthorized/)
  const rejectedHandshake = upstream.state.handshakes.at(-1)
  assert.equal(rejectedHandshake.headers.authorization, undefined, 'no credential was invented by the proxy')

  const control = await connect(stateless.port, {
    headers: { authorization: AUTH, 'x-dsh-device-id': 'device-2', 'x-dsh-channel': 'control' },
  })
  assert.equal(control.protocol, 'dsh-mobile-v1')
  assert.equal(upstream.state.handshakes.at(-1).headers['x-dsh-channel'], 'control')
  assert.equal(upstream.state.handshakes.at(-1).headers['x-dsh-device-id'], 'device-2')
  await closeClient(control)

  // The first-pair subprotocol is part of the same handshake and must survive
  // the relay; the upstream is the one that decides whether the code is valid.
  const pairing = await connect(stateless.port, {
    protocols: ['dsh-mobile-v1', 'dsh-pair.test-code'],
    headers: { 'x-dsh-device-id': 'device-pair' },
  })
  assert.equal(pairing.protocol, 'dsh-mobile-v1')
  assert.match(
    String(upstream.state.handshakes.at(-1).headers['sec-websocket-protocol']),
    /dsh-mobile-v1,\s*dsh-pair\.test-code/,
  )
  await closeClient(pairing)

  await stateless.stop()
  assert.deepEqual(fs.readdirSync(stateDir), [], 'stopping the stateless proxy wrote no files')

  // ---------------------------------------------------------------------
  // 3. Opt-in memory cache: immutable pages hit, bounds hold, opening pages
  //    are never cached.
  // ---------------------------------------------------------------------
  const cacheDir = fs.mkdtempSync(path.join(temp, 'cache-state-'))
  const cached = await startProxy(upstreamPort, {
    cwd: cacheDir,
    cacheArgs: [
      '--memory-cache',
      '--memory-cache-ttl', '30',
      '--memory-cache-entries', '1',
      '--memory-cache-bytes', '1048576',
    ],
  })
  proxies.push(cached)
  assert.equal(cached.health.cache.enabled, true)

  const cachedClient = await connect(cached.port)
  const cacheBase = upstream.state.historyRequests

  const missOne = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(historyRequest('session-cache', 100))
  await missOne
  assert.equal(upstream.state.historyRequests, cacheBase + 1, 'first immutable page is a miss')

  const hitOne = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(historyRequest('session-cache', 100))
  assert.equal((await hitOne).cursor, 100)
  assert.equal(upstream.state.historyRequests, cacheBase + 1, 'the repeated immutable page came from memory')

  const healthAfterHit = await waitHealth(cached.port)
  assert.equal(healthAfterHit.cache.entries, 1)
  assert.ok(healthAfterHit.cache.hits >= 1)
  assert.ok(healthAfterHit.cache.bytes > 0)

  // A different beforeSeq is a different page, and maxEntries=1 evicts the old one.
  const differentPage = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(historyRequest('session-cache', 50))
  assert.equal((await differentPage).cursor, 50)
  assert.equal(upstream.state.historyRequests, cacheBase + 2)
  assert.equal((await waitHealth(cached.port)).cache.entries, 1, 'the cache stays bounded')

  // The mutable opening page (no beforeSeq) must always go upstream.
  const openingOne = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(JSON.stringify({ type: 'history', sessionId: 'session-cache', historyFormatVersion: 3 }))
  await openingOne
  const openingTwo = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(JSON.stringify({ type: 'history', sessionId: 'session-cache', historyFormatVersion: 3 }))
  await openingTwo
  assert.equal(upstream.state.historyRequests, cacheBase + 4, 'opening pages are never cached')

  // Two history requests for the same Session are in flight: the opening
  // response arrives first, the paged response later. The opening page must
  // not be stored under the paged request's key.
  const raceBase = upstream.state.historyRequests
  const openingRace = nextMessage(cachedClient, (message) => message.kind === 'history')
  const pagedRace = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(historyRequest('session-race', 100, { testDelayMs: 200 }))
  cachedClient.send(JSON.stringify({ type: 'history', sessionId: 'session-race', historyFormatVersion: 3 }))
  await Promise.all([openingRace, pagedRace])
  assert.equal(upstream.state.historyRequests, raceBase + 2)
  assert.equal((await waitHealth(cached.port)).cache.entries, 1, 'the racing responses were not cached')

  const raceRetry = nextMessage(cachedClient, (message) => message.kind === 'history')
  cachedClient.send(historyRequest('session-race', 100))
  await raceRetry
  assert.equal(upstream.state.historyRequests, raceBase + 3, 'the paged request was not answered from a mis-attributed entry')

  await closeClient(cachedClient)
  assert.deepEqual(fs.readdirSync(cacheDir), [], 'the in-memory cache wrote no files')
  await cached.stop()
  assert.deepEqual(fs.readdirSync(cacheDir), [], 'stopping the cached proxy still leaves no files')

  // ---------------------------------------------------------------------
  // 4. Restart clears the cache: the same page must reach the desktop again.
  // ---------------------------------------------------------------------
  const restarted = await startProxy(upstreamPort, {
    cwd: cacheDir,
    cacheArgs: [
      '--memory-cache',
      '--memory-cache-ttl', '30',
      '--memory-cache-entries', '8',
      '--memory-cache-bytes', '1048576',
    ],
  })
  proxies.push(restarted)
  const afterRestartBase = upstream.state.historyRequests
  const restartedClient = await connect(restarted.port)
  const afterRestart = nextMessage(restartedClient, (message) => message.kind === 'history')
  restartedClient.send(historyRequest('session-cache', 100))
  await afterRestart
  assert.equal(upstream.state.historyRequests, afterRestartBase + 1, 'a restart cannot answer from the previous process')

  // TTL: a short-lived page expires rather than becoming a long-term store.
  const ttlProxy = await startProxy(upstreamPort, {
    cwd: cacheDir,
    cacheArgs: [
      '--memory-cache',
      '--memory-cache-ttl', '0.4',
      '--memory-cache-entries', '8',
      '--memory-cache-bytes', '1048576',
    ],
  })
  proxies.push(ttlProxy)
  const ttlClient = await connect(ttlProxy.port)
  const ttlBase = upstream.state.historyRequests
  const ttlFirst = nextMessage(ttlClient, (message) => message.kind === 'history')
  ttlClient.send(historyRequest('session-ttl', 30))
  await ttlFirst
  await sleep(700)
  const ttlSecond = nextMessage(ttlClient, (message) => message.kind === 'history')
  ttlClient.send(historyRequest('session-ttl', 30))
  await ttlSecond
  assert.equal(upstream.state.historyRequests, ttlBase + 2, 'an expired page is fetched again')
  await closeClient(ttlClient)
  assert.deepEqual(fs.readdirSync(cacheDir), [], 'TTL cache still wrote no files')

  clearTimeout(guard)
  console.log('STATELESS GATEWAY TESTS PASSED: history, live, auth, no-persistence, bounded memory cache')
} finally {
  clearTimeout(guard)
  for (const proxy of proxies) {
    try { await proxy.stop() } catch { /* already stopped */ }
  }
  await upstream.close()
  fs.rmSync(temp, { recursive: true, force: true })
}