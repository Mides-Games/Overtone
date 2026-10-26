import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../lib/api.js'

/**
 * The upload form. It is wired to `POST /api/v1/analyses`, which answers 501
 * until the queue and the worker exist (phase W3.4); the page says so plainly
 * instead of pretending.
 *
 * The audio's length is read in the browser first, so a song over the limit is
 * refused before a single byte is uploaded. The server will check it again.
 */
const OUTPUTS = ['timingPoints', 'osu', 'csv', 'click']

export default function Analyze() {
  const { t } = useTranslation()
  const [limits, setLimits] = useState(null)
  const [audio, setAudio] = useState(null)
  const [seconds, setSeconds] = useState(null)
  const [osu, setOsu] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [state, setState] = useState({ kind: 'idle' })

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

  async function submit(event) {
    event.preventDefault()
    if (!audio) return setState({ kind: 'error', message: t('analyze.pickAudio') })

    if (limits && seconds && seconds > limits.maxAudioSeconds) {
      return setState({
        kind: 'error',
        message: t('analyze.tooLong', { minutes: (seconds / 60).toFixed(1), limit: limits.maxAudioSeconds / 60 }),
      })
    }

    const form = new FormData()
    form.append('audio', audio)
    if (osu) form.append('osu', osu)

    setState({ kind: 'sending' })
    try {
      await api('/analyses', { method: 'POST', form })
      setState({ kind: 'idle' })
    } catch (error) {
      if (error.status === 501) setState({ kind: 'notReady' })
      else setState({ kind: 'error', message: t('analyze.failed', { message: error.message }) })
    }
  }

  return (
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('analyze.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('analyze.subtitle')}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
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
              accept="audio/*,.mp3,.ogg,.wav,.flac"
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

          <div className="space-y-2">
            <span className="label block">{t('analyze.osuLabel')}</span>
            {/* A styled button rather than the native control, whose text is in the browser's language, not the page's. */}
            <div className="flex items-center gap-3">
              <label htmlFor="osu" className="btn-ghost h-9 shrink-0 cursor-pointer">
                {t('analyze.chooseOsu')}
              </label>
              <span className={`min-w-0 truncate text-label ${osu ? 'text-text' : 'text-dim'}`}>{osu ? osu.name : t('analyze.noOsu')}</span>
              <input id="osu" type="file" accept=".osu" className="sr-only" onChange={(e) => setOsu(e.target.files?.[0] ?? null)} />
            </div>
            <p className="text-caption text-dim">{t('analyze.osuHint')}</p>
          </div>

          <button type="submit" className="btn-primary w-full" disabled={state.kind === 'sending'}>
            {state.kind === 'sending' ? t('analyze.sending') : t('analyze.submit')}
          </button>

          {state.kind === 'notReady' && (
            <div role="status" className="space-y-2 rounded-control border border-amber/40 bg-amber/10 p-4">
              <span className="chip-amber">{t('analyze.notReadyTitle')}</span>
              <p className="text-label text-text">{t('analyze.notReady')}</p>
            </div>
          )}
          {state.kind === 'error' && (
            <p role="alert" className="rounded-control border border-red/40 bg-red/10 p-4 text-label text-text">
              {state.message}
            </p>
          )}
        </form>

        <aside className="min-w-0 space-y-6">
          <section className="panel overflow-hidden">
            <h2 className="label border-b border-line px-4 py-2.5">{t('analyze.limitsTitle')}</h2>
            <dl className="grid grid-cols-2 gap-px bg-line">
              <div className="space-y-1 bg-surface px-4 py-3">
                <dt className="label">{t('analyze.perDay')}</dt>
                <dd className="readout text-title">{limits ? limits.anonDailyLimit : '–'}</dd>
              </div>
              <div className="space-y-1 bg-surface px-4 py-3">
                <dt className="label">{t('analyze.maxLength')}</dt>
                <dd className="readout text-title">
                  {limits ? limits.maxAudioSeconds / 60 : '–'}
                  <span className="ml-1 text-label text-dim">min</span>
                </dd>
              </div>
            </dl>
            <p className="border-t border-line px-4 py-3 text-caption text-dim">{t('analyze.limitsNote')}</p>
          </section>

          <section className="space-y-3">
            <h2 className="label">{t('analyze.outputsTitle')}</h2>
            <ul className="divide-y divide-line rounded-panel border border-line">
              {OUTPUTS.map((key) => (
                <li key={key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="text-label">{t(`analyze.outputs.${key}`)}</span>
                  <span className="readout text-caption text-dim">{t('analyze.soon')}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
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
