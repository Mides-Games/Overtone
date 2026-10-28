/**
 * The tempo map as an image (W12.18), to post on a forum or in a chat.
 *
 * - **SVG**: a reduced drawing written here, not the canvas: the red lines
 *   with their BPM, each line's tempo as a step, the engine's local tempo as a
 *   curve, each section's confidence along the foot, and a ruler. Pure: a
 *   string from the data and a palette, so it is tested without a browser and
 *   the embed page (`/embed/<id>`) draws its small chart with it too.
 * - **PNG**: the page's own painting (draw.js `paintMap`) of the whole song
 *   on an offscreen canvas, under a title line, through `toBlob`.
 *
 * Neither carries audio or anything the timing's page does not already show.
 */
import { LEVEL_TONE, layout, niceStep, paintMap, tempoRange } from '../components/result/draw.js'
import { formatBpm, formatRuler } from './timing.js'

/** The dark theme's tokens (index.css), for an image made away from the page. */
export const DARK = Object.freeze({
  bg: '#0d0b12', lane: '#19161f', line: '#26222f', lineStrong: '#353044', text: '#efecf5', dim: '#8f88a1',
  accent: '#3fd0dc', red: '#ff5d6c', amber: '#f5b44a', lavender: '#a996ff', grid: 'rgba(255, 255, 255, 0.06)',
})

const esc = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const n = (v) => (Math.round(v * 10) / 10).toString()

/** At most `max` points of a curve, keeping the extremes of each bucket so a spike is not lost. */
export function decimate(xs, ys, max) {
  if (xs.length <= max) return xs.map((x, i) => [x, ys[i]])
  const out = []
  const per = xs.length / (max / 2)
  for (let b = 0; b < xs.length; b += per) {
    let lo = Math.floor(b)
    let hi = lo
    for (let i = Math.floor(b); i < Math.min(xs.length, Math.floor(b + per)); i++) {
      if (ys[i] < ys[lo]) lo = i
      if (ys[i] > ys[hi]) hi = i
    }
    for (const i of lo <= hi ? [lo, hi] : [hi, lo]) if (out.at(-1)?.[0] !== xs[i]) out.push([xs[i], ys[i]])
  }
  return out
}

/**
 * The SVG of a timing. `lines` are the page's lines (lib/timing.js
 * `adjustLines`), `sections` the result's, `beats` its `{ t_ms, bpm }` or
 * null. `title` and `note` are text, escaped here. Returns the document.
 */
