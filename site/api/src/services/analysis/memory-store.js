/** The queue and its rows in this process's memory, for development without a database. */
import { BPM_EDGES, bucketOf, percentile, STATS_DAYS } from '../../utils/stats.js';
import { encodeCursor, isVariable, mainBpm, matches, microsOf } from '../../utils/timings.js';
import {
  engineHash,
  ERASED,
  FAILURE_DAYS,
  FAILURE_LIMIT,
  fairOrder,
  FINISHED,
  LIVE_LIMIT,
  MAX_ATTEMPTS,
  MODERATION_LOG_LIMIT,
  ownerOf,
  RECENT_LIMIT,
  RECENT_MINUTES,
  refusal,
  RELATED_LIMIT,
  REMOVED,
  SIBLINGS_LIMIT,
  startOfUtcDay,
  statusOf,
  versionOf,
} from './policy.js';

const memory = { analyses: new Map(), seq: 0, log: [] };

const memoryQueued = () => {
  const all = [...memory.analyses.values()];
  const served = new Map();
  for (const a of all) {
    const at = a.job?.claimedAt?.getTime() ?? 0;
    if (at > (served.get(ownerOf(a)) ?? 0)) served.set(ownerOf(a), at);
  }
  return fairOrder(all.filter((a) => a.job?.state === 'queued'), ownerOf, (o) => served.get(o) ?? 0);
};

// Synchronous on purpose: create() re-checks the limits with these and inserts
// with no await in between, so two requests cannot both pass and both insert.
const memoryCounts = ({ accountId, ipHash }) => {
  const owner = accountId ?? `ip:${ipHash}`;
  const since = startOfUtcDay();
  const counts = { mine: 0, all: 0, today: 0, cachedToday: 0 };
  for (const a of memory.analyses.values()) {
    if (a.job?.state === 'queued' || a.job?.state === 'running') {
      counts.all += 1;
      if (ownerOf(a) === owner) counts.mine += 1;
    }
    if (a.createdAt < since || ownerOf(a) !== owner) continue;
    if (a.cachedFrom) counts.cachedToday += 1;
    else counts.today += 1;
  }
  return counts;
};

