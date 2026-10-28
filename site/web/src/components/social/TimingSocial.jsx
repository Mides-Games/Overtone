import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { useAuth } from '../../context/AuthContext.jsx'
import {
  addToCollection,
  beatmapLink,
  createCollection,
  LIMITS,
  markUsed,
  myCollections,
  rate,
  ratingLabel,
  removeFromCollection,
  timingSocial,
  unmarkUsed,
  userPath,
} from '../../lib/social.js'
import { shortDate } from '../TimingList.jsx'

/**
 * What people did with a published timing (W6), under its result: its stars,
 * who used it in a map (with the map's link), and the reader's own
 * collections. Reading needs nothing; doing needs a Mides account, and the
 * uploader neither rates nor marks their own timing used (the server says so
 * too, as `own`).
 */
export default function TimingSocial({ id, social, onChange }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const signedIn = Boolean(account)

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1fr]" aria-label={t('social.title')}>
      <div className="panel space-y-4 p-4">
        <Rating id={id} social={social} signedIn={signedIn} onChange={onChange} />
        <div className="border-t border-line" />
        <Uses id={id} social={social} signedIn={signedIn} onChange={onChange} />
      </div>
      <div className="panel p-4">
        <Collections id={id} signedIn={signedIn} />
      </div>
    </section>
  )
}

