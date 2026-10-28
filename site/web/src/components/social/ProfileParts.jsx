import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { usePagedList } from '../../hooks/usePagedList.js'
import { BADGES, collectionPath, ratingLabel, SORTS, userTimings } from '../../lib/social.js'
import Avatar from '../Avatar.jsx'
import BrandLoader from '../BrandLoader.jsx'
import TimingList from '../TimingList.jsx'

/**
 * The pieces of a timer's profile (W5.6, W13.18), shared by the public page
 * (/u/<username>) and the account's own (/profile): the card with the
 * totals, the badges, the published timings, and the public collections.
 * Everything here is what the person published; nothing else is asked for.
 */

/** The card: banner, avatar, names, the totals, and whatever the page adds under the name. */
export function ProfileCard({ user, totals, children }) {
  const { t } = useTranslation()
  const cells = [
    { key: 'published', value: totals ? String(totals.published) : '–' },
    { key: 'timed', value: totals ? String(totals.timed) : '–' },
    { key: 'uses', value: totals ? String(totals.uses) : '–' },
    {
      key: 'rating',
      value: totals ? ratingLabel(totals.rating.average) : '–',
      note: totals?.rating.count ? t('social.stars.count', { count: totals.rating.count }) : null,
    },
  ]
  return (
    <section className="panel overflow-hidden">
      <div
        className="h-28 border-b border-line bg-surface-3 bg-cover bg-center sm:h-36"
        style={user.bannerUrl ? { backgroundImage: `url("${encodeURI(user.bannerUrl)}")` } : undefined}
      />
      <div className="flex flex-wrap items-end gap-4 px-5 pb-5">
        <Avatar account={user} size={84} className="-mt-10 ring-4 ring-[var(--surface)]" />
        <div className="min-w-0 flex-1 pb-1">
          <h1 className="truncate font-display text-[24px] font-bold">{user.displayName || user.username}</h1>
          <p className="readout text-label text-dim">@{user.username}</p>
        </div>
        {children}
      </div>
      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.key} className="space-y-1 bg-surface px-5 py-3">
            <dt className="label">{t(`social.profile.totals.${cell.key}`)}</dt>
            <dd className={`readout text-title ${totals ? 'text-text' : 'text-dim'}`}>
              {cell.value}
              {cell.note && <span className="ml-1.5 text-caption text-dim">{cell.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** The badges, each with what earned it; a quiet line when there are none yet. */
export function Badges({ badges }) {
  const { t } = useTranslation()
  const earned = BADGES.filter((b) => badges.includes(b))
  return (
    <section className="space-y-2">
      <h2 className="label">{t('social.profile.badges')}</h2>
      {earned.length === 0 ? (
        <p className="text-caption text-dim">{t('social.profile.noBadges')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {earned.map((b) => (
            <li key={b} className="chip-accent" title={t(`social.badges.${b}.why`)}>
              {t(`social.badges.${b}.name`)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Their published timings, newest, best rated or most used, a page at a time. */
export function PublishedTimings({ username, empty }) {
  const { t } = useTranslation()
  const [sort, setSort] = useState('new')
  const load = useCallback(
    (filters, options) => userTimings(username, filters, options).then((data) => ({ items: data.timings, next: data.next })),
    [username],
  )
  const list = usePagedList(load, { sort }, { delay: 0 })
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="label">{t('social.profile.timings')}</h2>
        <div role="group" aria-label={t('social.sort.label')} className="flex flex-wrap gap-1">
          {SORTS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              aria-pressed={sort === key}
              className="tool-btn px-2.5 font-display text-caption font-semibold uppercase"
            >
              {t(`social.sort.${key}`)}
            </button>
          ))}
        </div>
      </div>
      {list.items === null ? (
        list.error ? <p className="text-caption text-red">{t('social.failed')}</p> : <BrandLoader className="py-10" />
      ) : list.items.length === 0 ? (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">
          {sort === 'new' ? empty : t(`social.sort.${sort}Empty`)}
        </p>
      ) : (
        <TimingList timings={list.items} />
      )}
      {list.next && (
        <button type="button" className="btn-ghost w-full" onClick={list.more} disabled={list.loading}>
          {list.loading ? t('common.loading') : t('timings.more')}
        </button>
      )}
    </section>
  )
}

/** Collections as links to their pages, with how many timings each holds. */
export function CollectionLinks({ collections, title }) {
  const { t } = useTranslation()
  if (!collections.length) return null
  return (
    <section className="space-y-2">
      <h2 className="label">{title}</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {collections.map((c) => (
          <li key={c.id}>
            <Link to={collectionPath(c.id)} className="panel flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-surface-2">
              <span className="min-w-0 truncate text-label font-semibold">{c.name}</span>
              <span className="shrink-0 text-caption text-dim">{t('social.collections.count', { count: c.count })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
