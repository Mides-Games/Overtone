import { useTranslation } from 'react-i18next'

import { gutter } from '../lib/gutter.js'

/**
 * The status line above the bar: the Mides ticker, running leftwards for ever
 * (index.css, `.ticker-track`). Its lines are drawn twice so the loop has no
 * seam; a pointer over it pauses it and reduced motion keeps it still. It
 * scrolls away with the page instead of riding with the bar, and a phone,
 * which needs the height more, does not draw it. Its lines are the site's own
 * translated strings, so it makes no request; they repeat what the pages say,
 * so it is hidden from screen readers.
 */
export default function TickerBar() {
  const { t } = useTranslation()
  const items = t('ticker')
  if (!Array.isArray(items) || items.length === 0) return null

  const line = (copy) =>
    items.map((text, i) => (
      <span key={`${copy}-${i}`} className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap pr-7">
        <span className={`h-2.5 w-0.5 rounded-full ${i === 0 ? 'bg-red' : 'bg-line-hover'}`} />
        {text}
      </span>
    ))

  return (
    <div className="ticker hidden border-b border-line md:block" aria-hidden="true">
      <div
        className="mx-auto flex h-8 max-w-[76rem] select-none items-center overflow-hidden font-mono text-[11.5px] text-dim [mask-image:linear-gradient(to_right,transparent,black_4%,black_90%,transparent)]"
        style={gutter}
      >
        <div className="ticker-track flex w-max shrink-0" style={{ animationDuration: `${items.length * 14}s` }}>
          {line('a')}
          {line('b')}
        </div>
      </div>
    </div>
  )
}
