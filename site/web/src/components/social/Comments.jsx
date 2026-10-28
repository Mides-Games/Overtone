import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { useAuth } from '../../context/AuthContext.jsx'
import { length } from '../../lib/community.js'
import { deleteComment, formatAt, LIMITS, listComments, parseAt, postComment } from '../../lib/social.js'
import Avatar from '../Avatar.jsx'
import { HideButton, ReportButton, StaffNote } from '../community/Moderation.jsx'
import { Counter } from '../community/Suggestions.jsx'

/**
 * Comments on a published timing (W6), oldest first. A comment may point at
 * a time in the song (W13.15): its m:ss is a button that moves the player
 * there (`onSeek(ms)`), and the form can take the player's own position.
 * Text is plain text, rendered as such. Its author deletes it; anyone
 * reports it and staff hide it, through the community's moderation.
 */
export default function Comments({ id, durationS, onSeek, position, onItems = null }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    setFailed(false)
    listComments(id)
      .then((data) => alive && setPage(data))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [id, tick, account?.id])

  // A link to one comment (the staff panel's, a notification's) lands on it once the list is in.
  useEffect(() => {
    if (!page || !window.location.hash.startsWith('#comment-')) return
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'center' })
  }, [page])

  // The timed ones are drawn on the tempo map too (W13.15).
  useEffect(() => {
    if (page) onItems?.(page.items)
  }, [page, onItems])

  async function more() {
    const next = await listComments(id, page.items.length)
    setPage((current) => ({ ...next, items: [...current.items, ...next.items.filter((c) => !current.items.some((x) => x.id === c.id))] }))
  }

  return (
    <section className="space-y-4" aria-labelledby="comments-title">
      <h2 id="comments-title" className="label">
        {t('social.comments.title')}
        {page ? ` · ${page.total}` : ''}
      </h2>

      {account ? (
        <CommentForm id={id} durationS={durationS} position={position} onPosted={refresh} />
      ) : (
        account === null && (
          <p className="text-caption text-dim">
            <Link to="/login" className="text-accent hover:underline">
              {t('social.comments.signIn')}
            </Link>
          </p>
        )
      )}

      {failed && <p className="text-caption text-red">{t('social.failed')}</p>}
      {page && page.items.length === 0 && <p className="text-caption text-dim">{t('social.comments.empty')}</p>}
      {page && page.items.length > 0 && (
        <ul className="space-y-3">
          {page.items.map((c) => (
            <CommentCard key={c.id} timingId={id} comment={c} staff={Boolean(page.staff)} onSeek={onSeek} onChanged={refresh} />
          ))}
        </ul>
      )}
      {page && page.items.length < page.total && (
        <button type="button" onClick={more} className="btn-ghost mx-auto flex">
          {t('social.more')}
        </button>
      )}
    </section>
  )
}

function CommentForm({ id, durationS, position, onPosted }) {
  const { t } = useTranslation()
  const [body, setBody] = useState('')
  const [at, setAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const tooLong = length(body) > LIMITS.comment

  function here() {
    const seconds = position?.()
    if (Number.isFinite(seconds)) setAt(formatAt(seconds * 1000))
  }

  async function submit(event) {
    event.preventDefault()
    const atMs = parseAt(at)
    if (Number.isNaN(atMs) || (atMs !== null && durationS > 0 && atMs > Math.ceil(durationS * 1000))) {
      return setError(t('social.comments.badTime'))
    }
    setBusy(true)
    setError(null)
    try {
      await postComment(id, body, atMs)
      setBody('')
      setAt('')
      onPosted()
    } catch (failure) {
      setError(t(`social.errors.${failure.code}`, { defaultValue: t('social.failed') }))
    } finally {
      setBusy(false)
    }
    return undefined
  }

  return (
    <form onSubmit={submit} className="panel space-y-3 p-4">
      <label className="block space-y-1.5">
        <span className="sr-only">{t('social.comments.body')}</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={3}
          className="field resize-y"
          placeholder={t('social.comments.placeholder')}
        />
        <Counter value={body} max={LIMITS.comment} />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="label">{t('social.comments.at')}</span>
          <input
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className="field readout w-28 py-2"
            placeholder="1:23"
            inputMode="numeric"
            maxLength={10}
          />
        </label>
        {position && (
          <button type="button" className="btn-ghost h-[42px]" onClick={here}>
            {t('social.comments.here')}
          </button>
        )}
        <button type="submit" disabled={busy || tooLong || !body.trim()} className="btn-primary ml-auto h-[42px]">
          {t('social.comments.post')}
        </button>
      </div>
      <p className="text-caption text-dim">{t('social.comments.atHint')}</p>
      {error && (
        <p role="alert" className="text-label text-red">
          {error}
        </p>
      )}
    </form>
  )
}

function CommentCard({ timingId, comment: c, staff, onSeek, onChanged }) {
  const { t, i18n } = useTranslation()
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)

  async function remove() {
    try {
      await deleteComment(timingId, c.id)
      onChanged()
    } catch {
      setError(t('social.failed'))
    }
  }

  return (
    <li id={`comment-${c.id}`} className={`panel space-y-2 p-4 ${c.hidden ? 'border-dashed opacity-80' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Avatar account={c.author} size={24} />
        <span className="text-label font-semibold">{c.author ? `@${c.author.username}` : t('social.uses.goneAccount')}</span>
        <time dateTime={c.createdAt} className="text-caption text-dim">
          {new Date(c.createdAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
        {c.atMs !== null && (
          <button
            type="button"
            onClick={() => onSeek?.(c.atMs)}
            className="chip-accent readout normal-case hover:bg-accent/20"
            title={t('social.comments.seek')}
            aria-label={t('social.comments.seekTo', { at: formatAt(c.atMs) })}
          >
            ▶ {formatAt(c.atMs)}
          </button>
        )}
        {c.hidden && <span className="chip-amber">{t('community.moderation.hiddenChip')}</span>}
      </div>
      <p className="whitespace-pre-wrap break-words text-body text-text">{c.body}</p>
      {staff && <StaffNote item={c} />}
      <div className="flex flex-wrap items-center gap-3">
        {c.mine ? (
          confirming ? (
            <span className="inline-flex items-center gap-2 text-caption">
              {t('social.comments.deleteConfirm')}
              <button type="button" onClick={remove} className="text-red underline-offset-2 hover:underline">
                {t('social.comments.deleteYes')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="text-dim hover:text-text">
                {t('social.cancel')}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="text-caption text-dim underline-offset-2 hover:text-text hover:underline">
              {t('social.comments.delete')}
            </button>
          )
        ) : (
          !c.hidden && <ReportButton kind="comments" id={c.id} />
        )}
        {staff && <HideButton kind="comments" item={c} onDone={onChanged} />}
        {error && <span role="alert" className="text-caption text-red">{error}</span>}
      </div>
    </li>
  )
}
