import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-visits-'));
const { app } = await import('../src/app.js');
const { setProfileFields, upsertFromMides } = await import('../src/services/account.service.js');
const { COOKIE, issue } = await import('../src/services/session.service.js');
const { resetVisitMemory, utcDay, VISIT_DAYS, visits } = await import('../src/services/visit.service.js');
const { clearStatsCache } = await import('../src/routes/stats.routes.js');

/**
 * Profile visits (2026-10-28), over HTTP on the memory store: one per visitor
 * per profile per UTC day, never the owner's own, never a private profile's,
 * only through the page's POST with the same-origin header, and no visitor
 * hash leaving in any answer.
 */

let server;
let base;
const people = {};
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  for (const name of ['vera', 'walt', 'xena', 'yuri']) {
    const row = await upsertFromMides({
      midesUserId: `visit-${name}`, username: name, displayName: name.toUpperCase(), avatarUrl: null, bannerUrl: null, discordId: null, role: null,
    });
    people[name] = { id: row.id, cookie: `${COOKIE}=${issue(row.id, row.session_version)}` };
  }
});
after(() => server.close());
beforeEach(() => resetVisitMemory());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };

const call = async (method, path, { cookie = '', sameOrigin = true, agent } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(sameOrigin ? SAME_ORIGIN : {}), ...(cookie ? { Cookie: cookie } : {}), ...(agent ? { 'User-Agent': agent } : {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
};

const visit = (username, options) => call('POST', `/users/${username}/visit`, options);
const shown = async (username) => (await call('GET', `/users/${username}`)).body.visits;

test('one visit per visitor per profile per UTC day: a reload is not a second one', async () => {
  const first = await visit('vera');
  assert.equal(first.status, 200);
  assert.equal(first.body.counted, true);
  assert.deepEqual(first.body.visits, { total: 1, recent: 1, days: VISIT_DAYS });
  // The same anonymous address again, and again: still one.
  assert.equal((await visit('vera')).body.counted, false);
  assert.equal((await visit('vera')).body.counted, false);
  // Two signed-in visitors are two more; each of them reloading is not.
  assert.equal((await visit('vera', { cookie: people.walt.cookie })).body.counted, true);
  assert.equal((await visit('vera', { cookie: people.walt.cookie })).body.counted, false);
  assert.equal((await visit('vera', { cookie: people.xena.cookie })).body.counted, true);
  assert.deepEqual(await shown('vera'), { total: 3, recent: 3, days: VISIT_DAYS });
  // Another profile counts apart.
  assert.equal((await visit('walt', { cookie: people.xena.cookie })).body.counted, true);
  assert.equal((await shown('walt')).total, 1);
  assert.equal((await shown('vera')).total, 3);
});

test('the next UTC day the same visitor counts again, and the recent window ends after its days', async () => {
  const { id } = people.yuri;
  const today = utcDay();
  const day = (n) => utcDay(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000);
  assert.equal(await visits().record(id, 'a'.repeat(64), day(0)), true);
  assert.equal(await visits().record(id, 'a'.repeat(64), day(0)), false);
  assert.equal(await visits().record(id, 'a'.repeat(64), day(1)), true);
  // Old days: they stay in the total and leave the recent count.
  assert.equal(await visits().record(id, 'b'.repeat(64), day(VISIT_DAYS - 1)), true);
  assert.equal(await visits().record(id, 'b'.repeat(64), day(VISIT_DAYS)), true);
  assert.equal(await visits().record(id, 'b'.repeat(64), day(400)), true);
  assert.deepEqual(await visits().of(id, today), { total: 5, recent: 3 });
  assert.equal(await visits().total(), 5);
});

test('the owner looking at their own profile is not a visit', async () => {
  const own = await visit('xena', { cookie: people.xena.cookie });
  assert.equal(own.status, 200);
  assert.equal(own.body.counted, false);
  assert.equal(own.body.visits.total, 0);
  // Their own view shows the count others made.
  assert.equal((await visit('xena')).body.counted, true);
  assert.equal((await call('GET', '/me/profile', { cookie: people.xena.cookie })).body.visits.total, 1);
});

test('a private profile counts nothing and shows nothing, to its owner either', async () => {
  await setProfileFields(people.walt.id, { private: true });
  try {
    assert.equal((await visit('walt')).status, 404);
    assert.equal((await visit('walt', { cookie: people.vera.cookie })).status, 404);
    const own = await visit('walt', { cookie: people.walt.cookie });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body, { counted: false, visits: null });
    assert.equal((await call('GET', '/users/walt', { cookie: people.walt.cookie })).body.visits, null);
    assert.equal(await visits().total(), 0);
  } finally {
    await setProfileFields(people.walt.id, { private: false });
  }
});

test('a visit is a POST with the same-origin header: a GET, a bare POST or a bot counts nothing', async () => {
  const bare = await visit('vera', { sameOrigin: false });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.error.code, 'CSRF_HEADER_MISSING');
  assert.equal((await call('GET', '/users/vera/visit')).status, 404);
  // The profile itself and the link preview's card read without counting.
  await call('GET', '/users/vera');
  await call('GET', '/users/vera/card');
  const bot = await visit('vera', { agent: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' });
  assert.equal(bot.body.counted, false);
  assert.equal((await shown('vera')).total, 0);
  assert.equal((await visit('nobody_here')).status, 404);
});

test('no visitor hash leaves: the answers carry counts only', async () => {
  const answer = await visit('vera', { cookie: people.walt.cookie });
  assert.deepEqual(Object.keys(answer.body).sort(), ['counted', 'visits']);
  assert.deepEqual(Object.keys(answer.body.visits).sort(), ['days', 'recent', 'total']);
  assert.equal(/[0-9a-f]{32}/.test(answer.text), false);
});

test('/stats adds every profile visit up, as one number', async () => {
  await visit('vera');
  await visit('walt');
  await visit('walt', { cookie: people.vera.cookie });
  clearStatsCache();
  const body = await (await fetch(`${base}/stats`)).json();
  assert.deepEqual(body.profileVisits, { total: 3 });
});
