import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Router } from 'express';

import { env, secureCookies } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin } from '../middlewares/session.js';
import { analyses, engineHash, newPublicId } from '../services/analysis.service.js';
import { cookiesOf } from '../services/session.service.js';
import { commit, discard, discardPart, receive, reserve } from '../services/spool.service.js';
import { HttpError } from '../utils/http-error.js';
import { queueEntry } from '../utils/queue.js';
import { audioExtension, cleanFilename, cleanTag, downloadName, timingCsv, timingText } from '../utils/upload.js';

/**
 * Uploading a song and reading its analysis back (W3.4).
 *
 *   POST /analyses/lookup           { sha1, filename, size } -> the stored result, or { cached: false }
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

/** What the public queue may show of a new analysis (W3.8): its privacy, its tags and its uploader. */
const shown = (req, { hidden, title, artist }) => ({
  private: hidden,
  tagTitle: cleanTag(typeof title === 'string' ? title : null),
  tagArtist: cleanTag(typeof artist === 'string' ? artist : null),
  // Only the memory store keeps this; PostgreSQL joins `accounts` instead.
  uploader: req.account
    ? { username: req.account.username, displayName: req.account.display_name, avatarUrl: req.account.avatar_url }
    : null,
});

// Uploads are expensive for the server: a narrow per-address limit of its own,
// on top of the daily quota.
const uploadRateLimit = guard('upload', 10, 10 * 60_000);

const refuseEarly = (res, error) => {
  // The body was not read: close the connection so it is not drained.
  res.set('Connection', 'close');
  throw error;
};

/**
 * The limits a new analysis of this request is held to, checked again by the
 * store inside the insert (services/analysis.service.js, `refusal`). The
 * early checks below only spare reading a body that would be refused; this
 * second check is the one two parallel requests cannot both pass.
 */
const limitsFor = (accountId) => ({
  scope: accountId ? 'account' : 'anonymous',
  quota: accountId ? env.userDailyLimit : env.anonDailyLimit,
  maxPending: accountId ? env.userMaxPending : env.anonMaxPending,
  queueMax: env.queueMax,
  cacheDaily: env.cacheDailyLimit,
});

/**
 * Answers from the stored result of `sha1`: the copy this person already has
 * today when there is one (so asking again creates nothing), else a new copy,
 * held to the daily cap on stored results. Returns the JSON to send.
 */
const answerFromCache = async (req, res, cached, row) => {
  const store = analyses();
  // An upload has set the anonymous cookie already (row.anonHash); a lookup may not have.
  const known = row.accountId ? null : (row.anonHash ?? anonHashOf(req));
  const copy = known || row.accountId
    ? await store.findCopy({ sha1: row.sha1, accountId: row.accountId, anonHash: known })
    : null;
  if (copy) return { id: copy.publicId, status: copy.status, cached: true };
  const made = await store.create(
    { ...row, anonHash: row.accountId ? null : (known ?? ensureAnon(req, res)), cachedFrom: cached },
    { limits: limitsFor(row.accountId) },
  );
  return { id: row.publicId, status: made.status, cached: true };
};

/**
 * Uploads still arriving, per owner (as the queue's `ownerOf`: the account,
 * or the hashed address) and in all. Counted toward the pending and queue
 * caps, which the store only sees once a body has landed.
 */
const arriving = new Map();
let arrivingTotal = 0;
const ownerKey = (accountId, ipHash) => accountId ?? `ip:${ipHash}`;
const arrive = (owner, step) => {
  const now = (arriving.get(owner) ?? 0) + step;
  if (now > 0) arriving.set(owner, now);
  else arriving.delete(owner);
  arrivingTotal += step;
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

  // W3.9: a batch is many uploads, each one checked here, so a person's songs
  // in the queue at once are capped, and so is the whole queue.
  const pending = await analyses().countPending({ accountId, ipHash });
  const maxPending = accountId ? env.userMaxPending : env.anonMaxPending;
  // Uploads still arriving count too: K bodies sent at once would otherwise
  // all pass a cap the store only sees once each one has landed.
  const owner = ownerKey(accountId, ipHash);
  if (pending.mine + (arriving.get(owner) ?? 0) >= maxPending) {
    refuseEarly(
      res,
      new HttpError(
        429,
        `You already have ${maxPending} songs in the queue. Send more when one finishes.`,
        'PENDING_LIMIT',
        { limit: maxPending, scope: accountId ? 'account' : 'anonymous' },
      ),
    );
  }
  if (pending.all + arrivingTotal >= env.queueMax) {
    refuseEarly(res, new HttpError(503, 'The queue is full. Try again in a few minutes.', 'QUEUE_FULL'));
  }

  // Counted from here, with no await since the checks above, until the
  // response: received, refused or failed.
  arrive(owner, +1);
  let release = () => {};
  try {
    // The spool's room is taken before a byte is read. Node holds a body to
    // its Content-Length, so a declared size is what can arrive; without one
    // (chunked), the largest upload.
    try {
      release = await reserve(Number.isFinite(declared) && declared > 0 ? declared : limit);
    } catch (error) {
      refuseEarly(res, error);
    }
    return await receiveUpload(req, res, { accountId, ipHash, filename, limit });
  } finally {
    release();
    arrive(owner, -1);
  }
});

