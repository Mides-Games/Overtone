import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rowOf, timingRows, toggleSelection } from '../src/lib/osu-copy.js'
import { adjustLines, timingText } from '../src/lib/timing.js'
import { adjustmentLabel, diffLines, diffSummary, isAdjusted, versionLines } from '../src/lib/versions.js'

/** A result as the worker writes one: two red lines, the engine's own rows to 12 decimals. */
const result = {
  duration_s: 60,
  red_lines: [
    { time_ms: 400, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 30_400, bpm: 142, beat_length_ms: 422.535211267606, meter: 3, meter_known: true },
  ],
  osu_timing: '// engine header\n400,468.750000000000,4,1,0,100,1,0\n30400,422.535211267606,3,1,0,100,1,0',
}

test('copy as rows: the engine\'s own rows unadjusted, by time, CRLF, no header or comment', () => {
  const lines = adjustLines(result)
  assert.equal(timingRows(result, lines, undefined, [1]), '30400,422.535211267606,3,1,0,100,1,0\r\n')
  assert.equal(timingRows(result, lines, undefined, [1, 0, 1]), '400,468.750000000000,4,1,0,100,1,0\r\n30400,422.535211267606,3,1,0,100,1,0\r\n')
  assert.equal(timingRows(result, lines, undefined, []), '')
  assert.equal(timingRows(result, lines, undefined, [7, -1]), '')
  // Every row, unadjusted, is the whole-block copy without its header and comments.
  const block = timingText(result, lines).split('\r\n').filter((r) => r && !r.startsWith('[') && !r.startsWith('//'))
  assert.equal(timingRows(result, lines), `${block.join('\r\n')}\r\n`)
})

test('copy as rows: adjusted, the rows follow the page\'s lines as the whole block does', () => {
  const adjustment = { factor: 2, nudgeMs: 5 }
  const lines = adjustLines(result, adjustment)
  assert.equal(timingRows(result, lines, adjustment, [0]), '405,234.375000000000,4,1,0,100,1,0\r\n')
  const block = timingText(result, lines, adjustment).split('\r\n').filter((r) => r && !r.startsWith('[') && !r.startsWith('//'))
  assert.equal(timingRows(result, lines, adjustment), `${block.join('\r\n')}\r\n`)
  // A half ms rounds as the engine does, half to even.
  assert.equal(rowOf({ timeMs: 402.5, beatMs: 500, meter: 4 }), '402,500.000000000000,4,1,0,100,1,0')
})

test('copy as rows: rows whose engine text does not line up are built from the lines', () => {
  const broken = { ...result, osu_timing: '400,468.75,4,1,0,100,1,0' }
  assert.equal(timingRows(broken, adjustLines(broken), undefined, [1]), '30400,422.535211267606,3,1,0,100,1,0\r\n')
})

test('ticking: a click toggles one row, Shift-click a stretch to the last one clicked', () => {
  let s = toggleSelection(new Set(), 2)
  assert.deepEqual([...s], [2])
  s = toggleSelection(s, 5, { shift: true, anchor: 2 })
  assert.deepEqual([...s].sort(), [2, 3, 4, 5])
  // Row 3 was ticked, so the stretch from 5 back to 3 takes its new state: off.
  s = toggleSelection(s, 3, { shift: true, anchor: 5 })
  assert.deepEqual([...s].sort(), [2])
  // A plain click unticks one.
  assert.deepEqual([...toggleSelection(new Set([1, 2]), 1)], [2])
})

test('ticking: Shift-click on a ticked row clears the stretch', () => {
  const s = toggleSelection(new Set([1, 2, 3, 4]), 2, { shift: true, anchor: 4 })
  assert.deepEqual([...s].sort(), [1])
})

test('a diff pairs the closest red lines within half a beat and names what only one side has', () => {
  const engine = versionLines(result)
  const nudged = versionLines(result, { factor: 1, nudgeMs: -4 })
  const rows = diffLines(engine, nudged)
  assert.deepEqual(rows.map((r) => [r.a, r.b, r.dTimeMs, r.dBpm]), [[0, 0, -4, 0], [1, 1, -4, 0]])
  assert.deepEqual(diffSummary(rows), { maxTimeMs: 4, maxBpm: 0, onlyA: 0, onlyB: 0, meters: 0, same: false })

  const doubled = diffLines(engine, versionLines(result, { factor: 2, nudgeMs: 0 }))
  assert.deepEqual(doubled.map((r) => [r.dTimeMs, r.dBpm]), [[0, 128], [0, 142]])

  // A reading with a third red line: it is only in B, and the others still pair.
  const other = { ...result, red_lines: [...result.red_lines, { time_ms: 45_000, bpm: 150, beat_length_ms: 400, meter: 4 }], osu_timing: '' }
  const three = diffLines(engine, versionLines(other))
  assert.deepEqual(three.map((r) => [r.a, r.b]), [[0, 0], [1, 1], [null, 2]])
  assert.equal(diffSummary(three).onlyB, 1)
  assert.equal(diffSummary(diffLines(engine, engine)).same, true)
  // Too far apart to be the same line: two unpaired rows, never a forced pair.
  const far = diffLines([{ timeMs: 0, beatMs: 500, bpm: 120, meter: 4 }], [{ timeMs: 300, beatMs: 500, bpm: 120, meter: 4 }])
  assert.deepEqual(far.map((r) => [r.a, r.b]), [[0, null], [null, 0]])
})

test('an adjustment\'s name and whether there is one', () => {
  assert.equal(adjustmentLabel({ factor: 2, nudgeMs: -4 }), '×2 −4 ms')
  assert.equal(adjustmentLabel({ factor: 0.5, nudgeMs: 0 }), '÷2')
  assert.equal(adjustmentLabel({ factor: 1, nudgeMs: 12 }), '+12 ms')
  assert.equal(adjustmentLabel({ factor: 1, nudgeMs: 0 }), '')
  assert.equal(isAdjusted({ factor: 1, nudgeMs: 0 }), false)
  assert.equal(isAdjusted({ factor: 1, nudgeMs: 1 }), true)
})
