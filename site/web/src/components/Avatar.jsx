import { useState } from 'react'

/**
 * A profile picture with an initials fallback. The URL is already absolute
 * (the API makes it so) and public; a broken one falls back to the initials.
 *
 * `decorative`: the name is written right beside it (a list row, a byline),
 * so the picture says nothing more and a screen reader skips it rather than
 * reading the name twice. Otherwise the picture, or the initials standing in
 * for it, is an image named after the person.
 */
export default function Avatar({ account, size = 40, decorative = false, className = '' }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  const name = account?.displayName || account?.username || ''
  const named = Boolean(name) && !decorative

  if (account?.avatarUrl && !broken) {
    return (
      <img
        src={account.avatarUrl}
        alt={named ? name : ''}
        style={style}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full border border-line-strong bg-surface-3 object-cover ${className}`}
      />
    )
  }

  // The initials stand for the picture, so they are named as one: an
  // aria-label on a plain div is not announced (ARIA forbids it there).
  return (
    <div
      style={style}
      role={named ? 'img' : undefined}
      aria-label={named ? name : undefined}
      aria-hidden={named ? undefined : 'true'}
      className={`flex shrink-0 select-none items-center justify-center rounded-full border border-line-strong bg-surface-3 font-display font-bold tracking-[-0.02em] text-accent ${className}`}
    >
      <span aria-hidden={named ? 'true' : undefined} style={{ fontSize: size * 0.38 }}>
        {initials(name)}
      </span>
    </div>
  )
}

function initials(source) {
  // Letters and digits only: "Dev tester (google)" is DG, not D(.
  const parts = source.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