export const memoryStore = {
  async countPending(who) {
    const { mine, all } = memoryCounts(who);
    return { mine, all };
  },

  async countToday(who) {
    return memoryCounts(who).today;
  },

  // Mode and hints are part of every cache key (W11.1, W3.21): the same audio
  // asked for another way is another result, and another copy.
  async findCopy({ sha1, accountId, anonHash, mode = 'normal', optionsKey = '' }) {
    const since = startOfUtcDay();
    for (const a of memory.analyses.values()) {
      if (!a.cachedFrom || a.deletedAt || a.sha1 !== sha1 || a.createdAt < since) continue;
      if (a.mode !== mode || a.optionsKey !== optionsKey) continue;
      if (accountId ? a.accountId === accountId : !a.accountId && a.anonHash === anonHash) return a;
    }
    return null;
  },

  async findCached(sha1, hash, mode = 'normal', optionsKey = '') {
    if (!hash) return null;
    let best = null;
    for (const a of memory.analyses.values()) {
      if (a.sha1 === sha1 && a.engineHash === hash && a.mode === mode && a.optionsKey === optionsKey &&
          a.result && !a.cachedFrom) best = a;
    }
    return best;
  },

  /** The analyses linked to `publicId` by a re-analysis (W3.24), either way, oldest first. */
  async related(publicId) {
    const a = memory.analyses.get(publicId);
    if (!a) return [];
    return [...memory.analyses.values()]
      .filter((b) => !b.deletedAt && b.publicId !== publicId && (b.reanalysisOf === publicId || a.reanalysisOf === b.publicId))
      .sort((x, y) => x.createdAt - y.createdAt)
      .slice(0, RELATED_LIMIT)
      .map((b) => ({ ...b }));
  },

  async create({
    publicId, sha1, filename, sizeBytes, accountId, anonHash, ipHash, cachedFrom = null,
    private: hidden = false, tagTitle = null, tagArtist = null, uploader = null,
    mode = 'normal', options = null, optionsKey = '', audioSeconds = null, reanalysisOf = null,
  }, { limits = null } = {}) {
    if (limits) {
      const error = refusal(memoryCounts({ accountId, ipHash }), limits, Boolean(cachedFrom));
      if (error) throw error;
    }
    const row = {
      publicId, sha1, filename, sizeBytes, accountId, anonHash, ipHash,
      private: hidden, tagTitle, tagArtist, uploader,
      mode, options: options && Object.keys(options).length ? options : null, optionsKey, audioSeconds,
      reanalysisOf: reanalysisOf && memory.analyses.has(reanalysisOf) ? reanalysisOf : null,
      createdAt: new Date(), finishedAt: null, publishedAt: null, deletedAt: null,
      status: 'queued', stage: null, progress: 0, error: null,
      result: null, engineHash: engineHash(mode), cachedFrom: null,
      job: { seq: ++memory.seq, state: 'queued', attempts: 0, lockedAt: null },
    };
    if (cachedFrom) {
      Object.assign(row, {
        status: cachedFrom.status, progress: 1, result: cachedFrom.result, engineHash: cachedFrom.engineHash, ...versionOf(cachedFrom.result),
        cachedFrom: cachedFrom.publicId, finishedAt: new Date(), job: null,
      });
    }
    memory.analyses.set(publicId, row);
    return row;
  },

  async get(publicId, { position: rank = true } = {}) {
    const a = memory.analyses.get(publicId);
    if (!a || a.deletedAt) return null;
    let position = null;
    if (rank && a.job?.state === 'queued') {
      position = 1 + memoryQueued().indexOf(a);
    }
    return { ...a, position };
  },

  async queue() {
    const all = [...memory.analyses.values()];
    const queued = memoryQueued();
    const running = all.filter((a) => a.job?.state === 'running').sort((x, y) => x.job.seq - y.job.seq);
    const since = Date.now() - RECENT_MINUTES * 60_000;
    const recent = all
      .filter((a) => a.finishedAt && !a.deletedAt && a.finishedAt.getTime() >= since)
      .sort((x, y) => y.finishedAt - x.finishedAt)
      .slice(0, RECENT_LIMIT);
    const live = [...running.map((a) => ({ ...a, position: null })), ...queued.map((a, i) => ({ ...a, position: i + 1 }))];
    return { live: live.slice(0, LIVE_LIMIT), more: Math.max(0, live.length - LIVE_LIMIT), recent };
  },

  async cancel(publicId) {
    const a = memory.analyses.get(publicId);
    if (a?.job?.state !== 'queued') return false;
    memory.analyses.delete(publicId);
    return true;
  },

  async claim() {
    const next = memoryQueued()[0];
    if (!next) return null;
    const now = new Date();
    Object.assign(next.job, { state: 'running', attempts: next.job.attempts + 1, lockedAt: now, claimedAt: now });
    Object.assign(next, { status: 'running', stage: null, progress: 0 });
    return {
      publicId: next.publicId, filename: next.filename, attempt: next.job.attempts,
      mode: next.mode ?? 'normal', options: next.options ?? {},
    };
  },

  running(publicId, attempt) {
    const a = memory.analyses.get(publicId);
    return a?.job?.state === 'running' && a.job.attempts === attempt ? a : null;
  },

  async isRunning(publicId, attempt) {
    return Boolean(this.running(publicId, attempt));
  },

  async progress(publicId, attempt, { stage, progress }) {
    const a = this.running(publicId, attempt);
    if (!a) return false;
    // A heartbeat: a job still reporting is not stuck (requeueStale).
    a.job.lockedAt = new Date();
    Object.assign(a, { stage, progress });
    return true;
  },

  /** `asked` is the mode and hints the result was made with (internal.routes.js `askedOf`), which the row takes on. */
  async finish(publicId, attempt, result, asked = null) {
    const a = this.running(publicId, attempt);
    if (!a) return false;
    a.job.state = 'done';
    a.job.lockedAt = null;
    Object.assign(a, {
      status: statusOf(result), result, engineHash: result.engine_hash, ...versionOf(result), progress: 1, stage: null, finishedAt: new Date(),
      ...(asked ? { mode: asked.mode, options: Object.keys(asked.options).length ? asked.options : null, optionsKey: asked.key } : {}),
    });
    return true;
  },

  async fail(publicId, attempt, error) {
    const a = this.running(publicId, attempt);
    if (!a) return false;
    Object.assign(a.job, { state: 'failed', lockedAt: null });
    Object.assign(a, { status: 'failed', error, stage: null, finishedAt: new Date() });
    return true;
  },

  async requeueStale(timeoutS) {
    const cutoff = Date.now() - timeoutS * 1000;
    const failed = [];
    for (const a of memory.analyses.values()) {
      if (a.job?.state !== 'running' || a.job.lockedAt.getTime() > cutoff) continue;
      a.job.lockedAt = null;
      if (a.job.attempts >= MAX_ATTEMPTS) {
        a.job.state = 'failed';
        Object.assign(a, { status: 'failed', error: 'The analysis took too long and was stopped.', stage: null, finishedAt: new Date() });
        failed.push(a.publicId);
      } else {
        a.job.state = 'queued';
        Object.assign(a, { status: 'queued', stage: null, progress: 0 });
      }
    }
    return failed;
  },

  async remove(publicId, by) {
    const a = memory.analyses.get(publicId);
    if (a?.job?.state !== 'queued' && a?.job?.state !== 'running') return false;
    Object.assign(a.job, { state: 'failed', lockedAt: null });
    Object.assign(a, { status: 'failed', error: REMOVED, stage: null, finishedAt: new Date() });
    memoryLog('remove', a, by);
    return true;
  },

  async requeue(publicId, by) {
    const a = memory.analyses.get(publicId);
    if (a?.job?.state !== 'running') return false;
    Object.assign(a.job, { state: 'queued', lockedAt: null });
    Object.assign(a, { status: 'queued', stage: null, progress: 0 });
    memoryLog('requeue', a, by);
    return true;
  },

  async moderationLog(limit = MODERATION_LOG_LIMIT) {
    return memory.log.slice(-limit).reverse();
  },

  /** W13.19: the latest failed analyses within FAILURE_DAYS, newest first, for the staff panel. */
  async recentFailures(limit = FAILURE_LIMIT) {
    const since = Date.now() - FAILURE_DAYS * 86_400_000;
    return [...memory.analyses.values()]
      .filter((a) => a.status === 'failed' && a.finishedAt && a.finishedAt.getTime() >= since)
      .sort((x, y) => y.finishedAt - x.finishedAt)
      .slice(0, limit)
      .map((a) => ({ publicId: a.publicId, error: a.error, mode: a.mode ?? 'normal', audioSeconds: a.audioSeconds ?? null, finishedAt: a.finishedAt }));
  },

  // ── Published timings and history (W3.27, W5.1, W3.26) ──

  async publish(publicId) {
    const a = memory.analyses.get(publicId);
    if (!a || a.deletedAt || a.status !== 'done') return false;
    // Publishing again keeps the first time: a second press does not jump the list.
    a.publishedAt ??= new Date();
    a.private = false;
    return true;
  },

  async unpublish(publicId) {
    const a = memory.analyses.get(publicId);
    if (!a || a.deletedAt) return false;
    a.publishedAt = null;
    return true;
  },

  async getPublished(publicId) {
    const a = memory.analyses.get(publicId);
    return a && a.publishedAt && !a.deletedAt && a.status === 'done' ? { ...a } : null;
  },

  async getViewable(publicId) {
    const a = memory.analyses.get(publicId);
    return a && !a.deletedAt && a.status === 'done' && (a.publishedAt || (!a.private && !a.accountId)) ? { ...a } : null;
  },

  async listPublished(filters) {
    return memoryPage(
      [...memory.analyses.values()].filter((a) => a.publishedAt && !a.deletedAt && a.status === 'done'),
      (a) => a.publishedAt,
      filters,
    );
  },

  async history(accountId, filters) {
    return memoryPage(
      [...memory.analyses.values()].filter((a) => a.accountId === accountId && !a.deletedAt),
      (a) => a.createdAt,
      filters,
    );
  },

  async deleteOwn(publicId) {
    const a = memory.analyses.get(publicId);
    if (!a || a.deletedAt || !FINISHED.includes(a.status) || a.job?.state === 'queued' || a.job?.state === 'running') return false;
    if (a.createdAt < startOfUtcDay()) memory.analyses.delete(publicId);
    else Object.assign(a, ERASED(), { deletedAt: new Date() });
    return true;
  },

  async purgeDeleted() {
    const since = startOfUtcDay();
    for (const [id, a] of memory.analyses) if (a.deletedAt && a.createdAt < since) memory.analyses.delete(id);
  },

  // ── Versions of a timing (W12.21) ──

  async siblings(row, limit = SIBLINGS_LIMIT) {
    // Newest inserted first, then a stable sort: rows made in the same
    // millisecond keep that order, as PostgreSQL's `id DESC` does.
    return [...memory.analyses.values()]
      .reverse()
      .filter((a) => !a.deletedAt && a.sha1 === row.sha1 && sameOwner(a, row))
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, limit)
      .map((a) => ({ ...a }));
  },

  // ── Site statistics (W12.13) ──

  async stats({ days = STATS_DAYS } = {}) {
    const counts = { done: 0, refused: 0, failed: 0, cached: 0, published: 0 };
    const songs = new Set();
    const buckets = new Array(BPM_EDGES.length + 1).fill(0);
    const tempo = { single: 0, variable: 0 };
    const durations = [];
    const queue = { queued: 0, running: 0 };
    const recent = { week: 0, month: 0 };
    const since = Date.now() - days * 86_400_000;
    const week = Date.now() - 7 * 86_400_000;
    const month = Date.now() - 30 * 86_400_000;
    for (const a of memory.analyses.values()) {
      if (a.job?.state === 'queued') queue.queued += 1;
      else if (a.job?.state === 'running') queue.running += 1;
      if (a.deletedAt) continue;
      if (a.cachedFrom) {
        if (a.status === 'done' || a.status === 'refused') counts.cached += 1;
        continue;
      }
      if (a.status === 'done') {
        counts.done += 1;
        songs.add(a.sha1);
        if (a.publishedAt) counts.published += 1;
        const bpm = mainBpm(a.result);
        if (bpm !== null) buckets[bucketOf(bpm)] += 1;
        tempo[isVariable(a.result) ? 'variable' : 'single'] += 1;
        if (a.finishedAt && a.finishedAt.getTime() >= since) durations.push(a.finishedAt - a.createdAt);
        if (a.finishedAt && a.finishedAt.getTime() >= week) recent.week += 1;
        if (a.finishedAt && a.finishedAt.getTime() >= month) recent.month += 1;
      } else if (a.status === 'refused') counts.refused += 1;
      else if (a.status === 'failed') counts.failed += 1;
    }
    return {
      counts: { ...counts, songs: songs.size },
      buckets,
      tempo,
      times: { count: durations.length, medianMs: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9) },
      queue,
      timed: { last7Days: recent.week, last30Days: recent.month },
    };
  },
};

