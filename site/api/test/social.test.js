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
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-social-'));
const { app } = await import('../src/app.js');
const { analyses, newPublicId } = await import('../src/services/analysis.service.js');
const { upsertFromMides } = await import('../src/services/account.service.js');
const { COOKIE, issue } = await import('../src/services/session.service.js');
const { social } = await import('../src/services/social.service.js');
const {
  atMsOf, badgesOf, beatmapUrlOf, COLLECTIONS_PER_ACCOUNT, MIN_RATINGS_TO_RANK, rankScore, TIMER_MIN_RATINGS, TIMER_MIN_USES,
} = await import('../src/utils/social.js');
const { listFilters } = await import('../src/utils/timings.js');

/**
 * Social v2 on published timings (W5.6, W6, W13.15, W13.18), over HTTP on the
 * memory store: who may rate, mark a use, comment, keep collections and see
 * a profile; one rating and one use per account; private collections and
 * profiles as 404s; and nothing that names an upload's hashes leaving.
 */

let server;
let base;
let alice; // the Discord dev user: a member
let bob; // the Google dev user: staff
const extra = []; // more members, made directly: the dev login has only two
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  alice = await signIn('discord');
  bob = await signIn('google');
  for (const name of ['carol', 'dave', 'erin', 'frank', 'gina']) {
    const row = await upsertFromMides({
      midesUserId: `test-${name}`, username: name, displayName: name.toUpperCase(), avatarUrl: null, bannerUrl: null, discordId: null, role: null,
    });
    extra.push(`${COOKIE}=${issue(row.id, row.session_version)}`);
  }
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

/** Every response body this file read, to look for hashes in at the end. */
const seen = [];
const call = async (method, path, { cookie = '', body, sameOrigin = true } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(sameOrigin ? SAME_ORIGIN : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = response.status === 204 ? '' : await response.text();
  seen.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const accountOf = async (cookie) => (await call('GET', '/me', { cookie })).body.account;

const resultWith = (bpm) => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: bpm, offset_ms: 100, meter: '4/4',
  red_lines: [{ time_ms: 100, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true }],
  sections: [{ index: 0, start_ms: 100, end_ms: 60_000, bpm, confidence: 0.9, level: 'high' }],
  osu_timing: `100,${60_000 / bpm},4,1,0,100,1,0`,
});

/** Every hash an upload in this file carried: none may ever appear in a response. */
const secrets = [];
let counter = 0;
/**
 * A finished analysis by `cookie` (an account, or '' for anonymous),
 * published unless `publish` is false. Straight through the stores, as an
 * upload and the worker put it there: the routes under test are the social ones.
 */
const timing = async ({ cookie = alice, bpm = 128, publish = true, title = `Song ${++counter}`, isPrivate = false } = {}) => {
  const id = newPublicId();
  const sha1 = createHash('sha1').update(`audio ${counter} ${Math.random()}`).digest('hex');
  const anonHash = cookie ? null : createHash('sha256').update(`anon ${counter}`).digest('hex');
  const ipHash = createHash('sha256').update(`ip ${counter}`).digest('hex');
  secrets.push(sha1, ipHash, ...(anonHash ? [anonHash] : []));
  const account = cookie ? await accountOf(cookie) : null;
  await analyses().create({
    publicId: id, sha1, filename: `${title}.mp3`, sizeBytes: 1, accountId: account?.id ?? null, anonHash, ipHash,
    uploader: account ? { username: account.username, displayName: account.displayName, avatarUrl: null } : null,
    private: isPrivate, tagTitle: title, tagArtist: 'Artist',
  });
  const job = await analyses().claim();
  assert.ok(await analyses().finish(id, job.attempt, resultWith(bpm)));
  if (publish) assert.ok(await analyses().publish(id));
  return id;
};

