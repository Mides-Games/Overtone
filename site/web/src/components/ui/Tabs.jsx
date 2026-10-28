import { useRef } from 'react'

/**
 * A row of tabs over one panel (docs/design.md, sections 6 and 11): sentence
 * case, the selected one underlined in the accent, a hairline under the row.
 * The page keeps which tab is open (usually in the address, `?tab=`); this
 * draws the row and moves between tabs with the arrow keys, Home and End, as
 * the ARIA tabs pattern does, with only the selected tab in the tab order.
 *
 *   <Tabs id="community" label={title} tabs={[{ key, label }]} value={tab} onChange={setTab} />
 *   <section role="tabpanel" id={`community-panel-${tab}`} aria-labelledby={`community-tab-${tab}`}>...</section>
 *
 * The underline moves by opacity and scale, not by width (section 5).
 */
export default function Tabs({ id, label, tabs, value, onChange, className = '' }) {
  const refs = useRef({})

  function onKeyDown(event) {
    const at = tabs.findIndex((tab) => tab.key === value)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key]
    if (to === undefined) return
    event.preventDefault()
    const next = tabs[(to + tabs.length) % tabs.length]
    onChange(next.key)
    refs.current[next.key]?.focus()
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`flex gap-1 overflow-x-auto border-b border-line ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.key === value
        return (
          <button
            key={tab.key}
            ref={(element) => {
              refs.current[tab.key] = element
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`${id}-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            // The ring sits inside: the row scrolls sideways, which would clip one outside.
            className={`group relative inline-flex h-11 shrink-0 items-center gap-2 rounded-t-control px-3 focus-visible:-outline-offset-2 text-body font-medium transition-colors duration-150 ease-out ${
              selected ? 'text-text' : 'text-muted hover:text-text'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && <span className="readout text-caption text-dim">{tab.count}</span>}
            <span
              aria-hidden="true"
              className={`absolute inset-x-3 -bottom-px h-0.5 origin-center rounded-full bg-accent transition-[opacity,transform] duration-150 ease-out ${
                selected ? 'scale-x-100 opacity-100' : 'scale-x-50 opacity-0'
              }`}
            />
          </button>
        )
      })}
    </div>
  )
}