/** The upload's body to the spool and its row into the queue (or an answer from the cache). */
const receiveUpload = async (req, res, { accountId, ipHash, filename, limit }) => {
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
    ...shown(req, { hidden: req.get('X-Private') === '1', title: req.get('X-Title'), artist: req.get('X-Artist') }),
  };

  // The same audio through the same engine has been analysed before: answer
  // with that result, and the upload is not needed at all.
  const cached = await store.findCached(received.sha1, engineHash());
  if (cached) {
    await discardPart(id);
    return res.status(200).json(await answerFromCache(req, res, cached, row));
  }

  await commit(id, received.bytes);
  try {
    await store.create(row, { limits: limitsFor(accountId) });
  } catch (error) {
    await discard(id);
    throw error;
  }
  return res.status(202).json({ id, status: 'queued', cached: false });
};

// A lookup reads one indexed row and sends no audio: much wider than uploads,
// enough for a 50-file batch twice over in ten minutes.
const lookupRateLimit = guard('lookup', 120, 10 * 60_000);
const SHA1 = /^[0-9a-f]{40}$/;

/**
 * POST /analyses/lookup (W3.11): before uploading, the browser sends the
 * audio's SHA-1. When the current engine has analysed that audio, the answer
 * is a new analysis made from the stored result, exactly as an upload of the
 * same file would have got (200, `cached: true`), and nothing is uploaded.
 * Otherwise 200 `{ cached: false }` and the browser uploads as before.
 *
 * Like a cached upload, a hit costs no quota and no place in the queue. It
 * has a daily cap of its own (CACHE_DAILY_LIMIT), and asking again for audio
 * this person already has today returns that same analysis, so a lookup in a
 * loop neither fills the tables nor floods the public queue. Knowing the hash stands in for
 * having the file, which is the same trust the upload's cache already gives.
 */
router.post('/analyses/lookup', lookupRateLimit, requireSameOrigin, optionalSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body ?? {};
  const sha1 = typeof body.sha1 === 'string' ? body.sha1.toLowerCase() : '';
  if (!SHA1.test(sha1)) throw new HttpError(400, 'sha1 is the audio\'s SHA-1 in hex.', 'BAD_SHA1');
  const filename = cleanFilename(typeof body.filename === 'string' ? body.filename : null);
  if (!filename || !audioExtension(filename)) {
    throw new HttpError(400, 'Choose an MP3, OGG, WAV, FLAC, M4A or Opus file.', 'UNSUPPORTED_FORMAT');
  }
  const sizeBytes = Number.isSafeInteger(body.size) && body.size > 0 ? body.size : null;

  const store = analyses();
  const cached = await store.findCached(sha1, engineHash());
  if (!cached) return res.json({ cached: false });

  const row = {
    ...shown(req, { hidden: body.private === true, title: body.title, artist: body.artist }),
    filename,
    accountId: req.account?.id ?? null,
    publicId: newPublicId(),
    sha1,
    sizeBytes,
    ipHash: ipHashOf(req),
  };
  return res.json(await answerFromCache(req, res, cached, row));
});

/** Whether this request is the one that created `row`: its session account or its anonymous cookie. */
const isMine = (req, row, anonHash = anonHashOf(req)) =>
  Boolean((req.account && row.accountId === req.account.id) || (row.anonHash && row.anonHash === anonHash));

// Every open queue page polls; one read of the tables serves all of them for a second.
const QUEUE_TTL_MS = 1000;
// The promise is kept, not its value: requests that arrive while the read is
// running wait for it instead of starting their own.
let queueSnapshot = { at: 0, read: null };
const queueRows = () => {
  if (!queueSnapshot.read || Date.now() - queueSnapshot.at > QUEUE_TTL_MS) {
    const read = analyses()
      .queue()
      .then((data) => ({
        ...data,
        positions: new Map(data.live.filter((r) => r.position).map((r) => [r.publicId, r.position])),
      }));
    queueSnapshot = { at: Date.now(), read };
    read.catch(() => {
      if (queueSnapshot.read === read) queueSnapshot = { at: 0, read: null };
    });
  }
  return queueSnapshot.read;
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
  const row = await analyses().get(id, { position: false });
  if (!row || !isMine(req, row)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  return row;
};

/**
 * A queued row's place, from the one-second queue snapshot every poller
 * shares, so polling N analyses does not rank the whole queue N times. Past
 * the snapshot's LIVE_LIMIT rows the store ranks it on its own, as before.
 */
const withPosition = async (row) => {
  if (row.status !== 'queued') return row;
  const { positions } = await queueRows();
  const position = positions.get(row.publicId) ?? (await analyses().get(row.publicId))?.position ?? null;
  return { ...row, position };
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
  const row = await withPosition(await readable(req));
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
