import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import BrandLoader from '../components/BrandLoader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { nextDelay } from '../lib/backoff.js'

/**
 * The service's state (W10.4), as `GET /api/v1/health` reports it: the API,
 * its database and whether an analysis worker called lately. Nothing here is
 * measured by the page itself; it says what the API says, and "unreachable"
 * when the API says nothing.
 *
 * It asks again every 30 s, and after a failure sooner then less and less
 * often (lib/backoff.js), so a tab left open during an outage does not keep
 * knocking at the same pace. A hidden tab does not ask at all.
 */
const TONE = {
  ok: 'border-accent/40 bg-accent/10 text-accent',
  none: 'border-line-strong bg-surface-2 text-muted',
  unknown: 'border-amber/40 bg-amber/10 text-amber',
  down: 'border-red/40 bg-red/10 text-red',
  unreachable: 'border-red/40 bg-red/10 text-red',
}

function Row({ name, state, note }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <dt className="font-display text-label font-semibold uppercase">{t(`status.${name}`)}</dt>
        <p className="text-caption text-dim">{note}</p>
      </div>
      <dd className={`chip shrink-0 self-start sm:self-auto ${TONE[state]}`}>
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        {t(`status.states.${state}`)}
      </dd>
    </div>
  )
}

export default function Status() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('status.title'), t('status.description'))
  // { health, reached, at } once asked; `health` is null when the API did not answer.
  const [reading, setReading] = useState(null)
  const [checking, setChecking] = useState(false)
  const failures = useRef(0)
  const timer = useRef(null)

  const check = useCallback(async () => {
    clearTimeout(timer.current)
    setChecking(true)
    // Read by hand rather than through lib/api.js: a 503 is the API answering
    // that its database is down, and its body still says what is up.
    let health = null
    try {
      const response = await fetch('/api/v1/health', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      const data = await response.json().catch(() => null)
      // overtone-web's own 502/504 (no API behind it) has no `status`.
      if (data && typeof data.status === 'string') health = data
    } catch {
      // The network itself: unreachable, as below.
    }
    const reached = health !== null
    failures.current = reached ? 0 : failures.current + 1
    setReading({ health, reached, at: new Date() })
    setChecking(false)
    if (document.visibilityState === 'visible') timer.current = setTimeout(check, nextDelay(failures.current))
  }, [])

  useEffect(() => {
    const onVisible = () => {
      clearTimeout(timer.current)
      if (document.visibilityState === 'visible') check()
    }
    check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  const health = reading?.health
  const reached = reading?.reached
  const database = reached ? health.database : 'unreachable'
  const worker = reached ? (health.worker?.status ?? 'unknown') : 'unreachable'
  const workerNote =
    worker === 'ok' || worker === 'down'
      ? `${t('status.notes.worker')} ${t('status.notes.workerSeen', { seconds: health.worker.seenSecondsAgo })}`
      : worker === 'unknown'
        ? `${t('status.notes.worker')} ${t('status.notes.workerUnknown')}`
        : t('status.notes.unreachable')

  return (
    <div className="rise mx-auto max-w-[72ch] space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('status.title')}</h1>
        <p className="leading-relaxed text-muted">{t('status.intro')}</p>
      </header>

      {!reading ? (
        <BrandLoader className="py-16" />
      ) : (
        <section aria-live="polite" className="space-y-3">
          <dl className="grid gap-px overflow-hidden rounded-panel border border-line bg-line">
            <Row name="api" state={reached ? 'ok' : 'unreachable'} note={t('status.notes.api')} />
            <Row name="database" state={database} note={reached ? t('status.notes.database') : t('status.notes.unreachable')} />
            <Row name="worker" state={worker} note={workerNote} />
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="readout text-caption text-dim">
              {t('status.checked', { time: reading.at.toLocaleTimeString(i18n.language, { timeStyle: 'medium' }) })}
            </p>
            <button type="button" className="btn-ghost h-9" onClick={check} disabled={checking}>
              {checking ? t('status.checking') : t('status.retry')}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
