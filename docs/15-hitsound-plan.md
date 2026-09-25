# Hitsounds: the plan

[`06-hitsound-engine.md`](06-hitsound-engine.md) says *what* the hitsound engine is. This
document says *how to get there*: what already exists, what has to land first, and the
order in which each step ships something a mapper can use on its own. Written 2026-09-24,
when hitsounds became the next priority (the most requested feature).

The rule that shapes the order: **every step is usable alone, and every step is measured
before the next one leans on it.** Automatic hitsounding is the last step, not the first:
it needs everything else, and it is the step whose quality is hardest to prove.

---

## 1. What exists

| Piece | State | Where | Limit |
|---|---|---|---|
| Per-attack features (7 bands, spectral shape, rise/decay, HPSS, pitch, formants) | done | `overtone-hitsound` (Rust) | not reachable from the CLI or the app |
| Instrument templates, 13 classes, calibrated | done | `template.rs` | held-out macro F1 0.723 **on synthetic audio**; clap 0.15, closed hat 0.40. `calibrated_templates()` re-fits on every call: 3.4-3.6 s |
| Synthetic labelled corpus | done | `corpus.rs` | synthetic drums: an upper bound |
| Musical role (grid slot, metrical weight, phrase, accent, density) | done, audio side | `role.rs` | needs sections, bars and phrase edges from the caller |
| Phrase edges and sections | done | Structure view (2026-09-24) | edges are a bar near the change, not the phrase's first bar (31 % on a 4-bar line, 25 % by chance) |
| `.osu` hit objects | read | `_parse_hit_object` | `hitSound` and `hitSample` parsed; a slider's `edgeSounds` / `edgeSets` kept as raw strings |
| Audible state at a time (sample set, index, volume, kiai) | done | `_PlayState`, `_states_at_events` | built for inject; not yet applied per object |
| Map context per attack | partial | `attack_object_context` | attack-centric, object starts only, linear search per attack |
| Byte-identical writer | done, section level | `write_osu_beatmap`, inject | no edit of the hitsound fields inside a hit object line |
| Playback | done | app: one AudioContext clock, clicks scheduled 150 ms ahead | plays the song and a click; no samples |
| Timeline | done | waveform, red lines, drift lane | no object lane |
| Rust engine in the app | done | `overtone-cli` sidecar | commands: `analyze`, `structure` |
| Library index | done | `overtone_library.py` | 25,171 local maps, searchable: the evaluation corpus |

Measured on the local Songs folder (read only): of 400 standard maps with 200+ objects,
drawn from 18,179, **94 % put an addition on more than 5 % of their objects** and 94 % give
slider edges their own sounds. None sets a custom sample index on an object; mappers set
indices on green lines (not measured here). The local folder is a corpus of thousands of
real hitsounding decisions, which is what §4's evaluation uses.

### Corrections to `06-hitsound-engine.md`

- **Slider ticks take no additions.** A tick plays the slider's sample set; the format has no
  field for a tick's whistle, finish or clap. What a slider can carry is: a sound per edge
  (head, each repeat, tail: `edgeSounds`, `edgeSets`) and the body's sound (the slider's
  own `hitSound`: slide or whistle-slide). §5's "a tick on an audible attack may take one"
  cannot be written. Which of `hitSample`'s fields reach the edges and which the body is
  pinned by P-1 below, with tests, not assumed.
- **Profiles as JSON, not TOML.** `serde_json` is already a dependency; a TOML reader would
  be a new one for no capability. Same content, same "a profile is a file" rule.

---

## 2. Prerequisites

Each has an id, what it unblocks, and a size (S, M, L: relative effort, not a date).
**Done** ones are listed so the dependency picture is complete.

| Id | Prerequisite | Why it is needed | Unblocks | Size | Status |
|---|---|---|---|:--:|:--:|
| — | Proven grid and bars | metrical weight, "beat 2 of 4" | role, check, decision | — | **done** |
| — | Phrase edges | phrase position, section switches | role, decision | — | **done** |
| — | Playback clock | sample audition in time with the song | P-3 | — | **done** |
| — | Rust sidecar | the decision runs in Rust | P-4, H4 | — | **done** |
| — | Library index | picks the evaluation maps | P-6 | — | **done** |
| **P-1** | **Sound events from the map** | every object expanded into the sounds it makes: circle; slider head, each repeat, tail (per-edge sound and set), body; spinner end; mania hold. Each resolved to what osu! plays: object sample overriding the timing point's, 0 meaning "inherit". Everything below reads hitsounds through this | H1, H2, H3, H5, P-5 | M | **done** |
| **P-2** | **Hitsound field writer** | changes only `hitSound`, `edgeSounds`, `edgeSets` and `hitSample` on hit object lines, as edits over the original bytes. A write with zero changes gives the identical file (a test, and a measurement over every local map). Green lines only with consent, reusing inject's rules | H1, H5 | M | **done** |
| **P-3** | **Sample playback** | samples found as osu! finds them (beatmap folder custom index, then skin, then defaults), decoded in the page, scheduled on the existing clock. Defaults are **Overtone's own synthesised set**: osu!'s default samples are ppy's, not ours to bundle | H2, H5 | M | **done** |
| **P-4** | **Evidence through the CLI** | `overtone-cli hitsound-evidence <audio>`: per attack, class probabilities with each term's contribution, and its role. The calibrated weights baked in as constants, with a test that they equal a fresh fit (3.5 s per call otherwise) | H3 (audio half), H4 | M | todo |
| **P-5** | **Object ↔ attack matching** | object-centric: each sound event's nearest attack by binary search, and "no attack here" as a state of its own (a sound over silence) | H3, H4 | S | todo |
| **P-6** | **Real-map evaluation** | a local, read-only script over maps chosen from the library index: how often a proposal agrees with the mapper's own hitsounds, per addition, against simple baselines ("clap on 2 and 4", "finish on phrase starts"). The maps are never committed; the script and its numbers are | H3 thresholds, H4 tuning | M | todo |
| **P-7** | **Object lane on the timeline** | objects and their sounds drawn under the waveform, selectable | H2, H5 | S-M | **done** |

