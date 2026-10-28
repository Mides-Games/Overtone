/**
 * The pipeline as a picture (W12.12): one box per step of /how-it-works, top
 * to bottom, each a link to its section. Inline SVG drawn with the theme's
 * tokens (Tailwind's fill-/stroke- utilities over the CSS variables), so it
 * follows dark and light like the rest of the page, and its text is real text
 * a screen reader and a search can read. Vertical because it has to fit a
 * 375 px phone without shrinking its words.
 *
 * `steps` is `[{ id, label }]`; `title` and `desc` name the figure.
 */
const W = 320
const BOX_H = 44
const GAP = 22

export default function PipelineDiagram({ steps, title, desc }) {
  const height = steps.length * BOX_H + (steps.length - 1) * GAP + 8
  return (
    <figure className="mx-auto w-full max-w-[22rem]">
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="group" aria-labelledby="pipeline-title pipeline-desc" className="block">
        <title id="pipeline-title">{title}</title>
        <desc id="pipeline-desc">{desc}</desc>
        <defs>
          <marker id="pipeline-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className="fill-dim" />
          </marker>
        </defs>
        {steps.map((step, i) => {
          const y = 4 + i * (BOX_H + GAP)
          const last = i === steps.length - 1
          return (
            <g key={step.id}>
              {!last && (
                <line
                  x1={W / 2}
                  y1={y + BOX_H + 2}
                  x2={W / 2}
                  y2={y + BOX_H + GAP - 6}
                  className="stroke-dim"
                  strokeWidth="1.5"
                  markerEnd="url(#pipeline-arrow)"
                />
              )}
              <a href={`#step-${step.id}`} className="group">
                <rect
                  x="8"
                  y={y}
                  width={W - 16}
                  height={BOX_H}
                  rx="8"
                  className="fill-surface stroke-line-strong transition group-hover:stroke-accent group-focus-visible:stroke-accent"
                  strokeWidth="1.5"
                />
                <circle cx="34" cy={y + BOX_H / 2} r="12" className="fill-accent/15 stroke-accent" strokeWidth="1" />
                <text x="34" y={y + BOX_H / 2} dy="0.35em" textAnchor="middle" className="fill-accent font-mono text-[12px] font-semibold">
                  {i + 1}
                </text>
                <text x="58" y={y + BOX_H / 2} dy="0.35em" className="fill-text font-display text-[14px] font-semibold">
                  {step.label}
                </text>
              </a>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
