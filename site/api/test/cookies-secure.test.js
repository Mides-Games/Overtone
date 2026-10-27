import assert from 'node:assert/strict';
import { test } from 'node:test';

// Served over https: every cookie is Secure, so the session and anonymous ones are __Host-.
process.env.SITE_URL = 'https://overtone.example.test';
const session = await import('../src/services/session.service.js');

const attributes = (header) => header.split('; ');

test('over https the session and anonymous cookies are __Host-: Secure, Path=/, no Domain', () => {
  assert.equal(session.COOKIE, '__Host-overtone_session');
  assert.equal(session.ANON_COOKIE, '__Host-overtone_anon');
  for (const header of [session.cookieHeader('x'), session.clearedCookieHeader(), session.anonCookieHeader('y')]) {
    const parts = attributes(header);
    assert.ok(parts[0].startsWith('__Host-'), header);
    assert.ok(parts.includes('Secure'), header);
    assert.ok(parts.includes('Path=/'), header);
    assert.ok(parts.includes('HttpOnly'), header);
    assert.ok(!parts.some((p) => /^domain=/i.test(p)), header);
  }
});

test('a session signed by this server is read back from its __Host- cookie', () => {
  const token = session.issue('acc-1', 3);
  const req = { headers: { cookie: `${session.COOKIE}=${encodeURIComponent(token)}` } };
  assert.deepEqual(session.read(session.cookiesOf(req)[session.COOKIE]), { accountId: 'acc-1', version: 3 });
  // The old unprefixed name is not read: a sibling host could have set it.
  const legacy = { headers: { cookie: `overtone_session=${encodeURIComponent(token)}` } };
  assert.equal(session.cookiesOf(legacy)[session.COOKIE], undefined);
});
