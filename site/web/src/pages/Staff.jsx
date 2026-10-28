import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
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
 *
 * Laid out as docs/design.md asks: the counts that wait are readouts a
 * hairline apart, each part a section with its header, its lists as rows.
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

  if (account === undefined) return <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />
  if (!staff) return <NotFound />

  return (
    <div className="space-y-14">
      <PageHeader
        eyebrow={t('moderation.staff')}
        title={t('staff.title')}
        lede={t('staff.subtitle')}
        action={
          <button type="button" className="btn-ghost" onClick={refresh}>
            <Icon name="history" size={16} />
            {t('staff.refresh')}
          </button>
        }
      />

      {failed && (
        <p role="alert" className="text-caption text-red">
          {t('staff.failed')}
        </p>
      )}
      {!data && !failed && <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />}
      {data && (
        <>
          <Awaiting awaiting={data.awaiting} />
          <div className="grid gap-x-12 gap-y-14 lg:grid-cols-2">
            <QueueAndWorker queue={data.queue} worker={data.worker} />
            <Failures failures={data.failures} />
          </div>
          <Corrections onChanged={refresh} tick={tick} />
          <div className="grid gap-x-12 gap-y-14 lg:grid-cols-2">
            <Reports reports={data.reports} />
            <Log log={data.log} />
          </div>
          <p className="readout text-caption text-dim">{t('staff.readAt', { time: new Date(data.at).toLocaleTimeString() })}</p>
        </>
      )}
    </div>
  )
}

