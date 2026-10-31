import { hasDatabase, pool, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';
import {
  ACCEPTED_STATES,
  averageOf,
  COLLECTIONS_PER_ACCOUNT,
  COMMENTS_PAGE,
  ITEMS_PER_COLLECTION,
  MIN_RATINGS_TO_RANK,
  PRIOR_RATINGS,
  PRIOR_STARS,
  rankScore,
} from '../utils/social.js';
import { encodeOffset, matches } from '../utils/timings.js';
import { memoryAccounts } from './account.service.js';
import { filterClauses, LIST_COLS, listRow, memoryAnalyses, PUBLISHED } from './analysis.service.js';
import { memorySuggestions, registerMemoryKind } from './community.service.js';

/**
 * Social v2 on published timings (W5.6, W6, W13.15, W13.18): stars, "I used
 * this", comments, collections, and the numbers a profile is made of.
 *
 * A "timing" here is a published analysis, named by its public id as
 * /t/<id> names it. The tables are schema.sql's social tables, each pointed
 * at `analyses` by `analysis_id` (the schema says why). Only published rows
 * count anywhere: a rating, a use or a collection item on a timing its
 * uploader took back stays stored, unseen, and counts again if it comes back;
 * a deleted analysis takes them with it (ON DELETE CASCADE, or the memory
 * twin's filter on published rows).
 *
 * Nothing here returns an address hash, an anonymous cookie's hash or an
 * audio hash: people are their Mides public fields (`personOf`), timings are
 * `listRow`s, which carry neither.
 *
 * Without a database (development only) the rows live in this process's
 * memory, as the other stores' do.
 */

const publishedRow = (a) => a.publishedAt && !a.deletedAt && a.status === 'done';

const ratingSummary = (sum, count) => ({ average: averageOf(sum, count), count });

const person = (r) => (r?.username ? { username: r.username, displayName: r.display_name ?? null, avatarUrl: r.avatar_url ?? null } : null);

const tooMany = (what, limit) =>
  new HttpError(409, `At most ${limit} ${what}.`, 'LIMIT', { limit });

// ── In memory ───────────────────────────────────────────────────────────────

const memory = {
  /** timing id -> account id -> { stars, at } */
  ratings: new Map(),
  /** timing id -> account id -> { beatmapUrl, at, seq } */
  uses: new Map(),
  /** comment public id -> comment */
  comments: new Map(),
  /** collection public id -> collection, `items` timing id -> { at, seq } */
  collections: new Map(),
};
// Staff hide a comment through the community's moderation, which flips this map's rows.
registerMemoryKind('comment', memory.comments);

let seq = 0;

/** For the profile's memory twin (services/profile.service.js): timing id -> account id -> { at }. */
export const memoryUses = () => memory.uses;

/** For the tests: start from nothing. */
export const resetSocialMemory = () => {
  for (const map of Object.values(memory)) map.clear();
};

const memoryPublished = (id) => {
  for (const a of memoryAnalyses()) if (a.publicId === id) return publishedRow(a) ? a : null;
  return null;
};

const memoryAccount = (id) => (id ? memoryAccounts().get(id) ?? null : null);

const memoryStats = (id) => {
  const ratings = [...(memory.ratings.get(id)?.values() ?? [])];
  const sum = ratings.reduce((s, r) => s + r.stars, 0);
  return { ratingSum: sum, ratingCount: ratings.length, uses: memory.uses.get(id)?.size ?? 0 };
};

const statsView = ({ ratingSum, ratingCount, uses }) => ({ rating: ratingSummary(ratingSum, ratingCount), uses });

const memoryComment = (c) =>
  c && {
    publicId: c.publicId,
    timingId: c.timingId,
    timingPublished: Boolean(memoryPublished(c.timingId)),
    accountId: c.accountId,
    author: person(memoryAccount(c.accountId)),
    body: c.body,
    atMs: c.atMs,
    hidden: c.hidden,
    hiddenReason: c.hiddenReason,
    createdAt: c.createdAt,
  };

const memoryCollection = (c) =>
  c && {
    publicId: c.publicId,
    accountId: c.accountId,
    owner: person(memoryAccount(c.accountId)),
    name: c.name,
    isPublic: c.isPublic,
    count: [...c.items.keys()].filter((id) => memoryPublished(id)).length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };

const memoryStore = {
  async rate(timingId, accountId, stars) {
    const byAccount = memory.ratings.get(timingId) ?? new Map();
    memory.ratings.set(timingId, byAccount);
    if (stars === null) byAccount.delete(accountId);
    else byAccount.set(accountId, { stars, at: new Date() });
  },

  async ratingOf(timingId, viewerId) {
    const { ratingSum, ratingCount } = memoryStats(timingId);
    return { ...ratingSummary(ratingSum, ratingCount), mine: (viewerId && memory.ratings.get(timingId)?.get(viewerId)?.stars) || null };
  },

  async setUse(timingId, accountId, beatmapUrl) {
    const byAccount = memory.uses.get(timingId) ?? new Map();
    memory.uses.set(timingId, byAccount);
    const existing = byAccount.get(accountId);
    // Marking it again only changes the link: the first time is when it was used.
    byAccount.set(accountId, { beatmapUrl, at: existing?.at ?? new Date(), seq: existing?.seq ?? ++seq });
  },

  async removeUse(timingId, accountId) {
    return Boolean(memory.uses.get(timingId)?.delete(accountId));
  },

  async usesOf(timingId, viewerId, limit = 20) {
    const byAccount = memory.uses.get(timingId) ?? new Map();
    const mine = viewerId ? byAccount.get(viewerId) : null;
    const recent = [...byAccount.entries()]
      .sort(([, a], [, b]) => b.at - a.at || b.seq - a.seq)
      .slice(0, limit)
      .map(([accountId, u]) => ({ user: person(memoryAccount(accountId)), beatmapUrl: u.beatmapUrl ?? null, at: u.at }));
    return { count: byAccount.size, mine: mine ? { beatmapUrl: mine.beatmapUrl ?? null } : null, recent };
  },

  async statsFor(ids) {
    return new Map(ids.map((id) => [id, statsView(memoryStats(id))]));
  },

  async listRanked(filters) {
    const rows = [...memoryAnalyses()]
      .filter((a) => publishedRow(a) && matches(a, filters))
      .map((a) => ({ a, s: memoryStats(a.publicId) }))
      .filter(({ s }) => (filters.sort === 'rated' ? s.ratingCount >= MIN_RATINGS_TO_RANK : s.uses >= 1))
      .sort(({ a: x, s: p }, { a: y, s: q }) =>
        (filters.sort === 'rated'
          ? rankScore(q.ratingSum, q.ratingCount) - rankScore(p.ratingSum, p.ratingCount) || q.ratingCount - p.ratingCount
          : q.uses - p.uses) ||
        y.publishedAt - x.publishedAt ||
        (y.publicId > x.publicId ? 1 : -1),
      );
    const page = rows.slice(filters.offset, filters.offset + filters.limit);
    return {
      rows: page.map(({ a, s }) => ({ ...a, stats: statsView(s) })),
      next: rows.length > filters.offset + filters.limit ? encodeOffset(filters.offset + filters.limit) : null,
    };
  },

  async addComment({ publicId, timingId, accountId, body, atMs }) {
    const c = { publicId, timingId, accountId, body, atMs, hidden: false, hiddenReason: null, createdAt: new Date(), seq: ++seq };
    memory.comments.set(publicId, c);
    return memoryComment(c);
  },

  async listComments(timingId, { viewerId = null, staff = false, offset = 0, limit = COMMENTS_PAGE } = {}) {
    const rows = [...memory.comments.values()]
      .filter((c) => c.timingId === timingId && (!c.hidden || staff || (viewerId && c.accountId === viewerId)))
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(memoryComment) };
  },

  async getComment(publicId) {
    return memoryComment(memory.comments.get(publicId)) ?? null;
  },

  async deleteOwnComment(publicId, accountId) {
    const c = memory.comments.get(publicId);
    if (!c || c.accountId !== accountId) return false;
    return memory.comments.delete(publicId);
  },

  async createCollection({ publicId, accountId, name, isPublic }) {
    const own = [...memory.collections.values()].filter((c) => c.accountId === accountId).length;
    if (own >= COLLECTIONS_PER_ACCOUNT) throw tooMany('collections', COLLECTIONS_PER_ACCOUNT);
    const now = new Date();
    const c = { publicId, accountId, name, isPublic, items: new Map(), createdAt: now, updatedAt: now, seq: ++seq };
    memory.collections.set(publicId, c);
    return memoryCollection(c);
  },

  async ownCollections(accountId, { timingId = null } = {}) {
    return [...memory.collections.values()]
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq)
      .map((c) => ({ ...memoryCollection(c), has: Boolean(timingId && c.items.has(timingId)) }));
  },

  async publicCollectionsOf(accountId) {
    return (await this.ownCollections(accountId)).filter((c) => c.isPublic);
  },

  async getCollection(publicId) {
    return memoryCollection(memory.collections.get(publicId)) ?? null;
  },

  async updateCollection(publicId, { name, isPublic }) {
    const c = memory.collections.get(publicId);
    if (!c) return null;
    if (name !== undefined) c.name = name;
    if (isPublic !== undefined) c.isPublic = isPublic;
    c.updatedAt = new Date();
    return memoryCollection(c);
  },

  async deleteCollection(publicId) {
    return memory.collections.delete(publicId);
  },

  async addItem(publicId, timingId) {
    const c = memory.collections.get(publicId);
    if (!c) return null;
    if (c.items.has(timingId)) return 'exists';
    if (c.items.size >= ITEMS_PER_COLLECTION) throw tooMany('timings in a collection', ITEMS_PER_COLLECTION);
    c.items.set(timingId, { at: new Date(), seq: ++seq });
    c.updatedAt = new Date();
    return 'added';
  },

  async removeItem(publicId, timingId) {
    const c = memory.collections.get(publicId);
    if (!c || !c.items.delete(timingId)) return false;
    c.updatedAt = new Date();
    return true;
  },

  async collectionItems(publicId, { offset = 0, limit = 50 } = {}) {
    const c = memory.collections.get(publicId);
    if (!c) return { rows: [], next: null };
    const rows = [...c.items.entries()]
      .sort(([, a], [, b]) => b.at - a.at || b.seq - a.seq)
      .map(([id]) => memoryPublished(id))
      .filter(Boolean);
    return {
      rows: rows.slice(offset, offset + limit).map((a) => ({ ...a })),
      next: rows.length > offset + limit ? encodeOffset(offset + limit) : null,
    };
  },

  async profileStats(accountId) {
    const songs = new Set();
    let published = 0;
    let uses = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    for (const a of memoryAnalyses()) {
      if (a.accountId !== accountId) continue;
      if (a.status === 'done' && !a.deletedAt && !a.private) songs.add(a.sha1);
      if (!publishedRow(a)) continue;
      published += 1;
      const s = memoryStats(a.publicId);
      uses += s.uses;
      ratingSum += s.ratingSum;
      ratingCount += s.ratingCount;
    }
    const acceptedSuggestion = [...memorySuggestions()].some(
      (s) => s.accountId === accountId && !s.hidden && ACCEPTED_STATES.includes(s.state),
    );
    return { timed: songs.size, published, uses, ratingSum, ratingCount, acceptedSuggestion };
  },

};

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

