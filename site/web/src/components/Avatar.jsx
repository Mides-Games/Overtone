import { useState } from 'react'

/**
 * A profile picture with an initials fallback. The URL is already absolute
 * (the API makes it so) and public; a broken one falls back to the initials.
 */
export default function Avatar({ account, size = 40, className = '' }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  const name = account?.displayName || account?.username || ''

  if (account?.avatarUrl && !broken) {
    return (
      <img
        src={account.avatarUrl}
        alt={name}
        style={style}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full border border-line-strong bg-surface-3 object-cover ${className}`}
      />
    )
  }

  return (
    <div
      style={style}
      aria-label={name || undefined}
      className={`flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-3 font-display font-semibold text-accent ${className}`}
    >
      <span style={{ fontSize: size * 0.38 }}>{initials(name)}</span>
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
