#!/usr/bin/env node
/**
 * Stateless entry gateway for the mobile WebSocket path.
 *
 * This is the supported public entry: a phone reaches nginx, nginx reaches this
 * process on loopback, and this process relays the `dsh-mobile-v1` WebSocket to
 * the desktop DSH gateway through the existing tunnel. History is read from the
 * desktop on demand, exactly like live traffic; no Session bytes are stored on
 * the entry host.
 *
 * It is intentionally dependency-free. The entry VPS carries the distribution's
 * Node binary without an npm install, so the upstream handshake and the frame
 * codec live in `lib/ws-frame.mjs`. The default path is a raw byte relay: frames
 * are forwarded as they arrive, which also keeps large history pages streaming
 * instead of buffering them.
 *
 * The only cache is opt-in (`--memory-cache`): a bounded, volatile, in-process
 * TTL cache of immutable history pages. It is off by default, stores no
 * credentials, and is gone on restart. See DESIGN-vps-cache.md.
 *
 * Usage:
 *   stateless-gateway.mjs [--port 7091]
 *                         [--upstream http://127.0.0.1:7080]
 *                         [--upstream-host dsh.tokensfree.eu.cc]
 *                         [--ws-path /ws/mobile]
 *                         [--memory-cache] [--memory-cache-ttl 60]
 *                         [--memory-cache-entries 16]
 *                         [--memory-cache-bytes 33554432]
 *                         [--trace]
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { FrameParser, OPCODES, closePayload, encodeFrame } from '../lib/ws-frame.mjs'
import { MemoryHistoryCache } from '../lib/memory-history-cache.mjs'

const DEFAULT_PORT = 7091
const DEFAULT_UPSTREAM = 'http://127.0.0.1:7080'
const DEFAULT_UPSTREAM_HOST = 'dsh.tokensfree.eu.cc'
const DEFAULT_WS_PATH = '/ws/mobile'
const MAX_PENDING_HISTORY = 32
const PENDING_HISTORY_TTL_MS = 30_000

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] ?? ''))
}

function envNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

const argv = process.argv.slice(2)
let port = Number(process.env.DSH_PROXY_PORT ?? DEFAULT_PORT)
let upstream = process.env.DSH_UPSTREAM ?? DEFAULT_UPSTREAM
let upstreamHost = process.env.DSH_UPSTREAM_HOST ?? DEFAULT_UPSTREAM_HOST
let wsPath = process.env.DSH_WS_PATH ?? DEFAULT_WS_PATH
let memoryCacheEnabled = envFlag('DSH_MEMORY_CACHE')
let cacheTtlSeconds = envNumber('DSH_MEMORY_CACHE_TTL_SECONDS', 60)
let cacheEntries = envNumber('DSH_MEMORY_CACHE_ENTRIES', 16)
let cacheBytes = envNumber('DSH_MEMORY_CACHE_BYTES', 32 * 1024 * 1024)
let traceEnabled = envFlag('DSH_PROXY_TRACE')

function usage() {
  console.log(`usage: stateless-gateway.mjs [options]

  --port <port>                  loopback listen port (default ${DEFAULT_PORT})
  --upstream <url>               desktop DSH base URL (default ${DEFAULT_UPSTREAM})
  --upstream-host <host>         Host header used through the tunnel
                                 (default ${DEFAULT_UPSTREAM_HOST})
  --ws-path <path>               WebSocket path (default ${DEFAULT_WS_PATH})
  --memory-cache                 enable the bounded in-process history cache
                                 (default off; never writes to disk)
  --memory-cache-ttl <seconds>   cache TTL (default 60)
  --memory-cache-entries <n>     max cached pages (default 16)
  --memory-cache-bytes <bytes>   max cached payload bytes (default 33554432)
  --trace                        log frame types and sizes, never payloads
  --help

No Session history or device credentials are written to disk. The legacy disk
cache is a separate, explicit opt-in: session-cache-proxy.mjs --legacy-cache
(not recommended).`)
}

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--port') { port = Number(argv[++index]); continue }
  if (arg === '--upstream') { upstream = argv[++index]; continue }
  if (arg === '--upstream-host') { upstreamHost = argv[++index] ?? ''; continue }
  if (arg === '--ws-path') { wsPath = argv[++index]; continue }
  if (arg === '--memory-cache') { memoryCacheEnabled = true; continue }
  if (arg === '--memory-cache-ttl') { cacheTtlSeconds = Number(argv[++index]); memoryCacheEnabled = true; continue }
  if (arg === '--memory-cache-entries') { cacheEntries = Number(argv[++index]); memoryCacheEnabled = true; continue }
  if (arg === '--memory-cache-bytes') { cacheBytes = Number(argv[++index]); memoryCacheEnabled = true; continue }
  if (arg === '--trace') { traceEnabled = true; continue }
  if (arg === '--root' || arg === '--tokens' || arg === '--legacy-cache') {
    throw new Error(`${arg} is not supported: the stateless gateway writes no state and authenticates upstream; use session-cache-proxy.mjs --legacy-cache for the deprecated disk cache`)
  }
  if (arg === '--help' || arg === '-h') { usage(); process.exit(0) }
  throw new Error('unknown option: ' + arg)
}

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535')
if (typeof wsPath !== 'string' || !wsPath.startsWith('/') || wsPath.includes('..')) {
  throw new Error('ws-path must be an absolute path without ".."')
}
if (!Number.isInteger(cacheEntries) || cacheEntries < 1) throw new Error('memory-cache-entries must be a positive integer')
if (!Number.isInteger(cacheBytes) || cacheBytes < 1) throw new Error('memory-cache-bytes must be a positive integer')
if (!Number.isFinite(cacheTtlSeconds) || cacheTtlSeconds <= 0) throw new Error('memory-cache-ttl must be positive')

const upstreamUrl = new URL(upstream)
if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
  throw new Error('upstream must be an http:// or https:// URL')
}
if (upstreamUrl.username !== '' || upstreamUrl.password !== '') {
  throw new Error('upstream URL must not contain credentials')
}
if (upstreamHost === '') upstreamHost = upstreamUrl.host
if (/[\r\n]/.test(upstreamHost)) throw new Error('upstream-host must not contain CR or LF')

const memoryCache = memoryCacheEnabled
  ? new MemoryHistoryCache({
    ttlMs: cacheTtlSeconds * 1000,
    maxEntries: cacheEntries,
    maxBytes: cacheBytes,
  })
  : undefined

if (process.env.DSH_CACHE_ROOT !== undefined && process.env.DSH_CACHE_ROOT !== '') {
  console.warn('stateless-gateway: DSH_CACHE_ROOT is ignored; this process writes no session history')
}
if (memoryCacheEnabled) {
  console.warn(`stateless-gateway: in-memory history cache enabled (ttl=${cacheTtlSeconds}s entries=${cacheEntries} bytes=${cacheBytes}); it is volatile and stores no credentials`)
}

const transport = upstreamUrl.protocol === 'https:' ? https : http

function trace(...parts) {
  if (traceEnabled) console.log('[stateless]', ...parts)
}

function shortId(value) {
  return typeof value === 'string' && value.length > 24 ? value.slice(0, 24) + '…' : value
}

const STATUS_TEXT = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  426: 'Upgrade Required',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
})

function safeWrite(socket, payload) {
  if (socket === undefined || socket === null || socket.destroyed === true || socket.writable === false) return false
  try {
    socket.write(payload)
    return true
  } catch {
    try { socket.destroy() } catch { /* the socket is already gone */ }
    return false
  }
}

