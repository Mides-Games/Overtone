import express, { Router } from 'express';

import { botConfigured, env } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { bearerGuard } from '../middlewares/shared-secret.js';
import { analyses } from '../services/analysis.service.js';
import {
  accountByDiscord,
  claimDms,
  discordAnonHash,
  discordDayHash,
  discordKey,
  redeemLinkCode,
  setNotify,
} from '../services/links.service.js';
import { snowflake } from '../services/mides.service.js';
import { HttpError } from '../utils/http-error.js';
import { isVariable, mainBpm, publicTiming, redLineCount, songNames } from '../utils/timings.js';
import { AUDIO_EXTENSIONS } from '../utils/upload.js';
import { acceptUpload, refreshQueue } from './analyses.routes.js';

/**
 * The Discord bot's side of the API (W9.3-W9.5), under /api/internal/bot.
 *
 *   GET  /health                 the limits the bot checks an attachment against
 *   GET  /me                     the calling Discord user: linked or not, DMs on or off
 *   POST /analyses               raw audio, as the site's upload -> 202 { id } (or 200 from the cache)
 *   GET  /analyses/:id           one of the caller's analyses, summarised for an embed
 *   POST /analyses/:id/publish   the caller publishes one of theirs (an explicit option of /time-song)
 *   GET  /timings/:id            a published timing, summarised
 *   GET  /queue                  the queue's counts and the caller's own places
 *   GET  /recent                 the latest published timings of a linked Discord user (X-Discord-Target)
 *   POST /link                   { code }: links the caller to the account that showed the code
 *   PUT  /notify                 { on }: DMs when an analysis ends (W9.4)
 *   POST /dms/claim              the DMs to send now, each taken once
 *
 * Its own bearer, BOT_TOKEN: not WORKER_TOKEN, so the worker cannot act as
 * Discord users and the bot cannot claim jobs. Like the worker's routes,
 * overtone-web never forwards /api/internal (deploy/web/serve.mjs), so this
 * is reached on the API's own port only. With BOT_TOKEN unset every route is
 * a 503 BOT_OFF.
 *
 * Who a request is for comes in `X-Discord-User`, the id Discord gave the bot
 * with the interaction. The bot is trusted to pass it honestly, as the worker
 * is trusted with results; the id goes in a header, never in a URL, so no
 * access log keeps it. A linked Discord user acts as their account, with its
 * quota. An unlinked one gets the anonymous quota of one visitor, counted by
 * an HMAC of their id per day (docs/bot.md says why), and owns their
 * analyses by another HMAC of it: the same 404 as for a missing id meets
 * anyone else.
 */
const router = Router();

router.use((_req, _res, next) => {
  if (!botConfigured()) return next(new HttpError(503, 'The Discord bot is not configured on this server.', 'BOT_OFF'));
  return next();
});
router.use(bearerGuard(env.botToken));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const json = express.json({ limit: '4kb' });
const ID = /^[0-9a-f]{32}$/;

/** The caller: `req.discordId`, and `req.account` when they are linked. */
const discordUser = async (req, _res, next) => {
  const id = snowflake(req.get('X-Discord-User'));
  if (!id) return next(new HttpError(400, 'X-Discord-User is a Discord user id.', 'BAD_DISCORD_USER'));
  req.discordId = id;
  req.account = await accountByDiscord(id);
  return next();
};

// Every bot request comes from the bot's one address: these count per Discord user.
const perUser = (bucket, max, windowMs) => guard(bucket, max, windowMs, { keyOf: (req) => discordKey(req.discordId) });
const uploadLimit = perUser('bot-upload', 10, 10 * 60_000);
const readLimit = perUser('bot-read', 120, 10 * 60_000);
const linkLimit = perUser('bot-link', 10, 10 * 60_000);

/** The worst confidence level of a result's sections: what a person should look at first. */
const LEVEL_ORDER = ['check', 'medium', 'high'];
const levelOf = (result) => {
  const levels = (result?.sections ?? []).map((s) => s.level).filter((l) => LEVEL_ORDER.includes(l));
  return levels.length ? LEVEL_ORDER[Math.min(...levels.map((l) => LEVEL_ORDER.indexOf(l)))] : null;
};
const confidenceOf = (result) => {
  const values = (result?.sections ?? []).map((s) => s.confidence).filter((c) => typeof c === 'number');
  return values.length ? Math.min(...values) : null;
};

/**
 * An analysis as an embed reads it: never the file's SHA-1, the hashes or the
 * file name of a private row. `url` is the page the caller can open: the
 * public one once published, the result page when they have an account to
 * open it with, else none.
 */
const summary = (row, { linked }) => {
  const result = row.status === 'done' || row.status === 'refused' ? row.result : null;
  return {
    id: row.publicId,
    status: row.status,
    ...songNames(row),
    ...(row.status === 'queued' && row.position ? { position: row.position } : {}),
    ...(row.status === 'running' ? { progress: row.progress ?? 0, stage: row.stage ?? null } : {}),
    bpm: mainBpm(result),
    offsetMs: typeof result?.offset_ms === 'number' ? result.offset_ms : null,
    redLines: redLineCount(result),
    variable: isVariable(result),
    meter: typeof result?.meter === 'string' ? result.meter : null,
    level: levelOf(result),
    confidence: confidenceOf(result),
    refusal: row.status === 'refused' ? (result?.refusal?.message ?? null) : null,
    error: row.status === 'failed' ? (row.error ?? 'The analysis failed.') : null,
    cached: Boolean(row.cachedFrom),
    published: Boolean(row.publishedAt),
    url: row.publishedAt ? `${env.siteUrl}/t/${row.publicId}` : linked ? `${env.siteUrl}/analyze/${row.publicId}` : null,
  };
};

