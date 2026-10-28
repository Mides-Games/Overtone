import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_NUDGE_MS, overlayParams, overlayPath, overlaySearch, overlayState, pulseLevel } from '../src/lib/overlay.js'

// Two red lines: 120 BPM in 4/4 from 1 s, 150 BPM in 3/4 from 9 s.
const LINES = [
  { index: 0, timeMs: 1000, bpm: 120, beatMs: 500, meter: 4 },
  { index: 1, timeMs: 9000, bpm: 150, beatMs: 400, meter: 3 },
]

test('the start time comes from ?t0= in epoch ms, within reason, and the nudge is bounded', () => {
  const now = Date.UTC(2026, 9, 28)
  assert.deepEqual(overlayParams('?t0=1793145600000', now), { t0: 1793145600000, nudgeMs: 0 })
  assert.equal(overlayParams('', now).t0, null)
  assert.equal(overlayParams('?t0=abc', now).t0, null)
  assert.equal(overlayParams('?t0=12', now).t0, null, 'seconds, or a typo, are not a start')
  assert.equal(overlayParams('?t0=1000000000000', now).t0, null, '2001 is before any timing existed')
  assert.equal(overlayParams(`?t0=${now + 2 * 86_400_000}`, now).t0, null, 'two days ahead is a mistake')
  assert.equal(overlayParams(`?t0=${now + 5000}`, now).t0, now + 5000, 'a few seconds ahead is a count-in')
  assert.equal(overlayParams('?nudge=-35', now).nudgeMs, -35)
  assert.equal(overlayParams('?nudge=99999', now).nudgeMs, MAX_NUDGE_MS)
  assert.equal(overlayParams('?nudge=x', now).nudgeMs, 0)
})

test('starting writes t0 into the address, keeping the other parameters', () => {
  assert.equal(overlaySearch('', { t0: 1793145600000.4, nudgeMs: 0 }), '?t0=1793145600000')
  assert.equal(overlaySearch('?x=1&t0=5', { t0: 1793145600000, nudgeMs: 20 }), '?x=1&t0=1793145600000&nudge=20')
  assert.equal(overlaySearch('?t0=5&nudge=20', { t0: null, nudgeMs: 0 }), '')
  assert.equal(overlayPath('a'.repeat(32)), `/overlay/${'a'.repeat(32)}`)
})

test('the clock: count-in, intro, beats and bars, a line change, the end', () => {
  assert.equal(overlayState(LINES, -2500).phase, 'waiting')
  const intro = overlayState(LINES, 500)
  assert.deepEqual([intro.phase, intro.line, intro.key], ['intro', 0, null])

  const first = overlayState(LINES, 1000)
  assert.deepEqual([first.phase, first.line, first.beat, first.barBeat, first.key], ['playing', 0, 0, 0, '0:0'])
  const third = overlayState(LINES, 2100)
  assert.deepEqual([third.beat, third.barBeat], [2, 2])
  assert.ok(Math.abs(third.sinceBeatMs - 100) < 1e-9)
  assert.equal(overlayState(LINES, 3000).barBeat, 0, 'beat 4 is the next bar\'s downbeat')
  // A beat that lands exactly on the frame belongs to that beat, not the previous one.
  assert.equal(overlayState(LINES, 1000 + 7 * 500).beat, 7)

  // At 9 s the second line takes over: its count starts again, in 3/4.
  const second = overlayState(LINES, 9000)
  assert.deepEqual([second.line, second.beat, second.barBeat, second.key], [1, 0, 0, '1:0'])
  assert.equal(overlayState(LINES, 9000 + 3 * 400).barBeat, 0)
  assert.equal(overlayState(LINES, 9000 + 4 * 400).barBeat, 1)
  assert.equal(overlayState(LINES, 8999).line, 0)

  assert.equal(overlayState(LINES, 20_001, 20_000).phase, 'ended')
  assert.equal(overlayState([], 100).phase, 'ended')
})

test('every beat gets a new key, and only a new beat does', () => {
  const keys = new Set()
  let changes = 0
  let last = null
  for (let ms = 1000; ms < 9000; ms += 16) {
    const { key } = overlayState(LINES, ms)
    if (key !== last) changes += 1
    last = key
    keys.add(key)
  }
  // 8 s of 120 BPM is 16 beats.
  assert.equal(keys.size, 16)
  assert.equal(changes, 16)
})

test('the pulse is full at the beat and gone within a third of it', () => {
  assert.equal(pulseLevel(0, 500), 1)
  assert.ok(pulseLevel(80, 500) > 0 && pulseLevel(80, 500) < 1)
  assert.equal(pulseLevel(170, 500), 0, 'at most 180 ms, at most a third of a 500 ms beat (166.7 ms)')
  assert.equal(pulseLevel(null, 500), 0)
  assert.equal(pulseLevel(10, 0), 0)
  assert.ok(pulseLevel(100, 2000) > 0, 'a slow beat still fades within 180 ms')
  assert.equal(pulseLevel(181, 2000), 0)
})
