import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The spool: uploaded audio waiting for the worker, and nothing else.
 *
 * A file here is named by its analysis id alone (`<32 hex>.audio`, or
 * `.part` while it arrives), so the name a client sent never becomes a path.
 * The audio is deleted when the worker's result or failure arrives, when a
 * job runs out of attempts, and when a cached result makes it unnecessary
 * (ADR-W4: the audio is never kept).
 */

const ID = /^[0-9a-f]{32}$/;
const MB = 1_048_576;

const pathOf = (id, ext) => {
  if (!ID.test(id)) throw new Error('spool: not an analysis id');
  return join(env.spoolDir, `${id}.${ext}`);
};

export const audioPath = (id) => pathOf(id, 'audio');

// ── The budget (SPOOL_MAX_MB) ────────────────────────────────────────────────
//
// What the spool holds is counted here, in this process: the waiting audio
// by id, and the uploads still arriving by the reservation each made before
// its first byte. One API process owns the spool, as it owns the rate limits.

/** id -> bytes of each committed `<id>.audio`. */
const held = new Map();
let heldBytes = 0;
let reservedBytes = 0;

export const spoolUsage = () => ({ held: heldBytes, reserved: reservedBytes, budget: env.spoolMaxMb * MB });

const spoolFull = () => new HttpError(503, 'The server has no room for more uploads right now. Try again in a few minutes.', 'SPOOL_FULL');

/** Free bytes on the spool's filesystem, or null when it cannot be read. */
const freeBytes = async () => {
  try {
    const fs = await statfs(env.spoolDir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
};

/**
 * Reserves `bytes` for an upload about to be received: refused with 503
 * SPOOL_FULL when the spool's budget, or the disk's free space less
 * SPOOL_MIN_FREE_MB, has no room for it. Returns the release, which is safe
 * to call more than once and must be called in a `finally`.
 */
export const reserve = async (bytes) => {
  const free = await freeBytes();
  // Checked and taken with no await in between: two uploads cannot both take the last room.
  if (free !== null && free - reservedBytes - bytes < env.spoolMinFreeMb * MB) throw spoolFull();
  if (heldBytes + reservedBytes + bytes > env.spoolMaxMb * MB) throw spoolFull();
  reservedBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes -= bytes;
  };
};

const hold = (id, bytes) => {
  if (held.has(id)) heldBytes -= held.get(id);
  held.set(id, bytes);
  heldBytes += bytes;
};

const letGo = (id) => {
  if (!held.has(id)) return;
  heldBytes -= held.get(id);
  held.delete(id);
};

/** Creates the folder, readable by this user only, and counts what it already holds. */
export const prepareSpool = async ({ clear = false } = {}) => {
  await mkdir(env.spoolDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask, and an existing folder keeps its own.
  await chmod(env.spoolDir, 0o700).catch(() => {});
  held.clear();
  heldBytes = 0;
  // A half-written upload never finishes after a restart. Without a database
  // the jobs are gone too, so their audio goes with them.
  for (const name of await readdir(env.spoolDir)) {
    if (name.endsWith('.part') || (clear && name.endsWith('.audio'))) {
      await rm(join(env.spoolDir, name), { force: true });
    } else if (name.endsWith('.audio') && ID.test(name.slice(0, -6))) {
      const info = await stat(join(env.spoolDir, name)).catch(() => null);
      if (info) hold(name.slice(0, -6), info.size);
    }
  }
};

/**
 * Streams a request body to `<id>.part`, hashing as it goes and stopping the
 * moment it passes `limit` bytes. Resolves to `{ sha1, bytes }`; throws a 413
 * past the limit and deletes what it wrote whenever it does not finish.
 */
export const receive = async (req, id, limit) => {
  const part = pathOf(id, 'part');
  const hash = createHash('sha1');
  let bytes = 0;

  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) {
        return done(new HttpError(413, `The file is larger than ${Math.round(limit / 1_048_576)} MB.`, 'TOO_LARGE'));
      }
      hash.update(chunk);
      return done(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(part, { mode: 0o600 }));
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return { sha1: hash.digest('hex'), bytes, part };
};

/** The finished upload of `bytes` becomes the job's audio, counted against the budget. */
export const commit = async (id, bytes) => {
  await rename(pathOf(id, 'part'), audioPath(id));
  hold(id, bytes);
};

export const discardPart = (id) => rm(pathOf(id, 'part'), { force: true });

export const discard = async (id) => {
  await rm(audioPath(id), { force: true });
  letGo(id);
};
