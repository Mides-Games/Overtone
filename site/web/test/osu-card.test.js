import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  busiestMonth,
  fillMonths,
  GRADES,
  historyDate,
  mapShares,
  MODE_NAMES,
  monthName,
  nearestPoint,
  playHours,
  rankLine,
  rankSpan,
} from '../src/lib/osu-card.js'

/**
 * The osu! card's arithmetic (components/social/OsuCard.jsx, 2026-11-07):
 * what the drawing rests on, held apart from React so a wrong scale or a
 * closed gap shows here and not only on a page nobody looked at.
 */

test('the rank line puts a better rank higher and breaks where osu! had no rank', () => {
  const line = rankLine([100, 50, null, 75], 216, 108, 8)
  assert.deepEqual(
    line.points.map((p) => [p.i, p.x, p.y]),
    [
      [0, 8, 100],
      [1, 74.7, 8],
      [3, 208, 54],
    ],
  )
  // Two pieces: the day without a rank is a gap, not a fall to the bottom.
  assert.equal(line.d, 'M8 100L74.7 8M208 54')
  // Shade under the two-day run only, down to the floor: a lone day has no area.
  assert.equal(line.area, 'M8 108L8 100L74.7 8L74.7 108Z')
  assert.deepEqual([line.best, line.worst, line.from, line.to, line.change], [50, 100, 100, 75, 25])
})

test('a flat history sits in the middle; no rank at all, or no room, draws nothing', () => {
  const flat = rankLine([300, 300, 300], 100, 40)
  assert.ok(flat.points.every((p) => p.y === 20))
  assert.equal(rankLine([null, null], 100, 40), null)
  assert.equal(rankLine([], 100, 40), null)
  assert.equal(rankLine([5, 6], 0, 40), null)
  assert.equal(rankSpan([null]), null)
  // A single day is drawn at the centre, not divided by zero.
  assert.equal(rankLine([7], 100, 40).points[0].x, 50)
})

test('the change counts places climbed: from #1000 to #800 is 200 up, the other way 200 down', () => {
  assert.equal(rankSpan([1000, 900, 800]).change, 200)
  assert.equal(rankSpan([800, null, 1000]).change, -200)
})

test('the pointer reads the nearest day', () => {
  const { points } = rankLine([10, 20, 30, 40], 300, 100, 0)
  assert.equal(nearestPoint(points, 0).rank, 10)
  assert.equal(nearestPoint(points, 160).rank, 30)
  assert.equal(nearestPoint(points, 999).rank, 40)
  assert.equal(nearestPoint([], 5), null)
})

test('day i of a 90-day history is dated back from the card\'s own date', () => {
  const asOf = '2026-11-07T12:00:00.000Z'
  assert.equal(historyDate(asOf, 90, 89).toISOString(), asOf)
  assert.equal(historyDate(asOf, 90, 0).toISOString(), '2026-08-10T12:00:00.000Z')
  assert.equal(historyDate('not a date', 90, 0), null)
})

test('months osu! left out come back as 0, across a year end, oldest first', () => {
  const months = fillMonths([
    { month: '2025-12', count: 4 },
    { month: '2025-11', count: 2 },
    { month: '2026-02', count: 9 },
    { month: 'junk', count: 1 },
  ])
  assert.deepEqual(months, [
    { month: '2025-11', count: 2 },
    { month: '2025-12', count: 4 },
    { month: '2026-01', count: 0 },
    { month: '2026-02', count: 9 },
  ])
  assert.deepEqual(busiestMonth(months), { month: '2026-02', count: 9 })
  assert.deepEqual(fillMonths([]), [])
  assert.equal(busiestMonth([{ month: '2026-01', count: 0 }]), null)
})

test('the beatmap set bar leaves out empty states and its shares add up', () => {
  const { total, parts } = mapShares({ ranked: 2, loved: 0, guest: 1, pending: null, graveyard: 5 })
  assert.equal(total, 8)
  assert.deepEqual(parts.map((p) => [p.key, p.count, p.share]), [
    ['ranked', 2, 25],
    ['guest', 1, 12.5],
    ['graveyard', 5, 62.5],
  ])
  assert.deepEqual(mapShares({}), { total: 0, parts: [] })
})

test('grades run in osu!\'s order, silver before gold; hours round down; rulesets keep osu!\'s names', () => {
  assert.deepEqual(GRADES.map((g) => `${g.letter}${g.silver ? '+' : ''}`), ['SS+', 'SS', 'S+', 'S', 'A'])
  assert.equal(playHours(7199), 1)
  assert.equal(playHours(null), null)
  assert.equal(MODE_NAMES.fruits, 'osu!catch')
  assert.equal(monthName('2026-02', 'en'), 'Feb 2026')
  assert.equal(monthName('nope', 'en'), 'nope')
})