export function mapSvg({ lines, sections = [], beats = null, durationS, factor = 1, title = '', note = '', palette = DARK, width = 1200, height = 340, compact = false }) {
  const c = palette
  const pad = compact ? 10 : 24
  const head = title || note ? (compact ? 0 : 52) : 0
  const x0 = pad + (compact ? 30 : 40)
  const x1 = width - pad
  const top = pad + head + (compact ? 4 : 22)
  const bottom = height - pad - (compact ? 16 : 22)
  const dur = Math.max(durationS || 0, (lines.at(-1)?.timeMs ?? 0) / 1000 + 1, 1)
  const X = (s) => x0 + (s / dur) * (x1 - x0)
  const { lo, hi } = tempoRange(lines, beats, factor)
  const Y = (b) => bottom - 6 - ((Math.min(Math.max(b, lo), hi) - lo) / (hi - lo)) * (bottom - 6 - top)
  const out = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Cascadia Mono', Consolas, ui-monospace, monospace">`)
  out.push(`<rect width="${width}" height="${height}" fill="${c.bg}"/>`)
  if (head) {
    out.push(`<text x="${pad}" y="${pad + 20}" font-size="20" font-weight="700" fill="${c.text}" font-family="Bahnschrift, 'DIN Alternate', 'Segoe UI', sans-serif">${esc(title)}</text>`)
    if (note) out.push(`<text x="${pad}" y="${pad + 42}" font-size="12" fill="${c.dim}">${esc(note)}</text>`)
  }
  out.push(`<rect x="${n(x0)}" y="${n(top)}" width="${n(x1 - x0)}" height="${n(bottom - top)}" rx="6" fill="${c.lane}"/>`)

  // BPM guides and their labels.
  const step = niceStep(hi - lo, compact ? 3 : 4)
  for (let b = Math.ceil(lo / step) * step; b <= hi; b += step) {
    const y = n(Y(b))
    out.push(`<line x1="${n(x0)}" x2="${n(x1)}" y1="${y}" y2="${y}" stroke="${c.grid}"/>`)
    out.push(`<text x="${n(x0 - 5)}" y="${y}" font-size="10" fill="${c.dim}" text-anchor="end" dominant-baseline="middle">${Number.isInteger(b) ? b : b.toFixed(1)}</text>`)
  }

  // The engine's local tempo, as a curve.
  const bt = beats?.t_ms ?? []
  const bb = beats?.bpm ?? []
  if (bt.length > 1 && bb.length === bt.length) {
    const points = decimate(bt, bb, compact ? 400 : 1500)
    out.push(`<polyline fill="none" stroke="${c.lavender}" stroke-width="1.4" stroke-linejoin="round" points="${points.map(([t, b]) => `${n(X(t / 1000))},${n(Y(b * factor))}`).join(' ')}"/>`)
  }

  // Each red line's BPM as a step over its section, its confidence along the foot.
  const bounds = lines.map((l) => l.timeMs / 1000).concat([dur])
  lines.forEach((line, i) => {
    const a = Math.max(X(bounds[i]), x0)
    const b = Math.min(X(bounds[i + 1]), x1)
    if (b <= a) return
    out.push(`<line x1="${n(a)}" x2="${n(b)}" y1="${n(Y(line.bpm))}" y2="${n(Y(line.bpm))}" stroke="${c.red}" stroke-width="2"/>`)
    const tone = c[LEVEL_TONE[sections[line.index]?.level] ?? 'dim']
    out.push(`<rect x="${n(a)}" y="${n(bottom - 5)}" width="${n(Math.max(1, b - a - 1))}" height="4" fill="${tone}"/>`)
  })

  // The red lines themselves, a label where there is room for one.
  let lastLabel = -Infinity
  lines.forEach((line) => {
    const x = X(line.timeMs / 1000)
    if (x < x0 - 0.5 || x > x1 + 0.5) return
    out.push(`<line x1="${n(x)}" x2="${n(x)}" y1="${n(top)}" y2="${n(bottom)}" stroke="${c.red}" stroke-width="1.2"/>`)
    if (x - lastLabel >= (compact ? 44 : 64)) {
      out.push(`<text x="${n(x + 3)}" y="${n(top + 12)}" font-size="${compact ? 10 : 11}" fill="${c.red}">${esc(formatBpm(line.bpm))}</text>`)
      lastLabel = x
    }
  })

  // The ruler.
  const tstep = niceStep(dur, Math.max(3, Math.floor((x1 - x0) / 90)))
  for (let s = 0; s <= dur + 1e-9; s += tstep) {
    const x = n(X(s))
    out.push(`<line x1="${x}" x2="${x}" y1="${n(bottom)}" y2="${n(bottom + 4)}" stroke="${c.lineStrong}"/>`)
    out.push(`<text x="${x}" y="${n(bottom + 15)}" font-size="10" fill="${c.dim}" text-anchor="middle">${formatRuler(s)}</text>`)
  }
  out.push('</svg>')
  return out.join('\n')
}

/** An SVG as a data: URL, for an <img> (which never runs script, and the SVG has none). */
export const svgDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/**
 * The page's own map of the whole song as a PNG: `data` is what TempoMap
 * paints, `palette` the theme's (draw.js `readPalette`). Twice the pixels
 * for a sharp image; a title line above. Resolves to a Blob.
 */
export function mapPng({ data, palette, title = '', note = '', width = 1400, scale = 2 }) {
  const L = layout(width)
  const head = 52
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = (L.height + head + 12) * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, width, L.height + head + 12)
  ctx.fillStyle = palette.text
  ctx.font = "700 20px Bahnschrift, 'DIN Alternate', 'Segoe UI', sans-serif"
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(title, 12, 26)
  ctx.fillStyle = palette.dim
  ctx.font = "12px 'Cascadia Mono', Consolas, ui-monospace, monospace"
  ctx.fillText(note, 12, 44)
  ctx.translate(0, head)
  paintMap(ctx, L, { a: 0, b: Math.max(data.durationS, 1) }, { ...data, selected: null, hovered: null }, palette)
  // paintMap clears its own area first: the background goes in behind it after.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png'))
}

/** The snippet a forum or a site pastes to show a published timing (`/embed/<id>`). */
export const embedCode = (origin, id, title = 'Overtone timing') =>
  `<iframe src="${origin}/embed/${id}" title="${esc(title)}" width="560" height="320" style="border:0;max-width:100%" loading="lazy"></iframe>`
