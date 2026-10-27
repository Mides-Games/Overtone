import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { chime, unlockChime } from '../lib/chime.js'
import { alertFor, isFinished, trayTitle } from '../lib/tracker.js'
import { askToNotify, tracker, useTracker } from '../lib/tracking.js'
import CancelButton from './CancelButton.jsx'

/**
 * The analysis tray (W3.22) and its notices (W3.23): a panel on every page,
 * listing the songs this tab sent and follows, so the person can browse the
 * site while they wait. It reads the same store as the Analyze page and the
 * result page (lib/tracking.js), so opening it costs no request.
 *
 * Where its button lives depends on the width:
 * - wide (md and up), a small button in the bottom corner, open by default,
 *   with a spacer under the footer so the corner never hides the end of a page;
 * - narrow, a button in the navbar's top row (`TrayButton`), closed by
 *   default: a floating button on a phone sits on top of the page's own
 *   full-width buttons, and the bar is already on screen. Opened, the panel
 *   is a sheet at the bottom that the person closes again.
 * Nothing at all is drawn until there is something to show.
 */
const PANEL_ID = 'analysis-tray'
const wide = () => {
  try {
    return window.matchMedia('(min-width: 768px)').matches
  } catch {
    return false
  }
}
const permission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

/** Open or closed, shared by the corner button and the navbar's: one panel, two ways in. */
const view = (() => {
  let open = wide()
  let touched = false
  let opener = null
  const listeners = new Set()
  // Until the person opens or closes it, the default follows the width (a phone turned sideways, a resized window).
  try {
    window.matchMedia('(min-width: 768px)').addEventListener('change', (event) => {
      if (touched) return
      open = event.matches
      for (const listener of listeners) listener()
    })
  } catch {
    // No matchMedia: the first default stays.
  }
  return {
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    get: () => open,
    set(next, from = null) {
      touched = true
      if (next && from) opener = from
      open = next
      for (const listener of listeners) listener()
      // Closed with the keyboard, focus goes back to the button that opened it.
      if (!next && from === 'escape') opener?.focus?.()
    },
  }
})()
const useOpen = () => useSyncExternalStore(view.subscribe, view.get)
const hasContent = ({ entries, notices, count }) => entries.length > 0 || notices.length > 0 || count > 0

/** What one notice says, in the reader's language. */
function noticeText(t, notice) {
  if (notice.kind === 'batch') return t('tray.notice.batch', { done: notice.done, total: notice.total })
  return t(`tray.notice.${notice.status}`, { name: notice.name || notice.id })
}

/** The tray's way in on a narrow screen, in the navbar's top row. */
export function TrayButton() {
  const { t } = useTranslation()
  const snapshot = useTracker()
  const open = useOpen()
  if (!hasContent(snapshot)) return null
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? PANEL_ID : undefined}
      aria-label={open ? t('tray.hide') : t('tray.showCount', { count: snapshot.count })}
      onClick={(event) => view.set(!open, event.currentTarget)}
      className="flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 text-muted transition hover:bg-surface-3 hover:text-text md:hidden"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h10M4 18h7" />
      </svg>
      {snapshot.count > 0 && <span className="readout text-caption text-accent">{snapshot.count}</span>}
    </button>
  )
}

