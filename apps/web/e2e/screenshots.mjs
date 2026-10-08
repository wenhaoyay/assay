// Regenerate the README screenshots from a running server with the seeded demo and its history
// (`gaugelab seed --run --history --fresh`: run #4 = baseline, #9 = candidate) and the demo agent
// on :9040 for the connect-wizard shot.
//   node e2e/screenshots.mjs            (BASE=http://127.0.0.1:8040, OUT=../../docs/screenshots)
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8040'
const OUT = process.env.OUT ?? new URL('../../../docs/screenshots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined })

async function shot(name, path, { theme = 'light', prepare, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height }, deviceScaleFactor: 1 })
  await ctx.addInitScript(([t]) => {
    localStorage.setItem('gl-theme', t)
    localStorage.setItem('gl-annotator', 'Reviewer')
    localStorage.setItem('gl-motion', 'reduced') // stills, not mid-animation frames
  }, [theme])
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  if (prepare) await prepare(page)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await ctx.close()
}

await shot('home', '/')
await shot('chatbot', '/p/1', { height: 1100 })
await shot('compare', '/compare?baseline=4&candidate=9', { height: 1000 })
await shot('compare-dark', '/compare?baseline=4&candidate=9', { theme: 'dark', height: 1000 })
await shot('run-summary', '/runs/9', { height: 1100 })
await shot('explore', '/runs/4?tab=explore', { height: 1400, prepare: async (page) => { await page.waitForTimeout(1800) } })
await shot('failures', '/runs/4?tab=failures')
await shot('trial', '/runs/4?tab=failures', {
  prepare: async (page) => {
    await page.locator('td a[href^="/trials/"]').first().click()
    await page.waitForLoadState('networkidle')
  },
})
await shot('trace', '/runs/9?tab=traces')
await shot('dataset-history', '/datasets/1?tab=history')
await shot('calibration', '/calibration')
await shot('models', '/settings?tab=models')
await shot('connect', '/targets/new', {
  height: 1000,
  prepare: async (page) => {
    await page.getByRole('switch').click()
    await page.getByRole('button', { name: /Next: The request/ }).click()
    await page.getByLabel('curl command').fill(`curl http://127.0.0.1:9040/chat -H "Content-Type: application/json" --data-raw '{"message":"hi","variant":"candidate"}'`)
    await page.getByRole('button', { name: 'Read it' }).click()
    await page.getByRole('button', { name: /Next: Test and map/ }).click()
    await page.getByLabel('Test question').fill('Is order 18372 still covered by warranty?')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText('Where is each thing?').waitFor()
    await page.getByText('Where is each thing?').scrollIntoViewIfNeeded()
  },
})
await browser.close()
console.log('screenshots in', OUT)
