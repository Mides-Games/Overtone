import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { forgetOfflineResults, RESULTS_CACHE, SHARE_CACHE, SHARED_KEY, sharedName, sharedState, takeSharedAudio } from '../src/lib/pwa.js'

/**
 * The installable app (W12.23). The worker (public/sw.js) is run here in a
 * bare context, as a browser would load it, and its rules are read off
 * `self.overtone`: what it caches, and above all what it never does.
 */
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const worker = () => {
  const self = { location: { origin: 'https://o.test' }, addEventListener: () => {} }
  vm.runInNewContext(source, { self, URL, Response, Headers, caches: {}, fetch: () => {} })
  return self.overtone
}
const req = (path, { method = 'GET', mode = 'cors', origin = 'https://o.test' } = {}) => ({ url: `${origin}${path}`, method, mode })
const ID = 'a'.repeat(32)

test('the worker caches pages, assets and the visitor\'s own final results, and nothing else', () => {
  const { route } = worker()
  assert.equal(route(req('/analyze/x', { mode: 'navigate' })), 'page')
  assert.equal(route(req('/assets/index-abc.js')), 'asset')
  assert.equal(route(req('/manifest.webmanifest')), 'asset')
  assert.equal(route(req(`/api/v1/analyses/${ID}`)), 'result')
  assert.equal(route(req('/share-target', { method: 'POST' })), 'share')
  assert.equal(route(req(`/api/v1/analyses/${ID}`, { method: 'DELETE' })), 'forget')
  // Never: uploads, other API reads (public timings, lists, the account, tokens), exports, other origins, audio files.
  for (const [path, method] of [
    ['/api/v1/analyses', 'POST'], ['/api/v1/analyses/lookup', 'POST'], [`/api/v1/timings/${ID}`, 'GET'], ['/api/v1/timings', 'GET'],
    ['/api/v1/me', 'GET'], ['/api/v1/me/tokens', 'GET'], ['/api/v1/me/analyses', 'GET'], [`/api/v1/analyses/${ID}/timing.txt`, 'GET'],
    [`/api/v1/analyses/${ID}/versions`, 'GET'], [`/api/v1/analyses/${ID}?x=1`, 'GET'], ['/api/v1/analyses/queue', 'GET'],
    ['/_song.mp3', 'GET'], [`/api/v1/analyses/${ID}/publish`, 'POST'],
  ]) assert.equal(route(req(path, { method })), null, `${method} ${path}`)
  assert.equal(route(req(`/api/v1/analyses/${ID}`, { origin: 'https://evil.test' })), null)
  assert.equal(route(req('/assets/x.js', { origin: 'https://cdn.test' })), null)
})

test('the worker reads the shell\'s assets, keeps only final results and takes only audio', () => {
  const { shellAssets, keepable, isAudio } = worker()
  const html = '<script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-b2.css"><link rel="icon" href="/favicon.svg"><script src="/assets/index-a1.js"></script>'
  // Spread: the worker's array is from its own context.
  assert.deepEqual([...shellAssets(html)], ['/assets/index-a1.js', '/assets/index-b2.css'])
  assert.equal(keepable({ status: 'done' }), true)
  assert.equal(keepable({ status: 'refused' }), true)
  for (const status of ['queued', 'running', 'failed', 'cancelled']) assert.equal(keepable({ status }), false, status)
  assert.equal(keepable(null), false)
  assert.equal(isAudio({ name: 'song.MP3', size: 10, type: '' }), true)
  assert.equal(isAudio({ name: 'voice', size: 10, type: 'audio/ogg' }), true)
  assert.equal(isAudio({ name: 'notes.txt', size: 10, type: 'text/plain' }), false)
  assert.equal(isAudio({ name: 'empty.mp3', size: 0, type: 'audio/mpeg' }), false)
  assert.equal(isAudio('song.mp3'), false)
})

test('the page reads the share back once, with a safe name, and forgets results on sign-out', async () => {
  assert.equal(sharedState('?shared=1'), 'file')
  assert.equal(sharedState('?shared=none'), 'none')
  assert.equal(sharedState('?shared=unavailable'), 'none')
  assert.equal(sharedState('?x=1'), null)
  assert.equal(sharedName(encodeURIComponent('Band - Song.mp3')), 'Band - Song.mp3')
  assert.equal(sharedName(encodeURIComponent('../../etc/x\u0007.mp3')), 'x.mp3')
  assert.equal(sharedName('%E0%A4%A'), 'shared-audio')

  const store = new Map()
  const caches = {
    open: async (name) => ({
      match: async (key) => store.get(`${name}|${key}`),
      delete: async (key) => store.delete(`${name}|${key}`),
    }),
    delete: async (name) => {
      for (const key of [...store.keys()]) if (key.startsWith(`${name}|`)) store.delete(key)
      return true
    },
  }
  store.set(`${SHARE_CACHE}|${SHARED_KEY}`, new Response(new Blob(['RIFF']), { headers: { 'X-Filename': encodeURIComponent('Shared.wav'), 'Content-Type': 'audio/wav' } }))
  const file = await takeSharedAudio(caches)
  assert.equal(file.name, 'Shared.wav')
  assert.equal(file.size, 4)
  assert.equal(await takeSharedAudio(caches), null, 'taken once')

  store.set(`${RESULTS_CACHE}|/api/v1/analyses/${ID}`, new Response('{}'))
  await forgetOfflineResults(caches)
  assert.equal(store.size, 0)
  await forgetOfflineResults(undefined)
})

