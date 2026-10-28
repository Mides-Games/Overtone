import { createHash, randomBytes } from 'node:crypto';

import { hasDatabase, pool, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Personal API tokens (W12.20): what a signed-in person hands a script, a
 * bot or a community tool so it can call the public API as them.
 *
 * - **Shown once, kept as a hash.** A token is `ot_` and 256 random bits in
 *   base64url. The row keeps its SHA-256 and nothing else of it: a plain hash
 *   is enough for a secret this long (nothing to guess, so nothing a slow hash
 *   would slow down), and a leak of the table opens no account.
 * - **Scopes** say what it may do, chosen when it is made and never widened:
 *   `read:analyses` (your own analyses, their exports and versions),
 *   `upload` (send songs, as your account and within its quota) and
 *   `read:timings` (the published timings anyone can read; with a token they
 *   count against the token's own rate limit instead of an address's).
 * - **Revoked is deleted.** The row goes; the next request with it is a 401.
 * - At most MAX_TOKENS a person, so a script cannot mint its way round the
 *   per-token rate limit. Signing out does not revoke them: a token is for a
 *   machine, a session for a browser.
 *
 * Which routes a token reaches, and why it never stands in for a browser's
 * cookie, is middlewares/token.js.
 */

export const SCOPES = Object.freeze(['read:analyses', 'upload', 'read:timings']);
export const MAX_TOKENS = 5;
export const NAME_MAX = 60;

/** `ot_` and 43 base64url characters: what `newToken` makes, and nothing else is looked up. */
export const TOKEN_FORMAT = /^ot_[A-Za-z0-9_-]{43}$/;

export const newToken = () => `ot_${randomBytes(32).toString('base64url')}`;
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** last_used_at is written at most this often per token: a busy script is not a write per request. */
const TOUCH_MS = 60_000;

/** The scopes asked for, deduplicated in the canonical order, or null when any is unknown or none is given. */
export const parseScopes = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPES.length * 2) return null;
  if (!raw.every((s) => typeof s === 'string' && SCOPES.includes(s))) return null;
  return SCOPES.filter((s) => raw.includes(s));
};

const view = (row) => ({
  id: row.publicId,
  name: row.name,
  scopes: [...row.scopes],
  createdAt: new Date(row.createdAt).toISOString(),
  lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
});
export const tokenView = view;

const tooMany = () =>
  new HttpError(409, `You can have ${MAX_TOKENS} tokens at once. Revoke one first.`, 'TOKEN_LIMIT', { limit: MAX_TOKENS });

// ── Memory ──────────────────────────────────────────────────────────────────

const memory = { tokens: new Map() }; // hash -> row

const memoryStore = {
  async list(accountId) {
    return [...memory.tokens.values()].filter((t) => t.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt);
  },

  async create({ accountId, name, scopes }) {
    // No await between the count and the insert: two requests cannot both pass the cap.
    if ([...memory.tokens.values()].filter((t) => t.accountId === accountId).length >= MAX_TOKENS) throw tooMany();
    const token = newToken();
    const row = {
      publicId: randomBytes(16).toString('hex'), accountId, name, scopes, createdAt: new Date(), lastUsedAt: null,
    };
    memory.tokens.set(hashToken(token), row);
    return { token, row };
  },

  async revoke(accountId, publicId) {
    for (const [hash, row] of memory.tokens) {
      if (row.publicId === publicId && row.accountId === accountId) {
        memory.tokens.delete(hash);
        return true;
      }
    }
    return false;
  },

  async authenticate(token) {
    const row = memory.tokens.get(hashToken(token));
    if (!row) return null;
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() >= TOUCH_MS) row.lastUsedAt = new Date();
    return { id: row.publicId, accountId: row.accountId, scopes: [...row.scopes] };
  },
};

// ── PostgreSQL ──────────────────────────────────────────────────────────────

const fromRow = (r) => ({
  publicId: r.public_id.trim(), accountId: r.account_id, name: r.name, scopes: r.scopes,
  createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

const pgStore = {
  async list(accountId) {
    const { rows } = await query(
      `SELECT public_id, account_id, name, scopes, created_at, last_used_at
         FROM api_tokens WHERE account_id = $1 ORDER BY created_at DESC, id DESC`,
      [accountId],
    );
    return rows.map(fromRow);
  },

  async create({ accountId, name, scopes }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The account's row lock: two creations at once are counted one after the other.
      await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM api_tokens WHERE account_id = $1', [accountId]);
      if (n >= MAX_TOKENS) throw tooMany();
      const token = newToken();
      const { rows: [row] } = await client.query(
        `INSERT INTO api_tokens (public_id, account_id, name, token_hash, scopes)
              VALUES ($1, $2, $3, $4, $5)
           RETURNING public_id, account_id, name, scopes, created_at, last_used_at`,
        [randomBytes(16).toString('hex'), accountId, name, hashToken(token), scopes],
      );
      await client.query('COMMIT');
      return { token, row: fromRow(row) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  async revoke(accountId, publicId) {
    const { rowCount } = await query('DELETE FROM api_tokens WHERE public_id = $1 AND account_id = $2', [publicId, accountId]);
    return rowCount > 0;
  },

  async authenticate(token) {
    const { rows: [row] } = await query(
      `UPDATE api_tokens SET last_used_at = now()
        WHERE token_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2))
        RETURNING public_id, account_id, scopes`,
      [hashToken(token), TOUCH_MS / 1000],
    );
    const found = row ?? (await query('SELECT public_id, account_id, scopes FROM api_tokens WHERE token_hash = $1', [hashToken(token)])).rows[0];
    return found ? { id: found.public_id.trim(), accountId: found.account_id, scopes: found.scopes } : null;
  },
};

export const tokens = () => (hasDatabase() ? pgStore : memoryStore);
