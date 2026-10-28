import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
import { StaffPanel } from '../components/community/Moderation.jsx'
import Reviews from '../components/community/Reviews.jsx'
import Suggestions from '../components/community/Suggestions.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import Tabs from '../components/ui/Tabs.jsx'
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
    <div className="space-y-10">
      <PageHeader title={t('community.title')} lede={t('community.subtitle')} />

      <div className="space-y-8">
        <Tabs
          id="community"
          label={t('community.title')}
          tabs={TABS.map((key) => ({ key, label: t(`community.tabs.${key}`) }))}
          value={tab}
          onChange={(key) => setParams(key === 'suggestions' ? {} : { tab: key }, { replace: true })}
        />

        <section role="tabpanel" id={`community-panel-${tab}`} aria-labelledby={`community-tab-${tab}`}>
          {tab === 'suggestions' && <Suggestions onModerated={moderated} />}
          {tab === 'reviews' && <Reviews onModerated={moderated} />}
          {tab === 'changelog' && (
            <Suspense fallback={<SkeletonRows rows={4} label={t('community.loading')} />}>
              <Changelog />
            </Suspense>
          )}
        </section>
      </div>

      {staff && tab !== 'changelog' && <StaffPanel tick={tick} />}
    </div>
  )
}
