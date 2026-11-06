/**
 * The red lines for other rhythm games (W12.7), built in this browser from the
 * lines as the page has them (adjusted or not) after the export options.
 * Timing only: no notes, no charts. Overtone has no notes for these games, and
 * timing is the part that transfers. The reader opens the file in the game's
 * editor and charts on it.
 *
 * Where the v3 engine has an exporter (python/overtone/exports.py
 * `quaver_timing_text`, `stepmania_timing_text`), the timing text here is
 * the same, character for character but the comment line: the same numbers,
 * the same rounding (Python's half-to-even on exact ties, see `fixed`), the
 * same separators. Clone Hero has no v3 exporter.
 *
 * What each format says, and what it does with a tempo change:
 *
 * **Quaver (.qua)** is YAML. Each timing point carries an absolute
 * `StartTime` in ms (a float) and a `Bpm`, as a red line does, and each one
 * starts its own grid at its StartTime, as osu! does. So nothing accumulates
 * and a change off the previous grid costs nothing: the conversion is a
 * change of spelling. Meter: Quaver's `Signature` is an enum of Quadruple
 * (4/4, the default, left out) and Triple (3/4), as far as we know it; any
 * other meter is written as 4/4 and the page says so. Quaver may refuse to
 * play a map with no notes; the file is for its editor.
 *
 * **StepMania (.sm, .ssc)** counts beats, not ms. Beat 0 is the first red
 * line, and `#OFFSET` is where it sits, in seconds and negated: a first beat
 * 1.234 s into the audio is `#OFFSET:-1.234000;`. Each later change is a
 * `beat=bpm` pair in `#BPMS`, its beat ACCUMULATED through the tempi before
 * it: beat_i = beat_(i-1) + (t_i - t_(i-1)) / (60000 / bpm_(i-1)). A change
 * 30 s into a 150 BPM song is beat 75, not second 30. A change off the old
 * grid gives a fractional beat, which is written as it is (6 decimals, as v3
 * does). But StepMania stores a change on a row, 48 to the beat (its
 * ROWS_PER_BEAT), so on loading it moves the change to the nearest 1/48 of a
 * beat, and every beat after it moves with it, accumulating through later
 * changes. `stepmaniaRowShift` measures that from what the file says and the
 * page shows it when it reaches half a millisecond; we do not bend the BPMs to
 * hide it, which would make the file disagree with v3's. (We read this rounding
 * from StepMania 5's loader as we know it; we have not opened a file in it.)
 * `.sm` has no time signatures, so a meter other than 4/4 is lost there; `.ssc`
 * (StepMania 5) has `#TIMESIGNATURES` as `beat=numerator=denominator`, written
 * at the first line and wherever the bar changes: a new meter, or a line that
 * does not land on the running bar (osu! starts a bar at every red line;
 * StepMania counts bars from the last signature).
 *
 * **Etterna** reads StepMania's files; it has no timing format of its own that
 * we know of. The page offers the `.sm` for it rather than inventing one.
 *
 * **Clone Hero (.chart)** counts ticks: `Resolution = 192` per beat (a quarter
 * note), tempo as `tick = B <BPM x 1000>`, an integer (milli-BPM), meter as
 * `tick = TS <numerator>` (the denominator's log2 would follow; 4 is the
 * default and left out). Every position is a whole tick, so:
 * - **The start.** Tick 0 is the audio's start. `[Song] Offset` is written as
 *   0: Moonscraper (the editor Clone Hero charts are made in) treats that
 *   field as legacy as far as we know, and the games have not all read it the
 *   same way, so we do not lean on it. Instead the first line's grid is drawn
 *   back to its first downbeat at least half a bar in, and one lead-in bar from
 *   tick 0 takes exactly that long (its own BPM, between 2/3 and 2 times the
 *   first line's). When a downbeat falls on 0 itself, there is no lead-in.
 * - **A change off the grid.** Its tick is the accumulated beats x 192,
 *   rounded. Rounding alone would move the change up to half a tick, and every
 *   later one with it, so the section before it keeps its own BPM only when
 *   that lands the change within `CHART_TOLERANCE_MS` of its time; otherwise
 *   that section's BPM is fitted (to the milli-BPM) so it does. The game's own
 *   arithmetic is followed throughout, so the error never accumulates.
 *   `chartSyncTrack` reports how many sections were fitted and the worst miss.
 * - **Bars**, as in `.ssc`: a `TS` at tick 0 and wherever the bar changes.
 * The audio is named `song.<ext>` in the file, the name Clone Hero looks for.
 *
 * The four after them (W13.11) are JSON. We wrote each from its format as the
 * community documents it and as we know the games' loaders; we have opened
 * none of them in its game or editor, and each paragraph says where we are
 * least sure. Numbers are written to `JSON_DECIMALS` (6), and every position
 * is worked from where the file puts the change before it (`writtenBeats`,
 * `unitTimeline`), so a rounding moves one change by a hair and never
 * accumulates. Tests: test/game-formats-more.test.js, against hand-made
 * files in test/fixtures/games and read back by each game's arithmetic.
 *
 * **Beat Saber** gets a **v3** difficulty file (`"version": "3.3.0"`), named
 * `ExpertStandard.dat`: `bpmEvents: [{ b, m }]`, `b` the beat and `m` the BPM
 * from that beat on, and every other v3 list empty. We chose v3 over v2
 * because v2 has no official BPM event of its own (the editors kept them in
 * `_customData._BPMChanges`, and a late v2 used event type 100), while v3's
 * `bpmEvents` are the game's; v4 drops them for an audio file's BPM data,
 * which editors convert from v3. The beats are accumulated through the tempi,
 * as StepMania's are: a change at beat b after a BPM m holds from there on.
 * Beat 0 is the audio's start (Info.dat's `_songTimeOffset` is not used by the
 * game as far as we know, so we do not lean on it), so as in Clone Hero a
 * lead-in reaches the first line's grid: one beat from 0 to its first beat at
 * least half a beat in, its own BPM (2/3 to 2 times the first line's). Beats
 * are not whole, so nothing is fitted. A BPM event that repeats the one
 * before (a meter change alone: Beat Saber has no meter) is left out. Info.dat
 * is the editor's: the page names the BPM to give it (the first line's),
 * which is what the game's note jump distance reads.
 *
 * **A Dance of Fire and Ice** (`.adofai`, settings version 13) is a path of
 * tiles: with every `angleData` entry 0 the path is straight and each move is
 * one beat at the current speed. `settings.offset` is the time of tile 0 in
 * whole ms (as we understand it: the first tile is the first beat; if the
 * editor shows it a beat late, move the offset by one beat), `settings.bpm`
 * the first speed, and a `SetSpeed` action (`speedType: "Bpm"`,
 * `beatsPerMinute`) on a floor sets the speed from that tile on. A change
 * must sit on a tile, so a span that is not whole beats ends on one **odd
 * tile**: whole beats at the span's own BPM, then one tile of 0.5 to 1.5
 * beats whose BPM is set so the next line lands on its tile (two SetSpeeds:
 * the odd tile's and the line's). The grid stays the song's everywhere but in
 * that tile. Angled tiles could give a fractional beat instead, but which way
 * an angle counts is easy to get backwards untested, and a wrong guess there
 * would be silent; a speed is not. The tiles run to the song's end. A first
 * line before the audio is drawn forward by whole beats.
 *
 * **Friday Night Funkin'** gets the legacy chart JSON that the game before
 * 0.3 and Psych Engine read (`{ song: { song, bpm, notes: [sections] } }`;
 * 0.3's own format is two files, and its editor imports this one, as far as
 * we know). A section is 16 steps (4 beats); a section with `changeBPM: true`
 * sets `bpm` from its start, and the game adds the sections' steps up from the
 * audio's start. Sections carry `lengthInSteps` (the old game's) and
 * `sectionBeats` (Psych's), so a section may be shorter. Changes sit on
 * section starts, so: a lead-in from 0 of whole steps at the first line's BPM
 * (fitted so it ends on the first line's first section, which is at least
 * half a section in), and a span that is not whole sections ends on an odd
 * section of the nearest whole steps, fitted the same way when keeping the
 * span's BPM would miss the next line by more than `ODD_TOLERANCE_MS`.
 *
 * **Rhythm Doctor** (`.rdlevel`, settings version 55) places events by bar and
 * beat, both from 1. `PlaySong` at bar 1 beat 1 carries the song's `bpm` and
 * `offset` (whole ms: where bar 1 beat 1 is in the audio, the first line);
 * `SetBeatsPerMinute` (`beatsPerMinute`) changes the tempo at a later beat,
 * fractional when the change is off the grid; `SetCrotchetsPerBar` sets the
 * bar's length (Rhythm Doctor's default is 8) from a bar's first beat, so it
 * is written at bar 1 and at a new meter that starts a bar. A new meter in the
 * middle of a running bar is not written and the page counts it. The events
 * carry `y: 0`, the editor's row. How finely Rhythm Doctor stores a beat we do
 * not know; we write 6 decimals.
 */

