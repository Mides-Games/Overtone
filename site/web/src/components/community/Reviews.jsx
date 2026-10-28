import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../context/AuthContext.jsx'
import { deleteOwnReview, LIMITS, length, listReviews, postReview, reviewFormToken } from '../../lib/community.js'
import Avatar from '../Avatar.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'
import Skeleton, { SkeletonRows } from '../ui/Skeleton.jsx'
import { HideButton, ReportButton, StaffNote } from './Moderation.jsx'
import { Counter } from './Suggestions.jsx'

/**
 * Reviews of the site (W5.3): 1-5 stars and a few words, with a Mides account
 * (one each, editable) or anonymous. The average counts an anonymous review
 * at half, and the page says so beside it.
 *
 * Laid out as the design asks (docs/design.md, section 11): the summary is a
 * readout on the page's ground beside the form, the one panel, since it is
 * operated; the reviews are rows a hairline apart.
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

  if (failed) {
    return (
      <p role="alert" className="text-label text-red">
        {t('community.errors.load')}
      </p>
    )
  }
  if (!page) return <ReviewsSkeleton />

  return (
    <div className="space-y-10">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
        <Summary stats={page.stats} className="lg:col-span-5" />
        {account !== undefined && (
          <ReviewForm key={page.mine?.updatedAt ?? 'new'} mine={page.mine} signedIn={Boolean(account)} onSaved={refresh} className="lg:col-span-7" />
        )}
      </div>
      {page.items.length === 0 ? (
        <EmptyState title={t('community.reviews.empty')} className="border-y border-line" />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {page.items.map((r) => (
            <ReviewRow key={r.id} review={r} staff={Boolean(page.staff)} onChanged={refresh} />
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

/** The summary's and the list's shape while the first read runs. */
function ReviewsSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="space-y-10" aria-busy="true">
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-12 w-28" />
        <Skeleton className="h-3 w-40" />
      </div>
      <SkeletonRows rows={3} label={t('community.loading')} className="border-y border-line" />
    </div>
  )
}

/** Stars as a picture with a name: filled for the earned ones, outlined for the rest. */
export function Stars({ value, size = 16 }) {
  const { t } = useTranslation()
  return (
    <span role="img" aria-label={t('community.reviews.starsLabel', { count: value })} className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) =>
        n <= value ? (
          <Icon key={n} name="star-filled" size={size} strokeWidth={1} className="text-amber" />
        ) : (
          <Icon key={n} name="star" size={size} className="text-line-strong" />
        ),
      )}
    </span>
  )
}

/** The average, how many, how many anonymous, and the bars from 5 to 1. */
function Summary({ stats, className = '' }) {
  const { t, i18n } = useTranslation()
  const most = Math.max(1, ...stats.distribution)
  return (
    <section aria-label={t('community.reviews.count', { count: stats.count })} className={`space-y-5 ${className}`}>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <p className="readout font-display text-[clamp(2.75rem,2.2rem+2vw,3.75rem)] font-bold leading-none text-text">
          {stats.average === null ? '–' : stats.average.toLocaleString(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
        </p>
        <div className="space-y-1.5 pb-1">
          {stats.average !== null && <Stars value={Math.round(stats.average)} size={18} />}
          <p className="readout text-label text-muted">{t('community.reviews.count', { count: stats.count })}</p>
        </div>
      </div>
      <dl className="space-y-2">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = stats.distribution[star - 1]
          return (
            <div key={star} className="flex items-center gap-3 text-caption">
              <dt className="readout flex w-8 shrink-0 items-center gap-1 text-dim">
                {star}
                <Icon name="star" size={11} />
                <span className="sr-only">{t('community.reviews.starsLabel', { count: star })}</span>
              </dt>
              <dd className="flex flex-1 items-center gap-3">
                <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <span className="block h-full origin-left rounded-full bg-amber" style={{ transform: `scaleX(${n / most})` }} />
                </span>
                <span className="readout w-8 text-right text-muted">{n}</span>
              </dd>
            </div>
          )
        })}
      </dl>
      <p className="max-w-[52ch] text-caption text-dim">{t('community.reviews.weighting', { count: stats.anonymous })}</p>
    </section>
  )
}

/**
 * Leave a review, or edit your own. Anonymous: the form asks the API for a
 * token when it opens (the server refuses one sent too fast), and carries a
 * field no person sees, which a form-filling script fills.
 */
function ReviewForm({ mine, signedIn, onSaved, className = '' }) {
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
    <form onSubmit={submit} className={`panel relative space-y-4 p-5 sm:p-6 ${className}`}>
      <h2 className="heading-title">{mine ? t('community.reviews.editTitle') : t('community.reviews.formTitle')}</h2>
      {mine?.hidden && <p className="text-caption text-amber">{t('community.reviews.yoursHidden')}</p>}
      <fieldset className="space-y-1.5">
        <legend className="label mb-1.5">{t('community.reviews.starsLegend')}</legend>
        <div className="-ml-1.5 flex gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setStars(n)}
              aria-pressed={stars === n}
              aria-label={t('community.reviews.starsLabel', { count: n })}
              className={`icon-btn ${n <= stars ? 'text-amber' : 'text-line-strong'}`}
            >
              <Icon name={n <= stars ? 'star-filled' : 'star'} size={24} strokeWidth={n <= stars ? 1 : 1.5} />
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1.5">
        <span className="label">{t('community.reviews.body')}</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={3}
          aria-invalid={length(body) > LIMITS.review || undefined}
          className="field h-auto resize-y py-2.5"
        />
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
            <Icon name="trash" size={16} />
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

function ReviewRow({ review: r, staff, onChanged }) {
  const { t, i18n } = useTranslation()
  const date = new Date(r.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'medium' })
  const edited = Date.parse(r.updatedAt) - Date.parse(r.createdAt) > 60_000
  return (
    <li className={`grid gap-x-6 gap-y-3 py-5 sm:grid-cols-[12rem_1fr] ${r.hidden ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-col sm:items-start">
        <span className="inline-flex min-w-0 items-center gap-2 text-label font-medium">
          {r.author ? <Avatar account={r.author} size={24} decorative /> : <Icon name="user" size={18} className="text-dim" />}
          {r.author ? <span className="truncate text-text">@{r.author.username}</span> : <span className="text-muted">{t('community.reviews.anonymous')}</span>}
        </span>
        <span className="readout text-caption text-dim">
          <time dateTime={r.createdAt}>{date}</time>
          {edited && ` · ${t('community.reviews.edited')}`}
        </span>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Stars value={r.stars} />
          {r.mine && <span className="chip-neutral">{t('community.yours')}</span>}
          {r.hidden && (
            <span className="chip-neutral">
              <Icon name="eye-off" size={12} />
              {t('community.moderation.hiddenChip')}
            </span>
          )}
        </div>
        <p className="max-w-[72ch] whitespace-pre-line break-words text-body text-muted">{r.body}</p>
        {(!r.mine || staff) && (
          <div className="flex flex-wrap items-center gap-3">
            {!r.mine && <ReportButton kind="reviews" id={r.id} />}
            {staff && <HideButton kind="reviews" item={r} onDone={onChanged} />}
          </div>
        )}
        {staff && <StaffNote item={r} />}
      </div>
    </li>
  )
}
