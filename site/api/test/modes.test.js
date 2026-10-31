import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  audioSecondsOf, optionsFromHeader, optionsKey, parseMode, parseOptions,
} from '../src/utils/analysis-options.js';
import { estimateQueue, jobCost } from '../src/utils/estimate.js';
import { queueEntry } from '../src/utils/queue.js';

// ── The options, pure (W11.1, W3.21, W12.19) ────────────────────────────────

test('the mode defaults to normal and is one of three', () => {
  assert.equal(parseMode(undefined), 'normal');
  assert.equal(parseMode(''), 'normal');
  for (const mode of ['fast', 'normal', 'strict']) assert.equal(parseMode(mode), mode);
  for (const bad of ['FAST', 'slow', 3, {}]) assert.equal(catchCode(() => parseMode(bad)), 'BAD_MODE');
});

test('no hints is the empty key; the same hints in any order are the same key', () => {
  assert.deepEqual(parseOptions(null), { options: {}, key: '' });
  assert.deepEqual(parseOptions(undefined), { options: {}, key: '' });
  const a = parseOptions({ meter: 3, tempo: 'constant', bpm: 174.0004 });
  const b = parseOptions({ bpm: 174, tempo: 'constant', meter: 3 });
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'bpm=174;meter=3;tempo=constant');
  assert.equal(optionsKey({ start_s: 10, end_s: 40.5 }), 'end_s=40.5;start_s=10');
});

test('every hint is checked, and a bad one is a 400 that names it', () => {
  const bad = [
    'not an object', [1], { tempo: 'sometimes' }, { bpm: 20 }, { bpm: 401 }, { bpm: '120' }, { bpm: Number.NaN },
    { bpm: 120, bpm_min: 100, bpm_max: 140 }, { bpm_min: 140, bpm_max: 100 }, { bpm_min: 100 },
    { meter: 0 }, { meter: 17 }, { meter: 3.5 }, { start_s: 10 }, { start_s: 10, end_s: 15 },
    { start_s: -1, end_s: 30 }, { start_s: 0, end_s: 4000 }, { extra: 1 },
  ];
  for (const raw of bad) assert.equal(catchCode(() => parseOptions(raw, { maxSeconds: 600 })), 'BAD_OPTIONS', JSON.stringify(raw));
  assert.deepEqual(parseOptions({ start_s: 12.3456, end_s: 72 }, { maxSeconds: 600 }).options, { start_s: 12.346, end_s: 72 });
  assert.deepEqual(parseOptions({ bpm_min: 90, bpm_max: 180 }).options, { bpm_min: 90, bpm_max: 180 });
});

test('a live band is a hint of its own, true or left out', () => {
  assert.deepEqual(parseOptions({ band: true }), { options: { band: true }, key: 'band=true' });
  assert.deepEqual(parseOptions({ band: false }), { options: {}, key: '' });
  assert.equal(parseOptions({ band: true, meter: 4 }).key, 'band=true;meter=4');
  for (const raw of [{ band: 'yes' }, { band: 1 }]) assert.equal(catchCode(() => parseOptions(raw)), 'BAD_OPTIONS');
});

test('the upload header is percent-encoded JSON, capped', () => {
  const header = encodeURIComponent(JSON.stringify({ tempo: 'changes', meter: 7 }));
  assert.equal(optionsFromHeader(header).key, 'meter=7;tempo=changes');
  assert.deepEqual(optionsFromHeader(''), { options: {}, key: '' });
  assert.equal(catchCode(() => optionsFromHeader('%E0%A4%A')), 'BAD_OPTIONS');
  assert.equal(catchCode(() => optionsFromHeader('{oops')), 'BAD_OPTIONS');
  assert.equal(catchCode(() => optionsFromHeader(encodeURIComponent(JSON.stringify({ tempo: 'x'.repeat(600) })))), 'BAD_OPTIONS');
});

