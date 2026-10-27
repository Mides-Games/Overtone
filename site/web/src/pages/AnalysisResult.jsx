import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import AdjustExport from '../components/result/AdjustExport.jsx'
import AudioSource from '../components/result/AudioSource.jsx'
import { tempoRange } from '../components/result/draw.js'
import RedLinesTable, { LEVELS } from '../components/result/RedLinesTable.jsx'
import TempoMap from '../components/result/TempoMap.jsx'
import Transport from '../components/result/Transport.jsx'
import { useSongAudio } from '../hooks/useSongAudio.js'
import { api } from '../lib/api.js'
import { Player } from '../lib/player.js'
import { adjustLines, attackDrift, clickGrid, formatBpm, formatMs, lineDrift } from '../lib/timing.js'

/**
 * One analysis: its place in the queue, its progress, then its result.
 *
 * Polls `GET /api/v1/analyses/:id` while it is queued or running (every
 * second, then every three after a minute, so a long queue does not become a
 * stream of requests). The page is its own URL, so a reload or a link back
 * from the recent list lands here again.
 */
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

/**
 * The timing, to be checked by ear: the readouts, the tempo map with the song
 * and its clicks, the reader's adjustments and the exports, the red lines.
 * The song is the reader's own file, decoded here (ADR-W4).
 */
function Result({ id, analysis }) {
  const { t } = useTranslation()
  const result = analysis.result
  const [adjustment, setAdjustment] = useState({ factor: 1, nudgeMs: 0 })
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)
  const audio = useSongAudio(id, analysis.sha1)
  const [player] = useState(() => new Player())
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const clockRef = useRef(null)

  const durationS = result.duration_s ?? 0
  const sections = useMemo(() => result.sections ?? [], [result])
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  const lines = useMemo(() => adjustLines(result, adjustment), [result, adjustment])
  const grid = useMemo(() => clickGrid(lines, durationS), [lines, durationS])
  const attacks = useMemo(() => attackDrift(result.onsets?.t_ms ?? [], lines), [result, lines])
  // The worker's own per-line drift as it came; recomputed here once the reader moves the lines.
  const drift = useMemo(
    () =>
      adjusted && result.onsets
        ? lineDrift(result.onsets, attacks, lines, durationS * 1000)
        : lines.map((line) => {
            const s = sections[line.index] ?? {}
            return { drift_ms: s.drift_ms ?? null, drift_p90_ms: s.drift_p90_ms ?? null, drift_bias_ms: s.drift_bias_ms ?? null }
          }),
    [adjusted, result, attacks, lines, durationS, sections],
  )
  const spans = useMemo(
    () => lines.map((line, i) => ({ a: line.timeMs / 1000, b: i + 1 < lines.length ? lines[i + 1].timeMs / 1000 : durationS })),
    [lines, durationS],
  )

  useEffect(() => player.setGrid(grid), [player, grid])
  useEffect(() => player.setSections(spans), [player, spans])
  useEffect(() => {
    if (audio.kind === 'ready') player.setBuffer(audio.song.buffer)
  }, [player, audio.kind, audio.song])
  useEffect(() => () => player.destroy(), [player])

  const data = useMemo(
    () => ({
      lines,
      sections,
      grid,
      beats: result.beats ?? null,
      onsets: result.onsets ?? null,
      drift: attacks,
      envelope: result.onset_envelope ?? null,
      peaks: audio.kind === 'ready' ? audio.song.peaks : null,
      swing: result.swing?.spans ?? [],
      hints: result.pulse_hints ?? [],
      factor: adjustment.factor,
      durationS,
      range: tempoRange(lines, result.beats, adjustment.factor),
    }),
    [lines, sections, grid, result, attacks, audio.kind, audio.song, adjustment.factor, durationS],
  )

  const playFrom = (i) => {
    const line = lines[i]
    setSelected(i)
    // One beat early, so the line's first click is heard coming in.
    player.play(Math.max(0, (line.timeMs - line.beatMs) / 1000), { range: null, loopOn: false })
  }
  const loopLine = (i) => {
    setSelected(i)
    player.play(spans[i].a, { range: spans[i], loopOn: true })
  }

  const meters = [...new Set(lines.map((line) => line.meter))]
  const readouts = [
    { label: t('strip.bpm'), value: formatBpm(result.global_bpm === null ? null : result.global_bpm * adjustment.factor) },
    { label: t('strip.offset'), value: formatMs(lines[0]?.timeMs ?? null), unit: 'ms' },
    { label: t('strip.meter'), value: meters.length > 1 ? meters.map((m) => `${m}/4`).join(' · ') : result.meter },
    { label: t('result.redLines'), value: String(lines.length) },
  ]

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
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-dim">
            {Object.entries(LEVELS).map(([key, level]) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: level.tone }} />
                {t(level.key)}
              </li>
            ))}
          </ul>
          <p className="text-caption text-dim">{t('tempo.confidenceNote')}</p>
        </div>
      </section>

      <TempoMap
        data={data}
        player={player}
        snapshot={snapshot}
        selected={selected}
        hovered={hovered}
        onSelect={setSelected}
        onHover={setHovered}
        clockRef={clockRef}
      >
        <AudioSource audio={audio} filename={analysis.filename} />
        <Transport player={player} snapshot={snapshot} durationS={durationS} clockRef={clockRef} />
      </TempoMap>

      <AdjustExport id={id} analysis={analysis} lines={lines} adjustment={adjustment} onAdjust={setAdjustment} />

      <RedLinesTable
        lines={lines}
        sections={sections}
        drift={drift}
        selected={selected}
        hovered={hovered}
        onSelect={setSelected}
        onHover={setHovered}
        canPlay={snapshot.ready}
        onPlayFrom={playFrom}
        onLoop={loopLine}
      />

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
