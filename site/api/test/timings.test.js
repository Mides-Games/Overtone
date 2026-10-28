import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.USER_DAILY_LIMIT = '500';
process.env.ANON_DAILY_LIMIT = '50';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-timings-'));
const { app } = await import('../src/app.js');
const { analyses } = await import('../src/services/analysis.service.js');
const { prepareSpool } = await import('../src/services/spool.service.js');
const { decodeCursor, listFilters, songNames } = await import('../src/utils/timings.js');

let server;
let base;
let alice; // the Discord dev user
let bob; // the Google dev user
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
  assert.equal(exchange.status, 200);
  return cookieOf(exchange).join('; ');
};

/** A result as the worker builds one: `bpms` is one red line per BPM. */
const resultWith = (bpms) => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: bpms[0], offset_ms: 100, meter: '4/4',
  red_lines: bpms.map((bpm, i) => ({ time_ms: 100 + i * 20_000, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true })),
  sections: bpms.map((bpm, i) => ({ index: i, start_ms: 100 + i * 20_000, end_ms: 20_100 + i * 20_000, bpm, confidence: 0.9, level: 'high' })),
  osu_timing: bpms.map((bpm, i) => `${100 + i * 20_000},${60_000 / bpm},4,1,0,100,1,0`).join('\n'),
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const accounts = new Map();
/** The account and public profile behind a session cookie, as an upload would record them. */
const accountOf = async (cookie) => {
  if (!accounts.has(cookie)) {
    const { account } = await (await fetch(`${base}/me`, { headers: { Cookie: cookie } })).json();
    accounts.set(cookie, account);
  }
  return accounts.get(cookie);
};

let counter = 0;
/**
 * A song `cookie` analysed (an account, or '' for a new anonymous visitor),
 * finished by the worker with `bpms`. The row goes in through the store as
 * an upload puts it there: twenty uploads would only test the upload's own
 * rate limit. `headers` are the upload's (X-Filename, X-Private, X-Title,
 * X-Artist). Returns the id, the cookie that owns it and the audio's SHA-1.
 */
const finished = async ({ cookie = alice, bpms = [128], headers = {}, body = `song ${++counter}`, refused = false } = {}) => {
  const { cleanFilename, cleanTag } = await import('../src/utils/upload.js');
  const { newPublicId } = await import('../src/services/analysis.service.js');
  const id = newPublicId();
  const sha1 = createHash('sha1').update(body).digest('hex');
  let owner = cookie;
  let accountId = null;
  let anonHash = null;
  let uploader = null;
  if (cookie) {
    const account = await accountOf(cookie);
    accountId = account.id;
    uploader = { username: account.username, displayName: account.displayName, avatarUrl: account.avatarUrl };
  } else {
    const token = `anon${String(++counter).padStart(20, '0')}`;
    owner = `overtone_anon=${token}`;
    anonHash = sha256(token);
  }
  await analyses().create({
    publicId: id, sha1, filename: cleanFilename(headers['X-Filename'] ?? 'song.mp3'), sizeBytes: body.length,
    accountId, anonHash, ipHash: sha256(`ip ${counter}`), uploader,
    private: headers['X-Private'] === '1', tagTitle: cleanTag(headers['X-Title'] ?? null), tagArtist: cleanTag(headers['X-Artist'] ?? null),
  });
  const job = await analyses().claim();
  assert.equal(job.publicId, id);
  const result = refused
    ? { ...resultWith([]), refused: true, refusal: { code: 'no_pulse', message: 'No pulse.' }, global_bpm: null }
    : resultWith(bpms);
  assert.ok(await analyses().finish(id, job.attempt, result));
  return { id, cookie: owner, sha1 };
};

const publish = (id, cookie, body = {}, headers = JSON_BODY) =>
  fetch(`${base}/analyses/${id}/publish`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify(body) });
const unpublish = (id, cookie) =>
  fetch(`${base}/analyses/${id}/publish`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: cookie } });
const recent = async (query = '') => {
  const response = await fetch(`${base}/timings${query}`);
  assert.equal(response.status, 200);
  return response.json();
};
const recentIds = async (query = '') => (await recent(query)).timings.map((t) => t.id);

test('only its uploader publishes an analysis: a stranger gets the 404 of a missing id', async () => {
  const mine = await finished();
  const anon = await finished({ cookie: '' });
  assert.equal((await publish(mine.id, bob)).status, 404);
  assert.equal((await publish(mine.id, anon.cookie)).status, 404);
  assert.equal((await publish(mine.id, '')).status, 404);
  assert.equal((await publish('f'.repeat(32), alice)).status, 404);
  // Without the same-origin header, not even the uploader.
  assert.equal((await publish(mine.id, alice, {}, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await fetch(`${base}/timings/${mine.id}`)).status, 404);

  const done = await publish(mine.id, alice);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).published, true);
  assert.equal((await fetch(`${base}/timings/${mine.id}`)).status, 200);
  // An anonymous uploader publishes with the cookie that made it.
  assert.equal((await publish(anon.id, anon.cookie)).status, 200);
  const page = await (await fetch(`${base}/timings/${anon.id}`)).json();
  assert.equal(page.anonymous, true);
  assert.equal(page.uploader, null);
});