const sameOwner = (a, row) => (row.accountId ? a.accountId === row.accountId : !a.accountId && Boolean(row.anonHash) && a.anonHash === row.anonHash);

/**
 * One page of `rows`, newest first by `at(row)` and then by public id, from
 * after the cursor: the same keyset order PostgreSQL reads. Returns
 * `{ rows, next }`, next being the cursor of the page after, or null.
 */
const memoryPage = (rows, at, filters) => {
  const key = (a) => [microsOf(at(a)), a.publicId];
  const after = filters.cursor;
  const sorted = rows
    .filter((a) => matches(a, filters))
    .map((a) => ({ a, k: key(a) }))
    .filter(({ k }) => !after || k[0] < after.micros || (k[0] === after.micros && k[1] < after.id))
    .sort((x, y) => (x.k[0] === y.k[0] ? (x.k[1] < y.k[1] ? 1 : -1) : x.k[0] < y.k[0] ? 1 : -1));
  const page = sorted.slice(0, filters.limit);
  const last = page.at(-1);
  return {
    rows: page.map(({ a }) => ({ ...a })),
    next: sorted.length > filters.limit && last ? encodeCursor(last.k[0], last.k[1]) : null,
  };
};

const memoryLog = (action, a, { accountId, moderator, reason }) =>
  memory.log.push({ action, moderator, accountId, publicId: a.publicId, reason: reason ?? null, createdAt: new Date() });

// ── PostgreSQL ──────────────────────────────────────────────────────────────

export const memoryAnalyses = () => memory.analyses.values();
