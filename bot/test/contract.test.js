import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApi } from '../src/api.js';
import { createHandlers, createReported } from '../src/handlers.js';
import { defaultLimits } from '../src/limits.js';
import { createNotifier } from '../src/notifier.js';
import { BOT_TOKEN, fakeCdn, interaction } from './fakes.js';

/**
 * The bot against the real site/api (its memory store, no database), not a
 * stand-in: what bot/src/api.js sends is what site/api/src/routes/bot.routes.js
 * reads. Discord's CDN is still a fake. The worker is played over its own
 * HTTP routes with WORKER_TOKEN, so the audio's deletion and the DM outbox
 * run as they do in production.
 */

const WORKER_TOKEN = 'w'.repeat(40);
delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WORKER_TOKEN = WORKER_TOKEN;
process.env.MAX_UPLOAD_MB = '1';
process.env.SPOOL_MAX_MB = '64';
process.env.QUEUE_MAX = '10';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-bot-contract-'));
const { app } = await import('../../site/api/src/app.js');
const { prepareSpool, audioPath } = await import('../../site/api/src/services/spool.service.js');
const { setNotify } = await import('../../site/api/src/services/links.service.js');
const { upsertFromMides } = await import('../../site/api/src/services/account.service.js');

let server;
let cdn;
let base;
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cdn = await fakeCdn();
});
after(() => {
  server.close();
  cdn.close();
});

const result = {
  format: 'timing-result', version: 1, engine: 'v3', engine_hash: '0123456789abcdef', refused: false, refusal: null,
  duration_s: 60, global_bpm: 174, offset_ms: 42.5, meter: '4/4',
  red_lines: [{ time_ms: 42.5, bpm: 174, beat_length_ms: 60_000 / 174, meter: 4, meter_known: true }],
  sections: [{ index: 0, start_ms: 42.5, end_ms: 60_000, bpm: 174, confidence: 0.99, level: 'high' }],
  osu_timing: `42,${60_000 / 174},4,1,0,100,1,0`,
};

const asWorker = (path, body) =>
  fetch(`${base}/api/internal${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The worker: claims the next job and posts `result` for it. */
const worker = async () => {
  for (;;) {
    const claim = await asWorker('/jobs/claim', { engine_hash: result.engine_hash });
    if (claim.status === 200) {
      const job = await claim.json();
      assert.equal((await asWorker(`/jobs/${job.id}/result`, { attempt: job.attempt, result })).status, 204);
      return job.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const handlersFor = (api, extra = {}) =>
  createHandlers({ api, limits: defaultLimits(), hosts: ['127.0.0.1'], pollMs: 10, log: { warn() {}, error() {} }, ...extra });

const song = (v, name = 'track.ogg') => ({ name, size: 1000, contentType: 'audio/ogg', url: `${cdn.base}/song.mp3?v=${v}` });

test('/time-song through the real API: uploaded, queued, analysed, published, the audio gone', async () => {
  const api = createApi({ base, token: BOT_TOKEN });
  const i = interaction({ command: 'time-song', user: '900000000000000001', options: { audio: song(1), publish: true } });
  const done = worker();
  await handlersFor(api).handle(i);
  const id = await done;
  const [embed] = i.log.filter(([k]) => k === 'edit').at(-1)[1].embeds;
  assert.equal(embed.fields[0].value, '174');
  assert.equal(embed.fields[1].value, '42.5 ms');
  assert.equal(embed.url, `http://localhost:5173/t/${id}`);
  // Published: anyone reads it now.
  assert.equal((await api.timing('900000000000000002', id)).bpm, 174);
  // ADR-W4: the spooled audio went with the result.
  assert.equal(await stat(audioPath(id)).catch(() => null), null);
});

test('an over-cap attachment never reaches the API: the cap is the API\'s own MAX_UPLOAD_MB', async () => {
  const api = createApi({ base, token: BOT_TOKEN });
  assert.equal((await api.health()).maxUploadMb, 1);
  const i = interaction({ command: 'time-song', user: '900000000000000003', options: { audio: { ...song(2, 'big.mp3'), url: `${cdn.base}/big.mp3` } } });
  await handlersFor(api).handle(i);
  assert.match(i.log.at(-1)[1].content, /larger than 1 MB/);
});

test('the same audio again is answered from the stored result, without a job', async () => {
  const api = createApi({ base, token: BOT_TOKEN });
  const i = interaction({ command: 'time-song', user: '900000000000000005', options: { audio: song(1) } });
  await handlersFor(api).handle(i);
  const [embed] = i.log.filter(([k]) => k === 'edit').at(-1)[1].embeds;
  assert.match(embed.description, /Analysed before/);
});

test('a linked account with DMs on: its result is answered in the channel, and the DM outbox does not repeat it', async () => {
  const account = await upsertFromMides({
    midesUserId: 'contract-1', username: 'contract', displayName: null, avatarUrl: null, bannerUrl: null, discordId: '900000000000000004', role: null,
  });
  assert.ok(await setNotify(account.id, true));
  const api = createApi({ base, token: BOT_TOKEN });
  const reported = createReported();
  const sent = [];
  const notifier = createNotifier({ api, reported, sendDm: async (id, m) => sent.push([id, m]), log: { warn() {} } });

  const i = interaction({ command: 'time-song', user: '900000000000000004', options: { audio: song(3) } });
  const done = worker();
  await handlersFor(api, { reported }).handle(i);
  const id = await done;
  const [embed] = i.log.filter(([k]) => k === 'edit').at(-1)[1].embeds;
  // Linked: the result page opens for the account.
  assert.equal(embed.url, `http://localhost:5173/analyze/${id}`);
  assert.equal(await notifier.tick(), 0);

  // A song from the site (not the bot) of the same account: one DM.
  const upload = await fetch(`${base}/api/internal/bot/analyses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'X-Discord-User': '900000000000000004', 'Content-Type': 'application/octet-stream', 'X-Filename': 'site.mp3' },
    body: Buffer.alloc(500, 9),
  });
  assert.equal(upload.status, 202);
  const other = await worker();
  assert.equal(await notifier.tick(), 1);
  assert.equal(sent[0][0], '900000000000000004');
  assert.equal(sent[0][1].embeds[0].url, `http://localhost:5173/analyze/${other}`);
});
