import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MAX_TRACK_SECONDS, renderClickTrack } from '../../lib/click-track.js'
import { exportLines } from '../../lib/export-options.js'
import { SNAP_DIVISORS } from '../../lib/mapping.js'
import { patchOsuFile } from '../../lib/osu-patch.js'
import { downloadName, isAdjusted, resultJson, saveText, summaryText, timingCsv } from '../../lib/timing.js'
import ExportOptions, { useExportOptions } from './ExportOptions.jsx'
import DawExports from './DawExports.jsx'
import Icon from '../ui/Icon.jsx'
import GameFormats from './GameFormats.jsx'

/**
 * The downloads after the .osz (W3.20), folded away so the export row stays
 * one button: the reader's own .osu with the red lines put in, the click
 * track as a WAV, the other games' files (W12.7, W13.11), the tempo map for
 * music software (W13.10), the CSV, the result as
 * JSON and a plain-text summary. All of it is built in this browser; the .osu
 * and the song never leave it. On top, the export options (W12.8), which the
 * .osz above, the copy, the .osu, the games' and the DAWs' files follow; the clicks, the
 * CSV, the summary and the JSON do not (they are the timing as the page has it).
 * The click track may carry the subdivisions the player clicks (`clicks`,
 * W12.6); it never carries the player's latency shift. The patched .osu may
 * also snap its hit objects to the new grid (W13.2), off until asked.
 */
