import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import { compareHref, MODES } from '../../lib/analysis-options.js'
import { lookupAudio, uploadAudio } from '../../lib/api.js'
import { rememberAnalysis } from '../../lib/recent.js'
import { heldAudio, holdAudio, sha1Hex } from '../../lib/session-audio.js'
import { tracker } from '../../lib/tracking.js'
import { messageFor } from '../../pages/Analyze.jsx'

/**
 * Analyse the same song again in another mode (W3.24), without the person
 * finding the upload form again: the file this browser still holds for the
 * result (lib/session-audio.js), or the one they pick again, checked by its
 * SHA-1 against the analysis before anything is sent. The hints go along
 * unchanged; only the mode differs. A song already analysed that way is
 * answered from the stored result, and nothing is uploaded.
 *
 * The two results are linked both ways (the API's `reanalysis_of`), and each
 * lists the other here, with a link to compare them side by side (W12.11,
 * `/compare`, pages/Compare.jsx).
 */
export default function Reanalyse({ analysis }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const current = analysis.result?.mode ?? analysis.mode ?? 'normal'
  const [mode, setMode] = useState(() => MODES.find((m) => m !== current))
  const [state, setState] = useState({ kind: 'idle' }) // idle | pick | checking | mismatch | sending | error
  const related = analysis.related ?? []

  async function send(file) {
    setState({ kind: 'sending', sent: 0 })
    const options = {
      private: analysis.private,
      title: analysis.tagTitle,
      artist: analysis.tagArtist,
      mode,
      hints: analysis.result?.options ?? analysis.options ?? {},
      duration: analysis.result?.duration_s ?? null,
      reanalysisOf: analysis.id,
    }
    try {
      const created =
        (await lookupAudio(file, options)) ??
        (await uploadAudio(file, (sent) => setState({ kind: 'sending', sent }), options))
      rememberAnalysis(created.id, file.name)
      tracker.track(created.id, file.name, { status: created.status })
      holdAudio(created.id, file)
      navigate(`/analyze/${created.id}`)
    } catch (error) {
      setState({ kind: 'error', message: messageFor(t, error, null) })
    }
  }

  async function start() {
    const file = heldAudio(analysis.id)
    if (file) return send(file)
    setState({ kind: 'pick' })
  }

  async function picked(file) {
    if (!file) return
    setState({ kind: 'checking' })
    try {
      if ((await sha1Hex(file)) !== String(analysis.sha1 ?? '').toLowerCase()) return setState({ kind: 'mismatch', name: file.name })
    } catch {
      return setState({ kind: 'error', message: t('tempo.audio.error') })
    }
    holdAudio(analysis.id, file)
    send(file)
  }

  const busy = state.kind === 'checking' || state.kind === 'sending'

  return (
    <section className="panel space-y-4 p-4" aria-labelledby="reanalyse">
      <div className="space-y-1">
        <h2 id="reanalyse" className="label">{t('modes.reanalyse.title')}</h2>
        <p className="text-caption text-muted">{t('modes.reanalyse.note')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t('modes.options.mode')} className="flex flex-wrap gap-1">
          {MODES.filter((m) => m !== current).map((m) => (
            <button key={m} type="button" className="tool-btn px-3" aria-pressed={mode === m} onClick={() => setMode(m)} disabled={busy}>
              {t(`modes.names.${m}`)}
            </button>
          ))}
        </div>
        <button type="button" className="btn-primary" onClick={start} disabled={busy || !analysis.sha1}>
          {state.kind === 'sending'
            ? t('analyze.sending', { percent: Math.round((state.sent ?? 0) * 100) })
            : t('modes.reanalyse.go', { mode: t(`modes.names.${mode}`) })}
        </button>
      </div>

      {(state.kind === 'pick' || state.kind === 'mismatch' || state.kind === 'checking') && (
        <div className={`flex flex-col gap-2 rounded-control border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
          state.kind === 'mismatch' ? 'border-amber/40 bg-amber/10' : 'border-line bg-surface-2'}`}
        >
          <p className="text-caption text-text" aria-live="polite">
            {state.kind === 'mismatch'
              ? t('modes.reanalyse.mismatchFile', { name: state.name })
              : state.kind === 'checking'
                ? t('tempo.audio.checking')
                : t('modes.reanalyse.pick', { name: analysis.filename })}
          </p>
          {state.kind !== 'checking' && (
            <label className="btn-ghost h-8 shrink-0 cursor-pointer px-3 text-caption">
              {t('tempo.audio.pick')}
              <input
                type="file"
                accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a,.opus"
                className="sr-only"
                onChange={(e) => {
                  picked(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
          )}
        </div>
      )}

      {state.kind === 'error' && (
        <p role="alert" className="text-caption text-red">
          {state.message}
        </p>
      )}

      {related.length > 0 && (
        <div className="space-y-2">
          <h3 className="label">{t('modes.reanalyse.related')}</h3>
          <ul className="divide-y divide-line rounded-control border border-line">
            {related.map((other) => (
              <li key={other.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Link to={`/analyze/${other.id}`} className="flex min-w-0 items-center gap-2 text-label text-accent hover:underline">
                  <span className="chip-accent">{t(`modes.names.${other.mode}`)}</span>
                  <span className="truncate">{other.source ? t('modes.reanalyse.from') : t('modes.reanalyse.into')}</span>
                  <span className="text-caption text-dim">{t(`queue.status.${other.status}`, { defaultValue: other.status })}</span>
                </Link>
                {other.status === 'done' && analysis.status === 'done' && (
                  <Link to={compareHref(analysis.id, other.id)} className="btn-ghost h-8 px-3 text-caption">
                    {t('modes.reanalyse.compare')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
