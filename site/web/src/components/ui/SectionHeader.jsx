/**
 * A section's heading (docs/design.md, section 6): a mono eyebrow, a short
 * display heading the section is labelled by, an optional one-line lede, and
 * an optional action on the right (it wraps under the heading on a phone).
 *
 *   <section aria-labelledby="x">
 *     <SectionHeader id="x" eyebrow="How it works" title="Three steps" lede="..." action={<Link .../>} />
 *
 * `as` picks the heading level (h2 by default) so the page's outline stays in
 * order; the look does not change with it.
 */
export default function SectionHeader({ id, eyebrow, title, lede, action, as: Heading = 'h2', className = '' }) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-8 gap-y-3 ${className}`}>
      <div className="min-w-0 max-w-3xl space-y-3">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <Heading id={id} className="heading-section">
          {title}
        </Heading>
        {lede && <p className="lede max-w-[60ch]">{lede}</p>}
      </div>
      {action}
    </div>
  )
}
