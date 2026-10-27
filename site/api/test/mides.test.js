import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.MIDES_AUTH_URL = 'https://mides.example/api';
process.env.MIDES_WEB_URL = 'https://mides.example';
process.env.MIDES_CLIENT_SECRET = 'test-client-secret-test-client-secret';
const { exchangeCode } = await import('../src/services/mides.service.js');

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
    role: 'moderator',
  });
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