export {
  CHART_RESOLUTION,
  CHART_TOLERANCE_MS,
  fixed,
  gameLines,
  JSON_DECIMALS,
  ODD_TOLERANCE_MS,
  STEPMANIA_DECIMALS,
  STEPMANIA_ROWS_PER_BEAT,
  writtenBeats,
} from './game-formats/common.js'
export {
  quaFile,
  quaverTimingText,
} from './game-formats/quaver.js'
export {
  stepmaniaBeats,
  stepmaniaFile,
  stepmaniaRowShift,
  stepmaniaTimingText,
} from './game-formats/stepmania.js'
export {
  chartFile,
  chartSyncTrack,
} from './game-formats/clone-hero.js'
export {
  BEAT_SABER_VERSION,
  beatSaberBpmEvents,
  beatSaberFile,
} from './game-formats/beat-saber.js'
export {
  ADOFAI_VERSION,
  adofaiFile,
  adofaiTimeline,
} from './game-formats/adofai.js'
export {
  FNF_STEPS_PER_SECTION,
  fnfFile,
  fnfSections,
} from './game-formats/fnf.js'
export {
  RHYTHM_DOCTOR_VERSION,
  rhythmDoctorFile,
  rhythmDoctorTimeline,
} from './game-formats/rhythm-doctor.js'
export {
  GAME_FORMATS,
  gameFile,
} from './game-formats/registry.js'
