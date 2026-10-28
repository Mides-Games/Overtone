import { songLabel } from './upload.js';

/**
 * One row of the public queue (W3.8), as anyone may see it. Pure, so the tests
 * reach it without a server.
 *
 * A private upload shows its state and timing only: no song, no file name, no
 * uploader. A public one shows the song and, when it was signed in, the
 * uploader's public Mides profile. The audio and the spool path are never
 * part of it, and the analysis id only reaches the person who may open it
 * (`mine`): for everybody else an id would be a link to a 404. A finished
 * anonymous upload that was not kept private carries `timing`, the id of its
 * read-only page (/t/<id>), so anyone can see how it was timed.
 *
 * Staff (W3.18) get `ref` on every waiting or running row: the handle the
 * moderation buttons act on. It opens nothing, and a private row still shows
 * no song and no uploader: removing or requeueing a job needs neither.
 */
/*
 * W11.1 and W3.16: a waiting or running row also says its mode and, when
 * the queue snapshot has one (utils/estimate.js), its estimated time to done
 * as a range, `{ lowS, highS }`, `highS` null for "at least". Neither says
 * anything of the song.
 */
export const queueEntry = (row, { mine = false, staff = false, now = Date.now(), estimate = null } = {}) => {
  const created = new Date(row.createdAt).getTime();
  const finished = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
  const shown = !row.private;
  return {
    ...(mine ? { id: row.publicId } : {}),
    ...(!mine && row.status === 'done' && shown && !row.uploader ? { timing: row.publicId } : {}),
    ...(staff && (row.status === 'queued' || row.status === 'running') ? { ref: row.publicId } : {}),
    mine,
    status: row.status,
    ...(row.status === 'queued' && row.position ? { position: row.position } : {}),
    ...(row.status === 'running' ? { progress: row.progress ?? 0, stage: row.stage ?? null } : {}),
    mode: row.mode ?? 'normal',
    ...(estimate && (row.status === 'queued' || row.status === 'running') ? { estimate } : {}),
    private: Boolean(row.private),
    song: shown ? songLabel(row) : null,
    uploader:
      shown && row.uploader
        ? {
            username: row.uploader.username,
            displayName: row.uploader.displayName ?? null,
            avatarUrl: row.uploader.avatarUrl ?? null,
          }
        : null,
    anonymous: shown ? !row.uploader : null,
    cached: Boolean(row.cachedFrom),
    createdAt: new Date(created).toISOString(),
    ...(finished ? { finishedAt: new Date(finished).toISOString() } : {}),
    // Waiting plus analysing, so far or in all.
    elapsedS: Math.max(0, Math.round(((finished ?? now) - created) / 1000)),
  };
};
