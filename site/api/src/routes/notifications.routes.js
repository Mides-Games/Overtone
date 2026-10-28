import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { requireSameOrigin, requireSession } from '../middlewares/session.js';
import { notifications, PAGE } from '../services/notification.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The notification bell (W13.17), for the signed-in account only.
 *
 *   GET  /me/notifications          ?offset=&limit=&unread=1   newest first, with the unread count
 *   GET  /me/notifications/unread   { unread }: what the bell polls, once a minute at most
 *   POST /me/notifications/read     { ids: [...] } or { all: true }
 *
 * A notification is the account's own: another account's id is ignored as
 * one that is not there (marking it read changes nothing and says 0), so
 * nobody can learn whether an id exists. What each kind means and what its
 * payload holds is in services/notification.service.js.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
const MARK_MAX = 100;

// The bell polls `unread` once a minute and on focus: 120 in ten minutes is
// two tabs and plenty of focus changes, and still stops a loop.
const pollLimit = guard('notify-poll', 120, 10 * 60_000);
const readLimit = guard('notify-read', 120, 10 * 60_000);
const markLimit = guard('notify-mark', 120, 10 * 60_000);

const view = (n) => ({
  id: n.publicId,
  kind: n.kind,
  payload: n.payload ?? {},
  createdAt: new Date(n.createdAt).toISOString(),
  read: Boolean(n.readAt),
});

const intOf = (raw, fallback, max) => {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
};

router.get('/me/notifications/unread', pollLimit, requireSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ unread: await notifications().unread(req.account.id) });
});

router.get('/me/notifications', readLimit, requireSession, async (req, res) => {
  const offset = intOf(req.query.offset, 0, 10_000);
  const limit = Math.max(1, intOf(req.query.limit, PAGE, PAGE));
  const unreadOnly = req.query.unread === '1';
  const store = notifications();
  const [page, unread] = await Promise.all([store.list(req.account.id, { offset, limit, unreadOnly }), store.unread(req.account.id)]);
  res.set('Cache-Control', 'no-store');
  res.json({ items: page.items.map(view), total: page.total, unread, offset, limit });
});

router.post('/me/notifications/read', markLimit, requireSameOrigin, requireSession, async (req, res) => {
  const body = req.body ?? {};
  let ids = null;
  if (body.all !== true) {
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > MARK_MAX || !body.ids.every((id) => typeof id === 'string' && ID.test(id))) {
      throw new HttpError(400, `ids is a list of 1 to ${MARK_MAX} notification ids, or send { all: true }.`, 'BAD_IDS');
    }
    ids = [...new Set(body.ids)];
  }
  const marked = await notifications().markRead(req.account.id, ids);
  res.json({ marked, unread: await notifications().unread(req.account.id) });
});

export default router;
