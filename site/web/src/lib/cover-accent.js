/**
 * The cover's accent (W13.24): the dominant colour of the picture in the
 * song's own tags (lib/tags.js `readCover`, the same one the .osz takes as its
 * background) tints the result page's header, gently, and only as far as the
 * text on it keeps WCAG AA's 4.5:1. Read in this browser from the reader's own
 * file; nothing is sent, nothing is kept beyond the page.
 *
 * Off under high contrast: a tint is decoration, and that setting asks for none.
 * The colour maths is here, pure; reading the picture is hooks/useCoverAccent.js.
 */

/** AA for normal text. */
export const AA = 4.5
/** The header's wash at its strongest, by theme: a tint, not a fill. */
export const WASH_ALPHA = { light: 0.14, dark: 0.18 }
/** A picture with less than this share of coloured pixels has no accent: greys tint nothing. */
const MIN_COLOURED = 0.06
const HUES = 24

/** `#rrggbb`, `#rgb` or `rgb(r, g, b)` as `[r, g, b]` (0..255); null when it is neither. */
export function parseColor(text) {
  const s = String(text ?? '').trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16))
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s)
  if (m) return [m[1], m[2], m[3]].map(Number)
  return null
}

export const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

/** WCAG 2's relative luminance. */
export function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2's contrast ratio of two colours, 1..21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `top` at `alpha` over `bottom`, both opaque `[r, g, b]`. */
export const blend = (top, bottom, alpha) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha))

function hsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function rgbOf([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/**
 * The dominant colour of RGBA pixels (a small thumbnail's `ImageData.data`):
 * the hue that most of the picture's coloured pixels share, weighted by how
 * coloured each is, as the mean of that hue's pixels. Greys, near-blacks and
 * near-whites count for nothing, so a black sleeve with a red title is red; a
 * picture that is almost all grey has no accent (null).
 */
export function dominantColor(pixels) {
  const weight = new Float64Array(HUES)
  const sums = Array.from({ length: HUES }, () => [0, 0, 0])
  let total = 0
  let coloured = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255
    if (alpha < 0.5) continue
    total += 1
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]]
    const [h, s, l] = hsl(rgb)
    const chroma = s * (1 - Math.abs(2 * l - 1))
    if (chroma < 0.12 || l < 0.08 || l > 0.94) continue
    coloured += 1
    const bucket = Math.floor(h / (360 / HUES)) % HUES
    weight[bucket] += chroma
    for (let c = 0; c < 3; c++) sums[bucket][c] += rgb[c] * chroma
  }
  if (!total || coloured / total < MIN_COLOURED) return null
  // A hue and its two neighbours together, so a colour on a bucket's edge is not split in two.
  let best = 0
  let bestWeight = -1
  for (let k = 0; k < HUES; k++) {
    const w = weight[(k + HUES - 1) % HUES] + weight[k] + weight[(k + 1) % HUES]
    if (w > bestWeight) {
      bestWeight = w
      best = k
    }
  }
  const keys = [(best + HUES - 1) % HUES, best, (best + 1) % HUES]
  const w = keys.reduce((s, k) => s + weight[k], 0)
  if (!(w > 0)) return null
  return [0, 1, 2].map((c) => keys.reduce((s, k) => s + sums[k][c], 0) / w)
}

/**
 * The header's colours for an accent `rgb` on the page's `bg`, with its
 * `text`, `muted` and `dim` inks:
 *
 * - `ink`, the accent as text (the eyebrow): its hue, its lightness moved
 *   towards the text until it reads at `AA` on the tinted background;
 * - `wash`, the accent at the theme's alpha for the background's strongest end;
 *
 * Every text on the header is checked against the background with the wash
 * blended in; the wash is thinned until they all pass. Null when nothing
 * passes (it never should with this site's inks), so the page stays as it was.
 */
export function accentFor(rgb, { bg, text, muted, dim, dark }) {
  if (!rgb || !bg || !text) return null
  let alpha = dark ? WASH_ALPHA.dark : WASH_ALPHA.light
  let ground = blend(rgb, bg, alpha)
  const inks = [text, muted, dim].filter(Boolean)
  while (alpha > 0.01 && inks.some((ink) => contrast(ink, ground) < AA)) {
    alpha -= 0.02
    ground = blend(rgb, bg, alpha)
  }
  if (inks.some((ink) => contrast(ink, ground) < AA)) return null
  // The ink: the accent's hue, saturation kept, lightness walked away from the background.
  const [h, s] = hsl(rgb)
  let l = hsl(rgb)[2]
  const step = dark ? 0.01 : -0.01
  let ink = rgbOf([h, s, l])
  // Both grounds: the wash's strong end and the bare page under its fading end.
  const passes = (c) => contrast(c, ground) >= AA && contrast(c, bg) >= AA
  while (!passes(ink) && l > 0 && l < 1) {
    l = Math.min(1, Math.max(0, l + step))
    ink = rgbOf([h, s, l])
  }
  if (!passes(ink)) return null
  return {
    ink: toHex(ink),
    wash: `rgba(${rgb.map((v) => Math.round(v)).join(', ')}, ${alpha.toFixed(2)})`,
    alpha,
  }
}