const isCallers = (req, row) =>
  Boolean((req.account && row.accountId === req.account.id) || (!row.accountId && row.anonHash === discordAnonHash(req.discordId)));

/** The caller's analysis `:id`, or the same 404 as for one that does not exist. */
const callers = async (req) => {
  const { id } = req.params;
  if (!ID.test(id)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  const row = await analyses().get(id);
  if (!row || !isCallers(req, row)) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
  return row;
};

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    siteUrl: env.siteUrl,
    maxUploadMb: env.maxUploadMb,
    extensions: AUDIO_EXTENSIONS,
    anonDailyLimit: env.anonDailyLimit,
    userDailyLimit: env.userDailyLimit,
  });
});

router.get('/me', discordUser, readLimit, (req, res) => {
  res.json({
    linked: Boolean(req.account),
    ...(req.account ? { username: req.account.username, notify: Boolean(req.account.discord_notify) } : { notify: false }),
  });
});

router.post('/analyses', discordUser, uploadLimit, async (req, res) => {
  const discordId = req.discordId;
  await acceptUpload(req, res, {
    ipHash: discordDayHash(discordId),
    anonHash: () => discordAnonHash(discordId),
  });
  refreshQueue();
});

router.get('/analyses/:id', discordUser, readLimit, async (req, res) => {
  const row = await callers(req);
  res.json(summary(row, { linked: Boolean(req.account) }));
});

router.post('/analyses/:id/publish', discordUser, linkLimit, async (req, res) => {
  const row = await callers(req);
  if (row.status !== 'done' || !(await analyses().publish(row.publicId))) {
    throw new HttpError(409, 'Only a finished timing can be published.', 'NOT_PUBLISHABLE');
  }
  const now = await analyses().get(row.publicId, { position: false });
  res.json(summary(now, { linked: Boolean(req.account) }));
});

router.get('/timings/:id', discordUser, readLimit, async (req, res) => {
  const { id } = req.params;
  if (!ID.test(id)) throw new HttpError(404, 'No such timing.', 'NOT_FOUND');
  // The caller's own analysis first, published or not; then anyone's published one.
  const own = await analyses().get(id, { position: false });
  if (own && isCallers(req, own)) return res.json(summary(own, { linked: Boolean(req.account) }));
  const row = await analyses().getPublished(id);
  if (!row) throw new HttpError(404, 'No such timing.', 'NOT_FOUND');
  const { title, artist, uploader, anonymous } = publicTiming(row);
  return res.json({ ...summary(row, { linked: false }), title, artist, uploader, anonymous });
});

router.get('/queue', discordUser, readLimit, async (req, res) => {
  const { live, more, recent } = await analyses().queue();
  const mine = live
    .filter((row) => isCallers(req, row))
    .map((row) => ({ id: row.publicId, status: row.status, ...songNames(row), position: row.position ?? null, progress: row.progress ?? null }));
  res.json({
    waiting: live.filter((r) => r.status === 'queued').length + more,
    running: live.filter((r) => r.status === 'running').length,
    finishedLastHour: recent.length,
    mine,
  });
});

router.get('/recent', discordUser, readLimit, async (req, res) => {
  const target = snowflake(req.get('X-Discord-Target'));
  if (!target) throw new HttpError(400, 'X-Discord-Target is a Discord user id.', 'BAD_DISCORD_USER');
  const account = await accountByDiscord(target);
  // Unlinked and linked-with-nothing-published read the same: an empty list.
  if (!account) return res.json({ linked: false, timings: [] });
  const { rows } = await analyses().history(account.id, { q: null, bpmMin: null, bpmMax: null, tempo: null, status: 'done', from: null, to: null, cursor: null, limit: 50 });
  const timings = rows
    .filter((row) => row.publishedAt)
    .slice(0, 5)
    .map((row) => ({ ...summary(row, { linked: false }), publishedAt: new Date(row.publishedAt).toISOString() }));
  return res.json({ linked: true, username: account.username, timings });
});

router.post('/link', discordUser, linkLimit, json, async (req, res) => {
  const account = await redeemLinkCode(req.body?.code, req.discordId);
  if (!account) throw new HttpError(400, 'That code is not valid or has expired. Make a new one on your profile.', 'BAD_LINK_CODE');
  res.json({ linked: true, username: account.username });
});

router.put('/notify', discordUser, linkLimit, json, async (req, res) => {
  const on = req.body?.on;
  if (typeof on !== 'boolean') throw new HttpError(400, 'on is true or false.', 'BAD_NOTIFY');
  if (!req.account || !(await setNotify(req.account.id, on))) {
    throw new HttpError(409, 'Link your Overtone account first: the DMs are for analyses of an account.', 'DISCORD_NOT_LINKED');
  }
  res.json({ notify: on });
});

router.post('/dms/claim', async (_req, res) => {
  const dms = [];
  for (const { publicId, discordId } of await claimDms(10)) {
    const row = await analyses().get(publicId, { position: false });
    if (row) dms.push({ discordId, analysis: summary(row, { linked: true }) });
  }
  res.json({ dms });
});

router.use((_req, _res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')));

export default router;
