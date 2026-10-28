import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-stats-'));
const { app } = await import('../src/app.js');
const { analyses, newPublicId } = await import('../src/services/analysis.service.js');
const { clearStatsCache } = await import('../src/routes/stats.routes.js');
const { BPM_EDGES, MIN_TIMED, bucketOf, percentile, shapeStats } = await import('../src/utils/stats.js');

let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => server.close());
beforeEach(() => clearStatsCache());

const sha = (kind, text) => createHash(kind).update(text).digest('hex');

/** A result as the worker builds one: one red line per BPM. */
const resultWith = (bpms) => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: bpms[0], offset_ms: 100, meter: '4/4',
  red_lines: bpms.map((bpm, i) => ({ time_ms: 100 + i * 20_000, bpm, meter: 4 })),
  sections: bpms.map((bpm, i) => ({ index: i, start_ms: 100 + i * 20_000, end_ms: 20_100 + i * 20_000, bpm, confidence: 0.9, level: 'high' })),
  osu_timing: '',
});

/**
 * Everything a row could leak, with a name nobody would write by chance, so a
 * search of the response body for each of them proves none came out.
 */
const secrets = [];
let counter = 0;
const song = async ({ bpms = [128], outcome = 'done', tookMs = 0, publish = false, finishedAgoMs = 0 } = {}) => {
  counter += 1;
  const id = newPublicId();
  const row = {
    publicId: id,
    sha1: sha('sha1', `stats song ${counter}`),
    filename: `Secret Artist ${counter} - Hidden Title ${counter}.mp3`,
    sizeBytes: 1000,
    accountId: null,
    anonHash: sha('sha256', `anon cookie ${counter}`),
    ipHash: sha('sha256', `ip ${counter}`),
    tagTitle: `Hidden Title ${counter}`,
    tagArtist: `Secret Artist ${counter}`,
    uploader: { username: `secret_user_${counter}`, displayName: `Secret User ${counter}`, avatarUrl: null },
  };
  secrets.push(id, row.sha1, row.anonHash, row.ipHash, row.filename, row.tagTitle, row.tagArtist, row.uploader.username);
  const stored = await analyses().create(row);
  // The memory store hands back its own row: start it earlier to give the job a duration.
  stored.createdAt = new Date(Date.now() - tookMs);
  if (outcome === 'queued') return id;
  const job = await analyses().claim();
  assert.equal(job.publicId, id);
  if (outcome === 'running') return id;
  if (outcome === 'failed') assert.ok(await analyses().fail(id, job.attempt, 'boom'));
  else if (outcome === 'refused') {
    assert.ok(await analyses().finish(id, job.attempt, { ...resultWith([]), refused: true, global_bpm: null }));
  } else {
    assert.ok(await analyses().finish(id, job.attempt, resultWith(bpms)));
    // Backdated, for the windows: the row's own finish time, as the memory store keeps it.
    if (finishedAgoMs) stored.finishedAt = new Date(Date.now() - finishedAgoMs);
    if (publish) assert.ok(await analyses().publish(id));
  }
  return id;
};

const stats = async () => {
  const response = await fetch(`${base}/stats`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /^public, max-age=\d+$/);
  return { body: await response.json() };
};

test('the histogram buckets a BPM on an edge as width_bucket does, and the percentile is percentile_cont', () => {
  assert.equal(bucketOf(79.99), 0);
  assert.equal(bucketOf(80), 1);
  assert.equal(bucketOf(119.99), 2);
  assert.equal(bucketOf(120), 3);
  assert.equal(bucketOf(260), BPM_EDGES.length);
  assert.equal(bucketOf(999), BPM_EDGES.length);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4], 0.9), 4);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  // (n - 1) * 0.9 = 8.1: between the 9th and 10th values.
  assert.ok(Math.abs(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 0.9) - 9.1) < 1e-9);
});

test('shapeStats keeps only its own fields and withholds the times below the minimum', () => {
  const out = shapeStats({
    counts: { done: 3, refused: 1, failed: 0, cached: 2, published: 1, songs: 3, sha1: 'x' },
    buckets: [0, 1, 2],
    tempo: { single: 2, variable: 1 },
    times: { count: MIN_TIMED - 1, medianMs: 1234, p90Ms: 5678 },
    queue: { queued: 1, running: 0 },
    rows: [{ publicId: 'leak' }],
  });
  assert.deepEqual(Object.keys(out).sort(), ['analysisTime', 'bpm', 'generatedAt', 'profileVisits', 'queue', 'tempo', 'timed', 'totals']);
  assert.deepEqual(out.timed, { total: 3, last7Days: 0, last30Days: 0 });
  assert.deepEqual(out.profileVisits, { total: 0 });
  assert.equal(out.totals.sha1, undefined);
  assert.equal(out.bpm.buckets.length, BPM_EDGES.length + 1);
  assert.deepEqual(out.bpm.buckets[0], { from: null, to: 80, count: 0 });
  assert.deepEqual(out.bpm.buckets.at(-1), { from: 260, to: null, count: 0 });
  assert.equal(out.analysisTime.medianS, null);
  assert.equal(out.analysisTime.p90S, null);
  const enough = shapeStats({ times: { count: MIN_TIMED, medianMs: 1234, p90Ms: 5678 } });
  assert.equal(enough.analysisTime.medianS, 1.2);
  assert.equal(enough.analysisTime.p90S, 5.7);
});

