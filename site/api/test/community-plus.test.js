import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
const WORKER_TOKEN = 'k'.repeat(40);
Object.assign(process.env, {
  NODE_ENV: 'development',
  MIDES_DEV_LOGIN: '1',
  SPOOL_DIR: mkdtempSync(join(tmpdir(), 'overtone-plus-')),
  WORKER_TOKEN,
  // W13.20 over HTTP: one anonymous song a day, one of an account's at a time.
  ANON_DAILY_LIMIT: '1',
  USER_MAX_PENDING: '1',
});
const { app } = await import('../src/app.js');
const { analyses, dailyReset, failureCode, limitRefusal, newPublicId, REMOVED } = await import('../src/services/analysis.service.js');
const { memoryAccounts, upsertFromMides } = await import('../src/services/account.service.js');
const { COOKIE, issue } = await import('../src/services/session.service.js');
const { voteOf } = await import('../src/utils/votes.js');
const { reportMemory, resetWorkerMemory, workerMemory } = await import('../src/utils/worker-status.js');

/**
 * W13.14 votes, W13.16 the mapper's badge, W13.17 the bell, W13.19 the staff
 * panel and W13.20 the limit notices, over HTTP on the memory store: who may
 * do what, one vote per account, what stays private, the 404s, and the rate
 * limit on votes.
 */

let server;
let base;
let alice; // the Discord dev user: a member, uploads the timings
let bob; // the Google dev user: staff
const people = {}; // more members, made directly
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  alice = await signIn('discord');
  bob = await signIn('google');
  for (const name of ['carol', 'dave', 'mapper', 'mapper2']) {
    const row = await upsertFromMides({
      midesUserId: `plus-${name}`, username: name, displayName: name.toUpperCase(), avatarUrl: null, bannerUrl: null, discordId: null, role: null,
    });
    people[name] = { cookie: `${COOKIE}=${issue(row.id, row.session_version)}`, id: row.id };
  }
  // W9.2's fields as an osu! link would have left them: the seeded mappers.
  Object.assign(memoryAccounts().get(people.mapper.id), { osu_user_id: 7, osu_username: 'MapperOnOsu', osu_ranked_count: 4 });
  Object.assign(memoryAccounts().get(people.mapper2.id), { osu_user_id: 8, osu_username: 'Other', osu_ranked_count: 1, profile_private: true });
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

const signIn = async (provider) => {
  const start = await fetch(`${base}/auth/sso/start?provider=${provider}`);
  const { url } = await start.json();
  const code = new URL(url).hash.slice('#code='.length);
  const exchange = await fetch(`${base}/auth/sso/exchange`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: cookieOf(start).join('; ') },
    body: JSON.stringify({ code }),
  });
  assert.equal(exchange.status, 200);
  return cookieOf(exchange).join('; ');
};

const seen = [];
const call = async (method, path, { cookie = '', body, sameOrigin = true, headers = {} } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(sameOrigin ? SAME_ORIGIN : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = response.status === 204 ? '' : await response.text();
  seen.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

const accountOf = async (cookie) => (await call('GET', '/me', { cookie })).body.account;

const result = (bpm = 128) => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: bpm, offset_ms: 100, meter: '4/4',
  red_lines: [{ time_ms: 100, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true }],
  sections: [{ index: 0, start_ms: 100, end_ms: 60_000, bpm, confidence: 0.9, level: 'high' }],
  osu_timing: `100,${60_000 / bpm},4,1,0,100,1,0`,
});

const secrets = [];
let counter = 0;
/** A finished (and by default published) analysis of `cookie`'s account, straight through the stores. */
const timing = async ({ cookie = alice, publish = true } = {}) => {
  const id = newPublicId();
  counter += 1;
  const sha1 = createHash('sha1').update(`plus ${counter} ${Math.random()}`).digest('hex');
  const ipHash = createHash('sha256').update(`ip plus ${counter}`).digest('hex');
  secrets.push(sha1, ipHash);
  const account = await accountOf(cookie);
  await analyses().create({
    publicId: id, sha1, filename: `Song ${counter}.mp3`, sizeBytes: 1, accountId: account.id, anonHash: null, ipHash,
    uploader: { username: account.username, displayName: account.displayName, avatarUrl: null },
    private: false, tagTitle: `Song ${counter}`, tagArtist: 'Artist',
  });
  const job = await analyses().claim();
  assert.ok(await analyses().finish(id, job.attempt, result()));
  if (publish) assert.ok(await analyses().publish(id));
  return id;
};

