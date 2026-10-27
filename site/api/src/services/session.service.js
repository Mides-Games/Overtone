import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env, secureCookies } from '../config/env.js';

/**
 * The site's session: a signed cookie, and nothing more. Ported from
 * cavernia-api's `session.service.js`.
 *
 * Why signed and not a row: a session row costs a database read on every
 * request of every visitor, and buys per-session revocation this site does not
 * need. What it does need is covered: changing SESSION_SECRET ends every
 * session at once, and the cookie carries the account's `session_version`, so
 * signing out (which bumps it) ends that account's sessions everywhere.
 *
 * Why by hand and not a JWT library: this is an HMAC over a string and a date.
 * A JWT brings negotiable algorithms, `none` included, to store three fields.
 *
 * What is inside: this site's account id, the expiry and the version. Never
 * the Mides token, which stays on the server, and no personal data.
 */

/**
 * A cookie's name, `__Host-` prefixed whenever cookies are Secure. The browser
 * accepts a `__Host-` cookie only when it is Secure, has Path=/ and no
 * Domain, so no other host under the same domain (any *.midesprojects.com)
 * can set or shadow it: without the prefix a sibling subdomain could plant
 * its own anonymous cookie in a visitor's browser and then read every
 * analysis that visitor uploads. Over plain http (development) the prefix
 * would make the browser drop the cookie, so it is left off there.
 */
const hostCookie = (name) => (secureCookies() ? `__Host-${name}` : name);

export const COOKIE = hostCookie('overtone_session');

/** The anonymous uploader's cookie (routes/analyses.routes.js). */
export const ANON_COOKIE = hostCookie('overtone_anon');

/** The separator appears in neither a uuid nor base64url, so splitting is unambiguous. */
const SEP = '.';

/** Every cookie of the auth flow is scoped to the auth routes. */
const AUTH_PATH = '/api/v1/auth';

export const issue = (accountId, version = 0) => {
  const expiresAt = Date.now() + env.sessionDays * 24 * 60 * 60 * 1000;
  const payload = `${accountId}${SEP}${expiresAt}${SEP}${version}`;

  return `${payload}${SEP}${sign(`session:${payload}`)}`;
};

/**
 * From the cookie to `{ accountId, version }`, or `null` for anything that is
 * not a valid, current session: malformed, signed with another secret, expired.
 * The caller does not need to know which.
 */
export const read = (token) => {
  if (typeof token !== 'string') return null;

  const cut = token.lastIndexOf(SEP);
  if (cut < 0) return null;

  const payload = token.slice(0, cut);
  if (!matches(token.slice(cut + 1), sign(`session:${payload}`))) return null;

  const [accountId, expiresAt, version, ...rest] = payload.split(SEP);
  if (!accountId || !expiresAt || rest.length) return null;
  if (!(Number(expiresAt) > Date.now())) return null;
  if (!/^\d{1,9}$/.test(version ?? '')) return null;

  return { accountId, version: Number(version) };
};

const cookie = (name, value, { path = '/', maxAge }) =>
  [
    `${name}=${value}`,
    `Path=${path}`,
    // No script reads it, so an XSS cannot carry it away.
    'HttpOnly',
    // Not sent on requests another site triggers: half of CSRF. The other half
    // is the header `requireSameOrigin` demands.
    'SameSite=Lax',
    // Over http in development a Secure cookie would simply not be stored.
    secureCookies() ? 'Secure' : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join('; ');

export const cookieHeader = (token) => cookie(COOKIE, token, { maxAge: env.sessionDays * 24 * 60 * 60 });

export const clearedCookieHeader = () => cookie(COOKIE, '', { maxAge: 0 });

/** A year, Path=/ (a `__Host-` cookie can have no other). */
export const anonCookieHeader = (token) => cookie(ANON_COOKIE, token, { maxAge: 365 * 24 * 60 * 60 });

// ── The trip to the SSO (login CSRF) ─────────────────────────────────────────
//
// Whoever comes back from Mides brings a code in the URL, and anybody can
// bring a code: a link to `/login/callback#code=<someone else's>` would sign
// the person who opens it into someone else's account without them knowing.
// So `/auth/sso/start` sets this signed, short cookie, only for /api/v1/auth,
// and the exchange demands it: a browser that did not leave for Mides from
// here exchanges nothing.

export const SSO_COOKIE = 'overtone_sso';

/** How long the trip may take: going through Mides and back, with margin. */
export const SSO_MINUTES = 10;

export const issueSsoStart = () => {
  const payload = `${randomBytes(16).toString('base64url')}${SEP}${Date.now() + SSO_MINUTES * 60_000}`;

  return `${payload}${SEP}${sign(`sso:${payload}`)}`;
};

/** Whether the cookie is a trip this server signed and that is still current. */
export const readSsoStart = (token) => {
  if (typeof token !== 'string') return false;

  const cut = token.lastIndexOf(SEP);
  if (cut < 0) return false;

  const payload = token.slice(0, cut);
  if (!matches(token.slice(cut + 1), sign(`sso:${payload}`))) return false;

  const [nonce, expiresAt, ...rest] = payload.split(SEP);
  return Boolean(nonce) && Number(expiresAt) > Date.now() && rest.length === 0;
};

export const ssoCookieHeader = (token) => cookie(SSO_COOKIE, token, { path: AUTH_PATH, maxAge: SSO_MINUTES * 60 });

export const clearedSsoCookieHeader = () => cookie(SSO_COOKIE, '', { path: AUTH_PATH, maxAge: 0 });

/**
 * A request's cookies. By hand, without cookie-parser: split on `;` and the
 * first `=`. A cookie with a stray `%` (from another site on the same domain)
 * is skipped instead of turning the whole request into a 500.
 *
 * A name that arrives twice is treated as absent. Two cookies of one name
 * means a second one was set from somewhere else (another path, or a sibling
 * host where the `__Host-` prefix is off), and which one the browser sends
 * first is not something to stake a session or an anonymous identity on.
 */
export const cookiesOf = (req) => {
  const raw = req.headers?.cookie;
  if (!raw) return {};

  const jar = {};
  const seen = new Set();
  const twice = new Set();
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (seen.has(name)) {
      twice.add(name);
      continue;
    }
    seen.add(name);
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      continue;
    }
  }
  for (const name of twice) delete jar[name];

  return jar;
};

// Each kind of token signs with its own prefix, so a session signature never
// passes for an SSO trip or the other way round.
const sign = (payload) => createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');

/** Compares two signatures without leaking, through timing, where they differ. */
const matches = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
};
