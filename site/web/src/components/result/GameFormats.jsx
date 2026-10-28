import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../context/AuthContext.jsx'
import { GAME_FORMATS, gameFile } from '../../lib/game-formats.js'
import { saveText } from '../../lib/timing.js'

/**
 * The red lines for other games (W12.7, W13.11): Quaver, StepMania (and
 * Etterna, which reads its .sm), StepMania 5's .ssc, Clone Hero, Beat Saber,
 * A Dance of Fire and Ice, Friday Night Funkin' and Rhythm Doctor, built here from `lines`
 * (the export's, after the options). Timing only: no notes. Each format's
 * caveats are worked out before the download, so the reader sees them first.
 */
export default function GameFormats({ analysis, lines, offsetDecimals, durationS }) {
  const { t } = useTranslation()
  const { account } = useAuth() ?? {}
  const [failed, setFailed] = useState(false)
  const files = useMemo(() => {
    const out = {}
    for (const format of GAME_FORMATS) {
      try {
        out[format.id] = gameFile(format.id, { analysis, lines, offsetDecimals, creator: account?.username, durationS })
      } catch {
        out[format.id] = null
      }
    }
    return out
  }, [analysis, lines, offsetDecimals, account?.username, durationS])

  function save(id) {
    const file = files[id]
    if (!file) return setFailed(true)
    setFailed(false)
    saveText(file.text, file.name, 'text/plain;charset=utf-8')
  }

  const sm = files.sm?.report
  const notes = []
  if (sm && sm.worstMs >= 0.5) notes.push(t('gameFormats.rows', { count: sm.moved, ms: sm.worstMs.toFixed(1) }))
  if (sm?.meterLost) notes.push(t('gameFormats.smMeter'))
  if (files.qua?.report.meterLost) notes.push(t('gameFormats.quaMeter', { count: files.qua.report.meterLost }))
  if (files.chart?.report.fitted) notes.push(t('gameFormats.chartFitted', { count: files.chart.report.fitted, ms: Math.max(0.01, files.chart.report.worstMs).toFixed(2) }))
  if (files.adofai?.report.odd) notes.push(t('gameFormats.adofaiOdd', { count: files.adofai.report.odd }))
  if (files.fnf?.report.odd) notes.push(t('gameFormats.fnfOdd', { count: files.fnf.report.odd }))
  if (files.rdlevel?.report.meterLost) notes.push(t('gameFormats.rdMeter', { count: files.rdlevel.report.meterLost }))
  const audioExt = (/\.[A-Za-z0-9]{1,5}$/.exec(analysis.filename ?? '')?.[0] ?? '.mp3').toLowerCase()

  return (
    <div className="space-y-2 border-t border-line px-4 py-3">
      <h3 className="label">{t('gameFormats.title')}</h3>
      <div className="flex flex-wrap gap-2">
        {GAME_FORMATS.map((format) => (
          <button key={format.id} type="button" className="btn-ghost" disabled={!files[format.id]} onClick={() => save(format.id)}>
            {format.game} <span className="text-dim">.{format.ext}</span>
          </button>
        ))}
      </div>
      <p className="text-caption text-dim">{t('gameFormats.note')}</p>
      <ul className="list-disc space-y-1 pl-5 text-caption text-dim">
        <li>{t('gameFormats.etterna')}</li>
        <li>{t('gameFormats.cloneHero', { ext: audioExt })}</li>
        {files.beatsaber && <li>{t('gameFormats.beatSaber', { bpm: String(files.beatsaber.report.infoBpm) })}</li>}
        <li>{t('gameFormats.adofai')}</li>
        <li>{t('gameFormats.fnf')}</li>
        <li>{t('gameFormats.rhythmDoctor')}</li>
        {notes.map((note) => (
          <li key={note} className="text-amber">
            {note}
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="text-caption text-red">
          {t('gameFormats.failed')}
        </p>
      )}
    </div>
  )
}
