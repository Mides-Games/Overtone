import { Link } from 'react-router'

import Icon from './Icon.jsx'

/**
 * A page's own heading (docs/design.md, section 11): an optional way back or
 * eyebrow, the page's one `h1` in `heading-headline`, sentence case, an
 * optional lede, and an optional action on the right that wraps under it on a
 * phone. It rises in with the page (`.rise`); nothing waits with reduced motion.
 *
 *   <PageHeader title={title} lede={subtitle} action={<Link className="btn-quiet">...</Link>} />
 *
 * `back` is `{ to, label }`: a quiet link above the heading, for a sub-page.
 */
export default function PageHeader({ eyebrow, title, lede, action, back, id, className = '', children }) {
  return (
    <header className={`rise flex flex-wrap items-end justify-between gap-x-8 gap-y-4 ${className}`}>
      <div className="min-w-0 max-w-3xl space-y-3">
        {back && (
          <Link to={back.to} className="btn-quiet btn-sm -ml-2.5">
            <Icon name="arrow-left" size={16} />
            {back.label}
          </Link>
        )}
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 id={id} className="heading-headline break-words hyphens-auto">
          {title}
        </h1>
        {lede && <p className="lede max-w-[60ch]">{lede}</p>}
        {children}
      </div>
      {action}
    </header>
  )
}
