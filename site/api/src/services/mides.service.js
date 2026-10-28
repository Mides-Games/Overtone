import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { discordName } from '../utils/profile.js';

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
  const { status, data } = await call('POST', 'sso/exchange', {
    code,
    app: env.midesApp,
    client_secret: env.midesClientSecret,
  });

  // A secret Mides does not accept, or one Mides has not been given: the
  // server's configuration, not the person's code. Said in the log, not to them.
  if ((status === 401 && data?.error === 'invalid_client') || status === 503) {
    console.error(`[mides] the code exchange was refused (${status} ${data?.error ?? ''}): check MIDES_CLIENT_SECRET here and SSO_SECRET_OVERTONE in Mides`);
    throw new HttpError(503, 'Sign-in is not available right now.', 'MIDES_UNAVAILABLE');
  }

  if (status === 400 || status === 401) {
    throw new HttpError(400, 'The sign-in code is not valid or has expired. Try again.', 'SSO_CODE_INVALID');
  }

  // Mides' exchange answers 403 for an account that is not active or is
  // sanctioned (sso.py `exchange`): the person's account, said to them.
  if (status === 403) {
    throw new HttpError(403, 'Mides did not let this account sign in. Check your account on Mides.', 'MIDES_FORBIDDEN');
  }

  if (status >= 400 || !data?.access_token || !data?.user) {
    throw new HttpError(502, 'Mides did not return a valid session.', 'SSO_BAD_ANSWER');
  }

  // Mides gives this app no refresh token (an access with its own audience, and
  // the minimal profile), and the access is not kept: the profile is all it needs.
  return { user: toUser(data.user) };
};

/**
 * The Mides user in this server's shape: an explicit allow-list of public
 * profile fields. Mides sends this app only its minimal profile (no email,
 * phone or global role); `is_moderator` becomes the one role kept.
 *
 * `discord_id` (W9.1) is read when Mides sends it: the linked Discord user's
 * id, a snowflake. Mides did not send it on 2026-10-27; docs/bot.md says what
 * it must add. Anything that is not a snowflake is dropped.
 */
export const toUser = (u) => ({
  midesUserId: String(u.id),
  username: String(u.username ?? ''),
  displayName: u.full_name || u.nickname || null,
  avatarUrl: absolute(u.photo_url),
  bannerUrl: absolute(u.banner_url),
  discordId: snowflake(u.discord_id),
  // Shown to the account itself (the linked-accounts card), as text. Mides'
  // full profile had no Discord username on 2026-10-28; read when it does.
  discordUsername: discordName(u.discord_username),
  role: u.is_moderator === true ? 'moderator' : null,
});

/** Where a person changes their photo, banner and name: Mides' settings page (its App.jsx route). */
export const midesSettingsUrl = () => (env.midesWebUrl ? `${env.midesWebUrl}/settings` : null);

// ── The pre-flight (does Mides know this app?) ──────────────────────────────

/**
 * Whether sending someone to Mides now would bring them back, read from the
 * one place Mides answers it without a session: the first hop of the SSO
 * with a provider (Mides' oauth.py `start`), the very request its /authorize
 * page makes. It redirects either to the provider (the app and its
 * redirect_uri are allowed), or back to Mides' own /oauth/callback with
 * `#error=redirect_not_allowed` (Mides does not know the app, or not this
 * SITE_URL), which is where a real sign-in would strand the person. The
 * redirect is read, never followed, so nothing reaches Discord.
 *
 *   ready        the provider's page, or Mides' own /authorize (provider off there)
 *   app_unknown  Mides refused the app or its redirect_uri
 *   unreachable  Mides did not answer in time
 *   unknown      anything else (a 429, a new answer): not a reason to block
 *
 * Kept SSO_STATUS_MS, so at most a few probes an hour reach Mides (its start
 * allows 20 an hour per address), whatever the traffic of /login.
 */
const SSO_STATUS_MS = 10 * 60_000;
const SSO_STATUS_SHORT_MS = 60_000;
let ssoStatusCache = null;

