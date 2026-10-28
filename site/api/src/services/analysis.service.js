import { randomBytes } from 'node:crypto';

import { hasDatabase, pool, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';
import { encodeCursor, likePattern, matches, microsOf } from '../utils/timings.js';

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

const startOfUtcDay = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** A section-weighted confidence for the `analyses.confidence` column, or null. */
const confidenceOf = (result) => {
  const sections = result?.sections ?? [];
  if (!sections.length) return null;
  const value = Math.min(...sections.map((s) => Number(s.confidence)).filter(Number.isFinite));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
};

const statusOf = (result) => (result?.refused ? 'refused' : 'done');

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
    return cachedToday >= limits.cacheDaily
      ? new HttpError(429, `You have opened ${limits.cacheDaily} stored results today. The count resets at 00:00 UTC.`,
        'CACHE_LIMIT', { limit: limits.cacheDaily, scope })
      : null;
  }
  if (today >= limits.quota) {
    return new HttpError(
      429,
      scope === 'account'
        ? `You have used today's ${limits.quota} analyses. The count resets at 00:00 UTC.`
        : `Without an account you can analyse ${limits.quota} songs a day. Sign in for more, or come back after 00:00 UTC.`,
      'QUOTA_EXCEEDED',
      { limit: limits.quota, scope },
    );
  }
  if (mine >= limits.maxPending) {
    return new HttpError(429, `You already have ${limits.maxPending} songs in the queue. Send more when one finishes.`,
      'PENDING_LIMIT', { limit: limits.maxPending, scope });
  }
  if (all >= limits.queueMax) return new HttpError(503, 'The queue is full. Try again in a few minutes.', 'QUEUE_FULL');
  return null;
};

/**
 * Moderation (W3.18): staff may take a waiting or running job off the queue,
 * which fails it with this message, or hand a running one back to it. Each
 * is recorded with who did it, in `moderation_log`.
 */
export const REMOVED = 'Removed from the queue by a moderator.';
export const MODERATION_LOG_LIMIT = 50;

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
const FINISHED = ['done', 'refused', 'failed'];
const ERASED = () => ({
  result: null, filename: null, tagTitle: null, tagArtist: null, publishedAt: null, private: true, error: null,
});

/**
 * Whose turn an analysis waits for (W3.9): the account, or without one the
 * hashed address the anonymous quota counts (for IPv6, the hashed /64:
 * utils/client-ip.js). A cookie cleared between uploads, or an address
 * rotated inside the same /64, is still the same person here.
 */
const ownerOf = (a) => a.accountId ?? `ip:${a.ipHash}`;

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

const memoryStore = {
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
        status: cachedFrom.status, progress: 1, result: cachedFrom.result, engineHash: cachedFrom.engineHash,
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
      status: statusOf(result), result, engineHash: result.engine_hash, progress: 1, stage: null, finishedAt: new Date(),
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
};

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

const SELECT = `
  SELECT a.public_id, a.account_id, a.anon_hash, a.ip_hash, a.filename, a.size_bytes, a.status, a.stage,
         a.progress, a.error, a.result, a.engine_hash, a.created_at, a.finished_at,
         a.private, a.tag_title, a.tag_artist, a.published_at, a.deleted_at,
         a.mode, a.options, a.options_key, a.audio_seconds, r.public_id AS reanalysis_of,
         c.public_id AS cached_from, s.audio_sha1, j.id AS job_id, j.state AS job_state
    FROM analyses a
    JOIN songs s ON s.id = a.song_id
    LEFT JOIN jobs j ON j.analysis_id = a.id
    LEFT JOIN analyses c ON c.id = a.cached_from
    LEFT JOIN analyses r ON r.id = a.reanalysis_of`;

const fromRow = (r) =>
  r && {
    publicId: r.public_id,
    accountId: r.account_id,
    anonHash: r.anon_hash,
    ipHash: r.ip_hash,
    filename: r.filename,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    error: r.error,
    result: r.result,
    engineHash: r.engine_hash,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    cachedFrom: r.cached_from,
    sha1: r.audio_sha1,
    jobId: r.job_id,
    jobState: r.job_state,
    private: r.private,
    tagTitle: r.tag_title,
    tagArtist: r.tag_artist,
    publishedAt: r.published_at ?? null,
    deletedAt: r.deleted_at ?? null,
    mode: r.mode ?? 'normal',
    options: r.options ?? null,
    optionsKey: r.options_key ?? '',
    audioSeconds: r.audio_seconds ?? null,
    reanalysisOf: r.reanalysis_of?.trim() ?? null,
  };