test('the browser\'s length is a number in range, and a stretch counts as its own length', () => {
  assert.equal(audioSecondsOf('183.27'), 183.3);
  assert.equal(audioSecondsOf(90), 90);
  for (const bad of [undefined, '', 'abc', -1, 0, 99_999]) assert.equal(audioSecondsOf(bad), null);
  assert.equal(audioSecondsOf('300', { start_s: 30, end_s: 90 }), 60);
});

// ── The estimate (W3.16) ────────────────────────────────────────────────────

test('a job costs a range, wider with the vote, and fast is cheaper', () => {
  const normal = jobCost('normal', 276); // the reference song of W11.1, 4:36
  const fast = jobCost('fast', 276);
  assert.ok(normal.low < normal.high);
  assert.ok(fast.high < normal.low + normal.high);
  assert.ok(fast.low < normal.low && fast.high < normal.high);
  // 35 s per audio minute with the vote, 11 without: the conservative ends.
  assert.equal(Math.round(normal.high), Math.round(35 * 4.6));
  assert.equal(Math.round(fast.high), Math.round(11 * 4.6));
  assert.equal(jobCost('strict', 60).high, jobCost('normal', 60).high);
  // Unknown length: a floor and no ceiling.
  assert.equal(jobCost('normal', null).high, null);
  assert.ok(jobCost('normal', null).low > 0);
});

test('the wait adds up what is ahead; an unknown length makes everything behind it "at least"', () => {
  const live = [
    { publicId: 'r', status: 'running', progress: 0.5, mode: 'normal', audioSeconds: 120 },
    { publicId: 'a', status: 'queued', mode: 'fast', audioSeconds: 60 },
    { publicId: 'b', status: 'queued', mode: 'normal', audioSeconds: null },
    { publicId: 'c', status: 'queued', mode: 'normal', audioSeconds: 60 },
  ];
  const est = estimateQueue(live);
  const r = jobCost('normal', 120);
  assert.deepEqual(est.get('r'), { lowS: Math.round(r.low / 2), highS: Math.round(r.high / 2) });
  const a = est.get('a');
  assert.equal(a.lowS, Math.round(r.low / 2 + jobCost('fast', 60).low));
  assert.equal(a.highS, Math.round(r.high / 2 + jobCost('fast', 60).high));
  assert.equal(est.get('b').highS, null);
  assert.equal(est.get('c').highS, null);
  assert.ok(est.get('c').lowS > est.get('b').lowS);
});

test('a queue row says its mode and its estimate while it waits, never after', () => {
  const row = { publicId: 'x'.repeat(32), status: 'queued', position: 1, createdAt: new Date(), private: true, mode: 'fast' };
  const entry = queueEntry(row, { estimate: { lowS: 3, highS: 12 } });
  assert.equal(entry.mode, 'fast');
  assert.deepEqual(entry.estimate, { lowS: 3, highS: 12 });
  assert.equal(entry.song, null);
  assert.ok(!('estimate' in queueEntry({ ...row, status: 'done', finishedAt: new Date() }, { estimate: { lowS: 1, highS: 2 } })));
  assert.equal(queueEntry({ ...row, mode: undefined }).mode, 'normal');
});

// ── Through the API (memory store) ──────────────────────────────────────────

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-modes-'));
const TOKEN = 'w'.repeat(40);
process.env.WORKER_TOKEN = TOKEN;
// Each upload from its own address, so this file's dozen uploads do not run
// into the per-address limits other tests prove.
process.env.TRUST_PROXY = '1';
let address = 0;
const nextAddress = () => `198.51.100.${++address}`;
const { app } = await import('../src/app.js');
const { analyses } = await import('../src/services/analysis.service.js');
const { prepareSpool } = await import('../src/services/spool.service.js');

let server;
let base;
let internal;
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  base = `${root}/api/v1`;
  internal = `${root}/api/internal`;
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const HASHES = { fast: 'fa57fa57fa57fa57', normal: '0123456789abcdef', strict: '5e1ec75e1ec75e1e' };
const WORKER = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const sha1Of = (body) => createHash('sha1').update(body).digest('hex');

