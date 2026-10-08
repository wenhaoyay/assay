import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  // Labels need a name; set it once like a returning user.
  await page.addInitScript(() => localStorage.setItem('gl-annotator', 'e2e-reviewer'))
})

test('home shows each chatbot with its verdict, and opens its page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your chatbots' })).toBeVisible()
  await page.getByRole('link', { name: /Acme Support Demo/ }).first().click()
  await expect(page).toHaveURL(/\/p\/\d+/)
  await expect(page.getByText(/regressed, \d+ improved/)).toBeVisible()
  await expect(page.getByText('Where failures start').first()).toBeVisible()
})

test('start a run from the UI and see its gate verdict', async ({ page }) => {
  await page.goto('/runs/new')
  const target = page.getByLabel('Connection', { exact: true })
  const value = await target.locator('option', { hasText: 'candidate - v1' }).first().getAttribute('value')
  await target.selectOption(value!)
  await page.getByLabel('Dataset version').selectOption({ index: 1 })
  await page.getByLabel('Judge').selectOption('heuristic')
  await expect(page.getByTestId('receipt')).toContainText('Answers from the bot')
  await page.getByRole('button', { name: 'Create and run' }).click()
  await expect(page).toHaveURL(/\/runs\/\d+/)
  await expect(page.getByTestId('gate-stamp').first()).toBeVisible({ timeout: 45_000 })
  await expect(page.getByText(/n=58/).first()).toBeVisible()
})

test('compare: verdict, metrics table, and a regressed case side by side', async ({ page }) => {
  await page.goto('/compare?baseline=1&candidate=2')
  await expect(page.getByTestId('verdict')).toContainText(/pass rate/i)
  await expect(page.getByTestId('forest-overall_pass_rate')).toBeVisible()
  await page.getByRole('button', { name: 'Table' }).click()
  await expect(page.getByTestId('metric-overall_pass_rate')).toContainText('pp')
  await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible()
  await page.getByRole('button', { name: /^Both answers for / }).first().click()
  await expect(page.getByText(/Baseline #1/)).toBeVisible()
  await page.getByRole('link', { name: 'open try' }).first().click()
  await expect(page.getByRole('heading', { name: 'Every check' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Expected' })).toBeVisible()
})

test('failures grouped by case, open one and inspect its trace', async ({ page }) => {
  await page.goto('/runs/1?tab=failures')
  await expect(page.getByRole('button', { name: /Retrieval miss/ })).toBeVisible()
  await page.getByRole('button', { name: /Retrieval miss/ }).click()
  await expect(page.getByRole('button', { name: 'Clear filter' })).toBeVisible()
  await page.locator('a[href^="/trials/"]').first().click()
  await expect(page.getByTestId('trial-verdict')).toBeVisible()
  await expect(page.getByText('Execution trace')).toBeVisible()
  await page.getByRole('button', { name: /retrieval/ }).first().click()
  await expect(page.getByText('Checks that graded this answer')).toBeVisible()
})

test('keyboard: command palette jumps to a run, j/k + Enter opens a case', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Control+k')
  await page.getByLabel('Search').fill('#2')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/runs\/2$/)
  await expect(page.getByRole('tab', { name: /Failures/ })).toBeVisible()
  await page.keyboard.press('3')
  await expect(page).toHaveURL(/tab=failures/)
  await expect(page.locator('a[href^="/trials/"]').first()).toBeVisible()
  await page.keyboard.press('j')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/trials\/\d+/)
})

test('label a calibration sample blind, then see agreement', async ({ page }) => {
  await page.goto('/calibration')
  await expect(page.getByTestId('label-progress')).toHaveText(/^0 of 30$/)
  await expect(page.getByTestId('label-card')).toBeVisible() // the keys label the card on top: wait for it
  await page.keyboard.press('f')
  await expect(page.getByTestId('label-progress')).toHaveText(/^1 of 30$/, { timeout: 10_000 })
  await page.getByRole('tab', { name: 'Agreement' }).click()
  await expect(page.getByText('Calibrated on 1 sample')).toBeVisible()
  await expect(page.getByTestId('cell-FAIL-FAIL')).toBeVisible()
})

test('connect a Python chatbot through the wizard', async ({ page }) => {
  await page.goto('/targets/new')
  await page.getByRole('radio', { name: /Python function/ }).click()
  await page.getByRole('button', { name: /Next: The request/ }).click()
  await page.getByLabel('Callable').fill('acme_support_agent.app:run')
  await page.getByLabel('Options (JSON)').fill('{"variant": "candidate"}')
  await page.getByRole('button', { name: /Next: Test and map/ }).click()
  await page.getByLabel('Test question').fill('How long is the warranty on Device Alpha?')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Check the mapping' }).click()
  await expect(page.getByText("What you'll get")).toBeVisible()
  await page.getByRole('button', { name: /Next: Safety and save/ }).click()
  // The chatbot is chosen first: only the demo exists, so this is a new one.
  await page.getByLabel('New chatbot name').fill('Wizard chatbot')
  await page.getByLabel('Connection name').fill('Wizard bot')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await expect(page).toHaveURL(/\/targets\/\d+/)
  await expect(page.getByRole('heading', { name: /Wizard bot/ })).toBeVisible()
})

test('gates are edited as rules, and a new gate shows at once', async ({ page }) => {
  await page.goto('/gates')
  const cards = page.getByRole('button', { name: 'Edit' })
  await expect(cards.first()).toBeVisible() // the seeded gate, so the count below is the loaded list
  const before = await cards.count()
  await page.getByRole('button', { name: 'New gate' }).first().click()
  await expect(page.getByLabel('Metric').first()).toBeVisible()
  const name = `E2E gate ${Date.now()}`
  await page.getByRole('textbox').first().fill(name)
  await page.getByRole('button', { name: 'Add rule' }).click()
  await page.getByRole('button', { name: 'Save gate' }).click()
  // The new card itself, without a reload (the page title "Release gates" must not count).
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  await expect(cards).toHaveCount(before + 1)
})

test('what to fix first: failures by cause, and the cause of one answer', async ({ page }) => {
  await page.goto('/runs/1')
  const fix = page.getByTestId('fix-first')
  await expect(fix).toBeVisible()
  await fix.getByRole('button', { name: 'Show' }).first().click()
  await expect(page.getByRole('button', { name: 'Clear filter' })).toBeVisible()
  await page.locator('td a[href^="/trials/"]').first().click() // a failing question's row, not a fingerprint dot
  await expect(page.getByTestId('cause-card')).toBeVisible()
  await expect(page.getByText('What to change:')).toBeVisible()
  await expect(page.getByTestId('trial-verdict')).toContainText('Failed:')
})
