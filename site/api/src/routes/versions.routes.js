import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin } from '../middlewares/session.js';
import { analyses } from '../services/analysis.service.js';
import { LABEL_MAX, parseAdjustment, versions, versionView } from '../services/version.service.js';
import { HttpError } from '../utils/http-error.js';
import { cleanText } from '../utils/text.js';
import { readable } from './analyses.routes.js';

/**
 * Versions of a timing (W12.21), for its owner only (the same 404 for
 * anyone else as for an id that does not exist):
 *
 *   GET    /analyses/:id/versions          the readings of the same audio by the same owner, and the saved adjustments
 *   POST   /analyses/:id/versions          { factor, nudgeMs, lines?, label? }: save the adjustment (or edit, W7) being tried as a version
 *   DELETE /analyses/:id/versions/:vid     forget one
 *
 * The difference per red line between two versions is computed by the page
 * (site/web lib/versions.js) from the results it can already read: nothing
 * here copies a result.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
const readLimit = guard('versions', 240, 10 * 60_000);
const changeLimit = guard('versions-save', 60, 10 * 60_000);

const readingView = (row, currentId) => ({
  id: row.publicId,
  status: row.status,
  engineHash: row.engineHash ?? null,
  createdAt: new Date(row.createdAt).toISOString(),
  ...(row.finishedAt ? { finishedAt: new Date(row.finishedAt).toISOString() } : {}),
  current: row.publicId === currentId,
});

router.get('/analyses/:id/versions', readLimit, optionalSession, async (req, res) => {
  const row = await readable(req);
  // A copy answered from the cache is not a re-analysis: the same reading
  // again. Only the analysis being read is listed when it is one.
  const readings = (await analyses().siblings(row)).filter((r) => !r.cachedFrom || r.publicId === row.publicId);
  if (!readings.some((r) => r.publicId === row.publicId)) readings.unshift(row);
  const adjustments = await versions().list(readings.map((r) => r.publicId));
  res.set('Cache-Control', 'no-store');
  res.json({ readings: readings.map((r) => readingView(r, row.publicId)), adjustments: adjustments.map(versionView) });
});

router.post('/analyses/:id/versions', changeLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const row = await readable(req);
  if (row.status !== 'done') throw new HttpError(409, 'Only a finished timing has versions.', 'NO_TIMING');
  const adjustment = parseAdjustment(req.body);
  if (!adjustment) {
    throw new HttpError(
      400,
      'factor is 0.5, 1 or 2, nudgeMs a whole number from -500 to 500, lines (optional) up to 512 packed red lines; one of them must change something.',
      'BAD_ADJUSTMENT',
    );
  }
  const raw = req.body?.label;
  const label = raw === undefined || raw === null ? null : cleanText(raw, LABEL_MAX + 1);
  if (label && [...label].length > LABEL_MAX) throw new HttpError(400, `A label is at most ${LABEL_MAX} characters.`, 'TOO_LONG', { max: LABEL_MAX });
  const { version, created } = await versions().save(row.publicId, { ...adjustment, label });
  res.set('Cache-Control', 'no-store');
  res.status(created ? 201 : 200).json(versionView(version));
});

router.delete('/analyses/:id/versions/:vid', changeLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const row = await readable(req);
  const { vid } = req.params;
  if (!ID.test(vid) || !(await versions().remove(row.publicId, vid))) throw new HttpError(404, 'No such version.', 'NOT_FOUND');
  res.status(204).end();
});

export default router;
