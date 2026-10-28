import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router'

import Connections from '../components/Connections.jsx'
import ProfileEditor from '../components/social/ProfileEditor.jsx'
import { Activity, ProfileAbout, ProfileStats, Showcase, ShareButton } from '../components/social/ProfileMore.jsx'
import { Badges, ProfileCard, ProfileSkeleton, PublishedTimings } from '../components/social/ProfileParts.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { accentProps } from '../lib/accents.js'
import {
  collectionPath,
  createCollection,
  deleteCollection,
  LIMITS,
  myCollections,
  myProfile,
  setProfilePrivate,
  updateCollection,
  userPath,
} from '../lib/social.js'

/**
 * The signed-in account's own profile. The profile itself is the one on
 * midesprojects.com (ADR-W3); Overtone adds what it knows (W5.6): the
 * Timings tab, with the same totals, badges and published timings the
 * public page shows (/u/<username>, W13.18), and the Collections tab, where
 * the account's lists are renamed, shared or deleted. The switch that makes
 * the public page private lives here too.
 */
const TABS = ['timings', 'collections', 'edit']

/** The public fields an edit changes on the header, as the profile names them. */
const pick = ({ about, links, accent }) => ({
  ...(about !== undefined ? { about } : {}),
  ...(links !== undefined ? { links } : {}),
  ...(accent !== undefined ? { accent } : {}),
})

/** The badges after a link, a refresh or an unlink of osu!: "Ranked mapper" follows the card. */
const osuBadges = (badges, osu) => {
  const without = badges.filter((b) => b !== 'ranked-mapper')
  return osu?.rankedCount > 0 ? [...without, 'ranked-mapper'] : without
}

/**
 * Back from Mides' Discord page (`?linked=discord`, W9.1): Overtone keeps no
 * Mides token to ask again, so the profile is refreshed the way it is first
 * read, by signing in. Mides already has a session, so the trip is a bounce.
 * At most once a minute per tab, so a Mides that kept sending the browser
 * back here could not make it loop.
 */
const RELINK_NOTE = 'overtone.relinkAt'
const relinkOnce = () => {
  try {
    const last = Number(sessionStorage.getItem(RELINK_NOTE))
    if (Number.isFinite(last) && Date.now() - last < 60_000) return false
    sessionStorage.setItem(RELINK_NOTE, String(Date.now()))
    return true
  } catch {
    return false
  }
}

