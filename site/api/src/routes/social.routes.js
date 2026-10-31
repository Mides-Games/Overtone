import { createHmac } from 'node:crypto';

import { Router } from 'express';

import { env } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin, requireSession } from '../middlewares/session.js';
import {
  accountById,
  accountByUsername,
  isStaff,
  osuCard,
  profileFields,
  setProfileFields,
  shownName,
} from '../services/account.service.js';
import { analyses } from '../services/analysis.service.js';
import { newPublicId } from '../services/community.service.js';
import { midesSettingsUrl } from '../services/mides.service.js';
import { ACTIVITY_PAGE, activity, profileExtras } from '../services/profile.service.js';
import { social } from '../services/social.service.js';
import { overtoneRankOf } from '../services/team.service.js';
import { MIDES_RANKS } from '../services/mides.service.js';
import { utcDay, VISIT_DAYS, visits } from '../services/visit.service.js';
import { clientKey } from '../utils/client-ip.js';
import { HttpError } from '../utils/http-error.js';
import { profileEdit } from '../utils/profile.js';
import {
  atMsOf,
  averageOf,
  badgesOf,
  beatmapUrlOf,
  COLLECTION_NAME_MAX,
  COMMENT_MAX,
  COMMENTS_PAGE,
  MIN_RATINGS_TO_RANK,
  OFFSET_MAX,
  starsOf,
  USERNAME,
} from '../utils/social.js';
import { decodeOffset, encodeOffset, listFilters, recentEntry, songNames } from '../utils/timings.js';
import { notify } from '../services/notification.service.js';
import { field } from './community.routes.js';
import { listPage } from './timings.routes.js';

/**
 * Social v2 on published timings (W5.6, W6, W13.15, W13.18).
 *
 *   GET    /timings/:id/social                 stars (average, count, yours), uses (count, yours, the latest)
 *   PUT    /timings/:id/rating                 { stars }                  signed in, not the uploader
 *   DELETE /timings/:id/rating
 *   PUT    /timings/:id/use                    { beatmapUrl? }            signed in, not the uploader
 *   DELETE /timings/:id/use
 *   GET    /timings/:id/comments               ?offset=
 *   POST   /timings/:id/comments               { body, atMs? }            signed in
 *   DELETE /timings/:id/comments/:commentId    its author
 *   GET    /me/collections                     ?timing=  yours, and which hold that timing
 *   POST   /collections                        { name, public? }          signed in
 *   GET    /collections/:id                    a public one, or yours     ?cursor=
 *   PATCH  /collections/:id                    { name?, public? }         yours
 *   DELETE /collections/:id                    yours
 *   PUT    /collections/:id/items/:timingId    yours, a published timing
 *   DELETE /collections/:id/items/:timingId    yours
 *   GET    /users/:username                    a timer's public profile
 *   GET    /users/:username/timings            their published timings   ?sort=&cursor=
 *   GET    /users/:username/activity           their public activity     ?cursor=
 *   GET    /users/:username/card               a link preview's fields   (no session: private is a 404)
 *   POST   /users/:username/visit              the page counts a visit   (see "Profile visits" below)
 *   GET    /me/profile                         yours, private or not, with what you edit
 *   PUT    /me/profile                         { private?, about?, displayName?, links?, accent?, showcase? }
 *
 * The rules, in one place:
 *
 * - Everything hangs off a published timing. One that is not published (or
 *   never was) is the same 404 for every route, and so is everything on it.
 * - Stars and "I used this" need a Mides account and are one per account
 *   (the database's unique indexes are the rule; a second is an edit). The
 *   uploader can do neither on their own timing: their stars would be a vote
 *   for themselves and their use would make "used by others" a lie.
 * - A comment needs an account; its author deletes it, staff hide it through
 *   the community's moderation (`/community/comments/:id/report|moderate`),
 *   and a hidden one is seen only by staff and its author, as a hidden
 *   suggestion is.
 * - A collection is private until its owner makes it public. A private one,
 *   or one that is not yours, is the 404 of a missing one, for every route.
 * - A profile shows only what the person published, and a private profile
 *   is a 404 for everyone but its owner. Usernames are Mides' (ADR-W3).
 * - People are named by their Mides public fields only; no route here returns
 *   an address hash, an anonymous cookie's hash or an audio's hash.
 *
 * Every mutating route takes the same-origin header and a rate limit.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;

const readLimit = guard('social', 240, 10 * 60_000);
const rateLimit = guard('stars', 60, 10 * 60_000);
const useLimit = guard('use', 60, 10 * 60_000);
const commentLimit = guard('comment', 20, 10 * 60_000);
const collectionLimit = guard('collection', 120, 10 * 60_000);
const profileLimit = guard('profile', 30, 10 * 60_000);
const visitLimit = guard('visit', 120, 10 * 60_000);

const notFound = (what = 'Not found.') => new HttpError(404, what, 'NOT_FOUND');
const iso = (date) => new Date(date).toISOString();

/** The published timing `id`, or the same 404 as for one that never existed. */
const publishedTiming = async (id) => {
  if (!ID.test(id ?? '')) throw notFound('No such timing.');
  const row = await analyses().getPublished(id);
  if (!row) throw notFound('No such timing.');
  return row;
};

