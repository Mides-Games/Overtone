/** What an analysis may do and when: limits, refusals, failure codes and the fair queue order. */
import { randomBytes } from 'node:crypto';
import { HttpError } from '../../utils/http-error.js';

export const MAX_ATTEMPTS = 2;

export const newPublicId = () => randomBytes(16).toString('hex');

/**
 * The engine hashes the worker last announced, one per mode (W11.1): what a
 * cached result of that mode must match. A worker from before modes names
 * only the normal one, and then no other mode is ever answered from the cache.
 */
let currentEngineHashes = {};
export const engineHash = (mode = 'normal') => currentEngineHashes[mode] ?? null;
export const setEngineHash = (hash, hashes = null) => {
  currentEngineHashes = { ...(hashes && typeof hashes === 'object' ? hashes : {}), normal: hash };
};

export const startOfUtcDay = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** A section-weighted confidence for the `analyses.confidence` column, or null. */
export const confidenceOf = (result) => {
  const sections = result?.sections ?? [];
  if (!sections.length) return null;
  const value = Math.min(...sections.map((s) => Number(s.confidence)).filter(Number.isFinite));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
};

export const statusOf = (result) => (result?.refused ? 'refused' : 'done');

/**
 * Which Overtone timed a result: its release and the Beat This! model the
 * vote ran on ("<file>@<sha1 12>"), or null where the result does not say
 * (an older worker, or no vote). Kept as columns so old and new readings can
 * be told apart later.
 */
export const versionOf = (result) => ({
  appVersion: typeof result?.app_version === 'string' ? result.app_version.slice(0, 32) : null,
  engineModel: result?.model?.name && result.model.sha1 ? `${result.model.name}@${result.model.sha1}`.slice(0, 128) : null,
});

/**
 * The limits a new analysis must fit, given its owner's counts (W3.9,
 * W3.11): `{ quota, maxPending, queueMax, cacheDaily, scope }`. A queued
 * analysis is held to the daily quota, the owner's pending cap and the
 * queue's; one answered from the cache only to `cacheDaily`, so a lookup in a
 * loop cannot fill the tables or the public queue. Returns the refusal, or
 * null. Both stores call it at insert time, inside their critical section.
 */
export const refusal = ({ mine, all, today, cachedToday }, limits, cached) => {
  const { scope } = limits;
  if (cached) {
    return cachedToday >= limits.cacheDaily ? limitRefusal('CACHE_LIMIT', { limit: limits.cacheDaily, scope }) : null;
  }
  if (today >= limits.quota) return limitRefusal('QUOTA_EXCEEDED', { limit: limits.quota, scope });
  if (mine >= limits.maxPending) return limitRefusal('PENDING_LIMIT', { limit: limits.maxPending, scope, pending: mine });
  if (all >= limits.queueMax) return new HttpError(503, 'The queue is full. Try again in a few minutes.', 'QUEUE_FULL');
  return null;
};

/**
 * W13.20: when a daily count frees up again, said with the refusal so the
 * page can count down to it: the next 00:00 UTC, and the seconds until then
 * (which the page counts from, so a visitor's wrong clock cannot skew it).
 */
export const dailyReset = (now = Date.now()) => {
  const at = new Date(now);
  const reset = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return { resetAt: new Date(reset).toISOString(), retryAfterS: Math.max(1, Math.ceil((reset - now) / 1000)) };
};

/**
 * The three refusals a person's own limits give, each saying why and when it
 * frees up (W13.20): the two daily counts at 00:00 UTC, with a Retry-After a
 * polite client can wait for; the pending cap when one of their songs in the
 * queue finishes (`frees: 'finish'`), which no clock can say.
 */
export const limitRefusal = (code, { limit, scope, pending = null }, now = Date.now()) => {
  if (code === 'PENDING_LIMIT') {
    return new HttpError(429, `You already have ${limit} songs in the queue. Send more when one finishes.`, code, {
      limit, scope, pending: pending ?? limit, frees: 'finish',
    });
  }
  const reset = dailyReset(now);
  const message =
    code === 'CACHE_LIMIT'
      ? `You have opened ${limit} stored results today. The count resets at 00:00 UTC.`
      : scope === 'account'
        ? `You have used today's ${limit} analyses. The count resets at 00:00 UTC.`
        : `Without an account you can analyse ${limit} songs a day. Sign in for more, or come back after 00:00 UTC.`;
  const error = new HttpError(429, message, code, { limit, scope, frees: 'reset', ...reset });
  error.headers = { 'Retry-After': String(reset.retryAfterS) };
  return error;
};

