import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAB_REPS, LAB_SHIFTS, labReport, labTrials, mp3GaplessInfo, presented, vote, wilson } from '../src/lib/offset-lab.js'

/** A seeded generator, so the shuffle is the same on every run. */
const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

test('the blind test runs every shift three times, each against none, in a shuffled order', () => {
  const trials = labTrials(seeded(3))
  assert.equal(trials.length, LAB_SHIFTS.length * LAB_REPS)
  for (const shift of LAB_SHIFTS) assert.equal(trials.filter((t) => t.shift === shift).length, LAB_REPS)
  for (const trial of trials) {
    assert.ok(trial.first === 0 || trial.first === trial.shift)
    // The two presentations are the shift and none, in either order.
    assert.deepEqual([presented(trial, 0), presented(trial, 1)].sort((a, b) => a - b), [0, trial.shift].sort((a, b) => a - b))
  }
  assert.notDeepEqual(trials.map((t) => t.shift), LAB_SHIFTS.flatMap((s) => [s, s, s]))
})

test('a vote for the shifted presentation wins the shift, for the plain one loses it', () => {
  const trial = { shift: 10, first: 0 }
  assert.deepEqual(vote({}, trial, 1), { 10: [1, 0] })
  assert.deepEqual(vote({ 10: [1, 0] }, trial, 0), { 10: [1, 1] })
  assert.deepEqual(vote({}, { shift: -20, first: -20 }, 0), { '-20': [1, 0] })
})

test('the report: Wilson intervals, the best rate above one half, the smaller shift on a tie, nothing when none is unbeaten', () => {
  const [lo, hi] = wilson(3, 3)
  assert.ok(lo > 0.43 && lo < 0.44 && hi === 1)
  assert.deepEqual(wilson(0, 0), [0, 0])
  const report = labReport({ 10: [3, 0], 20: [3, 0], '-10': [1, 2] })
  assert.equal(report.best.shift, 10)
  assert.equal(report.rows.length, LAB_SHIFTS.length)
  assert.equal(labReport({ 10: [1, 2], 20: [0, 3] }).best, null)
  // Ties at half never win: none is as good.
  assert.equal(labReport({ 10: [1, 1] }).best, null)
})

/** An MPEG-1 Layer III frame with an Info header and a LAME tag at its usual place. */
function lameHead({ id3 = 0, delay = 576, padding = 1000, encoder = 'LAME3.100' } = {}) {
  const bytes = new Uint8Array(id3 + 600)
  let at = 0
  if (id3) {
    bytes.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, id3 - 10], 0)
    at = id3
  }
  bytes.set([0xff, 0xfb, 0x90, 0x64], at) // 44.1 kHz, joint stereo: the Info tag 32 bytes after the header
  const xing = at + 4 + 32
  bytes.set([...'Info'].map((c) => c.charCodeAt(0)), xing)
  const lame = xing + 120
  bytes.set([...encoder].map((c) => c.charCodeAt(0)), lame)
  const raw = (delay << 12) | padding
  bytes.set([(raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff], lame + 21)
  return bytes
}

test('the gapless header: the LAME tag\'s delay and padding, after an ID3 tag too, and nothing guessed without one', () => {
  assert.deepEqual(mp3GaplessInfo(lameHead(), 'song.mp3'), {
    present: true, encoder: 'LAME3.100', sampleRate: 44100, delaySamples: 576, paddingSamples: 1000, delayMs: 13.061, paddingMs: 22.676,
  })
  assert.equal(mp3GaplessInfo(lameHead({ id3: 40 }), 'song.MP3').delaySamples, 576)
  assert.deepEqual(mp3GaplessInfo(lameHead(), 'song.ogg'), { present: false })
  assert.deepEqual(mp3GaplessInfo(lameHead({ encoder: 'Lavf58.29' }), 'song.mp3'), { present: false })
  assert.deepEqual(mp3GaplessInfo(new Uint8Array(100), 'song.mp3'), { present: false })
})
