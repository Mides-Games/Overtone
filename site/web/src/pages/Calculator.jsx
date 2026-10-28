import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'
import {
  arrowStep,
  bpmForDrift,
  bpmFromMs,
  bpmFromSpan,
  calculatorSeed,
  drift,
  firstBeatOffset,
  lineOffset,
  msPerBeat,
  msToTicks,
  parseNumber,
  readout,
  stepValue,
  tickMs,
  ticksToMs,
} from '../lib/calc.js'

/**
 * The timing calculator (W13.9): five small calculators a mapper reaches for,
 * all live as the fields change, the arithmetic in lib/calc.js. Keyboard
 * first: the first field has the focus, Tab walks the fields in reading
 * order, the arrow keys step the field in hand (Shift ×10, Alt ×0.1), and a
 * result is a button that copies its number. A link may fill in a red line's
 * BPM and offset (`?bpm=&offset=`, the result page's link); nothing is sent
 * anywhere and nothing is kept.
 */
const DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16]

/** A number as a field's text after a conversion: 6 decimals at most, no trailing zeros. */
const asField = (x) => (x === null ? '' : String(Number(x.toFixed(6))))

export default function Calculator() {
  const { t } = useTranslation()
  usePageMeta(t('calculator.title'), t('calculator.description'))
  const { search } = useLocation()
  const seed = useMemo(() => calculatorSeed(search), [search])

  return (
    <article className="rise mx-auto max-w-5xl space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('calculator.title')}</h1>
        <p className="max-w-[72ch] text-body leading-relaxed text-muted">{t('calculator.intro')}</p>
        <p className="max-w-[72ch] text-caption text-dim">{t('calculator.keys')}</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <BpmMs seed={seed} />
        <Ticks seed={seed} />
        <TwoLines seed={seed} />
        <Drift seed={seed} />
        <FromSpan />
      </div>
    </article>
  )
}

function Panel({ title, intro, children }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="panel space-y-4 p-4">
      <div className="space-y-1">
        <h2 id={id} className="font-display text-title font-bold">
          {title}
        </h2>
        {intro && <p className="text-caption text-dim">{intro}</p>}
      </div>
      {children}
    </section>
  )
}

/** A number field: text, so a comma works as a decimal point; the arrows step it. */
function Field({ label, value, onChange, unit, step = 1, autoFocus = false }) {
  const id = useId()
  const ref = useRef(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  const bad = value.trim() !== '' && parseNumber(value) === null
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="label block">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={bad || undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            onChange(stepValue(value, (e.key === 'ArrowUp' ? 1 : -1) * arrowStep(e, step)))
          }}
          className={`field readout min-w-0 ${bad ? 'border-red' : ''}`}
        />
        {unit && <span className="shrink-0 text-caption text-dim">{unit}</span>}
      </div>
    </div>
  )
}

/** A result: a button that copies its number (ASCII minus, no unit). */
function Readout({ label, value, digits = 3, unit, note }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const text = readout(value, digits)
  const plain = text.replace('−', '-')
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-t border-line pt-2">
      <span className="min-w-0 text-label text-muted">
        {label}
        {note && <span className="block text-caption text-dim">{note}</span>}
      </span>
      <button
        type="button"
        disabled={text === '–'}
        aria-label={t('calculator.copy', { label, value: `${plain}${unit ? ` ${unit}` : ''}` })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(plain)
            setCopied(true)
          } catch {
            // No clipboard (an insecure page, a refusal): the number is on screen to select.
          }
        }}
        className="readout shrink-0 rounded-control px-1.5 py-0.5 text-right text-body text-text transition hover:bg-surface-2 disabled:cursor-default disabled:text-dim disabled:hover:bg-transparent"
      >
        {copied ? (
          <span className="text-accent" role="status">
            {t('calculator.copied')}
          </span>
        ) : (
          <>
            {text}
            {unit && text !== '–' && <span className="ml-1 text-caption text-dim">{unit}</span>}
          </>
        )}
      </button>
    </div>
  )
}

const num = (text) => parseNumber(text)

function BpmMs({ seed }) {
  const { t } = useTranslation()
  const [bpm, setBpm] = useState(seed.bpm || '120')
  const [ms, setMs] = useState(() => asField(msPerBeat(num(seed.bpm || '120'))))
  const beat = msPerBeat(num(bpm))
  return (
    <Panel title={t('calculator.bpmMs.title')}>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t('calculator.bpmMs.bpm')}
          unit="BPM"
          value={bpm}
          autoFocus
          onChange={(text) => {
            setBpm(text)
            setMs(asField(msPerBeat(num(text))))
          }}
        />
        <Field
          label={t('calculator.bpmMs.ms')}
          unit="ms"
          value={ms}
          onChange={(text) => {
            setMs(text)
            setBpm(asField(bpmFromMs(num(text))))
          }}
        />
      </div>
      <div className="space-y-2">
        <Readout label={t('calculator.bpmMs.beat')} value={beat} unit="ms" />
        <Readout label={t('calculator.bpmMs.exactBpm')} value={beat === null ? null : bpmFromMs(beat)} digits={6} unit="BPM" />
        <Readout label={t('calculator.bpmMs.bar')} value={beat === null ? null : beat * 4} unit="ms" />
        <Readout label={t('calculator.bpmMs.quarter')} value={tickMs(num(bpm), 4)} unit="ms" />
      </div>
    </Panel>
  )
}

