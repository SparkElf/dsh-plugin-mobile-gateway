import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const plugin = (await import('../lib/index.mjs')).default

// A malformed frame from a client must close that connection, not the process. `ws` parses frames
// inside the socket's 'data' listener and throws synchronously on a protocol violation; that would
// otherwise become an uncaughtException and take the whole harness down, which any client can
// trigger with one frame. Measured six such crashes in a day before this guard.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-frame-'))
let managementRoute
let upgradeRoute
let disposePlugin
const server = http.createServer((req, res) => {
  if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(managementRoute.path + '/'))) {
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
plugin.apply(ctx, {
  // Authentication off so the upgrade succeeds and the frame actually reaches the parser: a
  // refused upgrade never constructs a WebSocket, so it would not exercise the crash path.
  requireAuth: false,
  gatewayEnabled: true,
  gatewayWaitTimeoutMs: 60_000,
  adminLoopbackOnly: true,
  pairingTtlMs: 60_000,
  deviceFile: path.join(temp, 'devices.json'),
  publicUrlFile: path.join(temp, 'missing-public-url'),
})
server.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const port = server.address().port

// A frame that violates the protocol: a reserved bit set and no mask, the shape that crashed the
// deployment.
function malformedFrame() {
  return Buffer.concat([Buffer.from([0xc1, 0x02]), Buffer.from('{}')])
}

function openAndSend(frame) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    let sent = false
    let upgraded = false
    socket.on('connect', () => {
      socket.write(
        'GET /ws/mobile HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8', 0, 60)
      if (!sent && text.startsWith('HTTP/1.1')) {
        sent = true
        upgraded = text.includes('101')
        // Whether the handshake was accepted or refused, deliver the bad frame and observe that
        // the process survives it either way.
        setTimeout(() => { try { socket.write(frame) } catch {} }, 50)
      }
    })
    socket.on('error', () => {})
    setTimeout(() => { socket.destroy(); resolve(upgraded) }, 600)
  })
}

let crashed = false
process.on('uncaughtException', (error) => { crashed = true; console.log('  UNCAUGHT:', String(error && error.message).slice(0, 90)) })

try {
  const upgraded = await openAndSend(malformedFrame())
  assert.equal(upgraded, true, 'the test must reach a parsed frame, or it proves nothing')
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(crashed, false, 'a malformed frame must not escape as an uncaughtException')

  // The listener still serves after the bad frame.
  const status = await (await fetch('http://127.0.0.1:' + String(port) + '/mgw/status')).json()
  assert.equal(typeof status.gatewayEnabled, 'boolean', 'the gateway keeps serving after a malformed frame')

  for (let attempt = 0; attempt < 3; attempt += 1) await openAndSend(malformedFrame())
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(crashed, false, 'repeated malformed frames stay contained')
  const again = await (await fetch('http://127.0.0.1:' + String(port) + '/mgw/status')).json()
  assert.equal(typeof again.gatewayEnabled, 'boolean', 'the gateway still serves after repeated bad frames')

  console.log('MALFORMED FRAME CONTAINMENT TESTS PASSED')
} finally {
  server.close()
  disposePlugin?.()
  fs.rmSync(temp, { recursive: true, force: true })
}