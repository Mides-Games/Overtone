import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import CompareReport from '../components/compare/CompareReport.jsx'
import { ClicksSwitch } from '../components/compare/CompareWithMap.jsx'
import AudioSource from '../components/result/AudioSource.jsx'
import { tempoRange } from '../components/result/draw.js'
import TempoMap from '../components/result/TempoMap.jsx'
import Transport from '../components/result/Transport.jsx'
import Icon from '../components/ui/Icon.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import Skeleton, { SkeletonRows } from '../components/ui/Skeleton.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { useSongAudio } from '../hooks/useSongAudio.js'
import { api } from '../lib/api.js'
import { comparePath, compareTimings, readAnalysisRef, readSide } from '../lib/compare.js'
import { Player } from '../lib/player.js'
import { recentAnalyses } from '../lib/recent.js'
import { bpmLabel, checkTimingAudio, myAnalyses, publicTiming, songLine, timingPath } from '../lib/timings.js'
import { adjustLines, attackDrift, clickGrid, formatBpm } from '../lib/timing.js'

/**
 * One analysis's timing, as this visitor may read it: their own first
 * (`GET /analyses/:id`, which answers only its uploader), else a published
 * one (`GET /timings/:id`). Either way the same 404 for "not yours" and "no
 * such id", so this page can tell nobody whether a private analysis exists.
 */
async function loadTiming(id) {
  try {
    const own = await api(`/analyses/${id}`)
    if (own.status !== 'done' || !own.result?.red_lines?.length) return { id, error: 'notDone' }
    return { id, own: true, result: own.result, name: songLine({ title: own.tagTitle, artist: own.tagArtist }) ?? own.filename, sha1: own.sha1 }
  } catch (error) {
    if (error.status !== 404) return { id, error: 'network' }
  }
  try {
    const timing = await publicTiming(id)
    return { id, own: false, result: timing.result, name: songLine(timing), sha1: null }
  } catch (error) {
    return { id, error: error.status === 404 ? 'notFound' : 'network' }
  }
}

function useTiming(id) {
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!id) return setState(null)
    let alive = true
    setState({ id, loading: true })
    loadTiming(id).then((value) => alive && setState(value))
    return () => {
      alive = false
    }
  }, [id])
  return state?.id === id ? state : id ? { id, loading: true } : null
}

/**
 * Two timings side by side (W12.11): `/compare?a=<id>&b=<id>`, either an
 * analysis of the visitor's own or a published one, each optionally adjusted
 * (`ax`/`bx` ×0.5 or ×2, `an`/`bn` a nudge in ms), so one analysis can be put
 * against its own adjusted version. The page lines up their red lines
 * (lib/compare.js), draws B's on A's tempo map, and plays either one's clicks
 * over the visitor's own file of the song (ADR-W4: never uploaded).
 *
 * Not in the sitemap: what it shows depends on who asks, and an id in the
 * address is no page to index.
 */
export default function Compare() {
  const { t } = useTranslation()
  usePageMeta(t('compare.page.title'))
  const [params, setParams] = useSearchParams()
  const a = readSide(params, 'a')
  const b = readSide(params, 'b')
  const timingA = useTiming(a?.id)
  const timingB = useTiming(b?.id)

  const setSide = (key, side) => {
    const next = { a, b, [key]: side }
    setParams(new URLSearchParams(comparePath(next.a, next.b).split('?')[1] ?? ''), { replace: false })
  }
  const swap = () => setParams(new URLSearchParams(comparePath(b, a).split('?')[1] ?? ''))

  const ready = timingA?.result && timingB?.result
  return (
    <div className="space-y-10">
      <header className="rise max-w-3xl space-y-4">
        <p className="eyebrow">{t('compare.page.eyebrow')}</p>
        <h1 className="heading-headline">{t('compare.page.title')}</h1>
        <p className="lede max-w-[64ch]">{t('compare.page.subtitle')}</p>
      </header>

      <div className="space-y-3">
        {/* The two sides are what you operate here: each its own panel, side by side from 768 px. */}
        <div className="grid gap-4 md:grid-cols-2">
          <SideCard letter="A" side={a} timing={timingA} other={b} onChange={(side) => setSide('a', side)} />
          <SideCard letter="B" side={b} timing={timingB} other={a} onChange={(side) => setSide('b', side)} />
        </div>
        {a && b && (
          <button type="button" className="btn-quiet btn-sm -ml-2.5" onClick={swap}>
            <Icon name="loop" size={16} />
            {t('compare.page.swap')}
          </button>
        )}
      </div>

      {ready && <Comparison a={a} b={b} timingA={timingA} timingB={timingB} />}
    </div>
  )
}

const SIDE_TONE = { A: 'var(--red)', B: 'var(--compare)' }

