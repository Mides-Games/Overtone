import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { formatAt } from '../lib/social.js'
import { corrections, reviewCorrection, staffOverview } from '../lib/votes.js'
import NotFound from './NotFound.jsx'

/**
 * The staff panel (W13.19), for Mides moderators: what waits for them and
 * how the machine is doing, on one page. Everyone else gets the 404 page,
 * as the API gives them a 404 (the page's existence is not their business).
 *
 * It reads `/staff/overview` when opened, again every 30 s while the tab is
 * seen, and on "Refresh". Acting stays where it was: removing or requeueing
 * a job on `/queue`, hiding on the item's own page; the corrections from
 * votes (W13.14) are accepted or dismissed here, their only place.
 */
const REFRESH_MS = 30_000
const STATES = ['pending', 'accepted', 'dismissed']

export default function Staff() {
  const { t } = useTranslation()
  const { account } = useAuth()
  const staff = account?.role === 'moderator'
  usePageMeta(staff ? t('staff.title') : t('notFound.title'))
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!staff) return undefined
    let alive = true
    setFailed(false)
    staffOverview()
      .then((next) => alive && setData(next))
      .catch(() => alive && setFailed(true))
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1)
    }, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [staff, tick])

  if (account === undefined) return <BrandLoader className="py-16" />
  if (!staff) return <NotFound />

  return (
    <div className="space-y-8">
      <header className="rise flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <p className="label text-amber">{t('moderation.staff')}</p>
          <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('staff.title')}</h1>
          <p className="max-w-[60ch] text-muted">{t('staff.subtitle')}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={refresh}>
          {t('staff.refresh')}
        </button>
      </header>

      {failed && <p className="text-caption text-red">{t('staff.failed')}</p>}
      {!data && !failed && <BrandLoader className="py-10" />}
      {data && (
        <>
          <Awaiting awaiting={data.awaiting} />
          <div className="grid gap-6 lg:grid-cols-2">
            <QueueAndWorker queue={data.queue} worker={data.worker} />
            <Failures failures={data.failures} />
          </div>
          <Corrections onChanged={refresh} tick={tick} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Reports reports={data.reports} />
            <Log log={data.log} />
          </div>
          <p className="text-caption text-dim">{t('staff.readAt', { time: new Date(data.at).toLocaleTimeString() })}</p>
        </>
      )}
    </div>
  )
}

function Section({ title, children, action = null }) {
  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="label">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Awaiting({ awaiting }) {
  const { t } = useTranslation()
  const tiles = [
    { key: 'suggestions', to: '/community', value: awaiting.suggestions },
    { key: 'reports', to: '#staff-reports', value: awaiting.reports },
    { key: 'corrections', to: '#staff-corrections', value: awaiting.corrections },
  ]
  return (
    <section aria-label={t('staff.awaiting.title')} className="grid gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <a key={tile.key} href={tile.to} className="panel block space-y-1 p-4 transition hover:border-line-hover">
          <p className={`readout text-[28px] font-semibold leading-none ${tile.value ? 'text-amber' : 'text-text'}`}>{tile.value}</p>
          <p className="text-caption text-muted">{t(`staff.awaiting.${tile.key}`)}</p>
        </a>
      ))}
    </section>
  )
}

const mb = (v) => (v === null || v === undefined ? '–' : `${v} MB`)

