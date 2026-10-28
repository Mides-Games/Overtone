import { hasDatabase, query } from '../config/database.js';

/**
 * Profile visits (2026-10-28): how many people opened a public profile.
 *
 * A visit is one visitor on one profile on one UTC day. The visitor is a
 * keyed hash the route makes (routes/social.routes.js `visitorOf`) of the
 * signed-in account or, without one, of the client address, salted with the
 * day: the same person twice in a day is one visit, and nothing stored links
 * one day's visitor to the next. The raw address is never stored.
 *
 * Two tables (schema.sql): `profile_visitors` holds those day hashes only as
 * long as the dedupe needs them (today and yesterday; older rows are swept),
 * `profile_visits` the counts per profile and day, which is all that is kept
 * after. Without a database (development only) both live in this process's
 * memory, as the other stores' do.
 */

/** The window the profile's recent count covers, in days, today included. */
export const VISIT_DAYS = 30;

/** `YYYY-MM-DD` of `now` in UTC: the day a visit is counted on. */
export const utcDay = (now = new Date()) => new Date(now).toISOString().slice(0, 10);

/** The UTC day `days` before `day`, as `YYYY-MM-DD`. */
const dayBefore = (day, days) => utcDay(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000);

// ── In memory ───────────────────────────────────────────────────────────────

const memory = {
  /** `account|day|visitor` of the days the dedupe still needs. */
  seen: new Set(),
  /** account id -> day -> count */
  counts: new Map(),
};

/** For the tests: start from nothing. */
export const resetVisitMemory = () => {
  memory.seen.clear();
  memory.counts.clear();
};

const memoryStore = {
  async record(accountId, visitor, day = utcDay()) {
    const yesterday = dayBefore(day, 1);
    for (const key of memory.seen) if (key.split('|')[1] < yesterday) memory.seen.delete(key);
    const key = `${accountId}|${day}|${visitor}`;
    if (memory.seen.has(key)) return false;
    memory.seen.add(key);
    const days = memory.counts.get(accountId) ?? new Map();
    memory.counts.set(accountId, days);
    days.set(day, (days.get(day) ?? 0) + 1);
    return true;
  },

  async of(accountId, today = utcDay()) {
    const since = dayBefore(today, VISIT_DAYS - 1);
    let total = 0;
    let recent = 0;
    for (const [day, n] of memory.counts.get(accountId) ?? []) {
      total += n;
      if (day >= since && day <= today) recent += n;
    }
    return { total, recent };
  },

  async total() {
    let total = 0;
    for (const days of memory.counts.values()) for (const n of days.values()) total += n;
    return total;
  },
};

// ── PostgreSQL ──────────────────────────────────────────────────────────────

let lastSweep = 0;

const pgStore = {
  /**
   * One statement: the visitor's row for the day goes in unless it is there,
   * and only a row that went in adds one to the day's count. Two requests of
   * the same visitor at once meet on the primary key; one of them counts.
   */
  async record(accountId, visitor, day = utcDay()) {
    const { rowCount } = await query(
      `WITH seen AS (
         INSERT INTO profile_visitors (account_id, day, visitor) VALUES ($1, $2::date, $3)
         ON CONFLICT DO NOTHING RETURNING 1
       )
       INSERT INTO profile_visits AS v (account_id, day, count)
       SELECT $1, $2::date, 1 FROM seen
       ON CONFLICT (account_id, day) DO UPDATE SET count = v.count + 1`,
      [accountId, day, visitor],
    );
    if (Date.now() - lastSweep >= 60_000) {
      lastSweep = Date.now();
      // The hashes of the days the dedupe no longer needs. Nothing waits on it.
      query('DELETE FROM profile_visitors WHERE day < $1::date - 1', [day]).catch(() => {});
    }
    return rowCount === 1;
  },

  async of(accountId, today = utcDay()) {
    const { rows: [r] } = await query(
      `SELECT coalesce(sum(count), 0)::bigint AS total,
              coalesce(sum(count) FILTER (WHERE day > $2::date - $3::int AND day <= $2::date), 0)::bigint AS recent
         FROM profile_visits WHERE account_id = $1`,
      [accountId, today, VISIT_DAYS],
    );
    return { total: Number(r.total), recent: Number(r.recent) };
  },

  async total() {
    const { rows: [r] } = await query('SELECT coalesce(sum(count), 0)::bigint AS total FROM profile_visits');
    return Number(r.total);
  },
};

export const visits = () => (hasDatabase() ? pgStore : memoryStore);
