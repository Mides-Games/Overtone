import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import TimingList from '../components/TimingList.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { usePagedList } from '../hooks/usePagedList.js'
import { SORTS, sortedTimings } from '../lib/social.js'
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
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('timings.recent.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('timings.recent.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t('social.sort.label')} className="flex flex-wrap gap-1">
          {SORTS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className="tool-btn px-3 font-display text-caption font-semibold uppercase"
              aria-pressed={sort === key}
            >
              {t(`social.sort.${key}`)}
            </button>
          ))}
        </div>
        <Link to="/timers" className="text-label text-accent hover:underline">
          {t('social.timers.link')} →
        </Link>
      </div>
      {sort !== 'new' && (
        <p className="-mt-5 text-caption text-dim">{sort === 'rated' ? t('social.sort.ratedNote', { count: MIN_RATINGS }) : t('social.sort.usedNote')}</p>
      )}

      <form className="panel grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_auto_auto_auto] [&>*]:min-w-0" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="space-y-1">
          <span className="label">{t('timings.filters.search')}</span>
          <input type="search" className="field" value={filters.q} maxLength={100} onChange={set('q')} placeholder={t('timings.filters.searchPlaceholder')} />
        </label>
        <BpmRange filters={filters} set={set} />
        <label className="space-y-1">
          <span className="label">{t('timings.filters.tempo')}</span>
          <select className="field" value={filters.tempo} onChange={set('tempo')}>
            <option value="">{t('timings.filters.any')}</option>
            <option value="single">{t('timings.filters.single')}</option>
            <option value="variable">{t('timings.filters.variable')}</option>
          </select>
        </label>
        {narrowed && (
          <button type="button" className="btn-ghost self-end" onClick={() => setFilters(NO_FILTERS)}>
            {t('timings.filters.clear')}
          </button>
        )}
      </form>

      <Listing list={list} narrowed={narrowed} sort={sort} />
    </div>
  )
}

/** Two BPM fields side by side: from and to. */
export function BpmRange({ filters, set }) {
  const { t } = useTranslation()
  const input = 'field readout w-24'
  return (
    <fieldset className="space-y-1">
      <legend className="label">{t('timings.filters.bpm')}</legend>
      <div className="flex items-center gap-2">
        <input inputMode="decimal" className={input} value={filters.bpmMin} onChange={set('bpmMin')} placeholder={t('timings.filters.from')} aria-label={t('timings.filters.bpmMin')} maxLength={8} />
        <span className="text-dim">–</span>
        <input inputMode="decimal" className={input} value={filters.bpmMax} onChange={set('bpmMax')} placeholder={t('timings.filters.to')} aria-label={t('timings.filters.bpmMax')} maxLength={8} />
      </div>
    </fieldset>
  )
}

function Listing({ list, narrowed, sort = 'new' }) {
  const { t } = useTranslation()
  if (list.items === null) {
    return list.error ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />
  }
  return (
    <section className="space-y-4" aria-busy={list.loading}>
      {list.items.length ? (
        <TimingList timings={list.items} />
      ) : (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">
          {narrowed ? t('timings.recent.noMatch') : sort !== 'new' ? t(`social.sort.${sort}Empty`) : t('timings.recent.empty')}{' '}
          {!narrowed && sort === 'new' && (
            <Link to="/analyze" className="text-accent hover:underline">
              {t('timings.recent.analyze')}
            </Link>
          )}
        </p>
      )}
      {list.error && <p role="alert" className="text-caption text-red">{t('timings.loadFailed')}</p>}
      {list.next && (
        <button type="button" className="btn-ghost w-full" onClick={list.more} disabled={list.loading}>
          {list.loading ? t('common.loading') : t('timings.more')}
        </button>
      )}
    </section>
  )
}
