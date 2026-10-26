import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { api } from '../lib/api.js'

/**
 * One analysis: its place in the queue, its progress, then its result.
 *
 * Polls `GET /api/v1/analyses/:id` while it is queued or running (every
 * second, then every three after a minute, so a long queue does not become a
 * stream of requests). The page is its own URL, so a reload or a link back
 * from the recent list lands here again.
 */
const LEVELS = {
  high: { tone: 'var(--accent)', key: 'strip.high' },
  medium: { tone: 'var(--lavender)', key: 'strip.medium' },
  check: { tone: 'var(--amber)', key: 'strip.check' },
}

export default function AnalysisResult() {
  const { t } = useTranslation()
  const { id } = useParams()
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    let timer = null
    const started = Date.now()

    async function poll() {
      try {
        const data = await api(`/analyses/${id}`)
        if (!alive) return
        setAnalysis(data)
        setError(null)
        if (data.status === 'queued' || data.status === 'running') {
          timer = setTimeout(poll, Date.now() - started > 60_000 ? 3000 : 1000)
        }
      } catch (failure) {
        if (!alive) return
        if (failure.status === 404) return setError('notFound')
        // A dropped connection is not the end of the analysis: try again.
        setError('network')
        timer = setTimeout(poll, 3000)
      }
    }
    poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [id])

  if (error === 'notFound') {
    return (
      <div className="panel space-y-3 p-6">
        <h1 className="font-display text-title font-bold uppercase">{t('result.notFoundTitle')}</h1>
        <p className="text-label text-muted">{t('result.notFound')}</p>
        <Link to="/analyze" className="btn-ghost">
          {t('result.another')}
        </Link>
      </div>
    )
  }

  if (!analysis) {
    return error === 'network' ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />

  }

  return (
    <div className="space-y-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="label text-accent">{t('result.eyebrow')}</p>
          <h1 className="truncate font-display text-[clamp(1.5rem,1.2rem+1.2vw,2.1rem)] font-bold">{analysis.filename}</h1>
        </div>
        <Link to="/analyze" className="btn-ghost shrink-0">
          {t('result.another')}
        </Link>
      </header>

      {error === 'network' && (
        <p role="status" className="text-caption text-dim">
          {t('result.reconnecting')}
        </p>
      )}

      {(analysis.status === 'queued' || analysis.status === 'running') && <Waiting analysis={analysis} />}
      {analysis.status === 'failed' && <Failed analysis={analysis} />}
      {analysis.status === 'refused' && <Refused result={analysis.result} />}
      {analysis.status === 'done' && <Result id={id} analysis={analysis} />}
    </div>
  )
}

