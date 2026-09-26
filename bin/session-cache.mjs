#!/usr/bin/env node
/**
 * Session cache for the mobile gateway.
 *
 * A phone on the public path receives every byte through the desktop's own upstream, measured at
 * 0.9 MB/s on this deployment, while the entry VPS can push 8.3 MB/s downstream. Serving a Session
 * from here therefore turns a minute of waiting into a second, and the desktop fills the cache in
 * the background where its slow upstream costs the user nothing.
 *
 * The service is deliberately small and read-mostly: it stores one compressed snapshot per Session
 * plus a cursor, and the phone asks for the difference afterwards through the gateway's own
 * incremental history. It owns no Session semantics — it never parses event payloads, so a harness
 * format change cannot corrupt it.
 *
 * Authentication reuses the gateway's device tokens: the desktop proves write access with a shared
 * secret, and a phone proves read access with the same device id and token it paired with. A
 * request without either is refused before any file is touched.
 *
 * Usage: session-cache.mjs [--port 7090] [--root /var/lib/dsh-mobile-cache] [--secret <value>]
 */
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let port = Number(process.env.DSH_CACHE_PORT ?? 7090)
let root = resolve(process.env.DSH_CACHE_ROOT ?? '/var/lib/dsh-mobile-cache')
let secret = process.env.DSH_CACHE_SECRET ?? ''
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--port') { port = Number(argv[++index]); continue }
  if (arg === '--root') { root = resolve(argv[++index]); continue }
  if (arg === '--secret') { secret = argv[++index]; continue }
  if (arg === '--help' || arg === '-h') {
    console.log('usage: session-cache.mjs [--port 7090] [--root <dir>] [--secret <value>]')
    process.exit(0)
  }
  throw new Error('unknown option: ' + arg)
}
if (secret === '') throw new Error('session-cache: --secret or DSH_CACHE_SECRET is required')

mkdirSync(root, { recursive: true })

/** Compare two secrets without leaking their length or content through timing. */
function secretMatches(provided) {
  if (typeof provided !== 'string' || provided === '') return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

/**
 * Whether a read request carries a credential a paired device holds.
 *
 * The cache holds what the gateway already serves to a paired phone, so a read needs the same proof
 * of pairing. The desktop never sees a device's plaintext token — the gateway stores only its hash —
 * so the accepted set is hashes, and a presented token is hashed the same way to compare. A service
 * with no declared hashes refuses every read rather than serving one anonymously.
 */
let pairedTokenHashes = new Set()
function deviceTokenMatches(provided) {
  if (typeof provided !== 'string' || provided === '') return false
  return pairedTokenHashes.has(createHash('sha256').update(provided).digest('hex'))
}

/** Replace the accepted read credentials with the hashes the desktop declares. */
function setPairedTokenHashes(hashes) {
  pairedTokenHashes = new Set(hashes.filter((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))
}

/** Session ids are opaque; refuse anything that could escape the cache root. */
function cachePath(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.length > 128) return undefined
  return join(root, sessionId + '.bin')
}

function metaPath(sessionId) {
  return join(root, sessionId + '.meta.json')
}

function readMeta(sessionId) {
  try { return JSON.parse(readFileSync(metaPath(sessionId), 'utf8')) } catch { return undefined }
}

function writeMeta(sessionId, meta) {
  const temporary = metaPath(sessionId) + '.tmp'
  writeFileSync(temporary, JSON.stringify(meta))
  renameSync(temporary, metaPath(sessionId))
}

function readBody(request, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { rejectPromise(new Error('too large')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks)))
    request.on('error', rejectPromise)
  })
}

function send(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers })
  response.end(body)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://cache.invalid')
  const segments = url.pathname.split('/').filter((part) => part !== '')
  try {
    if (segments[0] !== 'cache') { send(response, 404, { error: 'not-found' }); return }

    // Two distinct credentials, so a leaked phone token cannot rewrite the cache: writing takes
    // the shared secret (the desktop side), reading takes the device credential the phone already
    // paired with. The index is desktop-side bookkeeping and takes the secret as well — a phone
    // asks for the one Session it is opening, never for a list of everything cached.
    const desktopSide = request.method === 'PUT' || request.method === 'DELETE' || segments.length === 1
    const deviceToken = request.headers['x-dsh-device-token']
    const authorized = desktopSide
      ? secretMatches(request.headers['x-dsh-cache-secret'])
      : deviceTokenMatches(deviceToken)
    if (!authorized) { send(response, 401, { error: 'unauthorized' }); return }

    if (segments.length === 1) {
      if (request.method !== 'GET') { send(response, 405, { error: 'method' }); return }
      const entries = []
      for (const name of readdirSync(root)) {
        if (!name.endsWith('.meta.json')) continue
        const sessionId = name.slice(0, -'.meta.json'.length)
        const meta = readMeta(sessionId)
        if (meta !== undefined) entries.push({ sessionId, ...meta })
      }
      send(response, 200, { entries })
      return
    }

    const sessionId = segments[1]
    const path = cachePath(sessionId)
    if (path === undefined) { send(response, 400, { error: 'bad-session-id' }); return }

    if (request.method === 'PUT') {
      const body = await readBody(request, 64 * 1024 * 1024)
      const temporary = path + '.tmp'
      writeFileSync(temporary, body)
      renameSync(temporary, path)
      const lastSeq = Number(url.searchParams.get('lastSeq') ?? '0')
      const eventCount = Number(url.searchParams.get('events') ?? '0')
      // The desktop states which device credential hashes may read what it cached, so revocation
      // is a property of the next write rather than a second channel.
      const hashes = url.searchParams.getAll('tokenHash')
      if (hashes.length > 0) setPairedTokenHashes(hashes)
      writeMeta(sessionId, { bytes: body.length, lastSeq, eventCount, updatedAt: Date.now() })
      send(response, 200, { stored: body.length, sessionId })
      return
    }

    if (request.method === 'DELETE') {
      rmSync(path, { force: true })
      rmSync(metaPath(sessionId), { force: true })
      send(response, 200, { removed: sessionId })
      return
    }

    if (request.method === 'GET') {
      if (!existsSync(path)) { send(response, 404, { error: 'not-cached' }); return }
      const meta = readMeta(sessionId)
      const stat = statSync(path)
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'x-dsh-cache-last-seq': String(meta?.lastSeq ?? 0),
        'x-dsh-cache-events': String(meta?.eventCount ?? 0),
      })
      response.end(readFileSync(path))
      return
    }

    send(response, 405, { error: 'method' })
  } catch (error) {
    send(response, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log('session-cache: listening on 127.0.0.1:' + String(port) + ' root=' + root)
})
