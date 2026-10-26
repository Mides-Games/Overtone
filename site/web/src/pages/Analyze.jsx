import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import { useAuth } from '../context/AuthContext.jsx'
import { api, uploadAudio } from '../lib/api.js'
import { recentAnalyses, rememberAnalysis } from '../lib/recent.js'

/**
 * The upload form: `POST /api/v1/analyses` with the audio as the raw body,
 * then the analysis's own page (`/analyze/:id`), which follows the queue and
 * shows the result.
 *
 * The size, the format and the length are checked here first, so a file the
 * server would refuse is refused before a single byte is uploaded. The server
 * checks all of it again.
 */
const EXTENSIONS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus']
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
  const [audio, setAudio] = useState(null)
  const [seconds, setSeconds] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [state, setState] = useState({ kind: 'idle' })
  const [recent] = useState(recentAnalyses)

  useEffect(() => {
    api('/health')
      .then((data) => setLimits(data.limits))
      .catch(() => setLimits(null))
  }, [])

  async function pickAudio(file) {
    setAudio(file)
    setSeconds(null)
    setState({ kind: 'idle' })
    if (file) setSeconds(await durationOf(file))
  }

  function problemWith(file) {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!EXTENSIONS.includes(ext)) return t('analyze.errors.UNSUPPORTED_FORMAT')
    if (limits && file.size > limits.maxUploadMb * 1_048_576) {
      return t('analyze.errors.TOO_LARGE', { limit: limits.maxUploadMb })
    }
    if (limits && seconds && seconds > limits.maxAudioSeconds) {
      return t('analyze.tooLong', { minutes: (seconds / 60).toFixed(1), limit: limits.maxAudioSeconds / 60 })
    }
    return null
  }

  async function submit(event) {
    event.preventDefault()
    if (!audio) return setState({ kind: 'error', message: t('analyze.pickAudio') })
    const problem = problemWith(audio)
    if (problem) return setState({ kind: 'error', message: problem })

    setState({ kind: 'sending', sent: 0 })
    try {
      const created = await uploadAudio(audio, (sent) => setState({ kind: 'sending', sent }))
      rememberAnalysis(created.id, audio.name)
      navigate(`/analyze/${created.id}`)
    } catch (error) {
      setState({ kind: 'error', message: messageFor(t, error, limits) })
    }
  }

  const perDay = account ? limits?.userDailyLimit : limits?.anonDailyLimit

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
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                pickAudio(e.dataTransfer.files?.[0] ?? null)
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
                accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a,.opus"
                className="sr-only"
                onChange={(e) => pickAudio(e.target.files?.[0] ?? null)}
              />
            </label>

            {audio && (
              <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-2 px-3 py-2">
                <span className="min-w-0 truncate text-label">{audio.name}</span>
                <span className="readout shrink-0 text-caption text-dim">
                  {formatSize(audio.size)}
                  {seconds ? ` · ${formatTime(seconds)}` : ''}
                </span>
              </div>
            )}

            <button type="submit" className="btn-primary w-full" disabled={state.kind === 'sending'}>
              {state.kind === 'sending' ? t('analyze.sending', { percent: Math.round(state.sent * 100) }) : t('analyze.submit')}
            </button>

            {state.kind === 'sending' && (
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.sent * 100)}>
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(state.sent * 100)}%` }} />
              </div>
            )}

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
    case 'NETWORK':
      return t('analyze.errors.NETWORK')
    default:
      return t('analyze.failed', { message: error.message })
  }
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