/** The audit record of a moderation (W3.18), written in the same transaction as the change. */
const pgLog = (client, action, analysisId, publicId, { accountId, moderator, reason }) =>
  client.query(
    `INSERT INTO moderation_log (account_id, moderator, action, analysis_id, public_id, reason)
          VALUES ($1, $2, $3, $4, $5, $6)`,
    [accountId, moderator, action, analysisId, publicId, reason ?? null],
  );

const transaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/** The running job of `publicId` at `attempt`, locked for the rest of the transaction. */
const lockRunning = async (client, publicId, attempt) => {
  const { rows } = await client.query(
    `SELECT a.id AS analysis_id, a.song_id, j.id AS job_id
       FROM analyses a JOIN jobs j ON j.analysis_id = a.id
      WHERE a.public_id = $1 AND j.state = 'running' AND j.attempts = $2
        FOR UPDATE OF j`,
    [publicId, attempt],
  );
  return rows[0] ?? null;
};

/**
 * Every queued job and its place in `fairOrder`: each person's own turn
 * number first (their 1st song, 2nd, ...), then whoever was served longest
 * ago, then the job id. A priority, which nothing sets yet, comes before all.
 */
const OWNER = "coalesce(a.account_id::text, 'ip:' || a.ip_hash)";
const FAIR_POSITIONS = `
  SELECT turns.id, row_number() OVER (ORDER BY turns.priority DESC, turns.turn, served.at NULLS FIRST, turns.id) AS position
    FROM (SELECT j.id, j.priority, ${OWNER} AS owner,
                 row_number() OVER (PARTITION BY ${OWNER} ORDER BY j.id) AS turn
            FROM jobs j JOIN analyses a ON a.id = j.analysis_id
           WHERE j.state = 'queued') turns
    LEFT JOIN (SELECT ${OWNER} AS owner, max(j.claimed_at) AS at
                 FROM jobs j JOIN analyses a ON a.id = j.analysis_id
                WHERE j.claimed_at > now() - interval '1 day'
                GROUP BY 1) served ON served.owner = turns.owner`;

/** One owner's counts in one statement, run by `run` (the pool, or a transaction's client). */
const pgCounts = async (run, { accountId, ipHash }) => {
  const mine = accountId ? 'a.account_id = $1' : 'a.account_id IS NULL AND a.ip_hash = $1';
  const { rows: [row] } = await run(
    `SELECT (SELECT count(*) FROM jobs j JOIN analyses a ON a.id = j.analysis_id
               WHERE j.state IN ('queued', 'running') AND ${mine})::int AS mine,
            (SELECT count(*) FROM jobs WHERE state IN ('queued', 'running'))::int AS total,
            (SELECT count(*) FROM analyses a WHERE ${mine} AND a.created_at >= $2 AND a.cached_from IS NULL)::int AS today,
            (SELECT count(*) FROM analyses a WHERE ${mine} AND a.created_at >= $2 AND a.cached_from IS NOT NULL)::int AS cached`,
    [accountId ?? ipHash, startOfUtcDay()],
  );
  return { mine: row.mine, all: row.total, today: row.today, cachedToday: row.cached };
};

// Every insert that is held to a limit takes this lock first, so the counts it
// reads are still true when it commits: two uploads cannot both pass the last
// free place. Inserts are a few milliseconds; nothing else waits on it.
const INSERT_LOCK = 0x0e7701;

