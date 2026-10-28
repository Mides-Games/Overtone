/**
 * The browser's half of the login-CSRF guard, ported from cavernia-web's
 * `lib/sso-guard.js`.
 *
 * `/login/callback` exchanges the `#code=` in its URL, and anybody can put a
 * code there: a link with someone else's code would sign whoever opens it into
 * that account. So before leaving for Mides this browser notes that it left
 * (and where to come back to), and the callback only exchanges when it finds
 * a fresh note, which it then deletes. The API's signed cookie is the other half.
 *
 * localStorage rather than sessionStorage: on a phone the Discord or Google app
 * may hand the login back in another tab, where sessionStorage is empty.
 */

const KEY = 'overtone.sso'
const FRESH_MS = 10 * 60_000

/**
 * Only https is a place to send someone to sign in; in development, http to
 * this machine too (the dev login comes straight back to localhost).
 */
function safeHref(url) {
  let parsed
  try {
    parsed = new URL(url, window.location.origin)
  } catch {
    return null
  }
  if (parsed.protocol === 'https:') return parsed.href
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  return local && parsed.protocol === 'http:' ? parsed.href : null
}

export function leaveForSignIn(url, returnTo = '/profile') {
  const href = safeHref(url)
  if (!href) throw new Error('unsafe sign-in redirect')

  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), returnTo }))
  } catch {
    // Without storage there is no note, and the callback will refuse: with
    // storage blocked there would be no session cookie either.
  }
  window.location.assign(href)
}

/** The note, if fresh, and removed either way. `null` means: do not exchange. */
export function takeSignInNote() {
  let note = null
  try {
    note = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    localStorage.removeItem(KEY)
  } catch {
    return null
  }
  if (!note || !(Date.now() - note.at < FRESH_MS)) return null
  return { returnTo: sitePath(note.returnTo) ?? '/profile' }
}

/**
 * The reasons Mides sends back as `#error=<reason>` instead of a code (its
 * oauth.py: `_fail_for` and `_sso_callback`), each with its own words on
 * /login; anything else is shown by its code.
 */
export const MIDES_ERRORS = [
  'redirect_not_allowed',
  'discord_mismatch',
  'sanctioned',
  'account_blocked',
  'cancelled',
  'bad_state',
  'token_error',
  'provider_error',
]

/** The `error` of a callback's fragment: a short code of letters and `_`, or null. */
export function midesErrorOf(hash) {
  const raw = new URLSearchParams(String(hash ?? '').replace(/^#/, '')).get('error')
  return raw && /^[a-z_]{1,40}$/.test(raw) ? raw : null
}

/**
 * Only a path on this site: a stored full URL would be an open redirect.
 * Browsers read `/\evil.example` (and `/<tab>/evil.example`) as
 * `//evil.example`, another host, so the check is the resolved URL's origin,
 * not the text's first characters.
 */
export function sitePath(value, origin = window.location.origin) {
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) return null
  let url
  try {
    url = new URL(value, origin)
  } catch {
    return null
  }
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null
}