export default function Profile() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('nav.profile'))
  const { account, signIn, refresh } = useAuth()
  const [params, setParams] = useSearchParams()
  const relink = params.get('linked') === 'discord'
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'timings'
  const [profile, setProfile] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!relink || !account) return
    setParams({}, { replace: true })
    if (relinkOnce()) signIn('', '/profile').catch(() => {})
  }, [relink, account, setParams, signIn])

  useEffect(() => {
    if (!account) return undefined
    let alive = true
    myProfile()
      .then((data) => alive && setProfile(data))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [account])

  if (account === undefined) return <ProfileSkeleton />
  if (account === null) return <Navigate to="/login" replace state={{ from: '/profile' }} />

  const since = new Date(account.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'long' })
  const user = { ...account, ...(profile?.user ?? {}) }
  const accent = accentProps(profile?.user.accent ?? account.accent)

  /** After an edit: the page's own copy, and the navbar's name. */
  const saved = (fields) => {
    setProfile((p) => p && { ...p, user: { ...p.user, ...pick(fields), displayName: fields.displayName || p.edit.midesDisplayName || p.user.username }, edit: { ...p.edit, ...fields } })
    // The showcase's rows (titles, stats) come from the server: read the profile again.
    if ('showcase' in fields) myProfile().then(setProfile).catch(() => {})
    refresh()
  }

  return (
    <div className={`space-y-12 ${accent.className ?? ''}`} style={accent.style}>
      <ProfileCard user={user} totals={profile?.totals ?? null} visits={profile?.visits ?? null}>
        {profile && !profile.private && (
          <>
            <ShareButton username={account.username} />
            <Link to={userPath(account.username)} className="btn-ghost btn-sm">
              <Icon name="user" size={15} />
              {t('social.profile.publicPage')}
            </Link>
          </>
        )}
        <a
          href={`https://midesprojects.com/profile/${encodeURIComponent(account.username)}`}
          target="_blank"
          rel="noreferrer noopener"
          className="btn-ghost btn-sm"
        >
          {t('profile.onMides')}
          <Icon name="external" size={15} className="text-dim" />
          <span className="sr-only">{t('common.newTab')}</span>
        </a>
      </ProfileCard>

      {profile && (
        <PrivateSwitch
          on={profile.private}
          onChange={(on) => {
            setProfile((p) => ({ ...p, private: on }))
            refresh()
          }}
        />
      )}
      {failed && (
        <p role="alert" className="text-caption text-red">
          {t('social.failed')}
        </p>
      )}

      {profile && <ProfileAbout user={profile.user} />}
      {profile && <Showcase timings={profile.showcase} />}

      <div className="space-y-10">
        <Tabs
          id="profile"
          label={t('nav.profile')}
          tabs={TABS.map((key) => ({ key, label: t(`social.profile.tabs.${key}`) }))}
          value={tab}
          onChange={(key) => setParams(key === 'timings' ? {} : { tab: key }, { replace: true })}
        />

        <section role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`} className="space-y-14">
          {tab === 'timings' && (
            <>
              <PublishedTimings
                username={account.username}
                empty={
                  <>
                    {t('social.profile.noOwnTimings')}{' '}
                    <Link to="/history" className="link">
                      {t('timings.history.all')}
                    </Link>
                  </>
                }
              />
              {profile && <ProfileStats stats={profile.stats} published={profile.totals.published} />}
              <Activity username={account.username} />
              {profile && <Badges badges={profile.badges} dates={profile.badgeDates} />}
            </>
          )}
          {tab === 'collections' && <ManageCollections />}
          {tab === 'edit' &&
            (profile ? (
              <ProfileEditor edit={profile.edit} username={account.username} onSaved={saved} />
            ) : (
              <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />
            ))}
        </section>
      </div>

      <Connections onOsuChange={(osu) => setProfile((p) => p && { ...p, osu, badges: osuBadges(p.badges, osu) })} />

      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-5">
        <p className="readout text-caption text-dim">{t('profile.since', { date: since })}</p>
        <Link to="/settings/tokens" className="btn-quiet btn-sm -mr-2.5">
          <Icon name="key" size={15} />
          {t('platform.tokens.fromProfile')}
          <Icon name="arrow-right" size={15} />
        </Link>
      </footer>
    </div>
  )
}

/** The private-profile switch (W13.18): the public page becomes a 404; the timings stay published. */
function PrivateSwitch({ on, onChange }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function flip() {
    setBusy(true)
    setError(false)
    try {
      const data = await setProfilePrivate(!on)
      onChange(data.private)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="-mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Icon name={on ? 'lock' : 'globe'} size={20} className={`mt-0.5 ${on ? 'text-dim' : 'text-accent'}`} />
        <div className="space-y-1">
          <p className="text-body font-semibold text-text">{on ? t('social.profile.isPrivate') : t('social.profile.isPublic')}</p>
          <p className="max-w-[70ch] text-caption text-muted">{t('social.profile.privateHint')}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-8 sm:pl-0">
        <button type="button" role="switch" aria-checked={on} onClick={flip} disabled={busy} className="btn-ghost btn-sm shrink-0">
          <Icon name={on ? 'globe' : 'lock'} size={15} />
          {on ? t('social.profile.makePublic') : t('social.profile.makePrivate')}
        </button>
        {error && (
          <span role="alert" className="text-caption text-red">
            {t('social.failed')}
          </span>
        )}
      </div>
    </div>
  )
}

/** The account's collections: make one, rename it, share it or not, delete it. */
function ManageCollections() {
  const { t } = useTranslation()
  const [list, setList] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    myCollections()
      .then((data) => alive && setList(data.collections))
      .catch(() => alive && setError(t('social.failed')))
    return () => {
      alive = false
    }
  }, [tick, t])

  async function act(work) {
    setError(null)
    try {
      await work()
      reload()
    } catch (failure) {
      setError(failure.code === 'LIMIT' ? t('social.collections.tooMany') : t('social.failed'))
    }
  }

  async function create(event) {
    event.preventDefault()
    if (!name.trim()) return
    await act(() => createCollection(name.trim(), false))
    setName('')
  }

  return (
    <div className="space-y-6">
      <p className="max-w-[70ch] text-body text-muted">{t('social.collections.intro')}</p>
      <form onSubmit={create} className="panel flex max-w-2xl flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 space-y-1.5">
          <span className="label block">{t('social.collections.newName')}</span>
          <input
            type="text"
            className="field"
            value={name}
            maxLength={LIMITS.collectionName}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('social.collections.newPlaceholder')}
            autoComplete="off"
            enterKeyHint="done"
          />
        </label>
        <button type="submit" className="btn-primary shrink-0" disabled={!name.trim()}>
          <Icon name="plus" size={16} />
          {t('social.collections.create')}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
      {list === null ? (
        !error && <SkeletonRows rows={3} label={t('common.loading')} className="border-y border-line" />
      ) : list.length === 0 ? (
        <EmptyState title={t('social.collections.noneYet')} className="border-y border-line" />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((c) => (
            <CollectionRow key={c.id} collection={c} act={act} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CollectionRow({ collection: c, act }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(c.name)
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            await act(() => updateCollection(c.id, { name: name.trim() }))
            setEditing(false)
          }}
        >
          <input
            type="text"
            className="field min-w-0 flex-1"
            value={name}
            maxLength={LIMITS.collectionName}
            onChange={(e) => setName(e.target.value)}
            aria-label={t('social.collections.rename')}
            autoComplete="off"
            // Opened to type the new name.
            autoFocus
          />
          <button type="submit" className="btn-primary shrink-0" disabled={!name.trim()}>
            {t('social.collections.save')}
          </button>
        </form>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <Icon name={c.public ? 'globe' : 'lock'} size={18} className={c.public ? 'text-accent' : 'text-dim'} />
          <div className="min-w-0">
            <Link to={collectionPath(c.id)} className="block truncate text-body font-semibold text-text hover:text-accent">
              {c.name}
            </Link>
            <p className="readout text-caption text-dim">
              {c.public ? t('social.collections.public') : t('social.collections.private')} · {t('social.collections.count', { count: c.count })}
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={() => act(() => updateCollection(c.id, { public: !c.public }))}>
          {c.public ? t('social.collections.makePrivate') : t('social.collections.makePublic')}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>
          {!editing && <Icon name="pencil" size={14} />}
          {editing ? t('social.cancel') : t('social.collections.rename')}
        </button>
        {confirming ? (
          <span className="inline-flex items-center gap-2">
            <button type="button" className="btn-ghost btn-sm border-red/50 text-red" onClick={() => act(() => deleteCollection(c.id))}>
              <Icon name="trash" size={14} />
              {t('social.collections.deleteYes')}
            </button>
            <button type="button" className="btn-quiet btn-sm" onClick={() => setConfirming(false)}>
              {t('social.cancel')}
            </button>
          </span>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            <Icon name="trash" size={14} />
            <span className="max-sm:sr-only">{t('social.collections.delete')}</span>
          </button>
        )}
      </div>
    </li>
  )
}
