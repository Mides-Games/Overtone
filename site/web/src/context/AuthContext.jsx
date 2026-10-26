import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { api } from '../lib/api.js'
import { leaveForSignIn } from '../lib/sso-guard.js'

/**
 * Who is signed in, from `GET /api/v1/me`. `account` is `undefined` while the
 * first answer is pending, `null` when nobody is signed in.
 */
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [account, setAccount] = useState(undefined)

  const refresh = useCallback(async () => {
    try {
      const data = await api('/me')
      setAccount(data.account)
      return data.account
    } catch {
      setAccount(null)
      return null
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** Asks the API where to go (it builds the redirect_uri), notes the trip, leaves. */
  const signIn = useCallback(async (provider, returnTo) => {
    const { url } = await api(`/auth/sso/start?provider=${encodeURIComponent(provider)}`)
    leaveForSignIn(url, returnTo)
  }, [])

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    setAccount(null)
  }, [])

  return <AuthContext value={{ account, refresh, signIn, signOut }}>{children}</AuthContext>
}

export const useAuth = () => useContext(AuthContext)
