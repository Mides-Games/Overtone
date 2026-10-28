import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { useAuth } from '../../context/AuthContext.jsx'
import { getSuggestion, LIMITS, length, listSuggestions, postSuggestion, setState, STATE_TONE, STATES, vote } from '../../lib/community.js'
import Avatar from '../Avatar.jsx'
import BrandLoader from '../BrandLoader.jsx'
import { HideButton, ReportButton, StaffNote } from './Moderation.jsx'

/**
 * Suggestions (W5.2): anyone reads them, a Mides account posts and votes
 * (one vote each), staff move them through their states with a reason that
 * everyone can read on the suggestion.
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
          <p className="rounded-panel border border-dashed border-line-strong px-4 py-4 text-label text-muted">
            {t('community.suggestions.signInToPost')}{' '}
            <Link to="/login" state={{ from: '/community' }} className="text-accent hover:underline">
              {t('nav.signIn')}
            </Link>
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">{t('community.suggestions.sortBy')}</span>
        {['votes', 'new'].map((key) => (
          <button key={key} type="button" aria-pressed={sort === key} onClick={() => setSort(key)} className="tool-btn px-2.5 font-sans">
            {t(`community.suggestions.sort.${key}`)}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2">
          <span className="label">{t('community.suggestions.filter')}</span>
          <select value={state} onChange={(e) => setStateFilter(e.target.value)} className="field h-8 w-auto py-0 text-label">
            <option value="">{t('community.suggestions.allStates')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(`community.states.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {failed && <p className="text-label text-red">{t('community.errors.load')}</p>}
      {!page ? (
        !failed && <BrandLoader className="py-12" />
      ) : page.items.length === 0 ? (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('community.suggestions.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {page.items.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} staff={Boolean(page.staff)} signedIn={Boolean(account)} onChanged={refresh} />
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
    <form onSubmit={submit} className="panel space-y-3 p-4">
      <label className="block space-y-1.5">
        <span className="label">{t('community.suggestions.title')}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={LIMITS.titleMin} className="field" autoComplete="off" />
        <Counter value={title} max={LIMITS.title} />
      </label>
      <label className="block space-y-1.5">
        <span className="label">{t('community.suggestions.body')}</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={5} className="field resize-y" />
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
  return <span className={STATE_TONE[state] ?? 'chip'}>{t(`community.states.${state}`)}</span>
}

function SuggestionCard({ suggestion: s, staff, signedIn, onChanged }) {
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
    <li id={`suggestion-${s.id}`} className={`panel flex scroll-mt-24 gap-3 p-4 ${s.hidden ? 'opacity-70' : ''}`}>
      <button
        type="button"
        onClick={toggleVote}
        disabled={!signedIn}
        aria-pressed={votes.voted}
        aria-label={t('community.suggestions.voteLabel', { count: votes.count })}
        title={signedIn ? undefined : t('community.suggestions.signInToVote')}
        className="tool-btn h-auto min-w-12 shrink-0 flex-col self-start px-2 py-1.5"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 4 3 16h18z" />
        </svg>
        <span className="text-label">{votes.count}</span>
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 break-words text-body font-semibold">{s.title}</h3>
          <StateChip state={s.state} />
          {s.mine && <span className="chip border-line-strong text-dim">{t('community.yours')}</span>}
          {s.hidden && <span className="chip-amber">{t('community.moderation.hiddenChip')}</span>}
        </div>
        <p className={`whitespace-pre-line break-words text-label text-muted ${open ? '' : 'line-clamp-3'}`}>{s.body}</p>
        {s.stateReason && (
          <p className="break-words text-caption text-muted">
            <span className="text-dim">{t('community.suggestions.staffSaid')}</span> {s.stateReason}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-dim">
          <span className="inline-flex items-center gap-1.5">
            {s.author ? <Avatar account={s.author} size={18} /> : null}
            {s.author ? `@${s.author.username}` : t('community.deletedAccount')}
          </span>
          <span className="readout">{date}</span>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-accent hover:underline">
            {open ? t('community.suggestions.less') : t('community.suggestions.details')}
          </button>
          {!s.mine && <ReportButton kind="suggestions" id={s.id} />}
          {voteError && <span className="text-red">{voteError}</span>}
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
    <ol className="space-y-1.5 border-l border-line pl-3">
      {history.map((e, i) => (
        <li key={`${e.at}-${i}`} className="text-caption">
          <span className="readout text-dim">{new Date(e.at).toLocaleString(i18n.language)}</span>{' '}
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
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-2">
      <span className="label text-amber">{t('moderation.staff')}</span>
      <label className="flex items-center gap-1.5">
        <span className="sr-only">{t('community.moderation.moveTo')}</span>
        <select value="" disabled={busy} onChange={(e) => change(e.target.value)} className="field h-7 w-auto py-0 text-caption">
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
