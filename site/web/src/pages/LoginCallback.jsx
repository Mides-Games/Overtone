import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import ReturnPage from '../components/ReturnPage.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'
import { takeSignInNote } from '../lib/sso-guard.js'

/**
 * Where Mides sends the browser back, with `#code=` in the fragment (never in
 * the query, so it does not reach any server log). The code is spent once: the
 * exchange is a module-level promise so React's double effects in development
 * do not post it twice.
 */
let pending = null

function exchangeOnce() {
  if (pending) return pending

  const code = new URLSearchParams(window.location.hash.slice(1)).get('code')
  // The code leaves the address bar and the history right away.
  window.history.replaceState(null, '', window.location.pathname)
  const note = takeSignInNote()

  pending = (async () => {
    if (!code || !note) return { error: 'state' }
    try {
      await api('/auth/sso/exchange', { method: 'POST', json: { code } })
      return { returnTo: note.returnTo }
    } catch (error) {
      return error.code === 'SSO_STATE_MISSING' ? { error: 'state' } : { error: 'failed', message: error.message }
    } finally {
      // A later visit to this page is a new sign-in.
      setTimeout(() => (pending = null), 0)
    }
  })()
  return pending
}

export default function LoginCallback() {
  const { t } = useTranslation()
  usePageMeta(t('nav.signIn'))
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [failure, setFailure] = useState(null)

  useEffect(() => {
    let live = true
    exchangeOnce().then(async (outcome) => {
      if (!live) return
      if (outcome.error) return setFailure(outcome)
      await refresh()
      navigate(outcome.returnTo, { replace: true })
    })
    return () => {
      live = false
    }
  }, [navigate, refresh])

  return (
    <ReturnPage
      title={t('nav.signIn')}
      working={t('callback.working')}
      failure={failure && (failure.error === 'state' ? t('callback.stateMissing') : t('callback.failed', { message: failure.message }))}
      back={{ to: '/login', label: t('callback.back') }}
    />
  )
}