test('only a finished timing can be published: not a queued song, not a refusal', async () => {
  const response = await fetch(`${base}/analyses`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'wait.mp3', Cookie: alice },
    body: 'still waiting',
  });
  const { id } = await response.json();
  const queued = await publish(id, alice);
  assert.equal(queued.status, 409);
  assert.equal((await queued.json()).error.code, 'NOT_PUBLISHABLE');
  await fetch(`${base}/analyses/${id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });

  const refused = await finished({ refused: true });
  assert.equal((await publish(refused.id, alice)).status, 409);
});

test('a private analysis is published only when the same action lifts its privacy', async () => {
  const hidden = await finished({ headers: { 'X-Private': '1' } });
  const plain = await publish(hidden.id, alice);
  assert.equal(plain.status, 409);
  assert.equal((await plain.json()).error.code, 'PRIVATE');
  assert.equal((await fetch(`${base}/timings/${hidden.id}`)).status, 404);

  const lifted = await publish(hidden.id, alice, { makePublic: true });
  assert.equal(lifted.status, 200);
  assert.equal((await lifted.json()).private, false);
  const own = await (await fetch(`${base}/analyses/${hidden.id}`, { headers: { Cookie: alice } })).json();
  assert.equal(own.private, false);
  assert.equal(own.published, true);
});

test('the public page, the list and the check never carry the SHA-1, anon_hash or ip_hash', async () => {
  const anon = await finished({ cookie: '', headers: { 'X-Title': 'Leak%20Test', 'X-Artist': 'Nobody' } });
  const signed = await finished({ headers: { 'X-Filename': 'Some%20Artist%20-%20Some%20Song.mp3' } });
  assert.equal((await publish(anon.id, anon.cookie)).status, 200);
  assert.equal((await publish(signed.id, alice)).status, 200);

  for (const { id, sha1 } of [anon, signed]) {
    const row = await analyses().get(id);
    const secrets = [sha1, row.anonHash, row.ipHash].filter(Boolean);
    assert.ok(secrets.length >= 2);
    const bodies = [
      await (await fetch(`${base}/timings/${id}`)).text(),
      await (await fetch(`${base}/timings/${id}/card`)).text(),
      await (await fetch(`${base}/timings?limit=50`)).text(),
      await (await fetch(`${base}/timings/${id}/timing.csv`)).text(),
      await (await fetch(`${base}/timings/${id}/check`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ sha1 }) })).text(),
    ];
    for (const body of bodies) {
      for (const secret of secrets) assert.equal(body.includes(secret), false);
      assert.equal(/sha1|anon_?hash|ip_?hash/i.test(body), false);
    }
  }

  const page = await (await fetch(`${base}/timings/${signed.id}`)).json();
  // Read from the file name, which itself is never shown.
  assert.equal(page.title, 'Some Song');
  assert.equal(page.artist, 'Some Artist');
  assert.equal(page.uploader.username.length > 0, true);
  assert.equal('filename' in page, false);
  assert.equal(page.result.red_lines.length, 1);
  const tagged = await (await fetch(`${base}/timings/${anon.id}`)).json();
  assert.deepEqual([tagged.title, tagged.artist], ['Leak Test', 'Nobody']);
});

test('the check answers only match or no match, and only for a published timing', async () => {
  const song = await finished({ body: 'checked audio' });
  const check = (sha1) =>
    fetch(`${base}/timings/${song.id}/check`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ sha1 }) });
  assert.equal((await check(song.sha1)).status, 404);
  await publish(song.id, alice);
  assert.deepEqual(await (await check(song.sha1)).json(), { match: true });
  assert.deepEqual(await (await check(song.sha1.toUpperCase())).json(), { match: true });
  assert.deepEqual(await (await check('0'.repeat(40))).json(), { match: false });
  assert.equal((await check('not a hash')).status, 400);
  const noHeader = await fetch(`${base}/timings/${song.id}/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha1: song.sha1 }),
  });
  assert.equal(noHeader.status, 403);
});

