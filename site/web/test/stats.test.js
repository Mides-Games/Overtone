import assert from 'node:assert/strict'
import { test } from 'node:test'

import { barScale, bucketName, shares } from '../src/lib/stats.js'

/** The statistics page's arithmetic (W12.13): the numbers come from the API, the page only names and scales them. */
test('the statistics page: shares add up to 100, buckets are named by their open or closed edges, bars scale to the longest', () => {
  assert.deepEqual(shares([1, 1, 1]), [34, 33, 33])
  assert.deepEqual(shares([0, 0]), [0, 0])
  assert.deepEqual(shares([3, 1]), [75, 25])
  for (const counts of [[1, 2], [7, 3, 9], [1, 1, 1, 1, 1, 1, 1]]) assert.equal(shares(counts).reduce((a, b) => a + b), 100)
  assert.deepEqual(bucketName({ from: null, to: 80 }), { key: 'siteStats.bpm.below', values: { to: 80 } })
  assert.deepEqual(bucketName({ from: 260, to: null }), { key: 'siteStats.bpm.above', values: { from: 260 } })
  assert.deepEqual(bucketName({ from: 120, to: 140 }), { key: 'siteStats.bpm.range', values: { from: 120, to: 140 } })
  assert.deepEqual(barScale([0, 2, 4]), [0, 0.5, 1])
  assert.deepEqual(barScale([0, 0]), [0, 0])
  assert.deepEqual(barScale([]), [])
})
