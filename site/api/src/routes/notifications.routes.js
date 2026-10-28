import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { requireSameOrigin, requireSession } from '../middlewares/session.js';
import { KINDS, notifications, PAGE, targetOf } from '../services/notification.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The notification bell (W13.17), for the signed-in account only.
 *
 *   GET    /me/notifications            ?offset=&limit=&unread=1&kind=a,b   newest first, with the unread count
 *   GET    /me/notifications/unread     { unread }: what the bell polls, once a minute at most
 *   POST   /me/notifications/read       { ids: [...] } or { all: true }
 *   POST   /me/notifications/unread     { ids: [...] }: back to unread
 *   DELETE /me/notifications/:id        one of them
 *   DELETE /me/notifications?read=true  every read one
 *
 * A notification is the account's own. Marking another account's id read or
 * unread changes nothing and says 0, and deleting one is the 404 of an id
 * that is not there, so nobody can learn whether an id exists. Every answer
 * that changes something carries the new unread count, which the bell shows
 * at once. What each kind means and what its payload holds is in
 * services/notification.service.js; each item's `target` is where a click
 * leads, a path on this site built there, never a URL from a row.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
const MARK_MAX = 100;

// The bell polls `unread` once a minute and on focus: 120 in ten minutes is
// two tabs and plenty of focus changes, and still stops a loop.
const pollLimit = guard('notify-poll', 120, 10 * 60_000);
const readLimit = guard('notify-read', 120, 10 * 60_000);
const markLimit = guard('notify-mark', 120, 10 * 60_000);
// Deleting one at a time from the panel is a click each: 120 in ten minutes
// is a long clean-up, and "delete read" does the rest in one.
const deleteLimit = guard('notify-delete', 120, 10 * 60_000);

const view = (n) => ({
  id: n.publicId,
  kind: n.kind,
  payload: n.payload ?? {},
  target: targetOf(n.kind, n.payload),
  createdAt: new Date(n.createdAt).toISOString(),
  read: Boolean(n.readAt),
});

const intOf = (raw, fallback, max) => {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
};

/** `kind=comment,vote`: known kinds only, else a 400; absent or empty is every kind. */
const kindsOf = (raw) => {
  if (raw === undefined || raw === '') return null;
  const list = typeof raw === 'string' ? raw.split(',') : null;
  if (!list || list.length > KINDS.length || !list.every((k) => KINDS.includes(k))) {
    throw new HttpError(400, `kind is a comma-separated list of ${KINDS.join(', ')}.`, 'BAD_KIND');
  }
  return [...new Set(list)];
};

/** `{ ids }`: 1 to MARK_MAX notification ids, deduplicated, else a 400. */
const idsOf = (body, { allowAll = false } = {}) => {
  if (allowAll && body?.all === true) return null;
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MARK_MAX || !ids.every((id) => typeof id === 'string' && ID.test(id))) {
    throw new HttpError(400, `ids is a list of 1 to ${MARK_MAX} notification ids${allowAll ? ', or send { all: true }' : ''}.`, 'BAD_IDS');
  }
  return [...new Set(ids)];
};

router.get('/me/notifications/unread', pollLimit, requireSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ unread: await notifications().unread(req.account.id) });
});

router.get('/me/notifications', readLimit, requireSession, async (req, res) => {
  const offset = intOf(req.query.offset, 0, 10_000);
  const limit = Math.max(1, intOf(req.query.limit, PAGE, PAGE));
  const unreadOnly = req.query.unread === '1';
  const kinds = kindsOf(req.query.kind);
  const store = notifications();
  const [page, unread] = await Promise.all([store.list(req.account.id, { offset, limit, unreadOnly, kinds }), store.unread(req.account.id)]);
  res.set('Cache-Control', 'no-store');
  res.json({ items: page.items.map(view), total: page.total, unread, offset, limit });
});

router.post('/me/notifications/read', markLimit, requireSameOrigin, requireSession, async (req, res) => {
  const ids = idsOf(req.body, { allowAll: true });
  const marked = await notifications().markRead(req.account.id, ids);
  res.json({ marked, unread: await notifications().unread(req.account.id) });
});

router.post('/me/notifications/unread', markLimit, requireSameOrigin, requireSession, async (req, res) => {
  const ids = idsOf(req.body);
  const marked = await notifications().markUnread(req.account.id, ids);
  res.json({ marked, unread: await notifications().unread(req.account.id) });
});

router.delete('/me/notifications', deleteLimit, requireSameOrigin, requireSession, async (req, res) => {
  // Only the read ones, and only when asked by name: a bare DELETE must not empty the bell.
  if (req.query.read !== 'true') throw new HttpError(400, 'Only the read ones can be deleted at once: send ?read=true.', 'READ_ONLY');
  const deleted = await notifications().removeRead(req.account.id);
  res.json({ deleted, unread: await notifications().unread(req.account.id) });
});

router.delete('/me/notifications/:id', deleteLimit, requireSameOrigin, requireSession, async (req, res) => {
  const { id } = req.params;
  if (!ID.test(id) || !(await notifications().remove(req.account.id, id))) {
    throw new HttpError(404, 'No such notification.', 'NOT_FOUND');
  }
  res.json({ deleted: 1, unread: await notifications().unread(req.account.id) });
});

export default router;
