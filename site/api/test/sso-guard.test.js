import assert from 'node:assert/strict';
import { test } from 'node:test';

// The web's half of the login guard (site/web/src/lib/sso-guard.js): plain
// JavaScript with no JSX, so this suite, the site's only runner, covers it.
globalThis.window = { location: { origin: 'https://overtone.example' } };
const { sitePath } = await import('../../web/src/lib/sso-guard.js');

test('the return path after sign-in stays on this site, however it is spelled', () => {
  assert.equal(sitePath('/profile'), '/profile');
  assert.equal(sitePath('/analyses/abc?x=1#y'), '/analyses/abc?x=1#y');
  // Browsers read each of these as another host.
  for (const value of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example',
    '\\\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', 42, null]) {
    assert.equal(sitePath(value), null, JSON.stringify(value));
  }
});
