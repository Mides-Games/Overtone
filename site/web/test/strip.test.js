import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activeIndex, barBeat, buildLines, gridOf, levelOf, loopTime, osuRow, readoutsOf, spanOf, steppedIndex } from '../src/lib/strip.js'

/**
 * The front page's example analysis (lib/strip.js): its red lines must be
 * timing a mapper would accept, the grid drawn must be the one those lines
 * make, and the playhead must find the right line at every moment of its loop.
 */
const lines = buildLines()

test('the example is osu! timing: whole-ms offsets on downbeats, beatLength = 60000 / BPM', () => {
  assert.ok(lines.length >= 4)
  assert.ok(new Set(lines.map((l) => l.bpm)).size >= 3, 'several BPMs')
  assert.ok(lines.some((l, i) => i > 0 && l.meter !== lines[i - 1].meter), 'a meter change')
  for (const [i, line] of lines.entries()) {
    assert.ok(Number.isInteger(line.offset), `line ${i} offset`)
    assert.equal(line.beatLength, 60000 / line.bpm)
    if (i > 0) {
      const prev = lines[i - 1]
      assert.equal(line.offset, prev.end)
      // The previous line's bars end within half a ms of this offset: it is on a downbeat.
      assert.ok(Math.abs(prev.offset + prev.bars * prev.meter * prev.beatLength - line.offset) <= 0.5)
    }
  }
  assert.equal(lines[0].offset, 1284)
  assert.equal(lines[1].offset, 1284 + Math.round(12 * (60000 / 174)))
})

test('the grid is each line\'s beats up to the next line, its bars on that line\'s meter', () => {
  const grid = gridOf(lines)
  assert.equal(grid.length, lines.reduce((n, l) => n + l.bars * l.meter, 0))
  for (const line of lines) assert.ok(grid.some((b) => b.time === line.offset && b.bar), 'a red line is a bar line')
  const threeFour = lines.findIndex((l) => l.meter === 3)
  const bars = grid.filter((b) => b.line === threeFour && b.bar).map((b) => b.time)
  assert.deepEqual(bars, [lines[threeFour].offset, lines[threeFour].offset + 3 * lines[threeFour].beatLength])
  assert.ok(grid.every((b, i) => i === 0 || b.time > grid[i - 1].time), 'strictly increasing')
})

test('the playhead loops over the span and finds the line in force', () => {
  const { start, end } = spanOf(lines)
  assert.equal(loopTime(lines, 0), start)
  assert.equal(loopTime(lines, end - start), start)
  assert.equal(loopTime(lines, end - start + 10), start + 10)
  assert.equal(loopTime(lines, -10), end - 10)
  assert.equal(loopTime(lines, NaN), start)
  for (const [i, line] of lines.entries()) {
    assert.equal(activeIndex(lines, line.offset), i, 'on its offset')
    assert.equal(activeIndex(lines, line.end - 1), i, 'just before the next')
  }
  assert.equal(activeIndex(lines, 0), 0, 'before the first line')
})

test('bar and beat count from each line\'s own offset and meter', () => {
  assert.deepEqual(barBeat(lines, lines[0].offset), { bar: 1, beat: 1 })
  assert.deepEqual(barBeat(lines, lines[0].offset + 5 * lines[0].beatLength), { bar: 2, beat: 2 })
  const l = lines[2]
  assert.deepEqual(barBeat(lines, l.offset + 3 * l.beatLength + 1), { bar: 2, beat: 1 })
})

test('the readouts and the [TimingPoints] row read as the result page writes them', () => {
  assert.deepEqual(readoutsOf(lines[0]), { bpm: '174.00', offset: '1284', meter: '4/4', confidence: '0.97' })
  assert.equal(osuRow(lines[0]), '1284,344.827586206897,4,2,0,60,1,0')
  assert.equal(osuRow(lines[2]).split(',')[2], '3')
  assert.deepEqual(lines.map((l) => l.level), ['high', 'high', 'medium', 'check'])
  assert.equal(levelOf(0.9), 'high')
  assert.equal(levelOf(0.75), 'medium')
  assert.equal(levelOf(0.7499), 'check')
})

test('reduced motion steps through the lines slowly instead of sweeping', () => {
  assert.equal(steppedIndex(lines, 0), 0)
  assert.equal(steppedIndex(lines, 3999), 0)
  assert.equal(steppedIndex(lines, 4000), 1)
  assert.equal(steppedIndex(lines, 4000 * lines.length), 0)
  assert.equal(steppedIndex(lines, -50), 0)
})
