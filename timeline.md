# Timeline

Engineering log for Overtone: what changed, **why**, and what it measurably did.

Newest first. One entry per release. Each entry keeps the same four sections so a
future reader can skim for the one they need:

- **Changed** — what the release does differently.
- **Fixed** — bugs, with the root cause, not just the symptom.
- **Hardening** — robustness and security work.
- **Measured** — numbers, or "not measured" if there aren't any.

A `Rejected / tried and dropped` section is worth adding whenever an approach was
attempted and abandoned — the reasoning is the expensive part, and re-deriving it
later costs more than writing it down now.

---

## v4.0.0-dev — 2026-09-24 · Reference timing, and what 30 ranked maps say about offsets

The next sidebar mode on the roadmap: any map of the song, graded line by line against the
attacks Overtone hears. Measuring it on real ranked maps turned up the offset bias the
roadmap had only guessed at.

### Changed

- **Reference timing** (Map check card). Choose any `.osu` of the song, or find every map of
  the same audio in a Songs folder. Each red line's span is fitted from the map's own grid
  with the engine's tools: the phase mode first, then least squares on windows that double
  forward from the line. It is read at the coarsest of 1/1-1/4 that explains the attacks.
  Per line the card shows:
  - its offset against the map's common shift, and its drift at the span's end, each with
    two standard errors;
  - the fitted BPM and the share of attack weight on the grid;
  - a verdict: ok, check (with offset and/or drift), weak or too few attacks.

  A line is flagged past 5 ms and past two of its own standard errors. The common shift is
  one banner, not a flag per line. Two lines that disagree with no majority say so rather
  than let the median pick a side. "Use as working timing" loads the map's red lines as
  hand-placed points with their own meters, keeps locked points, and is one undo step.
- **Same audio, byte for byte.** The card says whether the map's AudioFilename is the
  analysed file. Two encodes share a name but not an offset.
- **The fallback tracker's songs can be graded.** It keeps no attacks, so the bridge detects
  them once per song, under the one-heavy-job lock.
- **`reference/python-v3` is deferred.** `overtone.py` is the app's default engine and its
  only `.osu` reader and writer. A copy under `reference/` would keep changing, and a frozen
  split would stop the default engine taking fixes. It moves once Rust is the default and
  the osu! I/O is ported (roadmap, Phase 0; rule 4 in CLAUDE.md).

### Fixed

- The roadmap still counted 41 open audit findings after all were closed, and called the
  Rust engine unwired after Settings began running it.
- CLAUDE.md said "the last three" gates exist because the benchmark cannot see them. The
  list has grown to eight since then.

### Hardening

- **`gates.py reference`**: each corpus case timed four ways.
  - The true map must come back clean.
  - The whole map 10 ms late must read as one shift, within 1 ms, with no line flagged.
  - With three or four lines, moving one flags that line alone. With two, it is a split.
  - Every BPM 0.1 % high flags every line for drift.
- A fit that wanders more than -20 %/+25 % from the map's beat is stopped. On one real
  song it shrank every pass until the least squares overflowed.
- The Songs search lists folders with `os.scandir`, which carries each file's size on
  Windows.

### Measured

```
gates.py reference                  24/24; true maps worst 2.26 ms (shuffle-96, as the
                                    benchmark's worst); BPM +0.1 % drift ~1 ms per second
30 random ranked maps, local Songs  every map reads its attacks after its lines:
                                    median +26.2 ms, IQR +23.0..+30.9, range +12.1..+45.6
                                    MP3 +26.1 (n=27), OGG +27.2 (n=3): not the MP3 decoder
  their 318 red lines               207 graded; flagged: 206 against zero, 160 against the
                                    map's shift, 101 against the shift and their own errors;
                                    24 weak, 87 with too few attacks
  time per map                      0.6-10.2 s, decode and attack detection included
same-audio search, 4,798 sets       59,260 audio files; iterdir 20.7 s cold / 9.1 s warm ->
                                    scandir 0.8 s, same one match and four maps
Python unittest                     279 -> 298, all pass
benchmark.py                        24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures · signatures · robustness · facts
cargo test --workspace              231, all pass (no Rust changed)
```

The card was exercised in the built-in browser against replies frozen from the real bridge
on secs-3 with its last line moved 12 ms. It showed 2 ok and 1 to check (-12.5 ms,
offset), found the map by its audio, graded it from the list and loaded it (3 points).
Every banner rendered in Spanish, with no console errors.

### Rejected / tried and dropped

- **Judging each line's offset against zero.** On real songs every line of every ranked map
  was flagged (206 of 207), because of the +26 ms shift nobody has explained yet.
- **A common shift reported only when two or more lines all agree on it.** It hid the shift
  on single-line maps, which are most maps.
- **Weighing the majority by attacks.** With two lines the one with more attacks always
  won, even when it was the one moved. Lines vote, one each.
