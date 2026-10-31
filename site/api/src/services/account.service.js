import { randomUUID } from 'node:crypto';

import { hasDatabase, query } from '../config/database.js';
import { ACCENTS, storedLinks } from '../utils/profile.js';

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
  'discord_notify, osu_user_id, osu_username, osu_avatar_url, osu_ranked_count, osu_linked_at, profile_private, ' +
  'profile_about, profile_name, profile_links, profile_accent, profile_showcase, discord_username, ' +
  'osu_country, osu_global_rank, osu_country_rank, osu_pp, osu_accuracy, osu_play_count, osu_refreshed_at, mides_rank';

/** The osu! card's columns, empty: what unlinking leaves (services/links.service.js). */
export const OSU_EMPTY = {
  osu_user_id: null, osu_username: null, osu_avatar_url: null, osu_ranked_count: null, osu_linked_at: null,
  osu_country: null, osu_global_rank: null, osu_country_rank: null, osu_pp: null, osu_accuracy: null, osu_play_count: null,
  osu_refreshed_at: null,
};

/** The W9 and profile fields a new memory row starts with, as the table's defaults. */
const LINK_DEFAULTS = {
  discord_notify: false, discord_username: null, ...OSU_EMPTY,
  profile_about: null, profile_name: null, profile_links: {}, profile_accent: null, profile_showcase: [],
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
      profile_private: existing?.profile_private ?? false,
      mides_user_id: user.midesUserId,
      username: user.username,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
      banner_url: user.bannerUrl,
      discord_id: user.discordId ?? existing?.discord_id ?? null,
      // The name comes with the id or not at all: kept from before only when Mides sent no id.
      discord_username: user.discordId ? user.discordUsername ?? null : existing?.discord_username ?? null,
      mides_role: user.role,
      mides_rank: user.midesRank ?? null,
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
    `INSERT INTO accounts (mides_user_id, username, display_name, avatar_url, banner_url, discord_id, mides_role, discord_username, mides_rank)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (mides_user_id) DO UPDATE
             SET username = EXCLUDED.username,
                 display_name = EXCLUDED.display_name,
                 avatar_url = EXCLUDED.avatar_url,
                 banner_url = EXCLUDED.banner_url,
                 discord_id = coalesce(EXCLUDED.discord_id, accounts.discord_id),
                 discord_username = CASE WHEN EXCLUDED.discord_id IS NOT NULL THEN EXCLUDED.discord_username
                                         ELSE accounts.discord_username END,
                 mides_role = EXCLUDED.mides_role,
                 mides_rank = EXCLUDED.mides_rank,
                 cached_at = now()
       RETURNING ${COLUMNS}`,
    [user.midesUserId, user.username, user.displayName, user.avatarUrl, user.bannerUrl, user.discordId, user.role,
      user.discordId ? user.discordUsername ?? null : null, user.midesRank ?? null],
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
  displayName: shownName(row),
  midesDisplayName: row.display_name ?? null,
  avatarUrl: row.avatar_url,
  bannerUrl: row.banner_url,
  role: row.mides_role,
  createdAt: new Date(row.created_at).toISOString(),
  profilePrivate: Boolean(row.profile_private),
  accent: profileAccent(row),
});

/** The name a page shows: the one written on Overtone, else Mides'. */
export const shownName = (row) => row.profile_name || row.display_name || null;

export const profileAccent = (row) => (ACCENTS.includes(row.profile_accent) ? row.profile_accent : null);

const number = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The osu! card (W9.2 and the profile, 2026-10-28): what osu! said at link
 * time or at the last "Refresh", never read on a page view. `null` when no
 * osu! account is linked. The avatar URL is kept but not sent: the page does
 * not load images from osu!'s host (deploy/web/serve.mjs, img-src).
 */
export const osuCard = (row) =>
  row.osu_user_id
    ? {
        id: Number(row.osu_user_id),
        username: row.osu_username,
        url: `https://osu.ppy.sh/users/${Number(row.osu_user_id)}`,
        country: row.osu_country ?? null,
        globalRank: number(row.osu_global_rank),
        countryRank: number(row.osu_country_rank),
        pp: number(row.osu_pp),
        accuracy: number(row.osu_accuracy),
        playCount: number(row.osu_play_count),
        rankedCount: number(row.osu_ranked_count),
        linkedAt: iso(row.osu_linked_at),
        refreshedAt: iso(row.osu_refreshed_at ?? row.osu_linked_at),
      }
    : null;

