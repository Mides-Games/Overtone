# osu! Timing Analyzer v3.0

Local desktop app that extracts BPMs and offsets from audio, built for creating osu! red timing points. English is the default UI language (Español available in the dropdown).

![stack](https://img.shields.io/badge/python-3.10%2B-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## What changed in v3

v2 read tempo from the **gaps between detected beats**. Differencing amplifies the few milliseconds of jitter every onset detector carries, so its BPM wandered by ~0.2 and its offsets sat about 8 ms late.

v3 never differences anything. It fits an explicit model

```
t(k) = offset + k · beat_length          (k = integer beat index)
```

to the detected attack times by iteratively re-weighted least squares. Hundreds of inlier attacks average the jitter down by √N — that is what turns "±0.2 BPM" into "±0.001 BPM".

Measured on a 24-track synthetic benchmark with exact ground truth (odd tempos like 222.222 and 128.37, added noise, ±8 ms performance jitter, swing and shuffle, drops, sparse breakdown bars, 6-minute tracks, and 2–4 tempo changes per song), checking **every** section, not just the first:

| | v2 | v3 |
|---|---|---|
| median BPM error | 0.18 BPM | **0.0000 BPM** |
| median offset error | 8.2 ms | **0.14 ms** |
| sections within 0.05 BPM **and** 5 ms | 0 / 24 | **24 / 24** |
| time for a 60 s track | ~6 s | **~0.8 s** |

Where it still cannot be exact — and no tool can — is stated under [Honest limits](#honest-limits).
The full engineering log, including the approaches that were tried and dropped, is in [timeline.md](timeline.md).

## Install & run

```powershell
python -m pip install -r requirements.txt
python timing_analyzer.py
```

CLI analysis:

```powershell
python timing_analyzer.py "C:\path\song.wav" --stats --csv timing.csv --click click.wav
```

- `--delta 1.5` minimum gap between the current tempo and a new one before a red line is added.
- `--persistence 12` beats a new tempo must hold. Raise to 20+ for constant-tempo songs.
- `--min-confidence 75` filters shaky sections.
- `--subdivision 2` multiplies the detected beat rate; `0.5` halves it. Fixes an octave read you disagree with — and it is exact, not a re-guess.
- `--engine auto|precision|legacy` — `auto` (default) fits the grid and falls back to the v2 tracker only when nothing fits; `precision` refuses to fall back; `legacy` forces the v2 tracker.
- `--decimal-offsets 3` keeps sub-millisecond offsets (osu!lazer accepts them; **stable does not** — the default of whole milliseconds is what the .osu format specifies).
- `--click click.wav` writes a metronome aligned to the red lines — **listen to it against the song** before mapping.
- `--stats` prints global BPM, stability, meter, engine used and the grid residual.
- `--inject map.osu` writes red lines straight into the beatmap (`--no-backup` skips the `.bak`).
- `--no-refine` skips sample-resolution attack re-timing (diagnostic aid).

GUI presets: **⚡ Variable** = 1.5 / 12 / 75 (default — songs that change often), **🛡 Steady** = 2.0 / 20 / 85 (constant-tempo songs).

For MP3/M4A/AAC install FFmpeg and make sure it is on `PATH`. WAV/FLAC/OGG open directly via SoundFile.

## How the v3 engine works

1. **Load** mono 44.1 kHz with peak normalization (SoundFile fast path, librosa fallback). Files longer than an hour are refused rather than decoded.
2. **Attacks** are peak-picked from a 2.9 ms onset envelope with parabolic sub-frame interpolation, then **re-timed on the raw waveform at sample resolution**: a spectral-flux peak lags the physical attack by roughly one analysis window, and an offset 8 ms late is audible in the editor. On the benchmark this leaves attacks 0.15 ms from truth with 0.15 ms spread.
3. **Atomic pulse.** A weighted circular-coherence sweep, `R(f) = |Σ w·e^{2πi f t}| / Σ w`, scores every plausible pulse rate in one O(N) pass each. Candidates are ranked by *share* × *coverage* — how much attack energy a grid explains, times how many of its own slots are filled. A grid twice too slow fails the first, twice too fast fails the second; only the true atom scores on both.
4. **Lock.** Expanding-window least squares walks that grid over the whole track in doubling spans, so a 1 % seed error is absorbed without ever slipping a beat index. A robust re-centering pass snaps the phase onto the *densest* residual cluster rather than its mean, so swung off-beats and ghost notes cannot drag the offset (they used to cost 17 ms on a shuffle track).
5. **Octave.** Attacks are grouped by index modulo *m*; if *m* atoms really make a beat, one class holds the kicks and another the filler, so the accent depth is large. That plus tempogram hints read through librosa's log-normal prior decides how many atoms make a beat, and which one is the downbeat. Evidence — never blind multiplication.
6. **Sections** grow forward while attacks keep landing on the grid, and stop where they stop. Each new region **re-seeds its own coherence scan** instead of inheriting the previous period, because a period carried across a 128 → 142 BPM change assigns wrong beat indices on the far side and least squares cannot recover from that. Boundaries then settle on the beat where the two grids **cross**: at a real tempo change both grids share a beat and drift apart linearly on either side, which is a sharp minimum, while a residual cost is flat there. Finally every section is refitted on its own attacks alone.
7. **Fallback.** If no grid fits at all — rubato, free time, no percussion — the v2 hybrid tracker (DP + PLP + peak picking) runs instead, and the analysis says so (`engine: legacy` in `--stats`).

Headline extras: **global BPM** (duration-weighted across sections), **stability**, **meter** (4/4 vs 3/4, evidence-gated — the first red line is only moved to a bar line when the accents actually prove where the bar is), and the **grid residual** in ms, which is the honest measure of how well the song fits a fixed grid at all.

## The octave is still a judgement call

BPM and offset are now essentially exact. What no detector can settle for you is which multiple of the pulse *you* call the beat: a 92 BPM song with eighth-note hats is also a valid 184 BPM map, and 225 BPM streams read as 112.5 to any tempo estimator with a perceptual prior.

- `Prefer map BPM (120–300)` is **on** by default and breaks that tie towards the range osu! is mapped in. Turn it off (`--no-map-preference`) to get the musically-halved reading instead.
- If you disagree, hit **×2** or **÷2** in the results header. With a v3 analysis that is instant *and exact* — the fitted grids are simply read at a different beat rate, nothing is re-detected.
- The click track is the arbiter. A correct map clicks *with* the song; a halved one clicks every other beat.

## Honest limits

- **Rubato / accelerating tempo**: no fixed grid exists. The engine detects this and falls back to the tracker, which emits a staircase of sections. Expect to fix these by hand.
- **Non-percussive music** (pads, legato strings, solo voice): there are no attacks to fit. `--engine precision` will refuse the file outright rather than invent an answer.
- **Half-time *feel* sections** (same grid, half the energy): the BPM correctly stays put — map the feel, not a new red line.
- **Songs that truly change pulse per section**: the octave decision is global. Fix the odd section with **2× § / ÷2 §** in the editor panel.
- **Swing and shuffle**: BPM and offset come out exact, but the off-beats do not sit on a subdivision of the grid, so the reported grid residual is large. That number is telling you the truth about the music.
- **Offsets are exported as whole milliseconds** — that is what the .osu format specifies and what osu!stable writes. The fit is sub-millisecond; rounding costs at most 0.5 ms. Use `--decimal-offsets` if your tooling accepts more.
- **Always verify the first beat and every transition in the osu! editor.**

## App features

- Stat cards: global BPM, sections (+ meter), beats, stability.
- Results table (`# / offset / BPM / beat length / confidence`); click a row to highlight its section on the trace.
- **④ Edit timing points**: select a row to load offset/BPM, then Apply, Add, Delete (§1 is protected), nudge ±1/±5 ms, or **2× § / ÷2 §** per-section octave fix. Hand-added points carry 100 % confidence (you vouch for them).
- **Inject .osu…**: writes the red lines straight into a beatmap's `[TimingPoints]` — greens and everything else preserved byte-for-byte (CRLF-safe). The write is atomic (temp file + rename, so a crash cannot leave a half-written beatmap), a `.bak` is made and an **existing `.bak` is never overwritten** — the pristine original is the one worth keeping. Legacy v3/v4 maps whose timing lines have only two fields are recognised correctly. Audio-filename mismatch warning and a confirmation dialog. CLI: `--inject map.osu`.
- **Per-section pulse hints**: sections reading below 120 BPM with strong off-beat support are flagged in Details… and under the editor — doubling stays one manual click.
- Tempo-trace canvas: onset bed + local-tempo curve (from short least-squares fits, not beat deltas) + section shading + red-line markers.
- One-click **Export CSV**, **Copy .osu**, **Click track…**, **Details…**.
- **Tap tempo** card for a manual cross-check.
- Progress bar, background-thread analysis (UI never freezes), prefs + language persisted to `~/.timing_analyzer.json` — written atomically and ignored entirely if it is ever corrupt, so a bad config can no longer stop the app from starting.
- Shortcuts: `Ctrl+O` open, `Ctrl+C` copy points, `F5` analyze.

## Tests

```powershell
python -m unittest test_timing_analyzer -v
```

55 tests covering: least-squares grid fitting (including a regression test for the coherence phase sign, which once put the seed grid in anti-phase), sample-resolution attack re-timing, robust phase re-centering against ghost notes, boundary placement at the grid crossing, exact and reversible octave forcing, two-section detection to 0.02 BPM and 4 ms, the legacy engine and its fallback, .osu injection (CRLF-safe, idempotent, legacy two-field lines, backup preservation), whole-millisecond offset export, corrupt-config tolerance, and the v2 segmentation/gap-filling helpers that remain in the fallback path.

## Resumen en español

La interfaz usa inglés por defecto; elige **Español** en el desplegable. v3 sustituye la lectura de BPM «por diferencias entre beats» por un **ajuste de rejilla por mínimos cuadrados**: el BPM y el offset salen exactos (error mediano 0,0000 BPM y 0,14 ms en el banco de pruebas) y además es unas 7 veces más rápido. Lo que sigue siendo criterio humano es la **octava** (92 vs 184, 112,5 vs 225): usa **×2 / ÷2**, que ahora es instantáneo y exacto. Flujo recomendado: analiza → revisa la curva → ajusta a mano (④ Edit) → exporta el click track → escúchalo contra la canción → **Inject .osu…** → verifica en el editor de osu!.

## License

MIT — do what you want, credit appreciated.
