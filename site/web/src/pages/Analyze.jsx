import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import { useAuth } from '../context/AuthContext.jsx'
import { api, uploadAudio } from '../lib/api.js'
import { recentAnalyses, rememberAnalysis } from '../lib/recent.js'
import { readTags } from '../lib/tags.js'

/**
 * The upload form: `POST /api/v1/analyses` with the audio as the raw body,
 * then the analysis's own page (`/analyze/:id`), which follows the queue and
 * shows the result. Several files, or a folder, are sent one after another
 * (W3.9): each is its own analysis, and its card here follows it.
 *
 * The size, the format and the length are checked here first, so a file the
 * server would refuse is refused before a single byte is uploaded. The server
 * checks all of it again.
 */
const EXTENSIONS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus']
/** The most files one list holds; past it the oldest drop off. */
const MAX_FILES = 50
/** Refusals that the next file of a batch would get too. */
const STOPS_THE_BATCH = ['QUOTA_EXCEEDED', 'PENDING_LIMIT', 'QUEUE_FULL', 'NETWORK', 'RATE_LIMITED']
const OUTPUTS = [
  { key: 'timingPoints', ready: true },
  { key: 'csv', ready: true },
  { key: 'osu', ready: false },
  { key: 'click', ready: false },
]

export default function Analyze() {
  const { t } = useTranslation()
  const { account } = useAuth()
  const navigate = useNavigate()
  const [limits, setLimits] = useState(null)
  const [items, setItems] = useState([])
  const [hidden, setHidden] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [state, setState] = useState({ kind: 'idle' })
  const [recent] = useState(recentAnalyses)

  useEffect(() => {
    api('/health')
      .then((data) => setLimits(data.limits))
      .catch(() => setLimits(null))
  }, [])

  const update = (key, patch) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)))

  /** Adds files (several, or a whole folder's audio) to the list, reading each one's length and tags. */
  function pickAudio(files) {
    const picked = [...(files ?? [])].filter((file) => file.size > 0)
    if (!picked.length) return
    setState({ kind: 'idle' })
    const added = picked.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      seconds: null,
      tags: {},
      upload: { kind: 'ready' },
    }))
    setItems((list) => [...list, ...added].slice(-MAX_FILES))
    for (const item of added) {
      Promise.all([durationOf(item.file), readTags(item.file)]).then(([seconds, tags]) => update(item.key, { seconds, tags }))
    }
  }

  function problemWith({ file, seconds }) {
    if (!EXTENSIONS.includes(extensionOf(file))) return t('analyze.errors.UNSUPPORTED_FORMAT')
    if (limits && file.size > limits.maxUploadMb * 1_048_576) {
      return t('analyze.errors.TOO_LARGE', { limit: limits.maxUploadMb })
    }
    if (limits && seconds && seconds > limits.maxAudioSeconds) {
      return t('analyze.tooLong', { minutes: (seconds / 60).toFixed(1), limit: limits.maxAudioSeconds / 60 })
    }
    return null
  }

  /**
   * Sends the list one file at a time: each upload is its own analysis and
   * its own card. A single file goes straight to its result page, as before.
   */
  async function submit(event) {
    event.preventDefault()
    const waiting = items.filter((item) => item.upload.kind === 'ready' || item.upload.kind === 'error')
    if (!waiting.length) return setState({ kind: 'error', message: t('analyze.pickAudio') })
    const alone = items.length === 1
    if (alone) {
      const problem = problemWith(waiting[0])
      if (problem) return setState({ kind: 'error', message: problem })
    }

    setState({ kind: 'sending' })
    for (const item of waiting) {
      const problem = problemWith(item)
      if (problem) {
        update(item.key, { upload: { kind: 'error', message: problem } })
        continue
      }
      update(item.key, { upload: { kind: 'sending', sent: 0 } })
      try {
        const created = await uploadAudio(item.file, (sent) => update(item.key, { upload: { kind: 'sending', sent } }), {
          private: hidden,
          ...item.tags,
        })
        rememberAnalysis(created.id, item.file.name)
        if (alone) return navigate(`/analyze/${created.id}`)
        update(item.key, { upload: { kind: 'sent', id: created.id } })
      } catch (error) {
        if (alone) return setState({ kind: 'error', message: messageFor(t, error, limits) })
        update(item.key, { upload: { kind: 'error', message: messageFor(t, error, limits) } })
        // Nothing after this one would get through either.
        if (STOPS_THE_BATCH.includes(error.code)) break
      }
    }
    setState({ kind: 'idle' })
  }

  const perDay = account ? limits?.userDailyLimit : limits?.anonDailyLimit
  const atOnce = account ? limits?.userMaxPending : limits?.anonMaxPending
  const sending = state.kind === 'sending'
  const toSend = items.filter((item) => item.upload.kind === 'ready' || item.upload.kind === 'error').length

  return (
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('analyze.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('analyze.subtitle')}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 space-y-6">
          <form onSubmit={submit} className="panel min-w-0 space-y-5 p-5 sm:p-6">
            <label
              htmlFor="audio"
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={async (e) => {
                e.preventDefault()
                setDragging(false)
                pickAudio(await droppedFiles(e.dataTransfer))
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-panel border border-dashed px-4 py-10 text-center transition ${
                dragging ? 'border-accent bg-accent/5' : 'border-line-strong bg-surface-2 hover:border-line-hover'
              }`}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 14v1a5 5 0 0 0 5 5h6a5 5 0 0 0 5-5v-1M12 4v11M7.5 8.5 12 4l4.5 4.5" />
              </svg>
              <span className="font-display text-[15px] font-semibold">{t('analyze.drop')}</span>
              <span className="text-caption text-dim">{t('analyze.audioHint')}</span>
              <input
                id="audio"
                type="file"
                multiple
                accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a,.opus"
                className="sr-only"
                onChange={(e) => {
                  pickAudio(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="btn-ghost h-8 cursor-pointer px-3 text-caption">
                {t('analyze.folder')}
                <input
                  type="file"
                  multiple
                  webkitdirectory=""
                  className="sr-only"
                  onChange={(e) => {
                    pickAudio([...(e.target.files ?? [])].filter((file) => EXTENSIONS.includes(extensionOf(file))))
                    e.target.value = ''
                  }}
                />
              </label>
              {atOnce ? <span className="text-caption text-dim">{t('analyze.atOnce', { count: atOnce })}</span> : null}
            </div>

            {items.length > 0 && (
              <ul className="space-y-2">
                {items.map((item) => (
                  <FileCard
                    key={item.key}
                    item={item}
                    problem={item.upload.kind === 'ready' ? problemWith(item) : null}
                    onRemove={sending ? null : () => setItems((list) => list.filter((other) => other.key !== item.key))}
                  />
                ))}
              </ul>
            )}

            <label className="flex cursor-pointer items-start gap-3 rounded-control border border-line bg-surface-2 px-3 py-2.5">
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
              <span className="space-y-0.5">
                <span className="block text-label">{t('analyze.private')}</span>
                <span className="block text-caption text-dim">{t('analyze.privateHint')}</span>
              </span>
            </label>

            <button type="submit" className="btn-primary w-full" disabled={sending || (items.length > 0 && toSend === 0)}>
              {sending ? t('analyze.sendingMany') : toSend > 1 ? t('analyze.submitMany', { count: toSend }) : t('analyze.submit')}
            </button>

            {state.kind === 'error' && (
              <p role="alert" className="rounded-control border border-red/40 bg-red/10 p-4 text-label text-text">
                {state.message}
              </p>
            )}

            <p className="text-caption leading-relaxed text-dim">{t('analyze.privacy')}</p>
          </form>

          {recent.length > 0 && (
            <section className="space-y-3">
              <h2 className="label">{t('analyze.recentTitle')}</h2>
              <ul className="divide-y divide-line rounded-panel border border-line">
                {recent.map((item) => (
                  <li key={item.id}>
                    <Link to={`/analyze/${item.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2">
                      <span className="min-w-0 truncate text-label">{item.filename || item.id}</span>
                      <span className="readout shrink-0 text-caption text-dim">{new Date(item.at).toLocaleString()}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          <section className="panel overflow-hidden">
            <h2 className="label border-b border-line px-4 py-2.5">{account ? t('analyze.limitsTitleAccount') : t('analyze.limitsTitle')}</h2>
            <dl className="grid grid-cols-2 gap-px bg-line">
              <div className="space-y-1 bg-surface px-4 py-3">
                <dt className="label">{t('analyze.perDay')}</dt>
                <dd className="readout text-title">{perDay ?? '–'}</dd>
              </div>
              <div className="space-y-1 bg-surface px-4 py-3">
                <dt className="label">{t('analyze.maxLength')}</dt>
                <dd className="readout text-title">
                  {limits ? limits.maxAudioSeconds / 60 : '–'}
                  <span className="ml-1 text-label text-dim">min</span>
                </dd>
              </div>
            </dl>
            <p className="border-t border-line px-4 py-3 text-caption text-dim">
              {account ? t('analyze.limitsNoteAccount') : t('analyze.limitsNote')}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="label">{t('analyze.outputsTitle')}</h2>
            <ul className="divide-y divide-line rounded-panel border border-line">
              {OUTPUTS.map(({ key, ready }) => (
                <li key={key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="text-label">{t(`analyze.outputs.${key}`)}</span>
                  <span className={`readout text-caption ${ready ? 'text-accent' : 'text-dim'}`}>{ready ? t('analyze.ready') : t('analyze.soon')}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <span className="chip-amber self-start">{t('home.checkByEar')}</span>
            <p className="text-caption leading-relaxed text-muted">{t('analyze.honest')}</p>
          </section>
        </aside>
      </div>
    </div>
  )
}

/** A refusal from the server in the reader's language; its own message only as a last resort. */
export function messageFor(t, error, limits) {
  switch (error.code) {
    case 'QUOTA_EXCEEDED':
      return error.details?.scope === 'account'
        ? t('analyze.errors.QUOTA_ACCOUNT', { limit: error.details.limit })
        : t('analyze.errors.QUOTA_ANON', { limit: error.details?.limit ?? limits?.anonDailyLimit ?? '' })
    case 'TOO_LARGE':
      return t('analyze.errors.TOO_LARGE', { limit: error.details?.maxUploadMb ?? limits?.maxUploadMb ?? '' })
    case 'UNSUPPORTED_FORMAT':
    case 'UNSUPPORTED_MEDIA_TYPE':
      return t('analyze.errors.UNSUPPORTED_FORMAT')
    case 'EMPTY_UPLOAD':
      return t('analyze.errors.EMPTY_UPLOAD')
    case 'RATE_LIMITED':
      return t('analyze.errors.RATE_LIMITED')
    case 'PENDING_LIMIT':
      return t('analyze.errors.PENDING_LIMIT', { count: error.details?.limit ?? '' })
    case 'QUEUE_FULL':
      return t('analyze.errors.QUEUE_FULL')
    case 'NETWORK':
      return t('analyze.errors.NETWORK')
    default:
      return t('analyze.failed', { message: error.message })
  }
}

const extensionOf = (file) => file.name.split('.').pop()?.toLowerCase()

/** One file of the list: its name and size, then its upload, then its analysis, polled. */
function FileCard({ item, problem, onRemove }) {
  const { t } = useTranslation()
  const { file, seconds, upload } = item
  const [analysis, setAnalysis] = useState(null)

  useEffect(() => {
    if (upload.kind !== 'sent') return undefined
    let timer
    let stopped = false
    async function poll() {
      try {
        const next = await api(`/analyses/${upload.id}`)
        if (stopped) return
        setAnalysis(next)
        if (next.status === 'queued' || next.status === 'running') timer = setTimeout(poll, 3000)
      } catch {
        if (!stopped) timer = setTimeout(poll, 6000)
      }
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [upload.kind, upload.id])

  const percent =
    upload.kind === 'sending'
      ? Math.round(upload.sent * 100)
      : analysis?.status === 'running'
        ? Math.round((analysis.progress ?? 0) * 100)
        : null
  let status
  if (problem || upload.kind === 'error') status = <span className="text-red">{problem ?? upload.message}</span>
  else if (upload.kind === 'ready') status = t('analyze.card.ready')
  else if (upload.kind === 'sending') status = t('analyze.sending', { percent })
  else if (!analysis) status = t('analyze.card.sent')
  else if (analysis.status === 'queued') status = t('result.queued', { position: analysis.position ?? 1 })
  else if (analysis.status === 'running') {
    status = analysis.stage ? t(`result.stages.${analysis.stage}`, { defaultValue: t('result.running') }) : t('result.running')
  } else {
    const tone = analysis.status === 'done' ? 'text-accent' : analysis.status === 'refused' ? 'text-amber' : 'text-red'
    status = <span className={tone}>{t(`queue.status.${analysis.status}`)}</span>
  }

  return (
    <li className="space-y-1.5 rounded-control border border-line bg-surface-2 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        {upload.kind === 'sent' ? (
          <Link to={`/analyze/${upload.id}`} className="min-w-0 truncate text-label text-accent hover:underline">
            {file.name}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-label">{file.name}</span>
        )}
        <span className="flex shrink-0 items-center gap-2">
          <span className="readout text-caption text-dim">
            {formatSize(file.size)}
            {seconds ? ` · ${formatTime(seconds)}` : ''}
          </span>
          {onRemove && (upload.kind === 'ready' || upload.kind === 'error') && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('analyze.card.remove', { name: file.name })}
              className="px-1 text-dim hover:text-text"
            >
              ×
            </button>
          )}
        </span>
      </div>
      <p className="text-caption text-dim" aria-live="polite">
        {status}
      </p>
      {percent !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
    </li>
  )
}

/** Every file dropped, folders opened recursively where the browser lets it. */
async function droppedFiles(transfer) {
  const entries = [...(transfer.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.some((entry) => entry.isDirectory)) return [...(transfer.files ?? [])]
  const files = []
  async function walk(entry) {
    if (files.length >= MAX_FILES) return
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)))
      if (file && EXTENSIONS.includes(extensionOf(file))) files.push(file)
      return
    }
    const reader = entry.createReader()
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
      if (!batch.length) break
      for (const child of batch) await walk(child)
    }
  }
  for (const entry of entries) await walk(entry)
  return files
}

const formatSize = (bytes) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** The audio's length in seconds, or `null` if the browser cannot decode it. */
function durationOf(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const probe = new Audio()
    const done = (value) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null)
    probe.onerror = () => done(null)
    probe.src = url
  })
}
