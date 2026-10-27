import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { moderate, moderationLog, report } from '../../lib/community.js'

/**
 * The moderation suggestions and reviews share (W5.4, minimal): anyone can
 * report, staff hide or unhide with a reason, and staff read the open
 * reports and the log. Reasons are asked with the browser's own prompt, as
 * the queue's moderation does: a modal of our own would be more code for the
 * same one line of text.
 */

/** "Report", for anyone. Says "Reported" once the server has it; a second report counts once anyway. */
export function ReportButton({ kind, id }) {
  const { t } = useTranslation()
  const [state, setState] = useState('idle')

  async function send() {
    const reason = window.prompt(t('community.moderation.reportPrompt'))
    if (reason === null || !reason.trim()) return
    setState('busy')
    try {
      await report(kind, id, reason)
      setState('done')
    } catch {
      setState('error')
    }
  }

  if (state === 'done') return <span className="text-caption text-dim">{t('community.moderation.reported')}</span>
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={send} disabled={state === 'busy'} className="text-caption text-dim underline-offset-2 hover:text-text hover:underline">
        {t('community.moderation.report')}
      </button>
      {state === 'error' && (
        <span role="alert" className="text-caption text-red">
          {t('community.errors.failed')}
        </span>
      )}
    </span>
  )
}

/** Staff only: hide (with a reason, required) or unhide (reason optional). */
export function HideButton({ kind, item, onDone }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const action = item.hidden ? 'unhide' : 'hide'

  async function act() {
    const reason = window.prompt(t(`community.moderation.${action}Prompt`))
    if (reason === null) return
    if (action === 'hide' && !reason.trim()) return setError(t('community.errors.REASON_REQUIRED'))
    setBusy(true)
    setError(null)
    try {
      await moderate(kind, item.id, action, reason.trim())
      onDone?.()
    } catch (failure) {
      setError(t(`community.errors.${failure.code}`, { defaultValue: t('community.errors.failed') }))
    } finally {
      setBusy(false)
    }
    return undefined
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} onClick={act} className="btn-ghost h-7 px-2.5 text-caption">
        {t(`community.moderation.${action}`)}
      </button>
      {error && (
        <span role="alert" className="text-caption text-red">
          {error}
        </span>
      )}
    </span>
  )
}

/** The staff line under an item: that it is hidden and why, and how many open reports it has. */
export function StaffNote({ item }) {
  const { t } = useTranslation()
  if (!item.hidden && !item.reports) return null
  return (
    <p className="text-caption text-amber">
      {item.hidden && t('community.moderation.hiddenBecause', { reason: item.hiddenReason ?? '—' })}
      {item.hidden && item.reports > 0 && ' · '}
      {item.reports > 0 && t('community.moderation.reports', { count: item.reports })}
    </p>
  )
}

/** Staff: the open reports, then the latest actions, newest first. */
export function StaffPanel({ tick }) {
  const { t } = useTranslation()
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    moderationLog()
      .then((next) => alive && setData(next))
      .catch(() => alive && setData({ log: [], reports: [] }))
    return () => {
      alive = false
    }
  }, [tick])

  if (!data) return null
  return (
    <section className="space-y-4 rounded-panel border border-dashed border-amber/40 p-4">
      <h2 className="label text-amber">{t('community.moderation.staffTitle')}</h2>
      <div className="space-y-2">
        <h3 className="label">{t('community.moderation.openReports')}</h3>
        {!data.reports.length ? (
          <p className="text-caption text-dim">{t('community.moderation.noReports')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-panel border border-line">
            {data.reports.map((r) => (
              <li key={`${r.kind}-${r.ref}`} className="space-y-1 px-3 py-2 text-caption">
                <p>
                  <span className="font-semibold">{t(`community.moderation.kind.${r.kind}`)}</span>{' '}
                  <span className="readout text-dim">{r.ref.slice(0, 8)}</span> ·{' '}
                  {t('community.moderation.reports', { count: r.count })}
                </p>
                <p className="break-words text-muted">{r.reasons.map((reason) => `“${reason}”`).join(' ')}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="label">{t('community.moderation.logTitle')}</h3>
        {!data.log.length ? (
          <p className="text-caption text-dim">{t('community.moderation.logEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-panel border border-line">
            {data.log.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-caption">
                <span className="readout text-dim">{new Date(e.at).toLocaleString()}</span>
                <span>
                  {e.action === 'state'
                    ? t('community.moderation.did.state', {
                        moderator: e.moderator,
                        from: t(`community.states.${e.from}`),
                        to: t(`community.states.${e.to}`),
                      })
                    : t(`community.moderation.did.${e.action}`, { moderator: e.moderator, kind: t(`community.moderation.kind.${e.kind}`) })}
                </span>
                <span className="readout text-dim">{e.ref.slice(0, 8)}</span>
                {e.reason && <span className="break-words text-muted">“{e.reason}”</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
