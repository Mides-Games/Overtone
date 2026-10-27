import { songLabel } from './upload.js';

/**
 * One row of the public queue (W3.8), as anyone may see it. Pure, so the tests
 * reach it without a server.
 *
 * A private upload shows its state and timing only: no song, no file name, no
 * uploader. A public one shows the song and, when it was signed in, the
 * uploader's public Mides profile. The audio and the spool path are never
 * part of it, and the analysis id only reaches the person who may open it
 * (`mine`): for everybody else an id would be a link to a 404.
 */
export const queueEntry = (row, { mine = false, now = Date.now() } = {}) => {
  const created = new Date(row.createdAt).getTime();
  const finished = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
  const shown = !row.private;
  return {
    ...(mine ? { id: row.publicId } : {}),
    mine,
    status: row.status,
    ...(row.status === 'queued' && row.position ? { position: row.position } : {}),
    ...(row.status === 'running' ? { progress: row.progress ?? 0, stage: row.stage ?? null } : {}),
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
