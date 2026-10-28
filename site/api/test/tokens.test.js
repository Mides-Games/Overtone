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
process.env.USER_DAILY_LIMIT = '500';
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-tokens-'));
const { app } = await import('../src/app.js');
const { analyses, newPublicId } = await import('../src/services/analysis.service.js');
const { prepareSpool } = await import('../src/services/spool.service.js');
const { hashToken, MAX_TOKENS, parseScopes, TOKEN_FORMAT } = await import('../src/services/token.service.js');
const { bearerOf, tokenRoute } = await import('../src/middlewares/token.js');

let server;
let base;
let alice; // the Discord dev user
let bob; // the Google dev user (staff)
before(async () => {
  await prepareSpool();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  alice = await signIn('discord');
  bob = await signIn('google');
});
after(() => server.close());

const SAME_ORIGIN = { 'X-Requested-With': 'overtone-web' };
const JSON_BODY = { ...SAME_ORIGIN, 'Content-Type': 'application/json' };
const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

const signIn = async (provider) => {
  const start = await fetch(`${base}/auth/sso/start?provider=${provider}`);
  const { url } = await start.json();
  const code = new URL(url).hash.slice('#code='.length);
  const exchange = await fetch(`${base}/auth/sso/exchange`, {
    method: 'POST',
    headers: { ...JSON_BODY, Cookie: cookieOf(start).join('; ') },
    body: JSON.stringify({ code }),
  });
  assert.equal(exchange.status, 200);
  return cookieOf(exchange).join('; ');
};

const me = async (cookie) => (await (await fetch(`${base}/me`, { headers: { Cookie: cookie } })).json()).account;

const mint = async (cookie, { name = 'my script', scopes = ['read:analyses', 'upload', 'read:timings'] } = {}) => {
  const response = await fetch(`${base}/me/tokens`, { method: 'POST', headers: { ...JSON_BODY, Cookie: cookie }, body: JSON.stringify({ name, scopes }) });
  return { status: response.status, body: await response.json() };
};

const revokeAll = async (cookie) => {
  const { tokens } = await (await fetch(`${base}/me/tokens`, { headers: { Cookie: cookie } })).json();
  for (const t of tokens) await fetch(`${base}/me/tokens/${t.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: cookie } });
};

/** A finished analysis owned by `cookie`'s account, put in through the store as an upload would. */
const finishedFor = async (cookie) => {
  const account = await me(cookie);
  const id = newPublicId();
  await analyses().create({
    publicId: id, sha1: createHash('sha1').update(id).digest('hex'), filename: 'song.mp3', sizeBytes: 10,
    accountId: account.id, anonHash: null, ipHash: 'x', uploader: null,
  });
  const job = await analyses().claim();
  await analyses().finish(id, job.attempt, {
    format: 'timing-result', version: 1, engine: 'v3', engine_hash: 'abc', refused: false, refusal: null, duration_s: 60,
    global_bpm: 120, offset_ms: 0, meter: '4/4', sections: [], osu_timing: '0,500,4,1,0,100,1,0',
    red_lines: [{ time_ms: 0, bpm: 120, beat_length_ms: 500, meter: 4, meter_known: true }],
  });
  return id;
};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test('the pure parts: the format, the scopes, the Bearer header and the allow-list', () => {
  assert.ok(TOKEN_FORMAT.test(`ot_${'A'.repeat(43)}`));
  assert.ok(!TOKEN_FORMAT.test(`ot_${'A'.repeat(42)}`));
  assert.equal(hashToken('x').length, 64);
  assert.deepEqual(parseScopes(['upload', 'read:analyses', 'upload']), ['read:analyses', 'upload']);
  assert.equal(parseScopes([]), null);
  assert.equal(parseScopes(['admin']), null);
  assert.equal(parseScopes('upload'), null);
  const req = (value) => ({ get: () => value });
  assert.equal(bearerOf(req(undefined)), null);
  assert.equal(bearerOf(req('Basic dXNlcjpwYXNz')), null);
  assert.equal(bearerOf(req('Bearer abc')), 'abc');
  assert.equal(bearerOf(req('bearer   abc ')), 'abc');
  assert.equal(bearerOf(req('Bearer')), '');
  assert.equal(tokenRoute('GET', `/analyses/${'a'.repeat(32)}`).scope, 'read:analyses');
  assert.equal(tokenRoute('HEAD', '/timings').scope, 'read:timings');
  assert.equal(tokenRoute('POST', '/analyses').scope, 'upload');
  for (const [method, path] of [
    ['POST', `/analyses/${'a'.repeat(32)}/publish`], ['DELETE', `/analyses/${'a'.repeat(32)}`], ['POST', '/me/tokens'],
    ['GET', '/me/tokens'], ['POST', `/analyses/${'a'.repeat(32)}/versions`], ['POST', '/community/suggestions'],
    ['POST', `/analyses/${'a'.repeat(32)}/moderate`], ['POST', '/auth/logout'], ['POST', `/timings/${'a'.repeat(32)}/check`],
  ]) assert.equal(tokenRoute(method, path), null, `${method} ${path}`);
});

test('a token is made by a signed-in browser, shown once, listed without its secret and revoked', async () => {
  await revokeAll(alice);
  // Not signed in, or without the same-origin header: no.
  assert.equal((await mint('')).status, 401);
  const noHeader = await fetch(`${base}/me/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({ name: 'x', scopes: ['upload'] }),
  });
  assert.equal(noHeader.status, 403);
  // Validation.
  assert.equal((await mint(alice, { name: '  ' })).body.error.code, 'BAD_NAME');
  assert.equal((await mint(alice, { name: 'x'.repeat(61) })).body.error.code, 'TOO_LONG');
  assert.equal((await mint(alice, { scopes: [] })).body.error.code, 'BAD_SCOPES');
  assert.equal((await mint(alice, { scopes: ['read:analyses', 'admin'] })).body.error.code, 'BAD_SCOPES');

  const made = await mint(alice, { name: 'bot‮ one', scopes: ['read:timings'] });
  assert.equal(made.status, 201);
  assert.match(made.body.token, TOKEN_FORMAT);
  assert.equal(made.body.name, 'bot one');
  assert.deepEqual(made.body.scopes, ['read:timings']);

  const list = await (await fetch(`${base}/me/tokens`, { headers: { Cookie: alice } })).json();
  assert.equal(list.tokens.length, 1);
  assert.equal(list.max, MAX_TOKENS);
  assert.ok(!JSON.stringify(list).includes(made.body.token), 'the secret is never listed');
  assert.ok(!JSON.stringify(list).includes(hashToken(made.body.token)), 'nor its hash');

  // It works, and the use is noted.
  assert.equal((await fetch(`${base}/timings`, { headers: bearer(made.body.token) })).status, 200);
  const used = await (await fetch(`${base}/me/tokens`, { headers: { Cookie: alice } })).json();
  assert.ok(used.tokens[0].lastUsedAt);

  // Bob cannot revoke Alice's: the 404 of a token that does not exist.
  const theirs = await fetch(`${base}/me/tokens/${made.body.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: bob } });
  assert.equal(theirs.status, 404);
  const gone = await fetch(`${base}/me/tokens/${made.body.id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
  assert.equal(gone.status, 204);
  const after = await fetch(`${base}/timings`, { headers: bearer(made.body.token) });
  assert.equal(after.status, 401);
  assert.equal((await after.json()).error.code, 'INVALID_TOKEN');
  assert.match(after.headers.get('WWW-Authenticate'), /invalid_token/);
});

