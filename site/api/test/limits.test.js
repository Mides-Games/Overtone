import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.DATABASE_URL;
const { analyses, refusal } = await import('../src/services/analysis.service.js');

const limits = { scope: 'anonymous', quota: 5, maxPending: 2, queueMax: 4, cacheDaily: 3 };
const counts = { mine: 0, all: 0, today: 0, cachedToday: 0 };

test('a queued analysis is held to the quota, the pending cap and the queue cap, in that order', () => {
  assert.equal(refusal(counts, limits, false), null);
  assert.equal(refusal({ ...counts, today: 5 }, limits, false).code, 'QUOTA_EXCEEDED');
  assert.equal(refusal({ ...counts, mine: 2 }, limits, false).code, 'PENDING_LIMIT');
  assert.equal(refusal({ ...counts, all: 4 }, limits, false).code, 'QUEUE_FULL');
  assert.equal(refusal({ ...counts, all: 4 }, limits, false).status, 503);
});

test('a stored result is held only to its own daily cap', () => {
  assert.equal(refusal({ mine: 9, all: 9, today: 9, cachedToday: 2 }, limits, true), null);
  const error = refusal({ ...counts, cachedToday: 3 }, limits, true);
  assert.equal(error.code, 'CACHE_LIMIT');
  assert.equal(error.status, 429);
});

let n = 0;
const nextId = () => (++n + 1000).toString(16).padStart(32, '0');
const base = (who, extra = {}) => ({ publicId: nextId(), sha1: 'c'.repeat(40), filename: 'a.mp3', sizeBytes: 1, ipHash: `ip-${who}`, ...extra });

test('the memory store refuses at insert time, so parallel uploads cannot pass the last place', async () => {
  const store = analyses();
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => store.create(base('race'), { limits })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code), ['PENDING_LIMIT', 'PENDING_LIMIT']);
});

test('a progress report is a heartbeat: a long job is not taken for stuck', async () => {
  const store = analyses();
  // Drain what the previous test left queued.
  while (await store.claim()) {}
  const made = await store.create(base('slow', { sha1: 'd'.repeat(40) }));
  const job = await store.claim();
  assert.equal(job.publicId, made.publicId);
  const row = await store.get(made.publicId);
  row.job.lockedAt = new Date(Date.now() - 10_000);
  assert.equal(await store.progress(made.publicId, job.attempt, { stage: 'tempo', progress: 0.5 }), true);
  assert.deepEqual(await store.requeueStale(5), []);
  assert.equal((await store.get(made.publicId)).status, 'running');
});

test('the same person asking again for a stored result gets the same analysis', async () => {
  const store = analyses();
  const source = { publicId: 'f'.repeat(32), status: 'done', result: {}, engineHash: 'abcdef12' };
  const first = await store.create(base('copy', { sha1: 'e'.repeat(40), anonHash: 'anon-1', cachedFrom: source }), { limits });
  const found = await store.findCopy({ sha1: 'e'.repeat(40), anonHash: 'anon-1' });
  assert.equal(found.publicId, first.publicId);
  assert.equal(await store.findCopy({ sha1: 'e'.repeat(40), anonHash: 'anon-2' }), null);
});
