import { expect, test } from '@playwright/test'

import { LINES } from '../fixture.mjs'
import { expectNoHorizontalOverflow, prefer, ready, signInAsStaff, uploadSong } from './helpers.js'

/**
 * The site's main paths in a real browser (W10.6). The API is the dev one in
 * memory and the worker a fake that answers every job with fixture.mjs's
 * result, so these check the site's own work: forms, routing, polling,
 * drawing, downloads, sign-in, and none of the engine's.
 */

test.beforeEach(async ({ page }) => {
  await prefer(page)
})

test('home names the site and leads to the upload', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await expect(page).toHaveTitle(/Overtone/)
  await page.getByRole('navigation', { name: 'Overtone' }).first().getByRole('link', { name: 'Analyze' }).click()
  await expect(page).toHaveURL(/\/analyze$/)
  await ready(page)
})

test('an upload is queued, timed by the worker and drawn on its result page', async ({ page }) => {
  const id = await uploadSong(page)

  // The fake worker answers within about a second; the page polls until then.
  const table = page.locator('table').filter({ has: page.getByRole('columnheader') }).first()
  await expect(table).toBeVisible({ timeout: 20_000 })
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(LINES.length)
  for (const line of LINES) await expect(table).toContainText(String(line.bpm))

  // The tempo map is drawn: its canvas has painted pixels, not a blank box.
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('section canvas[aria-hidden="true"]')
    if (!canvas || !canvas.width || !canvas.height) return 0
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let lit = 0
    for (let i = 3; i < data.length; i += 4 * 16) if (data[i] > 0) lit++
    return lit
  })
  expect(painted).toBeGreaterThan(100)

  // The map's text alternative is the table (W10.2).
  await expect(page.locator('canvas[role="img"]')).toHaveAttribute('aria-describedby', await table.getAttribute('id'))

  // The song was picked in this session, so the .osz can be built at once.
  const osz = page.getByRole('button', { name: 'Download .osz' })
  await expect(osz).toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), osz.click()])
  expect(download.suggestedFilename()).toMatch(/\.osz$/)

  // The CSV is the API's, behind the uploader's cookie.
  await page.getByText('More downloads').click()
  const csv = page.locator(`a[href="/api/v1/analyses/${id}/timing.csv"]`)
  await expect(csv).toBeVisible()
  const response = await page.request.get(`/api/v1/analyses/${id}/timing.csv`)
  expect(response.status()).toBe(200)
  expect(await response.text()).toContain(String(LINES[1].time_ms))
})

test('the queue lists a song that was sent', async ({ page }) => {
  await uploadSong(page, 'Queue Artist - Queue Song.wav')
  await page.goto('/queue')
  await ready(page)
  await expect(page.getByText('Queue Song').first()).toBeVisible({ timeout: 20_000 })
})

test('the dev sign-in makes the Google user staff, who can post a suggestion', async ({ page }) => {
  await signInAsStaff(page)
  await ready(page)
  await page.goto('/community')
  await ready(page)
  await page.getByRole('button', { name: 'Suggest something' }).click()
  const title = `E2E suggestion ${Date.now()}`
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('What and why').fill('Posted by the end-to-end run.')
  await page.getByRole('button', { name: 'Post suggestion' }).click()
  await expect(page.getByText(title)).toBeVisible()
  // Staff see the moderation controls on it.
  await expect(page.getByText('Staff', { exact: false }).first()).toBeVisible()
})

test('the legal pages, the credits and the status page open', async ({ page }) => {
  for (const path of ['/terms', '/privacy', '/disclaimer', '/credits', '/status']) {
    await page.goto(path)
    await ready(page)
  }
  await expect(page.getByText(/in memory/i).first()).toBeVisible()
})

test('an unknown path is the 404 page', async ({ page }) => {
  await page.goto('/no-such-page')
  await expect(page.getByText('404')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible()
  await page.getByRole('link', { name: 'Back home' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('the language switch turns the page Spanish and is remembered', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await page.getByRole('button', { name: 'Cambiar a español' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('link', { name: 'Analizar' }).first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Switch to English' })).toBeVisible()
})

test('a Spanish visitor gets Spanish from the first frame, its strings loaded on demand', async ({ browser }) => {
  const page = await browser.newPage()
  await prefer(page, { lang: 'es' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('button', { name: 'Switch to English' })).toBeVisible()
  await page.close()
})

test('the theme switch turns the page light and is remembered', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Change theme' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.reload()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background)
})

test('the command palette opens with Ctrl+K and goes to a page', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await page.keyboard.press('Control+k')
  const field = page.getByRole('combobox')
  await expect(field).toBeFocused()
  await field.fill('queue')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/queue$/)
})

test('the keyboard reaches the skip link first, and every focus is visible', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await page.keyboard.press('Tab')
  const skip = page.locator('.skip-link')
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main-content')).toBeFocused()

  // The next stops, from the page's start: each shows an outline (or a ring).
  await page.reload()
  await ready(page)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    const shown = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return 'nothing focused'
      const style = getComputedStyle(el)
      const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      return ring || style.boxShadow !== 'none' ? 'ok' : `${el.tagName} ${el.className}`
    })
    expect(shown).toBe('ok')
  }
})

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  for (const path of ['/', '/analyze', '/queue', '/community', '/recent', '/stats', '/how-it-works', '/faq', '/glossary', '/settings', '/login', '/terms', '/credits', '/status']) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.goto(path)
      await ready(page)
      await expectNoHorizontalOverflow(page)
    })
  }

  test('a result page does not scroll sideways', async ({ page }) => {
    await uploadSong(page, 'Narrow - Song.wav')
    await expect(page.getByRole('button', { name: 'Download .osz' })).toBeVisible({ timeout: 20_000 })
    await expectNoHorizontalOverflow(page)
  })
})
