/**
 * Mint a pairing code against the local gateway.
 *
 * The management API accepts a same-origin request only, so this drives a real page and asks from
 * there — the same path the UI uses. Playwright is resolved by absolute path because this script
 * lives in the gateway repo while the browser tooling lives in the distribution repo; a bare
 * import would depend on which directory the caller happened to be in.
 *
 * Prints the code on stdout; diagnostics go to stderr. Run via scripts/e2e-mobile.sh.
 */

const PLAYWRIGHT = process.env.DSH_PLAYWRIGHT_PATH ?? '/root/projects/deepseek-harness-plus/node_modules/playwright/index.mjs'

let chromium
try {
  ({ chromium } = await import(PLAYWRIGHT))
} catch (error) {
  process.stderr.write('mint-pairing-code: cannot load playwright from ' + PLAYWRIGHT + ': ' + String(error).slice(0, 160) + '\n')
  process.exit(3)
}

const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  // The page must finish booting before its fetch carries the expected same-origin context.
  await page.waitForTimeout(8000)
  const body = await page.evaluate(async () => {
    const response = await fetch('/mgw/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e' }),
    })
    return await response.text()
  })
  const code = JSON.parse(body)?.payload?.pairingCode
  if (typeof code !== 'string' || code === '') {
    process.stderr.write('mint-pairing-code: no code in ' + body.slice(0, 200) + '\n')
    process.exit(4)
  }
  process.stdout.write(code)
} finally {
  await browser.close()
}
