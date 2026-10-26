import { HttpError } from '../utils/http-error.js';

/**
 * A fixed-window limit per client IP, kept in this process's memory.
 *
 * A fixed window lets up to twice the limit through at a window boundary. That
 * is accepted: the goal is that nobody uses this server as an amplifier, not a
 * fair share to the millisecond. What matters is that the count is per IP and
 * that the IP is the real one (`TRUST_PROXY`). One process today; the day there
 * are two, this moves to Postgres.
 */

/** `bucket:ip` -> `{ count, resetAt }` */
const hits = new Map();

/** Expired windows are swept now and then so the map does not grow forever. */
let lastSweep = Date.now();
const sweep = (now) => {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
};

export const guard = (bucket, max, windowMs) => (req, _res, next) => {
  if (max <= 0) return next();

  const now = Date.now();
  sweep(now);
  const key = `${bucket}:${req.ip ?? 'unknown'}`;
  const hit = hits.get(key);

  if (!hit || hit.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  hit.count += 1;
  if (hit.count <= max) return next();

  // Retry-After lets a polite client wait exactly as long as it has to.
  const seconds = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
  const error = new HttpError(429, 'Too many requests. Try again in a few seconds.', 'RATE_LIMITED');
  error.headers = { 'Retry-After': String(seconds) };
  return next(error);
};

/** Everything under /api: generous, it only stops a loop. */
export const rateLimit = guard('api', 300, 60_000);

/**
 * Sign-in attempts: much narrower and with a longer window. A separate bucket,
 * so a busy page does not spend the budget that protects the login.
 */
export const authRateLimit = guard('auth', 20, 10 * 60_000);
