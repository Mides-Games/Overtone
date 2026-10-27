import assert from 'node:assert/strict'
import { test } from 'node:test'

import { batchProgress, batchTitle, shouldNotify } from '../src/lib/batch.js'

test('a batch counts what will not change any more', () => {
  const progress = batchProgress(['done', 'running', 'queued', 'refused', 'sending'])
  assert.deepEqual(progress, { total: 5, finished: 2, done: 1, complete: false })
  assert.equal(batchProgress(['done', 'failed', 'refused', 'cancelled']).complete, true)
})

test('a single song is never a complete batch, and an empty list is not either', () => {
  assert.equal(batchProgress(['done']).complete, false)
  assert.equal(batchProgress([]).complete, false)
})

test('the title carries the count only for a batch', () => {
  assert.equal(batchTitle(batchProgress(['done', 'queued']), '1/2 ready', 'Overtone'), '1/2 ready · Overtone')
  assert.equal(batchTitle(batchProgress(['queued']), '0/1 ready', 'Overtone'), 'Overtone')
})

test('the notification goes once, when the batch has just finished, if asked and allowed', () => {
  const complete = batchProgress(['done', 'done'])
  const running = batchProgress(['done', 'running'])
  assert.equal(shouldNotify({ wasComplete: false, progress: complete, wanted: true, permission: 'granted' }), true)
  assert.equal(shouldNotify({ wasComplete: true, progress: complete, wanted: true, permission: 'granted' }), false)
  assert.equal(shouldNotify({ wasComplete: false, progress: running, wanted: true, permission: 'granted' }), false)
  assert.equal(shouldNotify({ wasComplete: false, progress: complete, wanted: false, permission: 'granted' }), false)
  for (const permission of ['default', 'denied', 'unsupported']) {
    assert.equal(shouldNotify({ wasComplete: false, progress: complete, wanted: true, permission }), false, permission)
  }
})
