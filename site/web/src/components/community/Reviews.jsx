import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../context/AuthContext.jsx'
import { deleteOwnReview, LIMITS, length, listReviews, postReview, reviewFormToken } from '../../lib/community.js'
import Avatar from '../Avatar.jsx'
import BrandLoader from '../BrandLoader.jsx'
import { HideButton, ReportButton, StaffNote } from './Moderation.jsx'
import { Counter } from './Suggestions.jsx'

/**
 * Reviews of the site (W5.3): 1-5 stars and a few words, with a Mides account
 * (one each, editable) or anonymous. The average counts an anonymous review
 * at half, and the page says so beside it.
 */
export default function Reviews({ onModerated }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => {
    setTick((n) => n + 1)
    onModerated?.()
  }, [onModerated])

  useEffect(() => {
    let alive = true
    setFailed(false)
    listReviews()
      .then((data) => alive && setPage(data))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [tick, account?.id])

  async function more() {
    const next = await listReviews(page.items.length)
    setPage((current) => ({ ...next, items: [...current.items, ...next.items.filter((r) => !current.items.some((c) => c.id === r.id))] }))
  }

  if (failed) return <p className="text-label text-red">{t('community.errors.load')}</p>
  if (!page) return <BrandLoader className="py-12" />

  return (
    <div className="space-y-6">
      <Summary stats={page.stats} />
      {account !== undefined && <ReviewForm key={page.mine?.updatedAt ?? 'new'} mine={page.mine} signedIn={Boolean(account)} onSaved={refresh} />}
      {page.items.length === 0 ? (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('community.reviews.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {page.items.map((r) => (
            <ReviewCard key={r.id} review={r} staff={Boolean(page.staff)} onChanged={refresh} />
          ))}
        </ul>
      )}
      {page.items.length < page.total && (
        <button type="button" onClick={more} className="btn-ghost mx-auto flex">
          {t('community.more', { count: page.total - page.items.length })}
        </button>
      )}
    </div>
  )
}

export function Stars({ value, size = 'text-body' }) {
  const { t } = useTranslation()
  return (
    <span role="img" aria-label={t('community.reviews.starsLabel', { count: value })} className={`${size} tracking-[0.1em] text-amber`}>
      {'★'.repeat(value)}
      <span className="text-line-strong">{'★'.repeat(5 - value)}</span>
    </span>
  )
}

/** The average, how many, how many anonymous, and the bars from 5 to 1. */
function Summary({ stats }) {
  const { t, i18n } = useTranslation()
  const most = Math.max(1, ...stats.distribution)
  return (
    <section className="panel grid gap-5 p-5 sm:grid-cols-[auto_1fr] sm:items-center">
      <div className="space-y-1 text-center sm:pr-6 sm:text-left">
        <p className="readout font-display text-[2.6rem] font-bold leading-none">
          {stats.average === null ? '–' : stats.average.toLocaleString(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
        </p>
        {stats.average !== null && <Stars value={Math.round(stats.average)} />}
        <p className="text-caption text-dim">{t('community.reviews.count', { count: stats.count })}</p>
      </div>
      <div className="space-y-1.5">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = stats.distribution[star - 1]
          return (
            <div key={star} className="flex items-center gap-2 text-caption">
              <span className="readout w-6 text-dim">{star}★</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-amber" style={{ width: `${(n / most) * 100}%` }} />
              </div>
              <span className="readout w-8 text-right text-dim">{n}</span>
            </div>
          )
        })}
        <p className="pt-1 text-caption text-dim">{t('community.reviews.weighting', { count: stats.anonymous })}</p>
      </div>
    </section>
  )
}

/**
 * Leave a review, or edit your own. Anonymous: the form asks the API for a
 * token when it opens (the server refuses one sent too fast), and carries a
 * field no person sees, which a form-filling script fills.
 */
