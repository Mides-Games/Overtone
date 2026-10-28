import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import Icon from './Icon.jsx'

/**
 * The long-form pages' frame (docs/design.md, section 11): the legal pages,
 * how it works, the FAQ, the glossary, the credits. A header like a section
 * header but with the page's one h1, then the text at a reading measure
 * (`.prose`, about 70ch) with, on a wide screen, a contents list that stays
 * beside it and marks the section in view.
 *
 *   <DocHeader eyebrow="Legal" title="Terms of use" lede="..." >{notes}</DocHeader>
 *   <DocLayout contents={<Contents label="Contents" items={[{ id, label }]} />}>...</DocLayout>
 */
export function DocHeader({ eyebrow, title, lede, children, className = '' }) {
  return (
    <header className={`max-w-[70ch] space-y-4 ${className}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 className="heading-headline break-words hyphens-auto">{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </header>
  )
}

/**
 * The text beside its contents. Without contents (a short page, or a phone)
 * the text simply takes the column; the list is not drawn below 1024 px,
 * where it would push the text a screen down.
 */
export function DocLayout({ contents, children, className = '' }) {
  return (
    <div className={`mt-12 border-t border-line pt-10 lg:grid lg:grid-cols-12 lg:gap-x-10 ${className}`}>
      {contents && <div className="hidden lg:col-span-3 lg:block">{contents}</div>}
      <div className={`min-w-0 ${contents ? 'lg:col-span-9' : 'lg:col-span-12'}`}>{children}</div>
    </div>
  )
}

/**
 * Which of `ids` is being read: the last whose top has passed a line a third
 * of the way down the screen. Scroll and resize are read once a frame.
 */
function useCurrent(ids) {
  const [current, setCurrent] = useState(ids[0] ?? null)
  const key = ids.join('|')
  useEffect(() => {
    const list = key ? key.split('|') : []
    if (!list.length) return undefined
    let frame = 0
    const read = () => {
      frame = 0
      const line = window.innerHeight / 3
      let at = list[0]
      for (const id of list) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) at = id
      }
      // At the very bottom the last short sections can never reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) at = list.at(-1)
      setCurrent(at)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [key])
  return current
}

/** The sticky contents list: `items` is `[{ id, label, number? }]`. */
export function Contents({ label, items }) {
  const current = useCurrent(items.map((item) => item.id))
  return (
    <nav aria-label={label} className="sticky top-[calc(var(--bar-height)+32px)] max-h-[calc(100vh-var(--bar-height)-64px)] overflow-y-auto pb-4">
      <p className="label pb-3">{label}</p>
      <ol className="border-l border-line text-label">
        {items.map((item) => {
          const here = item.id === current
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={here ? 'location' : undefined}
                className={`-ml-px flex gap-2.5 border-l-2 py-1.5 pl-3.5 leading-snug transition-colors duration-150 ${
                  here ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
                }`}
              >
                {item.number && <span className="readout shrink-0 text-dim">{item.number}</span>}
                <span className="min-w-0">{item.label}</span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Links onward at the end of a section or a page: `links` is `[{ to, label }]`,
 * each a quiet button with the arrow icon (no → character, section 11).
 */
export function NextLinks({ links, className = '' }) {
  if (!links?.length) return null
  return (
    <p className={`-ml-2.5 flex flex-wrap gap-x-1 gap-y-1 ${className}`}>
      {links.map((link) => (
        <Link key={link.to} to={link.to} className="btn-quiet btn-sm group">
          {link.label}
          <Icon name="arrow-right" size={15} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
        </Link>
      ))}
    </p>
  )
}
