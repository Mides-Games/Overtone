import { hasDatabase, query } from '../config/database.js';
import { newPublicId } from './community.service.js';

/**
 * The notification bell (W13.17): what happened to an account's things while
 * it was away, kept on the server with a read/unread state, so it follows
 * the person to another browser.
 *
 *   suggestion  staff moved your suggestion to another state
 *   comment     someone commented on your published timing
 *   use         someone said they used your timing (the first time only)
 *   vote        someone voted your timing on time or off (never named: votes
 *               are anonymous to everyone but staff, utils/votes.js)
 *   analysis    an analysis of yours ended and you had not seen it yet
 *
 * Each notification has a `dedupe_key`, one row per account and key: a vote
 * changed three times is one notification, brought back to unread, not
 * three. Nobody is notified of their own doing. The payload holds only what
 * the person could read on the page it points at (public ids, a song's
 * names, a public username), so a bell never shows what a page would hide.
 *
 * An account keeps its newest KEEP rows; older ones are dropped when a new
 * one arrives. Writing a notification never fails the request that caused
 * it (`notify` logs and carries on): the bell is a courtesy, the comment or
 * the result is the point.
 */
export const KINDS = ['suggestion', 'comment', 'use', 'vote', 'analysis'];
export const KEEP = 200;
export const PAGE = 50;
export const DROPDOWN = 8;

// ── In memory ───────────────────────────────────────────────────────────────

/** account id -> Map(dedupe key -> row) */
const memory = new Map();
let seq = 0;

/** For the tests: start from nothing. */
export const resetNotificationMemory = () => memory.clear();

const view = (n) => ({
  publicId: n.publicId,
  kind: n.kind,
  payload: n.payload,
  createdAt: n.createdAt,
  readAt: n.readAt ?? null,
});

const newestFirst = (a, b) => b.createdAt - a.createdAt || b.seq - a.seq;

const memoryStore = {
  async add(accountId, kind, key, payload) {
    const mine = memory.get(accountId) ?? new Map();
    memory.set(accountId, mine);
    const existing = mine.get(key);
    // Brought back to the top and to unread: something new happened to it.
    mine.set(key, { publicId: existing?.publicId ?? newPublicId(), kind, payload, createdAt: new Date(), readAt: null, seq: ++seq });
    if (mine.size > KEEP) {
      const oldest = [...mine.entries()].sort(([, a], [, b]) => newestFirst(b, a)).slice(0, mine.size - KEEP);
      for (const [k] of oldest) mine.delete(k);
    }
  },

  async list(accountId, { offset = 0, limit = PAGE, unreadOnly = false } = {}) {
    const rows = [...(memory.get(accountId)?.values() ?? [])].filter((n) => !unreadOnly || !n.readAt).sort(newestFirst);
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(view) };
  },

  async unread(accountId) {
    return [...(memory.get(accountId)?.values() ?? [])].filter((n) => !n.readAt).length;
  },

  async markRead(accountId, ids) {
    const now = new Date();
    let n = 0;
    for (const row of memory.get(accountId)?.values() ?? []) {
      if (!row.readAt && (ids === null || ids.includes(row.publicId))) {
        row.readAt = now;
        n += 1;
      }
    }
    return n;
  },

  async markSeen(accountId, key) {
    const row = memory.get(accountId)?.get(key);
    if (row && !row.readAt) row.readAt = new Date();
  },
};

// ── PostgreSQL ──────────────────────────────────────────────────────────────

const fromRow = (r) => ({
  publicId: r.public_id.trim(),
  kind: r.kind,
  payload: r.payload,
  createdAt: r.created_at,
  readAt: r.read_at,
});

const pgStore = {
  async add(accountId, kind, key, payload) {
    await query(
      `INSERT INTO notifications (public_id, account_id, kind, dedupe_key, payload) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, dedupe_key)
       DO UPDATE SET kind = EXCLUDED.kind, payload = EXCLUDED.payload, created_at = now(), read_at = NULL`,
      [newPublicId(), accountId, kind, key, payload],
    );
    // The account's newest KEEP only; an index scan of one account's rows.
    await query(
      `DELETE FROM notifications WHERE account_id = $1 AND id NOT IN
         (SELECT id FROM notifications WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
      [accountId, KEEP],
    );
  },

  async list(accountId, { offset = 0, limit = PAGE, unreadOnly = false } = {}) {
    const { rows } = await query(
      `SELECT public_id, kind, payload, created_at, read_at, count(*) OVER () AS total
         FROM notifications WHERE account_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL)
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [accountId, unreadOnly, limit, offset],
    );
    return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(fromRow) };
  },

  async unread(accountId) {
    const { rows: [n] } = await query('SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND read_at IS NULL', [accountId]);
    return n.n;
  },

  async markRead(accountId, ids) {
    const { rowCount } = await query(
      `UPDATE notifications SET read_at = now()
        WHERE account_id = $1 AND read_at IS NULL AND ($2::bpchar[] IS NULL OR public_id = ANY($2::bpchar[]))`,
      [accountId, ids],
    );
    return rowCount;
  },

  async markSeen(accountId, key) {
    await query('UPDATE notifications SET read_at = now() WHERE account_id = $1 AND dedupe_key = $2 AND read_at IS NULL', [accountId, key]);
  },
};

export const notifications = () => (hasDatabase() ? pgStore : memoryStore);

/**
 * Tells `accountId` about `kind`, unless there is nobody to tell or the
 * actor is the person themselves. Never throws: see the module's comment.
 */
export const notify = async (accountId, kind, key, payload, { actorId = null } = {}) => {
  if (!accountId || (actorId && actorId === accountId)) return;
  try {
    await notifications().add(accountId, kind, key, payload);
  } catch (error) {
    console.warn(`[notify] a ${kind} notification was not stored: ${error.message}`);
  }
};

/** An analysis's notification is marked read once its owner has read the ended analysis. */
export const analysisKey = (publicId) => `analysis:${publicId}`;

export const seen = async (accountId, key) => {
  try {
    await notifications().markSeen(accountId, key);
  } catch (error) {
    console.warn(`[notify] could not mark ${key} seen: ${error.message}`);
  }
};
