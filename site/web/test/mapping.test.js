import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  breakRows,
  divisorHistogram,
  divisorOf,
  GAP_AFTER_BREAK,
  GAP_BEFORE_BREAK,
  MIN_BREAK_MS,
  redPoints,
  snapTime,
  suggestBreaks,
  suggestDivisor,
  testObjects,
  testVersion,
} from '../src/lib/mapping.js'

// 120 BPM in 4/4 from 1000 ms: a beat every 500 ms. Synthetic, never anyone's song.
const line = (timeMs, bpm = 120, meter = 4) => ({ timeMs, beatMs: 60000 / bpm, meter })
const points = redPoints(['1000,500.000000000000,4,1,0,100,1,0', '1000,-100,4,1,0,100,0,0', '9000,400,3,1,0,100,1,0', '// a note'])

test('redPoints keeps the red lines only, in time order', () => {
  assert.deepEqual(points, [
    { time: 1000, beatLength: 500, meter: 4 },
    { time: 9000, beatLength: 400, meter: 3 },
  ])
  assert.deepEqual(redPoints(['500,300']), [{ time: 500, beatLength: 300, meter: 4 }], 'the old two-field rows count as red')
})

test('snapTime moves to the nearest tick of the red line in force, in whole ms', () => {
  assert.equal(snapTime(points, 1260, 1), 1500)
  assert.equal(snapTime(points, 1260, 4), 1250)
  assert.equal(snapTime(points, 1170, 3), 1167, 'a third of 500 ms, rounded as osu! stores it')
  assert.equal(snapTime(points, 9050, 2), 9000, 'the second red line restarts the grid')
  assert.equal(snapTime(points, 880, 1), 1000, 'before the first red line its grid runs back')
  assert.equal(snapTime(points, 740, 1), 500)
})

test('divisorOf names the simplest divisor an attack sits on, or 0', () => {
  const l = line(1000)
  assert.equal(divisorOf(1500, l), 1)
  assert.equal(divisorOf(1252, l), 2)
  assert.equal(divisorOf(1167, l), 3)
  assert.equal(divisorOf(1125, l), 4)
  assert.equal(divisorOf(1083, l), 6)
  assert.equal(divisorOf(1062, l), 8)
  assert.equal(divisorOf(1040, l), 0, 'between 1/8 and 1/6, closer than a 48th of the beat to neither')
  assert.equal(divisorOf(500, l), 1, 'before the line its grid runs back')
})

/** Attacks on the given beat fractions, for `beats` beats from `from` under `l`. */
const attacks = (l, beats, fractions, from = 0) => {
  const t = []
  for (let b = from; b < from + beats; b++) for (const f of fractions) t.push(Math.round(l.timeMs + (b + f) * l.beatMs))
  return t
}

test('a straight 1/4 song suggests 1/4; a swung 1/3 one suggests 1/3', () => {
  const l = line(1000)
  const straight = divisorHistogram({ t_ms: attacks(l, 32, [0, 0.25, 0.5, 0.75]), w: [] }, [l])
  assert.equal(straight.all.attacks, 128)
  assert.equal(straight.all.bins[1], 32)
  assert.equal(straight.all.bins[4], 64)
  assert.equal(suggestDivisor(straight.all), 4)
  const swung = divisorHistogram({ t_ms: attacks(l, 32, [0, 1 / 3, 2 / 3]), w: [] }, [l])
  assert.equal(suggestDivisor(swung.all), 3)
  const halves = divisorHistogram({ t_ms: attacks(l, 32, [0, 0.5]), w: [] }, [l])
  assert.equal(suggestDivisor(halves.all), 2)
})

test('the histogram splits by red line and weighs faint attacks less', () => {
  const a = line(1000)
  const b = line(9000, 150)
  const t = [...attacks(a, 16, [0, 0.5]), ...attacks(b, 8, [0, 1 / 3, 2 / 3])]
  const w = t.map((ms) => (ms >= 9000 ? 50 : 100))
  const h = divisorHistogram({ t_ms: t, w }, [a, b])
  assert.equal(h.lines[0].attacks, 32)
  assert.equal(h.lines[0].bins[2], 16)
  assert.equal(h.lines[1].attacks, 24)
  assert.equal(h.lines[1].bins[3], 8, 'sixteen attacks at half weight')
  assert.equal(h.all.attacks, 56)
  assert.equal(suggestDivisor(h.lines[0]), 2)
  assert.equal(suggestDivisor(h.lines[1]), 3)
})

test('a mix that no coarse divisor holds gets the one that holds most; too few attacks get none', () => {
  const l = line(1000)
  // Two thirds of the song in 1/4, a third in 1/3 and 1/6: no divisor holds 90 %; 1/4 and 1/8 hold the most
  // (62 %, against 1/6's 54 %), and of a tie the coarser wins.
  const mixed = divisorHistogram({ t_ms: [...attacks(l, 16, [0, 0.25, 0.5, 0.75]), ...attacks(l, 8, [1 / 6, 1 / 3, 2 / 3], 16)] }, [l])
  assert.equal(suggestDivisor(mixed.all), 4)
  const few = divisorHistogram({ t_ms: attacks(l, 3, [0, 0.25, 0.5, 0.75]) }, [l])
  assert.equal(suggestDivisor(few.all), null)
  assert.equal(suggestDivisor(divisorHistogram({ t_ms: [] }, [l]).all), null)
})