/**
 * Moderation (W3.18): staff may take a waiting or running job off the queue,
 * which fails it with this message, or hand a running one back to it. Each
 * is recorded with who did it, in `moderation_log`.
 */
export const REMOVED = 'Removed from the queue by a moderator.';
export const MODERATION_LOG_LIMIT = 50;
/** The staff panel's recent failures (W13.19): the last week, at most this many. */
export const FAILURE_LIMIT = 30;
export const FAILURE_DAYS = 7;

/**
 * Why an analysis failed, as a code (W13.19): the worker writes `too_heavy:`
 * or `timeout:` before its message (worker/isolate.py), a moderator's
 * removal and the sweeper's time-out have fixed texts here, and anything
 * else is the engine's own `failed`.
 */
export const failureCode = (error) => {
  const text = String(error ?? '');
  if (text === REMOVED) return 'removed';
  if (text === 'The analysis took too long and was stopped.') return 'stale';
  const prefix = /^([a-z_]{1,32}):\s/.exec(text);
  return prefix ? prefix[1] : 'failed';
};

/** How long a finished analysis stays on the public queue, and how many of them. */
export const RECENT_MINUTES = 60;
export const RECENT_LIMIT = 20;
/** The most unfinished rows the queue page lists; past it, it says how many more. */
export const LIVE_LIMIT = 100;
/** The most re-analyses (W3.24) a result page links to. */
export const RELATED_LIMIT = 20;

/**
 * Delete-own (W3.26) takes only a finished analysis: a queued one is
 * cancelled instead (W3.12), a running one is the worker's until it ends.
 * What a deletion clears at once: the result, every name, the publication.
 * A row created today stays, marked, so the day's quota still counts it;
 * from the next UTC day it goes for good (`purgeDeleted`).
 */
export const FINISHED = ['done', 'refused', 'failed'];
export const ERASED = () => ({
  result: null, filename: null, tagTitle: null, tagArtist: null, publishedAt: null, private: true, error: null,
});

/**
 * Whose turn an analysis waits for (W3.9): the account, or without one the
 * hashed address the anonymous quota counts (for IPv6, the hashed /64:
 * utils/client-ip.js). A cookie cleared between uploads, or an address
 * rotated inside the same /64, is still the same person here.
 */
export const ownerOf = (a) => a.accountId ?? `ip:${a.ipHash}`;

/**
 * The queue's order: round robin between people, each person's songs in the
 * order they sent them. Someone's 30th song waits behind everybody else's
 * 1st, so a batch never leaves a single upload waiting for all of it.
 *
 * Within a turn, whoever was served longest ago (or never) goes first.
 * Without that, the second song of a batch would become its owner's 1st the
 * moment the first one was taken, and win the tie against a newcomer's 1st
 * by being older: the batch would still go first in full.
 *
 * `lastServed(owner)` is when that person's latest job was claimed, in ms, or
 * 0 for never.
 */
export const fairOrder = (queued, owner = ownerOf, lastServed = () => 0) => {
  const turns = new Map();
  return [...queued]
    .sort((x, y) => x.job.seq - y.job.seq)
    .map((a) => {
      const turn = (turns.get(owner(a)) ?? 0) + 1;
      turns.set(owner(a), turn);
      return { a, turn, served: lastServed(owner(a)) };
    })
    .sort((x, y) => x.turn - y.turn || x.served - y.served || x.a.job.seq - y.a.job.seq)
    .map(({ a }) => a);
};

// ── Memory ──────────────────────────────────────────────────────────────────

/**
 * W12.21: the analyses of the same audio by the same owner (the account, or
 * without one the anonymous cookie's hash), newest first: the readings a
 * timing's version list shows. At most this many.
 */
export const SIBLINGS_LIMIT = 20;
