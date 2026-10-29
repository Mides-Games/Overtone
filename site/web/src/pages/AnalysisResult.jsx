import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import CancelButton from '../components/CancelButton.jsx'
import CompareWithMap from '../components/compare/CompareWithMap.jsx'
import Term from '../components/Term.jsx'
import AdjustExport from '../components/result/AdjustExport.jsx'
import AudioSource from '../components/result/AudioSource.jsx'
import CheckHere from '../components/result/CheckHere.jsx'
import Disclosure from '../components/result/Disclosure.jsx'
import HowAsked from '../components/result/HowAsked.jsx'
import MapImage from '../components/result/MapImage.jsx'
import MoreDownloads from '../components/result/MoreDownloads.jsx'
import Reanalyse from '../components/result/Reanalyse.jsx'
import { tempoRange } from '../components/result/draw.js'
import RedLinesTable, { LEVELS } from '../components/result/RedLinesTable.jsx'
import TempoMap from '../components/result/TempoMap.jsx'
import Listening from '../components/result/Listening.jsx'
import Practice from '../components/result/Practice.jsx'
import Transport from '../components/result/Transport.jsx'
import { useExportOptions } from '../components/result/ExportOptions.jsx'
import Versions from '../components/result/Versions.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import { timingRows } from '../lib/osu-copy.js'
import usePageMeta from '../hooks/usePageMeta.js'
import { useCoverAccent } from '../hooks/useCoverAccent.js'
import { useSongAudio } from '../hooks/useSongAudio.js'
import { useTimingEdits } from '../hooks/useTimingEdits.js'
import { formatRange } from '../lib/analysis-options.js'
import { calculatorPath } from '../lib/calc.js'
import { checkSpans } from '../lib/check-spans.js'
import { addLine, updateLine } from '../lib/editor.js'
import { comparePath } from '../lib/compare.js'
import { Player } from '../lib/player.js'
import { heldAudio } from '../lib/session-audio.js'
import { tracker, useAnalysis } from '../lib/tracking.js'
import { publishAnalysis, timingPath, unpublishAnalysis } from '../lib/timings.js'
import { adjustLines, attackDrift, clickGrid, formatBpm, formatClock, formatMs, governing, isAdjusted, lineDrift } from '../lib/timing.js'

// The editor (W7) and its offset lab load after the page: a reader who never edits never waits for them.
const TimingEditor = lazy(() => import('../components/result/TimingEditor.jsx'))

/**
 * One analysis: its place in the queue, its progress, then its result.
 *
 * Reads `GET /api/v1/analyses/:id` through the tracker (lib/tracking.js)
 * while it is queued or running, at its polite pace (every second at first,
 * slower in a long queue or a hidden tab), and the tray shows the same
 * reading: the page and the tray never both ask. The page is its own URL, so
 * a reload or a link back from the recent list lands here again.
 */
