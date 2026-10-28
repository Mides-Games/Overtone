import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * The Discord bot's routes (W9.3-W9.5), /api/internal/bot, as the bot calls
 * them: BOT_TOKEN bearer, the Discord user in X-Discord-User.
 */

const BOT_TOKEN = 'b'.repeat(40);
const WORKER_TOKEN = 'w'.repeat(40);
delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WORKER_TOKEN = WORKER_TOKEN;
// The proxy secret is on: the bot's routes must not need it.
process.env.PROXY_SECRET = 'p'.repeat(40);
process.env.ANON_DAILY_LIMIT = '2';
process.env.USER_DAILY_LIMIT = '50';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-bot-'));
const { app } = await import('../src/app.js');
const { analyses } = await import('../src/services/analysis.service.js');
const { prepareSpool } = await import('../src/services/spool.service.js');
const { DEV_DISCORD_ID } = await import('../src/routes/auth.routes.js');

const LINKED = DEV_DISCORD_ID; // the Discord dev user's id, linked through Mides at sign-in
const STRANGER = '200000000000000002';
const OTHER = '200000000000000003';

let server;
let root;
let alice; // the Discord dev user
let bob; // the Google dev user
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  alice = await signIn('discord');
  bob = await signIn('google');
});
after(() => server.close());

const PROXY = { 'X-Overtone-Proxy': 'p'.repeat(40) };
const JSON_BODY = { ...PROXY, 'X-Requested-With': 'overtone-web', 'Content-Type': 'application/json' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

const signIn = async (provider) => {
  const start = await fetch(`${root}/api/v1/auth/sso/start?provider=${provider}`, { headers: PROXY });
  const { url } = await start.json();
  const code = new URL(url).hash.slice('#code='.length);
  const exchange = await fetch(`${root}/api/v1/auth/sso/exchange`, {
    method: 'POST',
    headers: { ...JSON_BODY, Cookie: cookieOf(start).join('; ') },
    body: JSON.stringify({ code }),
  });
  assert.equal(exchange.status, 200);
  return cookieOf(exchange).join('; ');
};

/** A call as the bot makes it. */
const bot = (path, { user = LINKED, method = 'GET', headers = {}, body, token = BOT_TOKEN } = {}) =>
  fetch(`${root}/api/internal/bot${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(user ? { 'X-Discord-User': user } : {}), ...headers },
    body,
  });

let n = 0;
const upload = (user, { name = 'song.mp3', title } = {}) =>
  bot('/analyses', {
    user,
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': name, ...(title ? { 'X-Title': title } : {}) },
    body: `audio bytes ${++n} ${Math.random()}`,
  });

const result = (bpm) => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: bpm, offset_ms: 123, meter: '4/4',
  red_lines: [{ time_ms: 123, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true }],
  sections: [{ index: 0, start_ms: 123, end_ms: 60_000, bpm, confidence: 0.82, level: 'medium' }],
  osu_timing: `123,${60_000 / bpm},4,1,0,100,1,0`,
});

/** The worker's turn, straight through the store: claim the next job and finish it. */
const finishNext = async (bpm = 150) => {
  const job = await analyses().claim();
  assert.ok(job);
  assert.ok(await analyses().finish(job.publicId, job.attempt, result(bpm)));
  // As the worker's route does after a result: the DM notice.
  const { enqueueDm } = await import('../src/services/links.service.js');
  const row = await analyses().get(job.publicId, { position: false });
  await enqueueDm({ publicId: job.publicId, accountId: row.accountId });
  return job.publicId;
};

test('the bot\'s door takes BOT_TOKEN and nothing else, the worker\'s token included', async () => {
  assert.equal((await bot('/health', { token: 'nope' })).status, 401);
  assert.equal((await bot('/health', { token: WORKER_TOKEN })).status, 401);
  const health = await bot('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).maxUploadMb, 40);
  // And the bot's token opens nothing of the worker's.
  const claim = await fetch(`${root}/api/internal/jobs/claim`, {
    method: 'POST', headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: '{"engine_hash":"abcdef01"}',
  });
  assert.equal(claim.status, 401);
});

test('every user route wants a Discord id, in a header', async () => {
  assert.equal((await bot('/me', { user: null })).status, 400);
  assert.equal((await bot('/me', { user: 'robert\'); drop' })).status, 400);
  assert.deepEqual(await (await bot('/me', { user: STRANGER })).json(), { linked: false, notify: false });
  assert.deepEqual(await (await bot('/me')).json(), { linked: true, username: 'dev_discord', notify: false });
});

test('a linked Discord user uploads as their account; the embed has what the result says', async () => {
  const response = await upload(LINKED, { title: 'Bot Song' });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const queued = await (await bot(`/analyses/${id}`)).json();
  assert.equal(queued.status, 'queued');
  assert.equal(queued.title, 'Bot Song');
  // The site shows it to the account too: it is theirs.
  const site = await fetch(`${root}/api/v1/analyses/${id}`, { headers: { ...PROXY, Cookie: alice } });
  assert.equal(site.status, 200);

  await finishNext(150);
  const done = await (await bot(`/analyses/${id}`)).json();
  assert.equal(done.status, 'done');
  assert.equal(done.bpm, 150);
  assert.equal(done.offsetMs, 123);
  assert.equal(done.redLines, 1);
  assert.equal(done.level, 'medium');
  assert.equal(done.confidence, 0.82);
  assert.equal(done.url, `http://localhost:5173/analyze/${id}`);
  for (const key of ['sha1', 'anonHash', 'ipHash', 'filename']) assert.ok(!(key in done), key);
});