test('GET /stats counts the outcomes, the histogram, the tempo share, the times and the queue', async () => {
  const empty = (await stats()).body;
  assert.equal(empty.totals.done, 0);
  assert.equal(empty.analysisTime.medianS, null);

  await song({ bpms: [128], tookMs: 10_000, publish: true });
  await song({ bpms: [128, 142], tookMs: 20_000 });
  await song({ bpms: [175], tookMs: 30_000 });
  await song({ bpms: [90], tookMs: 40_000 });
  await song({ bpms: [260], tookMs: 50_000 });
  await song({ outcome: 'refused' });
  await song({ outcome: 'failed' });
  await song({ outcome: 'running' });
  const waiting = await song({ outcome: 'queued' });

  clearStatsCache();
  const { body } = await stats();
  assert.deepEqual(body.totals, { done: 5, refused: 1, failed: 1, cached: 0, published: 1, songs: 5 });
  const counts = Object.fromEntries(body.bpm.buckets.filter((b) => b.count).map((b) => [b.from, b.count]));
  assert.deepEqual(counts, { 80: 1, 120: 2, 160: 1, 260: 1 });
  assert.deepEqual(body.tempo, { single: 4, variable: 1 });
  assert.equal(body.analysisTime.count, 5);
  assert.equal(body.analysisTime.medianS, 30);
  assert.equal(body.analysisTime.p90S, 46);
  assert.deepEqual(body.queue, { queued: 1, running: 1 });
  // Out of the way of the next tests' claims.
  assert.ok(await analyses().cancel(waiting));
});

test('a cache hit and a deleted analysis are not counted as engine runs', async () => {
  const before = (await stats()).body.totals;
  const original = await analyses().get(await song({ bpms: [150] }));
  counter += 1;
  await analyses().create({
    publicId: newPublicId(), sha1: original.sha1, filename: 'copy.mp3', sizeBytes: 1, accountId: null,
    anonHash: sha('sha256', `copy ${counter}`), ipHash: sha('sha256', `copy ip ${counter}`), cachedFrom: original,
  });
  const gone = await song({ bpms: [150] });
  assert.ok(await analyses().deleteOwn(gone));
  clearStatsCache();
  const now = (await stats()).body.totals;
  assert.equal(now.done, before.done + 1);
  assert.equal(now.cached, before.cached + 1);
});

test('songs timed: ever, the last 7 and the last 30 days by when they finished; not a refusal, a failure, a cache hit or a deleted one', async () => {
  clearStatsCache();
  const before = (await stats()).body.timed;
  assert.equal(before.total, (await stats()).body.totals.done);
  const DAY = 86_400_000;
  await song({ bpms: [140] }); // now
  await song({ bpms: [140], finishedAgoMs: 6 * DAY }); // inside both windows
  await song({ bpms: [140], finishedAgoMs: 8 * DAY }); // the last 30 days only
  await song({ bpms: [140], finishedAgoMs: 29 * DAY });
  await song({ bpms: [140], finishedAgoMs: 31 * DAY }); // ever only
  await song({ bpms: [140], finishedAgoMs: 400 * DAY });
  await song({ outcome: 'refused' });
  await song({ outcome: 'failed' });
  const gone = await song({ bpms: [140] });
  assert.ok(await analyses().deleteOwn(gone));
  const original = await analyses().get(await song({ bpms: [140] }));
  counter += 1;
  await analyses().create({
    publicId: newPublicId(), sha1: original.sha1, filename: 'again.mp3', sizeBytes: 1, accountId: null,
    anonHash: sha('sha256', `again ${counter}`), ipHash: sha('sha256', `again ip ${counter}`), cachedFrom: original,
  });
  clearStatsCache();
  const { body } = await stats();
  assert.deepEqual(body.timed, {
    total: before.total + 7,
    last7Days: before.last7Days + 3,
    last30Days: before.last30Days + 5,
  });
  assert.equal(body.timed.total, body.totals.done);
});

test('the answer is the same for a minute: a new analysis waits for the cache to expire', async () => {
  const first = (await stats()).body;
  await song({ bpms: [200] });
  const second = (await stats()).body;
  assert.deepEqual(second, first);
  clearStatsCache();
  assert.equal((await stats()).body.totals.done, first.totals.done + 1);
});

test('nothing that belongs to a person is in the answer: no id, hash, file name, title or username', async () => {
  await song({ bpms: [133], publish: true });
  const response = await fetch(`${base}/stats`);
  const text = await response.text();
  assert.ok(secrets.length > 20);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked ${secret}`);
  // And no field a row would bring: every key of the body is one shapeStats writes.
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
  };
  walk(JSON.parse(text));
  const allowed = new Set([
    'generatedAt', 'totals', 'done', 'refused', 'failed', 'cached', 'published', 'songs', 'bpm', 'edges', 'buckets',
    'from', 'to', 'count', 'tempo', 'single', 'variable', 'analysisTime', 'days', 'minCount', 'medianS', 'p90S',
    'queue', 'queued', 'running', 'timed', 'total', 'last7Days', 'last30Days', 'profileVisits',
  ]);
  for (const key of keys) assert.ok(allowed.has(key), `unexpected field ${key}`);
});

test('GET /stats is rate limited per address', async () => {
  let last;
  for (let i = 0; i < 61; i += 1) last = await fetch(`${base}/stats`);
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});
