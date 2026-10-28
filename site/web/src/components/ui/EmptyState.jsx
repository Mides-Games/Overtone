import Waveform from './Waveform.jsx'

/**
 * Nothing to show yet (docs/design.md, section 6): a small waveform with no
 * red line on it yet, one line of text and at most one action. Not a panel:
 * put it inside the panel or list it stands in for.
 *
 *   <EmptyState title={emptyText} action={<Link to="/analyze" className="btn-ghost">...</Link>} />
 *
 * `title` is the one line; `children` an optional, quieter second line.
 */
export default function EmptyState({ title, children, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center gap-4 px-6 py-10 text-center ${className}`}>
      <Waveform bars={28} lines={[]} seed={3} className="h-8 w-28 opacity-90" />
      <div className="max-w-[46ch] space-y-1.5">
        <p className="text-body font-medium text-text">{title}</p>
        {children && <p className="text-label text-muted">{children}</p>}
      </div>
      {action}
    </div>
  )
}
