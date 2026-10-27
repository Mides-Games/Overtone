import assert from 'node:assert/strict'
import { test } from 'node:test'

import { batchProgress } from '../src/lib/batch.js'

test('a batch counts what will not change any more', () => {
  const progress = batchProgress(['done', 'running', 'queued', 'refused', 'sending'])
  assert.deepEqual(progress, { total: 5, finished: 2, done: 1, complete: false })
  assert.equal(batchProgress(['done', 'failed', 'refused', 'cancelled']).complete, true)
})

test('a single song is never a complete batch, and an empty list is not either', () => {
  assert.equal(batchProgress(['done']).complete, false)
  assert.equal(batchProgress([]).complete, false)
})
