import { hasDatabase, query } from '../config/database.js';
import { ACCEPTED_STATES, OFFSET_MAX } from '../utils/social.js';
import { bucketOf, BPM_EDGES } from '../utils/stats.js';
import { isVariable, mainBpm } from '../utils/timings.js';
import { isMapper } from '../utils/votes.js';
import { BPM, memoryAnalyses, PUBLISHED, VARIABLE } from './analysis.service.js';
import { memoryReviews, memorySuggestions } from './community.service.js';
import { memoryUses } from './social.service.js';
import { memoryVotes } from './vote.service.js';

/**
 * What a profile counts beyond its totals (2026-10-28): the BPM spread and
 * the share of variable tempo of the published timings, the dates the badges
 * were earned, and the public activity. Both stores, as everywhere.
 *
 * Only what is public goes in: published timings (a private upload, or one
 * never published, is not even a number here), suggestions and reviews staff
 * have not hidden, uses of the person's own published timings (counted, never
 * naming who used them), and the "on time" votes a mapper casts, which a
 * timing's page already names (W13.16). Every date is derived from those
 * rows when asked, never stored: unpublishing a timing moves a badge's date
 * the way it moves the count.
 */

/** The most published timings the stats read. Far beyond anyone's catalogue; a bound, not a page. */
export const STATS_ROWS = 5000;

/** Activity rows per page. */
export const ACTIVITY_PAGE = 20;

export const ACTIVITY_KINDS = ['published', 'used', 'verified', 'review', 'suggestion'];

const publishedRow = (a) => a.publishedAt && !a.deletedAt && a.status === 'done';

const trim = (id) => String(id).trim();

/** The account's published timings, oldest first: { id, at, bpm, variable }. */
const publishedOf = async (accountId) => {
  if (!hasDatabase()) {
    return [...memoryAnalyses()]
      .filter((a) => a.accountId === accountId && publishedRow(a))
      .map((a) => ({ id: a.publicId, at: new Date(a.publishedAt), bpm: mainBpm(a.result), variable: isVariable(a.result) }))
      .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
      .slice(0, STATS_ROWS);
  }
  const { rows } = await query(
    `SELECT a.public_id, a.published_at, ${BPM} AS bpm, ${VARIABLE} AS variable
       FROM analyses a WHERE a.account_id = $1 AND ${PUBLISHED}
      ORDER BY a.published_at, a.public_id LIMIT $2`,
    [accountId, STATS_ROWS],
  );
  return rows.map((r) => ({ id: trim(r.public_id), at: new Date(r.published_at), bpm: r.bpm === null ? null : Number(r.bpm), variable: Boolean(r.variable) }));
};

/** When another account first marked one of the person's published timings used, or null. */
const firstUseAt = async (accountId, publishedIds) => {
  if (!hasDatabase()) {
    let first = null;
    for (const id of publishedIds) {
      for (const [by, use] of memoryUses().get(id) ?? []) {
        if (by !== accountId && (!first || use.at < first)) first = use.at;
      }
    }
    return first;
  }
  const { rows: [r] } = await query(
    `SELECT min(t.used_at) AS at FROM timing_uses t JOIN analyses a ON a.id = t.analysis_id
      WHERE a.account_id = $1 AND ${PUBLISHED} AND t.account_id IS NOT NULL AND t.account_id <> $1`,
    [accountId],
  );
  return r?.at ?? null;
};

/**
 * When one of their suggestions first reached an accepted state, or null.
 * Read as the earliest `updated_at` among their accepted ones: a suggestion
 * edited later in its accepted life dates the badge later than it was earned,
 * never earlier. Close enough for a badge, and said here.
 */
const firstAcceptedAt = async (accountId) => {
  if (!hasDatabase()) {
    const dates = [...memorySuggestions()]
      .filter((s) => s.accountId === accountId && !s.hidden && ACCEPTED_STATES.includes(s.state))
      .map((s) => s.updatedAt);
    return dates.length ? new Date(Math.min(...dates)) : null;
  }
  const { rows: [r] } = await query(
    'SELECT min(updated_at) AS at FROM suggestions WHERE account_id = $1 AND NOT hidden AND state = ANY($2)',
    [accountId, ACCEPTED_STATES],
  );
  return r?.at ?? null;
};

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * The stats block and the badges' dates of `account` (a row), given the
 * badges `badgesOf` already decided. `ranked-mapper` is dated by the osu!
 * link, which is when the site learned of the ranked maps.
 */
