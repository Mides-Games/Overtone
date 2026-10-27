import { createHash, timingSafeEqual } from 'node:crypto';

import { HttpError } from '../utils/http-error.js';

/**
 * Two doors that open only for a caller holding a shared secret.
 *
 * Both compare in constant time over SHA-256 digests, so neither the content
 * nor the length of the expected value leaks through how long a refusal takes.
 * Both are factories taking the secret, so the tests can build them without
 * reading the environment.
 */

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();

/** Whether `given` equals `expected`, without a timing side channel. An empty `expected` matches nothing. */
export const sameSecret = (given, expected) => {
  if (typeof given !== 'string' || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
};

export const PROXY_HEADER = 'X-Overtone-Proxy';

/** Paths the proxy never forwards and that carry their own credential (the worker's bearer). */
export const INTERNAL_PREFIX = '/api/internal';

/**
 * Only requests that came through overtone-web (deploy/web/serve.mjs) reach
 * the API. On the panel every allocation port is public, so without this a
 * client could call the API directly and write its own X-Forwarded-For,
 * picking the address the rate limit and the anonymous quota count.
 *
 * Anything without the header gets a 404, as if nothing listened here. The
 * worker's internal routes are the exception: serve.mjs refuses to forward
 * them, and they demand WORKER_TOKEN instead. With no secret configured
 * (development only; production refuses to start without one) every request
 * passes.
 */
export const proxyGuard = (secret) => (req, _res, next) => {
  if (!secret) return next();
  const path = req.path ?? req.url ?? '';
  if (path === INTERNAL_PREFIX || path.startsWith(`${INTERNAL_PREFIX}/`)) return next();
  if (sameSecret(req.get?.(PROXY_HEADER) ?? req.headers?.[PROXY_HEADER.toLowerCase()], secret)) return next();
  return next(new HttpError(404, 'Not found.', 'NOT_FOUND'));
};

/**
 * The worker's door: `Authorization: Bearer <WORKER_TOKEN>`. Anything else is
 * a 401 that says nothing about why.
 */
export const bearerGuard = (token) => (req, _res, next) => {
  const header = req.get?.('Authorization') ?? req.headers?.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (sameSecret(given, token)) return next();
  return next(new HttpError(401, 'Not allowed.', 'UNAUTHORIZED'));
};
