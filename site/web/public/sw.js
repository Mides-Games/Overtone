/*
 * Overtone's service worker (W12.23): the site installs as an app, opens the
 * results its visitor already opened without a network, and takes an audio
 * file shared from a phone's share sheet. Hand-written and small on purpose
 * (no Workbox): four routes, three caches, and every rule below in one place.
 *
 * What is cached, and what never is:
 *
 * - The app shell: index.html and the hashed /assets/* it loads, plus the
 *   icons and the manifest. Pages are network first (a release is seen at
 *   once) and fall back to the cached shell offline; assets are cache first,
 *   since their names change with their content.
 * - The visitor's own opened results: `GET /api/v1/analyses/<id>` answers
 *   whose status is final (done or refused). Only that route: it already
 *   answers only to whoever uploaded the song, so the copy is of something
 *   this browser could read anyway. Network first; the copy is read only when
 *   the network fails, and is dropped when the API says 404 (deleted), when
 *   the visitor deletes it, and when someone signs out (lib/pwa.js). At most
 *   MAX_RESULTS, oldest out first.
 * - Never: audio (the site serves none, ADR-W4), uploads and every other
 *   POST, published timings and lists (other people's, and they can be
 *   unpublished), the queue, the account, tokens, anything not GET.
 * - A shared audio file waits in its own cache for the one moment between the
 *   share sheet's POST and the Analyze page picking it up, which deletes it;
 *   one left over is deleted after SHARE_TTL_MS.
 */
const SHELL = 'overtone-shell-v1'
const RESULTS = 'overtone-results-v1'
const SHARE = 'overtone-share-v1'
const SHARED_KEY = '/__overtone/shared-audio'
const MAX_RESULTS = 50
const SHARE_TTL_MS = 10 * 60_000
const RESULT = /^\/api\/v1\/analyses\/[0-9a-f]{32}$/
const STATIC = ['/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png']
const AUDIO = /\.(mp3|ogg|wav|flac|m4a|opus)$/i

/** What to do with a request: 'share', 'forget', 'page', 'asset', 'result', or null for the network alone. */
function route(request) {
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return null
  if (request.method === 'POST' && url.pathname === '/share-target') return 'share'
  if (request.method === 'DELETE' && RESULT.test(url.pathname)) return 'forget'
  if (request.method !== 'GET') return null
  if (url.pathname.startsWith('/api/')) return RESULT.test(url.pathname) && !url.search ? 'result' : null
  if (request.mode === 'navigate') return 'page'
  if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) return 'asset'
  return null
}

/** The /assets/* an index.html loads, so the shell works offline from the first visit. */
function shellAssets(html) {
  return [...new Set([...String(html).matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]))]
}

/** Whether a stored answer of `/analyses/<id>` is one worth keeping: final, so it will not change. */
function keepable(body) {
  return Boolean(body) && (body.status === 'done' || body.status === 'refused')
}

/** Whether a shared file is audio the Analyze form takes. */
function isAudio(file) {
  return Boolean(file) && typeof file === 'object' && typeof file.name === 'string' && file.size > 0 &&
    (AUDIO.test(file.name) || String(file.type).startsWith('audio/'))
}

self.overtone = { route, shellAssets, keepable, isAudio, SHELL, RESULTS, SHARE, SHARED_KEY, MAX_RESULTS }

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      try {
        const page = await fetch('/', { cache: 'no-cache' })
        if (page.ok) {
          const html = await page.clone().text()
          await cache.put('/', page)
          await cache.addAll([...shellAssets(html), ...STATIC])
        }
      } catch {
        // Offline at install: the shell fills in as pages are visited.
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('overtone-') && ![SHELL, RESULTS, SHARE].includes(name)) await caches.delete(name)
      }
      const share = await caches.open(SHARE)
      for (const request of await share.keys()) {
        const response = await share.match(request)
        if (!(Date.now() - Number(response?.headers.get('X-Shared-At')) < SHARE_TTL_MS)) await share.delete(request)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'forget-results') event.waitUntil(caches.delete(RESULTS))
})

self.addEventListener('fetch', (event) => {
  const kind = route(event.request)
  if (kind === 'share') event.respondWith(share(event.request))
  else if (kind === 'forget') event.respondWith(forget(event.request))
  else if (kind === 'page') event.respondWith(page(event.request))
  else if (kind === 'asset') event.respondWith(asset(event.request))
  else if (kind === 'result') event.respondWith(result(event.request))
})

async function page(request) {
  try {
    const response = await fetch(request)
    // The shell is index.html for every route: keep the newest one.
    if (response.ok && (response.headers.get('Content-Type') ?? '').includes('text/html')) {
      const cache = await caches.open(SHELL)
      await cache.put('/', response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match('/', { cacheName: SHELL })
    if (cached) return cached
    throw error
  }
}

async function asset(request) {
  const cached = await caches.match(request, { cacheName: SHELL })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) (await caches.open(SHELL)).put(request, response.clone())
  return response
}

async function result(request) {
  const cache = await caches.open(RESULTS)
  const stored = async () => {
    const cached = await cache.match(request.url)
    if (!cached) return null
    // Said in a header, so the page could tell; the body is the answer as it was.
    const headers = new Headers(cached.headers)
    headers.set('X-Overtone-Offline', '1')
    return new Response(cached.body, { status: 200, headers })
  }
  let response
  try {
    response = await fetch(request)
  } catch (error) {
    const cached = await stored()
    if (!cached) throw error
    return cached
  }
  // The site's own proxy answering for an API that is down is offline too.
  if (response.status >= 502 && response.status <= 504) return (await stored()) ?? response
  if (response.status === 404) await cache.delete(request.url)
  else if (response.ok) {
    const body = await response.clone().json().catch(() => null)
    if (keepable(body)) {
      await cache.put(request.url, response.clone())
      const keys = await cache.keys()
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_RESULTS))) await cache.delete(old)
    }
  }
  return response
}

async function forget(request) {
  const response = await fetch(request)
  if (response.ok) await (await caches.open(RESULTS)).delete(request.url)
  return response
}

/** The share sheet's POST: the file waits in SHARE, and the Analyze page takes it from there. */
async function share(request) {
  let file = null
  try {
    file = (await request.formData()).get('audio')
  } catch {
    file = null
  }
  if (!isAudio(file)) return Response.redirect(new URL('/analyze?shared=none', self.location.origin).href, 303)
  const cache = await caches.open(SHARE)
  await cache.put(
    SHARED_KEY,
    new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-Shared-At': String(Date.now()),
      },
    }),
  )
  return Response.redirect(new URL('/analyze?shared=1', self.location.origin).href, 303)
}