test('unpublishing takes the page and its list row down again; only the uploader can', async () => {
  const song = await finished();
  await publish(song.id, alice);
  assert.ok((await recentIds('?limit=50')).includes(song.id));
  assert.equal((await unpublish(song.id, bob)).status, 404);
  assert.equal((await fetch(`${base}/timings/${song.id}`)).status, 200);

  assert.equal((await unpublish(song.id, alice)).status, 204);
  assert.equal((await fetch(`${base}/timings/${song.id}`)).status, 404);
  assert.equal((await fetch(`${base}/timings/${song.id}/timing.txt`)).status, 404);
  assert.equal((await recentIds('?limit=50')).includes(song.id), false);
  // The uploader still reads it.
  const own = await (await fetch(`${base}/analyses/${song.id}`, { headers: { Cookie: alice } })).json();
  assert.equal(own.published, false);
});

test('deleting a finished analysis takes it off the recent list and the history, and the quota still counts it', async () => {
  const song = await finished();
  await publish(song.id, alice);
  const row = await analyses().get(song.id);
  const before = await analyses().countToday({ accountId: row.accountId });

  assert.equal((await fetch(`${base}/analyses/${song.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: bob } })).status, 404);
  assert.equal((await fetch(`${base}/analyses/${song.id}`, { method: 'DELETE', headers: { Cookie: alice } })).status, 403);
  assert.equal((await fetch(`${base}/analyses/${song.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } })).status, 204);

  assert.equal((await fetch(`${base}/timings/${song.id}`)).status, 404);
  assert.equal((await recentIds('?limit=50')).includes(song.id), false);
  assert.equal((await fetch(`${base}/analyses/${song.id}`, { headers: { Cookie: alice } })).status, 404);
  const history = await (await fetch(`${base}/me/analyses?limit=50`, { headers: { Cookie: alice } })).json();
  assert.equal(history.analyses.some((a) => a.id === song.id), false);
  assert.equal(await analyses().countToday({ accountId: row.accountId }), before);
  // Deleted twice is the 404 of something gone.
  assert.equal((await fetch(`${base}/analyses/${song.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } })).status, 404);
});

test('a deleted analysis keeps nothing to show; past its day the row goes too', async () => {
  const store = analyses();
  const today = await finished({ headers: { 'X-Title': 'Erased' } });
  const raw = await store.get(today.id);
  assert.ok(await store.deleteOwn(today.id));
  assert.equal(await store.get(today.id), null);
  assert.equal(await store.findCached(raw.sha1, raw.engineHash), null);
  assert.equal(await store.deleteOwn(today.id), false);

  // Marked today, it still counts in today's quota; once the day is over the
  // purge takes the row, and an analysis from an earlier day goes at once.
  const who = { accountId: raw.accountId };
  const counted = await store.countToday(who);
  const old = await finished();
  assert.equal(await store.countToday(who), counted + 1);
  const later = (fn) => async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 86_400_000 });
    try {
      return await fn();
    } finally {
      mock.timers.reset();
    }
  };
  assert.ok(await later(() => store.deleteOwn(old.id))());
  assert.equal(await store.countToday(who), counted);
  await later(() => store.purgeDeleted())();
  // This test's row and any other this account deleted today (an earlier test's).
  assert.ok((await store.countToday(who)) <= counted - 1);
});

test('a song being analysed is neither cancelled nor deleted', async () => {
  const response = await fetch(`${base}/analyses`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'busy.mp3', Cookie: alice },
    body: 'busy song',
  });
  const { id } = await response.json();
  const job = await analyses().claim();
  const refused = await fetch(`${base}/analyses/${id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'NOT_QUEUED');
  await analyses().finish(id, job.attempt, resultWith([120]));
});

test('pages follow each other with no repeat and no gap, even when a timing is published in between', async () => {
  const tag = `paging${Date.now()}`;
  const made = [];
  for (let i = 0; i < 5; i++) {
    const song = await finished({ headers: { 'X-Title': `${tag} ${i}` } });
    await publish(song.id, alice);
    made.push(song.id);
  }
  const whole = (await recent(`?q=${tag}&limit=50`)).timings.map((t) => t.id);
  assert.deepEqual(new Set(whole), new Set(made));
  const first = await recent(`?q=${tag}&limit=2`);
  assert.equal(first.timings.length, 2);
  assert.ok(first.next);
  // Published after the first page was read (a few ms later, as anything a
  // person publishes is): it belongs before that page, not inside the next.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const late = await finished({ headers: { 'X-Title': `${tag} late` } });
  await publish(late.id, alice);
  const second = await recent(`?q=${tag}&limit=2&cursor=${first.next}`);
  const third = await recent(`?q=${tag}&limit=2&cursor=${second.next}`);
  assert.equal(third.next, null);
  const seen = [...first.timings, ...second.timings, ...third.timings].map((t) => t.id);
  assert.deepEqual(seen, whole);
  // Newest first: the late one tops a fresh read.
  assert.equal((await recent(`?q=${tag}&limit=2`)).timings[0].id, late.id);
  assert.equal((await fetch(`${base}/timings?cursor=nonsense`)).status, 400);
});

test('the recent list filters by BPM range, single or variable tempo, and text', async () => {
  const tag = `filters${Date.now()}`;
  const slow = await finished({ bpms: [90], headers: { 'X-Title': `${tag} slow`, 'X-Artist': 'Quiet Band' } });
  const fast = await finished({ bpms: [180], headers: { 'X-Title': `${tag} fast` } });
  const varied = await finished({ bpms: [120, 150], headers: { 'X-Title': `${tag} varied` } });
  const meter = await finished({ bpms: [140, 140], headers: { 'X-Title': `${tag} meter` } });
  for (const song of [slow, fast, varied, meter]) await publish(song.id, alice);

  const ids = async (query) => new Set(await recentIds(`?q=${tag}${query}`));
  assert.deepEqual(await ids('&bpmMin=100&bpmMax=160'), new Set([varied.id, meter.id]));
  assert.deepEqual(await ids('&tempo=variable'), new Set([varied.id]));
  assert.deepEqual(await ids('&tempo=single'), new Set([slow.id, fast.id, meter.id]));
  assert.deepEqual(new Set(await recentIds(`?q=${encodeURIComponent('quiet BAND')}`)), new Set([slow.id]));
  // % and _ are letters here, not wildcards.
  assert.deepEqual(await recentIds('?q=%25%25%25'), []);

  const entry = (await recent(`?q=${tag}%20varied`)).timings[0];
  assert.deepEqual(
    { bpm: entry.bpm, redLines: entry.redLines, variable: entry.variable, anonymous: entry.anonymous },
    { bpm: 120, redLines: 2, variable: true, anonymous: false },
  );
  for (const bad of ['?bpmMin=-1', '?bpmMax=abc', '?tempo=fast', '?limit=0', '?bpmMin=1&bpmMin=2']) {
    assert.equal((await fetch(`${base}/timings${bad}`)).status, 400, bad);
  }
});

test('the history is the signed-in account\'s own, filtered by status, BPM and date', async () => {
  assert.equal((await fetch(`${base}/me/analyses`)).status, 401);
  const tag = `history${Date.now()}`;
  const mine = await finished({ headers: { 'X-Title': `${tag} one` }, bpms: [100] });
  const refusedOne = await finished({ headers: { 'X-Title': `${tag} two` }, refused: true });
  const theirs = await finished({ cookie: bob, headers: { 'X-Title': `${tag} bob` } });

  const read = async (cookie, query = '') => {
    const response = await fetch(`${base}/me/analyses?q=${tag}${query}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const all = await read(alice);
  // Two rows in the same millisecond may come in either order; the order itself is the paging test's.
  assert.deepEqual(new Set(all.analyses.map((a) => a.id)), new Set([refusedOne.id, mine.id]));
  const one = all.analyses.find((a) => a.id === mine.id);
  assert.equal(one.filename, 'song.mp3');
  assert.equal(one.published, false);
  assert.equal(one.status, 'done');
  assert.equal(JSON.stringify(all).includes(mine.sha1), false);
  assert.deepEqual((await read(bob)).analyses.map((a) => a.id), [theirs.id]);
  assert.deepEqual((await read(alice, '&status=refused')).analyses.map((a) => a.id), [refusedOne.id]);
  assert.deepEqual((await read(alice, '&bpmMin=90&bpmMax=110')).analyses.map((a) => a.id), [mine.id]);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await read(alice, `&from=${today}&to=${today}`)).analyses.length, 2);
  assert.equal((await read(alice, '&to=2000-01-01')).analyses.length, 0);
  const bad = await fetch(`${base}/me/analyses?from=2026-02-30`, { headers: { Cookie: alice } });
  assert.equal(bad.status, 400);
});

test('filters and cursors are read strictly, and names as the .osz names them', () => {
  assert.deepEqual(listFilters({}).limit, 24);
  assert.equal(listFilters({ limit: '500' }).limit, 50);
  assert.equal(listFilters({ q: '  a‮b\u0000  c ' }).q, 'ab c');
  assert.equal(listFilters({ q: 'x'.repeat(500) }).q.length, 100);
  assert.equal(listFilters({ status: 'done' }).status, null);
  assert.equal(listFilters({ status: 'done' }, { kind: 'history' }).status, 'done');
  assert.throws(() => listFilters({ status: 'gone' }, { kind: 'history' }), /status/);
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor('1-xyz'), /cursor/);
  assert.equal(decodeCursor(`123-${'a'.repeat(32)}`).micros, 123n);
  assert.deepEqual(songNames({ filename: 'Artist - Title.mp3' }), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(songNames({ filename: 'just a name.ogg' }), { title: 'just a name', artist: null });
  assert.deepEqual(songNames({ tagTitle: 'T', tagArtist: null, filename: 'A - B.mp3' }), { title: 'T', artist: null });
});
