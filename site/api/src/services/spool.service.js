import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
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

const pathOf = (id, ext) => {
  if (!ID.test(id)) throw new Error('spool: not an analysis id');
  return join(env.spoolDir, `${id}.${ext}`);
};

export const audioPath = (id) => pathOf(id, 'audio');

/** Creates the folder, readable by this user only. */
export const prepareSpool = async ({ clear = false } = {}) => {
  await mkdir(env.spoolDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask, and an existing folder keeps its own.
  await chmod(env.spoolDir, 0o700).catch(() => {});
  // A half-written upload never finishes after a restart. Without a database
  // the jobs are gone too, so their audio goes with them.
  for (const name of await readdir(env.spoolDir)) {
    if (name.endsWith('.part') || (clear && name.endsWith('.audio'))) {
      await rm(join(env.spoolDir, name), { force: true });
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

/** The finished upload becomes the job's audio. */
export const commit = (id) => rename(pathOf(id, 'part'), audioPath(id));

export const discardPart = (id) => rm(pathOf(id, 'part'), { force: true });

export const discard = (id) => rm(audioPath(id), { force: true });
