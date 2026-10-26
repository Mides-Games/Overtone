# Stack evaluation

The question is not "which language is fastest". The v3 engine's accuracy comes from its
*algorithm* — a 0.16 ms median offset is not something a compiler gives you. Rewriting in
a faster language buys nothing on accuracy by itself.

So the real question is: **which stack removes v3's actual blockers at the lowest
long-term cost?** From the [audit](01-audit-v3.md), those blockers are:

| # | Blocker | What a stack has to provide |
|---|---|---|
| B1 | 3258-line single namespace (F-04) | Enforced module boundaries, a testable core with no UI dependency |
| B2 | FFmpeg needed for MP3/M4A/AAC (F-06) | In-process decoders for the formats mappers actually have |
| B3 | Tk cannot become a DAW timeline | GPU-capable custom rendering, real layout, animation |
| B4 | `librosa → numba → llvmlite → LLVM` is unshippable as one `.exe` | Static-ish, self-contained binary |
| B5 | No room for the hitsound engine's per-onset feature work | Cheap parallelism, SIMD, no GIL |
| B6 | Progress/i18n/diagnostics leak through strings (F-08, F-10) | Structured events across a typed boundary |

Everything else — "Rust is fast", "React is popular" — is decoration on top of that list.

---

## Candidates

Four serious ones, plus the options that were considered and set aside with reasons.

### A · Rust + Tauri v2 + TypeScript frontend
Core engine as pure Rust library crates; UI as a web frontend in a WebView2 shell;
IPC across a typed command layer.

### B · Rust + egui
Same core; immediate-mode native GUI, everything in one language, one process, one
render loop.

### C · Rust + iced
Same core; retained-mode Elm-architecture native GUI on wgpu.

### D · C++20 + Qt 6 / QML
Engine in C++; QML scene-graph UI.

### E · C# .NET 9 + Avalonia
Engine in C#; XAML UI with a Skia compositor.

---

## Comparison

Scores are 1–5, judged against *this* project's needs, not in the abstract.
Reasoning follows the table; the table alone is not the argument.

| Criterion | Weight | A Tauri | B egui | C iced | D Qt/QML | E Avalonia |
|---|---:|:---:|:---:|:---:|:---:|:---:|
| DSP throughput | ×3 | 5 | 5 | 5 | 5 | 3 |
| Audio decoding without external binaries (B2) | ×3 | **5** | **5** | **5** | 3 | 2 |
| Multithreading / parallel DSP (B5) | ×3 | 5 | 5 | 5 | 4 | 4 |
| UI quality ceiling (B3) | ×3 | **5** | 2 | 3 | 4 | 4 |
| Interactive timeline / custom charts (B3) | ×3 | 5 | 3 | 3 | 4 | 3 |
| Audio playback + sample-accurate click | ×2 | 4 | 4 | 4 | 4 | 3 |
| Single-file `.exe` distribution (B4) | ×2 | 4 | **5** | **5** | 2 | 4 |
| Maintainability / module boundaries (B1) | ×2 | 4 | 4 | 4 | 2 | 4 |
| Extensibility (plugins, new analyses) | ×2 | 4 | 3 | 3 | 3 | 4 |
| `.osu` parsing ergonomics | ×1 | 5 | 5 | 5 | 3 | 5 |
| GPU path where it is actually justified | ×2 | 5 | 4 | 4 | 4 | 3 |
| Memory footprint | ×1 | 2 | **5** | 4 | 3 | 3 |
| Team/dev velocity on UI work | ×2 | **5** | 3 | 2 | 3 | 4 |
| Licensing cleanliness for MIT | ×1 | 5 | 5 | 5 | 2 | 5 |
| **Weighted total** (max 145) | | **131** | 112 | 112 | 103 | 104 |

### Why the engine column is a tie between A, B and C

A, B and C share the same Rust core. The engine differences between them are **zero** —
which is the single most important observation in this document, and the reason the
architecture puts the engine in UI-free crates. The choice between A, B and C is
*only* a choice of shell, and it is therefore reversible.

For the engine itself, Rust's advantage over C++ and C# is ecosystem-specific, not
ideological:

- **Symphonia** decodes MP3, AAC, ALAC, FLAC, Vorbis, WAV and MP4/M4A containers in
  pure Rust, in-process. This **deletes B2 outright** — no FFmpeg, no `PATH`, no "install
  this other program first" in the README. Nothing in the C++ or C# world is equivalent
  without shipping FFmpeg or gluing together four libraries (`dr_libs` + `minimp3` +
  `libsndfile` + an MP4 demuxer) and owning the integration.
