import { useEffect, useSyncExternalStore } from 'react'

import { api } from './api.js'
import { createTracker } from './tracker.js'

/**
 * The site's one tracker (lib/tracker.js), wired to the browser: the API, this
 * tab's storage, real timers and the page's visibility. Every page reads it
 * through the two hooks below, so nothing is polled twice.
 */
const storage = (name) => {
  try {
    return window[name]
  } catch {
    // Some privacy settings throw on the mere access.
    return null
  }
}

export const tracker = createTracker({
  load: (id) => api(`/analyses/${id}`),
  session: storage('sessionStorage'),
  local: storage('localStorage'),
  hidden: () => document.visibilityState === 'hidden',
})
document.addEventListener('visibilitychange', () => tracker.visibilityChanged())
tracker.start()

/** The whole snapshot: entries, notices, settings, live readings, count in flight. */
export const useTracker = () => useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)

/** One analysis, read until final while the calling component shows it: `{ data, error }` or `null`. */
export function useAnalysis(id) {
  const snapshot = useTracker()
  useEffect(() => (id ? tracker.watch(id) : undefined), [id])
  return id ? (snapshot.live[id] ?? null) : null
}

/**
 * Turns browser notifications on or off (W3.14, W3.23). On asks the browser
 * first, and is remembered only if it said yes.
 */
export async function askToNotify(wanted) {
  if (!wanted || typeof Notification === 'undefined') return tracker.setSettings({ notify: false })
  const answer = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  tracker.setSettings({ notify: answer === 'granted' })
}
