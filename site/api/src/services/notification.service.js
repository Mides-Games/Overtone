import { hasDatabase, query } from '../config/database.js';
import { staffIds } from './account.service.js';
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
 *   staff       (staff only) something waits on the staff panel: a report
 *               on an item, or a vote's correction to review
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
export const KINDS = ['suggestion', 'comment', 'use', 'vote', 'analysis', 'staff'];
export const KEEP = 200;
export const PAGE = 50;
export const DROPDOWN = 8;

// ── Where a notification leads (the panel's click) ──────────────────────────

const HEX = /^[0-9a-f]{32}$/;
/**
 * What a target may name, and the one path each is drawn as. The path is
 * built here from a fixed shape and a checked id, never read from a row, so
 * a link is always a path on this site: no scheme, no host, no `//`.
 */
export const TARGETS = {
  timing: (id) => `/t/${id}`,
  comment: (id, timing) => `/t/${timing}#comment-${id}`,
  analysis: (id) => `/analyze/${id}`,
  suggestion: (id) => (id ? `/community?suggestion=${id}#suggestion-${id}` : '/community'),
  staff: () => '/staff',
};
export const SAME_SITE = /^\/(?!\/)[A-Za-z0-9/_?=#-]*$/;

const target = (kind, id = null, extra = {}) => {
  const path = TARGETS[kind](id, extra.timing);
  return SAME_SITE.test(path) ? { kind, id, path } : null;
};

/**
 * `{ kind, id, path }`, or null when the row names nothing this site can
 * open. A row may carry its own `payload.target` ({ kind, id }, the staff
 * rows do); every older row is read from its kind and payload, which have
 * always held the ids (a comment's timing and comment, a suggestion's id...).
 */
export const targetOf = (kind, payload) => {
  const p = payload ?? {};
  const stored = p.target;
  if (stored && typeof stored === 'object' && Object.hasOwn(TARGETS, stored.kind)) {
    if (stored.kind === 'staff') return target('staff');
    if (stored.kind === 'suggestion' && stored.id == null) return target('suggestion');
    if (stored.kind === 'comment' && HEX.test(stored.id ?? '') && HEX.test(p.timing ?? '')) return target('comment', stored.id, { timing: p.timing });
    if (stored.kind !== 'comment' && HEX.test(stored.id ?? '')) return target(stored.kind, stored.id);
  }
  switch (kind) {
    case 'suggestion':
      return target('suggestion', HEX.test(p.suggestion ?? '') ? p.suggestion : null);
    case 'comment':
      if (!HEX.test(p.timing ?? '')) return null;
      return HEX.test(p.comment ?? '') ? target('comment', p.comment, { timing: p.timing }) : target('timing', p.timing);
    case 'use':
    case 'vote':
      return HEX.test(p.timing ?? '') ? target('timing', p.timing) : null;
    case 'analysis':
      return HEX.test(p.analysis ?? '') ? target('analysis', p.analysis) : null;
    case 'staff':
      return target('staff');
    default:
      return null;
  }
};

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

  async list(accountId, { offset = 0, limit = PAGE, unreadOnly = false, kinds = null } = {}) {
    const rows = [...(memory.get(accountId)?.values() ?? [])]
      .filter((n) => (!unreadOnly || !n.readAt) && (!kinds || kinds.includes(n.kind)))
      .sort(newestFirst);
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(view) };
  },

  async markUnread(accountId, ids) {
    let n = 0;
    for (const row of memory.get(accountId)?.values() ?? []) {
      if (row.readAt && ids.includes(row.publicId)) {
        row.readAt = null;
        n += 1;
      }
    }
    return n;
  },

  async remove(accountId, publicId) {
    const mine = memory.get(accountId);
    for (const [key, row] of mine ?? []) {
      if (row.publicId === publicId) return mine.delete(key);
    }
    return false;
  },

  async removeRead(accountId) {
    const mine = memory.get(accountId);
    let n = 0;
    for (const [key, row] of mine ?? []) {
      if (row.readAt) {
        mine.delete(key);
        n += 1;
      }
    }
    return n;
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

  async list(accountId, { offset = 0, limit = PAGE, unreadOnly = false, kinds = null } = {}) {
    const where = `account_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL) AND ($3::text[] IS NULL OR kind = ANY($3::text[]))`;
    const [{ rows }, { rows: [count] }] = await Promise.all([
      query(
        `SELECT public_id, kind, payload, created_at, read_at FROM notifications WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
        [accountId, unreadOnly, kinds, limit, offset],
      ),
      // Its own count: a window count is empty on a page past the end, and the
      // page's "more" needs the total even there.
      query(`SELECT count(*)::int AS n FROM notifications WHERE ${where}`, [accountId, unreadOnly, kinds]),
    ]);
    return { total: count.n, items: rows.map(fromRow) };
  },

  async markUnread(accountId, ids) {
    const { rowCount } = await query(
      `UPDATE notifications SET read_at = NULL
        WHERE account_id = $1 AND read_at IS NOT NULL AND public_id = ANY($2::bpchar[])`,
      [accountId, ids],
    );
    return rowCount;
  },

  async remove(accountId, publicId) {
    const { rowCount } = await query('DELETE FROM notifications WHERE account_id = $1 AND public_id = $2', [accountId, publicId]);
    return rowCount === 1;
  },

  async removeRead(accountId) {
    const { rowCount } = await query('DELETE FROM notifications WHERE account_id = $1 AND read_at IS NOT NULL', [accountId]);
    return rowCount;
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

/**
 * Tells every staff account but the actor that something waits on `/staff`
 * (`item` is `report` or `correction`). The payload names what kind of thing
 * and its song's title at most, never the reporter or the reason: the panel
 * shows those to whoever opens it. One row per thing (`key`), brought back to
 * unread by the next report on it. Never throws, as `notify`.
 */
export const notifyStaff = async (key, payload, { actorId = null } = {}) => {
  let ids;
  try {
    ids = await staffIds();
  } catch (error) {
    console.warn(`[notify] the staff could not be listed: ${error.message}`);
    return;
  }
  for (const id of ids) await notify(id, 'staff', key, { ...payload, target: { kind: 'staff', id: null } }, { actorId });
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
