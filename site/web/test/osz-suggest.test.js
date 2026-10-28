import assert from 'node:assert/strict'
import { test } from 'node:test'

import { barStarts, energyFrames, FRAME_S, kiaiRows, kiaiSections, leadIn, previewTime } from '../src/lib/osz-suggest.js'

// Synthetic songs: loudness per 50 ms frame, laid out in seconds, never audio from anyone.

/** Frames for `seconds` of song, `level(t)` the mean square at t seconds. */
const song = (seconds, level) => Float32Array.from({ length: Math.round(seconds / FRAME_S) }, (_, f) => level(f * FRAME_S))
// 120 BPM in 4/4 from 0.5 s: a bar every 2 s, at 0.5, 2.5, 4.5 ...
const line = (timeMs, bpm = 120, meter = 4) => ({ timeMs, beatMs: 60000 / bpm, meter, bpm })

test('energyFrames is the mean square per frame, the channels averaged', () => {
  const rate = 100 // 5 samples per 50 ms frame
  const left = Float32Array.from({ length: 12 }, (_, i) => (i < 5 ? 1 : 0.5))
  const right = new Float32Array(12)
  const frames = energyFrames([left, right], rate)
  assert.equal(frames.length, 3)
  assert.ok(Math.abs(frames[0] - 0.5) < 1e-6)
  assert.ok(Math.abs(frames[1] - 0.125) < 1e-6)
  assert.ok(Math.abs(frames[2] - 0.125) < 1e-6, 'a short last frame is averaged over what it has')
})

test('bars run from each line to the next and back from the first to 0', () => {
  const bars = barStarts([line(4500), line(10500, 60, 3)], 20000)
  assert.deepEqual(
    bars.map((b) => b.ms),
    [500, 2500, 4500, 6500, 8500, 10500, 13500, 16500, 19500],
  )
  assert.equal(bars[0].line, 0)
  assert.equal(bars.at(-1).meter, 3)
})

test('the preview starts where the loudest stretch starts, on a bar', () => {
  // Quiet verse, a loud chorus from 61.3 s to 90 s, quiet again.
  const frames = song(180, (t) => (t >= 61.3 && t < 90 ? 0.5 : 0.05))
  const ms = previewTime({ frames, lines: [line(500)], durationMs: 180000 })
  // The chorus top, not somewhere 15 s windows inside it tie: the nearest bar to 61.3 s is 60.5 s.
  assert.equal(ms, 60500)
})

test('a song shorter than the window previews from its first bar; silence has no preview', () => {
  assert.equal(previewTime({ frames: song(10, () => 0.2), lines: [line(1500)], durationMs: 10000 }), 1500)
  assert.equal(previewTime({ frames: song(60, () => 0), lines: [line(0)], durationMs: 60000 }), null)
  assert.equal(previewTime({ frames: new Float32Array(0), lines: [line(0)], durationMs: 1 }), null)
})

test('the lead-in is suggested only when the first sound comes early', () => {
  assert.deepEqual(leadIn({ lines: [line(400)], firstAttackMs: 380 }), { firstMs: 380, leadInMs: 1700 })
  assert.deepEqual(leadIn({ lines: [line(0)], firstAttackMs: null }), { firstMs: 0, leadInMs: 2000 })
  assert.deepEqual(leadIn({ lines: [line(1499)] }), { firstMs: 1499, leadInMs: 600 })
  assert.deepEqual(leadIn({ lines: [line(3200)], firstAttackMs: 3100 }), { firstMs: 3100, leadInMs: 0 })
  // An attack before the first red line counts: the player hears it.
  assert.deepEqual(leadIn({ lines: [line(5000)], firstAttackMs: 900 }).leadInMs, 1100)
  assert.equal(leadIn({ lines: [] }), null)
})

test('kiai goes on the bars clearly louder than the song, merged and on bar starts', () => {
  // Bars every 2 s from 0.5 s. Two choruses (40.5-56.5 s and 120.5-140.5 s), one
  // quiet bar inside the second, and a loud blip of one bar that is too short.
  const level = (t) => {
    if (t >= 40.5 && t < 56.5) return 0.4
    if (t >= 120.5 && t < 140.5 && !(t >= 128.5 && t < 130.5)) return 0.5
    if (t >= 90.5 && t < 92.5) return 0.6
    return 0.04
  }
  const frames = song(180, level)
  const sections = kiaiSections({ frames, lines: [line(500)], durationMs: 180000 })
  assert.deepEqual(sections, [
    { startMs: 40500, endMs: 56500, bars: 8 },
    { startMs: 120500, endMs: 140500, bars: 10 },
  ])
})

test('a song mastered flat gets no kiai, and at most maxSections are kept', () => {
  const flat = song(180, (t) => 0.3 + 0.01 * Math.sin(t))
  assert.deepEqual(kiaiSections({ frames: flat, lines: [line(500)], durationMs: 180000 }), [])
  // Four loud stretches of rising level: the three loudest stay, in time order.
  const four = song(200, (t) => {
    for (const [a, v] of [[20.5, 0.3], [60.5, 0.6], [100.5, 0.5], [140.5, 0.4]]) if (t >= a && t < a + 12) return v
    return 0.02
  })
  const kept = kiaiSections({ frames: four, lines: [line(500)], durationMs: 200000, maxSections: 3 })
  assert.deepEqual(kept.map((s) => s.startMs), [60500, 100500, 140500])
})

test('kiai never starts before the first red line', () => {
  const frames = song(120, (t) => (t < 30 ? 0.5 : 0.03))
  const sections = kiaiSections({ frames, lines: [line(10500)], durationMs: 120000 })
  assert.equal(sections[0].startMs, 10500)
})

test('kiai rows: on at the start, off at the end, again after a red line inside', () => {
  const lines = [line(500), line(30500, 140, 3)]
  const rows = kiaiRows([{ startMs: 20500.4, endMs: 40500 }, { startMs: 60000, endMs: 90000 }], lines, 90000)
  assert.deepEqual(
    rows.map((r) => r.row),
    ['20500,-100,4,1,0,100,0,1', '30500,-100,3,1,0,100,0,1', '40500,-100,3,1,0,100,0,0', '60000,-100,3,1,0,100,0,1'],
  )
  // A section that ends on a red line needs no off row: the red line turns kiai off.
  assert.deepEqual(kiaiRows([{ startMs: 10500, endMs: 30500 }], lines, 90000).map((r) => r.timeMs), [10500])
})
