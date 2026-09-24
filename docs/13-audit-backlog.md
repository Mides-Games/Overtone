# Audit backlog

Findings from the 2026-09-22 audit that its own verifiers confirmed (three votes for
high severity, one for medium and low). The five leads the roadmap listed as "to verify"
were re-probed and fixed on 2026-09-23 (PRs #22–#26); the four bugs reproduced before that
were fixed in PRs #17–#20; the six high findings below were fixed the same day (PRs
#29–#34); forty-five medium ones since (PRs #36–#38, #40–#43, #45–#48, #50–#61,
#63–#66, #69, #71–#77, and one #20 had fixed already), and the Opus half of the last
closed by decision: it stays refused. All forty low ones were closed on 2026-09-24,
five of them found already fixed. **Open: none.**

File paths are as the audit saw them: `timing_analyzer.py` is today's `overtone.py`,
and line numbers have moved since.

## High — all six fixed on 2026-09-23

Each was reproduced with a probe first, fixed in Python and Rust where both apply, and
landed with a test that fails on the old code.

| Finding | Measured | PR |
|---|---|---|
| ÷2 / ÷4 deleted real tempo changes (dedupe threshold not scaled by the factor) | changes kept at ÷4: tiny-change 1/2 → 2/2, secs-4 2/4 → 4/4 | #29 |
| Export snapping moved hand-placed red lines by up to a quarter beat | tolerance 1 ms (real rounding ≤ 0.026 ms); hand-placed lines never move; ranked real map within 10 ms 8.1 % → 14.4 % | #30 |
| A change's red line one beat late when the boundary beat sits µs before the start | fixed at the function level in both languages; the end-to-end cliff did not reproduce (0/77 constructions, 0/100 renders) | #31 |
| Stray attacks before the music threw away the grid | click before drums: fallback at 295.3 BPM → precision at exactly 150.000, red line within 0.1 ms | #32 |
| Sparse random attacks got a grid (no-grid verdict) | random attack times 18–22/40 → 0/40; rendered random clicks answered 63/240 → 12/240, none by the precision engine | #33 |
| Rust hitsound flux compared an 8192-point spectrum with a 4096-point one | steady tone 0.9996 → ~0; nine test seeds, 450 hits: 35 → 29 wrong, macro F1 0.913 → 0.931 | #34 |

## Medium — fixed since

| Finding | Measured | PR |
|---|---|---|
| `.bak` written in place, then never replaced | a backup write failing halfway left a truncated `.bak` -> leaves none; a map edited between two injects went unkept -> kept in `.bak2`, byte for byte | #36 |
| Rust decode dropped a rejected packet, shifting everything after it | one bad MP3 frame: every later click 26.1 ms early -> on the same sample as the intact file | #37 |
| (new) One analysis of a 5-minute song peaked at 3.7 GB of RAM | spectrogram and tempogram built in blocks: 3.7 -> 0.55 GB, the same red lines | #38 |
| A section's bar read one beat late when its downbeat is weak (the snare out-weighs the kick) | change renders 3/60 -> 0/60; first red line on a ranked map's 1: 36/88 -> 40/88 | #40 |
| `_grow_sections` stops after 64 passes on a long mix | 15-minute grid: coverage ended at 576.5 s -> reaches the last attack | #41 |
| The fallback tracker ignored ÷2 / ÷4 and read x1 as "force" (two findings) | kit read at 199.5: ÷2 ignored -> 99.8 BPM, on the first kick | #42 |
| The fallback tracker answered scattered clicks | 12/240 random renders -> 1/240; 0 of 55 real songs refused | #43 |
| A wrongly typed value in `~/.overtone.json` crashed the classic window at every launch (two findings) | `"cfg_version": "2"` raised TypeError -> opens with defaults | #45 |
| Ctrl+C in a text field replaced the clipboard with the timing block | copy_osu from the offset and BPM fields: 2 calls -> 0 | #46 |
| CSV export failed silently on a locked file | FileNotFoundError out of the callback -> "Error: ..." in the status bar | #47 |
| `.osz` audio lost its extension on long names or "..." | "(Extended Club " / "Title_wav" -> ".wav" kept, matches AudioFilename | #48 |
| ×2 / ÷2 silently discarded hand edits | already fixed by #20 (asks first); re-probed 2026-09-23, covered by `ClassicWindowEditGuardTests` | #20 |
| x2 on the fallback tracker read an unrelated BPM on a bare click (found 2026-09-23) | click 120 at x2: 186.0 -> 240.1; auto results identical on 27/27 real songs | #50 |
| With no bar claimed, the first red line followed noise before the music (found 2026-09-23) | `very-noisy-132`: -34.65 -> 419.897 ms (truth 420) | #51 |
| Rust broke ties to the last maximum where v3 takes the first (three findings) | beat_from_atoms on equal weights (2, 1) -> (2, 0), as v3 | #52 |
| Rust hour cap assumed 44.1 kHz stereo; no tests of the load contract (two findings) | 30 min at 96 kHz stereo: refused at 27.6 min -> accepted; every clause tested | #53 |
| Bench modes passed on missing audio; "analyse" timed attacks only (three findings) | missing fixture -> exit 1 naming its script; corpus 4.2 s end to end vs Python 18.5 s (not 2.5 s vs 21.6) | #54 |
| DSP contract and bandpass doc described what the code does not do (three findings) | peak distance 9 frames, dedupe keeps the earlier, own-band re-timing recorded as rejected | #55 |
| `meter_segments` kept or dropped a one-window region on float rounding | 4-bar 3/4 interlude, 37 start offsets: found 0/37 at a 1.2 s bar -> 37/37 | #57 |
| Peak picking broke equal-height ties rightmost-first and claimed scipy did | tied pairs [25, 44] -> [20, 40]; scipy's own order is unstable, so the rule is pinned | #58 |
| The golden gate never read the envelope; weights only by correlation | a symmetric Hann window now fails 24/24 (sum 4.7-6.6 off) where it passed | #59 |
| The golden gate never exercised a proven bar or the measure grid | confidence and bar compared (#60); three bar fixtures added, 8 proven-bar red lines, Rust 27/27 | #60, #61 |
| Hitsound "macro F1 0.91" judged a re-draw of its own training track; a class could collapse unseen (two findings) | held out: the old templates read 0.485; trained on varied arrangements 0.650; per-class floor | #63 |
| Hitsound sub-attack and decay windows off spec | flams counted after the attack (0.650 -> 0.658); the spec's decay window collapsed Clap to 0.00, so the doc now states the measured one | #64 |
| Hitsound pitch window cut to 93 ms, unwindowed | whole 20-300 ms, Hann: 0.658 -> 0.679, Vocal 0.74 -> 0.86, Keys 0.40 -> 0.67 | #65 |
| Hitsound role: 16ths on the 8th weight; no grid scored as a downbeat (two findings) | 16th 0.25 -> 0.10; no grid -> None; unproven bar -> 0.5; bar per section | #66 |
| Elastic grid diverged from its prototype: upper median, a ladder break dropped the degree, polyfit weights rooted twice (three findings) | change-128-142 and secs-2 degree 2 -> 1; worst invented drift 29.6 % -> 4.9 %; every case the prototype runs reads its digits | #69 |
| Structure, classify, band flux and HPSS built the whole-track linear spectrogram | structure mode peak 204 -> 23 MB on 60 s, 81-88 MB at six minutes; hitsound HPSS separates only the frames it reads, bit-identical | #71, #73 |
| Structure's chroma windows drifted against its 0.5 s energy windows | Am -> F at 240 s: boundary 240.5 -> 240.0 s | #72 |
| HPSS time kernel barely past the STFT window: isolated hits read as sustained | click 0.885 -> 1.00 percussive; with every template expecting it, held-out F1 0.679 -> 0.723 (chosen on a validation set: 0.677 -> 0.707) | #74 |
| A chorus on the verse's chords was labelled Verse | V C V C at +6 dB: all Verse -> V C V C; 0 of 39 fixtures' labels moved | #75 |
| Resampler evaluated 65 sin() per output sample; its speed was never measured | six minutes at 48 kHz: 12.25 -> 0.73 s | #76 |
| v4 could not open AIFF or Opus | AIFF decodes to the WAV's samples; Opus refused by name | #77 |
| v4 cannot decode Opus | decided 2026-09-23: it stays refused, with what to convert it to. A decoder means libopus, a C build on every Windows machine | decision |

## Low — all forty closed on 2026-09-24

Each re-probed first; the fixes that change behaviour landed with a test that fails on the
old code, and the ones that only needed the words to match the code say so.

| Finding | Outcome |
|---|---|
| `_choose_subdivision`'s octave-down safety net was a no-op | dead branch removed and the docstring made true: the chooser never halves, ÷2 is the way back; behaviour unchanged |
| Colliding re-timed attacks keep the earlier one, not the stronger | already true of the comment: "keep the earlier of any pair within 4 ms, whatever the weights", as the code and the Rust port do |
| Legacy global BPM averaged with a quantized tempogram guide | plain median of the tracker's own tempo: legacy-engine median error 0.391 → 0.173 BPM over 16 cases (14 better, 2 worse); every gate unchanged |
| Retheme leftovers in the classic window | unused ACCENT2 removed, comments corrected |
| Spanish classic window still showed English | Idioma, CURVA DE TEMPO, confianza and the §1 refusal translated |
| Every edit cleared the selection, so nudges could not repeat | +1 twice from 21000 → 21002 with the point still selected (was 21001, then "select a row") |
| `test_config_tolerates_garbage` read the real config | both config paths patched; the test never touches the home directory |
| CSV wrote raw offsets, every other export snapped ones | 11000.400 → 11000.000, as the table and the .osu |
| `nudge_timing_point` floored negative offsets at 0, left beat_index stale | −5 from −3 → −8 (was 0); +1000 ms moves beat_index 10 → 12 |
| Atomic writes never fsync before rename | each temp file synced before its rename (speed not measured) |
| CLI flags needing another flag were ignored; flags without audio opened the GUI | usage errors naming the missing flag (exit 2); --engine reaches every file of a folder |
| CLI progress and errors on stdout | stderr; `--json --osz` prints valid JSON |
| CLI traceback on a bad `--click` path | "Error writing output: …", exit 1 |
| CLAUDE.md said `cargo test` was 75/75 | long stale; `bench/facts.py` now checks every stated count against the source |
| Golden weights gated by Pearson r | each weight within 2e-5 since #59 |
| Bench usage omitted modes | every mode listed |
| `weighted_median` split half-weight ties unlike v3 | sum then divide, as `cumsum/total`: 32,624 of 249,689 constructed ties disagreed → 0 |
| `EDGE_PAD` comment: ringing dies in dozens of samples | band 0 rings 1,992 samples; pad 1024 → 4096, edge transient 6.5 % → under 1e-6 of band RMS |
| Band re-timing test never used the band bank | it does, and pins the smear: lowpass 0.964 ms against 1.863 full band |
| REPEAT_COSINE doc overstated the chord separation | already fixed by the chroma fix; the doc gives the measured 0.23–0.38 (fourths) and 0.548 (closest other chord) |
| HPSS "H + P == S everywhere" false in quiet bins | masks scaled as librosa's: bins losing energy 727,347 of 883,550 → 0 |
| docs/06 said phrase novelty uses MFCC | docs say MFCC is built and unused; novelty is chroma + energy |
| Multiband layout disagreed with its comment and the docs | comment and docs/10 describe the log-spaced bands as built |
| Structure merge chain could drop a boundary | strongest first: peaks at windows 10 / 16 / 22 keep [10, 22] (was [22]) |
| Structure edge filter could never fire | removed; the 4 s blind zone at each end is documented and pinned |
| `retime` took the last of equal maxima | the first, as np.argmax, since #52 |
| stft.rs claimed frames run past the padding | true comments since #71; the test reference indexes the padded copy directly |
| DSP contract named a nonexistent `OnsetFn::Flux1024` | docs/05 says the v3 fallback envelope was not ported |
| `role::analyze` panicked past the end of the audio | the window clamps; energy past the end reads 0 |
| A silent attack read as Snare | reads as Other (probability 1) |
| Calibrated hitsound weights existed only in tests | public `calibrated_templates()`; `initial_templates()` documented uncalibrated (held out 0.231 against 0.723) |
| Stale hitsound text in the roadmap and corpus | corpus comments and roadmap lines corrected |
| `coherence::candidates` documented slowest first | says fastest first, ascending period, in both engines |
| `octave::phase_class` was a dead duplicate | removed; its tests use `sections::phase_class` |
| Map-preference test passed with the preference off | unaccented 0.19 s grid; the test fails with the bonus off |
| Density compared raw scores; the prototype rounds | compares the prototype's rounded score; bench output byte-identical |
| Drop test passed without the parity guard | its comment says what keeps it quiet; the sparse-region test pins parity |
| `osu_timing_text` rounding and bar-less meters differed from v3 | half to even (1000.5 → 1000) and a proved bar of 0 falls back, as v3 |
| Growth sections counted inliers at another tolerance than v3 | the refinement's own mask; golden now compares inliers (within one: a float tie at a step edge; was up to 62) |
| Dead `classes` vector and a duplicated BPM helper | removed |
