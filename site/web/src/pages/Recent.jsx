import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { BpmRange, MoreButton, SearchField, SortButtons } from '../components/ListControls.jsx'
import TimingList from '../components/TimingList.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { usePagedList } from '../hooks/usePagedList.js'
import { sortedTimings } from '../lib/social.js'
import { NO_FILTERS } from '../lib/timings.js'

const loadRecent = (filters, options) => sortedTimings(filters, options).then((data) => ({ items: data.timings, next: data.next }))

/** "Best rated" counts a timing from this many ratings on (the API says the same number as `minRatings`). */
const MIN_RATINGS = 3

/**
 * Recent timings from everyone (W5.1): what people chose to publish, newest
 * first, or best rated or most used (W6), searchable by title and artist and
 * filtered by BPM and by single or variable tempo. A page at a time; the
 * filters live in the page, not in its URL.
 */
export default function Recent() {
  const { t } = useTranslation()
  usePageMeta(t('timings.recent.title'), t('timings.recent.subtitle'))
  const [filters, setFilters] = useState(NO_FILTERS)
  const [sort, setSort] = useState('new')
  const list = usePagedList(loadRecent, { ...filters, sort })
  const set = (key) => (event) => setFilters((f) => ({ ...f, [key]: event.target.value }))
  const narrowed = Object.entries(filters).some(([, value]) => value)

  return (
    <div className="space-y-10">
      <PageHeader
        title={t('timings.recent.title')}
        lede={t('timings.recent.subtitle')}
        action={
          <Link to="/timers" className="btn-quiet -mr-2.5">
            <Icon name="trophy" size={16} />
            {t('social.timers.link')}
            <Icon name="arrow-right" size={16} />
          </Link>
        }
      />

      <div className="space-y-6">
        <form className="panel grid grid-cols-1 gap-4 p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:p-5 [&>*]:min-w-0" role="search" onSubmit={(e) => e.preventDefault()}>
          <SearchField value={filters.q} onChange={set('q')} />
          <BpmRange filters={filters} set={set} />
          <label className="space-y-1.5">
            <span className="label block">{t('timings.filters.tempo')}</span>
            <select className="field" value={filters.tempo} onChange={set('tempo')}>
              <option value="">{t('timings.filters.any')}</option>
              <option value="single">{t('timings.filters.single')}</option>
              <option value="variable">{t('timings.filters.variable')}</option>
            </select>
          </label>
          {narrowed && (
            <button type="button" className="btn-ghost self-end" onClick={() => setFilters(NO_FILTERS)}>
              <Icon name="close" size={16} />
              {t('timings.filters.clear')}
            </button>
          )}
        </form>

        <div className="space-y-2">
          <SortButtons value={sort} onChange={setSort} />
          {sort !== 'new' && (
            <p className="text-caption text-dim">{sort === 'rated' ? t('social.sort.ratedNote', { count: MIN_RATINGS }) : t('social.sort.usedNote')}</p>
          )}
        </div>

        <Listing list={list} narrowed={narrowed} sort={sort} />
      </div>
    </div>
  )
}

function Listing({ list, narrowed, sort = 'new' }) {
  const { t } = useTranslation()
  if (list.items === null) {
    return list.error ? (
      <p role="status" className="text-label text-dim">
        {t('result.reconnecting')}
      </p>
    ) : (
      <SkeletonRows rows={6} label={t('common.loading')} className="border-y border-line" />
    )
  }
  return (
    <section className="space-y-6" aria-label={t('timings.recent.title')} aria-busy={list.loading}>
      {list.items.length ? (
        <TimingList timings={list.items} />
      ) : (
        <EmptyState
          title={narrowed ? t('timings.recent.noMatch') : sort !== 'new' ? t(`social.sort.${sort}Empty`) : t('timings.recent.empty')}
          className="border-y border-line"
          action={
            !narrowed &&
            sort === 'new' && (
              <Link to="/analyze" className="btn-ghost">
                {t('timings.recent.analyze')}
                <Icon name="arrow-right" size={16} />
              </Link>
            )
          }
        />
      )}
      {list.error && (
        <p role="alert" className="text-caption text-red">
          {t('timings.loadFailed')}
        </p>
      )}
      <MoreButton list={list} />
    </section>
  )
}
