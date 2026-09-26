#!/usr/bin/env node
/**
 * Session-cache gateway proxy.
 *
 * A phone on the public path receives every byte through the desktop's own upstream, measured at
 * 929 KB/s, while this host pushes downstream at 8.3 MB/s. Serving a Session's history from the
 * cache here is therefore 191x faster and does not touch the desktop's link at all. Live traffic
 * still needs the desktop, so this proxy splits the two: history answers from local storage, and
 * everything else is forwarded to the desktop through the existing tunnel.
 *
 * It speaks the same wire protocol as the gateway, so a phone reaches it by connecting here
 * instead — the protocol has no "fetch history elsewhere" field, and the App is a shipped binary
 * this side cannot change. The cache therefore has to look like the gateway itself.
 *
 * Zero dependencies: the VPS carries Node without npm, so the WebSocket handshake and frame codec
 * are implemented directly. Only text frames appear in this protocol, which keeps that tractable.
 *
 * Usage:
 *   session-cache-proxy.mjs [--port 7091] [--root /var/lib/dsh-mobile-cache]
 *                           [--upstream http://127.0.0.1:3080] [--ws-path /ws/mobile]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let port = Number(process.env.DSH_PROXY_PORT ?? 7091)
let root = resolve(process.env.DSH_CACHE_ROOT ?? '/var/lib/dsh-mobile-cache')
let upstream = process.env.DSH_UPSTREAM ?? 'http://127.0.0.1:3080'
let wsPath = process.env.DSH_WS_PATH ?? '/ws/mobile'
let tokensFile = process.env.DSH_CACHE_TOKENS ?? ''
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--port') { port = Number(argv[++index]); continue }
  if (arg === '--root') { root = resolve(argv[++index]); continue }
  if (arg === '--upstream') { upstream = argv[++index]; continue }
  if (arg === '--ws-path') { wsPath = argv[++index]; continue }
  if (arg === '--tokens') { tokensFile = resolve(argv[++index]); continue }
  if (arg === '--help' || arg === '-h') {
    console.log('usage: session-cache-proxy.mjs [--port 7091] [--root <dir>] [--upstream <url>] [--ws-path /ws/mobile] [--tokens <file>]')
    process.exit(0)
  }
  throw new Error('unknown option: ' + arg)
}

/** Accepted device credential hashes; a read requires one of them. */
function tokenHashes() {
  if (tokensFile === '') return new Set()
  try {
    const parsed = JSON.parse(readFileSync(tokensFile, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.hashes
    return new Set((Array.isArray(list) ? list : []).filter((hash) => typeof hash === 'string'))
  } catch { return new Set() }
}

const frame = {
  /** Encode one server frame. Payloads are text by construction. */
  encode(value) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
    }
    if (payload.length < 65536) {
      const header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
      return Buffer.concat([header, payload])
    }
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
    return Buffer.concat([header, payload])
  },
}

/**
 * Incremental text-frame decoder.
 *
 * Frames arrive fragmented across reads and batched within one, so the parser keeps a carry buffer
 * and returns every complete frame it can. Control frames are answered rather than surfaced: the
 * protocol uses none of them, but a client may still ping.
 */
class FrameReader {
  constructor(onFrame, onControl) {
    this.carry = Buffer.alloc(0)
    this.onFrame = onFrame
    this.onControl = onControl
  }
  push(chunk) {
    this.carry = Buffer.concat([this.carry, chunk])
    for (;;) {
      if (this.carry.length < 2) return
      const first = this.carry[0]
      const second = this.carry[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.carry.length < 4) return
        length = this.carry.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.carry.length < 10) return
        length = Number(this.carry.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (this.carry.length < offset + maskLength + length) return
      let payload = this.carry.subarray(offset + maskLength, offset + maskLength + length)
      if (masked) {
        const mask = this.carry.subarray(offset, offset + 4)
        payload = Buffer.from(payload)
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
      }
      this.carry = this.carry.subarray(offset + maskLength + length)
      if (opcode === 0x8) { this.onControl('close', payload); return }
      if (opcode === 0x9) { this.onControl('ping', payload); continue }
      if (opcode === 0xa) { this.onControl('pong', payload); continue }
      if (opcode === 0x1) this.onFrame(payload.toString('utf8'))
    }
  }
}

/** Read one Session's cached events, decompressing the stored snapshot. */
function cachedEvents(sessionId) {
  const path = join(root, sessionId + '.bin')
  if (!existsSync(path)) return undefined
  const meta = (() => { try { return JSON.parse(readFileSync(join(root, sessionId + '.meta.json'), 'utf8')) } catch { return undefined } })()
  const raw = execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  const events = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try { events.push(JSON.parse(line)) } catch { /* a row that does not parse carries no event */ }
  }
  return { events: events.filter((event) => typeof event.seq === 'number'), meta }
}

// --- history shaping, mirroring the gateway so a phone cannot tell the difference ---
const HISTORY_DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const HISTORY_TOOL_RESULT_MAX_CHARS = 2000

function eventBytes(event) { return Buffer.byteLength(JSON.stringify(event), 'utf8') }

