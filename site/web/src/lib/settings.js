/**
 * The visitor's display settings (W12.15), kept in this browser and nowhere
 * else (ADR-W6: no account needed). Pure, so the tests reach it without a
 * browser; context/SettingsContext.jsx holds the live copy and index.html
 * applies the stored one before the first frame.
 *
 * Three keys, each read defensively, because another tab, an older build or a
 * hand edit can leave anything in them:
 *  - `overtone.settings`: contrast, font scale, the map's palette, motion;
 *  - `mides.theme`: the theme, shared with midesprojects.com (ThemeContext),
 *    so it is not copied here. It gains a third value, `system`; a reader that
 *    knows only `light` and `dark` falls back to its default, as it already
 *    did for a missing key;
 *  - `overtone.player.latencyMs`: the device's output latency, written by the
 *    player's calibration (W12.2) and only shown, reset or typed in here.
 * The language keeps its own key too (`mides.lang`, i18n.js).
 */
export const SETTINGS_KEY = 'overtone.settings'
export const THEME_KEY = 'mides.theme'
export const LATENCY_KEY = 'overtone.player.latencyMs'

export const THEMES = ['system', 'dark', 'light']
export const CONTRASTS = ['normal', 'more']
export const PALETTES = ['default', 'cb']
export const MOTIONS = ['system', 'reduce', 'allow']

/** The font scale's range and step: 90 % to 130 % in fives, so a slider lands on whole percents. */
export const FONT_MIN = 0.9
export const FONT_MAX = 1.3
export const FONT_STEP = 0.05

/**
 * The latency a reader may type. A device's output latency is positive and
 * rarely past a few hundred ms (Bluetooth); a little below zero is allowed
 * because a calibration by ear can land there, and a second is the ceiling
 * past which the number is a typo, not a device.
 */
export const LATENCY_MIN = -250
export const LATENCY_MAX = 1000

export const DEFAULTS = Object.freeze({ contrast: 'normal', fontScale: 1, palette: 'default', reducedMotion: 'system' })

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/** A font scale clamped to the range and snapped to its step; anything else is 1. */
export function cleanFontScale(value) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, n))
  // toFixed: 18 × 0.05 is 0.9000000000000001, and the stored value should read as written.
  return Number((Math.round(clamped / FONT_STEP) * FONT_STEP).toFixed(2))
}

/**
 * A stored font scale: kept when it is in range, 1 when it is not. Not
 * clamped, unlike a slider's value: index.html's early script ignores an
 * out-of-range value too, and the two must agree or the text would jump once
 * the app starts.
 */
function storedFontScale(value) {
  return typeof value === 'number' && value >= FONT_MIN && value <= FONT_MAX ? Number(value.toFixed(2)) : 1
}

/** `overtone.settings` as stored (a string or null) to a whole, valid settings object. */
export function readSettings(raw) {
  let stored = {}
  try {
    const parsed = JSON.parse(raw ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
  } catch {
    // Not JSON: the defaults.
  }
  return {
    contrast: pick(stored.contrast, CONTRASTS, DEFAULTS.contrast),
    fontScale: storedFontScale(stored.fontScale),
    palette: pick(stored.palette, PALETTES, DEFAULTS.palette),
    reducedMotion: pick(stored.reducedMotion, MOTIONS, DEFAULTS.reducedMotion),
  }
}

/** What is written back: only the known fields, cleaned, so a stored object never grows junk. */
export const serializeSettings = (settings) => JSON.stringify(readSettings(JSON.stringify(settings ?? {})))

/** `mides.theme` to a theme; a missing or unknown value is dark, the site's default. */
export const readTheme = (raw) => pick(raw, THEMES, 'dark')

/** Whether `theme` comes out dark, given whether the system prefers light. */
export const isDark = (theme, systemLight) => (theme === 'system' ? !systemLight : theme !== 'light')

/**
 * Whether motion is cut: the reader's override, or the system's preference
 * when they left it to the system.
 */
export const motionReduced = (setting, systemReduce) => (setting === 'system' ? Boolean(systemReduce) : setting === 'reduce')

/**
 * The settings on the root element: a class per choice (index.css keys its
 * tokens and its motion rule on them; the tempo map repaints when the root's
 * classes change) and the font scale as a custom property. `root` needs only
 * `classList.toggle` and `style.setProperty`, so a test passes a stand-in.
 */
export function applySettings(root, settings) {
  const s = readSettings(JSON.stringify(settings ?? {}))
  root.classList.toggle('contrast-more', s.contrast === 'more')
  root.classList.toggle('palette-cb', s.palette === 'cb')
  root.classList.toggle('motion-reduce', s.reducedMotion === 'reduce')
  root.classList.toggle('motion-allow', s.reducedMotion === 'allow')
  root.style.setProperty('--font-scale', String(s.fontScale))
  return s
}

/** The stored latency in ms, or null when there is none or it is out of range. */
export function readLatency(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= LATENCY_MIN && n <= LATENCY_MAX ? Math.round(n * 10) / 10 : null
}

/**
 * A typed latency to the number to store, or null when it is not one. A comma
 * is a decimal point (the Spanish keyboard's), and a trailing "ms" is allowed.
 */
export function parseLatency(text) {
  const clean = String(text ?? '')
    .trim()
    .replace(/\s*ms$/i, '')
    .replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null
  return readLatency(clean)
}
