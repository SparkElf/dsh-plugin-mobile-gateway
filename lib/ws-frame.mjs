// Minimal RFC 6455 frame codec for the entry-side relay.
//
// The entry host is deliberately dependency-free: it runs the Node binary the
// distribution ships, without a package install. The `ws` dependency used by
// the plugin itself is therefore unavailable here, and only text frames occur
// in the `dsh-mobile-v1` protocol. This module implements just enough of the
// frame layer to relay those frames (including fragmentation and control
// frames) without interpreting the payload.
//
// Two rules matter for a relay:
//   * Client-to-server frames must be masked; server-to-client frames must not.
//   * Relaying a decoded message re-frames it as one unfragmented frame. The
//     payload is unchanged, so a peer cannot tell the difference.

import { randomBytes } from 'node:crypto'

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

export const OPCODES = Object.freeze({
  CONTINUATION: OPCODE_CONTINUATION,
  TEXT: OPCODE_TEXT,
  BINARY: OPCODE_BINARY,
  CLOSE: OPCODE_CLOSE,
  PING: OPCODE_PING,
  PONG: OPCODE_PONG,
})

const CONTROL_OPCODES = new Set([OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG])
const DATA_OPCODES = new Set([OPCODE_TEXT, OPCODE_BINARY])

/** Encode one complete frame. `mask` is required when the relay acts as the client. */
export function encodeFrame(opcode, payload, { mask = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | (opcode & 0x0f)
  if (!mask) return Buffer.concat([header, body])
  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.from(body)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= key[index % 4]
  return Buffer.concat([header, key, masked])
}

/** Encode a close frame payload: a two-byte status code plus an optional reason. */
export function closePayload(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(Number.isInteger(code) ? code : 1000, 0)
  text.copy(payload, 2)
  return payload
}

/**
 * Incremental frame parser.
 *
 * `expectMasked` encodes the side of the connection this parser reads: true
 * when reading client frames, false when reading upstream frames. The parser
 * emits complete data messages (fragments joined) and control frames through
 * separate callbacks, and reports a protocol violation through `onError`.
 *
 * The receive buffer grows geometrically and is compacted only when a frame is
 * consumed, so a multi-megabyte history page does not copy its prefix once per
 * TCP chunk.
 */
export class FrameParser {
  constructor({
    onMessage,
    onControl = () => {},
    onError = () => {},
    expectMasked = true,
    maxMessageBytes = 160 * 1024 * 1024,
    label = 'peer',
  } = {}) {
    if (typeof onMessage !== 'function') throw new TypeError('FrameParser requires onMessage')
    this.onMessage = onMessage
    this.onControl = onControl
    this.onError = onError
    this.expectMasked = expectMasked
    this.maxMessageBytes = maxMessageBytes
    this.label = label
    this.buffer = Buffer.alloc(0)
    this.length = 0
    this.failed = false
    this.fragmentOpcode = undefined
    this.fragments = []
    this.fragmentBytes = 0
  }

  append(chunk) {
    const required = this.length + chunk.length
    if (required > this.buffer.length) {
      let capacity = Math.max(1024, this.buffer.length * 2)
      while (capacity < required) capacity *= 2
      const next = Buffer.allocUnsafe(capacity)
      this.buffer.copy(next, 0, 0, this.length)
      this.buffer = next
    }
    chunk.copy(this.buffer, this.length)
    this.length = required
  }

  consume(count) {
    const remaining = this.length - count
    if (remaining > 0) this.buffer.copy(this.buffer, 0, count, this.length)
    this.length = remaining
  }

  push(chunk) {
    if (this.failed || chunk.length === 0) return
    this.append(chunk)
    for (;;) {
      if (this.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (rsv !== 0) return this.fail(1002, 'reserved bits set')
      if (masked !== this.expectMasked) return this.fail(1002, this.expectMasked ? 'unmasked frame' : 'masked frame')

      if (length === 126) {
        if (this.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.length < 10) return
        const wide = this.buffer.readBigUInt64BE(2)
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return this.fail(1009, 'frame too large')
        length = Number(wide)
        offset = 10
      }

      const isControl = CONTROL_OPCODES.has(opcode)
      if (!isControl && !DATA_OPCODES.has(opcode) && opcode !== OPCODE_CONTINUATION) {
        return this.fail(1002, 'unknown opcode')
      }
      if (isControl) {
        if (!fin) return this.fail(1002, 'fragmented control frame')
        if (length > 125) return this.fail(1002, 'oversized control frame')
      }
      if (length > this.maxMessageBytes) return this.fail(1009, 'frame too large')

      const maskLength = masked ? 4 : 0
      const frameLength = offset + maskLength + length
      if (this.length < frameLength) return
      const payloadStart = offset + maskLength
      let payload
      if (masked) {
        const key = this.buffer.subarray(offset, offset + 4)
        payload = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) {
          payload[index] = this.buffer[payloadStart + index] ^ key[index % 4]
        }
      } else {
        // Copy before compacting: consume() moves the remaining bytes over this region.
        payload = Buffer.from(this.buffer.subarray(payloadStart, payloadStart + length))
      }
      this.consume(frameLength)

      if (isControl) {
        this.onControl(opcode, payload)
        if (opcode === OPCODE_CLOSE) return
        continue
      }

      if (opcode === OPCODE_CONTINUATION) {
        if (this.fragmentOpcode === undefined) return this.fail(1002, 'unexpected continuation frame')
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > this.maxMessageBytes) return this.fail(1009, 'message too large')
        this.fragments.push(payload)
        if (fin) {
          const complete = Buffer.concat(this.fragments)
          const messageOpcode = this.fragmentOpcode
          this.fragmentOpcode = undefined
          this.fragments = []
          this.fragmentBytes = 0
          this.onMessage(messageOpcode, complete)
        }
        continue
      }

      if (this.fragmentOpcode !== undefined) return this.fail(1002, 'interleaved data frames')
      if (fin) {
        this.onMessage(opcode, payload)
      } else {
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        this.fragmentBytes = payload.length
      }
    }
  }

  fail(code, message) {
    if (this.failed) return
    this.failed = true
    this.length = 0
    this.onError(code, `${this.label}: ${message}`)
  }
}