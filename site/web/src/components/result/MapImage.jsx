import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { embedCode, mapPng, mapSvg } from '../../lib/map-image.js'
import { songNames } from '../../lib/osz.js'
import { adjustmentNote, downloadName, formatBpm, saveText } from '../../lib/timing.js'
import { readPalette } from './draw.js'

/**
 * The tempo map as an image (W12.18): a PNG of the page's own map of the
 * whole song, or a reduced SVG; and, once the timing is published, the code
 * to embed its card (`/embed/<id>`) in a forum or a site. Built here, from
 * what the page shows, in the page's theme.
 */
export default function MapImage({ id, analysis, lines, data, adjustment, published }) {
  const { t } = useTranslation()
  const [state, setState] = useState(null) // null | 'busy' | 'failed' | 'copied' | 'copyFailed'
  const { title, artist } = songNames({ ...analysis, filename: analysis.filename ?? 'Overtone' })
  const heading = [artist !== 'Unknown' ? artist : null, title].filter(Boolean).join(' - ')
  const bpm = analysis.result.global_bpm === null ? null : analysis.result.global_bpm * adjustment.factor
  const adjusted = adjustmentNote(adjustment)
  const note = [
    `${formatBpm(bpm)} BPM`,
    `${lines.length} red line${lines.length === 1 ? '' : 's'}`,
    adjusted ? `adjusted ${adjusted}` : null,
    'Overtone',
  ].filter(Boolean).join(' · ')
  const stem = downloadName(analysis.filename ?? heading, 'tempo-map').replace(/-tempo-map$/, '')

  async function png() {
    setState('busy')
    try {
      const blob = await mapPng({ data, palette: readPalette(), title: heading, note })
      saveText(blob, `${stem}-tempo-map.png`, 'image/png')
      setState(null)
    } catch {
      setState('failed')
    }
  }

  function svg() {
    const text = mapSvg({
      lines, sections: data.sections, beats: data.beats, durationS: data.durationS, factor: adjustment.factor,
      title: heading, note, palette: readPalette(),
    })
    saveText(text, `${stem}-tempo-map.svg`, 'image/svg+xml')
  }

  async function copyEmbed() {
    try {
      await navigator.clipboard.writeText(embedCode(window.location.origin, id, heading))
      setState('copied')
    } catch {
      setState('copyFailed')
    }
    setTimeout(() => setState((s) => (s === 'copied' || s === 'copyFailed' ? null : s)), 2500)
  }

  return (
    <div className="space-y-2 border-t border-line px-4 py-3">
      <h3 className="label">{t('platform.image.title')}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost" onClick={png} disabled={state === 'busy'}>
          {t('platform.image.png')}
        </button>
        <button type="button" className="btn-ghost" onClick={svg}>
          {t('platform.image.svg')}
        </button>
        {published && (
          <>
            <button type="button" className="btn-ghost" onClick={copyEmbed}>
              {state === 'copied' ? t('platform.image.copied') : state === 'copyFailed' ? t('platform.image.copyFailed') : t('platform.image.embed')}
            </button>
            <a href={`/embed/${id}`} target="_blank" rel="noopener" className="text-caption text-accent hover:underline">
              {t('platform.image.preview')} ↗
            </a>
          </>
        )}
      </div>
      <p className="text-caption text-dim" role={state === 'failed' ? 'alert' : undefined}>
        {state === 'failed' ? t('platform.image.failed') : published ? t('platform.image.note') : t('platform.image.notePrivate')}
      </p>
    </div>
  )
}
