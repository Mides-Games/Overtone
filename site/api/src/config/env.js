import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The API's configuration, read once from the environment and validated.
 *
 * `.env` is loaded by Node itself (`--env-file-if-exists=.env` in the package
 * scripts), so there is no dotenv dependency. Every name is listed in
 * `.env.example` and explained in `docs/site.md`.
 *
 * The rule is: development starts with nothing set, production refuses to start
 * with anything important missing. A server that boots with a guessed secret in
 * production is worse than one that does not boot.
 */

const problems = [];

const text = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

const integer = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = text(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
    return fallback;
  }
  return value;
};

/** An origin with no trailing slash, or '' when unset. */
const origin = (name, fallback = '') => {
  const raw = text(name, fallback).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    problems.push(`${name} must be an http(s) URL (got "${raw}").`);
    return '';
  }
  return raw;
};

/** A comma-separated list of http(s) origins (scheme, host, port; no path). */
const origins = (name) =>
  text(name)
    .split(',')
    .map((raw) => raw.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .filter((raw) => {
      try {
        const url = new URL(raw);
        if (['http:', 'https:'].includes(url.protocol) && url.origin === raw) return true;
      } catch {
        // reported below
      }
      problems.push(`${name} must list http(s) origins only, like https://cdn.example.com (got "${raw}").`);
      return false;
    });

const nodeEnv = text('NODE_ENV', 'development');
export const isProduction = nodeEnv === 'production';

const flag = (name) => ['1', 'true', 'yes'].includes(text(name).toLowerCase());

/**
 * A secret: required in production, generated per process in development.
 * A generated one means every restart signs everyone out, which is fine on a
 * laptop and says so once.
 */
const secret = (name, consequence = 'sessions end on restart') => {
  const value = text(name);
  if (value) {
    if (value.length < 32) problems.push(`${name} must be at least 32 characters.`);
    return value;
  }
  if (isProduction) {
    problems.push(`${name} is required in production.`);
    return '';
  }
  console.warn(`[env] ${name} is not set: using a random one for this process (${consequence}).`);
  return randomBytes(32).toString('base64url');
};

const devLogin = flag('MIDES_DEV_LOGIN');
if (devLogin && isProduction) {
  problems.push('MIDES_DEV_LOGIN is refused when NODE_ENV=production: it lets anyone sign in.');
}

const port = integer('PORT', 3001, { min: 1, max: 65535 });

export const env = {
  nodeEnv,
  port,
  // Empty listens on every interface. Behind a reverse proxy, 127.0.0.1.
  host: text('HOST'),
  // How many proxies sit in front (Caddy or nginx = 1). Decides which address
  // the rate limit counts: 0 behind a proxy puts every visitor in one bucket.
  trustProxy: integer('TRUST_PROXY', 0, { min: 0, max: 10 }),
  databaseUrl: text('DATABASE_URL'),
  // Where the web is served. The SSO redirect_uri is built from it, server side.
  siteUrl: origin('SITE_URL', 'http://localhost:5173'),
  sessionSecret: secret('SESSION_SECRET'),
  sessionDays: integer('SESSION_DAYS', 30, { min: 1, max: 90 }),
  // This server's secret for Mides' code exchange (SSO_APPS.overtone.secret_env
  // there, SSO_SECRET_OVERTONE): a code is only good with it, so one stolen from
  // a browser is good to nobody. The same value on both sides.
  midesClientSecret: secret('MIDES_CLIENT_SECRET', 'the real Mides sign-in is refused'),
  // The Mides identity API, e.g. https://midesprojects.com/api (the service
  // appends /auth/...). Server to server only.
  midesAuthUrl: origin('MIDES_AUTH_URL'),
  // The Mides website that hosts /authorize, e.g. https://midesprojects.com.
  midesWebUrl: origin('MIDES_WEB_URL'),
  // Other origins Mides serves profile pictures and banners from, beyond
  // MIDES_WEB_URL's own (e.g. its CDN). An image anywhere else is not kept,
  // and overtone-web's img-src allows the same list and nothing more.
  midesImageOrigins: origins('MIDES_IMAGE_ORIGINS'),
  midesApp: text('MIDES_APP', 'overtone'),
  devLogin: devLogin && !isProduction,
  anonDailyLimit: integer('ANON_DAILY_LIMIT', 5, { min: 0, max: 10_000 }),
  userDailyLimit: integer('USER_DAILY_LIMIT', 50, { min: 0, max: 100_000 }),
  // How many of one person's analyses may wait or run at once (W3.9): a batch
  // beyond it is refused song by song until the first ones finish.
  anonMaxPending: integer('ANON_MAX_PENDING', 3, { min: 1, max: 1000 }),
  userMaxPending: integer('USER_MAX_PENDING', 10, { min: 1, max: 1000 }),
  // The whole queue's ceiling, so no one can fill it whatever their quotas.
  // Every queued song holds up to MAX_UPLOAD_MB in the spool, so the default
  // keeps QUEUE_MAX x MAX_UPLOAD_MB (30 x 40 = 1200 MB) inside SPOOL_MAX_MB.
  queueMax: integer('QUEUE_MAX', 30, { min: 1, max: 100_000 }),
  // Stored results one person may open a day without analysing (W3.11): a
  // lookup or upload of audio analysed before costs no quota, so it has a cap
  // of its own.
  cacheDailyLimit: integer('CACHE_DAILY_LIMIT', 100, { min: 1, max: 100_000 }),
  maxAudioSeconds: integer('MAX_AUDIO_SECONDS', 600, { min: 10, max: 3600 }),
  // The largest upload: checked against Content-Length before a byte is read,
  // and again while the body streams to disk.
  maxUploadMb: integer('MAX_UPLOAD_MB', 40, { min: 1, max: 1024 }),
  // Where uploads wait for the worker. Files in it are named by analysis id
  // only: the uploaded file's own name never reaches the filesystem.
  spoolDir: resolve(text('SPOOL_DIR', join(tmpdir(), 'overtone-spool'))),
  // The most the spool may hold, waiting audio and uploads still arriving
  // together. An upload reserves its size before a byte is read and is
  // refused (503 SPOOL_FULL) when the reservation does not fit. The panel's
  // disk limit is not something the filesystem reports, so this is the bound;
  // the default fits the API server's 2 GB disk (docs/deploy.md).
  spoolMaxMb: integer('SPOOL_MAX_MB', 1280, { min: 1, max: 1_048_576 }),
  // Free space the spool always leaves on its filesystem, checked too.
  spoolMinFreeMb: integer('SPOOL_MIN_FREE_MB', 256, { min: 0, max: 1_048_576 }),
  // The bearer the worker sends to /api/internal. `pnpm dev` generates one
  // and hands it to the worker it starts.
  workerToken: secret('WORKER_TOKEN', 'no worker started elsewhere can connect'),
  // A job running longer than this goes back to the queue (two attempts in
  // all), and a late answer from the abandoned attempt is refused.
  jobTimeoutS: integer('JOB_TIMEOUT_S', 900, { min: 30, max: 86_400 }),
  // The header overtone-web adds to everything it forwards. Without it the
  // API answers 404 (middlewares/shared-secret.js). Optional in development,
  // where the browser reaches the API through Vite's proxy.
  proxySecret: text('PROXY_SECRET'),
  // W9.3: the Discord bot's bearer for /api/internal/bot, separate from
  // WORKER_TOKEN so a leak of one opens nothing of the other. Optional: unset,
  // the bot's routes answer 503 BOT_OFF and the site works as before.
  botToken: text('BOT_TOKEN'),
  // W9.1: the Mides page that links a Discord account to the signed-in Mides
  // user and sends the browser back to `return_to` (docs/bot.md lists what
  // Mides must offer). A path on MIDES_WEB_URL. Unset by default: Mides had no
  // such page on 2026-10-28 (its routes: App.jsx), and a button to a page that
  // is not there would strand the person on another site. Set it once Mides
  // serves one; until then the profile offers the bot's /link code.
  midesDiscordLinkPath: text('MIDES_DISCORD_LINK_PATH'),
  // W9.2: the osu! OAuth app (osu.ppy.sh/home/account/edit#oauth). All three
  // or none: with any missing, linking osu! is off and the profile says so.
  osuClientId: text('OSU_CLIENT_ID'),
  osuClientSecret: text('OSU_CLIENT_SECRET'),
  osuRedirectUri: text('OSU_REDIRECT_URI'),
  // osu!'s own origin; the tests point it at a stand-in.
  osuUrl: origin('OSU_URL', 'https://osu.ppy.sh'),
  // PKCE on the osu! link. osu!'s docs do not mention it; its OAuth server
  // (Laravel Passport, league/oauth2-server) checks a code_challenge when one is
  // sent. 0 turns it off if a real link ever fails on it (docs/bot.md).
  osuPkce: !['0', 'false', 'no'].includes(text('OSU_PKCE').toLowerCase()),
};

if (env.botToken) {
  if (env.botToken.length < 32) problems.push('BOT_TOKEN must be at least 32 characters.');
  if (env.botToken === env.workerToken) problems.push('BOT_TOKEN must not be WORKER_TOKEN: each door has its own key.');
} else {
  console.warn('[env] BOT_TOKEN is not set: the Discord bot\'s routes are off (503 BOT_OFF).');
}

const osuSet = [env.osuClientId, env.osuClientSecret, env.osuRedirectUri].filter(Boolean).length;
if (osuSet && osuSet < 3) {
  problems.push('OSU_CLIENT_ID, OSU_CLIENT_SECRET and OSU_REDIRECT_URI go together: set all three, or none.');
}
if (env.osuClientId && !/^\d{1,12}$/.test(env.osuClientId)) problems.push('OSU_CLIENT_ID is the number osu! shows for the app.');
if (env.osuRedirectUri) {
  try {
    const url = new URL(env.osuRedirectUri);
    // The code osu! sends back lands on this site's own page, nowhere else.
    if (url.origin !== new URL(env.siteUrl).origin) problems.push('OSU_REDIRECT_URI must be on SITE_URL (e.g. SITE_URL/link/osu).');
  } catch {
    problems.push(`OSU_REDIRECT_URI must be a URL (got "${env.osuRedirectUri}").`);
  }
}
if (!osuSet) console.warn('[env] OSU_CLIENT_ID is not set: linking an osu! account is off.');
if (env.midesDiscordLinkPath && !/^\/[A-Za-z0-9/_-]{0,120}$/.test(env.midesDiscordLinkPath)) {
  problems.push('MIDES_DISCORD_LINK_PATH is a path on MIDES_WEB_URL, like /connections/discord/link.');
}

if (env.proxySecret && env.proxySecret.length < 32) problems.push('PROXY_SECRET must be at least 32 characters.');
if (isProduction && !env.proxySecret) problems.push('PROXY_SECRET is required in production: every allocation port is public.');

if (env.spoolMaxMb < env.maxUploadMb) problems.push('SPOOL_MAX_MB must be at least MAX_UPLOAD_MB, or no upload fits.');
if (env.queueMax * env.maxUploadMb > env.spoolMaxMb) {
  console.warn(
    `[env] QUEUE_MAX x MAX_UPLOAD_MB (${env.queueMax * env.maxUploadMb} MB) is more than SPOOL_MAX_MB (${env.spoolMaxMb}): ` +
      'a queue of large files is refused with SPOOL_FULL before it is full.',
  );
}

if (isProduction && !env.databaseUrl) problems.push('DATABASE_URL is required in production.');
if (isProduction && !env.siteUrl.startsWith('https://')) problems.push('SITE_URL must be https in production.');

if (problems.length) {
  console.error(['[env] the configuration is not valid:', ...problems.map((p) => `  - ${p}`)].join('\n'));
  process.exit(1);
}

/** Cookies are `Secure` whenever the site itself is served over https. */
export const secureCookies = () => env.siteUrl.startsWith('https://');

/** Whether the real Mides SSO can be used (both URLs known). */
export const ssoConfigured = () => Boolean(env.midesAuthUrl && env.midesWebUrl);

/** Whether linking osu! can be offered (W9.2): the app's three values are set. */
export const osuConfigured = () => Boolean(env.osuClientId && env.osuClientSecret && env.osuRedirectUri);

/** Whether the Discord bot may call in (W9.3). */
export const botConfigured = () => Boolean(env.botToken);
