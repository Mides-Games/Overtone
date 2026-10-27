import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * W9.1 and W9.2 through the API, with a stand-in for osu!'s OAuth server: a
 * token endpoint that checks what a real one would (client, secret, code,
 * redirect_uri, the PKCE verifier against the challenge it was shown) and a
 * /api/v2/me that answers only that token. No BOT_TOKEN here, so the bot's
 * side is off, and that is tested too.
 */

const osu = { challenge: null, tokenCalls: 0, meCalls: 0, lastTokenBody: null, me: null };
const fakeOsu = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && req.url === '/oauth/token') {
      osu.tokenCalls += 1;
      const b = JSON.parse(body || '{}');
      osu.lastTokenBody = b;
      if (b.client_id !== 4242 || b.client_secret !== 'osu-test-secret') return send(401, { error: 'invalid_client' });
      if (b.code !== 'good-code' || b.redirect_uri !== 'http://localhost:5173/link/osu') return send(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
      if (challenge !== osu.challenge) return send(400, { error: 'invalid_grant', hint: 'pkce' });
      return send(200, { access_token: 'osu-access', token_type: 'Bearer', expires_in: 86400 });
    }
    if (req.method === 'GET' && req.url === '/api/v2/me') {
      osu.meCalls += 1;
      if (req.headers.authorization !== 'Bearer osu-access') return send(401, {});
      return send(200, osu.me);
    }
    return send(404, {});
  });
});
await new Promise((resolve) => fakeOsu.listen(0, '127.0.0.1', resolve));

delete process.env.DATABASE_URL;
delete process.env.PROXY_SECRET;
delete process.env.BOT_TOKEN;
process.env.NODE_ENV = 'development';
process.env.MIDES_DEV_LOGIN = '1';
process.env.MIDES_WEB_URL = 'https://mides.example';
process.env.OSU_CLIENT_ID = '4242';
process.env.OSU_CLIENT_SECRET = 'osu-test-secret';
process.env.OSU_REDIRECT_URI = 'http://localhost:5173/link/osu';
process.env.OSU_URL = `http://127.0.0.1:${fakeOsu.address().port}`;
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-links-'));
const { app } = await import('../src/app.js');
const { toUser } = await import('../src/services/mides.service.js');
const { normalizeCode } = await import('../src/services/links.service.js');
const { toOsuProfile } = await import('../src/services/osu.service.js');

let server;
let root;
let base;
let alice; // the Discord dev user: Mides sends a Discord id with it
let bob; // the Google dev user: no Discord
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  base = `${root}/api/v1`;
  alice = await signIn('discord');
  bob = await signIn('google');
});
after(() => {
  server.close();
  fakeOsu.close();
});

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

const links = async (cookie) => {
  const response = await fetch(`${base}/me/links`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
};

test('the Mides profile\'s discord_id is kept only when it is a snowflake', () => {
  assert.equal(toUser({ id: 1, username: 'a', discord_id: '123456789012345678' }).discordId, '123456789012345678');
  assert.equal(toUser({ id: 1, username: 'a', discord_id: 'javascript:1' }).discordId, null);
  assert.equal(toUser({ id: 1, username: 'a', discord_id: '12' }).discordId, null);
  assert.equal(toUser({ id: 1, username: 'a' }).discordId, null);
});

test('links need a session, and say what this server can link', async () => {
  assert.equal((await fetch(`${base}/me/links`)).status, 401);
  const mine = await links(alice);
  assert.deepEqual(mine.discord, { linked: true, notify: false });
  assert.equal(mine.osu, null);
  // No BOT_TOKEN here; osu! configured; the dev login has no Mides to link with.
  assert.deepEqual(mine.available, { midesDiscord: false, bot: false, osu: true });
  assert.deepEqual((await links(bob)).discord, { linked: false, notify: false });
});

test('the Discord link goes to the Mides page, back to the profile, built from the server\'s own URLs', async () => {
  const response = await fetch(`${base}/links/discord/start`, { headers: { Cookie: bob } });
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, 'https://mides.example');
  assert.equal(url.pathname, '/connections/discord/link');
  assert.equal(url.searchParams.get('app'), 'overtone');
  assert.equal(url.searchParams.get('return_to'), 'http://localhost:5173/profile?linked=discord');
});

test('with the bot off, no link code is made and its routes say so', async () => {
  const code = await fetch(`${base}/links/discord/code`, { method: 'POST', headers: { ...JSON_BODY, Cookie: bob }, body: '{}' });
  assert.equal(code.status, 503);
  assert.equal((await code.json()).error.code, 'BOT_OFF');
  const health = await fetch(`${root}/api/internal/bot/health`, { headers: { Authorization: 'Bearer x'.padEnd(40, 'x') } });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).error.code, 'BOT_OFF');
});

test('DMs turn on only with Discord linked, and unlinking turns them off', async () => {
  const notify = (cookie, on, headers = JSON_BODY) =>
    fetch(`${base}/links/discord/notify`, { method: 'PUT', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ on }) });
  assert.equal((await notify(bob, true)).status, 409);
  assert.equal((await notify(alice, 'yes')).status, 400);
  assert.equal((await notify(alice, true, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await notify(alice, true)).status, 200);
  assert.deepEqual((await links(alice)).discord, { linked: true, notify: true });

  const unlink = await fetch(`${base}/links/discord`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
  assert.equal(unlink.status, 204);
  assert.deepEqual((await links(alice)).discord, { linked: false, notify: false });
  // Signing in again through a Mides that sends the id links it again.
  alice = await signIn('discord');
  assert.deepEqual((await links(alice)).discord, { linked: true, notify: false });
});

