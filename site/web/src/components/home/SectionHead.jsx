/**
 * A front-page section's heading: the small-caps eyebrow, the h2 the section
 * is labelled by, and an optional link on the right (wraps under it on a
 * phone).
 */
export default function SectionHead({ id, eyebrow, title, children }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 space-y-2">
        <p className="label text-accent">{eyebrow}</p>
        <h2 id={id} className="font-display text-[clamp(1.4rem,1.1rem+1.2vw,2rem)] font-bold uppercase leading-tight tracking-[-0.005em]">
          {title}
        </h2>
      </div>
      {children}
    </div>
  )
}
