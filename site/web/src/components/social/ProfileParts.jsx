import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { usePagedList } from '../../hooks/usePagedList.js'
import { BADGES, collectionPath, ratingLabel, userTimings } from '../../lib/social.js'
import Avatar from '../Avatar.jsx'
import { MoreButton, SortButtons } from '../ListControls.jsx'
import TimingList from '../TimingList.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'
import SectionHeader from '../ui/SectionHeader.jsx'
import Skeleton, { SkeletonRows } from '../ui/Skeleton.jsx'
import Waveform from '../ui/Waveform.jsx'

/** A small number from a name, the same every time: the banner's waveform seed. */
const seedOf = (name = '') => [...name].reduce((sum, c) => (sum * 31 + c.codePointAt(0)) | 0, 7)

/**
 * The pieces of a timer's profile (W5.6, W13.18), shared by the public page
 * (/u/<username>) and the account's own (/profile): the header with the
 * totals, the badges, the published timings, and the public collections.
 * Everything here is what the person published; nothing else is asked for.
 *
 * Not a card (docs/design.md, section 11): the banner is a band, the name the
 * page's heading, the totals a row of readouts a hairline apart, and each
 * part below its own section.
 */

/**
 * The header: banner, avatar, names, the totals, and whatever the page adds
 * beside the name. `visits` ({ total, recent }, from the API; null for a
 * private profile) is a quiet line under the username, not a fifth readout:
 * it says who looked, not what the person did.
 */
