/**
 * The tempo map's painting, apart from its React shell (TempoMap.jsx): pure
 * functions of a 2-D context, a layout and the data, so a frame is cheap to
 * reason about. Lanes, top to bottom, as the desktop Timing view had them:
 * the red lines' chips, the tempo plot (local tempo, the lines' BPM, each
 * section's confidence along its foot), the waveform with the onsets and the
 * beat grid, the drift lane, the ruler.
 */
import { BAR, formatBpm, formatRuler, lowerBound, SUB } from '../../lib/timing.js'

export const MONO = "11px 'Cascadia Mono', 'Cascadia Code', 'SF Mono', Consolas, ui-monospace, monospace"
export const DRIFT_RANGE_MS = 30
const CHIP_H = 19

/** The theme's tokens (index.css), read when the theme changes. */
export function readPalette() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => css.getPropertyValue(name).trim()
  const dark = document.documentElement.classList.contains('dark')
  return {
    dark,
    bg: v('--bg'),
    surface: v('--surface'),
    lane: v('--surface-2'),
    lane2: v('--surface-3'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    text: v('--text'),
    muted: v('--muted'),
    dim: v('--dim'),
    accent: v('--accent'),
    red: v('--red'),
    redInk: dark ? '#22070b' : '#ffffff',
    amber: v('--amber'),
    lavender: v('--lavender'),
    compare: v('--compare'),
    onset: v('--onset'),
    grid: v('--grid'),
  }
}

export const LEVEL_TONE = { high: 'accent', medium: 'lavender', check: 'amber' }

/** Lane positions for a canvas `width` CSS pixels wide. */
export function layout(width) {
  const compact = width < 640
  const x0 = compact ? 30 : 46
  const x1 = Math.max(x0 + 10, width - 8)
  let y = CHIP_H * 2 + 6
  const tempoTop = y
  y += compact ? 70 : 104
  const tempoBottom = y
  y += 6
  const waveTop = y
  y += compact ? 66 : 88
  const waveBottom = y
  y += 6
  const driftTop = y
  y += compact ? 32 : 42
  const driftBottom = y
  const height = y + 20
  return { compact, width, height, x0, x1, tempoTop, tempoBottom, waveTop, waveBottom, driftTop, driftBottom }
}

export function niceStep(span, target) {
  const raw = span / Math.max(target, 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** The BPM range the tempo plot shows: robust to a few wild local readings, always holding every line. */
export function tempoRange(lines, beats, factor) {
  const bpms = (beats?.bpm ?? []).filter((b) => b > 0).map((b) => b * factor).sort((a, b) => a - b)
  const lineBpms = lines.map((l) => l.bpm)
  let lo = bpms.length ? bpms[Math.floor(bpms.length * 0.02)] : Math.min(...lineBpms)
  let hi = bpms.length ? bpms[Math.floor(bpms.length * 0.98)] : Math.max(...lineBpms)
  lo = Math.min(lo, ...lineBpms)
  hi = Math.max(hi, ...lineBpms)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 }
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2
    lo = mid - 2
    hi = mid + 2
  }
  const pad = (hi - lo) * 0.14
  return { lo: lo - pad, hi: hi + pad }
}

let hatch = { ink: null, pattern: null }
function hatchFill(ctx, ink) {
  if (hatch.ink !== ink || !hatch.pattern) {
    const tile = document.createElement('canvas')
    tile.width = tile.height = 8
    const g = tile.getContext('2d')
    g.strokeStyle = ink
    g.lineWidth = 1.2
    g.beginPath()
    for (const d of [-8, 0, 8]) {
      g.moveTo(d, 8)
      g.lineTo(d + 8, 0)
    }
    g.stroke()
    hatch = { ink, pattern: ctx.createPattern(tile, 'repeat') }
  }
  return hatch.pattern
}

/**
 * The static layer: everything but the playhead, the hover cursor and the
 * loop. `d` carries the data: lines (adjusted), sections, grid, clicks and subdivision, beats,
 * onsets, drift, envelope, peaks, swing, hints, factor, selected, hovered,
 * and other: another timing's red lines to draw beside them, or null.
 */
