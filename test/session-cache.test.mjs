import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SECRET = 'test-write-secret'
const DEVICE_TOKEN = 'test-device-token'
// The gateway stores only a device token's hash, so the read side accepts hashes too.
const DEVICE_HASH = createHash('sha256').update(DEVICE_TOKEN).digest('hex')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-cache-'))
const port = 17190 + Math.floor(Math.random() * 100)

const child = spawn(process.execPath, [
  new URL('../bin/session-cache.mjs', import.meta.url).pathname,
  '--port', String(port),
  '--root', path.join(temp, 'cache'),
  '--secret', SECRET,
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
const base = `http://127.0.0.1:${port}`

async function ready() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fetch(`${base}/cache`, { headers: { 'x-dsh-cache-secret': SECRET } }); return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('cache service did not start: ' + stderr)
}

try {
  await ready()

  // A read without a credential is refused before any file is touched.
  assert.equal((await fetch(`${base}/cache/one`)).status, 401)
  // A write with the wrong secret is refused too.
  assert.equal((await fetch(`${base}/cache/one`, { method: 'PUT', body: 'x', headers: { 'x-dsh-cache-secret': 'wrong' } })).status, 401)
  // A device token cannot write: only the desktop secret may.
  assert.equal((await fetch(`${base}/cache/one`, { method: 'PUT', body: 'x', headers: { 'x-dsh-device-token': DEVICE_TOKEN } })).status, 401)

  // An undeclared device is refused even before a snapshot exists: authorization is a property of
  // the service's configured set, not of what happens to be cached.
  assert.equal((await fetch(`${base}/cache/one`, { headers: { 'x-dsh-device-token': DEVICE_TOKEN } })).status, 401)

  // Write declares which device tokens may read.
  const payload = Buffer.from('compressed-session-bytes')
  const writeUrl = `${base}/cache/one?lastSeq=42&events=7&tokenHash=${DEVICE_HASH}`
  const written = await fetch(writeUrl, { method: 'PUT', body: payload, headers: { 'x-dsh-cache-secret': SECRET } })
  assert.equal(written.status, 200)

  // The declared device reads it back byte for byte, with its cursor in the headers.
  const read = await fetch(`${base}/cache/one`, { headers: { 'x-dsh-device-token': DEVICE_TOKEN } })
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('x-dsh-cache-last-seq'), '42')
  assert.equal(read.headers.get('x-dsh-cache-events'), '7')
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), payload)

  // An undeclared device cannot read what the desktop cached.
  assert.equal((await fetch(`${base}/cache/one`, { headers: { 'x-dsh-device-token': 'other' } })).status, 401)

  // The index lists what is cached.
  const index = await (await fetch(`${base}/cache`, { headers: { 'x-dsh-cache-secret': SECRET } })).json()
  assert.equal(index.entries.length, 1)
  assert.equal(index.entries[0].sessionId, 'one')
  assert.equal(index.entries[0].lastSeq, 42)

  // A later write replaces the snapshot rather than appending.
  const second = Buffer.from('v2')
  await fetch(`${base}/cache/one?lastSeq=99&events=9&tokenHash=${DEVICE_HASH}`, { method: 'PUT', body: second, headers: { 'x-dsh-cache-secret': SECRET } })
  const reread = await fetch(`${base}/cache/one`, { headers: { 'x-dsh-device-token': DEVICE_TOKEN } })
  assert.deepEqual(Buffer.from(await reread.arrayBuffer()), second)
  assert.equal(reread.headers.get('x-dsh-cache-last-seq'), '99')

  // A traversal attempt is refused rather than escaping the root.
  assert.equal((await fetch(`${base}/cache/..%2Fetc%2Fpasswd`, { headers: { 'x-dsh-device-token': DEVICE_TOKEN } })).status, 400)

  // Delete removes both halves.
  await fetch(`${base}/cache/one`, { method: 'DELETE', headers: { 'x-dsh-cache-secret': SECRET } })
  assert.equal((await fetch(`${base}/cache/one`, { headers: { 'x-dsh-device-token': DEVICE_TOKEN } })).status, 404)

  console.log('SESSION CACHE TESTS PASSED')
} finally {
  child.kill()
  fs.rmSync(temp, { recursive: true, force: true })
}