/**
 * The account's own links (W9.1, W9.2), for `/me` only: whether Discord is
 * linked and DMs are on (with the Discord username when Mides sent one), and
 * the osu! card. The Discord id itself is not sent: the page has no use for it.
 */
export const ownLinks = (row) => ({
  discord: {
    linked: Boolean(row.discord_id),
    notify: Boolean(row.discord_id && row.discord_notify),
    username: row.discord_id ? row.discord_username ?? null : null,
  },
  osu: osuCard(row),
});

/** What the person wrote on their profile, as a page reads it. Links are re-read: a row edited by hand stays safe. */
export const profileFields = (row) => ({
  about: row.profile_about ?? null,
  displayName: row.profile_name ?? null,
  links: storedLinks(row.profile_links),
  accent: profileAccent(row),
  showcase: Array.isArray(row.profile_showcase) ? row.profile_showcase.map((id) => String(id).trim()) : [],
});

/**
 * Writes the fields of a profile edit (utils/profile.js `profileEdit`), only
 * those sent. Returns the row as it is now.
 */
export const setProfileFields = async (id, edit) => {
  const columns = {
    private: 'profile_private', about: 'profile_about', displayName: 'profile_name',
    links: 'profile_links', accent: 'profile_accent', showcase: 'profile_showcase',
  };
  const entries = Object.entries(edit).filter(([key]) => key in columns);
  if (!hasDatabase()) {
    const row = memory.accounts.get(id);
    if (!row) return null;
    for (const [key, value] of entries) row[columns[key]] = key === 'links' ? { ...value } : key === 'showcase' ? [...value] : value;
    return row;
  }
  if (!entries.length) return accountById(id);
  // Column names come from the fixed map above, never from the request.
  const sets = entries.map(([key], i) => `${columns[key]} = $${i + 2}${key === 'links' ? '::jsonb' : ''}`);
  const { rows } = await query(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, ...entries.map(([key, value]) => (key === 'links' ? JSON.stringify(value) : value))],
  );
  return rows[0] ?? null;
};

// ── Profiles (W5.6, W13.18) ─────────────────────────────────────────────────

/**
 * The account a public profile's URL names, by its Mides username in any
 * case, or null. The username is refreshed at every sign-in, so a name that
 * moved to another person on Mides can sit on two rows here until the old
 * holder signs in again: the most recently refreshed row is the one that
 * holds it now.
 */
export const accountByUsername = async (username) => {
  const wanted = String(username).toLowerCase();
  if (!hasDatabase()) {
    return (
      [...memory.accounts.values()]
        .filter((a) => a.username.toLowerCase() === wanted)
        .sort((a, b) => b.cached_at - a.cached_at)[0] ?? null
    );
  }
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM accounts WHERE lower(username) = $1 ORDER BY cached_at DESC LIMIT 1`,
    [wanted],
  );
  return rows[0] ?? null;
};

/** One account by id, or null. */
export const accountById = async (id) => {
  if (!id) return null;
  if (!hasDatabase()) return memory.accounts.get(id) ?? null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ?? null;
};

/**
 * The staff's account ids (W13.17's `staff` notifications): every account
 * whose last sign-in brought Mides' moderator role. A handful at most, so
 * read whole.
 */
export const staffIds = async () => {
  if (!hasDatabase()) return [...memory.accounts.values()].filter(isStaff).map((a) => a.id);
  const { rows } = await query(`SELECT id FROM accounts WHERE mides_role = 'moderator'`);
  return rows.map((r) => r.id);
};

/** The private-profile switch (W13.18). */
export const setProfilePrivate = async (id, on) => {
  if (!hasDatabase()) {
    const row = memory.accounts.get(id);
    if (row) row.profile_private = Boolean(on);
    return;
  }
  await query('UPDATE accounts SET profile_private = $2 WHERE id = $1', [id, Boolean(on)]);
};

/** For the social store's memory twin (services/social.service.js): the accounts as rows. */
export const memoryAccounts = () => memory.accounts;
