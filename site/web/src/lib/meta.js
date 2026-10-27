import { useEffect } from 'react'

/**
 * A page's title and its description tags while it is shown, put back as
 * they were when it goes. For a timing's page (W3.27) the server writes the
 * same tags into the HTML it serves (deploy/web/serve.mjs), for the link
 * previewers that never run this script; this keeps a tab's title and a
 * page navigated to inside the app in step with it.
 */
const TAGS = [
  ['name', 'description'],
  ['property', 'og:title'],
  ['property', 'og:description'],
]

export function useDocumentMeta({ title, description } = {}) {
  useEffect(() => {
    if (!title) return undefined
    const before = document.title
    const restored = []
    document.title = title
    for (const [attr, key] of TAGS) {
      let tag = document.head.querySelector(`meta[${attr}="${key}"]`)
      const created = !tag
      if (created) {
        tag = document.createElement('meta')
        tag.setAttribute(attr, key)
        document.head.appendChild(tag)
      }
      restored.push({ tag, created, content: tag.getAttribute('content') })
      tag.setAttribute('content', key.endsWith('title') ? title : (description ?? ''))
    }
    return () => {
      document.title = before
      for (const { tag, created, content } of restored) {
        if (created) tag.remove()
        else tag.setAttribute('content', content ?? '')
      }
    }
  }, [title, description])
}
