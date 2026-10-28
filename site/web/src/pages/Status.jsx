import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SkeletonRows } from '../components/ui/Skeleton.jsx'
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
// The chips of docs/design.md, section 6. Down and unreachable are red, as
// the site's errors are; "not seen yet" is amber, something to look at.
const TONE = {
  ok: 'chip-accent',
  none: 'chip-neutral',
  unknown: 'chip-amber',
  down: 'chip-red',
  unreachable: 'chip-red',
}

function Row({ name, state, note }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 border-b border-line py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      {/* The term holds the name and its note: a <dl>'s row is dt + dd, nothing nested between. */}
      <dt className="min-w-0 space-y-1">
        <span className="heading-title block">{t(`status.${name}`)}</span>
        <span className="block text-label text-muted">{note}</span>
      </dt>
      <dd className={`shrink-0 self-start sm:self-auto ${TONE[state]}`}>
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
    <div className="rise space-y-10">
      <header className="max-w-[70ch] space-y-4">
        <p className="eyebrow">{t('footer.site')}</p>
        <h1 className="heading-headline">{t('status.title')}</h1>
        <p className="lede">{t('status.intro')}</p>
      </header>

      {!reading ? (
        <SkeletonRows rows={3} label={t('status.checking')} className="max-w-[52rem] border-t border-line" />
      ) : (
        <section aria-live="polite" className="max-w-[52rem] space-y-4">
          <dl className="border-t border-line">
            <Row name="api" state={reached ? 'ok' : 'unreachable'} note={t('status.notes.api')} />
            <Row name="database" state={database} note={reached ? t('status.notes.database') : t('status.notes.unreachable')} />
            <Row name="worker" state={worker} note={workerNote} />
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="readout text-caption text-dim">
              {t('status.checked', { time: reading.at.toLocaleTimeString(i18n.language, { timeStyle: 'medium' }) })}
            </p>
            <button type="button" className="btn-ghost btn-sm" onClick={check} disabled={checking}>
              {checking ? t('status.checking') : t('status.retry')}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
