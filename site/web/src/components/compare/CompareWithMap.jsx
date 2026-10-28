import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { compareTimings, readOsuFile } from '../../lib/compare.js'
import Icon from '../ui/Icon.jsx'
import CompareReport from './CompareReport.jsx'

/**
 * Compare with a map that already exists (W12.10): the reader picks an `.osu`
 * of the same song, this browser reads its red lines, and the page lines them
 * up with the result's as the reader has them (adjusted or not). The file is
 * read here and kept only in this component's memory: nothing is uploaded and
 * nothing stored, and leaving the page forgets it.
 *
 * `map` and `onMap` belong to the result page, which draws the map's lines on
 * the tempo map and can play its clicks instead of the result's (`clicks`).
 * `children` are the ways to the other comparison (W12.11), at the foot.
 */
export default function CompareWithMap({ lines, durationS, adjusted, filename, map, onMap, clicks, onClicks, onPlayAt, children = null }) {
  const { t } = useTranslation()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const comparison = useMemo(() => (map ? compareTimings(lines, map.lines, { durationMs: durationS * 1000 }) : null), [map, lines, durationS])
  const labelA = adjusted ? t('compare.resultAdjusted') : t('compare.result')
  const labelB = t('compare.map')

  async function pick(file) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const read = await readOsuFile(file)
      if (read.error) {
        setError(read.error)
        return
      }
      onMap({ ...read, name: file.name })
    } catch {
      setError('unreadable')
    } finally {
      setBusy(false)
    }
  }

  // The map's audio file name against the analysed file's: a hint, never a refusal (a map's audio is often renamed).
  const otherAudio = map?.audioFilename && filename && map.audioFilename.toLowerCase() !== filename.toLowerCase()
  const song = map ? [map.artist, map.title].filter(Boolean).join(' - ') : ''

  return (
    // Between hairlines, not a panel: one file button and, once a map is read, its report.
    <section className="space-y-4 border-t border-line pt-6" aria-labelledby="compare-map-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h3 id="compare-map-title" className="heading-title">
            {t('compare.withMap.title')}
          </h3>
          {map ? (
            <p className="break-words text-label text-text">
              {song || map.name}
              {map.version && <span className="text-muted"> [{map.version}]</span>}
              <span className="text-dim"> · {t('compare.withMap.lines', { count: map.lines.length })}</span>
            </p>
          ) : (
            <p className="max-w-[64ch] text-label text-muted">{t('compare.withMap.note')}</p>
          )}
          <p className="text-caption text-dim">{t('compare.withMap.privacy')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <label className="btn-ghost cursor-pointer">
            <Icon name="upload" size={16} />
            {busy ? t('common.loading') : map ? t('compare.withMap.pickAgain') : t('compare.withMap.pick')}
            <input
              type="file"
              accept=".osu"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          {map && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                onMap(null)
                setError(null)
              }}
            >
              {t('compare.withMap.clear')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-caption text-red">
          {t(`compare.withMap.errors.${error}`, { defaultValue: t('compare.withMap.errors.unreadable') })}
        </p>
      )}

      {map && (
        <>
          {otherAudio && (
            <p className="rounded-control border border-amber/40 bg-amber/10 px-3 py-2 text-caption text-text">
              {t('compare.withMap.otherAudio', { map: map.audioFilename, file: filename })}
            </p>
          )}
          <ClicksSwitch clicks={clicks} onClicks={onClicks} labelA={labelA} labelB={labelB} />
          <CompareReport comparison={comparison} labelA={labelA} labelB={labelB} onPlayAt={onPlayAt} />
        </>
      )}

      {children && <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">{children}</div>}
    </section>
  )
}

/** Which timing the clicks play: the result's or the other one's. The song and the map's drawing do not change. */
export function ClicksSwitch({ clicks, onClicks, labelA, labelB }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('compare.clicksFrom')}>
      <span className="label">{t('compare.clicksFrom')}</span>
      {[
        ['a', labelA],
        ['b', labelB],
      ].map(([key, label]) => (
        <button key={key} type="button" className="tool-btn px-2.5" aria-pressed={clicks === key} onClick={() => onClicks(key)}>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: key === 'a' ? 'var(--red)' : 'var(--compare)' }} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  )
}
