import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
Object.assign(process.env, {
  NODE_ENV: 'development',
  MIDES_DEV_LOGIN: '1',
  SPOOL_DIR: mkdtempSync(join(tmpdir(), 'overtone-notify-')),
  WORKER_TOKEN: 'n'.repeat(40),
});
const { app } = await import('../src/app.js');
const { analyses, newPublicId } = await import('../src/services/analysis.service.js');
const { upsertFromMides } = await import('../src/services/account.service.js');
const { COOKIE, issue } = await import('../src/services/session.service.js');
const { notify, SAME_SITE, targetOf } = await import('../src/services/notification.service.js');

/**
 * The notification panel (W13.17's second pass), over HTTP on the memory
 * store: read and unread marks, deleting one and every read one, the kind
 * filter and paging, where each notification leads, the staff's own
 * notifications, and that every one of these touches only the session's
 * account.
 */

let server;
let base;
let staff; // the Google dev user: a moderator
const people = {};
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  staff = await signIn('google');
  for (const name of ['erin', 'frank', 'grace']) {
    const row = await upsertFromMides({
      midesUserId: `notify-${name}`, username: name, displayName: name, avatarUrl: null, bannerUrl: null, discordId: null, role: null,
    });
    people[name] = { cookie: `${COOKIE}=${issue(row.id, row.session_version)}`, id: row.id };
  }
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

async function signIn(provider) {
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
}

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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const hex = (seed) => createHash('md5').update(String(seed)).digest('hex');
const inbox = async (cookie, query = '') => (await call('GET', `/me/notifications${query}`, { cookie })).body;

/** One of each kind for `who`, straight through `notify`, oldest first. */
const seedEach = async (who) => {
  const t = hex(`${who}-timing`);
  await notify(people[who].id, 'suggestion', `suggestion:${hex(`${who}-s`)}`, { suggestion: hex(`${who}-s`), title: 'S', from: 'open', to: 'planned' });
  await notify(people[who].id, 'comment', `comment:${hex(`${who}-c`)}`, { timing: t, comment: hex(`${who}-c`), title: 'T', user: 'x', atMs: 10 });
  await notify(people[who].id, 'use', `use:${t}:1`, { timing: t, title: 'T', user: 'x' });
  await notify(people[who].id, 'vote', `vote:${t}:1`, { timing: t, title: 'T', verdict: 'on' });
  await notify(people[who].id, 'analysis', `analysis:${hex(`${who}-a`)}`, { analysis: hex(`${who}-a`), name: 'A', status: 'done' });
  return t;
};

// ── Where each one leads ────────────────────────────────────────────────────

test('every kind leads to a path on this site, built from checked ids only', () => {
  const id = hex(1);
  const other = hex(2);
  assert.deepEqual(targetOf('comment', { timing: id, comment: other }), { kind: 'comment', id: other, path: `/t/${id}#comment-${other}` });
  assert.deepEqual(targetOf('comment', { timing: id }), { kind: 'timing', id, path: `/t/${id}` });
  assert.equal(targetOf('comment', { comment: other }), null);
  assert.deepEqual(targetOf('vote', { timing: id }), { kind: 'timing', id, path: `/t/${id}` });
  assert.deepEqual(targetOf('use', { timing: id }).path, `/t/${id}`);
  assert.deepEqual(targetOf('analysis', { analysis: id }), { kind: 'analysis', id, path: `/analyze/${id}` });
  assert.equal(targetOf('suggestion', { suggestion: id }).path, `/community?suggestion=${id}#suggestion-${id}`);
  assert.deepEqual(targetOf('suggestion', {}), { kind: 'suggestion', id: null, path: '/community' });
  assert.deepEqual(targetOf('staff', { item: 'report' }), { kind: 'staff', id: null, path: '/staff' });
  // A stored target wins, and is rebuilt, never trusted as a path.
  assert.deepEqual(targetOf('vote', { timing: id, target: { kind: 'analysis', id: other } }).path, `/analyze/${other}`);
  assert.equal(targetOf('vote', { timing: id, target: { kind: 'timing', id: 'https://evil.example' } }).path, `/t/${id}`);
  assert.equal(targetOf('vote', { target: { kind: 'javascript', id } }), null);
  // Hostile payloads fall to nothing rather than to a link.
  for (const timing of ['//evil.example', 'https://evil.example', '../admin', `${id}/../x`, null, 7]) {
    assert.equal(targetOf('vote', { timing }), null, String(timing));
    assert.equal(targetOf('comment', { timing, comment: id }), null, String(timing));
  }
  assert.equal(targetOf('mystery', { timing: id }), null);
  assert.equal(targetOf('vote', null), null);
  assert.ok(!SAME_SITE.test('//evil.example') && !SAME_SITE.test('https://x') && !SAME_SITE.test('/t/a b') && SAME_SITE.test('/staff'));
});

