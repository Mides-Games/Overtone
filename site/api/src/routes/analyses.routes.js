import { createHash, createHmac, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { Router } from 'express';

import { env } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { optionalSession, requireSameOrigin, requireSession } from '../middlewares/session.js';
import { isStaff } from '../services/account.service.js';
import { analyses, engineHash, limitRefusal, newPublicId, REMOVED } from '../services/analysis.service.js';
import { analysisKey, seen } from '../services/notification.service.js';
import { ANON_COOKIE, anonCookieHeader, cookiesOf } from '../services/session.service.js';
import { versions } from '../services/version.service.js';
import { audioPath, commit, discard, discardPart, receive, reserve } from '../services/spool.service.js';
import { clientKey } from '../utils/client-ip.js';
import { HttpError } from '../utils/http-error.js';
import { queueEntry } from '../utils/queue.js';
import { audioSecondsOf, optionsFromHeader, parseMode, parseOptions } from '../utils/analysis-options.js';
import { estimateQueue } from '../utils/estimate.js';
import { audioExtension, cleanFilename, cleanTag, downloadName, timingCsv, timingText } from '../utils/upload.js';

/**
 * Uploading a song and reading its analysis back (W3.4).
 *
 *   POST /analyses/lookup           { sha1, filename, size } -> the stored result, or { cached: false }
 *   POST /analyses                  raw audio body, X-Filename header -> 202 { id, status }
 *   GET  /analyses/queue            the public queue: waiting, running, finished in the last hour
 *   GET  /analyses/moderation       staff: the latest removals and requeues, and who did them
 *   POST /analyses/:id/moderate     staff: { action: remove | requeue, reason? }
 *   GET  /analyses/:id              status, queue position, progress, result
 *   DELETE /analyses/:id            cancel it while it is still queued, or delete it once finished
 *   GET  /analyses/:id/timing.txt   the [TimingPoints] block
 *   GET  /analyses/:id/timing.csv   the red lines as CSV
 *
 * No account is needed (ADR-W6). An anonymous uploader gets an HttpOnly
 * `overtone_anon` cookie (`__Host-overtone_anon` over https, Path=/), 128
 * random bits; the row keeps only its SHA-256.
 * An analysis is readable by the session account or the anonymous cookie that
 * created it, and by nobody else: anyone else gets the same 404 as for an id
 * that does not exist.
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const anonHashOf = (req) => {
  const token = cookiesOf(req)[ANON_COOKIE];
  return typeof token === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(token) ? sha256(token) : null;
};

/** Sets a new anonymous cookie when the request has none; returns the hash to store. */
const ensureAnon = (req, res) => {
  const existing = anonHashOf(req);
  if (existing) return existing;
  const token = randomBytes(16).toString('base64url');
  res.append('Set-Cookie', anonCookieHeader(token));
  return sha256(token);
};

/**
 * The client address as the quota counts it: an HMAC of the address (an IPv6
 * client's /64, utils/client-ip.js) and the UTC day, so the stored value
 * cannot be turned back into an address and does not link one day's uploads
 * to the next. The queue's turns count by it too.
 */
export const ipHashOf = (req) => {
  const day = new Date().toISOString().slice(0, 10);
  return createHmac('sha256', env.sessionSecret).update(`ip:${day}:${clientKey(req.ip)}`).digest('hex');
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
    ? await store.findCopy({ sha1: row.sha1, accountId: row.accountId, anonHash: known, mode: row.mode, optionsKey: row.optionsKey })
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

/**
 * How this analysis is asked for (W11.1, W3.21, W12.19, W3.24): the mode, the
 * hints and their cache key, the browser's reading of the audio's length,
 * and the analysis it re-analyses, checked to be the requester's own (the
 * same 404 as one that does not exist). Throws an HttpError.
 */
const askedFor = async (req, { mode, options, duration, reanalysisOf }) => {
  const parsed = typeof options === 'string' || options === undefined
    ? optionsFromHeader(options, { maxSeconds: env.maxAudioSeconds })
    : parseOptions(options, { maxSeconds: env.maxAudioSeconds });
  let source = null;
  if (reanalysisOf !== undefined && reanalysisOf !== null && reanalysisOf !== '') {
    if (typeof reanalysisOf !== 'string' || !ID.test(reanalysisOf)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
    source = await analyses().get(reanalysisOf, { position: false });
    if (!source || !isMine(req, source)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  }
  return {
    mode: parseMode(mode),
    options: parsed.options,
    optionsKey: parsed.key,
    audioSeconds: audioSecondsOf(duration, parsed.options),
    source,
  };
};

/** What a new row stores of `askedFor`'s answer. */
const rowAsked = (asked) => ({
  mode: asked.mode,
  options: asked.options,
  optionsKey: asked.optionsKey,
  audioSeconds: asked.audioSeconds,
  reanalysisOf: asked.source?.publicId ?? null,
});

const notSameAudio = () => new HttpError(400, 'This is not the audio of the analysis it re-analyses.', 'NOT_SAME_AUDIO');

router.post('/analyses', uploadRateLimit, requireSameOrigin, optionalSession, (req, res) =>
  acceptUpload(req, res, { ipHash: ipHashOf(req), anonHash: () => ensureAnon(req, res) }));

/**
 * An upload, from its headers to the queue: the browser's (above) and the
 * Discord bot's (routes/bot.routes.js, W9.3), which are one path so the bot is
 * held to exactly the site's limits. `req.account` is the uploader's account
 * or `null`; `ipHash` is what the anonymous quota and the queue's turns count
 * by (the address's daily HMAC, or the Discord user's); `anonHash()` gives the
 * hash an anonymous row is owned by, setting the cookie when the browser has
 * none.
 */
export const acceptUpload = async (req, res, { ipHash, anonHash }) => {
  res.set('Cache-Control', 'no-store');
  const limit = env.maxUploadMb * 1_048_576;

  let asked;
  try {
    asked = await askedFor(req, {
      mode: req.get('X-Mode'), options: req.get('X-Options') ?? '', duration: req.get('X-Duration'),
      reanalysisOf: req.get('X-Reanalysis-Of'),
    });
  } catch (error) {
    refuseEarly(res, error);
  }

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
  const quota = accountId ? env.userDailyLimit : env.anonDailyLimit;
  const used = await analyses().countToday({ accountId, ipHash });
  if (used >= quota) {
    refuseEarly(res, limitRefusal('QUOTA_EXCEEDED', { limit: quota, scope: accountId ? 'account' : 'anonymous' }));
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
      limitRefusal('PENDING_LIMIT', { limit: maxPending, scope: accountId ? 'account' : 'anonymous', pending: pending.mine }),
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
    return await receiveUpload(req, res, { accountId, ipHash, anonHash, filename, limit, asked });
  } finally {
    release();
    arrive(owner, -1);
  }
};

/** The upload's body to the spool and its row into the queue (or an answer from the cache). */
const receiveUpload = async (req, res, { accountId, ipHash, anonHash: anonHashFor, filename, limit, asked }) => {
  const anonHash = accountId ? null : anonHashFor();
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
  if (asked.source && asked.source.sha1 !== received.sha1) {
    await discardPart(id);
    throw notSameAudio();
  }

  const store = analyses();
  const row = {
    publicId: id, sha1: received.sha1, filename, sizeBytes: received.bytes, accountId, anonHash, ipHash,
    // The public queue's privacy switch: anything but "1" is public, as the form's default is.
    ...shown(req, { hidden: req.get('X-Private') === '1', title: req.get('X-Title'), artist: req.get('X-Artist') }),
    ...rowAsked(asked),
  };

  // The same audio through the same engine, in the same mode with the same
  // hints, has been analysed before: answer with that result, and the upload
  // is not needed at all.
  const cached = await store.findCached(received.sha1, engineHash(asked.mode), asked.mode, asked.optionsKey);
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
  const asked = await askedFor(req, {
    mode: body.mode, options: body.options ?? null, duration: body.duration, reanalysisOf: body.reanalysisOf,
  });
  if (asked.source && asked.source.sha1 !== sha1) throw notSameAudio();

  const store = analyses();
  const cached = await store.findCached(sha1, engineHash(asked.mode), asked.mode, asked.optionsKey);
  if (!cached) return res.json({ cached: false });

  const row = {
    ...shown(req, { hidden: body.private === true, title: body.title, artist: body.artist }),
    ...rowAsked(asked),
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
export const isMine = (req, row, anonHash = anonHashOf(req)) =>
  Boolean((req.account && row.accountId === req.account.id) || (row.anonHash && row.anonHash === anonHash));

// Every open queue page polls; one read of the tables serves all of them for a second.
const QUEUE_TTL_MS = 1000;
// The promise is kept, not its value: requests that arrive while the read is
// running wait for it instead of starting their own.
let queueSnapshot = { at: 0, read: null };
/** The next queue read goes to the tables: something it shows just changed. */
export const refreshQueue = () => {
  queueSnapshot = { at: 0, read: null };
};
const queueRows = () => {
  if (!queueSnapshot.read || Date.now() - queueSnapshot.at > QUEUE_TTL_MS) {
    const read = analyses()
      .queue()
      .then((data) => ({
        ...data,
        positions: new Map(data.live.filter((r) => r.position).map((r) => [r.publicId, r.position])),
        // W3.16: how long until each one is done, by the measured cost per audio minute.
        estimates: estimateQueue(data.live),
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
 * finished in the last hour, for anyone (W3.8). The anonymous cookie
 * reaches it (Path=/) and marks the caller's own rows. Polled by the page
 * every few seconds.
 */
router.get('/analyses/queue', optionalSession, async (req, res) => {
  const { live, more, recent, estimates } = await queueRows();
  const anonHash = anonHashOf(req);
  const now = Date.now();
  const staff = isStaff(req.account);
  const view = (row) => queueEntry(row, { mine: isMine(req, row, anonHash), staff, now, estimate: estimates.get(row.publicId) });
  res.set('Cache-Control', 'no-store');
  res.json({
    live: live.map(view), more, recent: recent.map(view), at: new Date(now).toISOString(), ...(staff ? { staff: true } : {}),
  });
});

/** Staff only (W3.18): Mides moderators. Everyone else gets a 403 that says so. */
const requireStaff = (req, _res, next) => {
  if (!isStaff(req.account)) return next(new HttpError(403, 'Only staff can do this.', 'STAFF_ONLY'));
  return next();
};

/** GET /analyses/moderation: the latest removals and requeues, newest first, with who did each. */
router.get('/analyses/moderation', requireSession, requireStaff, async (_req, res) => {
  const log = await analyses().moderationLog();
  res.set('Cache-Control', 'no-store');
  res.json({
    log: log.map((e) => ({
      action: e.action, moderator: e.moderator, ref: e.publicId, reason: e.reason, at: new Date(e.createdAt).toISOString(),
    })),
  });
});

const ACTIONS = ['remove', 'requeue'];

/**
 * POST /analyses/:id/moderate (W3.18), staff only. `remove` takes a waiting
 * or running job off the queue: it fails with a message that says a
 * moderator removed it, and its audio goes. A worker already on it finishes
 * its stage and its answer is refused as stale. `requeue` hands a running
 * job (a stuck one, typically) back to the queue, while its audio is still
 * spooled. Each is recorded in `moderation_log` with who did it, in the
 * same transaction as the change.
 */
router.post('/analyses/:id/moderate', requireSameOrigin, requireSession, requireStaff, async (req, res) => {
  const { id } = req.params;
  if (!ID.test(id)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  const action = req.body?.action;
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'action is remove or requeue.', 'BAD_ACTION');
  const reason = typeof req.body.reason === 'string'
    ? req.body.reason.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) || null
    : null;
  const by = { accountId: req.account.id, moderator: req.account.username, reason };

  const store = analyses();
  if (!(await store.get(id, { position: false }))) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  if (action === 'remove') {
    if (!(await store.remove(id, by))) throw new HttpError(409, 'It is not waiting or running any more.', 'NOT_LIVE');
    await discard(id);
  } else {
    if (!(await stat(audioPath(id)).catch(() => null))) {
      throw new HttpError(409, 'Its audio is gone: it cannot be analysed again.', 'AUDIO_GONE');
    }
    if (!(await store.requeue(id, by))) throw new HttpError(409, 'Only a running job can be handed back.', 'NOT_RUNNING');
  }
  queueSnapshot = { at: 0, read: null };
  res.status(204).end();
});

/** The analysis `:id` if this request may read it, else a 404. */
export const readable = async (req) => {
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
  if (row.status !== 'queued' && row.status !== 'running') return row;
  const { positions, estimates } = await queueRows();
  const estimate = estimates.get(row.publicId) ?? null;
  if (row.status === 'running') return { ...row, estimate };
  const position = positions.get(row.publicId) ?? (await analyses().get(row.publicId))?.position ?? null;
  return { ...row, position, estimate };
};

/**
 * W3.24: the analyses this one was re-analysed into, or from, that this
 * request may open (each one's own owner check, as `readable`): ids and
 * modes only.
 */
const relatedOf = async (req, row) =>
  (await analyses().related(row.publicId))
    .filter((other) => isMine(req, other))
    .map((other) => ({
      id: other.publicId,
      mode: other.mode ?? 'normal',
      status: other.status,
      options: other.options ?? {},
      source: other.publicId === row.reanalysisOf,
    }));

const publicView = (row) => ({
  id: row.publicId,
  status: row.status,
  filename: row.filename,
  // Only its uploader reads this view, and they hold the file: the result page
  // checks a file picked again against it before playing it (ADR-W4).
  sha1: row.sha1 ?? null,
  // The file's own tags, cleaned on upload: the .osz the page builds names its map by them.
  tagTitle: row.tagTitle ?? null,
  tagArtist: row.tagArtist ?? null,
  createdAt: new Date(row.createdAt).toISOString(),
  cached: Boolean(row.cachedFrom),
  // W3.27: whether its uploader made it public, and the privacy publishing lifts.
  private: Boolean(row.private),
  published: Boolean(row.publishedAt),
  ...(row.publishedAt ? { publishedAt: new Date(row.publishedAt).toISOString() } : {}),
  // W11.1, W3.21: how it was asked for; W3.24: what it was re-analysed from.
  mode: row.mode ?? 'normal',
  options: row.options ?? {},
  reanalysisOf: row.reanalysisOf ?? null,
  ...(row.estimate ? { estimate: row.estimate } : {}),
  ...(row.status === 'queued' && row.position ? { position: row.position } : {}),
  ...(row.status === 'running' ? { progress: row.progress ?? 0, stage: row.stage ?? null } : {}),
  ...(row.status === 'done' || row.status === 'refused' ? { result: row.result } : {}),
  ...(row.status === 'failed' ? { error: row.error ?? 'The analysis failed.', ...(row.error === REMOVED ? { removed: true } : {}) } : {}),
});

router.get('/analyses/:id', optionalSession, async (req, res) => {
  const row = await withPosition(await readable(req));
  res.set('Cache-Control', 'no-store');
  // Polled every second or so while it waits: the links are read once it has ended.
  const finished = !['queued', 'running'].includes(row.status);
  // W13.17: its owner has now seen how it ended; the bell need not say it.
  if (finished && req.account && row.accountId === req.account.id) await seen(req.account.id, analysisKey(row.publicId));
  res.json({ ...publicView(row), related: finished ? await relatedOf(req, row) : [] });
});

/**
 * DELETE /analyses/:id. While the song waits (W3.12) its uploader takes it
 * back: the job, the row and the spooled audio go, so it costs nothing of the
 * day's quota. Once it has finished (W3.26) its uploader deletes it: the
 * result, the names and the publication go at once, the row itself on the
 * next UTC day (until then it still counts in that day's quota, or deleting
 * would be a way around it). One that is being analysed stays (409
 * NOT_QUEUED): the worker has no way to hear about it mid-stage, and the
 * claim and this delete are decided by the same row lock.
 */
const deleteRateLimit = guard('delete', 60, 10 * 60_000);

router.delete('/analyses/:id', deleteRateLimit, requireSameOrigin, optionalSession, async (req, res) => {
  const row = await readable(req);
  const store = analyses();
  if (!(await store.cancel(row.publicId)) && !(await store.deleteOwn(row.publicId))) {
    throw new HttpError(409, 'A song that is being analysed cannot be cancelled or deleted until it ends.', 'NOT_QUEUED');
  }
  await discard(row.publicId);
  // Its saved versions (W12.21) go with it, even while the erased row waits out the day.
  await versions().removeAll(row.publicId);
  // The queue page shows it gone on its next poll, not a second later.
  queueSnapshot = { at: 0, read: null };
  res.status(204).end();
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