function Waiting({ analysis }) {
  const { t } = useTranslation()
  const running = analysis.status === 'running'
  const percent = Math.round((analysis.progress ?? 0) * 100)
  return (
    <section className="panel space-y-4 p-5 sm:p-6" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-3 font-display text-[17px] font-semibold">
          <BrandLoader />
          {running ? t('result.running') : t('result.queued', { position: analysis.position ?? 1 })}
        </span>
        {running && <span className="readout text-label text-dim">{percent}%</span>}
      </div>
      {running && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(3, percent)}%` }} />
        </div>
      )}
      <p className="text-caption text-dim">
        {running && analysis.stage ? t(`result.stages.${analysis.stage}`, { defaultValue: t('result.running') }) : t('result.queuedNote')}
      </p>
    </section>
  )
}

function Failed({ analysis }) {
  const { t } = useTranslation()
  return (
    <section role="alert" className="space-y-2 rounded-panel border border-red/40 bg-red/10 p-5">
      <h2 className="font-display text-[17px] font-semibold">{t('result.failedTitle')}</h2>
      <p className="text-label text-text">{t('result.failed')}</p>
      {analysis.error && <p className="readout text-caption text-dim">{analysis.error}</p>}
    </section>
  )
}

function Refused({ result }) {
  const { t } = useTranslation()
  const code = result?.refusal?.code ?? 'refused'
  return (
    <section className="space-y-3 rounded-panel border border-amber/40 bg-amber/10 p-5">
      <span className="chip-amber">{t('result.refusedTitle')}</span>
      <p className="text-body text-text">{t(`result.refusal.${code}`, { defaultValue: t('result.refusal.refused') })}</p>
      <p className="text-label text-muted">{t('result.refusedWhy')}</p>
      {result?.refusal?.message && <p className="readout text-caption text-dim">{result.refusal.message}</p>}
    </section>
  )
}

function Result({ id, analysis }) {
  const { t } = useTranslation()
  const result = analysis.result
  const [copied, setCopied] = useState(null)
  const lines = result.red_lines ?? []
  const sections = result.sections ?? []
  const duration = (result.duration_s ?? 0) * 1000
  const meters = [...new Set(lines.map((line) => line.meter))]

  const readouts = [
    { label: t('strip.bpm'), value: formatBpm(result.global_bpm) },
    { label: t('strip.offset'), value: formatMs(result.offset_ms), unit: 'ms' },
    { label: t('strip.meter'), value: meters.length > 1 ? meters.map((m) => `${m}/4`).join(' · ') : result.meter },
    { label: t('result.redLines'), value: String(lines.length) },
  ]

  async function copy() {
    const text = `[TimingPoints]\r\n${result.osu_timing.split(/\r?\n/).filter(Boolean).join('\r\n')}\r\n`
    try {
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied(null), 2500)
  }

  return (
    <div className="space-y-6">
      <section className="panel overflow-hidden">
        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {readouts.map((r) => (
            <div key={r.label} className="space-y-1 bg-surface px-4 py-3">
              <dt className="label">{r.label}</dt>
              <dd className="readout text-title text-text">
                {r.value}
                {r.unit && <span className="ml-1 text-label text-dim">{r.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>

        {duration > 0 && sections.length > 0 && (
          <div className="space-y-2 border-t border-line px-4 py-3">
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
              {sections.map((s) => (
                <span
                  key={s.index}
                  style={{ width: `${Math.max(0.5, ((s.end_ms - s.start_ms) / duration) * 100)}%`, background: LEVELS[s.level]?.tone }}
                />
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-dim">
              {Object.entries(LEVELS).map(([key, level]) => (
                <li key={key} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: level.tone }} />
                  {t(level.key)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-3 border-t border-line px-4 py-3">
          <button type="button" className="btn-primary" onClick={copy}>
            {copied === 'ok' ? t('result.copied') : copied === 'failed' ? t('result.copyFailed') : t('result.copy')}
          </button>
          <a className="btn-ghost" href={`/api/v1/analyses/${id}/timing.txt`} download>
            {t('result.downloadTxt')}
          </a>
          <a className="btn-ghost" href={`/api/v1/analyses/${id}/timing.csv`} download>
            {t('result.downloadCsv')}
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="label">{t('result.redLines')}</h2>
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full min-w-[34rem] text-left text-label">
            <thead className="bg-surface-2">
              <tr className="label">
                <th className="px-4 py-2 font-semibold">#</th>
                <th className="px-4 py-2 font-semibold">{t('result.time')}</th>
                <th className="px-4 py-2 font-semibold">{t('strip.bpm')}</th>
                <th className="px-4 py-2 font-semibold">{t('strip.meter')}</th>
                <th className="px-4 py-2 font-semibold">{t('strip.confidence')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((line, i) => {
                const section = sections[i] ?? {}
                const level = LEVELS[section.level]
                return (
                  <tr key={i} className="readout">
                    <td className="px-4 py-2 text-dim">{i + 1}</td>
                    <td className="px-4 py-2">
                      {formatClock(line.time_ms)}
                      <span className="ml-2 text-caption text-dim">{formatMs(line.time_ms)} ms</span>
                    </td>
                    <td className="px-4 py-2">{formatBpm(line.bpm)}</td>
                    <td className="px-4 py-2">
                      {line.meter}/4
                      {!line.meter_known && <span className="ml-1 text-caption text-dim" title={t('result.meterGuess')}>?</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: level?.tone }} />
                        {level ? t(level.key) : '–'}
                        <span className="text-caption text-dim">{Math.round((section.confidence ?? 0) * 100)}%</span>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <span className="chip-amber shrink-0">{t('home.checkByEar')}</span>
        <div className="space-y-1">
          <p className="max-w-[72ch] text-label leading-relaxed text-muted">{t('result.honest')}</p>
          <p className="readout text-caption text-dim">
            {t('result.engine', { hash: result.engine_hash, vote: result.beat_vote ? t('result.voteOn') : t('result.voteOff') })}
            {analysis.cached ? ` · ${t('result.cached')}` : ''}
          </p>
        </div>
      </section>
    </div>
  )
}

// Up to three decimals, trailing zeros dropped: 128, 128.37, 222.222.
const formatBpm = (bpm) => (bpm === null || bpm === undefined ? '–' : String(Number(Number(bpm).toFixed(3))))

const formatMs = (ms) => (ms === null || ms === undefined ? '–' : String(Math.round(ms)))

const formatClock = (ms) => {
  const total = Math.max(0, ms) / 1000
  const minutes = Math.floor(total / 60)
  const seconds = (total - minutes * 60).toFixed(3).padStart(6, '0')
  return `${minutes}:${seconds}`
}
