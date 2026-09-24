# Other languages

Overtone is written in Python (the v3 engine, the bridge, the classic window, the CLI and
the bench), Rust (the v4 engine and its CLI), and JavaScript, HTML and CSS (the web shell).
This document asks which features would be better served by another language, how viable
each one is on this project's rules, and how it would stay in step with the rest.

The rules that decide viability:
- **Offline.** No network calls from the app. A development tool may download packages
  once, as `pip` and `cargo` already do.
- **Every check runs locally, in one line.** A language adds a gate or it adds nothing.
- **One source of truth per contract.** Two languages that describe the same data drift
  apart unless one is generated from the other or a gate compares them.
- **Measured, or said to be unmeasured.**

What was already decided stays decided (`02-stack-evaluation.md`): Rust for the engine,
C++ rejected (FFTW is GPL, the build cost), Zig rejected (its ecosystem), C# rejected as
the *engine* language (no first-class FFT). None of that is reopened here. The question is
narrower: a feature at a time.

Tools on this machine (2026-09-24):

| Tool | State |
|---|---|
| SQLite (Python's `sqlite3`) | 3.50.4, with FTS5 full-text search: nothing to install |
| .NET | runtime 8.0 only, no SDK: C# needs the SDK installed |
| Node.js | absent: TypeScript needs Node installed (as a development tool) |
| WebView2 | present: WebGPU / WGSL available to the page |

---

## Candidates

### 1. SQL (SQLite + FTS5): a library index of the osu! Songs folder

**What it adds.** An index of every beatmap under a Songs folder. It holds the set, the
difficulty, artist, title, creator, source and tags, mode, the audio file and its size,
the red line count, the first BPM and the object count. On top of it:
- **The Songs browser with search** (Phase 19, Library: the part not built yet).
  Full-text search over 4,800 sets answers as you type.
- **Maps of this song in milliseconds.** Reference timing's same-audio search walks the
  folder on every call today (0.8 s over 4,798 sets). An index answers from a size
  lookup plus at most one hash, and remembers the hash.
- **Library health check** (Phase 21): which maps' timing disagrees with their audio,
  listed and sortable.
- **The ground for fingerprint reuse** (Phase 10.1) and the project format (Phase 8):
  both are indexes of what Overtone has already seen.

**Viability: high.** `sqlite3` is in Python's standard library, and FTS5 is compiled in.
The database is one local file under `%LOCALAPPDATA%\Overtone`. There is no server, no
install and nothing on the network.

**Staying in step.**
- The schema lives in one `.sql` file with a version number, and the code refuses a
  database from a newer schema.
- Upgrades are the file's own migrations.
- Tests build a library from a temporary Songs folder.
- `facts.py` checks that the schema version the code expects is the file's.

**Cost: low.** A scan reads each `.osu` header only, and a rescan skips unchanged files by
size and time.

**Verdict: build first.** P1.

### 2. TypeScript: the web shell, type-checked against the bridge

**What it adds.** `app/app.js` is 2,588 lines calling a bridge whose replies are plain
JSON. This session's slips were contract slips that a type checker catches before any run:
- SVG elements have no `.hidden`;
- a payload key renamed from `accent` to `level`;
- a reply field read before it existed.

TypeScript checks that without changing how the page runs: `// @ts-check` with JSDoc
types, and `tsc --noEmit` as a gate, keeps `app.js` as the file the window loads, with no
build step. It is also the frontend language `03-architecture.md` already plans for Tauri.

**Viability: medium.** Node.js LTS must be installed as a development tool. The app itself
never needs it.

**Staying in step.** The payload's types are generated from Python, the side that builds
the payload: a script dumps a real `analysis_payload` and every bridge reply shape. A gate
fails when the generated declarations and the committed ones differ, so Python and the
page cannot drift apart silently.

**Cost: medium.** Most of the work is typing the bridge replies once.

**Verdict: build second, once Node is installed.** P1 for the gate, P2 for full typing.

### 3. C#: osu!lazer compatibility, checked by lazer's own parser

**What it adds.** osu!lazer is C#. Its beatmap decoder is `osu.Game`, MIT-licensed on
NuGet. A small console tool would decode every `.osu` Overtone writes and compare lazer's
reading of the timing points with Overtone's intent: offsets, decimals, BPM, meter and the
green lines kept. Nothing reimplements lazer's parser. This checks the Phase 5 row
"lazer compatibility" against the real thing.

**Viability: medium.** The .NET 8 SDK must be installed, and one NuGet restore downloads
`osu.Game` and its dependencies at development time. The app never runs C#: it is a gate.

**Staying in step.** The tool reads the same fixtures and injected maps the Python tests
write, and exits non-zero on the first disagreement. One command, like every gate.

**Cost: medium.** It needs a small project under `tools/`, and `osu.Game`'s package is
large.

**Verdict: worth it.** P2.

### 4. WGSL (WebGPU): the spectrogram layer

**What it adds.** An optional spectrogram under the timeline (Phase 3, P3), with a
short-time FFT of the decoded song computed on the GPU in a compute shader. Scrolling and
zooming stay smooth where a canvas redraw would not.

**Viability: medium.** WebView2 exposes WebGPU, but a machine without it needs the CPU path
or no layer. It adds nothing to the timing itself.

**Staying in step.** The shader's FFT is checked against numpy's on a synthetic tone, in
the browser harness.

**Verdict: later.** P3, as the layer already is.

### 5. Lua: user rules for the mod report

**What it adds.** Users writing their own checks, for example "no red line within 1 ms of
a kiai start", run in a sandbox over the parsed beatmap. This is Phase 9's plugin API.

**Viability: medium.** `lupa` (Python) or `mlua` (Rust) embed Lua. A sandbox is a security
surface that has to be designed, not bolted on.

**Verdict: later.** P3, after the report has users who ask for rules.

### 6. WiX (XML): the installer

**What it adds.** The MSI already planned (Phase 10.13), with its own licence note (MS-RL).
It is listed here only so the count is complete.

---

## Rejected

| Language | Why not |
|---|---|
| C++ | Already rejected for the engine: FFTW is GPL, and the build and packaging cost more. No feature here needs it: the one C library that came up, libopus, was declined by decision. |
| Go, Java, Kotlin | No feature where they beat what is here; each would be a third runtime for nothing. |
| Cython | Numba already compiles the hot Python paths, and the fast path is the Rust engine. |
| Julia, R | The bench's statistics fit in Python scripts; a second numeric stack would be a second answer to check. |

## Order

1. **SQL library index**: no install, P1, and it unblocks the Songs browser, the library
   health check and fingerprint reuse.
2. **TypeScript check of the web shell**: after Node.js is installed.
3. **C# lazer gate**: after the .NET SDK is installed.
4. **WGSL spectrogram** and **Lua rules**: when their phases come up.
