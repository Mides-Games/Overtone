import { createHmac, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin, requireSession } from '../middlewares/session.js';
import { isStaff } from '../services/account.service.js';
import { community, KINDS, newPublicId, PAGE_MAX, SORTS, STATES } from '../services/community.service.js';
import { notify, notifyStaff } from '../services/notification.service.js';
import { social } from '../services/social.service.js';
import { HttpError } from '../utils/http-error.js';
import { cleanText } from '../utils/text.js';
import { ipHashOf } from './analyses.routes.js';

/**
 * Community (W5.2-W5.4): suggestions, reviews, and the moderation they share.
 *
 *   GET    /community/suggestions                ?sort=votes|new&state=&offset=
 *   POST   /community/suggestions                { title, body }               signed in
 *   GET    /community/suggestions/:id            the suggestion and its state history
 *   PUT    /community/suggestions/:id/vote       one vote per account          signed in
 *   DELETE /community/suggestions/:id/vote
 *   POST   /community/suggestions/:id/state      { state, reason? }            staff
 *   GET    /community/reviews                    ?offset=  the average, the distribution, a page, and yours
 *   GET    /community/reviews/form               a form token, for the anonymous minimum time
 *   POST   /community/reviews                    { stars, body, token?, website? }
 *   DELETE /community/reviews/mine               signed in
 *   POST   /community/:kind/:id/report           { reason }                    anyone; kind is
 *                                                 suggestions, reviews or comments (a timing's, W6)
 *   POST   /community/:kind/:id/moderate         { action: hide|unhide, reason? } staff
 *   GET    /community/moderation                 staff: open reports and the log
 *
 * Posting a suggestion needs a Mides account; reading needs nothing. Anonymous
 * suggestions are not taken: a suggestion is a thread its author is expected
 * to follow (a state change answers them, a "rejected" says why), and votes
 * already need an account to mean anything, so an anonymous post would invite
 * spam with nobody to answer. A review is different: it is one opinion, so it
 * can be anonymous, held to a daily count per hashed address, a honeypot
 * field and a minimum time on the form instead of a third-party CAPTCHA (the
 * site calls no outside service).
 *
 * A hidden item is the same 404 as one that does not exist, for everyone but
 * staff and, for a suggestion, its own author. Text is cleaned of control and
 * bidi characters (utils/text.js) and refused, not cut, when it is too long:
 * a person's suggestion silently shortened would say something else.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const SUGGESTION_MAX = 4000;
export const REVIEW_MAX = 2000;
export const REASON_MAX = 500;
const OFFSET_MAX = 10_000;

// Per address, as every limit here; a person posting a suggestion every 20
// seconds for ten minutes is already more than this page is for.
const writeLimit = guard('suggest', 30, 10 * 60_000);
const voteLimit = guard('vote', 60, 10 * 60_000);
const reviewLimit = guard('review', 20, 10 * 60_000);
const reportLimit = guard('report', 20, 10 * 60_000);
const staffLimit = guard('community-staff', 120, 10 * 60_000);

const requireStaff = (req, _res, next) => {
  if (!isStaff(req.account)) return next(new HttpError(403, 'Only staff can do this.', 'STAFF_ONLY'));
  return next();
};

const notFound = () => new HttpError(404, 'Not found.', 'NOT_FOUND');

/** Cleaned text within `[min, max]` code points, or a 400 that names the field. Also the comments' (routes/social.routes.js). */
export const field =(raw, name, min, max, { multiline = false } = {}) => {
  // One past the cap survives cleaning, so "too long" can be told from "fits".
  const text = cleanText(raw, max + 1, { multiline });
  const length = text ? [...text].length : 0;
  if (length < min) throw new HttpError(400, `${name} needs at least ${min} characters.`, 'TOO_SHORT', { field: name, min });
  if (length > max) throw new HttpError(400, `${name} can have at most ${max} characters.`, 'TOO_LONG', { field: name, max });
  return text;
};

const reasonOf = (raw) => cleanText(raw, REASON_MAX);

const offsetOf = (raw) => {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= OFFSET_MAX ? n : 0;
};

