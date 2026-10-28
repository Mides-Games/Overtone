#!/usr/bin/env node
/**
 * Screenshots of every page, at 1366 and 375 px, dark and light, English and
 * Spanish, and the console errors each one logged: what the site-ui-check
 * skill (.claude/skills/site-ui-check) looks at.
 *
 *   node site/e2e/screens.mjs --base http://127.0.0.1:5204 --out <folder> [--lang en,es] [--pages /,/queue]
 *
 * The site must already run (pnpm dev, or the e2e servers). It only reads:
 * no upload, no sign-in. Exits 1 if any page logged a console error or
 * scrolled sideways, and prints which.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { chromium } from '@playwright/test'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
)
const base = args.base ?? 'http://127.0.0.1:5290'
const out = resolve(args.out ?? 'site/e2e/test-results/screens')
const langs = (args.lang ?? 'en,es').split(',')
const pages = (args.pages ??
  '/,/analyze,/queue,/community,/recent,/compare,/stats,/how-it-works,/faq,/glossary,/settings,/login,/status,/terms,/privacy,/disclaimer,/credits,/no-such-page').split(',')
const WIDTHS = [
  { name: '1366', width: 1366, height: 900 },
  { name: '375', width: 375, height: 812 },
]

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const problems = []
let shots = 0

for (const lang of langs) {
  for (const theme of ['dark', 'light']) {
    for (const size of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } })
      await context.addInitScript(
        ([t, l]) => {
          localStorage.setItem('mides.theme', t)
          localStorage.setItem('mides.lang', l)
        },
        [theme, lang],
      )
      for (const path of pages) {
        const page = await context.newPage()
        const errors = []
        // A 401 is the signed-out visitor's /me and the like: expected, and
        // Chromium logs every failed request as a console error.
        page.on('console', (message) => {
          if (message.type() === 'error' && !/status of 401/.test(message.text())) errors.push(message.text())
        })
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(base + path, { waitUntil: 'networkidle' })
        await page.locator('main h1').first().waitFor({ timeout: 15_000 }).catch(() => errors.push('no <h1> in <main>'))
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        const file = `${lang}-${theme}-${size.name}${path === '/' ? '-home' : path.replace(/[^a-z0-9]+/gi, '-')}.png`
        await page.screenshot({ path: join(out, file), fullPage: true })
        shots++
        const where = `${lang} ${theme} ${size.name} ${path}`
        if (overflow > 0) problems.push(`${where}: scrolls sideways by ${overflow} px`)
        for (const error of errors) problems.push(`${where}: ${error}`)
        await page.close()
      }
      await context.close()
    }
  }
}
await browser.close()

console.log(`${shots} screenshots in ${out}`)
for (const problem of problems) console.log(`problem: ${problem}`)
process.exit(problems.length ? 1 : 0)
