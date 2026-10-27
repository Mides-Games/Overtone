import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

import { PUBLIC_PAGES, prefer, ready, signInAsStaff, uploadSong } from './helpers.js'

/**
 * WCAG 2.2 AA through axe-core (W10.2), on every page in both themes. axe
 * finds what a machine can: contrast, names, labels, landmarks, ARIA misuse.
 * Keyboard order, focus visibility and what a screen reader says are not in
 * its reach; docs/site.md says what was checked by hand.
 *
 * A failure prints each rule, its impact and the first elements it hit.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function audit(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const summary = violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    first: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    why: v.nodes[0]?.failureSummary,
  }))
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([])
}

for (const theme of ['dark', 'light']) {
  test.describe(`axe, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await prefer(page, { theme })
    })

    for (const path of PUBLIC_PAGES) {
      test(path, async ({ page }) => {
        await page.goto(path)
        await ready(page)
        // Lists and the status page fill in after their first request.
        await page.waitForLoadState('networkidle')
        await audit(page)
      })
    }

    test('a result page, running then done', async ({ page }) => {
      // A song not timed before (its own rate, so its own SHA-1), held by the
      // fake worker for 8 s: the progress panel is audited too.
      await uploadSong(page, `Axe ${theme} - Slow Song.wav`, { rate: theme === 'dark' ? 24_000 : 26_000 })
      await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 10_000 })
      await audit(page)
      await expect(page.getByRole('button', { name: 'Download .osz' })).toBeVisible({ timeout: 20_000 })
      await audit(page)
    })

    test('profile and history, signed in as staff', async ({ page }) => {
      await signInAsStaff(page)
      await ready(page)
      await audit(page)
      await page.goto('/history')
      await ready(page)
      await page.waitForLoadState('networkidle')
      await audit(page)
    })
  })
}