test('an unlinked Discord user has the anonymous quota of one visitor, counted per Discord user', async () => {
  const first = await upload(STRANGER);
  assert.equal(first.status, 202);
  const { id } = await first.json();
  assert.equal((await upload(STRANGER)).status, 202);
  const third = await upload(STRANGER);
  assert.equal(third.status, 429);
  const { error } = await third.json();
  assert.equal(error.code, 'QUOTA_EXCEEDED');
  assert.equal(error.details.scope, 'anonymous');
  // Another Discord user has their own.
  assert.equal((await upload(OTHER)).status, 202);

  // Theirs to read, and nobody else's: the same 404 as an id that does not exist.
  assert.equal((await bot(`/analyses/${id}`, { user: STRANGER })).status, 200);
  assert.equal((await bot(`/analyses/${id}`, { user: OTHER })).status, 404);
  assert.equal((await bot(`/analyses/${'0'.repeat(32)}`, { user: OTHER })).status, 404);
  assert.equal((await bot(`/analyses/${id}`, { user: LINKED })).status, 404);
  // No page they could open without an account.
  assert.equal((await (await bot(`/analyses/${id}`, { user: STRANGER })).json()).url, null);
});

test('an attachment of another type, or too large, is refused before it is read', async () => {
  const exe = await upload(OTHER, { name: 'virus.exe' });
  assert.equal(exe.status, 400);
  const big = await bot('/analyses', {
    user: OTHER, method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'a.mp3', 'Content-Length': String(41 * 1_048_576) },
    body: 'x',
  }).catch((e) => ({ status: e.cause?.code ?? 'cut' }));
  assert.notEqual(big.status, 202);
});

test('the queue says how many wait and where the caller\'s own songs are', async () => {
  const queue = await (await bot('/queue', { user: STRANGER })).json();
  assert.ok(queue.waiting >= 2);
  assert.equal(queue.mine.length, 2);
  assert.ok(queue.mine.every((m) => m.position >= 1));
  assert.equal((await (await bot('/queue', { user: '200000000000000099' })).json()).mine.length, 0);
});

