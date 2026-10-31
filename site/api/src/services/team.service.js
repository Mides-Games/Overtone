import { hasDatabase, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';
import { accountByUsername, isStaff, memoryAccounts, shownName } from './account.service.js';
import { MIDES_RANKS } from './mides.service.js';

/**
 * The team (/team and /testers, 2026-10-31): who looks after Overtone.
 *
 * Two kinds of rank, kept apart on purpose:
 *
 *   Mides Projects   owner, admin, moderator. Mides gives them; each sign-in
 *                    brings the current one (`accounts.mides_rank`). Shown
 *                    here, never changed here.
 *   Overtone         developer (shown with the staff), and tester, translator,
 *                    contributor (the testers' page). Given and taken on
 *                    /staff by Mides staff, to accounts that signed in here.
 *
 * A Mides staff member who also holds an Overtone rank is "Overtone related".
 */

/** Overtone's ranks and the page each one is listed on. */
export const OVERTONE_RANKS = {
  developer: 'staff',
  tester: 'testers',
  translator: 'testers',
  contributor: 'testers',
};

const memory = { ranks: new Map() };

/** For the tests: a clean slate. */
export const resetTeam = () => memory.ranks.clear();

const member = (row, rank) => ({
  username: row.username,
  displayName: shownName(row),
  avatarUrl: row.avatar_url ?? null,
  midesRank: isStaff(row) ? (MIDES_RANKS.includes(row.mides_rank) ? row.mides_rank : 'moderator') : null,
  overtoneRank: rank?.rank ?? null,
  overtoneRelated: Boolean(rank?.rank),
  // A private profile is listed (a rank is public), but its page is not linked.
  profile: !row.profile_private,
  since: rank?.granted_at ? new Date(rank.granted_at).toISOString() : null,
});

const byMidesRank = (a, b) =>
  MIDES_RANKS.indexOf(a.midesRank) - MIDES_RANKS.indexOf(b.midesRank) || a.username.localeCompare(b.username);
const byName = (a, b) => a.username.localeCompare(b.username);

/** Every account with a Mides staff rank or an Overtone rank, with both. */
const rows = async () => {
  if (!hasDatabase()) {
    return [...memoryAccounts().values()]
      .map((row) => ({ row, rank: memory.ranks.get(row.id) ?? null }))
      .filter(({ row, rank }) => isStaff(row) || rank);
  }
  const { rows: found } = await query(
    `SELECT a.id, a.username, a.display_name, a.profile_name, a.avatar_url, a.profile_private, a.mides_role, a.mides_rank,
            r.rank, r.granted_at
       FROM accounts a
       LEFT JOIN overtone_ranks r ON r.account_id = a.id
      WHERE a.mides_role = 'moderator' OR r.rank IS NOT NULL`,
  );
  return found.map((row) => ({ row, rank: row.rank ? { rank: row.rank, granted_at: row.granted_at } : null }));
};

/** What /team answers: the Mides staff, Overtone's staff and its testers. */
export const teamView = async () => {
  const all = (await rows()).map(({ row, rank }) => member(row, rank));
  return {
    mides: all.filter((m) => m.midesRank).sort(byMidesRank),
    staff: all.filter((m) => OVERTONE_RANKS[m.overtoneRank] === 'staff').sort(byName),
    testers: all.filter((m) => OVERTONE_RANKS[m.overtoneRank] === 'testers').sort(byName),
  };
};

/** One account's Overtone rank, or null (for its profile). */
export const overtoneRankOf = async (accountId) => {
  if (!hasDatabase()) return memory.ranks.get(accountId)?.rank ?? null;
  const { rows: found } = await query('SELECT rank FROM overtone_ranks WHERE account_id = $1', [accountId]);
  return found[0]?.rank ?? null;
};

/**
 * Gives `rank` to the account named `username`, or takes its rank when
 * `rank` is null. Only Overtone's ranks: a Mides rank is not this site's to give.
 */
export const setOvertoneRank = async (username, rank, by) => {
  if (rank !== null && !Object.hasOwn(OVERTONE_RANKS, rank)) {
    throw new HttpError(400, `rank is one of ${Object.keys(OVERTONE_RANKS).join(', ')}, or null.`, 'BAD_RANK');
  }
  const account = await accountByUsername(String(username ?? '').replace(/^@/, '').trim());
  if (!account) throw new HttpError(404, 'No Overtone account has that username. They must sign in here once first.', 'NO_ACCOUNT');

  if (!hasDatabase()) {
    if (rank === null) memory.ranks.delete(account.id);
    else memory.ranks.set(account.id, { rank, granted_by: by, granted_at: new Date() });
  } else if (rank === null) {
    await query('DELETE FROM overtone_ranks WHERE account_id = $1', [account.id]);
  } else {
    await query(
      `INSERT INTO overtone_ranks (account_id, rank, granted_by) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET rank = EXCLUDED.rank, granted_by = EXCLUDED.granted_by, granted_at = now()`,
      [account.id, rank, by],
    );
  }
  return member(account, rank ? { rank, granted_at: new Date() } : null);
};
