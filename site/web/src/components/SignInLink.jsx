import { Link } from 'react-router'

import useSignInState from '../hooks/useSignInState.js'

/** A link to /login that comes back to the page it is on (hooks/useSignInState.js). */
export default function SignInLink({ children, ...props }) {
  const state = useSignInState()
  return (
    <Link to="/login" state={state} {...props}>
      {children}
    </Link>
  )
}
