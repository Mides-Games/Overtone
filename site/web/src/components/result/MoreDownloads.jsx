import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MAX_TRACK_SECONDS, renderClickTrack } from '../../lib/click-track.js'
import { patchOsuFile } from '../../lib/osu-patch.js'
import { downloadName, resultJson, saveText, summaryText, timingCsv } from '../../lib/timing.js'

/**
 * The downloads after the .osz (W3.20), folded away so the export row stays
 * one button: the reader's own .osu with the red lines put in, the click
 * track as a WAV, the CSV, the result as JSON and a plain-text summary. All
 * of it is built in this browser; the .osu and the song never leave it.
 */
export default function MoreDownloads({ id, analysis, lines, adjustment, grid, durationS, songBuffer, player, checks }) {
  const { t } = useTranslation()
  const result = analysis.result
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  const osuInput = useRef(null)
  const [patch, setPatch] = useState(null) // { report } | { error } | 'busy'
  const [track, setTrack] = useState(null) // { busy, progress } | { error } | { capped }

  async function patchOsu(file) {
    if (!file) return
    setPatch('busy')
    try {
      const out = await patchOsuFile(file, lines)
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
      const { songVolume, clickVolume } = player.getSnapshot()
      const out = await renderClickTrack({
        grid,
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
    <details className="group border-t border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-label font-semibold text-text hover:bg-surface-2">
        <span aria-hidden className="text-dim transition group-open:rotate-90">
          ▸
        </span>
        {t('exports.more')}
      </summary>

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
          <button type="button" className="btn-ghost" disabled={patch === 'busy'} onClick={() => osuInput.current?.click()}>
            {t('exports.patchPick')}
          </button>
          <p className="text-caption text-dim">{t('exports.patchNote')}</p>
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
            <button type="button" className="btn-ghost" disabled={Boolean(track?.busy)} onClick={() => clickTrack(false)}>
              {track?.busy === 'clicks' ? t('exports.rendering') : t('exports.clicksOnly')}
            </button>
            <button type="button" className="btn-ghost" disabled={Boolean(track?.busy) || !songBuffer} onClick={() => clickTrack(true)}>
              {track?.busy === 'mix' ? t('exports.rendering') : t('exports.clicksMix')}
            </button>
          </div>
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

      <div className="space-y-2 border-t border-line px-4 py-3">
        <h3 className="label">{t('exports.filesTitle')}</h3>
        <div className="flex flex-wrap gap-2">
          {adjusted ? (
            <button type="button" className="btn-ghost" onClick={() => saveText(timingCsv(result, lines), downloadName(analysis.filename, 'timing.csv'), 'text/csv;charset=utf-8')}>
              {t('result.downloadCsv')}
            </button>
          ) : (
            <a className="btn-ghost" href={`/api/v1/analyses/${id}/timing.csv`} download>
              {t('result.downloadCsv')}
            </a>
          )}
          <button type="button" className="btn-ghost" onClick={() => saveText(resultJson(result), downloadName(analysis.filename, 'timing.json'), 'application/json')}>
            {t('exports.json')}
          </button>
          <button
            type="button"
            className="btn-ghost"
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
      {report.hitObjects > 0 && <p className="text-amber">{t('exports.objects', { count: report.hitObjects })}</p>}
    </div>
  )
}
