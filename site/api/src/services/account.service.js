import { randomUUID } from 'node:crypto';

import { hasDatabase, query } from '../config/database.js';

/**
 * Accounts, from the Mides profile each sign-in brings. No Mides token is kept.
 *
 * With a database, rows live in `accounts`. Without one
 * (development only; `env.js` refuses it in production) they live in this
 * process's memory and vanish on restart. That is what lets `pnpm dev` work on
 * a machine with no Postgres; it is not a cache and nothing reads it in
 * production.
 */

export const memory = { accounts: new Map() };

export const COLUMNS =
  'id, mides_user_id, username, display_name, avatar_url, banner_url, discord_id, mides_role, session_version, created_at, cached_at, ' +
  'discord_notify, osu_user_id, osu_username, osu_avatar_url, osu_ranked_count, osu_linked_at';

/** The W9 fields a new memory row starts with, as the table's defaults. */
const LINK_DEFAULTS = {
  discord_notify: false, osu_user_id: null, osu_username: null, osu_avatar_url: null, osu_ranked_count: null, osu_linked_at: null,
};

/**
 * Creates the account on first sign-in, refreshes its public fields on every
 * later one.
 *
 * The Discord id (W9.1) is taken when Mides sends one and kept when it does
 * not: a link made through the bot's /link code must survive a sign-in from a
 * Mides that has no Discord on file. Mides is the authority when it does send
 * one, so that id leaves any other account that held it first (one Discord
 * user, one account).
 */
export const upsertFromMides = async (user) => {
  if (!hasDatabase()) {
    const existing = [...memory.accounts.values()].find((a) => a.mides_user_id === user.midesUserId);
    if (user.discordId) {
      for (const other of memory.accounts.values()) {
        if (other !== existing && other.discord_id === user.discordId) Object.assign(other, { discord_id: null, discord_notify: false });
      }
    }
    const now = new Date();
    const row = {
      ...LINK_DEFAULTS,
      ...existing,
      id: existing?.id ?? randomUUID(),
      session_version: existing?.session_version ?? 0,
      created_at: existing?.created_at ?? now,
      mides_user_id: user.midesUserId,
      username: user.username,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
      banner_url: user.bannerUrl,
      discord_id: user.discordId ?? existing?.discord_id ?? null,
      mides_role: user.role,
      cached_at: now,
    };
    memory.accounts.set(row.id, row);
    return row;
  }

  if (user.discordId) {
    await query(
      'UPDATE accounts SET discord_id = NULL, discord_notify = false WHERE discord_id = $1 AND mides_user_id <> $2',
      [user.discordId, user.midesUserId],
    );
  }
  const { rows } = await query(
    `INSERT INTO accounts (mides_user_id, username, display_name, avatar_url, banner_url, discord_id, mides_role)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mides_user_id) DO UPDATE
             SET username = EXCLUDED.username,
                 display_name = EXCLUDED.display_name,
                 avatar_url = EXCLUDED.avatar_url,
                 banner_url = EXCLUDED.banner_url,
                 discord_id = coalesce(EXCLUDED.discord_id, accounts.discord_id),
                 mides_role = EXCLUDED.mides_role,
                 cached_at = now()
       RETURNING ${COLUMNS}`,
    [user.midesUserId, user.username, user.displayName, user.avatarUrl, user.bannerUrl, user.discordId, user.role],
  );
  return rows[0];
};

/** The account a session cookie names, or `null` if it is gone or the cookie predates a sign-out. */
export const sessionAccount = async ({ accountId, version }) => {
  let row;
  if (!hasDatabase()) {
    row = memory.accounts.get(accountId) ?? null;
  } else {
    // A cookie's id that is not a uuid would make PostgreSQL throw: no session, not a 500.
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
    ({ rows: [row = null] } = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [accountId]));
  }

  return row && row.session_version === version ? row : null;
};

/** Signing out: every cookie of this account stops being valid, and the token is forgotten. */
export const signOut = async (accountId) => {
  if (!hasDatabase()) {
    const row = memory.accounts.get(accountId);
    if (row) row.session_version += 1;
    return;
  }

  await query('UPDATE accounts SET session_version = session_version + 1 WHERE id = $1', [accountId]);
};


/**
 * Whether this account may moderate (W3.18): Mides' `is_moderator`, which the
 * sign-in keeps as `mides_role` and refreshes at every sign-in. Losing the role
 * in Mides takes effect here at the next sign-in.
 */
export const isStaff = (row) => row?.mides_role === 'moderator';

/**
 * What `/me` and a profile may show: public fields only, camelCase, and never
 * a token or the session version.
 */
export const publicAccount = (row) => ({
  id: row.id,
  midesUserId: row.mides_user_id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  bannerUrl: row.banner_url,
  role: row.mides_role,
  createdAt: new Date(row.created_at).toISOString(),
});

/**
 * The account's own links (W9.1, W9.2), for `/me` only: whether Discord is
 * linked and DMs are on, and the osu! profile read at link time. The Discord
 * id itself is not sent: the page has no use for it.
 */
export const ownLinks = (row) => ({
  discord: { linked: Boolean(row.discord_id), notify: Boolean(row.discord_id && row.discord_notify) },
  osu: row.osu_user_id
    ? {
        id: Number(row.osu_user_id),
        username: row.osu_username,
        avatarUrl: row.osu_avatar_url,
        rankedCount: row.osu_ranked_count ?? null,
        linkedAt: row.osu_linked_at ? new Date(row.osu_linked_at).toISOString() : null,
      }
    : null,
});