function QueueAndWorker({ queue, worker }) {
  const { t } = useTranslation()
  return (
    <Section
      title={t('staff.queue.title')}
      action={
        <Link to="/queue" className="text-caption text-accent hover:underline">
          {t('staff.queue.moderate')}
        </Link>
      }
    >
      <dl className="grid grid-cols-3 gap-2 text-caption">
        <Stat k={t('staff.queue.running')} v={queue.running} />
        <Stat k={t('staff.queue.waiting')} v={queue.waiting} />
        <Stat k={t('staff.queue.oldest')} v={queue.oldestWaitS === null ? '–' : formatAt(queue.oldestWaitS * 1000)} />
      </dl>
      <div className="space-y-1 rounded-panel border border-line p-3 text-caption">
        <p>
          <span className="text-dim">{t('status.worker')}: </span>
          <span className={worker.status === 'ok' ? 'text-accent' : worker.status === 'down' ? 'text-red' : 'text-dim'}>
            {t(`status.states.${worker.status}`)}
          </span>
          {worker.seenSecondsAgo !== null && <span className="text-dim"> · {t('status.notes.workerSeen', { seconds: worker.seenSecondsAgo })}</span>}
        </p>
        {worker.memory ? (
          <p className="readout text-muted">
            {t('staff.worker.memory', { rss: mb(worker.memory.rssMb), peak: mb(worker.memory.peakMb), limit: mb(worker.memory.limitMb) })}
            <span className="text-dim"> · {t('staff.worker.memoryAgo', { seconds: worker.memory.secondsAgo })}</span>
          </p>
        ) : (
          <p className="text-dim">{t('staff.worker.noMemory')}</p>
        )}
      </div>
      {queue.live.length === 0 ? (
        <p className="text-caption text-dim">{t('queue.empty')}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-panel border border-line">
          {queue.live.map((row) => (
            <li key={row.ref} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-caption">
              <span className="min-w-0 truncate">
                {row.song ?? <span className="text-dim">{t('queue.privateSong')}</span>}
                {row.uploader && <span className="text-dim"> · @{row.uploader.username}</span>}
              </span>
              <span className="readout shrink-0 text-dim">
                {t(`queue.status.${row.status}`)}
                {row.status === 'running' && ` ${Math.round((row.progress ?? 0) * 100)}%`} · {row.mode} · {formatAt(row.elapsedS * 1000)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Stat({ k, v }) {
  return (
    <div className="rounded-control border border-line px-2.5 py-2">
      <dt className="text-dim">{k}</dt>
      <dd className="readout text-label text-text">{v}</dd>
    </div>
  )
}

function Failures({ failures }) {
  const { t, i18n } = useTranslation()
  return (
    <Section title={t('staff.failures.title')}>
      {failures.length === 0 ? (
        <p className="text-caption text-dim">{t('staff.failures.none')}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto rounded-panel border border-line">
          {failures.map((f) => (
            <li key={f.ref} className="space-y-0.5 px-3 py-2 text-caption">
              <p className="flex flex-wrap items-center gap-2">
                <span className={f.code === 'failed' ? 'chip' : 'chip-amber'}>{f.code}</span>
                <span className="readout text-dim">{f.ref.slice(0, 8)}</span>
                <span className="text-dim">
                  {f.mode}
                  {f.audioSeconds ? ` · ${formatAt(f.audioSeconds * 1000)}` : ''}
                </span>
                <time dateTime={f.at} className="ml-auto text-dim">
                  {new Date(f.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </p>
              {f.message && <p className="break-words text-muted">{f.message}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-dim">{t('staff.failures.codes')}</p>
    </Section>
  )
}

function Corrections({ onChanged, tick }) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState('pending')
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    corrections(state)
      .then((data) => alive && setPage(data))
      .catch(() => alive && setError(t('staff.failed')))
    return () => {
      alive = false
    }
  }, [state, tick, t])

  async function act(item, action) {
    const reason = window.prompt(t(`staff.corrections.${action}Prompt`))
    if (reason === null) return
    setError(null)
    try {
      await reviewCorrection(item.id, action, reason.trim() || null)
      onChanged()
    } catch {
      setError(t('staff.failed'))
    }
  }

  return (
    <section id="staff-corrections" className="panel scroll-mt-24 space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="label">{t('staff.corrections.title')}</h2>
        <div role="group" aria-label={t('staff.corrections.title')} className="flex flex-wrap gap-1">
          {STATES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={state === key}
              onClick={() => setState(key)}
              className={state === key ? 'chip-accent' : 'chip hover:text-text'}
            >
              {t(`votes.review.${key}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-caption text-dim">{t('staff.corrections.hint')}</p>
      {error && <p role="alert" className="text-caption text-red">{error}</p>}
      {page && page.items.length === 0 && <p className="text-caption text-dim">{t('staff.corrections.none')}</p>}
      {page && page.items.length > 0 && (
        <ul className="divide-y divide-line rounded-panel border border-line">
          {page.items.map((c) => (
            <li key={c.id} className="space-y-1.5 px-3 py-2.5 text-caption">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Link to={`/t/${c.timing.id}`} className="font-semibold text-accent hover:underline">
                  {c.timing.title ?? t('timings.untitled')}
                </Link>
                {c.timing.artist && <span className="text-muted">{c.timing.artist}</span>}
                <span className="text-dim">· {c.voter ? `@${c.voter.username}` : t('social.uses.goneAccount')}</span>
                <time dateTime={c.at} className="ml-auto text-dim">
                  {new Date(c.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </p>
              <p className="readout text-muted">
                {t('staff.corrections.change', {
                  bpm: c.timing.bpm ?? '–',
                  offset: c.timing.offsetMs ?? '–',
                  newBpm: c.proposedBpm ?? '–',
                  newOffset: c.proposedOffsetMs ?? '–',
                })}
              </p>
              <p className="flex flex-wrap items-center gap-2">
                {c.trainingOk ? (
                  <span className="chip-accent">{t('staff.corrections.trainingOk')}</span>
                ) : (
                  <span className="chip">{t('staff.corrections.trainingNo')}</span>
                )}
                {c.reviewedBy && <span className="text-dim">{t('staff.corrections.by', { moderator: c.reviewedBy })}</span>}
                {c.state !== 'accepted' && (
                  <button type="button" className="btn-ghost h-7 px-2.5 text-caption" onClick={() => act(c, 'accept')}>
                    {t('staff.corrections.accept')}
                  </button>
                )}
                {c.state !== 'dismissed' && (
                  <button type="button" className="btn-ghost h-7 px-2.5 text-caption" onClick={() => act(c, 'dismiss')}>
                    {t('staff.corrections.dismiss')}
                  </button>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Reports({ reports }) {
  const { t } = useTranslation()
  return (
    <section id="staff-reports" className="panel scroll-mt-24 space-y-3 p-4">
      <h2 className="label">{t('community.moderation.openReports')}</h2>
      {reports.length === 0 ? (
        <p className="text-caption text-dim">{t('community.moderation.noReports')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-panel border border-line">
          {reports.map((r) => (
            <li key={`${r.kind}-${r.ref}`} className="space-y-1 px-3 py-2 text-caption">
              <p>
                <span className="font-semibold">{t(`community.moderation.kind.${r.kind}`)}</span>{' '}
                <span className="readout text-dim">{r.ref.slice(0, 8)}</span> · {t('community.moderation.reports', { count: r.count })} ·{' '}
                {r.timing ? (
                  <Link to={`/t/${r.timing}#comment-${r.ref}`} className="text-accent hover:underline">
                    {t('social.comments.openTiming')}
                  </Link>
                ) : (
                  <Link to={r.kind === 'review' ? '/community?tab=reviews' : `/community#suggestion-${r.ref}`} className="text-accent hover:underline">
                    {t('staff.open')}
                  </Link>
                )}
              </p>
              <p className="break-words text-muted">{r.reasons.map((reason) => `“${reason}”`).join(' ')}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Log({ log }) {
  const { t, i18n } = useTranslation()
  const line = (e) => {
    if (e.kind === 'analysis') return t(`moderation.did.${e.action}`, { moderator: e.moderator })
    if (e.kind === 'vote') return t(`staff.did.${e.action}`, { moderator: e.moderator })
    if (e.action === 'state') {
      return t('community.moderation.did.state', {
        moderator: e.moderator,
        from: t(`community.states.${e.from}`),
        to: t(`community.states.${e.to}`),
      })
    }
    return t(`community.moderation.did.${e.action}`, { moderator: e.moderator, kind: t(`community.moderation.kind.${e.kind}`) })
  }
  return (
    <Section title={t('community.moderation.logTitle')}>
      {log.length === 0 ? (
        <p className="text-caption text-dim">{t('community.moderation.logEmpty')}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto rounded-panel border border-line">
          {log.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-caption">
              <time dateTime={e.at} className="readout text-dim">
                {new Date(e.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
              </time>
              <span>{line(e)}</span>
              {e.ref && <span className="readout text-dim">{e.ref.slice(0, 8)}</span>}
              {e.reason && <span className="break-words text-muted">“{e.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
