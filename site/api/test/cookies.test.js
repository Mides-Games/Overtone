import assert from 'node:assert/strict';
import { test } from 'node:test';

// Over plain http (development) a __Host- cookie would be dropped by the browser.
delete process.env.SITE_URL;
const session = await import('../src/services/session.service.js');

test('over http the cookies keep their plain names and are not Secure', () => {
  assert.equal(session.COOKIE, 'overtone_session');
  assert.equal(session.ANON_COOKIE, 'overtone_anon');
  const parts = session.anonCookieHeader('y').split('; ');
  assert.ok(parts.includes('Path=/'));
  assert.ok(!parts.includes('Secure'));
});

test('a cookie name sent twice is treated as absent', () => {
  const jar = session.cookiesOf({ headers: { cookie: 'overtone_anon=mine; theme=dark; overtone_anon=planted' } });
  assert.equal(jar.overtone_anon, undefined);
  assert.equal(jar.theme, 'dark');
  // Even when one of the two does not decode.
  assert.equal(session.cookiesOf({ headers: { cookie: 'overtone_session=%E0%A4%A; overtone_session=b' } }).overtone_session, undefined);
  assert.equal(session.cookiesOf({ headers: { cookie: 'overtone_session=a' } }).overtone_session, 'a');
});
