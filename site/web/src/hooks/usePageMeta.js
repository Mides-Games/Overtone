import { useEffect } from 'react'

import { applyPageMeta, pageTitle } from '../lib/meta.js'

/**
 * Names the page in the tab and in the description tags (W10.3). Pass the
 * translated strings, so a language switch renames the tab too. Returns the
 * full title, for a page that decorates it (Analyze counts a batch in it).
 */
export default function usePageMeta(title, description) {
  useEffect(() => {
    applyPageMeta(document, { title, description })
  }, [title, description])
  return pageTitle(title)
}
