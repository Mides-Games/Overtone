import { hasDatabase, pool, query } from '../config/database.js';
import { CORRECTIONS_PAGE, isMapper, sameCorrection, VERIFIERS_SHOWN } from '../utils/votes.js';
import { memoryAccounts } from './account.service.js';
import { LIST_COLS, listRow, memoryAnalyses, PUBLISHED } from './analysis.service.js';
import { memoryLogEntry } from './community.service.js';

/**
 * Votes on published timings (W13.14) and the mapper's badge (W13.16).
 *
 * One vote per account and timing (`timing_votes_once`): "on" or "off", and
 * an "off" may carry a proposed BPM and/or offset. A vote with a correction
 * waits in the staff queue (`review_state` pending) until staff accept or
 * dismiss it, and the decision goes to `moderation_log` (kind `vote`) in the
 * same transaction. `training_ok` is the voter's own permission for the
 * correction to be used as data by the engine's stages (W11): it is stored
 * and shown to staff, and nothing reads it yet.
 *
 * Who voted is not public: a timing's page shows the counts, and names only
 * the mappers (W13.16) who said "on time", since a confirmation that names
 * nobody would be worth nothing. Staff see the voter of a correction.
 *
 * Only published timings count, as everything social does: a vote on a
 * timing its uploader took back stays stored, unseen, and counts again if it
 * comes back; a deleted analysis takes its votes with it.
 */

const publishedRow = (a) => a.publishedAt && !a.deletedAt && a.status === 'done';

const person = (r) => (r?.username ? { username: r.username, displayName: r.display_name ?? null, avatarUrl: r.avatar_url ?? null } : null);

/** A mapper as the badge names them: their site name and what osu! said at link time. */
const mapperOf = (r) => ({
  ...person(r),
  osuUsername: r.osu_username ?? null,
  rankedCount: Number(r.osu_ranked_count ?? 0),
  profilePublic: !r.profile_private,
});

/** What a voter sees of their own vote. */
const mineOf = (v) =>
  v && {
    verdict: v.verdict,
    proposedBpm: v.proposedBpm ?? null,
    proposedOffsetMs: v.proposedOffsetMs ?? null,
    trainingOk: Boolean(v.trainingOk),
    reviewState: v.reviewState ?? null,
  };

// ── In memory ───────────────────────────────────────────────────────────────

/** timing id -> account id -> vote */
const memory = new Map();
let seq = 0;

/** For the tests: start from nothing. */
export const resetVoteMemory = () => memory.clear();

const memoryTiming = (id) => {
  for (const a of memoryAnalyses()) if (a.publicId === id) return a;
  return null;
};