export default function AnalysisResult() {
  const { t } = useTranslation()
  const { id } = useParams()
  const reading = useAnalysis(id)
  const analysis = reading?.data ?? null
  const error = reading?.error ?? null
  // W13.24: the cover's colour, once the result has read the song's tags.
  const [accent, setAccent] = useState(null)
  // The file's name names the tab: it never leaves this browser that way.
  usePageMeta(analysis?.filename || t('result.eyebrow'))

  // Only its uploader can read it at all, so one still in flight is the
  // visitor's own: the tray follows it from here on, onto any other page.
  const inFlight = analysis?.status === 'queued' || analysis?.status === 'running'
  useEffect(() => {
    if (inFlight) tracker.track(id, analysis.filename, { status: analysis.status })
  }, [id, inFlight])

  if (error === 'notFound') {
    return (
      <div className="space-y-6">
        <header className="rise space-y-4">
          <p className="eyebrow">{t('result.eyebrow')}</p>
          <h1 className="heading-headline">{t('result.notFoundTitle')}</h1>
        </header>
        <div className="border-t border-line">
          <EmptyState
            title={t('result.notFound')}
            action={
              <Link to="/analyze" className="btn-primary">
                {t('result.another')}
                <Icon name="arrow-right" size={16} />
              </Link>
            }
          />
        </div>
      </div>
    )
  }

  if (!analysis) {
    return error === 'network' ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <ResultSkeleton />
  }

  return (
    <div className="space-y-8">
      <header className={`rise flex flex-col gap-x-6 gap-y-4 sm:flex-row sm:items-end sm:justify-between ${ACCENT_HEADER}`} style={accentWash(accent)}>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="eyebrow" style={accent ? { color: accent.ink } : undefined}>
            {t('result.eyebrow')}
          </p>
          <h1 className="heading-headline break-words sm:truncate" title={analysis.filename ?? undefined}>
            {analysis.filename}
          </h1>
        </div>
        <Link to="/analyze" className="btn-ghost shrink-0 self-start sm:self-auto">
          <Icon name="upload" size={16} />
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
      {analysis.status === 'refused' && <HowAsked analysis={analysis} />}
      {analysis.status === 'done' && <Publish analysis={analysis} onChange={(next) => tracker.patch(id, next)} />}
      {analysis.status === 'done' && <Result id={id} analysis={analysis} owner onAccent={setAccent} />}
      {/* W3.24: the same song in another mode, from here; and the results it is linked to. */}
      {(analysis.status === 'done' || analysis.status === 'refused') && <Reanalyse analysis={analysis} />}
    </div>
  )
}

/**
 * The page before its first reading: shaped like the header, the readouts
 * and the map, so nothing jumps when they land (docs/design.md, section 6).
 */
export function ResultSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="space-y-8" role="status" aria-label={t('common.loading')}>
      <div className="space-y-4" aria-hidden="true">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-3/5" />
      </div>
      <div className="grid grid-cols-2 gap-6 border-y border-line py-5 sm:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="space-y-2">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-6 w-20" />
          </span>
        ))}
      </div>
      <Skeleton className="h-80 w-full rounded-panel" />
    </div>
  )
}

/**
 * The header's tint from the cover (W13.24): a wash of its colour fading to
 * the page. The box is there with or without a cover, so the text does not
 * move when the wash arrives. No negative bottom margin: Tailwind 4's space-y
 * sets margin-block-end at zero specificity, so a -mb won and slid the wash
 * over the card below.
 * hooks/useCoverAccent.js has already checked every text on it for AA.
 */
export const ACCENT_HEADER = '-mx-3 -mt-3 rounded-panel px-3 py-3 sm:-mx-4 sm:px-4'
export const accentWash = (accent) => (accent ? { backgroundImage: `linear-gradient(100deg, ${accent.wash}, transparent 85%)` } : undefined)

/**
 * Sharing the timing (W3.27): off until its uploader presses Publish, and
 * undone by Unpublish. A private upload asks first, since publishing makes
 * it public; the API refuses it otherwise (409 PRIVATE).
 */
