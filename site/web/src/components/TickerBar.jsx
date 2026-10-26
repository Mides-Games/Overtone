import { useTranslation } from 'react-i18next'

/**
 * The signal strip across the top: the Mides ticker, made quiet. Monospaced,
 * dim, slow, and paused under the pointer. Its lines are the site's own
 * translated strings, so it makes no request.
 */
const REPEAT = 8 // the CSS moves the track by 1/8 of its width: exactly one set

export default function TickerBar() {
  const { t } = useTranslation()
  const items = t('ticker')
  if (!Array.isArray(items) || items.length === 0) return null

  const repeated = Array.from({ length: REPEAT }, () => items).flat()

  return (
    <div className="h-7 w-full select-none overflow-hidden border-b border-line bg-surface" aria-hidden="true">
      <div className="ticker-track h-full items-center">
        {repeated.map((text, i) => (
          <span key={i} className="inline-flex items-center whitespace-nowrap font-mono text-[11px] text-dim">
            <span className="mx-5 h-1 w-1 rounded-full bg-accent/70" />
            {text}
          </span>
        ))}
      </div>
    </div>
  )
}