test('a beatmap link is an osu.ppy.sh beatmapset, kept in one form; anything else is refused', () => {
  assert.equal(beatmapUrlOf('https://osu.ppy.sh/beatmapsets/12345'), 'https://osu.ppy.sh/beatmapsets/12345');
  assert.equal(beatmapUrlOf(' http://www.osu.ppy.sh/beatmapsets/012345/ '), 'https://osu.ppy.sh/beatmapsets/12345');
  assert.equal(beatmapUrlOf('https://osu.ppy.sh/beatmapsets/7#mania/99'), 'https://osu.ppy.sh/beatmapsets/7#mania/99');
  assert.equal(beatmapUrlOf('https://osu.ppy.sh/s/42'), 'https://osu.ppy.sh/beatmapsets/42');
  assert.equal(beatmapUrlOf(''), null);
  assert.equal(beatmapUrlOf(null), null);
  for (const bad of [
    'javascript:alert(1)',
    'https://evil.example/beatmapsets/1',
    'https://osu.ppy.sh.evil.example/beatmapsets/1',
    'https://osu.ppy.sh/users/2',
    'https://osu.ppy.sh/beatmapsets/1?x=1',
    'https://osu.ppy.sh/beatmapsets/1#chess/2',
    'https://osu.ppy.sh/beatmapsets/0',
    'https://user@osu.ppy.sh/beatmapsets/1',
    42,
    `https://osu.ppy.sh/beatmapsets/${'1'.repeat(300)}`,
  ]) {
    assert.throws(() => beatmapUrlOf(bad), /beatmapset/, String(bad));
  }
});

test('a comment time is whole milliseconds inside the song; the order is Bayesian; badges are counted', () => {
  assert.equal(atMsOf(undefined), null);
  assert.equal(atMsOf(0, 60), 0);
  assert.equal(atMsOf(60_000, 60), 60_000);
  assert.throws(() => atMsOf(60_001, 60), /atMs/);
  assert.throws(() => atMsOf(-1, 60), /atMs/);
  assert.throws(() => atMsOf(1.5, 60), /atMs/);
  assert.throws(() => atMsOf('100', 60), /atMs/);
  // docs/16 §4: a 5-star from three people must not beat a 4.6 from two hundred.
  assert.ok(rankScore(15, 3) < rankScore(4.6 * 200, 200));
  assert.ok(rankScore(5 * 3, 3) > rankScore(4 * 3, 3));
  assert.deepEqual(badgesOf({ published: 0, uses: 0, acceptedSuggestion: false }), []);
  assert.deepEqual(badgesOf({ published: 1, uses: 0, acceptedSuggestion: false }), ['first-timing']);
  assert.deepEqual(badgesOf({ published: 50, uses: 2, acceptedSuggestion: true }), [
    'first-timing', 'published-10', 'published-50', 'suggestion-accepted', 'used-by-others',
  ]);
  assert.equal(listFilters({ sort: 'rated', cursor: 'o24' }).offset, 24);
  assert.throws(() => listFilters({ sort: 'rated', cursor: '123-abc' }), /cursor/);
  assert.throws(() => listFilters({ sort: 'loudest' }), /sort/);
  // History has no orders by numbers.
  assert.equal(listFilters({ sort: 'rated' }, { kind: 'history' }).sort, 'new');
});

