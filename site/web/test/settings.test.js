import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import {
  DEFAULTS,
  applySettings,
  cleanFontScale,
  isDark,
  motionReduced,
  parseLatency,
  readLatency,
  readSettings,
  readTheme,
  serializeSettings,
} from '../src/lib/settings.js'

/**
 * The settings page's store (W12.15): what a stored value turns into, what
 * reaches <html>, that index.html's early script agrees with the library, and
 * the two claims index.css makes about its colours (high contrast at WCAG
 * AAA, the colour-blind palette further apart than the default), recomputed
 * from the CSS itself.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** A root element in miniature: a class list and a style. */
function fakeRoot(classes = []) {
  const set = new Set(classes)
  const props = new Map()
  return {
    classList: {
      toggle: (name, on) => (on ? set.add(name) : set.delete(name)),
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
    },
    style: { setProperty: (name, value) => props.set(name, value) },
    classes: () => [...set].sort(),
    prop: (name) => props.get(name),
  }
}

test('a stored value is read whole and valid, whatever was stored', () => {
  assert.deepEqual(readSettings(null), DEFAULTS)
  assert.deepEqual(readSettings('not json'), DEFAULTS)
  assert.deepEqual(readSettings('[1,2]'), DEFAULTS)
  assert.deepEqual(readSettings('null'), DEFAULTS)
  assert.deepEqual(readSettings(JSON.stringify({ contrast: 'more', fontScale: 1.2, palette: 'cb', reducedMotion: 'reduce' })), {
    contrast: 'more',
    fontScale: 1.2,
    palette: 'cb',
    reducedMotion: 'reduce',
  })
  assert.deepEqual(readSettings(JSON.stringify({ contrast: 'max', fontScale: 'big', palette: 'neon', reducedMotion: true })), DEFAULTS)
})

test('the font scale is clamped to 90-130 % and snapped to fives', () => {
  assert.equal(cleanFontScale(0.5), 0.9)
  assert.equal(cleanFontScale(2), 1.3)
  assert.equal(cleanFontScale(1.12), 1.1)
  assert.equal(cleanFontScale(1.13), 1.15)
  assert.equal(cleanFontScale('1.25'), 1.25)
  assert.equal(cleanFontScale(Number.NaN), 1)
  assert.equal(cleanFontScale(Infinity), 1)
  assert.equal(cleanFontScale(null), 1)
  // Every step reads back as written, not as 0.9000000000000001.
  for (let p = 90; p <= 130; p += 5) assert.equal(cleanFontScale(p / 100), p / 100)
})

test('what is written back holds only the known fields', () => {
  const written = JSON.parse(serializeSettings({ contrast: 'more', extra: '<script>', fontScale: 9 }))
  assert.deepEqual(Object.keys(written).sort(), ['contrast', 'fontScale', 'palette', 'reducedMotion'])
  // Out of range is not clamped when read back, as index.html's early script ignores it too.
  assert.equal(written.fontScale, 1)
  assert.equal(JSON.parse(serializeSettings({ fontScale: '1.2' })).fontScale, 1)
})

test('the theme is dark unless it says light or follows a light system', () => {
  assert.equal(readTheme(null), 'dark')
  assert.equal(readTheme('purple'), 'dark')
  assert.equal(readTheme('light'), 'light')
  assert.equal(readTheme('system'), 'system')
  assert.equal(isDark('dark', true), true)
  assert.equal(isDark('light', false), false)
  assert.equal(isDark('system', true), false)
  assert.equal(isDark('system', false), true)
})

test('reduced motion follows the system unless overridden', () => {
  assert.equal(motionReduced('system', true), true)
  assert.equal(motionReduced('system', false), false)
  assert.equal(motionReduced('reduce', false), true)
  assert.equal(motionReduced('allow', true), false)
})

