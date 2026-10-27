import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'

import { ICONS, encodePng, flatten, readFavicon, readMark, render } from '../scripts/icons.mjs'

const PUBLIC = new URL('../public/', import.meta.url)

/** The RGBA pixels of a PNG this script wrote (8-bit RGBA, filter 0 on every row). */
const pixels = (png) => {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const idat = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'unfiltered rows')
    raw.copy(out, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))
  }
  return { width, height, out }
}

test('the committed icons are what favicon.svg renders to today', () => {
  const mark = readFavicon()
  // The large ones are the same code at a larger size; 32 and 192 keep the test quick.
  for (const name of ['favicon-32.png', 'icon-192.png', 'apple-touch-icon.png']) {
    const options = ICONS[name]
    const committed = pixels(readFileSync(new URL(name, PUBLIC)))
    assert.equal(committed.width, options.width, name)
    assert.equal(committed.height, options.height, name)
    assert.ok(committed.out.equals(Buffer.from(render(mark, options))), `${name}: run node site/web/scripts/icons.mjs`)
  }
  for (const name of Object.keys(ICONS)) assert.ok(readFileSync(new URL(name, PUBLIC)).length > 0, name)
})

test('a PNG round-trips through the encoder', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4])
  const { width, height, out } = pixels(encodePng(2, 2, rgba))
  assert.deepEqual([width, height], [2, 2])
  assert.deepEqual([...out], [...rgba])
})

test('the path reader takes lines and curves and refuses what it does not draw', () => {
  const segments = flatten('M0 0 L10 0 C10 5 5 10 0 10 Q0 5 0 0')
  assert.equal(segments.length, 1 + 32 + 32)
  assert.deepEqual(segments[0], [0, 0, 10, 0])
  assert.deepEqual(segments.at(-1).slice(2), [0, 0])
  assert.throws(() => flatten('M0 0 a5 5 0 0 1 10 0'), /not supported/)
  assert.throws(() => readMark('<svg viewBox="0 0 10 10"><circle r="4"/></svg>'), /one <rect> and one <path>/)
})

test('the square is opaque inside and transparent at its rounded corner', () => {
  const mark = readFavicon()
  const rgba = render(mark, { width: 64, height: 64, size: 64 })
  assert.equal(rgba[3], 0, 'corner pixel')
  assert.equal(rgba[(32 * 64 + 4) * 4 + 3], 255, 'inside the square')
  const square = render(mark, { width: 64, height: 64, size: 64, rounded: false })
  assert.equal(square[3], 255, 'a plain square has no transparent corner')
})
