import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env, osuConfigured, secureCookies } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Linking an osu! account (W9.2): OAuth 2 of the osu! API v2, authorization
 * code with PKCE, scope `identify` and nothing more.
 *
 *   1. `startUrl(accountId)` -> the osu! authorize URL and a signed cookie
 *      holding the state, the account and an expiry.
 *   2. osu! sends the browser to OSU_REDIRECT_URI (the site's /link/osu page)
 *      with ?code&state; the page posts them to the API.
 *   3. `exchange(code)` trades the code for a token server side (with the
 *      client secret and the PKCE verifier), reads /me once, and returns the
 *      four fields Overtone keeps. The token is dropped right there: it is not
 *      stored, logged or returned, and no refresh is asked for.
 *
 * The PKCE verifier never leaves this server, not even inside the cookie: it
 * is an HMAC of the state under SESSION_SECRET, so the cookie (which the
 * browser holds) carries the state alone. osu!'s API docs do not mention
 * PKCE; osu-web's OAuth server is Laravel Passport (league/oauth2-server),
 * which checks a `code_challenge` (S256) whenever a client sends one. OSU_PKCE=0
 * leaves it out, should a real link ever fail on it; the state stays.
 *
 * The osu! API's terms (docs/bot.md): a registered app, its secret kept
 * secret, no more calls than the work needs (one /me per link), nothing
 * presented as official, and the data used only for the profile it is shown on.
 */

const TIMEOUT_MS = 10_000;
const STATE_MINUTES = 10;
export const OSU_COOKIE = 'overtone_osu';
/** Only the link routes read it. */
const COOKIE_PATH = '/api/v1/links/osu';

const sign = (payload) => createHmac('sha256', env.sessionSecret).update(`osu-state:${payload}`).digest('base64url');
const verifierOf = (state) => createHmac('sha256', env.sessionSecret).update(`osu-pkce:${state}`).digest('base64url');
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

const off = () => new HttpError(503, 'Linking osu! is not configured on this server.', 'OSU_OFF');

/** The authorize URL and the state cookie's value for `accountId`. */
export const startLink = (accountId) => {
  if (!osuConfigured()) throw off();
  const state = randomBytes(18).toString('base64url');
  const payload = `${state}.${accountId}.${Date.now() + STATE_MINUTES * 60_000}`;
  const url = new URL(`${env.osuUrl}/oauth/authorize`);
  url.searchParams.set('client_id', env.osuClientId);
  url.searchParams.set('redirect_uri', env.osuRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  if (env.osuPkce) {
    url.searchParams.set('code_challenge', challengeOf(verifierOf(state)));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return { url: url.toString(), cookie: `${payload}.${sign(payload)}` };
};

/**
 * The state the cookie vouches for, when it is this server's, current, for
 * this account and equal to the one osu! sent back; else `null`.
 */
export const checkState = (cookie, state, accountId) => {
  if (typeof cookie !== 'string' || typeof state !== 'string' || state.length > 64) return null;
  const cut = cookie.lastIndexOf('.');
  if (cut < 0) return null;
  const payload = cookie.slice(0, cut);
  const given = Buffer.from(cookie.slice(cut + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [saved, account, expires, ...rest] = payload.split('.');
  if (rest.length || saved !== state || account !== accountId || !(Number(expires) > Date.now())) return null;
  return saved;
};

export const osuCookieHeader = (value) =>
  [`${OSU_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', secureCookies() ? 'Secure' : null, `Max-Age=${value ? STATE_MINUTES * 60 : 0}`]
    .filter(Boolean)
    .join('; ');

/** Only osu!'s own avatar host, https: the page would load it. */
const avatar = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)ppy\.sh$/.test(url.hostname) && !url.username && value.length <= 300 ? url.href : null;
  } catch {
    return null;
  }
};

/** A whole number in [min, max], else `null`. */
const whole = (value, min, max = 2 ** 31 - 1) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
/** A finite number in [min, max], rounded to two decimals, else `null`. */
const decimal = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : null;

/**
 * osu!'s user (the link's /me, or /users/{id}/osu at a refresh) in the fields
 * kept: an allow-list, like Mides' profile. The card's numbers are the osu!
 * ruleset's `statistics`, which /me and /users/{id}/osu both carry; a field
 * osu! leaves out, or sends as something else, is `null`, never a guess.
 */
export const toOsuProfile = (me) => {
  const id = Number(me?.id);
  const username = typeof me?.username === 'string' ? me.username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 32) : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !username) return null;
  const ranked = me.ranked_beatmapset_count ?? me.ranked_and_approved_beatmapset_count;
  const stats = me.statistics && typeof me.statistics === 'object' ? me.statistics : {};
  const country = typeof me.country_code === 'string' && /^[A-Z]{2}$/.test(me.country_code) ? me.country_code : null;
  return {
    id,
    username,
    avatarUrl: avatar(me.avatar_url),
    rankedCount: Number.isInteger(ranked) && ranked >= 0 ? ranked : null,
    country,
    globalRank: whole(stats.global_rank, 1),
    countryRank: whole(stats.country_rank, 1),
    pp: decimal(stats.pp, 0, 1e6),
    accuracy: decimal(stats.hit_accuracy, 0, 100),
    playCount: whole(stats.play_count, 0),
  };
};

const call = async (path, init) => {
  try {
    return await fetch(`${env.osuUrl}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    console.error(`[osu] ${path} got no answer: ${error.cause?.code ?? error.message}`);
    throw new HttpError(503, 'osu! did not answer. Try again in a moment.', 'OSU_UNAVAILABLE');
  }
};

/** Code -> token -> /me -> the profile. The token goes out of scope here and is never kept. */
export const exchange = async (code, state) => {
  if (!osuConfigured()) throw off();
  const token = await call('/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Number(env.osuClientId),
      client_secret: env.osuClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: env.osuRedirectUri,
      ...(env.osuPkce ? { code_verifier: verifierOf(state) } : {}),
    }),
  });
  const grant = await token.json().catch(() => ({}));
  if (token.status === 400 || token.status === 401) {
    if (grant?.error === 'invalid_client') {
      console.error('[osu] the token exchange was refused as invalid_client: check OSU_CLIENT_ID and OSU_CLIENT_SECRET');
      throw new HttpError(503, 'Linking osu! is not available right now.', 'OSU_UNAVAILABLE');
    }
    throw new HttpError(400, 'The osu! code is not valid or has expired. Try again.', 'OSU_CODE_INVALID');
  }
  if (!token.ok || typeof grant?.access_token !== 'string') {
    throw new HttpError(502, 'osu! did not return a valid answer.', 'OSU_BAD_ANSWER');
  }

  const me = await call('/api/v2/me', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${grant.access_token}` },
  });
  const profile = me.ok ? toOsuProfile(await me.json().catch(() => null)) : null;
  if (!profile) throw new HttpError(502, 'osu! did not return a valid profile.', 'OSU_BAD_ANSWER');
  return profile;
};

// ── "Refresh" on the osu! card (2026-10-28) ─────────────────────────────────
//
// The link's token was dropped at link time, so a refresh cannot use it. It
// uses the app's own token instead (client credentials, scope `public`: the
// osu! API's grant for reading public data with no user behind it) and reads
// /users/{id}/osu, the same public profile anyone sees on osu!'s site. That
// token is kept in this process's memory until a minute before it expires, so
// a run of refreshes asks for it once; it never reaches a log, a row or a page.
// Only the person's own "Refresh" calls this, rate limited per account
// (routes/links.routes.js): no page view ever does.

let appToken = null;

export const resetAppToken = () => {
  appToken = null;
};

const appAccess = async () => {
  if (appToken && appToken.until > Date.now()) return appToken.value;
  const response = await call('/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Number(env.osuClientId),
      client_secret: env.osuClientSecret,
      grant_type: 'client_credentials',
      scope: 'public',
    }),
  });
  const grant = await response.json().catch(() => ({}));
  if (!response.ok || typeof grant?.access_token !== 'string') {
    if (grant?.error === 'invalid_client') console.error('[osu] the app token was refused as invalid_client: check OSU_CLIENT_ID and OSU_CLIENT_SECRET');
    throw new HttpError(503, 'osu! did not let this server read the profile right now.', 'OSU_UNAVAILABLE');
  }
  const seconds = Number.isFinite(grant.expires_in) ? grant.expires_in : 3600;
  appToken = { value: grant.access_token, until: Date.now() + Math.max(0, seconds - 60) * 1000 };
  return appToken.value;
};

/** The osu! user `osuUserId`'s public profile now, in the kept fields. */
export const refreshProfile = async (osuUserId) => {
  if (!osuConfigured()) throw off();
  const id = Number(osuUserId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(409, 'Link osu! first.', 'OSU_NOT_LINKED');
  const token = await appAccess();
  const response = await call(`/api/v2/users/${id}/osu?key=id`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) appToken = null;
  if (response.status === 404) throw new HttpError(404, 'osu! no longer has that account.', 'OSU_USER_GONE');
  const profile = response.ok ? toOsuProfile(await response.json().catch(() => null)) : null;
  if (!profile || profile.id !== id) throw new HttpError(502, 'osu! did not return a valid profile.', 'OSU_BAD_ANSWER');
  return profile;
};
