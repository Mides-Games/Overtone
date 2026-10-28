import { Link } from 'react-router'

import BrandLoader from './BrandLoader.jsx'
import Icon from './ui/Icon.jsx'

/**
 * The page a sign-in or a link comes back to (/login/callback, /link/osu):
 * the page's heading, then either the loader and what is happening, or why
 * it did not work and the one way back. Narrow and quiet: it is on screen for
 * a second when all goes well.
 */
export default function ReturnPage({ title, working, failure, back }) {
  return (
    <div className="rise mx-auto max-w-md space-y-8 py-4 sm:py-10">
      <h1 className="heading-headline">{title}</h1>
      {failure ? (
        <div className="space-y-5 border-t border-line pt-6">
          <p role="alert" className="flex items-start gap-3 text-body text-text">
            <Icon name="close" size={18} className="mt-0.5 text-red" strokeWidth={2} />
            <span>{failure}</span>
          </p>
          <Link to={back.to} className="btn-primary">
            <Icon name="arrow-left" size={16} />
            {back.label}
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-4 border-t border-line pt-6">
          <BrandLoader />
          <p className="text-body text-muted">{working}</p>
        </div>
      )}
    </div>
  )
}