/** Not on your own timing: see the rules above. */
const notOwn = (row, req) => {
  if (row.accountId && row.accountId === req.account.id) {
    throw new HttpError(403, 'This is your own timing.', 'OWN_TIMING');
  }
};

// ── Stars and uses ──────────────────────────────────────────────────────────

const usesView = (uses) => ({
  count: uses.count,
  mine: uses.mine,
  recent: uses.recent.map((u) => ({ user: u.user, beatmapUrl: u.beatmapUrl, at: iso(u.at) })),
});

router.get('/timings/:id/social', readLimit, optionalSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  const viewer = req.account?.id ?? null;
  const [rating, uses, uploader] = await Promise.all([
    social().ratingOf(row.publicId, viewer),
    social().usesOf(row.publicId, viewer),
    accountById(row.accountId),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    rating,
    uses: usesView(uses),
    // Whether the uploader's name may link to their profile: a private one is a 404.
    uploaderProfile: Boolean(uploader && !uploader.profile_private),
    own: Boolean(viewer && row.accountId === viewer),
    minRatings: MIN_RATINGS_TO_RANK,
  });
});

router.put('/timings/:id/rating', rateLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  notOwn(row, req);
  const stars = starsOf(req.body?.stars);
  await social().rate(row.publicId, req.account.id, stars);
  res.json({ rating: await social().ratingOf(row.publicId, req.account.id) });
});

router.delete('/timings/:id/rating', rateLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  await social().rate(row.publicId, req.account.id, null);
  res.json({ rating: await social().ratingOf(row.publicId, req.account.id) });
});

router.put('/timings/:id/use', useLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  notOwn(row, req);
  const beatmapUrl = beatmapUrlOf(req.body?.beatmapUrl);
  const before = await social().usesOf(row.publicId, req.account.id, 0);
  await social().setUse(row.publicId, req.account.id, beatmapUrl);
  // W13.17: the first time only; changing the link is not news.
  if (!before.mine) {
    await notify(row.accountId, 'use', `use:${row.publicId}:${req.account.id}`, {
      timing: row.publicId, title: songNames(row).title ?? null, user: req.account.username,
    }, { actorId: req.account.id });
  }
  res.json({ uses: usesView(await social().usesOf(row.publicId, req.account.id)) });
});

router.delete('/timings/:id/use', useLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  await social().removeUse(row.publicId, req.account.id);
  res.json({ uses: usesView(await social().usesOf(row.publicId, req.account.id)) });
});

// ── Comments ────────────────────────────────────────────────────────────────

