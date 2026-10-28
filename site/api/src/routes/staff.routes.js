import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin } from '../middlewares/session.js';
import { isStaff } from '../services/account.service.js';
import { analyses, failureCode } from '../services/analysis.service.js';
import { community, LOG_LIMIT, STAFF_LOG_KINDS } from '../services/community.service.js';
import { social } from '../services/social.service.js';
import { votes } from '../services/vote.service.js';
import { HttpError } from '../utils/http-error.js';
import { queueEntry } from '../utils/queue.js';
import { cleanText } from '../utils/text.js';
import { mainBpm, songNames } from '../utils/timings.js';
import { CORRECTIONS_PAGE, REVIEW_ACTIONS, REVIEW_STATES } from '../utils/votes.js';
import { workerMemory, workerStatus } from '../utils/worker-status.js';
import { estimateQueue } from '../utils/estimate.js';

/**
 * The staff panel (W13.19): one page for what Mides moderators look after.
 *
 *   GET  /staff/overview            the queue and the worker, recent failures, open reports,
 *                                   the moderation log and the counts awaiting review
 *   GET  /staff/corrections         ?state=pending|accepted|dismissed&offset=   votes with a correction (W13.14)
 *   POST /staff/corrections/:id     { action: accept|dismiss, reason? }
 *
 * Staff only, and for anyone else the same 404 as a route that does not
 * exist, signed in or not: the panel's existence is nobody else's business
 * (the community's older staff routes answer 403 STAFF_ONLY; this one
 * does not need to say anything to a non-moderator).
 *
 * Read-only but for the corrections: removing or requeueing a job stays on
 * the queue's own route (`/analyses/:id/moderate`), hiding on the
 * community's, so each action keeps one way in and one log line.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
const LIVE_SHOWN = 30;

const readLimit = guard('staff', 240, 10 * 60_000);
const writeLimit = guard('staff-write', 120, 10 * 60_000);

/** Staff pass; everyone else gets what an unknown route gets. */
const staffOnly = (req, _res, next) => {
  if (!isStaff(req.account)) return next(new HttpError(404, `No route for ${req.method} ${req.path}`, 'NOT_FOUND'));
  return next();
};

router.use('/staff', readLimit, optionalSession, staffOnly, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const iso = (date) => new Date(date).toISOString();

/** A comment's timing, so staff can open the page it sits on; null once the comment is gone. */
const timingOfComment = async (ref) => (await social().getComment(ref))?.timingId ?? null;

router.get('/staff/overview', async (_req, res) => {
  const now = Date.now();
  // The queue read fresh, not the public page's one-second snapshot: staff
  // reload this after acting, and it is read by few, seldom.
  const [queue, failures, reports, communityLog, queueLog, awaiting, corrections] = await Promise.all([
    analyses().queue().then((data) => ({ ...data, estimates: estimateQueue(data.live) })),
    analyses().recentFailures(),
    community().openReportList(),
    community().moderationLog(LOG_LIMIT, STAFF_LOG_KINDS),
    analyses().moderationLog(LOG_LIMIT),
    community().awaitingReview(),
    votes().pendingCount(),
  ]);
  const log = [
    ...communityLog.map((e) => ({
      action: e.action, kind: e.kind, ref: e.ref, from: e.fromState ?? null, to: e.toState ?? null,
      moderator: e.moderator, reason: e.reason ?? null, at: iso(e.createdAt),
    })),
    ...queueLog.map((e) => ({
      action: e.action, kind: 'analysis', ref: e.publicId, from: null, to: null, moderator: e.moderator, reason: e.reason ?? null, at: iso(e.createdAt),
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, LOG_LIMIT);
  const running = queue.live.filter((r) => r.status === 'running').length;
  const waiting = queue.live.filter((r) => r.status === 'queued').length + queue.more;
  const oldest = queue.live.filter((r) => r.status === 'queued').reduce((min, r) => Math.min(min, new Date(r.createdAt).getTime()), now);
  res.json({
    at: iso(now),
    queue: {
      running,
      waiting,
      oldestWaitS: waiting ? Math.round((now - oldest) / 1000) : null,
      live: queue.live
        .slice(0, LIVE_SHOWN)
        .map((row) => queueEntry(row, { staff: true, now, estimate: queue.estimates.get(row.publicId) })),
    },
    worker: { ...workerStatus(now), memory: workerMemory(now) },
    failures: failures.map((f) => ({
      ref: f.publicId,
      code: failureCode(f.error),
      message: f.error ?? null,
      mode: f.mode,
      audioSeconds: f.audioSeconds,
      at: iso(f.finishedAt),
    })),
    reports: await Promise.all(reports.map(async (r) => ({
      kind: r.kind, ref: r.ref, count: r.count, reasons: r.reasons, at: iso(r.latestAt),
      ...(r.kind === 'comment' ? { timing: await timingOfComment(r.ref) } : {}),
    }))),
    log,
    awaiting: { ...awaiting, corrections },
  });
});

const offsetOf = (raw) => {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
};

const correctionView = (v) => ({
  id: v.publicId,
  timing: {
    id: v.timing.publicId,
    ...songNames(v.timing),
    bpm: mainBpm(v.timing.result),
    offsetMs: Number.isFinite(v.timing.result?.offset_ms) ? v.timing.result.offset_ms : null,
  },
  voter: v.voter ?? null,
  verdict: v.verdict,
  proposedBpm: v.proposedBpm ?? null,
  proposedOffsetMs: v.proposedOffsetMs ?? null,
  trainingOk: Boolean(v.trainingOk),
  state: v.reviewState,
  reviewedBy: v.reviewedBy ?? null,
  reviewedAt: v.reviewedAt ? iso(v.reviewedAt) : null,
  at: iso(v.updatedAt),
});

router.get('/staff/corrections', async (req, res) => {
  const state = REVIEW_STATES.includes(req.query.state) ? req.query.state : 'pending';
  const offset = offsetOf(req.query.offset);
  const { items, total } = await votes().corrections({ state, offset, limit: CORRECTIONS_PAGE });
  res.json({ state, items: items.map(correctionView), total, offset, limit: CORRECTIONS_PAGE });
});

router.post('/staff/corrections/:id', writeLimit, requireSameOrigin, async (req, res) => {
  if (!ID.test(req.params.id)) throw new HttpError(404, 'No such correction.', 'NOT_FOUND');
  const to = REVIEW_ACTIONS[req.body?.action];
  if (!to) throw new HttpError(400, 'action is accept or dismiss.', 'BAD_ACTION');
  const reason = cleanText(req.body?.reason, 500);
  const done = await votes().review(req.params.id, to, { accountId: req.account.id, moderator: req.account.username, reason });
  if (done === null || done === false) throw new HttpError(404, 'No such correction.', 'NOT_FOUND');
  if (done.from === to) throw new HttpError(409, `It is already ${to}.`, 'NO_CHANGE');
  res.json(done);
});

export default router;
