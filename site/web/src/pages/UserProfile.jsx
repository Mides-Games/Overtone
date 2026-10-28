import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { Badges, CollectionLinks, ProfileCard, ProfileSkeleton, PublishedTimings } from '../components/social/ProfileParts.jsx'
import { Activity, OsuCard, ProfileAbout, ProfileStats, Showcase, ShareButton } from '../components/social/ProfileMore.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { accentProps } from '../lib/accents.js'
import { userProfile } from '../lib/social.js'

/**
 * A timer's public profile (W13.18, /u/<username>): what they wrote about
 * themselves and their links, their pinned timings, their osu! card, their
 * published timings, the tempo stats, their activity, their public
 * collections and their badges, in the accent they picked. Only what they
 * published; a private profile is the same "not found" as a name nobody has.
 */
export default function UserProfile() {
  const { t } = useTranslation()
  const { username } = useParams()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  usePageMeta(profile ? `@${profile.user.username}` : t('social.profile.title'), t('social.profile.description', { name: profile?.user.username ?? username }))

  useEffect(() => {
    let alive = true
    setProfile(null)
    setError(null)
    userProfile(username)
      .then((data) => alive && setProfile(data))
      .catch((failure) => alive && setError(failure.status === 404 ? 'notFound' : 'network'))
    return () => {
      alive = false
    }
  }, [username])

  if (error === 'notFound') {
    return (
      <div className="space-y-8">
        <PageHeader title={t('social.profile.notFoundTitle')} lede={t('social.profile.notFound')} />
        <EmptyState
          title={`@${username}`}
          className="border-y border-line"
          action={
            <Link to="/timers" className="btn-ghost">
              <Icon name="trophy" size={16} />
              {t('social.timers.link')}
            </Link>
          }
        />
      </div>
    )
  }
  if (!profile) {
    return error ? (
      <p role="status" className="text-label text-dim">
        {t('result.reconnecting')}
      </p>
    ) : (
      <ProfileSkeleton />
    )
  }

  const accent = accentProps(profile.user.accent)
  return (
    <div className={`space-y-14 ${accent.className ?? ''}`} style={accent.style}>
      <ProfileCard user={profile.user} totals={profile.totals}>
        {!profile.private && <ShareButton username={profile.user.username} />}
        {profile.mine && (
          <Link to="/profile" className="btn-ghost btn-sm">
            <Icon name="pencil" size={15} />
            {t('social.profile.edit')}
          </Link>
        )}
      </ProfileCard>
      {profile.mine && profile.private && (
        <p className="-mt-8 flex items-center gap-2 text-label text-muted">
          <Icon name="lock" size={16} className="text-dim" />
          {t('social.profile.privateNote')}
        </p>
      )}
      <ProfileAbout user={profile.user} />
      <Showcase timings={profile.showcase} />
      <OsuCard osu={profile.osu} />
      <PublishedTimings username={profile.user.username} empty={t('social.profile.noTimings')} />
      <ProfileStats stats={profile.stats} published={profile.totals.published} />
      <Activity username={profile.user.username} />
      <CollectionLinks collections={profile.collections} title={t('social.collections.publicTitle')} />
      <Badges badges={profile.badges} dates={profile.badgeDates} />
    </div>
  )
}
