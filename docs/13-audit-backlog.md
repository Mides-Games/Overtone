# Audit backlog

Findings from the 2026-09-22 audit that its own verifiers confirmed (three votes for
high severity, one for medium and low). The five leads the roadmap listed as "to verify"
were re-probed and fixed on 2026-09-23 (PRs #22–#26); the four bugs reproduced before that
were fixed in PRs #17–#20; the six high findings below were fixed the same day (PRs
#29–#34); forty-five medium ones since (PRs #36–#38, #40–#43, #45–#48, #50–#61,
#63–#66, #69, #71–#77, and one #20 had fixed already), and the Opus half of the last
closed by decision: it stays refused. **Open: 40 — none high, none medium, all low.** Nothing still open has been re-probed yet: each gets a probe before its
fix, and some may turn out to be fixed already (the ×2 / ÷2 edit guard, for one, landed in
PR #20).

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

## Low (40)

| Area | Where | Finding | What goes wrong |
|---|---|---|---|
| py-engine | `timing_analyzer.py:530` | _choose_subdivision's 'octave-down safety net' is a no-op: both branches return 1 | The legacy tracker locks at double time (e.g. 340 BPM on a 170 BPM song). The documented safety net never fires, and the 340 BPM reading is exported. |
| py-engine | `timing_analyzer.py:769` | Colliding re-timed attacks keep the earlier one, not the stronger one as the comment claims | A soft flam or pre-echo 2-3 ms before a strong hit is kept with its low weight, and the main hit is discarded. The strong attack's weight disappears from the coherence and IRLS stages, and the kept time is the grace not… |
| py-engine | `timing_analyzer.py:1954` | Legacy global_bpm is averaged with a quantized tempogram guide, which makes it less accurate | On the fallback path the GUI/summary 'Global BPM' is further from the truth than the engine's own measurement (error 0.66 instead of 0.075 BPM on odd-222.22), and it changes when the user presses ×1 again. |
| py-gui | `timing_analyzer.py:2802` | Leftovers from the retheme: unused ACCENT2 purple, a 'pink dot' comment and a wrong window width in a comment | A contributor who trusts the comment tunes button padding against 1180 px and crops 'Export' at the real 1120 px default. The unused purple constant invites reintroducing a second accent colour. |
| py-gui | `timing_analyzer.py:3040` | Spanish UI still shows English strings: 'Language' label, delete-§1 error, trace title and hover | With Español selected, the header reads 'Language' next to the combobox and the canvas title says 'TEMPO TRACE' while the label above it reads 'CURVA DE TEMPO …'. Trying to delete §1 shows 'Error: The first timing point… |
| py-gui | `timing_analyzer.py:3484` | Every edit clears the row selection and refills the editor with §1, so the nudge buttons cannot be pressed twice | The user selects §4 and presses '+1' (ms). The offset moves by 1 ms. They press '+1' again and get 'Select a table row first.' with no change, so each 1 ms step needs a fresh row click. After '2× §' on §4, the status sa… |
| py-io | `test_timing_analyzer.py:1030` | test_config_tolerates_garbage depends on whether ~/.timing_analyzer.json exists | On a machine that still has a pre-rename ~/.timing_analyzer.json, the `{not json` assertion `load_config() == {}` fails. The suite's 76/76 gate then depends on the developer's home directory. |
| py-io | `timing_analyzer.py:2082` | CSV export writes raw offsets while the table, .osu, .osz and click track use snapped ones | With the points from the snap finding, the table and the .osu show section 2 at 10000.0 ms while the CSV saved from the same screen says 10100.000. Anyone comparing the CSV against the map sees a 100 ms disagreement. |
| py-io | `timing_analyzer.py:2299` | nudge_timing_point turns any negative offset into 0 whichever way it nudges, and never refreshes beat_index despite its docstring | A mapper whose first red line is at -20 ms (an anacrusis, or audio that starts immediately) presses nudge -1 ms and the point moves +20 ms instead. The CSV beat_index column (line 2082) is stale after any nudge. |
| py-io | `timing_analyzer.py:2539` | Atomic .osu/.osz/.bak writes never fsync before rename | A power loss or OS crash just after os.replace can persist the rename before the file data, leaving map.osu empty or zero-filled. The first inject has a .bak to recover from; later injects do not (see the .bak finding). |
| py-io | `timing_analyzer.py:3952` | Flags that need another flag are silently ignored, and flags without an audio argument open the GUI | `python timing_analyzer.py --inject map.osu` (audio forgotten) opens the GUI and ignores --inject with no message. `python timing_analyzer.py song.mp3 --title X` writes no metadata anywhere and does not say so. |
| py-io | `timing_analyzer.py:3961` | CLI progress and error messages go to stdout, mixed into the red-line output | `python timing_analyzer.py song.mp3 > timing.txt` writes 4-5 progress lines ahead of the '// Generated' comment and the red lines. Pasting that file into [TimingPoints] adds lines that are neither comments nor timing po… |
| py-io | `timing_analyzer.py:3982` | CLI crashes with a traceback when --click has an unknown extension or a missing directory | `python timing_analyzer.py song.mp3 --click click` prints a Python traceback instead of 'Error writing output: …'. The GUI path at 3626 catches Exception, so the two front ends behave differently. |
| rust-core-audio-bench | `CLAUDE.md:47` | CLAUDE.md/AGENTS.md still say `cargo test --workspace` is 75/75 | A contributor who sees 176 passed may think the count gate is broken. If tests were lost, the documented number cannot flag it, because the expected count is no longer the real one. |
| rust-core-audio-bench | `main.rs:267` | Weight stage is gated by an affine-invariant Pearson r, not the documented tolerance | A port change that scales every attack weight by 2, or adds a constant (for example normalising the envelope by a different percentile), gives r = 1.0. The weight stage then reports 'ok' even though every weight is off… |
| rust-core-audio-bench | `main.rs:1135` | Bench usage message omits the map and nogrid modes | A user who mistypes a mode is shown a list that hides the no-grid refusal gate and the coherence-map gate, so those checks are easy to forget. |
| rust-core-audio-bench | `lib.rs:199` | weighted_median picks a different section than v3 at exact half-weight ties | Sections at 120/128/140/150 BPM with durations 38, 56, 20 and 114 s. v3's `_weighted_median` returns 140.0 (checked in the venv). The Rust accumulation reaches 0.49999999999999994 after the third section and returns 150… |
| rust-dsp-new | `bandpass.rs:18` | EDGE_PAD comment claims biquad ringing dies within dozens of samples; band 0 needs ~2000 | For audio that starts or ends non-silent (a chunk, or a track cut mid-note), band 0's output near both edges carries a start-up transient of about 2% of the step 2*y[0] − y[pad]. That is an offset bias in the first and… |
| rust-dsp-new | `bandpass.rs:186` | `band_limited_retiming_beats_full_band_under_a_hat` never uses the band bank and does not pin the 'halves the smear' claim | A change to Biquad::lowpass or retime that loses most of the improvement, say 1.4 ms instead of 0.96 ms, keeps this test green while the roadmap still claims a halving. The test name implies the bank itself is validated… |
| rust-dsp-new | `classify.rs:28` | REPEAT_COSINE doc overstates the separation: triads a fourth apart score ~0.68, not 0.3–0.5 | Someone tuning REPEAT_COSINE from the documented 0.3–0.5 range believes there is a 0.4+ margin below 0.90. The real margin is about 0.2, so lowering the threshold toward 0.7 would start merging chords a fourth apart. |
| rust-dsp-new | `hpss.rs:59` | 'H + P == S everywhere' is false wherever both medians are below ~1e-6 power | In near-silent bins (fades, the region above an MP3's 16 kHz lowpass, dither), H + P drops up to 99% of S. Energy ratios computed as P/S rather than P/(H+P) are biased there. The absolute energy is small, but the stated… |
| rust-dsp-new | `mfcc.rs:5` | docs/06 says phrase novelty runs on chroma + MFCC; structure.rs excludes MFCC and mfcc() has no caller | A reviewer checking phrase-position behaviour against docs/06 expects timbre-driven boundaries (same chords, new instrumentation) to be found. They are not, and the MFCC module the docs rely on is dead in the pipeline. |
| rust-dsp-new | `multiband.rs:18` | Multiband band layout disagrees with its own comment and with the band tables in docs/06 and docs/10 | Hat and cymbal energy above 11 kHz (docs/06: 'air 11k+ cymbal shimmer, crash') moves no multiband band. The index returned by band_flux is also not comparable to hitsound's band_ratios index, although roadmap line 133 s… |
| rust-dsp-new | `structure.rs:149` | The left-to-right merge chain can drop a boundary that is more than MERGE_S from every kept boundary | Two real phrase boundaries 5-8 s apart, with a rising texture ripple of at least 30% of the maximum between them, collapse into one boundary. The earlier phrase edge is silently lost. |
| rust-dsp-new | `structure.rs:161` | `merged.retain(/&i/ i > 1)` is unreachable filtering: novelty is zero for the first KERNEL_HALF windows | A reader believes leading-silence and track-start transitions are detected and filtered here. In fact, no boundary within 4 s of either end of the track can ever be reported, and nothing documents that. |
| rust-dsp-parity | `retime.rs:76` | retime picks the last maximum energy index where v3's np.argmax picks the first | Two separate bursts in the 42 ms search window reach exactly the same peak energy, with a dip below the 20% level between them (digitally generated or hard-clipped material with dyadic sample values). Rust then snaps th… |
| rust-dsp-parity | `stft.rs:63` | stft.rs says the last frames can run past the padded buffer; they cannot, so the defensive branch is dead | The comment misstates the centred-frame geometry the module is meant to document. A later change to frame_count or the padding, such as a streaming or chunked STFT, could rely on this silent zero-fill and quietly produc… |
| rust-dsp-parity | `05-dsp-pipeline.md:88` | The contract says the v3 fallback envelope 'ports as OnsetFn::Flux1024'; no such type or fallback exists | A reader of the contract believes the degraded-envelope path from v3 (timing_analyzer.py:140-146, `except Exception: env = _fast_onset_envelope(...)`) exists in v4, and may cite it when reasoning about robustness or par… |
| rust-hitsound | `role.rs:167` | role::analyze panics for an attack time ≥ duration + 1 s (slice out of range) | If role::analyze is fed object times (Phase 5 object context) or attacks from a different/longer decode than `y`, one time past the audio end by more than 1 s crashes the whole analysis instead of reporting energy 0. |
| rust-hitsound | `template.rs:76` | Silent attack reads as 'never decays' and is classified Snare (30%), not other | An attack on digital silence, or one on the noise floor after a fade, is labelled Snare with Cymbal as the alternative, and 'other' gets 5%. Doc §3/§12 say an attack the engine cannot characterise 'must not be forced in… |
| rust-hitsound | `template.rs:531` | Calibrated template weights exist only inside #[cfg(test)]; the public API ships hand-set weights (F1 0.07 per commit 92b3ddd) | Any consumer (the future decision engine, CLI or explain output) calling `classify(&initial_templates(), …)` gets the uncalibrated classifier with near-chance F1, and the explanations show hand-set contributions that we… |
| rust-hitsound | `07-roadmap.md:227` | Stale or false text: roadmap 8 classes / F1 0.85 vs 0.91 / 18 tests; corpus 'Eight classes' and 'metallic partials'; phantom `frame_of` param | A reader of the roadmap or module docs gets the wrong class count, conflicting accuracy numbers, and a wrong idea of what the corpus renders and what extract() expects. |
| rust-tempo-core | `coherence.rs:77` | coherence::candidates is documented and tested as 'slowest first' but returns ascending period (fastest first) | A caller relying on the doc takes `candidates(...)[0]` as the fundamental and gets the fastest widened candidate, e.g. a 0.055-0.2 s subdivision, instead of the slowest pulse. That would be an octave-level error at the… |
| rust-tempo-core | `octave.rs:331` | octave::phase_class is dead code that duplicates sections::phase_class and breaks ties differently | If someone wires octave::phase_class in (it is public and documented as 'which atom class inside a beat carries the accents'), tied class means return m-1 instead of 0. The phase of every non-first beat section then shi… |
| rust-tempo-core | `octave.rs:499` | map_preference_breaks_a_tie_towards_osu_range passes with the preference switched off | If the `prefer_map_bpm && in_range` +0.40 term (octave.rs:319) were dropped or its range changed, this test would stay green. That term decides octaves on real tracks (the bench passes prefer=true), and audit F-07 notes… |
| rust-tempo-density-elastic | `density.rs:227` | Density chooses between subdivisions on the raw score; the prototype compares scores rounded to 3 decimals | If sub=2 scores 0.3341 and sub=4 scores 0.3344, the prototype rounds both to 0.334 and keeps sub=2. Rust picks sub=4, which can carry a different run and therefore a different boundary_s and side. |
| rust-tempo-density-elastic | `density.rs:338` | The 'six-second drop' density test passes even with the parity discriminator disabled | If the port dropped or inverted the parity condition, or used the wrong residue in window_stats, a_six_second_drop_is_not_a_pulse_change would still pass. Its comment says it guards a property it never reaches. |
| rust-tempo-sections | `points.rs:496` | osu_timing_text rounds x.5 ms offsets up and writes meter 1 for meter_known points with meter 0, where v3 does otherwise | A point at exactly 400.5 ms is written as `400,...` by v3 and `401,...` by Rust. A meter_known point with meter 0 is written with 1 beats per bar by Rust and with the analysis meter (for example 3) by v3. |
| rust-tempo-sections | `sections.rs:130` | Atom and beat sections from growth carry the quality() inlier count, not v3's _refine_grid mask count | Any consumer or diagnostic that reads GridSection.inliers from atom_sections or beat_sections (beat_sections copies it unchanged) gets a different number than v3, and the 'stage by stage' gate cannot see it. |
| rust-tempo-sections | `sections.rs:428` | Dead `classes` vector in phase_class and a duplicated BPM helper in merge_sections | No runtime failure. It is leftover scaffolding in a precision-critical function that a reviewer has to reason about, and a future edit could make the two BPM helpers diverge. |