/** The worker with its listeners, a Cache Storage in memory and `fetch` as given. */
function running(fetch) {
  const listeners = {}
  const stores = new Map()
  const keyOf = (k) => (typeof k === 'string' ? new URL(k, 'https://o.test').href : k.url)
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const m = stores.get(name)
    return {
      match: async (k) => m.get(keyOf(k))?.clone(),
      put: async (k, r) => void m.set(keyOf(k), r),
      delete: async (k) => m.delete(keyOf(k)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      addAll: async () => {},
    }
  }
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (k, { cacheName }) => (await open(cacheName)).match(k),
  }
  const self = { location: { origin: 'https://o.test' }, addEventListener: (type, fn) => (listeners[type] = fn) }
  vm.runInNewContext(source, { self, URL, Response, Headers, caches, fetch })
  const dispatch = async (request) => {
    let answer = null
    listeners.fetch({ request, respondWith: (p) => (answer = p) })
    return answer ? await answer : 'network'
  }
  return { dispatch, stores }
}

test('a final result is kept and served when the network or the API is gone; a queued one never is', async () => {
  const url = `https://o.test/api/v1/analyses/${ID}`
  let answer = () => new Response(JSON.stringify({ id: ID, status: 'done', result: { bpm: 128 } }), { headers: { 'Content-Type': 'application/json' } })
  const w = running(async () => answer())
  const online = await w.dispatch(new Request(url))
  assert.equal((await online.json()).status, 'done')
  assert.equal(w.stores.get('overtone-results-v1').size, 1)

  answer = () => { throw new TypeError('offline') }
  const offline = await w.dispatch(new Request(url))
  assert.equal(offline.headers.get('X-Overtone-Offline'), '1')
  assert.equal((await offline.json()).result.bpm, 128)
  answer = () => new Response('{"error":"api_unreachable"}', { status: 502 })
  assert.equal((await (await w.dispatch(new Request(url))).json()).status, 'done', 'the proxy\'s 502 counts as offline')

  // Deleted on the server: the copy goes.
  answer = () => new Response('{}', { status: 404 })
  assert.equal((await w.dispatch(new Request(url))).status, 404)
  assert.equal(w.stores.get('overtone-results-v1').size, 0)

  // Still queued: passed on, not kept.
  answer = () => new Response(JSON.stringify({ id: ID, status: 'queued' }))
  await w.dispatch(new Request(url))
  assert.equal(w.stores.get('overtone-results-v1').size, 0)

  // Other API reads are not even seen by the worker.
  assert.equal(await w.dispatch(new Request(`https://o.test/api/v1/timings/${ID}`)), 'network')
})

test('a shared audio file waits for the Analyze page, and anything else is turned away', async () => {
  const w = running(async () => { throw new Error('no network needed') })
  const form = new FormData()
  form.append('audio', new File(['RIFF'], 'Shared Song.wav', { type: 'audio/wav' }))
  const answer = await w.dispatch(new Request('https://o.test/share-target', { method: 'POST', body: form }))
  assert.equal(answer.status, 303)
  assert.equal(answer.headers.get('Location'), 'https://o.test/analyze?shared=1')
  const stored = w.stores.get('overtone-share-v1').get('https://o.test/__overtone/shared-audio')
  assert.equal(decodeURIComponent(stored.headers.get('X-Filename')), 'Shared Song.wav')
  assert.equal(await stored.clone().text(), 'RIFF')

  const text = new FormData()
  text.append('audio', new File(['hi'], 'notes.txt', { type: 'text/plain' }))
  const refused = await w.dispatch(new Request('https://o.test/share-target', { method: 'POST', body: text }))
  assert.equal(refused.headers.get('Location'), 'https://o.test/analyze?shared=none')
})

test('the manifest offers the share target the worker answers', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))
  assert.deepEqual({ ...manifest.share_target, params: undefined }, { action: '/share-target', method: 'POST', enctype: 'multipart/form-data', params: undefined })
  assert.equal(manifest.share_target.params.files[0].name, 'audio')
  assert.ok(manifest.share_target.params.files[0].accept.includes('audio/*'))
  assert.match(source, /formData\(\)\)\.get\('audio'\)/)
})
