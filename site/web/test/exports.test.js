import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clickTrackPlan, MAX_TRACK_SECONDS } from '../src/lib/click-track.js'
import { adjustLines, BAR, clickGrid, resultJson, summaryText } from '../src/lib/timing.js'
import { encodeWav } from '../src/lib/wav.js'

const result = {
  duration_s: 60,
  global_bpm: 128,
  meter: '4/4',
  engine_hash: 'abc123',
  beat_vote: true,
  red_lines: [
    { time_ms: 400.127, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 30400.127, bpm: 142, beat_length_ms: 422.535211267606, meter: 4, meter_known: true },
  ],
  osu_timing: '// Overtone v3\r\n400,468.750000000000,4,1,0,100,1,0\r\n30400,422.535211267606,4,1,0,100,1,0',
  sections: [
    { index: 0, start_ms: 400.127, end_ms: 30400.127, confidence: 0.97, level: 'high', drift_p90_ms: 1.2 },
    { index: 1, start_ms: 30400.127, end_ms: 60000, confidence: 0.81, level: 'medium', drift_p90_ms: 3 },
  ],
}

test('the WAV header is canonical 16-bit PCM and the samples interleave, clipped', () => {
  const bytes = encodeWav([Float32Array.from([0, 1, -1]), Float32Array.from([0.5, 2, -2])], 44100)
  const view = new DataView(bytes.buffer)
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n))
  assert.equal(bytes.length, 44 + 3 * 2 * 2)
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(view.getUint32(4, true), bytes.length - 8)
  assert.equal(text(8, 8), 'WAVEfmt ')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 44100)
  assert.equal(view.getUint32(28, true), 44100 * 4)
  assert.equal(view.getUint16(32, true), 4)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(text(36, 4), 'data')
  assert.equal(view.getUint32(40, true), 12)
  const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))
  assert.deepEqual(samples, [0, 16384, 32767, 32767, -32768, -32768])
})

test('an empty WAV is a valid header with no data', () => {
  const bytes = encodeWav([new Float32Array(0)], 8000)
  assert.equal(bytes.length, 44)
  assert.equal(new DataView(bytes.buffer).getUint32(40, true), 0)
})

test('the click track plan holds the page clicks up to the song end, capped at the site limit', () => {
  const grid = clickGrid(adjustLines(result), 60)
  const plan = clickTrackPlan(grid, 60)
  assert.equal(plan.seconds, 60)
  assert.equal(plan.capped, false)
  assert.equal(plan.t.length, grid.t.length)
  assert.equal(plan.level[0], BAR)
  const short = clickTrackPlan(grid, 60, 10)
  assert.equal(short.seconds, 10)
  assert.equal(short.capped, true)
  assert.ok(short.t.every((t) => t <= 10))
  assert.equal(short.t.length, 1 + Math.floor((10 - 0.400127) / 0.46875))
  assert.equal(MAX_TRACK_SECONDS, 600)
})


test('the summary names the readings, every red line and what to check', () => {
  const lines = adjustLines(result)
  const checks = [{ startMs: 30400.127, endMs: 60000, reasons: ['medium'] }]
  const text = summaryText({ filename: 'song.mp3', result, lines, checks })
  assert.ok(text.startsWith('Overtone timing: song.mp3\r\n'))
  assert.match(text, /\r\nBPM {8}128\r\nOffset {5}400 ms\r\n/)
  assert.match(text, /\r\n0:00\.400 {4}128 {7}4\/4 {4}97% {9}high\r\n/)
  assert.match(text, /\r\n0:30\.400 {4}142 {7}4\/4 {4}81% {9}medium\r\n/)
  assert.match(text, /\r\nCheck here\r\n0:30\.400 - 1:00\.000  medium\r\n/)
  assert.doesNotMatch(text, /Adjusted/)
  const doubled = summaryText({ filename: 'song.mp3', result, lines: adjustLines(result, { factor: 2, nudgeMs: 5 }), adjustment: { factor: 2, nudgeMs: 5 } })
  assert.match(doubled, /\r\nBPM {8}256\r\nOffset {5}405 ms\r\n/)
  assert.match(doubled, /\r\nAdjusted {3}x2, \+5 ms /)
  assert.match(doubled, /Check here: nothing flagged/)
})

test('the JSON is the result as served', () => {
  assert.deepEqual(JSON.parse(resultJson(result)), result)
})