const unread = async (cookie) => (await call('GET', '/me/notifications/unread', { cookie })).body.unread;
const inbox = async (cookie) => (await call('GET', '/me/notifications', { cookie })).body;

// ── W13.14: the vote's rules ────────────────────────────────────────────────

test('a vote is "on" bare, or "off" with an optional checked BPM and offset', () => {
  assert.deepEqual(voteOf({ verdict: 'on' }, 60), { verdict: 'on', proposedBpm: null, proposedOffsetMs: null, trainingOk: false });
  assert.deepEqual(voteOf({ verdict: 'off', proposedBpm: 127.99991, proposedOffsetMs: 95, trainingOk: true }, 60), {
    verdict: 'off', proposedBpm: 128, proposedOffsetMs: 95, trainingOk: true,
  });
  assert.deepEqual(voteOf({ verdict: 'off' }, 60), { verdict: 'off', proposedBpm: null, proposedOffsetMs: null, trainingOk: false });
  for (const bad of [
    {},
    { verdict: 'maybe' },
    { verdict: 'on', proposedBpm: 120 },
    { verdict: 'on', trainingOk: true },
    { verdict: 'off', trainingOk: true },
    { verdict: 'off', proposedBpm: 19.9 },
    { verdict: 'off', proposedBpm: 1001 },
    { verdict: 'off', proposedBpm: '120' },
    { verdict: 'off', proposedBpm: Number.NaN },
    { verdict: 'off', proposedOffsetMs: 1.5 },
    { verdict: 'off', proposedOffsetMs: -10_001 },
    { verdict: 'off', proposedOffsetMs: 60_001 },
    { verdict: 'off', proposedBpm: 120, trainingOk: 'yes' },
  ]) {
    assert.throws(() => voteOf(bad, 60), (e) => e.code === 'BAD_VOTE', JSON.stringify(bad));
  }
});

test('voting needs an account, the same-origin header and a published timing that is not yours', async () => {
  const id = await timing();
  const hidden = await timing({ publish: false });
  assert.equal((await call('PUT', `/timings/${id}/vote`, { body: { verdict: 'on' } })).status, 401);
  assert.equal((await call('PUT', `/timings/${id}/vote`, { cookie: bob, body: { verdict: 'on' }, sameOrigin: false })).status, 403);
  const own = await call('PUT', `/timings/${id}/vote`, { cookie: alice, body: { verdict: 'on' } });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'OWN_TIMING');
  assert.equal((await call('PUT', `/timings/${hidden}/vote`, { cookie: bob, body: { verdict: 'on' } })).status, 404);
  assert.equal((await call('GET', `/timings/${hidden}/votes`)).status, 404);
  assert.equal((await call('GET', '/timings/nothex/votes')).status, 404);
  assert.equal((await call('PUT', `/timings/${id}/vote`, { cookie: bob, body: { verdict: 'off', proposedBpm: 5 } })).status, 400);
  // A take-back of a vote never cast is fine; the count stays at nothing.
  const none = await call('DELETE', `/timings/${id}/vote`, { cookie: bob });
  assert.equal(none.status, 200);
  assert.deepEqual([none.body.on, none.body.off, none.body.mine], [0, 0, null]);
});

test('one vote per account: a second is an edit, and the counts say so without naming anyone', async () => {
  const id = await timing();
  await call('PUT', `/timings/${id}/vote`, { cookie: bob, body: { verdict: 'on' } });
  await call('PUT', `/timings/${id}/vote`, { cookie: bob, body: { verdict: 'on' } });
  let s = (await call('GET', `/timings/${id}/votes`, { cookie: bob })).body;
  assert.deepEqual([s.on, s.off, s.mine.verdict], [1, 0, 'on']);
  const edit = await call('PUT', `/timings/${id}/vote`, { cookie: bob, body: { verdict: 'off', proposedBpm: 130 } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.queued, true);
  await call('PUT', `/timings/${id}/vote`, { cookie: people.carol.cookie, body: { verdict: 'on' } });
  s = (await call('GET', `/timings/${id}/votes`)).body;
  assert.deepEqual([s.on, s.off, s.mine, s.verified], [1, 1, null, false]);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('dev_google') && !text.includes('carol'), 'a plain vote names nobody');
  // The voter reads their own correction back, and takes the vote back.
  const mine = (await call('GET', `/timings/${id}/votes`, { cookie: bob })).body.mine;
  assert.deepEqual(mine, { verdict: 'off', proposedBpm: 130, proposedOffsetMs: null, trainingOk: false, reviewState: 'pending' });
  const gone = await call('DELETE', `/timings/${id}/vote`, { cookie: bob });
  assert.deepEqual([gone.body.on, gone.body.off, gone.body.mine], [1, 0, null]);
});

