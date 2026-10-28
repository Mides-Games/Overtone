import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { AA, accentFor, blend, contrast, dominantColor, parseColor, WASH_ALPHA } from '../src/lib/cover-accent.js'
import { countIn, practiceAt, practicePlan, practiceRates } from '../src/lib/practice.js'
import { BAR, BEAT, clickGrid } from '../src/lib/timing.js'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
/** A theme's tokens from index.css: `:root` for light, `.dark` for dark. */
function tokens(selector) {
  const block = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))[1]
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const themes = {
  light: { ...tokens(':root'), dark: false },
  dark: { ...tokens(':root'), ...tokens('.dark'), dark: true },
}
const inks = (theme) => ({ bg: parseColor(theme.bg), text: parseColor(theme.text), muted: parseColor(theme.muted), dim: parseColor(theme.dim), dark: theme.dark })

/** RGBA pixels: `count` of each `[r, g, b]` given. */
const pixels = (...runs) => Uint8ClampedArray.from(runs.flatMap(([rgb, count]) => Array.from({ length: count }, () => [...rgb, 255]).flat()))

test('colours parse from hex and rgb()', () => {
  assert.deepEqual(parseColor('#076672'), [7, 102, 114])
  assert.deepEqual(parseColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseColor('rgba(26, 23, 36, 0.09)'), [26, 23, 36])
  assert.equal(parseColor('teal'), null)
  assert.ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 1e-9)
})

test('the dominant colour is the cover\'s main hue, not its greys', () => {
  // A black sleeve with a red title: red, though black covers most of it.
  const red = dominantColor(pixels([[10, 10, 10], 700], [[200, 30, 40], 200], [[240, 240, 240], 100]))
  assert.ok(red[0] > 150 && red[1] < 60 && red[2] < 70, String(red))
  // Blue over a little orange: blue.
  const blue = dominantColor(pixels([[30, 80, 200], 600], [[230, 140, 20], 200]))
  assert.ok(blue[2] > blue[0], String(blue))
  // Grey all over has no accent.
  assert.equal(dominantColor(pixels([[128, 128, 128], 900], [[60, 60, 60], 100])), null)
  // Transparent pixels are not part of the picture.
  assert.equal(dominantColor(Uint8ClampedArray.from([200, 30, 40, 0, 200, 30, 40, 0])), null)
})

test('the accent keeps AA on both themes, for any cover colour', () => {
  const covers = [[255, 0, 0], [255, 230, 0], [0, 200, 255], [20, 0, 60], [240, 240, 255], [0, 128, 0], [255, 0, 255], [90, 60, 30]]
  for (const [name, theme] of Object.entries(themes)) {
    const page = inks(theme)
    for (const rgb of covers) {
      const accent = accentFor(rgb, page)
      assert.ok(accent, `${name} ${rgb}`)
      assert.ok(accent.alpha <= (page.dark ? WASH_ALPHA.dark : WASH_ALPHA.light) + 1e-9)
      const ground = blend(rgb, page.bg, accent.alpha)
      const ink = parseColor(accent.ink)
      for (const [label, colour] of [['text', page.text], ['muted', page.muted], ['dim', page.dim], ['ink', ink]]) {
        assert.ok(contrast(colour, ground) >= AA, `${name} ${rgb}: ${label} on the wash is ${contrast(colour, ground).toFixed(2)}`)
        assert.ok(contrast(colour, page.bg) >= AA, `${name} ${rgb}: ${label} on the page is ${contrast(colour, page.bg).toFixed(2)}`)
      }
    }
  }
})

test('an accent the page cannot carry is refused rather than forced', () => {
  // A page whose muted ink already fails AA on its own background: no wash can fix that.
  assert.equal(accentFor([255, 0, 0], { bg: [255, 255, 255], text: [0, 0, 0], muted: [200, 200, 200], dark: false }), null)
  assert.equal(accentFor(null, inks(themes.light)), null)
})

test('practice rates climb evenly from half speed to full', () => {
  assert.deepEqual(practiceRates(4), [0.5, 0.67, 0.83, 1])
  assert.deepEqual(practiceRates(6), [0.5, 0.6, 0.7, 0.8, 0.9, 1])
  assert.deepEqual(practiceRates(1), [1])
  assert.deepEqual(practiceRates(3, 0.6, 0.9), [0.6, 0.75, 0.9])
})

test('the count-in is one bar of the grid before the stretch, in its own meter', () => {
  const lines = [{ timeMs: 0, beatMs: 500, meter: 4, bpm: 120 }, { timeMs: 8000, beatMs: 400, meter: 3, bpm: 150 }]
  const grid = clickGrid(lines, 20)
  const four = countIn(grid, 4)
  assert.deepEqual(four.map((c) => c.s), [-2, -1.5, -1, -0.5])
  assert.deepEqual(four.map((c) => c.level), [BAR, BEAT, BEAT, BEAT])
  const three = countIn(grid, 9.2)
  assert.equal(three.length, 3)
  assert.ok(Math.abs(three[0].s + 1.2) < 1e-9)
  // No grid: four beats at 120 BPM.
  assert.deepEqual(countIn({ t: [], level: [] }, 3).map((c) => c.s), [-2, -1.5, -1, -0.5])
})

test('a practice plan counts in at the first rate and plays each repetition back to back', () => {
  const count = countIn(null, 10)
  const plan = practicePlan({ a: 10, b: 14, rates: [0.5, 1], count })
  // Four beats of 0.5 s at half speed: 4 s of count-in.
  assert.deepEqual(plan.counts.map((c) => c.at), [0, 1, 2, 3])
  assert.deepEqual(plan.reps, [
    { at: 4, end: 12, rate: 0.5 },
    { at: 12, end: 16, rate: 1 },
  ])
  assert.equal(plan.end, 16)
  assert.deepEqual(practiceAt(plan, 2), { rep: -1, pos: 10, rate: 0.5, done: false })
  assert.deepEqual(practiceAt(plan, 6), { rep: 0, pos: 11, rate: 0.5, done: false })
  assert.deepEqual(practiceAt(plan, 13), { rep: 1, pos: 11, rate: 1, done: false })
  assert.deepEqual(practiceAt(plan, 20), { rep: 1, pos: 14, rate: 1, done: true })
  // Without a count-in the first repetition starts at once.
  assert.equal(practicePlan({ a: 0, b: 1, rates: [1] }).reps[0].at, 0)
})
