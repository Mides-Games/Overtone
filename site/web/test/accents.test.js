import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ACCENTS as API_ACCENTS } from '../../api/src/utils/profile.js'
import { ACCENT_NAMES, ACCENTS, accentProps, contrast } from '../src/lib/accents.js'

/**
 * A profile's accent (2026-10-28) is text and a button fill on that person's
 * page, in both themes: each colour must read at WCAG AA (4.5:1) on every
 * surface of its theme, and its ink must read on it. The surfaces are read
 * from index.css, so a change to the theme re-checks the palette.
 */
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const block = (selector) => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, selector)
  return css.slice(start, css.indexOf('}', start))
}
const token = (text, name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(text)[1]
const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3']
const themes = {
  light: SURFACES.map((name) => token(block(':root'), name)),
  dark: SURFACES.map((name) => token(block('.dark'), name)),
}

test('the palette is the API\'s, name for name', () => {
  assert.deepEqual(ACCENT_NAMES, API_ACCENTS)
})

test('every accent reads at AA on every surface of its theme, and its ink reads on it', () => {
  for (const [name, set] of Object.entries(ACCENTS)) {
    for (const theme of ['light', 'dark']) {
      for (const key of ['accent', 'hover']) {
        for (const surface of themes[theme]) {
          const ratio = contrast(set[theme][key], surface)
          assert.ok(ratio >= 4.5, `${name} ${theme} ${key} on ${surface}: ${ratio.toFixed(2)}`)
        }
        const ink = contrast(set[theme].ink, set[theme][key])
        assert.ok(ink >= 4.5, `${name} ${theme} ink on ${key}: ${ink.toFixed(2)}`)
      }
    }
  }
})

test('the default and an unknown name leave the site\'s accent alone', () => {
  assert.deepEqual(accentProps(null), {})
  assert.deepEqual(accentProps('chartreuse'), {})
  assert.equal(accentProps('blue').className, 'profile-accent')
  // The class the props name is in the stylesheet, for both themes, and steps aside for high contrast.
  assert.match(css, /:root:not\(\.contrast-more\) \.profile-accent \{/)
  assert.match(css, /:root\.dark:not\(\.contrast-more\) \.profile-accent \{/)
})