test('stars: an account, the same-origin header, 1-5, one per account, never on your own timing', async () => {
  const id = await timing({ cookie: alice });
  const rate = (cookie, stars, sameOrigin = true) => call('PUT', `/timings/${id}/rating`, { cookie, body: { stars }, sameOrigin });

  assert.equal((await rate('', 5)).status, 401);
  assert.equal((await rate(bob, 5, false)).status, 403);
  assert.equal((await rate(bob, 6)).status, 400);
  assert.equal((await rate(bob, 2.5)).status, 400);
  assert.equal((await rate(bob, '5')).status, 400);
  const own = await rate(alice, 5);
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'OWN_TIMING');

  assert.deepEqual((await rate(bob, 4)).body.rating, { average: 4, count: 1, mine: 4 });
  // A second rating from the same account is an edit, not a second vote.
  assert.deepEqual((await rate(bob, 2)).body.rating, { average: 2, count: 1, mine: 2 });
  assert.deepEqual((await rate(extra[0], 5)).body.rating, { average: 3.5, count: 2, mine: 5 });

  const read = await call('GET', `/timings/${id}/social`, { cookie: bob });
  assert.deepEqual(read.body.rating, { average: 3.5, count: 2, mine: 2 });
  assert.equal(read.body.own, false);
  assert.equal(read.body.minRatings, MIN_RATINGS_TO_RANK);
  assert.equal((await call('GET', `/timings/${id}/social`, { cookie: alice })).body.own, true);
  assert.equal((await call('GET', `/timings/${id}/social`)).body.rating.mine, null);

  assert.deepEqual((await call('DELETE', `/timings/${id}/rating`, { cookie: bob })).body.rating, { average: 5, count: 1, mine: null });

  // Not published: the 404 of a timing that never existed, for reading and rating alike.
  const hidden = await timing({ publish: false });
  assert.equal((await call('GET', `/timings/${hidden}/social`)).status, 404);
  assert.equal((await call('PUT', `/timings/${hidden}/rating`, { cookie: bob, body: { stars: 3 } })).status, 404);
  assert.equal((await call('GET', '/timings/not-an-id/social')).status, 404);
});

test('"I used this": one per account, an optional beatmapset link in its one form, not on your own timing', async () => {
  const id = await timing({ cookie: alice });
  const use = (cookie, beatmapUrl) => call('PUT', `/timings/${id}/use`, { cookie, body: beatmapUrl === undefined ? {} : { beatmapUrl } });

  assert.equal((await use('')).status, 401);
  assert.equal((await use(alice)).body.error.code, 'OWN_TIMING');
  assert.equal((await use(bob, 'https://example.com/beatmapsets/1')).status, 400);
  assert.equal((await use(bob, 'javascript:alert(1)')).body.error.code, 'BAD_BEATMAP_URL');

  let uses = (await use(bob)).body.uses;
  assert.equal(uses.count, 1);
  assert.deepEqual(uses.mine, { beatmapUrl: null });
  // Marking it again changes the link, not the count.
  uses = (await use(bob, 'http://osu.ppy.sh/s/777')).body.uses;
  assert.equal(uses.count, 1);
  assert.deepEqual(uses.mine, { beatmapUrl: 'https://osu.ppy.sh/beatmapsets/777' });
  uses = (await use(extra[1], 'https://osu.ppy.sh/beatmapsets/5#taiko/6')).body.uses;
  assert.equal(uses.count, 2);
  assert.equal(uses.recent.length, 2);
  assert.deepEqual(Object.keys(uses.recent[0]).sort(), ['at', 'beatmapUrl', 'user']);
  assert.deepEqual(Object.keys(uses.recent[0].user).sort(), ['avatarUrl', 'displayName', 'username']);
  assert.ok(uses.recent.some((u) => u.user.username === 'dev_google' && u.beatmapUrl === 'https://osu.ppy.sh/beatmapsets/777'));

  const anon = await call('GET', `/timings/${id}/social`);
  assert.equal(anon.body.uses.count, 2);
  assert.equal(anon.body.uses.mine, null);

  assert.equal((await call('DELETE', `/timings/${id}/use`, { cookie: bob })).body.uses.count, 1);
  assert.equal((await call('DELETE', `/timings/${id}/use`, { cookie: bob, sameOrigin: false })).status, 403);
});

