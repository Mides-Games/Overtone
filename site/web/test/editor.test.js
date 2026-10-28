import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  addLine,
  canRedo,
  canUndo,
  commit,
  createHistory,
  deleteLine,
  EditError,
  editsKey,
  engineEditLines,
  HISTORY_LIMIT,
  jump,
  MAX_LINES,
  mergeSections,
  normaliseEdits,
  nudgeLine,
  packEdits,
  present,
  redo,
  rescaleSection,
  setMeter,
  snapTo,
  splitSection,
  toBase,
  undo,
  unpackEdits,
  updateLine,
} from '../src/lib/editor.js'
import { adjustLines, isAdjusted, timingText } from '../src/lib/timing.js'

const golden = JSON.parse(readFileSync(new URL('./fixtures/editor-golden.json', import.meta.url), 'utf8'))

/** Python's rows `[offset_ms, bpm, meter, meter_known]` as editor lines. */
const lines = (rows) => rows.map(([timeMs, bpm, meter, known], i) => ({ timeMs, beatMs: 60000 / bpm, meter, meterKnown: known, source: i }))
const rows = (out) => out.map((l) => [l.timeMs, 60000 / l.beatMs, l.meter, l.meterKnown])
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)

function sameRows(actual, expected, tol = 1e-6) {
  assert.equal(actual.length, expected.length)
  actual.forEach((row, i) => {
    near(row[0], expected[i][0], tol, `line ${i} time`)
    near(row[1], expected[i][1], tol, `line ${i} bpm`)
    assert.equal(row[2], expected[i][2])
    assert.equal(row[3], expected[i][3])
  })
}

test('the edits match the desktop app\'s Python helpers on every golden case', () => {
  assert.ok(golden.cases.length >= 15)
  for (const c of golden.cases) {
    const input = lines(c.lines)
    const attacks = { t: Float64Array.from(c.attacks?.t ?? []), w: Float64Array.from(c.attacks?.w ?? []) }
    const run = {
      split: () => splitSection(input, c.index, c.at, attacks, c.end),
      merge: () => mergeSections(input, c.index, attacks, c.end),
      nudge: () => nudgeLine(input, c.index, c.delta),
      add: () => addLine(input, c.time, c.bpm),
      update: () => updateLine(input, c.index, c.time, c.bpm),
      delete: () => deleteLine(input, c.index),
      meter: () => setMeter(input, c.index, c.meter),
      rescale: () => rescaleSection(input, c.index, c.factor),
    }[c.op]
    if (c.error) {
      assert.throws(run, EditError, `${c.op} at ${c.at} should be refused`)
      continue
    }
    const out = run()
    // The refit's BPM to a millionth of a BPM: same algorithm, same float order up to summation.
    sameRows(rows(out.lines), c.out, 1e-6)
    if (c.report) {
      if (c.op === 'split') near(out.report.splitMs, c.report.split, 1e-9, 'split time')
      else near(out.report.removedMs, c.report.removed, 1e-9, 'removed time')
      out.report.sections.forEach((s, i) => {
        const e = c.report.sections[i]
        assert.equal(s.kept, e.kept)
        assert.equal(s.attacks, e.attacks)
        near(s.bpm, e.bpm, 1e-6, 'refit bpm')
        if (e.share === null) assert.equal(s.share, null)
        else near(s.share, e.share, 1e-9, 'share')
      })
    }
  }
})

test('the golden refits are not all the same answer: a fit, a weak one and a few-attacks one are covered', () => {
  const kept = golden.cases.flatMap((c) => c.report?.sections ?? []).map((s) => s.kept)
  assert.ok(kept.includes(null))
  assert.ok(kept.includes('few'))
  assert.ok(kept.includes('weak'))
})

test('the selected line follows a moved line through the re-sort', () => {
  const input = lines([[0, 120, 4, true], [5000, 140, 4, true], [9000, 100, 4, true]])
  const out = updateLine(input, 1, 9500)
  assert.equal(out.selected, 2)
  assert.equal(out.lines[2].source, 1)
  // A drag keeps the beat to its last decimal when no BPM is typed.
  assert.equal(out.lines[2].beatMs, input[1].beatMs)
  assert.equal(addLine(input, 7000, 128).selected, 2)
  assert.equal(addLine(input, 7000, 128).lines[2].source, -1)
})

test('edits the editor refuses: the first line, two lines on one time, a BPM out of range, a section without a next', () => {
  const input = lines([[0, 120, 4, true], [5000, 140, 4, true]])
  assert.throws(() => deleteLine(input, 0), { code: 'first' })
  assert.throws(() => updateLine(input, 1, 0.5), { code: 'tooClose' })
  assert.throws(() => nudgeLine(input, 1, -4999.5), { code: 'tooClose' })
  assert.throws(() => addLine(input, 100, 0), { code: 'badBpm' })
  assert.throws(() => addLine(input, 100, 9000), { code: 'bpmRange' })
  assert.throws(() => mergeSections(input, 1, { t: [], w: [] }, 10_000), { code: 'noNext' })
  assert.throws(() => setMeter(input, 0, 17), { code: 'badMeter' })
  assert.throws(() => rescaleSection(lines([[0, 400, 4, true]]), 0, 2), { code: 'rescaleRange' })
  const full = Array.from({ length: MAX_LINES }, (_, i) => ({ timeMs: i * 10, beatMs: 500, meter: 4, meterKnown: true, source: i }))
  assert.throws(() => addLine(full, 99_999, 120), { code: 'tooMany' })
})

