// Regenerate the README screenshots from a running server with the seeded demo
// (and the demo agent on :9040 for the connect-wizard shot).
//   node e2e/screenshots.mjs            (BASE=http://127.0.0.1:8040, OUT=../../docs/screenshots)
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8040'
const OUT = process.env.OUT ?? new URL('../../../docs/screenshots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined })

async function shot(name, path, { theme = 'light', explain = false, prepare, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height }, deviceScaleFactor: 1 })
  await ctx.addInitScript(([t, x]) => {
    localStorage.setItem('gl-theme', t)
    localStorage.setItem('gl-explain', x)
    localStorage.setItem('gl-annotator', 'Reviewer')
    localStorage.setItem('gl-motion', 'reduced') // stills, not mid-animation frames
  }, [theme, String(explain)])
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  if (prepare) await prepare(page)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await ctx.close()
}

await shot('home', '/')
await shot('chatbot', '/p/1')
await shot('compare', '/compare?baseline=1&candidate=2')
await shot('compare-dark', '/compare?baseline=1&candidate=2', { theme: 'dark' })
await shot('run-summary', '/runs/2', { explain: true })
await shot('failures', '/runs/1?tab=failures')
await shot('trial', '/runs/1?tab=failures', {
  prepare: async (page) => {
    await page.locator('a[href^="/trials/"]').first().click()
    await page.waitForLoadState('networkidle')
  },
})
await shot('trace', '/runs/2?tab=traces')
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