function Publish({ analysis, onChange }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ kind: 'idle' }) // idle | confirm | busy | error | copied
  const link = typeof window === 'undefined' ? timingPath(analysis.id) : `${window.location.origin}${timingPath(analysis.id)}`

  async function publish(makePublic = false) {
    if (analysis.private && !makePublic) return setState({ kind: 'confirm' })
    setState({ kind: 'busy' })
    try {
      const done = await publishAnalysis(analysis.id, { makePublic })
      onChange({ published: true, publishedAt: done.publishedAt, private: false })
      setState({ kind: 'idle' })
    } catch (error) {
      if (error.code === 'PRIVATE') return setState({ kind: 'confirm' })
      setState({ kind: 'error' })
    }
  }

  async function unpublish() {
    setState({ kind: 'busy' })
    try {
      await unpublishAnalysis(analysis.id)
      onChange({ published: false, publishedAt: undefined })
      setState({ kind: 'idle' })
    } catch {
      setState({ kind: 'error' })
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setState({ kind: 'copied' })
    } catch {
      setState({ kind: 'error' })
    }
    setTimeout(() => setState((s) => (s.kind === 'copied' ? { kind: 'idle' } : s)), 2500)
  }

  const busy = state.kind === 'busy'
  return (
    // A strip between hairlines, not a panel: sharing is one press, and the
    // page's one primary action is the .osz further down.
    <section className="flex flex-col gap-3 border-y border-line py-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="share-title">
      <div className="flex min-w-0 items-start gap-3">
        <Icon name={analysis.published ? 'globe' : 'unlock'} size={20} className="mt-0.5 text-dim" />
        <div className="min-w-0 space-y-1">
          <h2 id="share-title" className="label">
            {t('timings.publish.title')}
          </h2>
          {analysis.published ? (
            <p className="text-label text-text">
              {t('timings.publish.isPublic')}{' '}
              <Link to={timingPath(analysis.id)} className="link readout break-all">
                {timingPath(analysis.id)}
              </Link>
            </p>
          ) : (
            <p className={`max-w-[72ch] text-label ${state.kind === 'confirm' ? 'text-amber' : 'text-muted'}`}>
              {state.kind === 'confirm' ? t('timings.publish.privateWarning') : t('timings.publish.note')}
            </p>
          )}
          {state.kind === 'error' && (
            <p role="alert" className="text-caption text-red">
              {t('timings.publish.failed')}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {analysis.published ? (
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={copy} disabled={busy}>
              <Icon name={state.kind === 'copied' ? 'check' : 'link'} size={16} />
              {state.kind === 'copied' ? t('timings.publish.copied') : t('timings.publish.copyLink')}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={unpublish} disabled={busy}>
              {t('timings.publish.unpublish')}
            </button>
          </>
        ) : state.kind === 'confirm' ? (
          <>
            <button type="button" className="btn-ghost btn-sm border-amber/60 text-amber" onClick={() => publish(true)}>
              {t('timings.publish.makePublic')}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setState({ kind: 'idle' })}>
              {t('timings.publish.keepPrivate')}
            </button>
          </>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={() => publish(false)} disabled={busy}>
            <Icon name="globe" size={16} />
            {busy ? t('timings.publish.busy') : t('timings.publish.publish')}
          </button>
        )}
      </div>
    </section>
  )
}

function Waiting({ analysis }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const running = analysis.status === 'running'
  const percent = Math.round((analysis.progress ?? 0) * 100)
  return (
    <section className="panel space-y-4 p-5 sm:p-6" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="heading-title flex items-center gap-3">
          <BrandLoader />
          {running ? t('result.running') : t('result.queued', { position: analysis.position ?? 1 })}
        </h2>
        {running && (
          <span className="readout text-title text-text">
            {percent}
            <span className="unit">%</span>
          </span>
        )}
      </div>
      {running && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={t('result.running')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          {/* scaleX, not width: the bar moves without a layout (docs/design.md, section 5). */}
          <div
            className="h-full origin-left bg-accent transition-transform duration-[var(--dur-panel)] ease-out"
            style={{ transform: `scaleX(${Math.max(3, percent) / 100})` }}
          />
        </div>
      )}
      <p className="text-caption text-dim">
        {running && analysis.stage ? t(`result.stages.${analysis.stage}`, { defaultValue: t('result.running') }) : t('result.queuedNote')}
      </p>
      {analysis.estimate && (
        <p className="readout text-caption text-dim">
          {t('modes.estimate.label')} {formatRange(t, analysis.estimate.lowS, analysis.estimate.highS)} · {t(`modes.names.${analysis.mode ?? 'normal'}`)}
          <span className="ml-1 font-sans">({t('modes.estimate.why')})</span>
        </p>
      )}
      {!running && <CancelButton id={analysis.id} onCancelled={() => navigate('/analyze')} />}
    </section>
  )
}

/**
 * The worker names why a job stopped at the start of its error
 * (worker/isolate.py): running out of memory or time is the server's limit,
 * not a damaged file, and the page says which.
 */
export const failureKey = (error) =>
  /^too_heavy:/.test(error ?? '') ? 'result.failedTooHeavy' : /^timeout:/.test(error ?? '') ? 'result.failedTimeout' : 'result.failed'

