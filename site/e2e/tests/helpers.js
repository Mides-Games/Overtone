import { expect } from '@playwright/test'

import { clickWav } from '../fixture.mjs'

/** The pages any visitor can open without an id, by path. */
export const PUBLIC_PAGES = [
  '/',
  '/analyze',
  '/queue',
  '/community',
  '/community?tab=reviews',
  '/community?tab=changelog',
  '/recent',
  '/compare',
  '/stats',
  '/how-it-works',
  '/faq',
  '/glossary',
  '/settings',
  '/timers',
  '/developers',
  '/login',
  '/status',
  '/terms',
  '/privacy',
  '/disclaimer',
  '/credits',
  '/no-such-page',
]

/**
 * Theme and language before the page's first script, as index.html reads
 * them. Once per tab: an init script runs on every load, and a reload must
 * keep what the page itself stored since.
 */
export async function prefer(page, { theme = 'dark', lang = 'en' } = {}) {
  await page.addInitScript(
    ([t, l]) => {
      if (sessionStorage.getItem('e2e.prefs')) return
      sessionStorage.setItem('e2e.prefs', '1')
      localStorage.setItem('mides.theme', t)
      localStorage.setItem('mides.lang', l)
    },
    [theme, lang],
  )
}

/** The page's main heading has rendered (lazy pages show a loader first). */
export async function ready(page) {
  await expect(page.locator('main h1').first()).toBeVisible()
}

/**
 * Upload the fixture WAV through the Analyze form, as one file, and land on
 * its result page. The form holds the file for this page's session, which is
 * what the .osz is built from.
 */
export async function uploadSong(page, name = 'E2E Artist - Click Song.wav', { rate } = {}) {
  await page.goto('/analyze')
  await page.locator('input#audio').setInputFiles({ name, mimeType: 'audio/wav', buffer: clickWav(rate) })
  await page.getByRole('button', { name: /^Analyze$/ }).click()
  await page.waitForURL(/\/analyze\/[0-9a-f]{32}$/)
  return page.url().split('/').pop()
}

/** No element makes the page scroll sideways. */
export async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0)
}

/** Sign in with the dev login's Google user, who is staff (a Mides moderator). */
export async function signInAsStaff(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await page.waitForURL(/\/profile$/)
}