/** An envelope at 100 values per second (10 ms each), loud except in `quiet` [a, b) seconds. */
const envelope = (seconds, quiet) => ({
  span_ms: seconds * 1000,
  v: Array.from({ length: seconds * 100 }, (_, i) => (quiet.some(([a, b]) => i / 100 >= a && i / 100 < b) ? 2 : 60)),
})
const steady = (seconds, quiet) => ({ t_ms: Array.from({ length: seconds * 2 }, (_, i) => i * 500).filter((ms) => !quiet.some(([a, b]) => ms >= a * 1000 && ms < b * 1000)) })

test('a long silence between attacks becomes a break inside osu!\'s gaps; a short one does not', () => {
  const quiet = [
    [20, 28],
    [40, 43],
  ]
  const breaks = suggestBreaks({ envelope: envelope(60, quiet), onsets: steady(60, quiet) })
  assert.deepEqual(breaks, [{ startMs: 20000 + GAP_BEFORE_BREAK, endMs: 28000 - GAP_AFTER_BREAK }])
  assert.deepEqual(breakRows(breaks), ['2,20200,27550'])
})

test('no break before the first attack or after the last, and a loud attack splits a silence', () => {
  const quiet = [
    [0, 10],
    [50, 60],
  ]
  assert.deepEqual(suggestBreaks({ envelope: envelope(60, quiet), onsets: steady(60, quiet) }), [])
  const long = [[10, 30]]
  const onsets = steady(60, long)
  onsets.t_ms.push(14000, 16000)
  onsets.t_ms.sort((a, b) => a - b)
  onsets.w = onsets.t_ms.map((ms) => (ms === 14000 ? 10 : 80))
  // 14 s is faint and does not count; 16 s splits 10-30 s into 10-16 s and 16-30 s.
  assert.deepEqual(suggestBreaks({ envelope: envelope(60, long), onsets }), [
    { startMs: 10200, endMs: 15550 },
    { startMs: 16200, endMs: 29550 },
  ])
  assert.deepEqual(suggestBreaks({ envelope: { span_ms: 0, v: [] }, onsets }), [])
})

test('every break is at least osu!\'s minimum', () => {
  for (const { startMs, endMs } of suggestBreaks({ envelope: envelope(60, [[20, 25.4]]), onsets: steady(60, [[20, 25.4]]) })) {
    assert.ok(endMs - startMs >= MIN_BREAK_MS)
  }
})

test('the test map puts a circle on every beat, the bar\'s first a new combo with a finish', () => {
  const rows = testObjects({ points, durationMs: 11000 })
  const times = rows.map((row) => Number(row.split(',')[2]))
  // 1000-9000 at 500 ms (16 beats), then 9000-11000 at 400 ms (5 beats).
  assert.equal(rows.length, 21)
  assert.deepEqual(times.slice(0, 3), [1000, 1500, 2000])
  assert.deepEqual(times.slice(-5), [9000, 9400, 9800, 10200, 10600])
  assert.equal(rows[0], '256,72,1000,5,4,0:0:0:0:', 'the bar starts at the top of the ring')
  assert.equal(rows[1], '376,192,1500,1,0,0:0:0:0:')
  assert.equal(rows[4].split(',').slice(2, 5).join(','), '3000,5,4')
  // The 3/4 line restarts the bar: 9000 and 10200 start one.
  assert.equal(rows[16].split(',')[3], '5')
  assert.equal(rows[19].split(',')[3], '5')
})

test('in halves the off-beats whistle; mania walks the columns; breaks stay empty', () => {
  const halves = testObjects({ points: points.slice(0, 1), durationMs: 2000, sub: 2 })
  assert.equal(halves.length, 4)
  assert.deepEqual(halves.map((row) => row.split(',')[4]), ['4', '2', '0', '2'])
  const mania = testObjects({ points: points.slice(0, 1), durationMs: 3500, mode: 3, keys: 4 })
  assert.deepEqual(mania.map((row) => row.split(',')[0]), ['64', '192', '320', '448', '64'])
  const gap = testObjects({ points: points.slice(0, 1), durationMs: 9000, breaks: [{ startMs: 3200, endMs: 6550 }] })
  const times = gap.map((row) => Number(row.split(',')[2]))
  assert.ok(times.includes(3000) && times.includes(7000))
  assert.ok(!times.some((ms) => ms > 3000 && ms < 7000), 'nothing inside the break or its gaps')
  assert.equal(testVersion(2), 'Overtone test (1/2)')
})
