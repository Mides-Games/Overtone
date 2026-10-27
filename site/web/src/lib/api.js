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
  if (!response.ok) throw new ApiError(response.status, data?.error?.code, data?.error?.message)
  return data
}

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
