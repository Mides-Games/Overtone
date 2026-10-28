import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router'

import Mark from '../components/Mark.jsx'
import Icon from '../components/ui/Icon.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'

const PROVIDERS = [
  {
    id: 'discord',
    color: '#5865f2',
    icon: 'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z',
  },
  {
    id: 'google',
    color: '#4285f4',
    icon: 'M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12s4.15 9.25 9.25 9.25c5.34 0 8.88-3.75 8.88-9.04 0-.6-.07-1.06-.15-1.51z',
  },
]

/**
 * Sign in (ADR-W3): the Mides account, by Discord or Google, and nothing
 * else. One panel, since it is the one thing on the page to operate; the
 * heading and the promise about what is kept sit on the ground around it.
 */
export default function Login() {
  const { t } = useTranslation()
  usePageMeta(t('login.title'), t('login.subtitle'))
  const { account, signIn } = useAuth()
  const location = useLocation()
  const [config, setConfig] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/auth/config')
      .then(setConfig)
      .catch(() => setConfig({ devLogin: false, providers: [] }))
  }, [])

  if (account) return <Navigate to="/profile" replace />

  async function go(provider) {
    setBusy(provider)
    setError(null)
    try {
      await signIn(provider, location.state?.from ?? '/profile')
    } catch (err) {
      setBusy(null)
      setError(t('login.failed', { message: err.message }))
    }
  }

  const available = config?.providers ?? []

  return (
    <div className="rise mx-auto max-w-md space-y-8 py-4 sm:py-10">
      <div className="space-y-4">
        <Mark size={40} />
        <h1 className="heading-headline">{t('login.title')}</h1>
        <p className="lede">{t('login.subtitle')}</p>
      </div>

      <div className="panel space-y-3 p-5 sm:p-6" aria-busy={config === null}>
        {config?.devLogin && (
          <div className="space-y-2 rounded-control border border-amber/40 bg-amber/10 p-3">
            <span className="chip-amber">{t('login.devTitle')}</span>
            <p className="text-caption text-text">{t('login.devNote')}</p>
          </div>
        )}

        {config && available.length === 0 && (
          <p role="alert" className="text-label text-red">
            {t('login.notConfigured')}
          </p>
        )}

        {/* The two buttons' places while the server says which it offers. */}
        {config === null && (
          <div aria-hidden="true" className="space-y-3">
            <Skeleton className="h-12 rounded-control" />
            <Skeleton className="h-12 rounded-control" />
          </div>
        )}

        {PROVIDERS.filter((p) => available.includes(p.id)).map((p) => (
          <button key={p.id} type="button" disabled={busy !== null} onClick={() => go(p.id)} className="btn-ghost btn-lg w-full">
            <svg width="20" height="20" viewBox="0 0 24 24" fill={p.color} aria-hidden="true" focusable="false">
              <path d={p.icon} />
            </svg>
            {busy === p.id ? t('common.loading') : t(`login.${p.id}`)}
          </button>
        ))}

        {error && (
          <p role="alert" className="text-label text-red">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-start gap-3 border-t border-line pt-5">
        <Icon name="lock" size={16} className="mt-0.5 text-dim" />
        <p className="text-caption text-muted">{t('login.privacy')}</p>
      </div>
    </div>
  )
}
