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
  // Only a path on this site: a stored full URL would be an open redirect.
  const returnTo = typeof note.returnTo === 'string' && /^\/(?!\/)/.test(note.returnTo) ? note.returnTo : '/profile'
  return { returnTo }
}