test('the settings reach the root as classes and a custom property, and come off again', () => {
  const root = fakeRoot(['dark'])
  applySettings(root, { contrast: 'more', palette: 'cb', reducedMotion: 'reduce', fontScale: 1.15 })
  assert.deepEqual(root.classes(), ['contrast-more', 'dark', 'motion-reduce', 'palette-cb'])
  assert.equal(root.prop('--font-scale'), '1.15')
  applySettings(root, { reducedMotion: 'allow' })
  assert.deepEqual(root.classes(), ['dark', 'motion-allow'])
  assert.equal(root.prop('--font-scale'), '1')
  applySettings(root, DEFAULTS)
  assert.deepEqual(root.classes(), ['dark'])
})

test('a stored latency is a number in range; a typed one may say ms or use a comma', () => {
  assert.equal(readLatency(null), null)
  assert.equal(readLatency(''), null)
  assert.equal(readLatency('abc'), null)
  assert.equal(readLatency('42'), 42)
  assert.equal(readLatency('42.37'), 42.4)
  assert.equal(readLatency('5000'), null)
  assert.equal(readLatency('-300'), null)
  assert.equal(parseLatency('40'), 40)
  assert.equal(parseLatency(' 40 ms '), 40)
  assert.equal(parseLatency('12,5'), 12.5)
  assert.equal(parseLatency('-20'), -20)
  assert.equal(parseLatency('1e3'), null)
  assert.equal(parseLatency('0x20'), null)
  assert.equal(parseLatency('40 50'), null)
  assert.equal(parseLatency(''), null)
  assert.equal(parseLatency('2000'), null)
})

test('index.html applies the stored settings before the first frame as the library does', () => {
  const html = read('../index.html')
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  assert.equal(scripts.length, 1, 'one inline script: serve.mjs allows it by its hash')
  const cases = [
    {},
    { 'mides.theme': 'light' },
    { 'mides.theme': 'system', systemLight: true },
    { 'mides.theme': 'system', systemLight: false },
    { 'mides.lang': 'es', 'overtone.settings': JSON.stringify({ contrast: 'more', palette: 'cb', reducedMotion: 'reduce', fontScale: 1.2 }) },
    { 'overtone.settings': JSON.stringify({ reducedMotion: 'allow', fontScale: 0.9 }) },
    { 'overtone.settings': JSON.stringify({ fontScale: '1.2' }) },
    { 'overtone.settings': JSON.stringify({ fontScale: true }) },
    { 'overtone.settings': JSON.stringify({ fontScale: 1.125 }) },
    { 'overtone.settings': JSON.stringify({ contrast: 'MORE', palette: 1, reducedMotion: 'x', fontScale: 7 }) },
    { 'overtone.settings': '{broken' },
  ]
  for (const stored of cases) {
    const early = fakeRoot(['dark'])
    early.lang = 'en'
    const storage = { getItem: (key) => stored[key] ?? null }
    vm.runInNewContext(scripts[0], {
      document: { documentElement: early },
      localStorage: storage,
      matchMedia: () => ({ matches: Boolean(stored.systemLight) }),
      JSON,
      String,
    })

    const late = fakeRoot()
    const theme = readTheme(stored['mides.theme'] ?? null)
    late.classList.toggle('dark', isDark(theme, Boolean(stored.systemLight)))
    const settings = applySettings(late, readSettings(stored['overtone.settings'] ?? null))
    assert.deepEqual(early.classes(), late.classes(), JSON.stringify(stored))
    // The early script sets the size only when one was stored in range; the default is the CSS's own 1.
    // The library rounds to hundredths, which no one sees; anything more is a jump.
    assert.ok(Math.abs(Number(early.prop('--font-scale') ?? 1) - settings.fontScale) < 0.006, JSON.stringify(stored))
    assert.equal(early.lang, stored['mides.lang'] === 'es' ? 'es' : 'en')
  }

  // W13.23: the stream overlay's path, and only it, is marked see-through before the first frame.
  const marked = (pathname) => {
    const root = fakeRoot(['dark'])
    vm.runInNewContext(scripts[0], {
      document: { documentElement: root },
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false }),
      location: { pathname },
      JSON,
      String,
    })
    return root.classes().includes('overlay')
  }
  const id = 'a'.repeat(32)
  assert.equal(marked(`/overlay/${id}`), true)
  assert.equal(marked(`/overlay/${id}/`), true)
  for (const path of ['/', `/embed/${id}`, `/t/${id}`, '/overlay', `/overlay/${id}/x`, `/x/overlay/${id}`]) assert.equal(marked(path), false, path)
})

