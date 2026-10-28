import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-community-'));
const { app } = await import('../src/app.js');
const { formToken, formTokenOk, MIN_FORM_MS, MAX_FORM_MS, SUGGESTION_MAX, TITLE_MAX } = await import('../src/routes/community.routes.js');
const { ANON_REVIEWS_PER_DAY, resetMemory, summarize } = await import('../src/services/community.service.js');
const { cleanText } = await import('../src/utils/text.js');

let server;
let base;
let staff;
let member;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  staff = await signIn('google');
  member = await signIn('discord');
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

/** Signs in through MIDES_DEV_LOGIN; the Google dev user is a moderator, the Discord one is not. */
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

const call = (method, path, { cookie = '', body, sameOrigin = true } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(sameOrigin ? SAME_ORIGIN : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const json = async (response) => ({ status: response.status, body: response.status === 204 ? null : await response.json() });

const suggest = async (title, cookie = member, body = 'A longer explanation of the idea.') => {
  const { status, body: data } = await json(await call('POST', '/community/suggestions', { cookie, body: { title, body } }));
  assert.equal(status, 201);
  return data.suggestion;
};

const list = async (query = '', cookie = '') => (await json(await call('GET', `/community/suggestions${query}`, { cookie }))).body;

test('text is cleaned of controls and bidi marks, keeps its line breaks where allowed, and is capped', () => {
  // An RLO would turn "abc‮def" around on screen.
  assert.equal(cleanText('  a\u0000b‮c​d﻿  ', 100), 'a bcd');
  assert.equal(cleanText('one\r\ntwo\n\n\n\nthree\u0007', 100, { multiline: true }), 'one\ntwo\n\nthree');
  assert.equal(cleanText('one\ntwo', 100), 'one two');
  assert.equal(cleanText('<b>kept as text</b>', 100), '<b>kept as text</b>');
  assert.equal(cleanText('😀😀😀', 2), '😀😀');
  assert.equal(cleanText('‮​', 10), null);
  assert.equal(cleanText(42, 10), null);
});

test('reading needs nothing; posting a suggestion needs an account, the same-origin header and sane lengths', async () => {
  resetMemory();
  assert.equal((await call('GET', '/community/suggestions')).status, 200);
  assert.equal((await call('POST', '/community/suggestions', { body: { title: 'Anonymous idea', body: 'x' } })).status, 401);
  assert.equal(
    (await call('POST', '/community/suggestions', { cookie: member, sameOrigin: false, body: { title: 'No header', body: 'x' } })).status,
    403,
  );

  const short = await json(await call('POST', '/community/suggestions', { cookie: member, body: { title: ' ​ab ', body: 'x' } }));
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'TOO_SHORT');
  const long = await json(await call('POST', '/community/suggestions', { cookie: member, body: { title: 'Fine', body: 'x'.repeat(SUGGESTION_MAX + 1) } }));
  assert.equal(long.body.error.code, 'TOO_LONG');
  const longTitle = await json(await call('POST', '/community/suggestions', { cookie: member, body: { title: 'x'.repeat(TITLE_MAX + 1), body: 'x' } }));
  assert.equal(longTitle.body.error.code, 'TOO_LONG');
  assert.equal((await call('POST', '/community/suggestions', { cookie: member, body: { title: 'Fine', body: 7 } })).status, 400);

  const made = await suggest('Dark  ‮mode\u0000', member, 'line one\r\n\r\n\r\nline two');
  assert.equal(made.title, 'Dark mode');
  assert.equal(made.body, 'line one\n\nline two');
  assert.equal(made.state, 'open');
  assert.equal(made.mine, true);
  assert.equal(made.author.username, 'dev_discord');
  assert.ok(!('accountId' in made) && !('reports' in made));
});

test('one vote per account, taken back with DELETE; anonymous visitors cannot vote', async () => {
  resetMemory();
  const s = await suggest('Vote on me');
  const path = `/community/suggestions/${s.id}/vote`;
  assert.equal((await call('PUT', path)).status, 401);
  assert.deepEqual((await json(await call('PUT', path, { cookie: member }))).body, { votes: 1, voted: true });
  assert.deepEqual((await json(await call('PUT', path, { cookie: member }))).body, { votes: 1, voted: true });
  assert.deepEqual((await json(await call('PUT', path, { cookie: staff }))).body, { votes: 2, voted: true });
  assert.deepEqual((await json(await call('DELETE', path, { cookie: member }))).body, { votes: 1, voted: false });
  assert.equal((await call('PUT', '/community/suggestions/0123456789abcdef0123456789abcdef/vote', { cookie: member })).status, 404);
  assert.equal((await call('PUT', '/community/suggestions/not-an-id/vote', { cookie: member })).status, 404);

  const [item] = (await list('', staff)).items;
  assert.equal(item.voted, true);
  assert.equal((await list('', member)).items[0].voted, false);
});

test('suggestions sort by votes or by date and filter by state', async () => {
  resetMemory();
  const a = await suggest('First idea');
  const b = await suggest('Second idea');
  const c = await suggest('Third idea');
  await call('PUT', `/community/suggestions/${b.id}/vote`, { cookie: member });
  await call('PUT', `/community/suggestions/${b.id}/vote`, { cookie: staff });
  await call('PUT', `/community/suggestions/${a.id}/vote`, { cookie: member });

  assert.deepEqual((await list('?sort=votes')).items.map((s) => s.id), [b.id, a.id, c.id]);
  assert.deepEqual((await list('?sort=new')).items.map((s) => s.id), [c.id, b.id, a.id]);
  // An unknown sort falls back to votes rather than reaching the store.
  assert.deepEqual((await list('?sort=drop%20table')).items.map((s) => s.id), [b.id, a.id, c.id]);

  await call('POST', `/community/suggestions/${c.id}/state`, { cookie: staff, body: { state: 'planned' } });
  const planned = await list('?state=planned');
  assert.deepEqual(planned.items.map((s) => s.id), [c.id]);
  assert.equal(planned.total, 1);
  assert.equal((await list('?state=open')).total, 2);
  assert.equal((await list('?state=bogus')).total, 3);
});

test('only staff change a state; a rejection needs a reason; every change is on the suggestion for anyone to read', async () => {
  resetMemory();
  const s = await suggest('Change my state');
  const path = `/community/suggestions/${s.id}/state`;
  assert.equal((await call('POST', path, { body: { state: 'review' } })).status, 401);
  const refused = await json(await call('POST', path, { cookie: member, body: { state: 'done' } }));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'STAFF_ONLY');
  assert.equal((await call('POST', path, { cookie: staff, sameOrigin: false, body: { state: 'review' } })).status, 403);
  assert.equal((await json(await call('POST', path, { cookie: staff, body: { state: 'shipped' } }))).body.error.code, 'BAD_STATE');
  assert.equal((await json(await call('POST', path, { cookie: staff, body: { state: 'open' } }))).body.error.code, 'SAME_STATE');

  assert.deepEqual((await json(await call('POST', path, { cookie: staff, body: { state: 'review' } }))).body, { from: 'open', to: 'review' });
  const noReason = await json(await call('POST', path, { cookie: staff, body: { state: 'rejected', reason: ' ​ ' } }));
  assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
  await call('POST', path, { cookie: staff, body: { state: 'rejected', reason: 'Out of scope‮ for now' } });

  const { suggestion, history } = (await json(await call('GET', `/community/suggestions/${s.id}`))).body;
  assert.equal(suggestion.state, 'rejected');
  assert.equal(suggestion.stateReason, 'Out of scope for now');
  assert.equal(history.length, 2);
  assert.deepEqual({ ...history[0], at: undefined }, {
    action: 'state', from: 'review', to: 'rejected', reason: 'Out of scope for now', moderator: 'dev_google', at: undefined,
  });
  assert.equal(history[1].from, 'open');
  assert.equal(history[1].reason, null);
  assert.ok(Date.parse(history[0].at) >= Date.parse(history[1].at));
});