const memoryStore = {
  async cast(timingId, accountId, vote, publicId) {
    const byAccount = memory.get(timingId) ?? new Map();
    memory.set(timingId, byAccount);
    const before = byAccount.get(accountId) ?? null;
    const now = new Date();
    const correction = vote.proposedBpm !== null || vote.proposedOffsetMs !== null;
    const keep = correction && before && sameCorrection(before, vote);
    byAccount.set(accountId, {
      publicId: before?.publicId ?? publicId,
      accountId,
      timingId,
      ...vote,
      reviewState: correction ? (keep ? before.reviewState : 'pending') : null,
      reviewedBy: keep ? before.reviewedBy : null,
      reviewedAt: keep ? before.reviewedAt : null,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      seq: before?.seq ?? ++seq,
    });
    return { before: mineOf(before), after: mineOf(byAccount.get(accountId)) };
  },

  async remove(timingId, accountId) {
    return Boolean(memory.get(timingId)?.delete(accountId));
  },

  async summary(timingId, viewerId) {
    const votes = [...(memory.get(timingId)?.values() ?? [])];
    const accounts = memoryAccounts();
    const mappers = votes
      .filter((v) => v.verdict === 'on' && isMapper(accounts.get(v.accountId)))
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    return {
      on: votes.filter((v) => v.verdict === 'on').length,
      off: votes.filter((v) => v.verdict === 'off').length,
      mine: mineOf(viewerId ? votes.find((v) => v.accountId === viewerId) : null) ?? null,
      verifiers: mappers.slice(0, VERIFIERS_SHOWN).map((v) => mapperOf(accounts.get(v.accountId))),
      verifierCount: mappers.length,
    };
  },

  async verifiedMany(ids) {
    const accounts = memoryAccounts();
    return new Set(
      ids.filter((id) => [...(memory.get(id)?.values() ?? [])].some((v) => v.verdict === 'on' && isMapper(accounts.get(v.accountId)))),
    );
  },

  async corrections({ state = 'pending', offset = 0, limit = CORRECTIONS_PAGE } = {}) {
    const rows = [];
    for (const [timingId, byAccount] of memory) {
      const timing = memoryTiming(timingId);
      if (!timing || !publishedRow(timing)) continue;
      for (const v of byAccount.values()) if (v.reviewState && v.reviewState === state) rows.push({ v, timing });
    }
    rows.sort((x, y) => y.v.updatedAt - x.v.updatedAt || y.v.seq - x.v.seq);
    const accounts = memoryAccounts();
    return {
      total: rows.length,
      items: rows.slice(offset, offset + limit).map(({ v, timing }) => ({
        ...v,
        voter: person(accounts.get(v.accountId)),
        timing: { ...timing },
      })),
    };
  },

  async review(publicId, to, by) {
    for (const byAccount of memory.values()) {
      for (const v of byAccount.values()) {
        if (v.publicId !== publicId) continue;
        if (!v.reviewState) return false;
        const from = v.reviewState;
        if (from === to) return { from, to };
        Object.assign(v, { reviewState: to, reviewedBy: by.moderator, reviewedAt: new Date() });
        memoryLogEntry({ action: to === 'accepted' ? 'accept' : 'dismiss', kind: 'vote', ref: publicId, fromState: from, toState: to, ...by });
        return { from, to };
      }
    }
    return null;
  },

  async pendingCount() {
    let n = 0;
    for (const [timingId, byAccount] of memory) {
      const timing = memoryTiming(timingId);
      if (!timing || !publishedRow(timing)) continue;
      for (const v of byAccount.values()) if (v.reviewState === 'pending') n += 1;
    }
    return n;
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

const ANALYSIS = (param) => `(SELECT id FROM analyses WHERE public_id = ${param})`;

const fromVote = (r) =>
  r && {
    publicId: r.public_id.trim(),
    accountId: r.account_id,
    verdict: r.verdict,
    proposedBpm: r.proposed_bpm === null ? null : Number(r.proposed_bpm),
    proposedOffsetMs: r.proposed_offset_ms,
    trainingOk: r.training_ok,
    reviewState: r.review_state,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const VOTE_COLS = `v.public_id, v.account_id, v.verdict, v.proposed_bpm, v.proposed_offset_ms, v.training_ok,
                   v.review_state, v.reviewed_by, v.reviewed_at, v.created_at, v.updated_at`;

const pgStore = {
  async cast(timingId, accountId, vote, publicId) {
    return transaction(async (client) => {
      const { rows: [before] } = await client.query(
        `SELECT ${VOTE_COLS} FROM timing_votes v WHERE v.analysis_id = ${ANALYSIS('$1')} AND v.account_id = $2 FOR UPDATE`,
        [timingId, accountId],
      );
      const old = fromVote(before);
      const correction = vote.proposedBpm !== null || vote.proposedOffsetMs !== null;
      const keep = correction && old && sameCorrection(old, vote);
      // timing_votes_once is the one-vote rule: a second vote is an edit.
      const { rows: [after] } = await client.query(
        `INSERT INTO timing_votes AS v (public_id, analysis_id, account_id, verdict, proposed_bpm, proposed_offset_ms, training_ok, review_state)
              VALUES ($1, ${ANALYSIS('$2')}, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (analysis_id, account_id) DO UPDATE
               SET verdict = EXCLUDED.verdict, proposed_bpm = EXCLUDED.proposed_bpm,
                   proposed_offset_ms = EXCLUDED.proposed_offset_ms, training_ok = EXCLUDED.training_ok,
                   review_state = CASE WHEN $9::boolean THEN v.review_state ELSE EXCLUDED.review_state END,
                   reviewed_by = CASE WHEN $9::boolean THEN v.reviewed_by END,
                   reviewed_at = CASE WHEN $9::boolean THEN v.reviewed_at END,
                   updated_at = now()
         RETURNING ${VOTE_COLS}`,
        [publicId, timingId, accountId, vote.verdict, vote.proposedBpm, vote.proposedOffsetMs, vote.trainingOk,
          correction ? 'pending' : null, Boolean(keep)],
      );
      return { before: mineOf(old), after: mineOf(fromVote(after)) };
    });
  },

  async remove(timingId, accountId) {
    const { rowCount } = await query(
      `DELETE FROM timing_votes WHERE analysis_id = ${ANALYSIS('$1')} AND account_id = $2`,
      [timingId, accountId],
    );
    return rowCount > 0;
  },

  async summary(timingId, viewerId) {
    const [{ rows: [n] }, { rows: mine }, { rows: mappers }] = await Promise.all([
      query(
        `SELECT count(*) FILTER (WHERE verdict = 'on')::int AS on_count, count(*) FILTER (WHERE verdict = 'off')::int AS off_count
           FROM timing_votes WHERE analysis_id = ${ANALYSIS('$1')}`,
        [timingId],
      ),
      viewerId
        ? query(`SELECT ${VOTE_COLS} FROM timing_votes v WHERE v.analysis_id = ${ANALYSIS('$1')} AND v.account_id = $2`, [timingId, viewerId])
        : { rows: [] },
      query(
        `SELECT acc.username, acc.display_name, acc.avatar_url, acc.osu_username, acc.osu_ranked_count, acc.profile_private,
                count(*) OVER () AS total
           FROM timing_votes v JOIN accounts acc ON acc.id = v.account_id
          WHERE v.analysis_id = ${ANALYSIS('$1')} AND v.verdict = 'on' AND acc.osu_ranked_count > 0
          ORDER BY v.created_at, v.id LIMIT $2`,
        [timingId, VERIFIERS_SHOWN],
      ),
    ]);
    return {
      on: n.on_count,
      off: n.off_count,
      mine: mineOf(fromVote(mine[0])) ?? null,
      verifiers: mappers.map(mapperOf),
      verifierCount: mappers.length ? Number(mappers[0].total) : 0,
    };
  },

  async verifiedMany(ids) {
    if (!ids.length) return new Set();
    const { rows } = await query(
      `SELECT DISTINCT a.public_id FROM timing_votes v
         JOIN analyses a ON a.id = v.analysis_id
         JOIN accounts acc ON acc.id = v.account_id
        WHERE a.public_id = ANY($1::bpchar[]) AND v.verdict = 'on' AND acc.osu_ranked_count > 0`,
      [ids],
    );
    return new Set(rows.map((r) => r.public_id.trim()));
  },

  async corrections({ state = 'pending', offset = 0, limit = CORRECTIONS_PAGE } = {}) {
    const { rows } = await query(
      `SELECT ${VOTE_COLS}, ${LIST_COLS},
              voter.username AS voter_username, voter.display_name AS voter_display_name, voter.avatar_url AS voter_avatar_url,
              count(*) OVER () AS total
         FROM timing_votes v
         JOIN analyses a ON a.id = v.analysis_id
         LEFT JOIN accounts u ON u.id = a.account_id
         LEFT JOIN accounts voter ON voter.id = v.account_id
        WHERE v.review_state = $1 AND ${PUBLISHED}
        ORDER BY v.updated_at DESC, v.id DESC
        LIMIT $2 OFFSET $3`,
      [state, limit, offset],
    );
    return {
      total: rows.length ? Number(rows[0].total) : 0,
      items: rows.map((r) => ({
        ...fromVote(r),
        voter: r.voter_username ? { username: r.voter_username, displayName: r.voter_display_name, avatarUrl: r.voter_avatar_url } : null,
        timing: listRow(r),
      })),
    };
  },

  async review(publicId, to, by) {
    return transaction(async (client) => {
      const { rows: [row] } = await client.query('SELECT review_state FROM timing_votes WHERE public_id = $1 FOR UPDATE', [publicId]);
      if (!row) return null;
      if (!row.review_state) return false;
      if (row.review_state === to) return { from: to, to };
      await client.query(
        'UPDATE timing_votes SET review_state = $2, reviewed_by = $3, reviewed_at = now() WHERE public_id = $1',
        [publicId, to, by.moderator],
      );
      await client.query(
        `INSERT INTO moderation_log (account_id, moderator, action, target_kind, target_ref, from_state, to_state, reason)
              VALUES ($1, $2, $3, 'vote', $4, $5, $6, $7)`,
        [by.accountId, by.moderator, to === 'accepted' ? 'accept' : 'dismiss', publicId, row.review_state, to, by.reason ?? null],
      );
      return { from: row.review_state, to };
    });
  },

  async pendingCount() {
    const { rows: [n] } = await query(
      `SELECT count(*)::int AS n FROM timing_votes v JOIN analyses a ON a.id = v.analysis_id
        WHERE v.review_state = 'pending' AND ${PUBLISHED}`,
    );
    return n.n;
  },
};

export const votes = () => (hasDatabase() ? pgStore : memoryStore);
