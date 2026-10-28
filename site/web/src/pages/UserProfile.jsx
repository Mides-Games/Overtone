import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { Badges, CollectionLinks, ProfileCard, PublishedTimings } from '../components/social/ProfileParts.jsx'
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
      <div className="panel space-y-3 p-6">
        <h1 className="font-display text-title font-bold uppercase">{t('social.profile.notFoundTitle')}</h1>
        <p className="text-label text-muted">{t('social.profile.notFound')}</p>
        <Link to="/timers" className="btn-ghost">
          {t('social.timers.link')}
        </Link>
      </div>
    )
  }
  if (!profile) return error ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />

  return (
    <div className="rise space-y-8">
      <ProfileCard user={profile.user} totals={profile.totals}>
        {profile.mine && (
          <Link to="/profile" className="btn-ghost h-9">
            {t('social.profile.edit')}
          </Link>
        )}
      </ProfileCard>
      {profile.mine && profile.private && <p className="chip-amber">{t('social.profile.privateNote')}</p>}
      <Badges badges={profile.badges} />
      <PublishedTimings username={profile.user.username} empty={t('social.profile.noTimings')} />
      <CollectionLinks collections={profile.collections} title={t('social.collections.publicTitle')} />
    </div>
  )
}
