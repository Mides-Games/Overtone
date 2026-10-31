import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.MIDES_AUTH_URL = 'https://mides.example/api';
process.env.MIDES_WEB_URL = 'https://mides.example';
process.env.MIDES_CLIENT_SECRET = 'test-client-secret-test-client-secret';
process.env.MIDES_IMAGE_ORIGINS = 'https://cdn.mides.example';
const mides = await import('../src/services/mides.service.js');
const { absolute, exchangeCode } = mides;

test('only images on Mides\' own origins are kept', () => {
  assert.equal(absolute('/api/profile/avatar/a.png'), 'https://mides.example/api/profile/avatar/a.png');
  assert.equal(absolute('https://mides.example/b.png'), 'https://mides.example/b.png');
  assert.equal(absolute(' https://cdn.mides.example/c.webp '), 'https://cdn.mides.example/c.webp');
  for (const value of [
    'https://tracker.example/pixel.png', // anyone else's host learns who views the queue
    'https://mides.example.evil.test/a.png',
    'http://mides.example/a.png', // the right host, the wrong scheme: another origin
    'https://user:pw@mides.example/a.png',
    '//tracker.example/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'avatar.png',
    '',
    null,
  ]) {
    assert.equal(absolute(value), null, String(value));
  }
});

const answer = (status, body) => async (url, init) => {
  answer.last = { url, body: JSON.parse(init.body) };
  return { status, json: async () => body };
};

test('the code exchange sends this app and its secret', async () => {
  globalThis.fetch = answer(200, {
    access_token: 'scoped',
    user: { id: 7, username: 'mapper', full_name: '', nickname: 'Map', photo_url: '/api/profile/avatar/a.png', banner_url: null, is_moderator: true },
  });
  const { user, ...rest } = await exchangeCode('the-code');
  assert.equal(answer.last.url, 'https://mides.example/api/auth/sso/exchange');
  assert.deepEqual(answer.last.body, { code: 'the-code', app: 'overtone', client_secret: 'test-client-secret-test-client-secret' });
  assert.deepEqual(rest, {}, 'no refresh token, no access token kept');
  assert.deepEqual(user, {
    midesUserId: '7',
    username: 'mapper',
    displayName: 'Map',
    avatarUrl: 'https://mides.example/api/profile/avatar/a.png',
    bannerUrl: null,
    discordId: null,
    discordUsername: null,
    midesRank: 'moderator',
    role: 'moderator',
  });
});

test('a Discord username is read only beside a Discord id, as text of the names Discord allows', () => {
  const { toUser } = mides;
  assert.equal(toUser({ id: 1, username: 'a', discord_id: '123456789012345678', discord_username: 'Some.Name_1' }).discordUsername, 'some.name_1');
  assert.equal(toUser({ id: 1, username: 'a', discord_username: '<img src=x>' }).discordUsername, null);
  assert.equal(toUser({ id: 1, username: 'a', discord_username: 'x' }).discordUsername, null);
});

test('an account Mides will not let in is told so, not shown a server error', async () => {
  globalThis.fetch = answer(403, { error: 'forbidden' });
  await assert.rejects(exchangeCode('c'), (error) => error.status === 403 && error.code === 'MIDES_FORBIDDEN');
});

test('the pre-flight reads where Mides would send the browser, and never follows it', () => {
  const { readProbe } = mides;
  const web = 'https://mides.example';
  // Mides knows the app: the provider's own page (or Mides' /authorize when that provider is off there).
  assert.equal(readProbe(302, 'https://discord.com/oauth2/authorize?client_id=1', web), 'ready');
  assert.equal(readProbe(302, '/authorize?app=overtone&redirect_uri=x', web), 'ready');
  // Mides does not: its own error page, where a real sign-in would strand the person.
  assert.equal(readProbe(302, 'https://mides.example/oauth/callback#error=redirect_not_allowed', web), 'app_unknown');
  assert.equal(readProbe(302, '/oauth/callback#error=redirect_not_allowed', web), 'app_unknown');
  // Anything else is no reason to block.
  assert.equal(readProbe(302, '/oauth/callback#error=bad_state', web), 'unknown');
  assert.equal(readProbe(429, null, web), 'unknown');
  assert.equal(readProbe(200, null, web), 'unknown');
});

test('the pre-flight asks Mides\' SSO start with this app and its callback, and keeps the answer', async () => {
  const { ssoStatus, resetSsoStatus } = mides;
  resetSsoStatus();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    const probe = new URL(url);
    assert.equal(`${probe.origin}${probe.pathname}`, 'https://mides.example/api/auth/discord/start');
    assert.equal(probe.searchParams.get('sso_app'), 'overtone');
    assert.match(probe.searchParams.get('sso_redirect'), /\/login\/callback$/);
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://mides.example/oauth/callback#error=redirect_not_allowed' } });
  };
  assert.equal(await ssoStatus(), 'app_unknown');
  assert.equal(await ssoStatus(), 'app_unknown');
  assert.equal(calls, 1, 'kept, so /login traffic does not become Mides traffic');

  resetSsoStatus();
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await ssoStatus(), 'unreachable');
  resetSsoStatus();
});

test('a profile without the moderator flag keeps no role', async () => {
  globalThis.fetch = answer(200, { access_token: 'scoped', user: { id: 8, username: 'x', role: 'owner' } });
  const { user } = await exchangeCode('c');
  assert.equal(user.role, null, 'a global role Mides should not have sent is not taken');
});

test('a refused secret is the server\'s configuration, not the person\'s code', async () => {
  for (const [status, body] of [[401, { error: 'invalid_client' }], [503, { error: 'sso_not_configured' }]]) {
    globalThis.fetch = answer(status, body);
    await assert.rejects(exchangeCode('c'), (error) => error.status === 503 && error.code === 'MIDES_UNAVAILABLE');
  }
  globalThis.fetch = answer(401, { error: 'invalid_code' });
  await assert.rejects(exchangeCode('c'), (error) => error.code === 'SSO_CODE_INVALID');
});
