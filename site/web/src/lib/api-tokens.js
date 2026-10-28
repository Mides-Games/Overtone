/**
 * Personal API tokens (W12.20), as the tokens page asks for them. The secret
 * comes back once, from `createToken`; the page shows it and keeps it nowhere.
 */
import { api } from './api.js'

export const SCOPES = ['read:analyses', 'upload', 'read:timings']
export const NAME_MAX = 60

export const listTokens = () => api('/me/tokens')
export const createToken = (name, scopes) => api('/me/tokens', { method: 'POST', json: { name, scopes } })
export const revokeToken = (id) => api(`/me/tokens/${id}`, { method: 'DELETE' })

/** The form's own check, before anything is sent: a name and at least one known scope. */
export function tokenFormProblem(name, scopes) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'name'
  if ([...trimmed].length > NAME_MAX) return 'long'
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => SCOPES.includes(s))) return 'scopes'
  return null
}

/** A `curl` line that reads with `token` (shown with a placeholder, never the secret, unless it was just made). */
export const curlExample = (origin, token = '$OVERTONE_TOKEN') =>
  `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/me/analyses`