test('a hidden suggestion is gone for everyone but staff and its author, and hiding is logged with its reason', async () => {
  resetMemory();
  const s = await suggest('Something to hide');
  const kept = await suggest('Something to keep');
  const path = `/community/suggestions/${s.id}/moderate`;
  assert.equal((await call('POST', path, { cookie: member, body: { action: 'hide', reason: 'mine' } })).status, 403);
  assert.equal((await json(await call('POST', path, { cookie: staff, body: { action: 'hide' } }))).body.error.code, 'REASON_REQUIRED');
  assert.equal((await json(await call('POST', path, { cookie: staff, body: { action: 'delete', reason: 'x' } }))).body.error.code, 'BAD_ACTION');
  assert.equal((await call('POST', path, { cookie: staff, body: { action: 'hide', reason: 'Spam' } })).status, 204);
  assert.equal((await json(await call('POST', path, { cookie: staff, body: { action: 'hide', reason: 'Again' } }))).body.error.code, 'NO_CHANGE');

  // Anonymous readers: not listed, and every route answers as if it never existed.
  assert.deepEqual((await list()).items.map((x) => x.id), [kept.id]);
  assert.equal((await list()).total, 1);
  assert.equal((await call('GET', `/community/suggestions/${s.id}`)).status, 404);
  assert.equal((await call('POST', `/community/suggestions/${s.id}/report`, { body: { reason: 'x' } })).status, 404);
  // Its author still opens it, marked hidden, but it is not in their list either.
  const own = (await json(await call('GET', `/community/suggestions/${s.id}`, { cookie: member }))).body.suggestion;
  assert.equal(own.hidden, true);
  assert.ok(!('hiddenReason' in own));
  assert.equal((await list('', member)).total, 1);
  // Staff see it, with why.
  const asStaff = await list('', staff);
  assert.equal(asStaff.staff, true);
  const row = asStaff.items.find((x) => x.id === s.id);
  assert.equal(row.hidden, true);
  assert.equal(row.hiddenReason, 'Spam');
  // The public history leaves the hide out; staff see it.
  assert.deepEqual((await json(await call('GET', `/community/suggestions/${s.id}`, { cookie: member }))).body.history, []);
  const staffHistory = (await json(await call('GET', `/community/suggestions/${s.id}`, { cookie: staff }))).body.history;
  assert.equal(staffHistory[0].action, 'hide');

  assert.equal((await call('POST', path, { cookie: staff, body: { action: 'unhide' } })).status, 204);
  assert.equal((await list()).total, 2);

  assert.equal((await call('GET', '/community/moderation', { cookie: member })).status, 403);
  const { log } = (await json(await call('GET', '/community/moderation', { cookie: staff }))).body;
  assert.deepEqual(log.map((e) => [e.action, e.kind, e.ref, e.reason, e.moderator]), [
    ['unhide', 'suggestion', s.id, null, 'dev_google'],
    ['hide', 'suggestion', s.id, 'Spam', 'dev_google'],
  ]);
});