function ReviewForm({ mine, signedIn, onSaved }) {
  const { t } = useTranslation()
  const [stars, setStars] = useState(mine?.stars ?? 0)
  const [body, setBody] = useState(mine?.body ?? '')
  const [website, setWebsite] = useState('')
  const [token, setToken] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    if (signedIn) return undefined
    let alive = true
    reviewFormToken()
      .then((data) => alive && setToken(data.token))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [signedIn])

  async function submit(event) {
    event.preventDefault()
    if (!stars) return setMessage({ error: true, text: t('community.reviews.pickStars') })
    setBusy(true)
    setMessage(null)
    try {
      await postReview({ stars, body, website, ...(signedIn ? {} : { token }) })
      if (!signedIn) {
        setStars(0)
        setBody('')
        setMessage({ error: false, text: t('community.reviews.thanks') })
        // A second anonymous review needs a new form, timed from now.
        reviewFormToken().then((data) => setToken(data.token)).catch(() => {})
      }
      onSaved?.()
    } catch (failure) {
      setMessage({ error: true, text: t(`community.errors.${failure.code}`, { defaultValue: t('community.errors.failed') }) })
    } finally {
      setBusy(false)
    }
    return undefined
  }

  async function remove() {
    if (!window.confirm(t('community.reviews.deleteConfirm'))) return
    try {
      await deleteOwnReview()
      onSaved?.()
    } catch {
      setMessage({ error: true, text: t('community.errors.failed') })
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4">
      <h2 className="label">{mine ? t('community.reviews.editTitle') : t('community.reviews.formTitle')}</h2>
      {mine?.hidden && <p className="text-caption text-amber">{t('community.reviews.yoursHidden')}</p>}
      <fieldset className="space-y-1">
        <legend className="sr-only">{t('community.reviews.starsLegend')}</legend>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setStars(n)}
              aria-pressed={stars === n}
              aria-label={t('community.reviews.starsLabel', { count: n })}
              className={`h-9 w-9 rounded-control text-[22px] leading-none transition hover:bg-surface-2 ${n <= stars ? 'text-amber' : 'text-line-strong'}`}
            >
              ★
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1.5">
        <span className="label">{t('community.reviews.body')}</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={3} className="field resize-y" />
        <Counter value={body} max={LIMITS.review} />
      </label>
      {/* The honeypot: out of sight, out of the tab order, never autofilled. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
        </label>
      </div>
      {!signedIn && <p className="text-caption text-dim">{t('community.reviews.anonymousNote')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || length(body) > LIMITS.review || (!signedIn && !token)} className="btn-primary">
          {mine ? t('community.reviews.update') : t('community.reviews.post')}
        </button>
        {mine && (
          <button type="button" onClick={remove} className="btn-ghost">
            {t('community.reviews.delete')}
          </button>
        )}
        {message && (
          <span role={message.error ? 'alert' : 'status'} className={`text-label ${message.error ? 'text-red' : 'text-accent'}`}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  )
}

function ReviewCard({ review: r, staff, onChanged }) {
  const { t, i18n } = useTranslation()
  const date = new Date(r.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'medium' })
  const edited = Date.parse(r.updatedAt) - Date.parse(r.createdAt) > 60_000
  return (
    <li className={`panel space-y-2 p-4 ${r.hidden ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars value={r.stars} />
        <span className="inline-flex items-center gap-1.5 text-label">
          {r.author ? <Avatar account={r.author} size={20} /> : null}
          {r.author ? `@${r.author.username}` : <span className="text-dim">{t('community.reviews.anonymous')}</span>}
        </span>
        {r.mine && <span className="chip border-line-strong text-dim">{t('community.yours')}</span>}
        {r.hidden && <span className="chip-amber">{t('community.moderation.hiddenChip')}</span>}
        <span className="readout ml-auto text-caption text-dim">
          {date}
          {edited && ` · ${t('community.reviews.edited')}`}
        </span>
      </div>
      <p className="whitespace-pre-line break-words text-label text-muted">{r.body}</p>
      <div className="flex flex-wrap items-center gap-3">
        {!r.mine && <ReportButton kind="reviews" id={r.id} />}
        {staff && <HideButton kind="reviews" item={r} onDone={onChanged} />}
      </div>
      {staff && <StaffNote item={r} />}
    </li>
  )
}