/** What a reader may see of a comment: staff also get the hide reason. Never an address or a hash. */
const commentView = (c, req) => ({
  id: c.publicId,
  body: c.body,
  atMs: c.atMs ?? null,
  author: c.author ?? null,
  mine: Boolean(req.account && c.accountId === req.account.id),
  createdAt: iso(c.createdAt),
  ...(c.hidden ? { hidden: true } : {}),
  ...(isStaff(req.account) ? { hiddenReason: c.hiddenReason ?? null } : {}),
});

const offsetOf = (raw) => {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
};

router.get('/timings/:id/comments', readLimit, optionalSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  const offset = offsetOf(req.query.offset);
  const staff = isStaff(req.account);
  const { items, total } = await social().listComments(row.publicId, {
    viewerId: req.account?.id ?? null, staff, offset, limit: COMMENTS_PAGE,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ items: items.map((c) => commentView(c, req)), total, offset, limit: COMMENTS_PAGE, ...(staff ? { staff: true } : {}) });
});

router.post('/timings/:id/comments', commentLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  const body = field(req.body?.body, 'body', 1, COMMENT_MAX, { multiline: true });
  const atMs = atMsOf(req.body?.atMs, Number(row.result?.duration_s));
  const comment = await social().addComment({ publicId: newPublicId(), timingId: row.publicId, accountId: req.account.id, body, atMs });
  // W13.17: who and where, not what: a comment staff hide later must not live on in a bell.
  await notify(row.accountId, 'comment', `comment:${comment.publicId}`, {
    timing: row.publicId, title: songNames(row).title ?? null, user: req.account.username, comment: comment.publicId, atMs,
  }, { actorId: req.account.id });
  res.status(201).json({ comment: commentView(comment, req) });
});

router.delete('/timings/:id/comments/:commentId', commentLimit, requireSameOrigin, requireSession, async (req, res) => {
  const row = await publishedTiming(req.params.id);
  const { commentId } = req.params;
  if (!ID.test(commentId)) throw notFound();
  const comment = await social().getComment(commentId);
  // Someone else's, or on another timing: the 404 of one that is not there.
  if (!comment || comment.timingId !== row.publicId || comment.accountId !== req.account.id) throw notFound();
  if (!(await social().deleteOwnComment(commentId, req.account.id))) throw notFound();
  res.status(204).end();
});

// ── Collections ─────────────────────────────────────────────────────────────

const collectionView = (c, req) => ({
  id: c.publicId,
  name: c.name,
  public: Boolean(c.isPublic),
  count: c.count,
  owner: c.owner,
  mine: Boolean(req.account && c.accountId === req.account.id),
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
  ...(c.has !== undefined ? { has: Boolean(c.has) } : {}),
});

const nameOf = (raw) => field(raw, 'name', 1, COLLECTION_NAME_MAX);

const publicFlag = (raw) => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new HttpError(400, 'public is true or false.', 'BAD_FLAG');
  return raw;
};

/** The collection `:id` if this request may read it: public, or the reader's own. Else a 404. */
const readableCollection = async (req) => {
  const { id } = req.params;
  if (!ID.test(id)) throw notFound();
  const c = await social().getCollection(id);
  if (!c || (!c.isPublic && !(req.account && c.accountId === req.account.id))) throw notFound();
  return c;
};

/** The collection `:id` if it is the signed-in account's own. Else the same 404. */
const ownCollection = async (req) => {
  const c = await readableCollection(req);
  if (c.accountId !== req.account.id) throw notFound();
  return c;
};

router.get('/me/collections', readLimit, requireSession, async (req, res) => {
  const timing = typeof req.query.timing === 'string' && ID.test(req.query.timing) ? req.query.timing : null;
  const rows = await social().ownCollections(req.account.id, { timingId: timing });
  res.set('Cache-Control', 'no-store');
  res.json({ collections: rows.map((c) => collectionView(c, req)) });
});

