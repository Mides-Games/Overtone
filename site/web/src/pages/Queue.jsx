import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import CancelButton from '../components/CancelButton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import Reveal from '../components/ui/Reveal.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { formatRange } from '../lib/analysis-options.js'
import { api } from '../lib/api.js'
import { timingPath } from '../lib/timings.js'

/**
 * The public queue (W3.8): every analysis waiting or running, and the ones
 * that finished in the last hour. Polled every few seconds; the rows carry
 * only what their uploaders let be shown (no song or uploader for a private
 * upload), and an id only on the reader's own rows, which open their result.
 * A finished anonymous upload that was not private opens its timing page.
 *
 * Staff (W3.18) also get a remove and a requeue button on the live rows, and
 * the moderation log under the queue: who did what, and why.
 */
const POLL_MS = 3000
const IDLE_POLL_MS = 10_000

export default function Queue() {
  const { t } = useTranslation()
  usePageMeta(t('queue.title'), t('queue.subtitle'))
  const [data, setData] = useState(null)
  const [offline, setOffline] = useState(false)
  // Bumped after a moderation, to read the queue and the log again at once.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let timer
    let stopped = false
    async function poll() {
      try {
        const next = await api('/analyses/queue')
        if (stopped) return
        setData(next)
        setOffline(false)
        timer = setTimeout(poll, next.live.length ? POLL_MS : IDLE_POLL_MS)
      } catch {
        if (stopped) return
        setOffline(true)
        timer = setTimeout(poll, IDLE_POLL_MS)
      }
    }
    // A hidden tab stops asking; coming back asks at once.
    const onVisible = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible') poll()
    }
    poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [tick])

  return (
    <div className="space-y-12">
      <header className="rise max-w-3xl space-y-4">
        <h1 className="heading-headline">{t('queue.title')}</h1>
        <p className="lede max-w-[60ch]">{t('queue.subtitle')}</p>
      </header>

      {offline && (
        <p role="status" className="text-label text-dim">
          {t('result.reconnecting')}
        </p>
      )}

      {!data ? (
        !offline && <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />
      ) : (
        <>
          <section className="space-y-5" aria-live="polite" aria-labelledby="queue-live">
            <SectionHeader
              id="queue-live"
              title={t('queue.live')}
              action={<span className="readout text-label text-dim">{t('queue.count', { count: data.live.length + data.more })}</span>}
            />
            {data.live.length ? (
              <Rows rows={data.live} onModerated={() => setTick((n) => n + 1)} />
            ) : (
              <EmptyState
                className="border-y border-line"
                title={t('queue.empty')}
                action={
                  <Link to="/analyze" className="btn-ghost">
                    {t('queue.upload')}
                    <Icon name="arrow-right" size={16} />
                  </Link>
                }
              />
            )}
            {data.more > 0 && <p className="text-caption text-dim">{t('queue.more', { count: data.more })}</p>}
          </section>

          {data.recent.length > 0 && (
            <section className="space-y-5 pt-4" aria-labelledby="queue-recent">
              <SectionHeader id="queue-recent" title={t('queue.recent')} />
              <Rows rows={data.recent} />
            </section>
          )}

          {data.staff && <ModerationLog tick={tick} />}

          <p className="max-w-[72ch] text-caption leading-relaxed text-dim">{t('modes.estimate.queueNote')}</p>
          <p className="max-w-[72ch] text-caption leading-relaxed text-dim">{t('queue.privacy')}</p>
        </>
      )}
    </div>
  )
}

function Rows({ rows, onModerated }) {
  return (
    <Reveal as="ul" className="divide-y divide-line border-y border-line">
      {rows.map((row, i) => (
        <Row key={row.id ?? row.ref ?? `${row.createdAt}-${i}`} row={row} onModerated={onModerated} index={i} />
      ))}
    </Reveal>
  )
}