- **Fitting outward from the middle of the span** (the engine's `_expand_fit`). At the
  middle, a BPM 1.3 % off has already walked a beat, and the fit locked onto the wrong
  one: share 0.25, fitted 152.7 for a true 150. Fitting forward from the red line reads
  150.001 up to 3 % off.
- **A flat 5 ms bar.** Twelve ms of jitter over 40 attacks gives a 10 ms drift by chance.
  Two standard errors let it pass, and take real-map flags from 160 to 101.

---

## v4.0.0-dev — 2026-09-24 · Every audit finding closed; the app gets sections and the Rust engine

The forty low findings, in three batches worked side by side (tempo and bench, Python,
DSP and hitsounds), then the app: a real sidebar, two new map checks, and the v4 engine
behind a switch.

### Changed

- **Sidebar sections.** The sidebar had one entry that did nothing. It now switches between
  Library, Timing, Map check, Mapset, Export and Settings over one shared song. Nothing was
  removed; views that need a song say so. English and Spanish.
- **Mapset check** (new section): every difficulty of a folder side by side. It compares
  red lines, AudioFilename, PreviewTime, lead-in and metadata, and shows kiai spans and
  objects per second. Differences are listed, never fixed.
- **Snap audit** (Map check card): objects off the map's own grid at the editor's divisors,
  with the miss in ms. Also objects before the first red line or past the audio, and what
  injecting the detected timing would unsnap.
- **The Rust engine in the app**, opt-in (Settings). `overtone_rust` runs `overtone-cli
  --full` and builds v3's own `Analysis`. A forced pulse, a missing binary, audio with no
  grid or a file it cannot decode goes to v3, with a note saying why.
- **`overtone-cli`**: `analyze <audio>` prints the red lines; `--json` gives v3's report
  shape and `--full` adds the evidence an app needs. Exit codes: 0 grid, 3 refused,
  1 unreadable, 2 usage.
- **`calibrated_templates()`** is public; the hand-set templates are documented as
  uncalibrated.
- **The legacy tracker's global BPM** is its own median, no longer averaged with a quantised
  tempogram guide.

### Fixed

- **Tempo parity details.** Growth inliers are counted from the refinement mask. Half-weight
  ties in the weighted median, density's rounded score, `.osu` half-millisecond rounding
  and bar-less meters now match v3 and its prototype.
- **DSP.** The HPSS masks lost energy in quiet bins. Band 0's edge padding was too short
  for its ringing. The structure merge could drop a boundary. `role::analyze` panicked past
  the end of the audio. A silent attack read as Snare.
- **Classic window and CLI** (Python):
  - edits kept their selection, so nudges repeat;
  - nudging below zero works;
  - the CSV writes the snapped offsets;
  - the Spanish strings are complete;
  - CLI progress goes to stderr, and bad flags and `--click` paths end with a message;
  - writes are synced before rename.
- **Load errors say what is wrong.** Missing, empty and junk files each get their own
  message, not "install FFmpeg".
- **Three UI slips.** "Section #{n}" was printed literally, the alignment warning icon was
  malformed, and the point editor had a stray `</div>`.

### Hardening

- **Golden** fails on a vector missing a stage, and compares section inliers.
- **`gates.py robustness`** runs the audit's edge-case probes as one command. The CLI tests
  run the same probes on v4.
- **`bench/facts.py`** checks every test count, crate list and fixture count the docs state.
- **`.gitattributes`** keeps `.osu` CRLF.
- **Measuring modes** in the bench: `structure`, `resample`.

### Measured

```
Python unittest                  239 -> 279, all pass
cargo test --workspace           214 -> 231, all pass; fmt and clippy clean
benchmark.py                     24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures 3/3 · signatures 6/6 · robustness 18/18
overtone-bench golden 27/27; nogrid, density, elastic, map output identical to before
weighted median, 249,689 constructed exact ties   32,624 disagreements with v3 -> 0
golden section inliers                           up to 62 off -> within 1 (a float tie)
legacy tracker global BPM, 16 cases              median error 0.391 -> 0.173 BPM
Rust engine vs v3 through the app, five fixtures  beats within 6e-12 s, local BPM
                                                  identical, whole-ms .osu offsets identical
overtone-cli, release, one corpus song           ~0.1-0.2 s decode + attacks + tempo
held-out hitsound F1                              0.723, unchanged
```

The app was exercised in the built-in browser against the real bridge (a local harness,
not committed), in both languages:

- Mapset flagged the Hard difficulty's red line 10 ms off.
- Python and Rust both read 174.000 BPM on edm-174.
- Snap audit listed the 40 objects the moved line unsnaps.

### Rejected / tried and dropped

- **A structure edge filter that refuses boundaries in the first 4 s.** It would also drop
  a real change at exactly 4 s (a two-bar intro at 120 BPM). The blind zone is documented
  instead.
- **Rebuilding the multiband layout to match the old docs.** It would move the band bank
  and every B.6 measurement; the docs now describe the bands as built.

### Not measured

- The fsync cost of atomic writes.
- The Rust engine on real songs through the app (the corpus and synthetic clicks only).
- Mapset and snap audit on real mapsets beyond a two-difficulty test folder.

---

## v4.0.0-dev — 2026-09-23 · The last medium findings: elastic parity, memory, the percussive ratio

Eight medium findings, and half of the ninth. Each was reproduced first; each fix landed
with a test that fails on the old code.

### Changed

- **The percussive ratio means percussive** (#74). The HPSS time kernel is 33 frames, not
  17: a transient smears over the 16 hops of the STFT window, and a 17-frame median was
  the median of that smear. The templates had been designed against what the feature
  measured, so only the snare, clap and ride expected a percussive attack. Now every drum
  does, and every tonal source expects a harmonic one.
- **A chorus on the verse's chords is a Chorus** (#75): a repetition group whose members
  fall into a quiet and a loud family (two or more each, 3 dB apart) splits in two.
- **AIFF opens in v4; Opus is refused by name** (#77), with what to convert it to.
- **Two measuring modes in the bench**: `structure <case>` (whole-track spectral
  analyses; peak memory read from outside) and `resample` (speed; every fixture is
  44.1 kHz, so nothing else runs the resampler).

### Fixed

- **Elastic parity** (#69). Three divergences from `proto/elastic.py`, written off as float
  noise near the degree cliff: a tolerance ladder that broke off dropped the whole degree;
  `polyfit` rooted weights already rooted; the local median took the upper middle value.
- **Structure's chroma drift** (#72): 172 STFT frames per window is 0.49923 s, so harmony
  ran 0.37 s ahead of the energy windows by four minutes.

### Hardening

- **No whole-track linear spectrogram** (#71, #73). `stft::map_frames` reduces each frame
  as it is computed; structure, classify and band flux keep 12 or 7 values a frame, and
  the zero padding is read through the index instead of copied. The hitsound HPSS
  separates only the frames it reads, bit for bit what the whole-track one gives there.
- **The resampler tabulates its kernel per phase** (#76): 147 phases for 48 -> 44.1 kHz,
  65 multiply-adds an output instead of 65 `sin()` calls.

### Measured

```
elastic, worst invented drift            29.559 % -> 4.865 %   (prototype: 4.865 %)
  change-128-142 / secs-2                degree 2 -> 1, 15.41 / 12.49 ms, as the prototype
structure mode peak working set, 60 s    204 MB -> 23 MB; six minutes 81-88 MB
Am -> F at 240 s, structure boundary     240.5 s -> 240.0 s
hitsound HPSS, isolated 2 ms click       0.885 -> 1.00 percussive; 40 ms snare 0.55 -> 0.88
hitsound macro F1                        validation 0.677 -> 0.707, held out 0.679 -> 0.723
chorus on the verse's chords, +6 dB      all Verse -> V C V C; 0 of 39 fixtures moved
resample six minutes, 48 kHz             12.25 s -> 0.73 s (96, 32, 22.05 kHz alike)
gates: cargo test 214/214; overtone-bench golden 27/27, nogrid, density 4/4, elastic, map
```

The hitsound kernel and template design were chosen on a validation set (seeds 31-34)
that neither trains nor judges; the held-out set was read once, at the end. Most of the
gain is the tonal terms (Bass 0.84 -> 1.00 on validation), which work at either kernel;
the kernel adds +0.005 macro and lifts Clap, the weakest class, 0.13 -> 0.27 at the
closed hats' expense.

### Rejected / tried and dropped

- **The larger HPSS kernel with the old templates.** Held out it read 0.693, but on
  validation 0.671 against 0.677: the held-out gain was selection on the test set. The
  isolated gate also turned: kicks read as snares once they read as percussive.
- **Kernels past 33.** Validation 0.668-0.674 (41-65 frames), held out falling to 0.657 at
  129: short tonal notes start reading as percussive.
- **Rayon in the resampler.** 0.7 s for six minutes did not call for a new dependency.
- **An Opus decoder in v4.** The mature one binds libopus, a C build on every Windows
  machine. Decided 2026-09-23: Opus stays refused by name, with what to convert it to.

### Not measured

- Real songs, for any of the hitsound or structure numbers: nothing in the pipeline
  labels sections or classifies hits yet. The six-minute "before" memory (~1.2 GB) is
  computed, not run, to keep RAM free.

---

## v4.0.0-dev — 2026-09-23 · The hitsound engine, judged honestly

Six findings in the Rust hitsound engine. The first changes what every later number
means, so it went first.

### Changed

- **Held-out evaluation** (#63). The gate calibrated on render seed 11 and tested on seed
  12, but `render()` keeps one schedule whatever the seed — same hit times, class order
  and neighbours — so "macro F1 0.91" judged a re-draw of the training track, with 3-4
  hits per class and only the macro asserted. `render_shuffled` varies order, gaps and
  level; templates train on four arrangements and are judged on four others, and no
  class may fall below 0.10. **The old templates read 0.485 held out.**
- **Dev builds optimise the FFT dependencies and DSP kernels** (#63). Debug assertions
  and overflow checks stay on; the larger evaluation made the hitsound tests 108 s, and
  the workspace now runs in ~40 s against 46-51 s before.

### Fixed

- **Sub-attacks** are counted over the 30 ms after the attack, not from 10 ms before it (#64).
- **The pitch window** reads the whole 20-300 ms with a Hann window; the 4096-point FFT
  had cut it to 93 ms, rectangular (#65).
- **The metrical role** (#66): 16ths weigh 0.10, not the 8th's 0.25; no grid means no
  division or weight (it read as a downbeat); an unproven bar's beats weigh 0.5; each
  section brings its own bar. Nothing consumes `Role` yet, so no F1 moves.

### Measured

```
held out, 280 hits, 4 shuffled arrangements   old templates 0.485 (the "0.91")
  trained on varied arrangements               0.650
  + sub-attacks after the attack               0.658 (Snare 0.52 -> 0.62)
  + whole pitch window, Hann                   0.679 (Vocal 0.86, Keys 0.67)
hitsound tests (debug)                         108 s -> 23 s with the dev profile
gates: cargo test 202/202; overtone-bench golden 27/27
```

### Rejected / tried and dropped

- **The documented 20-200 ms decay window.** Held out, it collapsed Clap to 0.00 (macro
  0.659): past ~100 ms a dense mix's neighbour tails dominate the fit. The code keeps
  +10 to +120 ms and the doc now says so.
- **Welch averaging for the pitch window** (4096-point frames): 0.666 against 0.679 for
  one Hann-windowed FFT over the whole window.

### Not measured

- Any of this on real songs. Every figure above is synthetic.

---

## v4.0.0-dev — 2026-09-23 · One-window signatures, the peak tie rule, the golden gate's blind spots

### Fixed

- **A one-window signature region** (#57, Python and Rust) was compared with exactly its
  own length in seconds and kept or dropped by the last bit. Runs are counted in whole
  windows; a single window is four bars, which the rule says is enough.
- **Peak picking's tie rule** (#58, Rust). Of two equal peaks within the distance the
  rightmost always won, and the comment said scipy did the same. scipy's order comes from
  an unstable `np.argsort` and follows no rule (`RLRLRLLRRR...` on one envelope), so exact
  parity is out of reach: the earlier peak now wins, pinned by a test. A golden diff on
  an exactly tied case in future is v3's nondeterminism, not a regression.

### Hardening

- **The golden gate reads the envelope and every weight** (#59): envelope sum within
  2e-3 (measured noise at most 0.00098) and each matched weight within 2e-5 (measured
  5.4e-6, the stored rounding). Correlation alone had passed a symmetric Hann window.
- **And each red line's bar** (#60): confidence, meter and meter_known are dumped and
  compared in both checks. The 24 vectors were re-dumped for the fields; long-6min's
  5th-decimal weight drift from #38 went in with them.
- **Three fixtures with a proven bar** (#61): `downbeat-4-4`, `downbeat-4-then-3` and
  `signature-changes`, rendered by the gates' own builders — 8 red lines on a proven bar
  and the measure-grid path, none of which the corpus reached. v3's two bar-branch unit
  tests are ported to Rust by name.

### Measured

```
4-bar 3/4 interlude, 37 start offsets      found 0/37 (1.2 s), 0/37 (1.6 s), 32/37 (1.875 s) -> 37/37
tied peak pairs, distance 9 (Rust)         kept [25, 44] -> [20, 40]
symmetric Hann injected into stft.rs       golden passed -> fails 24/24 (sum 4.7-6.6 off)
red lines with a proven bar under the gate 0 of 34 -> 8 of 42; Rust matches 27/27 vectors
gates: 239/239 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 27/27; coverage, measures, signatures green; cargo test 201/201; overtone-bench
golden 27/27, nogrid 3/3
```

---

## v4.0.0-dev — 2026-09-23 · Rust parity, the audio contract, bench honesty

Eleven more medium findings in four PRs, after #50 and #51 above.

### Fixed

- **Ties** (#52, three findings). `Iterator::max_by` keeps the last of equal maxima;
  v3's `np.argmax` and `max()` keep the first. Every Rust site with a v3 or prototype
  counterpart now iterates in reverse first (octave and meter classes, tempo hint,
  coherence fallback, primary section, fallback red line, density runs, re-timing, the
  bench's best hint); `tempo_hints` orders tied prominences as `argsort()[::-1]`.
- **The Rust hour cap** (#53) counted interleaved samples against 44.1 kHz stereo, so a
  30-minute 96 kHz stereo FLAC was refused at 27.6 min. The decoder now downmixes each
  packet as it arrives (v3's frame mean) and the cap counts mono samples at the file's
  own rate; the rest of `load()` is a pure function with tests for every clause.
- **Bench honesty** (#54, three findings). A missing fixture is a failure naming the
  script that renders it (it was skipped, and 0/0 passed). The bench times decode,
  attacks and tempo apart; "analyse" had timed attacks only.
- **Stale contract** (#55, three findings): peak distance 9 frames / 26.1 ms, re-timing
  dedupe keeps the earlier attack, own-band re-timing recorded as measured and rejected.

### Changed

- **The speed figures.** "The whole corpus analyses in 2.5 s against Python's 21.6 s"
  compared decode + attack detection with Python's whole `analyze_audio`. Like for
  like, on 2026-09-23: 4.2 s against 18.5 s, about 4.4x (the 6-minute fixture 1.12 s +
  decode against 4.6 s). CLAUDE.md, AGENTS.md, the README and the roadmap now say so.

### Measured

```
beat_from_atoms, equal weights (Rust vs v3)   (2, 1) -> (2, 0)
30 min 96 kHz stereo (Rust hour cap)           refused at 27.6 min -> accepted
corpus, Rust whole pipeline                    decode 0.45 + attacks 2.26 + tempo 1.49 = 4.2 s
corpus, Python analyze_audio                   18.5 s
bench with one fixture moved aside             pass -> exit 1, names the script
gates: 238/238 Python; cargo test 197/197; golden 24/24, nogrid 3/3, density 4/4 with 0
false positives, elastic and map green
```

### Not measured

- Decode memory on multichannel files after the per-packet downmix.
- Python and Rust timings vary by up to a third between runs on this machine; the
  figures above are single runs.

---

## v4.0.0-dev — 2026-09-23 · The two findings from the fixes

Both were recorded on 2026-09-23 while fixing others; each was reproduced first and
has a test that fails on the old code.

### Fixed

- **x2 on the fallback tracker dragged the new beats onto old hits** (#50). Inserted
  beats were snapped to the loudest point of their window even when that point was the
  window's edge — the previous hit's tail — so a bare 120 BPM click read 186 at x2. An
  inserted beat now holds when its window's maximum is on the edge. Only for a factor
  the user asked for: on the tracker's own doubling it changed 9 of 27 real songs with
  no net gain against their ranked maps, so auto results are exactly as before.
- **With no bar claimed, the first red line followed noise before the music** (Python and
  Rust). The line was placed from the first attack of any kind; it is now placed from
  the first attack the grid counts as an inlier (within 0.12 of a beat).

### Changed

- **`very-noisy-132` re-dumped, on purpose.** Its noise starts at 0 s and gives an
  attack at 27 ms, 0.136 of a beat off the grid. The first red line sat at -34.65 ms, on
  the grid beat before the music; it is now at 419.897 ms, on the first beat (truth
  420 ms). The other 23 vectors are unchanged (`long-6min`'s 5th-decimal weight drift
  from #38 was again left as committed).

### Measured

```
bare click 120, x2 (fallback)                186.0 -> 240.1 BPM (rebuild 239.9)
kit read at 199.5, x2 (fallback)             519.2 -> 399.2
27 real songs on the fallback, auto          identical to the old code, 27/27
  (holding on auto: within 10 ms of the map 0.128 -> 0.125, not applied)
kit at 420 ms + noise burst at 27 ms         first red line -34.4 -> 420 ms
very-noisy-132 first red line                -34.65 -> 419.897 ms
gates: 238/238 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 after the re-dump; coverage, measures, signatures green; cargo test
194/194; overtone-bench golden 24/24, nogrid 3/3
```

---

## v4.0.0-dev — 2026-09-23 · The classic window's config, clipboard, CSV and .osz

Four medium findings from the classic window and the file writers (five backlog rows —
two described the same config crash), each reproduced first and each with a test that
fails on the old code. No engine code changed; the benchmark and golden vectors are
untouched.

### Fixed

- **A badly typed `~/.overtone.json` crashed the classic window at every launch** (#45).
  `load_config` checked only that the file held a dict. Each known key now has a type; a
  wrong one is dropped so the reader's default applies, `recent` keeps its strings, a
  bool is never taken for a number, unknown keys pass through.
- **Ctrl+C in a text field replaced the clipboard with the timing block** (#46). The
  shortcut, bound on the window, ran after the field's own copy. It now skips text
  fields; the web shell already did.
- **CSV export failed silently** (#47) on a locked file: the error went to stderr. It
  now reports in the status bar and does not count hand edits as exported.
- **`.osz` audio lost its extension** (#48) on names over 80 characters or with "...".
  Stem and extension are sanitised apart, and trimmed again after the cut.
- Re-probed: **×2 / ÷2 discarding hand edits** was already fixed by #20.

### Measured

```
config {"cfg_version": "2", "prefer_map_bpm": "on"}   TypeError at launch -> opens, defaults
Ctrl+C in the offset / BPM fields                     copy_osu 2 calls -> 0 (table: still 1)
CSV to an unwritable path                             FileNotFoundError -> "Error: ..." status
.osz audio "…Club Mix).wav" / "Title....wav"          "…(Extended Club " / "Title_wav" -> ".wav" kept
gates: 236/236 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green
```

### Not measured

- On a real display with a real clipboard: the Ctrl+C test mocks `copy_osu` and selects
  nothing, so it never writes to the clipboard of the machine running it.

---

## v4.0.0-dev — 2026-09-23 · Long mixes, the fallback's pulse factor, scattered clicks

Three more medium findings, each reproduced before its fix and each with a test that
fails on the old code.

### Fixed

- **Section growth stopped after 64 passes** (#41, Python and Rust). A 15-minute mix
  changing tempo every 9 s came out as 64 sections ending at 576.5 s; the last 323 s had
  no red line and nothing said so. Every pass advances at least `seed_s`, so the guard
  is now `ceil(length / seed_s) + 2` (never below 64).
- **The fallback tracker ignored ÷2 / ÷4 and read x1 as "force"** (#42). It took the
  factor as an absolute subdivision of its tracked beats. The factor now multiplies its
  chosen subdivision, as it does the precision engine's; halving keeps every 2nd / 4th
  tracked beat from the first (not the more accented phase — the snare bias again), and
  `rebuild_with_subdivision` shares the helper, so ÷2 in the app works on it too.
- **The fallback tracker answered scattered clicks** (#43). `MIN_PULSE_GAP` 0.05 -> 0.07.

### Measured

```
15-minute grid, 120/127 BPM every 9 s        64 sections to 576.5 s -> to 899.8 s
kit 100 read at 199.5, ÷2 (fallback)         199.5 -> 99.8 BPM, first red line on the 1st kick
kit 170, ÷2 (fallback)                        170.9 -> 84.8, on the first kick
x1 vs auto (fallback), three renders          identical
random-click renders answered                 12/240 -> 1/240 (gap 0.0779 left)
real songs reaching the fallback, refused     0/28 -> 0/28 (lowest gap 0.0956)
gates: 232/232 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 193/193; golden 24/24
```

### Rejected / tried and dropped

- **MIN_PULSE_GAP 0.085**, which refuses the last random render too: 0.005 to spare
  below the lowest of 55 real songs.
- **Attack density** as a second signal for the fallback: random renders reach 22
  attacks/s, above most songs.
- **Chance of the attacks landing on the fallback's own beats:** backwards — the
  tracker follows the clicks, so random renders align better than music does.
- **Halving on the more accented phase:** on a 170 BPM kit it put the grid on the snare.

### Found, not fixed

- x2 on the fallback tracker with nothing between its beats reads an unrelated BPM
  (bare click 120 -> 186).

---

## v4.0.0-dev — 2026-09-23 · No bar without a proven 1

A section's bar was claimed whenever its strongest beat class stood 1.20 above the mean
of the classes. The onset envelope favours broadband hits, so that class was often the
snare: on the backbeat at the song's own tempo, or — read at double tempo, where four
"beats" are two — on every other beat. The red line then sat on the snare.

### Fixed

- **A downbeat must also out-weigh the beat half a bar away** (Python and Rust,
  `HALF_BAR_CONTRAST = 1.25`). A pattern that repeats every half bar cannot say which
  half starts the bar; the section then anchors to a beat, as it does with no accent at
  all. 3/4 has no half-bar class and keeps the rule it had.

### Changed

- **Two golden vectors re-dumped, on purpose.**
  - `slow-92` starts on its downbeat at 750 ms. Its first red line sat at 1402.1 ms, on
    the snare of beat 2; it is now at 749.93 ms, on the 1. `meter.bar_beats` 4 -> 1.
  - `very-noisy-132` starts on its downbeat at 420 ms. Its first red line sat at
    874.4 ms, on the snare of beat 2 (`downbeat_class` 1). It is now at -34.65 ms: with
    no bar claimed the line anchors to the first attack, and noise at 27 ms puts that
    on the grid beat before the music. Still one beat from the 1, now on the other side,
    but no longer claiming a bar the accents do not prove.
  - The benchmark scores offsets modulo one beat, which is how both hid. The other 22
    vectors are unchanged; `long-6min` drifted one weight in the 5th decimal from #38's
    blocks, inside the 1e-3 tolerance, and was left as committed.

### Measured

```
tempo-change renders, change on a bar line      3/60 red lines a beat late -> 0/60
  (all 3 were the renders read at double tempo)
88 ranked maps, first red line on the map's 1   36/88 -> 40/88
  of the 21 that claimed a bar                   5/21 -> 9/21 (5 gained, 1 lost)
  claimed bars by half-bar ratio, before         < 1.25: 0/9 on the 1; 1.25-1.5: 1/7;
                                                 >= 1.5: 4/5
gates: 227/227 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 after the two re-dumps; coverage, measures (3/3), signatures (6/6) green;
cargo test 192/192; overtone-bench golden 24/24, nogrid 3/3
```

### Rejected / tried and dropped

- **A threshold of 1.5.** The ranked maps favour it (15 wrong claims gone, 1 right one
  lost), but the `measures` gate's `downbeat-4-then-3` fixture carries a real accent at
  only 1.29 and would lose its bar. Lowering that fixture's bar to pass would be
  re-baselining. At 1.25 the change removes only claims that were all wrong.
- **Fixing it at the octave.** All three failing renders were read at double tempo,
  but the octave is pinned by `bpm-snapshot` and the same snare-over-kick bias shows
  at the right octave on real songs (the maps' wrong claims were mostly one beat early,
  on beat 4). The real fix is a downbeat cue the snare cannot win: low-frequency (kick,
  bass) onsets. Recorded in the roadmap; not attempted here.

### Not measured

- Songs whose first attack is noise before the music: their first red line follows it
  (`very-noisy-132` above). Recorded as its own finding.

---

## v4.0.0-dev — 2026-09-23 · Backups, dropped packets, and 3.7 GB per song

Two medium audit findings, and one that no audit listed: the user's PC froze while
several analyses ran, and one 5-minute song turned out to peak at 3.7 GB.

### Fixed

- **`.bak` written in place, then never replaced** (#36). A backup write that failed
  halfway left a truncated `.bak`, and the retry trusted it. A map the mapper worked on
  between two injects was overwritten with nothing keeping it, while the summary said
  `backup=True`. Backups now go through a temp file and `os.rename` (which refuses an
  existing target on Windows); the first `.bak` stays pristine and each later write keeps
  what it replaces in the next free `.bak2`, `.bak3`..., unless the newest backup already
  holds those bytes. The result reports the backup's path.
- **Rust decode dropped a rejected packet** (#37). Everything after it moved earlier by
  the packet's length — 26.1 ms for an MP3 frame. The packet now becomes silence of its
  own duration, and `Decoded.concealed_frames` counts it.
- **3.7 GB for one 5-minute song** (#38). librosa built the whole linear spectrogram for
  the onset envelope (~1.3 GB) and the fallback tracker built a whole 8-second tempogram
  twice (~3.5 GB each). Both are now built in blocks, and one tempogram pass feeds both
  of the tracker's tempo readings.

### Hardening

- New test fixture `crates/overtone-audio/testdata/clicks.mp3` (23.6 KB, libsndfile 1.2 /
  LAME): the decoder test corrupts one frame of it in memory.
- A memory test: 2 minutes of audio must stay under 300 MB for the envelope and 400 MB
  for the tempo guides plus tracker (533 and 1363 MB before, 160 and 131 MB now).

### Measured

```
backup write failing halfway              truncated .bak left -> no file left
map edited between two injects            unkept -> kept in .bak2, byte for byte
one rejected MP3 frame (Rust)             1152 frames short, later clicks 26.1 ms early
                                          -> same length, all 16 clicks on the same sample
5-minute song, peak RAM                   3.7 GB -> 0.55 GB, same 8 red lines
5-minute song, time                       14.5-21.7 s -> 16.0-23.0 s (this machine's noise)
2-minute render, envelope / tracker       533 / 1363 MB -> 160 / 131 MB
16 real songs, old vs new                 14 identical; 2 fallback songs moved one BPM in
                                          the 6th decimal, offsets identical
gates: 225/225 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 191/191; golden 24/24
```

### Rejected / tried and dropped

- **One block size for both.** 4096 frames made the tempogram 1.5-2x slower than
  one-shot (its column FFTs fall out of cache) and 512 made the spectrogram slower. They
  now have their own: 8192 frames for the spectrogram, 1024 columns for the tempogram.
- **The tempogram built blockwise but twice**, as v3 did whole: the saving in memory
  came with ~6 s more per fallback song. Sharing one pass removed it.
- **A bit-identical mel spectrogram.** The mel projection's float32 summation order
  follows the block shape (differences up to ~2e-6 of the envelope's range); the golden
  check's tolerances exist for exactly this, and all 24 fixtures match stage for stage.

### Not measured

- The downbeat fix (next item). The ranked-map sweep that should set its threshold was
  lost twice when the app quit; it now appends per song and resumes.

---

## v4.0.0-dev — 2026-09-23 · The six high audit findings

The backlog's six high findings. Each was reproduced with a probe before any change,
fixed in Python and Rust where both apply, and landed as its own PR (#29–#34) with a test
that fails on the old code.

### Fixed

- **÷2 / ÷4 deleted real tempo changes** (#29). The duplicate filter compared factored
  BPMs against the unfactored minimum change, so every change shrank by the factor; the
  20–900 BPM range check read the presented tempo too. Both now read the song's own
  tempo; Rust got the same range rule.
- **Export snapping moved hand-placed red lines** (#30). Any line within a quarter beat
  of the previous grid was pulled onto it. Snapping now removes only rounding noise
  (≤ 1 ms), and a `manual` flag, set by every edit and by re-added locks, keeps the
  mapper's lines where they were put.
- **A change's red line one beat late** (#31). `ceil` skipped the boundary beat when the
  refit left it microseconds before the start; the other sections now get section 0's
  quarter-period slack.
- **A stray click before the music threw the grid away** (#32). Section growth stopped
  when its first seed window held fewer than six attacks; it now moves on to the next
  attack.
- **Sparse random attacks got a grid** (#33). The 0.40 share gate passed about half of
  them. A grid is now refused when the binomial chance of its inliers is above 10^-6
  *and* the fitting envelope's pulse gap is below 0.15. The gap runs on the envelope the
  engine already has, max-pooled in pairs, with SplitMix64-ordered shuffles, so Rust
  reproduces v3's numbers to 1e-9.
- **Rust hitsound flux** (#34) subtracted a 4096-point spectrum from an 8192-point one bin
  by bin, so a steady tone scored 0.9996. It now compares the 50 ms before the attack with
  its first 50 ms, on the same bins.

### Changed

- `docs/13-audit-backlog.md`: the high section is now a record of the fixes; two new
  medium findings recorded (a weak downbeat read one beat late; the fallback tracker
  answering some scattered clicks). Open: 83 — none high, 43 medium, 40 low.
- README: most MP3s open directly, not all — one of the songs tested needs FFmpeg.

### Hardening

- Rust `NoCoherentPulse` now also covers a grid that chance explains (`best_share` is
  then above 0.40); its doc says so.

### Measured

```
÷4, changes kept                        tiny-change 1/2 -> 2/2, secs-4 2/4 -> 4/4
hand-placed red line at 10100 ms        exported 10000 -> 10100
ranked real map, within 10 ms           8.1 % -> 14.4 %   (median error 60.0 -> 42.7 ms)
change red line one beat late           not reproduced end to end (0/77 constructions,
                                        0/100 renders, before and after)
click at 0.3 s, drums at 8 s (150)      fallback 295.3 BPM -> precision 150.000
random attack times given a grid        18, 17, 15, 22, 5 of 40 -> 0 in every case
random-click files answered             63/240 (53 precision) -> 12/240 (0 precision)
real audio (36 fixtures + 40 songs)     76/76 still analysed, 0 newly refused
hitsound flux, steady tone              0.9996 -> ~0
hitsound, seed 12 (the gate)            same 4 misses; macro F1 0.910 -> 0.906
hitsound, seeds 12-20, 450 hits         35 -> 29 wrong; macro F1 0.913 -> 0.931
gates: 219/219 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 190/190;
overtone-bench golden 24/24, nogrid 3/3
```

### Rejected / tried and dropped

- **One statistic for the sparse-noise gate.** The binomial chance alone refused real
  songs whose vocals sit off the grid (as weak as 10^-1.3); the pulse gap alone refused a
  rubato ballad (0.035). Only both together separate them.
- **The pulse gap on a second, HOP-256 onset envelope.** It worked in Python, but Rust's
  engine only has the fitting envelope and numpy's shuffle cannot be reproduced there.
  Max-pooling the fitting envelope in pairs and hashing the shuffle gives both engines
  the same number.
- **A 0.10 gap threshold.** It kept two real songs on the precision path but let one of
  240 random attack sets through (gap 0.105). Those two songs' grids put 5 % and 18 % of
  their ranked map's beats within 10 ms, so 0.15 costs nothing worth keeping.

---

## v4.0.0-dev — 2026-09-23 · Five audit leads, five real bugs

The roadmap listed five audit findings as "to verify". Each was re-probed before any
change; all five were real. Three touched the engines.

### Fixed

- **First red line half a beat late** (Python and Rust). The octave stage picks the
  accented atom class counting from the anchor seed's phase; section 0 is seeded again
  during growth and can sit a whole atom away. The class is now re-expressed in section
  0's own frame (halves rounded as `floor(x + 0.5)` in both languages).
- **Meter path swallowing a tempo change** (Python and Rust). The bar measured on one
  section was applied to the whole track, so 128 → 150 BPM with an audible downbeat came
  out as one 128 BPM red line. Every section's beat must now tile that bar (within 0.02
  beats); a signature change over one bar does, a tempo change does not.
- **Rust chroma misplacing bass notes.** Below ~362 Hz a 21.5 Hz bin is wider than a
  semitone; there, only spectral peaks count, at their interpolated frequency. The
  hitsound crate's chord-change feature now ignores bins below 100 Hz, where kick
  fundamentals sit — its test had passed only because the old chroma misfiled a 55 Hz
  kick onto the pad's own class.
- **Licence claims** in the precision, installer and comfort plans, corrected from the
  projects' own licence files; Demucs dropped for HPSS (its weights are research-only).
- **CLAUDE.md / AGENTS.md** counts and layout.

### Changed

- **`bench/golden/fast-300.json` re-dumped, on purpose.** `fast-300` is a 300 BPM render
  read at 150 whose first kick is at 0.2 s. Its red line sat at 400.2 ms — on the snare —
  and passed because the benchmark scores offsets modulo one 300 BPM beat. With the
  section-0 fix it sits at 200.2 ms, on the kick. Only `beat_sections[0].phase_s`,
  `settled_sections[0].phase_s` and `result.points[0].offset_ms` changed; the other 23
  vectors are byte-identical.
- New `docs/13-audit-backlog.md`: the 87 findings the audit's verifiers confirmed that
  are still open, so they live in the repository and not in a temporary file.

### Measured

```
first red line on the off-beat, 8 plain constant-tempo renders     5/8 -> 0/8
tempo change with an audible downbeat (128->150, 120->160)         1 red line -> 2
bass notes E1..D#4 on the wrong pitch class (Rust chroma)          24/36 -> 0/36
hitsound calibration macro F1                                       0.910 -> 0.910
gates: 209/209 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 (after the fast-300 re-dump); coverage, measures, signatures green;
cargo test 181/181; overtone-bench golden 24/24
```

---

## v4.0.0-dev — 2026-09-23 · Four confirmed bugs fixed

The four bugs the 2026-09-22 audit reproduced with a probe. Each fix has a test
that fails on the old code. The accuracy baseline did not move.

### Fixed

- **Inject changed what a map plays.** Every new red line was written as
  Normal / index 0 / 100 % / no kiai, and all of them went where the first old
  red line was, out of time order. New red lines now carry the sample set,
  index, volume and kiai the map had at their time; where moving red lines
  would still change slider velocity or sounds, a green with the original
  values is added; the section is sorted, red before green at ties; greens,
  the BOM, each line's ending and a missing final newline keep their bytes.
- **White noise got a BPM.** The v2 tracker behind the precision engine always
  finds beats: noise came back as 127.68 BPM, pads as 60.09. The fallback now
  refuses audio whose onset envelope is no more periodic than itself with its
  frames shuffled.
- **Classic window: CSV clipped to 21 px.** Every ghost button inherited the
  clam theme's 11-character minimum; they now size to their labels and the
  minimum window width is 1070.
- **Classic window: ×2 / ÷2 and Analyze dropped hand edits.** They now ask
  while edits are unexported; exports clear the count.

### Hardening

- The pulse check is numpy, not librosa. A first version called librosa's
  tempogram before the tracker and moved the tracker's global BPM on a real
  song (198.07 → 199.27); the numpy version equals librosa's tempogram to
  6e-16 and leaves that song identical.
- Tests: 7 inject (against an independent play-state evaluator), 3 no-pulse,
  1 layout fit, 3 edit guard.

### Measured

```
inject on a ranked map (236 reds, 199 greens, 1341 objects), Overtone's 22 red lines:
  objects whose SV/sampleset/index/volume/kiai changed   old 229   new 0
  section in time order                                  old no    new yes
pulse gap (threshold 0.05):
  white / pink / brown noise + bench noise               +0.014 .. +0.022
  27 real songs from an osu! Songs folder                +0.090 min, +0.225 median
  check cost on a 5-minute song                          ~0.25 s (librosa version ~7 s)
classic window toolbar, clipped buttons (EN/ES x default/minimum)   old 4/4 cases   new 0/4
gates: 205/205 unit tests; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24; coverage, measures, signatures green
```

---

## v4.0.0-dev — 2026-09-22 · A shared grid slot reads as its coarsest division

A bug fix in the hitsound crate's musical role. The tempo engine is untouched.

### Changed

- **`role::grid_position` names a shared slot by its coarsest division.** An
  on-beat is 1/1, a half-beat 1/2, a 16th 1/4, whatever the period. Residuals
  are unchanged to within 1e-9 beats; only the label on coinciding slots moves.

### Fixed

- **On-beats read as triplets.** The loop over divisions 1, 2, 3, 4, 6, 8 kept
  the strictly smallest residual. Slots coincide across divisions (a beat is
  also 3/3 and 6/6, a half-beat is 2/4, 3/6 and 4/8), so for an attack on a
  shared slot every division reads the same residual, and rounding in
  `beat * d` picked the winner. Whenever the attack time was not an exact
  binary fraction of the period, which is every real track, 1/3 or 1/6 could
  win by 1e-13 ms. The division feeds `metrical_weight`, which returns 0.25 for
  1/2 to 1/4 and 0.10 finer, so a kick misread as 1/3 lost its downbeat (1.0)
  or backbeat (0.5) weight, and a hat misread as 1/6 dropped from 0.25 to 0.10
  as if it were a ghost note. The tests passed only because their times were binary
  fractions; one accepted "4 or 8" for a 16th, which was this ambiguity showing
  through. Now the coarsest division within 1e-9 beats of the minimum wins.
  Rounding is ~1e-12 beats even a thousand beats in; distinct slots sit at
  least 1/24 beat apart.

### Hardening

- The 16th test asserts division 4, not "4 or 8".
- New test at 174 BPM, phase off zero, every attack 0.5 ms late: 600 beats ×
  seven slots (1/1, 1/2, 1/3, both 1/4s, 1/6, 1/8) must each read their own
  division and a 0.5 ms residual. Under the strict minimum, 80 of the 600
  on-beats read as triplets. The edm-174 reading that exposed the bug is pinned
  beside it.
- `corpus.rs` and `role.rs` are rustfmt-clean, and `role.rs` is clippy-clean:
  `section_at` walks back from the last section instead of scanning all of
  them, the period guard names NaN explicitly, and `analyze` takes the same
  `too_many_arguments` allow as `points_from_sections`. No behaviour change;
  177/177 tests, golden 24/24.
- The whole workspace is now `cargo fmt --check` and `cargo clippy
  --workspace --all-targets` clean: 28 files reformatted, 35 warnings cleared,
  one commit per crate. Negated float comparisons spell out NaN; loops that
  only wrote one slice iterate it; the elastic solver's matrix loops and the
  five eight-to-nine-input functions keep an `allow` with the reason written
  down. The corpus's metallic decay looked like a lost per-voice value but the
  table already carries one per class, so the identical branch went. No
  behaviour change: every commit passes 177/177 and golden 24/24.

### Measured

Share of attack weight per division, on v3's precision analysis of every
corpus fixture that has a grid (31 of 34; the three ramps fall back to another
engine). Measured through a Python port of the same arithmetic: the hitsound
crate has no corpus harness yet, so this measures the arithmetic, not the Rust
binary.

```
                   before (strict minimum)          after (coarsest tie)
fixture          1/1   1/2   1/3   1/4   1/6   1/8    1/1   1/2   1/3   1/4   1/6   1/8
edm-174         48.9  23.5  17.6   0.0  10.0   0.0   66.5  33.5   0.0   0.0   0.0   0.0
downbeat-4-4    66.5   0.0  33.5   0.0   0.0   0.0  100.0   0.0   0.0   0.0   0.0   0.0
fast-300        25.0  39.4  13.7   0.0  21.9   0.0   38.7  61.3   0.0   0.0   0.0   0.0
shuffle-96      36.5   0.0  58.0   5.4   0.0   0.0   53.4   0.0  41.1   5.4   0.0   0.0
swing-120       34.4   0.0  25.8   0.0   0.0  39.8   53.7   0.0   6.5   0.0   0.0  39.8
very-noisy-132  40.2   9.7  26.9   3.9   9.4   9.8   62.3  15.5   4.9   3.9   3.7   9.8
```

- **Straight fixtures (29):** 1/3 + 1/6 carried 25–39 % of attack weight
  before, 0.0 % after on 26 of them. The other three (noisy-140 0.4 %,
  signature-changes 0.2 %, very-noisy-132 8.6 %) are attacks nearer a triplet
  slot than any other, not ties. On edm-174, 1/3's 17.6 points moved to 1/1 and
  1/6's 10.0 to 1/2: a quarter of the on-beat weight and a third of the
  half-beat weight had been read with the wrong metrical weight.
- **Shuffle-96** keeps its triplet hats at 41.1 %; the other 16.9 points were
  on-beats. **Swing-120** swings its hats to 0.58 beats, nearest the 5/8 slot,
  so they read 1/8 before and after.
- 1/4 and 1/8 shares are identical before and after on every fixture.
- `cargo test --workspace` passes (177 tests, one new). Golden gate 24/24
  attack for attack. The Python gates were not run: the v3 engine is untouched.

### Rejected / tried and dropped

- **A relative tolerance on the residual.** It collapses as the residual
  approaches zero, which is exactly an attack sitting on its slot: a 1e-15
  minimum and a 1e-13 rival are a factor of 100 apart and still a tie. The
  residual is already in beats, so an absolute tolerance is already
  period-relative.

---

## v3.6 — 2026-09-22 · Comfort features plan, and a place for output to live

Not code beyond a small repository hygiene fix; a plan release.

### Changed

- **New doc**: [`docs/12-comfort-features.md`](docs/12-comfort-features.md) —
  Phases 12 through 18, everything that raises the app's *comfort* ceiling
  without changing what it does. PySide6 + pyqtgraph (Phase 12) for the
  timeline, sounddevice for live playback and click (13), a proper `.oto`
  project format with auto-save and undo tree (14), deep osu! integration
  including lazer support and a Songs browser (15), full localization and
  accessibility (16), plugin API and PDF reports (17), MIDI/gamepad/video
  input (18). Every dependency audited: PySide6 LGPL-3.0, pyqtgraph MIT,
  everything else free.

- **Sub-phase 14.4b — Organised output folders** added. Every artefact
  Overtone writes goes under
  `%USERPROFILE%\Documents\Overtone\Exports\<Artist> - <Title>\`, keyed
  by song. Nothing lands loose next to the installed app; `Program Files\`
  is read-only after install. An `Exports\index.sqlite` records what was
  written when and from which project. The user can point the root
  elsewhere in Settings.

- **`STK_timing_points.osu.txt` moved** from the repo root to `fixtures/`,
  where new hand-timed samples will also live as the project grows. This
  is the loose file the user was reacting to.

### Cumulative installer estimate

Comfort deps add ~322 MB on top of Phase 10's precision stack. Total MSI
before size reduction: ~1.5 GB. After 10.13.4 quantisation and drums-only
Demucs: ~800 MB.

### Measured

Nothing. This is a plan. 76/76 tests still pass on the moved fixture.

---

## v3.5 — 2026-09-22 · Distribution model: one MSI, everything inside

Follow-up to v3.4. The user asked for the app to be installable as a single
MSI without any online dependency, portable if possible. That constraint
rewrote two parts of the precision plan.

### Changed

- **New doc**: [`docs/11-msi-distribution.md`](docs/11-msi-distribution.md) —
  the concrete plan to build a single-file Windows installer that bundles
  every model, every wheel, every native DLL. ~1.15 GB before size reduction,
  ~450 MB after (INT8 quantisation, Demucs drums-only, drop madmom as bundled
  dep — no accuracy loss beyond 0.5 %). WiX Toolset v5 for MSI authoring,
  PyInstaller for the Python bundle, Azure Trusted Signing ($10/month) for
  Windows SmartScreen. A portable ZIP variant ships alongside.
- **Phase 10.1 rewritten** in [`docs/10-precision-plan.md`](docs/10-precision-plan.md).
  The earlier plan scraped a public mirror of ranked maps from the osu! API —
  that requires network and does not fit the offline requirement. The rewrite
  indexes the user's own `C:\osu!\Songs\` folder instead. Every ranked map
  they already downloaded is already a ground-truth timing source; a
  Chromaprint fingerprint matches an incoming audio to that local corpus.
- **Phase 10.13 added to the roadmap** — MSI distribution as seven sub-phases
  (build harness, WiX, model manifest, size reduction, portable ZIP, code
  signing, build automation), ~12 days on top of Phase 10's ~4–6 weeks.

### Rejected in this release

- **osu! API scraping at runtime** — needs network permanently. Even a
  one-time build of a public mirror was rejected because 50 GB of downloads
  cannot ship inside a portable installer.
- **Runtime auto-update** — would be a policy change. Users update by
  downloading and re-running the new installer.
- **Cross-platform installers** for macOS and Linux — the app runs on those,
  but the packaging plan is Windows-first.
- **Microsoft Store submission** — GitHub Releases is enough for direct
  distribution.

### Measured

Nothing changes today: this is a plan, not code. The measurable claim in
v3.4 (4.7 % → ~95 % of ranked timing points within 5 ms) holds. The MSI plan
is about *how the product reaches users*, not *what accuracy it reaches*.

---

## v3.4 — 2026-09-22 · A written plan for human-level timing accuracy

Not a code release; a plan release. A user asked what it would take to time a
song as accurately as a mapper who has already done it by hand, using only free
software and offline models, without any budget on how long analysis is allowed
to take.

The answer, worked out in [`docs/10-precision-plan.md`](docs/10-precision-plan.md),
is that **90–95 % of a ranked map's timing points within 5 ms** is a real,
reachable target with the current state of open-source tooling. It takes about
4–6 weeks and twelve sub-phases, and every one of them is measurable.

### Changed

- **`docs/10-precision-plan.md`** — 12 sub-phases with dependencies, licences,
  expected accuracy gains, and a cumulative projection from today's 4.7 %
  within 5 ms on the Vampires reference track to ~95 %. Includes an honest
  audit of what stays outside even this plan.
- **Roadmap gets Phase 10** — a summary that points into the precision plan.

### Measured

Baseline on the reference track (My Chemical Romance – Vampires Will Never Hurt
You, 236 hand-placed red lines):

```
today             median offset error 60.0 ms   within 5 ms   4.7 %
after Phase 10    projected           ~1 ms                  ~95 %
```

The projection is not a promise. Each cell of the projection column is anchored
to published benchmarks for that specific technique (madmom's F-measure gain on
GTZAN, Demucs' SDR on MUSDB, etc), so it can be checked against reality one PR
at a time.

### What was rejected

- **Anything paid.** Spotify's Audio Analysis API is more accurate than an
  open pipeline for the tracks it has, but was rejected outright: the project's
  offline-first policy holds, and Spotify's terms restrict what can be built
  on their data.
- **Anything not free-licence.** RWC Popular Music dataset is skipped
  (commercial licence), even though it would help. Essentia is kept optional
  (AGPL) rather than statically linked.
- **Copying ranked map timings without matching them first** — Phase 10.1
  fingerprints before copying, so the user is not silently given someone
  else's timing for a different song.

---

## v3.3 — 2026-09-22 · Time signatures over a constant bar

A user compared Overtone against a beatmap they had timed by hand in Tempora
and reported a large difference. Reading their timing points made the cause
obvious, and it was not what either of us expected:

```
168    6 x 200 ms    bar 1200 ms         168 -   168 =      0 =  0 x 1200
20568  3 x 400 ms    bar 1200 ms       20568 -   168 =  20400 = 17 x 1200
39768  6 x 200 ms    bar 1200 ms       39768 -   168 =  39600 = 33 x 1200
58968  3 x 400 ms    bar 1200 ms       58968 -   168 =  58800 = 49 x 1200
68568  6 x 200 ms    bar 1200 ms       68568 -   168 =  68400 = 57 x 1200
100968 4 x 300 ms    bar 1200 ms      100968 -   168 = 100800 = 84 x 1200
```

**Every red line sits an exact multiple of 1200 ms from the first, and every
bar is 1200 ms.** The song has no tempo change anywhere. 300, 150 and 200 BPM
are three ways of writing the same measure with 6, 3 and 4 beats — which is
exactly Tempora's model, read from its source:

```csharp
MpsToBpm(mps) => mps * 60 * (TimeSignature[0] * 4f / TimeSignature[1])
measurePosition = (time - point.Offset) * point.MeasuresPerSecond + point.MeasurePosition
```

Measures per second is the physical quantity; BPM is a presentation of it
through the signature. v3 grows sections on measures per second, so a song that
changes only its signature was structurally invisible to it — it reported one
tempo for the whole track.

### Changed

- **`detect_bar`** — how many of a grid's beats make one measure, from accent
  contrast, refusing when the accents prove nothing.
- **`meter_segments`** — splits a track by *how the bar is subdivided*, scoring
  each window against every plausible beats-per-bar with the same
  `share x coverage` ranking the seeder uses. A grid too fine fills half its
  own slots; one too coarse leaves attacks off it; only the written
  subdivision scores on both.
- **`points_from_meter`** — one red line per signature region, on a bar line,
  with BPM derived as Tempora derives it. Declines and leaves the ordinary
  per-section placement alone when there is no provable bar, only one
  signature, or the user forced a pulse octave.
- New gate, `bench/gates.py signatures`, built from the reference track's shape.

### Measured

On a faithful reproduction of that song, against the hand-timed truth:

```
  #        offset        truth      error  beats truth        bpm
  1         168.1        168.0      +0.1ms      6     6    300.000
  2       20568.1      20568.0      +0.1ms      3     3    150.000
  3       39768.1      39768.0      +0.1ms      6     6    300.000
  4       58968.1      58968.0      +0.1ms      3     3    150.000
  5       68568.1      68568.0      +0.1ms      6     6    300.000
  6      100968.1     100968.0      +0.1ms      4     4    200.000
```

Six of six regions, every offset within 0.1 ms of the bar line a human placed
by hand, every signature right. Before this the same audio produced **two**
sections and a single subdivision for all of it.

Accuracy untouched, which the guard is there to ensure: **24/24 within 0.05 BPM
and 5 ms, median 0.0000 BPM / 0.16 ms**, `bpm-snapshot` and the golden vectors
both unchanged. On the 24-case corpus `detect_bar` returns "no bar" on every
fixture — those tracks put a hat on every beat and vary the kick only between
1.0 and 0.8 — so the new path never fires there. 76 unit tests, up from 69.

### Rejected / tried and dropped

- **Preferring the longest bar with usable accent contrast.** A four-bar
  hypermeasure still scores 1.24 on the reference track, beating the true
  three-beat bar at 1.22 under a "longest wins" rule and giving a 4800 ms
  measure where the truth is 1200. Strongest contrast wins instead, with
  near-ties going to the shorter reading — the one a mapper writes.
- **Labelling a region from the window that reads it.** A window wide enough
  to identify a signature is too wide to locate its change: one straddling the
  switch is labelled by whichever side fills more of it, which put every
  boundary exactly one bar early. Boundaries are now settled bar by bar, and
  a single ambiguous bar does not move the line.

### Open items

- **A signature change that keeps the beat and changes the bar's length**
  (4/4 → 3/4 at the same BPM) is a different shape and is not detected. The
  `measures` gate's `downbeat-4-then-3` case records it.
- The reference track is real audio; the reproduction is synthetic. On the real
  recording the offset came out about 20 ms late with 52 % confidence — the
  engine knew it was struggling. Synthetic fixtures remain an upper bound, as
  v3.0 already says of the corpus.

---

## v3.2 — 2026-09-22 · The measure grid, and timing a song from nothing

Tempora (`teamkongehund/Tempora`) times a song by associating points of time in
the music to a timeline of **measures and measure divisions**, by hand. Overtone
already automates the hard half of that — the pairing of audio time to beat
index is exactly `t(k) = offset + k·period`, solved over hundreds of attacks
instead of two hand-placed anchors. What it did not do was measures.

### Changed

- **Per-section time signature.** `section_measures` runs the meter detector on
  each section's own attacks. v3 read the meter once, from the first section,
  and wrote that number into every red line, so a song that moves to 3/4 for a
  bridge came out wrong everywhere after the change.
- **Red lines anchor to downbeats.** v3 anchored only the *first* line to a
  downbeat; every later section took the next plain beat, so osu!'s bar lines
  drifted out of step with the music after the first tempo change. Each section
  now anchors to its own downbeat — but only when its accents prove one.
- `TimingPoint` carries `meter` and `meter_known`. The second field matters:
  a point that does not know its bar falls back to the analysis meter rather
  than to a hard-coded 4, so writing 4 over a detected 3/4 cannot happen.
- New gate, `bench/gates.py measures`.

### Fixed

- **The click track accented every fourth beat regardless of meter** (audit
  **F-03**). A waltz clicked in 4 against the music, and the click track is
  what the README calls the arbiter — a mapper checking a 3/4 song by ear could
  have concluded the timing was wrong when it was not. Now accents on the
  point's own bar.
- **`snap_timing_points` dropped the bar.** It rebuilds each point, and the new
  fields were not carried, so every section silently reset to "unknown" before
  export and the per-section meter never reached the `.osu` or the click track.
  Caught by a test, not by inspection. The same omission was fixed in
  `update_timing_point`, `nudge_timing_point` and `rescale_section`.

### Hardening

- The "no evidence, no bar" rule is preserved exactly: a section whose accents
  do not prove a time signature reports `1` and keeps v3's beat anchoring.
  Guessing a bar without evidence pushes a red line up to three beats past
  where the music changed, which is worse than not knowing.

### Measured

Accuracy unchanged, which is the point: **24/24 within 0.05 BPM and 5 ms,
median 0.0000 BPM and 0.16 ms**, `bpm-snapshot` 24/24 unchanged, golden vectors
24/24 unchanged. 62 unit tests, up from 56.

The new gate needed its own fixtures, and the reason is worth recording. On the
24-case corpus the detector reports "no bar" on **every section**, and it is
right to: `build_track` puts a hat on every beat and varies the kick only
between 1.0 and 0.8, so downbeat contrast lands near 1.05 against a 1.20
threshold. The feature was therefore a no-op on the whole corpus — implemented
but unproven. Rather than lower a threshold with no ground truth to justify it,
three fixtures with an audible downbeat were added:

```
case                        truth     detected   anchored
downbeat-4-4                  [4]          [4]        yes
downbeat-3-4                  [3]          [3]        yes
downbeat-4-then-3          [4, 3]          [4]        yes
```

Anchoring is exact: the emitted offset sits a whole number of bars from its
section's downbeat, to within 2 % of a bar.

### Also changed — `.osz` export

The remaining piece of Tempora's workflow. v3 could only **inject** red lines
into a beatmap that already existed; `export_osz` writes the beatmap: a zip
holding the audio and a complete, openable `.osu` carrying this timing and
nothing else — no hit objects, no background, default difficulty. The point is
a file a mapper opens in the editor with the timing already correct.

`--osz out.osz`, with `--artist` / `--title` / `--creator` for the metadata.

Hardening, because an archive is a filename problem as much as a format one:

- the zip is built in a `.part` file and renamed into place, so an interrupted
  export cannot leave a half-written `.osz` that osu! refuses and the user does
  not think to delete;
- metadata is sanitised into the filename — path separators and the characters
  Windows refuses become `_`, and a run of dots collapses. `../../evil` cannot
  reach outside the archive, and a single dot survives because "Mr. Blue" is a
  legitimate artist;
- the audio is size-capped before anything is written;
- an analysis with no usable points is refused rather than producing a beatmap
  with an empty `[TimingPoints]`.

Seven tests, including that a failed export leaves neither the archive nor the
temporary file behind.

### Open items

- **A time-signature change at constant tempo is not detected.** Sections split
  on tempo, so 4/4 → 3/4 at the same BPM stays one section and only the first
  bar is reported (`downbeat-4-then-3` above). Tempora lets a user set the
  signature per audio block regardless of tempo; matching that needs a
  meter-change detector alongside the tempo one.

---

## v3.1 — 2026-09-22 · Audit, and the v4 design

No engine behaviour changed. This entry exists because the next release is a rewrite, and
a rewrite with no written baseline is how a 0.16 ms tool becomes an 8 ms tool without
anyone noticing.

### Changed

- **`docs/` — nine design documents** covering the audit of v3, a five-way stack
  evaluation, the v4 architecture, the UI/UX language, the DSP porting contract, the
  hitsound engine, the roadmap (phases 0–9), an ML assessment, and naming.
- **README rewritten** around what is measured versus what is designed. Every number now
  carries the date and the environment that produced it.
- **`CLAUDE.md` / `AGENTS.md`**: contributor and agent conventions. No `Co-Authored-By`
  trailers, no GitHub Actions — every gate is a local one-liner.
- `.gitignore` scoped so `.osu` and `.csv` **fixtures can be committed**; the repo-wide
  ignore is why the one sample lives as `STK_timing_points.osu.txt`.
- **`bench/gates.py`** — two gates for things the accuracy benchmark structurally cannot
  see. `bpm-snapshot` pins the **absolute** reported BPM per fixture (`bench/bpm_snapshot.json`,
  24 cases): the benchmark normalizes octaves, so a change to the octave decision could
  halve every track and all 24 rows would stay green. Verified by tampering with the
  baseline — it reports `global BPM 112.5 -> 225.0  <-- OCTAVE FLIP`. `coverage` measures
  the density signal behind F-11 on three half/double-time fixtures, deliberately kept out
  of `benchmark.CASES` so the published 24/24 stays comparable.
- **`bench/golden.py`** — per-stage golden vectors: attacks, coherence candidates, seed
  grids, octave, atom sections, beat sections, meter and points, 362 KB committed across
  the 24 fixtures, with a `check` mode that diffs stage by stage within documented
  tolerances (attacks 0.05 ms, period 1e-6 s, offsets 0.05 ms). This is the harness the
  Rust engine gets pointed at in Phase 1: a port can reach the right BPM through a wrong
  envelope and a compensating peak-picker, and only a stage-by-stage diff catches that.
  It captures by wrapping the private stage functions with recording proxies, so it
  duplicates no pipeline logic — what is recorded is what the shipped path computed.
- **`requirements.lock`** — the exact versions behind the measured baseline.
- One test added (56 total): `test_pulse_hints_only_ever_suggest_doubling`, which
  documents that `suggest_section_pulse` has no downward direction.
- **`proto/` — the two highest-risk roadmap algorithms, prototyped in Python** against the
  existing corpus before committing to them in Rust. Both are Phase 2 items rated
  difficulty *high* / impact *high*, and both would have been expensive to discover wrong
  after a port. Results in [`proto/README.md`](proto/README.md); summary under Measured.
- **Renamed to Overtone.** The repository was `githaltwastaken/Timing-Analyzer`; an
  overtone is a frequency above the fundamental, which is what the coherence sweep spends
  its time separating — `R(f)` peaks at the true pulse and at every multiple of it.
  Renamed: README, all docs, `CLAUDE.md` / `AGENTS.md`, this file, the GUI title and about
  box, the CLI description, and the `.osu` comment. Settings moved to `~/.overtone.json`
  with `~/.timing_analyzer.json` read as a fallback, so an existing install keeps its
  preferences instead of silently losing them. `timing_analyzer.py` keeps its filename on
  purpose — it is the v3 reference implementation and the roadmap already moves it to
  `reference/python-v3/` in the same commit that creates `crates/`; renaming it now would
  touch every import in the suite, the benchmark and all three gates for no gain.

### Fixed

- **`_atomic_grid_candidates` rebound its own `keep` parameter** with a 5000-element index
  array in the dense-audio guard, so `strong[:keep]` would raise `TypeError` and drop the
  whole analysis to the v2 tracker. Currently unreachable — every call site goes through
  `_seed_grid`, whose windows are at most 30 s, and the 25 ms minimum peak spacing caps
  that at ~1200 attacks — but the v4 design widens exactly those windows, and the code's
  own comment at `MAX_SCAN_FREQS` predicts it. Renamed the local to `dense`.
- **`window_of` was defined twice, identically, in `_tune_boundary`.** Copy-paste residue;
  Python binds the second, so behaviour was never affected. Deleted the first.

### Hardening

- Not applicable; no new I/O or parsing paths.

### Measured

The v3 baseline was **reproduced on this machine**, which matters more than quoting it:

| | published | reproduced 2026-09-21 |
|---|---|---|
| median BPM error | 0.0000 BPM | **0.0000 BPM** |
| median offset error | 0.16 ms | **0.16 ms** |
| sections within 0.05 BPM and 5 ms | 24/24 | **24/24** |
| unit tests | 55 | **55/55 pass** (56/56 after this release's addition) |

Environment: Windows 11 26200, Python 3.14.4, numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
numba 0.67.0. Worth recording because `requirements.txt` has lower bounds only, and the
resolve pulled librosa **1.0.0** — a major version past what v3 was developed against.
Everything passes on it; nothing in the repo would have told us either way.

Corpus wall time: **21.6 s for 24 tracks** single-threaded, worst case 5.0 s on the
6-minute fixture. Cheap enough that the full accuracy gate can run on every commit, which
removes the last excuse for an unmeasured change.

Two results the README did not previously state:

- `change-175-87.5` reports **1 of 2 sections**, and the cause is not what it looked
  like. My first diagnosis blamed the global octave decision; instrumenting the engine
  showed otherwise:

  ```
  ATOMIC grid on 175 region  : share=1.000 coverage=1.000 rms=1.27 ms
  ATOMIC grid on 87.5 region : share=1.000 coverage=0.633 rms=2.18 ms
  growth gate: break when share < 0.55 or rms > 15.43 ms
  ```

  The grid is continuous across the change, so every attack in the slow half still lands
  on the fast half's grid and `share` never moves. What halves is **coverage** — and
  `_grow_sections` computes it and throws it away (`share, _cov, rms = _grid_quality(...)`).
  The statistic `_seed_grid` ranks candidates by is discarded by the loop that decides
  whether a section continues. The signal is strong (drop 0.36–0.46 across three fixtures)
  and localises the change to within one 8-beat window, but it lives on the **subdivided**
  grid: at beat level coverage is 1.000 for the whole track, and the first version of the
  gate measured beat level, found nothing, and would have "proved" the signal absent.

  Whether it *should* split is a separate and genuinely open question — the README's
  policy is to keep the BPM through a half-time section, while the benchmark's ground
  truth asserts two sections. The repository contradicts itself and nothing resolves it.
  Third part of the gap: `suggest_section_pulse` returns early for any point at or above
  120 BPM, so it can only ever propose `×2` and offers nothing here.
- The octave choices are visible for the first time now that they are pinned:
  `slow-92` is reported as **184.000** and `fast-300` as **150.000**. Both were previously
  hidden behind the benchmark's `x2` / `x0.5` notes.
- White noise returns `127.68 BPM` through the legacy tracker. It should refuse.

**Prototype results** (`proto/`, full detail in `proto/README.md`):

*Density detector* — **4/4** real half/double-time changes found, **0 false positives out
of 23**, worst localisation error 1.37 s (one 8-beat window). Zero false positives on the
three fixtures built to look like this — a 6 s drop, a 10 s sparse region, and a track with
both — is the result that matters, and **parity** is what buys it: coverage says "half the
slots are empty", parity says "and it is every other one, not a random half". Verdict:
build it.

*Elastic grid* — a polynomial in `k` (degree 1 *is* v3, degree 2 is a ramp), so IRLS
carries over unchanged.

| case | deg | rms | fitted BPM | BPM err med/max | v3 |
|---|---:|---:|---|---|---|
| ramp-120-160 | 3 | 4.06 ms | 120.65 -> 159.04 | **0.163** / 0.748 | legacy, 8 sections |
| ramp-180-140 | 3 | 2.70 ms | 179.32 -> 140.44 | **0.144** / 0.536 | legacy, 13 sections |
| ramp-90-200 | 3 | 23.79 ms | 98.92 -> 189.51 | 1.387 / 10.739 | legacy, 1 section |

And the test that mattered more — it does **not** invent curvature: **22 of 24** constant
fixtures chose degree 1 with **0.00 % drift**. The two that bent, `secs-4` and
`tiny-change`, both have genuine tempo changes, so the model was noticing real changes and
smoothing them rather than hallucinating. That makes residual a clean **selector**: where
v3's piecewise fit applies it wins by two orders of magnitude (0.15 ms vs 8-15 ms); where
it falls back, elastic wins. The two models are complementary, not competing, and v4
should fit both and report which one answered.

### Rejected / tried and dropped

- **Porting the v2 hybrid tracker to Rust as the v4 fallback.** It means reimplementing
  librosa's DP beat tracker and PLP to reproduce an engine whose measured output on the
  degenerate corpus is an 8-section staircase on a tempo ramp and a confident BPM for
  white noise. Instead: keep the Python v3 runnable as the reference that produces
  `--engine legacy` numbers, ship an elastic (spline) tempo model for genuinely varying
  tempo, and refuse honestly when neither fits.
- **GPU compute for the analysis pipeline.** A 6-minute track is ~124k frames of
  1024-point real FFT; on CPU with rayon that is well under a second against the 5.0 s
  measured in Python. Transfer overhead, driver variance and a second numeric path to
  validate, for a fraction of an already-negligible cost. GPU is used for *rendering*,
  where the timeline genuinely needs it.
- **Extending the elastic tempo curve past its samples with the edge slope.** A ramp
  genuinely keeps ramping, and measurement showed the entire max error on every ramp
  fixture is edge behaviour rather than curve shape, so this looked like the obvious fix.
  It made the extreme fixture *worse* — median 0.63 -> 5.65 BPM, because a steep edge slope
  fed the polynomial-in-k stage badly enough to flip its degree choice — and changed
  nothing on the other two. Clamping at the sample edges is kept.
- **Seeding the elastic fit with a constant period.** Assigning beat indices with one
  period across a 60 s ramp slips indices, and least squares cannot recover a slipped
  index — the same failure mode this file records for the coherence phase sign. It
  returned degree 1 at 30 ms rms and a tempo 17 BPM from truth. The pipeline has to be
  curve-first: sample locally, normalise octaves, fit `period(t)`, integrate to a grid,
  *then* assign indices.
- **Fixing the click track's hardcoded 4-beat accent** (finding F-03, audible on 3/4
  tracks). It is a behaviour change to an audio export with no test covering the accent
  pattern, and the rule is that precision-adjacent code does not change without a test in
  the same commit. Patch is written down in the audit; it lands with its test.

### Open items

Unchanged from v3.0, plus: `_grow_sections` should consult coverage (F-11), and
`suggest_section_pulse` needs a downward direction so a half-time region can be surfaced
the way the global octave already is. Both now have gates that measure the signal; neither
has a fix.

Phase 0's remaining work is blocked on the Rust toolchain (MSVC Build Tools, then rustup
with the `x86_64-pc-windows-msvc` target), which is not installed. Everything in Phase 0
that does not need it is done.

---

## v3.0 — 2026-09-04 · Least-squares grid engine

The headline change: **BPM is no longer derived from the gaps between beats.**

### Why the old approach capped out

v2 computed tempo as `60 / (t[k+1] - t[k])`, smoothed. Every detected beat carries
a few milliseconds of onset-detector jitter, and differencing two jittery numbers
*amplifies* that noise instead of averaging it away. No amount of median filtering
downstream can recover information the differencing threw out. That is why v2 sat
at ~0.2 BPM of wobble and ~8 ms of offset error no matter how the filters were tuned.

v3 fits an explicit model to the attack times instead:

```
t(k) = offset + k · beat_length        (k = integer beat index)
```

by iteratively re-weighted least squares. With N inlier attacks the fitted period
averages the jitter down by √N. That single change is where essentially all of the
accuracy gain comes from; everything else in this entry exists to make sure the fit
is seeded correctly and applied to the right span of audio.

### Changed

- **Attack detection at sample resolution.** Peaks come off a 2.9 ms onset envelope
  (hop 128, was 256) with parabolic sub-frame interpolation, then each one is
  **re-timed on the raw waveform**: a local energy window walked back to its 20 %
  rise. A spectral-flux peak lags the physical attack by roughly one analysis
  window, which is exactly the ~8 ms bias v2 shipped with. Measured after the fix:
  attacks land 0.15 ms from truth with 0.15 ms spread.
- **Circular-coherence pulse sweep.** `R(f) = |Σ w·e^{2πi f t}| / Σ w` scores a
  candidate pulse rate in one O(N) pass, so the whole plausible range is swept
  rather than trusting one tracker's guess. Candidates are ranked by
  *share* × *coverage* (see Rejected, below).
- **Expanding-window least squares.** The fit grows over the track in doubling
  spans, so a 1 % seed error is absorbed without ever slipping a beat index.
- **Octave from accent depth.** Attacks are grouped by index modulo *m*; if *m*
  atoms really make a beat, one class holds the kicks and another the filler, so
  the spread between strongest and weakest class is large. That plus tempogram
  hints read through librosa's log-normal prior picks the beat — and the downbeat.
- **Sections grow and re-seed.** A region extends forward while attacks keep
  landing on its grid; the next region runs **its own** coherence scan instead of
  inheriting a period that just failed. Boundaries then settle on the beat where
  the two grids cross, and every section is refitted on its own attacks alone.
- **Legacy engine kept as a fallback**, not deleted. Rubato, free time and
  non-percussive audio have no grid to fit; those fall through to the v2 hybrid
  tracker and the analysis says so (`engine: legacy` in `--stats`).
- API: `analyze_audio(..., engine="auto"|"precision"|"legacy")`;
  `force_subdivision` is now a float (`0.25 … 4`, so ÷2 finally exists in the GUI
  and CLI); `osu_timing_text(analysis, decimals=0)`; new `GridSection` dataclass and
  `Analysis.sections / attack_times / attack_weights / engine / fit_residual_ms`.
- **The benchmark harness is in the repo** (`bench/benchmark.py`): 24 synthesized
  tracks with exact ground truth plus four no-answer inputs, scoring every section
  rather than only the first, seeded per track so a subset run reproduces a full
  one byte-for-byte. `--engine legacy` reproduces the v2 column of the table below
  from the same code, which is the only way the comparison means anything.
- Docs: README rewritten around the measured numbers and an explicit
  "Honest limits" section. Tests 35 → 55.

### Fixed

- **Coherence phase came back negated.** `z = Σ w·e^{2πi f t}` has
  `arg(z) = 2π f φ`, so `φ = arg(z)/(2πf)` — the code used `-arg(z)`. Every seed
  grid started in **anti-phase**, half a beat off, and least squares cannot recover
  from a slipped beat index. This was the single largest source of error in the
  first working version of the engine. Regression test:
  `GridMathTests.test_coherence_phase_has_the_right_sign`.
- **`_refine_beats_to_transients` had a latent `NameError`**: `dtype(...)` where
  `dtype=...` was meant, on the empty-input branch. Present since v2.1.
- **Variable-tempo tracks collapsed into one section.** A global expanding fit ran
  *before* section growth, so on a 128 → 142 BPM track it locked onto 142 and the
  per-section seeds inherited that. Removed; each section now seeds itself.
- **Section boundaries landed a beat late.** The reach walk that decides where a
  grid stops explaining attacks used a 5 %-of-beat tolerance, loose enough for the
  *old* grid to claim the *new* tempo's first beat. Now driven by each side's own
  fit residual.
- **Swung and ornamented music pulled the offset late.** Least squares balances
  everything inside its tolerance window, so a second population of attacks (swung
  off-beats, ghost notes) dragged the grid halfway toward them — 17 ms on the
  shuffle fixture. `_recentre_phase` scores candidate shifts with a narrow Gaussian
  and snaps to the *mode* rather than the mean. 17 ms → 0.09 ms.
- **`min_delta` was scaled the wrong way** when handed to the atom-level segmenter
  (`/m` instead of `*m`), making the change detector ~m² more sensitive than the
  documented parameter promised.
- `_robust_local_bpms` raised `IndexError` on arrays of 0 or 1 beats.
- The GUI editor located the edited point with `list.index()`, which matches by
  *value* on a frozen dataclass — duplicate points returned the wrong row.

### Hardening

- **`.osu` injection is now atomic** (temp file + rename). Previously a crash or
  power loss between truncate and write destroyed the user's beatmap.
- **An existing `.bak` is never overwritten.** Injecting twice used to back up the
  already-injected file, losing the pristine original for good.
- **Legacy `.osu` red lines are recognised.** Format v3/v4 wrote only
  `time,beatLength`; the old 8-field check treated those as green, so a legacy map
  kept its old red lines *and* gained the new ones. A negative beat length now
  always means inherited, overriding a contradictory flag.
- **Offsets export as whole milliseconds.** The `.osu` format specifies integers and
  osu!stable does not accept decimals; v2.2 wrote `.3f`. The fit is sub-millisecond,
  so rounding costs at most 0.5 ms. `--decimal-offsets N` opts back in for lazer.
- **A corrupt config no longer bricks the app.** `load_config` returned whatever
  JSON it found; a list or a scalar crashed startup with `AttributeError`, which the
  user could only fix by deleting `~/.timing_analyzer.json` by hand. Now validated,
  size-capped, and written atomically.
- **Resource limits** against absurd or hostile input: audio duration is checked
  from the file *header* before decoding, plus caps on `.osu` size, config size,
  click-track length, coherence-sweep frequencies, and onsets fed to the O(N×M)
  kernel scans.
- Division-by-zero guards for hand-edited 0 BPM points along every export path;
  a cap on the legacy peak-tracker's gap reconstruction loop.
- **The fallback is no longer silent.** An unexpected exception inside the precision
  engine used to degrade quietly to the legacy tracker, which hides a real bug
  behind merely-worse numbers. It now reports the exception type in the progress
  message — and this immediately caught a live regression during development (a
  cleanup pass deleted two helper functions and every benchmark silently dropped
  back to v2-quality output).
- Audited and clean: no `eval`/`exec`/`pickle`/`subprocess`/`shell=True`, no
  user-controlled format strings, no writes outside the target file's own directory.

### Measured

24-track synthetic benchmark with exact ground truth (odd tempos incl. 222.222 and
128.37, added noise, ±8 ms performance jitter, swing and shuffle, drops, sparse
breakdown bars, a 6-minute track, and 2–4 tempo changes per song), scoring **every**
section rather than only the first:

| | v2 engine | v3 engine |
|---|---|---|
| median BPM error | 0.1965 BPM | **0.0000 BPM** |
| median offset error | 8.37 ms | **0.16 ms** |
| sections within 0.05 BPM **and** 5 ms | 0 / 24 | **24 / 24** |
| wall time, 60 s track | ~5 s | **~0.7 s** |

Both columns come from the same harness, now committed as `bench/benchmark.py`:
`python bench/benchmark.py` and `python bench/benchmark.py --engine legacy`.

The speedup is incidental: the old tempogram ran at hop 128 and cost ~10 s of the
~11 s total. It only ever fed an octave *hint*, which needs no such resolution, so
it now runs on a 4× max-pooled envelope.

Degenerate inputs behave: a 120 → 160 BPM ramp and pad-only audio fall back to the
legacy tracker, pure silence raises a clear `ValueError`, white noise does not hang.

### Rejected / tried and dropped

- **"Slowest strong coherence peak" as the atomic grid.** `R(f)` is high at the true
  pulse *and every multiple of it*, so the fundamental is the slowest strong peak —
  in theory. In practice a 12-second uniform click track has near-flat coherence and
  a grid at half density (share 0.5) still qualified, halving the tempo. Replaced by
  ranking on *share* × *coverage*: a grid twice too slow explains only half the
  attack energy, a grid twice too fast fills only half its own slots, and only the
  true atom scores on both. Requiring `share ≥ 0.72` instead was tried first and
  rejected — it rejects legitimately ornamented music (the shuffle fixture sits at
  0.53) while still admitting the half-density case at 0.559.
- **Least-squares residual cost for section boundaries.** It is *flat* at the true
  change, because at a real tempo change both grids pass through the same beat and
  fit equally well on either side of it. Measured cost differed by 0.9 % between the
  correct split and one a beat early — noise. What *is* sharp is that the two grids
  share a beat there and drift apart linearly away from it, so the boundary is now
  placed at that crossing.

### Open items

- **The octave remains a judgement call, and always will be.** A 92 BPM song with
  eighth-note hats is a valid 184 BPM map; 225 BPM streams read as 112.5 to any
  estimator carrying a perceptual prior. `Prefer map BPM (120–300)` breaks the tie
  toward osu!'s range and ×2 / ÷2 is now instant and exact, but no detector settles
  this for you.
- Rubato and non-percussive audio still route to the v2 tracker, which emits a
  staircase of sections. Fitting a slowly-varying tempo curve (rather than piecewise
  constant) would serve those tracks properly.
- Swing and shuffle produce exact BPM and offset but a large grid residual, because
  the off-beats genuinely do not sit on a subdivision. That number is honest, but the
  confidence score currently reads it as instability.
- **The benchmark is entirely synthetic.** That is what makes sub-millisecond ground
  truth possible, but synthesized drums are cleaner than recorded ones and the
  numbers above should be read as an upper bound, not a promise about real masters.
  A small set of real tracks hand-timed in the osu! editor would be the honest
  complement — expensive to build, and worth it.

---

## v2.2 — 2026-09-03 · Editing, injection, hardening

Two commits (`0576894`, `ea5cb6e`).

- **Changed**: manual timing-point editor (add / update / delete / nudge ±1 and
  ±5 ms / per-section ×2 and ÷2); `.osu` injection preserving green lines and CRLF
  style with a `.bak` backup; per-section half-time pulse hints; menu bar i18n.
- **Fixed**: CSV column labels; CLI error paths made to exit cleanly instead of
  raising tracebacks; the GUI worker thread stopped touching Tk variables (it now
  captures parameters before the thread starts).
- **Hardening**: parameter validation before any I/O; validation tests.
- **Measured**: not measured — accuracy work in this release was qualitative.

## v2.1 — 2026-09-03 · Hybrid tracking

Commit `a3bc82e`.

- **Changed**: hybrid beat tracking (librosa DP + PLP + peak-picking fallback, most
  clock-regular candidate wins); sub-frame parabolic transient re-anchoring;
  half/double-time resolved from onset evidence at subdivided grid positions rather
  than blind multiplication; defaults retuned for songs that change tempo often;
  English as the default UI language.
- **Fixed**: half-time locks collapsing a whole map into one "constant" section
  (225 vs 222.2 differ by only ~1.4 BPM once halved, below `min_delta`).
- **Measured**: not measured — no ground-truth harness existed yet, which is
  precisely why the v2 error floor went unnoticed until v3.

## v1 — 2026-09-03 · Initial release

Commit `fae9bf7`. Onset-strength envelope, `librosa.beat.beat_track`, tempo from
smoothed beat intervals, persistence-based segmentation, Tk GUI, CSV and `.osu`
text export.

---

## Resumen en español

Este archivo es el registro de ingeniería del proyecto: qué cambió, **por qué**, y
qué efecto medible tuvo. Entradas de más nueva a más vieja, una por versión, cada
una con las mismas cuatro secciones (Changed / Fixed / Hardening / Measured) más,
cuando aplica, `Rejected` — las ideas que se probaron y se descartaron, porque el
razonamiento es lo caro de reconstruir después.

El cambio central de v3.0: el BPM ya no sale de las diferencias entre beats
consecutivos, sino de un ajuste por mínimos cuadrados sobre los tiempos de ataque.
Error mediano 0,0000 BPM y 0,14 ms frente a 0,18 BPM y 8,2 ms en v2.2, y unas 7
veces más rápido. Lo que sigue sin resolverse — y no lo resuelve ninguna
herramienta — está en `Open items`.