router.post('/collections', collectionLimit, requireSameOrigin, requireSession, async (req, res) => {
  const name = nameOf(req.body?.name);
  const isPublic = publicFlag(req.body?.public) ?? false;
  const c = await social().createCollection({ publicId: newPublicId(), accountId: req.account.id, name, isPublic });
  res.status(201).json({ collection: collectionView(c, req) });
});

router.get('/collections/:id', readLimit, optionalSession, async (req, res) => {
  const c = await readableCollection(req);
  const offset = decodeOffset(req.query.cursor);
  const { rows, next } = await social().collectionItems(c.publicId, { offset, limit: 50 });
  const stats = await social().statsFor(rows.map((r) => r.publicId));
  res.set('Cache-Control', 'no-store');
  res.json({
    collection: collectionView(c, req),
    timings: rows.map((r) => ({ ...recentEntry(r), ...(stats.get(r.publicId) ?? { rating: { average: null, count: 0 }, uses: 0 }) })),
    next,
  });
});

router.patch('/collections/:id', collectionLimit, requireSameOrigin, requireSession, async (req, res) => {
  const c = await ownCollection(req);
  const change = {
    name: req.body?.name === undefined ? undefined : nameOf(req.body.name),
    isPublic: publicFlag(req.body?.public),
  };
  const updated = await social().updateCollection(c.publicId, change);
  if (!updated) throw notFound();
  res.json({ collection: collectionView(updated, req) });
});

router.delete('/collections/:id', collectionLimit, requireSameOrigin, requireSession, async (req, res) => {
  const c = await ownCollection(req);
  await social().deleteCollection(c.publicId);
  res.status(204).end();
});

router.put('/collections/:id/items/:timingId', collectionLimit, requireSameOrigin, requireSession, async (req, res) => {
  const c = await ownCollection(req);
  const row = await publishedTiming(req.params.timingId);
  const outcome = await social().addItem(c.publicId, row.publicId);
  if (!outcome) throw notFound();
  res.status(outcome === 'added' ? 201 : 200).json({ added: outcome === 'added' });
});

router.delete('/collections/:id/items/:timingId', collectionLimit, requireSameOrigin, requireSession, async (req, res) => {
  const c = await ownCollection(req);
  if (!ID.test(req.params.timingId)) throw notFound();
  // Not checked for being published: a timing its uploader took back can still be taken out.
  if (!(await social().removeItem(c.publicId, req.params.timingId))) throw notFound();
  res.status(204).end();
});

// ── Profiles (W5.6, W13.18) ─────────────────────────────────────────────────

/**
 * A timer's profile: their Mides public fields, their totals and badges, and
 * their public collections. `timed` counts the songs they analysed that were
 * never private (a private upload stays out even as a number); the rest
 * counts published timings only.
 */
/** The profile's ranks (/team): Mides Projects' (Mides gives it) and Overtone's (staff give it here). */
const ranksOf = async (account) => ({
  midesRank: isStaff(account) ? (MIDES_RANKS.includes(account.mides_rank) ? account.mides_rank : 'moderator') : null,
  overtoneRank: await overtoneRankOf(account.id),
});