export default function Tray() {
  const { t } = useTranslation()
  const snapshot = useTracker()
  const { entries, notices, settings, live, count } = snapshot
  const open = useOpen()
  const [announce, setAnnounce] = useState('')
  const seen = useRef(notices.reduce((max, notice) => Math.max(max, notice.seq), 0))

  // The tab's title counts everything still in flight, whichever page is open.
  // The page's own title is whatever the tab shows that this did not write,
  // kept on <html> so a remount (or a hot reload) never counts it twice.
  // Pages rename the tab as they load (usePageMeta), so a title written by
  // anyone else is taken as the new base and the count goes back in front.
  useEffect(() => {
    const kept = document.documentElement.dataset
    const apply = () => {
      if (document.title === kept.trayTitle) return
      kept.trayBase = document.title
      kept.trayTitle = trayTitle(count, t('tray.titleCount', { count }), kept.trayBase)
      document.title = kept.trayTitle
    }
    if (kept.trayBase !== undefined && document.title === kept.trayTitle) {
      kept.trayTitle = trayTitle(count, t('tray.titleCount', { count }), kept.trayBase)
      document.title = kept.trayTitle
    } else apply()
    const title = document.querySelector('title')
    if (!title || typeof MutationObserver === 'undefined') return undefined
    const observer = new MutationObserver(apply)
    observer.observe(title, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [count, t])

  // Each new notice: said to a screen reader, and, if the person asked for it, a notification and a chime.
  useEffect(() => {
    const fresh = notices.filter((notice) => notice.seq > seen.current).reverse()
    if (!fresh.length) return
    seen.current = fresh.at(-1).seq
    setAnnounce(noticeText(t, fresh.at(-1)))
    for (const notice of fresh) {
      const alert = alertFor(notice, { settings, permission: permission(), visible: document.visibilityState === 'visible' && document.hasFocus() })
      if (alert.notify) {
        try {
          new Notification(notice.kind === 'batch' ? t('analyze.batch.notifyTitle') : t('tray.notifyTitle'), {
            body: notice.kind === 'batch' ? t('analyze.batch.notifyBody', { done: notice.done, total: notice.total }) : noticeText(t, notice),
            tag: alert.tag,
          })
        } catch {
          // Some browsers (Android Chrome) only notify from a service worker: the tray and the title still say it.
        }
      }
      if (alert.sound) chime(notice.kind === 'batch' || notice.status === 'done')
    }
  }, [notices, settings, t])

  // A remembered "sound on" needs one interaction after a reload before the browser lets it play.
  useEffect(() => {
    if (!settings.sound) return undefined
    const unlock = () => unlockChime()
    document.addEventListener('pointerdown', unlock, { once: true })
    document.addEventListener('keydown', unlock, { once: true })
    return () => {
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', unlock)
    }
  }, [settings.sound])

  // Escape closes it from wherever the focus is, the button that opened it included.
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.key === 'Escape') view.set(false, 'escape')
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open])

  function setSound(wanted) {
    if (wanted) unlockChime()
    tracker.setSettings({ sound: wanted })
    if (wanted) chime(true)
  }

  if (!hasContent(snapshot)) return null

  const finished = entries.filter((entry) => isFinished(entry.status)).length
  const blocked = permission() === 'denied' || permission() === 'unsupported'

  return (
    <>
      {/* Room under the footer, so the corner never hides the end of a page. */}
      <div aria-hidden="true" className="hidden h-16 md:block" />
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>
      <div
        className="pointer-events-none fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] z-30 flex flex-col items-end gap-2 md:right-4 md:bottom-4 md:left-auto"
      >
        {open && (
          <section
            id={PANEL_ID}
            aria-label={t('tray.label')}
            className="panel pointer-events-auto flex max-h-[min(60vh,34rem)] w-full flex-col overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.25)] md:max-h-[min(70vh,34rem)] md:w-[22rem]"
          >
            <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <h2 className="label whitespace-nowrap">{t('tray.label')}</h2>
              <span className="flex items-center gap-1.5">
                <button type="button" className="tool-btn px-2 text-caption" aria-pressed={settings.sound} onClick={() => setSound(!settings.sound)}>
                  {t('tray.sound')}
                </button>
                <button
                  type="button"
                  className="tool-btn px-2 text-caption"
                  aria-pressed={settings.notify}
                  disabled={blocked}
                  title={blocked ? t('tray.notifyBlocked') : undefined}
                  onClick={() => askToNotify(!settings.notify)}
                >
                  {t('tray.notify')}
                </button>
                <button
                  type="button"
                  onClick={() => view.set(false, 'escape')}
                  aria-label={t('tray.hide')}
                  className="flex h-8 w-8 items-center justify-center rounded-control text-dim hover:bg-surface-3 hover:text-text md:hidden"
                >
                  ×
                </button>
              </span>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {entries.length > 0 ? (
                <ul className="divide-y divide-line">
                  {entries.map((entry) => (
                    <Row key={entry.id} entry={entry} reading={live[entry.id]?.data ?? null} />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-caption text-dim">{t('tray.empty')}</p>
              )}
              {finished > 0 && (
                <div className="border-t border-line px-3 py-2">
                  <button type="button" className="btn-ghost h-7 px-2.5 text-caption" onClick={() => tracker.clearFinished()}>
                    {t('tray.clearFinished')}
                  </button>
                </div>
              )}

              <section className="border-t border-line" aria-label={t('tray.inbox')}>
                <div className="flex items-center justify-between gap-2 px-3 pt-2">
                  <h3 className="label">{t('tray.inbox')}</h3>
                  {notices.length > 0 && (
                    <button type="button" className="text-caption text-dim underline-offset-2 hover:text-text hover:underline" onClick={() => tracker.clearNotices()}>
                      {t('tray.clearInbox')}
                    </button>
                  )}
                </div>
                {notices.length > 0 ? (
                  <ul className="space-y-1 px-3 py-2">
                    {notices.map((notice) => (
                      <li key={notice.seq} className="flex items-baseline justify-between gap-3 text-caption">
                        <span className="min-w-0 break-words text-muted">{noticeText(t, notice)}</span>
                        <time className="readout shrink-0 text-dim" dateTime={new Date(notice.at).toISOString()}>
                          {new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3 py-2 text-caption text-dim">{t('tray.noNotices')}</p>
                )}
              </section>
            </div>
          </section>
        )}

        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? PANEL_ID : undefined}
          onClick={(event) => view.set(!open, event.currentTarget)}
          className="pointer-events-auto hidden h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 text-label font-semibold text-text shadow-[0_4px_16px_rgba(0,0,0,0.2)] transition hover:border-line-hover md:flex"
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${count > 0 ? 'animate-pulse bg-accent' : 'bg-line-hover'}`} />
          <span>{open ? t('tray.hide') : t('tray.show')}</span>
          {count > 0 && <span className="readout text-caption text-accent">{count}</span>}
        </button>
      </div>
    </>
  )
}

/** One followed song: its name (a link once there is a page to see), where it stands, and what can be done. */
function Row({ entry, reading }) {
  const { t } = useTranslation()
  const { id, status } = entry
  const name = entry.name || id
  const running = status === 'running'
  const percent = running ? Math.round((reading?.progress ?? 0) * 100) : null

  let text
  let tone = 'text-dim'
  if (status === null) text = t('analyze.card.sent')
  else if (status === 'queued') text = t('result.queued', { position: reading?.position ?? 1 })
  else if (running) text = reading?.stage ? t(`result.stages.${reading.stage}`, { defaultValue: t('result.running') }) : t('result.running')
  else if (status === 'gone') text = t('tray.gone')
  else {
    text = t(`queue.status.${status}`)
    tone = status === 'done' ? 'text-accent' : status === 'refused' ? 'text-amber' : status === 'failed' ? 'text-red' : 'text-dim'
  }

  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        {status === 'gone' || status === 'cancelled' ? (
          <span className="min-w-0 truncate text-label text-muted">{name}</span>
        ) : (
          <Link to={`/analyze/${id}`} className="min-w-0 truncate text-label text-accent hover:underline">
            {name}
          </Link>
        )}
        {isFinished(status) && (
          <button
            type="button"
            onClick={() => tracker.dismiss(id)}
            aria-label={t('tray.dismiss', { name })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-dim hover:bg-surface-3 hover:text-text"
          >
            ×
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-caption ${tone}`}>
          {text}
          {percent !== null && <span className="readout"> · {percent}%</span>}
        </p>
        {status === 'queued' && <CancelButton id={id} />}
      </div>
      {percent !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
    </li>
  )
}
