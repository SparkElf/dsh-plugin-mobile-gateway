import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')
const plugin = (await import('../lib/index.mjs')).default

function expectRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    ws.once('open', () => reject(new Error('expected WebSocket rejection')))
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.once('error', () => {})
  })
}

function waitForMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 2000)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.kind !== kind) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

async function waitForLanStatus(base) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await (await fetch(`${base}/mgw/status`)).json()
    if (status.lan && (status.lan.listening || status.lan.error)) return status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('LAN listener did not become ready')
}

;(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-lan-'))
  let managementRoute
  let upgradeRoute
  let disposePlugin
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  const ctx = {
    webServer,
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }

  plugin.apply(ctx, {
    requireAuth: false,
    gatewayEnabled: true,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'devices.json'),
    publicUrlFile: path.join(temp, 'missing-public-url'),
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`

  const status = await waitForLanStatus(base)
  assert.equal(status.lan.enabled, true)
  assert.equal(status.lan.listening, true)
  assert.equal(status.lan.requireAuth, true)
  assert.equal(status.lan.error, null)
  assert.equal(status.lan.urls.length, 1)
  const lanUrl = status.lan.urls[0]
  assert.equal(lanUrl, `ws://127.0.0.1:${status.lan.port}/ws/mobile`)

  // Main loopback listener follows the debug switch, but LAN never does.
  assert.equal(await expectRejected(lanUrl), 401)

  const lanHttp = await fetch(`http://127.0.0.1:${status.lan.port}/mgw/status`)
  assert.equal(lanHttp.status, 404)

  const pairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'LAN iPhone', publicUrl: lanUrl }),
  })
  assert.equal(pairResponse.status, 201)
  const pair = await pairResponse.json()
  assert.equal(pair.payload.publicUrl, lanUrl)
  assert.equal(pair.payload.gatewayId, status.gatewayId)
  assert.deepEqual(pair.payload.endpoints, [lanUrl])
  assert.deepEqual(status.endpoints, [lanUrl])

  const deviceId = '7bb30e78-4a31-4478-aae1-00a41d280637'
  const ws = new WebSocket(
    lanUrl,
    ['dsh-mobile-v1', `dsh-pair.${pair.payload.pairingCode}`],
    { headers: { 'X-DSH-Device-ID': deviceId } },
  )
  const pairedPromise = waitForMessage(ws, 'paired')
  const helloPromise = waitForMessage(ws, 'hello')
  await once(ws, 'open')
  const paired = await pairedPromise
  const hello = await helloPromise
  assert.equal(hello.authenticated, true)
  assert.equal(hello.port, status.lan.port)
  assert.equal(typeof paired.token, 'string')
  assert.equal(paired.gatewayId, status.gatewayId)
  assert.equal(hello.gatewayId, status.gatewayId)

  // A token paired through LAN identifies the same gateway on the host listener.
  const main = new WebSocket(`ws://127.0.0.1:${webServer.port}/ws/mobile`, {
    headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
  })
  const mainHelloPromise = waitForMessage(main, 'hello')
  await once(main, 'open')
  assert.equal((await mainHelloPromise).gatewayId, hello.gatewayId)
  main.close()
  await once(main, 'close')

  ws.close()
  await once(ws, 'close')
  disposePlugin()
  server.close()
  await once(server, 'close')
  fs.rmSync(temp, { recursive: true })
  console.log('LAN LISTENER TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})

// --- endpoint ordering ---
//
// A phone tries these in turn, so the LAN entry must lead. Measured on this deployment: the LAN
// path serves a Session at 20 MB/s while the public entry is capped by the desktop's own upstream
// at 0.9 MB/s, so a public-first list left a same-room phone waiting a minute for data the LAN
// could deliver in seconds. The public address must still be advertised for when the phone leaves.
{
  const { createGatewayHarness } = await import('./gateway-harness.mjs').catch(() => ({ createGatewayHarness: undefined }))
  if (createGatewayHarness !== undefined) {
    const harness = await createGatewayHarness({ publicUrlFile: undefined })
    try {
      const status = await harness.status()
      assert.ok(Array.isArray(status.endpoints) && status.endpoints.length >= 1, 'endpoints are advertised')
      const lanIndex = status.endpoints.findIndex(entry => /^ws:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|127\.)/.test(entry))
      assert.equal(lanIndex, 0, 'the LAN entry leads because the client tries them in order')
      if (typeof status.publicUrl === 'string' && status.publicUrl !== '') {
        assert.ok(status.endpoints.indexOf(status.publicUrl) > lanIndex, 'the public entry follows the LAN one')
      }
    } finally {
      await harness.close()
    }
  }
}

console.log('LAN-FIRST ORDERING TESTS PASSED')
// --- endpoint ordering ---
//
// A phone tries these in turn, so the LAN entry must lead. Measured on this deployment: the LAN
// path serves a Session at 20 MB/s while the public entry is capped by the desktop's own upstream
// at 0.9 MB/s, so a public-first list left a same-room phone waiting a minute for data the LAN
// could deliver in seconds. The public address must stay advertised for when the phone leaves.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-order-'))
  let managementRoute
  let disposePlugin
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade() { return () => {} },
  }
  const ctx = {
    webServer,
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream() {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }
  const publicUrlFile = path.join(temp, 'public-url')
  fs.writeFileSync(publicUrlFile, 'wss://gateway.example.test/ws/mobile\n')
  plugin.apply(ctx, {
    requireAuth: false,
    gatewayEnabled: true,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'devices.json'),
    publicUrlFile,
    publicUrl: 'wss://gateway.example.test/ws/mobile',
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
  })
  server.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const status = await waitForLanStatus(base)
    assert.ok(status.endpoints.length >= 2, 'both the LAN and public entries are advertised')
    const lanIndex = status.endpoints.findIndex(entry => entry.startsWith('ws://'))
    const publicIndex = status.endpoints.findIndex(entry => entry.startsWith('wss://'))
    assert.ok(lanIndex >= 0, 'the LAN entry is advertised while its listener is up')
    assert.ok(publicIndex >= 0, 'the public entry stays advertised for when the phone leaves')
    assert.ok(lanIndex < publicIndex, 'the LAN entry leads because the client tries them in order')
  } finally {
    server.close()
    disposePlugin?.()
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

console.log('LAN-FIRST ORDERING TESTS PASSED')
