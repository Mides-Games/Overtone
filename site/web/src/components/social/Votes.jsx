import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import SignInLink from '../SignInLink.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { userPath } from '../../lib/social.js'
import { castVote, offVote, removeVote, timingVotes } from '../../lib/votes.js'

/**
 * "Is it on time?" (W13.14) under a published timing: two answers, the
 * counts, and for "off" a proposed BPM and/or offset that goes to staff,
 * with the voter's own permission (a box, unticked) for the correction to
 * be used by the engine's stages. One vote per account, editable; never on
 * your own timing. Who voted is not shown, except a mapper's "on time",
 * which is the verified badge (W13.16): the form says so before anyone votes.
 */
export default function Votes({ id, durationS, votes, onChange }) {
  const { t } = useTranslation()
  const { account } = useAuth()
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(null)
  const mine = votes.mine

  async function send(body) {
    setBusy(true)
    setError(null)
    try {
      const next = await castVote(id, body)
      onChange(next)
      setForm(null)
      setSent(next.queued ? 'queued' : 'saved')
    } catch (failure) {
      setError(failure.code === 'BAD_VOTE' ? t('votes.errors.bad') : t('social.failed'))
    } finally {
      setBusy(false)
    }
  }

  async function takeBack() {
    setBusy(true)
    setError(null)
    try {
      onChange(await removeVote(id))
      setSent(null)
    } catch {
      setError(t('social.failed'))
    } finally {
      setBusy(false)
    }
  }

  function submitOff(event) {
    event.preventDefault()
    const { body, error: wrong } = offVote(form, durationS)
    if (wrong) return setError(t(`votes.errors.${wrong}`))
    return send(body)
  }

  return (
    <section className="panel space-y-3 p-4" aria-labelledby="votes-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="votes-title" className="label">
          {t('votes.title')}
        </h2>
        <p className="readout text-caption text-dim">
          <span className="text-accent">{t('votes.onCount', { count: votes.on })}</span> ·{' '}
          <span className="text-amber">{t('votes.offCount', { count: votes.off })}</span>
        </p>
      </div>

      {votes.verified && <VerifiedBadge votes={votes} />}

      {votes.own ? (
        <p className="text-caption text-dim">{t('votes.own')}</p>
      ) : !account ? (
        account === null && (
          <p className="text-caption text-dim">
            <SignInLink className="text-accent hover:underline">
              {t('votes.signIn')}
            </SignInLink>
          </p>
        )
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('votes.title')}>
            <button
              type="button"
              className={mine?.verdict === 'on' ? 'btn-primary' : 'btn-ghost'}
              aria-pressed={mine?.verdict === 'on'}
              disabled={busy}
              onClick={() => (mine?.verdict === 'on' ? takeBack() : send({ verdict: 'on' }))}
            >
              ✓ {t('votes.on')}
            </button>
            <button
              type="button"
              className={mine?.verdict === 'off' ? 'btn-primary' : 'btn-ghost'}
              aria-pressed={mine?.verdict === 'off'}
              aria-expanded={Boolean(form)}
              disabled={busy}
              onClick={() =>
                setForm((open) =>
                  open ? null : { bpm: mine?.proposedBpm ?? '', offset: mine?.proposedOffsetMs ?? '', trainingOk: Boolean(mine?.trainingOk) },
                )
              }
            >
              ≠ {t('votes.off')}
            </button>
            {mine && (
              <button type="button" className="text-caption text-dim underline-offset-2 hover:text-text hover:underline" onClick={takeBack} disabled={busy}>
                {t('votes.takeBack')}
              </button>
            )}
          </div>

          {mine?.verdict === 'off' && !form && (mine.proposedBpm !== null || mine.proposedOffsetMs !== null) && (
            <p className="text-caption text-muted">
              {t('votes.yourCorrection', {
                bpm: mine.proposedBpm ?? '–',
                offset: mine.proposedOffsetMs ?? '–',
              })}{' '}
              <span className="chip">{t(`votes.review.${mine.reviewState ?? 'pending'}`)}</span>
            </p>
          )}

          {form && (
            <form onSubmit={submitOff} className="space-y-3 rounded-panel border border-line p-3">
              <p className="text-caption text-dim">{t('votes.offHint')}</p>
              <div className="flex flex-wrap gap-3">
                <label className="block space-y-1">
                  <span className="label">{t('votes.bpm')}</span>
                  <input
                    className="field readout w-32 py-2"
                    inputMode="decimal"
                    maxLength={10}
                    value={form.bpm}
                    onChange={(e) => setForm({ ...form, bpm: e.target.value })}
                    placeholder="128.000"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="label">{t('votes.offset')}</span>
                  <input
                    className="field readout w-32 py-2"
                    inputMode="numeric"
                    maxLength={9}
                    value={form.offset}
                    onChange={(e) => setForm({ ...form, offset: e.target.value })}
                    placeholder="1234"
                  />
                </label>
              </div>
              <label className="flex items-start gap-2 text-caption text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={form.trainingOk}
                  onChange={(e) => setForm({ ...form, trainingOk: e.target.checked })}
                />
                <span>{t('votes.trainingOk')}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {t('votes.sendOff')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setForm(null)}>
                  {t('social.cancel')}
                </button>
              </div>
            </form>
          )}

          <p className="text-caption text-dim">{t('votes.privacy')}</p>
          {sent && (
            <p role="status" className="text-caption text-accent">
              {t(sent === 'queued' ? 'votes.queued' : 'votes.saved')}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
    </section>
  )
}

/** "Verified by a mapper" (W13.16): the first mappers who confirmed it, named, and how many more. */
export function VerifiedBadge({ votes, compact = false }) {
  const { t } = useTranslation()
  if (!votes?.verified) return null
  const [first] = votes.verifiers
  const more = Math.max(0, votes.verifierCount - 1)
  const name = first ? (
    first.profile ? (
      <Link to={userPath(first.username)} className="text-accent hover:underline">
        @{first.username}
      </Link>
    ) : (
      <span>@{first.username}</span>
    )
  ) : null
  return (
    <p className={`inline-flex flex-wrap items-center gap-1.5 ${compact ? 'text-caption' : 'text-label'}`}>
      <span className="chip-accent" title={t('votes.verifiedHint')}>
        ✓ {t('votes.verified')}
      </span>
      {name && (
        <span className="text-muted">
          {t('votes.verifiedBy')} {name}
          {first.osuUsername && <span className="text-dim"> · {t('votes.ranked', { name: first.osuUsername, count: first.rankedCount })}</span>}
          {more > 0 && <span className="text-dim"> · {t('votes.andMore', { count: more })}</span>}
        </span>
      )}
    </p>
  )
}

/** Loads a timing's votes; `update(next)` replaces them with what a button returned. */
export function useTimingVotes(id) {
  const { account } = useAuth()
  const [votes, setVotes] = useState(null)
  useEffect(() => {
    let alive = true
    setVotes(null)
    timingVotes(id)
      .then((data) => alive && setVotes(data))
      .catch(() => alive && setVotes(false))
    return () => {
      alive = false
    }
  }, [id, account?.id])
  return [votes, setVotes]
}
