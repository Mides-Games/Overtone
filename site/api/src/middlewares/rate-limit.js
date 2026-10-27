import { createHmac } from 'node:crypto';

import { env } from '../config/env.js';
import { hasDatabase, query } from '../config/database.js';
import { clientKey as addressKey } from '../utils/client-ip.js';
import { HttpError } from '../utils/http-error.js';

/**
 * A fixed-window limit per client address (W3.6; an IPv6 client's /64,
 * utils/client-ip.js), counted where every API process sees the same number
 * (W3.17).
 *
 * A fixed window lets up to twice the limit through at a window boundary. That
 * is accepted: the goal is that nobody uses this server as an amplifier, not a
 * fair share to the millisecond. What matters is that the count is per
 * address, that the address is the real one (`TRUST_PROXY`), and that two APIs
 * behind the proxy count together: with a database the windows live in the
 * `rate_limits` table, one upsert per request, so a client cannot double its
 * budget by landing on both. Without one (development only) they live in this
 * process's memory, as before.
 *
 * The address is never stored, in the table or in memory: the key is an HMAC
 * of it under SESSION_SECRET, which every process shares already.
 */

export const clientKey = (ip) => createHmac('sha256', env.sessionSecret).update(`rate:${addressKey(ip)}`).digest('hex').slice(0, 32);

/** A counter in this process's memory: one per process, so two processes count apart. */
export const memoryCounter = () => {
  /** `bucket:client` -> `{ count, resetAt }` */
  const hits = new Map();
  let lastSweep = Date.now();
  return {
    async hit(bucket, client, windowMs) {
      const now = Date.now();
      // Expired windows are swept now and then so the map does not grow forever.
      if (now - lastSweep >= 60_000) {
        lastSweep = now;
        for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
      }
      const key = `${bucket}:${client}`;
      let hit = hits.get(key);
      if (!hit || hit.resetAt <= now) {
        hit = { count: 0, resetAt: now + windowMs };
        hits.set(key, hit);
      }
      hit.count += 1;
      return { count: hit.count, waitMs: hit.resetAt - now };
    },
  };
};

/**
 * The shared counter. One statement both starts a window and counts in it:
 * ON CONFLICT takes the row's lock, so two processes hitting the same key at
 * once are counted one after the other. The wait is computed by the database
 * too, so the processes' clocks never have to agree.
 */
let lastPgSweep = 0;
export const pgCounter = {
  async hit(bucket, client, windowMs) {
    const { rows: [row] } = await query(
      `INSERT INTO rate_limits AS r (bucket, client, count, reset_at)
            VALUES ($1, $2, 1, now() + make_interval(secs => $3))
       ON CONFLICT (bucket, client) DO UPDATE
             SET count    = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
                 reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
         RETURNING r.count, extract(epoch FROM r.reset_at - now()) * 1000 AS wait_ms`,
      [bucket, client, windowMs / 1000],
    );
    if (Date.now() - lastPgSweep >= 60_000) {
      lastPgSweep = Date.now();
      // Dead windows only; nothing waits on it, and a failure is harmless.
      query("DELETE FROM rate_limits WHERE reset_at < now() - interval '1 minute'").catch(() => {});
    }
    return { count: row.count, waitMs: Number(row.wait_ms) };
  },
};

const fallback = memoryCounter();
let warned = false;

/** The counter for this request: the shared one when there is a database. */
const counterFor = () => (hasDatabase() ? pgCounter : fallback);

/**
 * `guard(bucket, max, windowMs)`: at most `max` requests per address per
 * window in `bucket`. `counter` is for the tests; the default picks the table
 * or memory per request.
 */
export const guard = (bucket, max, windowMs, { counter = null } = {}) => async (req, _res, next) => {
  if (max <= 0) return next();

  // A request made with a personal API token (W12.20, middlewares/token.js)
  // counts against that token, wherever it comes from; any other against its address.
  const client = req.token ? `t:${req.token.id}` : clientKey(req.ip);
  const chosen = counter ?? counterFor();
  let hit;
  try {
    hit = await chosen.hit(bucket, client, windowMs);
    warned = false;
  } catch (error) {
    // A limit that cannot count must not take the site down with it: until
    // the database answers again this process counts on its own. Said once
    // per outage.
    if (!warned) {
      warned = true;
      console.warn(`[rate-limit] the shared count failed (${error.message}); counting in memory until it answers`);
    }
    hit = await fallback.hit(bucket, client, windowMs);
  }
  if (hit.count <= max) return next();

  // Retry-After lets a polite client wait exactly as long as it has to.
  const seconds = Math.max(1, Math.ceil(hit.waitMs / 1000));
  const error = new HttpError(429, 'Too many requests. Try again in a few seconds.', 'RATE_LIMITED');
  error.headers = { 'Retry-After': String(seconds) };
  return next(error);
};

/** Everything under /api: generous, it only stops a loop. */
const addressLimit = guard('api', 300, 60_000);
// A token request has its own budget instead (W12.20); the bucket is apart, so
// a script's calls never spend the budget of the browser it runs beside.
const tokenLimit = guard('token', 120, 60_000);
export const rateLimit = (req, res, next) => (req.token ? tokenLimit : addressLimit)(req, res, next);

/**
 * Sign-in attempts: much narrower and with a longer window. A separate bucket,
 * so a busy page does not spend the budget that protects the login.
 */
export const authRateLimit = guard('auth', 20, 10 * 60_000);
