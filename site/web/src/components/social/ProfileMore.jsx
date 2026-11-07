import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LINK_KINDS, profileUrl, userActivity } from '../../lib/social.js'
import { bpmLabel, timingPath } from '../../lib/timings.js'
import { BpmChart, TempoChart } from '../StatsCharts.jsx'
import TimingList from '../TimingList.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'
import SectionHeader from '../ui/SectionHeader.jsx'
import { SkeletonRows } from '../ui/Skeleton.jsx'

/**
 * The parts of a profile the edit of 2026-10-28 added, shared by /profile
 * and /u/<username>: the About text and links, the pinned timings, the tempo
 * stats, the activity and the "copy link" button (the osu! card has its own
 * file, OsuCard.jsx). What the person wrote is rendered as text (React
 * escapes it); a link goes only to what the API kept, each to its own site,
 * and is marked `ugc` with `nofollow` so a profile cannot lend this site's
 * standing to a link.
 */

const LINK_REL = 'noopener nofollow ugc'

/** "About" and the links under the header; nothing when the person wrote neither. */
export function ProfileAbout({ user }) {
  const { t } = useTranslation()
  const links = LINK_KINDS.filter((kind) => user.links?.[kind])
  if (!user.about && !links.length) return null
  return (
    <section aria-labelledby="profile-about" className="-mt-4 space-y-4">
      <h2 id="profile-about" className="sr-only">
        {t('social.profile.about')}
      </h2>
      {user.about && <p className="max-w-[70ch] whitespace-pre-line break-words text-body text-text">{user.about}</p>}
      {links.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('social.profile.links.title')}>
          {links.map((kind) => (
            <li key={kind}>
              <a href={user.links[kind]} target="_blank" rel={LINK_REL} className="btn-ghost btn-sm">
                <Icon name={kind === 'website' ? 'globe' : 'link'} size={14} />
                {t(`social.profile.links.${kind}`)}
                <Icon name="external" size={13} className="text-dim" />
                <span className="sr-only">{t('common.newTab')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** "Copy profile link": the page's own URL on this origin. */
export function ShareButton({ username }) {
  const { t } = useTranslation()
  const [state, setState] = useState(null)
  const url = profileUrl(username)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn-ghost btn-sm" onClick={copy}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
        {state === 'copied' ? t('social.profile.copied') : t('social.profile.share')}
      </button>
      {state === 'failed' && (
        <span role="alert" className="readout select-all break-all text-caption text-muted">
          {url}
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? t('social.profile.copied') : ''}
      </span>
    </span>
  )
}

/** The pinned timings, in the owner's order. */
export function Showcase({ timings }) {
  const { t } = useTranslation()
  if (!timings?.length) return null
  return (
    <section aria-labelledby="profile-showcase" className="space-y-5">
      <SectionHeader id="profile-showcase" title={t('social.profile.showcase')} />
      <TimingList timings={timings} />
    </section>
  )
}

/** The BPM spread and the tempo split of the published timings, and the most used one. */
export function ProfileStats({ stats, published }) {
  const { t } = useTranslation()
  if (!stats || !published) return null
  const used = stats.mostUsed
  return (
    <section aria-labelledby="profile-stats" className="space-y-6">
      <SectionHeader id="profile-stats" title={t('social.profile.stats.title')} />
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <div className="min-w-0 space-y-4 border-t border-line pt-5">
          <h3 className="heading-title">{t('social.profile.stats.bpm')}</h3>
          <BpmChart buckets={stats.bpm.buckets} />
        </div>
        <div className="min-w-0 space-y-8">
          <div className="space-y-4 border-t border-line pt-5">
            <h3 className="heading-title">{t('social.profile.stats.tempo')}</h3>
            <TempoChart single={stats.tempo.single} variable={stats.tempo.variable} />
          </div>
          <div className="space-y-2 border-t border-line pt-5">
            <h3 className="heading-title">{t('social.profile.stats.mostUsed')}</h3>
            {used ? (
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link to={timingPath(used.id)} className="link min-w-0 break-words text-body font-semibold">
                  {[used.artist, used.title].filter(Boolean).join(' - ') || used.id}
                </Link>
                <span className="readout text-caption text-dim">
                  {bpmLabel(used.bpm)} · {t('social.profile.stats.uses', { count: used.uses ?? 0 })}
                </span>
              </p>
            ) : (
              <p className="text-label text-dim">{t('social.profile.stats.noneUsed')}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** The public activity, a page at a time. */
export function Activity({ username }) {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState(null)
  const [next, setNext] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (cursor) => {
      setBusy(true)
      setError(false)
      try {
        const page = await userActivity(username, cursor)
        setItems((old) => [...(cursor ? old ?? [] : []), ...page.items])
        setNext(page.next)
      } catch {
        setError(true)
      } finally {
        setBusy(false)
      }
    },
    [username],
  )

  useEffect(() => {
    setItems(null)
    load(null)
  }, [load])

  const when = (at) => new Date(at).toLocaleDateString(i18n.language, { dateStyle: 'medium' })

  return (
    <section aria-labelledby="profile-activity" className="space-y-5">
      <SectionHeader id="profile-activity" title={t('social.profile.activity.title')} />
      {items === null ? (
        error ? (
          <p role="alert" className="text-caption text-red">
            {t('social.failed')}
          </p>
        ) : (
          <SkeletonRows rows={3} label={t('common.loading')} className="border-y border-line" />
        )
      ) : items.length === 0 ? (
        <EmptyState title={t('social.profile.activity.empty')} className="border-y border-line" />
      ) : (
        <ol className="divide-y divide-line border-y border-line">
          {items.map((item, i) => (
            <li key={`${item.kind}-${item.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
              <span className="min-w-0 text-label text-text">
                <span className="text-muted">{t(`social.profile.activity.kinds.${item.kind}`)}</span>
                {item.timing && (
                  <>
                    {' '}
                    <Link to={timingPath(item.timing.id)} className="link break-words font-medium">
                      {[item.timing.artist, item.timing.title].filter(Boolean).join(' - ') || item.timing.id}
                    </Link>
                  </>
                )}
                {item.suggestion && <span className="break-words font-medium"> {item.suggestion.title}</span>}
                {item.kind === 'review' && <span className="readout"> {'★'.repeat(item.stars)}</span>}
              </span>
              <time dateTime={item.at} className="readout shrink-0 text-caption text-dim">
                {when(item.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {next && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => load(next)} disabled={busy}>
          {busy ? t('common.loading') : t('social.profile.activity.more')}
        </button>
      )}
      {items !== null && error && (
        <p role="alert" className="text-caption text-red">
          {t('social.failed')}
        </p>
      )}
    </section>
  )
}