// ── W13.16: the mapper's badge ──────────────────────────────────────────────

test('a mapper\'s "on time" verifies a timing and names them; anyone else\'s does not', async () => {
  const id = await timing();
  await call('PUT', `/timings/${id}/vote`, { cookie: people.carol.cookie, body: { verdict: 'on' } });
  await call('PUT', `/timings/${id}/vote`, { cookie: people.mapper2.cookie, body: { verdict: 'off', proposedOffsetMs: 90 } });
  let s = (await call('GET', `/timings/${id}/votes`)).body;
  assert.equal(s.verified, false, 'a member, and a mapper who said off, verify nothing');

  await call('PUT', `/timings/${id}/vote`, { cookie: people.mapper.cookie, body: { verdict: 'on' } });
  await call('PUT', `/timings/${id}/vote`, { cookie: people.mapper2.cookie, body: { verdict: 'on' } });
  s = (await call('GET', `/timings/${id}/votes`)).body;
  assert.equal(s.verified, true);
  assert.equal(s.verifierCount, 2);
  assert.deepEqual(s.verifiers.map((m) => [m.username, m.osuUsername, m.rankedCount, m.profile]), [
    // Oldest vote first: mapper2 voted (off) before mapper, and changed it later.
    ['mapper2', 'Other', 1, false],
    ['mapper', 'MapperOnOsu', 4, true],
  ]);
  // The recent list carries the badge too.
  const list = (await call('GET', '/timings')).body.timings;
  assert.equal(list.find((t) => t.id === id).verified, true);

  // Taking the confirmation back takes the badge.
  await call('DELETE', `/timings/${id}/vote`, { cookie: people.mapper.cookie });
  await call('DELETE', `/timings/${id}/vote`, { cookie: people.mapper2.cookie });
  assert.equal((await call('GET', `/timings/${id}/votes`)).body.verified, false);
});

// ── W13.14 and W13.19: the corrections queue ────────────────────────────────

test('a correction waits for staff, who accept or dismiss it; an edit to it waits again', async () => {
  const id = await timing();
  await call('PUT', `/timings/${id}/vote`, {
    cookie: people.dave.cookie, body: { verdict: 'off', proposedBpm: 64, proposedOffsetMs: 120, trainingOk: true },
  });
  for (const cookie of ['', alice, people.dave.cookie]) {
    assert.equal((await call('GET', '/staff/corrections', { cookie })).status, 404, 'the panel is not there for non-staff');
  }
  let queue = (await call('GET', '/staff/corrections', { cookie: bob })).body;
  const item = queue.items.find((c) => c.timing.id === id);
  assert.ok(item);
  assert.deepEqual(
    [item.voter.username, item.proposedBpm, item.proposedOffsetMs, item.trainingOk, item.state, item.timing.bpm, item.timing.offsetMs],
    ['dave', 64, 120, true, 'pending', 128, 100],
  );

  assert.equal((await call('POST', `/staff/corrections/${item.id}`, { cookie: alice, body: { action: 'accept' } })).status, 404);
  assert.equal((await call('POST', `/staff/corrections/${item.id}`, { cookie: bob, body: { action: 'accept' }, sameOrigin: false })).status, 403);
  assert.equal((await call('POST', `/staff/corrections/${item.id}`, { cookie: bob, body: { action: 'merge' } })).status, 400);
  assert.equal((await call('POST', `/staff/corrections/${newPublicId()}`, { cookie: bob, body: { action: 'accept' } })).status, 404);
  const done = await call('POST', `/staff/corrections/${item.id}`, { cookie: bob, body: { action: 'accept', reason: 'Checked by ear' } });
  assert.deepEqual(done.body, { from: 'pending', to: 'accepted' });
  assert.equal((await call('POST', `/staff/corrections/${item.id}`, { cookie: bob, body: { action: 'accept' } })).status, 409);

  // Saving the same correction keeps the decision; a different one goes back to the queue.
  await call('PUT', `/timings/${id}/vote`, { cookie: people.dave.cookie, body: { verdict: 'off', proposedBpm: 64, proposedOffsetMs: 120 } });
  assert.equal((await call('GET', `/timings/${id}/votes`, { cookie: people.dave.cookie })).body.mine.reviewState, 'accepted');
  await call('PUT', `/timings/${id}/vote`, { cookie: people.dave.cookie, body: { verdict: 'off', proposedBpm: 65 } });
  assert.equal((await call('GET', `/timings/${id}/votes`, { cookie: people.dave.cookie })).body.mine.reviewState, 'pending');
  queue = (await call('GET', '/staff/corrections?state=accepted', { cookie: bob })).body;
  assert.equal(queue.items.some((c) => c.timing.id === id), false);

  // The decision is in the panel's log.
  const overview = (await call('GET', '/staff/overview', { cookie: bob })).body;
  assert.ok(overview.log.some((e) => e.kind === 'vote' && e.action === 'accept' && e.ref === item.id && e.reason === 'Checked by ear'));
  assert.ok(overview.awaiting.corrections >= 1);
});

