import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEEN_WINDOW_S, workerSeen, workerStatus } from '../src/utils/worker-status.js';

test('a worker that never called is unknown, not down', () => {
  assert.deepEqual(workerStatus(1_000_000, null), { status: 'unknown', seenSecondsAgo: null });
});

test('a worker is up within the window and down after it', () => {
  const now = 10_000_000;
  assert.deepEqual(workerStatus(now, now - 2_000), { status: 'ok', seenSecondsAgo: 2 });
  assert.equal(workerStatus(now, now - SEEN_WINDOW_S * 1000).status, 'ok');
  assert.deepEqual(workerStatus(now, now - (SEEN_WINDOW_S + 1) * 1000), { status: 'down', seenSecondsAgo: SEEN_WINDOW_S + 1 });
});

test('a call marks the worker seen', () => {
  workerSeen(5_000);
  assert.deepEqual(workerStatus(6_000), { status: 'ok', seenSecondsAgo: 1 });
});
