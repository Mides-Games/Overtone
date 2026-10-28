import assert from 'node:assert/strict';
import { test } from 'node:test';

// The web's half of the login guard (site/web/src/lib/sso-guard.js): plain
// JavaScript with no JSX, so this suite, the site's only runner, covers it.
globalThis.window = { location: { origin: 'https://overtone.example' } };
const { MIDES_ERRORS, midesErrorOf, sitePath } = await import('../../web/src/lib/sso-guard.js');

test('a refusal Mides sends back in the fragment is read as a short code, nothing else', () => {
  assert.equal(midesErrorOf('#error=redirect_not_allowed'), 'redirect_not_allowed');
  assert.equal(midesErrorOf('error=discord_mismatch&x=1'), 'discord_mismatch');
  assert.ok(MIDES_ERRORS.includes('redirect_not_allowed'));
  // Anything that is not a short lowercase code is not shown, not even as text.
  for (const hash of ['', '#code=abc', '#error=<script>', '#error=' + 'a'.repeat(41), '#error=Bad', null]) {
    assert.equal(midesErrorOf(hash), null, String(hash));
  }
});

test('the return path after sign-in stays on this site, however it is spelled', () => {
  assert.equal(sitePath('/profile'), '/profile');
  assert.equal(sitePath('/analyses/abc?x=1#y'), '/analyses/abc?x=1#y');
  // Browsers read each of these as another host.
  for (const value of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example',
    '\\\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', 42, null]) {
    assert.equal(sitePath(value), null, JSON.stringify(value));
  }
});