test('recent: each timing carries its stars and uses; best rated needs the minimum and orders by the Bayesian average', async () => {
  const many = await timing({ cookie: '', title: 'Rated by five' });
  const few = await timing({ cookie: '', title: 'Rated by three' });
  const two = await timing({ cookie: '', title: 'Rated by two' });
  const used = await timing({ cookie: '', title: 'Used twice' });
  const voters = [alice, bob, ...extra];
  for (const cookie of voters.slice(0, 5)) await call('PUT', `/timings/${many}/rating`, { cookie, body: { stars: 4 } });
  for (const cookie of voters.slice(0, 3)) await call('PUT', `/timings/${few}/rating`, { cookie, body: { stars: 5 } });
  for (const cookie of voters.slice(0, 2)) await call('PUT', `/timings/${two}/rating`, { cookie, body: { stars: 5 } });
  for (const cookie of voters.slice(0, 2)) await call('PUT', `/timings/${used}/use`, { cookie, body: {} });

  // Published in the same millisecond, the newest four come in any order among themselves.
  const newest = await call('GET', '/timings?limit=4');
  const byId = new Map(newest.body.timings.map((t) => [t.id, t]));
  assert.deepEqual([...byId.keys()].sort(), [used, two, few, many].sort());
  assert.deepEqual(byId.get(two).rating, { average: 5, count: 2 });
  assert.deepEqual(byId.get(many).rating, { average: 4, count: 5 });
  assert.equal(byId.get(used).uses, 2);
  assert.equal(byId.get(many).uses, 0);
  assert.equal(newest.body.minRatings, MIN_RATINGS_TO_RANK);

  const rated = await call('GET', '/timings?sort=rated');
  const ids = rated.body.timings.map((t) => t.id);
  // Two ratings is under the minimum. Five from three people scores (9 + 15) / 6 = 4.0,
  // four from five (9 + 20) / 8 = 3.625: the three agreeing on five still lead.
  assert.ok(!ids.includes(two));
  assert.deepEqual(ids.filter((x) => [many, few].includes(x)), [few, many]);
  assert.ok(rated.body.timings.every((t) => t.rating.count >= MIN_RATINGS_TO_RANK));

  const usedList = await call('GET', '/timings?sort=used');
  assert.equal(usedList.body.timings[0].id, used);
  assert.ok(usedList.body.timings.every((t) => t.uses >= 1));

  // An order by numbers pages by offset.
  const first = await call('GET', '/timings?sort=used&limit=1');
  assert.equal(first.body.next, 'o1');
  const second = await call('GET', `/timings?sort=used&limit=1&cursor=${first.body.next}`);
  assert.notEqual(second.body.timings[0].id, first.body.timings[0].id);
  assert.equal((await call('GET', '/timings?sort=best')).status, 400);
  assert.equal((await call('GET', '/timings?sort=rated&cursor=o99999999')).status, 400);
  // The filters still apply to the orders.
  assert.deepEqual((await call('GET', '/timings?sort=rated&q=five')).body.timings.map((t) => t.id), [many]);
});

