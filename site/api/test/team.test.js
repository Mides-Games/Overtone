import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-team-'));
const { app } = await import('../src/app.js');
const { midesRank } = await import('../src/services/mides.service.js');

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

const give = (cookie, body) =>
  fetch(`${base}/staff/ranks`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

test('the Mides rank names a moderator rank from staff_rank, and never makes anyone staff', () => {
  assert.equal(midesRank({ is_moderator: true, staff_rank: 'owner' }), 'owner');
  assert.equal(midesRank({ is_moderator: true, staff_rank: 'god' }), 'moderator');
  assert.equal(midesRank({ is_moderator: true }), 'moderator');
  assert.equal(midesRank({ staff_rank: 'admin', role: 'admin' }), null);
});

test('/team lists the Mides staff with their Mides rank, and no one else', async () => {
  const team = await (await fetch(`${base}/team`)).json();
  assert.deepEqual(team.mides.map((m) => [m.username, m.midesRank, m.overtoneRelated]), [['dev_google', 'admin', false]]);
  assert.deepEqual(team.testers, []);
});

test('staff give and take Overtone ranks; Mides ranks and unknown names are refused', async () => {
  assert.equal((await give(staff, { username: 'dev_discord', rank: 'tester' })).status, 200);
  assert.equal((await give(staff, { username: '@dev_google', rank: 'developer' })).status, 200);
  let team = await (await fetch(`${base}/team`)).json();
  assert.deepEqual(team.testers.map((m) => [m.username, m.overtoneRank]), [['dev_discord', 'tester']]);
  assert.deepEqual(team.staff.map((m) => m.username), ['dev_google']);
  assert.equal(team.mides[0].overtoneRelated, true);

  const profile = await (await fetch(`${base}/users/dev_discord`)).json();
  assert.equal(profile.user.overtoneRank, 'tester');

  assert.equal((await give(staff, { username: 'dev_discord', rank: 'admin' })).status, 400);
  assert.equal((await give(staff, { username: 'nobody_here', rank: 'tester' })).status, 404);
  assert.equal((await give(staff, { username: 'dev_discord', rank: null })).status, 200);
  team = await (await fetch(`${base}/team`)).json();
  assert.deepEqual(team.testers, []);
});

test('a member cannot give ranks: the staff route is a 404 to them', async () => {
  assert.equal((await give(member, { username: 'dev_discord', rank: 'tester' })).status, 404);
});