/** One side: what it is and how it is adjusted, or a way to pick it. */
function SideCard({ letter, side, timing, other, onChange }) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const heading = (
    <h2 className="heading-title flex items-center gap-2.5">
      <span className="h-4 w-0.5 rounded-full" style={{ background: SIDE_TONE[letter] }} aria-hidden="true" />
      {t('compare.page.side', { letter })}
    </h2>
  )

  if (!side || picking) {
    return (
      <section className="panel space-y-4 p-4 sm:p-5">
        {heading}
        <Picker
          other={other}
          onPick={(picked) => {
            setPicking(false)
            onChange(picked)
          }}
        />
        {side && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setPicking(false)}>
            {t('compare.page.cancel')}
          </button>
        )}
      </section>
    )
  }

  const lines = timing?.result?.red_lines ?? []
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        {heading}
        <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setPicking(true)}>
          {t('compare.page.change')}
        </button>
      </div>
      {!timing || timing.loading ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ) : timing.error ? (
        <p role="alert" className="text-label text-amber">
          {t(`compare.page.errors.${timing.error}`)}
        </p>
      ) : (
        <>
          <div className="min-w-0 space-y-0.5">
            <Link to={timing.own ? `/analyze/${timing.id}` : timingPath(timing.id)} className="block truncate text-body font-semibold text-text transition-colors duration-150 ease-out hover:text-accent">
              {timing.name ?? t('timings.untitled')}
            </Link>
            <p className="readout text-caption text-dim">
              {bpmLabel(timing.result.global_bpm)}
              <span className="unit">BPM</span> · {t('timings.redLines', { count: lines.length })} · {timing.own ? t('compare.page.yours') : t('compare.page.published')}
            </p>
          </div>
          <Adjust side={side} onChange={onChange} />
        </>
      )}
    </section>
  )
}

