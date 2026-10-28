import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../lib/api.js'

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

  if (links === undefined) return null
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
    <section className="space-y-3" aria-labelledby="links-title">
      <h2 id="links-title" className="label">
        {t('links.title')}
      </h2>
      <div className="panel divide-y divide-line">
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-[16px] font-bold">Discord</p>
              <p className="text-caption text-dim">{discord.linked ? t('links.discord.linked') : t('links.discord.notLinked')}</p>
            </div>
            {discord.linked ? (
              <button type="button" className="btn-ghost h-9" onClick={unlinkDiscord} disabled={busy !== null}>
                {t('links.unlink')}
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {available.midesDiscord && (
                  <button type="button" className="btn-primary h-9" onClick={linkOnMides} disabled={busy !== null}>
                    {t('links.discord.onMides')} ↗
                  </button>
                )}
                {available.bot && (
                  <button type="button" className="btn-ghost h-9" onClick={makeCode} disabled={busy !== null}>
                    {t('links.discord.code')}
                  </button>
                )}
              </div>
            )}
          </div>

          {!discord.linked && !available.midesDiscord && !available.bot && (
            <p className="text-caption text-dim">{t('links.discord.unavailable')}</p>
          )}

          {!discord.linked && code && (
            <div className="rounded-panel border border-line bg-surface-2 px-4 py-3">
              <p className="text-label">{t('links.discord.codeHint', { minutes: code.minutes })}</p>
              <p className="readout mt-1 select-all text-title">/link {code.code}</p>
            </div>
          )}

          {discord.linked && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={discord.notify}
                onChange={(e) => setNotify(e.target.checked)}
                disabled={busy !== null}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className="space-y-0.5">
                <span className="block text-label">{t('links.discord.notify')}</span>
                <span className="block text-caption text-dim">
                  {available.bot ? t('links.discord.notifyHint') : t('links.discord.botOff')}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-[16px] font-bold">osu!</p>
              {osu ? (
                <p className="text-caption text-dim">
                  <a
                    href={`https://osu.ppy.sh/users/${encodeURIComponent(osu.id)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[var(--accent)] hover:underline"
                  >
                    {osu.username} ↗
                  </a>
                  {osu.rankedCount !== null && <> · {t('links.osu.ranked', { count: osu.rankedCount })}</>}
                </p>
              ) : (
                <p className="text-caption text-dim">{available.osu ? t('links.osu.notLinked') : t('links.osu.unavailable')}</p>
              )}
            </div>
            {osu ? (
              <button type="button" className="btn-ghost h-9" onClick={unlinkOsu} disabled={busy !== null}>
                {t('links.unlink')}
              </button>
            ) : (
              available.osu && (
                <button type="button" className="btn-primary h-9" onClick={linkOsu} disabled={busy !== null}>
                  {t('links.osu.link')} ↗
                </button>
              )
            )}
          </div>
          <p className="text-caption text-dim">{t('links.osu.scope')}</p>
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
