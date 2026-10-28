import { useTranslation } from 'react-i18next'

import { SORTS } from '../lib/social.js'
import Icon from './ui/Icon.jsx'

/**
 * The controls the timing lists share (/recent, /history, a profile's
 * timings): the search field, the BPM range, the sort toggles and the "show
 * more" under a paged list. One place, so the lists look and behave alike.
 */

/** The search box: a real search field, with the label above it. */
export function SearchField({ value, onChange }) {
  const { t } = useTranslation()
  return (
    <label className="space-y-1.5">
      <span className="label block">{t('timings.filters.search')}</span>
      <span className="relative block">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
        <input
          type="search"
          className="field pl-9"
          value={value}
          maxLength={100}
          onChange={onChange}
          placeholder={t('timings.filters.searchPlaceholder')}
          autoComplete="off"
          enterKeyHint="search"
        />
      </span>
    </label>
  )
}

/** Newest, best rated, most used: a row of toggles, one pressed. */
export function SortButtons({ value, onChange }) {
  const { t } = useTranslation()
  return (
    <div role="group" aria-label={t('social.sort.label')} className="flex flex-wrap gap-1.5">
      {SORTS.map((key) => (
        <button key={key} type="button" onClick={() => onChange(key)} className="tool-btn px-3 font-sans" aria-pressed={value === key}>
          {t(`social.sort.${key}`)}
        </button>
      ))}
    </div>
  )
}

/** Two BPM fields side by side: from and to. */
export function BpmRange({ filters, set }) {
  const { t } = useTranslation()
  const input = 'field readout w-24'
  return (
    <fieldset className="space-y-1.5">
      <legend className="label mb-1.5">{t('timings.filters.bpm')}</legend>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={input}
          value={filters.bpmMin}
          onChange={set('bpmMin')}
          placeholder={t('timings.filters.from')}
          aria-label={t('timings.filters.bpmMin')}
          maxLength={8}
        />
        <span aria-hidden="true" className="text-dim">
          –
        </span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={input}
          value={filters.bpmMax}
          onChange={set('bpmMax')}
          placeholder={t('timings.filters.to')}
          aria-label={t('timings.filters.bpmMax')}
          maxLength={8}
        />
      </div>
    </fieldset>
  )
}

/** The "show more" button under a paged list (hooks/usePagedList.js). */
export function MoreButton({ list }) {
  const { t } = useTranslation()
  if (!list.next) return null
  return (
    <button type="button" className="btn-ghost mx-auto flex" onClick={list.more} disabled={list.loading}>
      {list.loading ? t('common.loading') : t('timings.more')}
    </button>
  )
}
