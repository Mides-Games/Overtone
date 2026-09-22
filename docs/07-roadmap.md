# Roadmap

Ten phases. Each feature carries: **Diff** (difficulty) · **Imp** (impact) · **Deps** ·
**ML** · **GPU** · **Pri** (priority: P0 blocking, P1 core, P2 valuable, P3 optional).
"Viable" is omitted as a column because anything not viable is in
[§11 Rejected](#11-rejected--and-why), with the reason.

Phases are ordered by dependency, not by appetite. The only hard rule: **Phase 1 does not
end until the Rust engine matches the measured v3 baseline** — 24/24 within 0.05 BPM and
5 ms, median 0.0000 BPM / 0.16 ms. Everything after that is negotiable; that is not.

---

## Phase 0 — Architecture and gates

Nothing here produces a feature. It produces the ability to know whether later phases
broke something, which is why it is first.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri | Status |
|---|---|:--:|:--:|---|:--:|:--:|:--:|:--:|
| Toolchain | MSVC Build Tools + rustup MSVC target | — | — | — | no | no | **P0** | **blocked** |
| Workspace skeleton | 12 crates, dependency rules, `cargo xtask check-deps` | low | high | toolchain | no | no | **P0** | blocked |
| `reference/python-v3` | move v3 in, keep it runnable | low | high | — | no | no | **P0** | deferred¹ |
| `requirements.lock` | exact versions behind the measured baseline — **F-05** | trivial | med | — | no | no | **P0** | **done** |
| Golden-vector dump | per-stage attacks, seeds, octave, sections, points | med | **high** | — | no | no | **P0** | **done** |
| Golden-vector check | stage-by-stage diff, so a divergence names its stage | med | **high** | dump | no | no | **P0** | **done** |
| Corpus port | the 24 fixtures + 4 degenerate, same seeds, same scoring | med | **high** | skeleton | no | no | **P0** | blocked |
| **Octave-agreement gate** | pins absolute BPM per fixture — closes **F-07** | low | **high** | — | no | no | **P0** | **done** |
| **Density-change gate** | measures the coverage signal — closes **F-11** | low | high | — | no | no | **P0** | **done** |
| Pulse-hint regression test | documents the one-directional hint gap | trivial | low | — | no | no | P1 | **done** |
| Perf gate | per-stage budget vs measured baseline | low | med | corpus | no | no | P1 | todo |
| `.gitignore` scoping | stop ignoring `*.osu` repo-wide — **F-09** | trivial | low | — | no | no | P1 | **done** |

¹ Deferred deliberately: moving `timing_analyzer.py` before the Rust workspace exists
would break every path in the gates that were just built, for no gain. It moves in the
same commit that adds `crates/`.

**What the new gates cover, concretely:**

```bash
python bench/gates.py bpm-snapshot     # 24/24 readings unchanged
python bench/gates.py coverage         # signal present in 3/3 density fixtures
python bench/golden.py check           # 24/24 cases match stage for stage
```

The first pins the octave, which the accuracy benchmark normalizes away — it catches a
flip and labels it (`global BPM 112.5 -> 225.0  <-- OCTAVE FLIP`), verified by tampering
with the baseline. The second measures the coverage drop that `_grow_sections` discards.
The third is the harness the Rust engine gets pointed at: 362 KB of committed per-stage
vectors across the 24 fixtures.

**Exit:** the harness runs, produces v3's numbers from v3, and would fail if a Rust engine
disagreed.

---

## Phase 1 — Core engine port

The whole of [`05-dsp-pipeline.md`](05-dsp-pipeline.md) Part A, and nothing from Part B.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| `ota-core` types | unit newtypes, serde, errors, diagnostics | low | med | P0 | no | no | **P0** |
| Symphonia decode | MP3/AAC/ALAC/FLAC/Vorbis/WAV/MP4 — **removes FFmpeg** (F-06) | med | **high** | — | no | no | **P0** |
| Mel-flux envelope | the exact librosa contract (DSP §A.2) | **high** | **high** | decode | no | no | **P0** |
| Peak picking | scipy `find_peaks` prominence semantics + parabolic interp | med | high | envelope | no | no | **P0** |
| Attack re-timing | sample-resolution 20 % rise walk (DSP §A.4) | med | **high** | decode | no | no | **P0** |
| Coherence sweep | SIMD `R(f)`, correct phase sign, ×1–4 widening | med | **high** | attacks | no | no | **P0** |
| IRLS fit | tolerance ladder, mode re-centring at pass 2, expanding windows | med | **high** | coherence | no | no | **P0** |
| Octave decision | accent depth + tempogram hints (librosa-equivalent for now) | high | high | fit | no | no | **P0** |
| Sections | grow · re-seed · merge · crossing boundaries · refit | high | **high** | fit | no | no | **P0** |
| Meter, confidence, points | downbeat anchoring, snapping, whole-ms export | med | high | sections | no | no | **P0** |
| 55 unit tests ported | names preserved; coherence-sign test first | med | **high** | all | no | no | **P0** |
| Property tests | ×2/÷2 identity, exact-grid recovery, monotone boundaries | low | high | all | no | no | P1 |
| Structured diagnostics | carried on the result, not in a progress string — closes **F-08** | low | med | all | no | no | P1 |

**Exit:** `cargo run -p ota-bench` prints **24/24 · median 0.0000 BPM · 0.16 ms**, golden
vectors match within tolerance, 55/55 tests pass. Until then, nothing else starts.

---

## Phase 2 — Audio analysis beyond parity

Part B of the DSP doc, in the order its gates can be met.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Parallel + cache | rayon stages, blake3-keyed cache, incremental invalidation | med | **high** | P1 | no | no | **P1** |
| **Per-section octave** | half/double-time regions get their own beat rate — **F-11** | med | **high** | P1, fixture | no | no | **P1** |
| 2-D coherence map | `R(t,f)` full-track: better seeds + confidence map | med | high | P1 | no | no | P1 |
| **Elastic grid** | spline tempo model for rubato; replaces the v2 staircase | **high** | **high** | IRLS | no | no | **P1** |
| No-grid verdict | refuse honestly instead of the tracker's white-noise BPM | low | med | elastic | no | no | P1 |
| SuperFlux ODF | vibrato-suppressed flux, auto-selected on non-percussive audio | low | med | envelope | no | no | P2 |
| Drop librosa tempogram | octave hint from the coherence map | med | med | 2-D map, **octave test** | no | no | P2 |
| Multi-band flux | 7-band onset functions; also feeds hitsounds | low | med | STFT | no | no | **P1** |
| HPSS | harmonic/percussive/residual separation | med | high | STFT | no | no | **P1** |
| Band-limited re-timing | re-time each attack in its own band | med | low-med | multi-band | no | no | P3 |
| Structure analysis | novelty curve → phrases, downbeats, energy map | med | high | chroma/MFCC | no | no | **P1** |
| Section classification | intro/verse/chorus/bridge labels from structure | med | med | structure | opt | no | P2 |

---

## Phase 3 — Modern UI

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Tauri shell + tokens | window, theme, typography, command layer | med | **high** | P1 | no | no | **P1** |
| Binary transport | `ota://` URI scheme for peaks/envelope/attacks | med | **high** | shell | no | no | **P1** |
| Peak pyramid | LOD min/max, computed once, cached | low | **high** | `ota-audio` | no | no | **P1** |
| **WebGL timeline** | waveform · onsets · grid · attacks · sections · red lines | **high** | **high** | transport | no | **yes** | **P1** |
| Zoom / scroll / select | cursor-anchored zoom, range selection, keyboard nav | med | **high** | timeline | no | no | **P1** |
| Tempo curve layer | own axis above the waveform, from the fitted model | med | high | timeline | no | no | **P1** |
| Hover readout | BPM, beat length, offset, beat index, confidence | low | high | timeline | no | no | **P1** |
| Stat cards | BPM, length, sections, meter, stability, residual, engine | low | med | shell | no | no | P1 |
| Progress panel | per-stage ticks and timings, cancellable | low | med | shell | no | no | P1 |
| Dashboard | drop target, recents, folder/batch entry points | low | med | shell | no | no | P1 |
| Confidence ribbon | per-section confidence under the ruler | low | med | timeline | no | no | P2 |
| Spectrogram layer | optional tiled spectral energy | med | low-med | STFT, tiles | no | yes | P3 |
| Light theme | full token counterpart, renderer takes a palette | low | low | tokens | no | no | P3 |

---

## Phase 4 — Playback and timing editor

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| cpal transport | play/pause/seek, ring buffer, no alloc in the callback | med | **high** | `ota-audio` | no | no | **P1** |
| Live click track | synthesised against the *current* timing points | med | **high** | transport | no | no | **P1** |
| Playhead sync | timestamped position, UI extrapolates at 60 Hz | low | high | transport | no | no | **P1** |
| Scrub + loop | waveform scrubbing, loop selection, loop section | med | high | transport | no | no | P1 |
| Play from beat / point | `⌥`-click a beat or red line | low | med | transport | no | no | P2 |
| Grid editor table | inline edit offset/BPM, ±1/±5 ms, ×2/÷2 | med | **high** | P1 | no | no | **P1** |
| Add / delete / split / merge | with per-section re-seeded recalculation | med | high | editor | no | no | **P1** |
| **Lock timing point** | protect a verified point from re-analysis | low | high | editor | no | no | P1 |
| Undo/redo | one stack per project | med | high | editor | no | no | P1 |
| Click-accent meter fix | accent on the detected meter — closes audit **F-03** | trivial | low | click | no | no | P1 |

---

## Phase 5 — osu! integration

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Full `.osu` reader | all sections, hitobjects, sliders, SV, sample fields; unknown keys preserved | **high** | **high** | — | no | no | **P1** |
| Span-preserving writer | untouched fields come out byte-identical | high | **high** | reader | no | no | **P1** |
| Atomic write + backup | v3's rules: temp+rename, `.bak` never overwritten | low | **high** | writer | no | no | **P1** |
| Timing injection | red-line replacement, greens preserved, legacy 2-field lines | med | **high** | writer | no | no | **P1** |
| Parser fuzzing | `cargo fuzz` on the reader | low | high | reader | no | no | P1 |
| Beatmap folder import | audio + all difficulties from one drop | low | med | reader | no | no | P1 |
| **Map vs detected compare** | per-section BPM/offset diff table | med | **high** | reader, P1 | no | no | **P1** |
| Audio/object alignment | do the map's objects land on real attacks? | med | **high** | reader, attacks | no | no | **P1** |
| lazer compatibility | decimal offsets, `.osu` v14+ specifics | low | med | writer | no | no | P2 |

---

## Phase 6 — Hitsound engine

All of [`06-hitsound-engine.md`](06-hitsound-engine.md).

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Per-attack features | 7 bands, centroid/rolloff/flatness/crest, rise/decay, sub-attacks | med | **high** | P2 HPSS | no | no | **P1** |
| Harmonicity + pitch | autocorrelation, inharmonicity, formant-likeness | med | high | features | no | no | **P1** |
| Instrument templates | 13 scored classes, explainable by construction | high | **high** | features | no | no | **P1** |
| Synthetic label corpus | renderer emits audio + per-hit labels (no dataset licence) | med | **high** | bench | no | no | **P1** |
| Template calibration | logistic fit of term weights on the corpus | med | high | corpus | **light** | no | P1 |
| Musical role | grid position, metrical weight, phrase, accent, density | med | **high** | P2 structure | no | no | **P1** |
| Object context | type, pattern class, spacing, combo, existing hitsounds | med | **high** | P5 reader | no | no | **P1** |
| **Viterbi decision** | sequence labelling with consistency/symmetry/refractory costs | high | **high** | all above | no | no | **P1** |
| Explanations | itemised terms + alternatives from DP marginals | med | **high** | decision | no | no | **P1** |
| Profiles | 7 built-in + custom, as TOML data | low | high | decision | no | no | **P1** |
| Hitsound timeline | instrument lanes over object lanes, toggleable | med | **high** | P3 timeline | no | yes | **P1** |
| Hitsound editor | change/remove/volume/sample, apply to selection/pattern/section | med | **high** | decision | no | no | **P1** |
| Sample bank | import skin/folder, detect samples, audition against the song | med | high | P4 playback | no | no | P1 |
| Sample recommendation | map a bank's samples to roles by their own spectral profile | med | med | bank, features | no | no | P2 |
| Hitsound export | only hitsound fields change; `_hitsounded.osu` | med | **high** | P5 writer | no | no | **P1** |
| Consistency check | flag objects whose sound disagrees with their role or neighbours | low | high | decision | no | no | P2 |

---

## Phase 7 — Validation and mapping analysis

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Validation rules | duplicate points, very short sections, impossible changes, suspicious offsets, octave mistakes | med | **high** | P5 | no | no | **P1** |
| Hitsound validation | missing samples, silent assignments, inconsistent patterns | med | high | P6 | no | no | P1 |
| Alignment report | objects not on attacks; attacks with no object | med | high | P5 | no | no | P1 |
| Never auto-fix | every finding is a proposal with a diff and a consent step | low | **high** | rules | no | no | **P1** |
| Density analysis | objects/s, stream/burst/jump breakdown over time | low | med | P5 | no | no | P2 |
| Rhythm pattern recognition | recurring rhythmic figures, for consistency checking | high | med | P2, P5 | opt | no | P3 |

---

## Phase 8 — Automation

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| CLI rewrite | `analyze · timing · hitsound · validate · inject · export · bench` | med | **high** | P1, P5 | no | no | **P1** |
| Machine-readable output | `--json` on every command | low | high | CLI | no | no | P1 |
| Batch folder analysis | parallel across files, results table, non-zero exit on failure | low | high | CLI | no | no | P1 |
| Batch hitsounding | many difficulties, one audio analysis reused | low | high | P6 | no | no | P1 |
| Project format | `project.toml` + keyed binary cache; reopen without recompute | med | high | P2 cache | no | no | P1 |
| Watch mode | re-analyze on file change | low | low | CLI | no | no | P3 |

---

## Phase 9 — Experimental

Nothing here is promised. Each item is a hypothesis with a way to test it.

| Feature | What it does | Diff | Imp | Deps | ML | GPU | Pri |
|---|---|:--:|:--:|---|:--:|:--:|:--:|
| Drum classifier (CNN) | small mel-patch model vs calibrated templates | high | med-high | P6 corpus | **yes** | opt | P2 |
| Vocal onset model | the weakest classifier; the best ML candidate | high | med | P6 | **yes** | opt | P2 |
| Learned structure | section labels from a small embedding | high | low-med | P2 | **yes** | opt | P3 |
| Full drum transcription | complete kit transcription as its own output | high | med | classifier | yes | opt | P3 |
| Timing suggestions | propose red lines a mapper is missing | med | med | P7 | no | no | P2 |
| Waveform annotation | user notes pinned to timeline positions | low | low | P3 | no | no | P3 |
| Plugin API | third-party analysis stages | high | low | P0 rules | no | no | P3 |
| WASM engine | the core in a browser for a web demo | med | low | P1 | no | no | P3 |

---

## 11. Rejected — and why

The brief asks which of its own ideas are real and which are features for the sake of
features. These are the ones I would not build:

| Idea | Verdict |
|---|---|
| **Aim / speed / rhythm difficulty visualisation, strain graphs** | **Drop.** osu!'s own star-rating system and `osu-tools` already do this, better, with the official algorithm. Duplicating it here would be a worse copy of something mappers already have, and it does not feed any decision this tool makes. Object density — which *does* feed hitsound decisions — is kept |
| **"Suspicious map detection"** | **Reframe, don't build.** As stated it is a vibe. The useful content is the concrete validation rules in Phase 7. Anything beyond them is an accusation the tool cannot support |
| **Project sharing / export** | **Drop for now.** An offline single-user tool has no sharing story worth the format-stability commitment. Exporting a `.osu` and a CSV already covers real needs |
| **Automatic BPM detection** as a separate feature | **Already the product.** Listing it as new suggests a generic BPM detector, which is explicitly what this tool must not become |
| **Automatic timing** end-to-end with no review | **Won't build.** The octave is a human judgement and always will be; shipping "trust me" contradicts the tool's one real promise. Timing *suggestions* with confidence, yes |
| **Full automatic hitsounding with no review** | **Same.** The output is a first pass. The editor and the explanations are the feature; the automation is the convenience |
| **Chorus / verse detection** as a headline | **Keep, demote.** Cheap given the structure analysis Phase 2 needs anyway, and genuinely useful for per-section hitsound profiles. Not worth its own phase |
| **Cloud anything** | **Never.** Offline is a product property |

---

## 12. Sequencing summary

```
P0 gates ──► P1 parity ──┬──► P2 analysis ──┬──► P6 hitsounds ──► P7 validation
                         ├──► P3 UI ────────┤
                         ├──► P4 playback ──┘
                         └──► P5 osu! ──────────► P8 automation ──► P9 experiments
```

P3, P4 and P5 are independent of each other and can proceed in parallel once P1 is green.
P6 is the largest single body of work and depends on P2, P3 and P5 — it is deliberately
late, because a hitsound engine on top of an unvalidated tempo engine would be building on
sand.