test('comments: an account, cleaned and capped text, an optional time inside the song, deleted only by their author', async () => {
  const id = await timing({ cookie: alice });
  const post = (cookie, body, extraBody = {}) => call('POST', `/timings/${id}/comments`, { cookie, body: { body, ...extraBody } });

  assert.equal((await post('', 'hello')).status, 401);
  assert.equal((await call('POST', `/timings/${id}/comments`, { cookie: bob, body: { body: 'x' }, sameOrigin: false })).status, 403);
  assert.equal((await post(bob, '‮​ ')).body.error.code, 'TOO_SHORT');
  assert.equal((await post(bob, 'x'.repeat(1001))).body.error.code, 'TOO_LONG');
  assert.equal((await post(bob, 'late', { atMs: 60_001 })).body.error.code, 'BAD_TIME');

  const first = await post(bob, '  The kick at 0:42 drifts‮ early.\n\n\n\nCheck it.  ', { atMs: 42_000 });
  assert.equal(first.status, 201);
  assert.equal(first.body.comment.body, 'The kick at 0:42 drifts early.\n\nCheck it.');
  assert.equal(first.body.comment.atMs, 42_000);
  assert.equal(first.body.comment.mine, true);
  assert.equal(first.body.comment.author.username, 'dev_google');
  const second = (await post(alice, '<b>Thanks</b>')).body.comment;
  assert.equal(second.body, '<b>Thanks</b>');
  assert.equal(second.atMs, null);

  const list = await call('GET', `/timings/${id}/comments`);
  assert.deepEqual(list.body.items.map((c) => c.id), [first.body.comment.id, second.id]);
  assert.ok(list.body.items.every((c) => c.mine === false));

  // Someone else's comment, or one on another timing, is the 404 of one that is not there.
  assert.equal((await call('DELETE', `/timings/${id}/comments/${second.id}`, { cookie: bob })).status, 404);
  const other = await timing();
  assert.equal((await call('DELETE', `/timings/${other}/comments/${second.id}`, { cookie: alice })).status, 404);
  assert.equal((await call('DELETE', `/timings/${id}/comments/${second.id}`, { cookie: alice })).status, 204);
  assert.equal((await call('GET', `/timings/${id}/comments`)).body.total, 1);

  // Unpublished: its comments go with it, and so does posting.
  await analyses().unpublish(id);
  assert.equal((await call('GET', `/timings/${id}/comments`)).status, 404);
  assert.equal((await post(bob, 'still there?')).status, 404);
  await analyses().publish(id);
  assert.equal((await call('GET', `/timings/${id}/comments`)).body.total, 1);
});

test('comments go through the community moderation: anyone reports, staff hide, the author and staff still see it', async () => {
  const id = await timing({ cookie: alice });
  const comment = (await call('POST', `/timings/${id}/comments`, { cookie: extra[2], body: { body: 'Rude words' } })).body.comment;

  assert.equal((await call('POST', `/community/comments/${comment.id}/report`, { body: { reason: 'rude' } })).status, 204);
  assert.equal((await call('POST', `/community/comments/${comment.id}/moderate`, { cookie: alice, body: { action: 'hide', reason: 'x' } })).status, 403);
  assert.equal((await call('POST', `/community/comments/${comment.id}/moderate`, { cookie: bob, body: { action: 'hide' } })).body.error.code, 'REASON_REQUIRED');

  const panel = await call('GET', '/community/moderation', { cookie: bob });
  const reported = panel.body.reports.find((r) => r.ref === comment.id);
  assert.equal(reported.kind, 'comment');
  assert.equal(reported.timing, id);

  assert.equal((await call('POST', `/community/comments/${comment.id}/moderate`, { cookie: bob, body: { action: 'hide', reason: 'Insults' } })).status, 204);
  assert.equal((await call('GET', `/timings/${id}/comments`)).body.total, 0);
  assert.equal((await call('GET', `/timings/${id}/comments`, { cookie: alice })).body.total, 0);
  const author = (await call('GET', `/timings/${id}/comments`, { cookie: extra[2] })).body.items[0];
  assert.equal(author.hidden, true);
  assert.equal(author.hiddenReason, undefined);
  const staff = (await call('GET', `/timings/${id}/comments`, { cookie: bob })).body.items[0];
  assert.equal(staff.hiddenReason, 'Insults');
  // A hidden comment cannot be reported by someone who cannot see it.
  assert.equal((await call('POST', `/community/comments/${comment.id}/report`, { cookie: alice, body: { reason: 'again' } })).status, 404);
  const log = (await call('GET', '/community/moderation', { cookie: bob })).body.log;
  assert.ok(log.some((e) => e.kind === 'comment' && e.ref === comment.id && e.action === 'hide' && e.timing === id));
  assert.ok(!(await call('GET', '/community/moderation', { cookie: bob })).body.reports.some((r) => r.ref === comment.id));

  // A comment on a timing taken back cannot be reported or moderated.
  await analyses().unpublish(id);
  assert.equal((await call('POST', `/community/comments/${comment.id}/moderate`, { cookie: bob, body: { action: 'unhide' } })).status, 404);
  await analyses().publish(id);
});

