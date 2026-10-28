import { createHmac, randomInt } from 'node:crypto';

import { env } from '../config/env.js';
import { hasDatabase, query } from '../config/database.js';
import { COLUMNS, memory as accountMemory, OSU_EMPTY } from './account.service.js';

/**
 * An account's links to Discord and osu! (W9.1, W9.2), the bot's /link codes
 * and its DM outbox (W9.4). Both stores, as everywhere: PostgreSQL with
 * DATABASE_URL, this process's memory without (development and tests).
 *
 * A Discord id is personal data of a kind: it is kept raw only on the account
 * it is linked to, because the bot needs it to send a DM. Everything else
 * that is counted per Discord user (the anonymous quota, the rate limits) is
 * counted by an HMAC of it under SESSION_SECRET, never the id.
 */

const memory = { codes: new Map(), dms: [], dmSeq: 0 };

const hmac = (text) => createHmac('sha256', env.sessionSecret).update(text).digest('hex');

/** The rate limits' key for a Discord user (middlewares/rate-limit.js keys are 32 hex). */
export const discordKey = (discordId) => hmac(`discord-rate:${discordId}`).slice(0, 32);

/**
 * What stands in for the anonymous cookie's hash when an unlinked Discord user
 * analyses through the bot: stable, so the bot can read their analyses back
 * later, and never equal to a cookie's SHA-256 (another preimage entirely).
 */
export const discordAnonHash = (discordId) => hmac(`discord-anon:${discordId}`);

/**
 * What stands in for the client address's daily hash (routes/analyses.routes.js,
 * `ipHashOf`): the anonymous quota and the queue's turns count by it, so an
 * unlinked Discord user has the anonymous quota of one visitor. Per UTC day,
 * as the address's is, so one day's uploads do not link to the next.
 */
export const discordDayHash = (discordId) => hmac(`discord-day:${new Date().toISOString().slice(0, 10)}:${discordId}`);

/** The account linked to a Discord user, or `null`. */
export const accountByDiscord = async (discordId) => {
  if (!discordId) return null;
  if (!hasDatabase()) return [...accountMemory.accounts.values()].find((a) => a.discord_id === discordId) ?? null;
  const { rows: [row = null] } = await query(`SELECT ${COLUMNS} FROM accounts WHERE discord_id = $1`, [discordId]);
  return row;
};

export const accountById = async (accountId) => {
  if (!accountId) return null;
  if (!hasDatabase()) return accountMemory.accounts.get(accountId) ?? null;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
  const { rows: [row = null] } = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [accountId]);
  return row;
};

/**
 * Links `discordId` to the account, or unlinks with `null` (which turns the
 * DMs off too). The id leaves any account that held it before: whoever proves
 * it last (Mides, or the bot naming the user who typed the code) holds it.
 */