```
P-1 ─┬─► H1 copier ◄── P-2
     ├─► H2 hitsound view ◄── P-3, P-7
     ├─► P-5 ─┬─► H3 consistency check ◄── (P-4 for its audio half), P-6
     │        └─► H4 decision engine ◄── P-4, P-6, phrase edges, grid
     └────────────► H5 editor + export ◄── H4, P-2, P-3, P-7
```

---

## 3. What ships, in order

Each step is a feature on its own. The first two need no audio analysis at all.

### H1 · Hitsound copier (needs P-1, P-2) — done 2026-09-24

Copy the hitsounds of one difficulty onto others: every sound event of the source at the
same time (within a tolerance) gives its sound to the target's event there. Options: sample
sets, volumes, and green lines (copied only with consent). A preview lists what changes per
difficulty before anything is written; backups as inject makes them.

The most common hitsounding job there is, and a plain rule with no taste in it, so it can
be exact and tested to the byte. It also proves P-1 and P-2 on real maps before anything
riskier leans on them.

**Measure:** zero-change copy (a difficulty onto itself) is byte-identical on every local map;
events matched and unmatched per copy, on the mapsets of the local folder.

### H2 · The Hitsounds section, read only (needs P-1, P-3, P-7) — done 2026-09-24

The sidebar's Hitsounds section: every object with what it plays now, resolved; the object
lane on the timeline; audition with the samples, alone or over the song. A summary per
beat position ("claps: 96 % on beats 2 and 4") that already tells a modder a lot.

**Measure:** what it shows equals what osu! plays, on hand-made maps covering each rule of
P-1 (inheritance, per-edge sets, custom indices on greens).

### H3 · Consistency check (needs P-1, P-5; audio half P-4; thresholds P-6)

Items in the mod report: objects whose sound breaks the map's own pattern, say bar 12 beat
2 with no clap when 15 of the 16 bars around it have one, or a finish on an off-beat
16th. The first half reads only the map and the grid. The second adds the audio: a clap
over an attack that sounds nothing like a snare or clap, a whistle on silence.

Advice, never an edit, with the evidence written out. Useful for every map that already
has hitsounds, which is 94 % of them.

**Measure:** flags per map on the local corpus; a flag rate a modder would read, not
hundreds per map. Thresholds set on P-6's numbers, then held fixed.

### H4 · Decision engine (needs P-4, P-5, P-6, grid, phrase edges)

The Viterbi of `06` §6 in Rust, profiles as JSON files, a proposal per object with its
alternatives and the terms behind it. Exposed as `overtone-cli hitsound <audio> <map>`.

**Measure, two gates before it reaches the app:**
- *Synthetic:* the corpus renderer places hits with labels; a map with an object on each
  hit is hitsounded, and the proposal must put the profile's sound on each class (exact
  truth).
- *Real:* on P-6, agreement with the mapper per addition must beat the simple baselines.
  Mappers disagree with each other, so the number is not "accuracy". It is "better than a
  rule", or the engine does not ship.

### H5 · Editor and export (needs H4, P-2, P-3, P-7)

Accept, reject or change each proposal, per object or per section; volume and sample index;
undo; audition every change. Export through P-2 with a preview, backups, and optionally a
copy (`<name>_hitsounded.osu`) instead of the original.

### H6 · After it works

Sample bank import and sample-to-role recommendation (`06` §8), custom profiles in the app,
and only then the ML evaluation of `08`, against the template baseline.

---

## 4. Decisions to make

1. **Default samples.** Overtone's own synthesised set, bundled (recommended: free to
   ship, works with no skin), or ask for an osu! skin folder and play nothing without one.
2. **The copier first** (recommended), or straight to the Hitsounds section.
3. **Profile format:** JSON (recommended, no new dependency) or TOML as `06` wrote.

## 5. Honest limits, restated

- The template F1 is synthetic. Before H4, P-6 is the first measurement on real songs,
  and it may say the classes are weaker there. That is the point of measuring it first.
- Hitsounding is taste. H1 to H3 need none. H4 proposes and says why; the mapper decides.
