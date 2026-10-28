/**
 * The analyses this browser started, newest first, so a reload or a second
 * tab can find them again. Only ids and file names, in this browser's own
 * storage: the server already lets this browser read them (the anonymous
 * cookie or the session), this list only remembers where they are. Blocked
 * storage simply means no list.
 */
const KEY = 'overtone.recentAnalyses'
const MAX = 10

export function recentAnalyses() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((item) => /^[0-9a-f]{32}$/.test(item?.id ?? '')).slice(0, MAX) : []
  } catch {
    return []
  }
}

export function rememberAnalysis(id, filename) {
  try {
    const list = [{ id, filename, at: Date.now() }, ...recentAnalyses().filter((item) => item.id !== id)]
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    // Storage blocked: the analysis is still at its own URL.
  }
}

/** A cancelled analysis no longer exists: its link would only lead to a 404. */
export function forgetAnalysis(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentAnalyses().filter((item) => item.id !== id)))
  } catch {
    // Storage blocked: there was no list to clean.
  }
}
