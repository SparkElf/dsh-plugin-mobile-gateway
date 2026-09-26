#!/usr/bin/env node
/**
 * Push Session snapshots to the entry VPS.
 *
 * A phone on the public path receives every byte through this desktop's own upstream, measured at
 * 0.9 MB/s, while the entry VPS pushes downstream at 8.3 MB/s. Filling a cache there in the
 * background moves that upstream cost off the phone's critical path: the phone then downloads from
 * the VPS at its own speed and asks this gateway only for the increment.
 *
 * This walks the persisted Sessions, takes the ones worth caching, and PUTs each one's bytes. It
 * never blocks a Session: a failed push is retried on the next pass, and nothing here is on the
 * path a user waits for.
 *
 * Usage:
 *   push-session-cache.mjs --secret <value> [--home /root/.dsh] [--endpoint https://...]
 *                          [--once] [--interval 300] [--max-sessions 20] [--rate 200]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request } from 'node:https'
import { createGunzip } from 'node:zlib'

const argv = process.argv.slice(2)
let secret = process.env.DSH_CACHE_SECRET ?? ''
let home = process.env.DSH_HOME ?? '/root/.dsh'
let endpoint = process.env.DSH_CACHE_ENDPOINT ?? 'https://dsh.tokensfree.eu.cc/cache'
let once = false
let intervalSeconds = 300
let maxSessions = 20
let rateBytesPerSecond = 200 * 1024
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--secret') { secret = argv[++index]; continue }
  if (arg === '--home') { home = resolve(argv[++index]); continue }
  if (arg === '--endpoint') { endpoint = argv[++index]; continue }
  if (arg === '--once') { once = true; continue }
  if (arg === '--interval') { intervalSeconds = Number(argv[++index]); continue }
  if (arg === '--max-sessions') { maxSessions = Number(argv[++index]); continue }
  if (arg === '--rate') { rateBytesPerSecond = Number(argv[++index]) * 1024; continue }
  if (arg === '--help' || arg === '-h') {
    console.log('usage: push-session-cache.mjs --secret <value> [--home <dir>] [--endpoint <url>] [--once] [--interval 300] [--max-sessions 20] [--rate 200]')
    process.exit(0)
  }
  throw new Error('unknown option: ' + arg)
}
if (secret === '') throw new Error('push-session-cache: --secret or DSH_CACHE_SECRET is required')

/** Sessions live one directory deep, under a project directory whose name encodes the cwd. */
function findSessions() {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const directory = join(projectPath, session.name)
      // Prefer the highest format present: a Session that predates the v4 migration keeps both.
      const candidates = readdirSync(directory)
        .map((name) => /^session\.v(\d+)\.jsonl\.zstd$/.exec(name))
        .filter((match) => match !== null)
        .map((match) => ({ name: match[0], version: Number(match[1]) }))
        .sort((left, right) => right.version - left.version)
      if (candidates.length === 0) continue
      const path = join(directory, candidates[0].name)
      found.push({ id: session.name, path, version: candidates[0].version, mtime: statSync(path).mtimeMs, bytes: statSync(path).size })
    }
  }
  return found.sort((left, right) => right.mtime - left.mtime).slice(0, maxSessions)
}

/** Highest event seq in one compressed log, so the phone can tell cache from live. */
function lastSeq(path) {
  const raw = execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  let last = 0
  let events = 0
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const row = JSON.parse(line)
      if (typeof row.seq === 'number') { events += 1; if (row.seq > last) last = row.seq }
    } catch { /* a row that does not parse carries no seq to track */ }
  }
  return { last, events }
}

/** PUT one file, paced so the push never saturates the link a user is waiting on. */
function push(session, meta, hashes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(endpoint.replace(/\/$/, '') + '/' + encodeURIComponent(session.id))
    url.searchParams.set('lastSeq', String(meta.last))
    url.searchParams.set('events', String(meta.events))
    for (const hash of hashes) url.searchParams.append('tokenHash', hash)
    const body = readFileSync(session.path)
    const call = request(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        'x-dsh-cache-secret': secret,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode === 200) resolvePromise(Buffer.concat(chunks).toString())
        else rejectPromise(new Error('push failed: HTTP ' + String(response.statusCode) + ' ' + Buffer.concat(chunks).toString().slice(0, 200)))
      })
    })
    call.on('error', rejectPromise)
    call.end(body)
  })
}

/**
 * Credential hashes of the devices that may read, so the cache accepts exactly the paired set.
 *
 * The gateway stores a device's token as a hash and never keeps the plaintext, so this reads the
 * hashes it does keep. A revoked device drops out on the next pass, because the set is rebuilt from
 * the file rather than appended to.
 */
function pairedTokenHashes() {
  const file = join(home, 'mobile-gateway-devices.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const devices = Array.isArray(parsed?.devices) ? parsed.devices : []
    return devices
      .filter((device) => device?.revokedAt === null || device?.revokedAt === undefined)
      .map((device) => device?.tokenHash)
      .filter((hash) => typeof hash === 'string' && hash !== '')
  } catch { return [] }
}

async function pass() {
  const sessions = findSessions()
  if (sessions.length === 0) { console.log('push-session-cache: no Sessions to cache'); return }
  const hashes = pairedTokenHashes()
  console.log('push-session-cache: ' + String(sessions.length) + ' Session(s), ' + String(hashes.length) + ' paired device(s)')
  for (const session of sessions) {
    try {
      const meta = lastSeq(session.path)
      const started = Date.now()
      await push(session, meta, hashes)
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      console.log('  cached ' + session.id.slice(0, 24) + ' ' + (session.bytes / 1048576).toFixed(1) + ' MB lastSeq=' + String(meta.last) + ' in ' + seconds.toFixed(1) + 's (' + String(Math.round(session.bytes / seconds)) + ' B/s)')
    } catch (error) {
      console.log('  FAILED ' + session.id.slice(0, 24) + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

await pass()
if (!once) {
  console.log('push-session-cache: every ' + String(intervalSeconds) + 's')
  setInterval(() => { void pass() }, intervalSeconds * 1000)
}
