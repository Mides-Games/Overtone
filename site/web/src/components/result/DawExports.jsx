import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { midiFile, reaperProject } from '../../lib/daw-exports.js'
import { songNames } from '../../lib/osz.js'
import { downloadName, saveText } from '../../lib/timing.js'

/**
 * The tempo map for music software (W13.10): a Standard MIDI File any DAW
 * reads, and a Reaper project. Built here from `lines` (the export's, after
 * the options). Ableton Live has no tempo-map text of its own, so the page
 * sends its users to the MIDI file and says how, rather than inventing a file.
 */
export default function DawExports({ analysis, lines, durationS }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const title = songNames({ ...analysis, filename: analysis?.filename }).title
  const files = useMemo(() => {
    try {
      return {
        midi: midiFile(lines, { name: `${title} - Overtone tempo map` }),
        reaper: reaperProject({ lines, audioName: analysis?.filename, durationS, title }),
      }
    } catch {
      return null
    }
  }, [lines, analysis?.filename, durationS, title])

  function save(kind) {
    if (!files) return setFailed(true)
    setFailed(false)
    if (kind === 'midi') saveText(files.midi.bytes, downloadName(analysis.filename, 'tempo.mid'), 'audio/midi')
    else saveText(files.reaper.text, downloadName(analysis.filename, 'tempo.rpp'), 'text/plain;charset=utf-8')
  }

  const midi = files?.midi.report
  return (
    <div className="space-y-2 border-t border-line px-4 py-3">
      <h3 className="label">{t('daw.title')}</h3>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost btn-sm" disabled={!files} onClick={() => save('midi')}>
          {t('daw.midi')} <span className="text-dim">.mid</span>
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={!files} onClick={() => save('reaper')}>
          Reaper <span className="text-dim">.rpp</span>
        </button>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-caption text-dim">
        {midi && <li>{t('daw.midiNote', { ms: Math.max(0.01, midi.worstMs).toFixed(2) })}</li>}
        {midi?.leadIn && <li>{t('daw.leadIn')}</li>}
        <li>{files?.reaper.withAudio ? t('daw.reaperNote', { file: analysis.filename }) : t('daw.reaperNoAudio')}</li>
        <li>{t('daw.ableton')}</li>
      </ul>
      {failed && (
        <p role="alert" className="text-caption text-red">
          {t('gameFormats.failed')}
        </p>
      )}
    </div>
  )
}
