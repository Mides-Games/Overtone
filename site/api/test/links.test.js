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

const osu = { challenge: null, tokenCalls: 0, meCalls: 0, lastTokenBody: null, me: null, appTokens: 0, userCalls: 0, user: null };
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
      // The refresh's app token: client credentials, `public` only, no user behind it.
      if (b.grant_type === 'client_credentials') {
        osu.appTokens += 1;
        return b.scope === 'public' ? send(200, { access_token: 'osu-app', token_type: 'Bearer', expires_in: 86400 }) : send(400, { error: 'invalid_scope' });
      }
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
    // No ruleset in the path: osu! answers with the account's own, as /me does.
    const user = /^\/api\/v2\/users\/(\d+)\?key=id$/.exec(req.url);
    if (req.method === 'GET' && user) {
      osu.userCalls += 1;
      if (req.headers.authorization !== 'Bearer osu-app') return send(401, {});
      return osu.user && String(osu.user.id) === user[1] ? send(200, osu.user) : send(404, {});
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
// Unset by default (env.js says why); a Mides that serves the page is set up like this.
process.env.MIDES_DISCORD_LINK_PATH = '/connections/discord/link';
process.env.OSU_CLIENT_ID = '4242';
process.env.OSU_CLIENT_SECRET = 'osu-test-secret';
process.env.OSU_REDIRECT_URI = 'http://localhost:5173/link/osu';
process.env.OSU_URL = `http://127.0.0.1:${fakeOsu.address().port}`;
process.env.SPOOL_DIR = mkdtempSync(join(tmpdir(), 'overtone-links-'));
const { app } = await import('../src/app.js');
const { toUser } = await import('../src/services/mides.service.js');
const { normalizeCode } = await import('../src/services/links.service.js');
const { cleanDetails, toOsuProfile } = await import('../src/services/osu.service.js');

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
  assert.deepEqual(mine.discord, { linked: true, notify: false, username: null });
  assert.equal(mine.osu, null);
  // No BOT_TOKEN here; osu! configured; the dev login has no Mides to link with.
  assert.deepEqual(mine.available, { midesDiscord: false, bot: false, osu: true });  assert.deepEqual((await links(bob)).discord, { linked: false, notify: false, username: null });
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
  assert.deepEqual((await links(alice)).discord, { linked: true, notify: true, username: null });

  const unlink = await fetch(`${base}/links/discord`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
  assert.equal(unlink.status, 204);
  assert.deepEqual((await links(alice)).discord, { linked: false, notify: false, username: null });
  // Signing in again through a Mides that sends the id links it again.
  alice = await signIn('discord');
  assert.deepEqual((await links(alice)).discord, { linked: true, notify: false, username: null });
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
  osu.me = {
    id: 2, username: 'peppy', avatar_url: 'https://a.ppy.sh/2', ranked_beatmapset_count: 7, email: 'never@kept', country_code: 'AU',
    statistics: { global_rank: 1234, country_rank: 56, pp: 4321.987, hit_accuracy: 98.765, play_count: 4500 },
  };
  const { url, stateCookie } = await startOsu(bob);
  const before = { token: osu.tokenCalls, me: osu.meCalls };
  const response = await exchangeOsu(bob, stateCookie, { code: 'good-code', state: url.searchParams.get('state') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual({ ...body.osu, linkedAt: undefined, refreshedAt: undefined, details: undefined }, {
    id: 2, username: 'peppy', url: 'https://osu.ppy.sh/users/2', country: 'AU', globalRank: 1234, countryRank: 56,
    pp: 4321.99, accuracy: 98.77, playCount: 4500, rankedCount: 7, linkedAt: undefined, refreshedAt: undefined, details: undefined,
  });
  // A /me with none of the wider fields gives a wider card of blanks, not a guess.
  assert.deepEqual(body.osu.details, {
    mode: null, level: null, grades: null, playTime: null, rankedScore: null, totalHits: null, maxCombo: null, replaysWatched: null,
    firstPlaces: null, medals: null, peakRank: null, rankHistory: [], monthlyPlays: [], joinedAt: null, supporter: false,
    followers: null, mappingFollowers: null, kudosu: null, maps: null, groups: [],
  });
  // The avatar is kept but not sent: the page loads no image from osu!'s host.
  assert.ok(!JSON.stringify(body).includes('a.ppy.sh'));
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

const refresh = (cookie, headers = JSON_BODY) => fetch(`${base}/links/osu/refresh`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: '{}' });

test('the osu! card refreshes only on the owner\'s press, with the app\'s token, at most once in five minutes', async () => {
  // Not linked: nothing to refresh, and osu! is not asked.
  const calls = osu.userCalls;
  assert.equal((await refresh(alice)).status, 409);
  assert.equal((await refresh(alice, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal(osu.userCalls, calls);

  osu.me = { id: 9, username: 'mapper', ranked_beatmapset_count: 0, statistics: { global_rank: 900, pp: 100 } };
  const { url, stateCookie } = await startOsu(alice);
  assert.equal((await exchangeOsu(alice, stateCookie, { code: 'good-code', state: url.searchParams.get('state') })).status, 200);
  // Just linked: the card is fresh, so a refresh waits.
  const soon = await refresh(alice);
  assert.equal(soon.status, 429);
  assert.equal((await soon.json()).error.code, 'OSU_REFRESH_SOON');
  assert.equal(osu.userCalls, calls);

  // Five minutes on (the stored time moved back by hand), it reads /users/9/osu.
  const { memory } = await import('../src/services/account.service.js');
  const row = [...memory.accounts.values()].find((a) => Number(a.osu_user_id) === 9);
  row.osu_refreshed_at = new Date(Date.now() - 6 * 60_000);
  osu.user = { id: 9, username: 'mapper', ranked_beatmapset_count: 3, country_code: 'ES', statistics: { global_rank: 800, pp: 150.5 } };
  const fresh = await refresh(alice);
  assert.equal(fresh.status, 200);
  const card = (await fresh.json()).osu;
  assert.equal(card.rankedCount, 3);
  assert.equal(card.globalRank, 800);
  assert.equal(card.country, 'ES');
  assert.equal(osu.userCalls, calls + 1);
  assert.equal(osu.lastTokenBody.grant_type, 'client_credentials');
  // A ranked osu! account earns the profile its badge.
  const profile = await (await fetch(`${base}/me/profile`, { headers: { Cookie: alice } })).json();
  assert.ok(profile.badges.includes('ranked-mapper'));
  assert.equal(profile.osu.username, 'mapper');
  // And nobody's page view asks osu! anything.
  await fetch(`${base}/users/dev_discord`);
  assert.equal(osu.userCalls, calls + 1);
  await fetch(`${base}/links/osu`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
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

test('osu!\'s /me is reduced to an allow-list; an avatar off ppy.sh and numbers out of range are dropped', () => {
  const plain = toOsuProfile({ id: 5, username: 'a\u0000b', avatar_url: 'https://evil.example/x.png', ranked_and_approved_beatmapset_count: 3 });
  assert.deepEqual({ ...plain, details: undefined }, {
    id: 5, username: 'ab', avatarUrl: null, rankedCount: 3, country: null, globalRank: null, countryRank: null, pp: null, accuracy: null, playCount: null,
    details: undefined,
  });
  const odd = toOsuProfile({
    id: 5, username: 'a', country_code: 'es<script>', statistics: { global_rank: -1, country_rank: 1.5, pp: 'lots', hit_accuracy: 101, play_count: 2 ** 40 },
  });
  assert.deepEqual([odd.country, odd.globalRank, odd.countryRank, odd.pp, odd.accuracy, odd.playCount], [null, null, null, null, null, null]);
  assert.equal(toOsuProfile({ id: 'x', username: 'a' }), null);
  assert.equal(toOsuProfile({ id: 5, username: '' }), null);
  assert.equal(toOsuProfile({ id: 5, username: 'a' }).rankedCount, null);
});

/** An osu! UserExtended as /me and /users/{id} send it, cut to what the wider card reads (2026-11-07). */
const RICH_ME = {
  id: 7, username: 'mania_mapper', country_code: 'AR', playmode: 'mania', is_supporter: true, join_date: '2015-03-02T18:04:11+00:00',
  follower_count: 812, mapping_follower_count: 140, kudosu: { total: 233, available: 12 }, scores_first_count: 4,
  ranked_beatmapset_count: 5, loved_beatmapset_count: 1, guest_beatmapset_count: 9, pending_beatmapset_count: 2,
  graveyard_beatmapset_count: 31, nominated_beatmapset_count: 0, favourite_beatmapset_count: 77,
  user_achievements: [{ achievement_id: 1 }, { achievement_id: 2 }, { achievement_id: 3 }],
  rank_highest: { rank: 2950, updated_at: '2023-08-01T00:00:00Z' },
  rank_history: { mode: 'mania', data: [...Array.from({ length: 100 }, (_, i) => 5000 - i * 10), 0] },
  monthly_playcounts: Array.from({ length: 30 }, (_, i) => ({ start_date: `20${22 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, count: i * 3 })).reverse(),
  groups: [
    { short_name: 'BN', name: 'Beatmap Nominators', colour: '#A347EB', is_probationary: true },
    { short_name: '<b>', name: 'x', colour: 'red' },
  ],
  statistics: {
    global_rank: 4120, country_rank: 31, pp: 6543.21, hit_accuracy: 97.5, play_count: 15000, play_time: 1_234_567,
    ranked_score: 9_876_543_210, total_hits: 4_000_000, maximum_combo: 3456, replays_watched_by_others: 12,
    level: { current: 101, progress: 42 }, grade_counts: { ss: 10, ssh: 2, s: 300, sh: 15, a: 800 },
  },
};

test('the wider osu! card keeps its own shape: the ruleset, the last 90 days and 24 months, groups checked', () => {
  const { details } = toOsuProfile(RICH_ME);
  assert.equal(details.mode, 'mania');
  assert.deepEqual(details.level, { current: 101, progress: 42 });
  assert.deepEqual(details.grades, { ssh: 2, ss: 10, sh: 15, s: 300, a: 800 });
  assert.equal(details.rankedScore, 9_876_543_210);
  assert.deepEqual([details.playTime, details.totalHits, details.maxCombo, details.replaysWatched], [1_234_567, 4_000_000, 3456, 12]);
  assert.deepEqual([details.firstPlaces, details.medals, details.followers, details.mappingFollowers, details.kudosu], [4, 3, 812, 140, 233]);
  assert.deepEqual(details.peakRank, { rank: 2950, at: '2023-08-01T00:00:00.000Z' });
  assert.equal(details.joinedAt, '2015-03-02T18:04:11.000Z');
  assert.equal(details.supporter, true);
  // The last 90 days, oldest first; a day osu! sends as 0 (unranked) is a gap.
  assert.equal(details.rankHistory.length, 90);
  assert.equal(details.rankHistory.at(-1), null);
  assert.equal(details.rankHistory.at(-2), 5000 - 99 * 10);
  // Months oldest first whatever order osu! sends, the last 24.
  assert.equal(details.monthlyPlays.length, 24);
  assert.deepEqual(details.monthlyPlays[0], { month: '2022-07', count: 18 });
  assert.deepEqual(details.monthlyPlays.at(-1), { month: '2024-06', count: 87 });
  assert.deepEqual(details.maps, { loved: 1, guest: 9, pending: 2, graveyard: 31, nominated: 0, favourite: 77 });
  // A group with a short name that is not one, or a colour that is not a hex, is dropped or blanked.
  assert.deepEqual(details.groups, [{ short: 'BN', name: 'Beatmap Nominators', colour: '#a347eb', probationary: true }]);

  // What a stored row reads back as: the same, and anything else in it goes.
  assert.deepEqual(cleanDetails(JSON.parse(JSON.stringify(details))), details);
  const edited = cleanDetails({ ...details, extra: '<script>', mode: 'osu!', level: { current: 'x' }, groups: [{ short: 'GMT', name: 'a\u0007b', colour: 'url(x)' }] });
  assert.equal(edited.extra, undefined);
  assert.equal(edited.mode, null);
  assert.equal(edited.level, null);
  assert.deepEqual(edited.groups, [{ short: 'GMT', name: 'ab', colour: null, probationary: false }]);
  assert.equal(cleanDetails('not an object'), null);
  assert.equal(cleanDetails([]), null);
});

test('a refresh asks for no ruleset and keeps the account\'s own, wider card included', async () => {
  osu.me = { ...RICH_ME, id: 11, username: 'mania_one' };
  const { url, stateCookie } = await startOsu(alice);
  assert.equal((await exchangeOsu(alice, stateCookie, { code: 'good-code', state: url.searchParams.get('state') })).status, 200);
  const linked = (await links(alice)).osu;
  assert.equal(linked.details.mode, 'mania');
  assert.equal(linked.details.groups[0].short, 'BN');

  const { memory } = await import('../src/services/account.service.js');
  const row = [...memory.accounts.values()].find((a) => Number(a.osu_user_id) === 11);
  row.osu_refreshed_at = new Date(Date.now() - 6 * 60_000);
  osu.user = { ...RICH_ME, id: 11, username: 'mania_one', statistics: { ...RICH_ME.statistics, global_rank: 4000 } };
  const fresh = await refresh(alice);
  assert.equal(fresh.status, 200);
  const card = (await fresh.json()).osu;
  assert.equal(card.globalRank, 4000);
  assert.equal(card.details.mode, 'mania');
  assert.equal(card.details.rankHistory.length, 90);

  // A link made before the wider card has no details until its next Refresh.
  row.osu_details = null;
  assert.equal((await links(alice)).osu.details, null);
  await fetch(`${base}/links/osu`, { method: 'DELETE', headers: { ...SAME_ORIGIN, Cookie: alice } });
  assert.equal(row.osu_details, null);
});

test('link codes read as typed: case, spaces and the dash do not matter, look-alikes are not in it', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' AB CD EF GH '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD-EFG0'), null);
  assert.equal(normalizeCode('ABCD-EFGI'), null);
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode(42), null);
});