/** The analysis behind a timing's public id, as a subquery. */
const ANALYSIS = (param) => `(SELECT id FROM analyses WHERE public_id = ${param})`;

/** Per published analysis: its ratings' count and sum and its uses, joined on `a.id`. */
const STATS_JOINS = `
  LEFT JOIN (SELECT analysis_id, count(*)::int AS n, sum(stars)::int AS s
               FROM timing_ratings WHERE analysis_id IS NOT NULL GROUP BY analysis_id) r ON r.analysis_id = a.id
  LEFT JOIN (SELECT analysis_id, count(*)::int AS n
               FROM timing_uses WHERE analysis_id IS NOT NULL GROUP BY analysis_id) us ON us.analysis_id = a.id`;
const STATS_COLS = 'coalesce(r.n, 0) AS rn, coalesce(r.s, 0) AS rs, coalesce(us.n, 0) AS un';
const statsOf = (row) => statsView({ ratingSum: row.rs, ratingCount: row.rn, uses: row.un });

const COMMENT = `
  SELECT c.public_id, c.account_id, c.body, c.at_ms, c.hidden, c.hidden_reason, c.created_at,
         a.public_id AS timing_id, (${PUBLISHED}) AS timing_published,
         acc.username, acc.display_name, acc.avatar_url
    FROM timing_comments c
    JOIN analyses a ON a.id = c.analysis_id
    LEFT JOIN accounts acc ON acc.id = c.account_id`;

