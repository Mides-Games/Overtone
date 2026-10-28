import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { useAuth } from '../../context/AuthContext.jsx'
import { getSuggestion, LIMITS, length, listSuggestions, postSuggestion, setState, STATE_TONE, STATES, vote } from '../../lib/community.js'
import Avatar from '../Avatar.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'
import { SkeletonRows } from '../ui/Skeleton.jsx'
import { HideButton, ReportButton, StaffNote } from './Moderation.jsx'

/**
 * Suggestions (W5.2): anyone reads them, a Mides account posts and votes
 * (one vote each), staff move them through their states with a reason that
 * everyone can read on the suggestion.
 *
 * Drawn as rows on the page's ground, a hairline apart (docs/design.md,
 * section 11): only the form to post one is a panel, since it is operated.
 */
export default function Suggestions({ onModerated }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const [sort, setSort] = useState('votes')
  const [state, setStateFilter] = useState('')
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)
  // Bumped to read the list again after a post, a state change or a hide.
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => {
    setTick((n) => n + 1)
    onModerated?.()
  }, [onModerated])

  useEffect(() => {
    let alive = true
    setFailed(false)
    listSuggestions({ sort, state })
      .then((data) => alive && setPage(data))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [sort, state, tick, account?.id])

  async function more() {
    const next = await listSuggestions({ sort, state, offset: page.items.length })
    setPage((current) => ({ ...next, items: [...current.items, ...next.items.filter((s) => !current.items.some((c) => c.id === s.id))] }))
  }

  return (
    <div className="space-y-6">
      {account ? (
        <NewSuggestion onPosted={refresh} />
      ) : (
        account === null && (
          <div className="flex flex-col gap-3 border-y border-line py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body text-muted">{t('community.suggestions.signInToPost')}</p>
            <Link to="/login" state={{ from: '/community' }} className="btn-ghost btn-sm shrink-0 self-start sm:self-auto">
              <Icon name="user" size={16} />
              {t('nav.signIn')}
            </Link>
          </div>
        )
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div role="group" aria-label={t('community.suggestions.sortBy')} className="flex flex-wrap items-center gap-1.5">
          <span aria-hidden="true" className="label mr-1">
            {t('community.suggestions.sortBy')}
          </span>
          {['votes', 'new'].map((key) => (
            <button key={key} type="button" aria-pressed={sort === key} onClick={() => setSort(key)} className="tool-btn px-3 font-sans">
              {t(`community.suggestions.sort.${key}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2">
          <span className="label">{t('community.suggestions.filter')}</span>
          <select value={state} onChange={(e) => setStateFilter(e.target.value)} className="field h-9 w-auto py-0 text-label">
            <option value="">{t('community.suggestions.allStates')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(`community.states.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed && (
        <p role="alert" className="text-label text-red">
          {t('community.errors.load')}
        </p>
      )}
      {!page ? (
        !failed && <SkeletonRows rows={4} label={t('community.loading')} className="border-y border-line" />
      ) : page.items.length === 0 ? (
        <EmptyState title={t('community.suggestions.empty')} className="border-y border-line" />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {page.items.map((s) => (
            <SuggestionRow key={s.id} suggestion={s} staff={Boolean(page.staff)} signedIn={Boolean(account)} onChanged={refresh} />
          ))}
        </ul>
      )}
      {page && page.items.length < page.total && (
        <button type="button" onClick={more} className="btn-ghost mx-auto flex">
          {t('community.more', { count: page.total - page.items.length })}
        </button>
      )}
    </div>
  )
}

function NewSuggestion({ onPosted }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        <Icon name="plus" size={18} />
        {t('community.suggestions.new')}
      </button>
    )
  }

  const tooLong = length(title) > LIMITS.title || length(body) > LIMITS.suggestion

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await postSuggestion(title, body)
      setTitle('')
      setBody('')
      setOpen(false)
      onPosted?.()
    } catch (failure) {
      setError(t(`community.errors.${failure.code}`, { defaultValue: t('community.errors.failed') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel pop-in max-w-3xl space-y-4 p-5 sm:p-6" style={{ '--origin': 'top left' }}>
      <label className="block space-y-1.5">
        <span className="label">{t('community.suggestions.title')}</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={LIMITS.titleMin}
          aria-invalid={length(title) > LIMITS.title || undefined}
          className="field"
          autoComplete="off"
          enterKeyHint="next"
          // The form was opened to type in it.
          autoFocus
        />
        <Counter value={title} max={LIMITS.title} />
      </label>
      <label className="block space-y-1.5">
        <span className="label">{t('community.suggestions.body')}</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={5}
          aria-invalid={length(body) > LIMITS.suggestion || undefined}
          className="field h-auto resize-y py-2.5"
        />
        <Counter value={body} max={LIMITS.suggestion} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || tooLong} className="btn-primary">
          {t('community.suggestions.post')}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost">
          {t('community.cancel')}
        </button>
        {error && (
          <span role="alert" className="text-label text-red">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}

export function Counter({ value, max }) {
  const n = length(value)
  return <span className={`readout block text-right text-caption ${n > max ? 'text-red' : 'text-dim'}`}>{`${n} / ${max}`}</span>
}

export function StateChip({ state }) {
  const { t } = useTranslation()
  return <span className={STATE_TONE[state] ?? 'chip-neutral'}>{t(`community.states.${state}`)}</span>
}

function SuggestionRow({ suggestion: s, staff, signedIn, onChanged }) {
  const { t, i18n } = useTranslation()
  const [votes, setVotes] = useState({ count: s.votes, voted: s.voted })
  // A notification's link (W13.17) lands on the suggestion with its history open.
  const linked = typeof window !== 'undefined' && window.location.hash === `#suggestion-${s.id}`
  const [open, setOpen] = useState(linked)
  const [voteError, setVoteError] = useState(null)

  useEffect(() => {
    if (linked) document.getElementById(`suggestion-${s.id}`)?.scrollIntoView({ block: 'center' })
  }, [linked, s.id])

  useEffect(() => setVotes({ count: s.votes, voted: s.voted }), [s.votes, s.voted])

  async function toggleVote() {
    setVoteError(null)
    try {
      const next = await vote(s.id, !votes.voted)
      setVotes({ count: next.votes, voted: next.voted })
    } catch {
      setVoteError(t('community.errors.failed'))
    }
  }

  const date = new Date(s.createdAt).toLocaleDateString(i18n.language, { dateStyle: 'medium' })

  return (
    <li id={`suggestion-${s.id}`} className={`flex scroll-mt-24 gap-4 py-5 ${s.hidden ? 'opacity-70' : ''}`}>
      <button
        type="button"
        onClick={toggleVote}
        disabled={!signedIn}
        aria-pressed={votes.voted}
        aria-label={t('community.suggestions.voteLabel', { count: votes.count })}
        title={signedIn ? undefined : t('community.suggestions.signInToVote')}
        className="tool-btn h-auto min-w-12 shrink-0 flex-col gap-0.5 self-start px-2 py-1.5"
      >
        <Icon name="chevron-up" size={16} strokeWidth={2} />
        <span className="readout text-label">{votes.count}</span>
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="heading-title min-w-0 break-words">{s.title}</h3>
          <StateChip state={s.state} />
          {s.mine && <span className="chip-neutral">{t('community.yours')}</span>}
          {s.hidden && (
            <span className="chip-neutral">
              <Icon name="eye-off" size={12} />
              {t('community.moderation.hiddenChip')}
            </span>
          )}
        </div>
        <p className={`max-w-[72ch] whitespace-pre-line break-words text-body text-muted ${open ? '' : 'line-clamp-3'}`}>{s.body}</p>
        {s.stateReason && (
          <p className="max-w-[72ch] break-words border-l-2 border-line-strong pl-3 text-label text-muted">
            <span className="font-semibold text-text">{t('community.suggestions.staffSaid')}</span> {s.stateReason}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-dim">
          <span className="inline-flex items-center gap-2">
            {s.author ? <Avatar account={s.author} size={20} decorative /> : null}
            {s.author ? `@${s.author.username}` : t('community.deletedAccount')}
          </span>
          <time dateTime={s.createdAt} className="readout">
            {date}
          </time>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-control font-medium text-accent hover:underline"
          >
            <Icon name="history" size={14} />
            {open ? t('community.suggestions.less') : t('community.suggestions.details')}
          </button>
          {!s.mine && <ReportButton kind="suggestions" id={s.id} />}
          {voteError && (
            <span role="alert" className="text-red">
              {voteError}
            </span>
          )}
        </div>
        {staff && <StaffNote item={s} />}
        {open && <History id={s.id} />}
        {staff && <StaffControls suggestion={s} onDone={onChanged} />}
      </div>
    </li>
  )
}

/** Every state change of one suggestion, newest first: who, when, from, to, why. */
function History({ id }) {
  const { t, i18n } = useTranslation()
  const [history, setHistory] = useState(null)

  useEffect(() => {
    let alive = true
    getSuggestion(id)
      .then((data) => alive && setHistory(data.history))
      .catch(() => alive && setHistory([]))
    return () => {
      alive = false
    }
  }, [id])

  if (!history) return <p className="text-caption text-dim">{t('community.loading')}</p>
  if (!history.length) return <p className="text-caption text-dim">{t('community.suggestions.noHistory')}</p>
  return (
    <ol className="fade-in space-y-1.5 border-l border-line pl-3">
      {history.map((e, i) => (
        <li key={`${e.at}-${i}`} className="text-caption">
          <time dateTime={e.at} className="readout text-dim">
            {new Date(e.at).toLocaleString(i18n.language)}
          </time>{' '}
          {e.action === 'state'
            ? t('community.moderation.did.state', { moderator: e.moderator, from: t(`community.states.${e.from}`), to: t(`community.states.${e.to}`) })
            : t(`community.moderation.did.${e.action}`, { moderator: e.moderator, kind: t('community.moderation.kind.suggestion') })}
          {e.reason && <span className="break-words text-muted"> — “{e.reason}”</span>}
        </li>
      ))}
    </ol>
  )
}

/** Staff: move the suggestion to another state (a rejection asks for its reason) and hide or unhide it. */
function StaffControls({ suggestion: s, onDone }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function change(to) {
    if (!to || to === s.state) return
    const reason = window.prompt(t(to === 'rejected' ? 'community.moderation.rejectPrompt' : 'community.moderation.statePrompt'))
    if (reason === null) return
    if (to === 'rejected' && !reason.trim()) {
      setError(t('community.errors.REASON_REQUIRED'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await setState(s.id, to, reason.trim())
      onDone?.()
    } catch (failure) {
      setError(t(`community.errors.${failure.code}`, { defaultValue: t('community.errors.failed') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-3">
      <span className="label text-amber">{t('moderation.staff')}</span>
      <label className="flex items-center gap-1.5">
        <span className="sr-only">{t('community.moderation.moveTo')}</span>
        <select value="" disabled={busy} onChange={(e) => change(e.target.value)} className="field h-8 w-auto py-0 text-label">
          <option value="">{t('community.moderation.moveTo')}</option>
          {STATES.filter((x) => x !== s.state).map((x) => (
            <option key={x} value={x}>
              {t(`community.states.${x}`)}
            </option>
          ))}
        </select>
      </label>
      <HideButton kind="suggestions" item={s} onDone={onDone} />
      {error && (
        <span role="alert" className="text-caption text-red">
          {error}
        </span>
      )}
    </div>
  )
}
