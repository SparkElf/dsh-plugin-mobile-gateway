// The disk cache is deprecated, not silently available.
//
// Every legacy entry point must refuse to start unless the operator explicitly
// opts in with --legacy-cache (or DSH_LEGACY_SESSION_CACHE=1). This test also
// checks that the refusal happens before any directory is created, and that the
// stateless gateway rejects the old --root flag instead of pretending to use it.

process.on('unhandledRejection', (error) => { console.error('unhandled:', error); process.exit(1) })
const guard = setTimeout(() => { console.error('test timed out'); process.exit(3) }, 60_000)

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-gate-'))
const root = path.join(temp, 'cache-root')

function run(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(BIN, script), ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

try {
  // Without the flag: refuse before creating a cache root or demanding a secret.
  const cache = await run('session-cache.mjs', ['--port', '0', '--root', root, '--secret', 'test-secret'])
  assert.equal(cache.code, 2, 'session-cache refuses to start by default')
  assert.match(cache.stderr, /disabled by default/)
  assert.match(cache.stderr, /legacy-cache/)
  assert.equal(fs.existsSync(root), false, 'the refusal created no cache directory')

  const proxy = await run('session-cache-proxy.mjs', ['--port', '0', '--root', root])
  assert.equal(proxy.code, 2, 'session-cache-proxy refuses to start by default')
  assert.match(proxy.stderr, /disabled by default/)
  assert.match(proxy.stderr, /stateless-gateway/)

  const pusher = await run('push-session-cache.mjs', ['--home', path.join(temp, 'home'), '--endpoint', 'https://example.invalid/cache'])
  assert.equal(pusher.code, 2, 'the pusher refuses to run by default')
  assert.match(pusher.stderr, /disabled by default/)
  assert.match(pusher.stderr, /legacy-cache/)
  assert.equal(fs.existsSync(root), false)

  // Help remains available without opt-in: it is how an operator discovers the flag.
  for (const script of ['session-cache.mjs', 'session-cache-proxy.mjs', 'push-session-cache.mjs']) {
    const help = await run(script, ['--help'])
    assert.equal(help.code, 0, script + ' --help exits successfully')
    assert.match(help.stdout, /--legacy-cache/, script + ' documents the opt-in')
  }

  // The stateless entry has no state directory to point at: --root is an error,
  // not a silently ignored path that could imply history is being cached.
  const stateless = await run('stateless-gateway.mjs', ['--port', '0', '--root', root])
  assert.notEqual(stateless.code, 0, 'stateless-gateway rejects --root')
  assert.match(stateless.stderr, /--root is not supported/)
  assert.match(stateless.stderr, /writes no state/)
  assert.equal(fs.existsSync(root), false)

  clearTimeout(guard)
  console.log('LEGACY CACHE OPT-IN TESTS PASSED: disk cache refuses to start without --legacy-cache')
} finally {
  clearTimeout(guard)
  fs.rmSync(temp, { recursive: true, force: true })
}