const authorOf = (account) =>
  account ? { username: account.username, displayName: account.display_name, avatarUrl: account.avatar_url } : null;

const by = (req, reason) => ({ accountId: req.account.id, moderator: req.account.username, reason: reason ?? null });

const iso = (date) => new Date(date).toISOString();

/** What a reader may see of a suggestion: staff also get the hide reason and the open reports. */
const suggestionView = (s, req) => {
  const staff = isStaff(req.account);
  return {
    id: s.publicId,
    title: s.title,
    body: s.body,
    state: s.state,
    stateReason: s.stateReason ?? null,
    votes: s.votes,
    voted: Boolean(s.voted),
    author: s.author ?? null,
    mine: Boolean(req.account && s.accountId === req.account.id),
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
    ...(s.hidden ? { hidden: true } : {}),
    ...(staff ? { hiddenReason: s.hiddenReason ?? null, reports: s.reports ?? 0 } : {}),
  };
};

const reviewView = (r, req) => {
  const staff = isStaff(req.account);
  return {
    id: r.publicId,
    stars: r.stars,
    body: r.body,
    // An anonymous review shows no name at all, not even a placeholder made from its address.
    author: r.author ?? null,
    anonymous: !r.accountId,
    mine: Boolean(req.account && r.accountId === req.account.id),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    ...(r.hidden ? { hidden: true } : {}),
    ...(staff ? { hiddenReason: r.hiddenReason ?? null, reports: r.reports ?? 0 } : {}),
  };
};

/** The suggestion `:id` if this request may see it, else a 404. */
const visibleSuggestion = async (req) => {
  const { id } = req.params;
  if (!ID.test(id)) throw notFound();
  const s = await community().getSuggestion(id, { viewerId: req.account?.id ?? null });
  if (!s) throw notFound();
  if (s.hidden && !isStaff(req.account) && !(req.account && s.accountId === req.account.id)) throw notFound();
  return s;
};

// ── Suggestions ─────────────────────────────────────────────────────────────

router.get('/community/suggestions', optionalSession, async (req, res) => {
  const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'votes';
  const state = STATES.includes(req.query.state) ? req.query.state : null;
  const staff = isStaff(req.account);
  const offset = offsetOf(req.query.offset);
  const { items, total } = await community().listSuggestions({
    sort, state, staff, offset, limit: PAGE_MAX, viewerId: req.account?.id ?? null,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ items: items.map((s) => suggestionView(s, req)), total, offset, limit: PAGE_MAX, ...(staff ? { staff: true } : {}) });
});

router.post('/community/suggestions', writeLimit, requireSameOrigin, requireSession, async (req, res) => {
  const title = field(req.body?.title, 'title', TITLE_MIN, TITLE_MAX);
  const body = field(req.body?.body, 'body', 1, SUGGESTION_MAX, { multiline: true });
  const s = await community().createSuggestion({
    publicId: newPublicId(), accountId: req.account.id, author: authorOf(req.account), title, body,
  });
  res.status(201).json({ suggestion: suggestionView(s, req) });
});

router.get('/community/suggestions/:id', optionalSession, async (req, res) => {
  const s = await visibleSuggestion(req);
  const staff = isStaff(req.account);
  const history = (await community().history(s.publicId))
    // A state change is public; a hide or unhide is between staff.
    .filter((e) => staff || e.action === 'state')
    .map((e) => ({
      action: e.action, from: e.fromState ?? null, to: e.toState ?? null, reason: e.reason ?? null, moderator: e.moderator, at: iso(e.createdAt),
    }));
  res.set('Cache-Control', 'no-store');
  res.json({ suggestion: suggestionView(s, req), history });
});

const vote = (on) => async (req, res) => {
  const s = await visibleSuggestion(req);
  const votes = await community().vote(s.publicId, req.account.id, on);
  if (votes === null) throw notFound();
  res.json({ votes, voted: on });
};
router.put('/community/suggestions/:id/vote', voteLimit, requireSameOrigin, requireSession, vote(true));
router.delete('/community/suggestions/:id/vote', voteLimit, requireSameOrigin, requireSession, vote(false));