test('snapping a dragged line: the nearest attack within the tolerance, else where the pointer is', () => {
  const t = [1, 2, 3]
  assert.equal(snapTo(t, 2.04, 0.05), 2)
  assert.equal(snapTo(t, 2.5, 0.05), 2.5)
  assert.equal(snapTo([], 2.5, 0.05), 2.5)
})

const result = {
  duration_s: 60,
  red_lines: [
    { time_ms: 400, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 30_400, bpm: 142, beat_length_ms: 422.535211267606, meter: 3, meter_known: true },
  ],
  osu_timing: '// engine header\n400,468.750000000000,4,1,0,100,1,0\n30400,422.535211267606,3,1,0,100,1,0',
  sections: [{ confidence: 0.9, level: 'high' }, { confidence: 0.5, level: 'check' }],
}

test('frames: an edit made on the adjusted lines is kept before the adjustment and comes back the same', () => {
  const adjustment = { factor: 2, nudgeMs: 7 }
  const shown = adjustLines(result, adjustment)
  const { lines: moved } = nudgeLine(engineEditLines(result).map((l, i) => ({ ...l, timeMs: shown[i].timeMs, beatMs: shown[i].beatMs })), 1, 10)
  const base = toBase(moved, adjustment)
  assert.equal(base[0].timeMs, 400)
  assert.equal(base[1].timeMs, 30_410)
  assert.equal(base[1].beatMs, 422.535211267606)
  const again = adjustLines(result, { ...adjustment, edits: base })
  assert.equal(again[1].timeMs, 30_417)
  assert.equal(again[1].beatMs, 422.535211267606 / 2)
})

test('edits that come back to the engine\'s reading are no edits at all', () => {
  const engine = engineEditLines(result)
  assert.equal(normaliseEdits(engine.map((l) => ({ ...l })), engine), null)
  assert.notEqual(normaliseEdits(nudgeLine(engine, 1, 1).lines, engine), null)
  assert.equal(normaliseEdits(nudgeLine(nudgeLine(engine, 1, 1).lines, 1, -1).lines, engine), null)
})

test('edited lines feed the exports: rows rebuilt, the comment says edited, the confidence follows the source line', () => {
  const engine = engineEditLines(result)
  const { lines: edited } = addLine(engine, 10_000, 135)
  const adjustment = { factor: 1, nudgeMs: 0, edits: edited }
  assert.equal(isAdjusted(adjustment), true)
  const shown = adjustLines(result, adjustment)
  assert.equal(shown.length, 3)
  assert.equal(shown[1].index, -1)
  assert.equal(shown[1].added, true)
  assert.equal(shown[2].index, 1)
  assert.equal(shown[2].edited, false)
  const text = timingText(result, shown, adjustment)
  assert.match(text, /\/\/ Edited on the Overtone site \(edited: 3 red lines\): check it by ear/)
  assert.match(text, /\r\n10000,444\.444444444444,4,1,0,100,1,0\r\n/)
  // The engine's rows are untouched by an edit elsewhere: its own 12 decimals.
  assert.match(text, /\r\n30400,422\.535211267606,3,1,0,100,1,0\r\n/)
})

test('packed edits round-trip and are checked as the API checks them', () => {
  const engine = engineEditLines(result)
  const packed = packEdits(engine)
  assert.deepEqual(unpackEdits(JSON.parse(JSON.stringify(packed))), engine)
  assert.equal(unpackEdits([]), null)
  assert.equal(unpackEdits([[0, 500, 4, 1]]), null)
  assert.equal(unpackEdits([[0, 500, 4, 1, 0], [0.5, 500, 4, 1, 1]]), null)
  assert.equal(unpackEdits([[0, 5, 4, 1, 0]]), null)
  assert.equal(unpackEdits([[0, 500, 20, 1, 0]]), null)
  assert.equal(unpackEdits([[0, 500, 4, 2, 0]]), null)
  assert.equal(unpackEdits('x'), null)
  assert.equal(editsKey(engine), editsKey(unpackEdits(packed)))
  assert.notEqual(editsKey(engine), editsKey(nudgeLine(engine, 0, 1).lines))
  assert.equal(editsKey(null), '')
})

test('history: undo, redo, a new edit drops the redo, a jump, and the cap', () => {
  let h = createHistory()
  assert.equal(canUndo(h), false)
  h = commit(h, ['a'], { key: 'nudge' })
  h = commit(h, ['b'], { key: 'add' })
  assert.deepEqual(present(h), ['b'])
  h = undo(h)
  assert.deepEqual(present(h), ['a'])
  assert.equal(canRedo(h), true)
  h = redo(h)
  assert.deepEqual(present(h), ['b'])
  h = undo(undo(h))
  assert.equal(present(h), null)
  h = commit(h, ['c'], { key: 'delete' })
  assert.equal(canRedo(h), false)
  assert.equal(h.steps.length, 2)
  assert.deepEqual(present(jump(h, 0)), null)
  assert.equal(jump(h, 9), h)
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = commit(h, [i], { key: 'nudge' })
  assert.equal(h.steps.length, HISTORY_LIMIT)
  assert.equal(h.at, HISTORY_LIMIT - 1)
})