const profileOf = async (account, req) => {
  const fields = profileFields(account);
  const [stats, collections, showcase, mostUsed] = await Promise.all([
    social().profileStats(account.id),
    social().publicCollectionsOf(account.id),
    showcaseOf(account, fields.showcase),
    listPage({ ...listFilters({ sort: 'used' }), accountId: account.id, limit: 1 }).then((page) => page.timings[0] ?? null),
  ]);
  const mine = Boolean(req.account && req.account.id === account.id);
  const visited = account.profile_private ? null : await visitsOf(account);
  const badges = badgesOf({ ...stats, rankedCount: Number(account.osu_ranked_count ?? 0) });
  const extras = await profileExtras(account, badges);
  return {
    user: {
      username: account.username,
      displayName: shownName(account),
      avatarUrl: account.avatar_url ?? null,
      bannerUrl: account.banner_url ?? null,
      about: fields.about,
      links: fields.links,
      accent: fields.accent,
      ...(await ranksOf(account)),
    },
    totals: {
      timed: stats.timed,
      published: stats.published,
      uses: stats.uses,
      rating: { average: averageOf(stats.ratingSum, stats.ratingCount), count: stats.ratingCount },
    },
    badges,
    badgeDates: extras.badgeDates,
    stats: { ...extras.stats, mostUsed },
    showcase,
    osu: osuCard(account),
    collections: collections.map((c) => collectionView(c, req)),
    // A private profile counts no visits and shows none, not even to its owner.
    visits: visited,
    mine,
    // The owner's own view adds what they edit: the switch, their own text
    // as written (the name before the fallback), and where Mides edits the rest.
    ...(mine
      ? {
          private: Boolean(account.profile_private),
          edit: { ...fields, midesDisplayName: account.display_name ?? null, midesSettingsUrl: midesSettingsUrl() },
        }
      : {}),
  };
};

/**
 * The pinned timings, in the owner's order, as the lists show them: only the
 * ids that are still the account's own published timings (one unpublished
 * since is skipped, not shown as a hole).
 */
const showcaseOf = async (account, ids) => {
  const rows = (await Promise.all(ids.map((id) => analyses().getPublished(id)))).filter((row) => row && row.accountId === account.id);
  if (!rows.length) return [];
  const stats = await social().statsFor(rows.map((row) => row.publicId));
  return rows.map((row) => ({ ...recentEntry(row), ...(stats.get(row.publicId) ?? {}) }));
};

/** A profile's activity rows as the page reads them: timings named as the lists name them. */
const activityView = async (rows) => {
  const timingIds = [...new Set(rows.filter((r) => ['published', 'used', 'verified'].includes(r.kind)).map((r) => r.ref))];
  const timings = new Map(
    (await Promise.all(timingIds.map((id) => analyses().getPublished(id))))
      .filter(Boolean)
      .map((row) => {
        const entry = recentEntry(row);
        return [row.publicId, { id: entry.id, title: entry.title, artist: entry.artist, bpm: entry.bpm }];
      }),
  );
  return rows
    .map((r) => {
      const base = { kind: r.kind, at: r.at.toISOString() };
      if (r.kind === 'review') return { ...base, stars: r.stars };
      if (r.kind === 'suggestion') return { ...base, suggestion: { id: r.ref, title: r.title, state: r.state } };
      const timing = timings.get(r.ref);
      return timing ? { ...base, timing } : null;
    })
    .filter(Boolean);
};

/** The account `:username` names, if this request may see its profile; else the 404 of a name nobody has. */
const visibleProfile = async (req) => {
  const { username } = req.params;
  if (!USERNAME.test(username ?? '')) throw notFound('No such profile.');
  const account = await accountByUsername(username);
  if (!account) throw notFound('No such profile.');
  if (account.profile_private && !(req.account && req.account.id === account.id)) throw notFound('No such profile.');
  return account;
};

router.get('/users/:username', readLimit, optionalSession, async (req, res) => {
  const account = await visibleProfile(req);
  res.set('Cache-Control', 'no-store');
  res.json(await profileOf(account, req));
});

router.get('/users/:username/timings', readLimit, optionalSession, async (req, res) => {
  const account = await visibleProfile(req);
  const filters = { ...listFilters(req.query), accountId: account.id };
  res.set('Cache-Control', 'no-store');
  res.json({ ...(await listPage(filters)), minRatings: MIN_RATINGS_TO_RANK });
});

