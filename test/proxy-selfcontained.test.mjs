import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

// Every entry point must reach its ready line, not merely parse.
//
// A missing import does not fail at load: it fails at the line that uses it, and that line was
// inside a socket's data handler. The cache proxy therefore accepted a phone, completed its
// handshake, then died mid-conversation with "ReferenceError: randomBytes is not defined" — a
// phone in hand was the only way to see it. Starting each entry point and requiring its own ready
// line surfaces that class of fault without one.

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin')

/** Start a script and resolve once it prints its ready line. */
function startAndWaitFor(args, readyPattern, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timed out waiting for ' + String(readyPattern) + ' from ' + args.join(' ') + '; stderr=' + stderr.slice(0, 300)))
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (readyPattern.test(stdout)) { clearTimeout(timer); child.kill(); resolve({ stdout, stderr }) }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      // A ReferenceError from a socket handler arrives here and must fail the check.
      if (/ReferenceError|is not defined/.test(stderr)) {
        clearTimeout(timer)
        child.kill()
        reject(new Error(args.join(' ') + ' hit a ReferenceError: ' + stderr.slice(0, 240)))
      }
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(args.join(' ') + ' exited before becoming ready (code ' + String(code) + '): ' + stderr.slice(0, 300)))
    })
  })
}

fs.mkdirSync('/tmp/selfcontained-cache', { recursive: true })

const cache = await startAndWaitFor(
  [path.join(BIN, 'session-cache.mjs'), '--port', '17702', '--root', '/tmp/selfcontained-cache', '--secret', 'selfcontained-test'],
  /listening on/,
)
assert.match(cache.stdout, /listening on 127\.0\.0\.1:17702/)

const proxy = await startAndWaitFor(
  [path.join(BIN, 'session-cache-proxy.mjs'), '--port', '17703', '--root', '/tmp/selfcontained-cache'],
  /listening on/,
)
assert.match(proxy.stdout, /listening on 127\.0\.0\.1:17703/)

console.log('PROXY SELF-CONTAINMENT TESTS PASSED')