test('collections: private until made public, the 404 of a missing one for anyone else, published timings only', async () => {
  const a = await timing();
  const b = await timing();
  const made = await call('POST', '/collections', { cookie: alice, body: { name: '  My mapset  ' } });
  assert.equal(made.status, 201);
  const c = made.body.collection;
  assert.equal(c.name, 'My mapset');
  assert.equal(c.public, false);

  assert.equal((await call('POST', '/collections', { body: { name: 'x' } })).status, 401);
  assert.equal((await call('POST', '/collections', { cookie: alice, body: { name: '' } })).body.error.code, 'TOO_SHORT');
  assert.equal((await call('POST', '/collections', { cookie: alice, body: { name: 'x'.repeat(81) } })).body.error.code, 'TOO_LONG');
  assert.equal((await call('POST', '/collections', { cookie: alice, body: { name: 'x', public: 'yes' } })).body.error.code, 'BAD_FLAG');

  // Private: nobody else reads or changes it.
  for (const cookie of ['', bob]) assert.equal((await call('GET', `/collections/${c.id}`, { cookie })).status, 404);
  assert.equal((await call('PUT', `/collections/${c.id}/items/${a}`, { cookie: bob })).status, 404);
  assert.equal((await call('PATCH', `/collections/${c.id}`, { cookie: bob, body: { public: true } })).status, 404);
  assert.equal((await call('DELETE', `/collections/${c.id}`, { cookie: bob })).status, 404);

  assert.equal((await call('PUT', `/collections/${c.id}/items/${a}`, { cookie: alice })).status, 201);
  assert.equal((await call('PUT', `/collections/${c.id}/items/${a}`, { cookie: alice })).status, 200);
  assert.equal((await call('PUT', `/collections/${c.id}/items/${b}`, { cookie: alice, sameOrigin: false })).status, 403);
  assert.equal((await call('PUT', `/collections/${c.id}/items/${b}`, { cookie: alice })).status, 201);
  const unpublished = await timing({ publish: false });
  assert.equal((await call('PUT', `/collections/${c.id}/items/${unpublished}`, { cookie: alice })).status, 404);

  const mine = await call('GET', `/me/collections?timing=${a}`, { cookie: alice });
  assert.equal(mine.body.collections.find((x) => x.id === c.id).has, true);
  assert.equal((await call('GET', `/me/collections?timing=${unpublished}`, { cookie: alice })).body.collections.find((x) => x.id === c.id).has, false);
  assert.equal((await call('GET', '/me/collections')).status, 401);

  const own = await call('GET', `/collections/${c.id}`, { cookie: alice });
  assert.deepEqual(own.body.timings.map((t) => t.id), [b, a]);
  assert.equal(own.body.collection.mine, true);

  assert.equal((await call('PATCH', `/collections/${c.id}`, { cookie: alice, body: { public: true, name: 'Shared' } })).body.collection.public, true);
  const shared = await call('GET', `/collections/${c.id}`);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.collection.name, 'Shared');
  assert.equal(shared.body.collection.mine, false);
  assert.equal(shared.body.collection.owner.username, 'dev_discord');

  // A timing taken back leaves the page and the count, and comes back with it.
  await analyses().unpublish(b);
  const after1 = (await call('GET', `/collections/${c.id}`)).body;
  assert.deepEqual(after1.timings.map((t) => t.id), [a]);
  assert.equal(after1.collection.count, 1);
  await analyses().publish(b);

  assert.equal((await call('DELETE', `/collections/${c.id}/items/${a}`, { cookie: alice })).status, 204);
  assert.equal((await call('DELETE', `/collections/${c.id}/items/${a}`, { cookie: alice })).status, 404);
  assert.equal((await call('DELETE', `/collections/${c.id}`, { cookie: alice })).status, 204);
  assert.equal((await call('GET', `/collections/${c.id}`, { cookie: alice })).status, 404);
});

