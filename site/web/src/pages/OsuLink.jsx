import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'

/**
 * Where osu! sends the browser back after "Link osu!" (W9.2), with `?code`
 * and `?state` in the query: osu!'s OAuth puts them there, not in the
 * fragment. They leave the address bar at once and are posted to the API,
 * which checks the state against its cookie and exchanges the code server
 * side. Spent once, as the sign-in's code is (LoginCallback.jsx).
 */
let pending = null

function exchangeOnce() {
  if (pending) return pending
  const query = new URLSearchParams(window.location.search)
  const code = query.get('code')
  const state = query.get('state')
  const denied = query.get('error')
  window.history.replaceState(null, '', window.location.pathname)

  pending = (async () => {
    if (denied) return { error: 'denied' }
    if (!code || !state) return { error: 'state' }
    try {
      await api('/links/osu/exchange', { method: 'POST', json: { code, state } })
      return {}
    } catch (error) {
      return error.code === 'OSU_STATE_MISSING' ? { error: 'state' } : { error: 'failed', message: error.message }
    } finally {
      setTimeout(() => (pending = null), 0)
    }
  })()
  return pending
}

export default function OsuLink() {
  const { t } = useTranslation()
  usePageMeta(t('links.osu.title'))
  const navigate = useNavigate()
  const [failure, setFailure] = useState(null)

  useEffect(() => {
    let live = true
    exchangeOnce().then((outcome) => {
      if (!live) return
      if (outcome.error) return setFailure(outcome)
      navigate('/profile', { replace: true })
    })
    return () => {
      live = false
    }
  }, [navigate])

  if (!failure) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <BrandLoader />
        <p className="text-label text-muted">{t('links.osu.working')}</p>
      </div>
    )
  }

  return (
    <div className="panel mx-auto max-w-md space-y-4 p-8 text-center">
      <p role="alert">
        {failure.error === 'denied'
          ? t('links.osu.denied')
          : failure.error === 'state'
            ? t('links.osu.stateMissing')
            : t('links.osu.failed', { message: failure.message })}
      </p>
      <Link to="/profile" className="btn-primary">
        {t('links.back')}
      </Link>
    </div>
  )
}