test('anyone can report, once per person and item; staff see the open reports until they decide', async () => {
  resetMemory();
  const s = await suggest('Report me');
  const path = `/community/suggestions/${s.id}/report`;
  assert.equal((await call('POST', path, { body: { reason: 'Rude' }, sameOrigin: false })).status, 403);
  assert.equal((await json(await call('POST', path, { body: {} }))).body.error.code, 'TOO_SHORT');
  assert.equal((await call('POST', path, { body: { reason: 'Rude' } })).status, 204);
  assert.equal((await call('POST', path, { body: { reason: 'Rude again' } })).status, 204);
  assert.equal((await call('POST', path, { cookie: member, body: { reason: 'Off-topic' } })).status, 204);
  assert.equal((await call('POST', '/community/things/0123456789abcdef0123456789abcdef/report', { body: { reason: 'x' } })).status, 404);

  // Two people reported: the anonymous address once, the member once.
  assert.equal((await list('', staff)).items[0].reports, 2);
  assert.ok(!('reports' in (await list('', member)).items[0]));
  const { reports } = (await json(await call('GET', '/community/moderation', { cookie: staff }))).body;
  assert.deepEqual(reports.map((r) => [r.kind, r.ref, r.count]), [['suggestion', s.id, 2]]);
  assert.deepEqual(reports[0].reasons.sort(), ['Off-topic', 'Rude']);

  await call('POST', `/community/suggestions/${s.id}/moderate`, { cookie: staff, body: { action: 'hide', reason: 'Rude' } });
  assert.deepEqual((await json(await call('GET', '/community/moderation', { cookie: staff }))).body.reports, []);
});

test('one review per account, edited in place and deleted by its author', async () => {
  resetMemory();
  const first = await json(await call('POST', '/community/reviews', { cookie: member, body: { stars: 4, body: 'Good tool' } }));
  assert.equal(first.status, 201);
  assert.equal(first.body.review.anonymous, false);
  assert.equal(first.body.review.author.username, 'dev_discord');
  const edit = await json(await call('POST', '/community/reviews', { cookie: member, body: { stars: 5, body: 'Great tool' } }));
  assert.equal(edit.status, 200);
  assert.equal(edit.body.review.id, first.body.review.id);

  for (const stars of [0, 6, 4.5, '5', null]) {
    const bad = await json(await call('POST', '/community/reviews', { cookie: member, body: { stars, body: 'x' } }));
    assert.equal(bad.body.error.code, 'BAD_STARS', String(stars));
  }
  assert.equal((await json(await call('POST', '/community/reviews', { cookie: member, body: { stars: 3, body: '' } }))).body.error.code, 'TOO_SHORT');

  const page = (await json(await call('GET', '/community/reviews', { cookie: member }))).body;
  assert.equal(page.total, 1);
  assert.equal(page.items[0].body, 'Great tool');
  assert.equal(page.mine.id, first.body.review.id);
  assert.equal(page.mine.mine, true);

  assert.equal((await call('DELETE', '/community/reviews/mine')).status, 401);
  assert.equal((await call('DELETE', '/community/reviews/mine', { cookie: member })).status, 204);
  assert.equal((await call('DELETE', '/community/reviews/mine', { cookie: member })).status, 404);
  assert.equal((await json(await call('GET', '/community/reviews'))).body.total, 0);
});

