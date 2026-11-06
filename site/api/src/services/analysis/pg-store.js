/** The queue and its rows in PostgreSQL: `jobs` claimed with FOR UPDATE SKIP LOCKED. */
import { pool, query } from '../../config/database.js';
import { BPM_EDGES, STATS_DAYS } from '../../utils/stats.js';
import {
  BPM,
  fromRow,
  LIST_COLS,
  listRow,
  pgPage,
  PUBLISHED,
  SELECT,
  VARIABLE,
  VIEWABLE,
} from './pg-list.js';
import {
  confidenceOf,
  engineHash,
  FAILURE_DAYS,
  FAILURE_LIMIT,
  LIVE_LIMIT,
  MAX_ATTEMPTS,
  MODERATION_LOG_LIMIT,
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

export const pgStore = {
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
                                 private, tag_title, tag_artist, mode, options, options_key, audio_seconds, reanalysis_of,
                                 app_version, engine_model)
           SELECT $1, $2, $3, $4, $5, $6, $7, c.engine, c.engine_hash, c.result, c.confidence, c.status, 1, now(), c.id,
                  $9, $10, $11, $12, $13, $14, $15, ${linked}, c.app_version, c.engine_model
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
                             options_key = coalesce($8, options_key),
                             app_version = $9, engine_model = $10
          WHERE id = $1`,
        [held.analysis_id, statusOf(result), result, result.engine_hash, confidenceOf(result),
          asked?.mode ?? null, asked && Object.keys(asked.options).length ? asked.options : null, asked?.key ?? null,
          versionOf(result).appVersion, versionOf(result).engineModel],
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

  async recentFailures(limit = FAILURE_LIMIT) {
    const { rows } = await query(
      `SELECT public_id, error, mode, audio_seconds, finished_at FROM analyses
        WHERE status = 'failed' AND finished_at >= now() - make_interval(days => $2)
        ORDER BY finished_at DESC LIMIT $1`,
      [limit, FAILURE_DAYS],
    );
    return rows.map((r) => ({
      publicId: r.public_id.trim(), error: r.error, mode: r.mode ?? 'normal', audioSeconds: r.audio_seconds ?? null, finishedAt: r.finished_at,
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

  async getViewable(publicId) {
    const { rows } = await query(
      `SELECT ${LIST_COLS}, s.audio_sha1
         FROM analyses a
         JOIN songs s ON s.id = a.song_id
         LEFT JOIN accounts u ON u.id = a.account_id
        WHERE a.public_id = $1 AND ${VIEWABLE}`,
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

  async siblings(row, limit = SIBLINGS_LIMIT) {
    if (!row.accountId && !row.anonHash) return [];
    const { rows } = await query(
      `${SELECT}
        WHERE s.audio_sha1 = $1 AND a.deleted_at IS NULL
          AND ${row.accountId ? 'a.account_id = $2' : 'a.account_id IS NULL AND a.anon_hash = $2'}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3`,
      [row.sha1, row.accountId ?? row.anonHash, limit],
    );
    return rows.map(fromRow);
  },

  // ── Site statistics (W12.13) ──

  /**
   * One snapshot in one statement, so the totals, the histogram and the queue
   * are read at the same instant. Every sub-select returns aggregates only.
   * The engine's own runs are counted (`cached_from IS NULL`): a cache hit
   * re-serves a result already counted, and goes in `cached`.
   */
  async stats({ days = STATS_DAYS } = {}) {
    const OWN = 'a.deleted_at IS NULL AND a.cached_from IS NULL';
    const { rows: [row] } = await query(
      `SELECT
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done')::int AS done,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'refused')::int AS refused,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'failed')::int AS failed,
         (SELECT count(*) FROM analyses a
           WHERE a.deleted_at IS NULL AND a.cached_from IS NOT NULL AND a.status IN ('done', 'refused'))::int AS cached,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done' AND a.published_at IS NOT NULL)::int AS published,
         (SELECT count(DISTINCT a.song_id) FROM analyses a WHERE ${OWN} AND a.status = 'done')::int AS songs,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done' AND a.finished_at >= now() - interval '7 days')::int AS last7,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done' AND a.finished_at >= now() - interval '30 days')::int AS last30,
         (SELECT coalesce(json_agg(json_build_array(b, n)), '[]'::json)
            FROM (SELECT width_bucket(${BPM}, $2::float8[]) AS b, count(*)::int AS n
                    FROM analyses a WHERE ${OWN} AND a.status = 'done' AND ${BPM} IS NOT NULL
                   GROUP BY 1) h) AS buckets,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done' AND ${VARIABLE})::int AS variable,
         (SELECT count(*) FROM analyses a WHERE ${OWN} AND a.status = 'done' AND NOT ${VARIABLE})::int AS single,
         t.count AS timed, t.median_ms, t.p90_ms,
         (SELECT count(*) FROM jobs WHERE state = 'queued')::int AS queued,
         (SELECT count(*) FROM jobs WHERE state = 'running')::int AS running
       FROM (SELECT count(*)::int AS count,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.finished_at - a.created_at) * 1000) AS median_ms,
                    percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM a.finished_at - a.created_at) * 1000) AS p90_ms
               FROM analyses a
              WHERE ${OWN} AND a.status = 'done' AND a.finished_at >= now() - make_interval(days => $1)) t`,
      [days, BPM_EDGES],
    );
    const buckets = new Array(BPM_EDGES.length + 1).fill(0);
    for (const [b, n] of row.buckets ?? []) if (b >= 0 && b < buckets.length) buckets[b] = n;
    return {
      counts: {
        done: row.done, refused: row.refused, failed: row.failed, cached: row.cached, published: row.published, songs: row.songs,
      },
      buckets,
      tempo: { single: row.single, variable: row.variable },
      times: {
        count: row.timed,
        medianMs: row.median_ms === null ? null : Number(row.median_ms),
        p90Ms: row.p90_ms === null ? null : Number(row.p90_ms),
      },
      queue: { queued: row.queued, running: row.running },
      timed: { last7Days: row.last7, last30Days: row.last30 },
    };
  },
};