test('collections are capped per account, in the store', async () => {
  const account = await accountOf(extra[4]);
  for (let i = 0; i < COLLECTIONS_PER_ACCOUNT; i += 1) {
    await social().createCollection({ publicId: newPublicId(), accountId: account.id, name: `List ${i}`, isPublic: false });
  }
  await assert.rejects(
    social().createCollection({ publicId: newPublicId(), accountId: account.id, name: 'One too many', isPublic: false }),
    (error) => error.code === 'LIMIT' && error.status === 409,
  );
});

test('a profile shows what its timer published, their totals and badges; a private one is a 404 to all but them', async () => {
  // carol: two published timings, one unpublished, one private upload, and an anonymous one nobody can tie to her.
  const carol = extra[0];
  const p1 = await timing({ cookie: carol, title: 'Carol one' });
  const p2 = await timing({ cookie: carol, title: 'Carol two' });
  await timing({ cookie: carol, title: 'Carol draft', publish: false });
  await timing({ cookie: carol, title: 'Carol secret', publish: false, isPrivate: true });
  await call('PUT', `/timings/${p1}/rating`, { cookie: alice, body: { stars: 5 } });
  await call('PUT', `/timings/${p2}/rating`, { cookie: bob, body: { stars: 2 } });
  await call('PUT', `/timings/${p1}/use`, { cookie: alice, body: {} });

  const profile = await call('GET', '/users/CAROL');
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body.user, { username: 'carol', displayName: 'CAROL', avatarUrl: null, bannerUrl: null });
  assert.deepEqual(profile.body.totals, { timed: 3, published: 2, uses: 1, rating: { average: 3.5, count: 2 } });
  assert.deepEqual(profile.body.badges, ['first-timing', 'used-by-others']);
  assert.equal(profile.body.mine, false);
  assert.equal(profile.body.private, undefined);

  const list = await call('GET', '/users/carol/timings');
  assert.deepEqual(list.body.timings.map((t) => t.id).sort(), [p1, p2].sort());
  assert.ok(list.body.timings.every((t) => t.uploader.username === 'carol'));
  assert.deepEqual((await call('GET', '/users/carol/timings?sort=rated')).body.timings, []);

  for (const name of ['nobody', 'a b', '..%2f', 'x'.repeat(41)]) assert.equal((await call('GET', `/users/${name}`)).status, 404, name);

  // The private switch: the owner's own, the same-origin header, a boolean.
  assert.equal((await call('PUT', '/me/profile', { cookie: carol, body: { private: 'yes' } })).status, 400);
  assert.equal((await call('PUT', '/me/profile', { cookie: carol, body: { private: true }, sameOrigin: false })).status, 403);
  assert.equal((await call('PUT', '/me/profile', { body: { private: true } })).status, 401);
  assert.deepEqual((await call('PUT', '/me/profile', { cookie: carol, body: { private: true } })).body, { private: true });
  for (const cookie of ['', alice, bob]) {
    assert.equal((await call('GET', '/users/carol', { cookie })).status, 404);
    assert.equal((await call('GET', '/users/carol/timings', { cookie })).status, 404);
  }
  const self = await call('GET', '/users/carol', { cookie: carol });
  assert.equal(self.body.private, true);
  assert.equal((await call('GET', '/me/profile', { cookie: carol })).body.private, true);
  assert.equal((await call('GET', '/me', { cookie: carol })).body.account.profilePrivate, true);
  // Her timings stay published, and their page no longer links to a profile that is a 404.
  assert.equal((await call('GET', `/timings/${p1}`)).status, 200);
  assert.equal((await call('GET', `/timings/${p1}/social`)).body.uploaderProfile, false);
  await call('PUT', '/me/profile', { cookie: carol, body: { private: false } });
  assert.equal((await call('GET', `/timings/${p1}/social`)).body.uploaderProfile, true);
  assert.equal((await call('GET', '/users/carol')).status, 200);
});