test('the list carries each target, filters by kind and pages', async () => {
  const t = await seedEach('erin');
  const all = await inbox(people.erin.cookie);
  assert.equal(all.total, 5);
  assert.deepEqual(all.items.map((n) => n.kind), ['analysis', 'vote', 'use', 'comment', 'suggestion']);
  for (const n of all.items) assert.ok(n.target && SAME_SITE.test(n.target.path), n.kind);
  assert.equal(all.items.find((n) => n.kind === 'vote').target.path, `/t/${t}`);

  const some = await inbox(people.erin.cookie, '?kind=comment,vote');
  assert.deepEqual([some.total, some.items.map((n) => n.kind).sort()], [2, ['comment', 'vote']]);
  const paged = await inbox(people.erin.cookie, '?limit=2&offset=2');
  assert.deepEqual([paged.total, paged.items.length, paged.offset, paged.limit], [5, 2, 2, 2]);
  assert.equal((await inbox(people.erin.cookie, '?offset=50')).total, 5, 'the total is known past the end');
  for (const bad of ['?kind=nope', '?kind=comment,,vote', '?kind=comment&kind=vote']) {
    assert.equal((await call('GET', `/me/notifications${bad}`, { cookie: people.erin.cookie })).status, 400, bad);
  }
});

// ── Marks ───────────────────────────────────────────────────────────────────

test('read and unread marks change the count at once and only for their owner', async () => {
  await seedEach('frank');
  const { items } = await inbox(people.frank.cookie);
  const [a, b] = items;
  let r = await call('POST', '/me/notifications/read', { cookie: people.frank.cookie, body: { ids: [a.id, b.id, a.id] } });
  assert.deepEqual(r.body, { marked: 2, unread: 3 });
  r = await call('POST', '/me/notifications/unread', { cookie: people.frank.cookie, body: { ids: [a.id] } });
  assert.deepEqual(r.body, { marked: 1, unread: 4 });
  // Unread twice is nothing new.
  assert.equal((await call('POST', '/me/notifications/unread', { cookie: people.frank.cookie, body: { ids: [a.id] } })).body.marked, 0);
  assert.equal((await inbox(people.frank.cookie)).items.find((n) => n.id === a.id).read, false);

  // Another account's ids mark nothing either way.
  assert.equal((await call('POST', '/me/notifications/unread', { cookie: people.grace.cookie, body: { ids: [b.id] } })).body.marked, 0);
  assert.equal((await call('POST', '/me/notifications/read', { cookie: people.grace.cookie, body: { ids: [a.id] } })).body.marked, 0);
  assert.equal((await inbox(people.frank.cookie)).items.find((n) => n.id === b.id).read, true);

  for (const body of [{}, { ids: [] }, { ids: ['x'] }, { all: true }, { ids: Array.from({ length: 101 }, (_, i) => hex(i)) }]) {
    assert.equal((await call('POST', '/me/notifications/unread', { cookie: people.frank.cookie, body })).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call('POST', '/me/notifications/unread', { cookie: people.frank.cookie, body: { ids: [a.id] }, sameOrigin: false })).status, 403);
  assert.equal((await call('POST', '/me/notifications/unread', { body: { ids: [a.id] } })).status, 401);

  r = await call('POST', '/me/notifications/read', { cookie: people.frank.cookie, body: { all: true } });
  assert.equal(r.body.unread, 0);
});

// ── Deleting ────────────────────────────────────────────────────────────────

test('one is deleted by its owner; anyone else\'s is a 404 like a missing one', async () => {
  await seedEach('grace');
  const { items } = await inbox(people.grace.cookie);
  const [first, second] = items;
  assert.equal((await call('DELETE', `/me/notifications/${first.id}`, { cookie: people.erin.cookie })).status, 404);
  assert.equal((await call('DELETE', `/me/notifications/${hex('none')}`, { cookie: people.grace.cookie })).status, 404);
  assert.equal((await call('DELETE', '/me/notifications/not-an-id', { cookie: people.grace.cookie })).status, 404);
  assert.equal((await call('DELETE', `/me/notifications/${first.id}`, { cookie: people.grace.cookie, sameOrigin: false })).status, 403);
  assert.equal((await call('DELETE', `/me/notifications/${first.id}`)).status, 401);

  const gone = await call('DELETE', `/me/notifications/${first.id}`, { cookie: people.grace.cookie });
  assert.deepEqual(gone.body, { deleted: 1, unread: 4 });
  assert.equal((await call('DELETE', `/me/notifications/${first.id}`, { cookie: people.grace.cookie })).status, 404, 'once only');
  const left = await inbox(people.grace.cookie);
  assert.deepEqual([left.total, left.items.some((n) => n.id === first.id)], [4, false]);
  assert.ok(left.items.some((n) => n.id === second.id));
});