const pgStore = {
  async countPending(who) {
    const { mine, all } = await pgCounts(query, who);
    return { mine, all };
  },

  async countToday(who) {
    return (await pgCounts(query, who)).today;
  },

  async findCopy({ sha1, accountId, anonHash, mode = 'normal', optionsKey = '' }) {
    const { rows } = await query(
      `${SELECT}
        WHERE s.audio_sha1 = $1 AND a.cached_from IS NOT NULL AND a.created_at >= $3 AND a.deleted_at IS NULL
          AND a.mode = $4 AND a.options_key = $5
          AND ${accountId ? 'a.account_id = $2' : 'a.account_id IS NULL AND a.anon_hash = $2'}
        ORDER BY a.id DESC LIMIT 1`,
      [sha1, accountId ?? anonHash, startOfUtcDay(), mode, optionsKey],
    );
    return fromRow(rows[0]);
  },

  async findCached(sha1, hash, mode = 'normal', optionsKey = '') {
    if (!hash) return null;
    const { rows } = await query(
      `${SELECT}
        WHERE s.audio_sha1 = $1 AND a.engine_hash = $2 AND a.mode = $3 AND a.options_key = $4
          AND a.result IS NOT NULL AND a.cached_from IS NULL
        ORDER BY a.id DESC LIMIT 1`,
      [sha1, hash, mode, optionsKey],
    );
    return fromRow(rows[0]);
  },

  async related(publicId) {
    const { rows } = await query(
      `${SELECT}
        WHERE a.deleted_at IS NULL AND a.public_id <> $1
          AND (a.reanalysis_of = (SELECT id FROM analyses WHERE public_id = $1)
               OR a.id = (SELECT reanalysis_of FROM analyses WHERE public_id = $1))
        ORDER BY a.id LIMIT $2`,
      [publicId, RELATED_LIMIT],
    );
    return rows.map(fromRow);
  },

  async create({
    publicId, sha1, filename, sizeBytes, accountId, anonHash, ipHash, cachedFrom = null,
    private: hidden = false, tagTitle = null, tagArtist = null,
    mode = 'normal', options = null, optionsKey = '', audioSeconds = null, reanalysisOf = null,
  }, { limits = null } = {}) {
    const hints = options && Object.keys(options).length ? options : null;
    await transaction(async (client) => {
      if (limits) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [INSERT_LOCK]);
        const error = refusal(await pgCounts((...args) => client.query(...args), { accountId, ipHash }), limits, Boolean(cachedFrom));
        if (error) throw error;
      }
      const { rows: [song] } = await client.query(
        `INSERT INTO songs (audio_sha1) VALUES ($1)
         ON CONFLICT (audio_sha1) DO UPDATE SET audio_sha1 = EXCLUDED.audio_sha1
         RETURNING id`,
        [sha1],
      );
      // W3.24: a re-analysis names the one it was made from; the route
      // checked it is the same person's and the same audio.
      const linked = '(SELECT id FROM analyses WHERE public_id = $16)';
      if (cachedFrom) {
        await client.query(
          `INSERT INTO analyses (public_id, song_id, account_id, anon_hash, ip_hash, filename, size_bytes, engine,
                                 engine_hash, result, confidence, status, progress, finished_at, cached_from,
                                 private, tag_title, tag_artist, mode, options, options_key, audio_seconds, reanalysis_of)
           SELECT $1, $2, $3, $4, $5, $6, $7, c.engine, c.engine_hash, c.result, c.confidence, c.status, 1, now(), c.id,
                  $9, $10, $11, $12, $13, $14, $15, ${linked}
             FROM analyses c WHERE c.public_id = $8`,
          [publicId, song.id, accountId, anonHash, ipHash, filename, sizeBytes, cachedFrom.publicId, hidden, tagTitle, tagArtist,
            mode, hints, optionsKey, audioSeconds, reanalysisOf],
        );
        return;
      }
      const { rows: [analysis] } = await client.query(
        `INSERT INTO analyses (public_id, song_id, account_id, anon_hash, ip_hash, filename, size_bytes, engine, engine_hash,
                               private, tag_title, tag_artist, mode, options, options_key, audio_seconds, reanalysis_of)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'v3', $8, $9, $10, $11, $12, $13, $14, $15, ${linked})
           RETURNING id`,
        [publicId, song.id, accountId, anonHash, ipHash, filename, sizeBytes, engineHash(mode) ?? 'pending', hidden, tagTitle, tagArtist,
          mode, hints, optionsKey, audioSeconds, reanalysisOf],
      );
      await client.query('INSERT INTO jobs (analysis_id) VALUES ($1)', [analysis.id]);
    });
    return this.get(publicId);
  },

  /** One analysis; `position: false` skips ranking the whole queue, for callers that do not show it. */
  async get(publicId, { position: rank = true } = {}) {
    const { rows } = await query(`${SELECT} WHERE a.public_id = $1 AND a.deleted_at IS NULL`, [publicId]);
    const row = fromRow(rows[0]);
    if (!row) return null;
    let position = null;
    if (rank && row.jobState === 'queued') {
      const { rows: [place] } = await query(`SELECT position FROM (${FAIR_POSITIONS}) p WHERE id = $1`, [row.jobId]);
      position = place ? Number(place.position) : null;
    }
    return { ...row, position };
  },

  async queue() {
    const COLS = `a.public_id, a.account_id, a.anon_hash, a.filename, a.status, a.stage, a.progress,
                  a.created_at, a.finished_at, a.private, a.tag_title, a.tag_artist,
                  a.cached_from IS NOT NULL AS cached, a.mode, a.audio_seconds,
                  u.username, u.display_name, u.avatar_url`;
    // Running first, then queued in the order the claim takes them.
    const { rows: live } = await query(
      `SELECT ${COLS}, p.position, count(*) OVER () AS total
         FROM jobs j
         JOIN analyses a ON a.id = j.analysis_id
         LEFT JOIN accounts u ON u.id = a.account_id
         LEFT JOIN (${FAIR_POSITIONS}) p ON p.id = j.id
        WHERE j.state IN ('queued', 'running')
        ORDER BY j.state = 'queued', p.position, j.id
        LIMIT $1`,
      [LIVE_LIMIT],
    );
    const { rows: recent } = await query(
      `SELECT ${COLS}
         FROM analyses a
         LEFT JOIN accounts u ON u.id = a.account_id
        WHERE a.finished_at >= now() - make_interval(mins => $1) AND a.deleted_at IS NULL
        ORDER BY a.finished_at DESC
        LIMIT $2`,
      [RECENT_MINUTES, RECENT_LIMIT],
    );
    const shape = (r) => ({
      publicId: r.public_id,
      accountId: r.account_id,
      anonHash: r.anon_hash,
      filename: r.filename,
      status: r.status,
      stage: r.stage,
      progress: r.progress,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      private: r.private,
      tagTitle: r.tag_title,
      tagArtist: r.tag_artist,
      cachedFrom: r.cached || null,
      mode: r.mode ?? 'normal',
      audioSeconds: r.audio_seconds ?? null,
      position: r.position == null ? null : Number(r.position),
      uploader: r.username ? { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null,
    });
    const total = live.length ? Number(live[0].total) : 0;
    return { live: live.map(shape), more: Math.max(0, total - live.length), recent: recent.map(shape) };
  },

  async cancel(publicId) {
    // One statement: a claim that took the job first holds its row lock, and
    // once it commits the state is re-checked here and nothing is deleted.
    // The job goes with the analysis (ON DELETE CASCADE).
    const { rowCount } = await query(
      `DELETE FROM analyses a USING jobs j
        WHERE j.analysis_id = a.id AND a.public_id = $1 AND j.state = 'queued'`,
      [publicId],
    );
    return rowCount > 0;
  },

  async claim() {
    const { rows } = await query(
      `WITH next AS (
         SELECT j.id FROM jobs j JOIN (${FAIR_POSITIONS}) p ON p.id = j.id
          -- Checked again here, on the locked row: the ranking above read an
          -- older snapshot, and a job another worker just took is still in it.
          WHERE j.state = 'queued'
          ORDER BY p.position LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ), claimed AS (
         UPDATE jobs j SET state = 'running', attempts = j.attempts + 1, locked_at = now(), claimed_at = now(), error = NULL
           FROM next WHERE j.id = next.id AND j.state = 'queued'
         RETURNING j.analysis_id, j.attempts
       )
       UPDATE analyses a SET status = 'running', stage = NULL, progress = 0
         FROM claimed WHERE a.id = claimed.analysis_id
       RETURNING a.public_id, a.filename, claimed.attempts, a.mode, a.options`,
    );
    const row = rows[0];
    return row
      ? { publicId: row.public_id, filename: row.filename, attempt: row.attempts, mode: row.mode ?? 'normal', options: row.options ?? {} }
      : null;
  },

  async isRunning(publicId, attempt) {
    const { rows } = await query(
      `SELECT 1 FROM analyses a JOIN jobs j ON j.analysis_id = a.id
        WHERE a.public_id = $1 AND j.state = 'running' AND j.attempts = $2`,
      [publicId, attempt],
    );
    return rows.length > 0;
  },

  async progress(publicId, attempt, { stage, progress }) {
    // Also a heartbeat: locked_at moves, so a job still reporting is never
    // taken for stuck by requeueStale, however long the song.
    const { rowCount } = await query(
      `WITH beat AS (
         UPDATE jobs j SET locked_at = now()
           FROM analyses a
          WHERE a.public_id = $1 AND j.analysis_id = a.id AND j.state = 'running' AND j.attempts = $2
         RETURNING j.analysis_id
       )
       UPDATE analyses a SET stage = $3, progress = $4 FROM beat WHERE a.id = beat.analysis_id`,
      [publicId, attempt, stage, progress],
    );
    return rowCount > 0;
  },

  async finish(publicId, attempt, result, asked = null) {
    return transaction(async (client) => {
      const held = await lockRunning(client, publicId, attempt);
      if (!held) return false;
      await client.query("UPDATE jobs SET state = 'done', locked_at = NULL WHERE id = $1", [held.job_id]);
      await client.query(
        `UPDATE analyses SET status = $2, result = $3, engine_hash = $4, confidence = $5, progress = 1,
                             stage = NULL, finished_at = now(),
                             mode = coalesce($6, mode), options = CASE WHEN $6::text IS NULL THEN options ELSE $7::jsonb END,
                             options_key = coalesce($8, options_key)
          WHERE id = $1`,
        [held.analysis_id, statusOf(result), result, result.engine_hash, confidenceOf(result),
          asked?.mode ?? null, asked && Object.keys(asked.options).length ? asked.options : null, asked?.key ?? null],
      );
      if (Number.isFinite(result.duration_s)) {
        await client.query(
          'UPDATE songs SET duration_ms = $2 WHERE id = $1 AND duration_ms IS NULL',
          [held.song_id, Math.round(result.duration_s * 1000)],
        );
      }
      return true;
    });
  },

  async fail(publicId, attempt, error) {
    return transaction(async (client) => {
      const held = await lockRunning(client, publicId, attempt);
      if (!held) return false;
      await client.query("UPDATE jobs SET state = 'failed', locked_at = NULL, error = $2 WHERE id = $1", [held.job_id, error]);
      await client.query(
        "UPDATE analyses SET status = 'failed', error = $2, stage = NULL, finished_at = now() WHERE id = $1",
        [held.analysis_id, error],
      );
      return true;
    });
  },

  async requeueStale(timeoutS) {
    const { rows } = await query(
      `WITH stale AS (
         UPDATE jobs SET state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
                         locked_at = NULL,
                         error = CASE WHEN attempts >= $2 THEN 'timed out' ELSE error END
          WHERE state = 'running' AND locked_at < now() - make_interval(secs => $1)
         RETURNING analysis_id, state
       )
       UPDATE analyses a
          SET status = stale.state,
              stage = NULL,
              progress = CASE WHEN stale.state = 'queued' THEN 0 ELSE a.progress END,
              error = CASE WHEN stale.state = 'failed' THEN 'The analysis took too long and was stopped.' ELSE a.error END,
              finished_at = CASE WHEN stale.state = 'failed' THEN now() ELSE NULL END
         FROM stale WHERE a.id = stale.analysis_id
       RETURNING a.public_id, stale.state`,
      [timeoutS, MAX_ATTEMPTS],
    );
    return rows.filter((r) => r.state === 'failed').map((r) => r.public_id);
  },

  async remove(publicId, by) {
    return transaction(async (client) => {
      const { rows: [row] } = await client.query(
        `WITH job AS (
           UPDATE jobs j SET state = 'failed', locked_at = NULL, error = 'removed by staff'
             FROM analyses a
            WHERE a.id = j.analysis_id AND a.public_id = $1 AND j.state IN ('queued', 'running')
           RETURNING j.analysis_id
         )
         UPDATE analyses a SET status = 'failed', error = $2, stage = NULL, finished_at = now()
           FROM job WHERE a.id = job.analysis_id
         RETURNING a.id`,
        [publicId, REMOVED],
      );
      if (!row) return false;
      await pgLog(client, 'remove', row.id, publicId, by);
      return true;
    });
  },

  async requeue(publicId, by) {
    return transaction(async (client) => {
      // The attempt count is kept: the next claim's attempt is new, so a late
      // answer from the worker that had it is refused as stale.
      const { rows: [row] } = await client.query(
        `WITH job AS (
           UPDATE jobs j SET state = 'queued', locked_at = NULL
             FROM analyses a
            WHERE a.id = j.analysis_id AND a.public_id = $1 AND j.state = 'running'
           RETURNING j.analysis_id
         )
         UPDATE analyses a SET status = 'queued', stage = NULL, progress = 0
           FROM job WHERE a.id = job.analysis_id
         RETURNING a.id`,
        [publicId],
      );
      if (!row) return false;
      await pgLog(client, 'requeue', row.id, publicId, by);
      return true;
    });
  },

  async moderationLog(limit = MODERATION_LOG_LIMIT) {
    const { rows } = await query(
      `SELECT action, moderator, account_id, public_id, reason, created_at
         FROM moderation_log WHERE target_kind = 'analysis' ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      action: r.action, moderator: r.moderator, accountId: r.account_id, publicId: r.public_id?.trim() ?? null,
      reason: r.reason, createdAt: r.created_at,
    }));
  },

  // ── Published timings and history (W3.27, W5.1, W3.26) ──

  async publish(publicId) {
    // A second publish keeps the first time: pressing twice does not jump the list.
    const { rowCount } = await query(
      `UPDATE analyses SET published_at = coalesce(published_at, now()), private = false
        WHERE public_id = $1 AND status = 'done' AND deleted_at IS NULL`,
      [publicId],
    );
    return rowCount > 0;
  },

  async unpublish(publicId) {
    const { rowCount } = await query(
      'UPDATE analyses SET published_at = NULL WHERE public_id = $1 AND deleted_at IS NULL',
      [publicId],
    );
    return rowCount > 0;
  },

  async getPublished(publicId) {
    const { rows } = await query(
      `SELECT ${LIST_COLS}, s.audio_sha1
         FROM analyses a
         JOIN songs s ON s.id = a.song_id
         LEFT JOIN accounts u ON u.id = a.account_id
        WHERE a.public_id = $1 AND ${PUBLISHED}`,
      [publicId],
    );
    return rows[0] ? { ...listRow(rows[0]), sha1: rows[0].audio_sha1 } : null;
  },

  async listPublished(filters) {
    return pgPage(PUBLISHED, [], 'a.published_at', filters);
  },

  async history(accountId, filters) {
    return pgPage('a.account_id = $1 AND a.deleted_at IS NULL', [accountId], 'a.created_at', filters);
  },

  async deleteOwn(publicId) {
    // Re-checked on the row in the same statement: a job the worker holds is
    // never deleted under it. Before today the row goes; today it is erased
    // and marked, so the day's quota still counts it.
    const finished = `a.public_id = $1 AND a.deleted_at IS NULL AND a.status IN ('done', 'refused', 'failed')
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.analysis_id = a.id AND j.state IN ('queued', 'running'))`;
    const gone = await query(`DELETE FROM analyses a WHERE ${finished} AND a.created_at < $2`, [publicId, startOfUtcDay()]);
    if (gone.rowCount > 0) return true;
    const { rowCount } = await query(
      `UPDATE analyses a SET result = NULL, filename = NULL, tag_title = NULL, tag_artist = NULL, published_at = NULL,
                             private = true, error = NULL, deleted_at = now()
        WHERE ${finished}`,
      [publicId],
    );
    return rowCount > 0;
  },

  async purgeDeleted() {
    await query('DELETE FROM analyses WHERE deleted_at IS NOT NULL AND created_at < $1', [startOfUtcDay()]);
  },
};

/**
 * A time as whole microseconds since the epoch, exactly: whole seconds and the
 * microseconds within them apart, since one double holding both can be off by one.
 */
const MICROS = (col) =>
  `(extract(epoch FROM date_trunc('second', ${col}))::bigint * 1000000 + extract(microseconds FROM ${col})::bigint % 1000000)`;

const PUBLISHED = "a.published_at IS NOT NULL AND a.deleted_at IS NULL AND a.status = 'done'";

/**
 * What the recent list, a public page and the history read. No sha1 and no
 * hashes: a list never needs them, so a list cannot leak them.
 */
const LIST_COLS = `a.public_id, a.account_id, a.filename, a.status, a.result, a.created_at, a.published_at,
                   a.private, a.tag_title, a.tag_artist, a.cached_from IS NOT NULL AS cached,
                   ${MICROS('a.created_at')} AS created_us, ${MICROS('a.published_at')} AS published_us,
                   u.username, u.display_name, u.avatar_url`;

const listRow = (r) => ({
  publicId: r.public_id,
  accountId: r.account_id,
  filename: r.filename,
  status: r.status,
  result: r.result,
  createdAt: r.created_at,
  publishedAt: r.published_at,
  private: r.private,
  tagTitle: r.tag_title,
  tagArtist: r.tag_artist,
  cachedFrom: r.cached || null,
  uploader: r.username ? { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null,
});

/** Variable tempo in SQL, as utils/timings.js `isVariable` reads it: red lines at more than one BPM, to 0.01. */
const VARIABLE = `(SELECT count(DISTINCT round((l->>'bpm')::numeric * 100)) FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(a.result->'red_lines') = 'array' THEN a.result->'red_lines' ELSE '[]'::jsonb END) l) > 1`;
const BPM = `(CASE WHEN jsonb_typeof(a.result->'global_bpm') = 'number' THEN (a.result->>'global_bpm')::float8 END)`;

/**
 * One page under `where` (with its own `params`), newest first by `atCol`
 * and then public id, after the cursor, filtered as utils/timings.js
 * `matches` filters. One row more than the page is read, to know whether
 * there is a next one.
 */
const pgPage = async (where, params, atCol, filters) => {
  const args = [...params];
  const arg = (value) => {
    args.push(value);
    return `$${args.length}`;
  };
  const clauses = [where];
  if (filters.bpmMin !== null) clauses.push(`${BPM} >= ${arg(filters.bpmMin)}`);
  if (filters.bpmMax !== null) clauses.push(`${BPM} <= ${arg(filters.bpmMax)}`);
  if (filters.tempo) clauses.push(filters.tempo === 'variable' ? VARIABLE : `NOT ${VARIABLE}`);
  if (filters.status) clauses.push(`a.status = ${arg(filters.status)}`);
  if (filters.from) clauses.push(`a.created_at >= ${arg(filters.from)}`);
  if (filters.to) clauses.push(`a.created_at < ${arg(filters.to)}`);
  if (filters.q) {
    const like = arg(likePattern(filters.q));
    clauses.push(`(a.tag_title ILIKE ${like} OR a.tag_artist ILIKE ${like} OR a.filename ILIKE ${like})`);
  }
  if (filters.cursor) {
    // Exact to the microsecond: the epoch plus a whole number of them.
    const micros = arg(String(filters.cursor.micros));
    clauses.push(`(${atCol}, a.public_id) < (timestamptz 'epoch' + ${micros}::bigint * interval '1 microsecond', ${arg(filters.cursor.id)})`);
  }
  const { rows } = await query(
    `SELECT ${LIST_COLS}
       FROM analyses a LEFT JOIN accounts u ON u.id = a.account_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${atCol} DESC, a.public_id DESC
      LIMIT ${arg(filters.limit + 1)}`,
    args,
  );
  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  const micros = atCol === 'a.published_at' ? 'published_us' : 'created_us';
  return {
    rows: page.map(listRow),
    next: rows.length > filters.limit && last ? encodeCursor(String(last[micros]), last.public_id) : null,
  };
};

export const analyses = () => (hasDatabase() ? pgStore : memoryStore);
