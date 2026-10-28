import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DARK, decimate, embedCode, mapSvg, svgDataUrl } from '../src/lib/map-image.js'
import { adjustLines } from '../src/lib/timing.js'

/** Two red lines, 128 then 142 BPM, a minute long, with a local tempo curve. */
const result = {
  duration_s: 60,
  red_lines: [
    { time_ms: 400, bpm: 128, beat_length_ms: 468.75, meter: 4 },
    { time_ms: 30_400, bpm: 142, beat_length_ms: 60_000 / 142, meter: 3 },
  ],
  sections: [{ level: 'high' }, { level: 'check' }],
  beats: { t_ms: Array.from({ length: 200 }, (_, i) => i * 300), bpm: Array.from({ length: 200 }, (_, i) => (i < 100 ? 128 : 142)) },
}

test('the SVG holds every red line, its BPM, the tempo curve, the levels and the ruler', () => {
  const lines = adjustLines(result)
  const svg = mapSvg({ lines, sections: result.sections, beats: result.beats, durationS: 60, title: 'Band - Song', note: '128 BPM' })
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="1200" height="340"/)
  assert.ok(svg.endsWith('</svg>'))
  assert.equal((svg.match(/stroke="#ff5d6c" stroke-width="1.2"/g) ?? []).length, 2, 'one vertical per red line')
  assert.match(svg, />128<\/text>/)
  assert.match(svg, />142<\/text>/)
  assert.match(svg, /<polyline fill="none" stroke="#8fd16a"/)
  assert.match(svg, new RegExp(`fill="${DARK.accent}"`), 'the high section')
  assert.match(svg, new RegExp(`fill="${DARK.amber}"`), 'the check section')
  assert.match(svg, />0:00<\/text>/)
  assert.match(svg, />Band - Song<\/text>/)
  // Every number in it is finite: nothing reads NaN or Infinity.
  assert.ok(!/NaN|Infinity/.test(svg))
})

test('the SVG follows an adjustment and escapes the song\'s own text', () => {
  const adjustment = { factor: 2, nudgeMs: 0 }
  const svg = mapSvg({ lines: adjustLines(result, adjustment), sections: result.sections, beats: result.beats, durationS: 60, factor: 2, title: '<script>alert(1)</script> & "x"' })
  assert.match(svg, />256<\/text>/)
  assert.match(svg, />284<\/text>/)
  assert.ok(!svg.includes('<script>'))
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/)
})

test('the compact SVG has no title and still draws without beats', () => {
  const svg = mapSvg({ lines: adjustLines(result), durationS: 60, width: 600, height: 150, compact: true })
  assert.match(svg, /width="600" height="150"/)
  assert.ok(!svg.includes('polyline'))
  assert.ok(!/NaN|Infinity/.test(svg))
  assert.match(svgDataUrl(svg), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
})

test('decimating a curve keeps its extremes and its length bound', () => {
  const xs = Array.from({ length: 10_000 }, (_, i) => i)
  const ys = xs.map((i) => (i === 5_000 ? 999 : 120))
  const points = decimate(xs, ys, 400)
  assert.ok(points.length <= 402)
  assert.ok(points.some(([, y]) => y === 999), 'a spike is not lost')
  assert.deepEqual(decimate([1, 2], [3, 4], 10), [[1, 3], [2, 4]])
})

test('the embed snippet frames the card and escapes the title', () => {
  assert.equal(
    embedCode('https://o.test', 'a'.repeat(32), 'A "song"'),
    `<iframe src="https://o.test/embed/${'a'.repeat(32)}" title="A &quot;song&quot;" width="560" height="320" style="border:0;max-width:100%" loading="lazy"></iframe>`,
  )
})
