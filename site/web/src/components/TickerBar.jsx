import { useTranslation } from 'react-i18next'

import { gutter } from '../lib/gutter.js'

/**
 * The status line above the bar: the Mides ticker, as an instrument's status
 * strip rather than a marquee. It used to scroll for ever; the motion rules
 * (docs/design.md, section 5) keep perpetual motion for the hero's playhead
 * alone, so the lines now stand still, as many as fit, fading out at the
 * right edge. It scrolls away with the page instead of riding with the bar,
 * and a phone, which needs the height more, does not draw it. Its lines are
 * the site's own translated strings, so it makes no request; they repeat what
 * the pages say, so it is hidden from screen readers.
 */
export default function TickerBar() {
  const { t } = useTranslation()
  const items = t('ticker')
  if (!Array.isArray(items) || items.length === 0) return null

  return (
    <div className="hidden border-b border-line md:block" aria-hidden="true">
      <div
        className="mx-auto flex h-8 max-w-[76rem] select-none items-center gap-7 overflow-hidden font-mono text-[11.5px] text-dim [mask-image:linear-gradient(to_right,black_80%,transparent)]"
        style={gutter}
      >
        {items.map((text, i) => (
          <span key={i} className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap">
            <span className={`h-2.5 w-0.5 rounded-full ${i === 0 ? 'bg-red' : 'bg-line-hover'}`} />
            {text}
          </span>
        ))}
      </div>
    </div>
  )
}