router.post('/community/suggestions/:id/state', staffLimit, requireSameOrigin, requireSession, requireStaff, async (req, res) => {
  const s = await visibleSuggestion(req);
  const to = req.body?.state;
  if (!STATES.includes(to)) throw new HttpError(400, `state is one of ${STATES.join(', ')}.`, 'BAD_STATE');
  if (to === s.state) throw new HttpError(409, `It is already ${to}.`, 'SAME_STATE');
  const reason = reasonOf(req.body?.reason);
  if (to === 'rejected' && !reason) throw new HttpError(400, 'A rejection needs a reason.', 'REASON_REQUIRED');
  const changed = await community().setState(s.publicId, { to, reason, by: by(req, reason) });
  if (!changed) throw notFound();
  // W13.17: its author hears of it; one notification per suggestion, the latest state.
  await notify(s.accountId, 'suggestion', `suggestion:${s.publicId}`, {
    suggestion: s.publicId, title: s.title, from: changed.from, to: changed.to, reason: reason ?? null,
  }, { actorId: req.account.id });
  res.json({ from: changed.from, to: changed.to });
});

// ── Reviews ─────────────────────────────────────────────────────────────────

/**
 * The anonymous form's minimum time: the page asks for a token when the form
 * opens, and a review sent with a token younger than MIN_FORM_MS (or older
 * than MAX_FORM_MS, or not made here) is refused. The token is the time it was
 * made and an HMAC of it under SESSION_SECRET, so no state is kept for it.
 * A script can wait too; this only makes each review cost it seconds, which
 * with the per-address daily count is the point.
 */
export const MIN_FORM_MS = 3_000;
export const MAX_FORM_MS = 6 * 3_600_000;

const sign = (issued) => createHmac('sha256', env.sessionSecret).update(`review-form:${issued}`).digest('base64url');

export const formToken = (issued = Date.now()) => `${issued}.${sign(issued)}`;

/** Whether `token` was made here between MAX_FORM_MS and MIN_FORM_MS ago. */
export const formTokenOk = (token, now = Date.now()) => {
  if (typeof token !== 'string' || token.length > 100) return false;
  const [issuedText, mac] = token.split('.');
  const issued = Number(issuedText);
  if (!Number.isSafeInteger(issued) || typeof mac !== 'string') return false;
  const expected = Buffer.from(sign(issued));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const age = now - issued;
  return age >= MIN_FORM_MS && age <= MAX_FORM_MS;
};

router.get('/community/reviews', optionalSession, async (req, res) => {
  const store = community();
  const staff = isStaff(req.account);
  const offset = offsetOf(req.query.offset);
  const [stats, page, mine] = await Promise.all([
    store.reviewStats(),
    store.listReviews({ staff, offset, limit: PAGE_MAX }),
    req.account ? store.ownReview(req.account.id) : null,
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    stats,
    items: page.items.map((r) => reviewView(r, req)),
    total: page.total,
    offset,
    limit: PAGE_MAX,
    mine: mine ? reviewView(mine, req) : null,
    ...(staff ? { staff: true } : {}),
  });
});

router.get('/community/reviews/form', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ token: formToken(), minMs: MIN_FORM_MS });
});

router.post('/community/reviews', reviewLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const input = req.body ?? {};
  // The honeypot: a field a person never sees (the page hides it and takes it
  // out of the tab order) and a form-filling script fills.
  if (typeof input.website === 'string' && input.website.trim()) {
    throw new HttpError(400, 'This review was not accepted.', 'NOT_ACCEPTED');
  }
  const stars = input.stars;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, 'stars is a whole number from 1 to 5.', 'BAD_STARS');
  const body = field(input.body, 'body', 1, REVIEW_MAX, { multiline: true });
  const store = community();

  if (req.account) {
    const { review, created } = await store.upsertOwnReview({
      publicId: newPublicId(), accountId: req.account.id, author: authorOf(req.account), stars, body,
    });
    return res.status(created ? 201 : 200).json({ review: reviewView(review, req) });
  }

  if (!formTokenOk(input.token)) {
    throw new HttpError(400, 'The form expired or was sent too fast. Reload the page and try again.', 'FORM_TOO_FAST');
  }
  const review = await store.createAnonReview({ publicId: newPublicId(), ipHash: ipHashOf(req), stars, body });
  return res.status(201).json({ review: reviewView(review, req) });
});

