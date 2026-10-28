import { HttpError } from './http-error.js';

/**
 * Votes on published timings (W13.14) and the mapper's badge (W13.16): the
 * rules both stores and the routes share. Pure, so the tests reach them
 * without a server.
 */

/** "On time", or "off": the two answers a reader gives a timing. */
export const VERDICTS = ['on', 'off'];

/**
 * A proposed BPM is a tempo someone could time a map at: 20 to 1000, the
 * range osu! editors meet in practice (a 10 BPM ambient intro is timed at 20
 * or 40; past 1000 it is a typo). Kept to three decimals, as the red lines
 * the site exports are.
 */
export const BPM_MIN = 20;
export const BPM_MAX = 1000;

/**
 * A proposed offset is where the first red line should sit, in whole
 * milliseconds: from ten seconds before the song (a lead-in the engine
 * clipped) to its end.
 */
export const OFFSET_MIN = -10_000;

/** The staff queue's states for a vote that carries a correction. */
export const REVIEW_STATES = ['pending', 'accepted', 'dismissed'];
export const REVIEW_ACTIONS = { accept: 'accepted', dismiss: 'dismissed' };

/** The mappers a timing's page names on its badge; the count says how many more. */
export const VERIFIERS_SHOWN = 3;
export const CORRECTIONS_PAGE = 50;

const bad = (message) => new HttpError(400, message, 'BAD_VOTE');

/**
 * A vote from a request's body, validated: `{ verdict, proposedBpm,
 * proposedOffsetMs, trainingOk }`. "On time" carries nothing else (a
 * correction on it would be a contradiction, so it is refused rather than
 * dropped); "off" may carry a BPM, an offset, both or neither, and the
 * permission to use the correction for the W11 stages only when there is one
 * to use. `durationS` bounds the offset by the song's own length.
 */
export const voteOf = (body, durationS) => {
  const input = body && typeof body === 'object' ? body : {};
  const verdict = input.verdict;
  if (!VERDICTS.includes(verdict)) throw bad('verdict is "on" or "off".');
  const has = (key) => input[key] !== undefined && input[key] !== null && input[key] !== '';
  if (verdict === 'on') {
    if (has('proposedBpm') || has('proposedOffsetMs')) throw bad('An "on time" vote carries no correction.');
    if (input.trainingOk === true) throw bad('Only a correction can be shared.');
    return { verdict, proposedBpm: null, proposedOffsetMs: null, trainingOk: false };
  }
  let proposedBpm = null;
  if (has('proposedBpm')) {
    const n = input.proposedBpm;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < BPM_MIN || n > BPM_MAX) {
      throw bad(`proposedBpm is a number from ${BPM_MIN} to ${BPM_MAX}.`);
    }
    proposedBpm = Math.round(n * 1000) / 1000;
  }
  let proposedOffsetMs = null;
  if (has('proposedOffsetMs')) {
    const n = input.proposedOffsetMs;
    const end = Number.isFinite(durationS) && durationS > 0 ? Math.ceil(durationS * 1000) : 86_400_000;
    if (!Number.isInteger(n) || n < OFFSET_MIN || n > end) {
      throw bad(`proposedOffsetMs is whole milliseconds from ${OFFSET_MIN} to the song's end.`);
    }
    proposedOffsetMs = n;
  }
  if (input.trainingOk !== undefined && typeof input.trainingOk !== 'boolean') throw bad('trainingOk is true or false.');
  const correction = proposedBpm !== null || proposedOffsetMs !== null;
  if (input.trainingOk === true && !correction) throw bad('Only a correction can be shared.');
  return { verdict, proposedBpm, proposedOffsetMs, trainingOk: correction && input.trainingOk === true };
};

/** Whether a vote carries a correction for staff to look at. */
export const hasCorrection = (vote) => vote.proposedBpm !== null || vote.proposedOffsetMs !== null;

/**
 * W13.16: an account counts as a mapper when the osu! profile it linked
 * (W9.2) had ranked maps at link time. The number is osu!'s own, read once
 * through the `identify` scope; the site never asks osu! again.
 */
export const isMapper = (account) => Number(account?.osu_ranked_count ?? 0) > 0;

/**
 * Whether a vote edit changes what staff would review: a new or different
 * correction goes back to the queue as pending; the same one keeps its
 * decision (pressing "save" again must not undo a dismissal).
 */
export const sameCorrection = (a, b) =>
  Boolean(a) && Boolean(b) && a.proposedBpm === b.proposedBpm && a.proposedOffsetMs === b.proposedOffsetMs;
