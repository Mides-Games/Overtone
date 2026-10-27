#!/usr/bin/env node
/**
 * The PNG icons (W10.3), drawn from public/favicon.svg by code, with Node's
 * own zlib and nothing else:
 *
 *   node site/web/scripts/icons.mjs
 *
 * Why not a rasterizer package: the mark is one rounded square and one
 * stroked path of lines and Béziers, and a dependency (sharp, resvg) would be
 * a native binary or a WebAssembly build in the install for six files. So
 * this reads the SVG's own numbers (the square, the path, its stroke and
 * transform), flattens the curves, and gives every pixel the coverage of its
 * distance to the shape, as assets/logo.py does for the desktop icon.
 *
 * It understands exactly what favicon.svg holds (one <rect>, one <path> of
 * absolute M/L/C/Q, a translate+scale transform) and stops with a message on
 * anything else, so a new logo cannot come out silently wrong.
 *
 * Outputs, in site/web/public:
 *   favicon-32.png         browsers without SVG favicons
 *   apple-touch-icon.png   180, square and opaque (iOS rounds it itself)
 *   icon-192.png           manifest, rounded as the SVG
 *   icon-512.png           manifest, rounded as the SVG
 *   icon-maskable-512.png  manifest "maskable": full bleed, the mark inside
 *                          the central 80 % that every mask keeps
 *   og-image.png           1200x630 link preview: the mark on the page colour
 *
 * test/icons.test.js decodes the committed files and compares them pixel for
 * pixel with a fresh render, so an edit to the SVG without a re-run fails.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** The site's dark page colour (src/index.css, .dark --bg): behind the link preview. */
const PAGE = [0x0d, 0x0b, 0x12]