function Ticks({ seed }) {
  const { t } = useTranslation()
  const [bpm, setBpm] = useState(seed.bpm || '120')
  const [divisor, setDivisor] = useState(4)
  const [span, setSpan] = useState('1000')
  const [count, setCount] = useState('1')
  const divisorId = useId()
  const out = msToTicks(num(span), num(bpm), divisor)
  return (
    <Panel title={t('calculator.ticks.title')}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('calculator.ticks.bpm')} unit="BPM" value={bpm} onChange={setBpm} />
        <div className="space-y-1">
          <label htmlFor={divisorId} className="label block">
            {t('calculator.ticks.divisor')}
          </label>
          <select id={divisorId} value={divisor} onChange={(e) => setDivisor(Number(e.target.value))} className="field readout">
            {DIVISORS.map((d) => (
              <option key={d} value={d}>
                1/{d}
              </option>
            ))}
          </select>
        </div>
        <Field label={t('calculator.ticks.span')} unit="ms" value={span} onChange={setSpan} />
        <Field label={t('calculator.ticks.count')} value={count} onChange={setCount} />
      </div>
      <div className="space-y-2">
        <Readout label={t('calculator.ticks.tick')} value={tickMs(num(bpm), divisor)} unit="ms" />
        <Readout label={t('calculator.ticks.ticks')} value={out.ticks} digits={4} />
        <Readout label={t('calculator.ticks.nearest')} value={out.nearest} digits={0} note={t('calculator.ticks.off', { ms: readout(out.offMs, 3) })} />
        <Readout label={t('calculator.ticks.toMs')} value={ticksToMs(num(count), num(bpm), divisor)} unit="ms" />
      </div>
    </Panel>
  )
}

function TwoLines({ seed }) {
  const { t } = useTranslation()
  const [from, setFrom] = useState(seed.offset || '0')
  const [bpm, setBpm] = useState(seed.bpm || '120')
  const [to, setTo] = useState('')
  const [meter, setMeter] = useState('4')
  const out = lineOffset(num(from), num(bpm), num(to), num(meter))
  return (
    <Panel title={t('calculator.lines.title')} intro={t('calculator.lines.intro')}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('calculator.lines.from')} unit="ms" value={from} onChange={setFrom} />
        <Field label={t('calculator.lines.bpm')} unit="BPM" value={bpm} onChange={setBpm} />
        <Field label={t('calculator.lines.to')} unit="ms" value={to} onChange={setTo} />
        <Field label={t('calculator.lines.meter')} value={meter} onChange={setMeter} />
      </div>
      <div className="space-y-2">
        <Readout label={t('calculator.lines.span')} value={out.spanMs} unit="ms" />
        <Readout label={t('calculator.lines.beats')} value={out.beats} digits={4} />
        <Readout label={t('calculator.lines.bars')} value={out.bars} digits={4} />
        <Readout label={t('calculator.lines.nearest')} value={out.nearestBeat} digits={0} />
        <Readout label={t('calculator.lines.off')} value={out.offMs} unit="ms" note={t('calculator.lines.offNote')} />
        <Readout label={t('calculator.lines.earliest')} value={firstBeatOffset(num(from), num(bpm))} unit="ms" />
      </div>
    </Panel>
  )
}

function Drift({ seed }) {
  const { t } = useTranslation()
  const [right, setRight] = useState(seed.bpm || '120')
  const [mapped, setMapped] = useState(seed.bpm ? asField(num(seed.bpm) + 0.01) : '120.01')
  const [bars, setBars] = useState('32')
  const [meter, setMeter] = useState('4')
  const [allowed, setAllowed] = useState('5')
  const out = drift(num(right), num(mapped), num(bars), num(meter))
  const range = bpmForDrift(num(right), num(allowed), num(bars), num(meter))
  return (
    <Panel title={t('calculator.drift.title')} intro={t('calculator.drift.intro')}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('calculator.drift.right')} unit="BPM" value={right} onChange={setRight} />
        <Field label={t('calculator.drift.mapped')} unit="BPM" value={mapped} onChange={setMapped} step={0.01} />
        <Field label={t('calculator.drift.bars')} value={bars} onChange={setBars} />
        <Field label={t('calculator.drift.meter')} value={meter} onChange={setMeter} />
      </div>
      <div className="space-y-2">
        <Readout label={t('calculator.drift.total')} value={out.driftMs} unit="ms" note={t('calculator.drift.sign')} />
        <Readout label={t('calculator.drift.perBar')} value={out.perBarMs} unit="ms" />
      </div>
      <Field label={t('calculator.drift.allowed')} unit="ms" value={allowed} onChange={setAllowed} />
      <div className="space-y-2">
        <Readout label={t('calculator.drift.slower')} value={range.slower} digits={6} unit="BPM" />
        <Readout label={t('calculator.drift.faster')} value={range.faster} digits={6} unit="BPM" />
        <Readout label={t('calculator.drift.precision')} value={range.bpmDelta} digits={6} unit="BPM" />
      </div>
    </Panel>
  )
}

function FromSpan() {
  const { t } = useTranslation()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [beats, setBeats] = useState('16')
  const out = bpmFromSpan(num(start), num(end), num(beats))
  return (
    <Panel title={t('calculator.span.title')} intro={t('calculator.span.intro')}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('calculator.span.start')} unit="ms" value={start} onChange={setStart} />
        <Field label={t('calculator.span.end')} unit="ms" value={end} onChange={setEnd} />
        <Field label={t('calculator.span.beats')} value={beats} onChange={setBeats} />
      </div>
      <div className="space-y-2">
        <Readout label={t('calculator.span.bpm')} value={out.bpm} digits={6} unit="BPM" />
        <Readout label={t('calculator.span.beat')} value={out.beatMs} unit="ms" />
      </div>
    </Panel>
  )
}
