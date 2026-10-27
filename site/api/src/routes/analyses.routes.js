import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Router } from 'express';

import { env, secureCookies } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin } from '../middlewares/session.js';
import { analyses, engineHash, newPublicId } from '../services/analysis.service.js';
import { cookiesOf } from '../services/session.service.js';
import { commit, discard, discardPart, receive } from '../services/spool.service.js';
import { HttpError } from '../utils/http-error.js';
import { queueEntry } from '../utils/queue.js';
import { audioExtension, cleanFilename, cleanTag, downloadName, timingCsv, timingText } from '../utils/upload.js';

/**
 * Uploading a song and reading its analysis back (W3.4).
 *
 *   POST /analyses                  raw audio body, X-Filename header -> 202 { id, status }
 *   GET  /analyses/queue            the public queue: waiting, running, finished in the last hour
 *   GET  /analyses/:id              status, queue position, progress, result
 *   GET  /analyses/:id/timing.txt   the [TimingPoints] block
 *   GET  /analyses/:id/timing.csv   the red lines as CSV
 *
 * No account is needed (ADR-W6). An anonymous uploader gets an HttpOnly
 * `overtone_anon` cookie, 128 random bits; the row keeps only its SHA-256.
 * An analysis is readable by the session account or the anonymous cookie that
 * created it, and by nobody else: anyone else gets the same 404 as for an id
 * that does not exist.
 */
const router = Router();

const ANON_COOKIE = 'overtone_anon';
const ANON_PATH = '/api/v1/analyses';
const ID = /^[0-9a-f]{32}$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const anonHashOf = (req) => {
  const token = cookiesOf(req)[ANON_COOKIE];
  return typeof token === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(token) ? sha256(token) : null;
};

/** Sets a new anonymous cookie when the request has none; returns the hash to store. */
const ensureAnon = (req, res) => {
  const existing = anonHashOf(req);
  if (existing) return existing;
  const token = randomBytes(16).toString('base64url');
  res.append(
    'Set-Cookie',
    [
      `${ANON_COOKIE}=${token}`,
      `Path=${ANON_PATH}`,
      'HttpOnly',
      'SameSite=Lax',
      secureCookies() ? 'Secure' : null,
      `Max-Age=${365 * 24 * 60 * 60}`,
    ]
      .filter(Boolean)
      .join('; '),
  );
  return sha256(token);
};

/**
 * The client address as the quota counts it: an HMAC of the address and the
 * UTC day, so the stored value cannot be turned back into an address and does
 * not link one day's uploads to the next.
 */
const ipHashOf = (req) => {
  const day = new Date().toISOString().slice(0, 10);
  return createHmac('sha256', env.sessionSecret).update(`ip:${day}:${req.ip ?? 'unknown'}`).digest('hex');
};

// Uploads are expensive for the server: a narrow per-address limit of its own,
// on top of the daily quota.
const uploadRateLimit = guard('upload', 10, 10 * 60_000);

const refuseEarly = (res, error) => {
  // The body was not read: close the connection so it is not drained.
  res.set('Connection', 'close');
  throw error;
};

