# UI / UX design

The brief asks for something that reads as a professional audio tool rather than a Python
script with a window. That is mostly a matter of restraint: a small number of decisions,
applied without exception.

---

## 1. Design language

### Principles

1. **The waveform is the interface.** Everything else is chrome and gets out of its way.
   At any moment the timeline owns the majority of the pixels.
2. **One accent colour.** Semantic colour is reserved for meaning — red lines, confidence,
   hitsound layers. Nothing is coloured for decoration.
3. **Numbers are monospaced and exact.** A tool that claims 0.16 ms shows
   `422.535 ms`, not `422 ms`, and aligns digits so a column can be scanned.
4. **No modal dialogs except for destructive confirmation.** Editing happens in place.
5. **Motion communicates causality only.** 120–180 ms ease-out on state changes, nothing
   decorative, nothing that delays input.
6. **Uncertainty is always visible.** Confidence is shown wherever a number is shown. This
   is a product rule, not a UI one: the engine's honesty is its main feature.

### Tokens

```css
--bg-0:#0a0b0d  /* app background        */  --text-0:#e8eaed  /* primary   */
--bg-1:#111316  /* panels                */  --text-1:#9aa0a6  /* secondary */
--bg-2:#181b1f  /* cards, inputs         */  --text-2:#5f6570  /* tertiary  */
--bg-3:#1f2329  /* hover                 */
--line :#24282e /* 1px borders           */  --accent:#4fc08a  /* single accent   */
--wave :#3d444d /* waveform body         */  --red   :#e0606c  /* timing points   */
--onset:#4a5561 /* onset bed             */  --warn  :#e8b339  /* low confidence  */
--grid :#2a3038 /* beat grid             */  --info  :#7f9df0  /* tempo curve     */
```

Dark is the default and the design target. A light theme is a Phase 3 deliverable, not an
afterthought: every token above has a light counterpart and the timeline renderer takes
its palette as input.

Type: **IBM Plex Sans** for interface, **IBM Plex Mono** for every number — one family in
two widths, technical without being sterile, and deliberately not Inter (which now reads as
a default rather than a choice). Scale 10 / 11 / 12 / 13 / 15 / 19 / 21 px. Radii 6 / 10 px.
One shadow, barely there: `0 1px 2px rgb(0 0 0 / .4)`. Borders do the work shadows usually do.

**Rendered mockups:** four screens — dashboard, timing workspace, hitsound analyzer and the
decision inspector — are built as an interactive canvas rather than described here. Ask for
the link if you do not have it; the layouts below are the specification, the canvas is what
they look like.

---

## 2. Screens