/** Five buttons, one per star; the lit ones are the value. */
export function StarInput({ value, onPick, disabled = false, label }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState(0)
  const shown = hover || value || 0
  return (
    <div role="group" aria-label={label} className="flex" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onPick(n)}
          onMouseEnter={() => setHover(n)}
          aria-pressed={value === n}
          aria-label={t('social.stars.pick', { count: n })}
          className={`h-9 w-9 rounded-control text-[22px] leading-none transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${
            n <= shown ? 'text-amber' : 'text-line-strong'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  )
}

function Rating({ id, social, signedIn, onChange }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { rating } = social

  async function pick(stars) {
    setBusy(true)
    setError(null)
    try {
      const data = await rate(id, stars === rating.mine ? null : stars)
      onChange({ rating: data.rating })
    } catch {
      setError(t('social.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="label">{t('social.stars.title')}</h2>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="readout text-title text-text">{ratingLabel(rating.average)}</span>
        <span className="text-amber" aria-hidden="true">★</span>
        <span className="text-caption text-dim">{t('social.stars.count', { count: rating.count })}</span>
      </p>
      {rating.count > 0 && rating.count < social.minRatings && (
        <p className="text-caption text-dim">{t('social.stars.notRanked', { count: social.minRatings })}</p>
      )}
      {social.own ? (
        <p className="text-caption text-dim">{t('social.stars.own')}</p>
      ) : signedIn ? (
        <div className="space-y-1">
          <StarInput value={rating.mine} onPick={pick} disabled={busy} label={t('social.stars.yours')} />
          <p className="text-caption text-dim">{rating.mine ? t('social.stars.again') : t('social.stars.yoursHint')}</p>
        </div>
      ) : (
        <SignInHint text={t('social.stars.signIn')} />
      )}
      {error && <p role="alert" className="text-caption text-red">{error}</p>}
    </div>
  )
}

function Uses({ id, social, signedIn, onChange }) {
  const { t, i18n } = useTranslation()
  const { uses } = social
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState(uses.mine?.beatmapUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function save(event) {
    event.preventDefault()
    const typed = link.trim()
    const canonical = typed ? beatmapLink(typed) : null
    if (typed && !canonical) return setError(t('social.uses.badLink'))
    setBusy(true)
    setError(null)
    try {
      const data = await markUsed(id, canonical)
      onChange({ uses: data.uses })
      setOpen(false)
    } catch (failure) {
      setError(failure.code === 'BAD_BEATMAP_URL' ? t('social.uses.badLink') : t('social.failed'))
    } finally {
      setBusy(false)
    }
    return undefined
  }

  async function unmark() {
    setBusy(true)
    setError(null)
    try {
      const data = await unmarkUsed(id)
      onChange({ uses: data.uses })
      setLink('')
    } catch {
      setError(t('social.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="label">{t('social.uses.title')}</h2>
      <p className="text-label text-muted">{t('social.uses.count', { count: uses.count })}</p>

      {social.own ? (
        <p className="text-caption text-dim">{t('social.uses.own')}</p>
      ) : !signedIn ? (
        <SignInHint text={t('social.uses.signIn')} />
      ) : open ? (
        <form onSubmit={save} className="space-y-2">
          <label className="block space-y-1">
            <span className="label">{t('social.uses.link')}</span>
            <input
              type="url"
              inputMode="url"
              className="field"
              value={link}
              maxLength={200}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://osu.ppy.sh/beatmapsets/…"
            />
          </label>
          <p className="text-caption text-dim">{t('social.uses.linkHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {uses.mine ? t('social.uses.save') : t('social.uses.mark')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {t('social.cancel')}
            </button>
          </div>
        </form>
      ) : uses.mine ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip-accent">{t('social.uses.marked')}</span>
          <button type="button" className="btn-ghost h-8 px-3" onClick={() => setOpen(true)}>
            {t('social.uses.editLink')}
          </button>
          <button type="button" className="btn-ghost h-8 px-3" onClick={unmark} disabled={busy}>
            {t('social.uses.unmark')}
          </button>
        </div>
      ) : (
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          {t('social.uses.mark')}
        </button>
      )}
      {error && <p role="alert" className="text-caption text-red">{error}</p>}

      {uses.recent.length > 0 && (
        <ul className="divide-y divide-line rounded-panel border border-line">
          {uses.recent.map((u, i) => (
            <li key={`${u.user?.username ?? 'gone'}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-caption">
              <span className="min-w-0 truncate text-muted">
                {u.user ? `@${u.user.username}` : t('social.uses.goneAccount')} ·{' '}
                <time dateTime={u.at}>{shortDate(u.at, i18n.language)}</time>
              </span>
              {u.beatmapUrl && <BeatmapLink url={u.beatmapUrl} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A map someone said they used this timing in: shown as its text and a link.
 * The text is the link itself, so a reader sees where it goes; the server
 * only keeps osu.ppy.sh beatmapset links. `ugc` and `nofollow` because a
 * stranger wrote it; `noopener` because it opens a new tab.
 */
export function BeatmapLink({ url }) {
  const short = url.replace(/^https:\/\//, '')
  return (
    <a href={url} target="_blank" rel="noopener nofollow ugc" className="readout min-w-0 break-all text-accent hover:underline">
      {short} ↗
    </a>
  )
}

function SignInHint({ text }) {
  return (
    <p className="text-caption text-dim">
      <Link to="/login" className="text-accent hover:underline">
        {text}
      </Link>
    </p>
  )
}

/** The reader's own collections, each a checkbox for this timing, and a new one made on the spot. */
function Collections({ id, signedIn }) {
  const { t } = useTranslation()
  const [mine, setMine] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!signedIn) return undefined
    let alive = true
    myCollections(id)
      .then((data) => alive && setMine(data.collections))
      .catch(() => alive && setError(t('social.failed')))
    return () => {
      alive = false
    }
  }, [id, signedIn, t])

  async function toggle(c) {
    setError(null)
    try {
      if (c.has) await removeFromCollection(c.id, id)
      else await addToCollection(c.id, id)
      setMine((list) => list.map((x) => (x.id === c.id ? { ...x, has: !c.has, count: x.count + (c.has ? -1 : 1) } : x)))
    } catch (failure) {
      setError(failure.code === 'LIMIT' ? t('social.collections.full') : t('social.failed'))
    }
  }

  async function create(event) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { collection } = await createCollection(name.trim(), false)
      await addToCollection(collection.id, id)
      setMine((list) => [{ ...collection, has: true, count: 1 }, ...(list ?? [])])
      setName('')
    } catch (failure) {
      setError(failure.code === 'LIMIT' ? t('social.collections.tooMany') : t('social.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="label">{t('social.collections.title')}</h2>
      {!signedIn ? (
        <SignInHint text={t('social.collections.signIn')} />
      ) : mine === null ? (
        !error && <p className="text-caption text-dim">{t('common.loading')}</p>
      ) : (
        <>
          {mine.length === 0 ? (
            <p className="text-caption text-dim">{t('social.collections.none')}</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {mine.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-label hover:bg-surface-2">
                    <input type="checkbox" checked={c.has} onChange={() => toggle(c)} className="accent-[var(--accent)]" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="text-caption text-dim">{c.public ? t('social.collections.public') : t('social.collections.private')}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={create} className="flex gap-2">
            <input
              className="field min-w-0 flex-1 py-2"
              value={name}
              maxLength={LIMITS.collectionName}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('social.collections.newPlaceholder')}
              aria-label={t('social.collections.newName')}
            />
            <button type="submit" className="btn-ghost shrink-0" disabled={busy || !name.trim()}>
              {t('social.collections.create')}
            </button>
          </form>
          <p className="text-caption text-dim">
            {t('social.collections.privateNote')}{' '}
            <Link to="/profile?tab=collections" className="text-accent hover:underline">
              {t('social.collections.manage')}
            </Link>
          </p>
        </>
      )}
      {error && <p role="alert" className="text-caption text-red">{error}</p>}
    </div>
  )
}

/** "by @name", linked to the profile when it has a public one. */
export function UploaderLink({ uploader, linked }) {
  if (!uploader) return null
  return linked ? (
    <Link to={userPath(uploader.username)} className="text-accent hover:underline">
      @{uploader.username}
    </Link>
  ) : (
    <span>@{uploader.username}</span>
  )
}

/** Loads a timing's social numbers; `update(change)` merges what a button returned. */
export function useTimingSocial(id) {
  const [social, setSocial] = useState(null)
  const { account } = useAuth()
  useEffect(() => {
    let alive = true
    setSocial(null)
    timingSocial(id)
      .then((data) => alive && setSocial(data))
      .catch(() => alive && setSocial(false))
    return () => {
      alive = false
    }
  }, [id, account?.id])
  const update = (change) => setSocial((s) => ({ ...s, ...change, rating: change.rating ?? s.rating, uses: change.uses ?? s.uses }))
  return [social, update]
}