test('an accepted suggestion and public collections show on the profile; private collections do not', async () => {
  const dave = extra[1];
  await timing({ cookie: dave });
  const s = await call('POST', '/community/suggestions', { cookie: dave, body: { title: 'Dark mode', body: 'Please.' } });
  assert.equal((await call('GET', '/users/dave')).body.badges.includes('suggestion-accepted'), false);
  await call('POST', `/community/suggestions/${s.body.suggestion.id}/state`, { cookie: bob, body: { state: 'planned' } });
  assert.ok((await call('GET', '/users/dave')).body.badges.includes('suggestion-accepted'));

  const open = (await call('POST', '/collections', { cookie: dave, body: { name: 'Open list', public: true } })).body.collection;
  await call('POST', '/collections', { cookie: dave, body: { name: 'Closed list' } });
  const profile = (await call('GET', '/users/dave')).body;
  assert.deepEqual(profile.collections.map((c) => c.id), [open.id]);
  const me = (await call('GET', '/me/collections', { cookie: dave })).body;
  assert.equal(me.collections.length, 2);
});

test('the ranking of timers: by uses or by stars, a minimum to enter, private profiles left out', async () => {
  // erin: three uses by others and five ratings; frank: one use. gina rates and uses, and publishes nothing.
  const erin = extra[2];
  const frank = extra[3];
  const t1 = await timing({ cookie: erin });
  const t2 = await timing({ cookie: erin });
  const f1 = await timing({ cookie: frank });
  for (const cookie of [alice, bob, extra[4]]) await call('PUT', `/timings/${t1}/use`, { cookie, body: {} });
  for (const cookie of [alice, bob, extra[0], extra[1], extra[4]]) await call('PUT', `/timings/${t2}/rating`, { cookie, body: { stars: 4 } });
  await call('PUT', `/timings/${f1}/use`, { cookie: alice, body: {} });

  const byUses = await call('GET', '/timers');
  assert.equal(byUses.body.by, 'uses');
  assert.deepEqual(byUses.body.min, { uses: TIMER_MIN_USES, ratings: TIMER_MIN_RATINGS });
  const erinRow = byUses.body.timers.find((r) => r.user.username === 'erin');
  assert.deepEqual(erinRow, {
    user: { username: 'erin', displayName: 'ERIN', avatarUrl: null }, published: 2, uses: 3, rating: { average: 4, count: 5 },
  });
  assert.ok(!byUses.body.timers.some((r) => r.user.username === 'frank'));
  assert.ok(byUses.body.timers.every((r) => r.uses >= TIMER_MIN_USES));

  const byStars = await call('GET', '/timers?by=stars');
  assert.ok(byStars.body.timers.some((r) => r.user.username === 'erin'));
  assert.ok(byStars.body.timers.every((r) => r.rating.count >= TIMER_MIN_RATINGS));
  assert.equal((await call('GET', '/timers?by=nonsense')).body.by, 'uses');

  await call('PUT', '/me/profile', { cookie: erin, body: { private: true } });
  assert.ok(!(await call('GET', '/timers')).body.timers.some((r) => r.user.username === 'erin'));
  await call('PUT', '/me/profile', { cookie: erin, body: { private: false } });
});

test('nothing this file read carried an upload\'s SHA-1, address hash or anonymous hash', async () => {
  // A last look at the pages an anonymous timing appears on.
  const anon = await timing({ cookie: '' });
  await call('PUT', `/timings/${anon}/use`, { cookie: bob, body: {} });
  await call('GET', `/timings/${anon}/social`);
  await call('GET', '/timings?sort=used');
  await call('GET', '/timers?by=stars');
  assert.ok(secrets.length > 20);
  const all = seen.join('\n');
  for (const secret of secrets) assert.ok(!all.includes(secret), `a response carried ${secret}`);
  for (const key of ['sha1', 'anonHash', 'anon_hash', 'ipHash', 'ip_hash', 'accountId', 'account_id']) {
    assert.ok(!all.includes(`"${key}"`), `a response named ${key}`);
  }
});