const upload = async (body, headers = {}, cookie = '') => {
  const response = await fetch(`${base}/analyses`, {
    method: 'POST',
    headers: {
      ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'song.mp3', Cookie: cookie,
      'X-Forwarded-For': nextAddress(), ...headers,
    },
    body,
  });
  const set = response.headers.get('set-cookie');
  return { status: response.status, data: await response.json(), cookie: cookie || set?.split(';')[0] || '' };
};

const lookup = (json, cookie = '') =>
  fetch(`${base}/analyses/lookup`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'song.mp3', size: 10, ...json }),
  });

/** What the worker does with one job: claim, then post a result in the mode it was asked. */
const work = async (extra = {}) => {
  const claim = await fetch(`${internal}/jobs/claim`, {
    method: 'POST', headers: WORKER, body: JSON.stringify({ engine_hash: HASHES.normal, engine_hashes: HASHES }),
  });
  assert.equal(claim.status, 200);
  const job = await claim.json();
  const result = {
    format: 'timing-result', version: 1, minor: 2, engine: 'v3', engine_hash: HASHES[job.mode], refused: false,
    global_bpm: 120, offset_ms: 10, duration_s: 60, red_lines: [{ time_ms: 10, bpm: 120, beat_length_ms: 500, meter: 4 }],
    sections: [], osu_timing: '10,500,4,2,0,100,1,0', mode: job.mode, options: job.options, hint_checks: [], stretch: null,
    ...extra,
  };
  const done = await fetch(`${internal}/jobs/${job.id}/result`, {
    method: 'POST', headers: WORKER, body: JSON.stringify({ attempt: job.attempt, result }),
  });
  assert.equal(done.status, 204);
  return job;
};

test('the mode and the hints reach the worker and come back on the analysis', async () => {
  while (await analyses().claim()) {} // nothing left over from another test
  const body = randomBytes(64);
  const options = { tempo: 'constant', meter: 3, start_s: 10, end_s: 70 };
  const sent = await upload(body, {
    'X-Mode': 'fast', 'X-Options': encodeURIComponent(JSON.stringify(options)), 'X-Duration': '200.04',
  });
  assert.equal(sent.status, 202);
  const row = await analyses().get(sent.data.id);
  assert.equal(row.mode, 'fast');
  assert.equal(row.optionsKey, 'end_s=70;meter=3;start_s=10;tempo=constant');
  assert.equal(row.audioSeconds, 60); // the stretch, not the song

  const job = await work();
  assert.equal(job.id, sent.data.id);
  assert.equal(job.mode, 'fast');
  assert.deepEqual(job.options, options);
  const view = await (await fetch(`${base}/analyses/${sent.data.id}`, { headers: { Cookie: sent.cookie } })).json();
  assert.equal(view.mode, 'fast');
  assert.deepEqual(view.options, options);
  assert.equal(view.result.mode, 'fast');
});

test('the same audio in another mode, or with other hints, is another result; the same one is the cache', async () => {
  const body = randomBytes(64);
  const sha1 = sha1Of(body);
  const first = await upload(body, { 'X-Mode': 'fast' });
  await work();

  // Same mode, same (no) hints: answered from the stored result, nothing uploaded.
  const again = await (await lookup({ sha1, mode: 'fast' })).json();
  assert.equal(again.cached, true);
  const copy = await analyses().get(again.id);
  assert.equal(copy.mode, 'fast');
  // Normal, strict, or fast with a hint: not that result.
  assert.deepEqual(await (await lookup({ sha1 })).json(), { cached: false });
  assert.deepEqual(await (await lookup({ sha1, mode: 'strict' })).json(), { cached: false });
  assert.deepEqual(await (await lookup({ sha1, mode: 'fast', options: { meter: 3 } })).json(), { cached: false });
  // And an upload in normal mode queues a job of its own.
  const normal = await upload(body, {}, first.cookie);
  assert.equal(normal.status, 202);
  assert.equal(normal.data.cached, false);
  // A person who had the fast copy today does not get it back for normal.
  assert.notEqual(normal.data.id, again.id);
  await work();
});

