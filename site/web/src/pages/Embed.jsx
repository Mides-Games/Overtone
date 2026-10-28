import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

import Mark from '../components/Mark.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { DARK, mapSvg, svgDataUrl } from '../lib/map-image.js'
import { adjustLines, formatBpm, formatClock } from '../lib/timing.js'
import { bpmLabel, publicTiming, songLine, timingPath } from '../lib/timings.js'

/**
 * `/embed/<id>` (W12.18): a published timing as a small card another site may
 * frame (deploy/web/serve.mjs lets this path, and only this path, be framed).
 * The song, its BPM, the red lines, a small tempo chart and a link back to
 * the timing's page. No sign-in, no player, nothing to click but the link,
 * so being framed lends a hostile page nothing to trick a click into.
 * Outside the site's layout on purpose: a frame has no room for the navbar.
 */
const SHOWN = 6

export default function Embed() {
  const { t } = useTranslation()
  const { id } = useParams()
  const [timing, setTiming] = useState(null)
  const [error, setError] = useState(null)
  usePageMeta(timing ? songLine(timing) ?? t('timings.untitled') : t('platform.embed.title'))

  useEffect(() => {
    let alive = true
    publicTiming(id)
      .then((data) => alive && setTiming(data))
      .catch((failure) => alive && setError(failure.status === 404 ? 'notFound' : 'network'))
    return () => {
      alive = false
    }
  }, [id])

  const lines = useMemo(() => (timing ? adjustLines(timing.result) : []), [timing])
  const chart = useMemo(
    () =>
      timing
        ? svgDataUrl(mapSvg({
            lines, sections: timing.result.sections ?? [], beats: timing.result.beats ?? null, durationS: timing.result.duration_s,
            palette: DARK, width: 600, height: 150, compact: true,
          }))
        : null,
    [timing, lines],
  )
  const href = `${window.location.origin}${timingPath(id)}`

  return (
    <div className="dark min-h-screen bg-bg p-3 text-text">
      {error && (
        <p className="text-label text-muted">{error === 'notFound' ? t('platform.embed.notFound') : t('platform.embed.failed')}</p>
      )}
      {!error && !timing && <p className="text-label text-dim">{t('platform.embed.loading')}</p>}
      {timing && (
        <article className="space-y-2">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate font-display text-[17px] font-bold">{timing.title ?? t('timings.untitled')}</h1>
              {timing.artist && <p className="truncate text-label text-muted">{timing.artist}</p>}
            </div>
            <p className="readout shrink-0 text-title text-accent">
              {bpmLabel(timing.bpm)}
              <span className="ml-1 text-label text-dim">BPM</span>
            </p>
          </header>
          <img src={chart} alt={t('platform.embed.chartAlt')} className="block w-full rounded-control" width="600" height="150" />
          <ul className="readout grid grid-cols-2 gap-x-4 text-caption text-muted sm:grid-cols-3">
            {lines.slice(0, SHOWN).map((line) => (
              <li key={line.index} className="truncate">
                <span className="text-red">▍</span>
                {formatClock(line.timeMs)} · {formatBpm(line.bpm)}
                {line.meter !== 4 ? ` · ${line.meter}/4` : ''}
              </li>
            ))}
          </ul>
          <footer className="flex items-center justify-between gap-3 text-caption text-dim">
            <span>{lines.length > SHOWN ? t('platform.embed.more', { count: lines.length - SHOWN }) : t('timings.redLines', { count: lines.length })}</span>
            <a href={href} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-accent hover:underline">
              <Mark size={14} />
              {t('platform.embed.open')} ↗
            </a>
          </footer>
        </article>
      )}
    </div>
  )
}