/** The side's adjustment, as the result page's: ×0.5, ×1, ×2 and a nudge in ms. Display only; the analysis is unchanged. */
function Adjust({ side, onChange }) {
  const { t } = useTranslation()
  const [nudge, setNudge] = useState(String(side.nudgeMs))
  useEffect(() => setNudge(String(side.nudgeMs)), [side.nudgeMs])
  const commit = () => {
    const value = Number(nudge)
    if (Number.isFinite(value) && Math.abs(value) <= 1000) onChange({ ...side, nudgeMs: Math.round(value * 10) / 10 })
    else setNudge(String(side.nudgeMs))
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="label">{t('compare.page.adjust')}</span>
      {[0.5, 1, 2].map((factor) => (
        <button key={factor} type="button" className="tool-btn px-2.5" aria-pressed={side.factor === factor} onClick={() => onChange({ ...side, factor })}>
          ×{factor}
        </button>
      ))}
      <label className="flex items-center gap-1.5 text-caption text-dim">
        {t('compare.page.nudge')}
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          min={-1000}
          max={1000}
          className="field readout h-8 min-h-8 w-20 px-2 py-0 text-label"
          value={nudge}
          onChange={(e) => setNudge(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <span className="unit">ms</span>
      </label>
    </div>
  )
}

/**
 * Choosing a side: one of the visitor's own analyses (the account's history,
 * or this browser's short list without an account), the other side's own
 * analysis adjusted, or any id or link pasted (a published `/t/` timing).
 */
function Picker({ other, onPick }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const [mine, setMine] = useState(null)
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)

  useEffect(() => {
    if (account === undefined) return undefined
    if (!account) {
      setMine(recentAnalyses().map((item) => ({ id: item.id, name: item.filename })))
      return undefined
    }
    let alive = true
    myAnalyses({ status: 'done' }, { limit: 20 })
      .then((data) => alive && setMine(data.analyses.map((item) => ({ id: item.id, name: songLine(item) ?? item.filename, bpm: item.bpm }))))
      .catch(() => alive && setMine([]))
    return () => {
      alive = false
    }
  }, [account])

  const choices = (mine ?? []).filter((item) => item.id !== other?.id)
  const submit = (event) => {
    event.preventDefault()
    const id = readAnalysisRef(text)
    if (!id) return setBad(true)
    onPick({ id, factor: 1, nudgeMs: 0 })
  }

  return (
    <div className="space-y-3">
      {other && (
        <div className="flex flex-wrap gap-2">
          {[2, 0.5].map((factor) => (
            <button key={factor} type="button" className="btn-ghost btn-sm" onClick={() => onPick({ id: other.id, factor, nudgeMs: 0 })}>
              {t('compare.page.sameAdjusted', { factor })}
            </button>
          ))}
        </div>
      )}
      {mine === null ? (
        <SkeletonRows rows={2} label={t('common.loading')} />
      ) : choices.length ? (
        <ul className="panel-well max-h-56 divide-y divide-line overflow-auto">
          {choices.map((item) => (
            <li key={item.id}>
              <button type="button" className="flex min-h-10 w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 ease-out hover:bg-surface-2" onClick={() => onPick({ id: item.id, factor: 1, nudgeMs: 0 })}>
                <span className="min-w-0 flex-1 truncate text-label text-text">{item.name ?? t('timings.untitled')}</span>
                {item.bpm !== undefined && (
                  <span className="readout shrink-0 text-caption text-dim">
                    {bpmLabel(item.bpm)}
                    <span className="unit">BPM</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-dim">{account ? t('compare.page.noneYours') : t('compare.page.noneHere')}</p>
      )}
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t('compare.page.pasteLabel')}</span>
          <input
            type="text"
            className="field w-full"
            value={text}
            maxLength={300}
            placeholder={t('compare.page.pastePlaceholder')}
            onChange={(e) => {
              setText(e.target.value)
              setBad(false)
            }}
          />
        </label>
        <button type="submit" className="btn-ghost shrink-0">
          {t('compare.page.use')}
        </button>
      </form>
      {bad && (
        <p role="alert" className="text-caption text-red">
          {t('compare.page.badRef')}
        </p>
      )}
    </div>
  )
}

/** The comparison itself: the verdict and table, and A's tempo map with B's lines and either one's clicks. */
function Comparison({ a, b, timingA, timingB }) {
  const { t } = useTranslation()
  const resultA = timingA.result
  const resultB = timingB.result
  const linesA = useMemo(() => adjustLines(resultA, a), [resultA, a.factor, a.nudgeMs]) // eslint-disable-line react-hooks/exhaustive-deps
  const linesB = useMemo(() => adjustLines(resultB, b), [resultB, b.factor, b.nudgeMs]) // eslint-disable-line react-hooks/exhaustive-deps
  const durationS = resultA.duration_s ?? 0
  const comparison = useMemo(() => compareTimings(linesA, linesB, { durationMs: durationS * 1000 }), [linesA, linesB, durationS])
  const otherAudio = timingA.sha1 && timingB.sha1 && timingA.sha1 !== timingB.sha1

  const verify = useCallback((digest) => checkTimingAudio(timingA.id, digest), [timingA.id])
  const audio = useSongAudio(timingA.id, timingA.sha1, timingA.own ? null : verify)
  const [player] = useState(() => new Player())
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const clockRef = useRef(null)
  const [clicks, setClicks] = useState('a')
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)

  const gridA = useMemo(() => clickGrid(linesA, durationS), [linesA, durationS])
  const gridB = useMemo(() => clickGrid(linesB, durationS), [linesB, durationS])
  const attacks = useMemo(() => attackDrift(resultA.onsets?.t_ms ?? [], linesA), [resultA, linesA])
  const spans = useMemo(
    () => linesA.map((line, i) => ({ a: line.timeMs / 1000, b: i + 1 < linesA.length ? linesA[i + 1].timeMs / 1000 : durationS })),
    [linesA, durationS],
  )
  useEffect(() => player.setGrid(clicks === 'b' ? gridB : gridA), [player, gridA, gridB, clicks])
  useEffect(() => player.setSections(spans), [player, spans])
  useEffect(() => {
    if (audio.kind === 'ready') player.setBuffer(audio.song.buffer)
  }, [player, audio.kind, audio.song])
  useEffect(() => () => player.destroy(), [player])

  const data = useMemo(
    () => ({
      lines: linesA,
      sections: resultA.sections ?? [],
      grid: gridA,
      beats: resultA.beats ?? null,
      onsets: resultA.onsets ?? null,
      drift: attacks,
      envelope: resultA.onset_envelope ?? null,
      peaks: audio.kind === 'ready' ? audio.song.peaks : null,
      swing: [],
      hints: [],
      factor: a.factor,
      durationS,
      range: tempoRange([...linesA, ...linesB], resultA.beats, a.factor),
      other: linesB,
      otherLabel: t('compare.page.side', { letter: 'B' }),
    }),
    [linesA, linesB, resultA, gridA, attacks, audio.kind, audio.song, a.factor, durationS, t],
  )

  return (
    <div className="space-y-8">
      {otherAudio && <p className="rounded-control border border-amber/40 bg-amber/10 px-3 py-2 text-caption text-text">{t('compare.page.otherAudio')}</p>}
      <section className="space-y-5 border-t border-line pt-8" aria-labelledby="compare-result-title">
        <SectionHeader id="compare-result-title" title={t('compare.page.difference')} />
        <CompareReport
          comparison={comparison}
          labelA="A"
          labelB="B"
          onPlayAt={snapshot.ready ? (ms) => player.play(Math.max(0, ms / 1000 - 1), { range: null, loopOn: false }) : null}
        />
      </section>

      <section className="space-y-5 border-t border-line pt-8" aria-labelledby="compare-listen">
      <SectionHeader id="compare-listen" eyebrow={t('result.zones.listen.eyebrow')} title={t('result.zones.listen.title')} />
      <ClicksSwitch clicks={clicks} onClicks={setClicks} labelA={`A · ${formatBpm(linesA[0]?.bpm)}`} labelB={`B · ${formatBpm(linesB[0]?.bpm)}`} />
      <TempoMap data={data} player={player} snapshot={snapshot} selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} clockRef={clockRef} focus={null}>
        <AudioSource audio={audio} filename={timingA.name} visitor={!timingA.own} />
        <Transport player={player} snapshot={snapshot} durationS={durationS} clockRef={clockRef} />
      </TempoMap>
      <p className="max-w-[72ch] text-caption leading-relaxed text-dim">{t('compare.page.mapNote')}</p>
      </section>
    </div>
  )
}