### Dashboard

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◆ <app name>                                    ⌘K   ⚙            │
│                                                                      │
│      ┌────────────────────────────────────────────────────┐          │
│      │                                                    │          │
│      │            Drop audio or a beatmap folder          │          │
│      │        WAV · FLAC · OGG · MP3 · M4A · AAC          │          │
│      │                  or press ⌘O                       │          │
│      └────────────────────────────────────────────────────┘          │
│                                                                      │
│  Recent                                                    Analyze ▸ │
│  ┌──────────────────────────────────────────────────────────┐        │
│  │ Sidetracked Day        224.000   2 sections   98%   2d   │        │
│  │ Blue Zenith            200.000   1 section    99%   5d   │        │
│  │ Freedom Dive           222.220   1 section    97%   1w   │        │
│  └──────────────────────────────────────────────────────────┘        │
│                                                                      │
│  Analyze folder…   ·   Batch hitsound…   ·   Validate map…           │
└──────────────────────────────────────────────────────────────────────┘
```

Drag-and-drop accepts an audio file, an `.osu`, or a whole beatmap folder (in which case
the audio and every difficulty are picked up together). Recents show the numbers the user
actually remembers a song by: BPM, sections, confidence.

### Workspace

Three regions: a fixed left rail for navigation, a top strip of stat cards, and the
timeline filling the rest. An inspector slides in from the right when something is
selected — it never pushes the timeline into a different layout.

```
┌────┬─────────────────────────────────────────────────────────────────────┐
│    │ Sidetracked Day                          precision   0.31 ms resid  │
│ ◆  ├─────────────────────────────────────────────────────────────────────┤
│ ▸  │ ┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐      │
│ ♪  │ │ 224.000 │ 2:41    │ 2       │ 4/4     │ 99%     │ 0.31 ms │      │
│ ⊞  │ │ BPM     │ length  │ sections│ meter   │ stable  │ residual│      │
│ ✓  │ └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘      │
│    ├─────────────────────────────────────────────────────────────────────┤
│    │  240 ┤                              ╭──────────────  tempo          │
│    │  224 ┤──────────────────────────────╯                               │
│    │      ├─────────────────────────────────────────────────────────┤    │
│    │      │▁▃▅█▆▃▁▂▅█▇▄▂▁▃▆█▅▃▁▂▄█▇▅▃▁▂▅█▆▄▂▁▃▅█▇▄▂▁▂▄▆█▅▃▁▂▄█▇▅▃▁│    │
│    │      │        waveform · onset bed · beat grid · attacks       │    │
│    │      ├──┬──────────────────────────────┬───────────────────────┤    │
│    │      │ §1 224.000                      │ §2 226.500            │    │
│    │      └──┴──────────────────────────────┴───────────────────────┘    │
│    │  0:00        0:40        1:20        2:00        2:40               │
│    ├─────────────────────────────────────────────────────────────────────┤
│    │ ▶  0:42.318 / 2:41.004      ━━━━●────────────  🔊 ──── ⟲ L  1.0×   │
│    └─────────────────────────────────────────────────────────────────────┘
```

Left rail: Dashboard · Timing · Hitsounds · Compare · Validate. Five destinations, icons
with labels on hover, never a hamburger menu.

The stat cards are the brief's information list, and each is a *hover target* that reveals
its derivation — clicking "99% stable" explains what stability means and how it was
computed, because a number nobody can interpret is decoration.

---

## 3. The timeline

The single most important component, and the reason the stack choice went to a webview.

### Layers, bottom to top

| Layer | Source | Notes |
|---|---|---|
| Waveform | peak pyramid at current LOD | min/max envelope; RMS body at high zoom |
| Onset bed | onset envelope | filled area, low contrast — texture, not data |
| Spectral energy | spectrogram tiles | optional; off by default |
| Beat grid | fitted sections | 1/1 heavy, subdivisions progressively fainter; appears only when zoom makes it readable |
| Attacks | attack times + weights | tick height = weight |
| Section shading | sections | alternating 2 % white wash |
| Red timing points | timing points | draggable; label on hover |
| Tempo curve | local BPM curve | own y-axis, drawn *above* the waveform, not overlaid on it |
| Confidence ribbon | per-section confidence | thin band under the ruler; colour by confidence |
| Hitsound lanes | hitsound analysis | separate stacked lanes, toggleable |
| Playhead + selection | transport | |

### Rendering

WebGL2: the waveform is one instanced quad draw over a peak texture; overlays are
line/point batches. One draw call per layer, so a 6-minute track scrolls at 60 fps because
cost follows viewport width, not track length. Canvas2D fallback when WebGL is
unavailable (identical palette, fewer layers).

Text — ruler labels, section labels, hover readouts — is **DOM on top of the canvas**, not
rendered into it. Crisp type, real font features, selectable numbers, accessible.

### Interaction

| Action | Input |
|---|---|
| Zoom | scroll wheel (cursor-anchored), `⌘+` / `⌘-`, pinch |
| Scroll | shift-scroll, drag empty space, `←` `→` |
| Select range | drag on the ruler |
| Seek | click the ruler |
| Move a red line | drag it; snaps to attacks, `alt` to free it |
| Zoom to fit / to selection | `⇧F` / `⇧Z` |

### Hover readout

Follows the cursor, 120 ms fade, never covers the point being inspected:

```
┌──────────────────────────┐
│ 1:24.318                 │
│ 224.000 BPM              │
│ beat length  267.857 ms  │
│ offset        298 ms     │
│ beat         §2 · 1128   │
│ confidence      98.2%    │
└──────────────────────────┘
```

---

## 4. Beat grid editor

A table docked below the timeline, selection synced both ways — clicking a row highlights
its section, clicking a section selects its row.

```
  #   Offset        BPM        Beat length   Conf   Residual   🔒
  §1     298 ms   224.000       267.857 ms    98%    0.28 ms   ○
  §2   13240 ms   226.500       264.901 ms    94%    0.41 ms   ●
