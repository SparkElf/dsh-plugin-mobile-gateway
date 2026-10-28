// Unit tests for the dependency-free frame codec and the volatile cache.
//
// The relay's default path never parses frames, but the opt-in memory cache
// does, and a codec bug there would corrupt an opt-in deployment silently. The
// fragmentation and masking cases are the ones a browser/App can actually send.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { FrameParser, OPCODES, closePayload, encodeFrame } = await import('../lib/ws-frame.mjs')
const { MemoryHistoryCache } = await import('../lib/memory-history-cache.mjs')

function collect({ expectMasked = true, maxMessageBytes } = {}) {
  const messages = []
  const controls = []
  const errors = []
  const parser = new FrameParser({
    expectMasked,
    maxMessageBytes,
    onMessage: (opcode, payload) => messages.push({ opcode, text: payload.toString('utf8') }),
    onControl: (opcode, payload) => controls.push({ opcode, text: payload.toString('utf8') }),
    onError: (code, message) => errors.push({ code, message }),
  })
  return { parser, messages, controls, errors }
}

// A masked client text frame split at every byte boundary.
{
  const { parser, messages, errors } = collect()
  for (const byte of encodeFrame(OPCODES.TEXT, Buffer.from('hello'), { mask: true })) parser.push(Buffer.from([byte]))
  assert.deepEqual(errors, [])
  assert.deepEqual(messages, [{ opcode: OPCODES.TEXT, text: 'hello' }])
}

// A 70 KB payload uses the 64-bit length field and must survive a frame split
// across arbitrary TCP chunks.
{
  const { parser, messages, errors } = collect()
  const text = 'x'.repeat(70_000)
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(text), { mask: true })
  parser.push(frame.subarray(0, 3))
  parser.push(frame.subarray(3, 10))
  parser.push(frame.subarray(10))
  assert.deepEqual(errors, [])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text.length, 70_000)
}

// Fragmented text with a ping in the middle: control frames may interleave.
{
  const { parser, messages, controls, errors } = collect()
  const first = encodeFrame(OPCODES.TEXT, Buffer.from('frag'), { mask: true })
  first[0] &= 0x7f // FIN=0
  const continuation = encodeFrame(OPCODES.CONTINUATION, Buffer.from('mented'), { mask: true })
  const ping = encodeFrame(OPCODES.PING, Buffer.from('p'), { mask: true })
  parser.push(Buffer.concat([first, ping, continuation]))
  assert.deepEqual(errors, [])
  assert.deepEqual(controls, [{ opcode: OPCODES.PING, text: 'p' }])
  assert.deepEqual(messages, [{ opcode: OPCODES.TEXT, text: 'fragmented' }])
}

// Masking is direction-sensitive: clients must mask, servers must not.
{
  const client = collect({ expectMasked: true })
  client.parser.push(encodeFrame(OPCODES.TEXT, Buffer.from('bad'), { mask: false }))
  assert.equal(client.errors[0]?.code, 1002)
  const server = collect({ expectMasked: false })
  server.parser.push(encodeFrame(OPCODES.TEXT, Buffer.from('bad'), { mask: true }))
  assert.equal(server.errors[0]?.code, 1002)
}

// A close payload carries a status code and stays within the 125-byte control limit.
{
  const payload = closePayload(1009, 'too large')
  assert.equal(payload.readUInt16BE(0), 1009)
  assert.equal(payload.subarray(2).toString('utf8'), 'too large')
  assert.ok(payload.length <= 125)
}

// Bounded cache: LRU eviction, TTL expiry, and refusal to store an oversized page.
{
  let now = 1_000
  const cache = new MemoryHistoryCache({ ttlMs: 1_000, maxEntries: 1, maxBytes: 64, now: () => now })
  assert.equal(cache.set('a', 'alpha'), true)
  assert.equal(cache.set('b', 'bravo'), true)
  assert.equal(cache.get('a'), undefined, 'the oldest entry was evicted')
  assert.equal(cache.get('b'), 'bravo')
  const stats = cache.stats()
  assert.equal(stats.entries, 1)
  assert.equal(stats.evictions, 1)
  assert.ok(stats.hits >= 1)
  now += 1_001
  assert.equal(cache.get('b'), undefined, 'the entry expired')
  assert.equal(cache.set('huge', 'x'.repeat(65)), false, 'a page larger than the budget is not stored')
  assert.equal(cache.stats().entries, 0)
}

console.log('WS FRAME AND MEMORY CACHE TESTS PASSED')