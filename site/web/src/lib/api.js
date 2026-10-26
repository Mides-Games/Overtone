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
