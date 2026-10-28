import { api } from './api.js'

/**
 * The community's calls (W5.2-W5.4) and the few rules the page shares.
 * Everything here is plain text from the API; the page renders it as text.
 */

/** A suggestion's states in the order a suggestion lives them; `rejected` can come from any. */
export const STATES = ['open', 'review', 'planned', 'progress', 'done', 'rejected']

/**
 * What each state looks like. The reserved colours keep their meanings
 * (docs/design.md, section 12): red is a red line, amber "check by ear", the
 * green the tempo curve, so none of them marks a suggestion. Accent is the
 * signal: the suggestion is going somewhere (planned, in progress, done);
 * the rest are neutral and their word says which.
 */
export const STATE_TONE = {
  open: 'chip-neutral',
  review: 'chip-neutral',
  planned: 'chip-accent',
  progress: 'chip-accent',
  done: 'chip-accent',
  rejected: 'chip-neutral',
}

/** The caps the API holds text to (site/api/src/routes/community.routes.js). */
export const LIMITS = { title: 120, titleMin: 3, suggestion: 4000, review: 2000, reason: 500 }

/** Characters as the API counts them: code points, so an emoji is one. */
export const length = (text) => [...(text ?? '')].length

export const listSuggestions = ({ sort, state, offset = 0 }) => {
  const query = new URLSearchParams({ sort, offset: String(offset) })
  if (state) query.set('state', state)
  return api(`/community/suggestions?${query}`)
}
export const getSuggestion = (id) => api(`/community/suggestions/${id}`)
export const postSuggestion = (title, body) => api('/community/suggestions', { method: 'POST', json: { title, body } })
export const vote = (id, on) => api(`/community/suggestions/${id}/vote`, { method: on ? 'PUT' : 'DELETE' })
export const setState = (id, state, reason) =>
  api(`/community/suggestions/${id}/state`, { method: 'POST', json: { state, ...(reason ? { reason } : {}) } })

export const listReviews = (offset = 0) => api(`/community/reviews?offset=${offset}`)
export const reviewFormToken = () => api('/community/reviews/form')
export const postReview = (review) => api('/community/reviews', { method: 'POST', json: review })
export const deleteOwnReview = () => api('/community/reviews/mine', { method: 'DELETE' })

/** `kind` is `suggestions` or `reviews`, as in the API's paths. */
export const report = (kind, id, reason) => api(`/community/${kind}/${id}/report`, { method: 'POST', json: { reason } })
export const moderate = (kind, id, action, reason) =>
  api(`/community/${kind}/${id}/moderate`, { method: 'POST', json: { action, ...(reason ? { reason } : {}) } })
export const moderationLog = () => api('/community/moderation')
