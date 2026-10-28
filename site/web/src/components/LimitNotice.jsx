import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import SignInLink from './SignInLink.jsx'
import { countdown } from '../lib/limits.js'
import { useTracker } from '../lib/tracking.js'

/**
 * W13.20: why an upload was refused for one of the person's own limits, and
 * when they can send again: a live countdown to 00:00 UTC for the daily
 * counts, or, for the cap on songs waiting at once, "when one of yours
 * finishes", which turns into "you can send again" the moment the tray sees
 * one of this tab's songs end. `limit` is lib/limits.js `limitOf`.
 */
export default function LimitNotice({ limit }) {
  const { t } = useTranslation()
  const { count } = useTracker()
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(count)

  useEffect(() => {
    inFlight.current = count
    setNow(Date.now())
    if (!limit?.deadline) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [limit]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!limit) return null
  const reset = limit.frees === 'reset'
  const free = reset ? now >= limit.deadline : count < inFlight.current
  const why =
    limit.code === 'PENDING_LIMIT'
      ? t('limits.why.pending', { count: limit.limit ?? 0 })
      : limit.code === 'CACHE_LIMIT'
        ? t('limits.why.cache', { count: limit.limit ?? 0 })
        : t(`limits.why.${limit.scope === 'account' ? 'account' : 'anonymous'}`, { count: limit.limit ?? 0 })

  return (
    <div className="space-y-2 rounded-control border border-amber/40 bg-amber/10 p-4" role="status" aria-live="polite">
      <p className="text-label font-semibold text-text">{t('limits.title')}</p>
      <p className="text-caption text-muted">{why}</p>
      {free ? (
        <p className="text-label text-accent">{t('limits.free')}</p>
      ) : reset ? (
        <p className="text-label text-text">
          {t('limits.resetIn')}{' '}
          <span className="readout text-amber" aria-hidden="true">
            {countdown(limit.deadline, now)}
          </span>
          <span className="sr-only">{t('limits.resetAt', { time: new Date(limit.deadline).toLocaleTimeString() })}</span>
          <span className="text-caption text-dim"> · {t('limits.resetWhen')}</span>
        </p>
      ) : (
        <p className="text-label text-text">
          {t('limits.whenFinished', { count: limit.pending ?? limit.limit ?? 0 })}{' '}
          <Link to="/queue" className="text-caption text-accent hover:underline">
            {t('limits.seeQueue')}
          </Link>
        </p>
      )}
      {limit.scope === 'anonymous' && limit.code === 'QUOTA_EXCEEDED' && (
        <p className="text-caption text-dim">
          <SignInLink className="text-accent hover:underline">
            {t('limits.signIn')}
          </SignInLink>
        </p>
      )}
    </div>
  )
}
