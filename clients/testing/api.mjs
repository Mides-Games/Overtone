/*
 * A real Overtone API on 127.0.0.1, for the clients' tests (W13.22).
 *
 *   node clients/testing/api.mjs        prints one line, `OVERTONE_TEST_API {json}`, then serves until stdin closes
 *
 * It is site/api's own app, in memory (no DATABASE_URL), with the fake
 * sign-in on: the clients are tested against the routes, the token checks,
 * the rate limits and the error shapes the site really has, not a mock of
 * them. What it adds is only what a test cannot do through the public API:
 *
 * - an account (the dev sign-in) and two personal tokens minted the way the
 *   website mints them: one with every scope, one with `read:timings` alone;
 * - a stand-in worker on the real /api/internal routes that answers every
 *   job at once: a file named `*fail*` fails, any other gets one red line at
 *   the BPM in its name (`song-174.mp3` is 174 BPM; 120 without a number);
 * - one published timing, uploaded with the token and published with the
 *   browser session (a token cannot publish).
 *
 * The JS tests import `startTestApi()`; the Python tests run this file and
 * read its line. Nothing here is shipped with the clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };

const cookieOf = (response) =>
  response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

/** A timing-result v1 the API accepts: one red line at `bpm`. */
export const resultFor = (bpm) => {
  const beat = 60_000 / bpm;
  return {
    format: 'timing-result', version: 1, engine: 'v3', engine_hash: 'c11e47e5', refused: false, refusal: null,
    duration_s: 60, global_bpm: bpm, offset_ms: 120, meter: '4/4', stability: 0.99,
    sections: [{ index: 0, start_ms: 120, end_ms: 60_000, bpm, confidence: 0.97, level: 'high', residual_ms: 1.2, coverage: 0.9 }],
    osu_timing: `120,${beat},4,1,0,100,1,0`,
    red_lines: [{ time_ms: 120, bpm, beat_length_ms: beat, meter: 4, meter_known: true }],
  };
};

const bpmOf = (filename) => {
  const found = /(\d{2,3}(?:\.\d+)?)/.exec(filename);
  return found ? Number(found[1]) : 120;
};

/** Starts the API and its stand-in worker. Resolves to `{ base, token, readOnlyToken, timingId, close() }`. */
export async function startTestApi() {
  delete process.env.DATABASE_URL;
  delete process.env.PROXY_SECRET;
  process.env.NODE_ENV = 'development';
  process.env.MIDES_DEV_LOGIN = '1';
  process.env.USER_DAILY_LIMIT = '500';
  process.env.WORKER_TOKEN = randomBytes(32).toString('base64url');
  process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-clients-'));
  const workerToken = process.env.WORKER_TOKEN;

  const { app } = await import('../../site/api/src/app.js');
  const { prepareSpool } = await import('../../site/api/src/services/spool.service.js');
  await prepareSpool();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = `${origin}/api/v1`;

  // The dev sign-in, as the browser does it.
  const start = await fetch(`${api}/auth/sso/start?provider=discord`);
  const { url } = await start.json();
  const code = new URL(url).hash.slice('#code='.length);
  const exchange = await fetch(`${api}/auth/sso/exchange`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: cookieOf(start) },
    body: JSON.stringify({ code }),
  });
  if (exchange.status !== 200) throw new Error(`dev sign-in failed: ${exchange.status}`);
  const session = cookieOf(exchange);

  const mint = async (name, scopes) => {
    const response = await fetch(`${api}/me/tokens`, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: session },
      body: JSON.stringify({ name, scopes }),
    });
    if (response.status !== 201) throw new Error(`minting a token failed: ${response.status}`);
    return (await response.json()).token;
  };
  const token = await mint('client tests', ['read:analyses', 'upload', 'read:timings']);
  const readOnlyToken = await mint('client tests, read-only', ['read:timings']);

  // The stand-in worker: claims and answers every job on the real internal routes.
  const internal = (path, body) =>
    fetch(`${origin}/api/internal${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let busy = false;
  const work = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const claim = await internal('/jobs/claim', { engine_hash: 'c11e47e5' });
        if (claim.status !== 200) break;
        const job = await claim.json();
        if (/fail/i.test(job.filename)) await internal(`/jobs/${job.id}/fail`, { attempt: job.attempt, error: 'The audio could not be decoded.' });
        else await internal(`/jobs/${job.id}/result`, { attempt: job.attempt, result: resultFor(bpmOf(job.filename)) });
      }
    } catch {
      // The server is closing; the next tick (if any) tries again.
    } finally {
      busy = false;
    }
  };
  const worker = setInterval(work, 40);

  // One published timing, for the public reads.
  const upload = await fetch(`${api}/analyses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Filename': 'published-174.mp3' },
    body: new Uint8Array(randomBytes(256)),
  });
  const { id: timingId } = await upload.json();
  for (let i = 0; i < 100; i++) {
    const row = await (await fetch(`${api}/analyses/${timingId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (row.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const publish = await fetch(`${api}/analyses/${timingId}/publish`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json', Cookie: session },
    body: '{}',
  });
  if (publish.status !== 200) throw new Error(`publishing the test timing failed: ${publish.status}`);

  return {
    base: origin,
    token,
    readOnlyToken,
    timingId,
    close: () =>
      new Promise((resolve) => {
        clearInterval(worker);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Run as a program (the Python tests): one line on stdout, then serve until stdin closes.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const api = await startTestApi();
  const { close, ...shown } = api;
  process.stdout.write(`OVERTONE_TEST_API ${JSON.stringify(shown)}\n`);
  const stop = () => close().then(() => process.exit(0));
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