/** Starts an osu! link for `cookie`: the authorize URL and the state cookie. */
const startOsu = async (cookie) => {
  const response = await fetch(`${base}/links/osu/start`, { method: 'POST', headers: { ...JSON_BODY, Cookie: cookie }, body: '{}' });
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  const state = response.headers.getSetCookie().find((c) => c.startsWith('overtone_osu='));
  assert.match(state, /Path=\/api\/v1\/links\/osu/);
  assert.match(state, /HttpOnly/);
  osu.challenge = url.searchParams.get('code_challenge');
  return { url, stateCookie: state.split(';')[0] };
};

const exchangeOsu = (cookie, stateCookie, body) =>
  fetch(`${base}/links/osu/exchange`, {
    method: 'POST',
    headers: { ...JSON_BODY, Cookie: [cookie, stateCookie].filter(Boolean).join('; ') },
    body: JSON.stringify(body),
  });

test('the osu! authorize URL asks for identify only, with a state and an S256 challenge', async () => {
  const { url } = await startOsu(bob);
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), '4242');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/link/osu');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{20,}$/);
  // The verifier is not in the URL or in the cookie: only its challenge travels.
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
});

test('osu! links: code exchanged server side with the PKCE verifier, /me read once, the token kept nowhere', async () => {
  osu.me = { id: 2, username: 'peppy', avatar_url: 'https://a.ppy.sh/2', ranked_beatmapset_count: 7, email: 'never@kept' };
  const { url, stateCookie } = await startOsu(bob);
  const before = { token: osu.tokenCalls, me: osu.meCalls };
  const response = await exchangeOsu(bob, stateCookie, { code: 'good-code', state: url.searchParams.get('state') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual({ ...body.osu, linkedAt: undefined }, { id: 2, username: 'peppy', avatarUrl: 'https://a.ppy.sh/2', rankedCount: 7, linkedAt: undefined });
  assert.equal(osu.tokenCalls - before.token, 1);
  assert.equal(osu.meCalls - before.me, 1);
  assert.equal(osu.lastTokenBody.grant_type, 'authorization_code');
  assert.ok(!JSON.stringify(body).includes('osu-access'));
  // The state cookie is spent.
  assert.ok(response.headers.getSetCookie().some((c) => c.startsWith('overtone_osu=;') && c.includes('Max-Age=0')));
  assert.equal((await links(bob)).osu.username, 'peppy');

  const unlink = await fetch(`${base}/links/osu`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: bob } });
  assert.equal(unlink.status, 204);
  assert.equal((await links(bob)).osu, null);
});

test('an osu! return without its own state, or for another account, is refused before osu! is called', async () => {
  const { url, stateCookie } = await startOsu(bob);
  const state = url.searchParams.get('state');
  const calls = osu.tokenCalls;
  for (const [cookie, sc, body] of [
    [bob, null, { code: 'good-code', state }],
    [bob, stateCookie, { code: 'good-code', state: 'another-state' }],
    [alice, stateCookie, { code: 'good-code', state }],
  ]) {
    const response = await exchangeOsu(cookie, sc, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'OSU_STATE_MISSING');
  }
  assert.equal(osu.tokenCalls, calls);
  assert.equal((await exchangeOsu(bob, stateCookie, { state })).status, 400);
});

test('a stale osu! code, or a verifier that does not match the challenge, is refused', async () => {
  let { url, stateCookie } = await startOsu(bob);
  let response = await exchangeOsu(bob, stateCookie, { code: 'stale-code', state: url.searchParams.get('state') });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'OSU_CODE_INVALID');

  ({ url, stateCookie } = await startOsu(bob));
  // A verifier that does not match the challenge osu! saw (an intercepted code
  // replayed from another start) is refused by osu!.
  osu.challenge = 'not-the-challenge';
  response = await exchangeOsu(bob, stateCookie, { code: 'good-code', state: url.searchParams.get('state') });
  assert.equal(response.status, 400);
});

test('osu!\'s /me is reduced to four fields; an avatar off ppy.sh is dropped', () => {
  assert.deepEqual(toOsuProfile({ id: 5, username: 'a\u0000b', avatar_url: 'https://evil.example/x.png', ranked_and_approved_beatmapset_count: 3 }), {
    id: 5, username: 'ab', avatarUrl: null, rankedCount: 3,
  });
  assert.equal(toOsuProfile({ id: 'x', username: 'a' }), null);
  assert.equal(toOsuProfile({ id: 5, username: '' }), null);
  assert.equal(toOsuProfile({ id: 5, username: 'a' }).rankedCount, null);
});

test('link codes read as typed: case, spaces and the dash do not matter, look-alikes are not in it', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' AB CD EF GH '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD-EFG0'), null);
  assert.equal(normalizeCode('ABCD-EFGI'), null);
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode(42), null);
});
