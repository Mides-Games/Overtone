import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-versions-'));
const { app } = await import('../src/app.js');
const { analyses, newPublicId } = await import('../src/services/analysis.service.js');
const { prepareSpool } = await import('../src/services/spool.service.js');
const { MAX_PER_ANALYSIS, parseAdjustment } = await import('../src/services/version.service.js');

let server;
let base;
let alice;
let bob;
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  alice = await signIn('discord');
  bob = await signIn('google');
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const JSON_BODY = { ...SAME_ORIGIN, 'Content-Type': 'application/json' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

const signIn = async (provider) => {
  const start = await fetch(`${base}/auth/sso/start?provider=${provider}`);
  const { url } = await start.json();
  const code = new URL(url).hash.slice('#code='.length);
  const exchange = await fetch(`${base}/auth/sso/exchange`, {
    method: 'POST',
    headers: { ...JSON_BODY, Cookie: cookieOf(start).join('; ') },
    body: JSON.stringify({ code }),
  });
  return cookieOf(exchange).join('; ');
};

const accountOf = async (cookie) => (await (await fetch(`${base}/me`, { headers: { Cookie: cookie } })).json()).account;

/** One analysis of `audio` by `owner` (a session cookie, or `{ anon }` for an anonymous cookie's token), finished with `engine`. */
const analysed = async (owner, audio, { engine = 'aaa', status = 'done', cachedFrom = null } = {}) => {
  const accountId = typeof owner === 'string' ? (await accountOf(owner)).id : null;
  const anonHash = typeof owner === 'string' ? null : createHash('sha256').update(owner.anon).digest('hex');
  const id = newPublicId();
  const row = {
    publicId: id, sha1: createHash('sha1').update(audio).digest('hex'), filename: `${audio}.mp3`, sizeBytes: 1,
    accountId, anonHash, ipHash: 'ip', uploader: null,
  };
  if (cachedFrom) {
    await analyses().create({ ...row, cachedFrom: await analyses().get(cachedFrom) });
    return id;
  }
  await analyses().create(row);
  const job = await analyses().claim();
  assert.equal(job.publicId, id);
  if (status === 'failed') await analyses().fail(id, job.attempt, 'broken');
  else {
    await analyses().finish(id, job.attempt, {
      format: 'timing-result', version: 1, engine: 'v3', engine_hash: engine, refused: false, refusal: null, duration_s: 60,
      global_bpm: 120, offset_ms: 0, meter: '4/4', sections: [], osu_timing: '0,500,4,1,0,100,1,0',
      red_lines: [{ time_ms: 0, bpm: 120, beat_length_ms: 500, meter: 4, meter_known: true }],
    });
  }
  return id;
};

const versionsOf = async (id, cookie) => {
  const response = await fetch(`${base}/analyses/${id}/versions`, { headers: { Cookie: cookie } });
  return { status: response.status, body: await response.json() };
};
const save = async (id, cookie, body) => {
  const response = await fetch(`${base}/analyses/${id}/versions`, { method: 'POST', headers: { ...JSON_BODY, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

test('parseAdjustment takes what the page can apply and nothing that changes nothing', () => {
  assert.deepEqual(parseAdjustment({ factor: 2, nudgeMs: 0 }), { factor: 2, nudgeMs: 0 });
  assert.deepEqual(parseAdjustment({ factor: 1, nudgeMs: -12 }), { factor: 1, nudgeMs: -12 });
  assert.deepEqual(parseAdjustment({ factor: '0.5', nudgeMs: 3 }), { factor: 0.5, nudgeMs: 3 });
  for (const bad of [{ factor: 1, nudgeMs: 0 }, { factor: 3, nudgeMs: 0 }, { factor: 2, nudgeMs: 1.5 }, { factor: 2, nudgeMs: 501 }, { factor: 2 }, null]) {
    assert.equal(parseAdjustment(bad), null, JSON.stringify(bad));
  }
});

test('the readings of the same audio by the same owner are versions; another owner\'s, another song\'s and cache copies are not', async () => {
  const first = await analysed(alice, 'song-a', { engine: 'old' });
  const second = await analysed(alice, 'song-a', { engine: 'new' });
  await analysed(alice, 'song-b');
  await analysed(bob, 'song-a');
  const copy = await analysed(alice, 'song-a', { cachedFrom: second });

  const { status, body } = await versionsOf(second, alice);
  assert.equal(status, 200);
  assert.deepEqual(body.readings.map((r) => [r.id, r.engineHash, r.current]), [[second, 'new', true], [first, 'old', false]]);
  assert.deepEqual(body.adjustments, []);
  // Reading the copy itself lists it (it is the one open), and the re-analyses.
  const fromCopy = await versionsOf(copy, alice);
  assert.deepEqual(fromCopy.body.readings.map((r) => r.id).sort(), [copy, second, first].sort());
  // Bob, or nobody: the same 404 as an id that does not exist.
  assert.equal((await versionsOf(second, bob)).status, 404);
  assert.equal((await versionsOf(second, '')).status, 404);
  assert.equal((await versionsOf('f'.repeat(32), alice)).status, 404);
});

test('an anonymous owner\'s versions follow the anonymous cookie', async () => {
  const owner = { anon: 'anonymous-token-for-versions-0001' };
  const a = await analysed(owner, 'song-anon', { engine: 'one' });
  const b = await analysed(owner, 'song-anon', { engine: 'two' });
  await analysed({ anon: 'someone-else-entirely-000000000001' }, 'song-anon');
  const { body } = await versionsOf(b, `overtone_anon=${owner.anon}`);
  assert.deepEqual(body.readings.map((r) => r.id), [b, a]);
});

test('saving an adjustment stores it once, with a cleaned label, and lists it with its reading', async () => {
  const id = await analysed(alice, 'song-save');
  const made = await save(id, alice, { factor: 2, nudgeMs: -4, label: '  double‮ time  ' });
  assert.equal(made.status, 201);
  assert.deepEqual({ ...made.body, id: undefined, createdAt: undefined }, {
    id: undefined, analysisId: id, factor: 2, nudgeMs: -4, label: 'double time', createdAt: undefined,
  });
  // The same adjustment again is the same version.
  const again = await save(id, alice, { factor: 2, nudgeMs: -4 });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, made.body.id);

  const { body } = await versionsOf(id, alice);
  assert.deepEqual(body.adjustments.map((v) => [v.id, v.factor, v.nudgeMs]), [[made.body.id, 2, -4]]);
  // Only the adjustment: nothing of the result is in it.
  assert.ok(!('result' in body.adjustments[0]) && !('red_lines' in body.adjustments[0]));

  // Refusals: no header, someone else's, nothing to save, a label too long, a timing that failed.
  assert.equal((await fetch(`${base}/analyses/${id}/versions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: '{"factor":2,"nudgeMs":0}',
  })).status, 403);
  assert.equal((await save(id, bob, { factor: 2, nudgeMs: 0 })).status, 404);
  assert.equal((await save(id, alice, { factor: 1, nudgeMs: 0 })).body.error.code, 'BAD_ADJUSTMENT');
  assert.equal((await save(id, alice, { factor: 2, nudgeMs: 0, label: 'x'.repeat(61) })).body.error.code, 'TOO_LONG');
  const failed = await analysed(alice, 'song-failed', { status: 'failed' });
  assert.equal((await save(failed, alice, { factor: 2, nudgeMs: 0 })).body.error.code, 'NO_TIMING');

  // Deleted by its owner only; someone else gets the 404.
  assert.equal((await fetch(`${base}/analyses/${id}/versions/${made.body.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: bob } })).status, 404);
  assert.equal((await fetch(`${base}/analyses/${id}/versions/${made.body.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } })).status, 204);
  assert.deepEqual((await versionsOf(id, alice)).body.adjustments, []);
});

test('at most MAX_PER_ANALYSIS saved versions a reading, and they go when the analysis is deleted', async () => {
  const id = await analysed(alice, 'song-cap');
  let n = 0;
  for (let nudge = 1; n < MAX_PER_ANALYSIS; nudge++, n++) assert.equal((await save(id, alice, { factor: 1, nudgeMs: nudge })).status, 201);
  const over = await save(id, alice, { factor: 1, nudgeMs: 400 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'VERSION_LIMIT');

  // A sibling lists this reading's saved versions too.
  const sibling = await analysed(alice, 'song-cap', { engine: 'other' });
  assert.equal((await versionsOf(sibling, alice)).body.adjustments.length, MAX_PER_ANALYSIS);

  assert.equal((await fetch(`${base}/analyses/${id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } })).status, 204);
  const left = await versionsOf(sibling, alice);
  assert.deepEqual(left.body.readings.map((r) => r.id), [sibling]);
  assert.deepEqual(left.body.adjustments, []);
});
