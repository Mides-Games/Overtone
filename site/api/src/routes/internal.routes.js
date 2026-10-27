import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import express, { Router } from 'express';

import { env } from '../config/env.js';
import { bearerGuard } from '../middlewares/shared-secret.js';
import { analyses, setEngineHash } from '../services/analysis.service.js';
import { audioPath, discard } from '../services/spool.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The worker's side of the queue, under /api/internal (worker/main.py).
 *
 *   POST /jobs/claim          { engine_hash } -> 204, or { id, attempt, filename, max_seconds }
 *   GET  /jobs/:id/audio      the spooled audio of a running job
 *   POST /jobs/:id/progress   { attempt, stage, progress }
 *   POST /jobs/:id/result     { attempt, result }   -> the audio is deleted
 *   POST /jobs/:id/fail       { attempt, error }    -> the audio is deleted
 *
 * Every route demands `Authorization: Bearer <WORKER_TOKEN>`. overtone-web
 * never forwards /api/internal, so these are reached on the API's own port
 * only, and the proxy secret does not apply to them.
 *
 * Every call after the claim names the attempt it was given. A job handed
 * back to the queue after JOB_TIMEOUT_S and claimed again has a new attempt
 * number, so the first worker's late answer gets a 409 instead of
 * overwriting the second's.
 */
const router = Router();

router.use(bearerGuard(env.workerToken));
// A result carries every red line and the [TimingPoints] text: larger than
// the 16 kB the public routes allow, and only the worker can send it.
router.use(express.json({ limit: '2mb' }));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{8,64}$/;
const STAGE = /^[a-z_]{1,24}$/;

const idOf = (req) => {
  if (!ID.test(req.params.id)) throw new HttpError(404, 'No such job.', 'NOT_FOUND');
  return req.params.id;
};

const attemptOf = (req) => {
  const attempt = req.body?.attempt;
  if (!Number.isInteger(attempt) || attempt < 1) throw new HttpError(400, 'attempt is required.', 'BAD_ATTEMPT');
  return attempt;
};

const stale = () => new HttpError(409, 'This job is not running at that attempt any more.', 'JOB_NOT_RUNNING');

/** Jobs stuck past JOB_TIMEOUT_S go back to the queue, or fail after the last attempt. */
export const sweepStaleJobs = async () => {
  const failed = await analyses().requeueStale(env.jobTimeoutS);
  for (const id of failed) await discard(id);
  if (failed.length) console.warn(`[queue] ${failed.length} job(s) timed out on their last attempt`);
};

router.post('/jobs/claim', async (req, res) => {
  const hash = req.body?.engine_hash;
  if (typeof hash !== 'string' || !HASH.test(hash)) {
    throw new HttpError(400, 'engine_hash is required.', 'BAD_ENGINE_HASH');
  }
  setEngineHash(hash);
  await sweepStaleJobs();
  const job = await analyses().claim();
  if (!job) return res.status(204).end();
  return res.json({
    id: job.publicId,
    attempt: job.attempt,
    filename: job.filename,
    max_seconds: env.maxAudioSeconds,
  });
});

router.get('/jobs/:id/audio', async (req, res) => {
  const id = idOf(req);
  const attempt = Number(req.query.attempt);
  const row = await analyses().get(id, { position: false });
  if (!row || row.status !== 'running') throw stale();
  if (Number.isInteger(attempt) && attempt > 0 && !(await analyses().isRunning(id, attempt))) throw stale();
  const path = audioPath(id);
  const info = await stat(path).catch(() => null);
  if (!info) throw new HttpError(410, 'The audio of this job is gone.', 'AUDIO_GONE');
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(info.size));
  createReadStream(path).pipe(res);
});

router.post('/jobs/:id/progress', async (req, res) => {
  const id = idOf(req);
  const attempt = attemptOf(req);
  const stage = typeof req.body.stage === 'string' && STAGE.test(req.body.stage) ? req.body.stage : null;
  const progress = Number(req.body.progress);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new HttpError(400, 'progress is a number from 0 to 1.', 'BAD_PROGRESS');
  }
  if (!(await analyses().progress(id, attempt, { stage, progress }))) throw stale();
  res.status(204).end();
});

