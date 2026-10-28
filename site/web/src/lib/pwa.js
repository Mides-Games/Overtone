/**
 * The page's side of the installable app (W12.23); the service worker is
 * public/sw.js and holds the caching rules.
 *
 * - Registered in a production build only: in development it would serve
 *   Vite's modules from a cache and hide every edit.
 * - `takeSharedAudio` picks up the file the share sheet sent (the worker
 *   keeps it in its own cache for that moment) and deletes it at once.
 * - `forgetOfflineResults` drops the offline copies of results, called on
 *   sign-out so the next person on this browser cannot read them offline.
 */
export const RESULTS_CACHE = 'overtone-results-v1'
export const SHARE_CACHE = 'overtone-share-v1'
export const SHARED_KEY = '/__overtone/shared-audio'

export function registerServiceWorker() {
  // Spelled out in full: Vite replaces `import.meta.env.PROD` at build time, and only that spelling.
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // No worker (a private window, a browser that refuses): the site works as before, online.
    })
  })
}

/** The `?shared=` the worker redirected to: 'file', 'none' (nothing usable was shared) or null. */
export function sharedState(search) {
  const value = new URLSearchParams(search).get('shared')
  if (value === '1') return 'file'
  if (value === 'none' || value === 'unavailable') return 'none'
  return null
}

/** The file name the worker stored, read back safely: decoded, without path or control characters. */
export function sharedName(raw) {
  let name = 'shared-audio'
  try {
    name = decodeURIComponent(String(raw ?? '')) || name
  } catch {
    // Not percent-encoded as the worker writes it: keep the default.
  }
  return name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'shared-audio'
}

/** The audio shared to the app, as a File, taken out of the worker's cache; null when there is none. */
export async function takeSharedAudio(store = globalThis.caches) {
  try {
    const cache = await store.open(SHARE_CACHE)
    const response = await cache.match(SHARED_KEY)
    if (!response) return null
    await cache.delete(SHARED_KEY)
    const blob = await response.blob()
    return new File([blob], sharedName(response.headers.get('X-Filename')), { type: blob.type || response.headers.get('Content-Type') || '' })
  } catch {
    return null
  }
}

/** Deletes every offline copy of a result. Safe to call without a worker or caches. */
export async function forgetOfflineResults(store = globalThis.caches) {
  try {
    await store?.delete(RESULTS_CACHE)
  } catch {
    // No Cache Storage here: nothing was kept.
  }
}
