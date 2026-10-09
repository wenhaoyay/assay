import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Every main page, in both themes: no serious or critical WCAG 2.0/2.1 A/AA violation.
const PAGES: [string, string][] = [
  ['home', '/'],
  ['chatbot page', '/p/1'],
  ['runs list', '/runs'],
  ['run summary', '/runs/1'],
  ['run failures', '/runs/1?tab=failures'],
  ['question page', '/trials/1'],
  ['compare', '/compare?baseline=1&candidate=2'],
  ['new run', '/runs/new'],
  ['gates', '/gates'],
  ['calibration', '/calibration'],
  ['checks', '/evaluators'],
  ['settings', '/settings'],
  ['datasets', '/datasets'],
  ['connections', '/targets'],
  ['connect wizard', '/targets/new'],
]

async function scan(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? n.failureSummary)).join(' | ')}`)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`a11y ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => {
        localStorage.setItem('gl-theme', t)
        localStorage.setItem('gl-annotator', 'e2e-reviewer')
        localStorage.setItem('gl-motion', 'reduced')
      }, theme)
    })
    for (const [name, url] of PAGES) {
      test(`${name} has no serious axe violations`, async ({ page }) => {
        await page.goto(url)
        await page.waitForLoadState('networkidle')
        await expect(page.locator('main, #main, [role="main"]').first()).toBeVisible()
        expect(await scan(page)).toEqual([])
      })
    }
    test('calibration name dialog', async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem('gl-annotator'))
      await page.goto('/calibration')
      await page.waitForLoadState('networkidle')
      expect(await scan(page)).toEqual([])
    })
    test('compare table view', async ({ page }) => {
      await page.goto('/compare?baseline=1&candidate=2')
      await page.getByRole('button', { name: 'Table' }).click()
      expect(await scan(page)).toEqual([])
    })
  })
}

test.describe('keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gl-annotator', 'e2e-reviewer'))
  })
  test('command palette opens and closes with the keyboard', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Control+k')
    await expect(page.getByLabel('Search')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Search')).toHaveCount(0)
  })
  test('name dialog keeps focus inside it', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('gl-annotator'))
    await page.goto('/calibration')
    const dlg = page.getByRole('dialog')
    await expect(dlg).toBeVisible()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }
  })
  test('shortcut sheet opens with ? and closes with Escape', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('?')
    const dlg = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(dlg).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
  })
  for (const [name, url] of PAGES.filter(([n]) => ['home', 'run summary', 'gates', 'settings', 'new run', 'runs list'].includes(n))) {
    test(`${name}: tabbing reaches controls and each focus is visible`, async ({ page }) => {
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      const bad: string[] = []
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          const cs = getComputedStyle(el)
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && cs.boxShadow !== '')
          return { ring, d: `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}]` }
        })
        if (r && !r.ring) bad.push(r.d)
      }
      expect(bad).toEqual([])
    })
  }
})
