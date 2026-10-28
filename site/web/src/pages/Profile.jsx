import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import Connections from '../components/Connections.jsx'
import { Badges, ProfileCard, PublishedTimings } from '../components/social/ProfileParts.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
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
const TABS = ['timings', 'collections']

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

  if (account === undefined) return <BrandLoader className="py-16" />
  if (account === null) return <Navigate to="/login" replace state={{ from: '/profile' }} />

  const since = new Date(account.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'long' })

  return (
    <div className="rise space-y-6">
      <ProfileCard user={account} totals={profile?.totals ?? null}>
        <div className="flex flex-wrap gap-2">
          {profile && !profile.private && (
            <Link to={userPath(account.username)} className="btn-ghost h-9">
              {t('social.profile.publicPage')}
            </Link>
          )}
          <a
            href={`https://midesprojects.com/profile/${encodeURIComponent(account.username)}`}
            target="_blank"
            rel="noreferrer noopener"
            className="btn-ghost h-9"
          >
            {t('profile.onMides')} ↗
          </a>
        </div>
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
      {failed && <p className="text-caption text-red">{t('social.failed')}</p>}

      <div role="tablist" aria-label={t('nav.profile')} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`profile-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`profile-panel-${key}`}
            onClick={() => setParams(key === 'timings' ? {} : { tab: key }, { replace: true })}
            className={`relative shrink-0 px-3 pb-2.5 pt-1 font-display text-label font-semibold uppercase tracking-[0.08em] transition ${
              tab === key
                ? 'text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                : 'text-dim hover:text-text'
            }`}
          >
            {t(`social.profile.tabs.${key}`)}
          </button>
        ))}
      </div>

      <section role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`} className="space-y-8">
        {tab === 'timings' && (
          <>
            {profile && <Badges badges={profile.badges} />}
            <PublishedTimings
              username={account.username}
              empty={
                <>
                  {t('social.profile.noOwnTimings')}{' '}
                  <Link to="/history" className="text-accent hover:underline">
                    {t('timings.history.all')}
                  </Link>
                </>
              }
            />
          </>
        )}
        {tab === 'collections' && <ManageCollections />}
      </section>

      <Connections />

      <p className="readout text-caption text-dim">{t('profile.since', { date: since })}</p>
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
    <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-label font-semibold">{on ? t('social.profile.isPrivate') : t('social.profile.isPublic')}</p>
        <p className="max-w-[70ch] text-caption text-dim">{t('social.profile.privateHint')}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" role="switch" aria-checked={on} onClick={flip} disabled={busy} className="btn-ghost shrink-0">
          {on ? t('social.profile.makePublic') : t('social.profile.makePrivate')}
        </button>
        {error && <span role="alert" className="text-caption text-red">{t('social.failed')}</span>}
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
    <div className="space-y-4">
      <p className="max-w-[70ch] text-label text-muted">{t('social.collections.intro')}</p>
      <form onSubmit={create} className="flex gap-2">
        <input
          className="field min-w-0 flex-1"
          value={name}
          maxLength={LIMITS.collectionName}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('social.collections.newPlaceholder')}
          aria-label={t('social.collections.newName')}
        />
        <button type="submit" className="btn-primary shrink-0" disabled={!name.trim()}>
          {t('social.collections.create')}
        </button>
      </form>
      {error && <p role="alert" className="text-caption text-red">{error}</p>}
      {list === null ? (
        !error && <BrandLoader className="py-10" />
      ) : list.length === 0 ? (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('social.collections.noneYet')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-panel border border-line">
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
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            await act(() => updateCollection(c.id, { name: name.trim() }))
            setEditing(false)
          }}
        >
          <input className="field min-w-0 flex-1 py-2" value={name} maxLength={LIMITS.collectionName} onChange={(e) => setName(e.target.value)} aria-label={t('social.collections.rename')} />
          <button type="submit" className="btn-primary h-[42px] shrink-0" disabled={!name.trim()}>
            {t('social.collections.save')}
          </button>
        </form>
      ) : (
        <div className="min-w-0">
          <Link to={collectionPath(c.id)} className="block truncate text-label font-semibold text-text hover:text-accent">
            {c.name}
          </Link>
          <p className="text-caption text-dim">
            {c.public ? t('social.collections.public') : t('social.collections.private')} · {t('social.collections.count', { count: c.count })}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost h-8 px-3" onClick={() => act(() => updateCollection(c.id, { public: !c.public }))}>
          {c.public ? t('social.collections.makePrivate') : t('social.collections.makePublic')}
        </button>
        <button type="button" className="btn-ghost h-8 px-3" onClick={() => setEditing((v) => !v)}>
          {editing ? t('social.cancel') : t('social.collections.rename')}
        </button>
        {confirming ? (
          <span className="inline-flex items-center gap-2 text-caption">
            <button type="button" className="text-red hover:underline" onClick={() => act(() => deleteCollection(c.id))}>
              {t('social.collections.deleteYes')}
            </button>
            <button type="button" className="text-dim hover:text-text" onClick={() => setConfirming(false)}>
              {t('social.cancel')}
            </button>
          </span>
        ) : (
          <button type="button" className="btn-ghost h-8 px-3" onClick={() => setConfirming(true)}>
            {t('social.collections.delete')}
          </button>
        )}
      </div>
    </li>
  )
}