// ── W13.17: the bell ────────────────────────────────────────────────────────

test('the uploader hears of comments, a first use and votes; never of their own doing', async () => {
  const id = await timing();
  const before = await unread(alice);
  await call('POST', `/timings/${id}/comments`, { cookie: alice, body: { body: 'my own note' } });
  assert.equal(await unread(alice), before, 'your own comment is not news');

  await call('POST', `/timings/${id}/comments`, { cookie: people.carol.cookie, body: { body: 'lovely', atMs: 2000 } });
  await call('PUT', `/timings/${id}/use`, { cookie: people.carol.cookie, body: {} });
  await call('PUT', `/timings/${id}/use`, { cookie: people.carol.cookie, body: { beatmapUrl: 'https://osu.ppy.sh/beatmapsets/1' } });
  await call('PUT', `/timings/${id}/vote`, { cookie: people.carol.cookie, body: { verdict: 'off', proposedBpm: 129 } });
  await call('PUT', `/timings/${id}/vote`, { cookie: people.carol.cookie, body: { verdict: 'off', proposedBpm: 130 } });
  await call('PUT', `/timings/${id}/vote`, { cookie: people.mapper.cookie, body: { verdict: 'on' } });
  assert.equal(await unread(alice), before + 4, 'a comment, one use, one (edited) vote, a mapper\'s vote');

  const items = (await inbox(alice)).items.filter((n) => n.payload.timing === id);
  const comment = items.find((n) => n.kind === 'comment');
  assert.deepEqual([comment.payload.user, comment.payload.atMs, comment.payload.title], ['carol', 2000, `Song ${counter}`]);
  assert.ok(!('body' in comment.payload), 'what the comment says stays on the page');
  const voteNotes = items.filter((n) => n.kind === 'vote');
  assert.equal(voteNotes.length, 2);
  const plain = voteNotes.find((n) => n.payload.verdict === 'off');
  assert.equal(plain.payload.proposedBpm, 130);
  assert.ok(!JSON.stringify(plain).includes('carol'), 'a plain vote does not name its voter');
  assert.equal(voteNotes.find((n) => n.payload.verdict === 'on').payload.mapper, 'mapper');
  assert.equal(items.filter((n) => n.kind === 'use').length, 1);
});

