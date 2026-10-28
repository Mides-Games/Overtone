import { useLocation } from 'react-router'

/**
 * The router state a "Sign in" link carries: the page it was pressed on, so
 * the sign-in comes back there instead of to /profile (Login.jsx reads
 * `from`, sso-guard.js checks it is a path on this site). The login pages
 * themselves are not a place to come back to.
 */
export default function useSignInState() {
  const { pathname, search } = useLocation()
  return pathname.startsWith('/login') ? undefined : { from: `${pathname}${search}` }
}
