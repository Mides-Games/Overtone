import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BPM_TOLERANCE,
  compareTimings,
  comparePath,
  matchLines,
  OFFSET_TOLERANCE_MS,
  phaseMs,
  readAnalysisRef,
  readOsu,
  readSide,
  relation,
} from '../src/lib/compare.js'
import { adjustLines } from '../src/lib/timing.js'

/** A red line in `adjustLines`' shape. */
const line = (timeMs, bpm, meter = 4) => ({ timeMs, bpm, beatMs: 60000 / bpm, meter })
const close = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not ${expected}`)
const MINUTE = 60_000

test('the tolerances are the accuracy gates own', () => {
  assert.equal(BPM_TOLERANCE, 0.05)
  assert.equal(OFFSET_TOLERANCE_MS, 5)
})

test('the same grid shifted by whole beats is the same grid', () => {
  const A = [line(400, 128)]
  // Four beats, then thirteen beats later: osu! plays the same clicks.
  for (const beats of [4, 13]) {
    const B = [line(400 + beats * (60000 / 128), 128)]
    const cmp = compareTimings(A, B, { durationMs: MINUTE })
    assert.equal(cmp.verdict, 'same', `${beats} beats`)
    close(cmp.withinMs, 0)
    assert.ok(cmp.samples > 100)
  }
  // Paired when close enough; the phase is 0 and the bar is shifted by one beat.
  const cmp = compareTimings(A, [line(400 + 60000 / 128, 128)], { durationMs: MINUTE })
  assert.equal(cmp.pairs.length, 1)
  close(cmp.pairs[0].offsetMs, 0)
  close(cmp.pairs[0].endOffsetMs, 0)
  assert.equal(cmp.pairs[0].barShiftBeats, 1)
  assert.equal(cmp.barsShifted, 1)
  assert.equal(cmp.pairs[0].agree, true)
})

test('a small offset is measured in ms, and past 5 ms it is an offset, not the same grid', () => {
  const A = [line(400, 128)]
  const within = compareTimings(A, [line(403, 128)], { durationMs: MINUTE })
  assert.equal(within.verdict, 'same')
  close(within.withinMs, 3)
  close(within.pairs[0].offsetMs, 3)

  const shifted = compareTimings(A, [line(412, 128)], { durationMs: MINUTE })
  assert.equal(shifted.verdict, 'offset')
  close(shifted.offsetMs, 12)
  assert.equal(shifted.pairs[0].agree, false)

  // Earlier is negative: B minus A.
  const early = compareTimings(A, [line(390 + 60000 / 128 * 8, 128)], { durationMs: MINUTE })
  assert.equal(early.verdict, 'offset')
  close(early.offsetMs, -10)
})

test('half and double the tempo on the same beats are named, not called different', () => {
  const A = [line(400, 120)]
  const double = compareTimings(A, [line(400, 240)], { durationMs: MINUTE })
  assert.equal(double.verdict, 'double')
  close(double.withinMs, 0)
  assert.equal(double.pairs[0].kind, 'double')
  assert.equal(double.pairs[0].bpmOk, true)

  // Half, starting on an off-beat of A's grid: still every other beat of A.
  const half = compareTimings(A, [line(900, 60)], { durationMs: MINUTE })
  assert.equal(half.verdict, 'half')
  close(half.withinMs, 0)
  close(half.pairs[0].offsetMs, 0)

  // Double but 8 ms off is different, with nothing agreeing.
  const off = compareTimings(A, [line(408, 240)], { durationMs: MINUTE })
  assert.equal(off.verdict, 'different')
  assert.equal(off.agreeShare, 0)
})

test('relation judges half and double on the slower scale', () => {
  assert.deepEqual(relation(120, 120.04), { kind: 'same', bpmOk: true })
  assert.deepEqual(relation(120, 120.06), { kind: 'same', bpmOk: false })
  assert.deepEqual(relation(120, 240.08), { kind: 'double', bpmOk: true })
  assert.deepEqual(relation(120, 240.12), { kind: 'double', bpmOk: false })
  assert.deepEqual(relation(120, 60.04), { kind: 'half', bpmOk: true })
  assert.deepEqual(relation(120, 180), { kind: 'other', bpmOk: false })
})

test('a missing red line is listed, and says whether the other grid already agrees there', () => {
  const A = [line(400, 128), line(30400, 142)]
  const B = [line(400, 128)]
  const cmp = compareTimings(A, B, { durationMs: MINUTE })
  assert.equal(cmp.pairs.length, 1)
  assert.deepEqual(cmp.unmatched.map((u) => [u.side, u.index, u.sameGrid]), [['A', 1, false]])
  assert.equal(cmp.verdict, 'different')
  // The first 30 s agree, then B runs on at 128.
  assert.ok(cmp.agreeShare > 0.4 && cmp.agreeShare < 0.6, String(cmp.agreeShare))
  assert.ok(cmp.firstApartMs >= 30400 && cmp.firstApartMs < 31000, String(cmp.firstApartMs))

  // A redundant line (same tempo, on the grid) is unmatched but changes nothing.
  const redundant = compareTimings([line(400, 128)], [line(400, 128), line(400 + 64 * (60000 / 128), 128)], { durationMs: MINUTE })
  assert.equal(redundant.verdict, 'same')
  assert.deepEqual(redundant.unmatched.map((u) => [u.side, u.sameGrid]), [['B', true]])
})

test('drift growing over time: same start, the offset grows to the end', () => {
  // 120 against 120.1: 0.1 BPM over 60 s puts the last beat about 50 ms early.
  const cmp = compareTimings([line(0, 120)], [line(0, 120.1)], { durationMs: MINUTE })
  assert.equal(cmp.verdict, 'different')
  const pair = cmp.pairs[0]
  assert.equal(pair.kind, 'same')
  assert.equal(pair.bpmOk, false)
  close(pair.bpmDiff, 0.1, 1e-9)
  close(pair.offsetMs, 0)
  assert.ok(pair.endOffsetMs < -45 && pair.endOffsetMs > -55, String(pair.endOffsetMs))
  // Agreeing at first, then apart once the drift passes 5 ms (about 6 s in).
  assert.ok(cmp.firstApartMs > 5000 && cmp.firstApartMs < 7000, String(cmp.firstApartMs))
  close(cmp.withinMs, Math.abs(pair.endOffsetMs), 1)

  // 0.04 BPM over a minute is within the gate's BPM tolerance, but not its 5 ms.
  const slow = compareTimings([line(0, 120)], [line(0, 120.04)], { durationMs: MINUTE })
  assert.equal(slow.pairs[0].bpmOk, true)
  assert.equal(slow.verdict, 'different')
})

test('a meter difference is reported per pair, and the grid can still be the same', () => {
  const cmp = compareTimings([line(400, 150, 4)], [line(400, 150, 3)], { durationMs: MINUTE })
  assert.equal(cmp.verdict, 'same')
  assert.equal(cmp.meterDiffers, 1)
  assert.equal(cmp.pairs[0].meterA, 4)
  assert.equal(cmp.pairs[0].meterB, 3)
  assert.equal(cmp.pairs[0].barShiftBeats, null)
})

test('a tempo change matched across two timings, and the lines a few beats apart pair up', () => {
  const A = [line(400.127, 128), line(30400.127, 142)]
  // A map's whole-ms offsets: the same grid within a fraction of a ms.
  const cmp = compareTimings(A, [line(400, 128), line(30400, 142)], { durationMs: MINUTE })
  assert.equal(cmp.verdict, 'same')
  assert.ok(cmp.withinMs < 0.2)
  assert.deepEqual(cmp.unmatched, [])

  // Its change two beats late still pairs, but the 845 ms between them click at the old tempo: different there.
  const B = [line(400, 128), line(30400 + 2 * (60000 / 142), 142)]
  const { pairs, onlyA, onlyB } = matchLines(A, B)
  assert.deepEqual(pairs, [[0, 0], [1, 1]])
  assert.deepEqual([onlyA, onlyB], [[], []])
  const late = compareTimings(A, B, { durationMs: MINUTE })
  assert.equal(late.verdict, 'different')
  close(late.pairs[1].offsetMs, -0.127, 1e-6)
  assert.ok(late.agreeShare > 0.95)
  assert.ok(late.firstApartMs > 30400 && late.firstApartMs < 31300)
})

test('lines too far apart do not pair; the order of lines is kept', () => {
  const A = [line(0, 120), line(20000, 140), line(40000, 160)]
  const B = [line(0, 120), line(41000, 160)]
  const { pairs, onlyA } = matchLines(A, B)
  assert.deepEqual(pairs, [[0, 0], [2, 1]])
  assert.deepEqual(onlyA, [1])
})

test('phaseMs reads a grid one beat away as 0 and a half-beat away as half a beat', () => {
  const a = line(1000, 120)
  close(phaseMs(a, line(1500, 120), 1500), 0)
  close(phaseMs(a, line(1250, 120), 1250), 250)
})

test('no overlap and empty timings', () => {
  assert.equal(compareTimings([], [line(0, 120)], { durationMs: MINUTE }), null)
  const late = compareTimings([line(0, 120)], [line(2 * MINUTE, 120)], { durationMs: MINUTE })
  assert.equal(late.pairs.length, 0)
  assert.equal(late.unmatched.length, 2)
})

test('the result against its own adjusted version: x2 is double, a nudge is an offset', () => {
  const result = {
    red_lines: [{ time_ms: 400.127, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true }],
    osu_timing: '400,468.750000000000,4,1,0,100,1,0',
  }
  const engine = adjustLines(result)
  assert.equal(compareTimings(engine, adjustLines(result, { factor: 2 }), { durationMs: MINUTE }).verdict, 'double')
  const nudged = compareTimings(engine, adjustLines(result, { nudgeMs: 7 }), { durationMs: MINUTE })
  assert.equal(nudged.verdict, 'offset')
  close(nudged.offsetMs, 7)
})

/** A mapped .osu, CRLF, with a BOM, greens, a duplicate red line and a meter change. */
const map = [
  '﻿osu file format v14',
  '',
  '[General]',
  'AudioFilename: audio.mp3',
  'AudioLeadIn: 0',
  '',
  '[Metadata]',
  'Title:Song',
  'TitleUnicode:Sóng‮',
  'Artist:Someone',
  'Version:Insane',
  '',
  '[TimingPoints]',
  '398,500,4,2,1,70,1,0',
  '398,-100,4,2,1,70,0,0',
  '15398,-50,4,2,1,70,0,1',
  '30398,999,4,2,1,70,1,0',
  '30398,422.535211267606,3,2,1,70,1,0',
  '// a comment',
  '',
  '[HitObjects]',
  '256,192,398,1,0,0:0:0:0:',
].join('\r\n')

test('readOsu reads red lines, the audio file and the names, and leaves green lines out', () => {
  const osu = readOsu(map)
  assert.equal(osu.audioFilename, 'audio.mp3')
  assert.equal(osu.title, 'Sóng')
  assert.equal(osu.artist, 'Someone')
  assert.equal(osu.version, 'Insane')
  assert.equal(osu.lines.length, 2)
  assert.deepEqual(
    osu.lines.map((l) => [l.timeMs, l.meter]),
    [[398, 4], [30398, 3]],
  )
  close(osu.lines[0].bpm, 120)
  close(osu.lines[1].bpm, 142, 1e-9)
})

test('readOsu refuses what is not a map or has no red line', () => {
  assert.deepEqual(readOsu('hello'), { error: 'notOsu' })
  assert.deepEqual(readOsu('osu file format v14\n[General]\nAudioFilename: a.mp3\n'), { error: 'noTimingPoints' })
  assert.deepEqual(readOsu('osu file format v14\n[TimingPoints]\n0,-100,4,1,0,100,0,0\n'), { error: 'noRedLines' })
  const many = ['osu file format v14', '[TimingPoints]', ...Array.from({ length: 2001 }, (_, i) => `${i * 10},500,4,1,0,100,1,0`)].join('\n')
  assert.deepEqual(readOsu(many), { error: 'tooManyLines' })
})

test('the /compare address round-trips, validates ids and adjustments, and reads pasted links', () => {
  const a = { id: 'a'.repeat(32), factor: 1, nudgeMs: 0 }
  const b = { id: 'b'.repeat(32), factor: 2, nudgeMs: -5 }
  const path = comparePath(a, b)
  assert.equal(path, `/compare?a=${'a'.repeat(32)}&b=${'b'.repeat(32)}&bx=2&bn=-5`)
  const params = new URLSearchParams(path.split('?')[1])
  assert.deepEqual(readSide(params, 'a'), a)
  assert.deepEqual(readSide(params, 'b'), b)
  assert.equal(comparePath(a), `/compare?a=${'a'.repeat(32)}`)
  assert.equal(readSide(new URLSearchParams('a=xyz'), 'a'), null)
  assert.deepEqual(readSide(new URLSearchParams(`a=${'c'.repeat(32)}&ax=3&an=99999`), 'a'), { id: 'c'.repeat(32), factor: 1, nudgeMs: 0 })

  const id = '0123456789abcdef0123456789abcdef'
  assert.equal(readAnalysisRef(id), id)
  assert.equal(readAnalysisRef(` https://overtone.midesprojects.com/t/${id} `), id)
  assert.equal(readAnalysisRef(`http://127.0.0.1:5194/analyze/${id}?x=1`), id)
  assert.equal(readAnalysisRef('/t/nothex'), null)
})
