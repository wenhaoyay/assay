// Regenerate the README screenshots from a running server with the seeded demo.
//   node e2e/screenshots.mjs            (BASE=http://127.0.0.1:8040, OUT=../../docs/screenshots)
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8040'
const OUT = process.env.OUT ?? new URL('../../../docs/screenshots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined })

async function shot(name, path, { theme = 'light', prepare } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await ctx.addInitScript((t) => localStorage.setItem('gl-theme', t), theme)
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  if (prepare) await prepare(page)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await ctx.close()
}

await shot('compare', '/compare?baseline=1&candidate=2')
await shot('run-summary', '/runs/2')
await shot('failures', '/runs/1?tab=failures')
await shot('trial', '/runs/1?tab=failures', {
  prepare: async (page) => {
    await page.locator('a[href^="/trials/"]').first().click()
    await page.waitForLoadState('networkidle')
  },
})
await shot('trace', '/runs/2?tab=traces', {
  prepare: async (page) => {
    await page.getByRole('button', { name: /tool_01/ }).first().click()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /tool: check_warranty/ }).first().click()
  },
})
await shot('dataset', '/datasets/1')
await shot('calibration', '/calibration')
await shot('compare-dark', '/compare?baseline=1&candidate=2', { theme: 'dark' })
await browser.close()
console.log('screenshots in', OUT)
