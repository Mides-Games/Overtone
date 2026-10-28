/**
 * The bot's client of site/api's /api/internal/bot (site/api/src/routes/bot.routes.js).
 *
 * Every call carries `Authorization: Bearer <BOT_TOKEN>` and, for a person's
 * request, `X-Discord-User` with the id Discord gave the interaction: in a
 * header, never in the URL, so no access log keeps it. `fetch` is injected so
 * the tests can point it anywhere.
 */

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? null;
    this.details = details;
  }
}

const TIMEOUT_MS = 30_000;
// An upload of MAX_UPLOAD_MB over a slow link may take a while; the API is the one that limits it.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export const createApi = ({ base, token, fetch: doFetch = globalThis.fetch }) => {
  const call = async (method, path, { user, headers = {}, json, body, timeout = TIMEOUT_MS } = {}) => {
    const all = { Accept: 'application/json', Authorization: `Bearer ${token}`, ...headers };
    if (user) all['X-Discord-User'] = String(user);
    if (json !== undefined) all['Content-Type'] = 'application/json';
    let response;
    try {
      response = await doFetch(`${base}/api/internal/bot${path}`, {
        method,
        headers: all,
        body: json !== undefined ? JSON.stringify(json) : body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new ApiError(0, 'NETWORK', `Overtone did not answer (${error.cause?.code ?? error.name}).`);
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, data?.error?.code, data?.error?.message, data?.error?.details ?? null);
    }
    return data;
  };

  return {
    health: () => call('GET', '/health'),
    me: (user) => call('GET', '/me', { user }),
    /** The audio as the site's upload: raw body, the name percent-encoded (a header is Latin-1). */
    upload: (user, { audio, filename, hidden = false }) =>
      call('POST', '/analyses', {
        user,
        body: audio,
        timeout: UPLOAD_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(filename),
          ...(hidden ? { 'X-Private': '1' } : {}),
        },
      }),
    analysis: (user, id) => call('GET', `/analyses/${encodeURIComponent(id)}`, { user }),
    publish: (user, id) => call('POST', `/analyses/${encodeURIComponent(id)}/publish`, { user }),
    timing: (user, id) => call('GET', `/timings/${encodeURIComponent(id)}`, { user }),
    queue: (user) => call('GET', '/queue', { user }),
    recent: (user, target) => call('GET', '/recent', { user, headers: { 'X-Discord-Target': String(target) } }),
    link: (user, code) => call('POST', '/link', { user, json: { code } }),
    notify: (user, on) => call('PUT', '/notify', { user, json: { on } }),
    claimDms: () => call('POST', '/dms/claim'),
  };
};