router.delete('/community/reviews/mine', reviewLimit, requireSameOrigin, requireSession, async (req, res) => {
  if (!(await community().deleteOwnReview(req.account.id))) throw notFound();
  res.status(204).end();
});

// ── Moderation, shared ──────────────────────────────────────────────────────

const KIND_OF = { suggestions: 'suggestion', reviews: 'review', comments: 'comment' };

/**
 * The item `:kind/:id` if this request may see it (as `visibleSuggestion`),
 * else a 404. A comment (W6, routes/social.routes.js) is also a 404 while its
 * timing is not published: nobody can see it then, so nobody reports it.
 */
const visibleItem = async (req) => {
  const kind = KIND_OF[req.params.kind];
  if (!kind || !KINDS.includes(kind)) throw notFound();
  if (kind === 'suggestion') return { kind, item: await visibleSuggestion(req) };
  if (!ID.test(req.params.id)) throw notFound();
  const item = kind === 'review' ? await community().getReview(req.params.id) : await social().getComment(req.params.id);
  if (!item || (kind === 'comment' && !item.timingPublished)) throw notFound();
  if (item.hidden && !isStaff(req.account) && !(req.account && item.accountId === req.account.id)) throw notFound();
  return { kind, item };
};

/**
 * Anyone may report, signed in or not: the report is what tells staff to
 * look. A second report from the same person on the same item is a no-op, so
 * a report button pressed twice counts once.
 */
router.post('/community/:kind/:id/report', reportLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const { kind, item } = await visibleItem(req);
  const reason = field(req.body?.reason, 'reason', 1, REASON_MAX);
  const added = await community().report(kind, item.publicId, { accountId: req.account?.id ?? null, ipHash: ipHashOf(req), reason });
  // W13.17: staff hear of it, one notification per reported item; never who or why.
  if (added) await notifyStaff(`staff:report:${kind}:${item.publicId}`, { item: 'report', kind }, { actorId: req.account?.id ?? null });
  res.status(204).end();
});

router.post('/community/:kind/:id/moderate', staffLimit, requireSameOrigin, requireSession, requireStaff, async (req, res) => {
  const { kind, item } = await visibleItem(req);
  const action = req.body?.action;
  if (action !== 'hide' && action !== 'unhide') throw new HttpError(400, 'action is hide or unhide.', 'BAD_ACTION');
  const reason = reasonOf(req.body?.reason);
  if (action === 'hide' && !reason) throw new HttpError(400, 'Hiding needs a reason.', 'REASON_REQUIRED');
  const changed = await community().setHidden(kind, item.publicId, { hidden: action === 'hide', by: by(req, reason) });
  if (changed === null) throw notFound();
  if (!changed) throw new HttpError(409, action === 'hide' ? 'It is hidden already.' : 'It is not hidden.', 'NO_CHANGE');
  res.status(204).end();
});

/** A comment's timing, so staff can open the page it sits on; null once the comment is gone. */
const timingOfComment = async (kind, ref) => (kind === 'comment' ? ((await social().getComment(ref))?.timingId ?? null) : undefined);

router.get('/community/moderation', requireSession, requireStaff, async (_req, res) => {
  const store = community();
  const [log, reports] = await Promise.all([store.moderationLog(), store.openReportList()]);
  res.set('Cache-Control', 'no-store');
  res.json({
    log: await Promise.all(log.map(async (e) => ({
      action: e.action, kind: e.kind, ref: e.ref, from: e.fromState ?? null, to: e.toState ?? null,
      moderator: e.moderator, reason: e.reason ?? null, at: iso(e.createdAt),
      ...(e.kind === 'comment' ? { timing: await timingOfComment(e.kind, e.ref) } : {}),
    }))),
    reports: await Promise.all(reports.map(async (r) => ({
      kind: r.kind, ref: r.ref, count: r.count, reasons: r.reasons, at: iso(r.latestAt),
      ...(r.kind === 'comment' ? { timing: await timingOfComment(r.kind, r.ref) } : {}),
    }))),
  });
});

export default router;