const hex = (value) => {
  const m = /^#([0-9a-f]{6})$/i.exec(value ?? '')
  if (!m) throw new Error(`icons: "${value}" is not a #rrggbb colour`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/**
 * The mark in favicon.svg as numbers: `{ box, radius, background, stroke,
 * width, segments }`, the segments already transformed into the viewBox.
 */
export function readMark(svg) {
  const viewBox = attr(/<svg[^>]*>/.exec(svg)?.[0] ?? '', 'viewBox')?.split(/\s+/).map(Number)
  const rects = svg.match(/<rect[^>]*>/g) ?? []
  const paths = svg.match(/<path[^>]*>/g) ?? []
  if (!viewBox || viewBox.length !== 4 || viewBox[0] || viewBox[1] || rects.length !== 1 || paths.length !== 1) {
    throw new Error('icons: favicon.svg is no longer one <rect> and one <path> in a 0 0 w h viewBox; update scripts/icons.mjs')
  }
  const [rect] = rects
  const [path] = paths
  const transform = attr(path, 'transform') ?? ''
  const t = /^translate\(([-\d.]+)[ ,]+([-\d.]+)\)\s*scale\(([-\d.]+)\)$/.exec(transform.trim())
  if (transform && !t) throw new Error(`icons: the transform "${transform}" is not translate(x y) scale(s)`)
  const [tx, ty, s] = t ? t.slice(1).map(Number) : [0, 0, 1]
  if (attr(path, 'fill') !== 'none') throw new Error('icons: the path is expected to be a stroke with fill="none"')

  return {
    box: viewBox[2],
    radius: Number(attr(rect, 'rx') ?? 0),
    background: hex(attr(rect, 'fill')),
    stroke: hex(attr(path, 'stroke')),
    width: Number(attr(path, 'stroke-width')) * s,
    segments: flatten(attr(path, 'd')).map(([x0, y0, x1, y1]) => [tx + x0 * s, ty + y0 * s, tx + x1 * s, ty + y1 * s]),
  }
}

/** Absolute M/L/C/Q path data to line segments; each curve in 32 straight steps. */
export function flatten(d) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const out = []
  let i = 0
  let x = 0
  let y = 0
  let command = null
  const num = () => {
    const value = Number(tokens[i++])
    if (!Number.isFinite(value)) throw new Error('icons: the path data ends early')
    return value
  }
  const curve = (point) => {
    for (let k = 1; k <= 32; k++) {
      const [nx, ny] = point(k / 32)
      out.push([x, y, nx, ny])
      x = nx
      y = ny
    }
  }
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    if (command === 'M') {
      x = num()
      y = num()
      command = 'L' // further pairs after an M are lines
    } else if (command === 'L') {
      const nx = num()
      const ny = num()
      out.push([x, y, nx, ny])
      x = nx
      y = ny
    } else if (command === 'C') {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = [x, y, num(), num(), num(), num(), num(), num()]
      curve((u) => {
        const v = 1 - u
        return [
          v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
          v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3,
        ]
      })
    } else if (command === 'Q') {
      const [x0, y0, x1, y1, x2, y2] = [x, y, num(), num(), num(), num()]
      curve((u) => {
        const v = 1 - u
        return [v * v * x0 + 2 * v * u * x1 + u * u * x2, v * v * y0 + 2 * v * u * y1 + u * u * y2]
      })
    } else {
      throw new Error(`icons: path command "${command}" is not supported (absolute M, L, C and Q only)`)
    }
  }
  return out
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function segmentDistance(px, py, [x0, y0, x1, y1]) {
  const dx = x1 - x0
  const dy = y1 - y0
  const length2 = dx * dx + dy * dy
  const u = length2 ? clamp01(((px - x0) * dx + (py - y0) * dy) / length2) : 0
  const ex = px - (x0 + u * dx)
  const ey = py - (y0 + u * dy)
  return Math.sqrt(ex * ex + ey * ey)
}

/** Coverage (0..1) of a w x h rectangle with corner radius r at a pixel centre. */
function roundedRect(px, py, w, h, r) {
  if (r <= 0) return clamp01(Math.min(px, py, w - px, h - py) + 0.5)
  const cx = Math.min(Math.max(px, r), w - r)
  const cy = Math.min(Math.max(py, r), h - r)
  const inside = Math.min(px, py, w - px, h - py)
  const corner = r - Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
  return clamp01(Math.min(inside, corner) + 0.5)
}

/**
 * RGBA pixels of a `width` x `height` image: `page` (an [r,g,b] or null for
 * transparent) everywhere, then the mark's square of side `size` at
 * (`left`, `top`) with corner radius scaled from the SVG (`rounded: false`
 * makes it a plain square), then the stroke, shrunk by `inset` around the
 * square's centre (1 = as in the SVG).
 */
export function render(mark, { width, height, size, left = 0, top = 0, page = null, rounded = true, inset = 1 }) {
  const rgba = new Uint8Array(width * height * 4)
  const k = size / mark.box
  const half = (mark.width * k * inset) / 2
  const centre = mark.box / 2
  const segments = mark.segments.map((seg) =>
    seg.map((v, j) => (j % 2 === 0 ? left : top) + (centre + (v - centre) * inset) * k),
  )
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x0, y0, x1, y1] of segments) {
    minX = Math.min(minX, x0, x1)
    maxX = Math.max(maxX, x0, x1)
    minY = Math.min(minY, y0, y1)
    maxY = Math.max(maxY, y0, y1)
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let r = page ? page[0] : 0
      let g = page ? page[1] : 0
      let b = page ? page[2] : 0
      let a = page ? 1 : 0

      const inSquare = roundedRect(px - left, py - top, size, size, rounded ? mark.radius * k : 0)
      if (inSquare > 0) {
        ;[r, g, b, a] = over([r, g, b, a], mark.background, inSquare)
        if (px >= minX - half - 1 && px <= maxX + half + 1 && py >= minY - half - 1 && py <= maxY + half + 1) {
          let distance = Infinity
          for (const seg of segments) distance = Math.min(distance, segmentDistance(px, py, seg))
          const ink = clamp01(half - distance + 0.5) * inSquare
          if (ink > 0) [r, g, b, a] = over([r, g, b, a], mark.stroke, ink)
        }
      }
      const at = (y * width + x) * 4
      rgba[at] = Math.round(r)
      rgba[at + 1] = Math.round(g)
      rgba[at + 2] = Math.round(b)
      rgba[at + 3] = Math.round(a * 255)
    }
  }
  return rgba
}

/** Source-over of an opaque colour with coverage `c` onto an [r, g, b, a(0..1)] pixel. */
function over([r, g, b, a], [sr, sg, sb], c) {
  const outA = c + a * (1 - c)
  if (outA === 0) return [0, 0, 0, 0]
  const mix = (s, d) => (s * c + d * a * (1 - c)) / outA
  return [mix(sr, r), mix(sg, g), mix(sb, b), outA]
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** An 8-bit RGBA PNG, every row unfiltered. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8 bits, RGBA, deflate, no filter, no interlace
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Every file this script writes, by name: the render() options of each. */
export const ICONS = {
  'favicon-32.png': { width: 32, height: 32, size: 32 },
  'apple-touch-icon.png': { width: 180, height: 180, size: 180, rounded: false },
  'icon-192.png': { width: 192, height: 192, size: 192 },
  'icon-512.png': { width: 512, height: 512, size: 512 },
  'icon-maskable-512.png': { width: 512, height: 512, size: 512, rounded: false, inset: 0.75 },
  'og-image.png': { width: 1200, height: 630, size: 360, left: 420, top: 135, page: PAGE },
}

export const readFavicon = () => readMark(readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8'))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mark = readFavicon()
  for (const [name, options] of Object.entries(ICONS)) {
    const png = encodePng(options.width, options.height, render(mark, options))
    writeFileSync(join(PUBLIC, name), png)
    console.log(`icons: ${name} ${options.width}x${options.height}, ${png.length} bytes`)
  }
}
