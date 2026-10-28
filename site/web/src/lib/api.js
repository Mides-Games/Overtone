/**
 * The one way the web talks to site/api: same origin, `/api/v1`, JSON.
 *
 * Every request that is not a GET carries `X-Requested-With: overtone-web`,
 * which the API demands as its half of the CSRF guard. The session is the
 * HttpOnly cookie; this code never sees it.
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code ?? null
  }
}

export async function api(path, { method = 'GET', json, form } = {}) {
  const headers = { Accept: 'application/json' }
  if (method !== 'GET') headers['X-Requested-With'] = 'overtone-web'

  let body
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  } else if (form) {
    body = form
  }

  let response
  try {
    response = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'NETWORK', 'The server could not be reached.')
  }

  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new ApiError(response.status, data?.error?.code, data?.error?.message)
    error.details = data?.error?.details ?? null
    throw error
  }
  return data
}

/** Cancels one of your analyses while it is still queued (W3.12); 409 `NOT_QUEUED` once it is not. */
export const cancelAnalysis = (id) => api(`/analyses/${id}`, { method: 'DELETE' })

/**
 * Asks the API whether this audio was already analysed (W3.11), by its SHA-1,
 * before a byte of it is uploaded. Resolves to `{ id, status, cached: true }`
 * on a hit and `null` otherwise, including when the browser cannot hash it
 * or the lookup fails: the upload then answers as it always did.
 */
export async function lookupAudio(file, options = {}) {
  let sha1
  try {
    const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer())
    sha1 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
  try {
    const found = await api('/analyses/lookup', {
      method: 'POST',
      json: {
        sha1, filename: file.name, size: file.size, private: Boolean(options.private), title: options.title ?? null, artist: options.artist ?? null,
        ...asked(options),
      },
    })
    return found?.cached ? found : null
  } catch (error) {
    // Over the daily cap of stored results the upload would be refused the
    // same way: say so now instead of sending the whole file first. A bad
    // option or a re-analysis that does not fit would be refused by the
    // upload too.
    if (['CACHE_LIMIT', 'BAD_OPTIONS', 'BAD_MODE', 'NOT_SAME_AUDIO', 'NOT_FOUND'].includes(error.code)) throw error
    return null
  }
}

/**
 * What a lookup's body says of how it was asked for (W11.1, W3.21, W3.24):
 * `options.mode`, `options.hints` (lib/analysis-options.js), the length the
 * browser read (`options.duration`, for the queue's estimate only) and the
 * analysis it re-analyses (`options.reanalysisOf`). Nothing for the defaults.
 */
const asked = (options) => ({
  ...(options.mode && options.mode !== 'normal' ? { mode: options.mode } : {}),
  ...(options.hints && Object.keys(options.hints).length ? { options: options.hints } : {}),
  ...(Number.isFinite(options.duration) && options.duration > 0 ? { duration: Math.round(options.duration * 10) / 10 } : {}),
  ...(options.reanalysisOf ? { reanalysisOf: options.reanalysisOf } : {}),
})

/**
 * Uploads an audio file as the raw body of `POST /api/v1/analyses`, reporting
 * the share sent through `onProgress(0..1)`. XMLHttpRequest rather than fetch
 * because fetch cannot report upload progress. Resolves to `{ id, status,
 * cached }`; rejects with an ApiError (`details` carries the server's).
 *
 * `options.private` keeps the song and the uploader off the public queue;
 * `options.title` and `options.artist` are the file's own tags (lib/tags.js).
 */
export function uploadAudio(file, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/v1/analyses')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-Requested-With', 'overtone-web')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    // A header is Latin-1: the name travels percent-encoded.
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    if (options.private) xhr.setRequestHeader('X-Private', '1')
    if (options.title) xhr.setRequestHeader('X-Title', encodeURIComponent(options.title))
    if (options.artist) xhr.setRequestHeader('X-Artist', encodeURIComponent(options.artist))
    // The same fields as the lookup's, as headers: the body is the audio.
    const how = asked(options)
    if (how.mode) xhr.setRequestHeader('X-Mode', how.mode)
    if (how.options) xhr.setRequestHeader('X-Options', encodeURIComponent(JSON.stringify(how.options)))
    if (how.duration) xhr.setRequestHeader('X-Duration', String(how.duration))
    if (how.reanalysisOf) xhr.setRequestHeader('X-Reanalysis-Of', how.reanalysisOf)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON: a proxy's page, say. The status still says what happened.
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data)
      const error = new ApiError(xhr.status, data?.error?.code, data?.error?.message)
      error.details = data?.error?.details ?? null
      return reject(error)
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'The server could not be reached.'))
    xhr.send(file)
  })
}