function Row({ row, onModerated, index = 0 }) {
  const { t } = useTranslation()
  const [cancelled, setCancelled] = useState(false)
  if (cancelled) return null
  const body = (
    <div className={`flex items-center gap-3 px-2 py-3 sm:px-3 ${row.mine ? 'bg-accent/5' : ''}`}>
      {row.position ? <span className="readout w-8 shrink-0 text-center text-label text-dim">#{row.position}</span> : null}
      <Uploader row={row} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-label text-text">
          {row.song ?? <span className="text-dim">{t('queue.privateSong')}</span>}
          {row.mine && <span className="chip-accent ml-2 align-middle">{t('queue.yours')}</span>}
        </p>
        <p className="truncate text-caption text-dim">{who(t, row)}</p>
        {row.status === 'running' && (
          <div
            className="h-1 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-label={row.song ?? t('queue.privateSong')}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((row.progress ?? 0) * 100)}>
            <div
              className="h-full origin-left bg-accent transition-transform duration-[var(--dur-panel)] ease-out"
              style={{ transform: `scaleX(${Math.round((row.progress ?? 0) * 100) / 100})` }}
            />
          </div>
        )}
      </div>
      <div className="max-w-[45%] shrink-0 space-y-1 text-right">
        <Status row={row} />
        <p className="readout text-caption text-dim">{formatElapsed(row.elapsedS)}</p>
        {/* W3.16: an estimate, a range, and said to be one; W11.1: in which mode. */}
        {row.estimate && (
          <p className="readout text-caption text-dim" title={t('modes.estimate.why')}>
            {t('modes.estimate.left')} {formatRange(t, row.estimate.lowS, row.estimate.highS)}
          </p>
        )}
        {row.mode && row.mode !== 'normal' && <p className="text-caption text-dim">{t(`modes.names.${row.mode}`)}</p>}
      </div>
    </div>
  )
  const to = row.id ? `/analyze/${row.id}` : row.timing ? timingPath(row.timing) : null
  const link = to ? <Link to={to} className="block transition-colors duration-150 ease-out hover:bg-surface-2">{body}</Link> : body
  // Your own waiting song can be taken back (W3.12); the button sits beside
  // the link, not inside it.
  const cancellable = row.mine && row.id && row.status === 'queued'
  return (
    <li data-reveal style={{ '--i': index }}>
      {cancellable ? (
        <div className="flex items-center bg-accent/5">
          <div className="min-w-0 flex-1">{link}</div>
          <CancelButton id={row.id} onCancelled={() => setCancelled(true)} className="shrink-0 pr-3" />
        </div>
      ) : (
        link
      )}
      {row.ref && <StaffActions row={row} onDone={onModerated} />}
    </li>
  )
}

/** A moderator's two buttons on a live row (W3.18), each asking for an optional reason for the log. */
function StaffActions({ row, onDone }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function act(action) {
    const reason = window.prompt(t(`moderation.${action}Prompt`))
    if (reason === null) return
    setBusy(true)
    setError(null)
    try {
      await api(`/analyses/${row.ref}/moderate`, { method: 'POST', json: { action, ...(reason.trim() ? { reason } : {}) } })
      onDone?.()
    } catch (failure) {
      setError(t(`moderation.errors.${failure.code}`, { defaultValue: t('moderation.failed') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line px-2 py-2 sm:px-3">
      <span className="label text-amber">{t('moderation.staff')}</span>
      <button type="button" disabled={busy} onClick={() => act('remove')} className="btn-ghost btn-sm">
        {t('moderation.remove')}
      </button>
      {row.status === 'running' && (
        <button type="button" disabled={busy} onClick={() => act('requeue')} className="btn-ghost btn-sm">
          {t('moderation.requeue')}
        </button>
      )}
      {error && (
        <span role="alert" className="text-caption text-red">
          {error}
        </span>
      )}
    </div>
  )
}

/** The latest removals and requeues, for staff: who, what, when and why. */
function ModerationLog({ tick }) {
  const { t } = useTranslation()
  const [log, setLog] = useState(null)

  useEffect(() => {
    let alive = true
    api('/analyses/moderation')
      .then((data) => alive && setLog(data.log))
      .catch(() => alive && setLog([]))
    return () => {
      alive = false
    }
  }, [tick])

  return (
    <section className="space-y-5 pt-4" aria-labelledby="queue-moderation">
      <SectionHeader id="queue-moderation" eyebrow={t('moderation.staff')} title={t('moderation.logTitle')} />
      {!log?.length ? (
        <p className="text-caption text-dim">{t('moderation.logEmpty')}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {log.map((entry, i) => (
            <li key={`${entry.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-caption">
              <span className="readout text-dim">{new Date(entry.at).toLocaleString()}</span>
              <span>{t(`moderation.did.${entry.action}`, { moderator: entry.moderator })}</span>
              {entry.ref && <span className="readout text-dim">{entry.ref.slice(0, 8)}</span>}
              {entry.reason && <span className="text-muted">“{entry.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Uploader({ row }) {
  if (row.uploader) return <Avatar account={row.uploader} size={32} />
  return (
    <div aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-3 text-dim">
      <Icon name="user" size={15} />
    </div>
  )
}

function who(t, row) {
  if (row.private) return t('queue.privateUpload')
  if (row.uploader) return `@${row.uploader.username}`
  return t('queue.anonymous')
}

function Status({ row }) {
  const { t } = useTranslation()
  const tone = {
    queued: 'text-dim',
    running: 'text-accent',
    done: 'text-accent',
    refused: 'text-amber',
    failed: 'text-red',
  }[row.status]
  const label =
    row.status === 'running' && row.stage
      ? t(`result.stages.${row.stage}`, { defaultValue: t('queue.status.running') })
      : t(`queue.status.${row.status}`)
  return (
    <p className={`text-caption font-semibold ${tone ?? ''}`}>
      {label}
      {row.cached && <span className="ml-1 font-normal text-dim">· {t('queue.cached')}</span>}
    </p>
  )
}

const formatElapsed = (s) => {
  if (s == null) return ''
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)} h ${m % 60} min`
}