router.get('/users/:username/activity', readLimit, optionalSession, async (req, res) => {
  const account = await visibleProfile(req);
  const offset = decodeOffset(req.query.cursor);
  const { rows, more } = await activity(account, { offset, limit: ACTIVITY_PAGE });
  res.set('Cache-Control', 'no-store');
  res.json({ items: await activityView(rows), next: more && offset + ACTIVITY_PAGE <= OFFSET_MAX ? encodeOffset(offset + ACTIVITY_PAGE) : null });
});

/**
 * What a link preview of /u/<username> says (deploy/web/serve.mjs writes it
 * into the page's Open Graph tags): the shown name, the start of the About
 * text and the published count. Never with a session, so a private profile is
 * the same 404 here as everywhere and gets no tags.
 */
router.get('/users/:username/card', readLimit, async (req, res) => {
  const { username } = req.params;
  if (!USERNAME.test(username ?? '')) throw notFound('No such profile.');
  const account = await accountByUsername(username);
  if (!account || account.profile_private) throw notFound('No such profile.');
  const stats = await social().profileStats(account.id);
  const about = profileFields(account).about;
  res.set('Cache-Control', 'no-store');
  res.json({
    username: account.username,
    displayName: shownName(account),
    about: about ? [...about.replace(/\s+/g, ' ')].slice(0, 160).join('') : null,
    published: stats.published,
  });
});

// ── Profile visits (2026-10-28) ─────────────────────────────────────────────

/**
 * What counts as a visit, in one place (services/visit.service.js stores it):
 *
 * - One visitor on one public profile on one UTC day. The visitor is the
 *   signed-in account or, without one, the client address (an IPv6 client's
 *   /64), each only as an HMAC under SESSION_SECRET salted with the day: the
 *   same person reloading is one visit, and the stored value cannot be turned
 *   back into an account or an address, nor linked to the next day's.
 * - The page asks for it with a POST once it has drawn the profile, never a
 *   GET: a link preview (deploy/web/serve.mjs reads /card), a crawler or a
 *   prefetch does not run the page, and a POST without the same-origin header
 *   is refused like every other write. A user agent that says it is a bot is
 *   not counted either.
 * - The owner looking at their own profile is not a visit, and a private
 *   profile counts nothing (it is the 404 of a missing one to everybody else).
 */
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless/i;

const visitorOf = (req, day) =>
  createHmac('sha256', env.sessionSecret)
    .update(`visit:${day}:${req.account ? `account:${req.account.id}` : `ip:${clientKey(req.ip)}`}`)
    .digest('hex');

/** The profile's visits as the page shows them: ever, and over the last VISIT_DAYS days. */
const visitsOf = async (account) => {
  const { total, recent } = await visits().of(account.id);
  return { total, recent, days: VISIT_DAYS };
};

router.post('/users/:username/visit', visitLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const account = await visibleProfile(req);
  const mine = Boolean(req.account && req.account.id === account.id);
  let counted = false;
  if (!mine && !account.profile_private && !BOT.test(req.get('User-Agent') ?? '')) {
    const day = utcDay();
    counted = await visits().record(account.id, visitorOf(req, day), day);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ counted, visits: account.profile_private ? null : await visitsOf(account) });
});

router.get('/me/profile', readLimit, requireSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await profileOf(req.account, req));
});

/**
 * The owner's edit: any of { private, about, displayName, links, accent,
 * showcase }, only those sent (utils/profile.js reads each). A pinned timing
 * must be one of the account's own published timings: anything else is the
 * 404 of a timing that is not there.
 */
router.put('/me/profile', profileLimit, requireSameOrigin, requireSession, async (req, res) => {
  const edit = profileEdit(req.body);
  if (edit.showcase) {
    const rows = await Promise.all(edit.showcase.map((id) => analyses().getPublished(id)));
    if (rows.some((row) => !row || row.accountId !== req.account.id)) throw notFound('No such timing of yours to pin.');
  }
  const row = await setProfileFields(req.account.id, edit);
  res.json({ private: Boolean(row.profile_private), ...profileFields(row) });
});

export default router;
