import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { analyses } from '../services/analysis.service.js';
import { STATS_DAYS, shapeStats } from '../utils/stats.js';

/**
 * The site's public statistics (W12.13).
 *
 *   GET /stats   totals, the BPM histogram, single vs. variable tempo, the
 *                median and 90th percentile time from upload to result, and
 *                the queue's length
 *
 * Aggregates only: no id, no name, no hash, nothing that belongs to one
 * person. The store counts, utils/stats.js `shapeStats` builds the answer
 * field by field, and the test reads the whole body for anything else.
 *
 * The answer is computed at most once a minute per process and shared by
 * every visitor: a page that anyone may reload must not become a way to make
 * the database count every table in a loop. The rate limit stops a single
 * address from trying anyway.
 */
const router = Router();

export const CACHE_MS = 60_000;
const statsRateLimit = guard('stats', 60, 10 * 60_000);

/** `{ at, value }` once computed; `pending` while a computation runs, so a burst waits on one. */
let cache = null;
let pending = null;

/** For the tests: the next request computes afresh. */
export const clearStatsCache = () => {
  cache = null;
  pending = null;
};

const compute = async () => {
  const raw = await analyses().stats({ days: STATS_DAYS });
  return shapeStats(raw, { days: STATS_DAYS });
};

router.get('/stats', statsRateLimit, async (_req, res) => {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_MS) {
    pending ??= compute().finally(() => {
      pending = null;
    });
    const value = await pending;
    cache = { at: now, value };
  }
  const age = Math.floor((Date.now() - cache.at) / 1000);
  res.set('Cache-Control', `public, max-age=${Math.max(0, CACHE_MS / 1000 - age)}`);
  res.json(cache.value);
});

export default router;