test('an anonymous review needs the form token, an empty honeypot, and stays within the daily count per address', async () => {
  resetMemory();
  const send = (body) => call('POST', '/community/reviews', { body: { stars: 3, body: 'Anonymous words', ...body } });
  const aged = formToken(Date.now() - MIN_FORM_MS - 1000);

  assert.equal((await json(await send({}))).body.error.code, 'FORM_TOO_FAST');
  // A token made just now is a form filled faster than a person could.
  assert.equal((await json(await send({ token: formToken() }))).body.error.code, 'FORM_TOO_FAST');
  assert.equal((await json(await send({ token: aged, website: 'http://spam.example' }))).body.error.code, 'NOT_ACCEPTED');

  for (let i = 0; i < ANON_REVIEWS_PER_DAY; i += 1) {
    const ok = await json(await send({ token: aged, stars: 1 }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.review.anonymous, true);
    assert.equal(ok.body.review.author, null);
    assert.ok(!JSON.stringify(ok.body).includes('ip'));
  }
  const over = await json(await send({ token: aged }));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'REVIEW_LIMIT');

  // A signed-in review is not held to the anonymous count.
  assert.equal((await call('POST', '/community/reviews', { cookie: member, body: { stars: 5, body: 'Signed in' } })).status, 201);
  const { stats } = (await json(await call('GET', '/community/reviews'))).body;
  assert.deepEqual(stats.distribution, [2, 0, 0, 0, 1]);
  assert.equal(stats.count, 3);
  assert.equal(stats.anonymous, 2);
  // Anonymous reviews count half: (1*0.5 + 1*0.5 + 5) / 2 = 3.
  assert.equal(stats.average, 3);
});

test('a hidden review is out of the list and the average for everyone but staff and its author', async () => {
  resetMemory();
  await call('POST', '/community/reviews', { cookie: staff, body: { stars: 5, body: 'From staff' } });
  const { review } = (await json(await call('POST', '/community/reviews', { cookie: member, body: { stars: 1, body: 'Rant' } }))).body;
  const path = `/community/reviews/${review.id}/moderate`;
  assert.equal((await call('POST', path, { cookie: member, body: { action: 'hide', reason: 'x' } })).status, 403);
  assert.equal((await call('POST', path, { cookie: staff, body: { action: 'hide', reason: 'Abuse' } })).status, 204);

  const anon = (await json(await call('GET', '/community/reviews'))).body;
  assert.equal(anon.total, 1);
  assert.equal(anon.stats.average, 5);
  assert.equal((await call('POST', `/community/reviews/${review.id}/report`, { body: { reason: 'x' } })).status, 404);
  const author = (await json(await call('GET', '/community/reviews', { cookie: member }))).body;
  assert.equal(author.total, 1);
  assert.equal(author.mine.hidden, true);
  // Editing does not undo a moderator's hide.
  await call('POST', '/community/reviews', { cookie: member, body: { stars: 2, body: 'Calmer' } });
  assert.equal((await json(await call('GET', '/community/reviews', { cookie: member }))).body.mine.hidden, true);

  const asStaff = (await json(await call('GET', '/community/reviews', { cookie: staff }))).body;
  assert.equal(asStaff.total, 2);
  assert.equal(asStaff.items.find((r) => r.id === review.id).hiddenReason, 'Abuse');
});

test('the form token is refused when forged, expired or malformed', () => {
  const now = Date.now();
  const issued = now - MIN_FORM_MS - 1;
  assert.equal(formTokenOk(formToken(issued), now), true);
  assert.equal(formTokenOk(formToken(now - MAX_FORM_MS - 1), now), false);
  assert.equal(formTokenOk(`${issued}.${'A'.repeat(43)}`, now), false);
  assert.equal(formTokenOk(`${issued - 1}.${formToken(issued).split('.')[1]}`, now), false);
  for (const bad of [undefined, '', 'x', '1.2.3', 'x'.repeat(200)]) assert.equal(formTokenOk(bad, now), false);
});

test('the average weighs anonymous reviews at half and says how many there are', () => {
  assert.deepEqual(summarize([]), { count: 0, anonymous: 0, average: null, distribution: [0, 0, 0, 0, 0] });
  assert.deepEqual(summarize([{ stars: 4, anonymous: false }, { stars: 1, anonymous: true }]), {
    count: 2, anonymous: 1, average: 3, distribution: [1, 0, 0, 1, 0],
  });
});