function httpError(socket, status, message) {
  if (socket.destroyed) return
  const body = Buffer.from(JSON.stringify({ error: message }))
  const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${body.length}\r\n`
    + 'Connection: close\r\n\r\n'
  if (safeWrite(socket, head)) socket.end(body)
}

function cacheStats() {
  if (memoryCache !== undefined) return memoryCache.stats()
  return {
    enabled: false,
    entries: 0,
    bytes: 0,
    ttlMs: 0,
    maxEntries: 0,
    maxBytes: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  }
}

const startedAt = Date.now()
const connections = new Set()

function health() {
  return {
    status: 'ok',
    mode: 'stateless',
    protocol: 'dsh-mobile-v1',
    upstream: {
      url: upstreamUrl.origin,
      host: upstreamHost,
      path: wsPath,
    },
    cache: cacheStats(),
    connections: connections.size,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://gateway.invalid')
  if (request.method === 'GET' && url.pathname === '/healthz') {
    const body = Buffer.from(JSON.stringify(health()))
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    response.end(body)
    return
  }
  const body = Buffer.from(JSON.stringify({ error: 'not-found', mode: 'stateless' }))
  response.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
})

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

/** Headers a relay must not copy verbatim; the handshake below sets its own. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'content-length',
])

function forwardedHeaders(request) {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = upstreamHost
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  headers['sec-websocket-key'] = request.headers['sec-websocket-key']
  headers['sec-websocket-version'] = '13'
  return headers
}

function upstreamPath(url) {
  const prefix = upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname.replace(/\/+$/, '')
  const suffix = wsPath.startsWith('/') ? wsPath : '/' + wsPath
  return prefix + suffix + (url.search || '')
}

function openUpstream(request, url) {
  const options = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port === '' ? undefined : Number(upstreamUrl.port),
    path: upstreamPath(url),
    method: 'GET',
    headers: forwardedHeaders(request),
  }
  // When the tunnel terminates TLS for the public name, the certificate belongs
  // to that name, not to the loopback address dialled here.
  if (upstreamUrl.protocol === 'https:' && net.isIP(upstreamHost) === 0) options.servername = upstreamHost
  return transport.request(options)
}

/**
 * Answer a history page from the volatile cache.
 *
 * Only requests carrying `beforeSeq` are eligible. Such a page is an immutable
 * prefix of the Session log; the opening page (no `beforeSeq`) grows with every
 * turn, and serving a stale copy could make a phone miss events appended after
 * it was captured. Cache keys include every request field that changes the
 * answer, plus the announced history format version.
 */
function historyCacheKey(message) {
  if (message === null || typeof message !== 'object' || message.type !== 'history') return undefined
  if (typeof message.sessionId !== 'string' || message.sessionId === '' || message.sessionId.length > 512) return undefined
  if (!Number.isSafeInteger(message.beforeSeq) || message.beforeSeq < 0) return undefined
  if (!Number.isSafeInteger(message.historyFormatVersion) || message.historyFormatVersion < 0) return undefined
  return JSON.stringify({
    sessionId: message.sessionId,
    beforeSeq: message.beforeSeq,
    maxMessages: Number.isSafeInteger(message.maxMessages) ? message.maxMessages : null,
    maxBytes: Number.isSafeInteger(message.maxBytes) ? message.maxBytes : null,
    view: typeof message.view === 'string' ? message.view : null,
    historyFormatVersion: message.historyFormatVersion,
  })
}

/** Raw relay: the default. Bytes are forwarded as they arrive; nothing is parsed. */
function relayRaw(client, upstreamSocket, clientHead, upstreamHead) {
  if (upstreamHead.length > 0) safeWrite(client, upstreamHead)
  if (clientHead.length > 0) safeWrite(upstreamSocket, clientHead)
  client.pipe(upstreamSocket)
  upstreamSocket.pipe(client)
}

/** Frame-aware relay used only when the opt-in memory cache is enabled. */
function relayFramed(client, upstreamSocket, clientHead, upstreamHead) {
  let closed = false
  const pending = []

  const writeFrame = (socket, opcode, payload, mask) => {
    if (closed || socket.destroyed || socket.writable === false) return false
    try {
      socket.write(encodeFrame(opcode, payload, { mask }))
      return true
    } catch {
      try { socket.destroy() } catch { /* the socket is already gone */ }
      return false
    }
  }

  const fail = (code, reason) => {
    if (closed) return
    trace('connection protocol failure code=' + String(code) + ' reason=' + reason)
    writeFrame(client, OPCODES.CLOSE, closePayload(code, reason), false)
    writeFrame(upstreamSocket, OPCODES.CLOSE, closePayload(code, reason), true)
    closed = true
    setTimeout(() => {
      client.destroy()
      upstreamSocket.destroy()
    }, 100).unref()
  }

  const prunePending = () => {
    const now = Date.now()
    while (pending.length > 0 && now - pending[0].at > PENDING_HISTORY_TTL_MS) pending.shift()
  }

  const clientParser = new FrameParser({
    expectMasked: true,
    label: 'client',
    onError: fail,
    onControl: (opcode, payload) => {
      if (closed) return
      writeFrame(upstreamSocket, opcode, payload, true)
      if (opcode === OPCODES.CLOSE) {
        setTimeout(() => { client.destroy(); upstreamSocket.destroy() }, 1_000).unref()
      }
    },
    onMessage: (opcode, payload) => {
      if (closed) return
      if (opcode === OPCODES.TEXT) {
        let message
        try { message = JSON.parse(payload.toString('utf8')) } catch { /* not JSON; forward it */ }
        if (message !== null && typeof message === 'object' && message.type === 'history') {
          const key = historyCacheKey(message)
          if (key !== undefined) {
            const cached = memoryCache.get(key)
            if (cached !== undefined) {
              trace('history cache=hit session=' + shortId(message.sessionId) + ' beforeSeq=' + String(message.beforeSeq))
              writeFrame(client, OPCODES.TEXT, Buffer.from(cached, 'utf8'), false)
              return
            }
            trace('history cache=miss session=' + shortId(message.sessionId) + ' beforeSeq=' + String(message.beforeSeq))
          }
          if (typeof message.sessionId === 'string') {
            prunePending()
            // Track every in-flight history request, including the mutable
            // opening page. A response cannot be attributed to a request when
            // more than one for the same Session is outstanding.
            pending.push({
              key,
              sessionId: message.sessionId,
              historyFormatVersion: message.historyFormatVersion,
              beforeSeq: message.beforeSeq,
              at: Date.now(),
            })
            if (pending.length > MAX_PENDING_HISTORY) pending.shift()
          }
        }
        trace('client->upstream type=' + String(message?.type ?? 'unparsed'))
      } else {
        trace('client->upstream opcode=' + String(opcode) + ' bytes=' + String(payload.length))
      }
      writeFrame(upstreamSocket, opcode, payload, true)
    },
  })

  const upstreamParser = new FrameParser({
    expectMasked: false,
    label: 'upstream',
    onError: fail,
    onControl: (opcode, payload) => {
      if (closed) return
      writeFrame(client, opcode, payload, false)
      if (opcode === OPCODES.CLOSE) {
        setTimeout(() => { client.destroy(); upstreamSocket.destroy() }, 1_000).unref()
      }
    },
    onMessage: (opcode, payload) => {
      if (closed) return
      if (opcode === OPCODES.TEXT && pending.length > 0) {
        let message
        try { message = JSON.parse(payload.toString('utf8')) } catch { /* not JSON */ }
        if (message !== null && typeof message === 'object') {
          if (message.kind === 'history') {
            // History responses carry no request id. Cache only when exactly one
            // request for this Session is in flight; an opening-page response
            // must never be stored under a paged request's key.
            const matches = pending.filter((entry) => entry.sessionId === message.sessionId)
            if (matches.length === 1) {
              const entry = matches[0]
              pending.splice(pending.indexOf(entry), 1)
              const text = payload.toString('utf8')
              if (entry.key !== undefined
                && message.historyFormatVersion === entry.historyFormatVersion
                && memoryCache.set(entry.key, text)) {
                trace('history cache=store session=' + shortId(message.sessionId) + ' beforeSeq=' + String(entry.beforeSeq))
              }
            } else if (matches.length > 1) {
              for (const entry of matches) pending.splice(pending.indexOf(entry), 1)
            }
          } else if (message.kind === 'error' && message.requestType === 'history') {
            const index = typeof message.sessionId === 'string'
              ? pending.findIndex((entry) => entry.sessionId === message.sessionId)
              : 0
            if (index >= 0) pending.splice(index, 1)
          }
          trace('upstream->client kind=' + String(message.kind ?? 'unparsed'))
        } else {
          trace('upstream->client opcode=' + String(opcode) + ' bytes=' + String(payload.length))
        }
      } else {
        trace('upstream->client opcode=' + String(opcode) + ' bytes=' + String(payload.length))
      }
      writeFrame(client, opcode, payload, false)
    },
  })

  if (clientHead.length > 0) clientParser.push(clientHead)
  if (upstreamHead.length > 0) upstreamParser.push(upstreamHead)
  client.on('data', (chunk) => clientParser.push(chunk))
  upstreamSocket.on('data', (chunk) => upstreamParser.push(chunk))
  client.on('close', () => { closed = true; upstreamSocket.destroy() })
  upstreamSocket.on('close', () => { closed = true; client.destroy() })
  trace('framed relay established')
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://gateway.invalid')
  if (url.pathname !== wsPath) {
    httpError(socket, 404, 'not-found')
    return
  }
  if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    httpError(socket, 400, 'websocket-upgrade-required')
    return
  }
  if (typeof request.headers['sec-websocket-key'] !== 'string' || request.headers['sec-websocket-key'] === '') {
    httpError(socket, 400, 'missing-websocket-key')
    return
  }

  connections.add(socket)
  socket.once('close', () => connections.delete(socket))
  socket.on('error', () => { /* handled by the close path */ })

  let upgraded = false
  let refused = false
  const live = openUpstream(request, url)

  live.on('upgrade', (response, liveSocket, liveHead) => {
    upgraded = true
    live.setTimeout(0)
    const accept = response.headers['sec-websocket-accept']
    if (typeof accept !== 'string' || accept === '') {
      liveSocket.destroy()
      httpError(socket, 502, 'invalid-upstream-handshake')
      return
    }
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
    ]
    const protocol = response.headers['sec-websocket-protocol']
    if (typeof protocol === 'string' && protocol !== '') lines.push('Sec-WebSocket-Protocol: ' + protocol)
    const cookies = response.headers['set-cookie']
    if (cookies !== undefined) {
      for (const cookie of [].concat(cookies)) lines.push('Set-Cookie: ' + cookie)
    }
    if (!safeWrite(socket, lines.join('\r\n') + '\r\n\r\n')) {
      liveSocket.destroy()
      return
    }

    liveSocket.on('error', () => socket.destroy())
    socket.on('error', () => liveSocket.destroy())
    socket.on('close', () => liveSocket.destroy())
    liveSocket.on('close', () => socket.destroy())

    trace('upgraded path=' + url.pathname + ' protocol=' + String(protocol ?? '-'))
    if (memoryCache !== undefined) relayFramed(socket, liveSocket, head, liveHead)
    else relayRaw(socket, liveSocket, head, liveHead)
  })

  // A refusal belongs to the upstream: relay its status and body so the phone
  // can distinguish 401 (re-pair) from 5xx (retry) exactly as before.
  live.on('response', (response) => {
    refused = true
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => {
      if (socket.destroyed) return
      const body = Buffer.concat(chunks)
      const headers = {
        'Content-Type': response.headers['content-type'] ?? 'application/json',
        'Content-Length': body.length,
        Connection: 'close',
      }
      if (typeof response.headers['www-authenticate'] === 'string') {
        headers['WWW-Authenticate'] = response.headers['www-authenticate']
      }
      const cookies = response.headers['set-cookie']
      if (cookies !== undefined) headers['Set-Cookie'] = cookies
      const statusLine = `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}`
      const headerLines = []
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) headerLines.push(`${name}: ${item}`)
        else headerLines.push(`${name}: ${value}`)
      }
      if (safeWrite(socket, statusLine + '\r\n' + headerLines.join('\r\n') + '\r\n\r\n')) socket.end(body)
    })
  })

  live.on('error', () => {
    if (!upgraded && !refused) httpError(socket, 502, 'upstream-unreachable')
  })
  live.on('timeout', () => {
    if (upgraded) return
    live.destroy()
    httpError(socket, 504, 'upstream-timeout')
  })
  live.setTimeout(20_000)
  socket.on('close', () => { if (!upgraded) live.destroy() })
  live.end()
})

server.on('error', (error) => {
  console.error('stateless-gateway: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const cache = memoryCache === undefined
    ? 'off'
    : `memory(ttl=${cacheTtlSeconds}s entries=${cacheEntries} bytes=${cacheBytes})`
  console.log(`stateless-gateway: listening on 127.0.0.1:${port} mode=stateless cache=${cache} upstream=${upstreamUrl.origin} host=${upstreamHost} path=${wsPath}`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`stateless-gateway: ${signal}, closing`)
  server.close(() => process.exit(0))
  for (const socket of connections) {
    try { socket.destroy() } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 2_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))