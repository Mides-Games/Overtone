import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-cancel-'));
const { app } = await import('../src/app.js');
const { analyses } = await import('../src/services/analysis.service.js');
const { audioPath, prepareSpool } = await import('../src/services/spool.service.js');

let server;
let base;
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };

/** Uploads a few bytes as a new anonymous visitor; returns the id and that visitor's cookie. */
const upload = async (body, cookie = '') => {
  const response = await fetch(`${base}/analyses`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/octet-stream', 'X-Filename': 'song.mp3', Cookie: cookie },
    body,
  });
  assert.equal(response.status, 202);
  const set = response.headers.get('set-cookie');
  return { id: (await response.json()).id, cookie: cookie || set.split(';')[0] };
};

const cancel = (id, cookie, headers = SAME_ORIGIN) =>
  fetch(`${base}/analyses/${id}`, { method: 'DELETE', headers: { ...headers, Cookie: cookie } });

test('a queued song is cancelled by its uploader: row, job and audio go, and the quota gets the place back', async () => {
  const { id, cookie } = await upload('first song');
  const store = analyses();
  const { ipHash } = await store.get(id);
  assert.equal(await store.countToday({ ipHash }), 1);
  assert.ok(existsSync(audioPath(id)));

  assert.equal((await cancel(id, cookie)).status, 204);
  assert.equal(await store.get(id), null);
  assert.equal(existsSync(audioPath(id)), false);
  assert.equal(await store.countToday({ ipHash }), 0);
  assert.deepEqual(await store.countPending({ ipHash }), { mine: 0, all: 0 });
  assert.equal((await fetch(`${base}/analyses/${id}`, { headers: { Cookie: cookie } })).status, 404);
});

test('somebody else, or a request without the same-origin header, cannot cancel it', async () => {
  const { id, cookie } = await upload('second song');
  const stranger = await upload('stranger song');
  // Another visitor gets the same 404 as for an id that does not exist.
  assert.equal((await cancel(id, stranger.cookie)).status, 404);
  assert.equal((await cancel(id, cookie, {})).status, 403);
  assert.equal((await analyses().get(id)).status, 'queued');
  await cancel(id, cookie);
  await cancel(stranger.id, stranger.cookie);
});

test('a song already being analysed is not cancelled', async () => {
  const { id, cookie } = await upload('third song');
  const job = await analyses().claim();
  assert.equal(job.publicId, id);
  const response = await cancel(id, cookie);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'NOT_QUEUED');
  assert.equal((await analyses().get(id)).status, 'running');
  assert.ok(existsSync(audioPath(id)));
});
