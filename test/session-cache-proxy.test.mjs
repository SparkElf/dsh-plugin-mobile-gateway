// Fails fast rather than hanging: every await here is bounded.
process.on('unhandledRejection', (error) => { console.error('unhandled:', error); process.exit(1) })
const guard = setTimeout(() => { console.error('test timed out'); process.exit(3) }, 60_000)

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const WebSocket = require('ws')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cache-proxy-'))
const cacheRoot = path.join(temp, 'cache')
fs.mkdirSync(cacheRoot, { recursive: true })

const SESSION_ID = 'session-proxy-test'
const zstdPath = path.join(cacheRoot, SESSION_ID + '.bin')
// Store a real compressed snapshot, so the proxy's decompression is exercised rather than stubbed.
const events = [
  { type: 'system/message', seq: 0, time: 1, data: { message: { role: 'system', content: [] } } },
  { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, stream: { partial: true } } },
]
const plain = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
fs.writeFileSync(path.join(temp, 'plain.jsonl'), plain)
require('node:child_process').execFileSync('zstd', ['-q', '-f', path.join(temp, 'plain.jsonl'), '-o', zstdPath])
fs.writeFileSync(path.join(cacheRoot, SESSION_ID + '.meta.json'), JSON.stringify({ lastSeq: 2, eventCount: 3 }))

// An upstream that records what reaches it, so forwarding can be observed.
const forwarded = []
const upstream = http.createServer((_request, response) => { response.writeHead(404).end() })
upstream.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  // Record what arrives; do not reply, so the test observes forwarding without racing a reply.
  socket.on('data', (chunk) => { forwarded.push(chunk.toString('latin1')) })
})
upstream.listen(0, '127.0.0.1')
await new Promise((resolve) => upstream.once('listening', resolve))
const upstreamPort = upstream.address().port

const port = 17390 + Math.floor(Math.random() * 100)
const child = spawn(process.execPath, [
  new URL('../bin/session-cache-proxy.mjs', import.meta.url).pathname,
  '--port', String(port),
  '--root', cacheRoot,
  '--upstream', 'http://127.0.0.1:' + String(upstreamPort),
  '--legacy-cache',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + String(port) + '/ws/mobile')
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('connect timed out: ' + stderr)) }, 5000)
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function next(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame')), 5000)
    ws.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())) })
  })
}

try {
  // Wait for the listener without opening and closing a probe connection: a closed socket leaves
  // the retry state ambiguous, which is what made an earlier version of this test hang.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const ws = await connect()

  // The history answer must declare the same Session format the gateway announced in its hello
  // frame. The client checks one against the other, so a mismatch makes it reject every page and
  // sit on "loading history" — which is what a proxy announcing the newest format it knew about did,
  // while the gateway it fronted announced an older one.
  //
  const asked = next(ws)
  ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, view: 'conversation' }))
  const answer = await asked
  assert.equal(answer.kind, 'history')
  assert.equal(answer.sessionId, SESSION_ID)
  assert.equal(answer.cursor, 2)
  // system/message is not rendered on a chat page, so the view trims it.
  assert.deepEqual(answer.events.map((event) => event.seq), [1, 2])
  // The stream field is dropped on assistant messages.
  assert.equal(answer.events[1].data.stream, undefined)
  assert.equal(answer.view, 'conversation')
  assert.equal(
    answer.historyFormatVersion,
    3,
    'the history answer declares the Session format the gateway announces in its hello frame',
  )

  // Every forwarded frame must already be framed: the upstream socket is a raw stream, and bare
  // JSON corrupts the header ('{' is 0x7B, whose RSV2 and RSV3 bits are both set).
  const frameBytes = Buffer.from(forwarded.join(''), 'latin1')
  if (frameBytes.length > 0) {
    const first = frameBytes[0]
    assert.equal((first >> 5) & 1, 0, 'RSV2 must be clear on a forwarded frame')
    assert.equal((first >> 4) & 1, 0, 'RSV3 must be clear on a forwarded frame')
    assert.equal(first & 0x0f, 0x1, 'a forwarded frame is text')
  }

  // An uncached Session is forwarded upstream rather than answered here.
  const before = forwarded.length
  ws.send(JSON.stringify({ type: 'history', sessionId: 'session-not-cached' }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(forwarded.length > before, 'an uncached history request reaches the upstream')

  // A non-history request is forwarded too.
  const beforeOther = forwarded.length
  ws.send(JSON.stringify({ type: 'sessions' }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(forwarded.length > beforeOther, 'a sessions request reaches the upstream')

  ws.close()
  clearTimeout(guard)
  console.log('SESSION CACHE PROXY TESTS PASSED')
} finally {
  clearTimeout(guard)
  child.kill()
  upstream.close()
  fs.rmSync(temp, { recursive: true, force: true })
}

// --- upstream framing ---
//
// The socket an 'upgrade' event hands back is a raw TCP stream, so everything written to it must
// already be framed. Writing bare JSON corrupts silently: the first payload byte becomes the frame
// header, and '{' is 0x7B = FIN 0, RSV1 1, RSV2 1, RSV3 1, opcode 0xB, which the receiving parser
// rejects as WS_ERR_UNEXPECTED_RSV_2_3. A phone doing this read as the App sending malformed
// frames; the bytes came from this proxy.
{
  const { spawn } = require('node:child_process')
  // A real WebSocket server, not a bare socket: this is what parses the forwarded frame, so it is
  // what rejects an unmasked one (WS_ERR_EXPECTED_MASK) or a stray reserved bit. A raw collector
  // would accept anything and prove nothing.
  const { WebSocketServer } = require('ws')
  const received = []
  const upstream = http.createServer((_r, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => received.push(data.toString('utf8')))
      ws.on('error', (error) => received.push('ERROR:' + String(error.code ?? error.message)))
    })
  })
  upstream.listen(0, '127.0.0.1')
  await new Promise((resolve) => upstream.once('listening', resolve))
  const upstreamPort = upstream.address().port
  const proxyPort = 17590 + Math.floor(Math.random() * 50)
  const proxy = spawn(process.execPath, [
    new URL('../bin/session-cache-proxy.mjs', import.meta.url).pathname,
    '--port', String(proxyPort), '--root', cacheRoot,
    '--upstream', 'http://127.0.0.1:' + String(upstreamPort),
    '--legacy-cache',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const ws = await new Promise((resolve, reject) => {
      const client = new WebSocket('ws://127.0.0.1:' + String(proxyPort) + '/ws/mobile')
      const timer = setTimeout(() => { client.terminate(); reject(new Error('connect timed out')) }, 5000)
      client.once('open', () => { clearTimeout(timer); resolve(client) })
      client.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    // A frame with no cached answer and one that is not a history request both go upstream.
    ws.send(JSON.stringify({ type: 'sessions' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    ws.close()
    // The upstream ws parser accepts the frame only if it is well formed: masked, text, no reserved
    // bits. A parse failure surfaces as an 'error' entry rather than a message.
    assert.deepEqual(received.filter((entry) => entry.startsWith('ERROR:')), [], 'the upstream accepted every forwarded frame')
    assert.ok(received.length > 0, 'the frame reached the upstream')
    assert.deepEqual(JSON.parse(received[0]), { type: 'sessions' }, 'the upstream decoded the payload intact')
  } finally {
    proxy.kill()
    upstream.close()
  }
}

console.log('UPSTREAM FRAMING TESTS PASSED')