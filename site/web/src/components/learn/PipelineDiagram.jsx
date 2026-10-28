import Waveform from '../ui/Waveform.jsx'

/**
 * The pipeline as a picture (W12.12): the steps of /how-it-works as a signal
 * chain, each a link to its section. It reads left to right on a wide screen
 * (six across), two by three on a tablet and two across on a phone, so its
 * words keep their size everywhere instead of shrinking with a viewBox.
 *
 * Real text in an ordered list, so a screen reader hears the steps in order
 * and a search reads them; the figure is named by `title` and described by
 * `desc`. Over the chain runs the site's signature drawing, a waveform cut by
 * red lines (docs/design.md, section 1): it is decorative and hidden.
 *
 * `steps` is `[{ id, label }]`.
 */
export default function PipelineDiagram({ steps, title, desc }) {
  return (
    <figure aria-labelledby="pipeline-title" aria-describedby="pipeline-desc" className="panel overflow-hidden">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
        <span id="pipeline-title" className="label">
          {title}
        </span>
        <span id="pipeline-desc" className="sr-only">
          {desc}
        </span>
      </figcaption>
      {/* Across the six steps the red line falls where the steps below it start making red lines (Sections). */}
      <Waveform bars={120} lines={steps.length > 4 ? [4 / steps.length] : []} seed={5} className="hidden h-10 w-full pt-3 opacity-80 xl:block" />
      <ol className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-6 xl:border-t xl:border-line [&>li]:bg-surface">
        {steps.map((step, i) => (
          <li key={step.id}>
            <a
              href={`#step-${step.id}`}
              className="group flex h-full min-h-[5.5rem] flex-col justify-between gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-2 sm:px-5 focus-visible:-outline-offset-2"
            >
              <span className="flex items-center gap-2">
                <span className="readout text-caption font-medium text-accent">{String(i + 1).padStart(2, '0')}</span>
                {i < steps.length - 1 && <span aria-hidden="true" className="h-px flex-1 bg-line-strong transition-colors duration-150 group-hover:bg-accent" />}
              </span>
              <span className="text-label font-semibold leading-snug text-text">{step.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </figure>
  )
}