function Failed({ analysis }) {
  const { t } = useTranslation()
  return (
    <section role="alert" className="space-y-2 rounded-panel border border-red/40 bg-red/10 p-5">
      <h2 className="heading-title">{t('result.failedTitle')}</h2>
      <p className="text-label text-text">{analysis.removed ? t('result.removed') : t(failureKey(analysis.error))}</p>
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
 *
 * A published timing's page (W3.27) shows the same view to anyone: it has no
 * `sha1` to check a file against, so it passes `verify`, which asks the
 * server, and `csvHref`, the public CSV. Only the uploader's page (`owner`)
 * lists and saves versions (W12.21).
 *
 * The reader's own changes are `adjustment`: the ×2 / ÷2 and the nudge
 * (`frame`), and the red lines edited in the editor (W7, `edits`, kept by
 * hooks/useTimingEdits.js). Everything below reads the lines through
 * `adjustLines(result, adjustment)`, so an edit reaches the clicks, the copy,
 * the .osz and the exports exactly as the nudge does.
 */
export function Result({ id, analysis, verify = null, csvHref = null, playerRef = null, owner = false, onAccent = null, marks = null, onMark = null }) {
  const { t } = useTranslation()
  const result = analysis.result
  const [frame, setFrame] = useState({ factor: 1, nudgeMs: 0 })
  const editor = useTimingEdits(id, result, frame)
  const adjustment = useMemo(() => (editor.edits ? { ...frame, edits: editor.edits } : frame), [frame, editor.edits])
  const [editing, setEditing] = useState(false)
  // W12.24: a copied row is written as the whole block is (W12.8's options).
  const exportOptions = useExportOptions()
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)
  const audio = useSongAudio(id, analysis.sha1, verify)
  // W13.24: the cover of the song the reader holds (checked to be this analysis's audio) tints the page's header.
  const accent = useCoverAccent(audio.kind === 'ready' ? heldAudio(id) : null)
  useEffect(() => {
    onAccent?.(accent)
  }, [accent, onAccent])
  useEffect(() => () => onAccent?.(null), [onAccent])
  const [player] = useState(() => new Player())
  // A public page's comments (W13.15) move this player to the time they name.
  useEffect(() => {
    if (!playerRef) return undefined
    playerRef.current = player
    return () => {
      playerRef.current = null
    }
  }, [player, playerRef])
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const clockRef = useRef(null)
  const checks = useMemo(() => checkSpans(analysis.result), [analysis.result])
  const [checking, setChecking] = useState(null)
  const [focus, setFocus] = useState(null)
  // W12.10: a map the reader picked to compare with, held here only, and which timing the clicks play.
  const [map, setMap] = useState(null)
  const [clickSource, setClickSource] = useState('a')

  const durationS = result.duration_s ?? 0
  const sections = useMemo(() => result.sections ?? [], [result])
  const adjusted = isAdjusted(adjustment)
  const lines = useMemo(() => adjustLines(result, adjustment), [result, adjustment])
  // An undo or a delete can leave the selection past the last line.
  useEffect(() => {
    if (selected !== null && selected >= lines.length) setSelected(lines.length ? lines.length - 1 : null)
  }, [selected, lines.length])
  // The beats alone, for the map, the arrow keys and the taps; the clicks add the subdivisions the reader asked for (W12.6).
  const grid = useMemo(() => clickGrid(lines, durationS), [lines, durationS])
  const subdivision = snapshot.subdivision
  const clicks = useMemo(() => (subdivision > 1 ? clickGrid(lines, durationS, { subdivision }) : grid), [lines, durationS, subdivision, grid])
  // The engine's own lines' clicks, for the A/B (W12.5): only when the reader has moved them.
  const engineClicks = useMemo(
    () => (adjusted ? clickGrid(adjustLines(result), durationS, { subdivision }) : null),
    [adjusted, result, durationS, subdivision],
  )
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

  const mapGrid = useMemo(() => (map ? clickGrid(map.lines, durationS) : null), [map, durationS])
  // The map's grid when the reader asked for its clicks (W12.10); otherwise the result's, with its A/B (W12.5).
  useEffect(
    () => (clickSource === 'b' && mapGrid ? player.setGrid(mapGrid, null) : player.setGrid(clicks, engineClicks)),
    [player, clicks, engineClicks, mapGrid, clickSource],
  )
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
      clicks,
      subdivision,
      beats: result.beats ?? null,
      onsets: result.onsets ?? null,
      drift: attacks,
      envelope: result.onset_envelope ?? null,
      peaks: audio.kind === 'ready' ? audio.song.peaks : null,
      swing: result.swing?.spans ?? [],
      hints: result.pulse_hints ?? [],
      factor: adjustment.factor,
      durationS,
      range: tempoRange(map ? [...lines, ...map.lines] : lines, result.beats, adjustment.factor),
      other: map?.lines ?? null,
      otherLabel: t('compare.map'),
    }),
    [lines, sections, grid, clicks, subdivision, result, attacks, audio.kind, audio.song, adjustment.factor, durationS, map, t],
  )

  // The decoded song for the map's bands and spectrogram (W13.6, W13.7), cached per analysis.
  const songLanes = useMemo(() => (audio.kind === 'ready' ? { id, buffer: audio.song.buffer } : null), [id, audio.kind, audio.song])

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

  // "Check here": a span shown is the map's loop band (no audio needed), brought into view; played, it loops with the clicks.
  const spanOf = (item) => ({ a: item.startMs / 1000, b: Math.min(item.endMs / 1000, durationS || item.endMs / 1000) })
  const showSpan = (item) => {
    setChecking(item.key)
    if (item.sections) setSelected(item.sections[0])
    player.setRange(spanOf(item))
    setFocus({ ...spanOf(item), key: item.key, scroll: true })
  }
  const playSpan = (item) => {
    setChecking(item.key)
    if (item.sections) setSelected(item.sections[0])
    player.play(spanOf(item).a, { range: spanOf(item), loopOn: true })
    setFocus({ ...spanOf(item), key: item.key, scroll: false })
  }

  // The map's own edits (W7): a dragged line lands, a double-click adds one with the BPM and bar of the line before it.
  const moveLine = (i, ms) => {
    const out = editor.act((l) => updateLine(l, i, ms), (o) => ({ key: 'move', values: { n: o.selected + 1, time: formatClock(ms) } }))
    if (!out.error) setSelected(out.selected)
  }
  const addAt = (ms) => {
    const here = lines[governing(lines, ms / 1000)]
    if (!here) return
    const out = editor.act((l) => addLine(l, ms, here.bpm, { meter: here.meter }), (o) => ({ key: 'add', values: { n: o.selected + 1, time: formatClock(ms) } }))
    if (!out.error) setSelected(out.selected)
  }
  const audioFile = audio.kind === 'none' || audio.kind === 'checking' || audio.kind === 'mismatch' || audio.kind === 'unverifiable' ? null : heldAudio(id)

  const meters = [...new Set(lines.map((line) => line.meter))]
  const readouts = [
    { term: 'bpm', label: t('strip.bpm'), value: formatBpm(result.global_bpm === null ? null : result.global_bpm * adjustment.factor) },
    { term: 'offset', label: t('strip.offset'), value: formatMs(lines[0]?.timeMs ?? null), unit: 'ms' },
    { term: 'meter', label: t('strip.meter'), value: meters.length > 1 ? meters.map((m) => `${m}/4`).join(' · ') : result.meter },
    { term: 'redLine', label: t('result.redLines'), value: String(lines.length) },
  ]

  return (
    <div className="space-y-[calc(var(--space-section)*0.4)]">
      {/* The reading at a glance: a row of readouts between hairlines, not cards (docs/design.md, section 11.4). */}
      <section aria-label={t('result.eyebrow')} className="space-y-5">
        <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-4">
          {readouts.map((r, i) => (
            <div
              key={r.label}
              // Two by two on a phone, one row from 640 px: a hairline between neighbours, none at the edge.
              className={`min-w-0 space-y-1.5 border-line py-4 pr-3 ${i > 0 ? 'sm:border-l sm:pl-5' : ''} ${i % 2 ? 'max-sm:border-l max-sm:pl-4' : ''} ${i >= 2 ? 'max-sm:border-t' : ''}`}
            >
              <dt className="label">
                <Term id={r.term}>{r.label}</Term>
              </dt>
              <dd className="readout truncate text-heading font-medium leading-none text-text">
                {r.value}
                {r.unit && <span className="unit">{r.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-x-6 gap-y-2 lg:flex-row lg:items-center lg:justify-between">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-dim">
            <li className="label">
              <Term id="confidence">{t('strip.confidence')}</Term>
            </li>
            {Object.entries(LEVELS).map(([key, level]) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: level.tone }} />
                {t(level.key)}
              </li>
            ))}
          </ul>
          <p className="text-caption text-dim">{t('tempo.confidenceNote')}</p>
        </div>
        {/* W11.1, W3.21, W12.19: the mode, the hints and the stretch this reading covers. */}
        <HowAsked analysis={analysis} />
      </section>

      <ZoneNav />

      <section id="listen" aria-labelledby="listen-title" className="scroll-mt-24 space-y-6">
        <SectionHeader id="listen-title" eyebrow={t('result.zones.listen.eyebrow')} title={t('result.zones.listen.title')} />
        <TempoMap
          data={data}
          player={player}
          snapshot={snapshot}
          selected={selected}
          hovered={hovered}
          onSelect={setSelected}
          onHover={setHovered}
          clockRef={clockRef}
          focus={focus}
          song={songLanes}
          editing={editing}
          onToggleEdit={lines.length ? () => setEditing((on) => !on) : null}
          onMoveLine={moveLine}
          onAddAt={addAt}
          marks={marks}
          onMark={onMark}
        >
          <AudioSource audio={audio} filename={analysis.filename} visitor={Boolean(verify)} />
          <Transport player={player} snapshot={snapshot} durationS={durationS} clockRef={clockRef} />
          {/* The editor (W7) opens from the map's toolbar, right under the transport it plays with. */}
          {lines.length > 0 && (
            <Suspense fallback={null}>
              <TimingEditor
                editor={editor}
                editing={editing}
                onEditing={setEditing}
                lines={lines}
                selected={selected}
                onSelect={setSelected}
                player={player}
                snapshot={snapshot}
                result={result}
                durationS={durationS}
                owner={owner}
                nudgeMs={adjustment.nudgeMs}
                onAdjust={setFrame}
                audioFile={audioFile}
              />
            </Suspense>
          )}
          {/* Practice and the by-ear tools (W13.8, W12.2-W12.6) fold under one line: still mounted, so their keys work folded. */}
          <Disclosure title={t('result.moreTools.title')} hint={t('result.moreTools.hint')} inset="px-3" className="border-t border-line">
            <Practice player={player} snapshot={snapshot} />
            <Listening
              player={player}
              snapshot={snapshot}
              lines={lines}
              grid={grid}
              adjusted={adjusted}
              nudgeMs={adjustment.nudgeMs}
              onAdjust={setFrame}
            />
          </Disclosure>
        </TempoMap>
      </section>

      <section id="check" aria-labelledby="check-title" className="scroll-mt-24 space-y-8 border-t border-line pt-[calc(var(--space-section)*0.4)]">
        <SectionHeader id="check-title" eyebrow={t('result.zones.check.eyebrow')} title={t('result.zones.check.title')} />

        <CheckHere
          spans={checks}
          // Lit while its band is the map's loop: drawing another loop unlights it.
          active={snapshot.range && checks.some((c) => c.key === checking && Math.abs(c.startMs / 1000 - snapshot.range.a) < 1e-6) ? checking : null}
          canPlay={snapshot.ready}
          onShow={showSpan}
          onPlay={playSpan}
        />

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
          copyRows={(positions) => timingRows(result, lines, adjustment, positions, exportOptions)}
        />

        <CompareWithMap
          lines={lines}
          durationS={durationS}
          adjusted={adjusted}
          filename={analysis.filename}
          map={map}
          onMap={(next) => {
            setMap(next)
            if (!next) setClickSource('a')
          }}
          clicks={clickSource}
          onClicks={setClickSource}
          // A second early, so the line is heard coming in.
          onPlayAt={snapshot.ready ? (ms) => player.play(Math.max(0, ms / 1000 - 1), { range: null, loopOn: false }) : null}
        >
          <Link to={comparePath({ id })} className="btn-ghost btn-sm">
            {t('compare.withAnother')}
          </Link>
          {/* An edited timing's lines do not fit in a link: the comparison takes the ×2 and the nudge only. */}
          {adjusted && !adjustment.edits && (
            <Link to={comparePath({ id }, { id, ...adjustment })} className="btn-ghost btn-sm">
              {t('compare.withAdjusted')}
            </Link>
          )}
          {/* The first red line's BPM and offset, as the page has them, filled in. */}
          <Link to={calculatorPath(lines[0])} className="btn-ghost btn-sm">
            {t('calculator.fromResult')}
          </Link>
        </CompareWithMap>
      </section>

      <section id="export" aria-labelledby="export-title" className="scroll-mt-24 space-y-8 border-t border-line pt-[calc(var(--space-section)*0.4)]">
        <SectionHeader id="export-title" eyebrow={t('result.zones.export.eyebrow')} title={t('result.zones.export.title')} />
        <AdjustExport
          id={id}
          keptSource={verify ? 'timing' : 'analysis'}
          analysis={analysis}
          lines={lines}
          adjustment={adjustment}
          onAdjust={setFrame}
          audioFile={audioFile}
          songBuffer={audio.kind === 'ready' ? audio.song.buffer : null}
        >
          <MoreDownloads
            id={id}
            analysis={analysis}
            lines={lines}
            adjustment={adjustment}
            grid={grid}
            clicks={clicks}
            durationS={durationS}
            songBuffer={audio.kind === 'ready' ? audio.song.buffer : null}
            player={player}
            checks={checks}
            csvHref={csvHref}
          />
          {/* W12.18: a published timing's page (verify) is public by definition. */}
          <MapImage id={id} analysis={analysis} lines={lines} data={data} adjustment={adjustment} published={Boolean(analysis.published || verify)} />
        </AdjustExport>

        {owner && (
          <Versions
            analysis={analysis}
            adjustment={adjustment}
            onApply={(next) => {
              setFrame({ factor: next.factor, nudgeMs: next.nudgeMs })
              // A version's edits, or none: one step of the editor's history, so it undoes.
              if ((next.edits ?? null) !== (editor.edits ?? null)) editor.replace(next.edits ?? null, { key: 'version' })
            }}
          />
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-start sm:gap-5">
        {/* W4.6: the short version here, the whole disclaimer on its own page. */}
        <Link to="/disclaimer" className="chip-amber shrink-0 self-start transition-colors duration-150 ease-out hover:bg-amber/20">
          {t('home.checkByEar')}
        </Link>
        <div className="space-y-1">
          <p className="max-w-[72ch] text-label leading-relaxed text-muted">
            {t('result.honest')}{' '}
            <Link to="/disclaimer" className="link inline-flex items-center gap-1 whitespace-nowrap">
              {t('legal.resultLink')}
              <Icon name="arrow-right" size={14} />
            </Link>
          </p>
          <p className="readout text-caption text-dim">
            {t('result.engine', { hash: result.engine_hash, vote: result.beat_vote ? t('result.voteOn') : t('result.voteOff') })}
            {analysis.cached ? ` · ${t('result.cached')}` : ''}
          </p>
        </div>
      </section>
    </div>
  )
}

/**
 * The result's three zones as jump links (docs/design.md, section 11): the
 * page is long, and a reader who came for the .osz should not scroll past
 * the map to find it. Plain anchors: the browser scrolls, `scroll-mt` keeps
 * the zone's heading clear of the sticky bar.
 */
function ZoneNav() {
  const { t } = useTranslation()
  const zones = [
    { id: 'listen', icon: 'headphones' },
    { id: 'check', icon: 'red-lines' },
    { id: 'export', icon: 'package' },
  ]
  return (
    <nav aria-label={t('result.zones.nav')} className="-mt-2 flex flex-wrap items-center gap-2">
      <span className="label mr-1">{t('result.zones.nav')}</span>
      {zones.map((zone) => (
        <a key={zone.id} href={`#${zone.id}`} className="btn-ghost btn-sm">
          <Icon name={zone.icon} size={16} />
          {t(`result.zones.${zone.id}.eyebrow`)}
        </a>
      ))}
    </nav>
  )
}
