import { randomBytes } from 'node:crypto';

import { hasDatabase, pool, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Community (W5.2-W5.4): suggestions with their staff states and votes, the
 * site's reviews, and the moderation both share: reports from anyone, and
 * staff hiding or unhiding an item with a reason.
 *
 * Every staff action goes to `moderation_log`, the table the queue's
 * moderation (W3.18) writes, with `target_kind` saying what it acted on and,
 * for a state change, the state before and after. A suggestion's state
 * changes are public (who, when, from, to, why); hides and unhides are read by
 * staff only.
 *
 * Suggestions and reviews are named outside the API by `public_id`, 128
 * random bits in hex like an analysis, so a hidden one cannot be found by
 * counting.
 *
 * Without a database (development only) the rows live in this process's
 * memory, as accounts and analyses do.
 */

export const newPublicId = () => randomBytes(16).toString('hex');

/**
 * A suggestion's life. `open` is where it starts; staff move it along, to any
 * state (a rejected one can be opened again, a planned one can go back to
 * review), but a rejection always says why.
 */
export const STATES = ['open', 'review', 'planned', 'progress', 'done', 'rejected'];

export const SORTS = ['votes', 'new'];
/**
 * What can be reported and hidden. `comment` is a comment on a published
 * timing (W6, services/social.service.js): its rows live there, but its
 * reports, hides and log are this moderation's, so staff have one place.
 */
export const KINDS = ['suggestion', 'review', 'comment'];

/** Anonymous reviews per hashed address per UTC day. */
export const ANON_REVIEWS_PER_DAY = 2;
/** An anonymous review counts this much in the average (W5.3: they weigh less, and the page says so). */
export const ANON_WEIGHT = 0.5;
export const LOG_LIMIT = 50;
export const PAGE_MAX = 50;

const startOfUtcDay = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** The average and the 1-5 distribution, anonymous reviews weighted by ANON_WEIGHT. */
export const summarize = (rows) => {
  const distribution = [0, 0, 0, 0, 0];
  let weighted = 0;
  let weights = 0;
  let anonymous = 0;
  for (const { stars, anonymous: anon } of rows) {
    distribution[stars - 1] += 1;
    const w = anon ? ANON_WEIGHT : 1;
    weighted += stars * w;
    weights += w;
    if (anon) anonymous += 1;
  }
  return {
    count: rows.length,
    anonymous,
    average: weights ? Math.round((weighted / weights) * 100) / 100 : null,
    distribution,
  };
};

// ── In memory ───────────────────────────────────────────────────────────────

const memory = { suggestions: new Map(), reviews: new Map(), reports: [], log: [] };

/**
 * Each kind's rows in memory, by public id: what a hide flips. Another
 * store's kind registers its own map (the social store's comments), so this
 * module never imports it.
 */
const memoryKinds = { suggestion: memory.suggestions, review: memory.reviews };
export const registerMemoryKind = (kind, map) => {
  memoryKinds[kind] = map;
};

/** For the social store's memory twin: the suggestions, to see whether an author had one accepted. */
export const memorySuggestions = () => memory.suggestions.values();

/** For the tests: start from nothing. */
export const resetMemory = () => {
  memory.suggestions.clear();
  memory.reviews.clear();
  memory.reports.length = 0;
  memory.log.length = 0;
};

const openReports = (kind, publicId) =>
  memory.reports.filter((r) => r.kind === kind && r.publicId === publicId && r.state === 'open').length;

const memorySuggestion = (s, viewerId) =>
  s && {
    publicId: s.publicId,
    accountId: s.accountId,
    author: s.author,
    title: s.title,
    body: s.body,
    state: s.state,
    stateReason: s.stateReason,
    hidden: s.hidden,
    hiddenReason: s.hiddenReason,
    votes: s.votes.size,
    voted: Boolean(viewerId && s.votes.has(viewerId)),
    reports: openReports('suggestion', s.publicId),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };

const memoryReview = (r) =>
  r && {
    publicId: r.publicId,
    accountId: r.accountId,
    author: r.author,
    stars: r.stars,
    body: r.body,
    hidden: r.hidden,
    hiddenReason: r.hiddenReason,
    reports: openReports('review', r.publicId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };

const memoryLog = (entry) =>
  memory.log.push({ fromState: null, toState: null, reason: null, ...entry, createdAt: new Date() });

const byNewest = (a, b) => b.createdAt - a.createdAt || (b.seq ?? 0) - (a.seq ?? 0);
let seq = 0;

const memoryStore = {
  async createSuggestion({ publicId, accountId, author, title, body }) {
    const now = new Date();
    const s = {
      publicId, accountId, author, title, body, state: 'open', stateReason: null,
      hidden: false, hiddenReason: null, votes: new Set(), createdAt: now, updatedAt: now, seq: ++seq,
    };
    memory.suggestions.set(publicId, s);
    return memorySuggestion(s, accountId);
  },

  async listSuggestions({ sort = 'votes', state = null, viewerId = null, staff = false, limit = PAGE_MAX, offset = 0 }) {
    const rows = [...memory.suggestions.values()].filter((s) => (staff || !s.hidden) && (!state || s.state === state));
    rows.sort(sort === 'new' ? byNewest : (a, b) => b.votes.size - a.votes.size || byNewest(a, b));
    return { total: rows.length, items: rows.slice(offset, offset + limit).map((s) => memorySuggestion(s, viewerId)) };
  },

  async getSuggestion(publicId, { viewerId = null } = {}) {
    return memorySuggestion(memory.suggestions.get(publicId), viewerId) ?? null;
  },

  async setState(publicId, { to, reason, by }) {
    const s = memory.suggestions.get(publicId);
    if (!s) return null;
    const from = s.state;
    Object.assign(s, { state: to, stateReason: reason ?? null, updatedAt: new Date() });
    memoryLog({ action: 'state', kind: 'suggestion', ref: publicId, fromState: from, toState: to, reason, ...by });
    return { from, to };
  },

  async history(publicId) {
    return memory.log.filter((e) => e.kind === 'suggestion' && e.ref === publicId).slice().reverse();
  },

  async vote(publicId, accountId, on) {
    const s = memory.suggestions.get(publicId);
    if (!s) return null;
    if (on) s.votes.add(accountId);
    else s.votes.delete(accountId);
    return s.votes.size;
  },

  async setHidden(kind, publicId, { hidden, by }) {
    const item = memoryKinds[kind]?.get(publicId);
    if (!item) return null;
    if (item.hidden === hidden) return false;
    Object.assign(item, { hidden, hiddenReason: hidden ? (by.reason ?? null) : null });
    memoryLog({ action: hidden ? 'hide' : 'unhide', kind, ref: publicId, ...by });
    // A decision closes the reports that asked for one.
    for (const r of memory.reports) if (r.kind === kind && r.publicId === publicId && r.state === 'open') r.state = 'resolved';
    return true;
  },

  async report(kind, publicId, { accountId, ipHash, reason }) {
    const reporter = accountId ?? `ip:${ipHash}`;
    const open = memory.reports.find((r) => r.kind === kind && r.publicId === publicId && r.reporter === reporter && r.state === 'open');
    if (open) return false;
    memory.reports.push({ kind, publicId, reporter, accountId, reason, state: 'open', createdAt: new Date() });
    return true;
  },

  async upsertOwnReview({ publicId, accountId, author, stars, body }) {
    const now = new Date();
    const existing = [...memory.reviews.values()].find((r) => r.accountId === accountId);
    if (existing) {
      // An edit keeps a moderator's hide: editing must not be a way out of it.
      Object.assign(existing, { stars, body, author, updatedAt: now });
      return { review: memoryReview(existing), created: false };
    }
    const r = { publicId, accountId, author, ipHash: null, stars, body, hidden: false, hiddenReason: null, createdAt: now, updatedAt: now, seq: ++seq };
    memory.reviews.set(publicId, r);
    return { review: memoryReview(r), created: true };
  },

  async createAnonReview({ publicId, ipHash, stars, body }) {
    const since = startOfUtcDay();
    const today = [...memory.reviews.values()].filter((r) => !r.accountId && r.ipHash === ipHash && r.createdAt >= since).length;
    if (today >= ANON_REVIEWS_PER_DAY) throw anonLimit();
    const now = new Date();
    const r = { publicId, accountId: null, author: null, ipHash, stars, body, hidden: false, hiddenReason: null, createdAt: now, updatedAt: now, seq: ++seq };
    memory.reviews.set(publicId, r);
    return memoryReview(r);
  },

  async ownReview(accountId) {
    return memoryReview([...memory.reviews.values()].find((r) => r.accountId === accountId)) ?? null;
  },

  async deleteOwnReview(accountId) {
    const r = [...memory.reviews.values()].find((x) => x.accountId === accountId);
    if (!r) return false;
    memory.reviews.delete(r.publicId);
    return true;
  },

  async getReview(publicId) {
    return memoryReview(memory.reviews.get(publicId)) ?? null;
  },

  async listReviews({ staff = false, limit = PAGE_MAX, offset = 0 }) {
    const rows = [...memory.reviews.values()].filter((r) => staff || !r.hidden).sort(byNewest);
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(memoryReview) };
  },

  async reviewStats() {
    return summarize([...memory.reviews.values()].filter((r) => !r.hidden).map((r) => ({ stars: r.stars, anonymous: !r.accountId })));
  },

  async moderationLog(limit = LOG_LIMIT) {
    return memory.log.slice(-limit).reverse();
  },

  async openReportList(limit = LOG_LIMIT) {
    const groups = new Map();
    for (const r of memory.reports) {
      if (r.state !== 'open') continue;
      const key = `${r.kind}:${r.publicId}`;
      const g = groups.get(key) ?? { kind: r.kind, ref: r.publicId, count: 0, reasons: [], latestAt: r.createdAt };
      g.count += 1;
      if (g.reasons.length < 5) g.reasons.push(r.reason);
      if (r.createdAt > g.latestAt) g.latestAt = r.createdAt;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt).slice(0, limit);
  },
};

const anonLimit = () =>
  new HttpError(
    429,
    `Without an account you can leave ${ANON_REVIEWS_PER_DAY} reviews a day. Sign in to leave one that you can edit later.`,
    'REVIEW_LIMIT',
    { limit: ANON_REVIEWS_PER_DAY },
  );

// ── PostgreSQL ──────────────────────────────────────────────────────────────

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

/** One `moderation_log` row for a community action, in the caller's transaction. */
const pgLog = (client, { action, kind, ref, fromState = null, toState = null, accountId, moderator, reason }) =>
  client.query(
    `INSERT INTO moderation_log (account_id, moderator, action, target_kind, target_ref, from_state, to_state, reason)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [accountId, moderator, action, kind, ref, fromState, toState, reason ?? null],
  );

const author = (r) =>
  r.username ? { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null;

const SUGGESTION = `
  SELECT s.id, s.public_id, s.account_id, s.title, s.body, s.state, s.state_reason, s.hidden, s.hidden_reason,
         s.created_at, s.updated_at, acc.username, acc.display_name, acc.avatar_url,
         (SELECT count(*) FROM suggestion_votes v WHERE v.suggestion_id = s.id)::int AS votes,
         EXISTS (SELECT 1 FROM suggestion_votes v WHERE v.suggestion_id = s.id AND v.account_id = $1::uuid) AS voted,
         (SELECT count(*) FROM reports r
           WHERE r.target_kind = 'suggestion' AND r.target_id = s.public_id AND r.state = 'open')::int AS reports
    FROM suggestions s
    LEFT JOIN accounts acc ON acc.id = s.account_id`;

const fromSuggestion = (r) =>
  r && {
    publicId: r.public_id,
    accountId: r.account_id,
    author: author(r),
    title: r.title,
    body: r.body,
    state: r.state,
    stateReason: r.state_reason,
    hidden: r.hidden,
    hiddenReason: r.hidden_reason,
    votes: r.votes,
    voted: r.voted,
    reports: r.reports,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const REVIEW = `
  SELECT rv.public_id, rv.account_id, rv.stars, rv.body, rv.hidden, rv.hidden_reason, rv.created_at, rv.updated_at,
         acc.username, acc.display_name, acc.avatar_url,
         (SELECT count(*) FROM reports r
           WHERE r.target_kind = 'review' AND r.target_id = rv.public_id AND r.state = 'open')::int AS reports
    FROM reviews rv
    LEFT JOIN accounts acc ON acc.id = rv.account_id`;

const fromReview = (r) =>
  r && {
    publicId: r.public_id,
    accountId: r.account_id,
    author: author(r),
    stars: r.stars,
    body: r.body,
    hidden: r.hidden,
    hiddenReason: r.hidden_reason,
    reports: r.reports,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const fromLog = (r) => ({
  action: r.action,
  kind: r.target_kind,
  ref: r.target_ref,
  fromState: r.from_state,
  toState: r.to_state,
  moderator: r.moderator,
  accountId: r.account_id,
  reason: r.reason,
  createdAt: r.created_at,
});

const TABLE = { suggestion: 'suggestions', review: 'reviews', comment: 'timing_comments' };

const pgStore = {
  async createSuggestion({ publicId, accountId, title, body }) {
    await query('INSERT INTO suggestions (public_id, account_id, title, body) VALUES ($1, $2, $3, $4)', [publicId, accountId, title, body]);
    return this.getSuggestion(publicId, { viewerId: accountId });
  },

  async listSuggestions({ sort = 'votes', state = null, viewerId = null, staff = false, limit = PAGE_MAX, offset = 0 }) {
    // Both orders come from this fixed list, never from the request.
    const order = sort === 'new' ? 'created_at DESC, id DESC' : 'votes DESC, created_at DESC, id DESC';
    const { rows } = await query(
      `SELECT *, count(*) OVER () AS total FROM (${SUGGESTION}
        WHERE ($2::boolean OR NOT s.hidden) AND ($3::text IS NULL OR s.state = $3)) s
        ORDER BY ${order}
        LIMIT $4 OFFSET $5`,
      [viewerId, staff, state, limit, offset],
    );
    return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(fromSuggestion) };
  },

  async getSuggestion(publicId, { viewerId = null } = {}) {
    const { rows } = await query(`${SUGGESTION} WHERE s.public_id = $2`, [viewerId, publicId]);
    return fromSuggestion(rows[0]) ?? null;
  },

  async setState(publicId, { to, reason, by }) {
    return transaction(async (client) => {
      const { rows: [row] } = await client.query('SELECT state FROM suggestions WHERE public_id = $1 FOR UPDATE', [publicId]);
      if (!row) return null;
      await client.query(
        'UPDATE suggestions SET state = $2, state_reason = $3, updated_at = now() WHERE public_id = $1',
        [publicId, to, reason ?? null],
      );
      await pgLog(client, { action: 'state', kind: 'suggestion', ref: publicId, fromState: row.state, toState: to, reason, ...by });
      return { from: row.state, to };
    });
  },

  async history(publicId) {
    const { rows } = await query(
      `SELECT action, target_kind, target_ref, from_state, to_state, moderator, account_id, reason, created_at
         FROM moderation_log WHERE target_kind = 'suggestion' AND target_ref = $1 ORDER BY id DESC LIMIT 200`,
      [publicId],
    );
    return rows.map(fromLog);
  },

  async vote(publicId, accountId, on) {
    const { rows: [s] } = await query('SELECT id FROM suggestions WHERE public_id = $1', [publicId]);
    if (!s) return null;
    // The primary key is the one-vote rule; a second vote is a no-op, not an error.
    if (on) {
      await query('INSERT INTO suggestion_votes (suggestion_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [s.id, accountId]);
    } else {
      await query('DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND account_id = $2', [s.id, accountId]);
    }
    const { rows: [n] } = await query('SELECT count(*)::int AS votes FROM suggestion_votes WHERE suggestion_id = $1', [s.id]);
    return n.votes;
  },

  async setHidden(kind, publicId, { hidden, by }) {
    const table = TABLE[kind];
    return transaction(async (client) => {
      const { rows: [row] } = await client.query(`SELECT hidden FROM ${table} WHERE public_id = $1 FOR UPDATE`, [publicId]);
      if (!row) return null;
      if (row.hidden === hidden) return false;
      await client.query(`UPDATE ${table} SET hidden = $2, hidden_reason = $3 WHERE public_id = $1`, [
        publicId, hidden, hidden ? (by.reason ?? null) : null,
      ]);
      await pgLog(client, { action: hidden ? 'hide' : 'unhide', kind, ref: publicId, ...by });
      await client.query(
        "UPDATE reports SET state = 'resolved' WHERE target_kind = $1 AND target_id = $2 AND state = 'open'",
        [kind, publicId],
      );
      return true;
    });
  },

  async report(kind, publicId, { accountId, ipHash, reason }) {
    // reports_once_idx: one open report per reporter and item; a second is dropped.
    const { rowCount } = await query(
      `INSERT INTO reports (target_kind, target_id, account_id, ip_hash, reason)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [kind, publicId, accountId, accountId ? null : ipHash, reason],
    );
    return rowCount === 1;
  },

  async upsertOwnReview({ publicId, accountId, stars, body }) {
    // An edit keeps a moderator's hide: editing must not be a way out of it.
    const { rows: [row] } = await query(
      `INSERT INTO reviews (public_id, account_id, stars, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) WHERE account_id IS NOT NULL
       DO UPDATE SET stars = EXCLUDED.stars, body = EXCLUDED.body, updated_at = now()
       RETURNING public_id, (xmax = 0) AS created`,
      [publicId, accountId, stars, body],
    );
    return { review: await this.getReview(row.public_id), created: row.created };
  },

  async createAnonReview({ publicId, ipHash, stars, body }) {
    return transaction(async (client) => {
      // One address's reviews are counted and inserted one request at a time,
      // so two sent at once cannot both pass the daily count.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`review:${ipHash}`]);
      const { rows: [n] } = await client.query(
        `SELECT count(*)::int AS today FROM reviews
          WHERE account_id IS NULL AND ip_hash = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [ipHash],
      );
      if (n.today >= ANON_REVIEWS_PER_DAY) throw anonLimit();
      await client.query('INSERT INTO reviews (public_id, ip_hash, stars, body) VALUES ($1, $2, $3, $4)', [publicId, ipHash, stars, body]);
      const { rows } = await client.query(`${REVIEW} WHERE rv.public_id = $1`, [publicId]);
      return fromReview(rows[0]);
    });
  },

  async ownReview(accountId) {
    const { rows } = await query(`${REVIEW} WHERE rv.account_id = $1`, [accountId]);
    return fromReview(rows[0]) ?? null;
  },

  async deleteOwnReview(accountId) {
    const { rowCount } = await query('DELETE FROM reviews WHERE account_id = $1', [accountId]);
    return rowCount > 0;
  },

  async getReview(publicId) {
    const { rows } = await query(`${REVIEW} WHERE rv.public_id = $1`, [publicId]);
    return fromReview(rows[0]) ?? null;
  },

  async listReviews({ staff = false, limit = PAGE_MAX, offset = 0 }) {
    const { rows } = await query(
      `SELECT *, count(*) OVER () AS total FROM (${REVIEW} WHERE ($1::boolean OR NOT rv.hidden)) rv
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [staff, limit, offset],
    );
    return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(fromReview) };
  },

  async reviewStats() {
    const { rows } = await query(
      `SELECT stars, (account_id IS NULL) AS anonymous, count(*)::int AS n
         FROM reviews WHERE NOT hidden GROUP BY stars, anonymous`,
    );
    return summarize(rows.flatMap((r) => Array.from({ length: r.n }, () => ({ stars: r.stars, anonymous: r.anonymous }))));
  },

  async moderationLog(limit = LOG_LIMIT) {
    const { rows } = await query(
      `SELECT action, target_kind, target_ref, from_state, to_state, moderator, account_id, reason, created_at
         FROM moderation_log WHERE target_kind = ANY($2::text[]) ORDER BY id DESC LIMIT $1`,
      [limit, KINDS],
    );
    return rows.map(fromLog);
  },

  async openReportList(limit = LOG_LIMIT) {
    const { rows } = await query(
      `SELECT target_kind, target_id, count(*)::int AS count, max(created_at) AS latest_at,
              (array_agg(reason ORDER BY created_at DESC))[1:5] AS reasons
         FROM reports WHERE state = 'open' AND target_kind = ANY($2::text[])
        GROUP BY target_kind, target_id ORDER BY latest_at DESC LIMIT $1`,
      [limit, KINDS],
    );
    return rows.map((r) => ({ kind: r.target_kind, ref: r.target_id, count: r.count, reasons: r.reasons, latestAt: r.latest_at }));
  },
};

export const community = () => (hasDatabase() ? pgStore : memoryStore);