export function paintMap(ctx, L, view, d, c) {
  const { x0, x1 } = L
  const span = view.b - view.a
  const X = (s) => x0 + ((s - view.a) / span) * (x1 - x0)
  const lanes = [
    [L.tempoTop, L.tempoBottom],
    [L.waveTop, L.waveBottom],
    [L.driftTop, L.driftBottom],
  ]
  ctx.clearRect(0, 0, L.width, L.height)

  // Lane panels.
  ctx.fillStyle = c.lane
  for (const [a, b] of lanes) {
    roundRect(ctx, x0, a, x1 - x0, b - a, 6)
    ctx.fill()
  }
  ctx.save()
  ctx.beginPath()
  for (const [a, b] of lanes) ctx.rect(x0, a, x1 - x0, b - a)
  ctx.clip()

  const top = L.tempoTop
  const foot = L.driftBottom
  const bounds = d.lines.map((l) => l.timeMs / 1000).concat([d.durationS])

  // Sections: the selected one lit, every other one faintly shaded.
  d.lines.forEach((_, i) => {
    const a = X(bounds[i])
    const b = X(bounds[i + 1])
    if (b < x0 || a > x1) return
    if (i === d.selected) {
      ctx.globalAlpha = c.dark ? 0.1 : 0.08
      ctx.fillStyle = c.accent
      ctx.fillRect(a, top, b - a, foot - top)
      ctx.globalAlpha = 1
    } else if (i % 2 === 1) {
      ctx.fillStyle = c.grid
      ctx.fillRect(a, top, b - a, foot - top)
    }
  })
  // Before the first red line osu! runs its grid backwards: it holds only if the intro keeps that tempo.
  if (bounds.length > 1 && bounds[0] > view.a) {
    ctx.fillStyle = hatchFill(ctx, c.grid)
    ctx.fillRect(X(view.a), top, Math.min(X(bounds[0]), x1) - X(view.a), foot - top)
  }

  // The beat grid once beats are far enough apart to read; zoomed out past that, the bars alone.
  const gt = d.grid.t
  const gl = d.grid.level
  const pxPerS = (x1 - x0) / span
  // The densest line decides, so no part of the view turns into a solid block.
  const beatPx = d.lines.length ? (Math.min(...d.lines.map((l) => l.beatMs)) / 1000) * pxPerS : 0
  const barPx = d.lines.length ? beatPx * Math.min(...d.lines.map((l) => l.meter)) : 0
  const showBeats = beatPx >= 7
  const showBars = barPx >= 9
  // The subdivisions the clicks play (W12.6), once they too are far enough apart: dashed and
  // drawn first, so a beat stays a beat on top of them.
  const sub = d.subdivision ?? 1
  if (sub > 1 && d.clicks && beatPx / sub >= 7) {
    const ct = d.clicks.t
    const cl = d.clicks.level
    ctx.strokeStyle = c.line
    ctx.lineWidth = 1
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    for (let i = lowerBound(ct, view.a); i < ct.length && ct[i] <= view.b; i++) {
      if (cl[i] !== SUB) continue
      const x = Math.round(X(ct[i])) + 0.5
      ctx.moveTo(x, top)
      ctx.lineTo(x, L.waveBottom)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (showBars) {
    for (let i = lowerBound(gt, view.a); i < gt.length && gt[i] <= view.b; i++) {
      if (gl[i] !== BAR && !showBeats) continue
      const x = Math.round(X(gt[i])) + 0.5
      ctx.strokeStyle = gl[i] === BAR ? c.lineStrong : c.line
      ctx.lineWidth = gl[i] === BAR ? 1.2 : 1
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, L.waveBottom)
      ctx.stroke()
    }
  }

  // Tempo plot: horizontal guides, the local tempo, the lines' BPM.
  const { lo, hi } = d.range
  const Y = (b) => L.tempoBottom - 7 - ((b - lo) / (hi - lo)) * (L.tempoBottom - 7 - (L.tempoTop + 4))
  const ystep = niceStep(hi - lo, L.compact ? 3 : 4)
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  for (let b = Math.ceil(lo / ystep) * ystep; b <= hi; b += ystep) {
    const y = Math.round(Y(b)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
  }
  const bt = d.beats?.t_ms ?? []
  const bb = d.beats?.bpm ?? []
  if (bt.length > 1 && bb.length === bt.length) {
    const from = Math.max(0, lowerBound(bt, view.a * 1000) - 1)
    const to = Math.min(bt.length, lowerBound(bt, view.b * 1000) + 1)
    ctx.beginPath()
    let started = false
    for (let i = from; i < to; i++) {
      const x = X(bt[i] / 1000)
      const y = Y(Math.min(Math.max(bb[i] * d.factor, lo), hi))
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    if (started) {
      ctx.lineWidth = 1.6
      ctx.lineJoin = 'round'
      ctx.strokeStyle = c.lavender
      ctx.stroke()
      ctx.lineTo(X(bt[to - 1] / 1000), L.tempoBottom)
      ctx.lineTo(X(bt[from] / 1000), L.tempoBottom)
      ctx.closePath()
      ctx.globalAlpha = 0.1
      ctx.fillStyle = c.lavender
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }
  ctx.strokeStyle = c.red
  ctx.lineWidth = 2
  d.lines.forEach((line, i) => {
    const a = Math.max(X(bounds[i]), x0)
    const b = Math.min(X(bounds[i + 1]), x1)
    if (b <= a) return
    const y = Math.round(Y(line.bpm)) + 0.5
    ctx.beginPath()
    ctx.moveTo(a, y)
    ctx.lineTo(b, y)
    ctx.stroke()
  })
  // The other timing's BPM (W12.10, W12.11), dashed so it reads apart even where the two coincide.
  const other = d.other?.length ? d.other : null
  if (other) {
    const ends = other.map((l) => l.timeMs / 1000).concat([d.durationS])
    ctx.strokeStyle = c.compare
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    other.forEach((line, i) => {
      const a = Math.max(X(ends[i]), x0)
      const b = Math.min(X(ends[i + 1]), x1)
      if (b <= a) return
      const y = Math.round(Y(Math.min(Math.max(line.bpm, lo), hi))) + 0.5
      ctx.beginPath()
      ctx.moveTo(a, y)
      ctx.lineTo(b, y)
      ctx.stroke()
    })
    ctx.setLineDash([])
  }

  // Each section's level along the plot's foot, a pixel apart at each line.
  d.lines.forEach((line, i) => {
    const a = Math.max(X(bounds[i]), x0)
    const b = Math.min(X(bounds[i + 1]), x1)
    if (b <= a) return
    const level = d.sections[line.index]?.level
    ctx.fillStyle = c[LEVEL_TONE[level] ?? 'dim']
    ctx.fillRect(a, L.tempoBottom - 5, Math.max(1, b - a - 1), 4)
  })

  // The engine's half/double-time hints: evidence, never a red line.
  for (const hint of d.hints) {
    const a = Math.max(X(hint.from_ms / 1000), x0)
    const b = Math.min(X(hint.to_ms / 1000), x1)
    if (b > a) {
      ctx.globalAlpha = 0.5
      ctx.fillStyle = c.amber
      ctx.fillRect(a, L.tempoTop + 2, b - a, 3)
      ctx.globalAlpha = 1
    }
    const at = X(hint.boundary_ms / 1000)
    if (at >= x0 && at <= x1) {
      ctx.strokeStyle = c.amber
      ctx.lineWidth = 1.2
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(Math.round(at) + 0.5, L.tempoTop)
      ctx.lineTo(Math.round(at) + 0.5, L.tempoBottom - 6)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // Waveform from the decoded song, or the engine's onset envelope until there is one.
  const wmid = (L.waveTop + L.waveBottom) / 2 + 3
  const wh = (L.waveBottom - L.waveTop) / 2 - 6
  if (d.peaks) {
    const perPx = span / (x1 - x0)
    const level = perPx / d.peaks.secondsPerBin > 32 ? d.peaks.coarse : d.peaks
    const { min, max, secondsPerBin } = level
    ctx.fillStyle = c.dim
    ctx.globalAlpha = 0.75
    for (let px = Math.floor(x0); px < x1; px++) {
      const s0 = view.a + (px - x0) * perPx
      const i0 = Math.max(0, Math.floor(s0 / secondsPerBin))
      if (i0 >= min.length) break
      const i1 = Math.min(min.length, Math.max(i0 + 1, Math.ceil((s0 + perPx) / secondsPerBin)))
      let mn = 0
      let mx = 0
      for (let i = i0; i < i1; i++) {
        if (min[i] < mn) mn = min[i]
        if (max[i] > mx) mx = max[i]
      }
      ctx.fillRect(px, wmid - mx * wh, 1, Math.max(1, (mx - mn) * wh))
    }
    ctx.globalAlpha = 1
  } else if (d.envelope?.v?.length) {
    const v = d.envelope.v
    const per = d.envelope.span_ms / 1000 / v.length
    ctx.fillStyle = c.onset
    const i0 = Math.max(0, Math.floor(view.a / per))
    const i1 = Math.min(v.length, Math.ceil(view.b / per) + 1)
    const w = Math.max(1, per * pxPerS)
    for (let i = i0; i < i1; i++) {
      const h = (v[i] / 100) * wh
      if (h >= 0.6) ctx.fillRect(X(i * per), wmid - h, w, 2 * h)
    }
  }

  // Onsets: a tick from the waveform lane's top per attack the grid was fitted to, as tall as it is strong.
  const ot = d.onsets?.t_ms ?? []
  const ow = d.onsets?.w ?? []
  if (ot.length) {
    ctx.fillStyle = c.accent
    for (let i = lowerBound(ot, view.a * 1000); i < ot.length && ot[i] <= view.b * 1000; i++) {
      ctx.globalAlpha = 0.35 + 0.55 * (ow[i] / 100)
      ctx.fillRect(Math.round(X(ot[i] / 1000)), L.waveTop + 1, 1, 3 + 7 * (ow[i] / 100))
    }
    ctx.globalAlpha = 1
  }

  // Swing: where the engine heard the off-beat eighth land late.
  ctx.font = MONO
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  for (const s of d.swing) {
    const a = Math.max(X(s.start_ms / 1000), x0)
    const b = Math.min(X(s.end_ms / 1000), x1)
    if (b <= a) continue
    ctx.fillStyle = c.lavender
    ctx.fillRect(a, L.waveBottom - 3, b - a, 2)
    if (b - a > 70) ctx.fillText(`${s.feel}${s.snap ? ` ${s.snap}` : ''}`, a + 4, L.waveBottom - 6)
  }

  // Drift lane: each attack's distance from the grid osu! will play.
  const dmid = Math.round((L.driftTop + L.driftBottom) / 2) + 0.5
  const dh = (L.driftBottom - L.driftTop) / 2 - 3
  ctx.strokeStyle = c.lineStrong
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x0, dmid)
  ctx.lineTo(x1, dmid)
  ctx.stroke()
  if (ot.length && d.drift) {
    for (let i = lowerBound(ot, view.a * 1000); i < ot.length && ot[i] <= view.b * 1000; i++) {
      const dev = d.drift[i]
      if (!Number.isFinite(dev)) continue
      const size = Math.abs(dev)
      ctx.fillStyle = size <= 5 ? c.accent : size <= 15 ? c.amber : c.red
      const w = ow[i] / 100
      ctx.globalAlpha = 0.35 + 0.65 * w
      const y = dmid - (Math.max(-DRIFT_RANGE_MS, Math.min(DRIFT_RANGE_MS, dev)) / DRIFT_RANGE_MS) * dh
      const r = 1.3 + 1.3 * w
      ctx.fillRect(X(ot[i] / 1000) - r, y - r, 2 * r, 2 * r)
    }
    ctx.globalAlpha = 1
  }
  ctx.restore()

  // Axis labels.
  ctx.font = MONO
  ctx.fillStyle = c.dim
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let b = Math.ceil(lo / ystep) * ystep; b <= hi; b += ystep) {
    ctx.fillText(Number.isInteger(b) ? String(b) : b.toFixed(1), x0 - 5, Y(b))
  }
  ctx.fillText(L.compact ? '±30' : `±${DRIFT_RANGE_MS}`, x0 - 5, dmid)

  // Ruler.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const tstep = niceStep(span, Math.max(3, Math.floor((x1 - x0) / 90)))
  const decimals = tstep >= 1 ? 0 : tstep >= 0.1 ? 1 : 2
  ctx.strokeStyle = c.lineStrong
  for (let s = Math.ceil(view.a / tstep) * tstep; s <= view.b + 1e-9; s += tstep) {
    const x = Math.round(X(s)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, L.driftBottom)
    ctx.lineTo(x, L.driftBottom + 4)
    ctx.stroke()
    // Kept inside the canvas: the last label of the song sits on its right edge.
    const text = formatRuler(s, decimals)
    const half = ctx.measureText(text).width / 2
    ctx.fillText(text, Math.min(Math.max(x, half + 1), L.width - half - 1), L.driftBottom + 6)
  }

  // The other timing's red lines, dashed under the result's, each with its BPM along the plot's foot where there is room.
  if (other) {
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    let room = -1e9
    other.forEach((line, i) => {
      const x = Math.round(X(line.timeMs / 1000)) + 0.5
      if (x < x0 || x > x1) return
      ctx.strokeStyle = c.compare
      ctx.lineWidth = 1.4
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(x, L.tempoTop)
      ctx.lineTo(x, L.driftBottom)
      ctx.stroke()
      ctx.setLineDash([])
      const meterChanged = i === 0 ? line.meter !== 4 : line.meter !== other[i - 1].meter
      const label = formatBpm(line.bpm) + (meterChanged ? ` · ${line.meter}/4` : '')
      const w = ctx.measureText(label).width
      if (x + 3 > room && x + 3 + w < x1) {
        ctx.fillStyle = c.compare
        ctx.fillText(label, x + 3, L.tempoBottom - 9)
        room = x + 3 + w + 6
      }
    })
  }

  // Red lines, with chips staggered over two rows; a third overlap draws the line alone.
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const right = [-1e9, -1e9]
  const order = d.lines.map((_, i) => i)
  // The selected and hovered lines last, so their chips are never the ones dropped.
  order.sort((a, b) => rank(a, d) - rank(b, d))
  const chips = []
  for (const i of d.lines.map((_, j) => j)) {
    const line = d.lines[i]
    const x = Math.round(X(line.timeMs / 1000)) + 0.5
    if (x < x0 - 80 || x > x1 + 1) continue
    const meterChanged = i === 0 ? line.meter !== 4 : line.meter !== d.lines[i - 1].meter
    const label = formatBpm(line.bpm) + (meterChanged ? ` · ${line.meter}/4` : '')
    const w = ctx.measureText(label).width + 12
    let row = -1
    if (x > right[0] + 3) row = 0
    else if (x > right[1] + 3) row = 1
    if (row >= 0) right[row] = x + w
    chips[i] = { x, w, label, row }
  }
  for (const i of order) {
    const chip = chips[i]
    if (!chip) continue
    const strong = i === d.selected || i === d.hovered
    ctx.strokeStyle = c.red
    ctx.lineWidth = strong ? 2.2 : 1.2
    ctx.beginPath()
    ctx.moveTo(chip.x, chip.row === 1 ? CHIP_H + 4 : 2)
    ctx.lineTo(chip.x, L.driftBottom)
    ctx.stroke()
    const row = chip.row >= 0 ? chip.row : strong ? 0 : -1
    if (row < 0) continue
    const y = 2 + row * (CHIP_H + 2)
    ctx.fillStyle = c.red
    roundRect(ctx, chip.x, y, chip.w, CHIP_H, 3)
    ctx.fill()
    if (strong) {
      ctx.strokeStyle = c.text
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
    ctx.fillStyle = c.redInk
    ctx.fillText(chip.label, chip.x + 6, y + CHIP_H / 2 + 0.5)
  }
  return { X }
}

function rank(i, d) {
  if (i === d.hovered) return 2
  if (i === d.selected) return 1
  return 0
}

/** The overview under the map: the whole song, its lines and levels; the view box and playhead go on top each frame. */
export function paintOverview(ctx, width, height, d, c) {
  const X = (s) => (s / d.durationS) * width
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = c.lane
  ctx.fillRect(0, 0, width, height)
  const mid = (height - 4) / 2
  const h = mid - 2
  if (d.peaks) {
    const { min, max, secondsPerBin } = d.peaks.coarse
    const perPx = d.durationS / width
    ctx.fillStyle = c.dim
    ctx.globalAlpha = 0.6
    for (let px = 0; px < width; px++) {
      const i0 = Math.floor((px * perPx) / secondsPerBin)
      const i1 = Math.min(min.length, Math.max(i0 + 1, Math.ceil(((px + 1) * perPx) / secondsPerBin)))
      let mn = 0
      let mx = 0
      for (let i = i0; i < i1; i++) {
        if (min[i] < mn) mn = min[i]
        if (max[i] > mx) mx = max[i]
      }
      ctx.fillRect(px, mid - mx * h, 1, Math.max(1, (mx - mn) * h))
    }
    ctx.globalAlpha = 1
  } else if (d.envelope?.v?.length) {
    const v = d.envelope.v
    const per = d.envelope.span_ms / 1000 / v.length
    ctx.fillStyle = c.onset
    const w = Math.max(1, (per / d.durationS) * width)
    for (let i = 0; i < v.length; i++) {
      const y = (v[i] / 100) * h
      if (y >= 0.5) ctx.fillRect(X(i * per), mid - y, w, 2 * y)
    }
  }
  const bounds = d.lines.map((l) => l.timeMs / 1000).concat([d.durationS])
  d.lines.forEach((line, i) => {
    const a = X(bounds[i])
    const b = X(bounds[i + 1])
    ctx.fillStyle = c[LEVEL_TONE[d.sections[line.index]?.level] ?? 'dim']
    ctx.fillRect(a, height - 3, Math.max(1, b - a - 1), 3)
    ctx.fillStyle = c.red
    ctx.fillRect(Math.round(a), 0, i === d.selected ? 2 : 1, height - 3)
  })
  // The other timing's lines: the lower half, so a line both share shows as red above and blue below.
  ctx.fillStyle = c.compare
  for (const line of d.other ?? []) ctx.fillRect(Math.round(X(line.timeMs / 1000)), mid, 1.5, height - 3 - mid)
}
