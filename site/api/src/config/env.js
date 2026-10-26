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
  // Seals the Mides refresh token at rest (AES-256-GCM, key derived with HKDF).
  tokenKey: secret('TOKEN_KEY'),
  // The Mides identity API, e.g. https://midesprojects.com/api (the service
  // appends /auth/...). Server to server only.
  midesAuthUrl: origin('MIDES_AUTH_URL'),
  // The Mides website that hosts /authorize, e.g. https://midesprojects.com.
  midesWebUrl: origin('MIDES_WEB_URL'),
  midesApp: text('MIDES_APP', 'overtone'),
  devLogin: devLogin && !isProduction,
  anonDailyLimit: integer('ANON_DAILY_LIMIT', 5, { min: 0, max: 10_000 }),
  userDailyLimit: integer('USER_DAILY_LIMIT', 50, { min: 0, max: 100_000 }),
  maxAudioSeconds: integer('MAX_AUDIO_SECONDS', 600, { min: 10, max: 3600 }),
  // The largest upload: checked against Content-Length before a byte is read,
  // and again while the body streams to disk.
  maxUploadMb: integer('MAX_UPLOAD_MB', 40, { min: 1, max: 1024 }),
  // Where uploads wait for the worker. Files in it are named by analysis id
  // only: the uploaded file's own name never reaches the filesystem.
  spoolDir: resolve(text('SPOOL_DIR', join(tmpdir(), 'overtone-spool'))),
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
};

if (env.proxySecret && env.proxySecret.length < 32) problems.push('PROXY_SECRET must be at least 32 characters.');
if (isProduction && !env.proxySecret) problems.push('PROXY_SECRET is required in production: every allocation port is public.');

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