export const setDiscord = async (accountId, discordId) => {
  if (!hasDatabase()) {
    if (discordId) {
      for (const other of accountMemory.accounts.values()) {
        if (other.id !== accountId && other.discord_id === discordId) Object.assign(other, { discord_id: null, discord_notify: false, discord_username: null });
      }
    }
    const row = accountMemory.accounts.get(accountId);
    if (!row) return null;
    // A new id (the bot's code) comes with no name; the old name went with the old id.
    if (row.discord_id !== discordId) row.discord_username = null;
    Object.assign(row, { discord_id: discordId, ...(discordId ? {} : { discord_notify: false }) });
    return row;
  }
  if (discordId) {
    await query(
      'UPDATE accounts SET discord_id = NULL, discord_notify = false, discord_username = NULL WHERE discord_id = $1 AND id <> $2',
      [discordId, accountId],
    );
  }
  const { rows: [row = null] } = await query(
    `UPDATE accounts SET discord_id = $2, discord_notify = CASE WHEN $2::text IS NULL THEN false ELSE discord_notify END,
                         discord_username = CASE WHEN discord_id IS NOT DISTINCT FROM $2::text THEN discord_username END
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [accountId, discordId],
  );
  return row;
};

/** DMs on or off (W9.4). Only with Discord linked: `false` when it is not. */
export const setNotify = async (accountId, on) => {
  if (!hasDatabase()) {
    const row = accountMemory.accounts.get(accountId);
    if (!row?.discord_id) return false;
    row.discord_notify = Boolean(on);
    return true;
  }
  const { rowCount } = await query(
    'UPDATE accounts SET discord_notify = $2 WHERE id = $1 AND discord_id IS NOT NULL',
    [accountId, Boolean(on)],
  );
  return rowCount > 0;
};

/**
 * Stores what osu!'s /me said (W9.2), or clears it with `null`. One osu!
 * user, one account: linking proves who holds the osu! account now, so an
 * older link of the same osu! user to another account goes.
 */
export const setOsu = async (accountId, profile) => {
  const fields = profile ? { ...osuColumns(profile), osu_linked_at: new Date(), osu_refreshed_at: new Date() } : { ...OSU_EMPTY };
  if (!hasDatabase()) {
    if (profile) {
      for (const other of accountMemory.accounts.values()) {
        if (other.id !== accountId && Number(other.osu_user_id) === profile.id) Object.assign(other, OSU_EMPTY);
      }
    }
    const row = accountMemory.accounts.get(accountId);
    if (!row) return null;
    Object.assign(row, fields);
    return row;
  }
  if (profile) {
    const clear = Object.keys(OSU_EMPTY).map((column) => `${column} = NULL`).join(', ');
    await query(`UPDATE accounts SET ${clear} WHERE osu_user_id = $1 AND id <> $2`, [profile.id, accountId]);
  }
  return updateOsu(accountId, fields);
};

/** The osu! card's columns from a profile (osu.service.js `toOsuProfile`). */
const osuColumns = (profile) => ({
  osu_user_id: profile.id,
  osu_username: profile.username,
  osu_avatar_url: profile.avatarUrl,
  osu_ranked_count: profile.rankedCount,
  osu_country: profile.country ?? null,
  osu_global_rank: profile.globalRank ?? null,
  osu_country_rank: profile.countryRank ?? null,
  osu_pp: profile.pp ?? null,
  osu_accuracy: profile.accuracy ?? null,
  osu_play_count: profile.playCount ?? null,
});

/** Writes `fields` (osu_* columns from the fixed lists above) to the account. */
const updateOsu = async (accountId, fields) => {
  const entries = Object.entries(fields);
  const { rows: [row = null] } = await query(
    `UPDATE accounts SET ${entries.map(([column], i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    [accountId, ...entries.map(([, value]) => value)],
  );
  return row;
};

/**
 * A "Refresh" of the osu! card: the same osu! user's fields now. Only while
 * that user is still the one linked (an unlink or a relink in between wins),
 * and the link's date stays.
 */
export const refreshOsu = async (accountId, profile) => {
  const fields = { ...osuColumns(profile), osu_refreshed_at: new Date() };
  if (!hasDatabase()) {
    const row = accountMemory.accounts.get(accountId);
    if (!row || Number(row.osu_user_id) !== profile.id) return null;
    Object.assign(row, fields);
    return row;
  }
  const entries = Object.entries(fields);
  const { rows: [row = null] } = await query(
    `UPDATE accounts SET ${entries.map(([column], i) => `${column} = $${i + 3}`).join(', ')}
      WHERE id = $1 AND osu_user_id = $2 RETURNING ${COLUMNS}`,
    [accountId, profile.id, ...entries.map(([, value]) => value)],
  );
  return row;
};

// ── The bot's /link code (W9.1's fallback) ──────────────────────────────────

/** No 0/O, 1/I/L: a code is read off one screen and typed into another. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_MINUTES = 10;

/** The code as typed, upper case and without spaces or dashes; `null` when it cannot be one. */
export const normalizeCode = (raw) => {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
};

const codeHash = (code) => hmac(`link-code:${code}`);

/** A new code for the account, replacing its last one. 8 characters of 31: about 40 bits, ten minutes, rate limited. */
export const issueLinkCode = async (accountId) => {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
  if (!hasDatabase()) {
    for (const [hash, entry] of memory.codes) if (entry.accountId === accountId || entry.expiresAt <= new Date()) memory.codes.delete(hash);
    memory.codes.set(codeHash(code), { accountId, expiresAt });
  } else {
    await query('DELETE FROM discord_link_codes WHERE account_id = $1 OR expires_at <= now()', [accountId]);
    await query('INSERT INTO discord_link_codes (code_hash, account_id, expires_at) VALUES ($1, $2, $3)', [codeHash(code), accountId, expiresAt]);
  }
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
};

/** Spends a code: links its account to `discordId` and returns the account, or `null` for a wrong or stale code. */
export const redeemLinkCode = async (raw, discordId) => {
  const code = normalizeCode(raw);
  if (!code) return null;
  const hash = codeHash(code);
  let accountId = null;
  if (!hasDatabase()) {
    const entry = memory.codes.get(hash);
    memory.codes.delete(hash);
    if (entry && entry.expiresAt > new Date()) accountId = entry.accountId;
  } else {
    // One statement takes it and spends it: two bots racing on a code link once.
    const { rows: [row] } = await query(
      'DELETE FROM discord_link_codes WHERE code_hash = $1 AND expires_at > now() RETURNING account_id',
      [hash],
    );
    accountId = row?.account_id ?? null;
  }
  return accountId ? setDiscord(accountId, discordId) : null;
};

// ── The DM outbox (W9.4) ────────────────────────────────────────────────────

/**
 * An analysis ended: when its account has Discord linked and asked for DMs,
 * the bot gets a notice to send. A row per analysis at most.
 */
export const enqueueDm = async ({ publicId, accountId }) => {
  if (!accountId) return false;
  const account = await accountById(accountId);
  if (!account?.discord_id || !account.discord_notify) return false;
  if (!hasDatabase()) {
    if (memory.dms.some((d) => d.publicId === publicId)) return false;
    memory.dms.push({ id: ++memory.dmSeq, accountId, publicId, createdAt: new Date(), sentAt: null });
    return true;
  }
  const { rowCount } = await query(
    'INSERT INTO discord_dms (account_id, public_id) VALUES ($1, $2) ON CONFLICT (public_id) DO NOTHING',
    [accountId, publicId],
  );
  return rowCount > 0;
};

/**
 * Up to `limit` notices for the bot, marked sent as they are taken. Each
 * carries the Discord id read now, not at enqueue time: someone who unlinked
 * or turned DMs off in between gets nothing.
 */
export const claimDms = async (limit = 10) => {
  let taken;
  if (!hasDatabase()) {
    const day = Date.now() - 86_400_000;
    memory.dms = memory.dms.filter((d) => !d.sentAt || d.sentAt.getTime() > day);
    taken = memory.dms.filter((d) => !d.sentAt).slice(0, limit);
    for (const d of taken) d.sentAt = new Date();
  } else {
    query("DELETE FROM discord_dms WHERE sent_at < now() - interval '1 day'").catch(() => {});
    ({ rows: taken } = await query(
      `WITH picked AS (
         SELECT id FROM discord_dms WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE discord_dms d SET sent_at = now() FROM picked WHERE d.id = picked.id
       RETURNING d.public_id AS "publicId", d.account_id AS "accountId"`,
      [limit],
    ));
  }
  const out = [];
  for (const { publicId, accountId } of taken) {
    const account = await accountById(accountId);
    if (account?.discord_id && account.discord_notify) out.push({ publicId: String(publicId).trim(), discordId: account.discord_id });
  }
  return out;
};
