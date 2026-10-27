import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-moderation-'));
const { app } = await import('../src/app.js');
const { analyses, REMOVED } = await import('../src/services/analysis.service.js');
const { audioPath, prepareSpool } = await import('../src/services/spool.service.js');

let server;
let base;
let staff;
let member;
before(async () => {
  await prepareSpool();
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

const upload = async (body, extra = {}) => {
  const response = await fetch(`${base}/analyses`, {
    method: 'POST',
    // As the member, whose daily quota outlasts the anonymous five.
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'song.mp3', Cookie: member, ...extra },
    body,
  });
  assert.equal(response.status, 202);
  return (await response.json()).id;
};

const moderate = (id, cookie, body) =>
  fetch(`${base}/analyses/${id}/moderate`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });


test('only staff may moderate: anyone else is told so, nobody is let through', async () => {
  const id = await upload('a song for the gate');
  assert.equal((await moderate(id, '', { action: 'remove' })).status, 401);
  const refused = await moderate(id, member, { action: 'remove' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, 'STAFF_ONLY');
  assert.equal((await fetch(`${base}/analyses/moderation`, { headers: { Cookie: member } })).status, 403);
  assert.equal((await moderate(id, staff, { action: 'ban' })).status, 400);
  assert.equal((await analyses().get(id)).status, 'queued');
  await moderate(id, staff, { action: 'remove' });
});

test('staff see a handle on every live row, and a private row still hides its song', async () => {
  const id = await upload('a private song', { 'X-Private': '1' });
  const asStaff = await (await fetch(`${base}/analyses/queue`, { headers: { Cookie: staff } })).json();
  assert.equal(asStaff.staff, true);
  const row = asStaff.live.find((r) => r.ref === id);
  assert.ok(row);
  assert.equal(row.song, null);
  assert.equal(row.uploader, null);
  assert.ok(!('id' in row));

  const asMember = await (await fetch(`${base}/analyses/queue`, { headers: { Cookie: member } })).json();
  assert.ok(!('staff' in asMember));
  assert.ok(asMember.live.every((r) => !('ref' in r)));
  await moderate(id, staff, { action: 'remove', reason: 'cleanup' });
});

test('a removed job fails with a message, loses its audio, and the log says who', async () => {
  const id = await upload('a song to remove');
  const response = await moderate(id, staff, { action: 'remove', reason: '  spam\u0000 <b>upload</b> ' });
  assert.equal(response.status, 204);
  const row = await analyses().get(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, REMOVED);
  assert.equal(existsSync(audioPath(id)), false);
  // The uploader's page says a moderator did it, not that the file was bad.
  const page = await (await fetch(`${base}/analyses/${id}`, { headers: { Cookie: member } })).json();
  assert.equal(page.removed, true);
  // A finished job is not live any more.
  assert.equal((await moderate(id, staff, { action: 'remove' })).status, 409);

  const { log } = await (await fetch(`${base}/analyses/moderation`, { headers: { Cookie: staff } })).json();
  assert.deepEqual({ ...log[0], at: undefined }, { action: 'remove', moderator: 'dev_google', ref: id, reason: 'spam bupload/b', at: undefined });
});

test('a running job handed back waits again, and the worker that had it is refused', async () => {
  while (await analyses().claim()) {}
  const id = await upload('a stuck song');
  const job = await analyses().claim();
  assert.equal(job.publicId, id);
  // A queued job has nothing to hand back.
  const other = await upload('a waiting song');
  assert.equal((await moderate(other, staff, { action: 'requeue' })).status, 409);

  assert.equal((await moderate(id, staff, { action: 'requeue' })).status, 204);
  assert.equal((await analyses().get(id)).status, 'queued');
  assert.equal(await analyses().finish(id, job.attempt, { engine_hash: 'abcdef12', refused: false }), false);
  const again = await analyses().claim();
  assert.equal(again.publicId, id);
  assert.ok(again.attempt > job.attempt);

  const { log } = await (await fetch(`${base}/analyses/moderation`, { headers: { Cookie: staff } })).json();
  assert.equal(log[0].action, 'requeue');
  assert.equal(log[0].ref, id);
});

test('a job whose audio is gone cannot be handed back', async () => {
  while (await analyses().claim()) {}
  const id = await upload('a song without audio');
  await analyses().claim();
  const { rm } = await import('node:fs/promises');
  await rm(audioPath(id));
  const response = await moderate(id, staff, { action: 'requeue' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'AUDIO_GONE');
  assert.equal((await analyses().get(id)).status, 'running');
});