export const resetSsoStatus = () => {
  ssoStatusCache = null;
};

export const readProbe = (status, location, webUrl) => {
  if (status < 300 || status >= 400 || !location) return 'unknown';
  let url;
  try {
    url = new URL(location, webUrl);
  } catch {
    return 'unknown';
  }
  const mides = new URL(webUrl).origin;
  if (url.origin === mides && url.pathname === '/oauth/callback') {
    return /(^|[#&])error=redirect_not_allowed(&|$)/.test(url.hash) ? 'app_unknown' : 'unknown';
  }
  return 'ready';
};

export const ssoStatus = async () => {
  if (!env.midesWebUrl) return 'unknown';
  if (ssoStatusCache && ssoStatusCache.until > Date.now()) return ssoStatusCache.state;
  const probe = new URL(`${env.midesWebUrl}/api/auth/discord/start`);
  probe.searchParams.set('sso_app', env.midesApp);
  probe.searchParams.set('sso_redirect', `${env.siteUrl}/login/callback`);
  let state;
  try {
    const response = await fetch(probe, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel().catch(() => {});
    state = readProbe(response.status, response.headers.get('location'), env.midesWebUrl);
  } catch (error) {
    console.warn(`[mides] the sign-in pre-flight got no answer: ${error.cause?.code ?? error.message}`);
    state = 'unreachable';
  }
  if (state === 'app_unknown') {
    console.error(`[mides] Mides does not accept app "${env.midesApp}" with redirect_uri ${env.siteUrl}/login/callback (SSO_APPS in Mides' config.py)`);
  }
  ssoStatusCache = { state, until: Date.now() + (state === 'ready' ? SSO_STATUS_MS : SSO_STATUS_SHORT_MS) };
  return state;
};

/** A Discord id as a string of 17 to 20 digits, or `null`. */
export const snowflake = (value) => {
  const raw = typeof value === 'number' ? String(value) : value;
  return typeof raw === 'string' && /^\d{17,20}$/.test(raw.trim()) ? raw.trim() : null;
};

/**
 * Where to send someone who wants to link Discord (W9.1): a page on Mides
 * that links it to their Mides account and sends them back to `return_to`.
 * Overtone runs no Discord OAuth of its own. `return_to` is built here, from
 * SITE_URL, like the SSO's redirect_uri: never from the request.
 */
export const discordLinkUrl = () => {
  if (!env.midesWebUrl || !env.midesDiscordLinkPath) {
    throw new HttpError(503, 'Linking Discord through Mides is not configured on this server.', 'MIDES_LINK_OFF');
  }
  const url = new URL(`${env.midesWebUrl}${env.midesDiscordLinkPath}`);
  url.searchParams.set('app', env.midesApp);
  url.searchParams.set('return_to', `${env.siteUrl}/profile?linked=discord`);
  return url.toString();
};

/**
 * A Mides image URL, absolute, or `null`. Mides stores them relative
 * (`/api/profile/...`) and this site is another origin. Only an image on
 * Mides' own origins is kept: MIDES_WEB_URL's and MIDES_IMAGE_ORIGINS. An
 * avatar is fetched by every visitor of the public queue, so one on any
 * other host would tell that host who looks at the page, and when; a
 * `javascript:` or `data:` value, or a URL with credentials in it, is never
 * a `src` either. overtone-web's img-src allows the same origins and no more.
 */
export const absolute = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let url;
  try {
    if (/^https?:\/\//i.test(raw)) url = new URL(raw);
    else if (raw.startsWith('/') && !raw.startsWith('//') && env.midesWebUrl) url = new URL(`${env.midesWebUrl}${raw}`);
    else return null;
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  return imageOrigins().has(url.origin) ? url.href : null;
};

const imageOrigins = () =>
  new Set([env.midesWebUrl, ...env.midesImageOrigins].filter(Boolean).map((origin) => new URL(origin).origin));

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
