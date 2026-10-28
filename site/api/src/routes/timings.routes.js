import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin, requireSession } from '../middlewares/session.js';
import { analyses } from '../services/analysis.service.js';
import { social } from '../services/social.service.js';
import { votes } from '../services/vote.service.js';
import { HttpError } from '../utils/http-error.js';
import { MIN_RATINGS_TO_RANK } from '../utils/social.js';
import { historyEntry, listFilters, publicTiming, recentEntry } from '../utils/timings.js';
import { downloadName, timingCsv, timingText } from '../utils/upload.js';
import { readable } from './analyses.routes.js';

/**
 * Published timings (W3.27, W5.1) and a person's own history (W3.26).
 *
 *   POST   /analyses/:id/publish    the uploader makes a finished analysis public { makePublic? }
 *   DELETE /analyses/:id/publish    the uploader takes it back
 *   GET    /timings                 recent published timings from everyone: filters, an order
 *                                   (sort=new|rated|used, W6) and a cursor; each with its stars and uses
 *   GET    /timings/:id             one published timing, as anyone may see it
 *   GET    /timings/:id/card        the same without the result: a link preview's fields
 *   GET    /timings/:id/timing.txt  its [TimingPoints] block
 *   GET    /timings/:id/timing.csv  its red lines as CSV
 *   POST   /timings/:id/check       { sha1 } -> { match }: is the visitor's file this timing's audio?
 *   GET    /me/analyses             the signed-in account's analyses: filters and a cursor
 *
 * The privacy model, in one place:
 *
 * - Nothing is public until its uploader publishes it. Publishing is a press
 *   of a button on a finished analysis (status `done`: a refusal or a failure
 *   has no timing to share), never a default, and unpublishing undoes it.
 *   Anonymous uploaders may publish too, while their cookie lasts; the page
 *   then says "anonymous".
 * - A private analysis (W3.8) is not published by a plain publish: the API
 *   answers 409 PRIVATE, and the page asks. Publishing it with
 *   `makePublic: true` lifts the privacy in the same statement. Unpublishing
 *   does not make it private again: privacy is about the live queue, which
 *   only shows the last hour, and nothing there depends on it any more.
 * - The public page's URL is `/t/<id>`, the analysis's own public id. A
 *   second id would only matter if the first were a secret, and it is not
 *   one: reading `/analyses/<id>` still needs the uploader's session or
 *   cookie, publishing only opens `/timings/<id>`.
 * - What anyone sees: title and artist (tags, else read from the file name;
 *   never the file name itself), the result, the uploader's public Mides
 *   profile or "anonymous", when it was published. Never the audio's SHA-1
 *   (it names the file), never `anon_hash` or `ip_hash`: the views in
 *   utils/timings.js are built field by field.
 * - The .osz needs the visitor's own audio (ADR-W4). The page hashes the
 *   file they pick and asks `POST /timings/:id/check`, which answers only
 *   whether it matches. That answers nothing a visitor could not learn by
 *   trying the file, and it is rate limited, so it is no way to collect the
 *   hashes; in return the visitor hears the clicks against the song and gets
 *   a map that opens in osu!, as the uploader does.
 *
 * Every mutating route takes the same-origin header and a rate limit, and
 * "not yours" is the same 404 as "does not exist".
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
const SHA1 = /^[0-9a-f]{40}$/;

const publishRateLimit = guard('publish', 30, 10 * 60_000);
// Public reads: wide, but one address cannot page the whole table in a loop.
const readRateLimit = guard('timings', 240, 10 * 60_000);
// A visitor checks one file, or a few; a loop of guesses is cut short.
const checkRateLimit = guard('check', 20, 10 * 60_000);

/** The published timing `:id`, or the same 404 as for an id that never existed. */
const published = async (req) => {
  const { id } = req.params;
  if (!ID.test(id)) throw new HttpError(404, 'No such timing.', 'NOT_FOUND');
  const row = await analyses().getPublished(id);
  if (!row) throw new HttpError(404, 'No such timing.', 'NOT_FOUND');
  return row;
};