test('bad options are refused before the body is read', async () => {
  for (const headers of [{ 'X-Mode': 'turbo' }, { 'X-Options': 'nope' }, { 'X-Options': encodeURIComponent('{"bpm":1000}') }]) {
    const sent = await upload(randomBytes(8), headers);
    assert.equal(sent.status, 400, JSON.stringify(headers));
    assert.ok(['BAD_MODE', 'BAD_OPTIONS'].includes(sent.data.error.code));
  }
  assert.equal((await lookup({ sha1: 'a'.repeat(40), options: { meter: 99 } })).status, 400);
});

test('a re-analysis is linked both ways, for its owner only, and must be the same audio', async () => {
  const body = randomBytes(64);
  const sha1 = sha1Of(body);
  const first = await upload(body);
  await work();

  // Another visitor cannot hang anything off it: the 404 of a missing one.
  const stranger = await upload(randomBytes(8));
  await work();
  const theirs = await upload(body, { 'X-Mode': 'fast', 'X-Reanalysis-Of': first.data.id }, stranger.cookie);
  assert.equal(theirs.status, 404);
  assert.equal((await lookup({ sha1, mode: 'fast', reanalysisOf: first.data.id }, stranger.cookie)).status, 404);
  // Other audio is not a re-analysis of it.
  const other = await upload(randomBytes(64), { 'X-Mode': 'fast', 'X-Reanalysis-Of': first.data.id }, first.cookie);
  assert.equal(other.status, 400);
  assert.equal(other.data.error.code, 'NOT_SAME_AUDIO');

  const second = await upload(body, { 'X-Mode': 'fast', 'X-Reanalysis-Of': first.data.id }, first.cookie);
  assert.equal(second.status, 202);
  await work();
  const read = async (id, cookie) => (await fetch(`${base}/analyses/${id}`, { headers: { Cookie: cookie } })).json();
  const a = await read(first.data.id, first.cookie);
  const b = await read(second.data.id, first.cookie);
  assert.equal(b.reanalysisOf, first.data.id);
  assert.deepEqual(a.related.map((r) => [r.id, r.mode, r.source]), [[second.data.id, 'fast', false]]);
  assert.deepEqual(b.related.map((r) => [r.id, r.mode, r.source]), [[first.data.id, 'normal', true]]);

  // From the cache too: the same request again is answered without a job, and linked.
  const third = await (await lookup({ sha1, mode: 'fast', reanalysisOf: first.data.id }, first.cookie)).json();
  assert.equal(third.cached, true);
});

test('a result stored by a worker from before modes counts as what it ran: normal, no hints', async () => {
  const sent = await upload(randomBytes(64), { 'X-Mode': 'fast', 'X-Options': encodeURIComponent('{"meter":3}') });
  await work({ mode: undefined, options: undefined, hint_checks: undefined, stretch: undefined });
  const row = await analyses().get(sent.data.id);
  assert.equal(row.mode, 'normal');
  assert.equal(row.optionsKey, '');
});

test('the queue says each waiting row\'s mode and an estimate', async () => {
  while (await analyses().claim()) {}
  await upload(randomBytes(32), { 'X-Mode': 'fast', 'X-Duration': '120' });
  await upload(randomBytes(32), { 'X-Duration': '240' });
  const queue = await (await fetch(`${base}/analyses/queue`)).json();
  const waiting = queue.live.filter((r) => r.status === 'queued');
  assert.deepEqual(waiting.map((r) => r.mode), ['fast', 'normal']);
  assert.ok(waiting[0].estimate.lowS < waiting[1].estimate.lowS);
  assert.ok(waiting[1].estimate.highS >= waiting[1].estimate.lowS);
  while (await analyses().claim()) {}
});

function catchCode(work) {
  try {
    work();
  } catch (error) {
    return error.code;
  }
  return null;
}
