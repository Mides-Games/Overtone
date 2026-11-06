/**
 * Analyses and their queue (ADR-W5): `songs` by audio SHA-1, one `analyses`
 * row per upload, one `jobs` row per analysis the worker has to run.
 *
 * With a database the queue is the `jobs` table, claimed with
 * `FOR UPDATE SKIP LOCKED`. Without one (development only; env.js refuses it
 * in production) the same rows live in this process's memory, as accounts do,
 * and vanish on restart together with the spooled audio.
 *
 * An analysis is named outside the API by `public_id`, 128 random bits in
 * hex: knowing it is half of being allowed to read it (the other half is the
 * session or the anonymous cookie that created it).
 *
 * Status: queued -> running -> done | refused | failed. A refusal is a
 * result (the engine found no pulse it would stand behind), not a failure.
 * A queued analysis its uploader cancels (W3.12) is deleted outright, job
 * and row: it was never analysed, so it leaves no trace in the quota.
 */

import { hasDatabase } from '../config/database.js';
import { memoryStore } from './analysis/memory-store.js';
import { pgStore } from './analysis/pg-store.js';

export {
  dailyReset,
  engineHash,
  FAILURE_DAYS,
  FAILURE_LIMIT,
  failureCode,
  fairOrder,
  limitRefusal,
  LIVE_LIMIT,
  MAX_ATTEMPTS,
  MODERATION_LOG_LIMIT,
  newPublicId,
  RECENT_LIMIT,
  RECENT_MINUTES,
  refusal,
  RELATED_LIMIT,
  REMOVED,
  setEngineHash,
  SIBLINGS_LIMIT,
  versionOf,
} from './analysis/policy.js';
/**
 * For services/social.service.js: what a published row is and how a list
 * reads one, in SQL, and the memory store's rows, so the social orders and
 * totals read the same rows the recent list does.
 */
export { memoryAnalyses } from './analysis/memory-store.js';
export {
  BPM,
  filterClauses,
  LIST_COLS,
  listRow,
  PUBLISHED,
  VARIABLE,
} from './analysis/pg-list.js';

export const analyses = () => (hasDatabase() ? pgStore : memoryStore);
