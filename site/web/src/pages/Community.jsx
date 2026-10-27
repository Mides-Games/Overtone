import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { StaffPanel } from '../components/community/Moderation.jsx'
import Reviews from '../components/community/Reviews.jsx'
import Suggestions from '../components/community/Suggestions.jsx'
import { useAuth } from '../context/AuthContext.jsx'

/**
 * Community (W5.2-W5.5): suggestions, reviews and the changelog, one tab each.
 * The tab is in the address (`?tab=reviews`), so a link can point at one.
 * Staff also get the open reports and the moderation log under the tab.
 */
const TABS = ['suggestions', 'reviews', 'changelog']

// The changelog carries the timeline's text: its own chunk, fetched when the tab opens.
const Changelog = lazy(() => import('../components/community/Changelog.jsx'))

export default function Community() {
  const { t } = useTranslation()
  usePageMeta(t('community.title'), t('community.subtitle'))
  const { account } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'suggestions'
  // Bumped after any staff action, so the staff panel reads the log again.
  const [tick, setTick] = useState(0)
  const moderated = useCallback(() => setTick((n) => n + 1), [])
  const staff = account?.role === 'moderator'

  return (
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('community.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('community.subtitle')}</p>
      </header>

      <div role="tablist" aria-label={t('community.title')} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`community-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`community-panel-${key}`}
            onClick={() => setParams(key === 'suggestions' ? {} : { tab: key }, { replace: true })}
            className={`relative shrink-0 px-3 pb-2.5 pt-1 font-display text-label font-semibold uppercase tracking-[0.08em] transition ${
              tab === key
                ? 'text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                : 'text-dim hover:text-text'
            }`}
          >
            {t(`community.tabs.${key}`)}
          </button>
        ))}
      </div>

      <section role="tabpanel" id={`community-panel-${tab}`} aria-labelledby={`community-tab-${tab}`}>
        {tab === 'suggestions' && <Suggestions onModerated={moderated} />}
        {tab === 'reviews' && <Reviews onModerated={moderated} />}
        {tab === 'changelog' && (
          <Suspense fallback={<BrandLoader className="py-12" />}>
            <Changelog />
          </Suspense>
        )}
      </section>

      {staff && tab !== 'changelog' && <StaffPanel tick={tick} />}
    </div>
  )
}