```

Editing is direct: click a cell, type, `↵`. Offset and BPM accept arithmetic (`×2`,
`+5`, `/2`). Everything else is a button row acting on the selection:

`±1 ms` `±5 ms` · `×2` `÷2` · `Add` `Delete` · `Split` `Merge` · `Recalculate` · `🔒 Lock`

- **Lock** pins a point so re-analysis and recalculation leave it alone. A mapper who has
  verified a section by ear must be able to protect it.
- **Recalculate** refits *only* the selected section on its own attacks — a targeted
  version of what the engine already does per section.
- **Split** at the playhead, seeding the new region with its own coherence scan.
- Hand-edited points carry 100 % confidence and are marked as user-owned, as in v3 — with
  the addition that the badge says *why* it is 100 % ("you set this").
- Every edit is undoable. One undo stack per project, `⌘Z` / `⇧⌘Z`.

---

## 5. Transport

Playback is part of the analysis loop, not a convenience: the click track is how a mapper
verifies timing, and v3 made them export a WAV and open a DAW to hear it.

```
▶  0:42.318 / 2:41.004   ━━━━━●─────────────   🔊 ────○──   ⟲ Loop   ♪ Click 40%
```

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek 1 s |
| `⇧←` `⇧→` | seek 10 ms |
| `⌥←` `⌥→` | previous / next beat |
| `[` `]` | previous / next timing point |
| `L` | loop selection |
| `⇧L` | loop current section |
| `M` | mute |
| `C` | click track on/off |
| `K` | solo click |
| `1`–`5` | left-rail destinations |
| `⌘O` `⌘S` `⌘Z` `F5` | open · save · undo · re-analyze |

Clicking a beat or a timing point with `⌥` starts playback from it. The click track is
mixed live in Rust against the *current* (including hand-edited) timing points, so the
verification loop is: edit → hear it immediately.

---

## 6. Hitsound workspace

```
┌─────────────────────────────────────────────────────────────────────┐
│ Profile  [ Balanced ▾ ]   Difficulty [ Another ▾ ]     Analyze ▸    │
├─────────────────────────────────────────────────────────────────────┤
│  waveform ▁▃▅█▆▃▁▂▅█▇▄▂▁▃▆█▅▃▁▂▄█▇▅▃▁▂▅█▆▄▂▁▃▅█▇▄▂▁▂▄▆█▅▃▁         │
│                                                                     │
│  Kick     ●       ●       ●       ●       ●       ●          ◉ on   │
│  Snare        ●       ●       ●       ●       ●              ◉ on   │
│  Hat      · · · · · · · · · · · · · · · · · ·                ◉ on   │
│  Cymbal   ◆                               ◆                  ◉ on   │
│  Vocal        ▲    ▲       ▲     ▲                           ○ off  │
│  ─────────────────────────────────────────────────────────────────  │
│  Objects  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○                       │
│  Assigned N C N F N C N N N C N F N C N N N C                       │
└─────────────────────────────────────────────────────────────────────┘
```

Instrument lanes above, map objects below, sharing one time axis with the timing
workspace — so zoom and scroll are shared state and switching views never loses your place.
Each lane toggles. An object whose assignment disagrees with the audio evidence gets a
`warn`-coloured ring, which is the whole point: it draws the eye to the places worth
listening to.

Selecting an object opens the inspector with the decision, the confidence, the itemised
evidence and the alternatives — the explainability requirement is a first-class screen,
designed in [`06-hitsound-engine.md`](06-hitsound-engine.md) §7.

---

## 7. Progress

Analysis is not instant and pretending otherwise is worse than showing the truth.

```
Analyzing  ████████████████░░░░  78%          1.2 s

  Decode      ✓  0.21 s
  Peaks       ✓  0.08 s
  Onsets      ✓  0.34 s
  Attacks     ✓  0.19 s
  Coherence   ✓  0.06 s
  Octave      ✓  0.11 s
  Sections    ⠋  …
  Spectral    ·
```

Per-stage timings are always visible, not hidden behind a debug flag: they are how a user
reports a performance problem, and how we notice one. Cancellable at any point. The
previous analysis stays on screen and interactive throughout.

---

## 8. Accessibility and honesty

- Every interactive element reachable by keyboard; visible focus rings.
- Contrast ≥ 4.5:1 for text, ≥ 3:1 for meaningful graphics against their background.
- Colour is never the only carrier: confidence is a number *and* a colour; hitsound lanes
  use distinct glyphs (`●` `◆` `▲` `·`) as well as position.
- Respects `prefers-reduced-motion`: transitions become instant.
- No spinner without a stage name. No percentage that is not derived from real work.
- When the engine falls back or refuses, the UI says which and why, in one sentence, with
  the diagnostic available — never a silent downgrade.

---

## 9. What is deliberately not in the UI

- No mixer, no EQ, no effects. This is an analyser, not a DAW.
- No beatmap *editing* beyond hitsounds and timing. osu!'s editor exists.
- No account, no sync, no telemetry, no update check. Offline is a feature.
- No onboarding tour. The dashboard is one drop target and a list.