test('a suggestion\'s author hears of its state; read marks are the account\'s own', async () => {
  const created = await call('POST', '/community/suggestions', { cookie: people.dave.cookie, body: { title: 'Dark mode please', body: 'More dark.' } });
  const sid = created.body.suggestion.id;
  await call('POST', `/community/suggestions/${sid}/state`, { cookie: bob, body: { state: 'planned', reason: 'Soon' } });
  const box = await inbox(people.dave.cookie);
  const note = box.items.find((n) => n.kind === 'suggestion' && n.payload.suggestion === sid);
  assert.deepEqual([note.payload.from, note.payload.to, note.payload.reason, note.read], ['open', 'planned', 'Soon', false]);

  // Someone else's id marks nothing.
  const other = await call('POST', '/me/notifications/read', { cookie: people.carol.cookie, body: { ids: [note.id] } });
  assert.equal(other.body.marked, 0);
  assert.equal((await call('POST', '/me/notifications/read', { cookie: people.dave.cookie, body: { ids: ['nope'] } })).status, 400);
  assert.equal((await call('POST', '/me/notifications/read', { cookie: people.dave.cookie, body: {} })).status, 400);
  assert.equal((await call('POST', '/me/notifications/read', { cookie: people.dave.cookie, body: { ids: [note.id] }, sameOrigin: false })).status, 403);
  const mine = await call('POST', '/me/notifications/read', { cookie: people.dave.cookie, body: { ids: [note.id] } });
  assert.equal(mine.body.marked, 1);
  assert.equal((await inbox(people.dave.cookie)).items.find((n) => n.id === note.id).read, true);
  await call('POST', '/me/notifications/read', { cookie: alice, body: { all: true } });
  assert.equal(await unread(alice), 0);
  assert.equal((await call('GET', '/me/notifications/unread')).status, 401);
  assert.equal((await call('GET', '/me/notifications')).status, 401);
});

