import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin, requireSession } from '../middlewares/session.js';
import { analyses } from '../services/analysis.service.js';
import { newPublicId } from '../services/community.service.js';
import { notify } from '../services/notification.service.js';
import { votes } from '../services/vote.service.js';
import { HttpError } from '../utils/http-error.js';
import { songNames } from '../utils/timings.js';
import { hasCorrection, isMapper, voteOf } from '../utils/votes.js';

/**
 * Votes on published timings (W13.14) and the mapper's badge (W13.16).
 *
 *   GET    /timings/:id/votes    the counts, your vote, the mappers who confirmed it
 *   PUT    /timings/:id/vote     { verdict: on|off, proposedBpm?, proposedOffsetMs?, trainingOk? }   signed in
 *   DELETE /timings/:id/vote
 *
 * The rules:
 *
 * - One vote per account (the store's unique index); a second is an edit.
 *   Not on your own timing (403 `OWN_TIMING`), as stars are not: a vote for
 *   yourself says nothing.
 * - "On time" carries nothing else. "Off" may propose a BPM (20-1000, three
 *   decimals) and/or an offset (whole ms inside the song); such a vote goes
 *   to the staff queue (routes/staff.routes.js). `trainingOk` is the voter's
 *   explicit permission for the correction to be used by the engine's stages
 *   (W11): stored, shown to staff, read by nothing yet.
 * - Who voted is not shown, except the mappers who confirmed it (W13.16): an
 *   account whose linked osu! profile had ranked maps, and only on "on time".
 *   The page says so beside the buttons, before anyone votes.
 * - The uploader hears of a vote through the bell (W13.17) without the
 *   voter's name, unless it is a mapper's confirmation, which the badge names
 *   anyway.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;

const readLimit = guard('votes', 240, 10 * 60_000);
const voteLimit = guard('timing-vote', 30, 10 * 60_000);

const notFound = () => new HttpError(404, 'No such timing.', 'NOT_FOUND');

/** The published timing `id`, or the same 404 as for one that never existed. */
const publishedTiming = async (id) => {
  if (!ID.test(id ?? '')) throw notFound();
  const row = await analyses().getPublished(id);
  if (!row) throw notFound();
  return row;
};

/** What anyone may read: counts, the mappers by their public names, and the reader's own vote. */
const summaryView = (s) => ({
  on: s.on,
  off: s.off,
  mine: s.mine,
  verified: s.verifierCount > 0,
  verifiers: s.verifiers.map((m) => ({
    username: m.username,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    osuUsername: m.osuUsername,
    rankedCount: m.rankedCount,
    // A private profile is a 404: the badge names them without the link.
    profile: m.profilePublic,
  })),
  verifierCount: s.verifierCount,
});

router.get('/timings/:id/votes', readLimit, optionalSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  const summary = await votes().summary(row.publicId, req.account?.id ?? null);
  res.set('Cache-Control', 'no-store');
  res.json({ ...summaryView(summary), own: Boolean(req.account && row.accountId === req.account.id) });
});

router.put('/timings/:id/vote', voteLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  if (row.accountId && row.accountId === req.account.id) throw new HttpError(403, 'This is your own timing.', 'OWN_TIMING');
  const vote = voteOf(req.body, Number(row.result?.duration_s));
  const { before, after } = await votes().cast(row.publicId, req.account.id, vote, newPublicId());
  const changed =
    !before || before.verdict !== after.verdict || before.proposedBpm !== after.proposedBpm || before.proposedOffsetMs !== after.proposedOffsetMs;
  if (changed) {
    const mapper = vote.verdict === 'on' && isMapper(req.account);
    // One notification per voter and timing, brought back to unread on a change.
    await notify(row.accountId, 'vote', `vote:${row.publicId}:${req.account.id}`, {
      timing: row.publicId,
      title: songNames(row).title ?? null,
      verdict: vote.verdict,
      proposedBpm: vote.proposedBpm,
      proposedOffsetMs: vote.proposedOffsetMs,
      ...(mapper ? { mapper: req.account.username } : {}),
    }, { actorId: req.account.id });
  }
  const summary = await votes().summary(row.publicId, req.account.id);
  res.json({ ...summaryView(summary), own: false, queued: hasCorrection(vote) });
});

router.delete('/timings/:id/vote', voteLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  await votes().remove(row.publicId, req.account.id);
  const summary = await votes().summary(row.publicId, req.account.id);
  res.json({ ...summaryView(summary), own: Boolean(row.accountId === req.account.id) });
});

export default router;
