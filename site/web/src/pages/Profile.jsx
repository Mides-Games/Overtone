import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import BrandLoader from '../components/BrandLoader.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'

/**
 * A placeholder. The profile is the one on midesprojects.com (ADR-W3);
 * Overtone will add a Timings tab and its numbers once publishing exists.
 * Until then the counters show a dash, not a zero: nothing has been counted.
 */
const STATS = ['timings', 'uses', 'rating']

export default function Profile() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('nav.profile'))
  const { account } = useAuth()

  if (account === undefined) return <BrandLoader className="py-16" />
  if (account === null) return <Navigate to="/login" replace state={{ from: '/profile' }} />

  const since = new Date(account.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'long' })

  return (
    <div className="rise space-y-6">
      <section className="panel overflow-hidden">
        <div
          className="h-28 border-b border-line bg-surface-3 bg-cover bg-center sm:h-36"
          style={account.bannerUrl ? { backgroundImage: `url("${encodeURI(account.bannerUrl)}")` } : undefined}
        />
        <div className="flex flex-wrap items-end gap-4 px-5 pb-5">
          <Avatar account={account} size={84} className="-mt-10 ring-4 ring-[var(--surface)]" />
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="truncate font-display text-[24px] font-bold">{account.displayName || account.username}</h1>
            <p className="readout text-label text-dim">@{account.username}</p>
          </div>
          <a
            href={`https://midesprojects.com/profile/${encodeURIComponent(account.username)}`}
            target="_blank"
            rel="noreferrer noopener"
            className="btn-ghost h-9"
          >
            {t('profile.onMides')} ↗
          </a>
        </div>
        <dl className="grid grid-cols-3 gap-px border-t border-line bg-line">
          {STATS.map((key) => (
            <div key={key} className="space-y-1 bg-surface px-5 py-3">
              <dt className="label">{t(`profile.stats.${key}`)}</dt>
              <dd className="readout text-title text-dim">–</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="label">{t('profile.timings')}</h2>
        <div className="rounded-panel border border-dashed border-line-strong px-5 py-10 text-center">
          <p className="mx-auto max-w-[52ch] text-label text-muted">{t('profile.timingsSoon')}</p>
        </div>
        <p className="readout text-caption text-dim">{t('profile.since', { date: since })}</p>
        <Link to="/settings/tokens" className="inline-block text-caption text-accent hover:underline">
          {t('platform.tokens.fromProfile')} →
        </Link>
      </section>
    </div>
  )
}
