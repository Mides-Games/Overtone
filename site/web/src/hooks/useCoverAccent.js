import { useEffect, useState } from 'react'

import { accentFor, dominantColor, parseColor } from '../lib/cover-accent.js'
import { readCover } from '../lib/tags.js'

const cache = new WeakMap() // File -> Promise<[r, g, b] | null>

/**
 * The dominant colour of `file`'s cover (lib/tags.js `readCover`, the
 * picture the .osz takes), read once per file; null without one. The picture
 * is decoded at 32 pixels square by `createImageBitmap`, which also keeps it
 * clear of the page's `img-src` (no blob: URL is loaded). Never throws.
 */
export function coverColor(file) {
  if (!file) return Promise.resolve(null)
  if (!cache.has(file)) {
    const work = (async () => {
      try {
        const cover = await readCover(file)
        if (!cover || typeof createImageBitmap !== 'function') return null
        const bitmap = await createImageBitmap(new Blob([cover.bytes], { type: cover.mime }), { resizeWidth: 32, resizeHeight: 32, resizeQuality: 'low' })
        const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(32, 32) : Object.assign(document.createElement('canvas'), { width: 32, height: 32 })
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0, 32, 32)
        bitmap.close?.()
        return dominantColor(ctx.getImageData(0, 0, 32, 32).data)
      } catch {
        return null
      }
    })()
    cache.set(file, work)
  }
  return cache.get(file)
}

/** Whether the reader asked for high contrast, by the setting (W12.15) or the system's. */
export function wantsHighContrast() {
  if (document.documentElement.classList.contains('contrast-more')) return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-contrast: more)').matches
}

/** The theme's own colours, read from its tokens. */
function pageInks() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => parseColor(css.getPropertyValue(name))
  return { bg: v('--bg'), text: v('--text'), muted: v('--muted'), dim: v('--dim'), dark: document.documentElement.classList.contains('dark') }
}

/**
 * The header's accent (W13.24) for the song `file`: `{ ink, wash }` from
 * `accentFor`, or null (no file, no cover, a grey cover, high contrast).
 * Follows the theme and the contrast setting as they change.
 */
export function useCoverAccent(file) {
  const [rgb, setRgb] = useState(null)
  const [accent, setAccent] = useState(null)

  useEffect(() => {
    let live = true
    setRgb(null)
    coverColor(file).then((found) => live && setRgb(found))
    return () => {
      live = false
    }
  }, [file])

  useEffect(() => {
    if (!rgb) return setAccent(null)
    const update = () => setAccent(wantsHighContrast() ? null : accentFor(rgb, pageInks()))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-contrast: more)') : null
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [rgb])

  return accent
}