test('publishing through the bot opens the public page, and /timing reads it for anyone', async () => {
  // Drain the queue: the stranger's two and the other's one.
  const ids = [await finishNext(120), await finishNext(121), await finishNext(122)];
  const mine = [];
  for (const id of ids) if ((await bot(`/analyses/${id}`, { user: STRANGER })).status === 200) mine.push(id);
  assert.equal(mine.length, 2);
  const published = await bot(`/analyses/${mine[0]}/publish`, { user: STRANGER, method: 'POST' });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).url, `http://localhost:5173/t/${mine[0]}`);
  // Someone else's: the 404.
  assert.equal((await bot(`/analyses/${mine[1]}/publish`, { user: OTHER, method: 'POST' })).status, 404);

  const seen = await (await bot(`/timings/${mine[0]}`, { user: OTHER })).json();
  assert.equal(seen.published, true);
  assert.equal(seen.anonymous, true);
  // Unpublished and not theirs: not found.
  assert.equal((await bot(`/timings/${mine[1]}`, { user: OTHER })).status, 404);
});

test('/link with a code from the profile links the Discord user who typed it', async () => {
  const made = await fetch(`${root}/api/v1/links/discord/code`, { method: 'POST', headers: { ...JSON_BODY, Cookie: bob }, body: '{}' });
  assert.equal(made.status, 200);
  const { code, minutes } = await made.json();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(minutes, 10);

  const link = (user, body) => bot('/link', { user, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await link(OTHER, { code: 'AAAA-AAAA' })).status, 400);
  const ok = await link(OTHER, { code: code.toLowerCase() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { linked: true, username: 'dev_google' });
  // Spent: a second use does nothing.
  assert.equal((await link(STRANGER, { code })).status, 400);
  assert.deepEqual(await (await bot('/me', { user: OTHER })).json(), { linked: true, username: 'dev_google', notify: false });
  // And the link survives a sign-in from a Mides that sends no Discord id.
  bob = await signIn('google');
  assert.equal((await (await bot('/me', { user: OTHER })).json()).linked, true);
});

test('/notify is for linked users; a finished analysis then becomes one DM, taken once', async () => {
  const notify = (user, on) => bot('/notify', { user, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
  assert.equal((await notify(STRANGER, true)).status, 409);
  assert.equal((await notify(LINKED, 'on')).status, 400);
  assert.equal((await notify(LINKED, true)).status, 200);

  // Drain what the earlier tests left in the outbox (DMs were off then: nothing).
  await (await bot('/dms/claim', { method: 'POST', user: null })).json();
  const { id } = await (await upload(LINKED)).json();
  await finishNext(170);
  const { dms } = await (await bot('/dms/claim', { method: 'POST', user: null })).json();
  assert.equal(dms.length, 1);
  assert.equal(dms[0].discordId, LINKED);
  assert.equal(dms[0].analysis.id, id);
  assert.equal(dms[0].analysis.bpm, 170);
  assert.deepEqual((await (await bot('/dms/claim', { method: 'POST', user: null })).json()).dms, []);

  // Off again: nothing more.
  assert.equal((await notify(LINKED, false)).status, 200);
  await upload(LINKED);
  await finishNext(171);
  assert.deepEqual((await (await bot('/dms/claim', { method: 'POST', user: null })).json()).dms, []);
});

test('/recent lists a linked user\'s published timings, and nothing for anyone else', async () => {
  const { id } = await (await upload(LINKED, { title: 'Recent One' })).json();
  await finishNext(140);
  assert.equal((await bot(`/analyses/${id}/publish`, { method: 'POST' })).status, 200);
  const recent = await (await bot('/recent', { user: OTHER, headers: { 'X-Discord-Target': LINKED } })).json();
  assert.equal(recent.linked, true);
  assert.equal(recent.timings[0].id, id);
  assert.equal(recent.timings[0].title, 'Recent One');
  assert.deepEqual(await (await bot('/recent', { user: OTHER, headers: { 'X-Discord-Target': STRANGER } })).json(), { linked: false, timings: [] });
  assert.equal((await bot('/recent', { user: OTHER })).status, 400);
});

test('an unknown bot path is a 404, not the worker\'s 401', async () => {
  assert.equal((await bot('/jobs/claim', { method: 'POST' })).status, 404);
});
