import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { Badges, CollectionLinks, ProfileCard, ProfileSkeleton, PublishedTimings } from '../components/social/ProfileParts.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { userProfile } from '../lib/social.js'

/**
 * A timer's public profile (W13.18, /u/<username>): their published timings,
 * their totals and badges, and their public collections. Only what they
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

  return (
    <div className="space-y-14">
      <ProfileCard user={profile.user} totals={profile.totals}>
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
      <PublishedTimings username={profile.user.username} empty={t('social.profile.noTimings')} />
      <CollectionLinks collections={profile.collections} title={t('social.collections.publicTitle')} />
      <Badges badges={profile.badges} />
    </div>
  )
}