export function ProfileCard({ user, totals, visits = null, children }) {
  const { t, i18n } = useTranslation()
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
    <header className="rise space-y-8">
      <div className="relative">
        <div
          className="relative h-28 overflow-hidden rounded-panel border border-line bg-surface-2 bg-cover bg-center sm:h-40"
          style={user.bannerUrl ? { backgroundImage: `url("${encodeURI(user.bannerUrl)}")` } : undefined}
        >
          {/* Without a banner, the site's own mark: a quiet waveform along the band, seeded by the name so each profile has its own. */}
          {!user.bannerUrl && (
            <Waveform bars={128} lines={[0.31, 0.74]} seed={seedOf(user.username)} mirrored={false} className="absolute inset-x-0 bottom-0 h-3/5 w-full opacity-40" />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4 px-1 sm:px-6">
          <Avatar account={user} size={96} className="relative z-10 -mt-12 ring-4 ring-[var(--bg)] sm:-mt-14" />
          <div className="min-w-0 flex-1 basis-56 space-y-1 pt-2">
            <h1 className="heading-headline break-words">{user.displayName || user.username}</h1>
            <p className="readout text-label text-muted">@{user.username}</p>
            {visits && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-caption text-dim" title={t('social.profile.visits.note')}>
                <Icon name="eye" size={14} />
                <span>{t('social.profile.visits.title')}</span>
                <span className="readout font-medium text-text">{visits.total.toLocaleString(i18n.language)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {t('social.profile.visits.recent')} <span className="readout text-muted">{visits.recent.toLocaleString(i18n.language)}</span>
                </span>
              </p>
            )}
          </div>
          {children && <div className="flex flex-wrap gap-2 pb-1">{children}</div>}
        </div>
      </div>
      <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-4">
        {cells.map((cell, i) => (
          <div
            key={cell.key}
            className={`space-y-1.5 py-4 pr-4 ${i % 2 ? 'border-l border-line pl-5' : ''} ${i > 1 ? 'border-t border-line sm:border-t-0' : ''} ${
              i === 2 ? 'sm:border-l sm:pl-5' : ''
            }`}
          >
            <dt className="label">{t(`social.profile.totals.${cell.key}`)}</dt>
            <dd className={`readout flex flex-wrap items-baseline gap-x-2 text-heading font-semibold ${totals ? 'text-text' : 'text-dim'}`}>
              {cell.key === 'rating' && totals?.rating.count > 0 && <Icon name="star-filled" size={18} strokeWidth={1} className="self-center text-amber" />}
              {cell.value}
              {cell.note && <span className="text-caption font-normal text-dim">{cell.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  )
}

/** The header's shape while it loads (the band, the avatar, the name), then rows. */
export function ProfileSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="space-y-10" role="status" aria-label={t('common.loading')}>
      <div aria-hidden="true">
        <Skeleton className="h-28 rounded-panel sm:h-40" />
        <div className="flex items-end gap-6 px-1 sm:px-6">
          <Skeleton className="relative -mt-12 h-24 w-24 rounded-full ring-4 ring-[var(--bg)] sm:-mt-14" />
          <span className="flex-1 space-y-2 pb-2">
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-3 w-24" />
          </span>
        </div>
      </div>
      <div aria-hidden="true" className="divide-y divide-line border-y border-line">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 py-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <span className="flex-1 space-y-2">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-2.5 w-1/4 opacity-70" />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The badges, each with what earned it and when; a quiet line when there are none yet. */
export function Badges({ badges, dates = {} }) {
  const { t, i18n } = useTranslation()
  const earned = BADGES.filter((b) => badges.includes(b))
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' }) : null)
  return (
    <section aria-labelledby="profile-badges" className="space-y-3">
      {/* A title, not a section heading: a short row of chips does not carry a headline. */}
      <h2 id="profile-badges" className="heading-title">
        {t('social.profile.badges')}
      </h2>
      {earned.length === 0 ? (
        <p className="text-label text-dim">{t('social.profile.noBadges')}</p>
      ) : (
        <ul className="grid gap-x-8 gap-y-0 sm:grid-cols-2 lg:grid-cols-3">
          {earned.map((b) => (
            <li key={b} className="flex items-start gap-3 border-t border-line py-3">
              <span className="chip-accent mt-0.5 shrink-0">
                <Icon name="check" size={12} strokeWidth={2} />
                {t(`social.badges.${b}.name`)}
              </span>
              <span className="space-y-0.5">
                <span className="block text-caption text-muted">{t(`social.badges.${b}.why`)}</span>
                {when(dates[b]) && <span className="readout block text-caption text-dim">{t('social.profile.badgeEarned', { date: when(dates[b]) })}</span>}
              </span>
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
    <section aria-labelledby="profile-timings" className="space-y-5">
      <SectionHeader id="profile-timings" title={t('social.profile.timings')} action={<SortButtons value={sort} onChange={setSort} />} />
      {list.items === null ? (
        list.error ? (
          <p role="alert" className="text-caption text-red">
            {t('social.failed')}
          </p>
        ) : (
          <SkeletonRows rows={3} label={t('common.loading')} className="border-y border-line" />
        )
      ) : list.items.length === 0 ? (
        <EmptyState title={sort === 'new' ? empty : t(`social.sort.${sort}Empty`)} className="border-y border-line" />
      ) : (
        <TimingList timings={list.items} />
      )}
      <MoreButton list={list} />
    </section>
  )
}

/** Collections as links to their pages, with how many timings each holds. */
export function CollectionLinks({ collections, title }) {
  const { t } = useTranslation()
  if (!collections.length) return null
  return (
    <section aria-labelledby="profile-collections" className="space-y-5">
      <SectionHeader id="profile-collections" title={title} />
      <ul className="grid gap-x-8 sm:grid-cols-2">
        {collections.map((c) => (
          <li key={c.id} className="border-t border-line">
            <Link
              to={collectionPath(c.id)}
              className="group -mx-3 flex items-center justify-between gap-3 rounded-control px-3 py-3.5 transition-colors duration-150 ease-out hover:bg-surface-2"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Icon name="list" size={18} className="text-dim" />
                <span className="truncate text-body font-semibold text-text group-hover:text-accent">{c.name}</span>
              </span>
              <span className="readout shrink-0 text-caption text-dim">{t('social.collections.count', { count: c.count })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