router.post('/analyses/:id/publish', publishRateLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const row = await readable(req);
  if (row.status !== 'done') {
    throw new HttpError(409, 'Only a finished timing can be published.', 'NOT_PUBLISHABLE');
  }
  if (row.private && req.body?.makePublic !== true) {
    throw new HttpError(409, 'This analysis is private. Publishing it makes it public.', 'PRIVATE');
  }
  if (!(await analyses().publish(row.publicId))) {
    throw new HttpError(409, 'Only a finished timing can be published.', 'NOT_PUBLISHABLE');
  }
  const now = await analyses().get(row.publicId, { position: false });
  res.set('Cache-Control', 'no-store');
  res.json({ id: row.publicId, published: true, publishedAt: new Date(now.publishedAt).toISOString(), private: false });
});

router.delete('/analyses/:id/publish', publishRateLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const row = await readable(req);
  await analyses().unpublish(row.publicId);
  res.status(204).end();
});

const NO_STATS = Object.freeze({ rating: { average: null, count: 0 }, uses: 0 });

/**
 * One page of published timings under `filters` (utils/timings.js
 * `listFilters`), each with its stars and uses (W6): newest first from the
 * analyses' keyset list, or best rated or most used from the social store's
 * order. The recent list and a profile's list (routes/social.routes.js) are
 * both this.
 */
export const listPage = async (filters) => {
  // W13.16: whether a mapper confirmed each row, one query for the page.
  const verifiedOf = async (rows) => votes().verifiedMany(rows.map((row) => row.publicId));
  if (filters.sort !== 'new') {
    const { rows, next } = await social().listRanked(filters);
    const verified = await verifiedOf(rows);
    return { timings: rows.map((row) => ({ ...recentEntry(row), ...row.stats, verified: verified.has(row.publicId) })), next };
  }
  const { rows, next } = await analyses().listPublished(filters);
  const [stats, verified] = await Promise.all([social().statsFor(rows.map((row) => row.publicId)), verifiedOf(rows)]);
  return {
    timings: rows.map((row) => ({ ...recentEntry(row), ...(stats.get(row.publicId) ?? NO_STATS), verified: verified.has(row.publicId) })),
    next,
  };
};

router.get('/timings', readRateLimit, async (req, res) => {
  const page = await listPage(listFilters(req.query));
  // Not cached either: an unpublished timing leaves the list on the next read.
  res.set('Cache-Control', 'no-store');
  res.json({ ...page, minRatings: MIN_RATINGS_TO_RANK });
});

router.get('/timings/:id', readRateLimit, async (req, res) => {
  const row = await published(req);
  // Not cached: an unpublish must take it down at once.
  res.set('Cache-Control', 'no-store');
  res.json(publicTiming(row));
});

/**
 * GET /timings/:id/card: the list's fields alone, without the result. What
 * overtone-web reads to write a shared link's Open Graph tags
 * (deploy/web/serve.mjs), so a preview does not fetch a whole tempo map.
 */
router.get('/timings/:id/card', readRateLimit, async (req, res) => {
  const row = await published(req);
  res.set('Cache-Control', 'no-store');
  res.json(recentEntry(row));
});

const download = (suffix, type, body) => async (req, res) => {
  const row = await published(req);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', type);
  const { title, artist } = publicTiming(row);
  res.set('Content-Disposition', `attachment; filename="${downloadName([artist, title].filter(Boolean).join(' - ') || 'overtone', suffix)}"`);
  res.send(body(row.result));
};

router.get('/timings/:id/timing.txt', readRateLimit, download('timing.txt', 'text/plain; charset=utf-8', timingText));
router.get('/timings/:id/timing.csv', readRateLimit, download('timing.csv', 'text/csv; charset=utf-8', timingCsv));

router.post('/timings/:id/check', checkRateLimit, requireSameOrigin, async (req, res) => {
  const sha1 = typeof req.body?.sha1 === 'string' ? req.body.sha1.toLowerCase() : '';
  if (!SHA1.test(sha1)) throw new HttpError(400, 'sha1 is the audio\'s SHA-1 in hex.', 'BAD_SHA1');
  const row = await published(req);
  const match = typeof row.sha1 === 'string' && SHA1.test(row.sha1) && timingSafeEqual(Buffer.from(row.sha1), Buffer.from(sha1));
  res.set('Cache-Control', 'no-store');
  res.json({ match });
});

router.get('/me/analyses', readRateLimit, requireSession, async (req, res) => {
  const { rows, next } = await analyses().history(req.account.id, listFilters(req.query, { kind: 'history' }));
  res.set('Cache-Control', 'no-store');
  res.json({ analyses: rows.map(historyEntry), next });
});

export default router;