router.post('/analyses', uploadRateLimit, requireSameOrigin, optionalSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const limit = env.maxUploadMb * 1_048_576;

  const type = (req.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    refuseEarly(res, new HttpError(415, 'Send the audio as the raw body (application/octet-stream).', 'UNSUPPORTED_MEDIA_TYPE'));
  }

  const filename = cleanFilename(req.get('X-Filename'));
  const ext = audioExtension(filename);
  if (!filename || !ext) {
    refuseEarly(res, new HttpError(400, 'Choose an MP3, OGG, WAV, FLAC, M4A or Opus file.', 'UNSUPPORTED_FORMAT'));
  }

  const declared = Number(req.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    refuseEarly(res, new HttpError(413, `The file is larger than ${env.maxUploadMb} MB.`, 'TOO_LARGE', { maxUploadMb: env.maxUploadMb }));
  }

  const accountId = req.account?.id ?? null;
  const ipHash = ipHashOf(req);
  const quota = accountId ? env.userDailyLimit : env.anonDailyLimit;
  const used = await analyses().countToday({ accountId, ipHash });
  if (used >= quota) {
    const error = new HttpError(
      429,
      accountId
        ? `You have used today's ${quota} analyses. The count resets at 00:00 UTC.`
        : `Without an account you can analyse ${quota} songs a day. Sign in for more, or come back after 00:00 UTC.`,
      'QUOTA_EXCEEDED',
      { limit: quota, scope: accountId ? 'account' : 'anonymous' },
    );
    refuseEarly(res, error);
  }

  const anonHash = accountId ? null : ensureAnon(req, res);
  const id = newPublicId();

  let received;
  try {
    received = await receive(req, id, limit);
  } catch (error) {
    if (error instanceof HttpError) res.set('Connection', 'close');
    throw error;
  }
  if (received.bytes === 0) {
    await discardPart(id);
    throw new HttpError(400, 'The file is empty.', 'EMPTY_UPLOAD');
  }

  const store = analyses();
  const row = {
    publicId: id, sha1: received.sha1, filename, sizeBytes: received.bytes, accountId, anonHash, ipHash,
    // The public queue's privacy switch: anything but "1" is public, as the form's default is.
    private: req.get('X-Private') === '1',
    tagTitle: cleanTag(req.get('X-Title')),
    tagArtist: cleanTag(req.get('X-Artist')),
    // Only the memory store keeps this; PostgreSQL joins `accounts` instead.
    uploader: req.account
      ? { username: req.account.username, displayName: req.account.display_name, avatarUrl: req.account.avatar_url }
      : null,
  };

  // The same audio through the same engine has been analysed before: answer
  // with that result, and the upload is not needed at all.
  const cached = await store.findCached(received.sha1, engineHash());
  if (cached) {
    await discardPart(id);
    const made = await store.create({ ...row, cachedFrom: cached });
    return res.status(200).json({ id, status: made.status, cached: true });
  }

  await commit(id);
  try {
    await store.create(row);
  } catch (error) {
    await discard(id);
    throw error;
  }
  return res.status(202).json({ id, status: 'queued', cached: false });
});

/** Whether this request is the one that created `row`: its session account or its anonymous cookie. */
const isMine = (req, row, anonHash = anonHashOf(req)) =>
  Boolean((req.account && row.accountId === req.account.id) || (row.anonHash && row.anonHash === anonHash));

// Every open queue page polls; one read of the tables serves all of them for a second.
const QUEUE_TTL_MS = 1000;
let queueSnapshot = { at: 0, data: null };
const queueRows = async () => {
  if (!queueSnapshot.data || Date.now() - queueSnapshot.at > QUEUE_TTL_MS) {
    queueSnapshot = { at: Date.now(), data: await analyses().queue() };
  }
  return queueSnapshot.data;
};

/**
 * GET /analyses/queue: what is waiting, what is being analysed and what
 * finished in the last hour, for anyone (W3.8). Under /analyses so the
 * anonymous cookie, whose path is ANON_PATH, reaches it and marks the
 * caller's own rows. Polled by the page every few seconds.
 */
router.get('/analyses/queue', optionalSession, async (req, res) => {
  const { live, more, recent } = await queueRows();
  const anonHash = anonHashOf(req);
  const now = Date.now();
  const view = (row) => queueEntry(row, { mine: isMine(req, row, anonHash), now });
  res.set('Cache-Control', 'no-store');
  res.json({ live: live.map(view), more, recent: recent.map(view), at: new Date(now).toISOString() });
});

/** The analysis `:id` if this request may read it, else a 404. */
const readable = async (req) => {
  const { id } = req.params;
  if (!ID.test(id)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  const row = await analyses().get(id);
  if (!row || !isMine(req, row)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  return row;
};

const publicView = (row) => ({
  id: row.publicId,
  status: row.status,
  filename: row.filename,
  createdAt: new Date(row.createdAt).toISOString(),
  cached: Boolean(row.cachedFrom),
  ...(row.status === 'queued' && row.position ? { position: row.position } : {}),
  ...(row.status === 'running' ? { progress: row.progress ?? 0, stage: row.stage ?? null } : {}),
  ...(row.status === 'done' || row.status === 'refused' ? { result: row.result } : {}),
  ...(row.status === 'failed' ? { error: row.error ?? 'The analysis failed.' } : {}),
});

router.get('/analyses/:id', optionalSession, async (req, res) => {
  const row = await readable(req);
  res.set('Cache-Control', 'no-store');
  res.json(publicView(row));
});

const download = (suffix, type, body) => async (req, res) => {
  const row = await readable(req);
  if (row.status !== 'done') {
    throw new HttpError(409, 'This analysis has no timing to download.', 'NO_TIMING');
  }
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${downloadName(row.filename, suffix)}"`);
  res.send(body(row.result));
};

router.get('/analyses/:id/timing.txt', optionalSession, download('timing.txt', 'text/plain; charset=utf-8', timingText));
router.get('/analyses/:id/timing.csv', optionalSession, download('timing.csv', 'text/csv; charset=utf-8', timingCsv));

export default router;