- **rustfft / realfft** are SIMD-dispatched (AVX2/FMA, NEON) real-input FFTs with no
  build-time native dependency. The C++ default, FFTW, is **GPL-or-commercial** — a
  licensing problem for an MIT project — so Qt would mean pocketfft or KissFFT and
  measurably more work. .NET has no first-class fast FFT; realistically you P/Invoke one,
  at which point the C# advantage evaporates.
- **rayon** gives work-stealing parallelism over the exact shapes this project needs
  (per-frame STFT, per-onset feature extraction, per-file batch) in one line each, with
  no GIL and no `Task`-scheduler surprises in tight numeric loops.
- **rubato / soxr** cover resampling, and `memmap2` covers memory-mapped reads for the
  waveform pyramid.
- Cargo means `Cargo.lock` is checked in by default, which is the direct answer to F-05.

C# is the outlier at 3 for DSP throughput, and that needs justifying rather than
asserting. .NET 9 vectorises well and is genuinely within ~1.5–2× of native on tight
`Vector256` loops. The problems are elsewhere: the GC is hostile to a real-time audio
callback (you end up allocating unmanaged and pinning, i.e. writing C# that looks like C),
and the numeric library ecosystem is thin enough that the FFT, the resampler and the
decoders all become your problem or a P/Invoke. Fine language, wrong ecosystem for this.

### Why Tauri wins the shell, and what it costs

**B3 is the deciding criterion**, because it is the one blocker where the candidates
genuinely differ, and it is what the brief spends the most words on: a DAW-grade timeline
with waveform, onset bed, beat grid, tempo curve, section shading, hitsound lanes, zoom,
scroll, selection, hover readouts, and the visual standard of Linear or a modern DAW.

- **egui** is an excellent tool-builder and I would pick it for a profiler or a debug
  overlay. Its ceiling for *this* brief is the problem: immediate-mode means every frame
  is re-declared, and the visual language the brief asks for — negative space, soft
  borders, subtle shadows, small animations, consistent iconography, real typography — is
  achievable only by hand-building each of those primitives. You would spend the project's
  UI budget rebuilding what CSS already does, and still land at "clean tool", not
  "professional product". Scored 2.
- **iced** is a better fit than egui for styled UI and its `Canvas` + wgpu backend can
  draw the timeline. But animation and complex-widget stories are still thin, and a DAW
  timeline is a *lot* of custom widget. Scored 3.
- **QML** is the strongest native answer — a GPU scene graph, declarative animation, and
  `QQuickItem` custom nodes for the timeline. It loses on everything around it: C++ build
  complexity on Windows, `windeployqt`, Qt's LGPLv3 obligations pushing you to dynamic
  linking (which fights B4), and the engine-side costs above. Scored 4, total 103.
- **Avalonia** is a real contender and the closest thing to "Tauri's UI ergonomics
  without a webview". Loses on the engine side, and heavy custom timeline rendering still
  means hand-written SkiaSharp draw operations.
- **Tauri** gets flexbox/grid layout, CSS transitions, `@font-face`, mature charting, and
  WebGL2/WebGPU for the timeline — and WebView2 is already present on this machine and on
  every current Windows install. The timeline becomes a canvas with a shader, and the
  chrome around it becomes CSS. That is why it scores 5 twice on the ×3 UI criteria and
  wins by 19 points.

The honest costs of A, and how the architecture absorbs each one:

| Cost | Mitigation |
|---|---|
| ~120–180 MB RSS baseline for WebView2 | Accepted, and stated in the README. A DAW uses more. This is the only criterion where egui beats Tauri outright (scored 2 vs 5) |
| IPC boundary; JSON is too slow for bulk data | Small state over typed commands; bulk arrays (peak pyramid, onset envelope, spectrogram tiles) over a custom URI scheme returning raw bytes the frontend reads as `TypedArray`. Never JSON-encode a waveform |
| Webview cannot schedule sample-accurate audio | Playback lives in Rust (`cpal`); the UI receives a timestamped playhead and extrapolates locally at 60 Hz. No IPC message per frame |
| Two languages, two toolchains | Real, and the main reason to prefer B if the team is one Rust developer who dislikes TypeScript |
| WebView2 runtime dependency on older Windows | Evergreen bootstrapper; present by default on Windows 11 |
| MSVC build tools needed on Windows | One-time setup, and required by B/C/D too |

### Considered and set aside

- **Keep Python, add a Rust/PyO3 extension for the hot paths.** The cheapest path to speed,
  and it fixes *nothing* on the list except B5 partially. B1, B2, B3 and B4 all survive.
  Rejected — it optimises the one dimension that was never the problem.
- **Python engine + web UI (FastAPI + local browser).** Keeps B2/B4, adds a server
  process to a tool whose main selling point is that it is local and offline. Rejected.
- **Julia.** Superb DSP ergonomics, genuinely fast. Desktop GUI and single-`.exe`
  distribution are weak, and startup latency is poor for a tool you open to check one
  song. Rejected on B3/B4.
- **Zig.** Attractive for the DSP core and cross-compilation. Ecosystem for decoding, FFT
  and GUI is far behind Rust's, so it would mean writing the parts Symphonia and rustfft
  already give us. Rejected on cost, not on merit.
- **Flutter / Electron shells.** Electron is a heavier Tauri with a worse story for a
  native engine. Flutter's desktop audio/native-interop story adds an FFI boundary with
  none of Tauri's UI advantages over plain web tech. Rejected.

---

## Decision

> **Rust workspace of UI-free engine crates + Tauri v2 shell with a TypeScript/React
> frontend; timeline rendered on WebGL2 with a Canvas2D fallback; audio decode via
> Symphonia; FFT via realfft/rustfft; parallelism via rayon; playback via cpal.**

The decision rests on three claims, each independently checkable:

1. **The engine must be Rust**, because Symphonia deletes the FFmpeg dependency, rustfft
   and rayon cover the DSP without a GPL dependency or a P/Invoke, and `Cargo.lock`
   answers the reproducibility finding. This is the load-bearing part of the choice.
2. **The shell should be a webview**, because the brief's hardest requirement is a
   DAW-grade interactive timeline with modern visual polish, and that is the one thing
   web rendering does better than every native alternative here per hour of work spent.
3. **The choice of shell must be reversible**, because claim 2 is a judgement about UI
   quality and dev velocity, not a measurement. Which is why:

### The de-risking rule

**No crate under `crates/` may depend on Tauri, on a UI framework, or on the filesystem
layout of the app.** The engine's public surface is plain Rust types plus a `serde`
representation. Consequences:

- The CLI links the same crates the GUI does. It is not a second implementation.
- The accuracy benchmark links the same crates. It measures the shipped engine.
- If Tauri turns out to be the wrong call, swapping in egui or iced costs the shell
  (`app/`) and nothing else. That is a few weeks, not a rewrite.
- A future plugin host, a server mode, or a WASM build are all reachable without
  touching the engine.

This is why the stack decision can be made now with incomplete information: the expensive
half is not the part in doubt.

### Rejected within the chosen stack

- **No GPU compute for analysis.** A 6-minute track at hop 128 is ~124k frames of
  1024-point real FFT. On CPU with realfft + rayon across 8–16 cores that is well under a
  second, and the measured v3 baseline for the same track is 5.0 s *single-threaded in
  Python*. Adding wgpu compute would buy a fraction of an already-negligible cost while
  adding driver variance, a second numeric path to validate, and a class of bug that only
  reproduces on some GPUs. For batch work, parallelising **across files** gets near-linear
  speedup with none of that. The brief says not to add GPU without justification; there
  is none for analysis. **GPU is used for rendering, where it is clearly justified.**
- **No ML in the tempo path, ever.** The grid fit is already exact on the corpus
  (0.0000 BPM median). A learned tempo estimator would be strictly worse and unexplainable.
  ML is evaluated only where hand-tuned features plateau — see
  [`08-machine-learning.md`](08-machine-learning.md).
- **No `unsafe` for performance without a benchmark in the same commit.** Bounds checks are
  not the bottleneck; memory bandwidth and FFT throughput are.

---

## Toolchain reality on this machine

Checked, not assumed:

| Component | Status | Needed for |
|---|---|---|
| Node.js 24.15 | ✅ present | frontend build |
| Python 3.14 + venv w/ numpy, scipy, librosa | ✅ working (55/55 tests, 24/24 bench) | v3 reference + golden vectors |
| git | ✅ present | — |
| WebView2 runtime | ✅ present | Tauri runtime |
| **Rust / rustup** | ❌ **missing** | everything |
| **MSVC build tools** | ❌ **missing** (no Visual Studio detected) | the `x86_64-pc-windows-msvc` linker |
| `gh` CLI | ❌ missing | optional; plain `git` over HTTPS is enough |

So implementation is gated on two installs, in this order:

1. **Visual Studio 2022 Build Tools** with the "Desktop development with C++" workload
   (~3–5 GB) — supplies `link.exe` and the Windows SDK.
2. **rustup**, then `rustup default stable-x86_64-pc-windows-msvc`.

The `x86_64-pc-windows-gnu` toolchain avoids the MSVC download but produces binaries with
worse debugging, occasional linker friction with C-shim crates, and is not what Tauri
targets by default on Windows. Not worth the saving.

Nothing else is blocked: the audit, the design, and the Python reference all run today.
