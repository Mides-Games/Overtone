import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The spool's budget against a real server (memory store): one megabyte of
// room, uploads of up to one megabyte, two of one person's songs at a time.
const folder = await mkdtemp(join(tmpdir(), 'overtone-spool-test-'));
delete process.env.DATABASE_URL;
Object.assign(process.env, {
  SPOOL_DIR: folder, SPOOL_MAX_MB: '1', SPOOL_MIN_FREE_MB: '0', MAX_UPLOAD_MB: '1',
  ANON_MAX_PENDING: '2', QUEUE_MAX: '10', ANON_DAILY_LIMIT: '50',
});
const { app } = await import('../src/app.js');
const spool = await import('../src/services/spool.service.js');

let server;
let port;
before(async () => {
  await spool.prepareSpool({ clear: true });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(folder, { recursive: true, force: true });
});

/**
 * An upload of `size` bytes whose body is held open after its first byte
 * until `finish()` is called. `answer` resolves to `{ status, body }`.
 */
const upload = (size, name = 'a.wav') => {
  const req = http.request({
    port, method: 'POST', path: '/api/v1/analyses',
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
      'X-Filename': name, 'X-Requested-With': 'overtone-web',
    },
  });
  const answer = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
  });
  req.write(Buffer.alloc(1, 7));
  return { answer, finish: () => req.end(Buffer.alloc(size - 1, 7)), abort: () => req.destroy() };
};

/** Waits until the server has counted `bytes` as reserved. */
const reserved = async (bytes) => {
  for (let i = 0; i < 200 && spool.spoolUsage().reserved !== bytes; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(spool.spoolUsage().reserved, bytes);
};

test('an upload that does not fit the spool is refused before its body is read', async () => {
  const first = upload(600_000, 'first.wav');
  await reserved(600_000);

  const second = upload(600_000, 'second.wav');
  const refused = await second.answer;
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'SPOOL_FULL');
  assert.equal(spool.spoolUsage().reserved, 600_000);

  first.finish();
  const done = await first.answer;
  assert.equal(done.status, 202);
  // Waiting audio holds its room; the reservation went with the request.
  assert.deepEqual({ ...spool.spoolUsage(), budget: 0 }, { held: 600_000, reserved: 0, budget: 0 });

  // Its discard gives the room back.
  await spool.discard(done.body.id);
  assert.equal(spool.spoolUsage().held, 0);
});

test('uploads still arriving count toward the pending cap', async () => {
  // One queued song from the previous test was discarded from the spool but
  // is still queued: with a cap of 2, one more may arrive, not two.
  const arriving = upload(10_000, 'arriving.wav');
  await reserved(10_000);
  const extra = upload(10_000, 'extra.wav');
  const refused = await extra.answer;
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'PENDING_LIMIT');

  arriving.finish();
  assert.equal((await arriving.answer).status, 202);
  assert.equal(spool.spoolUsage().reserved, 0);
});

test('an upload cut off mid-body releases its reservation', async () => {
  // The pending cap is reached (two queued), so lift it by finishing one.
  const { analyses } = await import('../src/services/analysis.service.js');
  const job = await analyses().claim();
  await analyses().fail(job.publicId, job.attempt, 'test');

  const cut = upload(400_000, 'cut.wav');
  cut.answer.catch(() => {});
  await reserved(400_000);
  cut.abort();
  await reserved(0);
  assert.equal(spool.spoolUsage().held, 10_000);
});