export default function MoreDownloads({ id, analysis, lines, adjustment, grid, clicks = grid, durationS, songBuffer, player, checks, csvHref = null }) {
  const { t } = useTranslation()
  const result = analysis.result
  const adjusted = isAdjusted(adjustment)
  const options = useExportOptions()
  const written = useMemo(() => exportLines(lines, options), [lines, options])
  const osuInput = useRef(null)
  const [patch, setPatch] = useState(null) // { report } | { error } | 'busy'
  const [snap, setSnap] = useState(0) // 0 = leave the objects where they are
  const [track, setTrack] = useState(null) // { busy, progress } | { error } | { capped }
  const [withSubs, setWithSubs] = useState(true)
  const subdivided = clicks !== grid

  async function patchOsu(file) {
    if (!file) return
    setPatch('busy')
    try {
      const out = await patchOsuFile(file, written, { snap: snap || null })
      if (out.error) return setPatch({ error: out.error })
      saveText(out.bytes, out.name, 'application/octet-stream')
      setPatch({ report: out.report })
    } catch {
      setPatch({ error: 'failed' })
    }
  }

  async function clickTrack(withSong) {
    if (track?.busy) return
    setTrack({ busy: withSong ? 'mix' : 'clicks', progress: 0 })
    try {
      const { songVolume, clickVolume, subVolume } = player.getSnapshot()
      const out = await renderClickTrack({
        grid: subdivided && withSubs ? clicks : grid,
        subVolume,
        durationS,
        buffer: withSong ? songBuffer : null,
        songVolume,
        clickVolume,
        onProgress: (progress) => setTrack((now) => (now?.busy ? { ...now, progress } : now)),
      })
      saveText(out.bytes, downloadName(analysis.filename, withSong ? 'clicks-mix.wav' : 'clicks.wav'), 'audio/wav')
      setTrack(out.capped ? { capped: true } : null)
    } catch {
      setTrack({ error: true })
    }
  }

  const minutes = MAX_TRACK_SECONDS / 60

  return (
    <details className="group/more border-t border-line">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-label font-semibold text-text transition-colors duration-150 ease-out hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <Icon name="chevron-right" size={16} className="text-dim transition-transform duration-150 ease-out group-open/more:rotate-90" />
        {t('exports.more')}
      </summary>

      <ExportOptions lines={lines} durationS={durationS} />

      <div className="grid gap-px bg-line md:grid-cols-2">
        <div className="space-y-2 bg-surface px-4 py-3">
          <h3 className="label">{t('exports.patchTitle')}</h3>
          <input
            ref={osuInput}
            type="file"
            accept=".osu"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              patchOsu(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button type="button" className="btn-ghost btn-sm" disabled={patch === 'busy'} onClick={() => osuInput.current?.click()}>
            {t('exports.patchPick')}
          </button>
          <p className="text-caption text-dim">{t('exports.patchNote')}</p>
          <fieldset className="space-y-1.5">
            <legend className="text-caption text-text">{t('exports.snapLabel')}</legend>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="tool-btn px-2.5" aria-pressed={!snap} onClick={() => setSnap(0)}>
                {t('exports.snapOff')}
              </button>
              {SNAP_DIVISORS.map((d) => (
                <button key={d} type="button" className="tool-btn min-w-11" aria-pressed={snap === d} onClick={() => setSnap(d)}>
                  1/{d}
                </button>
              ))}
            </div>
            <p className="text-caption text-dim">{t('exports.snapNote')}</p>
          </fieldset>
          {patch?.report && <PatchReport report={patch.report} />}
          {patch?.error && (
            <p role="alert" className="text-caption text-red">
              {t(`exports.patchError.${patch.error}`, { defaultValue: t('exports.patchError.failed') })}
            </p>
          )}
        </div>

        <div className="space-y-2 bg-surface px-4 py-3">
          <h3 className="label">{t('exports.clickTitle')}</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={Boolean(track?.busy)} onClick={() => clickTrack(false)}>
              {track?.busy === 'clicks' ? t('exports.rendering') : t('exports.clicksOnly')}
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={Boolean(track?.busy) || !songBuffer} onClick={() => clickTrack(true)}>
              {track?.busy === 'mix' ? t('exports.rendering') : t('exports.clicksMix')}
            </button>
          </div>
          {subdivided && (
            <label className="flex items-center gap-2 text-label">
              <input type="checkbox" checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} className="accent-[var(--accent)]" />
              <span>{t('listening.exportSubs', { n: player.getSnapshot().subdivision })}</span>
            </label>
          )}
          {track?.busy && (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label={t('exports.rendering')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(track.progress * 100)}
            >
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(3, track.progress * 100)}%` }} />
            </div>
          )}
          <p className="text-caption text-dim" role={track?.error ? 'alert' : undefined}>
            {track?.error
              ? t('exports.clickFailed')
              : track?.capped
                ? t('exports.clickCapped', { minutes })
                : songBuffer
                  ? t('exports.clickNote', { minutes })
                  : t('exports.clickNeedsAudio', { minutes })}
          </p>
        </div>
      </div>

      <GameFormats analysis={analysis} lines={written} offsetDecimals={options.offsetDecimals} durationS={durationS} />

      <DawExports analysis={analysis} lines={written} durationS={durationS} />

      <div className="space-y-2 border-t border-line px-4 py-3">
        <h3 className="label">{t('exports.filesTitle')}</h3>
        <div className="flex flex-wrap gap-2">
          {adjusted ? (
            <button type="button" className="btn-ghost btn-sm" onClick={() => saveText(timingCsv(result, lines), downloadName(analysis.filename, 'timing.csv'), 'text/csv;charset=utf-8')}>
              {t('result.downloadCsv')}
            </button>
          ) : (
            <a className="btn-ghost btn-sm" href={csvHref ?? `/api/v1/analyses/${id}/timing.csv`} download>
              {t('result.downloadCsv')}
            </a>
          )}
          <button type="button" className="btn-ghost btn-sm" onClick={() => saveText(resultJson(result), downloadName(analysis.filename, 'timing.json'), 'application/json')}>
            {t('exports.json')}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() =>
              saveText(summaryText({ filename: analysis.filename, result, lines, adjustment, checks }), downloadName(analysis.filename, 'summary.txt'), 'text/plain;charset=utf-8')
            }
          >
            {t('exports.summary')}
          </button>
        </div>
        <p className="text-caption text-dim">{t('exports.filesNote')}</p>
      </div>
    </details>
  )
}

/** What the patch did, in the reader's words: red lines, green lines, hit objects. */
function PatchReport({ report }) {
  const { t } = useTranslation()
  return (
    <div role="status" className="space-y-1 rounded-control border border-accent/40 bg-accent/10 px-3 py-2 text-caption text-text">
      <p>{t('exports.patched', { removed: report.redRemoved, added: report.redAdded, kept: report.greensKept })}</p>
      {report.greensBefore > 0 && <p>{t('exports.greensBefore', { count: report.greensBefore })}</p>}
      {report.carried > 0 && <p>{t('exports.carried', { count: report.carried })}</p>}
      {report.snap ? (
        <>
          <p>
            {report.snap.moved
              ? t('exports.snapped', {
                  divisor: `1/${report.snap.divisor}`,
                  moved: report.snap.moved,
                  total: report.snap.total,
                  max: report.snap.maxMs,
                  median: report.snap.medianMs,
                })
              : t('exports.snappedNone', { divisor: `1/${report.snap.divisor}`, total: report.snap.total })}
          </p>
          {report.snap.shared > 0 && <p className="text-amber">{t('exports.snapShared', { n: report.snap.shared })}</p>}
        </>
      ) : (
        report.hitObjects > 0 && <p className="text-amber">{t('exports.objects', { count: report.hitObjects })}</p>
      )}
    </div>
  )
}