/** One part of the panel: a section header, then its rows. */
function Section({ id, title, children, action = null }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="min-w-0 scroll-mt-24 space-y-5">
      <SectionHeader id={`${id}-title`} title={title} action={action} />
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
    <section aria-label={t('staff.awaiting.title')}>
      <ul className="grid border-y border-line sm:grid-cols-3">
        {tiles.map((tile, i) => (
          <li key={tile.key} className={i ? 'border-t border-line sm:border-l sm:border-t-0' : ''}>
            <a href={tile.to} className="group flex items-end justify-between gap-4 px-1 py-5 transition-colors duration-150 ease-out hover:bg-surface-2 sm:px-5">
              <span className="space-y-1.5">
                <span className={`readout block text-headline font-semibold leading-none ${tile.value ? 'text-accent' : 'text-text'}`}>{tile.value}</span>
                <span className="block text-label text-muted">{t(`staff.awaiting.${tile.key}`)}</span>
              </span>
              <Icon name="arrow-right" size={18} className="mb-1 text-dim transition-transform duration-150 ease-out group-hover:translate-x-1 group-hover:text-accent" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

const mb = (v) => (v === null || v === undefined ? '–' : `${v} MB`)

function QueueAndWorker({ queue, worker }) {
  const { t } = useTranslation()
  return (
    <Section
      id="staff-queue"
      title={t('staff.queue.title')}
      action={
        <Link to="/queue" className="btn-quiet btn-sm -ml-2.5 h-auto min-h-8 whitespace-normal py-1 text-left sm:-mr-2.5 sm:ml-0">
          {t('staff.queue.moderate')}
          <Icon name="arrow-right" size={15} />
        </Link>
      }
    >
      <dl className="grid grid-cols-3 border-y border-line">
        <Stat k={t('staff.queue.running')} v={queue.running} />
        <Stat k={t('staff.queue.waiting')} v={queue.waiting} divided />
        <Stat k={t('staff.queue.oldest')} v={queue.oldestWaitS === null ? '–' : formatAt(queue.oldestWaitS * 1000)} divided />
      </dl>
      <div className="space-y-1 text-caption">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-dim">{t('status.worker')}:</span>
          <span className={worker.status === 'ok' ? 'chip-accent' : 'chip-neutral'}>{t(`status.states.${worker.status}`)}</span>
          {worker.seenSecondsAgo !== null && <span className="text-dim">{t('status.notes.workerSeen', { seconds: worker.seenSecondsAgo })}</span>}
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
        <EmptyState title={t('queue.empty')} className="border-y border-line py-6" />
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto border-y border-line">
          {queue.live.map((row) => (
            <li key={row.ref} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 text-label">
              <span className="min-w-0 truncate text-text">
                {row.song ?? <span className="text-dim">{t('queue.privateSong')}</span>}
                {row.uploader && <span className="text-dim"> · @{row.uploader.username}</span>}
              </span>
              <span className="readout shrink-0 text-caption text-dim">
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

function Stat({ k, v, divided = false }) {
  return (
    <div className={`space-y-1 py-3 ${divided ? 'border-l border-line pl-4' : 'pr-4'}`}>
      <dt className="label">{k}</dt>
      <dd className="readout text-title font-semibold text-text">{v}</dd>
    </div>
  )
}

function Failures({ failures }) {
  const { t, i18n } = useTranslation()
  return (
    <Section id="staff-failures" title={t('staff.failures.title')}>
      {failures.length === 0 ? (
        <EmptyState title={t('staff.failures.none')} className="border-y border-line py-6" />
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto border-y border-line">
          {failures.map((f) => (
            <li key={f.ref} className="space-y-1 py-2.5 text-caption">
              <p className="flex flex-wrap items-center gap-2">
                <span className="chip-neutral">{f.code}</span>
                <span className="readout text-dim">{f.ref.slice(0, 8)}</span>
                <span className="text-dim">
                  {f.mode}
                  {f.audioSeconds ? ` · ${formatAt(f.audioSeconds * 1000)}` : ''}
                </span>
                <time dateTime={f.at} className="readout ml-auto text-dim">
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
    <Section
      id="staff-corrections"
      title={t('staff.corrections.title')}
      action={
        <div role="group" aria-label={t('staff.corrections.title')} className="flex flex-wrap gap-1.5">
          {STATES.map((key) => (
            <button key={key} type="button" aria-pressed={state === key} onClick={() => setState(key)} className="tool-btn px-3 font-sans">
              {t(`votes.review.${key}`)}
            </button>
          ))}
        </div>
      }
    >
      <p className="max-w-[72ch] text-label text-muted">{t('staff.corrections.hint')}</p>
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
      {!page && !error && <SkeletonRows rows={2} label={t('common.loading')} className="border-y border-line" />}
      {page && page.items.length === 0 && <EmptyState title={t('staff.corrections.none')} className="border-y border-line py-6" />}
      {page && page.items.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {page.items.map((c) => (
            <li key={c.id} className="space-y-2 py-3.5 text-label">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Link to={`/t/${c.timing.id}`} className="font-semibold text-text hover:text-accent hover:underline">
                  {c.timing.title ?? t('timings.untitled')}
                </Link>
                {c.timing.artist && <span className="text-muted">{c.timing.artist}</span>}
                <span className="text-dim">· {c.voter ? `@${c.voter.username}` : t('social.uses.goneAccount')}</span>
                <time dateTime={c.at} className="readout ml-auto text-caption text-dim">
                  {new Date(c.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </p>
              <p className="readout text-caption text-muted">
                {t('staff.corrections.change', {
                  bpm: c.timing.bpm ?? '–',
                  offset: c.timing.offsetMs ?? '–',
                  newBpm: c.proposedBpm ?? '–',
                  newOffset: c.proposedOffsetMs ?? '–',
                })}
              </p>
              <p className="flex flex-wrap items-center gap-2">
                <span className={c.trainingOk ? 'chip-accent' : 'chip-neutral'}>
                  {c.trainingOk ? t('staff.corrections.trainingOk') : t('staff.corrections.trainingNo')}
                </span>
                {c.reviewedBy && <span className="text-caption text-dim">{t('staff.corrections.by', { moderator: c.reviewedBy })}</span>}
                {c.state !== 'accepted' && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => act(c, 'accept')}>
                    <Icon name="check" size={14} />
                    {t('staff.corrections.accept')}
                  </button>
                )}
                {c.state !== 'dismissed' && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => act(c, 'dismiss')}>
                    <Icon name="close" size={14} />
                    {t('staff.corrections.dismiss')}
                  </button>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Reports({ reports }) {
  const { t } = useTranslation()
  return (
    <Section id="staff-reports" title={t('community.moderation.openReports')}>
      {reports.length === 0 ? (
        <EmptyState title={t('community.moderation.noReports')} className="border-y border-line py-6" />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {reports.map((r) => (
            <li key={`${r.kind}-${r.ref}`} className="space-y-1 py-2.5 text-label">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-text">{t(`community.moderation.kind.${r.kind}`)}</span>
                <span className="readout text-caption text-dim">{r.ref.slice(0, 8)}</span>
                <span className="chip-neutral">{t('community.moderation.reports', { count: r.count })}</span>
                {r.timing ? (
                  <Link to={`/t/${r.timing}#comment-${r.ref}`} className="link text-caption">
                    {t('social.comments.openTiming')}
                  </Link>
                ) : (
                  <Link to={r.kind === 'review' ? '/community?tab=reviews' : `/community#suggestion-${r.ref}`} className="link text-caption">
                    {t('staff.open')}
                  </Link>
                )}
              </p>
              <p className="break-words text-caption text-muted">{r.reasons.map((reason) => `“${reason}”`).join(' ')}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
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
    <Section id="staff-log" title={t('community.moderation.logTitle')}>
      {log.length === 0 ? (
        <EmptyState title={t('community.moderation.logEmpty')} className="border-y border-line py-6" />
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto border-y border-line">
          {log.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-label">
              <time dateTime={e.at} className="readout text-caption text-dim">
                {new Date(e.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}
              </time>
              <span className="text-text">{line(e)}</span>
              {e.ref && <span className="readout text-caption text-dim">{e.ref.slice(0, 8)}</span>}
              {e.reason && <span className="w-full break-words text-muted">“{e.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
