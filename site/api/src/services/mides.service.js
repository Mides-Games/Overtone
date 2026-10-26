import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The Mides identity (midesprojects.com), spoken server to server. Ported from
 * cavernia-api's `mides.service.js`, for the `web` SSO app type
 * (docs/16-web-platform.md, ADR-W2).
 *
 * Overtone keeps no passwords. Sign-in goes to Mides' /authorize, which sends
 * the browser straight to Discord or Google and back to /login/callback with a
 * one-use code in the fragment; this server exchanges that code.
 *
 * What does not cross: the Mides tokens. A `web` token is a full Mides session
 * (it can post on the wall and read email and phone), so it never leaves this
 * process. The browser only ever holds Overtone's own cookie.
 */

const TIMEOUT_MS = 10_000;

/** The providers one can ask for up front. An allow-list, because it ends up in a redirect. */
export const PROVIDERS = new Set(['discord', 'google']);

/**
 * Where to send someone who wants to sign in. The redirect_uri is built here,
 * from SITE_URL, never taken from the request: a redirect_uri from the browser
 * is the classic way to turn a login into an open redirector that lands the
 * session code on an attacker's site.
 */
export const authorizeUrl = (provider) => {
  if (!env.midesWebUrl) {
    throw new HttpError(503, 'Sign-in is not configured on this server.', 'SSO_NOT_CONFIGURED');
  }

  const url = new URL(`${env.midesWebUrl}/authorize`);
  url.searchParams.set('app', env.midesApp);
  url.searchParams.set('redirect_uri', `${env.siteUrl}/login/callback`);
  if (provider && PROVIDERS.has(provider)) url.searchParams.set('provider', provider);

  return url.toString();
};

/** Exchanges the SSO's one-use code for the Mides user and tokens. */
export const exchangeCode = async (code) => {
  const { status, data } = await call('POST', 'sso/exchange', { code });

  if (status === 400 || status === 401) {
    throw new HttpError(400, 'The sign-in code is not valid or has expired. Try again.', 'SSO_CODE_INVALID');
  }

  if (status >= 400 || !data?.access_token || !data?.user) {
    throw new HttpError(502, 'Mides did not return a valid session.', 'SSO_BAD_ANSWER');
  }

  return { refresh: data.refresh_token ?? null, user: toUser(data.user) };
};

/**
 * A new access token from the refresh token. `null` only when Mides says the
 * refresh token is no longer good (401 or 422 from flask-jwt); anything else is
 * transient and throws a 503, so a Mides redeploy does not wipe stored tokens.
 */
export const refreshAccess = async (refresh) => {
  const { status, data } = await call('POST', 'refresh', null, refresh);

  if (status === 200 && typeof data?.access_token === 'string') return data.access_token;
  if (status === 401 || status === 422) return null;

  throw new HttpError(503, 'Mides is not available right now.', 'MIDES_UNAVAILABLE');
};

/**
 * The Mides user in this server's shape: an explicit allow-list of public
 * profile fields. Email and phone are not here. Not storing them is the
 * cheapest way of never leaking them.
 */
export const toUser = (u) => ({
  midesUserId: String(u.id),
  username: String(u.username ?? ''),
  displayName: u.full_name || u.nickname || null,
  avatarUrl: absolute(u.photo_url),
  bannerUrl: absolute(u.banner_url),
  discordId: u.discord_id ? String(u.discord_id) : null,
  role: u.role ?? null,
});

/**
 * A Mides image URL, absolute. Mides stores them relative (`/api/profile/...`)
 * and this site is another origin. Anything that is neither http(s) nor a path
 * (a `javascript:` or `data:` stored over there) becomes `null`, not a `src`.
 */
const absolute = (value) => {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith('/')) return null;

  return env.midesWebUrl ? `${env.midesWebUrl}${url}` : null;
};

/**
 * One call to the identity API. Only transport problems (Mides down or not
 * configured) become exceptions; statuses pass through for the caller to read.
 */
const call = async (method, path, body, token) => {
  if (!env.midesAuthUrl) {
    throw new HttpError(503, 'Sign-in is not configured on this server.', 'SSO_NOT_CONFIGURED');
  }

  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${env.midesAuthUrl}/auth/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[mides] ${method} /auth/${path} got no answer: ${error.cause?.code ?? error.message}`);
    throw new HttpError(503, 'Sign-in is not available right now.', 'MIDES_UNAVAILABLE');
  }

  let data = {};
  try {
    data = (await response.json()) ?? {};
  } catch {
    data = {};
  }

  return { status: response.status, data };
};