test('at most MAX_TOKENS per account', async () => {
  await revokeAll(bob);
  for (let i = 0; i < MAX_TOKENS; i++) assert.equal((await mint(bob, { name: `t${i}` })).status, 201);
  const over = await mint(bob, { name: 'one more' });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'TOKEN_LIMIT');
  await revokeAll(bob);
});

test('a token reads its owner\'s analyses under its scope, and nobody else\'s', async () => {
  await revokeAll(alice);
  const mine = await finishedFor(alice);
  const theirs = await finishedFor(bob);
  const { body: reader } = await mint(alice, { scopes: ['read:analyses'] });
  const { body: publicOnly } = await mint(alice, { name: 'public', scopes: ['read:timings'] });

  const read = await fetch(`${base}/analyses/${mine}`, { headers: bearer(reader.token) });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).status, 'done');
  assert.equal((await fetch(`${base}/analyses/${mine}/timing.txt`, { headers: bearer(reader.token) })).status, 200);
  assert.equal((await fetch(`${base}/analyses/${mine}/versions`, { headers: bearer(reader.token) })).status, 200);
  assert.equal((await fetch(`${base}/me/analyses`, { headers: bearer(reader.token) })).status, 200);
  assert.equal((await fetch(`${base}/me`, { headers: bearer(reader.token) })).status, 200);
  // Someone else's: the same 404 as an id that does not exist.
  assert.equal((await fetch(`${base}/analyses/${theirs}`, { headers: bearer(reader.token) })).status, 404);
  // Without the scope: 403 that names it.
  const scoped = await fetch(`${base}/analyses/${mine}`, { headers: bearer(publicOnly.token) });
  assert.equal(scoped.status, 403);
  assert.deepEqual((await scoped.json()).error, {
    status: 403, message: 'This token does not have the read:analyses scope.', code: 'TOKEN_SCOPE', details: { scope: 'read:analyses' },
  });
  const upload = await fetch(`${base}/analyses`, {
    method: 'POST', headers: { ...bearer(reader.token), 'Content-Type': 'application/octet-stream', 'X-Filename': 'a.mp3' }, body: 'x',
  });
  assert.equal(upload.status, 403);
  assert.equal((await upload.json()).error.code, 'TOKEN_SCOPE');
  await revokeAll(alice);
});

