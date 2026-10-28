import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  arrowStep,
  bpmForDrift,
  bpmFromMs,
  bpmFromSpan,
  calculatorPath,
  calculatorSeed,
  drift,
  firstBeatOffset,
  lineOffset,
  msPerBeat,
  msToTicks,
  parseNumber,
  readout,
  stepValue,
  tickMs,
  ticksToMs,
} from '../src/lib/calc.js'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

test('fields: a comma is a decimal point, junk is null', () => {
  assert.equal(parseNumber('1,5'), 1.5)
  assert.equal(parseNumber(' 1 234.5 '), 1234.5)
  assert.equal(parseNumber('-12'), -12)
  assert.equal(parseNumber('−12'), -12)
  assert.equal(parseNumber('.5'), 0.5)
  assert.equal(parseNumber('1e3'), 1000)
  for (const bad of ['', ' ', 'abc', '1..2', '1,2,3', '--1', 'Infinity', null, undefined, NaN]) assert.equal(parseNumber(bad), null, String(bad))
})

test('BPM and ms per beat are each other’s inverse', () => {
  assert.equal(msPerBeat(150), 400)
  assert.equal(bpmFromMs(400), 150)
  close(bpmFromMs(msPerBeat(174.3)), 174.3)
  for (const bad of [0, -1, null, NaN]) {
    assert.equal(msPerBeat(bad), null)
    assert.equal(bpmFromMs(bad), null)
  }
})

test('ticks: 1/4 at 150 BPM is 100 ms, and a span counts in them', () => {
  assert.equal(tickMs(150, 4), 100)
  assert.equal(ticksToMs(3, 150, 4), 300)
  const t = msToTicks(1234, 150, 4)
  close(t.ticks, 12.34)
  assert.equal(t.nearest, 12)
  close(t.offMs, 34)
  close(t.beats, 3.085)
  assert.deepEqual(msToTicks(100, 0, 4), { ticks: null, beats: null, nearest: null, offMs: null })
  assert.equal(tickMs(150, 0), null)
})

test('the offset between two red lines, on the first one’s grid', () => {
  // 150 BPM from 1000 ms; a line at 1000 + 75 beats + 12.5 ms.
  const out = lineOffset(1000, 150, 1000 + 75 * 400 + 12.5)
  close(out.spanMs, 30012.5)
  assert.equal(out.nearestBeat, 75)
  close(out.offMs, 12.5)
  close(out.gridMs, 31000)
  close(out.bars, 75.03125 / 4)
  // Early: negative.
  close(lineOffset(1000, 150, 1000 + 400 * 10 - 3).offMs, -3)
  // A line before the first one works too.
  assert.equal(lineOffset(1000, 150, 200).nearestBeat, -2)
  assert.equal(lineOffset(1000, null, 200).offMs, null)
})

test('the earliest offset for the same grid', () => {
  close(firstBeatOffset(1234, 150), 34)
  close(firstBeatOffset(-366, 150), 34)
  assert.equal(firstBeatOffset(800, 150), 0)
  assert.equal(firstBeatOffset(5, 0), null)
})

test('drift: 150 against 150.1 over 32 bars of 4', () => {
  const out = drift(150.1, 150, 32)
  assert.equal(out.beats, 128)
  // 128 × (400 − 60000/150.1) = 128 × 0.26649 ≈ 34.11 ms, late.
  close(out.driftMs, 128 * (400 - 60000 / 150.1))
  assert.ok(out.driftMs > 34.1 && out.driftMs < 34.12)
  close(out.perBarMs, out.driftMs / 32)
  assert.ok(drift(150, 150.1, 32).driftMs < 0)
  assert.equal(drift(150, 150, 100).driftMs, 0)
  assert.equal(drift(150, 0, 32).driftMs, null)
})

test('the BPM that drifts X ms in Y bars, and back', () => {
  const out = bpmForDrift(150, 5, 64)
  // 5 ms over 256 beats: each beat 5/256 ms longer or shorter.
  close(out.slower, 60000 / (400 + 5 / 256))
  close(out.faster, 60000 / (400 - 5 / 256))
  close(drift(150, out.slower, 64).driftMs, 5, 1e-9)
  close(drift(150, out.faster, 64).driftMs, -5, 1e-9)
  assert.ok(out.bpmDelta > 0.0073 && out.bpmDelta < 0.0074)
  // A drift as long as a beat per beat leaves no faster BPM.
  assert.equal(bpmForDrift(150, 400 * 4, 1).faster, null)
  assert.equal(bpmForDrift(150, 5, 0).slower, null)
})

test('the BPM from two timestamps and a beat count', () => {
  assert.deepEqual(bpmFromSpan(1000, 9000, 20), { bpm: 150, beatMs: 400 })
  assert.deepEqual(bpmFromSpan(9000, 1000, 20), { bpm: 150, beatMs: 400 })
  assert.deepEqual(bpmFromSpan(1000, 1000, 20), { bpm: null, beatMs: null })
  assert.deepEqual(bpmFromSpan(1000, 2000, 0), { bpm: null, beatMs: null })
})

test('readouts keep their decimals, use a true minus and never say -0', () => {
  assert.equal(readout(400, 3), '400.000')
  assert.equal(readout(-3.25, 2), '−3.25')
  assert.equal(readout(-0.0001, 3), '0.000')
  assert.equal(readout(null), '–')
  assert.equal(readout(NaN), '–')
})

test('the result page’s link fills in its first line, and nothing else', () => {
  assert.equal(calculatorPath({ timeMs: 1234.5678, beatMs: 60000 / 174.3 }), '/tools/calculator?bpm=174.3&offset=1234.568')
  assert.equal(calculatorPath(null), '/tools/calculator')
  assert.equal(calculatorPath({ timeMs: 0, beatMs: 0 }), '/tools/calculator')
  assert.deepEqual(calculatorSeed('?bpm=174.3&offset=1234.568'), { bpm: '174.3', offset: '1234.568' })
  assert.deepEqual(calculatorSeed('?bpm=-5&offset=abc'), { bpm: '', offset: '' })
  assert.deepEqual(calculatorSeed(''), { bpm: '', offset: '' })
})

test('arrow keys: 1, ×10 with Shift, ×0.1 with Alt, without float dust', () => {
  assert.equal(arrowStep({}), 1)
  assert.equal(arrowStep({ shiftKey: true }), 10)
  assert.equal(arrowStep({ altKey: true }), 0.1)
  assert.equal(stepValue('0.2', 0.1), '0.3')
  assert.equal(stepValue('150', -10), '140')
  assert.equal(stepValue('', 1), '1')
  assert.equal(stepValue('1,5', 0.1), '1.6')
})