test('"delete read" takes the read ones only, and only when asked by name', async () => {
  const who = people.erin;
  const before = await inbox(who.cookie);
  const read = before.items.slice(0, 2).map((n) => n.id);
  await call('POST', '/me/notifications/read', { cookie: who.cookie, body: { ids: read } });
  assert.equal((await call('DELETE', '/me/notifications', { cookie: who.cookie })).status, 400, 'a bare DELETE empties nothing');
  assert.equal((await call('DELETE', '/me/notifications?read=1', { cookie: who.cookie })).status, 400);
  assert.equal((await call('DELETE', '/me/notifications?read=true', { cookie: who.cookie, sameOrigin: false })).status, 403);
  // Frank's read ones stay where they are.
  const frankBefore = (await inbox(people.frank.cookie)).total;
  const r = await call('DELETE', '/me/notifications?read=true', { cookie: who.cookie });
  assert.deepEqual(r.body, { deleted: 2, unread: before.total - 2 });
  const after = await inbox(who.cookie);
  assert.equal(after.total, before.total - 2);
  assert.ok(after.items.every((n) => !n.read));
  assert.equal((await inbox(people.frank.cookie)).total, frankBefore);
  assert.equal((await call('DELETE', '/me/notifications?read=true', { cookie: who.cookie })).body.deleted, 0);
});

test('deleting is rate limited', async () => {
  let refused = null;
  for (let i = 0; i < 125 && !refused; i += 1) {
    const r = await call('DELETE', `/me/notifications/${hex(`limit-${i}`)}`, { cookie: people.frank.cookie });
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, 'the 121st delete in ten minutes is refused');
});

// ── Staff ───────────────────────────────────────────────────────────────────

test('staff hear of a report and of a correction, never who sent them, and land on /staff', async () => {
  const created = await call('POST', '/community/suggestions', { cookie: people.grace.cookie, body: { title: 'A thing to report', body: 'Body.' } });
  const sid = created.body.suggestion.id;
  assert.equal((await call('POST', `/community/suggestions/${sid}/report`, { cookie: people.erin.cookie, body: { reason: 'Spam spam' } })).status, 204);
  // A second report of the same item is the same notification, back to unread.
  await call('POST', `/community/suggestions/${sid}/report`, { cookie: people.frank.cookie, body: { reason: 'More spam' } });
  let box = await inbox(staff);
  const reports = box.items.filter((n) => n.kind === 'staff' && n.payload.item === 'report');
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].payload.kind, reports[0].target.path, reports[0].read], ['suggestion', '/staff', false]);
  assert.ok(!JSON.stringify(reports[0]).includes('Spam') && !JSON.stringify(reports[0]).includes('erin'), 'neither why nor who');
  assert.equal((await inbox(people.grace.cookie, '?kind=staff')).total, 0, 'members hear nothing of it');

  // A vote with a correction, on a published timing of grace's.
  const id = newPublicId();
  await analyses().create({
    publicId: id, sha1: hex('song').padEnd(40, '0'), filename: 'Song.mp3', sizeBytes: 1, accountId: people.grace.id, anonHash: null,
    ipHash: 'c'.repeat(64), uploader: { username: 'grace', displayName: 'grace', avatarUrl: null }, private: false, tagTitle: 'Corrected', tagArtist: 'A',
  });
  const job = await analyses().claim();
  const bpm = 128;
  assert.ok(await analyses().finish(id, job.attempt, {
    format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
    duration_s: 60, global_bpm: bpm, offset_ms: 100, meter: '4/4',
    red_lines: [{ time_ms: 100, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true }],
    sections: [{ index: 0, start_ms: 100, end_ms: 60_000, bpm, confidence: 0.9, level: 'high' }],
    osu_timing: `100,${60_000 / bpm},4,1,0,100,1,0`,
  }));
  assert.ok(await analyses().publish(id));
  assert.equal((await call('PUT', `/timings/${id}/vote`, { cookie: people.erin.cookie, body: { verdict: 'on' } })).status, 200);
  box = await inbox(staff, '?kind=staff');
  assert.ok(!box.items.some((n) => n.payload.item === 'correction'), 'a bare "on" is nothing to review');
  assert.equal((await call('PUT', `/timings/${id}/vote`, { cookie: people.erin.cookie, body: { verdict: 'off', proposedBpm: 129 } })).status, 200);
  box = await inbox(staff, '?kind=staff');
  const correction = box.items.find((n) => n.payload.item === 'correction');
  assert.deepEqual([correction.payload.timing, correction.payload.title, correction.target.path], [id, 'Corrected', '/staff']);
  assert.ok(!JSON.stringify(correction).includes('erin'));
  // Staff's own report is not news to themselves.
  const before = (await inbox(staff, '?kind=staff')).total;
  const other = await call('POST', '/community/suggestions', { cookie: people.frank.cookie, body: { title: 'Another', body: 'B.' } });
  await call('POST', `/community/suggestions/${other.body.suggestion.id}/report`, { cookie: staff, body: { reason: 'Mine' } });
  assert.equal((await inbox(staff, '?kind=staff')).total, before);
});
