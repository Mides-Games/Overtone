import { useTranslation } from 'react-i18next'

/**
 * Where the song comes from: the reader's own file, never the server. Shown
 * above the transport until the song is ready, and as a one-line note after.
 * A `visitor` of a published timing (W3.27) never uploaded it: they are asked
 * for their own copy, and told the server only answers whether it matches.
 */
export default function AudioSource({ audio, filename, visitor = false }) {
  const { t } = useTranslation()
  if (audio.kind === 'ready') {
    return <p className="border-t border-line px-3 py-2 text-caption text-dim">{t('tempo.audio.ready', { name: audio.name })}</p>
  }
  const busy = audio.kind === 'checking' || audio.kind === 'decoding'
  const message = {
    none: visitor ? t('timings.audio.none') : t('tempo.audio.none', { name: filename }),
    checking: t('tempo.audio.checking'),
    decoding: t('tempo.audio.decoding'),
    mismatch: visitor ? t('timings.audio.mismatch', { name: audio.name }) : t('tempo.audio.mismatch', { name: audio.name }),
    unverifiable: t('tempo.audio.unverifiable'),
    error: t('tempo.audio.error'),
  }[audio.kind]
  const warn = audio.kind === 'mismatch' || audio.kind === 'error' || audio.kind === 'unverifiable'

  return (
    <div className={`flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between ${warn ? 'border-amber/40 bg-amber/10' : 'border-line bg-surface-2'}`}>
      <div className="space-y-0.5" aria-live="polite">
        <p className="text-label text-text">{message}</p>
        <p className="text-caption text-dim">{visitor ? t('timings.audio.privacy') : t('tempo.audio.privacy')}</p>
      </div>
      {!busy && audio.kind !== 'unverifiable' && (
        <label className="btn-ghost shrink-0 cursor-pointer">
          {audio.kind === 'none' ? t('tempo.audio.pick') : t('tempo.audio.pickAgain')}
          <input
            type="file"
            accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a,.opus"
            className="sr-only"
            onChange={(e) => {
              audio.pick(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
      )}
    </div>
  )
}