export const profileExtras = async (account, badges) => {
  const rows = await publishedOf(account.id);
  const counts = new Array(BPM_EDGES.length + 1).fill(0);
  let single = 0;
  let variable = 0;
  for (const r of rows) {
    if (r.bpm !== null && Number.isFinite(r.bpm)) counts[bucketOf(r.bpm)] += 1;
    if (r.variable) variable += 1;
    else single += 1;
  }
  const dates = {};
  const nth = (n) => iso(rows[n - 1]?.at);
  if (badges.includes('first-timing')) dates['first-timing'] = nth(1);
  if (badges.includes('published-10')) dates['published-10'] = nth(10);
  if (badges.includes('published-50')) dates['published-50'] = nth(50);
  if (badges.includes('used-by-others')) dates['used-by-others'] = iso(await firstUseAt(account.id, rows.map((r) => r.id)));
  if (badges.includes('suggestion-accepted')) dates['suggestion-accepted'] = iso(await firstAcceptedAt(account.id));
  if (badges.includes('ranked-mapper')) dates['ranked-mapper'] = iso(account.osu_linked_at);
  return {
    stats: {
      bpm: {
        buckets: counts.map((count, i) => ({
          from: i === 0 ? null : BPM_EDGES[i - 1],
          to: i === BPM_EDGES.length ? null : BPM_EDGES[i],
          count,
        })),
      },
      tempo: { single, variable },
    },
    badgeDates: dates,
  };
};

// ── Activity ────────────────────────────────────────────────────────────────

/**
 * One page of the account's public activity, newest first: rows of
 * { kind, at, ref, stars?, title?, state? } where `ref` is a timing's public
 * id (published, used, verified), a review's or a suggestion's. Paged by
 * offset, as the orders by numbers are (utils/social.js OFFSET_MAX bounds it).
 */
export const activity = async (account, { offset = 0, limit = ACTIVITY_PAGE } = {}) => {
  const mapper = isMapper(account);
  if (!hasDatabase()) {
    const events = [];
    const mine = [...memoryAnalyses()].filter((a) => a.accountId === account.id && publishedRow(a));
    for (const a of mine) {
      events.push({ kind: 'published', at: new Date(a.publishedAt), ref: a.publicId });
      for (const [by, use] of memoryUses().get(a.publicId) ?? []) {
        if (by && by !== account.id) events.push({ kind: 'used', at: new Date(use.at), ref: a.publicId });
      }
    }
    if (mapper) {
      const live = new Map([...memoryAnalyses()].filter(publishedRow).map((a) => [a.publicId, a]));
      for (const [timingId, byAccount] of memoryVotes()) {
        const v = byAccount.get(account.id);
        if (v && v.verdict === 'on' && live.has(timingId)) events.push({ kind: 'verified', at: new Date(v.createdAt), ref: timingId });
      }
    }
    for (const r of memoryReviews()) {
      if (r.accountId === account.id && !r.hidden) events.push({ kind: 'review', at: new Date(r.createdAt), ref: r.publicId, stars: r.stars });
    }
    for (const s of memorySuggestions()) {
      if (s.accountId === account.id && !s.hidden && ACCEPTED_STATES.includes(s.state)) {
        events.push({ kind: 'suggestion', at: new Date(s.updatedAt), ref: s.publicId, title: s.title, state: s.state });
      }
    }
    events.sort((x, y) => y.at - x.at || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.ref < y.ref ? -1 : 1));
    return { rows: events.slice(offset, offset + limit), more: events.length > offset + limit };
  }
  const { rows } = await query(
    `SELECT kind, at, ref, stars, title, state FROM (
       SELECT 'published' AS kind, a.published_at AS at, a.public_id::text AS ref, NULL::smallint AS stars, NULL::text AS title, NULL::text AS state
         FROM analyses a WHERE a.account_id = $1 AND ${PUBLISHED}
       UNION ALL
       SELECT 'used', t.used_at, a.public_id::text, NULL, NULL, NULL
         FROM timing_uses t JOIN analyses a ON a.id = t.analysis_id
        WHERE a.account_id = $1 AND ${PUBLISHED} AND t.account_id IS NOT NULL AND t.account_id <> $1
       UNION ALL
       SELECT 'verified', v.created_at, a.public_id::text, NULL, NULL, NULL
         FROM timing_votes v JOIN analyses a ON a.id = v.analysis_id
        WHERE v.account_id = $1 AND v.verdict = 'on' AND $2::boolean AND ${PUBLISHED}
       UNION ALL
       SELECT 'review', r.created_at, r.public_id, r.stars, NULL, NULL
         FROM reviews r WHERE r.account_id = $1 AND NOT r.hidden
       UNION ALL
       SELECT 'suggestion', s.updated_at, s.public_id, NULL, s.title, s.state
         FROM suggestions s WHERE s.account_id = $1 AND NOT s.hidden AND s.state = ANY($3)
     ) e
     ORDER BY at DESC, kind, ref
     LIMIT $4 OFFSET $5`,
    [account.id, mapper, ACCEPTED_STATES, limit + 1, Math.min(offset, OFFSET_MAX)],
  );
  return {
    rows: rows.slice(0, limit).map((r) => ({
      kind: r.kind, at: new Date(r.at), ref: trim(r.ref),
      ...(r.stars !== null ? { stars: Number(r.stars) } : {}),
      ...(r.title !== null ? { title: r.title, state: r.state } : {}),
    })),
    more: rows.length > limit,
  };
};
