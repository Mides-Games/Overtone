import Icon from '../ui/Icon.jsx'

/**
 * A group of tools folded under one line (docs/design.md, section 11: the
 * result page is dense, so what most readers never touch waits behind a
 * summary that names everything inside it). A native `details`: the keyboard
 * opens it, a screen reader says whether it is open, and what is inside stays
 * mounted, so its keyboard shortcuts keep working while it is folded.
 *
 * Used inside a panel, between hairlines: it is not a box of its own.
 */
export default function Disclosure({ title, hint = null, open = false, inset = 'px-4', className = '', children }) {
  return (
    <details className={`group/disclosure ${className}`} open={open || undefined}>
      <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-3 ${inset} py-2.5 transition-colors duration-150 ease-out hover:bg-surface-2 [&::-webkit-details-marker]:hidden`}>
        <Icon name="chevron-right" size={16} className="text-dim transition-transform duration-150 ease-out group-open/disclosure:rotate-90" />
        <span className="min-w-0">
          <span className="block text-label font-semibold text-text">{title}</span>
          {hint && <span className="block text-caption text-dim">{hint}</span>}
        </span>
      </summary>
      {children}
    </details>
  )
}
