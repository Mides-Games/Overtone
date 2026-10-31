/**
 * The team (/team, /testers) and the staff's rank form. Mides Projects'
 * ranks come from Mides and are only shown; Overtone's are given on /staff.
 */
import { api } from './api.js'

export const MIDES_RANKS = ['owner', 'admin', 'moderator']
/** Overtone's ranks, as the API's OVERTONE_RANKS (site/api services/team.service.js). */
export const OVERTONE_RANKS = ['developer', 'tester', 'translator', 'contributor']

export const team = () => api('/team')
export const setRank = (username, rank) => api('/staff/ranks', { method: 'POST', json: { username, rank: rank || null } })
