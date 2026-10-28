/**
 * A Discord attachment, from "someone sent a file" to bytes in memory.
 *
 * Checked twice: before downloading (name, declared size and type, and the
 * URL's host) and while downloading (the response's type and length, and the
 * running total, cut at the cap). The cap is the site's MAX_UPLOAD_MB, read
 * from the API, so the bot never fetches what the API would refuse.
 *
 * The audio lives in this process's memory only: never on disk, never in a
 * log, and dropped as soon as the upload to the API has been sent (ADR-W4).
 */

/** Discord serves attachments from these hosts only: anything else is not an attachment. */
export const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/**
 * The types an audio attachment may carry. Discord guesses them from the
 * name, so an MP3 may come as audio/mpeg and an Opus as audio/ogg; it may
 * also send none, or the generic octet-stream. A page or an image is not audio.
 */
const AUDIO_TYPE = /^(audio\/[a-z0-9.+-]+|video\/ogg|application\/ogg|application\/octet-stream)$/i;

const extensionOf = (name) => /\.([A-Za-z0-9]{1,5})$/.exec(name ?? '')?.[1].toLowerCase() ?? null;

export const typeOk = (type) => !type || AUDIO_TYPE.test(String(type).split(';')[0].trim());

/**
 * Whether `att` ({ name, size, contentType, url }) may be downloaded:
 * `{ ok: true }` or `{ ok: false, reason }` with reason `format`, `type`,
 * `size` or `host`.
 */
export const checkAttachment = (att, { maxBytes, extensions, hosts = ATTACHMENT_HOSTS }) => {
  const ext = extensionOf(att?.name);
  if (!ext || !extensions.includes(ext)) return { ok: false, reason: 'format' };
  if (!typeOk(att.contentType)) return { ok: false, reason: 'type' };
  if (!(Number(att.size) > 0) || Number(att.size) > maxBytes) return { ok: false, reason: 'size' };
  let url;
  try {
    url = new URL(att.url);
  } catch {
    return { ok: false, reason: 'host' };
  }
  if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname)) return { ok: false, reason: 'host' };
  return { ok: true };
};

export class DownloadError extends Error {
  constructor(reason) {
    super(`The attachment could not be downloaded (${reason}).`);
    this.reason = reason;
  }
}

/** The attachment's bytes, at most `maxBytes`; a DownloadError otherwise. */
export const download = async (url, { maxBytes, fetch: doFetch = globalThis.fetch, timeoutMs = 120_000 }) => {
  let response;
  try {
    // No redirect: an attachment URL that sends us elsewhere is not one.
    response = await doFetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DownloadError('network');
  }
  if (!response.ok || !response.body) throw new DownloadError('status');
  if (!typeOk(response.headers.get('content-type'))) throw new DownloadError('type');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadError('size');

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    // Leaving the loop cancels the stream: the rest is never read into memory.
    if (total > maxBytes) throw new DownloadError('size');
    chunks.push(chunk);
  }
  if (total === 0) throw new DownloadError('empty');
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
};
