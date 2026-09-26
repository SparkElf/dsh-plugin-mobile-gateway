#!/usr/bin/env node
/**
 * Mobile gateway protocol harness.
 *
 * Drives a full pairing and Session load the way the App does, so a change can be checked without
 * a phone in hand. It speaks the wire protocol directly: the App is a shipped binary and the point
 * is to reproduce its behaviour, not the gateway's own tests.
 *
 * Usage:
 *   protocol-harness.mjs --host 127.0.0.1 --port 7091 --code <pairingCode> [--json]
 *                        [--expect-history] [--timeout 30000]
 *
 * Exit codes: 0 the flow completed, 1 a protocol failure, 2 the flow timed out.
 */
import net from 'node:net'
import { randomBytes } from 'node:crypto'

const argv = process.argv.slice(2)
let host = '127.0.0.1'
let port = 7091
let code = ''
let json = false
let expectHistory = false
let sessionId = ''
let timeoutMs = 30000
let path = '/ws/mobile'
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--host') { host = argv[++index]; continue }
  if (arg === '--port') { port = Number(argv[++index]); continue }
  if (arg === '--code') { code = argv[++index]; continue }
  if (arg === '--path') { path = argv[++index]; continue }
  if (arg === '--timeout') { timeoutMs = Number(argv[++index]); continue }
  if (arg === '--json') { json = true; continue }
  if (arg === '--expect-history') { expectHistory = true; continue }
  if (arg === '--session') { sessionId = argv[++index]; continue }
  if (arg === '--help' || arg === '-h') {
    console.log('usage: protocol-harness.mjs --code <pairingCode> [--host 127.0.0.1] [--port 7091] [--path /ws/mobile] [--json] [--expect-history] [--timeout 30000]')
    process.exit(0)
  }
  throw new Error('unknown option: ' + arg)
}

const report = { steps: [], frames: [], errors: [], ok: false }

function note(step) { report.steps.push(step); if (!json) console.log('  ' + step) }
function fail(message) { report.errors.push(message); if (!json) console.log('  FAIL ' + message) }

/** One masked client text frame, per RFC 6455 — an unmasked frame is rejected as EXPECTED_MASK. */
function encodeClientText(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x81
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

const socket = net.connect(port, host)
let carry = Buffer.alloc(0)
let handshakeDone = false
let finished = false
const sentHistory = new Set()

function finish(ok, why) {
  if (finished) return
  finished = true
  report.ok = ok
  if (why !== undefined) fail(why)
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log()
    console.log('  帧序列: ' + report.frames.map((frame) => frame.kind).join(' -> '))
    console.log('  结果: ' + (ok ? 'PASS' : 'FAIL'))
    if (report.errors.length > 0) for (const error of report.errors) console.log('    - ' + error)
  }
  try { socket.destroy() } catch {}
  process.exit(ok ? 0 : 1)
}

/** Decode server frames; the server never masks, so the payload follows the header directly. */
function readFrames() {
  for (;;) {
    if (carry.length < 2) return
    const opcode = carry[0] & 0x0f
    const masked = (carry[1] & 0x80) !== 0
    let length = carry[1] & 0x7f
    let offset = 2
    if (length === 126) { if (carry.length < 4) return; length = carry.readUInt16BE(2); offset = 4 }
    else if (length === 127) { if (carry.length < 10) return; length = Number(carry.readBigUInt64BE(2)); offset = 10 }
    const maskLength = masked ? 4 : 0
    if (carry.length < offset + maskLength + length) return
    let payload = carry.subarray(offset + maskLength, offset + maskLength + length)
    if (masked) {
      const mask = carry.subarray(offset, offset + 4)
      payload = Buffer.from(payload)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    }
    carry = carry.subarray(offset + maskLength + length)
    if (opcode === 0x8) { note('server closed the connection'); finish(false, 'the server closed before the flow completed'); return }
    if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), randomBytes(4)])); continue }
    if (opcode !== 0x1) continue
    onFrame(payload.toString('utf8'))
  }
}

function onFrame(text) {
  let frame
  try { frame = JSON.parse(text) } catch { fail('the server sent a frame that is not JSON'); return }
  report.frames.push({ kind: frame.kind, bytes: text.length })
  if (!json) console.log('  <- ' + frame.kind + (frame.kind === 'history' ? ' events=' + String(frame.events?.length ?? 0) + ' cursor=' + String(frame.cursor) + ' bytes=' + String(frame.bytes) : ''))
  if (frame.kind === 'error') { fail('server error frame: ' + JSON.stringify(frame).slice(0, 160)); return }
  if (frame.kind === 'paired') { note('paired'); socket.write(encodeClientText(JSON.stringify({ type: 'sessions' }))); return }
  if (frame.kind === 'sessions') {
    note('sessions: ' + String(frame.sessions?.length ?? 0))
    // A named Session lets a caller exercise a Session known to hold events, which the default
    // first-two choice cannot guarantee.
    const ids = sessionId !== '' ? [sessionId] : (frame.sessions ?? []).map((session) => session.sessionId).slice(0, 2)
    for (const id of ids) { sentHistory.add(id); socket.write(encodeClientText(JSON.stringify({ type: 'history', sessionId: id, view: 'conversation' }))) }
    if (ids.length === 0) { note('no Sessions to request'); finish(true) }
    return
  }
  if (frame.kind === 'history') {
    note('history for ' + String(frame.sessionId).slice(0, 24) + ': ' + String(frame.events?.length ?? 0) + ' events'
      + ' cursor=' + String(frame.cursor) + ' hasMore=' + String(frame.hasMore)
      + ' bytes=' + String(frame.bytes) + ' formatVersion=' + String(frame.historyFormatVersion)
      + ' view=' + String(frame.view))
    if ((frame.events?.length ?? 0) > 0) {
      const sequenced = frame.events.every((event) => typeof event.seq === 'number')
      if (!sequenced) fail('history carried an event without a seq')
    }
    const done = [...sentHistory].every((id) => report.frames.some((seen) => seen.kind === 'history'))
    if (done) finish(report.errors.length === 0)
  }
}

socket.on('connect', () => {
  const key = randomBytes(16).toString('base64')
  const protocols = code === '' ? 'dsh-mobile-v1' : 'dsh-mobile-v1, dsh-pair.' + code
  socket.write(
    'GET ' + path + ' HTTP/1.1\r\n'
    + 'Host: ' + host + ':' + String(port) + '\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + 'Sec-WebSocket-Key: ' + key + '\r\n'
    + 'Sec-WebSocket-Protocol: ' + protocols + '\r\n'
    + 'X-DSH-Device-ID: harness-' + randomBytes(8).toString('hex') + '\r\n'
    + '\r\n',
  )
})

socket.on('data', (chunk) => {
  if (!handshakeDone) {
    carry = Buffer.concat([carry, chunk])
    const end = carry.indexOf('\r\n\r\n')
    if (end < 0) return
    const head = carry.subarray(0, end).toString('utf8')
    const status = head.split('\r\n')[0]
    report.handshake = status
    if (!json) console.log('  handshake: ' + status)
    if (!head.startsWith('HTTP/1.1 101')) { finish(false, 'handshake refused: ' + status); return }
    handshakeDone = true
    note('upgraded')
    carry = carry.subarray(end + 4)
  } else {
    carry = Buffer.concat([carry, chunk])
  }
  readFrames()
})

socket.on('error', (error) => finish(false, 'socket error: ' + error.message))
setTimeout(() => finish(false, 'timed out after ' + String(timeoutMs) + 'ms'), timeoutMs)