test('an ended analysis rings the bell until its owner reads it', async () => {
  const account = await accountOf(people.carol.cookie);
  const id = newPublicId();
  await analyses().create({
    publicId: id, sha1: 'a'.repeat(40), filename: 'mine.mp3', sizeBytes: 1, accountId: account.id, anonHash: null, ipHash: 'b'.repeat(64),
    uploader: null, tagTitle: 'Mine',
  });
  const claimed = await fetch(`${base.replace('/v1', '')}/internal/jobs/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_hash: '0123456789abcdef', memory: { rss_mb: 812, peak_mb: 1500, limit_mb: 1800 } }),
  });
  const job = await claimed.json();
  assert.equal(job.id, id);
  await fetch(`${base.replace('/v1', '')}/internal/jobs/${id}/result`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ attempt: job.attempt, result: result() }),
  });
  const note = (await inbox(people.carol.cookie)).items.find((n) => n.kind === 'analysis' && n.payload.analysis === id);
  assert.deepEqual([note.payload.name, note.payload.status, note.read], ['Mine', 'done', false]);
  assert.equal((await call('GET', `/analyses/${id}`, { cookie: people.carol.cookie })).status, 200);
  assert.equal((await inbox(people.carol.cookie)).items.find((n) => n.id === note.id).read, true);

  // The worker's memory report reached the staff panel.
  const overview = (await call('GET', '/staff/overview', { cookie: bob })).body;
  assert.deepEqual([overview.worker.memory.rssMb, overview.worker.memory.peakMb, overview.worker.memory.limitMb], [812, 1500, 1800]);
  assert.equal(overview.worker.status, 'ok');
});

// ── W13.19: the staff panel ─────────────────────────────────────────────────

test('the staff panel: 404 for everyone but staff, and the failures with their codes', async () => {
  for (const cookie of ['', alice, people.mapper.cookie]) {
    const r = await call('GET', '/staff/overview', { cookie });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
  }
  const failed = [];
  for (const error of ['too_heavy: The analysis used 2000 MB', 'timeout: The analysis ran past its 600 s limit', 'Could not decode.']) {
    const id = newPublicId();
    await analyses().create({ publicId: id, sha1: createHash('sha1').update(error).digest('hex'), filename: 'x.mp3', sizeBytes: 1, accountId: null, anonHash: 'c'.repeat(64), ipHash: 'd'.repeat(64) });
    const job = await analyses().claim();
    assert.ok(await analyses().fail(id, job.attempt, error));
    failed.push(id);
  }
  const queued = newPublicId();
  await analyses().create({ publicId: queued, sha1: 'e'.repeat(40), filename: 'secret name.mp3', sizeBytes: 1, accountId: null, anonHash: 'f'.repeat(64), ipHash: '0'.repeat(64), private: true });

  const r = await call('GET', '/staff/overview', { cookie: bob });
  assert.equal(r.status, 200);
  const codes = Object.fromEntries(r.body.failures.filter((f) => failed.includes(f.ref)).map((f) => [f.ref, f.code]));
  assert.deepEqual(failed.map((id) => codes[id]), ['too_heavy', 'timeout', 'failed']);
  assert.ok(r.body.queue.waiting >= 1);
  const row = r.body.queue.live.find((x) => x.ref === queued);
  assert.equal(row.song, null, 'a private upload stays nameless, staff or not');
  assert.ok(!JSON.stringify(r.body).includes('secret name'));
  assert.equal(typeof r.body.awaiting.suggestions, 'number');
  assert.equal(typeof r.body.awaiting.reports, 'number');
  await analyses().cancel(queued);
});

test('a failure\'s code comes from the worker\'s prefix or a fixed text', () => {
  assert.equal(failureCode('too_heavy: x'), 'too_heavy');
  assert.equal(failureCode('timeout: y'), 'timeout');
  assert.equal(failureCode(REMOVED), 'removed');
  assert.equal(failureCode('The analysis took too long and was stopped.'), 'stale');
  assert.equal(failureCode('Something: else'), 'failed');
  assert.equal(failureCode(null), 'failed');
});

test('a memory report keeps whole MB only, and nothing malformed', () => {
  resetWorkerMemory();
  reportMemory('lots');
  reportMemory({ rss_mb: -1, peak_mb: 'x' });
  assert.equal(workerMemory(), null);
  reportMemory({ rss_mb: 100.5, peak_mb: 300, limit_mb: null, extra: '<script>' }, 1000);
  assert.deepEqual(workerMemory(4000), { rssMb: null, peakMb: 300, limitMb: null, secondsAgo: 3 });
});

// ── W13.20: limits that say when they free up ──────────────────────────────

test('a daily refusal names the next 00:00 UTC and how long until it', () => {
  const now = Date.UTC(2026, 9, 27, 22, 30, 0);
  assert.deepEqual(dailyReset(now), { resetAt: '2026-10-28T00:00:00.000Z', retryAfterS: 5400 });
  const quota = limitRefusal('QUOTA_EXCEEDED', { limit: 5, scope: 'anonymous' }, now);
  assert.deepEqual(quota.details, { limit: 5, scope: 'anonymous', frees: 'reset', resetAt: '2026-10-28T00:00:00.000Z', retryAfterS: 5400 });
  assert.equal(quota.headers['Retry-After'], '5400');
  assert.equal(limitRefusal('CACHE_LIMIT', { limit: 100, scope: 'account' }, now).details.frees, 'reset');
  const pending = limitRefusal('PENDING_LIMIT', { limit: 3, scope: 'account', pending: 3 }, now);
  assert.deepEqual(pending.details, { limit: 3, scope: 'account', pending: 3, frees: 'finish' });
  assert.equal(pending.headers, undefined);
});

// ── Privacy and the rate limit ──────────────────────────────────────────────

test('no response here carried an upload\'s hash or an address hash', () => {
  const all = seen.join('\n');
  for (const secret of secrets) assert.ok(!all.includes(secret), 'a hash leaked');
  assert.ok(!/ipHash|anonHash|ip_hash|anon_hash/.test(all));
});

test('votes are rate limited per address', async () => {
  const id = await timing();
  let refused = null;
  for (let i = 0; i < 40 && !refused; i += 1) {
    const r = await call('PUT', `/timings/${id}/vote`, { cookie: people.carol.cookie, body: { verdict: i % 2 ? 'on' : 'off' } });
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, 'the 31st vote in ten minutes is refused');
  assert.equal(refused.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
});

const upload = (cookie = '') =>
  fetch(`${base}/analyses`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'a.wav', ...(cookie ? { Cookie: cookie } : {}) },
    body: Buffer.alloc(2000, 7),
  }).then(async (r) => ({ status: r.status, body: await r.json(), retryAfter: r.headers.get('retry-after') }));

test('over HTTP: the quota says when it resets, the pending cap says it frees when a song finishes', async () => {
  assert.equal((await upload()).status, 202);
  const quota = await upload();
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal(quota.body.error.details.frees, 'reset');
  assert.ok(Date.parse(quota.body.error.details.resetAt) > Date.now());
  assert.equal(quota.retryAfter, String(quota.body.error.details.retryAfterS));

  assert.equal((await upload(people.mapper.cookie)).status, 202);
  const pending = await upload(people.mapper.cookie);
  assert.equal(pending.status, 429);
  assert.equal(pending.body.error.code, 'PENDING_LIMIT');
  assert.deepEqual([pending.body.error.details.frees, pending.body.error.details.pending, pending.body.error.details.limit], ['finish', 1, 1]);
});