// What a stored result may hold. The worker is trusted to be honest, not to be
// right: a bug there, or a stolen WORKER_TOKEN, must not put a NaN, a
// megabyte label or a formula into what every page and download reads back.
// Fields not named here (a newer worker's) pass through unchecked.
const MAX_LINES = 2000;
const MAX_MS = 4 * 3600 * 1000;
const LEVELS = new Set(['high', 'medium', 'check']);
const REFUSAL_CODE = /^[a-z_]{1,32}$/;

const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const nullOr = (check) => (value) => value === null || value === undefined || check(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const time = (value) => finite(value, -60_000, MAX_MS);
const bpm = (value) => finite(value, 1e-3, 10_000);

const validLine = (line) =>
  line && typeof line === 'object' &&
  time(line.time_ms) &&
  bpm(line.bpm) &&
  finite(line.beat_length_ms, 6, 60_000_000) &&
  Number.isInteger(line.meter) && line.meter >= 1 && line.meter <= 16 &&
  (line.meter_known === undefined || typeof line.meter_known === 'boolean');

const validSection = (section) =>
  section && typeof section === 'object' &&
  (section.index === undefined || (Number.isInteger(section.index) && section.index >= 0 && section.index < MAX_LINES)) &&
  time(section.start_ms) &&
  time(section.end_ms) &&
  section.end_ms >= section.start_ms &&
  bpm(section.bpm) &&
  finite(section.confidence, 0, 1) &&
  LEVELS.has(section.level) &&
  nullOr((v) => finite(v, 0, 60_000))(section.residual_ms) &&
  nullOr((v) => finite(v, 0, 1))(section.coverage);

/** A `timing-result v1` whose every field the site reads is the type and size it should be. */
export const validResult = (result) =>
  Boolean(result) &&
  typeof result === 'object' &&
  result.format === 'timing-result' &&
  result.version === 1 &&
  typeof result.refused === 'boolean' &&
  typeof result.engine_hash === 'string' &&
  HASH.test(result.engine_hash) &&
  Array.isArray(result.red_lines) &&
  Array.isArray(result.sections) &&
  result.red_lines.length <= MAX_LINES &&
  result.sections.length <= MAX_LINES &&
  result.red_lines.every(validLine) &&
  result.sections.every(validSection) &&
  text(result.osu_timing, 256 * 1024) &&
  nullOr(bpm)(result.global_bpm) &&
  nullOr(time)(result.offset_ms) &&
  nullOr((v) => finite(v, 0, 86_400))(result.duration_s) &&
  nullOr((v) => finite(v, 0, 1))(result.stability) &&
  nullOr((v) => finite(v, 0, 60_000))(result.residual_ms) &&
  nullOr((v) => text(v, 16))(result.meter) &&
  nullOr((v) => text(v, 32))(result.engine_mode) &&
  (result.findings === undefined || (Array.isArray(result.findings) && result.findings.length <= MAX_LINES)) &&
  nullOr((r) => typeof r === 'object' && REFUSAL_CODE.test(r.code) && text(r.message, 1000))(result.refusal) &&
  (result.refused ? result.red_lines.length === 0 && result.global_bpm === null : result.red_lines.length > 0);

router.post('/jobs/:id/result', async (req, res) => {
  const id = idOf(req);
  const attempt = attemptOf(req);
  const { result } = req.body;
  if (!validResult(result)) throw new HttpError(400, 'Not a timing-result v1.', 'BAD_RESULT');
  if (!(await analyses().finish(id, attempt, result))) throw stale();
  await discard(id);
  res.status(204).end();
});

router.post('/jobs/:id/fail', async (req, res) => {
  const id = idOf(req);
  const attempt = attemptOf(req);
  const error = String(req.body.error ?? 'The analysis failed.').slice(0, 500);
  if (!(await analyses().fail(id, attempt, error))) throw stale();
  await discard(id);
  res.status(204).end();
});

export default router;
