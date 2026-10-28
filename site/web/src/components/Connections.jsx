import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../lib/api.js'
import Icon from './ui/Icon.jsx'
import SectionHeader from './ui/SectionHeader.jsx'
import Skeleton from './ui/Skeleton.jsx'

/**
 * The profile's linked accounts (W9.1, W9.2, W9.4): Discord and osu!.
 *
 * Discord is linked on Mides (the button leaves for Mides' own page, which
 * comes back to /profile and signs in again so the new Discord id arrives
 * with the profile) or, while Mides cannot do that, with a code typed to the
 * bot as `/link`. osu! is its own OAuth, `identify` only. Each part says when
 * this server cannot offer it, instead of showing a button that fails.
 *
 * The osu! avatar is not shown: images load only from this site and Mides
 * (the img-src of deploy/web/serve.mjs), and widening that for one picture
 * on a page only its owner sees is not worth a third-party request.
 */
export default function Connections() {
  const { t } = useTranslation()
  const [links, setLinks] = useState(undefined)
  const [code, setCode] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setLinks(await api('/me/links'))
    } catch {
      setLinks(null)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Runs one button's request; the error, if any, is shown under the section. */
  const act = async (name, run) => {
    setBusy(name)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (links === undefined) return <Skeleton className="h-48 rounded-panel" />
  if (links === null) {
    return (
      <p role="alert" className="text-label text-red">
        {t('links.loadFailed')}
      </p>
    )
  }

  const { discord, osu, available } = links

  const linkOnMides = () =>
    act('mides', async () => {
      const { url } = await api('/links/discord/start')
      window.location.assign(url)
    })
  const makeCode = () => act('code', async () => setCode(await api('/links/discord/code', { method: 'POST', json: {} })))
  const setNotify = (on) =>
    act('notify', async () => {
      await api('/links/discord/notify', { method: 'PUT', json: { on } })
      await load()
    })
  const unlinkDiscord = () =>
    act('unlinkDiscord', async () => {
      await api('/links/discord', { method: 'DELETE' })
      setCode(null)
      await load()
    })
  const linkOsu = () =>
    act('osu', async () => {
      const { url } = await api('/links/osu/start', { method: 'POST', json: {} })
      window.location.assign(url)
    })
  const unlinkOsu = () =>
    act('unlinkOsu', async () => {
      await api('/links/osu', { method: 'DELETE' })
      await load()
    })

  return (
    <section className="space-y-5" aria-labelledby="links-title">
      <SectionHeader id="links-title" title={t('links.title')} />
      <div className="panel divide-y divide-line">
        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <ServiceMark linked={discord.linked} />
              <div className="min-w-0 space-y-1">
                <h3 className="heading-title">Discord</h3>
                <p className="max-w-[60ch] text-caption text-muted">{discord.linked ? t('links.discord.linked') : t('links.discord.notLinked')}</p>
              </div>
            </div>
            {discord.linked ? (
              <button type="button" className="btn-ghost btn-sm" onClick={unlinkDiscord} disabled={busy !== null}>
                {t('links.unlink')}
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {available.midesDiscord && (
                  <button type="button" className="btn-primary btn-sm" onClick={linkOnMides} disabled={busy !== null}>
                    {t('links.discord.onMides')}
                    <Icon name="external" size={15} />
                  </button>
                )}
                {available.bot && (
                  <button type="button" className="btn-ghost btn-sm" onClick={makeCode} disabled={busy !== null}>
                    {t('links.discord.code')}
                  </button>
                )}
              </div>
            )}
          </div>

          {!discord.linked && !available.midesDiscord && !available.bot && (
            <p className="pl-9 text-caption text-dim">{t('links.discord.unavailable')}</p>
          )}

          {!discord.linked && code && (
            <div className="panel-well fade-in space-y-1.5 px-4 py-3 sm:ml-9">
              <p className="text-label text-muted">{t('links.discord.codeHint', { minutes: code.minutes })}</p>
              <p className="readout select-all text-title text-text">/link {code.code}</p>
            </div>
          )}

          {discord.linked && (
            <label className="flex cursor-pointer items-start gap-3 sm:pl-9">
              <input
                type="checkbox"
                checked={discord.notify}
                onChange={(e) => setNotify(e.target.checked)}
                disabled={busy !== null}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="space-y-0.5">
                <span className="block text-label font-medium text-text">{t('links.discord.notify')}</span>
                <span className="block text-caption text-muted">
                  {available.bot ? t('links.discord.notifyHint') : t('links.discord.botOff')}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <ServiceMark linked={Boolean(osu)} />
              <div className="min-w-0 space-y-1">
                <h3 className="heading-title">osu!</h3>
                {osu ? (
                  <p className="flex flex-wrap items-center gap-x-2 text-caption text-muted">
                    <a
                      href={`https://osu.ppy.sh/users/${encodeURIComponent(osu.id)}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="link inline-flex items-center gap-1"
                    >
                      {osu.username}
                      <Icon name="external" size={13} />
                      <span className="sr-only">{t('common.newTab')}</span>
                    </a>
                    {osu.rankedCount !== null && <span className="readout">· {t('links.osu.ranked', { count: osu.rankedCount })}</span>}
                  </p>
                ) : (
                  <p className="text-caption text-muted">{available.osu ? t('links.osu.notLinked') : t('links.osu.unavailable')}</p>
                )}
              </div>
            </div>
            {osu ? (
              <button type="button" className="btn-ghost btn-sm" onClick={unlinkOsu} disabled={busy !== null}>
                {t('links.unlink')}
              </button>
            ) : (
              available.osu && (
                <button type="button" className="btn-primary btn-sm" onClick={linkOsu} disabled={busy !== null}>
                  {t('links.osu.link')}
                  <Icon name="external" size={15} />
                </button>
              )
            )}
          </div>
          <p className="max-w-[72ch] text-caption text-dim sm:pl-9">{t('links.osu.scope')}</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
    </section>
  )
}

/** Linked or not, at a glance: the link icon in the accent, or dim. */
function ServiceMark({ linked }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${linked ? 'border-accent/50 text-accent' : 'border-line-strong text-dim'}`}
    >
      <Icon name={linked ? 'check' : 'link'} size={13} strokeWidth={linked ? 2 : 1.5} />
    </span>
  )
}
