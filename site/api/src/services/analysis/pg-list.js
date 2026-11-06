/** Analyses as PostgreSQL rows: the SELECT and its row shape, the shared columns, filters and keyset pages. */
import { query } from '../../config/database.js';
import { encodeCursor, likePattern } from '../../utils/timings.js';
import { engineHash } from './policy.js';

export const SELECT = `
  SELECT a.public_id, a.account_id, a.anon_hash, a.ip_hash, a.filename, a.size_bytes, a.status, a.stage,
         a.progress, a.error, a.result, a.engine_hash, a.app_version, a.engine_model, a.created_at, a.finished_at,
         a.private, a.tag_title, a.tag_artist, a.published_at, a.deleted_at,
         a.mode, a.options, a.options_key, a.audio_seconds, r.public_id AS reanalysis_of,
         c.public_id AS cached_from, s.audio_sha1, j.id AS job_id, j.state AS job_state
    FROM analyses a
    JOIN songs s ON s.id = a.song_id
    LEFT JOIN jobs j ON j.analysis_id = a.id
    LEFT JOIN analyses c ON c.id = a.cached_from
    LEFT JOIN analyses r ON r.id = a.reanalysis_of`;

export const fromRow = (r) =>
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
    appVersion: r.app_version ?? null,
    engineModel: r.engine_model ?? null,
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

/**
 * A time as whole microseconds since the epoch, exactly: whole seconds and the
 * microseconds within them apart, since one double holding both can be off by one.
 */
const MICROS = (col) =>
  `(extract(epoch FROM date_trunc('second', ${col}))::bigint * 1000000 + extract(microseconds FROM ${col})::bigint % 1000000)`;

export const PUBLISHED = "a.published_at IS NOT NULL AND a.deleted_at IS NULL AND a.status = 'done'";
// What a timing's page may show: a published one, or an anonymous upload that
// was not kept private, which has nobody signed in to publish it and which the
// queue links to once it is done.
export const VIEWABLE = `a.deleted_at IS NULL AND a.status = 'done'
  AND (a.published_at IS NOT NULL OR (NOT a.private AND a.account_id IS NULL))`;

/**
 * What the recent list, a public page and the history read. No sha1 and no
 * hashes: a list never needs them, so a list cannot leak them.
 */
export const LIST_COLS = `a.public_id, a.account_id, a.filename, a.status, a.result, a.created_at, a.published_at,
                   a.private, a.tag_title, a.tag_artist, a.cached_from IS NOT NULL AS cached,
                   ${MICROS('a.created_at')} AS created_us, ${MICROS('a.published_at')} AS published_us,
                   u.username, u.display_name, u.avatar_url`;

export const listRow = (r) => ({
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
export const VARIABLE = `(SELECT count(DISTINCT round((l->>'bpm')::numeric * 100)) FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(a.result->'red_lines') = 'array' THEN a.result->'red_lines' ELSE '[]'::jsonb END) l) > 1`;
export const BPM = `(CASE WHEN jsonb_typeof(a.result->'global_bpm') = 'number' THEN (a.result->>'global_bpm')::float8 END)`;

/**
 * One page under `where` (with its own `params`), newest first by `atCol`
 * and then public id, after the cursor, filtered as utils/timings.js
 * `matches` filters. One row more than the page is read, to know whether
 * there is a next one.
 */
export const pgPage = async (where, params, atCol, filters) => {
  const args = [...params];
  const arg = (value) => {
    args.push(value);
    return `$${args.length}`;
  };
  const clauses = [where, ...filterClauses(filters, arg)];
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

/**
 * The SQL of utils/timings.js `matches`, one clause per filter that is set,
 * on `analyses a`; `arg(value)` adds a parameter and returns its `$n`. Also
 * what the social store's orders by stars and uses filter with
 * (services/social.service.js), so the two lists filter alike.
 */
export const filterClauses = (filters, arg) => {
  const clauses = [];
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
  if (filters.accountId) clauses.push(`a.account_id = ${arg(filters.accountId)}::uuid`);
  return clauses;
};