const fromComment = (r) =>
  r && {
    publicId: r.public_id,
    timingId: r.timing_id.trim(),
    timingPublished: r.timing_published,
    accountId: r.account_id,
    author: person(r),
    body: r.body,
    atMs: r.at_ms,
    hidden: r.hidden,
    hiddenReason: r.hidden_reason,
    createdAt: r.created_at,
  };

const COLLECTION = `
  SELECT c.id, c.public_id, c.account_id, c.name, c.is_public, c.created_at, c.updated_at,
         acc.username, acc.display_name, acc.avatar_url,
         (SELECT count(*)::int FROM collection_items i JOIN analyses a ON a.id = i.analysis_id
           WHERE i.collection_id = c.id AND ${PUBLISHED}) AS count
    FROM collections c
    JOIN accounts acc ON acc.id = c.account_id`;

const fromCollection = (r) =>
  r && {
    publicId: r.public_id,
    accountId: r.account_id,
    owner: person(r),
    name: r.name,
    isPublic: r.is_public,
    count: r.count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const pgStore = {
  async rate(timingId, accountId, stars) {
    if (stars === null) {
      await query(`DELETE FROM timing_ratings WHERE analysis_id = ${ANALYSIS('$1')} AND account_id = $2`, [timingId, accountId]);
      return;
    }
    // timing_ratings_analysis_once is the one-rating rule: a second is an edit.
    await query(
      `INSERT INTO timing_ratings (analysis_id, account_id, stars) VALUES (${ANALYSIS('$1')}, $2, $3)
       ON CONFLICT (analysis_id, account_id) WHERE analysis_id IS NOT NULL
       DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
      [timingId, accountId, stars],
    );
  },

  async ratingOf(timingId, viewerId) {
    const { rows: [r] } = await query(
      `SELECT count(*)::int AS n, coalesce(sum(stars), 0)::int AS s,
              max(stars) FILTER (WHERE account_id = $2::uuid) AS mine
         FROM timing_ratings WHERE analysis_id = ${ANALYSIS('$1')}`,
      [timingId, viewerId],
    );
    return { ...ratingSummary(r.s, r.n), mine: r.mine ?? null };
  },

  async setUse(timingId, accountId, beatmapUrl) {
    await query(
      `INSERT INTO timing_uses (analysis_id, account_id, beatmap_url) VALUES (${ANALYSIS('$1')}, $2, $3)
       ON CONFLICT (analysis_id, account_id) WHERE analysis_id IS NOT NULL AND account_id IS NOT NULL
       DO UPDATE SET beatmap_url = EXCLUDED.beatmap_url`,
      [timingId, accountId, beatmapUrl],
    );
  },

  async removeUse(timingId, accountId) {
    const { rowCount } = await query(
      `DELETE FROM timing_uses WHERE analysis_id = ${ANALYSIS('$1')} AND account_id = $2`,
      [timingId, accountId],
    );
    return rowCount > 0;
  },

  async usesOf(timingId, viewerId, limit = 20) {
    const [{ rows: [n] }, { rows }] = await Promise.all([
      query(
        `SELECT count(*)::int AS n,
                (array_agg(coalesce(beatmap_url, '')) FILTER (WHERE account_id = $2::uuid))[1] AS mine
           FROM timing_uses WHERE analysis_id = ${ANALYSIS('$1')}`,
        [timingId, viewerId],
      ),
      query(
        `SELECT u.beatmap_url, u.used_at, acc.username, acc.display_name, acc.avatar_url
           FROM timing_uses u LEFT JOIN accounts acc ON acc.id = u.account_id
          WHERE u.analysis_id = ${ANALYSIS('$1')}
          ORDER BY u.used_at DESC, u.id DESC LIMIT $2`,
        [timingId, limit],
      ),
    ]);
    return {
      count: n.n,
      mine: n.mine === null || n.mine === undefined ? null : { beatmapUrl: n.mine || null },
      recent: rows.map((r) => ({ user: person(r), beatmapUrl: r.beatmap_url ?? null, at: r.used_at })),
    };
  },

  async statsFor(ids) {
    if (!ids.length) return new Map();
    const { rows } = await query(
      `SELECT a.public_id, ${STATS_COLS} FROM analyses a ${STATS_JOINS} WHERE a.public_id = ANY($1::bpchar[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.public_id.trim(), statsOf(r)]));
  },

  async listRanked(filters) {
    const args = [];
    const arg = (value) => {
      args.push(value);
      return `$${args.length}`;
    };
    const rated = filters.sort === 'rated';
    const clauses = [PUBLISHED, ...filterClauses(filters, arg)];
    clauses.push(rated ? `coalesce(r.n, 0) >= ${arg(MIN_RATINGS_TO_RANK)}` : 'coalesce(us.n, 0) >= 1');
    // Both orders come from this fixed text, never from the request.
    const order = rated
      ? `(${arg(PRIOR_RATINGS * PRIOR_STARS)}::float8 + coalesce(r.s, 0)) / (${arg(PRIOR_RATINGS)} + coalesce(r.n, 0)) DESC, coalesce(r.n, 0) DESC`
      : 'coalesce(us.n, 0) DESC';
    const { rows } = await query(
      `SELECT ${LIST_COLS}, ${STATS_COLS}
         FROM analyses a LEFT JOIN accounts u ON u.id = a.account_id ${STATS_JOINS}
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${order}, a.published_at DESC, a.public_id DESC
        LIMIT ${arg(filters.limit + 1)} OFFSET ${arg(filters.offset)}`,
      args,
    );
    const page = rows.slice(0, filters.limit);
    return {
      rows: page.map((r) => ({ ...listRow(r), stats: statsOf(r) })),
      next: rows.length > filters.limit ? encodeOffset(filters.offset + filters.limit) : null,
    };
  },

  async addComment({ publicId, timingId, accountId, body, atMs }) {
    await query(
      `INSERT INTO timing_comments (public_id, analysis_id, account_id, body, at_ms) VALUES ($1, ${ANALYSIS('$2')}, $3, $4, $5)`,
      [publicId, timingId, accountId, body, atMs],
    );
    return this.getComment(publicId);
  },

  async listComments(timingId, { viewerId = null, staff = false, offset = 0, limit = COMMENTS_PAGE } = {}) {
    const { rows } = await query(
      `SELECT *, count(*) OVER () AS total FROM (${COMMENT}
        WHERE c.analysis_id = ${ANALYSIS('$1')} AND (NOT c.hidden OR $2::boolean OR c.account_id = $3::uuid)) c
        ORDER BY created_at, public_id LIMIT $4 OFFSET $5`,
      [timingId, staff, viewerId, limit, offset],
    );
    return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(fromComment) };
  },

  async getComment(publicId) {
    const { rows } = await query(`${COMMENT} WHERE c.public_id = $1`, [publicId]);
    return fromComment(rows[0]) ?? null;
  },

  async deleteOwnComment(publicId, accountId) {
    const { rowCount } = await query('DELETE FROM timing_comments WHERE public_id = $1 AND account_id = $2', [publicId, accountId]);
    return rowCount > 0;
  },

  async createCollection({ publicId, accountId, name, isPublic }) {
    await transaction(async (client) => {
      // One account's collections are counted and inserted one at a time,
      // so two created at once cannot both pass the cap.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`collections:${accountId}`]);
      const { rows: [n] } = await client.query('SELECT count(*)::int AS n FROM collections WHERE account_id = $1', [accountId]);
      if (n.n >= COLLECTIONS_PER_ACCOUNT) throw tooMany('collections', COLLECTIONS_PER_ACCOUNT);
      await client.query(
        'INSERT INTO collections (public_id, account_id, name, is_public) VALUES ($1, $2, $3, $4)',
        [publicId, accountId, name, isPublic],
      );
    });
    return this.getCollection(publicId);
  },

  async ownCollections(accountId, { timingId = null } = {}) {
    const { rows } = await query(
      `SELECT * FROM (${COLLECTION} WHERE c.account_id = $1) c,
              LATERAL (SELECT EXISTS (SELECT 1 FROM collection_items i
                        WHERE i.collection_id = c.id AND i.analysis_id = ${ANALYSIS('$2')}) AS has) h
        ORDER BY updated_at DESC, id DESC`,
      [accountId, timingId],
    );
    return rows.map((r) => ({ ...fromCollection(r), has: r.has }));
  },

  async publicCollectionsOf(accountId) {
    const { rows } = await query(`${COLLECTION} WHERE c.account_id = $1 AND c.is_public ORDER BY c.updated_at DESC, c.id DESC`, [accountId]);
    return rows.map(fromCollection);
  },

  async getCollection(publicId) {
    const { rows } = await query(`${COLLECTION} WHERE c.public_id = $1`, [publicId]);
    return fromCollection(rows[0]) ?? null;
  },

  async updateCollection(publicId, { name, isPublic }) {
    const { rowCount } = await query(
      `UPDATE collections SET name = coalesce($2, name), is_public = coalesce($3, is_public), updated_at = now()
        WHERE public_id = $1`,
      [publicId, name ?? null, isPublic ?? null],
    );
    return rowCount ? this.getCollection(publicId) : null;
  },

  async deleteCollection(publicId) {
    const { rowCount } = await query('DELETE FROM collections WHERE public_id = $1', [publicId]);
    return rowCount > 0;
  },

  async addItem(publicId, timingId) {
    return transaction(async (client) => {
      const { rows: [c] } = await client.query('SELECT id FROM collections WHERE public_id = $1 FOR UPDATE', [publicId]);
      if (!c) return null;
      const { rows: [n] } = await client.query('SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1', [c.id]);
      const { rowCount } = await client.query(
        `INSERT INTO collection_items (collection_id, analysis_id)
              SELECT $1, ${ANALYSIS('$2')} WHERE $3::int < $4::int
         ON CONFLICT (collection_id, analysis_id) WHERE analysis_id IS NOT NULL DO NOTHING`,
        [c.id, timingId, n.n, ITEMS_PER_COLLECTION],
      );
      if (rowCount) {
        await client.query('UPDATE collections SET updated_at = now() WHERE id = $1', [c.id]);
        return 'added';
      }
      const { rows: [had] } = await client.query(
        `SELECT 1 FROM collection_items WHERE collection_id = $1 AND analysis_id = ${ANALYSIS('$2')}`,
        [c.id, timingId],
      );
      if (had) return 'exists';
      throw tooMany('timings in a collection', ITEMS_PER_COLLECTION);
    });
  },

  async removeItem(publicId, timingId) {
    const { rowCount } = await query(
      `DELETE FROM collection_items i USING collections c
        WHERE c.id = i.collection_id AND c.public_id = $1 AND i.analysis_id = ${ANALYSIS('$2')}`,
      [publicId, timingId],
    );
    if (rowCount) await query('UPDATE collections SET updated_at = now() WHERE public_id = $1', [publicId]);
    return rowCount > 0;
  },

  async collectionItems(publicId, { offset = 0, limit = 50 } = {}) {
    const { rows } = await query(
      `SELECT ${LIST_COLS}
         FROM collections c
         JOIN collection_items i ON i.collection_id = c.id
         JOIN analyses a ON a.id = i.analysis_id
         LEFT JOIN accounts u ON u.id = a.account_id
        WHERE c.public_id = $1 AND ${PUBLISHED}
        ORDER BY i.added_at DESC, a.public_id DESC
        LIMIT $2 OFFSET $3`,
      [publicId, limit + 1, offset],
    );
    return {
      rows: rows.slice(0, limit).map(listRow),
      next: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  },

  async profileStats(accountId) {
    const { rows: [r] } = await query(
      `WITH pub AS (SELECT a.id FROM analyses a WHERE a.account_id = $1 AND ${PUBLISHED})
       SELECT (SELECT count(DISTINCT a.song_id)::int FROM analyses a
                WHERE a.account_id = $1 AND a.status = 'done' AND a.deleted_at IS NULL AND NOT a.private) AS timed,
              (SELECT count(*)::int FROM pub) AS published,
              (SELECT count(*)::int FROM timing_uses t JOIN pub ON pub.id = t.analysis_id) AS uses,
              (SELECT count(*)::int FROM timing_ratings t JOIN pub ON pub.id = t.analysis_id) AS rn,
              (SELECT coalesce(sum(t.stars), 0)::int FROM timing_ratings t JOIN pub ON pub.id = t.analysis_id) AS rs,
              EXISTS (SELECT 1 FROM suggestions s
                       WHERE s.account_id = $1 AND NOT s.hidden AND s.state = ANY($2::text[])) AS accepted`,
      [accountId, ACCEPTED_STATES],
    );
    return {
      timed: r.timed, published: r.published, uses: r.uses, ratingSum: r.rs, ratingCount: r.rn, acceptedSuggestion: r.accepted,
    };
  },

};

export const social = () => (hasDatabase() ? pgStore : memoryStore);