// ---- index.css's colour claims ----

const css = read('../src/index.css')

/** The custom properties declared in the block whose selector is exactly `selector`. */
function tokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(block, `index.css declares ${selector}`)
  return Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

const hex = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h)
  assert.ok(m, `${h} is a #rrggbb colour`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
}
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (h) => {
  const [r, g, b] = hex(h).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 2's contrast ratio. */
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT = tokens(':root')
const DARK = { ...LIGHT, ...tokens('.dark') }

test('high contrast puts every text colour at 7:1 or more on every surface, and lines at 3:1', () => {
  for (const [name, base, more] of [
    ['light', LIGHT, { ...LIGHT, ...tokens(':root:not(.dark).contrast-more') }],
    ['dark', DARK, { ...DARK, ...tokens('.dark.contrast-more') }],
  ]) {
    for (const ink of ['text', 'muted', 'dim', 'accent', 'red', 'amber', 'tempo']) {
      for (const ground of ['bg', 'surface', 'surface-2', 'surface-3']) {
        const ratio = contrast(more[ink], more[ground])
        assert.ok(ratio >= 7, `${name} ${ink} on ${ground}: ${ratio.toFixed(2)}:1`)
      }
      // And never lower than without it.
      assert.ok(contrast(more[ink], more.surface) >= contrast(base[ink], base.surface) - 1e-9, `${name} ${ink} is not lowered`)
    }
    assert.ok(contrast(more['line-strong'], more.bg) >= 3, `${name} line-strong on bg`)
    assert.ok(contrast(more['accent-ink'], more.accent) >= 7, `${name} the accent's ink`)
  }
})

/*
 * Machado, Oliveira and Fernandes (2009), severity 1.0: each deficiency as a
 * matrix on linear RGB. Distances are CIE76 ΔE in CIELAB (D65).
 */
const DEFICIENCIES = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
}

function lab(h, matrix) {
  const c = hex(h).map(linear)
  const [r, g, b] = matrix.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])))
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** The smallest distance between any two of the map's four signal colours, under every deficiency. */
function closest(t) {
  const colours = ['accent', 'red', 'amber', 'tempo'].map((name) => t[name])
  let min = Infinity
  for (const matrix of Object.values(DEFICIENCIES)) {
    const points = colours.map((h) => lab(h, matrix))
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) min = Math.min(min, Math.hypot(...points[i].map((v, k) => v - points[j][k])))
    }
  }
  return min
}

test('the colour-blind palette keeps the map\'s colours further apart than the default, in both themes', () => {
  const lightCb = { ...LIGHT, ...tokens(':root:not(.dark).palette-cb') }
  const darkCb = { ...DARK, ...tokens('.dark.palette-cb') }
  // Measured 2026-10-28, the studio palette (docs/design.md): default light 3.7, dark 11.5; colour-blind light 32.6, dark 42.2.
  assert.ok(closest(lightCb) >= 30, `light: ${closest(lightCb).toFixed(1)}`)
  assert.ok(closest(darkCb) >= 30, `dark: ${closest(darkCb).toFixed(1)}`)
  assert.ok(closest(lightCb) > closest(LIGHT) + 10, `light: ${closest(lightCb).toFixed(1)} against ${closest(LIGHT).toFixed(1)}`)
  assert.ok(closest(darkCb) > closest(DARK) + 10, `dark: ${closest(darkCb).toFixed(1)} against ${closest(DARK).toFixed(1)}`)
  // Each still reads against the panel it is painted on (AA for text, which the chips are).
  for (const [t, ground] of [
    [lightCb, LIGHT.surface],
    [darkCb, DARK.surface],
  ]) {
    for (const name of ['red', 'amber', 'tempo']) assert.ok(contrast(t[name], ground) >= 4.5, `${name} ${t[name]} on ${ground}`)
  }
})