test('an upload with a token belongs to the token\'s account, needs no same-origin header and sets no cookie', async () => {
  await revokeAll(alice);
  const { body: uploader } = await mint(alice, { scopes: ['upload', 'read:analyses'] });
  const sent = await fetch(`${base}/analyses`, {
    method: 'POST',
    headers: { ...bearer(uploader.token), 'Content-Type': 'application/octet-stream', 'X-Filename': 'token-song.mp3' },
    body: 'not really audio, but bytes',
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.headers.getSetCookie().length, 0, 'no anonymous cookie for a token');
  const { id } = await sent.json();
  // Alice's browser reads it: it is her account's.
  assert.equal((await fetch(`${base}/analyses/${id}`, { headers: { Cookie: alice } })).status, 200);
  assert.equal((await fetch(`${base}/analyses/${id}`, { headers: { Cookie: bob } })).status, 404);
  // Cancel it, so the queue is left as found.
  assert.equal((await fetch(`${base}/analyses/${id}`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } })).status, 204);
  await revokeAll(alice);
});

test('a token never stands in for a browser: cookies beside it are ignored and nothing outside the list is reached', async () => {
  await revokeAll(alice);
  await revokeAll(bob);
  const mine = await finishedFor(alice);
  const { body: bobs } = await mint(bob, { scopes: ['read:analyses', 'upload', 'read:timings'] });

  // Bob's token beside Alice's cookie reads as Bob: Alice's analysis is a 404.
  const mixed = await fetch(`${base}/analyses/${mine}`, { headers: { ...bearer(bobs.token), Cookie: alice } });
  assert.equal(mixed.status, 404);
  const who = await (await fetch(`${base}/me`, { headers: { ...bearer(bobs.token), Cookie: alice } })).json();
  assert.equal(who.account.id, (await me(bob)).id);

  // A Bearer that is not a token never falls back to the cookie beside it.
  for (const value of ['Bearer', 'Bearer nonsense', `Bearer ot_${'x'.repeat(43)}`]) {
    const response = await fetch(`${base}/analyses/${mine}`, { headers: { Authorization: value, Cookie: alice, ...SAME_ORIGIN } });
    assert.equal(response.status, 401, value);
  }

  // State-changing routes outside the list are refused before they run, even
  // with the same-origin header and a valid session beside the token.
  const attempts = [
    ['POST', `/analyses/${mine}/publish`, {}],
    ['DELETE', `/analyses/${mine}`, undefined],
    ['POST', `/analyses/${mine}/versions`, { factor: 2, nudgeMs: 0 }],
    ['POST', '/me/tokens', { name: 'minted by a token', scopes: ['upload'] }],
    ['POST', '/community/suggestions', { title: 'from a token', body: 'hello' }],
    ['POST', '/auth/logout', undefined],
    ['GET', '/me/tokens', undefined],
  ];
  for (const [method, path, body] of attempts) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...bearer(bobs.token), ...JSON_BODY, Cookie: alice },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error.code, 'TOKEN_NOT_ALLOWED', `${method} ${path}`);
  }
  // Nothing happened: Alice's analysis is still there and unpublished, and Alice is still signed in.
  const still = await (await fetch(`${base}/analyses/${mine}`, { headers: { Cookie: alice } })).json();
  assert.equal(still.published, false);
  assert.equal((await fetch(`${base}/me`, { headers: { Cookie: alice } })).status, 200);
  assert.equal((await (await fetch(`${base}/me/tokens`, { headers: { Cookie: bob } })).json()).tokens.length, 1);

  // Without a Bearer, the browser rules are as they were: no same-origin header, no publish.
  const forged = await fetch(`${base}/analyses/${mine}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: '{}' });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, 'CSRF_HEADER_MISSING');
  // Another scheme (a staging site behind basic auth) leaves the request a browser one.
  const basic = await fetch(`${base}/analyses/${mine}`, { headers: { Authorization: 'Basic dXNlcjpwYXNz', Cookie: alice } });
  assert.equal(basic.status, 200);
  await revokeAll(bob);
  await revokeAll(alice);
});

test('a token counts against its own rate limit, not the address\'s', async () => {
  await revokeAll(alice);
  const { body: a } = await mint(alice, { name: 'a', scopes: ['read:timings'] });
  const { body: b } = await mint(alice, { name: 'b', scopes: ['read:timings'] });
  let last;
  for (let i = 0; i < 121; i++) last = await fetch(`${base}/health`, { headers: bearer(a.token) });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('Retry-After')) >= 1);
  // Another token, and the browser at the same address, are not held up by it.
  assert.equal((await fetch(`${base}/health`, { headers: bearer(b.token) })).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  await revokeAll(alice);
});