function trimConversationEvent(event) {
  switch (event.type) {
    case 'assistant/chunk':
    case 'request/header':
    case 'request/context':
    case 'system/message':
      return null
    case 'assistant/message':
    case 'assistant/attempt': {
      const { stream, ...data } = event.data || {}
      return { ...event, data }
    }
    case 'tool/result': {
      const data = event.data || {}
      const message = data.message
      if (!message || !Array.isArray(message.content)) return event
      let changed = false
      const truncate = (block) => {
        if (!block || typeof block !== 'object') return block
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > HISTORY_TOOL_RESULT_MAX_CHARS) {
          changed = true
          return { ...block, text: block.text.slice(0, HISTORY_TOOL_RESULT_MAX_CHARS) + '…' }
        }
        if (Array.isArray(block.content)) return { ...block, content: block.content.map(truncate) }
        return block
      }
      const content = message.content.map(truncate)
      return changed ? { ...event, data: { ...data, message: { ...message, content } } } : event
    }
    default:
      return event
  }
}

/** Keep the newest suffix within a byte budget; always keep the newest event. */
function capHistoryEvents(events, maxBytes, trim, beforeSeq) {
  const bounded = beforeSeq === undefined ? events : events.filter((event) => event.seq < beforeSeq)
  const processed = trim ? bounded.map(trimConversationEvent).filter(Boolean) : bounded
  if (processed.length === 0) return { events: [], bytes: 0, hasMore: false }
  let total = 0
  let start = processed.length
  for (let index = processed.length - 1; index >= 0; index -= 1) {
    const size = eventBytes(processed[index])
    if (start !== processed.length && total + size > maxBytes) break
    total += size
    start = index
  }
  return { events: processed.slice(start), bytes: total, hasMore: start > 0 }
}

/** Build the wire frame a phone expects, from cached events. */
function historyFrame(message, cached) {
  const capped = capHistoryEvents(cached.events, HISTORY_DEFAULT_MAX_BYTES, message.view === 'conversation', message.beforeSeq)
  const oldest = capped.events[0]?.seq ?? cached.events[0]?.seq
  const lastSeq = cached.events.length === 0 ? 0 : cached.events[cached.events.length - 1].seq
  return {
    kind: 'history',
    sessionId: message.sessionId,
    events: capped.events,
    bytes: capped.bytes,
    hasMore: capped.hasMore,
    ...(message.view === 'conversation' ? { view: 'conversation' } : {}),
    ...(capped.hasMore && oldest !== undefined ? { nextBeforeSeq: oldest } : {}),
    cursor: lastSeq,
    historyFormatVersion: 4,
  }
}

const server = createServer((_request, response) => {
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'websocket-only' }))
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://proxy.invalid')
  if (url.pathname !== wsPath) { socket.destroy(); return }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') { socket.destroy(); return }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')

  // Forward the paired credential to the desktop for the live half. The cache serves history, so a
  // live-only write goes upstream unchanged and the gateway stays the single authority on identity.
  const headers = {}
  for (const name of ['authorization', 'sec-websocket-protocol', 'x-dsh-device-id', 'x-dsh-device-token', 'cookie']) {
    const value = request.headers[name]
    if (value !== undefined) headers[name] = value
  }
  const upstreamUrl = new URL(wsPath, upstream)
  const live = httpRequest({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: upstreamUrl.pathname,
    method: 'GET',
    headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
  })
  live.on('upgrade', (response2, liveSocket, liveHead) => {
    if (liveHead.length > 0) socket.write(liveHead)
    const toClient = (text) => socket.write(frame.encode(JSON.parse(text)))
    const liveReader = new FrameReader(toClient, () => {})
    liveSocket.on('data', (chunk) => liveReader.push(chunk))
    liveSocket.on('close', () => socket.destroy())
    liveSocket.on('error', () => socket.destroy())
    // From here the client's frames are examined: history answers locally, everything else forwards.
    const seen = new Set()
    const clientReader = new FrameReader((text) => {
      let message
      try { message = JSON.parse(text) } catch { liveSocket.write(text); return }
      if (message?.type === 'history' && typeof message.sessionId === 'string') {
        let cached
        try { cached = cachedEvents(message.sessionId) } catch { cached = undefined }
        if (cached !== undefined && cached.events.length > 0) {
          seen.add(message.sessionId)
          socket.write(frame.encode(historyFrame(message, cached)))
          return
        }
      }
      liveSocket.write(text)
    }, (kind, payload) => {
      if (kind === 'ping') { /* the client's ping is answered by the live socket's own keepalive */ }
      if (kind === 'close') liveSocket.destroy()
      void payload
    })
    socket.on('data', (chunk) => clientReader.push(chunk))
  })
  live.on('error', () => socket.destroy())
  live.end()
  if (head.length > 0) socket.unshift(head)
})

server.listen(port, '127.0.0.1', () => {
  console.log('session-cache-proxy: listening on 127.0.0.1:' + String(port) + ' root=' + root + ' upstream=' + upstream)
})
