// Overtone web shell — talks to overtone_web.Api through window.pywebview.api.
// Python pushes analysis events back through window.overtone.on*.
"use strict";

const I18N = {
  en: {
    tagline: "Timing for osu! maps", nav_timing: "Timing", offline: "offline, nothing leaves this PC",
    nav_sections: "Sections", nav_library: "Library", nav_mapcheck: "Map check", nav_export: "Export", nav_history: "History", nav_settings: "Settings",
    close: "Close",
    need_title: "Nothing analyzed yet",
    need_body: "{view} works on the analyzed song, the same one every section shares. Open an audio file and analyze it.",
    need_busy: "Analyzing… {view} fills in as soon as it finishes.",
    need_analyze: "Analyze {name}", need_library: "Go to Library",
    mapcheck_sub: "One difficulty you mapped, checked against this analysis. Read only: nothing is written.",
    export_sub: "Everything here writes the current timing points, edits included.",
    exp_osu_t: "osu! timing points", exp_osu_d: "The red lines as [TimingPoints] text, ready to paste into a .osu.",
    exp_qua_t: "Quaver timing points",
    exp_qua_d: "The red lines as a .qua TimingPoints block. Written from the format as documented — no game has opened one here, so check it once in the editor.",
    exp_sm_t: "StepMania timing",
    exp_sm_d: "#OFFSET and #BPMS for a .sm or .ssc. StepMania counts from beat 0 and states where it sits, so the offset is negative. Same caveat: no game has opened one here.",
    exp_game_ok: "Read back: {lines} line(s), every beat within {ms} ms of the timing above.",
    exp_game_off: "Read back: the {lines} line(s) did not come back as written — do not use this text.",
    actions_copy_qua: "Copy .qua", actions_copy_sm: "Copy #BPMS",
    exp_csv_t: "CSV table", exp_csv_d: "Offset, BPM, beat and confidence per point, for a spreadsheet.",
    exp_click_t: "Click track", exp_click_d: "A metronome WAV on these red lines, to hear any drift against the song.",
    exp_osz_t: ".osz package", exp_osz_d: "The audio plus a new beatmap carrying this timing.",
    exp_inject_t: "Inject into a .osu", exp_inject_d: "Replaces the red lines of a difficulty you already have. You confirm first, and a backup is kept.",
    exp_inject_all_t: "Inject into every difficulty", exp_inject_all_d: "Replaces the red lines of every .osu beside the analyzed song. One preview, one confirmation, each file backed up first.",
    exp_inject_all_preview: "Preview all", actions_inject_all: "Inject all…",
    inject_all_row: "{file}: {replaced} replaced, {added} new",
    inject_all_row_drift: ", drift {d}ms",
    inject_all_row_greens: ", +{g} greens",
    inject_all_row_mismatch: " (audio differs)",
    inject_all_error: "{file}: {detail}",
    inject_all_confirm: "Replace the red lines of {n} difficulties ({files})? Each file is backed up first.{warn}",
    inject_all_warn: " Some .osu files name a different audio.",
    inject_all_done: "Injected {n} difficulties, {f} skipped.",
    inject_all_nothing: "No difficulty to inject into.",
    hist_sub: "Every .osu write this app made, newest first, with the backup holding what it replaced. Restoring keeps the current file as a new backup first.",
    hist_title: "Writes", hist_empty: "Nothing written yet.",
    hist_t_when: "When", hist_t_what: "What", hist_t_file: "File", hist_t_backup: "Backup",
    hist_diff: "Diff", hist_restore: "Restore", hist_count: "{n} writes",
    hist_op_inject: "timing", hist_op_hitsounds: "hitsounds", hist_op_write: "write", hist_op_restore: "restore", hist_op_swap: "audio swap",
    hist_op_resnap: "re-snap", hist_op_bookmarks: "bookmarks", hist_op_kiai: "kiai", hist_op_breaks: "breaks",
    hist_op_scroll: "constant scroll", hist_op_volumes: "section volumes", hist_op_hsdiff: "hitsound difficulty",
    hist_op_suggestion: "suggested red line",
    hsd_title: "Hitsound difficulty",
    hsd_sub: "A new difficulty beside the others with a circle at every sound of the mapset, each playing it exactly: hitsound in one place, then copy it to every difficulty (Mapset, Copy hitsounds). Where two difficulties sound together the source's sound wins; timing, events and settings are the source's own.",
    hsd_source: "Sounds from", hsd_fill: "Fill in the other difficulties' sounds where the source has none",
    hsd_preview: "Preview", hsd_write: "Write the difficulty",
    hsd_would: "{dest}: {n} circles, {src} from {name} and {others} from the other difficulties ({merged} sounds shared within 5 ms).",
    hsd_exact: "Every circle plays its sound exactly.",
    hsd_stacked: "{n} of the source's sounds share their time with a different one (a chord, stacked objects): the circle keeps the first (the first at {time}).",
    hsd_inexact: "{n} circles cannot play exactly: the format can only inherit an index of 0 there, and the source's green lines give another (the first at {time}).",
    hsd_confirm: "Write {dest} beside the song? It is a new file: nothing is replaced.",
    hsd_done: "Wrote {dest}: {n} circles.",
    hsd_exists: "{dest} is already beside the song: remove or rename it to write a new one.",
    hist_added: "+{n} red lines", hist_removed: "−{n} red lines", hist_changed: "~{n} red lines moved",
    hist_no_change: "same red lines",
    hist_confirm: "Restore {file} from {backup}? The current file is kept as a new backup first.",
    hist_restored: "{file} restored.",
    hist_summary_hitsounds: "{n} objects", hist_summary_inject: "{n} red lines",
    nav_mapset: "Mapset",
    mapset_sub: "Every difficulty of one beatmap folder side by side: red lines, audio settings and metadata that must match. The comparison only lists differences; Copy hitsounds writes, after a preview, with backups.",
    ms_title: "Difficulties", ms_pick: "Choose beatmap folder…", ms_recheck: "Check again",
    ms_empty: "Choose a beatmap folder, or import one in the Library, to compare its difficulties.",
    ms_no_maps: "That folder has no .osu files.",
    ms_count: "{n} difficulties", ms_all_match: "everything matches", ms_to_check: "{n} to check", ms_unreadable_n: "{n} unreadable",
    ms_t_diff: "Difficulty", ms_t_reds: "Red lines", ms_t_audio: "Audio", ms_t_meta: "Metadata", ms_t_kiai: "Kiai",
    ms_t_objects: "Objects", ms_t_rate: "Per second (mean · peak)",
    ms_reference: "reference", ms_match: "same", ms_differ: "{n} differ",
    ms_unreadable: "Could not read this file: {detail}",
    ms_kiai_none: "none", ms_kiai_end: "end",
    ms_density_note: "Objects per second over 5 s windows, to compare difficulties with each other. Not a star rating.",
    ms_red_title: "Red lines",
    ms_red_ref: "Compared with {ref}, the difficulty most others match.",
    ms_red_same: "Every difficulty has the same red lines.",
    ms_t_offset: "Offset (ms)", ms_t_what: "What differs",
    ms_d_offset: "Moved to {found} ms; the reference has it at {expected} ms.",
    ms_d_beat_length: "Beat length {found} ms instead of {expected} ms.",
    ms_d_meter: "Meter {found}/4 instead of {expected}/4.",
    ms_d_missing: "Missing: the reference has a red line here.",
    ms_d_extra: "Extra: the reference has no red line here.",
    ms_fields_title: "Audio and metadata",
    ms_fields_hint: "Each field shows the value most difficulties have.",
    ms_t_field: "Field", ms_t_value: "Value", ms_t_differs: "Different in",
    ms_same_all: "same in all", ms_not_set: "(not set)", ms_empty_value: "(empty)",
    open: "Open audio", analyze: "Analyze", analyzing: "Analyzing…",
    empty_title: "Time a song in one click",
    empty_body: "Open an audio file and Overtone finds every BPM change, offset and bar line.",
    stat_global: "Global BPM", stat_points: "Timing points", stat_beats: "Beats", stat_stability: "Stability", stat_engine: "Engine",
    trace_title: "Tempo map", trace_sub: "Wheel to zoom · drag to pan · drag a red line to move it (it snaps to an attack; Alt moves it freely) · click selects, double-click plays · Shift-drag marks a loop on the beats (Alt: anywhere), Shift-click clears it",
    pb_loop_drawn: "Loop {a} – {b}", loop_set: "Loop {a} – {b}: {n} beats", loop_set_free: "Loop {a} – {b}: {s} s", loop_cleared: "Loop cleared: Loop section follows the playhead again",
    no_song: "No song open", no_song_hint: "Open an audio file to start", analyze_last: "Analyze the last song",
    k_open: "open", k_analyze: "analyze", table_hint: "↑ ↓ to move", f_preset: "Preset",
    d_song: "Song", d_point: "Timing point", d_offset: "Offset", d_beat: "Beat length", d_meter: "Meter",
    d_conf: "Confidence", d_span: "Governs", d_until: "until {t}", d_end: "to the end", d_bars: "{n} bars",
    d_duration: "Duration", d_first: "First beat", d_engine: "Engine", d_residual: "Grid residual",
    d_pulse: "Pulse", d_sections: "Grid sections", d_hint: "Select a timing point in the list or on the tempo map to inspect it.",
    d_timing: "Analysis", d_timing_cached: "from the cache, {s} s",
    project_offer: "You worked on this song's timing on {when}: {n} red lines. This analysis does not have that work.",
    project_offer_locks: "You worked on this song's timing on {when}: {n} red lines ({locks} locked). This analysis does not have that work.",
    project_restore: "Restore my work", project_keep: "Keep the analysis",
    project_restored: "Your work is back: {n} red lines. Undo returns to the analysis.",
    stop: "Stop", stopping: "Stopping", stop_hint: "Stops the analysis where it is, without waiting for the stage to end; the result on screen stays",
    analysis_stopped: "Analysis stopped after {s} s", analysis_stopped_kept: "Analysis stopped after {s} s — the result on screen stays",
    stage_load: "Audio", stage_attacks: "Attacks", stage_coherence: "Pulse scan", stage_octave: "Octave",
    stage_sections: "Sections", stage_fallback: "Beat tracker", stage_transients: "Transients",
    stage_tracking: "Beats", stage_pulse: "Half/double time", stage_local: "Local tempo", stage_rust: "Rust engine",
    d_meter_known: "Bar found in the accents: this red line sits on a downbeat.",
    d_meter_guess: "No bar evidence: the red line sits on a beat, and the meter is the analysis default.",
    lg_tempo: "tempo", lg_points: "timing points", lg_onsets: "onsets", lg_ghost: "map lines",
    table_title: "Timing points", col_offset: "Offset (ms)", col_beat: "Beat (ms)", col_meter: "Meter", col_conf: "Confidence",
    detection: "Detection settings", preset_variable: "Variable tempo", preset_steady: "Steady",
    f_delta: "Min change (BPM)", f_persist: "Confirm beats", f_conf: "Min confidence (%)", f_pulse: "Pulse (octave)", auto: "Auto",
    t_prefer: "Prefer map BPM (120–300)", t_refine: "Re-anchor beats to transients",
    t_rust: "Rust engine (faster, same results)",
    t_rust_note: "Runs at the grid's own pulse. Where it finds no grid, the Python engine takes over and says so.",
    t_rust_missing: "The Rust engine is not built on this machine (cargo build --release -p overtone-cli).",
    warn_rust_fallback: "Analysed with the Python engine: {why}.",
    backend_rust: "Rust", backend_python: "Python",
    inspector_note: "Applied on the next Analyze. Shared with the classic window.",
    songopt_applied: "This song's own settings are back: {what}.",
    songopt_note: "These are this song's own settings, from its last analysis: {what}.",
    songopt_back: "Use the previous ones", songopt_reverted: "Back to the settings you had before.",
    songopt_custom: "{d} BPM · {p} beats · {c} %", songopt_pulse: "pulse {p}",
    songopt_no_prefer: "no BPM preference", songopt_no_refine: "no re-anchoring",
    conf_live_same: "At {v} %: the same red lines as now ({lines}).",
    conf_live_diff: "At {v} %: {lines}, against {now} now. On the map, dashed: the ones it would add; faded: the ones it would drop.",
    conf_apply: "Apply to this analysis",
    conf_applied: "At {v} % now: {lines}. Undo puts back the ones before.",
    conf_line: "1 red line", conf_lines: "{n} red lines",
    engine_precision: "precision grid", engine_legacy: "beat tracker fallback",
    constant: "constant", variable: "variable", points_n: "{n} points", meter_known: "bar found", meter_guess: "bar assumed",
    time_at: "time", tempo_at: "tempo", line_at: "red line", conf_at: "confidence",
    before_first: "before the first red line: its grid runs back here",
    warn_legacy: "No steady grid could be fitted, so this result comes from the fallback beat tracker. Check it by ear before mapping.",
    warn_loose: "The grid fits loosely (residual {ms} ms). The tempo may drift; listen to the click track.",
    v_dup_points: "Two red lines {gap} ms apart — one of them is a duplicate.",
    v_short_section: "Section #{n} lasts {beats} beats, less than a bar. Check it by ear.",
    v_impossible_change: "Tempo jumps {from} → {to} BPM — that is a detection error, not music.",
    v_octave_check: "Section #{n} moves {from} → {to} BPM: half-time feel or an octave mistake? Your call.",
    v_negative_offset: "Point #{n} sits at {ms} ms — before the audio starts.",
    v_bad_number: "Point #{n} has no usable number — re-analyze or delete it.",
    v_late_first: "The first red line is at {line} s but the music starts at {beat} s. Everything before it inherits this timing — check the intro.",
    v_past_end: "Point #{n} sits at {ms} ms — past the end of the audio.",
    bad_file: "Choose an existing audio file first.", bad_values: "Check the detection values.",
    bad_drop: "That drop could not be read as audio.", too_big: "That file is over 64 MB — not a beatmap's audio.",
    busy: "An analysis is already running.", first: "Analyze a song first.", no_grid: "No stored beat grid — analyze again.",
    no_selection: "Select a timing point first.",
    lock: "Lock", unlock: "Unlock", locked_pill: "locked",
    locked_note: "Locked: the editor skips this point and re-analysis keeps it.",
    locked_on: "Point #{n} locked.", locked_off: "Point #{n} unlocked.",
    point_locked: "Point #{n} is locked — unlock it first.",
    undo: "Undo", redo: "Redo",
    no_undo: "Nothing to undo.", no_redo: "Nothing to redo.",
    undone: "Undone.", redone: "Redone.",
    actions_copy: "Copy .osu", actions_csv: "Save CSV…", actions_click: "Save click track…", actions_osz: "Save .osz…", actions_inject: "Inject .osu…",
    e_offset: "Offset (ms)", e_bpm: "BPM", e_apply: "Apply", e_add: "Add", e_delete: "Delete",
    edited: "Point #{n}: {bpm} BPM · {ms} ms", added: "Added {bpm} BPM at {ms} ms", deleted: "Deleted point #{n}",
    section_rescaled: "Section #{n}: {bpm} BPM",
    e_split: "Split at playhead", e_merge: "Merge with next",
    e_meter: "Beats per bar", e_meter_hint: "The bar's length from this red line to the next; the beat stays",
    meter_set: "Point #{n}: {m}/4, the beat unchanged",
    e_split_hint: "A red line on this section's beat nearest the playhead; both halves are refitted to their attacks",
    e_merge_hint: "Removes the next red line and refits the whole span from this one",
    split_outside: "Put the playhead inside this section first",
    split_done: "Split at {time} — before: {first} · after: {second}",
    merged_done: "Merged — {first}",
    refit_bpm: "{bpm} BPM, {share}% on grid", refit_kept_few: "{bpm} BPM kept: too few attacks",
    refit_kept_weak: "{bpm} BPM kept: only {share}% on grid",
    copied: "Timing points copied — paste into the .osu [TimingPoints].",
    clipboard_failed: "Could not reach the clipboard: {detail}",
    saved_to: "Saved to {path}",
    osz_named_map: "named {artist} - {title}, as the song's own maps name it",
    osz_named_tags: "named {artist} - {title}, from the audio's tags",
    injected: "Injected {added} red lines ({replaced} replaced, {greens} green kept).",
    inject_confirm: "Replace {reds} red lines with {n} new ones in {file}?{warn}",
    inject_diff_line: "{o}ms {ob} → {n}ms {nb}",
    inject_diff_drift: " (drift {d}ms)",
    inject_diff_more: "+{n} more changed lines",
    inject_diff_same: "{n} lines unchanged",
    inject_greens: "\nIt also adds {g} green lines so slider velocity and hitsounds play as before.",
    inject_warn: "\nThe .osu audio ({osu}) differs from the analyzed file ({src}).",
    drop_title: "Drop the audio", drop_body: "Release to time it with the current detection settings.",
    recent: "Recent",
    nav_hitsounds: "Hitsounds",
    hsv_sub: "What one difficulty plays: where its additions fall in the bar, every sound to hear one by one, and the decision engine's proposals to write or not.",
    hsv_map: "Difficulty", hsv_none: "No difficulty beside this song plays its audio.",
    hsv_sounds_n: "Sounds", hsv_sets: "Sample sets", hsv_samples: "Samples",
    hsv_samples_v: "{map} the map's · {own} Overtone's",
    hsv_where_title: "Where the additions fall",
    hsv_where_note: "Share of each addition on each sixteenth of a {meter}/4 bar, read against the map's own red lines.",
    hsv_top: "{pct} % on {slots}", hsv_none_add: "none",
    hsv_between: "{n} between sixteenths (triplets and the like)", hsv_other_meter: "{n} under another meter",
    hsv_sounds: "Sounds", hsv_all: "All", hsv_count: "{n} sounds",
    hsv_t_time: "Time", hsv_t_place: "Bar · beat", hsv_t_part: "Part", hsv_t_sounds: "Sounds",
    hsv_t_sets: "Sets", hsv_t_index: "Index", hsv_t_volume: "Volume",
    hsv_play: "Hear this sound", hsv_more: "Show {n} more",
    hsv_play_proposal: "Hear this sound as it would be written",
    hsv_decide_title: "Propose and edit hitsounds",
    hsv_decide_sub: "The decision engine proposes every object's sound; volume and sample index are yours to set. Tick what to keep, hear it over the song, preview, then write the file or a copy. Each write is backed up, and one undo restores it.",
    hsv_propose: "Propose", hsv_proposing: "Deciding every sound…",
    hsv_propose_all: "Every difficulty",
    hsv_all_done: "{n} difficulties decided on one reading of the song.",
    hsv_all_one: "1 difficulty decided.",
    hsv_all_some: "{n} of {of} difficulties decided; {bad} could not be read.",
    hsv_all_some_one: "{n} of {of} difficulties decided; 1 could not be read.",
    hsv_profile: "Profile", hsv_prof_balanced: "Balanced",
    hsv_prof_balanced_note: "Balanced, the default: every instrument heard can take its sound, placed by the beat.",
    hsv_prof_drum_focused: "Drum-focused",
    hsv_prof_drum_focused_note: "Drum-focused: kick, snare, hats and cymbals choose the sounds; vocals and melody only keep the plain sound; a finish leans to where a combo starts.",
    hsv_prof_again: "The proposals shown were decided with {used}: press Propose to decide with {chosen}.",
    bad_profile: "That hitsound profile is not in the profiles folder.",
    hsv_proposed: "{n} proposals", hsv_decide_all: "All", hsv_decide_none: "None",
    hsv_preview: "Preview", hsv_would_change: "{what}: {n} objects would change",
    hsv_what_ticked: "{accepted} of {units} proposals ticked", hsv_edited: "{n} objects edited", hsv_and: " and ",
    hsv_what_ticked_alt: "{accepted} of {units} proposals ticked, {chosen} of them an alternative",
    hsv_alts: "{n} alternatives", hsv_alt_aria: "The proposal or one of its alternatives",
    hsv_alt_note: "In the table, a proposal can be swapped for one of its alternatives. The percentages say how likely each sound is there on its own, among the 24 the engine weighs, which keeps them low. The proposal is the one that fits the whole sequence best, so an alternative can score higher alone.",
    hsv_why_proposed: "Proposed", hsv_why_behind: "behind it:", hsv_why_heard: "Heard", hsv_why_terms: "Why",
    hsv_why_sum: "Its score here", hsv_why_close: "Close",
    hsv_why_silence: "Nothing was heard under it: the audio and its place in the bar say nothing here.",
    hsv_why_tail: "A slider tail takes the sound of the object landing under it.",
    hsv_why_tail_bare: "No object lands under this tail, so it stays bare.",
    hsv_why_note: "The proposal is the best path through the whole map, not the best score here alone: these are its terms at this sound, added up.",
    hsv_term_affinity: "the instrument heard", hsv_term_role: "its place in the bar", hsv_term_context: "a new combo",
    hsv_term_prior: "what the map plays now", hsv_term_transition: "the sound before it",
    hsv_div_1: "on a beat", hsv_div_2: "on an eighth", hsv_div_3: "on a triplet", hsv_div_4: "on a sixteenth",
    hsv_div_6: "on a sextuplet", hsv_div_8: "on a 32nd", hsv_div_none: "off every grid",
    hs_class_kick: "kick", hs_class_snare: "snare", hs_class_clap: "clap", hs_class_hat_closed: "closed hat",
    hs_class_hat_open: "open hat", hs_class_tom: "tom", hs_class_cymbal: "cymbal", hs_class_ride: "ride",
    hs_class_bass: "bass", hs_class_guitar: "guitar", hs_class_keys: "keys", hs_class_vocal: "vocal", hs_class_other: "other",
    hsv_hear: "Hear before writing",
    hsv_hearing: "The transport plays the file as it would be written ({what}): {n} sounds unlike the file, the first at {time}. Switch its hitsounds to {name} to compare.",
    hsv_hearing_same: "The transport plays the file as it would be written ({what}), and every sound plays as the file already does.",
    hsv_edit_volume: "Volume (%)", hsv_edit_index: "Sample index",
    hsv_edit_set: "Set on the sounds shown", hsv_edit_clear: "Clear their edits",
    hsv_edit_note: "0 follows the green line. A slider has one volume and one index for all its edges. All, None, Set and Clear act on the sounds the table shows: its filter and its bars.",
    hsv_edit_empty: "Type a volume or a sample index first.",
    hsv_edit_bad: "Volume goes from 0 to 100 and the sample index from 0 up, in whole numbers.",
    hsv_line: "the line's", hsv_bars: "Bars", hsv_bar_from: "From bar", hsv_bar_to: "To bar",
    hsv_write: "Write into this file", hsv_write_copy: "Write a copy",
    hsv_undo: "Undo", hsv_confirm_write: "Write new hitsounds on {n} objects of {file}? Only hitsound fields change, and the file is backed up first.",
    hsv_confirm_copy: "Write new hitsounds on {n} objects into a copy beside {file}? The original stays untouched.",
    hsv_done: "New hitsounds on {n} objects, written into {file}.",
    hsv_done_copy: "New hitsounds on {n} objects, written into {file}. The original stays untouched.",
    hsv_undone: "Restored {file} from before the write.",
    hsv_no_rust: "Proposals run on the Rust engine (overtone-cli), and it is not built here: cargo build --release -p overtone-cli.",
    hsv_no_proposal: "Propose or edit first: there is nothing to preview or write yet.",
    hsv_t_proposal: "Proposal",
    part_circle: "circle", part_head: "slider head", part_repeat: "slider repeat", part_tail: "slider tail",
    part_spinner_end: "spinner end", part_hold: "hold",
    lane_objects: "objects", lg_whistle: "whistle", lg_finish: "finish", lg_clap: "clap",
    g_v_short_section: "{count} sections last less than a bar. Check them by ear.",
    g_v_octave_check: "{count} sections change tempo by an octave: half-time feel or octave mistakes? Your call.",
    g_v_dup_points: "{count} red lines are duplicates, a few ms from another.",
    g_v_impossible_change: "{count} tempo jumps are detection errors, not music.",
    g_v_negative_offset: "{count} points sit before the audio starts.",
    g_v_past_end: "{count} points sit past the end of the audio.",
    g_v_bad_number: "{count} points have no usable number: re-analyze or delete them.",
    warn_show: "Show them", warn_hide: "Hide", warn_beats: "{beats} beats",
    warn_more: "{n} more notes", warn_fewer: "Show fewer notes",
    pb_hs: "Hitsounds from", pb_hs_off: "Off", pb_hs_vol: "Hitsounds",
    pb_hs_loading: "Loading the hitsounds of {name}…",
    pb_hs_proposal: "{name}, as it would be written",
    pb_hs_ready: "Hitsounds of {name}: {n} sounds and {bodies} slider slides; {map} from the map's own samples, {own} from Overtone's.",
    pb_hs_unreadable: "{n} sample(s) this window cannot decode stay silent.",
    pb_hs_ready_skin: "Hitsounds of {name}: {n} sounds and {bodies} slider slides; {map} from the map's own samples, {skin} from the skin, {own} from Overtone's.",
    pb_hs_empty: "{n} sample(s) hold no audio and mute their sound.",
    hsv_samples_v_skin: "{map} the map's · {skin} the skin's · {own} Overtone's",
    sb_title: "Samples",
    sb_sub: "The hitsound samples a folder holds, named as osu! names them: each set's four hits and the two sounds a slider body loops, then the numbered ones. Click one to hear it; a missing one plays what would play instead. The folder is only read.",
    sb_src_song: "This song's folder", sb_src_skin: "Playback skin", sb_src_pick: "Another folder…",
    sb_kind_skin: "skin", sb_kind_beatmap: "beatmap folder",
    sb_hitnormal: "normal", sb_sliderslide: "slide", sb_sliderwhistle: "whistle slide",
    sb_counts: "{hits} of 12 hits · {slides} of 6 slider sounds",
    sb_counts_empty: "{n} with no audio in them: they mute their sound",
    sb_missing_skin: "{n} missing: {skin} play the skin's, {own} Overtone's own",
    sb_missing_all_skin: "{n} missing: the skin's play instead",
    sb_missing_own: "{n} missing: Overtone's own play instead",
    sb_cell_title: "{file} · {kb} KB",
    sb_cell_empty: "empty", sb_cell_empty_title: "{file} holds no audio: it mutes this sound",
    sb_cell_skin: "→ skin", sb_cell_own: "→ Overtone",
    sb_cell_skin_title: "Not in this folder: the skin's {file} plays",
    sb_cell_own_title: "Not in this folder: Overtone's own {file} plays",
    sb_custom_beatmap: "Custom indices {list}: {n} samples a map asks this folder for by index",
    sb_custom_skin: "{n} numbered samples: osu! asks a skin for no index, so none of them plays",
    sb_unused: "Never played, {n}: {names}. Index 1 takes no number, and no index starts with a zero.",
    sb_shadowed: "Shadowed, {n}: {names}. A file of the same name that osu! looks for first (wav, then ogg, then mp3) plays instead.",
    sb_more: "{n} more",
    sb_skin_none: "Playback asks no skin: what a map's folder lacks plays Overtone's own samples.",
    sb_skin_is: "Playback skin: {name}. What a map's folder lacks plays its samples, else Overtone's own.",
    sb_skin_gone: "The playback skin is not there any more ({path}): Overtone's own samples play instead.",
    sb_use: "Use for playback", sb_stop: "Stop using a skin",
    sb_used: "Playback now asks {name} for what a map's folder lacks.",
    sb_stopped: "Playback asks no skin now: Overtone's own samples fill in.",
    sb_hear: "Hear it at the selected sound",
    sb_hear_pick: "Click a sample, then select a sound in the Sounds table: the song plays from a second before it, with the sample in that sound's place.",
    sb_hear_sound: "Select a sound in the Sounds table: the song plays from a second before it, with {sample} in that sound's place.",
    sb_hear_ready: "{sample} in place of the sound at {time} (bar {bar} · {beat}), from a second before.",
    sb_hear_no_map: "No difficulty beside this song plays its audio, so there is no sound to hear it at.",
    sb_hearing: "Playing {sample} at {time}…",
    sb_loading: "Reading the folder…",
    sb_gone: "That sample is not in its folder any more: read the folder again.",
    sb_empty_heard: "{file} holds no audio: it plays nothing.",
    hs_title: "Copy hitsounds", hs_preview: "Preview", hs_apply: "Copy hitsounds",
    hs_sub: "Each sound of the chosen difficulties takes the source's sound at the same moment (within 5 ms): additions, sample sets and index. Sounds with nothing under them are left as they are. Only hitsound fields change, and every file is backed up first.",
    hs_source: "From", hs_targets: "Onto",
    hs_volumes: "Copy volumes too (usually the green lines' job; they are not copied)",
    hs_no_targets: "Choose at least one difficulty to copy onto.", hs_same_file: "A difficulty cannot be copied onto itself.",
    hs_t_diff: "Difficulty", hs_t_sounds: "Sounds", hs_t_matched: "With a source sound", hs_t_changed: "Will change",
    hs_t_unmatched: "Nothing under them", hs_t_conflicts: "Index conflicts",
    hs_conflict_note: "An index conflict is a sound whose sample index comes from a green line the target does not have, or a slider edge whose index differs from its head's: the copy leaves those indexes as they are.",
    hs_confirm: "Write the hitsounds of {source} into {n} difficulties? Only hitsound fields change; each file is backed up first.",
    sw_title: "Audio swap", sw_preview: "Preview", sw_apply: "Move every time",
    sw_sub: "Measures the shift between the mapped audio and a new encode, and moves every timing line, object, preview point and bookmark by it; the lead-in, a wait before the song, stays. Tempo twins and strangers refuse; every file is backed up first.",
    sw_old: "Mapped audio", sw_new: "New encode",
    sw_shift: "{ms} ms from {old} to {nw}; peak {peak}",
    sw_t_reds: "Red lines", sw_t_objects: "Objects",
    sw_confirm: "Move every time of {n} difficulties by {ms} ms onto {file}? Each file is backed up first.",
    sw_done: "{n} difficulties moved onto {file}.",
    sw_same_file: "The new encode is the mapped audio already.",
    ac_title: "Audio file",
    ac_sub: "Bitrate, sample rate, length, clipping and lead-in of the audio the maps name. Findings carry the tool's own bars; no ranking number is encoded.",
    ac_facts: "{format} · {rate} Hz · {ch} ch · {dur} · {br} kbps{avg} · peak {peak} dB",
    ac_avg: " (average)",
    ac_clean: "Clean: no clipping, short lead-in, full rate.",
    ac_clipping: "Clipping: {share}% of samples at full scale.",
    ac_long_lead: "{ms} ms of near-silence before the first sound.",
    ac_low_rate: "{rate} Hz is under CD quality.",
    ms_no_audio: "That folder names no audio file its maps can play.",
    hs_done: "Hitsounds copied into {n} difficulties ({objects} objects). Backups kept beside each file.",
    hs_nothing: "Nothing to change: these difficulties already sound like {source}.",
    st_theme: "Theme", st_theme_system: "System", st_theme_dark: "Dark", st_theme_light: "Light",
    theme_to_light: "Light theme", theme_to_dark: "Dark theme",
    nav_structure: "Structure",
    stx_sub: "Where the song's phrases change, what each part is, and why: every label beside the evidence it rests on. Read only.",
    stx_title: "Sections",
    stx_loading: "Reading the song's structure…",
    stx_no_rust: "The Structure view runs on the Rust engine (overtone-cli), and it is not built here: cargo build --release -p overtone-cli.",
    stx_none: "No phrase change found: the song reads as one part. Changes within {s} s of either end cannot be placed.",
    stx_count: "{n} sections",
    stx_intro: "Intro", stx_verse: "Verse", stx_chorus: "Chorus", stx_bridge: "Bridge", stx_outro: "Outro",
    stx_h_start: "Start", stx_h_bar: "Bar", stx_h_len: "Length", stx_h_part: "Part", stx_h_why: "Why", stx_h_moved: "Snapped",
    stx_why_chorus: "Repeats ({n}×) and is the loudest repeated part.",
    stx_why_chorus_db: "Repeats ({n}×) and is the loudest repeated part, {db} dB over the next.",
    stx_why_verse_quieter: "Repeats ({n}×), {db} dB under the chorus.",
    stx_why_verse_family: "Repeats ({n}×). The only repeated part, so there is no quieter repeat for a chorus to stand over.",
    stx_why_single: "The whole song reads as one part.",
    stx_why_intro: "Heard once, first, {s} s long (under {max} s).",
    stx_why_outro: "Heard once, last.",
    stx_why_bridge: "Heard once, between the repeats.",
    stx_unsnapped: "no proven bar within {s} s",
    stx_one_family: "Every section reads as one family: on a full mix, the harmony of verse and chorus often looks alike, and the labels cannot tell them apart. The phrase edges and the energy still hold.",
    stx_preview: "Preview point: {at} ({kind}).",
    stx_bm_title: "Bookmarks",
    stx_bm_sub: "Section starts as editor bookmarks in one difficulty, merged with its own. Nothing is ever deleted; every file is backed up first.",
    stx_bm_preview: "Preview", stx_bm_apply: "Write bookmarks",
    stx_bm_would: "{added} new of {total} bookmarks into {file}.",
    stx_bm_confirm: "Write {n} bookmarks into {file}? Its own bookmarks stay.",
    stx_bm_done: "{n} bookmarks into {file}.",
    stx_bm_nothing: "Every section start is already a bookmark in {file}.",
    stx_kiai_title: "Kiai",
    stx_kiai_sub: "Kiai on the chorus sections in one difficulty, written as green lines. Sound never changes — kiai is light, not sound; every file is backed up first.",
    stx_kiai_preview: "Preview", stx_kiai_apply: "Write kiai",
    stx_kiai_would: "{added} new, {flipped} flipped, {kept} kept over {n} choruses into {file}.",
    stx_kiai_confirm: "Write kiai on {n} choruses into {file}?",
    stx_kiai_done: "Kiai on {n} choruses into {file}.",
    stx_kiai_nothing: "Kiai already matches the choruses in {file}.",
    stx_kiai_nochorus: "No chorus sections in this song, so there is nothing to light.",
    stx_breaks_title: "Breaks",
    stx_breaks_sub: "Breaks where the song goes quiet and the map goes silent, written as 2,start,end lines. Only spans 5 s or longer are proposed; every file is backed up first.",
    stx_breaks_preview: "Preview", stx_breaks_apply: "Write breaks",
    stx_breaks_would: "{n} breaks into {file}: {spans}.",
    stx_breaks_confirm: "Write {n} breaks into {file}?",
    stx_breaks_done: "{n} breaks into {file}.",
    stx_breaks_nothing: "Nothing quiet and long enough for a break in this song.",
    stx_vol_title: "Volume",
    stx_vol_sub: "Hitsound volume following section energy in one difficulty, written as green lines. A section where the map sets its own volumes is left alone; the others take their volume all the way through. Sets, samples and kiai never move; every file is backed up first.",
    stx_vol_preview: "Preview", stx_vol_apply: "Write volumes",
    stx_vol_would: "{set} sections set ({added} new greens, {flipped} rewritten), {kept} at their volume already, {mapper} left to the map's own volumes, into {file}.",
    stx_vol_confirm: "Set the volume of {n} sections in {file}? The sections where the map sets its own stay as they are.",
    stx_vol_done: "Volumes set in {n} sections of {file}.",
    stx_vol_nothing: "Nothing to write in {file}: the sections read their volumes already, or the map sets its own.",
    stx_note: "Letters are families of sections that repeat. Each edge moves to a proven bar line within {snap} s: the nearest, or the bar before or after it when the level changes more there, by {margin} dB or more, rising into a louder section or falling into a quieter one. A bar where the change lands, not proof the phrase starts on it. A change within {edge} s of either end cannot be placed. Click a section to open it in Timing.",
    songs_title: "osu! Songs",
    songs_scan: "Scan",
    songs_rescan: "Rescan",
    songs_scanning: "Scanning…",
    songs_pick: "Folder…",
    songs_search: "Search artist, title, mapper, difficulty, tags",
    songs_listing: "Listing the folder…",
    songs_progress: "{done} / {total} folders",
    songs_removing: "Removing {n} maps that are no longer in the folder…",
    songs_none: "Not indexed yet: Scan reads {root} once.",
    songs_missing: "No Songs folder at {root}: choose one.",
    songs_empty: "No beatmaps in {root} · scanned {when}",
    songs_gone: "{root} is not there: the index ({n} maps) is from {when}.",
    songs_info: "{n} maps in {s} sets · scanned {when}",
    songs_other: "Index of {root} ({n} maps): Rescan for the current folder.",
    songs_failed: "{n} could not be read",
    songs_scanned: "Library: {n} maps in {s} sets ({changed} read, {removed} gone) in {sec} s.",
    songs_scanned_failed: "Library: {n} maps in {s} sets ({changed} read, {removed} gone, {failed} could not be read) in {sec} s.",
    songs_rebuilt: "The damaged index was rebuilt.",
    library_damaged: "The library index is damaged: Rescan rebuilds it from the folder.",
    songs_nothing: "No map matches “{q}”.",
    songs_limited: "The first {n} maps: type more to narrow them.",
    songs_diff: "diff",
    songs_diffs: "diffs",
    scan_running: "A scan is already running.",
    ref_indexed: "From the library index, scanned {when}.",
    cmp_title: "Map vs detected", cmp_pick: "Choose .osu…",
    cmp_empty: "Choose the .osu you mapped to compare it against this detection.",
    cmp_sections: "{n} sections",
    cmp_det_off: "Det. offset", cmp_det_bpm: "Det. BPM", cmp_map_off: "Map offset", cmp_map_bpm: "Map BPM",
    cmp_dbpm: "Δ BPM", cmp_dms: "Δ ms", cmp_oct: "Octave",
    cmp_octave_f: "Section #{n}: map {map} vs detected {det} BPM — an octave apart ({octave}).",
    cmp_bpm_f: "Section #{n}: map {map} vs detected {det} BPM (off by {err}).",
    cmp_offset_f: "Section #{n}: the map grid misses the detected beats by {ms} ms.",
    cmp_count_f: "The .osu has {map} red lines, detection found {det} sections.",
    cmp_no_reds_f: "That .osu has no red lines to compare.",
    cmp_unreadable_f: "Could not compare: {detail}",
    sug_title: "Suggestions",
    sug_empty: "Every detected change has a red line nearby.",
    sug_hint: "Changes Overtone hears that this map has no red line for. Add writes one into the map, backed up first; Inject .osu… writes them all.",
    sug_show: "Show", sug_add: "Add",
    sug_add_confirm: "Add a red line to {file}?\n\n{lines}\n\nThe file is backed up first, and History can restore it.",
    sug_add_line: "{o} ms · {b} BPM · {m} beats a bar, with the sample set, volume and kiai the map plays there",
    sug_add_green: "A green line at the same time keeps the slider velocity the map had there",
    sug_add_octave: "Careful: that is {k} the map's own {b} BPM here, which is more often the same pulse counted differently than a new tempo",
    sug_octave_tip: "An octave of the map's own {b} BPM here: more often the same pulse counted differently than a new tempo.",
    sug_add_objects: "{n} objects follow the new beat until the next red line",
    sug_add_sliders: "{n} slider ends move; the furthest by {d} ms, {dir}",
    sug_earlier: "earlier", sug_later: "later",
    sug_added: "Red line added at {o} ms in {file}.",
    suggestion_gone: "That suggestion is no longer in the list: the map or the analysis changed since.",
    align_title: "Alignment", align_pick: "Check alignment…",
    align_empty: "Choose a .osu to check its objects against the detected attacks.",
    align_counts: "{m}/{o} objects · {c}/{a} attacks",
    align_off_f: "{n} objects miss the attacks (worst {worst} ms).",
    align_unc_f: "{n} strong attacks have no object.",
    align_none_f: "No attacks to align against — this result came from the fallback tracker.",
    align_t_time: "Time", align_t_kind: "Object", align_t_ms: "Off by",
    align_uncovered: "Uncovered attacks (ms):",
    align_more: "+{n} more",
    den_title: "Density", den_pick: "Check density…",
    den_empty: "Choose a .osu to break its objects into hits per second.",
    den_counts: "{o} objects · peak {p}/s · {s} stream · {j} jump",
    den_t_range: "Time", den_t_n: "Objects", den_t_rate: "Per second",
    den_t_stream: "Stream", den_t_jump: "Jump", den_t_single: "Single",
    snap_title: "Snap audit", snap_pick: "Check snapping…",
    snap_empty: "Choose a .osu to list the objects off its own grid, and what injecting the detected timing would unsnap.",
    snap_counts: "{s}/{o} on the grid · {u} off",
    snap_t_time: "Time (ms)", snap_t_kind: "Object", snap_t_div: "Nearest", snap_t_off: "Off (ms)",
    snap_before: "Before the first red line:", snap_past: "Past the end of the audio:",
    snap_inject: "Injecting the detected timing would unsnap {n} object(s) and put {m} back on the grid.",
    snap_inject_none: "Injecting the detected timing would unsnap nothing.",
    snap_no_reds: "This map has no red lines to snap to.",
    snap_unparsed: "{n} line(s) in [HitObjects] could not be read.",
    snap_starts: "Object starts only; slider, spinner and hold ends are not checked.",
    rs_title: "Re-snap objects", rs_pick: "Choose .osu…", rs_apply: "Re-snap…",
    rs_sub: "Move this map's snapped objects onto the detected grid after a timing change. Run it before injecting, while the map still has its old red lines — off-grid objects stay put and are listed.",
    rs_would: "{moved} to move, {changed} times changing, {left} staying",
    rs_left_row: "{t}ms {kind}",
    rs_left_more: "+{n} more staying",
    rs_confirm: "Move {n} objects in {file}? Off-grid objects stay.",
    rs_done: "Moved {n} objects in {file}.",
    rs_clean: "Every snapped object already sits on the detected grid.",
    resnapped: "Re-snapped for this timing already: inject the timing into this file next. Re-snapping again would move these objects twice; History restores the file to start over.",
    ref_title: "Reference timing", ref_pick: "Grade a .osu…", ref_find: "Maps of this song…",
    ref_empty: "Choose any .osu of this song, hand-timed or ranked, to grade each red line against the attacks Overtone hears. Useful where detection is weakest: live bands, rubato, drift.",
    ref_counts: "{ok} ok · {check} to check · {weak} weak · {few} too few",
    ref_t_line: "#", ref_t_offset: "Offset", ref_t_bpm: "BPM", ref_t_div: "Read at", ref_t_share: "On grid",
    ref_t_off: "vs map (ms)", ref_t_drift: "Drift at end (ms)", ref_t_fit: "Fitted BPM", ref_t_verdict: "",
    ref_ok: "ok", ref_check: "check", ref_weak: "weak", ref_too_few: "too few",
    ref_offset: "offset", ref_drift: "drift",
    ref_shift_f: "Every line reads {ms} ms from the attacks, so the table shows each line against that shift. On real songs Overtone has read +12 to +46 ms (median +26) on all 30 ranked maps tested, MP3 and OGG alike, and why is not known yet: check the offset by ear before moving the whole map.",
    ref_split_f: "These {n} lines do not agree on one offset, and no majority decides which ones are right: check them by ear.",
    ref_before_f: "{n} attacks come before the first red line.",
    ref_same: "Same audio as the analyzed file, byte for byte.",
    ref_other: "This map's audio is not the analyzed file byte for byte: offsets may not carry over between two encodes.",
    ref_unknown: "The map's audio file was not found next to it, so it could not be compared.",
    ref_imported: "Timing read from another game's file. Its audio was not checked against this one, so an offset only carries over if both play the same encode.",
    ref_no_reds: "This map has no red lines to grade.",
    ref_no_attacks: "No attacks were found in this song to grade against.",
    ref_hint: "Positive: the music comes after the red line. ± is two standard errors: a line is flagged past 5 ms and past its own ±.",
    ref_load: "Use as working timing",
    ref_load_confirm: "Replace the {n} working timing points with the {m} red lines of {file}? Undo brings them back.",
    ref_loaded: "Loaded {n} red lines from {file}.",
    ref_found: "{n} map(s) share this audio under {root}.",
    ref_found_none: "No map under {root} uses this exact audio ({s} audio files checked).",
    ref_grade: "Grade",
    no_songs: "Choose your osu! Songs folder.",
    ev_title: "Evidence",
    ev_sub: "What the engine read against: coherence candidates per section, the octave margin, residual and coverage. Using one writes its BPM into the governing red line.",
    ev_section: "§{n} · {from}–{to} s · {bpm} BPM · residual {res} ms · coverage {cov} % · {inliers} attacks",
    ev_candidates: "Coherence candidates",
    ev_seeded: "seeded", ev_half: "half", ev_double: "double",
    ev_margin: "octave margin {m}",
    ev_use: "Use", ev_used: "Red line {n} now runs {bpm} BPM.",
    ev_note: "The fallback engine keeps no attacks, so there are no alternatives to show.",
    ev_t_bpm: "BPM", ev_t_coh: "Coherence",
    ramp_title: "Ramps",
    ramp_sub: "The elastic curve as the fewest red lines within the drift. Using them replaces the timing with hand-placed lines; undo brings it back.",
    ramp_drift: "Drift (ms)", ramp_max: "At most N lines", ramp_fit: "Fit", ramp_use: "Use these lines",
    ramp_lines: "{n} red lines within {ms} ms",
    ramp_tradeoff: "Fewer lines cost drift: {rows}.",
    ramp_trade_row: "{drift} ms → {n} lines",
    ramp_recommend: "The curve bends here: ramps fit better than one grid per section.",
    ramp_piecewise: "The sections already read fine: ramps add nothing, so there are no lines to use.",
    ramp_used: "{n} hand-placed red lines.",
    ramp_no_ramps: "Fit first: there are no lines to use yet.",
    ramp_not_recommended: "The sections read better than ramps here: there is nothing to use.",
    ramp_t_at: "Starts", ramp_t_attacks: "Attacks",
    sv_title: "Constant scroll",
    sv_sub: "Greens that cancel this difficulty's BPM changes: one at each red line, and every green after it scaled by the tempo ratio, so the scroll stays constant and the map's own SV changes keep their shape. A slider lasts by its SV, so a map with sliders after a BPM change is refused rather than moved off its beats. Sound, kiai and barlines never move; every file is backed up first.",
    sv_preview: "Preview", sv_apply: "Write greens",
    sv_would: "{added} new, {flipped} rescaled, {kept} already constant at {bpm} BPM into {file}.",
    already_written: "Written here already, and not written twice: History restores the file to start over.",
    scroll_sliders: "{n} sliders start where the scroll would be rescaled, the first at {at}: a slider lasts by its SV, so every end would leave its beat. Nothing is written; normalise this difficulty in the editor, resizing its sliders.",
    sv_confirm: "Write scroll greens at {bpm} BPM into {file}?",
    sv_done: "Scroll constant at {bpm} BPM into {file}.",
    sv_nothing: "Every section already scrolls at {bpm} BPM in {file}.",
    div_title: "Snap divisors",
    div_sub: "Which divisor each section needs, from the song's own attacks. Thirds and sixths past the weight bar read 1/3 and 1/6, the rest 1/4. Read only.",
    div_row: "{at} · {bpm} BPM · {d}{extra}",
    div_extra: " ({t} thirds, {s} sixths)",
    swing_title: "Swing",
    swing_sub: "Where the off-beat eighth falls inside the beat, eight beats at a time: halfway is straight, later is swing. Measured from each window's own beat, so a grid a few ms off changes nothing. Read only — the snap is what you would set in the editor.",
    swing_row: "{from} – {to} · {what} · {at} of the beat{snap} · ratio {ratio} · {late} ms late",
    swing_snap: " ({snap})",
    swing_swing: "swing",
    swing_triplets: "triplets",
    swing_none: "Straight all through: none of the {measured} windows read swung.",
    swing_nothing: "No window had a beat of its own to measure.",
    swing_count: "{n} of {measured} windows swung, in {spans}.",
    swing_span: "1 stretch",
    swing_spans: "{n} stretches",
    ph_title: "Half and double time",
    ph_sub: "A stretch inside one reported section where the song changes pulse. The grid keeps fitting, because every hit of the slow half still lands on the fast half's grid; what changes is how many slots are filled, and whether the filled ones fall on every other beat. Read only — nothing here moves a red line.",
    ph_none: "No section holds a half- or double-time stretch.",
    ph_row_half: "From {at}: section {n} reads {bpm} BPM, but {from} – {to} plays at {reads}. Half-time from there — ÷2 on that section, or a red line at {at}.",
    ph_row_double: "Until {at}: section {n} reads {bpm} BPM, but {from} – {to} plays at {reads}. Double-time up to there — ×2 on that section, or a red line at {at}.",
    ph_why: "{thinned} of {windows} windows, on the beat split in {sub}: {cin} % of the slots filled against {cout} % elsewhere, and {pin} % of the weight on every other one against {pout} %.",
    lg_pulse: "half/double",
    lab_title: "Offset lab",
    lab_sub: "What the file says about its own delay, and the first attack through each decoder side by side.",
    lab_header: "{encoder}: {delay} samples of delay ({delayMs} ms), {pad} of padding ({padMs} ms).",
    lab_no_tag: "No gapless tag: this file does not state its delay.",
    lab_compare: "Compare decoders",
    lab_decoders: "First attack: Python {py} ms, Rust {rust} ms, {delta} ms apart.",
    lab_test_title: "Blind test",
    lab_test_sub: "Hear the same passage twice with two hidden click shifts and pick the one in time. Each shift runs against no shift, three times each.",
    lab_start: "Start", lab_hear1: "Hear 1", lab_hear2: "Hear 2",
    lab_vote1: "1 was in time", lab_vote2: "2 was in time", lab_cancel: "Cancel",
    lab_rate: "Set speed to 100% for the test.",
    lab_trial: "Trial {k} of {n}",
    lab_t_shift: "Shift", lab_t_wins: "Wins", lab_t_interval: "95% interval",
    lab_best: "Preferred: {shift} ms ({lo}–{hi} % preferred over no shift).",
    lab_none: "Nothing beats no shift: the click sits where it is.",
    as_title: "Assisted timing",
    as_sub: "Where detection is wrong, mark two downbeats: the grid is fitted from there, or refused with the reason.",
    as_first: "First downbeat (ms)", as_second: "A later downbeat (ms)", as_bars: "Bars between", as_meter: "Beats per bar",
    as_fit: "Fit", as_add: "Add to timing",
    as_facts: "<b>{bpm}</b> BPM · red line at <b>{offset}</b> ms · holds <b>{from}–{to}</b> s ({bars} bars) · read at 1/{div} · {share}% on grid",
    as_moved: "Your marks moved {a} and {b} ms onto the attacks.",
    as_short: "The grid held only {bars} bars: its BPM can be tenths off. Mark downbeats further apart, or check by ear.",
    as_add_hint: "Adds one hand-placed red line; detected lines inside {from}–{to} s are replaced, except near its end, where a line is most likely the change that ended it. Undo brings them back.",
    as_added: "Added {bpm} BPM at {offset} ms.",
    as_bad_marks: "Enter two downbeats, the second after the first, and whole numbers of bars and beats.",
    as_bpm_range: "Those marks make {bpm} BPM, outside 40–400: check the bars between them.",
    as_too_few: "Only {n} attacks around the marks: mark downbeats where the music plays.",
    as_weak: "The attacks do not follow that grid ({share} on it): check the marks and the bars between them.",
    as_chance: "Random attacks would fit that grid as well: there is no grid here to time.",
    as_no_attacks: "No attacks were found in this song.",
    no_fit: "Fit a grid first.",
    settings_sub: "Saved on this PC as you change them.",
    st_output: "Exports", st_folder: "Output folder", st_folder_default: "Use the default", st_folder_pick: "Choose folder…",
    st_folder_is_default: "{path} (the default)",
    st_ask: "Ask where to save each export (the dialog opens in the song's folder)",
    st_decimals: "Offset precision",
    st_decimals_hint: "osu!stable reads whole milliseconds; osu!lazer keeps decimals. Used by copy, .osz and inject.",
    st_click: "Click", st_sub: "Clicks per beat",
    st_sub_hint: "Extra soft clicks between beats, in the app and in the exported click track.",
    st_accent: "Accent the first beat of each bar",
    st_look: "Appearance", st_scale: "Interface size", st_motion: "Reduce motion",
    st_detect: "Detection and engine",
    st_detect_hint: "Change detection, pulse and the Rust engine in the panel the toolbar opens too.",
    st_detect_open: "Detection settings…",
    st_storage: "Cache and backups", st_cache: "Result cache", st_cache_clear: "Clear cache",
    st_cache_info: "{n} analyses · {mb} MB (keeps the latest {max}) · {path}",
    st_cache_cleared: "Cache cleared: each song is analysed again next time.",
    st_backups: "Backups: before any .osu is written, the bytes it replaces are kept beside it. The first is map.osu.bak and is never touched again; later ones are .bak2, .bak3…, so every earlier state survives.",
    nav_audio: "Audio",
    nav_report: "Report",
    audio_sub: "What started, not just that something did: the onset flux split into seven bands, from the kick's 40 Hz up to 11 kHz. A kick moves the bottom lane, a hat the top, a broadband click all seven. Read only.",
    spec_title: "Spectrogram",
    spec_note: "{rows} mel bands to 11 kHz over {span}, {cols} columns. Each column keeps the loudest frame under it, and {floor} dB under this song’s loudest moment is black.",
    spec_reading: "Reading the song’s spectrum…",
    audio_busy: "The song is busy with another job. Open Audio again in a moment.",
    band_title: "Onset bands",
    band_note: "{n} columns over {span}, loudest {db} dB of flux. Every lane is drawn against that one peak, so a quiet band looks quiet.",
    band_reading: "Reading the song’s bands…",
    band_none: "No flux to show for this song.",
    report_sub: "Every finding about one difficulty as osu! editor timestamps, ready to paste into a mod post. A timestamp opens the editor there. Read only: nothing is written.",
    rp_title: "Mod report", rp_pick: "Choose .osu…", rp_copy: "Copy all",
    rp_empty: "Choose the .osu of a difficulty to gather every finding about it: red lines to check, red lines it is missing, unsnapped objects, objects away from the music and hitsounds breaking the map's own pattern.",
    rp_counts: "{n} findings", rp_none: "Nothing to report on this difficulty.",
    rp_src_reference: "Red lines", rp_src_suggestion: "Missing red lines", rp_src_snap: "Snapping", rp_src_alignment: "Away from the music", rp_src_hitsound: "Hitsounds",
    rp_hint: "The lines are in English, as mod posts are. Untick a group to leave it out of the copy.",
    rp_copied: "Report copied: paste it into your mod post.",
    rp_open: "Open in the osu! editor",
    bad_stamp: "That is not an editor timestamp.",
    no_osu: "osu! did not open — is it installed? ({detail})",
    pb_play: "Play / pause (Space)", pb_from_line: "From red line", pb_seek: "Position",
    pb_click: "Click", pb_perc: "Percussion only", pb_loop: "Loop section", pb_song: "Song", pb_click_vol: "Click",
    pb_hint: "Space plays and pauses · double-click the tempo map to play from there · stopped, the seek bar and the arrow keys sound where they land · the click follows your edits · ? lists every key",
    keys_title: "Keyboard", kb_space: "Space", kb_shift: "Shift", kb_enter: "Enter",
    key_play: "Play / pause", key_seek: "Back / forward 1 s (stopped: heard there)", key_seek_fine: "Back / forward 10 ms (stopped: heard there)",
    key_lines: "Previous / next red line: select it, the playhead on it",
    key_points: "Previous / next timing point (Timing)", key_loop: "Loop on / off", key_click: "Click on / off",
    key_tap: "Tap along with the click", key_views: "The menu's sections, in order",
    key_open: "Open audio", key_analyze: "Analyze", key_undo: "Undo", key_redo: "Redo",
    key_sheet: "This sheet", key_close: "Close a panel or this sheet",
    key_toggled: "{what}: {state}", key_state_on: "on", key_state_off: "off",
    pb_loading: "Loading the song… {n}/{of}",
    pb_perc_preparing: "Separating the drums…",
    pb_perc_on: "Percussion only: the drums against the click. Untick to hear the full song.",
    pb_failed: "The song could not be played: {detail}",
    no_audio_staged: "The song is not loaded; press play again.",
    pb_rate: "Speed: slower lowers the pitch, so every attack stays exactly in place",
    lane_wave: "wave", lane_swing: "swing", lg_swing: "swing",
    tl_zoom: "{a} – {b}", tl_fit: "Show all", lg_drift: "drift", lg_conf: "confidence",
    tap_btn: "Tap (T)", tap_calibrate: "Calibrate to these taps", tap_assist: "Use for assisted timing", tap_clear: "Clear",
    tap_hint: "Play, then tap T on each beat: to check the timing by ear, to calibrate your taps (tap to the click alone), or to seed assisted timing (start on a downbeat).",
    tap_info: "{n} taps · {bpm} BPM · {where}",
    tap_after: "you tap {ms} ms after the click (± {sd})",
    tap_before: "you tap {ms} ms before the click (± {sd})",
    tap_play_first: "Play the song first, then tap along.",
    tap_calibrated: "Calibrated: your taps are taken {ms} ms earlier from now on.",
    tap_assist_need: "Tap at least {n} beats in a row, starting on a downbeat.",
    bad_latency: "Those taps are too far from the click to be latency.",
    import_folder: "Import beatmap folder…",
    imported: "Folder: {audio} + {n} {difficulties}.",
    difficulties: "difficulties",
    no_audio: "That folder has no audio Overtone can read — its maps are still listed for compare.",
    bad_folder: "Choose a real folder first.",
    done: "Done: {n} timing points · {bpm} BPM", rescaled: "Pulse ×{f}: {n} timing points · {bpm} BPM",
    error: "Error: {detail}",
  },
  es: {
    tagline: "Timing para mapas de osu!", nav_timing: "Timing", offline: "sin conexión, nada sale de esta PC",
    nav_sections: "Secciones", nav_library: "Biblioteca", nav_mapcheck: "Revisar mapa", nav_export:
    "Exportar", nav_history: "Historial", nav_settings: "Ajustes",
    close: "Cerrar",
    need_title: "Todavía no hay nada analizado",
    need_body: "{view} trabaja sobre la canción analizada, la misma que comparten todas las secciones. Abrí un audio y analizalo.",
    need_busy: "Analizando… {view} se completa apenas termine.",
    need_analyze: "Analizar {name}", need_library: "Ir a la Biblioteca",
    mapcheck_sub: "Una dificultad que mapeaste, contrastada con este análisis. Solo lectura: no se escribe nada.",
    export_sub: "Todo lo de acá escribe los timing points actuales, ediciones incluidas.",
    exp_osu_t: "Timing points de osu!", exp_osu_d: "Las líneas rojas como texto de [TimingPoints], listas para pegar en un .osu.",
    exp_qua_t: "Timing points de Quaver",
    exp_qua_d: "Las líneas rojas como un bloque TimingPoints de .qua. Escrito según el formato documentado: acá no lo abrió ningún juego, así que revisalo una vez en el editor.",
    exp_sm_t: "Timing de StepMania",
    exp_sm_d: "#OFFSET y #BPMS para un .sm o .ssc. StepMania cuenta desde el beat 0 y dice dónde cae, por eso el offset es negativo. Mismo aviso: acá no lo abrió ningún juego.",
    exp_game_ok: "Releído: {lines} línea(s), cada beat a menos de {ms} ms del timing de arriba.",
    exp_game_off: "Releído: las {lines} línea(s) no volvieron como se escribieron; no uses este texto.",
    actions_copy_qua: "Copiar .qua", actions_copy_sm: "Copiar #BPMS",
    exp_csv_t: "Tabla CSV", exp_csv_d: "Offset, BPM, beat y confianza por punto, para una planilla.",
    exp_click_t: "Pista de clic", exp_click_d: "Un WAV de metrónomo sobre estas líneas rojas, para oír si derivan contra la canción.",
    exp_osz_t: "Paquete .osz", exp_osz_d: "El audio más un beatmap nuevo con este timing.",
    exp_inject_t: "Inyectar en un .osu", exp_inject_d: "Reemplaza las líneas rojas de una dificultad que ya tenés. Confirmás antes y se guarda un respaldo.",
    exp_inject_all_t: "Inyectar en todas las dificultades", exp_inject_all_d: "Reemplaza las líneas rojas de cada .osu junto a la canción analizada. Una vista previa, una confirmación, cada archivo respaldado antes.",
    exp_inject_all_preview: "Vista previa", actions_inject_all: "Inyectar todas…",
    inject_all_row: "{file}: {replaced} reemplazadas, {added} nuevas",
    inject_all_row_drift: ", deriva {d}ms",
    inject_all_row_greens: ", +{g} verdes",
    inject_all_row_mismatch: " (el audio difiere)",
    inject_all_error: "{file}: {detail}",
    inject_all_confirm: "¿Reemplazar las líneas rojas de {n} dificultades ({files})? Cada archivo se respalda antes.{warn}",
    inject_all_warn: " Algunos .osu nombran otro audio.",
    inject_all_done: "Inyectadas {n} dificultades, {f} salteadas.",
    inject_all_nothing: "No hay dificultades para inyectar.",
    hist_sub: "Cada escritura .osu que hizo esta app, la más nueva primero, con el respaldo que guarda lo reemplazado. Restaurar guarda el archivo actual como respaldo nuevo antes.",
    hist_title: "Escrituras", hist_empty: "Nada escrito todavía.",
    hist_t_when: "Cuándo", hist_t_what: "Qué", hist_t_file: "Archivo", hist_t_backup: "Respaldo",
    hist_diff: "Diff", hist_restore: "Restaurar", hist_count: "{n} escrituras",
    hist_op_inject: "timing", hist_op_hitsounds: "hitsounds", hist_op_write: "escritura", hist_op_restore: "restauración", hist_op_swap: "cambio de audio",
    hist_op_resnap: "reajuste", hist_op_bookmarks: "bookmarks", hist_op_kiai: "kiai", hist_op_breaks: "breaks",
    hist_op_scroll: "scroll constante", hist_op_volumes: "volúmenes por sección", hist_op_hsdiff: "dificultad de hitsounds",
    hist_op_suggestion: "línea roja sugerida",
    hsd_title: "Dificultad de hitsounds",
    hsd_sub: "Una dificultad nueva junto a las demás, con un círculo en cada sonido del mapset que lo toca exacto: hitsoundeá en un solo lugar y después copiala a todas (Mapset, Copiar hitsounds). Donde dos dificultades suenan juntas gana la fuente; el timing, los eventos y los ajustes son los de la fuente.",
    hsd_source: "Sonidos de", hsd_fill: "Completar con los sonidos de las demás dificultades donde la fuente no tiene",
    hsd_preview: "Vista previa", hsd_write: "Escribir la dificultad",
    hsd_would: "{dest}: {n} círculos, {src} de {name} y {others} de las demás dificultades ({merged} sonidos compartidos a menos de 5 ms).",
    hsd_exact: "Cada círculo toca su sonido exacto.",
    hsd_stacked: "{n} sonidos de la fuente comparten su instante con otro distinto (un acorde, objetos apilados): el círculo se queda con el primero (el primero en {time}).",
    hsd_inexact: "{n} círculos no pueden sonar exacto: ahí el formato solo puede heredar un índice 0, y las líneas verdes de la fuente dan otro (el primero en {time}).",
    hsd_confirm: "¿Escribir {dest} junto a la canción? Es un archivo nuevo: no se reemplaza nada.",
    hsd_done: "{dest} escrito: {n} círculos.",
    hsd_exists: "{dest} ya está junto a la canción: borralo o renombralo para escribir uno nuevo.",
    hist_added: "+{n} líneas rojas", hist_removed: "−{n} líneas rojas", hist_changed: "~{n} líneas rojas movidas",
    hist_no_change: "mismas líneas rojas",
    hist_confirm: "¿Restaurar {file} desde {backup}? El archivo actual se guarda como respaldo nuevo antes.",
    hist_restored: "{file} restaurado.",
    hist_summary_hitsounds: "{n} objetos", hist_summary_inject: "{n} líneas rojas",
    nav_mapset: "Mapset",
    mapset_sub: "Todas las dificultades de una carpeta, lado a lado: líneas rojas, ajustes de audio y metadatos que deben coincidir. La comparación solo lista diferencias; Copiar hitsounds escribe, después de una vista previa y con respaldos.",
    ms_title: "Dificultades", ms_pick: "Elegir carpeta…", ms_recheck: "Revisar de nuevo",
    ms_empty: "Elegí una carpeta de beatmap, o importala en la Biblioteca, para comparar sus dificultades.",
    ms_no_maps: "Esa carpeta no tiene archivos .osu.",
    ms_count: "{n} dificultades", ms_all_match: "todo coincide", ms_to_check: "{n} para revisar", ms_unreadable_n: "{n} ilegibles",
    ms_t_diff: "Dificultad", ms_t_reds: "Líneas rojas", ms_t_audio: "Audio", ms_t_meta: "Metadatos", ms_t_kiai: "Kiai",
    ms_t_objects: "Objetos", ms_t_rate: "Por segundo (media · pico)",
    ms_reference: "referencia", ms_match: "igual", ms_differ: "{n} difieren",
    ms_unreadable: "No se pudo leer este archivo: {detail}",
    ms_kiai_none: "ninguno", ms_kiai_end: "fin",
    ms_density_note: "Objetos por segundo en ventanas de 5 s, para comparar dificultades entre sí. No es un star rating.",
    ms_red_title: "Líneas rojas",
    ms_red_ref: "Comparadas con {ref}, la dificultad con la que más coinciden las demás.",
    ms_red_same: "Todas las dificultades tienen las mismas líneas rojas.",
    ms_t_offset: "Offset (ms)", ms_t_what: "Qué difiere",
    ms_d_offset: "Movida a {found} ms; la referencia la tiene en {expected} ms.",
    ms_d_beat_length: "Beat de {found} ms en vez de {expected} ms.",
    ms_d_meter: "Compás {found}/4 en vez de {expected}/4.",
    ms_d_missing: "Falta: la referencia tiene una línea roja acá.",
    ms_d_extra: "Sobra: la referencia no tiene una línea roja acá.",
    ms_fields_title: "Audio y metadatos",
    ms_fields_hint: "Cada campo muestra el valor que tiene la mayoría de las dificultades.",
    ms_t_field: "Campo", ms_t_value: "Valor", ms_t_differs: "Distinto en",
    ms_same_all: "igual en todas", ms_not_set: "(sin definir)", ms_empty_value: "(vacío)",
    open: "Abrir audio", analyze: "Analizar", analyzing: "Analizando…",
    empty_title: "Timea una canción con un clic",
    empty_body: "Abre un audio y Overtone encuentra cada cambio de BPM, offset y línea de compás.",
    stat_global: "BPM global", stat_points: "Timing points", stat_beats: "Beats", stat_stability: "Estabilidad", stat_engine: "Motor",
    trace_title: "Mapa de tempo", trace_sub: "Rueda para acercar · arrastrá para desplazarte · arrastrá una línea roja para moverla (se imanta a un ataque; con Alt, libre) · clic elige, doble clic reproduce · Mayús+arrastre marca un bucle en los pulsos (con Alt, donde sea), Mayús+clic lo quita",
    pb_loop_drawn: "Bucle {a} – {b}", loop_set: "Bucle {a} – {b}: {n} pulsos", loop_set_free: "Bucle {a} – {b}: {s} s", loop_cleared: "Bucle quitado: «Repetir sección» vuelve a seguir al cabezal",
    no_song: "Ninguna canción abierta", no_song_hint: "Abrí un archivo de audio para empezar", analyze_last: "Analizar la última canción",
    k_open: "abrir", k_analyze: "analizar", table_hint: "↑ ↓ para moverte", f_preset: "Preajuste",
    d_song: "Canción", d_point: "Timing point", d_offset: "Offset", d_beat: "Duración del beat", d_meter: "Compás",
    d_conf: "Confianza", d_span: "Gobierna", d_until: "hasta {t}", d_end: "hasta el final", d_bars: "{n} compases",
    d_duration: "Duración", d_first: "Primer beat", d_engine: "Motor", d_residual: "Residuo de la rejilla",
    d_pulse: "Pulso", d_sections: "Secciones de rejilla", d_hint: "Elegí un timing point en la lista o en el mapa de tempo para inspeccionarlo.",
    d_timing: "Análisis", d_timing_cached: "desde la caché, {s} s",
    project_offer: "Trabajaste el timing de esta canción el {when}: {n} líneas rojas. Este análisis no tiene ese trabajo.",
    project_offer_locks: "Trabajaste el timing de esta canción el {when}: {n} líneas rojas ({locks} con candado). Este análisis no tiene ese trabajo.",
    project_restore: "Restaurar mi trabajo", project_keep: "Quedarme con el análisis",
    project_restored: "Tu trabajo volvió: {n} líneas rojas. Deshacer vuelve al análisis.",
    stop: "Detener", stopping: "Deteniendo", stop_hint: "Detiene el análisis donde esté, sin esperar a que termine la etapa; el resultado en pantalla se queda",
    analysis_stopped: "Análisis detenido a los {s} s", analysis_stopped_kept: "Análisis detenido a los {s} s — el resultado en pantalla se queda",
    stage_load: "Audio", stage_attacks: "Ataques", stage_coherence: "Barrido del pulso", stage_octave: "Octava",
    stage_sections: "Secciones", stage_fallback: "Rastreador de pulsos", stage_transients: "Transitorios",
    stage_tracking: "Pulsos", stage_pulse: "Mitad/doble tiempo", stage_local: "Tempo local", stage_rust: "Motor Rust",
    d_meter_known: "Compás hallado en los acentos: esta línea roja cae en un downbeat.",
    d_meter_guess: "Sin evidencia de compás: la línea roja cae en un beat y el compás es el valor por defecto.",
    lg_tempo: "tempo", lg_points: "timing points", lg_onsets: "ataques", lg_ghost: "líneas del mapa",
    table_title: "Timing points", col_offset: "Offset (ms)", col_beat: "Beat (ms)", col_meter: "Compás", col_conf: "Confianza",
    detection: "Ajustes de detección", preset_variable: "Tempo variable", preset_steady: "Estable",
    f_delta: "Cambio mínimo (BPM)", f_persist: "Beats de confirmación", f_conf: "Confianza mínima (%)", f_pulse: "Pulso (octava)", auto: "Auto",
    t_prefer: "Preferir BPM de mapa (120–300)", t_refine: "Re-anclar beats a transitorios",
    t_rust: "Motor Rust (más rápido, mismos resultados)",
    t_rust_note: "Corre al pulso propio de la rejilla. Donde no encuentra rejilla, el motor Python toma el relevo y lo avisa.",
    t_rust_missing: "El motor Rust no está compilado en esta máquina (cargo build --release -p overtone-cli).",
    warn_rust_fallback: "Analizado con el motor Python: {why}.",
    backend_rust: "Rust", backend_python: "Python",
    inspector_note: "Se aplican en el próximo análisis. Compartidos con la ventana clásica.",
    songopt_applied: "Volvieron los ajustes propios de esta canción: {what}.",
    songopt_note: "Estos son los ajustes propios de esta canción, de su último análisis: {what}.",
    songopt_back: "Usar los anteriores", songopt_reverted: "Volviste a los ajustes que tenías antes.",
    songopt_custom: "{d} BPM · {p} pulsos · {c} %", songopt_pulse: "pulso {p}",
    songopt_no_prefer: "sin preferencia de BPM", songopt_no_refine: "sin reanclar",
    conf_live_same: "Con {v} %: las mismas líneas rojas que ahora ({lines}).",
    conf_live_diff: "Con {v} %: {lines}, contra {now} ahora. En el mapa, punteadas: las que agregaría; tenues: las que quitaría.",
    conf_apply: "Aplicar a este análisis",
    conf_applied: "Ahora con {v} %: {lines}. Deshacer vuelve a las de antes.",
    conf_line: "1 línea roja", conf_lines: "{n} líneas rojas",
    engine_precision: "rejilla de precisión", engine_legacy: "tracker de respaldo",
    constant: "constante", variable: "variable", points_n: "{n} puntos", meter_known: "compás hallado", meter_guess: "compás supuesto",
    time_at: "tiempo", tempo_at: "tempo", line_at: "línea roja", conf_at: "confianza",
    before_first: "antes de la primera línea roja: su grilla se extiende hacia atrás",
    warn_legacy: "No se pudo ajustar una rejilla estable; este resultado viene del tracker de respaldo. Revisalo de oído antes de mapear.",
    warn_loose: "La rejilla ajusta con holgura (residuo {ms} ms). El tempo puede derivar; escuchá la pista de clic.",
    v_dup_points: "Dos líneas rojas a {gap} ms — una es un duplicado.",
    v_short_section: "La sección #{n} dura {beats} beats, menos de un compás. Revisala de oído.",
    v_impossible_change: "El tempo salta de {from} a {to} BPM — eso es un error de detección, no música.",
    v_octave_check: "La sección #{n} pasa de {from} a {to} BPM: ¿half-time o error de octava? Lo decidís vos.",
    v_negative_offset: "El punto #{n} está en {ms} ms — antes de que empiece el audio.",
    v_bad_number: "El punto #{n} no tiene un número usable — re-analizá o borralo.",
    v_late_first: "La primera línea roja está en {line} s pero la música empieza en {beat} s. Todo lo anterior hereda ese timing — revisá la intro.",
    v_past_end: "El punto #{n} está en {ms} ms — después del final del audio.",
    bad_file: "Elegí primero un archivo de audio existente.", bad_values: "Revisá los valores de detección.",
    bad_drop: "No se pudo leer lo soltado como audio.", too_big: "Ese archivo supera los 64 MB — no es el audio de un beatmap.",
    busy: "Ya hay un análisis en curso.", first: "Analizá una canción primero.", no_grid: "No hay rejilla guardada — analizá de nuevo.",
    no_selection: "Elegí primero un timing point.",
    lock: "Bloquear", unlock: "Desbloquear", locked_pill: "bloqueado",
    locked_note: "Bloqueado: la edición lo saltea y el re-análisis lo conserva.",
    locked_on: "Punto #{n} bloqueado.", locked_off: "Punto #{n} desbloqueado.",
    point_locked: "El punto #{n} está bloqueado — desbloquealo primero.",
    undo: "Deshacer", redo: "Rehacer",
    no_undo: "Nada que deshacer.", no_redo: "Nada que rehacer.",
    undone: "Deshecho.", redone: "Rehecho.",
    actions_copy: "Copiar .osu", actions_csv: "Guardar CSV…", actions_click: "Guardar pista de clic…", actions_osz: "Guardar .osz…", actions_inject: "Inyectar .osu…",
    e_offset: "Offset (ms)", e_bpm: "BPM", e_apply: "Aplicar", e_add: "Añadir", e_delete: "Borrar",
    edited: "Punto #{n}: {bpm} BPM · {ms} ms", added: "Añadido {bpm} BPM en {ms} ms", deleted: "Borrado el punto #{n}",
    section_rescaled: "Sección #{n}: {bpm} BPM",
    e_split: "Dividir en el cabezal", e_merge: "Unir con la siguiente",
    e_meter: "Pulsos por compás", e_meter_hint: "El largo del compás desde esta línea roja hasta la siguiente; el pulso no cambia",
    meter_set: "Punto #{n}: {m}/4, el pulso igual",
    e_split_hint: "Una línea roja en el pulso de esta sección más cercano al cabezal; las dos mitades se reajustan a sus ataques",
    e_merge_hint: "Quita la línea roja siguiente y reajusta todo el tramo desde esta",
    split_outside: "Primero poné el cabezal dentro de esta sección",
    split_done: "Dividida en {time} — antes: {first} · después: {second}",
    merged_done: "Unidas — {first}",
    refit_bpm: "{bpm} BPM, {share}% en la grilla", refit_kept_few: "{bpm} BPM sin cambios: pocos ataques",
    refit_kept_weak: "{bpm} BPM sin cambios: solo {share}% en la grilla",
    copied: "Timing points copiados — pegalos en el [TimingPoints] del .osu.",
    clipboard_failed: "No se pudo llegar al portapapeles: {detail}",
    saved_to: "Guardado en {path}",
    osz_named_map: "con el nombre {artist} - {title}, como lo nombran los mapas de la canción",
    osz_named_tags: "con el nombre {artist} - {title}, de las etiquetas del audio",
    injected: "Inyectadas {added} líneas rojas ({replaced} reemplazadas, {greens} verdes intactas).",
    inject_confirm: "¿Reemplazar {reds} líneas rojas por {n} nuevas en {file}?{warn}",
    inject_diff_line: "{o}ms {ob} → {n}ms {nb}",
    inject_diff_drift: " (deriva {d}ms)",
    inject_diff_more: "+{n} líneas cambiadas más",
    inject_diff_same: "{n} líneas iguales",
    inject_greens: "\nTambién agrega {g} líneas verdes para que la velocidad de sliders y los hitsounds suenen igual.",
    inject_warn: "\nEl audio del .osu ({osu}) difiere del analizado ({src}).",
    drop_title: "Soltá el audio", drop_body: "Soltá para timearlo con los ajustes actuales.",
    recent: "Recientes",
    nav_hitsounds: "Hitsounds",
    hsv_sub: "Lo que suena en una dificultad: dónde caen sus adiciones en el compás, cada sonido para escucharlos uno por uno, y las propuestas del motor para escribirlas o no.",
    hsv_map: "Dificultad", hsv_none: "Ninguna dificultad junto a esta canción usa su audio.",
    hsv_sounds_n: "Sonidos", hsv_sets: "Sample sets", hsv_samples: "Samples",
    hsv_samples_v: "{map} del mapa · {own} de Overtone",
    hsv_where_title: "Dónde caen las adiciones",
    hsv_where_note: "Proporción de cada adición en cada semicorchea de un compás de {meter}/4, leída contra las líneas rojas del propio mapa.",
    hsv_top: "{pct} % en {slots}", hsv_none_add: "ninguna",
    hsv_between: "{n} entre semicorcheas (tresillos y similares)", hsv_other_meter: "{n} bajo otro compás",
    hsv_sounds: "Sonidos", hsv_all: "Todos", hsv_count: "{n} sonidos",
    hsv_t_time: "Tiempo", hsv_t_place: "Compás · tiempo", hsv_t_part: "Parte", hsv_t_sounds: "Sonidos",
    hsv_t_sets: "Sets", hsv_t_index: "Índice", hsv_t_volume: "Volumen",
    hsv_play: "Escuchar este sonido", hsv_more: "Mostrar {n} más",
    hsv_play_proposal: "Escuchar este sonido como quedaría escrito",
    hsv_decide_title: "Proponer y editar hitsounds",
    hsv_decide_sub: "El motor propone el sonido de cada objeto; el volumen y el índice de sample los ponés vos. Tildá lo que queda, escuchalo sobre la canción, previsualizá, y escribí el archivo o una copia. Cada escritura se respalda, y un deshacer lo restaura.",
    hsv_propose: "Proponer", hsv_proposing: "Decidiendo cada sonido…",
    hsv_propose_all: "Todas las dificultades",
    hsv_all_done: "{n} dificultades decididas con una sola lectura de la canción.",
    hsv_all_one: "1 dificultad decidida.",
    hsv_all_some: "{n} de {of} dificultades decididas; {bad} no se pudieron leer.",
    hsv_all_some_one: "{n} de {of} dificultades decididas; 1 no se pudo leer.",
    hsv_profile: "Perfil", hsv_prof_balanced: "Equilibrado",
    hsv_prof_balanced_note: "Equilibrado, el de siempre: cada instrumento que se oye puede llevar su sonido, ubicado según el pulso.",
    hsv_prof_drum_focused: "Centrado en la batería",
    hsv_prof_drum_focused_note: "Centrado en la batería: bombo, caja, hi-hats y platillos eligen los sonidos; la voz y la melodía solo mantienen el sonido liso; un finish tiende a caer donde empieza un combo.",
    hsv_prof_again: "Las propuestas que ves se decidieron con {used}: tocá Proponer para decidir con {chosen}.",
    bad_profile: "Ese perfil de hitsounds no está en la carpeta de perfiles.",
    hsv_proposed: "{n} propuestas", hsv_decide_all: "Todas", hsv_decide_none: "Ninguna",
    hsv_preview: "Vista previa", hsv_would_change: "{what}: {n} objetos cambiarían",
    hsv_what_ticked: "{accepted} de {units} propuestas tildadas", hsv_edited: "{n} objetos editados", hsv_and: " y ",
    hsv_what_ticked_alt: "{accepted} de {units} propuestas tildadas, {chosen} de ellas una alternativa",
    hsv_alts: "{n} alternativas", hsv_alt_aria: "La propuesta o una de sus alternativas",
    hsv_alt_note: "En la tabla, cada propuesta se puede cambiar por una de sus alternativas. Los porcentajes dicen qué tan probable es cada sonido ahí por sí solo, entre los 24 que pesa el motor, y por eso son bajos. La propuesta es la que mejor encaja en toda la secuencia, así que una alternativa puede puntuar más sola.",
    hsv_why_proposed: "Propuesto", hsv_why_behind: "detrás:", hsv_why_heard: "Se oyó", hsv_why_terms: "Por qué",
    hsv_why_sum: "Su puntaje acá", hsv_why_close: "Cerrar",
    hsv_why_silence: "No se oyó nada debajo: el audio y su lugar en el compás no dicen nada acá.",
    hsv_why_tail: "Una cola de slider toma el sonido del objeto que cae debajo.",
    hsv_why_tail_bare: "Ningún objeto cae debajo de esta cola, así que queda sin adiciones.",
    hsv_why_note: "La propuesta es el mejor camino por todo el mapa, no el mejor puntaje acá solo: estos son sus términos en este sonido, sumados.",
    hsv_term_affinity: "el instrumento oído", hsv_term_role: "su lugar en el compás", hsv_term_context: "un combo nuevo",
    hsv_term_prior: "lo que el mapa ya suena", hsv_term_transition: "el sonido anterior",
    hsv_div_1: "en un tiempo", hsv_div_2: "en una corchea", hsv_div_3: "en un tresillo", hsv_div_4: "en una semicorchea",
    hsv_div_6: "en un seisillo", hsv_div_8: "en una fusa", hsv_div_none: "fuera de toda grilla",
    hs_class_kick: "bombo", hs_class_snare: "caja", hs_class_clap: "palmas", hs_class_hat_closed: "hi-hat cerrado",
    hs_class_hat_open: "hi-hat abierto", hs_class_tom: "tom", hs_class_cymbal: "platillo", hs_class_ride: "ride",
    hs_class_bass: "bajo", hs_class_guitar: "guitarra", hs_class_keys: "teclado", hs_class_vocal: "voz", hs_class_other: "otro",
    hsv_hear: "Escuchar antes de escribir",
    hsv_hearing: "El transporte toca el archivo como quedaría escrito ({what}): {n} sonidos distintos del archivo, el primero en {time}. Cambiá sus hitsounds a {name} para comparar.",
    hsv_hearing_same: "El transporte toca el archivo como quedaría escrito ({what}), y cada sonido suena como ya suena en el archivo.",
    hsv_edit_volume: "Volumen (%)", hsv_edit_index: "Índice de sample",
    hsv_edit_set: "Poner en los sonidos mostrados", hsv_edit_clear: "Quitar sus ediciones",
    hsv_edit_note: "0 sigue a la línea verde. Un slider tiene un solo volumen y un solo índice para todos sus bordes. Todas, Ninguna, Poner y Quitar actúan sobre los sonidos que muestra la tabla: su filtro y sus compases.",
    hsv_edit_empty: "Escribí primero un volumen o un índice de sample.",
    hsv_edit_bad: "El volumen va de 0 a 100 y el índice de sample de 0 para arriba, en números enteros.",
    hsv_line: "el de la línea", hsv_bars: "Compases", hsv_bar_from: "Desde el compás", hsv_bar_to: "Hasta el compás",
    hsv_write: "Escribir en este archivo", hsv_write_copy: "Escribir una copia",
    hsv_undo: "Deshacer", hsv_confirm_write: "¿Escribir hitsounds nuevos en {n} objetos de {file}? Solo cambian los campos de hitsound, y el archivo se respalda antes.",
    hsv_confirm_copy: "¿Escribir hitsounds nuevos en {n} objetos, en una copia junto a {file}? El original queda intacto.",
    hsv_done: "Hitsounds nuevos en {n} objetos, escritos en {file}.",
    hsv_done_copy: "Hitsounds nuevos en {n} objetos, escritos en {file}. El original queda intacto.",
    hsv_undone: "{file} restaurado a antes de la escritura.",
    hsv_no_rust: "Las propuestas usan el motor Rust (overtone-cli), y acá no está compilado: cargo build --release -p overtone-cli.",
    hsv_no_proposal: "Proponé o editá primero: no hay nada que previsualizar o escribir todavía.",
    hsv_t_proposal: "Propuesta",
    part_circle: "círculo", part_head: "cabeza de slider", part_repeat: "repetición de slider", part_tail: "cola de slider",
    part_spinner_end: "fin de spinner", part_hold: "hold",
    lane_objects: "objetos", lg_whistle: "whistle", lg_finish: "finish", lg_clap: "clap",
    g_v_short_section: "{count} secciones duran menos de un compás. Revisalas de oído.",
    g_v_octave_check: "{count} secciones cambian el tempo una octava: ¿half-time o errores de octava? Lo decidís vos.",
    g_v_dup_points: "{count} líneas rojas son duplicados, a pocos ms de otra.",
    g_v_impossible_change: "{count} saltos de tempo son errores de detección, no música.",
    g_v_negative_offset: "{count} puntos están antes de que empiece el audio.",
    g_v_past_end: "{count} puntos están después del final del audio.",
    g_v_bad_number: "{count} puntos no tienen un número usable: re-analizá o borralos.",
    warn_show: "Verlas", warn_hide: "Ocultar", warn_beats: "{beats} beats",
    warn_more: "{n} avisos más", warn_fewer: "Mostrar menos avisos",
    pb_hs: "Hitsounds de", pb_hs_off: "Apagados", pb_hs_vol: "Hitsounds",
    pb_hs_loading: "Cargando los hitsounds de {name}…",
    pb_hs_proposal: "{name}, como quedaría escrita",
    pb_hs_ready: "Hitsounds de {name}: {n} sonidos y {bodies} slides de slider; {map} con samples propios del mapa, {own} con los de Overtone.",
    pb_hs_unreadable: "{n} sample(s) que esta ventana no puede decodificar quedan en silencio.",
    pb_hs_ready_skin: "Hitsounds de {name}: {n} sonidos y {bodies} slides de slider; {map} con samples propios del mapa, {skin} con los del skin, {own} con los de Overtone.",
    pb_hs_empty: "{n} sample(s) sin audio silencian su sonido.",
    hsv_samples_v_skin: "{map} del mapa · {skin} del skin · {own} de Overtone",
    sb_title: "Samples",
    sb_sub: "Los samples de hitsound de una carpeta, con los nombres que usa osu!: los cuatro golpes de cada set y los dos sonidos que repite el cuerpo de un slider, y después los numerados. Hacé clic en uno para escucharlo; uno que falta suena con lo que sonaría en su lugar. La carpeta solo se lee.",
    sb_src_song: "Carpeta de esta canción", sb_src_skin: "Skin de reproducción", sb_src_pick: "Otra carpeta…",
    sb_kind_skin: "skin", sb_kind_beatmap: "carpeta de beatmap",
    sb_hitnormal: "normal", sb_sliderslide: "slide", sb_sliderwhistle: "whistle slide",
    sb_counts: "{hits} de 12 golpes · {slides} de 6 sonidos de slider",
    sb_counts_empty: "{n} sin audio: silencian su sonido",
    sb_missing_skin: "faltan {n}: {skin} suenan con los del skin, {own} con los de Overtone",
    sb_missing_all_skin: "faltan {n}: suenan los del skin en su lugar",
    sb_missing_own: "faltan {n}: suenan los de Overtone en su lugar",
    sb_cell_title: "{file} · {kb} KB",
    sb_cell_empty: "vacío", sb_cell_empty_title: "{file} no tiene audio: silencia este sonido",
    sb_cell_skin: "→ skin", sb_cell_own: "→ Overtone",
    sb_cell_skin_title: "No está en esta carpeta: suena {file} del skin",
    sb_cell_own_title: "No está en esta carpeta: suena {file} de Overtone",
    sb_custom_beatmap: "Índices propios {list}: {n} samples que un mapa le pide a esta carpeta por índice",
    sb_custom_skin: "{n} samples numerados: osu! no le pide índices a un skin, así que ninguno suena",
    sb_unused: "Nunca suenan, {n}: {names}. El índice 1 no lleva número, y ningún índice empieza con cero.",
    sb_shadowed: "Tapados, {n}: {names}. Suena en su lugar un archivo del mismo nombre que osu! busca antes (wav, después ogg, después mp3).",
    sb_more: "{n} más",
    sb_skin_none: "La reproducción no usa skin: lo que le falta a la carpeta de un mapa suena con los samples de Overtone.",
    sb_skin_is: "Skin de reproducción: {name}. Lo que le falta a la carpeta de un mapa suena con sus samples, o si no con los de Overtone.",
    sb_skin_gone: "El skin de reproducción ya no está ({path}): suenan los samples de Overtone en su lugar.",
    sb_use: "Usar para la reproducción", sb_stop: "Dejar de usar un skin",
    sb_used: "La reproducción ahora usa {name} para lo que le falta a la carpeta de un mapa.",
    sb_stopped: "La reproducción ya no usa skin: completan los samples de Overtone.",
    sb_hear: "Escucharlo en el sonido elegido",
    sb_hear_pick: "Hacé clic en un sample y después elegí un sonido en la tabla Sonidos: la canción suena desde un segundo antes, con el sample en lugar de ese sonido.",
    sb_hear_sound: "Elegí un sonido en la tabla Sonidos: la canción suena desde un segundo antes, con {sample} en lugar de ese sonido.",
    sb_hear_ready: "{sample} en lugar del sonido de {time} (compás {bar} · {beat}), desde un segundo antes.",
    sb_hear_no_map: "Ninguna dificultad junto a esta canción usa su audio, así que no hay sonido donde escucharlo.",
    sb_hearing: "Sonando {sample} en {time}…",
    sb_loading: "Leyendo la carpeta…",
    sb_gone: "Ese sample ya no está en su carpeta: volvé a leer la carpeta.",
    sb_empty_heard: "{file} no tiene audio: no suena nada.",
    hs_title: "Copiar hitsounds", hs_preview: "Vista previa", hs_apply: "Copiar hitsounds",
    hs_sub: "Cada sonido de las dificultades elegidas toma el sonido de la fuente en el mismo momento (a menos de 5 ms): adiciones, sample sets e índice. Los sonidos sin nada debajo quedan como están. Solo cambian los campos de hitsound, y cada archivo se respalda antes.",
    hs_source: "Desde", hs_targets: "Hacia",
    hs_volumes: "Copiar también los volúmenes (suelen ser trabajo de las líneas verdes, que no se copian)",
    hs_no_targets: "Elegí al menos una dificultad de destino.", hs_same_file: "Una dificultad no se puede copiar sobre sí misma.",
    hs_t_diff: "Dificultad", hs_t_sounds: "Sonidos", hs_t_matched: "Con sonido fuente", hs_t_changed: "Van a cambiar",
    hs_t_unmatched: "Sin nada debajo", hs_t_conflicts: "Conflictos de índice",
    hs_conflict_note: "Un conflicto de índice es un sonido cuyo índice de sample viene de una línea verde que el destino no tiene, o un borde de slider con un índice distinto al de su cabeza: la copia deja esos índices como están.",
    hs_confirm: "¿Escribir los hitsounds de {source} en {n} dificultades? Solo cambian los campos de hitsound; cada archivo se respalda antes.",
    sw_title: "Cambio de audio", sw_preview: "Vista previa", sw_apply: "Mover todos los tiempos",
    sw_sub: "Mide el desplazamiento entre el audio mapeado y una nueva codificación, y mueve por él cada línea de timing, objeto, punto de preview y bookmark; el lead-in, una espera antes de la canción, queda igual. Gemelos de tempo y extraños se rechazan; cada archivo se respalda antes.",
    sw_old: "Audio mapeado", sw_new: "Nueva codificación",
    sw_shift: "{ms} ms de {old} a {nw}; pico {peak}",
    sw_t_reds: "Líneas rojas", sw_t_objects: "Objetos",
    sw_confirm: "¿Mover todos los tiempos de {n} dificultades por {ms} ms hacia {file}? Cada archivo se respalda antes.",
    sw_done: "{n} dificultades movidas hacia {file}.",
    sw_same_file: "La nueva codificación ya es el audio mapeado.",
    ac_title: "Archivo de audio",
    ac_sub: "Bitrate, sample rate, duración, clips e intro del audio que nombran los mapas. Los hallazgos usan las barras de la herramienta; ningún número de ranking está codificado.",
    ac_facts: "{format} · {rate} Hz · {ch} canales · {dur} · {br} kbps{avg} · pico {peak} dB",
    ac_avg: " (promedio)",
    ac_clean: "Limpio: sin clips, intro corta, rate completo.",
    ac_clipping: "Clipping: {share}% de samples a full.",
    ac_long_lead: "{ms} ms de casi silencio antes del primer sonido.",
    ac_low_rate: "{rate} Hz bajo calidad CD.",
    ms_no_audio: "Esa carpeta no nombra ningún audio que sus mapas puedan usar.",
    hs_done: "Hitsounds copiados en {n} dificultades ({objects} objetos). Los respaldos quedan junto a cada archivo.",
    hs_nothing: "Nada que cambiar: estas dificultades ya suenan como {source}.",
    st_theme: "Tema", st_theme_system: "Sistema", st_theme_dark: "Oscuro", st_theme_light: "Claro",
    theme_to_light: "Tema claro", theme_to_dark: "Tema oscuro",
    nav_structure: "Estructura",
    stx_sub: "Dónde cambian las frases de la canción, qué es cada parte y por qué: cada etiqueta junto a la evidencia en la que se apoya. Solo lectura.",
    stx_title: "Secciones",
    stx_loading: "Leyendo la estructura de la canción…",
    stx_no_rust: "La vista Estructura usa el motor Rust (overtone-cli), y acá no está compilado: cargo build --release -p overtone-cli.",
    stx_none: "No se encontró ningún cambio de frase: la canción se lee como una sola parte. Los cambios a menos de {s} s de cada punta no se pueden ubicar.",
    stx_count: "{n} secciones",
    stx_intro: "Intro", stx_verse: "Estrofa", stx_chorus: "Estribillo", stx_bridge: "Puente", stx_outro: "Final",
    stx_h_start: "Inicio", stx_h_bar: "Compás", stx_h_len: "Duración", stx_h_part: "Parte", stx_h_why: "Por qué", stx_h_moved: "Ajuste",
    stx_why_chorus: "Se repite ({n}×) y es la parte repetida más fuerte.",
    stx_why_chorus_db: "Se repite ({n}×) y es la parte repetida más fuerte, {db} dB sobre la siguiente.",
    stx_why_verse_quieter: "Se repite ({n}×), {db} dB por debajo del estribillo.",
    stx_why_verse_family: "Se repite ({n}×). Es la única parte repetida, así que no hay una repetición más baja sobre la que se destaque un estribillo.",
    stx_why_single: "Toda la canción se lee como una sola parte.",
    stx_why_intro: "Suena una vez, al principio, {s} s (menos de {max} s).",
    stx_why_outro: "Suena una vez, al final.",
    stx_why_bridge: "Suena una vez, entre las repeticiones.",
    stx_unsnapped: "sin compás probado a menos de {s} s",
    stx_one_family: "Todas las secciones se leen como una sola familia: en una mezcla completa, la armonía de estrofa y estribillo suele parecerse, y las etiquetas no las distinguen. Los bordes de frase y la energía siguen valiendo.",
    stx_preview: "Punto de preview: {at} ({kind}).",
    stx_bm_title: "Bookmarks",
    stx_bm_sub: "Inicios de sección como bookmarks de editor en una dificultad, mezclados con los suyos. Nada se borra nunca; cada archivo se respalda antes.",
    stx_bm_preview: "Vista previa", stx_bm_apply: "Escribir bookmarks",
    stx_bm_would: "{added} nuevos de {total} bookmarks en {file}.",
    stx_bm_confirm: "¿Escribir {n} bookmarks en {file}? Los suyos quedan.",
    stx_bm_done: "{n} bookmarks en {file}.",
    stx_bm_nothing: "Cada inicio de sección ya es bookmark en {file}.",
    stx_kiai_title: "Kiai",
    stx_kiai_sub: "Kiai en las secciones de estribillo en una dificultad, escrito como líneas verdes. El sonido no cambia nunca — el kiai es luz, no sonido; cada archivo se respalda antes.",
    stx_kiai_preview: "Vista previa", stx_kiai_apply: "Escribir kiai",
    stx_kiai_would: "{added} nuevas, {flipped} cambiadas, {kept} iguales en {n} estribillos en {file}.",
    stx_kiai_confirm: "¿Escribir kiai en {n} estribillos en {file}?",
    stx_kiai_done: "Kiai en {n} estribillos en {file}.",
    stx_kiai_nothing: "El kiai ya coincide con los estribillos en {file}.",
    stx_kiai_nochorus: "Esta canción no tiene secciones de estribillo, así que no hay nada que iluminar.",
    stx_breaks_title: "Breaks",
    stx_breaks_sub: "Breaks donde la canción se calma y el mapa queda en silencio, escritos como líneas 2,start,end. Solo se proponen tramos de 5 s o más; cada archivo se respalda antes.",
    stx_breaks_preview: "Vista previa", stx_breaks_apply: "Escribir breaks",
    stx_breaks_would: "{n} breaks en {file}: {spans}.",
    stx_breaks_confirm: "¿Escribir {n} breaks en {file}?",
    stx_breaks_done: "{n} breaks en {file}.",
    stx_breaks_nothing: "Nada tan calmo y largo como para un break en esta canción.",
    stx_vol_title: "Volumen",
    stx_vol_sub: "Volumen de hitsounds según la energía de cada sección en una dificultad, escrito como líneas verdes. Una sección donde el mapa pone sus propios volúmenes queda como está; las demás toman su volumen de punta a punta. Sets, samples y kiai no se mueven nunca; cada archivo se respalda antes.",
    stx_vol_preview: "Vista previa", stx_vol_apply: "Escribir volúmenes",
    stx_vol_would: "{set} secciones ajustadas ({added} verdes nuevas, {flipped} reescritas), {kept} ya en su volumen, {mapper} con los volúmenes del propio mapa, en {file}.",
    stx_vol_confirm: "¿Ajustar el volumen de {n} secciones en {file}? Las secciones donde el mapa pone el suyo quedan como están.",
    stx_vol_done: "Volúmenes ajustados en {n} secciones de {file}.",
    stx_vol_nothing: "Nada para escribir en {file}: las secciones ya tienen su volumen, o el mapa pone el suyo.",
    stx_note: "Las letras son familias de secciones que se repiten. Cada borde se ajusta a una línea de compás probada a menos de {snap} s: la más cercana, o el compás anterior o el siguiente cuando el nivel cambia más ahí, por {margin} dB o más, subiendo hacia una sección más fuerte o bajando hacia una más suave. Un compás donde cae el cambio, no la prueba de que la frase empiece ahí. Un cambio a menos de {edge} s de cada punta no se puede ubicar. Hacé clic en una sección para abrirla en Timing.",
    songs_title: "Songs de osu!",
    songs_scan: "Escanear",
    songs_rescan: "Reescanear",
    songs_scanning: "Escaneando…",
    songs_pick: "Carpeta…",
    songs_search: "Buscá artista, título, mapper, dificultad, tags",
    songs_listing: "Listando la carpeta…",
    songs_progress: "{done} / {total} carpetas",
    songs_removing: "Quitando {n} mapas que ya no están en la carpeta…",
    songs_none: "Sin índice todavía: Escanear lee {root} una vez.",
    songs_missing: "No hay carpeta Songs en {root}: elegí una.",
    songs_empty: "No hay beatmaps en {root} · escaneado {when}",
    songs_gone: "{root} no está: el índice ({n} mapas) es del {when}.",
    songs_info: "{n} mapas en {s} sets · escaneado {when}",
    songs_other: "Índice de {root} ({n} mapas): reescaneá para la carpeta actual.",
    songs_failed: "{n} no se pudieron leer",
    songs_scanned: "Biblioteca: {n} mapas en {s} sets ({changed} leídos, {removed} quitados) en {sec} s.",
    songs_scanned_failed: "Biblioteca: {n} mapas en {s} sets ({changed} leídos, {removed} quitados, {failed} sin leer) en {sec} s.",
    songs_rebuilt: "El índice dañado se reconstruyó.",
    library_damaged: "El índice de la biblioteca está dañado: Reescanear lo reconstruye desde la carpeta.",
    songs_nothing: "Ningún mapa coincide con “{q}”.",
    songs_limited: "Los primeros {n} mapas: escribí más para acotar.",
    songs_diff: "dific.",
    songs_diffs: "dific.",
    scan_running: "Ya hay un escaneo en curso.",
    ref_indexed: "Del índice de la biblioteca, escaneado {when}.",
    cmp_title: "Mapa vs detección", cmp_pick: "Elegir .osu…",
    cmp_empty: "Elegí el .osu que mapeaste para compararlo con esta detección.",
    cmp_sections: "{n} secciones",
    cmp_det_off: "Offset det.", cmp_det_bpm: "BPM det.", cmp_map_off: "Offset mapa", cmp_map_bpm: "BPM mapa",
    cmp_dbpm: "Δ BPM", cmp_dms: "Δ ms", cmp_oct: "Octava",
    cmp_octave_f: "Sección #{n}: mapa {map} vs detectado {det} BPM — a una octava ({octave}).",
    cmp_bpm_f: "Sección #{n}: mapa {map} vs detectado {det} BPM (difiere {err}).",
    cmp_offset_f: "Sección #{n}: la rejilla del mapa erra los beats detectados por {ms} ms.",
    cmp_count_f: "El .osu tiene {map} líneas rojas, la detección encontró {det} secciones.",
    cmp_no_reds_f: "Ese .osu no tiene líneas rojas para comparar.",
    cmp_unreadable_f: "No se pudo comparar: {detail}",
    sug_title: "Sugerencias",
    sug_empty: "Cada cambio detectado tiene una línea roja cerca.",
    sug_hint: "Cambios que Overtone detecta y este mapa no tiene como línea roja. Agregar escribe una en el mapa, con copia de seguridad antes; Inyectar .osu… las escribe todas.",
    sug_show: "Ver", sug_add: "Agregar",
    sug_add_confirm: "¿Agregar una línea roja a {file}?\n\n{lines}\n\nAntes se hace una copia de seguridad del archivo, e Historial puede restaurarlo.",
    sug_add_line: "{o} ms · {b} BPM · {m} pulsos por compás, con el sample set, el volumen y el kiai que el mapa tiene ahí",
    sug_add_green: "Una línea verde en el mismo tiempo mantiene la velocidad de sliders que el mapa tenía ahí",
    sug_add_octave: "Ojo: es {k} los {b} BPM del propio mapa aquí, y eso suele ser el mismo pulso contado de otra forma más que un tempo nuevo",
    sug_octave_tip: "Una octava de los {b} BPM del propio mapa aquí: suele ser el mismo pulso contado de otra forma más que un tempo nuevo.",
    sug_add_objects: "{n} objetos siguen el nuevo pulso hasta la próxima línea roja",
    sug_add_sliders: "{n} finales de slider se mueven; el que más, {d} ms {dir}",
    sug_earlier: "antes", sug_later: "después",
    sug_added: "Línea roja agregada en {o} ms en {file}.",
    suggestion_gone: "Esa sugerencia ya no está en la lista: cambió el mapa o el análisis.",
    align_title: "Alineación", align_pick: "Revisar alineación…",
    align_empty: "Elegí un .osu para contrastar sus objetos con los ataques detectados.",
    align_counts: "{m}/{o} objetos · {c}/{a} ataques",
    align_off_f: "{n} objetos erran los ataques (peor {worst} ms).",
    align_unc_f: "{n} ataques fuertes no tienen objeto.",
    align_none_f: "Sin ataques contra los que alinear — este resultado vino del tracker de respaldo.",
    align_t_time: "Tiempo", align_t_kind: "Objeto", align_t_ms: "Desvío",
    align_uncovered: "Ataques sin objeto (ms):",
    align_more: "+{n} más",
    den_title: "Densidad", den_pick: "Revisar densidad…",
    den_empty: "Elegí un .osu para desglosar sus objetos en hits por segundo.",
    den_counts: "{o} objetos · pico {p}/s · {s} stream · {j} jump",
    den_t_range: "Tiempo", den_t_n: "Objetos", den_t_rate: "Por segundo",
    den_t_stream: "Stream", den_t_jump: "Jump", den_t_single: "Single",
    snap_title: "Revisión de snap", snap_pick: "Revisar snap…",
    snap_empty: "Elegí un .osu para ver los objetos fuera de su propia grilla y qué desajustaría inyectar el timing detectado.",
    snap_counts: "{s}/{o} en la grilla · {u} fuera",
    snap_t_time: "Tiempo (ms)", snap_t_kind: "Objeto", snap_t_div: "Más cercano", snap_t_off: "Desvío (ms)",
    snap_before: "Antes de la primera línea roja:", snap_past: "Después del final del audio:",
    snap_inject: "Inyectar el timing detectado desajustaría {n} objeto(s) y volvería a ajustar {m}.",
    snap_inject_none: "Inyectar el timing detectado no desajustaría nada.",
    snap_no_reds: "Este mapa no tiene líneas rojas con las que ajustar.",
    snap_unparsed: "No se pudieron leer {n} línea(s) de [HitObjects].",
    snap_starts: "Solo el inicio de cada objeto; no se revisan los finales de sliders, spinners ni holds.",
    rs_title: "Re-snap de objetos", rs_pick: "Elegir .osu…", rs_apply: "Re-snapear…",
    rs_sub: "Mueve los objetos snapeados de este mapa a la grilla detectada tras un cambio de timing. Correlo antes de inyectar, mientras el mapa conserva sus líneas rojas viejas — los objetos fuera del grid quedan y se listan.",
    rs_would: "{moved} para mover, {changed} tiempos cambian, {left} quedan",
    rs_left_row: "{t}ms {kind}",
    rs_left_more: "+{n} más quedan",
    rs_confirm: "¿Mover {n} objetos en {file}? Los fuera del grid quedan.",
    rs_done: "Movidos {n} objetos en {file}.",
    rs_clean: "Cada objeto snapeado ya está en la grilla detectada.",
    resnapped: "Ya se reajustó con este timing: inyectá el timing en este archivo a continuación. Reajustar otra vez movería estos objetos dos veces; Historial restaura el archivo para empezar de nuevo.",
    ref_title: "Timing de referencia", ref_pick: "Calificar un .osu…", ref_find: "Mapas de esta canción…",
    ref_empty: "Elegí cualquier .osu de esta canción, timeado a mano o rankeado, para calificar cada línea roja contra los ataques que Overtone escucha. Sirve donde la detección flaquea: bandas en vivo, rubato, deriva.",
    ref_counts: "{ok} ok · {check} a revisar · {weak} débiles · {few} con pocos ataques",
    ref_t_line: "#", ref_t_offset: "Offset", ref_t_bpm: "BPM", ref_t_div: "Leído a", ref_t_share: "En la grilla",
    ref_t_off: "vs mapa (ms)", ref_t_drift: "Deriva al final (ms)", ref_t_fit: "BPM ajustado", ref_t_verdict: "",
    ref_ok: "ok", ref_check: "revisar", ref_weak: "débil", ref_too_few: "pocos ataques",
    ref_offset: "offset", ref_drift: "deriva",
    ref_shift_f: "Todas las líneas quedan a {ms} ms de los ataques, así que la tabla muestra cada línea respecto de ese corrimiento. En canciones reales Overtone leyó de +12 a +46 ms (mediana +26) en los 30 mapas rankeados probados, en MP3 y en OGG, y todavía no se sabe por qué: revisá el offset a oído antes de mover todo el mapa.",
    ref_split_f: "Estas {n} líneas no coinciden en un mismo offset y no hay mayoría que decida cuáles están bien: revisalas a oído.",
    ref_before_f: "{n} ataques suenan antes de la primera línea roja.",
    ref_same: "Mismo audio que el archivo analizado, byte por byte.",
    ref_other: "El audio de este mapa no es el archivo analizado byte por byte: los offsets pueden no trasladarse entre dos codificaciones.",
    ref_unknown: "No se encontró el audio del mapa junto a él, así que no se pudo comparar.",
    ref_imported: "Timing leído del archivo de otro juego. Su audio no se comparó con este, así que un offset solo se traslada si ambos reproducen la misma codificación.",
    ref_no_reds: "Este mapa no tiene líneas rojas para calificar.",
    ref_no_attacks: "No se encontraron ataques en esta canción contra los que calificar.",
    ref_hint: "Positivo: la música llega después de la línea roja. ± son dos errores estándar: una línea se marca pasados 5 ms y pasado su propio ±.",
    ref_load: "Usar como timing de trabajo",
    ref_load_confirm: "¿Reemplazar los {n} timing points de trabajo por las {m} líneas rojas de {file}? Deshacer los recupera.",
    ref_loaded: "Cargadas {n} líneas rojas de {file}.",
    ref_found: "{n} mapa(s) usan este audio en {root}.",
    ref_found_none: "Ningún mapa en {root} usa exactamente este audio ({s} archivos de audio revisados).",
    ref_grade: "Calificar",
    no_songs: "Elegí tu carpeta Songs de osu!.",
    ev_title: "Evidencia",
    ev_sub: "Contra qué leyó el motor: candidatos de coherencia por sección, margen de octava, residual y cobertura. Usar uno escribe su BPM en la línea roja que manda.",
    ev_section: "§{n} · {from}–{to} s · {bpm} BPM · residual {res} ms · cobertura {cov} % · {inliers} ataques",
    ev_candidates: "Candidatos de coherencia",
    ev_seeded: "semilla", ev_half: "mitad", ev_double: "doble",
    ev_margin: "margen de octava {m}",
    ev_use: "Usar", ev_used: "La línea roja {n} ahora va a {bpm} BPM.",
    ev_note: "El motor alternativo no guarda ataques, así que no hay alternativas que mostrar.",
    ev_t_bpm: "BPM", ev_t_coh: "Coherencia",
    ramp_title: "Rampas",
    ramp_sub: "La curva elástica como las menos líneas rojas dentro del drift. Usarlas reemplaza el timing con líneas puestas a mano; deshacer lo recupera.",
    ramp_drift: "Drift (ms)", ramp_max: "Como mucho N líneas", ramp_fit: "Ajustar", ramp_use: "Usar estas líneas",
    ramp_lines: "{n} líneas rojas dentro de {ms} ms",
    ramp_tradeoff: "Menos líneas cuestan drift: {rows}.",
    ramp_trade_row: "{drift} ms → {n} líneas",
    ramp_recommend: "La curva se dobla acá: las rampas ajustan mejor que una grilla por sección.",
    ramp_piecewise: "Las secciones ya leen bien: las rampas no agregan nada, así que no hay líneas para usar.",
    ramp_used: "{n} líneas rojas puestas a mano.",
    ramp_no_ramps: "Ajustá primero: todavía no hay líneas para usar.",
    ramp_not_recommended: "Acá las secciones leen mejor que las rampas: no hay nada para usar.",
    ramp_t_at: "Empieza", ramp_t_attacks: "Ataques",
    sv_title: "Scroll constante",
    sv_sub: "Verdes que cancelan los cambios de BPM de esta dificultad: uno en cada línea roja, y cada verde después de ella escalado por la razón de tempo, para que el scroll vaya siempre igual y los cambios de SV del mapa conserven su forma. Un slider dura según su SV, así que un mapa con sliders después de un cambio de BPM se rechaza en vez de sacarlos de sus tiempos. El sonido, el kiai y los compases no se mueven nunca; cada archivo se respalda antes.",
    sv_preview: "Vista previa", sv_apply: "Escribir verdes",
    sv_would: "{added} nuevas, {flipped} reescaladas, {kept} ya constantes a {bpm} BPM en {file}.",
    already_written: "Ya se escribió acá, y no se escribe dos veces: Historial restaura el archivo para empezar de nuevo.",
    scroll_sliders: "{n} sliders empiezan donde el scroll se reescalaría, el primero en {at}: un slider dura según su SV, así que cada final saldría de su tiempo. No se escribe nada; normalizá esta dificultad en el editor, ajustando sus sliders.",
    sv_confirm: "¿Escribir verdes de scroll a {bpm} BPM en {file}?",
    sv_done: "Scroll constante a {bpm} BPM en {file}.",
    sv_nothing: "Cada sección ya va a {bpm} BPM en {file}.",
    div_title: "Divisores de snap",
    div_sub: "Qué divisor necesita cada sección, según los ataques de la canción. Tresillos y seisillos que superan la barra de peso leen 1/3 y 1/6, el resto 1/4. Solo lectura.",
    div_row: "{at} · {bpm} BPM · {d}{extra}",
    div_extra: " ({t} tresillos, {s} seisillos)",
    swing_title: "Swing",
    swing_sub: "Dónde cae la corchea a contratiempo dentro del pulso, de ocho en ocho pulsos: a la mitad es recto, más tarde es swing. Se mide desde el pulso propio de cada ventana, así que una rejilla desviada unos ms no cambia nada. Solo lectura: el snap es el que pondrías en el editor.",
    swing_row: "{from} – {to} · {what} · {at} del pulso{snap} · proporción {ratio} · {late} ms más tarde",
    swing_snap: " ({snap})",
    swing_swing: "swing",
    swing_triplets: "tresillos",
    swing_none: "Recto de principio a fin: ninguna de las {measured} ventanas lee swing.",
    swing_nothing: "Ninguna ventana tuvo un pulso propio que medir.",
    swing_count: "{n} de {measured} ventanas con swing, en {spans}.",
    swing_span: "1 tramo",
    swing_spans: "{n} tramos",
    ph_title: "Mitad y doble de tempo",
    ph_sub: "Un tramo dentro de una misma sección donde la canción cambia de pulso. La rejilla sigue encajando, porque cada golpe de la mitad lenta cae igual en la rejilla de la rápida; lo que cambia es cuántas casillas se llenan, y si las llenas caen una sí y una no. Solo lectura: nada de esto mueve una línea roja.",
    ph_none: "Ninguna sección tiene un tramo a mitad ni a doble de tempo.",
    ph_row_half: "Desde {at}: la sección {n} lee {bpm} BPM, pero {from} – {to} suena a {reads}. Mitad de tempo desde ahí: ÷2 en esa sección, o una línea roja en {at}.",
    ph_row_double: "Hasta {at}: la sección {n} lee {bpm} BPM, pero {from} – {to} suena a {reads}. Doble de tempo hasta ahí: ×2 en esa sección, o una línea roja en {at}.",
    ph_why: "{thinned} de {windows} ventanas, sobre el pulso dividido en {sub}: {cin} % de las casillas llenas frente a {cout} % en el resto, y {pin} % del peso una sí y una no frente a {pout} %.",
    lg_pulse: "mitad/doble",
    lab_title: "Laboratorio de offset",
    lab_sub: "Lo que el archivo dice de su propio delay, y el primer ataque por cada decodificador lado a lado.",
    lab_header: "{encoder}: delay {delay} samples ({delayMs} ms), pad {pad} samples ({padMs} ms).",
    lab_no_tag: "Sin etiqueta gapless: este archivo no dice su delay.",
    lab_compare: "Comparar decodificadores",
    lab_decoders: "Primer ataque: Python {py} ms, Rust {rust} ms, diferencia {delta} ms.",
    lab_test_title: "Prueba ciega",
    lab_test_sub: "Escuchá el mismo pasaje dos veces con dos shifts ocultos y elegí el que va a tiempo. Cada shift corre contra cero, tres veces cada uno.",
    lab_start: "Empezar", lab_hear1: "Escuchar 1", lab_hear2: "Escuchar 2",
    lab_vote1: "1 iba a tiempo", lab_vote2: "2 iba a tiempo", lab_cancel: "Cancelar",
    lab_rate: "Poné la velocidad en 100% para la prueba.",
    lab_trial: "Prueba {k} de {n}",
    lab_t_shift: "Shift", lab_t_wins: "Ganadas", lab_t_interval: "Intervalo 95%",
    lab_best: "Preferido: {shift} ms ({lo}–{hi} % preferido sobre cero).",
    lab_none: "Nada le gana a cero: el clic queda donde está.",
    as_title: "Timing asistido",
    as_sub: "Donde la detección se equivoca, marcá dos tiempos fuertes: el grid se ajusta desde ahí, o se rechaza con el motivo.",
    as_first: "Primer tiempo fuerte (ms)", as_second: "Un tiempo fuerte posterior (ms)", as_bars: "Compases entre ambos", as_meter: "Tiempos por compás",
    as_fit: "Ajustar", as_add: "Agregar al timing",
    as_facts: "<b>{bpm}</b> BPM · línea roja en <b>{offset}</b> ms · se sostiene de <b>{from}–{to}</b> s ({bars} compases) · leído a 1/{div} · {share}% en la grilla",
    as_moved: "Tus marcas se movieron {a} y {b} ms hasta los ataques.",
    as_short: "El grid se sostuvo solo {bars} compases: su BPM puede errar por décimas. Marcá tiempos fuertes más separados, o revisalo a oído.",
    as_add_hint: "Agrega una línea roja puesta a mano; se reemplazan las líneas detectadas dentro de {from}–{to} s, salvo cerca del final, donde una línea es casi seguro el cambio que lo terminó. Deshacer las recupera.",
    as_added: "Agregado {bpm} BPM en {offset} ms.",
    as_bad_marks: "Ingresá dos tiempos fuertes, el segundo después del primero, y números enteros de compases y tiempos.",
    as_bpm_range: "Esas marcas dan {bpm} BPM, fuera de 40–400: revisá los compases entre ellas.",
    as_too_few: "Solo hay {n} ataques cerca de las marcas: marcá tiempos fuertes donde suena la música.",
    as_weak: "Los ataques no siguen ese grid ({share} sobre él): revisá las marcas y los compases entre ellas.",
    as_chance: "Ataques al azar encajarían igual de bien en ese grid: acá no hay un grid para timear.",
    as_no_attacks: "No se encontraron ataques en esta canción.",
    no_fit: "Primero ajustá un grid.",
    settings_sub: "Se guardan en esta PC a medida que los cambiás.",
    st_output: "Exportaciones", st_folder: "Carpeta de salida", st_folder_default: "Usar la predeterminada", st_folder_pick: "Elegir carpeta…",
    st_folder_is_default: "{path} (la predeterminada)",
    st_ask: "Preguntar dónde guardar cada exportación (el diálogo abre en la carpeta de la canción)",
    st_decimals: "Precisión del offset",
    st_decimals_hint: "osu!stable lee milisegundos enteros; osu!lazer guarda decimales. Se usa al copiar, en el .osz y al inyectar.",
    st_click: "Click", st_sub: "Clicks por beat",
    st_sub_hint: "Clicks suaves extra entre beats, en la app y en el click track exportado.",
    st_accent: "Acentuar el primer tiempo de cada compás",
    st_look: "Apariencia", st_scale: "Tamaño de la interfaz", st_motion: "Reducir el movimiento",
    st_detect: "Detección y motor",
    st_detect_hint: "La detección, el pulso y el motor Rust se cambian en el panel que también abre la barra superior.",
    st_detect_open: "Ajustes de detección…",
    st_storage: "Caché y backups", st_cache: "Caché de resultados", st_cache_clear: "Vaciar caché",
    st_cache_info: "{n} análisis · {mb} MB (guarda los últimos {max}) · {path}",
    st_cache_cleared: "Caché vaciada: cada canción se vuelve a analizar la próxima vez.",
    st_backups: "Backups: antes de escribir un .osu, los bytes que reemplaza se guardan a su lado. El primero es map.osu.bak y nunca se vuelve a tocar; los siguientes son .bak2, .bak3…, así sobrevive cada estado anterior.",
    nav_audio: "Audio",
    nav_report: "Reporte",
    audio_sub: "Qué empezó, no solo que algo empezó: el flujo de onsets partido en siete bandas, desde los 40 Hz del kick hasta 11 kHz. Un kick mueve el carril de abajo, un hat el de arriba, un clic de banda ancha los siete. Solo lectura.",
    spec_title: "Espectrograma",
    spec_note: "{rows} bandas mel hasta 11 kHz sobre {span}, {cols} columnas. Cada columna guarda el frame más fuerte que cae debajo, y {floor} dB por debajo del momento más fuerte de esta canción es negro.",
    spec_reading: "Leyendo el espectro de la canción…",
    audio_busy: "La canción está ocupada con otro trabajo. Volvé a abrir Audio en un momento.",
    band_title: "Bandas de onsets",
    band_note: "{n} columnas sobre {span}, pico de {db} dB de flujo. Cada carril se dibuja contra ese mismo pico, así que una banda silenciosa se ve silenciosa.",
    band_reading: "Leyendo las bandas de la canción…",
    band_none: "No hay flujo que mostrar para esta canción.",
    report_sub: "Cada hallazgo sobre una dificultad como timestamps del editor de osu!, listo para pegar en un mod. Un timestamp abre el editor ahí. Solo lectura: no se escribe nada.",
    rp_title: "Reporte de mod", rp_pick: "Elegir .osu…", rp_copy: "Copiar todo",
    rp_empty: "Elegí el .osu de una dificultad para juntar cada hallazgo sobre ella: líneas rojas a revisar, líneas rojas que le faltan, objetos sin snap, objetos lejos de la música e hitsounds que rompen el patrón del mapa.",
    rp_counts: "{n} hallazgos", rp_none: "Nada que reportar en esta dificultad.",
    rp_src_reference: "Líneas rojas", rp_src_suggestion: "Líneas rojas faltantes", rp_src_snap: "Snap", rp_src_alignment: "Lejos de la música", rp_src_hitsound: "Hitsounds",
    rp_hint: "Las líneas van en inglés, como los mods. Destildá un grupo para dejarlo fuera de la copia.",
    rp_copied: "Reporte copiado: pegalo en tu mod.",
    rp_open: "Abrir en el editor de osu!",
    bad_stamp: "Eso no es un timestamp del editor.",
    no_osu: "osu! no se abrió — ¿está instalado? ({detail})",
    pb_play: "Reproducir / pausar (Espacio)", pb_from_line: "Desde la línea roja", pb_seek: "Posición",
    pb_click: "Click", pb_perc: "Solo percusión", pb_loop: "Repetir sección", pb_song: "Canción", pb_click_vol: "Click",
    pb_hint: "Espacio reproduce y pausa · doble clic en el mapa de tempo para reproducir desde ahí · en pausa, la barra y las flechas suenan donde caen · el click sigue tus ediciones · ? muestra todas las teclas",
    keys_title: "Teclado", kb_space: "Espacio", kb_shift: "Mayús", kb_enter: "Intro",
    key_play: "Reproducir / pausar", key_seek: "Atrás / adelante 1 s (en pausa: se oye ahí)", key_seek_fine: "Atrás / adelante 10 ms (en pausa: se oye ahí)",
    key_lines: "Línea roja anterior / siguiente: la elige y pone el cabezal en ella",
    key_points: "Timing point anterior / siguiente (Timing)", key_loop: "Bucle sí / no", key_click: "Click sí / no",
    key_tap: "Marcar el pulso junto al click", key_views: "Las secciones del menú, en orden",
    key_open: "Abrir audio", key_analyze: "Analizar", key_undo: "Deshacer", key_redo: "Rehacer",
    key_sheet: "Esta hoja", key_close: "Cerrar un panel o esta hoja",
    key_toggled: "{what}: {state}", key_state_on: "sí", key_state_off: "no",
    pb_loading: "Cargando la canción… {n}/{of}",
    pb_perc_preparing: "Separando la batería…",
    pb_perc_on: "Solo percusión: la batería contra el click. Destildá para oír la canción entera.",
    pb_failed: "No se pudo reproducir la canción: {detail}",
    no_audio_staged: "La canción no está cargada; volvé a darle play.",
    pb_rate: "Velocidad: más lento baja el tono, así cada ataque queda exactamente en su lugar",
    lane_wave: "onda", lane_swing: "swing", lg_swing: "swing",
    tl_zoom: "{a} – {b}", tl_fit: "Ver todo", lg_drift: "deriva", lg_conf: "confianza",
    tap_btn: "Tap (T)", tap_calibrate: "Calibrar con estos taps", tap_assist: "Usar para timing asistido", tap_clear: "Borrar",
    tap_hint: "Reproducí y tocá T en cada beat: para revisar el timing a oído, para calibrar tus taps (tocá solo con el click) o para arrancar el timing asistido (empezá en un tiempo fuerte).",
    tap_info: "{n} taps · {bpm} BPM · {where}",
    tap_after: "tocás {ms} ms después del click (± {sd})",
    tap_before: "tocás {ms} ms antes del click (± {sd})",
    tap_play_first: "Primero reproducí la canción, después tocá al ritmo.",
    tap_calibrated: "Calibrado: desde ahora tus taps se toman {ms} ms antes.",
    tap_assist_need: "Tocá al menos {n} beats seguidos, empezando en un tiempo fuerte.",
    bad_latency: "Esos taps están demasiado lejos del click para ser latencia.",
    import_folder: "Importar carpeta…",
    imported: "Carpeta: {audio} + {n} {difficulties}.",
    difficulties: "dificultades",
    no_audio: "Esa carpeta no tiene audio legible — sus mapas igual sirven para comparar.",
    bad_folder: "Elegí primero una carpeta real.",
    done: "Listo: {n} timing points · {bpm} BPM", rescaled: "Pulso ×{f}: {n} timing points · {bpm} BPM",
    error: "Error: {detail}",
  },
};

const S = { lang: "en", view: "library", mapset: null, file: null, options: null, presets: {}, result: null, timings: null, busy: false, selected: -1, locks: [], compare: null, comparePath: null, align: null, density: null, snap: null, ref: null, refFind: null, assist: null, report: null, recent: [] };
const $ = (id) => document.getElementById(id);
const api = () => (window.pywebview && window.pywebview.api) || null;

function t(key, values) {
  const table = I18N[S.lang] || I18N.en;
  let text = table[key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(values || {})) text = text.replaceAll(`{${k}}`, v);
  return text;
}

function translate() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  // Icon-only controls (and nav items once the rail collapses) carry their
  // name in title/aria-label, so those follow the language too.
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute("aria-label", el.title);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  document.querySelectorAll("#langSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  pbLoopLabel();
  renderProjectOffer();
  renderSongOptions();
  renderSong();
  renderRecents();
  renderSongs();
  renderStructure();
  if (HSV.report) renderHitsoundsView();
  sbRender();
  renderNeedSong();
  renderMapset();
  if (typeof renderCopier === "function") renderCopier();
  if (typeof renderSwapResult === "function" && S.mapset) renderSwap();
  if (S.result) renderResult(S.result);
  if (S.busy) $("analyzeText").textContent = t("analyzing");
}

// ------------------------------------------------------------------ views
// One analysed song is shared by every view: switching only changes what is
// visible, never the session. Views that read the analysis show the
// "analyze first" panel until there is one, instead of blank space.
const VIEWS = ["library", "timing", "structure", "hitsounds", "mapcheck", "mapset", "audio", "report", "export", "history", "settings"];
const VIEW_LABEL = { library: "nav_library", timing: "nav_timing", structure: "nav_structure", hitsounds: "nav_hitsounds", mapcheck: "nav_mapcheck", mapset: "nav_mapset", audio: "nav_audio", report: "nav_report", export: "nav_export", history: "nav_history", settings: "nav_settings" };

function needsResult(view) {
  const section = document.querySelector(`.content > [data-view="${view}"]`);
  return !!section && section.hasAttribute("data-needs-result");
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  const changed = S.view !== view;
  S.view = view;
  document.querySelectorAll("#nav [data-view]").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  const blocked = needsResult(view) && !S.result;
  document.querySelectorAll(".content > [data-view]").forEach((sec) => { sec.hidden = blocked || sec.dataset.view !== view; });
  $("needSong").hidden = !blocked;
  renderNeedSong();
  if (changed) $("content").scrollTop = 0;
  // The canvas measures its box: it can only be drawn while visible.
  if (view === "timing" && S.result) {
    drawTrace(); waveLoad(); svMaps(); divsLoad(); swingLoad(); phLoad();
  }
  if (view === "structure" && S.result) { stxLoad(); stxBmMaps(); stxKiaiMaps(); stxBreaksMaps(); stxVolMaps(); }
  if (view === "hitsounds" && S.result) { hsvLoad(); sbView(); }
  if (view === "export" && S.result) hsdfMaps();
  if (view === "audio" && S.result) audioLoad();
  if (view === "history") histLoad();
}

function renderNeedSong() {
  const view = t(VIEW_LABEL[S.view] || "nav_timing");
  $("needBody").textContent = t(S.busy ? "need_busy" : "need_body", { view });
  const ready = !!S.file && !S.busy;
  $("needAnalyze").hidden = !ready;
  if (ready) $("needAnalyzeText").textContent = t("need_analyze", { name: S.file.name });
  // One primary action: Analyze once a song is open, Open audio before.
  $("needOpen").classList.toggle("primary", !ready);
  $("needOpen").disabled = S.busy;
}

let toastTimer = 0;
function toast(text, isError) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3200);
}

// ------------------------------------------------------------------ file + options
function setFile(info) {
  S.file = info && info.exists ? info : null;
  renderSong();
  $("analyzeBtn").disabled = !S.file || S.busy;
  $("emptyAnalyze").hidden = !S.file;
  renderNeedSong();
  songOptionsFor(S.file);
}

function renderSong() {
  const song = $("song"), title = $("songTitle"), meta = $("songMeta");
  song.classList.toggle("idle", !S.file);
  if (!S.file) {
    title.textContent = t("no_song"); meta.textContent = t("no_song_hint");
    return;
  }
  // osu! song folders are "<id> Artist - Title": that reads better than audio.mp3
  const folder = S.file.folder.replace(/^\d+\s+/, "");
  title.textContent = folder && folder.includes(" - ") ? folder : S.file.name;
  const bits = [S.file.name, `${S.file.size_mb} MB`];
  if (S.result && S.result.path === S.file.path) bits.push(mmss(S.result.duration));
  meta.textContent = bits.join(" · ");
}

function applyOptions(o) {
  S.options = o;
  $("delta").value = o.delta;
  $("persistence").value = o.persistence;
  $("confidence").value = o.confidence;
  $("confidenceRange").value = o.confidence;
  $("preferMap").checked = o.prefer_map_bpm;
  $("refineBeats").checked = o.refine_beats;
  $("rustEngine").checked = o.engine === "rust";
  document.querySelectorAll("#pulseSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.pulse === o.pulse));
  markPreset();
}

function readOptions() {
  const o = {
    delta: parseFloat($("delta").value),
    persistence: parseInt($("persistence").value, 10),
    confidence: parseFloat($("confidence").value),
    pulse: (document.querySelector("#pulseSwitch button.on") || {}).dataset?.pulse || "auto",
    prefer_map_bpm: $("preferMap").checked,
    refine_beats: $("refineBeats").checked,
    engine: $("rustEngine").checked ? "rust" : "python",
  };
  const bad = {
    delta: !(o.delta > 0), persistence: !(o.persistence >= 2), confidence: !(o.confidence >= 0 && o.confidence <= 100),
  };
  for (const [k, isBad] of Object.entries(bad)) $(k).classList.toggle("bad", isBad);
  return Object.values(bad).some(Boolean) ? null : o;
}

// ------------------------------------------------------------------ per-song settings
// A song remembers the detection settings its last analysis ran with (the
// engine stays one setting): choosing it again puts them back, says so, and
// keeps the ones they replaced one click away.
const SONGOPT = { path: "", previous: null, options: null };
const SONGOPT_KEYS = ["delta", "persistence", "confidence", "pulse", "prefer_map_bpm", "refine_beats"];

function songOptionsText(o) {
  const preset = Object.entries(S.presets || {}).find(([, p]) =>
    +p.delta === +o.delta && +p.persistence === +o.persistence && +p.confidence === +o.confidence);
  const parts = [preset ? t(`preset_${preset[0]}`)
                        : t("songopt_custom", { d: o.delta, p: o.persistence, c: o.confidence })];
  const pulse = document.querySelector(`#pulseSwitch [data-pulse="${o.pulse}"]`);
  if (o.pulse !== "auto" && pulse) parts.push(t("songopt_pulse", { p: pulse.textContent }));
  if (!o.prefer_map_bpm) parts.push(t("songopt_no_prefer"));
  if (!o.refine_beats) parts.push(t("songopt_no_refine"));
  return parts.join(" · ");
}

async function songOptionsFor(info) {
  SONGOPT.path = ""; SONGOPT.previous = null; SONGOPT.options = null;
  renderSongOptions();
  if (!info || !info.exists || !api()) return;
  const reply = await api().song_options(info.path);
  if (!reply || !reply.ok || !reply.options || S.busy || !S.file || S.file.path !== info.path) return;
  const now = readOptions();
  if (!now || SONGOPT_KEYS.every((k) => now[k] === reply.options[k])) return;
  Object.assign(SONGOPT, { path: info.path, previous: now, options: reply.options });
  applyOptions({ ...now, ...reply.options });
  renderSongOptions();
  toast(t("songopt_applied", { what: songOptionsText(reply.options) }));
}

function renderSongOptions() {
  const on = !!SONGOPT.previous && !!S.file && S.file.path === SONGOPT.path;
  $("songOptNote").hidden = !on;
  $("songOptText").textContent = on ? t("songopt_note", { what: songOptionsText(SONGOPT.options) }) : "";
  $("settingsBtn").classList.toggle("song-own", on);
}

function songOptionsBack() {
  if (!SONGOPT.previous) return;
  applyOptions(SONGOPT.previous);
  SONGOPT.previous = null;
  renderSongOptions();
  toast(t("songopt_reverted"));
}

// A setting changed by hand is the mapper's, no longer the song's (the
// engine was never the song's).
function songOptionsTouched(e) {
  if (!SONGOPT.previous || (e && e.target.closest("#songOptNote, #rustEngine"))) return;
  SONGOPT.previous = null;
  renderSongOptions();
}

// ------------------------------------------------------------------ live confidence
// A minimum confidence tried on the analysis on screen: its fitted sections
// read again (nothing analysed), the red lines it would add dashed on the
// map and the ones it would drop faded, until it is applied or left.
const CONF = { percent: null, points: null, added: [], removed: new Set(), timer: 0, seq: 0 };

function confLiveUsable() {
  // The grid engine's sections, or the fallback tracker's stored beats: both
  // are read again at another confidence (the bridge refuses anything else).
  const rereadable = S.result && ((S.result.sections && S.result.sections.length)
                                  || S.result.engine === "legacy");
  return !!(rereadable && !S.busy && api());
}

function confLiveClear(redraw = true) {
  clearTimeout(CONF.timer);
  CONF.seq++;
  Object.assign(CONF, { percent: null, points: null, added: [], removed: new Set() });
  renderConfLive();
  if (redraw && S.result) drawTrace();
}

function confLiveSchedule() {
  clearTimeout(CONF.timer);
  const v = parseFloat($("confidence").value);
  if (!confLiveUsable() || !(v >= 0 && v <= 100)) { confLiveClear(); return; }
  CONF.timer = setTimeout(() => confLivePreview(v), 120);
}

async function confLivePreview(v) {
  const seq = ++CONF.seq;
  const reply = await api().confidence_preview(v);
  if (seq !== CONF.seq || !confLiveUsable()) return;
  if (!reply.ok) { confLiveClear(); return; }
  const now = S.result.points.map((p) => p.offset_ms);
  const next = reply.points.map((p) => p.offset_ms);
  const near = (a, list) => list.some((b) => Math.abs(a - b) < 1);
  Object.assign(CONF, {
    percent: v, points: reply.points,
    added: next.filter((o) => !near(o, now)).map((o) => o / 1000),
    removed: new Set(now.flatMap((o, i) => (near(o, next) ? [] : [i]))),
  });
  renderConfLive();
  drawTrace();
}

function confLines(n) {
  return n === 1 ? t("conf_line") : t("conf_lines", { n });
}

function renderConfLive() {
  const on = CONF.points !== null && confLiveUsable();
  $("confLive").hidden = !on;
  $("scrim").classList.toggle("see-through", on);
  if (!on) return;
  const same = !CONF.added.length && !CONF.removed.size;
  $("confLiveText").textContent = same
    ? t("conf_live_same", { v: CONF.percent, lines: confLines(CONF.points.length) })
    : t("conf_live_diff", { v: CONF.percent, lines: confLines(CONF.points.length),
                            now: S.result.points.length });
  $("confLiveApply").disabled = same;
}

async function confLiveApply() {
  if (!confLiveUsable() || CONF.percent === null) return;
  const v = CONF.percent;
  const reply = await api().confidence_apply(v);
  if (!reply.ok) { editFailure(reply); return; }
  S.selected = -1;
  S.locks = reply.locks || [];
  S.options = { ...S.options, confidence: v };
  confLiveClear(false);
  showResult(reply.result);
  syncHistory(reply);
  toast(t("conf_applied", { v, lines: confLines(reply.result.points.length) }));
}

function markPreset() {
  const d = parseFloat($("delta").value), p = parseInt($("persistence").value, 10), c = parseFloat($("confidence").value);
  document.querySelectorAll("#presetSwitch button").forEach((b) => {
    const pr = S.presets[b.dataset.preset];
    b.classList.toggle("on", !!pr && +pr.delta === d && +pr.persistence === p && +pr.confidence === c);
  });
}

// ------------------------------------------------------------------ analysis flow
function setBusy(busy, message) {
  S.busy = busy;
  $("analyzeBtn").disabled = busy || !S.file;
  $("openBtn").disabled = busy;
  $("importBtn").disabled = busy;
  $("analyzeIcon").hidden = busy;
  $("analyzeSpin").hidden = !busy;
  $("analyzeText").textContent = t(busy ? "analyzing" : "analyze");
  $("progress").hidden = !busy;
  clearInterval(PROG.timer);
  if (busy) {
    confLiveClear();
    progressReset(message);
    PROG.timer = setInterval(renderProgress, 200);
  }
  syncActions();
  renderNeedSong();
}

// The running analysis, stage by stage: the engine announces each one as it
// begins, with what every earlier one took; the clocks run between events.
const PROG = { start: 0, stageStart: 0, began: false, stage: null, message: "", done: [], timer: 0, stopping: false };

function stageName(id, message) {
  return id ? t(`stage_${id}`) : String(message || "").replace(/…$/, "");
}

function progressReset(message) {
  const now = performance.now();
  Object.assign(PROG, { start: now, stageStart: now, began: false, stage: null,
                        message: message || "", done: [], stopping: false });
  renderProgress();
}

function renderProgress() {
  const now = performance.now(), secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
  // Before the first stage the line says what is being read (a dropped file's name).
  const current = PROG.began
    ? `${stageName(PROG.stage, PROG.message)}… ${secs(now - PROG.stageStart)}` : PROG.message;
  $("progressText").textContent = PROG.stopping ? [t("stopping"), current].filter(Boolean).join(" · ") : current;
  $("progressText").title = PROG.began ? PROG.message : "";
  $("progressStages").innerHTML = PROG.done.map((s) =>
    `<span class="stage" title="${esc(s.message)}">✓ ${esc(stageName(s.stage, s.message))} <span class="num">${s.seconds.toFixed(1)} s</span></span>`).join("");
  $("progressClock").textContent = secs(now - PROG.start);
  $("stopBtn").disabled = PROG.stopping;
  $("stopBtn").title = t("stop_hint");
}

async function stopAnalysis() {
  if (!api() || !S.busy || PROG.stopping) return;
  PROG.stopping = true;
  renderProgress();
  const reply = await api().stop_analysis();
  // Not running: a dropped file still being read, or the analysis ended as
  // the click travelled (its own event says how). Either way, nothing stops.
  if (!reply.ok) { PROG.stopping = false; renderProgress(); }
}

// How long the analysis on screen took, for the song panel.
function timingSummary(tm) {
  if (!tm) return "—";
  return tm.cached ? t("d_timing_cached", { s: tm.total_s.toFixed(2) }) : `${tm.total_s.toFixed(1)} s`;
}

function timingStages(tm) {
  if (!tm || tm.cached || !tm.stages.length) return "";
  return tm.stages.map((s) => `${esc(stageName(s.stage, s.message))} ${s.seconds.toFixed(1)}`).join(" · ") + " s";
}

function syncActions() {
  const on = !!S.result && !S.busy;
  ["copyOsuBtn", "copyQuaBtn", "copySmBtn", "csvBtn", "clickBtn", "oszBtn", "injectBtn", "cmpPick", "alignPick", "denPick", "snapPick", "rsPick", "refPick", "refFind", "asFit", "rpPick", "rpCopy"].forEach((id) => { $(id).disabled = !on; });
  if (!on) {
    $("undoBtn").disabled = true;
    $("redoBtn").disabled = true;
  } else {
    syncHistory();
  }
}

async function syncHistory(known) {
  const st = known || (api() ? await api().history_state() : { undo: false, redo: false });
  const off = !S.result || S.busy;
  $("undoBtn").disabled = off || !st.undo;
  $("redoBtn").disabled = off || !st.redo;
}

async function undo() {
  if (!api() || !S.result || S.busy) return;
  const keep = S.selected;
  const reply = await api().undo();
  if (!reply.ok) { editFailure(reply); return; }
  S.selected = Math.min(keep, reply.result.points.length - 1);
  S.locks = reply.locks || [];
  showResult(reply.result);
  syncHistory(reply);
  songPulseShown(reply.pulse);
  toast(t("undone"));
}

async function redo() {
  if (!api() || !S.result || S.busy) return;
  const keep = S.selected;
  const reply = await api().redo();
  if (!reply.ok) { editFailure(reply); return; }
  S.selected = Math.min(keep, reply.result.points.length - 1);
  S.locks = reply.locks || [];
  showResult(reply.result);
  syncHistory(reply);
  songPulseShown(reply.pulse);
  toast(t("redone"));
}

async function syncLocks() {
  if (!api() || !S.result) { S.locks = []; return; }
  try {
    S.locks = (await api().locks()).locks || [];
  } catch (err) {
    S.locks = [];
  }
  renderResult(S.result);
}

async function analyze() {
  if (!S.file || S.busy || !api()) return;
  const options = readOptions();
  if (!options) { toast(t("bad_values"), true); return; }
  setBusy(true, "");
  const reply = await api().analyze(S.file.path, options);
  if (!reply.ok) { setBusy(false); toast(t(reply.key, { detail: reply.detail || "" }), true); }
}

async function openAudio() {
  if (!api() || S.busy) return;
  const info = await api().pick_audio();
  if (info) setFile(info);
}

async function importFolder() {
  if (!api() || S.busy) return;
  const folder = await api().pick_folder();
  if (folder) await importFolderPath(folder);
}

async function importFolderPath(folder) {
  if (!api() || S.busy) return;
  const reply = await api().import_folder(folder);
  if (!reply.ok) {
    toast(reply.key === "error" ? t("error", { detail: reply.detail || "" }) : t(reply.key), true);
    return;
  }
  S.lastFolder = reply.folder;
  // The difficulties it lists are the Mapset view's input: check them now,
  // quietly, so the view is ready when the user opens it.
  runMapset(reply.folder, true);
  if (reply.file) {
    setFile(reply.file);
    refreshRecents();
    toast(t("imported", { audio: reply.file.name, n: reply.beatmaps.length,
                          difficulties: t("difficulties") }));
  } else {
    toast(t("no_audio"), true);
  }
}

// The pulse the song keeps after a ×2/÷2 or its undo, shown in the drawer:
// the next Analyze lands on the octave on screen.
function songPulseShown(pulse) {
  if (typeof pulse !== "string") return;
  document.querySelectorAll("#pulseSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.pulse === pulse));
  S.options = { ...S.options, pulse };
}

async function rescale(mult) {
  if (!api() || S.busy) return;
  const reply = await api().rescale(mult);
  if (!reply.ok) { toast(t(reply.key, { detail: reply.detail || "" }), true); return; }
  S.selected = -1;
  S.locks = reply.locks || [];
  showResult(reply.result);
  syncHistory(reply);
  songPulseShown(reply.pulse);
  toast(t("rescaled", { f: reply.result.subdivision, n: reply.result.points.length, bpm: reply.result.global_bpm.toFixed(2) }));
}

window.overtone = {
  onProgress(info) {
    const now = performance.now();
    Object.assign(PROG, { began: true, stage: info.stage || null, message: info.message || "",
                          stageStart: now, done: info.done || [] });
    // The bridge's clock is the truth; the page's only runs between events.
    if (info.elapsed_s !== undefined) PROG.start = now - info.elapsed_s * 1000;
    renderProgress();
  },
  onStopped(timings) {
    S.pendingDrop = null;
    setBusy(false);
    const s = ((timings && timings.total_s) || 0).toFixed(1);
    toast(t(S.result ? "analysis_stopped_kept" : "analysis_stopped", { s }));
  },
  onLibraryProgress(progress) { SONGS.progress = progress; renderSongs(); },
  onResult(result) {
    setBusy(false);
    // A dragged file has no remembered entry yet: the staged copy Python
    // analysed becomes the current song, so the header names it.
    if (S.pendingDrop) {
      setFile({ path: result.path, name: result.source, folder: result.source,
                size_mb: S.pendingDrop.size_mb, exists: true });
      S.pendingDrop = null;
    }
    S.selected = -1;
    S.timings = null;
    showResult(result);
    // A finished analysis lands on Timing, unless the user is already on a
    // view that was waiting for it (Map check, Export): that one fills in.
    if (!needsResult(S.view)) setView("timing");
    syncHistory();
    syncLocks();
    refreshRecents();
    api().analysis_timings().then((reply) => {
      S.timings = reply && reply.ok ? reply : null;
      if (S.selected < 0) renderDetail();
    });
    projectCheck();
    toast(t("done", { n: result.points.length, bpm: result.global_bpm.toFixed(2) }));
  },
  onError(detail) { S.pendingDrop = null; setBusy(false); toast(t("error", { detail }), true); },
};

// ------------------------------------------------------------------ rendering
function fmtTime(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(r < 10 && s < 60 ? 1 : 0)}`;
}
function mmss(s) { const m = Math.floor(s / 60), r = Math.round(s - m * 60); return `${m}:${String(r).padStart(2, "0")}`; }

function showResult(result) {
  const sameSong = !!S.result && S.result.path === result.path;
  // A new point list (analysis, edit, undo) is not the one a trial was read against.
  if (CONF.points !== null) confLiveClear(false);
  S.result = result;
  S.compare = null;  // these cards belong to one map and one point list
  S.align = null;
  S.density = null;
  S.snap = null;
  // A grade depends on the map and the song's attacks, not on the point list:
  // it stays through edits and goes with the song.
  if (!sameSong) { S.ref = null; S.refFind = null; S.assist = null; S.report = null; RA.report = null; labCancel(); pbReset(); hsMaps(); WARN.open.clear(); WARN.all = false; }
  if (!sameSong) { STX.view = null; STX.file = ""; STX.error = null; }
  if (!sameSong) S.comparePath = null;  // a map belongs to one song
  setView(S.view);  // lifts the "analyze first" panel off the current view
  syncActions();
  renderResult(result);
  // Same song, new point list (edit, undo, redo, pulse): recompare so the
  // suggestions stay current instead of vanishing until the map is re-picked.
  if (S.comparePath) refreshCompare();
}

// ------------------------------------------------------------------ warnings
// One banner per kind of finding, not per finding: a song with many timing
// points used to bury the view under a banner for every short section. A kind
// that repeats says how many, and lists them as points to jump to, folded.
// Past a few kinds, the rest fold too.
const WARN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`;
const WARN_ITEM = {
  v_short_section: (v) => `#${v.n} · ${t("warn_beats", { beats: v.beats })}`,
  v_octave_check: (v) => `#${v.n} · ${v.from} → ${v.to}`,
  v_impossible_change: (v) => `#${v.n} · ${v.from} → ${v.to}`,
  v_dup_points: (v) => `#${v.n} · ${v.gap} ms`,
  v_negative_offset: (v) => `#${v.n} · ${v.ms} ms`,
  v_past_end: (v) => `#${v.n} · ${v.ms} ms`,
  v_bad_number: (v) => `#${v.n}`,
};
const WARN_SHOWN = 3;
const WARN = { open: new Set(), all: false };

function renderWarnings(list) {
  const groups = new Map();
  for (const w of list) {
    if (!groups.has(w.key)) groups.set(w.key, []);
    groups.get(w.key).push(w);
  }
  const banners = [...groups].map(([key, ws]) => {
    const info = ws.every((w) => w.level === "info") ? "info" : "";
    if (ws.length === 1 || !WARN_ITEM[key]) {
      return ws.map((w) => `<div class="banner ${w.level === "info" ? "info" : ""}">${WARN_ICON}<div>${t(w.key, w.values)}</div></div>`).join("");
    }
    const open = WARN.open.has(key);
    const items = ws.map((w) => `<button type="button" class="chip" data-point="${(w.values.n ?? 0) - 1}"
        title="${esc(t(w.key, w.values))}">${esc(WARN_ITEM[key](w.values))}</button>`).join("");
    return `<div class="banner ${info}">${WARN_ICON}<div class="banner-text">
        <div>${t("g_" + key, { count: ws.length })} <button type="button" class="link" data-warn="${key}">${t(open ? "warn_hide" : "warn_show")}</button></div>
        ${open ? `<div class="chips">${items}</div>` : ""}</div></div>`;
  });
  const hidden = banners.length - WARN_SHOWN;
  const shown = WARN.all || hidden <= 1 ? banners : banners.slice(0, WARN_SHOWN);
  $("warnings").innerHTML = shown.join("") + (hidden > 1
    ? `<button type="button" class="link warn-more" data-warn-all>${WARN.all ? t("warn_fewer") : t("warn_more", { n: hidden })}</button>` : "");
}

// The song's saved timing work (roadmap 14.1), offered back after an
// analysis when it is not what the analysis gave; kept until a choice.
const PROJECT = { state: null };

async function projectCheck() {
  PROJECT.state = null;
  const reply = await api().project_state();
  PROJECT.state = reply && reply.ok && reply.exists && reply.differs ? reply : null;
  renderProjectOffer();
}

function renderProjectOffer() {
  const box = $("projectOffer"), st = PROJECT.state;
  box.hidden = !st;
  box.innerHTML = !st ? "" : `<div class="banner info">${WARN_ICON}<div class="banner-text">
      <div>${t(st.locks ? "project_offer_locks" : "project_offer", { when: esc(when(st.saved_at)), n: st.points, locks: st.locks })}</div>
      <div class="banner-actions">
        <button type="button" class="btn small primary" data-project="restore">${t("project_restore")}</button>
        <button type="button" class="btn small" data-project="keep">${t("project_keep")}</button>
      </div></div></div>`;
}

async function projectAction(action) {
  if (action === "restore") {
    const reply = await api().project_restore();
    if (!reply.ok) { editFailure(reply); return; }
    S.locks = reply.locks || [];
    showEditResult(reply, t("project_restored", { n: reply.result.points.length }));
  }
  PROJECT.state = null;
  renderProjectOffer();
}

function renderResult(r) {
  const precise = r.engine === "precision", stable = r.stability >= 0.75;
  $("statGlobal").textContent = r.global_bpm.toFixed(2);
  $("statPoints").innerHTML = `${r.points.length}<small>${r.meter}</small>`;
  $("statBeats").innerHTML = `${r.beat_count}<small>${mmss(r.duration)}</small>`;
  $("statStability").innerHTML = `${Math.round(r.stability * 100)}<small>% ${t(stable ? "constant" : "variable")}</small>`;
  $("statEngine").innerHTML = `<span class="pill ${precise ? "accent" : "amber"}">${t(precise ? "engine_precision" : "engine_legacy")}</span>`
    + (precise ? `<span class="pill">${r.residual_ms.toFixed(2)} ms</span>` : "");
  renderSong();

  renderWarnings(r.warnings);

  $("tableCount").textContent = t("points_n", { n: r.points.length });
  $("rows").innerHTML = r.points.map((p, i) => {
    const c = p.confidence, cls = c >= 0.9 ? "" : c >= 0.75 ? "mid" : "low";
    const locked = (S.locks || []).includes(p.offset_ms);
    return `<tr data-i="${i}" class="${i === S.selected ? "sel" : ""}${locked ? " locked" : ""}">
      <td><span class="idx">${i + 1}</span></td>
      <td class="num">${p.offset_ms.toFixed(1)}</td>
      <td class="num">${p.bpm.toFixed(3)}</td>
      <td class="num">${p.beat_ms.toFixed(2)}</td>
      <td><span class="pill ${p.meter_known ? "accent" : ""}" title="${t(p.meter_known ? "meter_known" : "meter_guess")}">${p.meter}/4</span></td>
      <td><span class="conf ${cls}"><span class="bar"><b style="width:${Math.round(c * 100)}%"></b></span><span class="num">${Math.round(c * 100)}%</span></span></td>
    </tr>`;
  }).join("");
  renderDetail();
  drawTrace();
  renderCompare();
  renderAlign();
  renderDensity();
  renderSnap();
  renderResnap();
  renderRef();
  renderAssist();
  renderRamps();
  renderReport();
  renderTaps();
  renderBookmarks();
  renderKiai();
  renderBreaks();
  renderVolumes();
  renderInjectAll();
  renderSv();
  renderDivisors();
  renderSwing();
  renderPulseHints();
  if (S.view === "timing") waveLoad();
  evLoad();
  labLoad();
}

function renderDetail() {
  const r = S.result, el = $("detail");
  if (!r) return;
  const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join("")}</dl>`;
  if (S.selected < 0 || S.selected >= r.points.length) {
    const firstBeat = r.trace.t.length ? fmtTime(r.trace.t[0]) : "—";
    el.innerHTML = `
      <div class="detail-head"><div class="card-title">${t("d_song")}</div></div>
      <div class="detail-big">${r.global_bpm.toFixed(2)}<small>BPM</small></div>
      ${kv([[t("d_duration"), mmss(r.duration)], [t("d_first"), firstBeat],
            [t("d_engine"), `${t(r.engine === "precision" ? "engine_precision" : "engine_legacy")} · ${t(r.backend === "rust" ? "backend_rust" : "backend_python")}`],
            [t("d_residual"), r.engine === "precision" ? `${r.residual_ms.toFixed(2)} ms` : "—"],
            [t("d_sections"), r.sections.length || "—"], [t("d_pulse"), `×${r.subdivision}`],
            [t("d_timing"), timingSummary(S.timings)]])}
      ${timingStages(S.timings) ? `<div class="detail-note num">${timingStages(S.timings)}</div>` : ""}
      <div class="detail-note">${t("d_hint")}</div>`;
    return;
  }
  const p = r.points[S.selected], next = r.points[S.selected + 1];
  const start = p.offset_ms / 1000, end = next ? next.offset_ms / 1000 : r.duration;
  const bars = p.beat_ms > 0 ? Math.floor(((end - start) * 1000) / (p.beat_ms * p.meter)) : 0;
  const c = Math.round(p.confidence * 100);
  const locked = (S.locks || []).includes(p.offset_ms);
  el.innerHTML = `
    <div class="detail-head">
      <span class="idx">${S.selected + 1}</span>
      <div class="card-title">${t("d_point")}</div>
      <div class="spacer"></div>
      ${locked ? `<span class="pill accent">${t("locked_pill")}</span>` : ""}
      <span class="pill ${p.meter_known ? "accent" : ""}">${p.meter}/4</span>
    </div>
    <div class="detail-big">${p.bpm.toFixed(3)}<small>BPM</small></div>
    ${kv([[t("d_offset"), `${p.offset_ms.toFixed(1)} ms`], [t("d_beat"), `${p.beat_ms.toFixed(3)} ms`],
          [t("d_conf"), `${c}%`],
          [t("d_span"), `${fmtTime(start)} → ${next ? fmtTime(end) : t("d_end")}`],
          ["", t("d_bars", { n: bars })]])}
    <div class="editor">
      <div class="grid-2">
        <div class="field"><label>${t("e_offset")}</label>
          <input class="input num" id="editOffset" type="number" step="0.1" value="${p.offset_ms.toFixed(1)}"></div>
        <div class="field"><label>${t("e_bpm")}</label>
          <input class="input num" id="editBpm" type="number" step="0.001" value="${p.bpm.toFixed(3)}"></div>
      </div>
      <div class="editor-row">
        <button class="btn small primary" data-action="apply">${t("e_apply")}</button>
        <button class="btn small" data-action="add">${t("e_add")}</button>
        <button class="btn small" data-action="delete">${t("e_delete")}</button>
      </div>
      <div class="editor-row">
        <button class="btn small" data-action="nudge--5">−5 ms</button>
        <button class="btn small" data-action="nudge--1">−1 ms</button>
        <button class="btn small" data-action="nudge-1">+1 ms</button>
        <button class="btn small" data-action="nudge-5">+5 ms</button>
        <button class="btn small" data-action="half-s">÷2 §</button>
        <button class="btn small" data-action="double-s">×2 §</button>
      </div>
      <div class="editor-row">
        <label class="editor-label" for="editMeter">${t("e_meter")}</label>
        <select class="input small editor-meter" id="editMeter" title="${t("e_meter_hint")}">
          ${Array.from({ length: 16 }, (_, k) => k + 1).map((m) => `<option value="${m}" ${m === p.meter ? "selected" : ""}>${m}/4</option>`).join("")}
        </select>
      </div>
      <div class="editor-row">
        <button class="btn small" data-action="split" title="${t("e_split_hint")}">${t("e_split")}</button>
        <button class="btn small" data-action="merge" title="${t("e_merge_hint")}" ${next ? "" : "disabled"}>${t("e_merge")}</button>
      </div>
      <div class="editor-row">
        <button class="btn small" data-action="lock">${t(locked ? "unlock" : "lock")}</button>
      </div>
    </div>
    <div class="detail-note">${t(locked ? "locked_note" : (p.meter_known ? "d_meter_known" : "d_meter_guess"))}</div>`;
}

// ------------------------------------------------------------------ point editing
function editFailure(reply) {
  toast(reply.key === "error" ? t("error", { detail: reply.detail || "" }) : t(reply.key), true);
}

function showEditResult(reply, message) {
  if (reply.selected !== undefined) S.selected = reply.selected;
  showResult(reply.result);
  syncHistory(reply);
  toast(message);
}

async function editAction(action) {
  if (!api() || S.busy || !S.result) return;
  const sel = S.selected;
  const num = (id) => parseFloat($(id) && $(id).value);
  let reply = null, message = null;
  if (action === "apply" || action === "add") {
    if (action === "apply" && sel < 0) { toast(t("no_selection"), true); return; }
    reply = action === "apply"
      ? await api().edit_apply(sel, num("editOffset"), num("editBpm"))
      : await api().edit_add(num("editOffset"), num("editBpm"));
    if (reply.ok) {
      const q = reply.result.points[reply.selected];
      message = action === "apply"
        ? t("edited", { n: reply.selected + 1, bpm: q.bpm.toFixed(3), ms: q.offset_ms.toFixed(1) })
        : t("added", { bpm: q.bpm.toFixed(2), ms: q.offset_ms.toFixed(1) });
    }
  } else if (action === "delete") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    reply = await api().edit_delete(sel);
    if (reply.ok) message = t("deleted", { n: sel + 1 });
  } else if (action.startsWith("nudge")) {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    reply = await api().edit_nudge(sel, parseFloat(action.replace("nudge-", "")));
    if (reply.ok) {
      const q = reply.result.points[reply.selected];
      message = t("edited", { n: reply.selected + 1, bpm: q.bpm.toFixed(3), ms: q.offset_ms.toFixed(1) });
    }
  } else if (action === "half-s" || action === "double-s") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    reply = await api().edit_rescale(sel, action === "half-s" ? 0.5 : 2);
    if (reply.ok) {
      const q = reply.result.points[reply.selected];
      message = t("section_rescaled", { n: reply.selected + 1, bpm: q.bpm.toFixed(2) });
    }
  } else if (action === "split" || action === "merge") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    // Each refitted section in words: the BPM its attacks keep and how much of
    // their weight the grid explains, or why the BPM stayed.
    const refit = (s) => t(s.kept ? `refit_kept_${s.kept}` : "refit_bpm",
      { bpm: s.bpm.toFixed(3), share: s.share == null ? "" : Math.round(s.share * 100) });
    if (action === "split") {
      const p = S.result.points[sel], next = S.result.points[sel + 1];
      const at = pbPosition() * 1000, stop = next ? next.offset_ms : S.result.duration * 1000;
      if (!(at > p.offset_ms && at < stop)) { toast(t("split_outside"), true); return; }
      reply = await api().edit_split(sel, at);
      if (reply.ok) {
        const [a, b] = reply.report.sections;
        message = t("split_done", { time: fmtTime(reply.report.split_ms / 1000), first: refit(a), second: refit(b) });
      }
    } else {
      reply = await api().edit_merge(sel);
      if (reply.ok) message = t("merged_done", { first: refit(reply.report.sections[0]) });
    }
  } else if (action === "meter") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    const meter = parseInt($("editMeter").value, 10);
    reply = await api().edit_meter(sel, meter);
    if (reply.ok) message = t("meter_set", { n: sel + 1, m: meter });
  } else if (action === "lock") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    const off = S.result.points[sel].offset_ms;
    reply = await api().set_locked(sel, !(S.locks || []).includes(off));
    if (reply.ok) message = t(reply.locked ? "locked_on" : "locked_off", { n: sel + 1 });
  }
  if (!reply) return;
  if (!reply.ok) {
    if (reply.key === "locked") toast(t("point_locked", { n: (reply.index ?? sel) + 1 }), true);
    else editFailure(reply);
    return;
  }
  if (reply.locks !== undefined) S.locks = reply.locks;
  showEditResult(reply, message);
}

// ------------------------------------------------------------------ exports + inject
async function copyOsu() {
  if (!api() || !S.result) return;
  const reply = await api().osu_text();
  if (!reply.ok) { editFailure(reply); return; }
  copyText(reply.text, "copied");
}

// The same timing for Quaver and StepMania. The reply carries what the
// engine found by reading its own text back, and that goes on screen beside
// the button: this app cannot open either game, so the one thing it can say
// is how far the written grid sits from the one it just showed.
async function copyOtherGame(game) {
  if (!api() || !S.result) return;
  const reply = await api().other_game_text(game);
  const where = $(game === "quaver" ? "quaCheck" : "smCheck");
  if (!reply.ok) { where.textContent = ""; editFailure(reply); return; }
  const c = reply.check;
  where.textContent = c.ok
    ? t("exp_game_ok", { lines: c.lines, ms: c.worst_ms.toFixed(3) })
    : t("exp_game_off", { lines: c.lines });
  where.classList.toggle("warn-text", !c.ok);
  copyText(reply.text, "copied");
}

async function copyText(text, doneKey) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t(doneKey));
    return;
  } catch (err) {
    // A local file page may not get the async clipboard; the legacy path works.
    const box = document.createElement("textarea");
    box.value = text;
    document.body.appendChild(box);
    box.select();
    try {
      if (!document.execCommand("copy")) throw new Error("execCommand");
      toast(t(doneKey));
    } catch (err2) {
      toast(t("clipboard_failed", { detail: String((err2 && err2.message) || err) }), true);
    }
    box.remove();
  }
}

async function saveAs(kind) {
  if (!api() || !S.result || S.busy) return;
  const reply = await api()[kind]();
  if (!reply.ok) {
    if (reply.key === "cancelled") return;  // closed the dialog: silence, not an error
    editFailure(reply);
    return;
  }
  // A .osz says what it named the song, and where the name came from.
  const meta = reply.metadata;
  const named = meta && meta.from !== "none" && meta.from !== "given"
    ? " · " + t(`osz_named_${meta.from}`, { artist: meta.artist_unicode, title: meta.title_unicode }) : "";
  toast(t("saved_to", { path: reply.path }) + named);
}

async function injectOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const prev = await api().inject_preview(target);
  if (!prev.ok) { editFailure(prev); return; }
  const s = prev.summary;
  const warn = (s.audio_mismatch ? t("inject_warn", { osu: s.osu_audio, src: s.analysed_audio }) : "")
    + (s.greens_added ? t("inject_greens", { g: s.greens_added }) : "")
    + injectDiffText((prev.diff && prev.diff.pairs) || []);
  const name = String(target).split(/[\\/]/).pop();
  if (!confirm(t("inject_confirm", { reds: s.reds_replaced, n: s.reds_added, file: name, warn }))) return;
  const done = await api().inject_apply(target);
  if (!done.ok) { editFailure(done); return; }
  const d = done.summary;
  toast(t("injected", { added: d.reds_added, replaced: d.reds_replaced, greens: d.greens_kept }));
}

// Changed red lines as confirm-dialog lines: the first 10, then a count.
function injectDiffText(pairs) {
  const moved = (p) => p.delta_offset_ms || p.delta_bpm || (p.drift_end_ms !== null && p.drift_end_ms);
  const changed = pairs.filter(moved), same = pairs.length - changed.length;
  const lines = changed.slice(0, 10).map((p) => {
    const base = t("inject_diff_line", { o: p.old.offset_ms, ob: p.old.bpm, n: p.new.offset_ms, nb: p.new.bpm });
    return p.drift_end_ms === null ? base : base + t("inject_diff_drift", { d: p.drift_end_ms });
  });
  if (changed.length > 10) lines.push(t("inject_diff_more", { n: changed.length - 10 }));
  if (same) lines.push(t("inject_diff_same", { n: same }));
  return lines.length ? "\n" + lines.join("\n") : "";
}

// ------------------------------------------------------------------ inject all
// Phase 21: the same inject over every .osu beside the analyzed song.
// Preview lists each file, one confirmation writes them all, each backed up.
const INJALL = { preview: null, for: "" };

function injectAllRow(f) {
  if (!f.ok) return t("inject_all_error", { file: f.file, detail: f.error });
  const greens = f.greens_added ? t("inject_all_row_greens", { g: f.greens_added }) : "";
  const warn = f.audio_mismatch ? t("inject_all_row_mismatch") : "";
  const pairs = (f.diff && f.diff.pairs) || [];
  const drifts = pairs.map((p) => p.drift_end_ms).filter((d) => d !== null && d);
  const worst = drifts.length ? drifts.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b) : null;
  const drift = worst === null ? "" : t("inject_all_row_drift", { d: worst });
  return t("inject_all_row", { file: f.file, replaced: f.reds_replaced, added: f.reds_added }) + greens + warn + drift;
}

async function injectAllPreview() {
  if (!api() || !S.result || S.busy) return;
  const reply = await api().inject_all_preview();
  if (!reply.ok) { editFailure(reply); return; }
  INJALL.preview = reply.report;
  INJALL.for = (S.result && S.result.path) || "";
  renderInjectAll();
}

async function injectAllApply() {
  if (!api() || !S.result || S.busy || !INJALL.preview) return;
  const r = INJALL.preview;
  if (!r.ok) { toast(t("inject_all_nothing")); return; }
  const good = r.files.filter((f) => f.ok);
  const warn = r.files.some((f) => f.ok && f.audio_mismatch) ? t("inject_all_warn") : "";
  if (!confirm(t("inject_all_confirm", { n: good.length, files: good.map((f) => f.file).join(", "), warn }))) return;
  const done = await api().inject_all_apply();
  if (!done.ok) { editFailure(done); return; }
  toast(t("inject_all_done", { n: done.report.ok, f: done.report.failed }));
  INJALL.preview = null;
  renderInjectAll();
}

function renderInjectAll() {
  const path = (S.result && S.result.path) || "";
  if (INJALL.for !== path) { INJALL.for = path; INJALL.preview = null; }
  const p = INJALL.preview;
  if ($("injectAllBtn")) $("injectAllBtn").disabled = !S.result || !p || !p.ok;
  if ($("injectAllResult")) $("injectAllResult").textContent = !p ? ""
    : p.files.map(injectAllRow).join(" · ");
}

// ------------------------------------------------------------------ drag and drop
// The File API hides local paths on purpose, so a drop cannot reuse analyze():
// the bytes travel as base64 and Python stages them before analysing.
let dragDepth = 0;

function hasFiles(e) {
  return [...(e.dataTransfer ? e.dataTransfer.types : [])].some((k) => String(k).toLowerCase() === "files");
}

const AUDIO_EXT = /\.(wav|flac|ogg|mp3|m4a|aac|opus|aiff?)$/i;

function renderRecents() {
  const box = $("recents"), list = $("recentList");
  box.hidden = !S.recent.length;
  list.innerHTML = S.recent.map((f, i) => `
    <button class="recent-item" data-recent="${i}" title="${f.path.replaceAll('"', "")}">
      <span class="name">${f.name}</span>
      <span class="meta num">${f.size_mb} MB</span>
    </button>`).join("");
}

async function refreshRecents() {
  if (!api()) return;
  try {
    S.recent = (await api().state()).recent || [];
  } catch (err) {
    S.recent = [];
  }
  renderRecents();
}

// ------------------------------------------------------------------ songs browser
// The library index (overtone_library.py) answers as you type. A scan brings
// it in step with the Songs folder; only the first one reads every header.
const SONGS = { state: null, result: null, query: "", timer: 0, scanning: false, progress: null, asked: 0 };

function when(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !isNaN(date) ? date.toLocaleString(S.lang, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

async function songsLoad() {
  if (!api()) return;
  // A failed reply is kept too: its key and the folder facts are what the
  // info line says, where it used to go blank.
  SONGS.state = await api().library_state();
  if (SONGS.state.ok && SONGS.state.index.beatmaps) await songsSearch();
  else renderSongs();
}

async function songsSearch() {
  // Searches overlap once one takes longer than the typing pause, and
  // replies can land out of order: only the latest one is drawn.
  const asked = ++SONGS.asked;
  const reply = await api().library_search(SONGS.query);
  if (asked !== SONGS.asked) return;
  if (!reply.ok && reply.key === "library_damaged") SONGS.state = { ...(SONGS.state || {}), ...reply };
  else if (!reply.ok) toast(t("error", { detail: reply.detail || "" }), true);
  SONGS.result = reply.ok ? reply.result : null;
  renderSongs();
}

async function songsScan(folder = "") {
  if (!api() || SONGS.scanning) return;
  SONGS.scanning = true;
  SONGS.progress = null;
  renderSongs();
  let reply;
  try {
    reply = await api().library_scan(folder);
  } finally {
    SONGS.scanning = false;
  }
  if (!reply.ok && reply.key === "no_songs") {
    toast(t("no_songs"));
    const picked = await api().pick_folder();
    if (picked) { songsScan(picked); return; }
  } else if (!reply.ok) {
    toast(reply.key === "error" ? t("error", { detail: reply.detail || "" }) : t(reply.key), true);
  } else {
    const r = reply.report;
    toast((r.rebuilt ? t("songs_rebuilt") + " " : "")
          + t(r.failed ? "songs_scanned_failed" : "songs_scanned",
              { n: r.beatmaps, s: r.sets, changed: r.added + r.updated, removed: r.removed,
                failed: r.failed, sec: r.seconds.toFixed(1) }));
  }
  await songsLoad();
}

async function songsPick() {
  if (!api() || SONGS.scanning) return;
  const folder = await api().pick_folder();
  if (folder) songsScan(folder);
}

function songBpm(set) {
  const bpms = set.beatmaps.map((b) => b.first_bpm).filter((v) => v !== null);
  if (!bpms.length) return "";
  const lo = Math.round(Math.min(...bpms)), hi = Math.round(Math.max(...bpms));
  return ` · ${lo === hi ? lo : `${lo}–${hi}`} BPM`;
}

function renderSongs() {
  const st = SONGS.state, ok = !!(st && st.ok), idx = ok ? st.index : null;
  const indexed = !!(idx && idx.beatmaps), damaged = !!(st && st.key === "library_damaged");
  $("songsQuery").placeholder = t("songs_search");
  $("songsQuery").hidden = !indexed;
  $("songsScanText").textContent = t(SONGS.scanning ? "songs_scanning" : indexed || damaged ? "songs_rescan" : "songs_scan");
  $("songsScan").disabled = SONGS.scanning;
  $("songsPick").disabled = SONGS.scanning;
  let info = "", tip = "";
  const p = SONGS.progress;
  if (SONGS.scanning) {
    info = !p ? t("songs_listing") : p.removing ? t("songs_removing", { n: p.removing }) : t("songs_progress", p);
  } else if (st && !ok) {
    info = damaged ? t("library_damaged") : t("error", { detail: esc(st.detail || "") });
  } else if (st && !indexed) {
    // Scanned and empty is not "not indexed yet".
    info = !st.songs_found ? t("songs_missing", { root: esc(st.songs) })
      : idx.scanned_at && st.current ? t("songs_empty", { root: esc(st.songs), when: esc(when(idx.scanned_at)) })
      : t("songs_none", { root: esc(st.songs) });
  } else if (st) {
    info = t(st.current && !st.songs_found ? "songs_gone" : st.current ? "songs_info" : "songs_other",
             { n: idx.beatmaps, s: idx.sets, when: esc(when(idx.scanned_at)), root: esc(idx.root) });
  }
  if (!SONGS.scanning && idx && idx.failed) {
    info += ` · ${t("songs_failed", { n: idx.failed })}`;
    // A reason that already names its file ("x.osu is empty…") is not prefixed again.
    tip = idx.failures.map((f) => {
      const name = f.path.split(/[\\/]/).pop();
      return f.detail.includes(name) ? f.detail : `${name}: ${f.detail}`;
    }).join("\n")
      + (idx.failed > idx.failures.length ? "\n…" : "");
  }
  $("songsInfo").innerHTML = info;
  $("songsInfo").title = tip || $("songsInfo").textContent;
  const res = SONGS.result;
  if (!indexed || !res) { $("songsList").innerHTML = ""; return; }
  if (!res.sets.length) {
    $("songsList").innerHTML = `<div class="card-sub">${t("songs_nothing", { q: esc(res.query) })}</div>`;
    return;
  }
  $("songsList").innerHTML = res.sets.map((set, i) => {
    const unicode = [set.artist_unicode, set.title_unicode].filter(Boolean).join(" - ");
    return `
    <button class="recent-item" data-song="${i}" title="${esc(unicode || set.folder)}">
      <span>
        <span class="name">${esc(set.artist)} - ${esc(set.title)} <span class="muted">(${esc(set.creator)})</span></span>
        <span class="diffs">${set.beatmaps.map((b) => esc(b.version)).join(" · ")}</span>
      </span>
      <span class="meta num">${set.beatmaps.length} ${t(set.beatmaps.length === 1 ? "songs_diff" : "songs_diffs")}${songBpm(set)}</span>
    </button>`;
  }).join("") + (res.limited ? `<div class="card-sub">${t("songs_limited", { n: res.beatmaps })}</div>` : "");
}

// ------------------------------------------------------------------ structure
// Phrases from the Rust engine (overtone-cli structure), snapped to this
// song's proven bar lines, every label beside the evidence it rests on.
const STX = { view: null, file: "", loading: false, error: null };
const STX_KIND = { intro: "stx_intro", verse: "stx_verse", chorus: "stx_chorus", bridge: "stx_bridge", outro: "stx_outro" };

async function stxLoad() {
  if (!api() || !S.result || STX.loading) return;
  STX.loading = true;
  renderStructure();
  let reply;
  try {
    reply = await api().structure();
  } finally {
    STX.loading = false;
  }
  STX.error = reply.ok ? null : reply;
  if (reply.ok) { STX.view = reply.view; STX.file = reply.file; }
  renderStructure();
}

function stxTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

function stxWhy(w) {
  switch (w.rule) {
    case "chorus_loudest":
      return w.over_db === null ? t("stx_why_chorus", { n: w.repeats })
        : t("stx_why_chorus_db", { n: w.repeats, db: w.over_db.toFixed(1) });
    case "verse_quieter": return t("stx_why_verse_quieter", { n: w.repeats, db: w.under_db.toFixed(1) });
    case "verse_one_family": return t("stx_why_verse_family", { n: w.repeats });
    case "verse_single": return t("stx_why_single");
    case "intro_first": return t("stx_why_intro", { s: w.length_s, max: w.max_s ?? 12 });
    case "outro_last": return t("stx_why_outro");
    default: return t("stx_why_bridge");
  }
}

function renderStructure() {
  const body = $("stxBody"), v = STX.view, pill = $("stxCount");
  $("stxFile").textContent = STX.file || "";
  pill.hidden = !(v && v.sections.length);
  if (STX.loading && !v) { body.innerHTML = `<div class="card-sub">${t("stx_loading")}</div>`; return; }
  if (STX.error) {
    body.innerHTML = `<div class="card-sub">${STX.error.key === "no_rust" ? t("stx_no_rust")
      : STX.error.key === "error" ? esc(t("error", { detail: STX.error.detail || "" })) : t(STX.error.key)}</div>`;
    return;
  }
  if (!v) { body.innerHTML = ""; return; }
  const edge = v.rules.edge_blind_s ?? 4;
  if (!v.sections.length) { body.innerHTML = `<div class="card-sub">${t("stx_none", { s: edge })}</div>`; return; }
  pill.textContent = t("stx_count", { n: v.sections.length });
  const dur = v.duration || 1, lane = v.lane.values;
  const x = (s) => (100 * s / dur).toFixed(3);
  const path = lane.length ? `M0,100 ${lane.map((e, i) => `L${x((i + 0.5) * v.lane.hop)},${(100 - 88 * e).toFixed(2)}`).join(" ")} L100,100 Z` : "";
  const blocks = v.sections.map((s, i) => `
    <div class="stx-sec k-${s.kind}" data-stx="${i}" style="left:${x(s.start_s)}%;width:${x(s.end_s - s.start_s)}%"
         title="${esc(`${s.group} · ${t(STX_KIND[s.kind])} · ${stxTime(s.start_s)}–${stxTime(s.end_s)}`)}">
      <span class="lbl">${esc(s.group)} · ${t(STX_KIND[s.kind])}</span>
    </div>`).join("");
  const moved = (s) => s.index === 0 ? "—"
    : s.moved_ms === null ? `<span class="muted">${t("stx_unsnapped", { s: v.snap_s })}</span>`
    : `${s.moved_ms > 0 ? "+" : ""}${Math.round(s.moved_ms)} ms`;
  const rows = v.sections.map((s, i) => `
    <tr data-stx="${i}">
      <td class="num">${stxTime(s.start_s)}</td>
      <td class="num">${s.bar ?? "—"}</td>
      <td class="num">${(s.end_s - s.start_s).toFixed(1)} s</td>
      <td><span class="stx-kind k-${s.kind}">${esc(s.group)} · ${t(STX_KIND[s.kind])}</span> <span class="muted num">${s.level_db.toFixed(1)} dB</span></td>
      <td class="why">${stxWhy(s.why)}</td>
      <td class="num">${moved(s)}</td>
    </tr>`).join("");
  body.innerHTML = `
    <div class="stx-lane"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="energy" d="${path}"/></svg>${blocks}</div>
    ${v.preview ? `<div class="card-sub mb-m">${t("stx_preview", { at: stxTime(v.preview.time_s), kind: t(STX_KIND[v.preview.kind]) })}</div>` : ""}
    ${v.one_family ? `<div class="card-sub mb-m">${t("stx_one_family")}</div>` : ""}
    <div class="table-scroll"><table class="stx-table">
      <thead><tr><th>${t("stx_h_start")}</th><th>${t("stx_h_bar")}</th><th>${t("stx_h_len")}</th><th>${t("stx_h_part")}</th><th>${t("stx_h_why")}</th><th>${t("stx_h_moved")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="card-sub mt-m">${t("stx_note", { snap: v.snap_s, edge, margin: v.phrase_margin_db })}</div>`;
}

// ------------------------------------------------------------------ bookmarks
// Phase 21: section starts as editor bookmarks in one difficulty of the song.
// The maps come from the transport picker; preview counts, apply merges with
// the map's own bookmarks under a backup, and the card refreshes.
const STXBM = { preview: null, for: "" };

async function stxBmMaps() {
  const box = $("stxBmMap");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  const path = (S.result && S.result.path) || "";
  if (STXBM.for !== path) { STXBM.for = path; STXBM.preview = null; }
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = !maps.length;
  renderBookmarks();
}

async function stxBmPreview() {
  if (!api() || !S.result) return;
  const file = $("stxBmMap").value;
  if (!file) return;
  const reply = await api().structure_bookmarks_preview(file);
  if (!reply.ok) { editFailure(reply); return; }
  STXBM.preview = { ...reply, file };
  renderBookmarks();
}

async function stxBmApply() {
  if (!api() || !S.result || !STXBM.preview) return;
  const file = $("stxBmMap").value;
  if (STXBM.preview.file !== file) { await stxBmPreview(); return; }
  if (!STXBM.preview.added) { toast(t("stx_bm_nothing", { file })); return; }
  if (!confirm(t("stx_bm_confirm", { n: STXBM.preview.added, file }))) return;
  const reply = await api().structure_bookmarks_apply(file);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("stx_bm_done", { n: reply.added, file }));
  STXBM.preview = null;
  renderBookmarks();
}

function renderBookmarks() {
  const card = $("stxBmCard"), p = STXBM.preview;
  card.hidden = !S.result;
  if (!S.result) return;
  $("stxBmApply").disabled = !p || !p.added;
  $("stxBmResult").textContent = !p ? ""
    : t("stx_bm_would", { added: p.added, total: p.total, file: p.file });
}

// ------------------------------------------------------------------ kiai
// Phase 21: kiai on the chorus sections in one difficulty of the song.
// The maps come from the transport picker; preview counts added, flipped
// and kept, apply writes green lines under a backup, and the card refreshes.
const STXK = { preview: null, for: "" };

async function stxKiaiMaps() {
  const box = $("stxKiaiMap");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  const path = (S.result && S.result.path) || "";
  if (STXK.for !== path) { STXK.for = path; STXK.preview = null; }
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = !maps.length;
  renderKiai();
}

async function stxKiaiPreview() {
  if (!api() || !S.result) return;
  const file = $("stxKiaiMap").value;
  if (!file) return;
  const reply = await api().structure_kiai_preview(file);
  if (!reply.ok) {
    if (reply.key === "no_chorus") { toast(t("stx_kiai_nochorus")); return; }
    editFailure(reply); return;
  }
  STXK.preview = { ...reply, file };
  renderKiai();
}

async function stxKiaiApply() {
  if (!api() || !S.result || !STXK.preview) return;
  const file = $("stxKiaiMap").value;
  if (STXK.preview.file !== file) { await stxKiaiPreview(); return; }
  if (!STXK.preview.added && !STXK.preview.flipped) { toast(t("stx_kiai_nothing", { file })); return; }
  if (!confirm(t("stx_kiai_confirm", { n: STXK.preview.choruses, file }))) return;
  const reply = await api().structure_kiai_apply(file);
  if (!reply.ok) {
    if (reply.key === "no_chorus") { toast(t("stx_kiai_nochorus")); return; }
    editFailure(reply); return;
  }
  toast(t("stx_kiai_done", { n: reply.choruses, file }));
  STXK.preview = null;
  renderKiai();
}

function renderKiai() {
  const card = $("stxKiaiCard"), p = STXK.preview;
  card.hidden = !S.result;
  if (!S.result) return;
  $("stxKiaiApply").disabled = !p || (!p.added && !p.flipped);
  $("stxKiaiResult").textContent = !p ? ""
    : t("stx_kiai_would", { added: p.added, flipped: p.flipped, kept: p.kept, n: p.choruses, file: p.file });
}

// ------------------------------------------------------------------ breaks
// Phase 21: breaks where the song goes quiet and the map goes silent, in one
// difficulty of the song. The maps come from the transport picker; preview
// lists the spans, apply writes 2,start,end lines under a backup.
const STXBR = { preview: null, for: "" };

function stxBrSpan(s) {
  return `${mmss(s.start_ms / 1000)}–${mmss(s.end_ms / 1000)} ${s.kind}`;
}

async function stxBreaksMaps() {
  const box = $("stxBreaksMap");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  const path = (S.result && S.result.path) || "";
  if (STXBR.for !== path) { STXBR.for = path; STXBR.preview = null; }
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = !maps.length;
  renderBreaks();
}

async function stxBreaksPreview() {
  if (!api() || !S.result) return;
  const file = $("stxBreaksMap").value;
  if (!file) return;
  const reply = await api().structure_breaks_preview(file);
  if (!reply.ok) { editFailure(reply); return; }
  STXBR.preview = { ...reply, file };
  if (!reply.spans.length) toast(t("stx_breaks_nothing"));
  renderBreaks();
}

async function stxBreaksApply() {
  if (!api() || !S.result || !STXBR.preview) return;
  const file = $("stxBreaksMap").value;
  if (STXBR.preview.file !== file) { await stxBreaksPreview(); return; }
  if (!STXBR.preview.spans.length) { toast(t("stx_breaks_nothing")); return; }
  if (!confirm(t("stx_breaks_confirm", { n: STXBR.preview.spans.length, file }))) return;
  const reply = await api().structure_breaks_apply(file);
  if (!reply.ok) {
    if (reply.key === "no_breaks") { toast(t("stx_breaks_nothing")); return; }
    editFailure(reply); return;
  }
  toast(t("stx_breaks_done", { n: reply.breaks, file }));
  STXBR.preview = null;
  renderBreaks();
}

function renderBreaks() {
  const card = $("stxBreaksCard"), p = STXBR.preview;
  card.hidden = !S.result;
  if (!S.result) return;
  $("stxBreaksApply").disabled = !p || !p.spans.length;
  // No span: the toast already said so, and "0 breaks into X: ." said nothing.
  $("stxBreaksResult").textContent = !p ? ""
    : !p.spans.length ? t("stx_breaks_nothing")
    : t("stx_breaks_would", { n: p.spans.length, file: p.file,
                               spans: p.spans.map(stxBrSpan).join(" · ") });
}

// ------------------------------------------------------------------ constant scroll
// Phase 21, SV normaliser: greens cancelling one difficulty's BPM changes so
// scroll and slider speed stay constant. The maps come from the transport
// picker; preview counts, apply writes under a backup, and the card refreshes.
const SV = { preview: null, for: "" };

async function svMaps() {
  const box = $("svMap");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  const path = (S.result && S.result.path) || "";
  if (SV.for !== path) { SV.for = path; SV.preview = null; }
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = !maps.length;
  renderSv();
}

// ------------------------------------------------------------------ volumes
// Phase 21: hitsound volume from section energy in one difficulty of the
// song. The maps come from the transport picker; preview counts added,
// flipped and kept, apply writes green lines under a backup.
const STXV = { preview: null, for: "" };

async function stxVolMaps() {
  const box = $("stxVolMap");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  const path = (S.result && S.result.path) || "";
  if (STXV.for !== path) { STXV.for = path; STXV.preview = null; }
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = !maps.length;
  renderVolumes();
}

async function svPreview() {
  if (!api() || !S.result) return;
  const file = $("svMap").value;
  if (!file) return;
  const reply = await api().scroll_preview(file);
  if (!reply.ok) {
    if (reply.key === "scroll_sliders") {
      // Refused for a reason the card can say in full, not an error.
      SV.preview = null;
      renderSv();
      $("svResult").textContent = t("scroll_sliders", { n: reply.count, at: mmss(reply.first_ms / 1000) });
      return;
    }
    editFailure(reply);
    return;
  }
  SV.preview = { ...reply, file };
  renderSv();
}

async function svApply() {
  if (!api() || !S.result || !SV.preview) return;
  const file = $("svMap").value;
  if (SV.preview.file !== file) { await svPreview(); return; }
  if (!SV.preview.added && !SV.preview.flipped) {
    toast(t("sv_nothing", { bpm: SV.preview.reference_bpm, file })); return;
  }
  if (!confirm(t("sv_confirm", { bpm: SV.preview.reference_bpm, file }))) return;
  const reply = await api().scroll_apply(file);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("sv_done", { bpm: reply.reference_bpm, file }));
  SV.preview = null;
  renderSv();
}

function renderSv() {
  const card = $("svCard"), p = SV.preview;
  card.hidden = !S.result;
  if (!S.result) return;
  $("svApply").disabled = !p || p.already || (!p.added && !p.flipped);
  $("svResult").textContent = !p ? "" : p.already ? t("already_written")
    : t("sv_would", { added: p.added, flipped: p.flipped, kept: p.kept, bpm: p.reference_bpm, file: p.file });
}

async function stxVolPreview() {
  if (!api() || !S.result) return;
  const file = $("stxVolMap").value;
  if (!file) return;
  const reply = await api().structure_volumes_preview(file);
  if (!reply.ok) { editFailure(reply); return; }
  STXV.preview = { ...reply, file };
  renderVolumes();
}

async function stxVolApply() {
  if (!api() || !S.result || !STXV.preview) return;
  const file = $("stxVolMap").value;
  if (STXV.preview.file !== file) { await stxVolPreview(); return; }
  if (!STXV.preview.added && !STXV.preview.flipped) { toast(t("stx_vol_nothing", { file })); return; }
  if (!confirm(t("stx_vol_confirm", { n: STXV.preview.set, file }))) return;
  const reply = await api().structure_volumes_apply(file);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("stx_vol_done", { n: reply.set, file }));
  STXV.preview = null;
  renderVolumes();
}

function renderVolumes() {
  const card = $("stxVolCard"), p = STXV.preview;
  card.hidden = !S.result;
  if (!S.result) return;
  $("stxVolApply").disabled = !p || p.already || (!p.added && !p.flipped);
  $("stxVolResult").textContent = !p ? "" : p.already ? t("already_written")
    : t("stx_vol_would", { set: p.set, added: p.added, flipped: p.flipped, kept: p.kept,
                           mapper: p.mapper, file: p.file });
}

// ------------------------------------------------------------------ snap divisors
// Phase 21: which divisor each section needs, from the song's own attacks.
// Read only: one line per section, no preview, nothing to apply.
const DIVS = { report: null, for: "" };

async function divsLoad() {
  DIVS.report = null;
  if (api() && S.result) {
    const reply = await api().snap_divisors();
    if (reply.ok) DIVS.report = reply.report;
  }
  DIVS.for = (S.result && S.result.path) || "";
  renderDivisors();
}

function renderDivisors() {
  const card = $("divCard"), r = DIVS.report;
  card.hidden = !S.result;
  if (!S.result) return;
  if (DIVS.for !== S.result.path) { divsLoad(); return; }
  if (!r) { $("divBody").textContent = ""; return; }
  $("divBody").innerHTML = r.sections.map((s) => {
    const extra = (s.thirds || s.sixths)
      ? t("div_extra", { t: s.thirds, s: s.sixths }) : "";
    return `<div>${esc(t("div_row", { at: mmss(s.offset_ms / 1000), bpm: s.bpm, d: s.divisor, extra }))}</div>`;
  }).join("");
}

// ------------------------------------------------------------------ swing lane
// Phase 21: where the off-beat eighth falls inside the beat, eight beats at a
// time. Read only: a lane on the tempo map (only while something swings) and
// one line per swung stretch.
const SWING = { report: null, for: "" };

async function swingLoad() {
  SWING.report = null;
  if (api() && S.result) {
    const reply = await api().swing_lane();
    if (reply.ok) SWING.report = reply.report;
  }
  SWING.for = (S.result && S.result.path) || "";
  renderSwing();
  drawTrace();  // the lane appears or goes, and the other lanes move with it
}

function renderSwing() {
  const card = $("swingCard"), r = SWING.report;
  card.hidden = !S.result;
  // the legend's swing key shows while the lane does
  document.querySelectorAll(".legend .swing-key").forEach((el) => {
    el.hidden = !(r && r.spans.length);
  });
  if (!S.result) return;
  if (SWING.for !== S.result.path) { swingLoad(); return; }
  if (!r) { $("swingBody").textContent = ""; return; }
  const spans = r.spans.map((s) => {
    const what = t(s.feel === "triplets" ? "swing_triplets" : "swing_swing");
    return `<div>${esc(t("swing_row", {
      from: mmss(s.start_ms / 1000), to: mmss(s.end_ms / 1000), what,
      at: s.at.toFixed(2), snap: s.snap ? t("swing_snap", { snap: s.snap }) : "",
      ratio: s.ratio.toFixed(2), late: s.late_ms.toFixed(0),
    }))}</div>`;
  });
  const head = !r.measured ? t("swing_nothing")
    : !r.swung ? t("swing_none", { measured: r.measured })
      : t("swing_count", {
        n: r.swung, measured: r.measured,
        spans: r.spans.length === 1 ? t("swing_span") : t("swing_spans", { n: r.spans.length }),
      });
  $("swingBody").innerHTML = `<div>${esc(head)}</div>${spans.join("")}`;
}

// ------------------------------------------------------------------ audio bands
// Seven onset-flux lanes, low band at the foot. The engine scales them all by
// one peak, so a quiet band draws quiet: that comparison is the whole point,
// and per-lane normalisation would invent a kick in a song that has none.
const BANDS = { data: null, for: "", loading: false };
const SPEC = { data: null, image: null, for: "", loading: false };

// The spectrogram arrives as one byte a cell — 128 rows of dB under the
// song's own loudest moment — and is painted once into an offscreen canvas
// at its true size. Drawing then scales that, so a resize costs a blit and
// not a repaint of 180,000 cells.
// The spectrogram and the lanes come from one decode, so they are asked for
// in turn: both at once and the second is refused while the first holds it.
async function audioLoad() {
  await specLoad();
  await bandsLoad();
}

async function specLoad() {
  if (!api() || !S.result) return;
  if (SPEC.for === S.result.path || SPEC.loading) { drawSpec(); return; }
  SPEC.loading = true;
  $("specNote").textContent = t("spec_reading");
  try {
    const reply = await api().audio_spectrogram();
    if (!reply.ok) {
      // Busy is not a failure: another heavy job has the song. Say so, and
      // leave it to be asked again rather than sitting on "reading…".
      $("specNote").textContent = reply.key === "busy" ? t("audio_busy") : "";
      if (reply.key !== "busy") editFailure(reply);
      return;
    }
    SPEC.data = reply;
    SPEC.image = reply.columns ? specPaint(reply) : null;
    SPEC.for = S.result.path;
  } finally {
    SPEC.loading = false;
  }
  drawSpec();
}

// One cell is one pixel, low band at the foot. The ramp goes from the plot's
// own background at the floor to the tempo ink at the loudest, so the picture
// belongs to the theme rather than to a palette of its own.
function specPaint(data) {
  const bytes = atob(data.cells);
  const off = document.createElement("canvas");
  off.width = data.columns; off.height = data.rows;
  const ctx = off.getContext("2d");
  const image = ctx.createImageData(data.columns, data.rows);
  const low = rgbOf(C.plot), high = rgbOf(C.tempo);
  for (let row = 0; row < data.rows; row++) {
    const y = data.rows - 1 - row;                    // band 0 at the foot
    for (let col = 0; col < data.columns; col++) {
      const v = bytes.charCodeAt(row * data.columns + col) / 255;
      const at = (y * data.columns + col) * 4;
      image.data[at] = low[0] + (high[0] - low[0]) * v;
      image.data[at + 1] = low[1] + (high[1] - low[1]) * v;
      image.data[at + 2] = low[2] + (high[2] - low[2]) * v;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return off;
}

function rgbOf(colour) {
  const probe = document.createElement("canvas").getContext("2d");
  probe.fillStyle = colour;
  const m = probe.fillStyle.match(/^#(..)(..)(..)$/);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : (probe.fillStyle.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
}

function drawSpec() {
  const wrap = $("specWrap"), canvas = $("specCanvas"), data = SPEC.data;
  if (!wrap || !canvas) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!data || !SPEC.image) return;
  $("specNote").textContent = t("spec_note", {
    rows: data.rows, cols: data.columns, span: mmss(data.span_s), floor: data.floor_db,
  });
  const padL = 74, padR = 14, padT = 8, padB = 22;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  ctx.save();
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 6); ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(SPEC.image, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
  // A few mel rows named in Hz, and the same time axis the lanes carry.
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const row of [0, 32, 64, 96, 127]) {
    const hz = data.hz[row];
    const y = y1 - ((row + 0.5) / data.rows) * (y1 - y0);
    ctx.fillText(hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(Math.round(hz)), x0 - 10, y);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = niceStep(data.span_s, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = 0; s <= data.span_s + 1e-6; s += step) {
    ctx.fillText(mmss(s), x0 + (s / data.span_s) * (x1 - x0), y1 + 5);
  }
}

async function bandsLoad() {
  if (!api() || !S.result) return;
  if (BANDS.for === S.result.path || BANDS.loading) { drawBands(); return; }
  BANDS.loading = true;
  $("bandNote").textContent = t("band_reading");
  try {
    const reply = await api().audio_bands();
    if (!reply.ok) {
      $("bandNote").textContent = reply.key === "busy" ? t("audio_busy") : "";
      if (reply.key !== "busy") editFailure(reply);
      return;
    }
    BANDS.data = reply;
    BANDS.for = S.result.path;
  } finally {
    BANDS.loading = false;
  }
  drawBands();
}

function drawBands() {
  const wrap = $("bandWrap"), canvas = $("bandCanvas"), data = BANDS.data;
  if (!wrap || !canvas) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;                   // Audio is not the visible view
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!data || !data.lanes.length) {
    $("bandNote").textContent = data ? t("band_none") : $("bandNote").textContent;
    return;
  }
  $("bandNote").textContent = t("band_note", {
    n: data.columns, span: mmss(data.span_s), db: data.peak_db.toFixed(1),
  });
  const padL = 74, padR = 14, padT = 8, padB = 22;
  const x0 = padL, x1 = W - padR, plotH = H - padT - padB;
  const lanes = data.lanes.length, gap = 4;
  const laneH = (plotH - gap * (lanes - 1)) / lanes;
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  ctx.textBaseline = "middle";
  for (let b = 0; b < lanes; b++) {
    // low band at the foot, as a spectrum is read
    const top = padT + (lanes - 1 - b) * (laneH + gap);
    ctx.fillStyle = C.plot;
    roundRect(ctx, x0, top, x1 - x0, laneH, 6); ctx.fill();
    const row = data.lanes[b];
    ctx.fillStyle = C.onset;
    for (let px = 0; px < x1 - x0; px++) {
      const i0 = Math.floor((px / (x1 - x0)) * row.length);
      const i1 = Math.max(i0 + 1, Math.ceil(((px + 1) / (x1 - x0)) * row.length));
      let peak = 0;
      for (let i = i0; i < i1 && i < row.length; i++) if (row[i] > peak) peak = row[i];
      const h = peak * (laneH - 2);
      if (h > 0.4) ctx.fillRect(x0 + px, top + laneH - 1 - h, 1, h);
    }
    ctx.fillStyle = C.gridText; ctx.textAlign = "right";
    ctx.fillText(bandLabel(data.edges, b), x0 - 10, top + laneH / 2);
  }
  // the time axis, shared with the tempo map's own wording
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = niceStep(data.span_s, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = 0; s <= data.span_s + 1e-6; s += step) {
    ctx.fillText(mmss(s), x0 + (s / data.span_s) * (x1 - x0), H - padB + 5);
  }
}

// "40–89" and so on, in Hz or kHz, from the edges the engine sends.
function bandLabel(edges, b) {
  const one = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(Math.round(hz)));
  return `${one(edges[b])}–${one(edges[b + 1])}`;
}

// ------------------------------------------------------------------ pulse hints
// F-11: a stretch inside one reported section that reads half or double the
// rate. Read only — a ribbon on the tempo map marking the stretch and the
// beat the change sits on, and one line per hint with the evidence behind it.
const PH = { hints: null, for: "" };

async function phLoad() {
  PH.hints = null;
  if (api() && S.result) {
    const reply = await api().density_hints();
    if (reply.ok) PH.hints = reply.hints;
  }
  PH.for = (S.result && S.result.path) || "";
  renderPulseHints();
  drawTrace();  // the ribbon appears or goes with the hints
}

// The direction as the mapper would read it: a thinned tail is the song
// going half-time from there; a thinned head was double-time until there.
function phWay(hint) {
  return hint.thin_side === "head" ? "double" : "half";
}

function renderPulseHints() {
  const card = $("phCard"), hints = PH.hints;
  card.hidden = !S.result;
  document.querySelectorAll(".legend .ph-key").forEach((el) => {
    el.hidden = !(hints && hints.length);
  });
  if (!S.result) return;
  if (PH.for !== S.result.path) { phLoad(); return; }
  if (!hints) { $("phBody").textContent = ""; return; }
  if (!hints.length) { $("phBody").textContent = t("ph_none"); return; }
  const sections = S.result.sections || [];
  $("phBody").innerHTML = hints.map((h) => {
    const bpm = (sections[h.section] || {}).bpm || 0;
    const read = bpm > 0 ? (phWay(h) === "half" ? bpm * h.factor : bpm / h.factor) : 0;
    const head = t(phWay(h) === "half" ? "ph_row_half" : "ph_row_double", {
      at: mmss(h.boundary_s), from: mmss(h.from_s), to: mmss(h.to_s),
      bpm: bpm.toFixed(bpm % 1 ? 2 : 0), reads: read.toFixed(read % 1 ? 2 : 0),
      n: h.section + 1,
    });
    const why = t("ph_why", {
      cin: Math.round(h.coverage_in * 100), cout: Math.round(h.coverage_out * 100),
      pin: Math.round(h.parity_in * 100), pout: Math.round(h.parity_out * 100),
      sub: h.subdivision, thinned: h.thinned, windows: h.windows,
    });
    return `<div>${esc(head)}</div><div class="ph-why">${esc(why)}</div>`;
  }).join("");
}

// A section opens in Timing: the timeline zoomed to it, the playhead at its start.
function stxShow(i) {
  const s = STX.view && STX.view.sections[i];
  if (!s || !S.result) return;
  VIEW.a = s.start_s;
  VIEW.b = s.end_s;
  setView("timing");
  drawTrace();
  pbSeek(s.start_s);
}

// ------------------------------------------------------------------ hitsounds view
// Phase 6, H2: one difficulty, read only. Where its additions fall in the bar
// (a small multiple per addition, on one scale), and every sound, to hear
// one by one with the samples the transport plays.
const HSV = { file: "", report: null, filter: "all", bars: { from: null, to: null }, shown: 200,
              selected: null };
const HSV_ADDS = ["whistle", "finish", "clap"];
const HSV_PAGE = 200;

function slotLabel(slot, meter) {
  if (slot === null || slot === undefined) return "—";
  return `${Math.floor(slot / 4) + 1}${["", "e", "+", "a"][slot % 4]}`;
}

async function hsvLoad() {
  const box = $("hsvMap");
  if (!api() || !S.result) return;
  if (!box.options.length || box.dataset.for !== S.result.path) {
    const reply = await api().song_maps();
    const maps = reply.ok ? reply.maps : [];
    box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
    box.dataset.for = S.result.path;
    box.disabled = !maps.length;
    HSV.file = ""; HSV.report = null;
    // Bars belong to one song: a new one starts from all of them.
    HSV.bars = { from: null, to: null };
    $("hsvBarFrom").value = $("hsvBarTo").value = "";
    if (!maps.length) { renderHitsoundsView(); return; }
    if (HSP.file && maps.some((m) => m.file === HSP.file)) box.value = HSP.file;
  }
  if (box.value && box.value !== HSV.file) await hsvPick(box.value);
  else renderHitsoundsView();
}

async function hsvPick(file) {
  // New file, new decision state; refreshing the same file after a write
  // clears the (now stale) units but keeps a live undo.
  if (HSV.file !== file) {
    HSD.file = ""; HSD.units = []; HSD.byKey = new Map(); HSD.accepted = new Set(); HSD.choice = new Map();
    HSD.edits = new Map(); HSD.undo = false;
  }
  HSV.file = file; HSV.report = null; HSV.shown = HSV_PAGE; HSV.selected = null;
  $("hsvDecidePrevText").textContent = "";
  const reply = await api().hitsound_report(file);
  if (HSV.file !== file) return;
  if (!reply.ok) { editFailure(reply); return; }
  HSV.report = reply.report;
  // A run over the whole mapset already decided this difficulty: show what it
  // found instead of asking the sidecar for this one map again.
  if (HSD.file !== file) {
    const cached = await api().hitsound_decide_cached(file);
    if (HSV.file !== file) return;
    if (cached.ok) hsdAdopt(file, cached.units, cached.profile);
  }
  renderHitsoundsView();
  // The same difficulty in the transport: its samples load for the ▶ buttons.
  if (HSP.file !== file) { $("pbHs").value = file; hsPick(file).then(renderHitsoundsView); }
}

function hsvChart(name, a, meter, peak) {
  const n = a.slots.length, W = 300, H = 96, gap = 2, bw = (W - gap * (n - 1)) / n;
  const bars = a.slots.map((c, k) => {
    const share = a.total ? c / a.total : 0, h = peak ? (share / peak) * (H - 8) : 0;
    const x = k * (bw + gap);
    return `<rect class="bar" x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, share ? 1 : 0).toFixed(1)}"><title>${slotLabel(k, meter)}: ${c} (${Math.round(share * 100)} %)</title></rect>`;
  }).join("");
  const labels = a.slots.map((_c, k) => k % 4 === 0
    ? `<text class="beat" x="${(k * (bw + gap) + bw / 2).toFixed(1)}" y="${H + 14}" text-anchor="middle">${k / 4 + 1}</text>`
    : (n <= 16 ? `<text class="sub" x="${(k * (bw + gap) + bw / 2).toFixed(1)}" y="${H + 14}" text-anchor="middle">${["", "e", "+", "a"][k % 4]}</text>` : "")).join("");
  // The fewest sixteenths that hold 80 % of this addition, four at most.
  const order = a.slots.map((c, k) => [c, k]).sort((x, y) => y[0] - x[0]);
  let held = 0; const top = [];
  for (const [c, k] of order) { if (!c || top.length === 4 || held >= 0.8 * a.total) break; top.push(k); held += c; }
  const sum = a.total ? t("hsv_top", { pct: Math.round((held / a.total) * 100), slots: top.sort((x, y) => x - y).map((k) => slotLabel(k, meter)).join(", ") })
                      : t("hsv_none_add");
  const extra = [a.off_grid ? t("hsv_between", { n: a.off_grid }) : "", a.other_meter ? t("hsv_other_meter", { n: a.other_meter }) : ""].filter(Boolean).join(" · ");
  return `<div class="hsv-chart k-${name}">
    <div class="head"><span class="hsv-dot k-${name}"></span><b>${t("lg_" + name)}</b><span class="num">${a.total}</span><span class="sum">${esc(sum)}</span></div>
    <svg viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="${esc(t("lg_" + name) + ": " + sum)}">
      ${bars}<line class="base" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/>${labels}</svg>
    ${extra ? `<div class="card-sub mt-s">${esc(extra)}</div>` : ""}</div>`;
}

// The sounds the table shows: its addition filter and its bars (either end
// open). All, None, Set and Clear act on these, pages beyond the first too.
function hsvShown() {
  const r = HSV.report;
  if (!r) return [];
  const { from, to } = HSV.bars;
  return r.sounds.filter((s) => (HSV.filter === "all" || s.sounds.includes(HSV.filter))
    && (from === null || (s.bar !== null && s.bar >= from))
    && (to === null || (s.bar !== null && s.bar <= to)));
}

function renderHitsoundsView() {
  const r = HSV.report, box = $("hsvMap");
  $("hsvWhereCard").hidden = $("hsvSoundsCard").hidden = !r;
  if (!box.options.length) { $("hsvSummary").innerHTML = `<div class="card-sub">${t("hsv_none")}</div>`; hsdRender(); return; }
  if (!r) { $("hsvSummary").innerHTML = ""; hsdRender(); return; }
  const n = r.sounds.length, pct = (x) => (n ? Math.round((x / n) * 100) : 0);
  const sets = r.sets.normal, setsText = ["normal", "soft", "drum"].filter((s) => sets[s]).map((s) => `${s} ${pct(sets[s])} %`).join(" · ");
  const c = HSP.file === HSV.file && HSP.events && !HSP.proposal ? HSP.counts : null;
  const stat = (label, value, small) => `<div class="hsv-stat"><div class="label">${label}</div><div class="value">${value}${small ? `<small>${small}</small>` : ""}</div></div>`;
  $("hsvSummary").innerHTML = `<div class="hsv-stats">
      ${stat(t("hsv_sounds_n"), n)}
      ${HSV_ADDS.map((a) => stat(t("lg_" + a), r.additions[a].total, `${pct(r.additions[a].total)} %`)).join("")}
      ${stat(t("hsv_sets"), `<span class="card-sub">${esc(setsText)}</span>`)}
      ${c ? stat(t("hsv_samples"), `<span class="card-sub">${esc(t(c.skin ? "hsv_samples_v_skin" : "hsv_samples_v", { map: c.map + c.file, skin: c.skin, own: c.overtone }))}</span>`) : ""}
    </div>`;
  const peak = Math.max(1e-9, ...HSV_ADDS.flatMap((a) => r.additions[a].slots.map((x) => (r.additions[a].total ? x / r.additions[a].total : 0))));
  $("hsvWhere").innerHTML = HSV_ADDS.map((a) => hsvChart(a, r.additions[a], r.meter, peak)).join("");
  $("hsvWhereNote").textContent = t("hsv_where_note", { meter: r.meter });
  const rows = hsvShown();
  $("hsvCount").textContent = t("hsv_count", { n: rows.length });
  // ▶ plays what the transport holds: the file, or the file as it would be written.
  const playLabel = t(HSP.proposal && HSP.file === HSV.file ? "hsv_play_proposal" : "hsv_play");
  // A hand edit shows beside what plays now; 0 hands the value back to the green line.
  const cell = (now, set, unit) => set === undefined ? `${now}${unit}`
    : `<span class="was">${now}${unit}</span> → <span class="now">${set === 0 ? t("hsv_line") : set + unit}</span>`;
  $("hsvRows").innerHTML = rows.slice(0, HSV.shown).map((s) => {
    const i = r.sounds.indexOf(s);
    const adds = s.sounds.slice(1).map((a) => `<span class="hsv-dot k-${a}"></span>${t("lg_" + a)}`).join(" ");
    const unit = hsdUnitFor(s);
    const key = unit && hsdKey(unit.object, unit.part, unit.edge);
    const tick = unit && `<input type="checkbox" data-hsd="${esc(key)}" ${HSD.accepted.has(key) ? "checked" : ""}>`;
    // The proposal, or one of its runner-ups; a slider tail follows its head and has none.
    const alts = unit && unit.alternatives && unit.alternatives.length ? unit.alternatives : null;
    const chosen = alts && HSD.choice.has(key) ? HSD.choice.get(key) : -1;
    const prop = !unit ? `<span class="muted">—</span>`
      : !alts ? `<label class="check">${tick}<span>${esc(hsdLabel(unit.proposal))}</span></label>`
      : `<span class="hsv-prop"><label class="check">${tick}</label><select class="input hsv-alt" data-hsd-alt="${esc(key)}" aria-label="${t("hsv_alt_aria")}">`
        + [unit.proposal, ...alts].map((p, k) => `<option value="${k - 1}"${k - 1 === chosen ? " selected" : ""}>${esc(hsdLabel(p))}</option>`).join("")
        + `</select></span>`;
    const edit = HSD.file === HSV.file ? HSD.edits.get(s.object) : undefined;
    return `<tr data-i="${i}"${i === HSV.selected ? ' class="sel"' : ""}>
      <td class="txt num">${fmtTime(s.t)}</td>
      <td class="num">${s.bar ?? "—"} · ${slotLabel(s.slot, s.meter)}</td>
      <td class="txt">${t("part_" + s.part)}</td>
      <td class="txt">${s.file ? esc(s.file) : (adds || `<span class="muted">normal</span>`)}</td>
      <td class="txt">${s.normal_set}${s.sounds.length > 1 && s.addition_set !== s.normal_set ? ` / ${s.addition_set}` : ""}</td>
      <td class="num">${cell(s.index, edit && edit.index, "")}</td><td class="num">${cell(s.volume, edit && edit.volume, " %")}</td>
      <td class="txt">${prop}</td>
      <td><button type="button" class="btn small icon" data-play="${i}" title="${playLabel}" aria-label="${playLabel}">▶</button></td>
    </tr>`;
  }).join("");
  const more = rows.length - HSV.shown;
  $("hsvMore").hidden = more <= 0;
  $("hsvMore").textContent = t("hsv_more", { n: Math.min(more, HSV_PAGE) });
  hsdRender();
  hsdWhy();
  sbRenderHear();
}

// ▶ plays one sound now, with the samples the transport loaded for this map.
function hsvPlay(i) {
  const s = HSV.report && HSV.report.sounds[i];
  if (!s || !HSP.events || HSP.file !== HSV.file) return;
  const k = lowerBound(HSP.events.t, s.t - 1e-6);
  if (k >= HSP.events.t.length || Math.abs(HSP.events.t[k] - s.t) > 1e-3) return;
  const ctx = pbContext();
  if (ctx.state === "suspended") ctx.resume();
  pbHitAt(ctx.currentTime + 0.02, HSP.events.keys[k], HSP.events.volume[k]);
}

// ------------------------------------------------------------------ decide
// Phase 6, H5: the decision engine's proposals over the sounds table, and
// volume and sample index by hand. Units join report sounds on (object,
// part, edge); the ticked set is the accept list the bridge previews and
// writes. Proposing runs the CLI once and caches server-side; writing clears
// the cache, because the map the units were decided on is gone. Edits need
// no proposal: one per object, keyed by the sound they were set on, so the
// bridge can refuse them if that sound moved.
const HSD = { file: "", units: [], byKey: new Map(), accepted: new Set(), choice: new Map(),
              edits: new Map(), undo: false, proposing: false,
              profiles: ["balanced"], profile: "balanced", proposedWith: "" };

// Hitsound profiles by name, as the bridge lists them (balanced first): a
// profile the page has words for shows them, any other its file's name.
function hsdProfileLabel(name) {
  const key = "hsv_prof_" + name;
  return key in I18N.en ? t(key) : name;
}

// The selector shows only when there is a choice: balanced alone needs none.
function hsdProfilesRender() {
  const box = $("hsvProfile");
  box.innerHTML = HSD.profiles.map((name) => {
    const key = "hsv_prof_" + name;
    return `<option value="${esc(name)}"${key in I18N.en ? ` data-i18n="${key}"` : ""}>${esc(hsdProfileLabel(name))}</option>`;
  }).join("");
  box.value = HSD.profile;
  $("hsvProfileField").hidden = HSD.profiles.length < 2;
}

async function hsdProfilesLoad() {
  if (!api()) return;
  const reply = await api().hitsound_profiles();
  if (!reply || !reply.ok) return;
  HSD.profiles = reply.profiles;
  if (!HSD.profiles.includes(HSD.profile)) HSD.profile = reply.default;
  hsdProfilesRender();
}

// What the chosen profile does, and a reminder when the proposals shown
// were decided with another one.
function hsdProfileNote() {
  const key = `hsv_prof_${HSD.profile}_note`;
  const note = HSD.profiles.length > 1 && key in I18N.en ? t(key) : "";
  const shown = HSD.file === HSV.file && HSD.units.length > 0 && HSD.proposedWith;
  const again = shown && HSD.proposedWith !== HSD.profile
    ? t("hsv_prof_again", { used: hsdProfileLabel(HSD.proposedWith), chosen: hsdProfileLabel(HSD.profile) })
    : "";
  return [note, again].filter(Boolean).join(" ");
}

function hsdKey(object, part, edge) { return `${object}|${part}|${edge ?? ""}`; }

function hsdUnitFor(sound) {
  if (!HSD.units.length || HSD.file !== HSV.file) return null;
  return HSD.byKey.get(hsdKey(sound.object, sound.part, sound.edge)) || null;
}

function hsdEditList() { return [...HSD.edits.values()]; }

// The runner-ups chosen on ticked sounds, as [object, part, edge, index].
function hsdChoiceList() {
  return [...HSD.choice].filter(([key]) => HSD.accepted.has(key)).map(([key, k]) => {
    const [object, part, edge] = key.split("|");
    return [+object, part, edge === "" ? null : +edge, k];
  });
}

// What a preview or the transport is made of, in words.
function hsdWhat(r) {
  const parts = [];
  if (r.units) parts.push(t(r.chosen ? "hsv_what_ticked_alt" : "hsv_what_ticked",
                            { accepted: r.accepted, units: r.units, chosen: r.chosen }));
  if (r.edited) parts.push(t("hsv_edited", { n: r.edited }));
  return parts.join(t("hsv_and"));
}

// Something to write: ticked-or-not proposals, or edits, for the difficulty shown.
function hsdHas() { return HSD.file === HSV.file && (HSD.units.length > 0 || HSD.edits.size > 0); }

// A proposal or a runner-up in words, compact for the table: its bank, its
// additions, how likely on its own ("soft+whistle 7 %").
function hsdLabel(p) {
  const sure = typeof p.probability === "number" ? ` ${Math.round(p.probability * 100)} %` : "";
  return p.bank + p.additions.map((a) => "+" + a).join("") + sure;
}

// The decision behind one sound, read off the computation (docs/06 §7): the
// proposal and its runner-ups, what was heard under it, and every term the
// engine added up there, signed. Opens on a row click, over the table.
const HSD_TERMS = ["affinity", "role", "context", "prior"];

function hsdWhy() {
  const box = $("hsvWhy"), r = HSV.report;
  const s = r && HSV.selected !== null ? r.sounds[HSV.selected] : null;
  const unit = s && hsdUnitFor(s);
  box.hidden = !unit;
  if (!unit) { box.innerHTML = ""; return; }
  const head = `${fmtTime(s.t)} · ${t("part_" + s.part)} · ${s.bar ?? "—"} · ${slotLabel(s.slot, s.meter)}`;
  const row = (label, body) => `<div class="label">${label}</div><div>${body}</div>`;
  const alts = (unit.alternatives || []).map((a) => esc(hsdLabel(a))).join(" · ");
  let heard = "", why = "";
  if (unit.tail) {
    heard = esc(t(unit.follows === null ? "hsv_why_tail_bare" : "hsv_why_tail"));
  } else if (!unit.heard) {
    heard = esc(t("hsv_why_silence"));
  } else {
    const classes = unit.heard.classes.map((c) => `${esc(t("hs_class_" + c.class))} ${Math.round(c.probability * 100)} %`).join(" · ");
    const d = unit.heard.division;
    heard = `${classes} · ${esc(t(d ? "hsv_div_" + d : "hsv_div_none"))}`;
  }
  if (!unit.tail) {
    const terms = HSD_TERMS.map((name) => [name, (unit.terms.find((x) => name in x) || {})[name] || 0]);
    if (unit.transition_in !== null && unit.transition_in !== undefined) terms.push(["transition", unit.transition_in]);
    const peak = Math.max(1e-9, ...terms.map(([, v]) => Math.abs(v)));
    const sum = terms.reduce((a, [, v]) => a + v, 0);
    why = `<div class="hsv-terms">${terms.map(([name, v]) => `<span>${esc(t("hsv_term_" + name))}</span>`
      + `<span class="track"><span class="bar${v < 0 ? " neg" : ""}" style="width:${(Math.abs(v) / peak * 100).toFixed(1)}%"></span></span>`
      + `<span class="num">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}</span>`).join("")}`
      + `<span><b>${esc(t("hsv_why_sum"))}</b></span><span></span><span class="num"><b>${sum >= 0 ? "+" : "−"}${Math.abs(sum).toFixed(2)}</b></span></div>`;
  }
  box.innerHTML = `<div class="hsv-why-head"><b>${esc(head)}</b><span class="spacer"></span>`
    + `<button type="button" class="btn small icon" data-why-close title="${t("hsv_why_close")}" aria-label="${t("hsv_why_close")}">×</button></div>`
    + `<div class="hsv-why-grid">`
    + row(t("hsv_why_proposed"), `<b>${esc(hsdLabel(unit.proposal))}</b>${alts ? ` <span class="muted">· ${t("hsv_why_behind")} ${alts}</span>` : ""}`)
    + row(t("hsv_why_heard"), heard)
    + (why ? row(t("hsv_why_terms"), why) : "")
    + `</div>${why ? `<div class="card-sub mt-s">${esc(t("hsv_why_note"))}</div>` : ""}`;
}

function hsdAcceptList() {
  return [...HSD.accepted].map((key) => {
    const [object, part, edge] = key.split("|");
    return [+object, part, edge === "" ? null : +edge];
  });
}

function hsdRender() {
  const mine = HSD.file === HSV.file, units = mine && HSD.units.length > 0, has = hsdHas();
  $("hsvDecideCard").hidden = !HSV.report;
  $("hsvPropose").disabled = HSD.proposing || !HSV.file;
  $("hsvProposeAll").disabled = HSD.proposing || !$("hsvMap").options.length;
  $("hsvProfile").disabled = HSD.proposing;
  $("hsvProfileNote").textContent = hsdProfileNote();
  $("hsvDecideAll").disabled = $("hsvDecideNone").disabled = !units;
  for (const id of ["hsvDecidePreview", "hsvDecideHear", "hsvDecideApply", "hsvDecideCopy"]) {
    $(id).disabled = !has;
  }
  $("hsvEditSet").disabled = !HSV.report;
  $("hsvEditClear").disabled = !(mine && HSD.edits.size);
  $("hsvDecideUndo").disabled = !HSD.undo;
  const chosen = units ? hsdChoiceList().length : 0;
  $("hsvDecideStatus").textContent = HSD.proposing ? t("hsv_proposing")
    : [units ? t("hsv_proposed", { n: HSD.accepted.size }) : "",
       units && HSD.proposedWith && HSD.profiles.length > 1 ? hsdProfileLabel(HSD.proposedWith) : "",
       chosen ? t("hsv_alts", { n: chosen }) : "",
       mine && HSD.edits.size ? t("hsv_edited", { n: HSD.edits.size }) : ""].filter(Boolean).join(" · ");
  hsProposalOption(has ? HSD.file : "");
  const h = has && HSP.proposal && HSP.file === HSD.file ? HSP.heard : null;
  const plain = h && [...$("pbHs").options].find((o) => o.value === HSD.file);
  $("hsvDecideHearText").textContent = !h ? ""
    : h.differs ? t("hsv_hearing", { what: hsdWhat(h), n: h.differs, time: fmtTime(h.first),
                                     name: plain ? plain.textContent : HSD.file })
    : t("hsv_hearing_same", { what: hsdWhat(h) });
}

// Hear the ticked proposals and the edits over the song: the transport
// switches to the difficulty as it would be written and plays, from the
// playhead or, from the song's start, just before the first sound that changes.
async function hsdHear() {
  if (!api() || !hsdHas()) return;
  hsProposalOption(HSD.file);
  await hsPick(HS_PROPOSAL + HSD.file);
  renderHitsoundsView();
  const h = HSP.proposal && HSP.heard;
  if (!h || P.playing) return;
  pbPlay(P.pos > 0 || h.first === null ? P.pos : Math.max(0, h.first - 1));
}

// The ticks or the edits changed: the transport, when it plays the file as it
// would be written, follows them once the changing pauses, heard on the next
// beat like an edit to the click. With nothing left to write, that is the file.
let hsdRehear = 0;
function hsdTicked() {
  clearTimeout(hsdRehear);
  const live = () => HSP.proposal && HSP.file === HSV.file;
  if (!live()) return;
  hsdRehear = setTimeout(() => {
    if (live()) hsPick(hsdHas() ? HS_PROPOSAL + HSV.file : HSV.file).then(hsdRender);
  }, 250);
}

// Volume and sample index by hand on the sounds shown: the object's own
// values, 0 to follow its green line again; a slider's for all its edges.
function hsdEditSet() {
  if (!HSV.report) return;
  const read = (id, max) => {
    const raw = $(id).value.trim();
    if (raw === "") return undefined;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 && v <= max ? v : NaN;
  };
  const volume = read("hsvEditVolume", 100), index = read("hsvEditIndex", Number.MAX_SAFE_INTEGER);
  if (volume === undefined && index === undefined) { toast(t("hsv_edit_empty"), true); return; }
  if (Number.isNaN(volume) || Number.isNaN(index)) { toast(t("hsv_edit_bad"), true); return; }
  HSD.file = HSV.file;
  for (const s of hsvShown()) {
    const edit = HSD.edits.get(s.object)
      || { object: s.object, part: s.part, edge: s.edge, time_ms: s.t * 1000 };
    if (volume !== undefined) edit.volume = volume;
    if (index !== undefined) edit.index = index;
    HSD.edits.set(s.object, edit);
  }
  $("hsvDecidePrevText").textContent = "";
  renderHitsoundsView();
  hsdTicked();
}

function hsdEditClear() {
  for (const s of hsvShown()) HSD.edits.delete(s.object);
  $("hsvDecidePrevText").textContent = "";
  renderHitsoundsView();
  hsdTicked();
}

// One proposal's units become the decision state: every sound ticked, no
// runner-up chosen, no hand edit, nothing to undo.
function hsdAdopt(file, units, profile) {
  HSD.file = file;
  HSD.proposedWith = profile || HSD.profile;
  HSD.units = units;
  HSD.byKey = new Map(units.map((u) => [hsdKey(u.object, u.part, u.edge), u]));
  HSD.choice = new Map();
  HSD.accepted = new Set(HSD.byKey.keys());
  HSD.undo = false;
}

async function hsvPropose() {
  if (!api() || !HSV.file || HSD.proposing) return;
  HSD.proposing = true; hsdRender();
  try {
    const reply = await api().hitsound_decide_propose(HSV.file, HSD.profile);
    if (HSV.file !== (reply.file || HSV.file)) { hsdRender(); return; }
    if (!reply.ok) {
      if (reply.key === "no_rust") toast(t("hsv_no_rust"), true);
      else editFailure(reply);
      return;
    }
    hsdAdopt(HSV.file, reply.units, reply.profile);
  } finally {
    HSD.proposing = false;
  }
  renderHitsoundsView();
  hsdTicked();
}

// Every difficulty beside the song in one run of the sidecar: deciding is
// mostly the song's work, and the song is the same, so a set costs about
// what one map costs. Each map's proposal is cached, so moving between
// difficulties afterwards asks for nothing.
async function hsvProposeAll() {
  if (!api() || HSD.proposing) return;
  HSD.proposing = true; hsdRender();
  let reply;
  try {
    reply = await api().hitsound_decide_propose_all(HSD.profile);
  } finally {
    HSD.proposing = false;
  }
  if (!reply.ok) {
    if (reply.key === "no_rust") toast(t("hsv_no_rust"), true);
    else editFailure(reply);
    renderHitsoundsView();
    return;
  }
  const bad = reply.maps.filter((m) => m.error !== undefined).length;
  const done = reply.maps.length - bad;
  toast(bad ? t(bad === 1 ? "hsv_all_some_one" : "hsv_all_some", { n: done, of: reply.maps.length, bad })
    : t(done === 1 ? "hsv_all_one" : "hsv_all_done", { n: done }));
  // the difficulty on screen shows its own share of the run
  const mine = HSV.file && reply.maps.find((m) => m.file === HSV.file);
  if (mine && mine.error === undefined) {
    const cached = await api().hitsound_decide_cached(HSV.file);
    if (cached.ok && HSV.file === cached.file) hsdAdopt(HSV.file, cached.units, cached.profile);
  }
  renderHitsoundsView();
  hsdTicked();
}

// Tick or untick the proposals of the sounds shown: every one, with no
// filter and no bars.
function hsdSetAll(on) {
  for (const s of hsvShown()) {
    const unit = hsdUnitFor(s);
    if (!unit) continue;
    const key = hsdKey(unit.object, unit.part, unit.edge);
    if (on) HSD.accepted.add(key); else HSD.accepted.delete(key);
  }
  $("hsvDecidePrevText").textContent = "";
  renderHitsoundsView();
  hsdTicked();
}

async function hsdPreview() {
  if (!api() || !hsdHas()) return;
  const reply = await api().hitsound_decide_preview(HSV.file, hsdAcceptList(), hsdEditList(), hsdChoiceList());
  if (!reply.ok) {
    if (reply.key === "no_proposal") toast(t("hsv_no_proposal"), true);
    else editFailure(reply);
    return reply;
  }
  $("hsvDecidePrevText").textContent = t("hsv_would_change",
    { what: hsdWhat(reply), n: reply.would_change });
  return reply;
}

async function hsdWrite(copy) {
  if (!api() || !hsdHas()) return;
  const preview = await hsdPreview();
  if (!preview || !preview.ok || !preview.would_change) return;
  const ok = confirm(t(copy ? "hsv_confirm_copy" : "hsv_confirm_write",
    { n: preview.would_change, file: HSV.file }));
  if (!ok) return;
  const reply = await api().hitsound_decide_apply(HSV.file, hsdAcceptList(), copy, hsdEditList(),
                                                hsdChoiceList());
  if (!reply.ok) { editFailure(reply); return; }
  HSD.units = []; HSD.byKey = new Map(); HSD.accepted = new Set(); HSD.choice = new Map();
  HSD.edits = new Map();
  HSD.undo = reply.undo;
  $("hsvDecidePrevText").textContent = "";
  // A copy names the file it wrote, not the original it left alone.
  const written = copy && reply.dest ? String(reply.dest).split(/[\\/]/).pop() : HSV.file;
  toast(t(copy ? "hsv_done_copy" : "hsv_done", { n: reply.changed.length, file: written }));
  await hsvPick(HSV.file);
  if (HSP.file === HSV.file) await hsPick(HSV.file);
  renderHitsoundsView();
}

async function hsdUndo() {
  if (!api()) return;
  const reply = await api().hitsound_decide_undo();
  if (!reply.ok) { editFailure(reply); return; }
  HSD.units = []; HSD.byKey = new Map(); HSD.accepted = new Set(); HSD.choice = new Map();
  HSD.edits = new Map();
  HSD.undo = false;
  toast(t("hsv_undone", { file: reply.file }));
  await hsvPick(reply.file);
  if (HSP.file === reply.file) await hsPick(reply.file);
  renderHitsoundsView();
}

// ------------------------------------------------------------------ hitsound difficulty
// Phase 6, H5 export: a new difficulty with a circle at every sound of the
// mapset, each playing it exactly, to hitsound in one place and copy from.
const HSDF = { preview: null };

async function hsdfMaps() {
  const box = $("hsdSource");
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  // The densest difficulty first: the natural source, and the first to fill from.
  maps.sort((a, b) => b.objects - a.objects);
  const keep = box.value;
  box.innerHTML = maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  if (maps.some((m) => m.file === keep)) box.value = keep;
  box.disabled = $("hsdPreviewBtn").disabled = !maps.length;
  HSDF.preview = null;
  hsdfRender();
}

function hsdfRender() {
  const p = HSDF.preview;
  $("hsdWriteBtn").disabled = !(p && p.circles);
  if (!p) { $("hsdResult").textContent = ""; return; }
  const name = ($("hsdSource").selectedOptions[0] || {}).textContent || p.file;
  $("hsdResult").textContent = [
    t("hsd_would", { dest: p.dest, n: p.circles, src: p.from_source, name, others: p.from_others, merged: p.merged }),
    p.stacked ? t("hsd_stacked", { n: p.stacked, time: fmtTime(p.stacked_times[0]) }) : "",
    p.inexact ? t("hsd_inexact", { n: p.inexact, time: fmtTime(p.inexact_times[0]) }) : t("hsd_exact"),
  ].filter(Boolean).join(" ");
}

async function hsdfPreview() {
  const file = $("hsdSource").value;
  if (!api() || !file) return;
  const reply = await api().hitsound_difficulty_preview(file, $("hsdFill").checked);
  HSDF.preview = reply.ok ? reply : null;
  hsdfRender();
  // One is there already: the card says so where the preview would be.
  if (reply.key === "hsd_exists") $("hsdResult").textContent = t("hsd_exists", { dest: reply.dest });
  else if (!reply.ok) editFailure(reply);
}

async function hsdfWrite() {
  const p = HSDF.preview;
  if (!api() || !p || !p.circles) return;
  if (!confirm(t("hsd_confirm", { dest: p.dest }))) return;
  const reply = await api().hitsound_difficulty_write(p.file, $("hsdFill").checked);
  if (reply.key === "hsd_exists") { toast(t("hsd_exists", { dest: reply.dest }), true); return; }
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("hsd_done", { dest: reply.dest, n: reply.circles }));
  // The new difficulty is one of the song's now: its lists pick it up, and
  // what the transport plays stays as it is.
  $("hsvMap").dataset.for = "";
  await hsMapsRefresh();
  await hsdfMaps();
}

// The transport's list of difficulties again, what it plays untouched.
async function hsMapsRefresh() {
  if (!api()) return;
  const box = $("pbHs"), keep = box.value;
  const reply = await api().song_maps();
  const maps = reply.ok ? reply.maps : [];
  box.innerHTML = `<option value="">${t("pb_hs_off")}</option>` +
    maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  box.disabled = !maps.length;
  hsProposalOption(hsdHas() ? HSD.file : "");
  box.value = keep;
}

// ------------------------------------------------------------------ samples
// Phase 6, H6: the sample bank. A folder's samples as playback reads them:
// the song's own folder, the playback skin, or any folder picked. Every cell
// plays its sample, or what plays in its place; the last one heard can play
// over the song in place of the sound selected in the Sounds table. The skin
// playback asks is a setting, and changing it reloads what the transport holds.
const SB = { reply: null, source: "song", for: "", sel: null, buffers: new Map(), token: 0,
             loading: false, skinFound: null };
// The song before and after the sound an audition replaces, in seconds.
const SB_LEAD = 1, SB_TAIL = 1.5;

function sbSkin() { return (ST.settings && ST.settings.skin_folder) || ""; }
function sbBase(path) { return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path); }

// A few names, then how many more.
function sbList(names, max = 4) {
  return names.slice(0, max).join(", ") + (names.length > max ? `, ${t("sb_more", { n: names.length - max })}` : "");
}

// Where a cell's or a numbered sample's sound comes from: its own file, or
// for a missing cell the skin's or Overtone's, named so a hearing says which.
function sbWhere(entry) {
  const bank = SB.reply.bank;
  if (entry.file) return { folder: bank.folder, file: entry.file, label: entry.file };
  const f = entry.fallback;
  return { folder: f.folder, file: f.file,
           label: `${f.source === "skin" ? sbBase(f.folder) : "Overtone"} · ${f.file}` };
}

function sbIsSel(where) { return !!SB.sel && SB.sel.folder === where.folder && SB.sel.file === where.file; }

// The shown folder again: the song's own, the playback skin's, or the one picked.
async function sbLoad(source) {
  if (!api()) return;
  if (source === "skin" && !sbSkin()) source = "song";
  const folder = source === "skin" ? sbSkin() : source === "pick" && SB.reply ? SB.reply.bank.folder : "";
  const token = ++SB.token;
  SB.loading = true;
  $("sbCounts").textContent = t("sb_loading");
  const reply = await api().sample_bank(folder);
  if (token !== SB.token) return;
  SB.loading = false;
  sbTake(reply, source);
}

async function sbPick() {
  if (!api()) return;
  const token = ++SB.token;
  const reply = await api().pick_sample_folder();
  if (token !== SB.token) return;
  SB.loading = false;
  if (!reply.ok) { if (reply.key !== "cancelled") editFailure(reply); sbRender(); return; }
  sbTake(reply, "pick");
}

function sbTake(reply, source) {
  if (!reply.ok) {
    // A playback skin that moved away is said on the card, which shows the
    // song's folder instead.
    if (source === "skin" && reply.key === "bad_folder") { SB.skinFound = false; sbLoad("song"); return; }
    editFailure(reply);
    SB.reply = null;
    sbRender();
    return;
  }
  SB.reply = reply; SB.source = source; SB.buffers = new Map();
  SB.for = source === "song" && S.result ? S.result.path : SB.for;
  SB.skinFound = sbSkin() ? !!reply.skin : null;
  sbRender();
}

// The Hitsounds view opened: the song's folder is read again for a new song.
function sbView() {
  if (!S.result) return;
  if (!SB.reply || (SB.source === "song" && SB.for !== S.result.path)) sbLoad(SB.source);
  else sbRender();
}

function sbCell(c, i) {
  const where = sbWhere(c), on = sbIsSel(where) ? " on" : "";
  if (c.file) {
    const ext = c.file.split(".").pop().toLowerCase();
    const kb = c.bytes === null ? "?" : (c.bytes / 1024).toFixed(1);
    const title = c.empty ? t("sb_cell_empty_title", { file: c.file }) : t("sb_cell_title", { file: c.file, kb });
    return `<button type="button" class="sb-cell${c.empty ? " empty" : ""}${on}" data-sb-cell="${i}" title="${esc(title)}">`
      + `${esc(c.empty ? t("sb_cell_empty") : `${ext} · ${kb} KB`)}</button>`;
  }
  const skin = c.fallback.source === "skin";
  const title = t(skin ? "sb_cell_skin_title" : "sb_cell_own_title", { file: c.fallback.file })
    + (c.fallback.empty ? ` · ${t("sb_cell_empty")}` : "");
  return `<button type="button" class="sb-cell miss${c.fallback.empty ? " empty" : ""}${on}" data-sb-cell="${i}" title="${esc(title)}">`
    + `${esc(t(skin ? "sb_cell_skin" : "sb_cell_own"))}</button>`;
}

function sbRender() {
  const r = SB.reply, bank = r && r.bank, skin = sbSkin();
  document.querySelectorAll("#sbSource button").forEach((b) => {
    b.classList.toggle("on", b.dataset.src === SB.source);
    if (b.dataset.src === "skin") b.disabled = !skin;
  });
  $("sbKind").hidden = !bank;
  $("sbName").textContent = bank ? bank.name : "";
  $("sbRows").innerHTML = "";
  $("sbCustom").innerHTML = "";
  $("sbNotes").textContent = "";
  if (bank) {
    $("sbKind").textContent = t(bank.kind === "skin" ? "sb_kind_skin" : "sb_kind_beatmap");
    const c = bank.counts, missing = c.to_skin + c.to_overtone;
    const missingKey = !c.to_skin ? "sb_missing_own" : !c.to_overtone ? "sb_missing_all_skin" : "sb_missing_skin";
    $("sbCounts").textContent = [t("sb_counts", { hits: c.hits, slides: c.slides }),
      missing ? t(missingKey, { n: missing, skin: c.to_skin, own: c.to_overtone }) : "",
      c.empty ? t("sb_counts_empty", { n: c.empty }) : ""].filter(Boolean).join(" · ");
    $("sbRows").innerHTML = bank.sets.map((set) => `<tr><td>${esc(set)}</td>${bank.sounds.map((sound) => {
      const i = bank.cells.findIndex((x) => x.set === set && x.sound === sound);
      return `<td>${i < 0 ? "" : sbCell(bank.cells[i], i)}</td>`;
    }).join("")}</tr>`).join("");
    if (bank.custom.length) {
      const head = bank.kind === "skin" ? t("sb_custom_skin", { n: bank.custom.length })
        : t("sb_custom_beatmap", { list: sbList(bank.indices.map(String), 12), n: bank.custom.length });
      $("sbCustom").innerHTML = `<div class="card-sub">${esc(head)}</div><div class="chips">`
        + bank.custom.map((x, i) => `<button type="button" class="chip${x.empty ? " empty" : ""}${sbIsSel(sbWhere(x)) ? " on" : ""}" data-sb-custom="${i}"`
          + ` title="${esc(x.empty ? t("sb_cell_empty_title", { file: x.file }) : t("sb_cell_title", { file: x.file, kb: x.bytes === null ? "?" : (x.bytes / 1024).toFixed(1) }))}">${esc(x.file)}</button>`).join("")
        + `</div>`;
    }
    const shadowed = [...bank.cells, ...bank.custom].flatMap((x) => x.shadowed || []);
    $("sbNotes").textContent = [bank.unused.length ? t("sb_unused", { n: bank.unused.length, names: sbList(bank.unused) }) : "",
      shadowed.length ? t("sb_shadowed", { n: shadowed.length, names: sbList(shadowed) }) : ""].filter(Boolean).join(" ");
  } else {
    $("sbCounts").textContent = SB.loading ? t("sb_loading") : "";
  }
  $("sbSkinText").textContent = !skin ? t("sb_skin_none")
    : SB.skinFound === false ? t("sb_skin_gone", { path: skin }) : t("sb_skin_is", { name: sbBase(skin) });
  // A skin is a folder without maps, and never the song's own folder.
  $("sbUse").hidden = !(bank && bank.kind === "skin" && !r.song && !r.in_use);
  $("sbStop").hidden = !skin;
  sbRenderHear();
}

// The sound an audition would replace: the row selected in the Sounds table.
function sbSound() {
  return HSV.report && HSV.selected !== null ? HSV.report.sounds[HSV.selected] || null : null;
}

function sbRenderHear() {
  const s = sbSound(), sel = SB.sel, hearing = P.playing && P.swap && P.swap.label ? P.swap : null;
  $("sbHear").disabled = !(sel && s);
  $("sbHearText").textContent = hearing ? t("sb_hearing", { sample: hearing.label, time: fmtTime(hearing.t) })
    : !$("hsvMap").options.length ? t("sb_hear_no_map")
    : !sel ? t("sb_hear_pick")
    : !s ? t("sb_hear_sound", { sample: sel.label })
    : t("sb_hear_ready", { sample: sel.label, time: fmtTime(s.t), bar: s.bar ?? "—", beat: slotLabel(s.slot, s.meter) });
}

// A sample's decode, once per folder load: {empty, buffer}, or null when it
// cannot be read or decoded (said in a toast).
async function sbBuffer(where) {
  const key = `${where.folder}|${where.file}`;
  if (SB.buffers.has(key)) return SB.buffers.get(key);
  const reply = await api().sample_audition(where.folder, where.file);
  if (!reply.ok) { editFailure(reply); return null; }
  let got = { empty: true, buffer: null };
  if (!reply.empty) {
    const raw = atob(reply.data), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    try { got = { empty: false, buffer: await pbContext().decodeAudioData(bytes.buffer) }; }
    catch (err) { toast(t("pb_hs_unreadable", { n: 1 }), true); return null; }
  }
  SB.buffers.set(key, got);
  return got;
}

// A cell or a numbered sample clicked: heard now, alone, and kept for the song.
async function sbHearAlone(where) {
  if (!api()) return;
  SB.sel = where;
  sbRender();
  const got = await sbBuffer(where);
  if (!got) return;
  if (got.empty) { toast(t("sb_empty_heard", { file: where.file })); return; }
  const ctx = pbContext();
  if (ctx.state === "suspended") await ctx.resume();
  pbBufferAt(ctx.currentTime + 0.02, got.buffer, 1);
}

// The kept sample over the song: from a second before the selected sound, in
// its place (a mute plays silence there), at the sound's own volume.
async function sbHearAtSound() {
  const s = sbSound(), where = SB.sel;
  if (!api() || !s || !where) return;
  const got = await sbBuffer(where);
  if (!got) return;
  await pbPlay(Math.max(0, s.t - SB_LEAD), {
    t: s.t, buffer: got.buffer, label: where.label, until: s.t + SB_TAIL,
    volume: Math.max(0.05, Math.min(1, (s.volume ?? 100) / 100)), onEnd: sbRenderHear });
  sbRenderHear();
}

// The playback skin chosen or dropped: kept as a setting, and what the
// transport holds is loaded again with it.
async function sbSetSkin(folder) {
  if (!api()) return;
  const reply = await api().set_settings({ skin_folder: folder });
  if (!reply.ok) { editFailure(reply); return; }
  stTake(reply);
  SB.skinFound = folder ? true : null;
  toast(folder ? t("sb_used", { name: sbBase(folder) }) : t("sb_stopped"));
  for (const key of Object.keys(HSP.decoded)) if (key.startsWith("skin:")) delete HSP.decoded[key];
  if (HSP.file) {
    await hsPick($("pbHs").value);
    if (HSV.report) renderHitsoundsView();
  }
  await sbLoad(SB.source === "skin" && !folder ? "song" : SB.source);
}

async function dropAnalyze(file) {
  if (!api() || S.busy) return;
  const options = readOptions();
  if (!options) { toast(t("bad_values"), true); openDrawer(true); return; }
  setBusy(true, file.name);
  let dataUrl = "";
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  } catch (err) {
    setBusy(false);
    toast(t("bad_drop"), true);
    return;
  }
  S.pendingDrop = { name: file.name, size_mb: Math.round((file.size / 1048576) * 10) / 10 };
  const reply = await api().analyze_bytes(file.name, String(dataUrl).split(",")[1] || "", options);
  if (!reply.ok) { S.pendingDrop = null; setBusy(false); toast(t(reply.key, { detail: reply.detail || "" }), true); }
}

function wireDrop() {
  const overlay = $("dropOverlay");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => { if (!overlay.hidden) e.preventDefault(); });
  document.addEventListener("dragleave", () => {
    if (overlay.hidden) return;
    if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; }
  });
  document.addEventListener("drop", (e) => {
    if (overlay.hidden) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const file = [...(e.dataTransfer.files || [])].find((f) => AUDIO_EXT.test(f.name));
    if (!file) { toast(t("bad_drop"), true); return; }
    dropAnalyze(file);
  });
}

// ------------------------------------------------------------------ map vs detected
const CMP_STR = {
  map_octave: "cmp_octave_f", map_bpm: "cmp_bpm_f", map_offset: "cmp_offset_f",
  map_count: "cmp_count_f", map_no_reds: "cmp_no_reds_f", map_unreadable: "cmp_unreadable_f",
};

async function compareOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().compare(target);
  if (!reply.ok) { editFailure(reply); return; }
  const sug = await api().suggest(target);
  S.comparePath = target;
  S.compare = { file: reply.file, report: reply.report,
                suggestions: sug.ok ? sug.suggestions : [] };
  renderCompare();
}

async function refreshCompare() {
  if (!api() || !S.result || !S.comparePath) return;
  const reply = await api().compare(S.comparePath);
  if (!reply.ok) {
    S.compare = null;
    S.comparePath = null;
    renderCompare();
    return;
  }
  const sug = await api().suggest(S.comparePath);
  S.compare = { file: reply.file, report: reply.report,
                suggestions: sug.ok ? sug.suggestions : [] };
  renderCompare();
}

function renderCompare() {
  const body = $("cmpBody"), cmp = S.compare;
  if (!cmp) {
    $("cmpCount").hidden = true;
    $("cmpFile").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("cmp_empty")}</div>`;
    return;
  }
  const { report, file } = cmp;
  $("cmpFile").textContent = file;
  const pill = $("cmpCount");
  pill.hidden = false;
  pill.textContent = t("cmp_sections", { n: report.sections.length });
  const banners = report.findings.map((f) => `
    <div class="banner ${f.level === "info" ? "info" : ""}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div>${t(CMP_STR[f.key] || "error", { ...f.values, n: f.index + 1 })}</div>
    </div>`).join("");
  const rows = report.sections.map((r) => {
    // Display thresholds, same bars as the engine findings.
    const badB = r.bpm_error > 1, badM = r.offset_error_ms > 5;
    return `<tr>
      <td><span class="idx">${r.index + 1}</span></td>
      <td class="num">${r.det_offset_ms.toFixed(1)}</td>
      <td class="num">${r.det_bpm.toFixed(3)}</td>
      <td class="num">${r.map_offset_ms.toFixed(1)}</td>
      <td class="num">${r.map_bpm.toFixed(3)}</td>
      <td class="num ${badB ? "neg" : ""}">${r.bpm_error.toFixed(3)}</td>
      <td class="num ${badM ? "neg" : ""}">${r.offset_error_ms.toFixed(1)}</td>
      <td>${r.octave === 1 ? "×1" : `<span class="pill amber">×${r.octave}</span>`}</td>
    </tr>`;
  }).join("");
  const sug = (cmp.suggestions || []).map((s) => `
    <tr>
      <td><span class="idx">${s.index + 1}</span></td>
      <td class="num">${s.offset_ms.toFixed(1)}</td>
      <td class="num">${s.bpm.toFixed(3)}${s.octave
        ? ` <span class="pill amber" title="${esc(t("sug_octave_tip", { b: s.map_bpm.toFixed(3) }))}">${octaveLabel(s.octave)}</span>` : ""}</td>
      <td class="num">${s.nearest_ms === null ? "—" : s.nearest_ms.toFixed(1)}</td>
      <td><div class="sug-actions">
        <button class="btn small" data-show="${s.index}">${t("sug_show")}</button>
        <button class="btn small" data-add="${s.index}">${t("sug_add")}</button>
      </div></td>
    </tr>`).join("");
  body.innerHTML = `
    ${banners ? `<div class="warnings">${banners}</div>` : ""}
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>#</th><th>${t("cmp_det_off")}</th><th>${t("cmp_det_bpm")}</th>
          <th>${t("cmp_map_off")}</th><th>${t("cmp_map_bpm")}</th>
          <th>${t("cmp_dbpm")}</th><th>${t("cmp_dms")}</th><th>${t("cmp_oct")}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card-head flush">
      <div class="card-title">${t("sug_title")}</div>
      <div class="spacer"></div>
      <span class="card-sub">${t((cmp.suggestions || []).length ? "sug_hint" : "sug_empty")}</span>
    </div>
    ${sug ? `<div class="table-scroll">
      <table>
        <thead><tr><th>#</th><th>${t("cmp_det_off")}</th><th>${t("cmp_det_bpm")}</th><th>${t("cmp_dms")}</th><th></th></tr></thead>
        <tbody>${sug}</tbody>
      </table>
    </div>` : ""}`;
}

// ×2, ×4, ÷2 or ÷4: how a suggestion's tempo stands to the map's own there.
function octaveLabel(factor) {
  return factor >= 1 ? `×${Math.round(factor)}` : `÷${Math.round(1 / factor)}`;
}

// One suggestion into the map (Phase 9): the preview names what the write
// adds and what it moves, nothing is written without that consent, and the
// list is read again after, since the new red line answers its suggestion.
async function suggestAdd(index) {
  if (!api() || !S.result || S.busy || !S.comparePath) return;
  const prev = await api().suggest_preview(S.comparePath, index);
  if (!prev.ok) {
    editFailure(prev);
    if (prev.key === "suggestion_gone") refreshCompare();
    return;
  }
  const s = prev.summary;
  const lines = [t("sug_add_line", { o: s.offset_ms, b: s.bpm.toFixed(3), m: s.meter })];
  // Twice or four times the map's own tempo there is more often the same
  // pulse counted differently than a change the map lacks (Corpus B: every
  // slider shift past 25 ms came from one of these). The engine says which.
  const octave = prev.suggestion.octave;
  if (octave) lines.push(t("sug_add_octave", { k: octaveLabel(octave), b: prev.suggestion.map_bpm.toFixed(3) }));
  if (s.greens_added) lines.push(t("sug_add_green"));
  if (s.objects) lines.push(t("sug_add_objects", { n: s.objects }));
  if (s.slider_ends_moved) {
    lines.push(t("sug_add_sliders", { n: s.slider_ends_moved, d: Math.abs(s.max_end_shift_ms).toFixed(1),
                                      dir: t(s.max_end_shift_ms < 0 ? "sug_earlier" : "sug_later") }));
  }
  if (!confirm(t("sug_add_confirm", { file: prev.file, lines: lines.join("\n") }))) return;
  const done = await api().suggest_apply(S.comparePath, index, prev.suggestion.offset_ms);
  if (!done.ok) {
    editFailure(done);
    if (done.key === "suggestion_gone") refreshCompare();
    return;
  }
  toast(t("sug_added", { o: done.summary.offset_ms, file: done.file }));
  refreshCompare();
}

// ------------------------------------------------------------------ alignment
const ALIGN_STR = {
  objects_off_grid: "align_off_f", attacks_without_objects: "align_unc_f",
  no_attacks: "align_none_f",
};

async function alignOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().align(target);
  if (!reply.ok) { editFailure(reply); return; }
  S.align = { file: reply.file, report: reply.report };
  renderAlign();
}

function renderAlign() {
  const body = $("alignBody"), al = S.align;
  if (!al) {
    $("alignCount").hidden = true;
    $("alignFile").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("align_empty")}</div>`;
    return;
  }
  const { report, file } = al;
  $("alignFile").textContent = file;
  const pill = $("alignCount");
  pill.hidden = false;
  pill.textContent = t("align_counts", { m: report.matched, o: report.objects,
                                        c: report.covered, a: report.attacks });
  const banners = report.findings.map((f) => `
    <div class="banner ${f.level === "info" ? "info" : ""}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div>${t(ALIGN_STR[f.key] || "error", f.values)}</div>
    </div>`).join("");
  const rows = report.offenders.map((o) => `
    <tr>
      <td class="num">${o.time.toFixed(1)}</td>
      <td>${o.kind || "?"}</td>
      <td class="num neg">${o.ms.toFixed(1)}</td>
    </tr>`).join("");
  const shown = report.uncovered.slice(0, 20);
  const rest = report.uncovered.length - shown.length;
  body.innerHTML = `
    ${banners ? `<div class="warnings">${banners}</div>` : ""}
    ${rows ? `<div class="table-scroll">
      <table>
        <thead><tr><th>${t("align_t_time")}</th><th>${t("align_t_kind")}</th><th>${t("align_t_ms")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ""}
    ${shown.length ? `<div class="card-sub mt-m">${t("align_uncovered")} ${shown.map((ms) => ms.toFixed(1)).join(", ")}${rest > 0 ? ` ${t("align_more", { n: rest })}` : ""}</div>` : ""}`;
}

// ------------------------------------------------------------------ density
async function densityOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().density(target);
  if (!reply.ok) { editFailure(reply); return; }
  S.density = { file: reply.file, report: reply.report };
  renderDensity();
}

function renderDensity() {
  const body = $("denBody"), den = S.density;
  if (!den) {
    $("denCount").hidden = true;
    $("denFile").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("den_empty")}</div>`;
    return;
  }
  const { report, file } = den;
  $("denFile").textContent = file;
  const pill = $("denCount");
  pill.hidden = false;
  pill.textContent = t("den_counts", { o: report.objects, p: report.peak_per_second,
                                      s: report.stream, j: report.jump });
  const rows = report.buckets.map((b) => `
    <tr>
      <td class="num">${b.t0.toFixed(1)}–${b.t1.toFixed(1)}</td>
      <td class="num">${b.objects}</td>
      <td class="num">${b.per_second.toFixed(1)}</td>
      <td class="num">${b.stream}</td>
      <td class="num">${b.jump}</td>
      <td class="num">${b.single}</td>
    </tr>`).join("");
  body.innerHTML = `
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>${t("den_t_range")}</th><th>${t("den_t_n")}</th><th>${t("den_t_rate")}</th>
          <th>${t("den_t_stream")}</th><th>${t("den_t_jump")}</th><th>${t("den_t_single")}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------------ snap audit
async function snapOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().snap(target);
  if (!reply.ok) { editFailure(reply); return; }
  S.snap = { file: reply.file, report: reply.report };
  renderSnap();
}

function renderSnap() {
  const body = $("snapBody"), snap = S.snap;
  if (!snap) {
    $("snapCount").hidden = true;
    $("snapFile").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("snap_empty")}</div>`;
    return;
  }
  const { report, file } = snap;
  $("snapFile").textContent = file;
  const pill = $("snapCount");
  if (!report.ok) {
    pill.hidden = true;
    body.innerHTML = `<div class="card-sub">${t("snap_no_reds")}</div>`;
    return;
  }
  pill.hidden = false;
  pill.textContent = t("snap_counts", { s: report.snapped, o: report.objects,
                                       u: report.unsnapped.length });
  const ms = (list) => list.map((x) => x.toFixed(0)).join(", ");
  const notes = [];
  const moved = report.with_detected_timing;
  if (moved) {
    notes.push(moved.would_unsnap.length
      ? t("snap_inject", { n: moved.would_unsnap.length, m: moved.would_snap })
      : t("snap_inject_none"));
  }
  if (report.before_first_red.length) notes.push(`${t("snap_before")} ${ms(report.before_first_red)}`);
  if (report.past_audio && report.past_audio.length) notes.push(`${t("snap_past")} ${ms(report.past_audio)}`);
  if (report.unparsed) notes.push(t("snap_unparsed", { n: report.unparsed }));
  const rows = report.unsnapped.slice(0, 200).map((o) => `
    <tr>
      <td class="num">${o.time_ms.toFixed(0)}</td>
      <td>${esc(o.kind || "?")}</td>
      <td class="num">1/${o.nearest_divisor}</td>
      <td class="num neg">${o.off_ms.toFixed(1)}</td>
    </tr>`).join("");
  body.innerHTML = `
    ${notes.map((n) => `<div class="card-sub">${n}</div>`).join("")}
    ${rows ? `<div class="table-scroll mt-s">
      <table>
        <thead><tr><th>${t("snap_t_time")}</th><th>${t("snap_t_kind")}</th><th>${t("snap_t_div")}</th><th>${t("snap_t_off")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ""}
    <div class="card-sub mt-m">${t("snap_starts")}</div>`;
}

// ------------------------------------------------------------------ re-snap objects
// After a timing change, snapped objects ride the drift onto the detected
// grid; off-grid ones stay put and are listed. Runs before injecting, while
// the map still has its old red lines.
const RSNP = { path: null, preview: null, song: "" };

async function resnapPick() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().resnap_preview(target);
  if (!reply.ok) { editFailure(reply); return; }
  RSNP.path = target; RSNP.preview = reply;
  RSNP.song = (S.result && S.result.path) || "";
  renderResnap();
}

async function resnapApply() {
  if (!api() || !S.result || S.busy || !RSNP.preview || !RSNP.path) return;
  const p = RSNP.preview;
  if (!p.changed) { toast(t("rs_clean")); return; }
  const name = String(RSNP.path).split(/[\\/]/).pop();
  if (!confirm(t("rs_confirm", { n: p.changed, file: name }))) return;
  const reply = await api().resnap_apply(RSNP.path);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("rs_done", { n: reply.changed, file: name }));
  const fresh = await api().resnap_preview(RSNP.path);
  RSNP.preview = fresh.ok ? fresh : null;
  renderResnap();
}

function renderResnap() {
  const body = $("rsBody");
  if (RSNP.song && S.result && RSNP.song !== S.result.path) { RSNP.path = null; RSNP.preview = null; }
  const p = RSNP.preview;
  if (!RSNP.path || !p) {
    $("rsCount").hidden = true;
    $("rsFile").textContent = "";
    $("rsApply").disabled = true;
    body.innerHTML = `<div class="card-sub">${t("rs_sub")}</div>`;
    return;
  }
  $("rsFile").textContent = p.file;
  const pill = $("rsCount");
  // Re-snapped already, the counts are a second move that will not happen.
  pill.hidden = !!p.resnapped;
  pill.textContent = t("rs_would", { moved: p.moved, changed: p.changed, left: p.left.length });
  // Re-snapped and not injected since: another apply would move them twice.
  $("rsApply").disabled = !p.changed || !!p.resnapped;
  const rows = p.left.slice(0, 10).map((o) => `
    <tr>
      <td class="num">${o.time_ms.toFixed(0)}</td>
      <td>${esc(o.kind || "?")}</td>
      <td class="num">1/${o.nearest_divisor}</td>
      <td class="num neg">${o.off_ms.toFixed(1)}</td>
    </tr>`).join("");
  body.innerHTML = p.resnapped ? `<div class="card-sub">${t("resnapped")}</div>` : `
    <div class="card-sub">${t("rs_would", { moved: p.moved, changed: p.changed, left: p.left.length })}</div>
    ${rows ? `<div class="table-scroll mt-s">
      <table>
        <thead><tr><th>${t("snap_t_time")}</th><th>${t("snap_t_kind")}</th><th>${t("snap_t_div")}</th><th>${t("snap_t_off")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${p.left.length > 10 ? `<div class="card-sub">${t("rs_left_more", { n: p.left.length - 10 })}</div>` : ""}` : ""}`;
}

// ------------------------------------------------------------------ reference timing
// Any map of this song, graded line by line against the attacks. Read only
// until "Use as working timing", which is one undo step.
const REF_STR = { ref_shift: "ref_shift_f", ref_split: "ref_split_f", ref_before: "ref_before_f" };

async function refPick() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (target) refGrade(target);
}

async function refGrade(target) {
  if (!api() || !S.result || S.busy) return;
  const reply = await api().reference_grade(target);
  if (!reply.ok) { editFailure(reply); return; }
  S.ref = { path: reply.path, file: reply.file, report: reply.report, same: reply.same_audio,
            format: reply.format || "osu" };
  renderRef();
}

async function refFind() {
  if (!api() || !S.result || S.busy) return;
  let reply = await api().reference_find("");
  if (!reply.ok && reply.key === "no_songs") {
    toast(t("no_songs"));
    const folder = await api().pick_folder();
    if (!folder) return;
    reply = await api().reference_find(folder);
  }
  if (!reply.ok) { editFailure(reply); return; }
  S.refFind = reply.report;
  renderRef();
}

async function refLoad() {
  if (!api() || !S.result || S.busy || !S.ref || !S.ref.report.ok) return;
  if (!confirm(t("ref_load_confirm", { n: S.result.points.length, m: S.ref.report.lines.length,
                                       file: S.ref.file }))) return;
  const reply = await api().reference_load(S.ref.path);
  if (!reply.ok) { editFailure(reply); return; }
  S.locks = reply.locks || [];
  showEditResult(reply, t("ref_loaded", { n: reply.loaded, file: S.ref.file }));
}

// "12.3 ±1.4": the error and two of its standard errors, or just the error
// when there was no spread to measure.
function withSe(value, se) {
  const v = `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
  return se === null || se === undefined ? v : `${v} <span class="muted">±${(2 * se).toFixed(1)}</span>`;
}

function renderRefFind() {
  const found = S.refFind;
  if (!found) return "";
  const maps = found.matches.flatMap((m) => m.beatmaps.map((b) => ({ ...b, folder: m.folder })));
  const root = esc(found.root);
  if (!maps.length) return `<div class="card-sub">${t("ref_found_none", { root, s: found.scanned })}</div>`;
  const indexed = found.indexed ? ` <span class="muted">${t("ref_indexed", { when: esc(when(found.scanned_at)) })}</span>` : "";
  return `<div class="card-sub">${t("ref_found", { n: maps.length, root })}${indexed}</div>
    <div class="stack tight mt-s mb-m">${maps.map((b, i) => `
      <div class="recent-item static">
        <span class="name">${esc(b.difficulty)} <span class="muted">· ${esc(b.folder.split(/[\\/]/).pop())}</span></span>
        <button class="btn small" data-ref-grade="${i}">${t("ref_grade")}</button>
      </div>`).join("")}</div>`;
}

function renderRef() {
  const body = $("refBody"), ref = S.ref, pill = $("refCount");
  const found = renderRefFind();
  if (!ref) {
    pill.hidden = true;
    $("refFile").textContent = "";
    body.innerHTML = `${found}<div class="card-sub">${t("ref_empty")}</div>`;
  } else {
    const { report, file } = ref;
    $("refFile").textContent = file;
    if (!report.ok) {
      pill.hidden = true;
      body.innerHTML = `${found}<div class="card-sub">${t(report.reason === "no_attacks" ? "ref_no_attacks" : "ref_no_reds")}</div>`;
    } else {
      const c = report.counts;
      pill.hidden = false;
      pill.textContent = t("ref_counts", { ok: c.ok, check: c.check, weak: c.weak, few: c.too_few });
      // Timing read from another game names the game and says the audio was
      // not checked, rather than the .osu wording about a missing file.
      const audio = ref.format !== "osu" ? ["info", "ref_imported"]
        : ref.same === true ? ["info", "ref_same"]
        : ref.same === false ? ["", "ref_other"] : ["info", "ref_unknown"];
      const notes = [...report.findings.map((f) => [f.level === "info" ? "info" : "", t(REF_STR[f.key] || "error", f.values)]),
                     [audio[0], t(audio[1])]];
      const banners = notes.map(([level, text]) => `
        <div class="banner ${level}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          <div>${text}</div>
        </div>`).join("");
      const verdict = (l) => {
        const cls = l.verdict === "ok" ? "accent" : l.verdict === "check" ? "amber" : "";
        const why = l.issues.map((k) => t(`ref_${k}`)).join(", ");
        return `<span class="pill ${cls}">${t(`ref_${l.verdict}`)}${why ? ` · ${why}` : ""}</span>`;
      };
      const rows = report.lines.map((l) => {
        const graded = l.verdict === "ok" || l.verdict === "check";
        const measured = l.share !== undefined;
        return `<tr>
          <td><span class="idx">${l.index + 1}</span></td>
          <td class="num">${l.offset_ms.toFixed(0)}</td>
          <td class="num">${l.bpm.toFixed(3)}</td>
          <td class="num">${measured ? `1/${l.divisor}` : "—"}</td>
          <td class="num">${measured ? `${Math.round(l.share * 100)}%` : `${l.attacks}`}</td>
          <td class="num ${l.issues.includes("offset") ? "neg" : ""}">${graded ? withSe(l.relative_ms, l.offset_se_ms) : "—"}</td>
          <td class="num ${l.issues.includes("drift") ? "neg" : ""}">${graded ? withSe(l.drift_ms, l.drift_se_ms) : "—"}</td>
          <td class="num">${graded ? l.fitted_bpm.toFixed(3) : "—"}</td>
          <td>${verdict(l)}</td>
        </tr>`;
      }).join("");
      body.innerHTML = `
        ${found}
        <div class="warnings">${banners}</div>
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>${t("ref_t_line")}</th><th>${t("ref_t_offset")}</th><th>${t("ref_t_bpm")}</th>
              <th>${t("ref_t_div")}</th><th>${t("ref_t_share")}</th><th>${t("ref_t_off")}</th>
              <th>${t("ref_t_drift")}</th><th>${t("ref_t_fit")}</th><th>${t("ref_t_verdict")}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="card-head flush">
          <span class="card-sub">${t("ref_hint")}</span>
          <div class="spacer"></div>
          <button class="btn small" id="refLoad"><span>${t("ref_load")}</span></button>
        </div>`;
      $("refLoad").onclick = refLoad;
      $("refLoad").disabled = S.busy;
    }
  }
  body.querySelectorAll("[data-ref-grade]").forEach((btn) => {
    const maps = S.refFind.matches.flatMap((m) => m.beatmaps);
    btn.onclick = () => refGrade(maps[+btn.dataset.refGrade].path);
  });
}

// ------------------------------------------------------------------ assisted timing
// Two marked downbeats seed the grid; the answer (or the refusal) is read
// only until "Add to timing", which is one undo step.
async function assistFit() {
  if (!api() || !S.result || S.busy) return;
  const first = parseFloat($("asFirst").value), second = parseFloat($("asSecond").value);
  const bars = parseInt($("asBars").value, 10), meter = parseInt($("asMeter").value, 10);
  const reply = await api().assisted_fit(first, second, bars, meter);
  if (!reply.ok) { editFailure(reply); return; }
  S.assist = reply.fit;
  renderAssist();
}

async function assistAdd() {
  if (!api() || !S.result || S.busy || !S.assist || !S.assist.ok) return;
  const fit = S.assist;
  const reply = await api().assisted_apply();
  if (!reply.ok) { editFailure(reply); return; }
  S.assist = null;
  S.locks = reply.locks || [];
  showEditResult(reply, t("as_added", { bpm: fit.bpm.toFixed(3), offset: fit.offset_ms.toFixed(0) }));
}

function renderAssist() {
  const box = $("asResult"), fit = S.assist;
  if (!fit) { box.innerHTML = ""; return; }
  if (!fit.ok) {
    box.innerHTML = `<div class="warnings mt-m"><div class="banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div>${t(`as_${fit.reason}`, fit.values)}</div></div></div>`;
    return;
  }
  const span = { from: (fit.start_ms / 1000).toFixed(1), to: (fit.end_ms / 1000).toFixed(1) };
  const notes = [t("as_moved", { a: `${fit.first_shift_ms >= 0 ? "+" : ""}${fit.first_shift_ms.toFixed(0)}`,
                                 b: `${fit.second_shift_ms >= 0 ? "+" : ""}${fit.second_shift_ms.toFixed(0)}` })];
  const short = fit.short ? `<div class="warnings mt-m"><div class="banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div>${t("as_short", { bars: Math.floor(fit.bars_held) })}</div></div></div>` : "";
  box.innerHTML = `
    <div class="assist-facts">${t("as_facts", { bpm: fit.bpm.toFixed(3), offset: fit.offset_ms.toFixed(0), ...span,
                                                bars: Math.floor(fit.bars_held), div: fit.divisor,
                                                share: Math.round(fit.share * 100) })}</div>
    ${short}
    ${notes.map((n) => `<div class="card-sub mt-s">${n}</div>`).join("")}
    <div class="card-head flush">
      <span class="card-sub">${t("as_add_hint", span)}</span>
      <div class="spacer"></div>
      <button class="btn small" id="asAdd"><span>${t("as_add")}</span></button>
    </div>`;
  $("asAdd").onclick = assistAdd;
  $("asAdd").disabled = S.busy;
}

// ------------------------------------------------------------------ evidence
// Phase 19: the engine's alternatives for the open song. Read only until a
// candidate is used, which writes its BPM into the governing red line
// through the editor's own apply path, so undo and locks behave as usual.
const EV = { data: null, loading: false };

async function evLoad() {
  EV.data = null;
  if (!api() || !S.result) { renderEvidence(); return; }
  EV.loading = true; renderEvidence();
  try {
    const reply = await api().evidence();
    if (!S.result) return;
    if (!reply.ok) { editFailure(reply); return; }
    EV.data = reply.evidence;
  } finally {
    EV.loading = false;
  }
  renderEvidence();
}

function evGoverning(start_s) {
  const points = (S.result && S.result.points) || [];
  let idx = 0;
  points.forEach((p, i) => { if (p.offset_ms <= start_s * 1000 + 1e-6) idx = i; });
  return idx;
}

async function evUse(section, bpm) {
  if (!api() || !S.result || S.busy) return;
  const idx = evGoverning(section.start_s);
  const point = S.result.points[idx];
  selectPoint(idx, false);
  const reply = await api().edit_apply(idx, point.offset_ms, bpm);
  if (!reply.ok) { editFailure(reply); return; }
  showEditResult(reply, t("ev_used", { n: idx + 1, bpm: bpm.toFixed(2) }));
}

function renderEvidence() {
  const card = $("evCard"), body = $("evBody");
  if (!S.result) { card.hidden = true; return; }
  card.hidden = false;
  const ev = EV.data;
  $("evEngine").textContent = S.result.engine;
  if (EV.loading || !ev) { body.innerHTML = `<div class="card-sub">${EV.loading ? t("analyzing") : ""}</div>`; return; }
  if (!ev.sections.length) { body.innerHTML = `<div class="card-sub">${t("ev_note")}</div>`; return; }
  body.innerHTML = ev.sections.map((s, n) => {
    const tags = [
      s.octave_margin !== null && s.octave_margin !== undefined
        ? `<span class="card-sub">${t("ev_margin", { m: s.octave_margin.toFixed(3) })}</span>` : "",
      s.half ? `<span class="card-sub">${t("ev_half")}: ${s.half.bpm.toFixed(2)} (${s.half.coherence.toFixed(3)})</span>` : "",
      s.double ? `<span class="card-sub">${t("ev_double")}: ${s.double.bpm.toFixed(2)} (${s.double.coherence.toFixed(3)})</span>` : "",
    ].filter(Boolean).join(" ");
    const rows = s.candidates.map((c, i) => `
      <tr>
        <td class="num">${c.bpm.toFixed(2)}</td>
        <td><span class="conf"><span class="bar"><b style="width:${Math.round(c.coherence * 100)}%"></b></span><span class="num">${c.coherence.toFixed(3)}</span></span></td>
        <td class="txt">${i === s.seeded ? t("ev_seeded")
          : (s.half && c.bpm === s.half.bpm ? t("ev_half")
          : (s.double && c.bpm === s.double.bpm ? t("ev_double") : ""))}</td>
        <td><button type="button" class="btn small" data-ev-use="${n}:${c.bpm}">${t("ev_use")}</button></td>
      </tr>`).join("");
    return `<div class="card-sub"><b>${t("ev_section", { n: n + 1, from: s.start_s.toFixed(1), to: s.end_s.toFixed(1),
      bpm: s.bpm.toFixed(2), res: s.residual_ms.toFixed(2), cov: Math.round(s.coverage * 100),
      inliers: s.inliers })}</b> ${tags}</div>
      <div class="table-scroll"><table>
        <caption class="card-sub">${t("ev_candidates")}</caption>
        <thead><tr><th>${t("ev_t_bpm")}</th><th>${t("ev_t_coh")}</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }).join("");
  body.querySelectorAll("[data-ev-use]").forEach((button) => {
    button.onclick = () => {
      const [n, bpm] = button.dataset.evUse.split(":");
      evUse(EV.data.sections[+n], parseFloat(bpm));
    };
  });
}

// ------------------------------------------------------------------ ramps
// Phase 19: the elastic curve as red lines. Fit reads the sidecar and caches
// it there; Use loads the lines as hand-placed points through the editor's
// own path, so undo and locks behave as usual.
const RA = { report: null };

async function rampFit() {
  if (!api() || !S.result || S.busy) return;
  const drift = parseFloat($("rampDrift").value);
  const maxRaw = $("rampMax").value;
  const reply = await api().ramps(drift, maxRaw === "" ? null : maxRaw);
  if (!reply.ok) { editFailure(reply); return; }
  RA.report = reply.report;
  renderRamps();
}

async function rampUse() {
  if (!api() || !S.result || S.busy || !RA.report) return;
  const reply = await api().ramps_use();
  if (!reply.ok) {
    if (reply.key === "no_ramps") toast(t("ramp_no_ramps"), true);
    else if (reply.key === "ramps_not_recommended") toast(t("ramp_not_recommended"), true);
    else editFailure(reply);
    return;
  }
  showEditResult(reply, t("ramp_used", { n: reply.loaded }));
}

function renderRamps() {
  const box = $("rampResult"), report = RA.report;
  $("rampCard").hidden = !S.result;
  // The engine's own selector decides: where the sections read better, the
  // lines are a real song's jitter cut into two-attack grids at any BPM
  // (184 lines, 173-794 BPM on a steady 172 BPM song), so none are offered.
  const usable = !!report && report.recommend_ramps && report.lines.length > 0;
  $("rampUse").disabled = !usable;
  if (!report) { box.innerHTML = ""; return; }
  const rows = report.tradeoff.map((row) =>
    t("ramp_trade_row", { drift: row.drift_ms, n: row.lines })).join(" · ");
  if (!report.recommend_ramps) {
    box.innerHTML = `<div class="card-sub">${t("ramp_piecewise")}</div>`;
    return;
  }
  box.innerHTML = `
    <div class="card-sub">${t("ramp_lines", { n: report.lines.length, ms: report.drift_ms })}
      ${t("ramp_recommend")}</div>
    <div class="card-sub mt-s">${t("ramp_tradeoff", { rows })}</div>
    <div class="table-scroll mt-s"><table>
      <thead><tr><th>${t("ev_t_bpm")}</th><th>${t("ramp_t_at")}</th><th>${t("ramp_t_attacks")}</th></tr></thead>
      <tbody>${report.lines.map((line) => `
        <tr>
          <td class="num">${line.bpm.toFixed(2)}</td>
          <td class="num">${(line.offset_ms / 1000).toFixed(3)} s</td>
          <td class="num">${line.attacks}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

// ------------------------------------------------------------------ offset lab
// Phase 19: the file's own gapless numbers plus the first attack through
// each decoder, side by side. The header reads with the card; the decoder
// comparison decodes twice, so it runs on its own button.
async function labLoad() {
  $("labCard").hidden = !S.result;
  $("labHeader").textContent = "";
  $("labResult").textContent = "";
  if (!api() || !S.result) return;
  const reply = await api().offset_lab();
  if (!reply.ok) { editFailure(reply); return; }
  const header = reply.header;
  $("labHeader").textContent = header.present
    ? t("lab_header", { encoder: header.encoder, delay: header.delay_samples,
                        delayMs: header.delay_ms, pad: header.padding_samples, padMs: header.padding_ms })
    : t("lab_no_tag");
}

async function labCompare() {
  if (!api() || !S.result || S.busy) return;
  $("labCompare").disabled = true;
  try {
    const reply = await api().offset_decoders();
    if (!reply.ok) {
      if (reply.key === "no_rust") toast(t("hsv_no_rust"), true);
      else editFailure(reply);
      return;
    }
    $("labResult").textContent = t("lab_decoders",
      { py: reply.python_ms.toFixed(2), rust: reply.rust_ms.toFixed(2), delta: reply.delta_ms.toFixed(2) });
  } finally {
    $("labCompare").disabled = false;
  }
}

// ------------------------------------------------------------------ blind test
// Phase 19: which click shift sounds in time, measured blind. Each trial
// plays the same passage twice with two shifts in random order; the vote
// records which presentation won without naming its shift. Every shift runs
// against 0, so the report is one win rate per shift with a Wilson 95 %
// interval, and the preferred shift is the argmax — or nothing, when 0 is
// unbeaten. Read only: nothing is written, and the shift restores to 0.
const LAB_SHIFTS = [-30, -20, -10, 10, 20, 30];
const LAB_REPS = 3;
const LAB_WINDOW_S = 6;
const LAB = { trials: [], at: 0, heard: [false, false], timer: 0, votes: {} };

function labShiftLabel(shift) { return shift === 0 ? "±0" : `${shift > 0 ? "+" : ""}${shift}`; }

function labStartPoint() {
  if (P.loop) return P.loop.a;
  const points = (S.result && S.result.points) || [];
  return points.length ? Math.max(0, points[0].offset_ms / 1000) : 0;
}

function wilson(wins, n) {
  // Wilson score interval, 95 %: honest about 3 reps a shift.
  if (!n) return [0, 0];
  const z = 1.96, p = wins / n, denom = 1 + (z * z) / n;
  const middle = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, (middle - half) / denom), Math.min(1, (middle + half) / denom)];
}

function labStart() {
  if (!api() || !S.result) return;
  if (pbRate() !== 1) { toast(t("lab_rate"), true); return; }
  const order = [];
  for (const shift of LAB_SHIFTS) for (let r = 0; r < LAB_REPS; r++) order.push(shift);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  LAB.trials = order.map((shift) => ({ shift, first: Math.random() < 0.5 ? 0 : shift }));
  LAB.at = 0;
  LAB.votes = {};
  for (const shift of LAB_SHIFTS) LAB.votes[shift] = [0, 0];
  LAB.heard = [false, false];
  renderLab();
}

function labStopTimer() {
  if (LAB.timer) { clearTimeout(LAB.timer); LAB.timer = 0; }
}

async function labHear(which) {
  // which 0/1: play the window with that presentation's shift, then stop.
  if (!api() || !S.result || !LAB.trials.length || LAB.at >= LAB.trials.length) return;
  const trial = LAB.trials[LAB.at];
  const shift = which === 0 ? trial.first : (trial.first === 0 ? trial.shift : 0);
  P.clickShiftMs = shift;
  labStopTimer();
  await pbPlay(labStartPoint());
  if (!P.playing) { P.clickShiftMs = 0; return; }
  LAB.timer = setTimeout(() => { pbStop(); P.clickShiftMs = 0; LAB.heard[which] = true; renderLab(); }, LAB_WINDOW_S * 1000);
  renderLab();
}

function labVote(which) {
  if (!LAB.trials.length || LAB.at >= LAB.trials.length) return;
  if (!LAB.heard[0] || !LAB.heard[1]) return;
  const trial = LAB.trials[LAB.at];
  const picked = which === 0 ? trial.first : (trial.first === 0 ? trial.shift : 0);
  // Every trial is its shift against 0: picking the shift wins it, picking
  // 0 loses it. Zero itself keeps no tally.
  const entry = LAB.votes[trial.shift];
  if (picked === trial.shift) entry[0]++;
  else entry[1]++;
  LAB.at++;
  LAB.heard = [false, false];
  if (LAB.at >= LAB.trials.length) labFinish();
  else renderLab();
}

function labCancel() {
  labStopTimer();
  pbStop();
  P.clickShiftMs = 0;
  LAB.trials = [];
  LAB.at = 0;
  renderLab();
}

function labFinish() {
  labStopTimer();
  pbStop();
  P.clickShiftMs = 0;
  renderLab();
}

function labReport() {
  // Per shift: wins, trials, Wilson interval. Preferred is the top win
  // rate, smallest shift breaking ties; silence when 0 beats everything.
  const rows = LAB_SHIFTS.map((shift) => {
    const [wins, losses] = LAB.votes[shift] || [0, 0];
    const n = wins + losses, rate = n ? wins / n : 0;
    const [lo, hi] = wilson(wins, n);
    return { shift, wins, n, rate, lo, hi };
  });
  const best = rows.reduce((a, b) => (b.rate > a.rate || (b.rate === a.rate && Math.abs(b.shift) < Math.abs(a.shift)) ? b : a));
  return { rows, best: best.rate > 0.5 ? best : null };
}

function renderLab() {
  const done = LAB.trials.length > 0 && LAB.at >= LAB.trials.length;
  const live = LAB.trials.length > 0 && !done;
  $("labTestCard").hidden = !S.result;
  $("labStart").disabled = !S.result || live;
  $("labCancel").hidden = !live && !done;
  for (const id of ["labHear1", "labHear2", "labVote1", "labVote2"]) $(id).disabled = !live;
  if (live) {
    $("labVote1").disabled = $("labVote2").disabled = !(LAB.heard[0] && LAB.heard[1]);
    $("labProgress").textContent = t("lab_trial", { k: LAB.at + 1, n: LAB.trials.length });
  } else {
    $("labProgress").textContent = "";
  }
  const box = $("labTestResult");
  if (!done) { box.innerHTML = ""; return; }
  const { rows, best } = labReport();
  box.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>${t("lab_t_shift")}</th><th>${t("lab_t_wins")}</th><th>${t("lab_t_interval")}</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td class="num">${labShiftLabel(row.shift)} ms</td>
          <td class="num">${row.wins}/${row.n}</td>
          <td class="num">${Math.round(row.lo * 100)}–${Math.round(row.hi * 100)} %</td>
        </tr>`).join("")}</tbody>
    </table></div>
    <div class="card-sub mt-s">${best ? t("lab_best", { shift: labShiftLabel(best.shift), lo: Math.round(best.lo * 100), hi: Math.round(best.hi * 100) })
      : t("lab_none")}</div>`;
}

// ------------------------------------------------------------------ playback
// The song and the click leave through one AudioContext, so they share one
// clock and cannot drift apart. Every time below derives from it: the song
// started at ctx time `startCtx` from song position `startPos`, and a click at
// song time c plays at startCtx + (c - startPos), folded into the loop when
// one is set. Clicks are read from the payload on every tick, so an edit is
// heard on the next beat.
const P = {
  ctx: null, buffer: null, bufferFor: null, loading: null, source: null,
  song: null, click: null, playing: false, startCtx: 0, startPos: 0, pos: 0,
  sched: 0, timer: 0, raf: 0, loop: null, rate: 1,
  // A loop drawn on the map (Shift-drag), in seconds: {a, b}, or null.
  userLoop: null,
  levels: { song_volume: 0.8, click_volume: 0.6, hitsound_volume: 0.7 },
};
const PB_LOOKAHEAD = 0.15, PB_TICK_MS = 25, PB_LEAD = 0.06;

function pbContext() {
  if (!P.ctx) {
    P.ctx = new (window.AudioContext || window.webkitAudioContext)();
    P.song = P.ctx.createGain(); P.song.connect(P.ctx.destination);
    P.click = P.ctx.createGain(); P.click.connect(P.ctx.destination);
    P.hits = P.ctx.createGain(); P.hits.connect(P.ctx.destination);
    pbApplyLevels();
  }
  return P.ctx;
}

function pbApplyLevels() {
  if (!P.ctx) return;
  P.song.gain.value = P.levels.song_volume;
  P.click.gain.value = $("pbClick").checked ? P.levels.click_volume : 0;
  P.hits.gain.value = P.levels.hitsound_volume ?? 0.7;
}

async function pbFetch(kind) {
  const opened = await api().audio_open(kind);
  if (!opened.ok) throw new Error(opened.key === "error" ? opened.detail : t(opened.key));
  const bytes = new Uint8Array(opened.size);
  for (let i = 0; i < opened.chunks; i++) {
    $("pbStatus").textContent = t("pb_loading", { n: i + 1, of: opened.chunks });
    const chunk = await api().audio_chunk(i);
    if (!chunk.ok) throw new Error(t(chunk.key));
    const raw = atob(chunk.data);
    for (let j = 0; j < raw.length; j++) bytes[i * (1 << 20) + j] = raw.charCodeAt(j);
  }
  api().audio_close();
  return bytes.buffer;
}

async function pbLoad() {
  const path = S.result && S.result.path;
  if (!path) return false;
  const perc = $("pbPerc") && $("pbPerc").checked;
  const key = perc ? path + "|perc" : path;
  if (P.buffer && P.bufferFor === key) return true;
  if (P.loading) return P.loading;
  P.loading = (async () => {
    const ctx = pbContext();
    try {
      if (perc) {
        $("pbStatus").textContent = t("pb_perc_preparing");
        P.buffer = await ctx.decodeAudioData(await pbFetch("percussion"));
      } else {
        try {
          P.buffer = await ctx.decodeAudioData(await pbFetch("file"));
        } catch (err) {
          // The browser cannot read every format Overtone can (AIFF): take
          // Overtone's own decode instead of refusing.
          P.buffer = await ctx.decodeAudioData(await pbFetch("wav"));
        }
      }
      P.bufferFor = key;
      waveBuild();
      $("pbStatus").textContent = t(perc ? "pb_perc_on" : "pb_hint");
      return true;
    } catch (err) {
      P.buffer = null;
      $("pbStatus").textContent = t("pb_failed", { detail: String((err && err.message) || err) });
      return false;
    } finally {
      P.loading = null;
    }
  })();
  return P.loading;
}

// Song position `elapsed` seconds after start, at the playing rate, folded
// into the loop.
function pbSongAt(elapsed) {
  const ahead = elapsed * P.rate;
  if (!P.loop) return P.startPos + ahead;
  const { a, b } = P.loop, L = b - a;
  return a + ((((P.startPos - a + ahead) % L) + L) % L);
}

function pbPosition() {
  if (!P.playing || !P.ctx) return P.pos;
  return pbSongAt(Math.max(0, P.ctx.currentTime - P.startCtx));
}

// First index of a sorted array whose value is >= x.
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// The WAV export's three tones, by level: 2 the bar's first beat, 1 a beat,
// 0 a subdivision. 8 ms decay, 45 ms long.
const PB_TONES = { 2: [2093, 1], 1: [1568, 0.7], 0: [1318.5, 0.4] };

function pbClickAt(when, level) {
  const ctx = P.ctx, osc = ctx.createOscillator(), env = ctx.createGain();
  const [freq, gain] = PB_TONES[level] || PB_TONES[1];
  osc.frequency.value = freq;
  env.gain.setValueAtTime(gain, when);
  env.gain.setTargetAtTime(0.0001, when, 0.008);
  osc.connect(env); env.connect(P.click);
  osc.start(when); osc.stop(when + 0.045);
}
// A listening-test shift, output milliseconds, added to every click below.
// Zero unless a blind trial sets it; normal playback never sees it move.
P.clickShiftMs = 0;

// Hitsounds beside the song (Phase 6, P-3): one difficulty's sounds, found as
// osu! finds its samples, scheduled on the playback clock like the click.
// `proposal` is set while they are the file as it would be written (H5): the
// ticked proposals and the hand edits made, not yet written; `heard` is what the
// bridge counted then. Samples decode once per song: their keys name a file
// of the song's folder, the same for every difficulty.
const HSP = { file: "", proposal: false, heard: null, events: null, loops: null, loopsMax: 0,
              objects: null, buffers: {}, decoded: {}, token: 0 };
// The transport's option for a difficulty as it would be written. A "/" is
// never in a file name the bridge takes, so it cannot be a difficulty's own.
const HS_PROPOSAL = "proposal/";

// The legend's addition keys show while a difficulty's object lane does.
function hsLegend() {
  document.querySelectorAll(".legend .hs-key").forEach((el) => { el.hidden = !HSP.objects; });
}

async function hsMaps() {
  const box = $("pbHs");
  HSP.file = ""; HSP.proposal = false; HSP.heard = null; HSP.events = null; HSP.loops = null;
  HSP.objects = null; HSP.buffers = {}; HSP.decoded = {}; HSP.token++;
  hsLegend();
  let maps = [];
  if (api()) {
    const reply = await api().song_maps();
    maps = reply.ok ? reply.maps : [];
  }
  box.innerHTML = `<option value="">${t("pb_hs_off")}</option>` +
    maps.map((m) => `<option value="${esc(m.file)}">${esc(m.difficulty)}</option>`).join("");
  box.disabled = !maps.length;
}

// The transport offers a difficulty as it would be written while there is
// something to write (proposals or edits): until a write, an undo or another
// difficulty.
function hsProposalOption(file) {
  const box = $("pbHs"), value = file ? HS_PROPOSAL + file : "";
  for (const o of [...box.options]) if (o.value.startsWith(HS_PROPOSAL) && o.value !== value) o.remove();
  const plain = file && [...box.options].find((o) => o.value === file);
  if (!plain || [...box.options].some((o) => o.value === value)) return;
  const o = document.createElement("option");
  o.value = value;
  o.textContent = t("pb_hs_proposal", { name: plain.textContent });
  plain.after(o);
}

// Load a transport option: a difficulty's file, or HS_PROPOSAL + file for it
// as the ticked proposals and the edits would write it. Between a file and
// that version the old sounds play on until the new ones are in, so an A/B
// while playing has no gap; another difficulty silences them at once.
async function hsPick(value) {
  const proposal = value.startsWith(HS_PROPOSAL);
  const file = proposal ? value.slice(HS_PROPOSAL.length) : value;
  const token = ++HSP.token;
  $("pbHs").value = value;
  if (HSP.file !== file || !file) {
    HSP.events = null; HSP.loops = null; HSP.objects = null;
    hsLegend();
    if (S.result) drawTrace();
  }
  HSP.file = file; HSP.proposal = proposal; HSP.heard = null;
  const option = $("pbHs").selectedOptions[0];
  const name = option && option.value === value ? option.textContent : file;
  if (!file) { $("pbStatus").textContent = t("pb_hint"); return; }
  $("pbStatus").textContent = t("pb_hs_loading", { name });
  const reply = proposal ? await api().hitsound_decide_playback(file, hsdAcceptList(), hsdEditList(),
                                                              hsdChoiceList())
                         : await api().hitsound_playback(file);
  if (HSP.token !== token) return;           // another pick came in meanwhile
  if (!reply.ok) {
    if (reply.key === "no_proposal") toast(t("hsv_no_proposal"), true);
    else editFailure(reply);
    // A proposal that cannot be heard leaves the file as written playing.
    if (proposal) { hsPick(file).then(() => { if (HSV.report) renderHitsoundsView(); }); return; }
    HSP.file = ""; HSP.proposal = false; HSP.events = null; HSP.loops = null; HSP.objects = null;
    $("pbHs").value = "";
    hsLegend();
    if (S.result) drawTrace();
    return;
  }
  const ctx = pbContext(), buffers = {};
  let unreadable = 0, empty = 0;
  for (const [key, s] of Object.entries(reply.samples)) {
    // A file with no audio in it mutes its sound: nothing to decode or play.
    if (s.empty) { empty++; continue; }
    if (!HSP.decoded[key]) {
      const raw = atob(s.data), bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      try { HSP.decoded[key] = await ctx.decodeAudioData(bytes.buffer); } catch (err) { unreadable++; continue; }
    }
    buffers[key] = HSP.decoded[key];
  }
  if (HSP.token !== token) return;
  HSP.buffers = buffers;
  HSP.events = reply.events;
  HSP.loops = reply.loops;
  // The longest body bounds the look back for one already sounding.
  HSP.loopsMax = Math.max(0, ...reply.loops.t.map((t0, i) => reply.loops.end[i] - t0));
  HSP.objects = reply.objects;
  HSP.counts = reply.counts;
  HSP.heard = proposal ? { accepted: reply.accepted, units: reply.units, edited: reply.edited,
                           chosen: reply.chosen, differs: reply.differs, first: reply.first } : null;
  hsLegend();
  if (S.result) drawTrace();
  const c = reply.counts;
  $("pbStatus").textContent = t(c.skin ? "pb_hs_ready_skin" : "pb_hs_ready",
                                { name, n: c.sounds, bodies: c.slider_bodies, map: c.map + c.file,
                                  skin: c.skin, own: c.overtone }) +
    (empty ? ` ${t("pb_hs_empty", { n: empty })}` : "") +
    (unreadable ? ` ${t("pb_hs_unreadable", { n: unreadable })}` : "");
}

// One decoded sample on the hitsound bus, so a stop cuts it and the level applies.
function pbBufferAt(when, buffer, volume) {
  const src = P.ctx.createBufferSource(), gain = P.ctx.createGain();
  src.buffer = buffer;
  gain.gain.value = volume;
  src.connect(gain); gain.connect(P.hits);
  src.start(when);
}

function pbHitAt(when, keys, volume) {
  for (const key of keys) {
    if (HSP.buffers[key]) pbBufferAt(when, HSP.buffers[key], volume);
  }
}

// A slider's body: its slide, and whistle slide, looped from `when` to
// `until` (context time) on the hitsound bus, so a stop cuts it too.
function pbSlideAt(when, until, keys, volume) {
  if (!(until > when)) return;
  for (const key of keys) {
    const buffer = HSP.buffers[key];
    if (!buffer) continue;
    const src = P.ctx.createBufferSource(), gain = P.ctx.createGain();
    src.buffer = buffer;
    src.loop = true;
    gain.gain.value = volume;
    src.connect(gain); gain.connect(P.hits);
    src.start(when);
    src.stop(until);
  }
}

function pbTick() {
  if (!P.playing || !S.result) return;
  const clicks = S.result.clicks || { t: [], level: [] };
  const until = P.ctx.currentTime - P.startCtx + PB_LOOKAHEAD;
  while (P.sched < until) {
    const s0 = pbSongAt(P.sched);
    // Up to the loop's end at most, so a window never spans the wrap. Song
    // time runs at the playing rate; the clicks keep their own pitch.
    const room = P.loop ? (P.loop.b - s0) / P.rate : Infinity;
    const len = Math.min(until - P.sched, room);
    for (let i = lowerBound(clicks.t, s0); i < clicks.t.length && clicks.t[i] < s0 + len * P.rate; i++) {
      pbClickAt(P.startCtx + P.sched + (clicks.t[i] - s0) / P.rate + (P.clickShiftMs || 0) / 1000, clicks.level[i]);
    }
    // An audition (the Samples card): one sample in place of the sounds at one moment.
    const swap = P.swap;
    const hits = HSP.events;
    if (hits) {
      for (let i = lowerBound(hits.t, s0); i < hits.t.length && hits.t[i] < s0 + len * P.rate; i++) {
        if (swap && Math.abs(hits.t[i] - swap.t) < 1e-3) continue;
        pbHitAt(P.startCtx + P.sched + (hits.t[i] - s0) / P.rate, hits.keys[i], hits.volume[i]);
      }
    }
    if (swap && !swap.done && swap.t >= s0 && swap.t < s0 + len * P.rate) {
      if (swap.buffer) pbBufferAt(P.startCtx + P.sched + (swap.t - s0) / P.rate, swap.buffer, swap.volume);
      swap.done = true;
    }
    const slides = HSP.loops;
    if (slides && slides.t.length) {
      const at = (s) => P.startCtx + P.sched + (s - s0) / P.rate;
      const stop = (end) => at(Math.min(end, P.loop ? P.loop.b : Infinity));
      const first = lowerBound(slides.t, s0);
      // A body already sounding as playback starts, or as the loop wraps, joins in now.
      if (P.sched === 0 || (P.loop && Math.abs(s0 - P.loop.a) < 1e-6)) {
        for (let i = first - 1; i >= 0 && slides.t[i] >= s0 - HSP.loopsMax; i--) {
          if (slides.end[i] > s0) pbSlideAt(at(s0), stop(slides.end[i]), slides.keys[i], slides.volume[i]);
        }
      }
      for (let i = first; i < slides.t.length && slides.t[i] < s0 + len * P.rate; i++) {
        pbSlideAt(at(slides.t[i]), stop(slides.end[i]), slides.keys[i], slides.volume[i]);
      }
    }
    P.sched += len > 1e-9 ? len : 1e-6;
  }
  // An audition stops on its own a moment after its sample.
  if (P.swap && pbPosition() >= P.swap.until) {
    const done = P.swap;
    pbStop();
    P.swap = null;
    if (done.onEnd) done.onEnd();
    return;
  }
  if (!P.loop && pbPosition() >= P.buffer.duration) { pbStop(); P.pos = 0; pbDraw(); }
}

function pbLoopFor(pos) {
  // A loop drawn on the map (Shift-drag) wins; otherwise the section under
  // the playhead, from its red line to the next one.
  if (P.userLoop) return { a: Math.max(0, P.userLoop.a), b: Math.min(P.userLoop.b, P.buffer.duration) };
  const r = S.result, i = governing(r, pos);
  const a = r.points[i].offset_ms / 1000;
  const b = i + 1 < r.points.length ? r.points[i + 1].offset_ms / 1000 : r.duration;
  return b - a > 0.05 ? { a: Math.max(0, a), b: Math.min(b, P.buffer.duration) } : null;
}

// `swap`, from an audition: {t, buffer, volume, until, label, onEnd}, the
// sample to play at song time t in place of the sounds there, when to stop,
// and what the Samples card calls it meanwhile.
async function pbPlay(from, swap) {
  if (!api() || !S.result) return;
  if (!(await pbLoad())) return;
  const ctx = pbContext();
  if (ctx.state === "suspended") await ctx.resume();
  pbStop();
  try { if (SCRUB.source) SCRUB.source.stop(); } catch (err) { /* already ended */ }
  let pos = Math.min(Math.max(0, from ?? P.pos), P.buffer.duration - 0.01);
  // Any other play ends an audition; an audition plays through, never looped.
  P.swap = swap || null;
  P.loop = !P.swap && $("pbLoop").checked ? pbLoopFor(pos) : null;
  if (P.loop && (pos < P.loop.a || pos >= P.loop.b)) pos = P.loop.a;
  const source = ctx.createBufferSource();
  source.buffer = P.buffer;
  if (P.loop) { source.loop = true; source.loopStart = P.loop.a; source.loopEnd = P.loop.b; }
  // Slower by resampling, so the pitch drops with it: every attack stays
  // exactly at t / rate, and crisp. A pitch-kept stretch moved attacks ~24 ms.
  P.rate = pbRate();
  source.playbackRate.value = P.rate;
  source.connect(P.song);
  P.startCtx = ctx.currentTime + PB_LEAD;
  P.startPos = pos;
  P.sched = 0;
  source.start(P.startCtx, pos);
  P.source = source;
  P.playing = true;
  pbTick();
  P.timer = setInterval(pbTick, PB_TICK_MS);
  P.raf = requestAnimationFrame(pbFrame);
  pbButtons();
  pbDraw();
}

function pbStop() {
  if (!P.playing) return;
  P.pos = pbPosition();
  P.playing = false;
  clearInterval(P.timer);
  cancelAnimationFrame(P.raf);
  try { P.source.stop(); } catch (err) { /* already stopped */ }
  P.source = null;
  // Clicks already handed to the context would still sound: cut their bus.
  if (P.click) {
    P.click.disconnect();
    P.click = P.ctx.createGain(); P.click.connect(P.ctx.destination);
    P.hits.disconnect();                         // and the hitsounds already scheduled
    P.hits = P.ctx.createGain(); P.hits.connect(P.ctx.destination);
    pbApplyLevels();
  }
  pbButtons();
  pbDraw();  // animation frames stop with the song, and in a hidden window
}

function pbToggle() { if (P.playing) pbStop(); else pbPlay(); }

// ``scrub``: the mapper moved the position (the seek bar, the arrow keys, a
// jump to a red line), so while the song is stopped a grain of it plays there.
function pbSeek(pos, scrub = false) {
  if (P.playing) pbPlay(pos);
  else {
    P.pos = Math.max(0, pos);
    pbDraw();
    if (scrub) pbScrubAt(P.pos);
  }
}

// ------------------------------------------------------------------ scrub
// A stopped song heard where the position moves to: a short grain of it,
// faded in and out so it does not click, one at a time (each cuts the one
// before) and at most one per SCRUB_EVERY_MS, the newest position kept.
const SCRUB_GRAIN_S = 0.12, SCRUB_FADE_S = 0.008, SCRUB_EVERY_MS = 45;
const SCRUB = { last: -1e9, pending: null, timer: 0, source: null, grains: 0 };

function pbScrubAt(pos) {
  if (P.playing || !S.result || !api()) return;
  // Not decoded yet: fetch it now, so the next move is heard.
  if (!P.buffer || !P.bufferFor || !P.bufferFor.startsWith(S.result.path)) { pbLoad(); return; }
  const now = performance.now(), wait = SCRUB_EVERY_MS - (now - SCRUB.last);
  if (wait > 0) {
    SCRUB.pending = pos;
    if (!SCRUB.timer) {
      SCRUB.timer = setTimeout(() => {
        SCRUB.timer = 0;
        const next = SCRUB.pending;
        SCRUB.pending = null;
        if (next !== null) pbScrubAt(next);
      }, wait);
    }
    return;
  }
  SCRUB.last = now;
  const ctx = P.ctx;
  if (ctx.state === "suspended") ctx.resume();
  try { if (SCRUB.source) SCRUB.source.stop(); } catch (err) { /* already ended */ }
  const src = ctx.createBufferSource(), env = ctx.createGain(), t0 = ctx.currentTime + 0.005;
  const at = Math.min(Math.max(0, pos), Math.max(0, P.buffer.duration - SCRUB_GRAIN_S));
  src.buffer = P.buffer;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + SCRUB_FADE_S);
  env.gain.setValueAtTime(1, t0 + SCRUB_GRAIN_S - SCRUB_FADE_S);
  env.gain.linearRampToValueAtTime(0, t0 + SCRUB_GRAIN_S);
  src.connect(env);
  env.connect(P.song);
  src.start(t0, at, SCRUB_GRAIN_S);
  SCRUB.source = src;
  SCRUB.grains++;
}

function pbButtons() {
  // SVG elements have no .hidden property: the attribute is what hides them.
  $("pbPlayIcon").toggleAttribute("hidden", P.playing);
  $("pbPauseIcon").toggleAttribute("hidden", !P.playing);
  sbRenderHear();                                // an audition says while it plays
}

function pbFrame() {
  pbDraw();
  if (P.playing) P.raf = requestAnimationFrame(pbFrame);
}

function pbDraw() {
  const canvas = $("playhead"), r = S.result;
  if (!r) return;
  const pos = pbPosition(), dur = Math.max(r.duration, 1e-3);
  const m = Math.floor(pos / 60), s = pos - m * 60;
  $("pbTime").textContent = `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
  if (document.activeElement !== $("pbSeek")) $("pbSeek").value = String(Math.round((pos / dur) * 1000));
  const wrap = $("traceWrap"), dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H || !geom) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // The loop that plays; a drawn one shows while paused too, and while it is drawn.
  const drawing = TL.drag && TL.drag.kind === "loop" && TL.moved ? loopSpan(TL.drag.from, TL.drag.to) : null;
  const band = drawing || (P.playing ? P.loop : ($("pbLoop").checked ? P.userLoop : null));
  if (band) {
    ctx.fillStyle = C.loop;
    ctx.fillRect(geom.X(band.a), geom.y0 - 22, geom.X(band.b) - geom.X(band.a), geom.y1 - geom.y0 + 22);
  }
  if (!P.playing && pos <= 0) return;
  const x = Math.round(geom.X(Math.min(pos, dur))) + 0.5;
  ctx.strokeStyle = C.playhead; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, geom.y0 - 22); ctx.lineTo(x, geom.y1); ctx.stroke();
}

function pbReset() {
  // A new song: its buffer, position and loop are the old song's no more.
  pbStop();
  clearTimeout(SCRUB.timer);
  SCRUB.timer = 0; SCRUB.pending = null;
  P.buffer = null; P.bufferFor = null; P.pos = 0; P.loop = null; P.userLoop = null;
  pbLoopLabel();
  TAP.taps = [];
  renderTaps();
  pbDraw();
}

function pbLevels() {
  P.levels = { song_volume: +$("pbSongVol").value / 100, click_volume: +$("pbClickVol").value / 100,
               hitsound_volume: +$("pbHsVol").value / 100 };
  pbApplyLevels();
  if (api()) api().set_playback(P.levels);
}

function pbRate() {
  const on = document.querySelector("#pbRate button.on");
  return on ? parseFloat(on.dataset.rate) || 1 : 1;
}

// ------------------------------------------------------------------ taps
// A tap lands at the song time that was *sounding* when the key went down.
// getOutputTimestamp ties the page's clock to the sample leaving the
// speakers, so the output latency drops out; what is left (key travel, the
// hand, the ear) is this person's own, and calibrates away against the click.
const TAP = { taps: [], latency: 0 };
// Taps further apart than this (song seconds) start a new run: a pause, a
// loop's wrap or a seek between them breaks the count of beats.
const TAP_MAX_GAP = 2.0;

function tapHeardCtx(ev) {
  const ctx = P.ctx, ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0) return ts.contextTime + (ev.timeStamp - ts.performanceTime) / 1000;
  // No output timestamp: the context's own latency figures, and the event's age.
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0)
    - (performance.now() - ev.timeStamp) / 1000;
}

function tapNow(ev) {
  if (!P.playing) { toast(t("tap_play_first")); return; }
  TAP.taps.push(pbSongAt(tapHeardCtx(ev) - P.startCtx - TAP.latency / 1000));
  renderTaps();
}

function tapStats() {
  const taps = TAP.taps, r = S.result;
  if (!r || !taps.length) return null;
  const clicks = r.clicks.t;
  // Each tap against the nearest click of the current timing, in ms.
  const offs = taps.map((s) => {
    const i = lowerBound(clicks, s);
    const near = [clicks[i - 1], clicks[i]].filter((v) => v !== undefined)
      .reduce((b, v) => (Math.abs(s - v) < Math.abs(s - b) ? v : b), Infinity);
    return (s - near) * 1000;
  }).filter((v) => Number.isFinite(v));
  const mean = offs.reduce((a, b) => a + b, 0) / Math.max(offs.length, 1);
  const sd = Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(offs.length - 1, 1));
  // The tempo of the last unbroken run: beats numbered from the median gap,
  // then a least-squares line through them, so one early tap cannot set it.
  const run = [taps[taps.length - 1]];
  for (let i = taps.length - 2; i >= 0; i--) {
    const gap = run[0] - taps[i];
    if (gap > 0 && gap < TAP_MAX_GAP) run.unshift(taps[i]); else break;
  }
  let bpm = null;
  if (run.length >= 4) {
    const gaps = run.slice(1).map((v, i) => v - run[i]).sort((a, b) => a - b);
    const g = gaps[gaps.length >> 1];
    const k = run.map((v) => Math.round((v - run[0]) / g));
    const km = k.reduce((a, b) => a + b, 0) / k.length, tm = run.reduce((a, b) => a + b, 0) / run.length;
    const sxx = k.reduce((a, v) => a + (v - km) ** 2, 0);
    const beat = sxx > 0 ? k.reduce((a, v, i) => a + (v - km) * (run[i] - tm), 0) / sxx : 0;
    if (beat > 0) bpm = 60 / beat;
  }
  return { n: taps.length, mean, sd, bpm, run };
}

function renderTaps() {
  const st = tapStats();
  $("tapCalibrate").hidden = !st || st.n < 4;
  $("tapClear").hidden = !st;
  $("tapAssist").hidden = !st || st.run.length <= (parseInt($("asMeter").value, 10) || 4);
  if (!st) { $("tapInfo").textContent = t("tap_hint"); return; }
  const side = st.mean >= 0 ? "tap_after" : "tap_before";
  $("tapInfo").textContent = t("tap_info", {
    n: st.n, bpm: st.bpm ? st.bpm.toFixed(2) : "—",
    where: t(side, { ms: Math.abs(st.mean).toFixed(1), sd: st.sd.toFixed(1) }),
  });
}

async function tapCalibrate() {
  const st = tapStats();
  if (!api() || !st || st.n < 4) return;
  // The taps were already corrected by the old latency: the new one adds to it.
  const reply = await api().set_tap_latency(TAP.latency + st.mean);
  if (!reply.ok) { toast(t(reply.key), true); return; }
  TAP.latency = reply.playback.tap_latency_ms;
  TAP.taps = [];
  renderTaps();
  toast(t("tap_calibrated", { ms: TAP.latency.toFixed(1) }));
}

function tapAssist() {
  const st = tapStats(), meter = parseInt($("asMeter").value, 10) || 4;
  if (!st) return;
  const bars = Math.floor((st.run.length - 1) / meter);
  if (bars < 1) { toast(t("tap_assist_need", { n: meter + 1 }), true); return; }
  $("asFirst").value = String(Math.round(st.run[0] * 1000));
  $("asSecond").value = String(Math.round(st.run[bars * meter] * 1000));
  $("asBars").value = String(bars);
  assistFit();
  $("asResult").closest(".card").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ------------------------------------------------------------------ mod report
// One difficulty, every finding, in time order as a mod post lists them.
const RP_SOURCES = ["reference", "suggestion", "snap", "alignment", "hitsound"];

async function reportPick() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const reply = await api().mod_report(target);
  if (!reply.ok) { editFailure(reply); return; }
  S.report = { file: reply.file, difficulty: reply.difficulty, report: reply.report,
               hidden: S.report ? S.report.hidden : [] };
  renderReport();
  renderTaps();
}

function reportShown() {
  const rp = S.report;
  return rp ? rp.report.items.filter((i) => !rp.hidden.includes(i.source)) : [];
}

async function openStamp(stamp) {
  if (!api()) return;
  const reply = await api().open_in_editor(stamp);
  if (!reply.ok) toast(t(reply.key, { detail: reply.detail || "" }), true);
}

function renderReport() {
  const body = $("rpBody"), rp = S.report, pill = $("rpCount");
  $("rpCopy").hidden = !rp || !rp.report.items.length;
  if (!rp) {
    pill.hidden = true;
    $("rpFile").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("rp_empty")}</div>`;
    return;
  }
  $("rpFile").textContent = rp.difficulty ? `${rp.file} · ${rp.difficulty}` : rp.file;
  const items = rp.report.items;
  pill.hidden = false;
  pill.textContent = t("rp_counts", { n: items.length });
  if (!items.length) { body.innerHTML = `<div class="card-sub">${t("rp_none")}</div>`; return; }
  const filters = RP_SOURCES.filter((s) => rp.report.counts[s]).map((s) => `
    <label class="check"><input type="checkbox" data-rp-source="${s}" ${rp.hidden.includes(s) ? "" : "checked"}>
      <span>${t(`rp_src_${s}`)} <span class="muted">${rp.report.counts[s]}</span></span></label>`).join("");
  const rows = reportShown().map((i) => `
    <tr>
      <td class="num">${i.time_ms === null ? `<span class="muted">${esc(i.stamp)}</span>`
        : `<button class="link" data-stamp="${esc(i.stamp)}" title="${t("rp_open")}">${esc(i.stamp)}</button>`}</td>
      <td class="txt">${esc(i.text)}</td>
      <td><span class="pill ${i.level === "warn" ? "amber" : ""}">${t(`rp_src_${i.source}`)}</span></td>
    </tr>`).join("");
  body.innerHTML = `
    <div class="rp-filters">${filters}</div>
    <div class="table-scroll mt-m"><table><tbody>${rows}</tbody></table></div>
    <div class="card-sub mt-m">${t("rp_hint")}</div>`;
  body.querySelectorAll("[data-stamp]").forEach((b) => { b.onclick = () => openStamp(b.dataset.stamp); });
  body.querySelectorAll("[data-rp-source]").forEach((box) => {
    box.onchange = () => {
      const s = box.dataset.rpSource;
      rp.hidden = box.checked ? rp.hidden.filter((h) => h !== s) : [...rp.hidden, s];
      renderReport();
    };
  });
}

function copyReport() {
  const lines = reportShown().map((i) => `${i.stamp} - ${i.text}`);
  if (lines.length) copyText(lines.join("\n"), "rp_copied");
}

// ------------------------------------------------------------------ history
// Phase 19: every .osu write, its backup, restore. Global like Library:
// no song needed. A restore keeps the current file as a new backup first,
// so no button here destroys anything.
const HIST = { entries: [], diff: -1, diffReport: null };

function histOp(entry) {
  // Known operations translate; a future one reads raw instead of a key.
  const missing = `hist_op_${entry.op}`;
  const text = t(missing);
  return text === missing ? entry.op : text;
}

function histSummary(entry) {
  const summary = entry.summary || {};
  if (entry.op === "hitsounds" && summary.changed !== undefined) {
    return t("hist_summary_hitsounds", { n: summary.changed });
  }
  if (entry.op === "inject" && (summary.reds_replaced !== undefined || summary.reds_added !== undefined)) {
    return t("hist_summary_inject", { n: (summary.reds_replaced || 0) + (summary.reds_added || 0) });
  }
  return "";
}

function histWhen(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
}

async function histLoad() {
  HIST.diff = -1;
  const reply = await api().history();
  if (!reply.ok) { editFailure(reply); return; }
  HIST.entries = reply.entries;
  renderHistory();
}

function histDiffText(diff) {
  const parts = [];
  if (diff.n_added) parts.push(t("hist_added", { n: diff.n_added }));
  if (diff.n_removed) parts.push(t("hist_removed", { n: diff.n_removed }));
  if (diff.n_changed) parts.push(t("hist_changed", { n: diff.n_changed }));
  const lines = [
    ...diff.removed.map((o) => `− ${o} ms`),
    ...diff.added.map((a) => `+ ${a.offset} ms · ${a.bpm.toFixed(2)} BPM`),
    ...diff.changed.map((c) => `~ ${c.offset} ms · ${c.old_bpm.toFixed(2)} → ${c.new_bpm.toFixed(2)} BPM`),
  ];
  return { summary: parts.length ? parts.join(" · ") : t("hist_no_change"), lines };
}

async function histShowDiff(index) {
  HIST.diff = HIST.diff === index ? -1 : index;
  if (HIST.diff < 0) { renderHistory(); return; }
  const reply = await api().history_diff(index);
  if (!reply.ok) { editFailure(reply); HIST.diff = -1; renderHistory(); return; }
  HIST.diffReport = reply.diff;
  renderHistory();
}

async function histRestore(index) {
  const entry = HIST.entries[index];
  if (!entry) return;
  const ok = confirm(t("hist_confirm", { file: entry.file, backup: entry.backup || "—" }));
  if (!ok) return;
  const reply = await api().history_restore(index);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("hist_restored", { file: entry.file }));
  histLoad();
}

function renderHistory() {
  const rows = HIST.entries.map((e, i) => `
    <tr>
      <td class="txt num">${esc(histWhen(e.ts))}</td>
      <td class="txt">${esc(histOp(e))}${e.summary ? ` <span class="muted">${esc(histSummary(e))}</span>` : ""}</td>
      <td class="txt">${esc(e.file)}</td>
      <td class="txt">${e.backup ? esc(e.backup) : `<span class="muted">—</span>`}</td>
      <td><button type="button" class="btn small" data-hist-diff="${i}">${t("hist_diff")}</button>
        <button type="button" class="btn small" data-hist-restore="${i}" ${e.backup ? "" : "disabled"}>${t("hist_restore")}</button></td>
    </tr>`).join("");
  $("histCount").hidden = !HIST.entries.length;
  $("histCount").textContent = t("hist_count", { n: HIST.entries.length });
  let detail = "";
  if (HIST.diff >= 0 && HIST.diffReport) {
    const text = histDiffText(HIST.diffReport);
    detail = `<div class="card-sub mt-m"><b>${esc(HIST.entries[HIST.diff].file)}</b> · ${esc(text.summary)}</div>`
      + (text.lines.length ? `<div class="card-sub">${text.lines.slice(0, 20).map(esc).join("<br>")}</div>` : "");
  }
  $("histRows").innerHTML = rows.length ? rows
    : `<tr><td colspan="5"><div class="card-sub">${t("hist_empty")}</div></td></tr>`;
  $("histDiff").innerHTML = detail;
  document.querySelectorAll("[data-hist-diff]").forEach((b) => { b.onclick = () => histShowDiff(+b.dataset.histDiff); });
  document.querySelectorAll("[data-hist-restore]").forEach((b) => { b.onclick = () => histRestore(+b.dataset.histRestore); });
}

// ------------------------------------------------------------------ settings
// Every option in one place (Phase 20). Each change is sent at once; the
// bridge checks it and answers with the settings as kept.
const ST = { settings: null, cache: null, outputDefault: "" };

// "System" follows Windows' app mode, live; the stylesheet only knows dark
// and light, so it is resolved here.
const SYSTEM_LIGHT = window.matchMedia("(prefers-color-scheme: light)");

function stTheme() {
  const want = (ST.settings && ST.settings.theme) || "dark";
  const theme = want === "system" ? (SYSTEM_LIGHT.matches ? "light" : "dark") : want;
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
    chartInk();                       // canvas ink is read, not inherited
    // The spectrogram is painted once into its own bitmap, from the theme's
    // ink: that bitmap is the one thing here that does not follow a token.
    if (SPEC.data && SPEC.image) SPEC.image = specPaint(SPEC.data);
    if (S.result) { drawTrace(); drawBands(); drawSpec(); }
  }
  themeButton(theme);
}
SYSTEM_LIGHT.addEventListener("change", stTheme);

// The rail's own theme switch, beside the language one: always in reach,
// where the Settings three-way (System / Dark / Light) was the only way in.
// It shows the theme it would move to — the icon and the words together, so
// the icon alone never has to carry it — and writes the same setting, so the
// three-way follows and the choice is remembered like any other.
function themeButton(theme) {
  const button = $("themeBtn");
  if (!button) return;
  const key = theme === "dark" ? "theme_to_light" : "theme_to_dark";
  button.classList.toggle("is-dark", theme === "dark");
  button.title = t(key);
  button.setAttribute("aria-label", t(key));
  button.dataset.i18nTitle = key;
  const label = $("themeLabel");
  label.textContent = t(key);
  label.dataset.i18n = key;
}

// Whatever is on screen now, the other one — from "System" too, which is
// then answered with the theme the button offered rather than a third state.
function themeToggle() {
  stSet({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" });
}

function stApply() {
  const s = ST.settings;
  if (!s) return;
  document.documentElement.style.zoom = String(s.ui_scale);
  document.body.classList.toggle("reduce-motion", s.reduced_motion);
  stTheme();
  if (S.result) drawTrace();
}

function stRender() {
  const s = ST.settings;
  if (!s) return;
  $("stFolder").textContent = s.output_folder || t("st_folder_is_default", { path: ST.outputDefault });
  $("stFolderDefault").hidden = !s.output_folder;
  $("stAsk").checked = s.export_ask;
  document.querySelectorAll("#stDecimals button").forEach((b) => b.classList.toggle("on", +b.dataset.v === s.offset_decimals));
  document.querySelectorAll("#stSub button").forEach((b) => b.classList.toggle("on", +b.dataset.v === s.click_subdivision));
  $("stAccent").checked = s.click_accent;
  $("stScale").value = String(Math.round(s.ui_scale * 100));
  $("stScaleValue").textContent = `${Math.round(s.ui_scale * 100)}%`;
  $("stMotion").checked = s.reduced_motion;
  document.querySelectorAll("#stTheme button").forEach((b) => b.classList.toggle("on", b.dataset.v === s.theme));
  const c = ST.cache;
  if (c) {
    $("stCache").textContent = t("st_cache_info", { n: c.entries, mb: (c.bytes / 1048576).toFixed(1),
                                                    max: c.limit_entries, path: c.path });
  }
}

function stTake(reply) {
  ST.settings = reply.settings;
  ST.cache = reply.cache || ST.cache;
  ST.outputDefault = reply.output_default || ST.outputDefault;
  stApply();
  stRender();
  // Click settings changed: the same song, with its clicks rebuilt.
  if (reply.result) showResult(reply.result);
}

async function stLoad() {
  if (!api()) return;
  const reply = await api().settings();
  if (reply.ok) stTake(reply);
}

async function stSet(changes) {
  if (!api()) return;
  const reply = await api().set_settings(changes);
  if (!reply.ok) { toast(t(reply.key), true); stRender(); return; }
  stTake(reply);
}

function stWire() {
  $("stFolderPick").onclick = async () => {
    const reply = await api().pick_output_folder();
    if (reply.ok) stTake(reply);
    else if (reply.key !== "cancelled") toast(t(reply.key), true);
  };
  $("stFolderDefault").onclick = () => stSet({ output_folder: "" });
  $("stAsk").onchange = () => stSet({ export_ask: $("stAsk").checked });
  document.querySelectorAll("#stDecimals button").forEach((b) => b.onclick = () => stSet({ offset_decimals: +b.dataset.v }));
  document.querySelectorAll("#stSub button").forEach((b) => b.onclick = () => stSet({ click_subdivision: +b.dataset.v }));
  $("stAccent").onchange = () => stSet({ click_accent: $("stAccent").checked });
  $("stScale").oninput = () => { $("stScaleValue").textContent = `${$("stScale").value}%`; };
  $("stScale").onchange = () => stSet({ ui_scale: +$("stScale").value / 100 });
  $("stMotion").onchange = () => stSet({ reduced_motion: $("stMotion").checked });
  document.querySelectorAll("#stTheme button").forEach((b) => b.onclick = () => stSet({ theme: b.dataset.v }));
  $("stDetect").onclick = () => openDrawer(true);
  $("stCacheClear").onclick = async () => {
    const reply = await api().cache_clear();
    if (reply.ok) { ST.cache = reply.cache; stRender(); toast(t("st_cache_cleared")); }
  };
}

// ------------------------------------------------------------------ mapset
// Read only and independent of the analysis: one folder, every difficulty.
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Enough digits to show any difference past the 1e-6 ms tolerance, no float noise.
const exact = (x) => (typeof x === "number" ? String(+x.toFixed(9)) : String(x));

async function pickMapset() {
  if (!api()) return;
  const folder = await api().pick_folder();
  if (folder) runMapset(folder, false);
}

async function runMapset(folder, quiet) {
  if (!api() || !folder) return;
  const reply = await api().mapset_check(folder);
  if (!reply.ok) { if (!quiet) editFailure(reply); return; }
  if (!S.mapset || S.mapset.path !== folder) { HS.preview = null; $("hsTargets").innerHTML = ""; }
  S.mapset = { path: folder, name: reply.folder, report: reply.report };
  renderMapset();
  renderCopier();
  renderSwap();
  renderAudioCheck();
}

function msValue(value) {
  if (value === null || value === undefined) return `<span class="card-sub">${t("ms_not_set")}</span>`;
  if (value === "") return `<span class="card-sub">${t("ms_empty_value")}</span>`;
  return esc(value);
}

// ------------------------------------------------------------------ hitsound copier
// Phase 6, H1: one difficulty's hitsounds onto others, by time. A preview
// first, which writes nothing; the copy writes only hitsound fields.
const HS = { preview: null };

function hsReadable() {
  return S.mapset ? S.mapset.report.difficulties.filter((d) => d.readable) : [];
}

function renderCopier() {
  const diffs = hsReadable(), card = $("hsCard");
  card.hidden = diffs.length < 2;
  if (card.hidden) return;
  const source = $("hsSource"), keep = source.value;
  source.innerHTML = diffs.map((d) => `<option value="${esc(d.file)}">${esc(d.difficulty)}</option>`).join("");
  if (diffs.some((d) => d.file === keep)) source.value = keep;
  const chosen = new Set([...document.querySelectorAll("#hsTargets input:checked")].map((i) => i.value));
  const fresh = !$("hsTargets").children.length;
  $("hsTargets").innerHTML = diffs.filter((d) => d.file !== source.value).map((d) => `
    <label class="check"><input type="checkbox" value="${esc(d.file)}" ${fresh || chosen.has(d.file) ? "checked" : ""}><span>${esc(d.difficulty)}</span></label>`).join("");
  renderCopyResult();
}

function hsChoice() {
  return { source: $("hsSource").value,
           targets: [...document.querySelectorAll("#hsTargets input:checked")].map((i) => i.value),
           options: { volumes: $("hsVolumes").checked } };
}

function hsName(file) {
  const d = hsReadable().find((x) => x.file === file);
  return d ? d.difficulty : file;
}

function renderCopyResult() {
  const box = $("hsResult"), p = HS.preview;
  $("hsApply").disabled = !p || !p.targets.some((r) => r.changed);
  if (!p) { box.innerHTML = ""; return; }
  const rows = p.targets.map((r) => `<tr>
      <td class="txt">${esc(hsName(r.file))}</td><td class="num">${r.target_sounds}</td>
      <td class="num">${r.matched}</td><td class="num">${r.changed}</td>
      <td class="num">${r.unmatched}</td><td class="num">${r.index_conflicts}</td></tr>`).join("");
  box.innerHTML = `<div class="table-scroll"><table class="ms-table">
      <thead><tr><th class="txt">${t("hs_t_diff")}</th><th>${t("hs_t_sounds")}</th><th>${t("hs_t_matched")}</th>
        <th>${t("hs_t_changed")}</th><th>${t("hs_t_unmatched")}</th><th>${t("hs_t_conflicts")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${p.targets.some((r) => r.index_conflicts) ? `<div class="card-sub mt-s">${t("hs_conflict_note")}</div>` : ""}`;
}

async function hsPreview() {
  if (!api() || !S.mapset) return;
  const c = hsChoice();
  const reply = await api().hitsound_copy_preview(S.mapset.path, c.source, c.targets, c.options);
  if (!reply.ok) { editFailure(reply); return; }
  HS.preview = { ...reply, choice: JSON.stringify(c) };
  renderCopyResult();
}

async function hsApply() {
  if (!api() || !S.mapset || !HS.preview) return;
  const c = hsChoice();
  if (JSON.stringify(c) !== HS.preview.choice) { await hsPreview(); return; }   // the choice changed: preview it first
  const n = HS.preview.targets.filter((r) => r.changed).length;
  if (!n) { toast(t("hs_nothing", { source: hsName(c.source) })); return; }
  if (!confirm(t("hs_confirm", { source: hsName(c.source), n }))) return;
  const reply = await api().hitsound_copy_apply(S.mapset.path, c.source, c.targets, c.options);
  if (!reply.ok) { editFailure(reply); return; }
  const written = reply.targets.filter((r) => r.written);
  toast(t("hs_done", { n: written.length, objects: written.reduce((a, r) => a + r.objects, 0) }));
  HS.preview = null;
  await hsPreview();                       // what is left: nothing, but index conflicts
  runMapset(S.mapset.path, true);
}

// ------------------------------------------------------------------ audio swap
// Phase 19: one mapset's times onto a new encode of its audio. A preview
// first, which writes nothing and refuses twins and strangers; the apply
// moves every time with backups, and the mapset check re-reads the result.
const SW = { audios: [], current: "", preview: null };

async function renderSwap() {
  const card = $("swCard");
  if (!S.mapset) { card.hidden = true; return; }
  const reply = await api().swap_audios(S.mapset.path);
  if (!reply.ok) { card.hidden = true; return; }
  SW.audios = reply.audios;
  SW.current = reply.current;
  SW.preview = null;
  const others = reply.audios.filter((a) => a !== reply.current);
  card.hidden = others.length < 1;
  if (card.hidden) return;
  $("swOld").textContent = reply.current || "—";
  const box = $("swNew"), keep = box.value;
  box.innerHTML = others.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  if (others.includes(keep)) box.value = keep;
  renderSwapResult();
}

function renderSwapResult() {
  const box = $("swResult"), p = SW.preview;
  $("swApply").disabled = !p || p.refused || !p.maps.some((r) => r.ok);
  if (!p) { box.innerHTML = ""; return; }
  const shift = p.shift;
  box.innerHTML = `<div class="card-sub">${t("sw_shift", { ms: shift.shift_ms.toFixed(2), old: p.old, nw: p.new, peak: shift.peak.toFixed(3) })}</div>
    <div class="table-scroll mt-s"><table class="ms-table">
      <thead><tr><th class="txt">${t("ms_t_diff")}</th><th>${t("sw_t_reds")}</th><th>${t("sw_t_objects")}</th></tr></thead>
      <tbody>${p.maps.map((r) => `<tr><td class="txt">${esc(r.file)}</td>
        <td class="num">${r.ok ? r.reds : `<span class="neg">${esc(r.error)}</span>`}</td>
        <td class="num">${r.ok ? r.objects : ""}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

async function swPreview() {
  if (!api() || !S.mapset) return;
  const reply = await api().swap_preview(S.mapset.path, SW.current, $("swNew").value);
  if (!reply.ok) {
    // A refused choice leaves no preview behind: the last one named another file.
    SW.preview = null;
    renderSwapResult();
    editFailure(reply);
    return;
  }
  SW.preview = { ...reply, choice: SW.current + "\n" + $("swNew").value };
  renderSwapResult();
}

async function swApply() {
  if (!api() || !S.mapset || !SW.preview) return;
  const choice = SW.current + "\n" + $("swNew").value;
  if (choice !== SW.preview.choice) { await swPreview(); return; }
  const n = SW.preview.maps.filter((r) => r.ok).length;
  if (!n) return;
  if (!confirm(t("sw_confirm", { n, ms: SW.preview.shift.shift_ms.toFixed(1), file: $("swNew").value }))) return;
  const moved = $("swNew").value;
  const reply = await api().swap_apply(S.mapset.path, SW.current, moved);
  if (!reply.ok) { editFailure(reply); return; }
  toast(t("sw_done", { n: reply.maps.length, file: moved }));
  SW.preview = null;
  runMapset(S.mapset.path, true);
  renderSwap();
}

// ------------------------------------------------------------------ audio file check
// Phase 21: facts and stated bars for the mapset folder's own audio.
// Read only; runs with the mapset check.
const AC = { reply: null, for: "" };

async function renderAudioCheck() {
  const card = $("acCard");
  if (!S.mapset) { card.hidden = true; return; }
  if (AC.for !== S.mapset.path) {
    AC.for = S.mapset.path;
    AC.reply = await api().audio_check(S.mapset.path);
  }
  const reply = AC.reply;
  card.hidden = !reply;
  if (!reply) return;
  const body = $("acBody");
  if (!reply.ok) {
    body.innerHTML = `<div class="card-sub">${reply.key === "ms_no_audio" ? t("ms_no_audio") : esc(reply.detail || reply.key)}</div>`;
    return;
  }
  const r = reply.report;
  const facts = t("ac_facts", { format: r.format || r.file.split(".").pop().toUpperCase(),
                                rate: r.sample_rate, ch: r.channels, dur: mmss(r.duration_s),
                                br: r.bitrate_kbps, avg: r.bitrate_how === "average" ? t("ac_avg") : "",
                                peak: r.peak_db === null ? "—" : r.peak_db });
  const rows = r.findings.map((f) => {
    const text = f.key === "clipping" ? t("ac_clipping", { share: f.share_pct })
      : f.key === "long_lead" ? t("ac_long_lead", { ms: f.lead_ms })
      : t("ac_low_rate", { rate: f.sample_rate });
    return `<div class="card-sub ${f.level === "warn" ? "neg" : ""}">${esc(text)}</div>`;
  }).join("");
  body.innerHTML = `<div>${esc(facts)}</div>`
    + (rows || `<div class="card-sub">${t("ac_clean")}</div>`);
}

function msKiai(spans) {
  if (!spans.length) return `<span class="card-sub">${t("ms_kiai_none")}</span>`;
  const shown = spans.slice(0, 3).map((s) => `${mmss(s.start_ms / 1000)}–${s.end_ms === null ? t("ms_kiai_end") : mmss(s.end_ms / 1000)}`);
  const rest = spans.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` ${t("align_more", { n: rest })}` : "");
}

function msCheck(list) {
  return list.length ? `<span class="pill amber">${esc(list.join(", "))}</span>` : `<span class="pill accent">${t("ms_match")}</span>`;
}

function renderMapset() {
  const ms = S.mapset, body = $("msBody");
  $("msRecheck").hidden = !ms;
  $("msRedCard").hidden = $("msFieldCard").hidden = true;
  $("msCount").hidden = $("msVerdict").hidden = true;
  if (!ms) {
    $("msFolder").textContent = "";
    body.innerHTML = `<div class="card-sub">${t("ms_empty")}</div>`;
    return;
  }
  const r = ms.report;
  $("msFolder").textContent = ms.name;
  $("msFolder").title = ms.path;
  if (!r.difficulties.length) {
    body.innerHTML = `<div class="card-sub">${t("ms_no_maps")}</div>`;
    return;
  }
  $("msCount").hidden = false;
  $("msCount").textContent = t("ms_count", { n: r.difficulties.length });
  const verdict = $("msVerdict");
  verdict.hidden = false;
  verdict.className = `pill ${r.consistent ? "accent" : "amber"}`;
  verdict.textContent = r.consistent ? t("ms_all_match")
    : [r.differences ? t("ms_to_check", { n: r.differences }) : "",
       r.unreadable ? t("ms_unreadable_n", { n: r.unreadable }) : ""].filter(Boolean).join(" · ");

  const rows = r.difficulties.map((d) => {
    const name = `<td class="txt" title="${esc(d.file)}">${esc(d.difficulty)}${d.reference ? ` <span class="pill blue">${t("ms_reference")}</span>` : ""}</td>`;
    if (!d.readable) return `<tr>${name}<td class="txt neg" colspan="6">${esc(t("ms_unreadable", { detail: d.detail }))}</td></tr>`;
    const reds = d.checks.red_lines ? `<span class="pill amber">${t("ms_differ", { n: d.checks.red_lines })}</span>`
      : (d.reference ? "" : `<span class="pill accent">${t("ms_match")}</span>`);
    return `<tr>${name}
      <td><span class="num">${d.red_lines}</span> ${reds}</td>
      <td>${msCheck(d.checks.audio)}</td>
      <td>${msCheck(d.checks.metadata)}</td>
      <td class="num">${msKiai(d.kiai)}</td>
      <td class="num">${d.density.objects}</td>
      <td class="num">${d.density.mean_per_second.toFixed(2)} · ${d.density.peak_per_second.toFixed(2)}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <div class="table-scroll">
      <table class="ms-table">
        <thead><tr>
          <th class="txt">${t("ms_t_diff")}</th><th>${t("ms_t_reds")}</th><th>${t("ms_t_audio")}</th>
          <th>${t("ms_t_meta")}</th><th>${t("ms_t_kiai")}</th><th>${t("ms_t_objects")}</th><th>${t("ms_t_rate")}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card-sub mt-m">${t("ms_density_note")}</div>`;

  const readable = r.difficulties.filter((d) => d.readable);
  if (readable.length < 2) return;  // nothing to compare against

  const ref = r.difficulties.find((d) => d.reference);
  $("msRedCard").hidden = false;
  $("msRedHint").textContent = ref ? t("ms_red_ref", { ref: ref.difficulty }) : "";
  $("msRedBody").innerHTML = !r.red_lines.length ? `<div class="card-sub">${t("ms_red_same")}</div>` : `
    <div class="table-scroll">
      <table class="ms-table">
        <thead><tr><th class="txt">${t("ms_t_diff")}</th><th>${t("ms_t_offset")}</th><th class="txt">${t("ms_t_what")}</th></tr></thead>
        <tbody>${r.red_lines.map((x) => `
          <tr>
            <td class="txt" title="${esc(x.file)}">${esc(x.difficulty)}</td>
            <td class="num">${exact(x.offset_ms)}</td>
            <td class="txt">${esc(t("ms_d_" + x.kind, { found: exact(x.found), expected: exact(x.expected) }))}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;

  $("msFieldCard").hidden = false;
  $("msFieldHint").textContent = t("ms_fields_hint");
  // Ten fixed rows: no inner scroll box, the view scrolls.
  $("msFieldBody").innerHTML = `
    <div>
      <table class="ms-table">
        <thead><tr><th class="txt">${t("ms_t_field")}</th><th class="txt">${t("ms_t_value")}</th><th class="txt">${t("ms_t_differs")}</th></tr></thead>
        <tbody>${r.fields.map((f) => `
          <tr>
            <td class="txt">${f.field}</td>
            <td class="txt wrap">${msValue(f.value)}</td>
            <td class="txt wrap">${f.identical ? `<span class="pill accent">${t("ms_same_all")}</span>`
              : f.differences.map((x) => `<div><b title="${esc(x.file)}">${esc(x.difficulty)}</b>: <span class="neg">${msValue(x.value)}</span></div>`).join("")}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------------ tempo trace
// Canvas ink comes from the stylesheet's --chart-* tokens, so the timeline
// follows the theme like every other surface. Read again when the theme changes.
const C_TOKENS = {
  plot: "plot", grid: "grid", gridText: "grid-text", tempo: "tempo", fill: "tempo-fill",
  onset: "onset", red: "red", redSoft: "red-soft", redInk: "red-ink", section: "section",
  selected: "selected", cursor: "cursor", beat: "beat", beatBar: "bar", wave: "wave",
  ghost: "ghost", driftOk: "drift-ok", driftWarn: "drift-warn", driftBad: "drift-bad",
  playhead: "playhead", loop: "loop",
  objects: "objects", hsWhistle: "whistle", hsFinish: "finish", hsClap: "clap",
  confHigh: "conf-high", confMid: "conf-mid", confLow: "conf-low", trial: "trial",
  swing: "swing", swingTriplets: "swing-triplets", swingStraight: "swing-straight",
  phHalf: "pulse-half", phDouble: "pulse-double",
};
const C = {};
function chartInk() {
  const css = getComputedStyle(document.documentElement);
  for (const [key, name] of Object.entries(C_TOKENS)) C[key] = css.getPropertyValue(`--chart-${name}`).trim();
}
chartInk();
const PAD = { l: 52, r: 18, t: 34, b: 30 };
let geom = null;

function niceStep(span, target) {
  const raw = span / Math.max(target, 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// The tempo map is a timeline: a visible window of the song (zoom, pan), the
// local tempo on top, then the waveform and the drift lane under it.
const LANES = { wave: 58, objects: 44, swing: 34, drift: 46, gap: 10 };
const TL_MIN_SPAN = 0.5;          // seconds: the closest zoom
const TL_SNAP_PX = 6;             // a dragged red line snaps to an attack this close
const DRIFT_MS = 30;              // the drift lane's half height
const SWING_LATE_MAX = 0.84;      // the swing lane's top: the engine's own bound
const VIEW = { a: 0, b: 0, for: null };
const WAVE = { for: null, bin: 256, rate: 0, min: null, max: null };
let DRIFT = { for: null, dev: null };
const TL = { drag: null, moved: false, suppressClick: false };

function tlView(r) {
  const dur = Math.max(r.duration, 1e-3);
  if (VIEW.for !== r.path) { VIEW.a = 0; VIEW.b = dur; VIEW.for = r.path; }
  const span = Math.min(Math.max(VIEW.b - VIEW.a, TL_MIN_SPAN), dur);
  VIEW.a = Math.min(Math.max(VIEW.a, 0), dur - span);
  VIEW.b = VIEW.a + span;
  return VIEW;
}

function tlFit() { VIEW.a = 0; VIEW.b = S.result ? S.result.duration : 0; drawTrace(); }

// Min/max of every 256 samples, built once per song from the decoded audio:
// a column of the waveform then reduces a few bins, not a few thousand samples.
function waveBuild() {
  const buf = P.buffer;
  if (!buf || WAVE.for === P.bufferFor) return;
  const chans = [];
  for (let c = 0; c < Math.min(buf.numberOfChannels, 2); c++) chans.push(buf.getChannelData(c));
  const n = Math.ceil(buf.length / WAVE.bin), mn = new Float32Array(n), mx = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const end = Math.min(buf.length, (i + 1) * WAVE.bin);
    for (const ch of chans) for (let j = i * WAVE.bin; j < end; j++) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, -mn[i], mx[i]);
  for (let i = 0; i < n; i++) { mn[i] /= peak; mx[i] /= peak; }
  Object.assign(WAVE, { for: P.bufferFor, rate: buf.sampleRate, min: mn, max: mx });
}

async function waveLoad() {
  const r = S.result;
  if (!r || WAVE.for === r.path || !api()) return;
  if (await pbLoad()) { waveBuild(); drawTrace(); }
}

// How far each attack sits from the nearest tick (1/1, 1/2, 1/3, 1/4) of the
// red line governing it: the grid osu! will play, in ms, once per payload.
function driftFor(r) {
  if (DRIFT.for === r) return DRIFT.dev;
  const at = (r.attacks && r.attacks.t) || [], dev = new Float32Array(at.length);
  const pts = r.points;
  let g = 0;
  for (let i = 0; i < at.length; i++) {
    const s = at[i];
    while (g + 1 < pts.length && pts[g + 1].offset_ms / 1000 <= s + 1e-9) g++;
    const p = pts[g];
    if (!p || !(p.bpm > 0)) { dev[i] = NaN; continue; }
    const beat = 60 / p.bpm, pos = (s - p.offset_ms / 1000) / beat;
    let best = Infinity;
    for (const d of [1, 2, 3, 4]) {
      const off = (s - (p.offset_ms / 1000 + (Math.round(pos * d) / d) * beat)) * 1000;
      if (Math.abs(off) < Math.abs(best)) best = off;
    }
    dev[i] = best;
  }
  DRIFT = { for: r, dev };
  return dev;
}

// Diagonal hatching, one tile per ink: the grid's own, so it follows the theme.
const HATCH = { ink: null, pattern: null };
function hatchFill(ctx) {
  if (HATCH.ink !== C.grid || !HATCH.pattern) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 8;
    const g = tile.getContext("2d");
    g.strokeStyle = C.grid; g.lineWidth = 1.5;
    g.beginPath();
    for (const d of [-8, 0, 8]) { g.moveTo(d, 8); g.lineTo(d + 8, 0); }
    g.stroke();
    Object.assign(HATCH, { ink: C.grid, pattern: ctx.createPattern(tile, "repeat") });
  }
  return HATCH.pattern;
}

// The loaded map's red lines, drawn as ghosts beside the working ones.
function ghostLines() {
  if (S.ref && S.ref.report && S.ref.report.ok) return S.ref.report.lines.map((l) => l.offset_ms / 1000);
  if (S.compare && S.compare.report) return S.compare.report.sections.map((s) => s.map_offset_ms / 1000);
  return [];
}

function drawTrace(hoverX) {
  const r = S.result, canvas = $("trace");
  if (!r) return;
  const wrap = $("traceWrap"), dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;  // Timing is not the visible view; setView redraws it
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const v = tlView(r), span = v.b - v.a, dur = Math.max(r.duration, 1e-3);
  const x0 = PAD.l, x1 = W - PAD.r;
  // The lanes stack up from the drift lane's foot, and the two conditional
  // ones take no room when they are off: the object lane (P-7) only while a
  // difficulty's hitsounds are picked, the swing lane only when the song swings.
  const lane = !!(HSP.events && HSP.objects);
  const swung = !!(SWING.report && SWING.report.spans.length);
  let foot = H - PAD.b;
  const yD1 = foot, yD0 = yD1 - LANES.drift;
  foot = yD0;
  let yS0 = foot, yS1 = foot;
  if (swung) { yS1 = foot - LANES.gap; yS0 = yS1 - LANES.swing; foot = yS0; }
  let yO0 = foot, yO1 = foot;
  if (lane) { yO1 = foot - LANES.gap; yO0 = yO1 - LANES.objects; foot = yO0; }
  const yW1 = foot - LANES.gap, yW0 = yW1 - LANES.wave;
  const y0 = PAD.t, y1 = yW0 - LANES.gap;
  const X = (s) => x0 + ((s - v.a) / span) * (x1 - x0);
  const Sx = (x) => v.a + ((x - x0) / (x1 - x0)) * span;

  // y range: robust to the few wild local fits at a section edge
  const vals = r.trace.bpm.filter((b) => b > 0).slice().sort((a, b) => a - b);
  const pts = r.points.map((p) => p.bpm);
  let lo = vals.length ? vals[Math.floor(vals.length * 0.02)] : Math.min(...pts);
  let hi = vals.length ? vals[Math.floor(vals.length * 0.98)] : Math.max(...pts);
  lo = Math.min(lo, ...pts); hi = Math.max(hi, ...pts);
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const padY = (hi - lo) * 0.12; lo -= padY; hi += padY;
  const Y = (b) => y1 - ((b - lo) / (hi - lo)) * (y1 - y0);
  geom = { x0, x1, y0, y1, yW0, yW1, yO0, yO1, yS0, yS1, yD0, yD1, dur, X, S: Sx, Y, lo, hi };

  const plotTop = y0 - 22;
  const panels = [[plotTop, y1], [yW0, yW1], [yD0, yD1]]
    .concat(lane ? [[yO0, yO1]] : []).concat(swung ? [[yS0, yS1]] : []);
  ctx.fillStyle = C.plot;
  for (const [a, b] of panels) { roundRect(ctx, x0, a, x1 - x0, b - a, 12); ctx.fill(); }
  const clipAll = () => { ctx.beginPath(); for (const [a, b] of panels) ctx.rect(x0, a, x1 - x0, b - a); ctx.clip(); };

  // section shading (alternating) and the selected point's span, through every lane
  ctx.save(); clipAll();
  const bounds = r.points.map((p) => p.offset_ms / 1000).concat([dur]);
  r.points.forEach((p, i) => {
    const a = X(bounds[i]), b = X(bounds[i + 1]);
    if (b < x0 || a > x1) return;
    if (i === S.selected) { ctx.fillStyle = C.selected; ctx.fillRect(a, plotTop, b - a, yD1 - plotTop); }
    else if (i % 2 === 1) { ctx.fillStyle = C.section; ctx.fillRect(a, plotTop, b - a, yD1 - plotTop); }
  });
  // Before the first red line no line governs the song: osu! runs that line's
  // grid back over it, which holds only if the intro keeps its tempo.
  const firstLine = bounds.length > 1 ? bounds[0] : 0;
  if (firstLine > v.a) {
    ctx.fillStyle = hatchFill(ctx);
    ctx.fillRect(X(v.a), plotTop, Math.min(X(firstLine), x1) - X(v.a), yD1 - plotTop);
  }

  // the beat grid once beats are far enough apart to read; zoomed out past
  // that, the bars alone while they are
  const ct = (r.clicks && r.clicks.t) || [], cl = (r.clicks && r.clicks.level) || [];
  const spacing = (level) => {
    const first = [];
    for (let i = 0; i < ct.length && first.length < 2; i++) if (cl[i] >= level) first.push(ct[i]);
    return first.length > 1 ? ((x1 - x0) / span) * (first[1] - first[0]) : 0;
  };
  const gridLevel = spacing(1) >= 7 ? 1 : spacing(2) >= 8 ? 2 : 0;
  if (gridLevel) {
    for (let i = lowerBound(ct, v.a); i < ct.length && ct[i] <= v.b; i++) {
      if (!(cl[i] >= gridLevel)) continue;
      const x = Math.round(X(ct[i])) + 0.5;
      ctx.strokeStyle = cl[i] === 2 ? C.beatBar : C.beat; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, yW1); ctx.stroke();
    }
  }

  // waveform, or the onset envelope until the song is decoded
  const wmid = (yW0 + yW1) / 2, wh = (yW1 - yW0) / 2 - 4;
  if (WAVE.for === r.path && WAVE.min) {
    ctx.fillStyle = C.wave;
    const perBin = WAVE.bin / WAVE.rate;
    for (let px = Math.floor(x0); px < x1; px++) {
      const i0 = Math.max(0, Math.floor(Sx(px) / perBin)), i1 = Math.min(WAVE.min.length, Math.max(i0 + 1, Math.ceil(Sx(px + 1) / perBin)));
      if (i0 >= WAVE.min.length) break;
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) { if (WAVE.min[i] < mn) mn = WAVE.min[i]; if (WAVE.max[i] > mx) mx = WAVE.max[i]; }
      ctx.fillRect(px, wmid - mx * wh, 1, Math.max(1, (mx - mn) * wh));
    }
  } else {
    const on = r.onset.v, ospan = r.onset.span_s || dur;
    if (on.length) {
      ctx.fillStyle = C.onset;
      for (let i = 0; i < on.length; i++) {
        const x = X((i / on.length) * ospan);
        if (x < x0 - 2 || x > x1) continue;
        const h = on[i] * wh;
        if (h >= 0.6) ctx.fillRect(x, wmid - h, Math.max(((x1 - x0) / on.length) * (dur / span), 1), 2 * h);
      }
    }
  }

  // object lane: the picked difficulty's objects, and under them each
  // sound's additions in rows of their own (whistle, finish, clap)
  if (lane) {
    const top = yO0 + 6, barH = 8, ob = HSP.objects;
    ctx.fillStyle = C.objects;
    for (let i = 0; i < ob.t.length; i++) {
      const a = ob.t[i], e = ob.end[i] ?? a;
      if (e < v.a || a > v.b) continue;
      const xa = X(a), xb = X(e);
      if (ob.end[i] !== null) { roundRect(ctx, xa, top, Math.max(3, xb - xa), barH, 3); ctx.fill(); }
      else ctx.fillRect(Math.round(xa) - 1, top - 1, 3, barH + 2);
    }
    const ev = HSP.events, rows = [[2, C.hsWhistle], [4, C.hsFinish], [8, C.hsClap]];
    for (let i = lowerBound(ev.t, v.a); i < ev.t.length && ev.t[i] <= v.b; i++) {
      const adds = ev.adds[i];
      if (!adds) continue;
      const x = X(ev.t[i]);
      rows.forEach(([bit, colour], k) => {
        if (!(adds & bit)) return;
        ctx.fillStyle = colour;
        ctx.beginPath(); ctx.arc(x, top + barH + 7 + k * 7, 2.4, 0, 2 * Math.PI); ctx.fill();
      });
    }
  }

  // swing lane: where each window's off-beat eighth falls inside the beat,
  // with the straight half and the two snaps a mapper would reach for ruled in
  if (swung) {
    const top = yS0 + 6, bot = yS1 - 6;
    const Yp = (p) => bot - ((p - 0.5) / (SWING_LATE_MAX - 0.5)) * (bot - top);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (const p of [0.5, 2 / 3, 0.75]) {
      const y = Math.round(Yp(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
    for (const w of SWING.report.windows) {
      if (w.at === null || w.end_ms / 1000 < v.a || w.start_ms / 1000 > v.b) continue;
      const a = X(w.start_ms / 1000), b = X(w.end_ms / 1000), y = Math.round(Yp(w.at)) + 0.5;
      ctx.strokeStyle = w.feel === "swing" ? C.swing
        : w.feel === "triplets" ? C.swingTriplets : C.swingStraight;
      ctx.lineWidth = w.feel === "straight" ? 1.5 : 3;
      ctx.beginPath(); ctx.moveTo(a, y); ctx.lineTo(Math.max(a + 1.5, b - 1), y); ctx.stroke();
    }
  }

  // drift lane: each attack's distance from the grid osu! will play
  const dmid = (yD0 + yD1) / 2, dh = (yD1 - yD0) / 2 - 4;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, Math.round(dmid) + 0.5); ctx.lineTo(x1, Math.round(dmid) + 0.5); ctx.stroke();
  const dev = driftFor(r), at = (r.attacks && r.attacks.t) || [], aw = (r.attacks && r.attacks.w) || [];
  for (let i = lowerBound(at, v.a); i < at.length && at[i] <= v.b; i++) {
    const d = dev[i];
    if (!Number.isFinite(d)) continue;
    const ad = Math.abs(d);
    ctx.fillStyle = ad <= 5 ? C.driftOk : ad <= 15 ? C.driftWarn : C.driftBad;
    ctx.globalAlpha = 0.35 + 0.65 * (aw[i] || 0);
    const y = dmid - (Math.max(-DRIFT_MS, Math.min(DRIFT_MS, d)) / DRIFT_MS) * dh;
    ctx.beginPath(); ctx.arc(X(at[i]), y, 1.4 + 1.4 * (aw[i] || 0), 0, 2 * Math.PI); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // horizontal grid + labels
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  const ystep = niceStep(hi - lo, 4);
  ctx.save(); roundRect(ctx, x0, plotTop, x1 - x0, y1 - plotTop, 12); ctx.clip();
  for (let b = Math.ceil(lo / ystep) * ystep; b <= hi; b += ystep) {
    const y = Y(b);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let b = Math.ceil(lo / ystep) * ystep; b <= hi; b += ystep) ctx.fillText(Number.isInteger(b) ? b : b.toFixed(1), x0 - 10, Y(b));
  ctx.fillText(t("lane_wave"), x0 - 10, wmid);
  if (lane) ctx.fillText(t("lane_objects"), x0 - 10, (yO0 + yO1) / 2);
  if (swung) ctx.fillText(t("lane_swing"), x0 - 10, (yS0 + yS1) / 2);
  ctx.fillText(`±${DRIFT_MS}`, x0 - 10, dmid);

  // time axis, over the visible window
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const tstep = niceStep(span, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = Math.ceil(v.a / tstep) * tstep; s <= v.b + 1e-6; s += tstep) {
    ctx.fillText(span < 30 ? fmtTime(s) : mmss(s), X(s), yD1 + 8);
  }

  // tempo curve with a soft fill
  const tt = r.trace.t, bb = r.trace.bpm;
  if (tt.length > 1 && bb.length === tt.length) {
    ctx.save(); roundRect(ctx, x0, plotTop, x1 - x0, y1 - plotTop, 12); ctx.clip();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < tt.length; i++) {
      if (!(bb[i] > 0)) continue;
      const x = X(tt[i]), y = Y(Math.min(Math.max(bb[i], lo), hi));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2; ctx.strokeStyle = C.tempo; ctx.lineJoin = "round"; ctx.stroke();
    ctx.lineTo(X(tt[tt.length - 1]), y1); ctx.lineTo(X(tt[0]), y1); ctx.closePath();
    ctx.fillStyle = C.fill; ctx.fill();
    ctx.restore();
  }

  // Pulse hints: the stretch that reads half or double, as a band over the
  // confidence ribbon, with the beat the change sits on marked through the
  // plot. Nothing here is a red line — it is evidence, and the card says why.
  if (PH.hints && PH.hints.length) {
    ctx.save(); roundRect(ctx, x0, plotTop, x1 - x0, y1 - plotTop, 12); ctx.clip();
    for (const h of PH.hints) {
      const a = Math.max(X(h.from_s), x0), b = Math.min(X(h.to_s), x1);
      if (b > a) {
        ctx.fillStyle = phWay(h) === "half" ? C.phHalf : C.phDouble;
        ctx.fillRect(a, y1 - 12, Math.max(1, b - a), 5);
      }
      const at = X(h.boundary_s);
      if (at >= x0 && at <= x1) {
        ctx.strokeStyle = phWay(h) === "half" ? C.phHalf : C.phDouble;
        ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(Math.round(at) + 0.5, plotTop);
        ctx.lineTo(Math.round(at) + 0.5, y1 - 7); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  // Each section's confidence along the plot's foot, coloured as the points
  // list's bars (90 % and up, 75 % and up, below), a pixel apart at each line.
  ctx.save(); roundRect(ctx, x0, plotTop, x1 - x0, y1 - plotTop, 12); ctx.clip();
  r.points.forEach((p, i) => {
    const a = Math.max(X(bounds[i]), x0), b = Math.min(X(bounds[i + 1]), x1);
    if (b <= a) return;
    ctx.fillStyle = p.confidence >= 0.9 ? C.confHigh : p.confidence >= 0.75 ? C.confMid : C.confLow;
    ctx.fillRect(a, y1 - 5, Math.max(1, b - a - 1), 4);
  });
  ctx.restore();

  // the compared map's red lines, as ghosts
  ctx.save(); clipAll();
  ctx.strokeStyle = C.ghost; ctx.lineWidth = 1.25; ctx.setLineDash([3, 4]);
  for (const s of ghostLines()) {
    const x = Math.round(X(s)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, plotTop + 22); ctx.lineTo(x, yD1); ctx.stroke();
  }
  // the red lines a confidence being tried would add, dashed in their own ink
  ctx.strokeStyle = C.trial; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  for (const s of CONF.added) {
    const x = Math.round(X(s)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, yD1); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // red lines with value chips (staggered when they would overlap)
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const lastRight = [-1e9, -1e9];
  const dragging = TL.drag && TL.drag.kind === "line" && TL.moved ? TL.drag : null;
  r.points.forEach((p, i) => {
    const s = dragging && dragging.i === i ? dragging.to : p.offset_ms / 1000;
    const x = Math.round(X(s)) + 0.5;
    if (x < x0 - 60 || x > x1 + 1) return;
    // A line the confidence being tried would drop is drawn faded.
    ctx.globalAlpha = CONF.removed.has(i) ? 0.3 : 1;
    ctx.strokeStyle = C.red; ctx.lineWidth = i === S.selected || (dragging && dragging.i === i) ? 2 : 1.25;
    ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, yD1); ctx.stroke();
    // A red line where the bar changes length says so: the signature's region starts here.
    const meterChange = p.meter !== (i ? r.points[i - 1].meter : 4);
    const label = dragging && dragging.i === i ? `${(s * 1000).toFixed(1)} ms`
      : p.bpm.toFixed(p.bpm % 1 ? 2 : 0) + (meterChange ? ` · ${p.meter}/4` : "");
    const w = ctx.measureText(label).width + 16;
    const row = x > lastRight[0] + 4 ? 0 : (x > lastRight[1] + 4 ? 1 : 0);
    lastRight[row] = x + w;
    const top = y0 - 20 + row * 24;
    ctx.fillStyle = C.red; roundRect(ctx, x, top, w, 20, 4); ctx.fill();
    ctx.fillStyle = C.redInk; ctx.fillText(label, x + 8, top + 10.5);
    ctx.globalAlpha = 1;
  });

  // hover cursor
  if (hoverX !== undefined && hoverX >= x0 && hoverX <= x1) {
    ctx.strokeStyle = C.cursor; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(hoverX + 0.5, plotTop); ctx.lineTo(hoverX + 0.5, yD1); ctx.stroke();
    ctx.setLineDash([]);
  }
  $("tlZoom").textContent = span < dur - 1e-6 ? t("tl_zoom", { a: fmtTime(v.a), b: fmtTime(v.b) }) : "";
  $("tlFit").hidden = !(span < dur - 1e-6);
  pbDraw();  // the playhead layer follows the map's geometry
}

// -- timeline interaction: wheel zooms at the cursor, drag pans, a red line
// -- drags (snapping to the nearest attack; Alt moves it freely)
// The pointer in the canvas's own pixels. Under the interface-size setting
// (CSS zoom) the client rect is scaled and the canvas is not: at 120 % the
// pointer landed 20 % off, and a red line could not be caught.
function tlX(ev) {
  const rect = $("trace").getBoundingClientRect(), width = $("traceWrap").clientWidth;
  return (ev.clientX - rect.left) * (rect.width ? width / rect.width : 1);
}

function tlLineAt(x) {
  if (!S.result || !geom) return -1;
  let best = -1, bd = TL_SNAP_PX + 1;
  S.result.points.forEach((p, i) => {
    const d = Math.abs(geom.X(p.offset_ms / 1000) - x);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function tlSnap(s, free) {
  const at = (S.result.attacks && S.result.attacks.t) || [];
  if (free || !at.length) return s;
  const i = lowerBound(at, s);
  let best = s, bd = Infinity;
  for (const j of [i - 1, i]) {
    if (j < 0 || j >= at.length) continue;
    const d = Math.abs(geom.X(at[j]) - geom.X(s));
    if (d <= TL_SNAP_PX && d < bd) { bd = d; best = at[j]; }
  }
  return best;
}

// A drawn loop's ends go on the nearest beat, so it repeats whole beats and
// the click folds into it; Alt leaves an end where the pointer is.
function tlBeat(s, free) {
  const beats = S.result.trace.t;
  if (free || !beats.length) return Math.min(Math.max(s, 0), S.result.duration);
  const i = lowerBound(beats, s);
  const near = [i - 1, i].filter((j) => j >= 0 && j < beats.length);
  return near.reduce((best, j) => (Math.abs(beats[j] - s) < Math.abs(best - s) ? beats[j] : best), beats[near[0]]);
}

function loopSpan(from, to) {
  return to === null || from === to ? null : { a: Math.min(from, to), b: Math.max(from, to) };
}

// m:ss.sss, as the transport's clock reads.
function clock3(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(3)}`;
}

function pbLoopLabel() {
  $("pbLoopText").textContent = P.userLoop
    ? t("pb_loop_drawn", { a: clock3(P.userLoop.a), b: clock3(P.userLoop.b) }) : t("pb_loop");
}

function setUserLoop(span) {
  P.userLoop = span;
  pbLoopLabel();
  if (span) $("pbLoop").checked = true;
  // Playing: go on in the new loop (or the section under the playhead again).
  if (P.playing) pbPlay(span ? span.a : pbPosition());
  else { if (span) P.pos = span.a; pbDraw(); }
}

function tlDown(ev) {
  if (ev.button !== 0 || !S.result || !geom) return;
  const x = tlX(ev), i = tlLineAt(x);
  TL.moved = false;
  if (ev.shiftKey) {
    TL.drag = { kind: "loop", x0: x, from: tlBeat(geom.S(x), ev.altKey), to: null };
    return;
  }
  TL.drag = i >= 0 && !(S.locks || []).includes(S.result.points[i].offset_ms)
    ? { kind: "line", i, x0: x, to: S.result.points[i].offset_ms / 1000 }
    : { kind: "pan", x0: x, a: VIEW.a, b: VIEW.b };
}

function tlMove(ev) {
  if (!TL.drag || !geom) return;
  const x = tlX(ev), dx = x - TL.drag.x0;
  if (Math.abs(dx) > 3) TL.moved = true;
  if (!TL.moved) return;
  if (TL.drag.kind === "pan") {
    const ds = (dx / (geom.x1 - geom.x0)) * (TL.drag.b - TL.drag.a);
    VIEW.a = TL.drag.a - ds; VIEW.b = TL.drag.b - ds;
    $("trace").style.cursor = "grabbing";
  } else if (TL.drag.kind === "loop") {
    TL.drag.to = tlBeat(geom.S(x), ev.altKey);
  } else {
    TL.drag.to = tlSnap(geom.S(x), ev.altKey);
  }
  $("tip").hidden = true;
  drawTrace();
}

async function tlUp() {
  const drag = TL.drag;
  TL.drag = null;
  $("trace").style.cursor = "";
  if (!drag) return;
  if (TL.moved) TL.suppressClick = true;
  if (drag.kind === "loop") {
    TL.suppressClick = true;                 // Shift-click clears; it does not select
    const span = TL.moved ? loopSpan(drag.from, drag.to) : null;
    if (span && span.b - span.a >= 0.05) {
      // Whole beats when both ends sit on one; with Alt, its length instead.
      const beats = S.result.trace.t, at = (s) => lowerBound(beats, s - 1e-9);
      const whole = beats[at(span.a)] === span.a && beats[at(span.b)] === span.b;
      setUserLoop(span);
      toast(whole ? t("loop_set", { a: clock3(span.a), b: clock3(span.b), n: at(span.b) - at(span.a) })
                  : t("loop_set_free", { a: clock3(span.a), b: clock3(span.b), s: (span.b - span.a).toFixed(3) }));
    } else if (!TL.moved && P.userLoop) {
      setUserLoop(null);
      toast(t("loop_cleared"));
    } else drawTrace();
    return;
  }
  if (drag.kind !== "line" || !TL.moved || !api()) { drawTrace(); return; }
  const p = S.result.points[drag.i];
  const reply = await api().edit_apply(drag.i, Math.round(drag.to * 1e6) / 1000, p.bpm);
  if (!reply.ok) { editFailure(reply); drawTrace(); return; }
  showEditResult(reply, t("edited", { n: drag.i + 1, bpm: p.bpm.toFixed(3), ms: (drag.to * 1000).toFixed(1) }));
}

function tlWheel(ev) {
  if (!S.result || !geom) return;
  ev.preventDefault();
  const s = geom.S(tlX(ev)), dur = S.result.duration, span = VIEW.b - VIEW.a;
  const next = Math.min(Math.max(span * Math.exp(ev.deltaY * 0.0015), TL_MIN_SPAN), dur);
  VIEW.a = s - (s - VIEW.a) * (next / span);
  VIEW.b = VIEW.a + next;
  drawTrace();
}

function governing(r, s) {
  let idx = 0;
  r.points.forEach((p, i) => { if (p.offset_ms / 1000 <= s + 1e-9) idx = i; });
  return idx;
}

function onTraceMove(ev) {
  const r = S.result; if (!r || !geom) return;
  const x = tlX(ev);
  const tip = $("tip");
  if (TL.drag) return;
  $("trace").style.cursor = tlLineAt(x) >= 0 ? "ew-resize" : "";
  if (x < geom.x0 || x > geom.x1) { tip.hidden = true; drawTrace(); return; }
  const s = geom.S(x);
  let j = 0, best = Infinity;
  r.trace.t.forEach((tt, i) => { const d = Math.abs(tt - s); if (d < best) { best = d; j = i; } });
  const g = r.points[governing(r, s)];
  tip.innerHTML = `
    <div class="row"><span class="k">${t("time_at")}</span><span class="num">${fmtTime(s)}</span></div>
    <div class="row"><span class="k">${t("tempo_at")}</span><span class="num">${(r.trace.bpm[j] || 0).toFixed(2)}</span></div>
    <div class="row"><span class="k">${t("line_at")}</span><span class="num">${g ? g.bpm.toFixed(3) : "—"}</span></div>
    <div class="row"><span class="k">${t("conf_at")}</span><span class="num">${g ? `${Math.round(g.confidence * 100)}%` : "—"}</span></div>
    ${r.points.length && s < r.points[0].offset_ms / 1000 ? `<div class="row"><span class="k">${t("before_first")}</span></div>` : ""}`;
  tip.style.left = `${x}px`; tip.style.top = `${geom.y0}px`;
  tip.hidden = false;
  drawTrace(x);
}

function selectPoint(i, toggle = true) {
  S.selected = toggle && S.selected === i ? -1 : i;
  document.querySelectorAll("#rows tr").forEach((tr) => {
    const on = +tr.dataset.i === S.selected;
    tr.classList.toggle("sel", on);
    if (on) {
      const box = tr.closest(".table-scroll"), top = tr.offsetTop - box.querySelector("thead").offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (tr.offsetTop + tr.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = tr.offsetTop + tr.offsetHeight - box.clientHeight;
    }
  });
  renderDetail();
  drawTrace();
}

let drawerOpener = null;
function openDrawer(open) {
  const drawer = $("drawer"), wasOpen = drawer.classList.contains("open");
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  // Closed, it is only slid off screen: inert keeps Tab out of it.
  drawer.inert = !open;
  $("scrim").hidden = !open;
  if (open && !wasOpen) {
    drawerOpener = document.activeElement;
    $("closeDrawer").focus();
  } else if (!open && wasOpen && drawerOpener && drawerOpener.focus) {
    drawerOpener.focus();
    drawerOpener = null;
  }
  // A confidence tried and left is not applied: the map shows what is.
  if (!open && wasOpen) confLiveClear();
}

// ------------------------------------------------------------------ keyboard
// Every shortcut, as the sheet (?) lists it: alternatives, each a chord of
// keys. Named keys are translated; the rest read as printed on the key.
const KEYS = [
  [[["kb_space"]], "key_play"],
  [[["←"], ["→"]], "key_seek"],
  [[["kb_shift", "←"], ["kb_shift", "→"]], "key_seek_fine"],
  [[["["], ["]"]], "key_lines"],
  [[["↑"], ["↓"]], "key_points"],
  [[["L"]], "key_loop"],
  [[["C"]], "key_click"],
  [[["T"]], "key_tap"],
  [[["1–9"], ["0"]], "key_views"],
  [[["Ctrl", "O"]], "key_open"],
  [[["kb_enter"], ["F5"]], "key_analyze"],
  [[["Ctrl", "Z"]], "key_undo"],
  [[["Ctrl", "Y"], ["Ctrl", "kb_shift", "Z"]], "key_redo"],
  [[["?"]], "key_sheet"],
  [[["Esc"]], "key_close"],
];

function renderKeys() {
  const kbd = (k) => `<kbd>${esc(k.startsWith("kb_") ? t(k) : k)}</kbd>`;
  $("keysList").innerHTML = KEYS.map(([alts, what]) =>
    `<dt>${alts.map((chord) => chord.map(kbd).join(" + ")).join(" / ")}</dt><dd>${esc(t(what))}</dd>`).join("");
}

function openKeys() {
  const sheet = $("keysSheet");
  if (sheet.open) { sheet.close(); return; }
  renderKeys();
  sheet.showModal();
}

// [ and ]: the red line before or after the playhead, selected, the playhead on it.
function jumpLine(dir) {
  const pos = pbPosition(), lines = S.result.points.map((p) => p.offset_ms / 1000);
  let i = -1;
  if (dir > 0) i = lines.findIndex((s) => s > pos + 0.001);
  else for (let k = lines.length - 1; k >= 0; k--) if (lines[k] < pos - 0.001) { i = k; break; }
  if (i < 0) return;
  selectPoint(i, false);
  pbSeek(Math.max(0, lines[i]), true);
}

// L and C: the transport's own check boxes, so the view shows what the key did.
function toggleCheck(id) {
  const box = $(id);
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change"));
  toast(t("key_toggled", { what: box.closest("label").textContent.trim(),
                           state: t(box.checked ? "key_state_on" : "key_state_off") }));
}

// ------------------------------------------------------------------ wiring
let focusByKey = false;

function wire() {
  document.querySelectorAll("#nav [data-view]").forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  stWire();
  $("needOpen").onclick = openAudio;
  $("needAnalyze").onclick = analyze;
  $("needLibrary").onclick = () => setView("library");
  $("openBtn").onclick = openAudio;
  $("emptyOpen").onclick = (e) => { e.stopPropagation(); openAudio(); };
  $("importBtn").onclick = (e) => { e.stopPropagation(); importFolder(); };
  $("emptyAnalyze").onclick = (e) => { e.stopPropagation(); analyze(); };
  $("settingsBtn").onclick = () => openDrawer(true);
  $("closeDrawer").onclick = () => openDrawer(false);
  $("scrim").onclick = () => openDrawer(false);
  $("drop").onclick = openAudio;
  $("analyzeBtn").onclick = analyze;
  $("stopBtn").onclick = stopAnalysis;
  $("projectOffer").addEventListener("click", (e) => {
    const b = e.target.closest("[data-project]");
    if (b) projectAction(b.dataset.project);
  });
  $("halfBtn").onclick = () => rescale(0.5);
  $("doubleBtn").onclick = () => rescale(2);
  $("rows").onclick = (e) => { const tr = e.target.closest("tr"); if (tr) selectPoint(+tr.dataset.i); };
  $("hsvMap").onchange = () => hsvPick($("hsvMap").value);
  $("hsvFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    HSV.filter = b.dataset.f; HSV.shown = HSV_PAGE;
    document.querySelectorAll("#hsvFilter button").forEach((x) => x.classList.toggle("on", x === b));
    renderHitsoundsView();
  });
  $("hsvMore").onclick = () => { HSV.shown += HSV_PAGE; renderHitsoundsView(); };
  $("hsvPropose").onclick = () => hsvPropose();
  $("hsvProposeAll").onclick = () => hsvProposeAll();
  $("hsvProfile").onchange = () => { HSD.profile = $("hsvProfile").value; hsdRender(); };
  $("hsvDecideAll").onclick = () => hsdSetAll(true);
  $("hsvDecideNone").onclick = () => hsdSetAll(false);
  $("hsvDecidePreview").onclick = () => hsdPreview();
  $("hsvDecideHear").onclick = () => hsdHear();
  $("hsvDecideApply").onclick = () => hsdWrite(false);
  $("hsvDecideCopy").onclick = () => hsdWrite(true);
  $("hsvDecideUndo").onclick = () => hsdUndo();
  $("hsvEditSet").onclick = () => hsdEditSet();
  $("hsvEditClear").onclick = () => hsdEditClear();
  ["hsvEditVolume", "hsvEditIndex"].forEach((id) => $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); hsdEditSet(); }
  }));
  ["hsvBarFrom", "hsvBarTo"].forEach((id) => $(id).addEventListener("input", () => {
    const bar = (el) => (el.value.trim() === "" || !Number.isFinite(+el.value) ? null : Math.trunc(+el.value));
    HSV.bars = { from: bar($("hsvBarFrom")), to: bar($("hsvBarTo")) };
    HSV.shown = HSV_PAGE;
    renderHitsoundsView();
  }));
  $("hsvRows").addEventListener("change", (e) => {
    const alt = e.target.closest("[data-hsd-alt]");
    if (alt) {
      // A runner-up chosen is a sound wanted: it ticks itself.
      const key = alt.dataset.hsdAlt, k = +alt.value;
      if (k < 0) HSD.choice.delete(key);
      else { HSD.choice.set(key, k); HSD.accepted.add(key); }
      $("hsvDecidePrevText").textContent = "";
      renderHitsoundsView();
      hsdTicked();
      return;
    }
    const box = e.target.closest("[data-hsd]");
    if (!box) return;
    if (box.checked) HSD.accepted.add(box.dataset.hsd);
    else HSD.accepted.delete(box.dataset.hsd);
    $("hsvDecidePrevText").textContent = "";
    hsdRender();
    hsdTicked();
  });
  $("hsvRows").addEventListener("click", (e) => {
    const play = e.target.closest("[data-play]");
    if (play) { hsvPlay(+play.dataset.play); return; }
    if (e.target.closest("select, input, label")) return;   // a choice, not a seek
    const row = e.target.closest("tr[data-i]");
    const s = row && HSV.report && HSV.report.sounds[+row.dataset.i];
    if (!s) return;
    pbSeek(Math.max(0, s.t - 1));
    // The row's decision opens over the table, and the row stays marked.
    HSV.selected = +row.dataset.i;
    document.querySelectorAll("#hsvRows tr.sel").forEach((tr) => tr.classList.remove("sel"));
    row.classList.add("sel");
    hsdWhy();
    sbRenderHear();
  });
  $("hsvWhy").addEventListener("click", (e) => {
    if (!e.target.closest("[data-why-close]")) return;
    HSV.selected = null;
    document.querySelectorAll("#hsvRows tr.sel").forEach((tr) => tr.classList.remove("sel"));
    hsdWhy();
    sbRenderHear();
  });
  $("sbSource").addEventListener("click", (e) => {
    const b = e.target.closest("[data-src]");
    if (!b || b.disabled) return;
    if (b.dataset.src === "pick") sbPick(); else sbLoad(b.dataset.src);
  });
  $("sbRows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sb-cell]");
    if (b && SB.reply) sbHearAlone(sbWhere(SB.reply.bank.cells[+b.dataset.sbCell]));
  });
  $("sbCustom").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sb-custom]");
    if (b && SB.reply) sbHearAlone(sbWhere(SB.reply.bank.custom[+b.dataset.sbCustom]));
  });
  $("sbUse").onclick = () => { if (SB.reply) sbSetSkin(SB.reply.bank.folder); };
  $("sbStop").onclick = () => sbSetSkin("");
  $("sbHear").onclick = sbHearAtSound;
  $("stxBody").addEventListener("click", (e) => {
    const el = e.target.closest("[data-stx]");
    if (el) stxShow(+el.dataset.stx);
  });
  $("stxBmPreview").onclick = stxBmPreview;
  $("stxBmApply").onclick = stxBmApply;
  $("stxBmMap").onchange = () => { STXBM.preview = null; renderBookmarks(); };
  $("stxKiaiPreview").onclick = stxKiaiPreview;
  $("stxKiaiApply").onclick = stxKiaiApply;
  $("stxKiaiMap").onchange = () => { STXK.preview = null; renderKiai(); };
  $("stxBreaksPreview").onclick = stxBreaksPreview;
  $("stxBreaksApply").onclick = stxBreaksApply;
  $("stxBreaksMap").onchange = () => { STXBR.preview = null; renderBreaks(); };
  $("stxVolPreview").onclick = stxVolPreview;
  $("stxVolApply").onclick = stxVolApply;
  $("stxVolMap").onchange = () => { STXV.preview = null; renderVolumes(); };
  $("songsScan").onclick = () => songsScan();
  $("songsPick").onclick = songsPick;
  $("songsQuery").oninput = () => {
    clearTimeout(SONGS.timer);
    SONGS.timer = setTimeout(() => { SONGS.query = $("songsQuery").value; songsSearch(); }, 120);
  };
  $("songsList").onclick = (e) => {
    const btn = e.target.closest("[data-song]");
    const set = btn && SONGS.result && SONGS.result.sets[+btn.dataset.song];
    if (set) importFolderPath(set.folder);
  };
  $("recentList").onclick = (e) => {
    const btn = e.target.closest("[data-recent]");
    if (btn && S.recent[+btn.dataset.recent]) setFile(S.recent[+btn.dataset.recent]);
  };
  $("warnings").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-warn]");
    if (toggle) {
      const key = toggle.dataset.warn;
      if (WARN.open.has(key)) WARN.open.delete(key); else WARN.open.add(key);
      renderWarnings(S.result.warnings);
      return;
    }
    if (e.target.closest("[data-warn-all]")) { WARN.all = !WARN.all; renderWarnings(S.result.warnings); return; }
    const chip = e.target.closest("[data-point]");
    const i = chip ? +chip.dataset.point : -1;
    if (!S.result || !(i >= 0 && i < S.result.points.length)) return;
    selectPoint(i, false);
    document.querySelector(".trace-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("detail").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) editAction(btn.dataset.action);
  });
  $("detail").addEventListener("change", (e) => {
    if (e.target.id === "editMeter") editAction("meter");
  });
  $("cmpBody").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { suggestAdd(+add.dataset.add); return; }
    const btn = e.target.closest("[data-show]");
    if (!btn || !S.result) return;
    const i = +btn.dataset.show;
    if (!(i >= 0 && i < S.result.points.length)) return;
    setView("timing");  // the tempo map and the point live in Timing
    selectPoint(i, false);
    document.querySelector(".trace-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("copyOsuBtn").onclick = copyOsu;
  $("copyQuaBtn").onclick = () => copyOtherGame("quaver");
  $("copySmBtn").onclick = () => copyOtherGame("stepmania");
  $("csvBtn").onclick = () => saveAs("save_csv");
  $("clickBtn").onclick = () => saveAs("save_click");
  $("oszBtn").onclick = () => saveAs("save_osz");
  $("cmpPick").onclick = compareOsu;
  $("alignPick").onclick = alignOsu;
  $("denPick").onclick = densityOsu;
  $("snapPick").onclick = snapOsu;
  $("rsPick").onclick = resnapPick;
  $("rsApply").onclick = resnapApply;
  $("refPick").onclick = refPick;
  $("refFind").onclick = refFind;
  $("asFit").onclick = assistFit;
  $("rampFit").onclick = rampFit;
  $("svPreview").onclick = svPreview;
  $("svApply").onclick = svApply;
  $("svMap").onchange = () => { SV.preview = null; renderSv(); };
  $("rampUse").onclick = rampUse;
  $("labCompare").onclick = labCompare;
  $("labStart").onclick = labStart;
  $("labHear1").onclick = () => labHear(0);
  $("labHear2").onclick = () => labHear(1);
  $("labVote1").onclick = () => labVote(0);
  $("labVote2").onclick = () => labVote(1);
  $("labCancel").onclick = labCancel;
  $("rpPick").onclick = reportPick;
  $("rpCopy").onclick = copyReport;
  $("pbPlay").onclick = pbToggle;
  $("pbFromLine").onclick = () => {
    if (!S.result) return;
    const i = S.selected >= 0 ? S.selected : governing(S.result, pbPosition());
    pbPlay(S.result.points[i].offset_ms / 1000);
  };
  $("pbSeek").addEventListener("input", () => { if (S.result) pbSeek((+$("pbSeek").value / 1000) * S.result.duration, true); });
  $("pbClick").addEventListener("change", pbApplyLevels);
  $("pbPerc").addEventListener("change", () => {
    P.buffer = null;
    if (P.playing) pbPlay(pbPosition());
    else pbDraw();
  });
  $("pbLoop").addEventListener("change", () => { if (P.playing) pbPlay(pbPosition()); else pbDraw(); });
  document.querySelectorAll("#pbRate button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("#pbRate button").forEach((o) => o.classList.toggle("on", o === b));
    if (P.playing) pbPlay(pbPosition());
  });
  // pointerdown, not click: the tap is when the finger lands, not when it lifts.
  $("tapBtn").addEventListener("pointerdown", tapNow);
  $("tapCalibrate").onclick = tapCalibrate;
  $("tapAssist").onclick = tapAssist;
  $("tapClear").onclick = () => { TAP.taps = []; renderTaps(); };
  ["pbSongVol", "pbClickVol", "pbHsVol"].forEach((id) => {
    $(id).addEventListener("input", () => {
      P.levels = { song_volume: +$("pbSongVol").value / 100, click_volume: +$("pbClickVol").value / 100,
                   hitsound_volume: +$("pbHsVol").value / 100 };
      pbApplyLevels();
    });
    $(id).addEventListener("change", pbLevels);
  });
  $("pbHs").onchange = () => hsPick($("pbHs").value).then(() => { if (HSV.report) renderHitsoundsView(); });
  $("trace").addEventListener("dblclick", (e) => {
    if (!S.result || !geom) return;
    pbPlay(Math.max(0, geom.S(tlX(e))));
  });
  ["asFirst", "asSecond", "asBars", "asMeter"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); assistFit(); } });
  });
  $("msPick").onclick = pickMapset;
  $("msRecheck").onclick = () => { if (S.mapset) runMapset(S.mapset.path, false); };
  $("hsPreview").onclick = hsPreview;
  $("hsApply").onclick = hsApply;
  $("hsSource").onchange = () => { HS.preview = null; $("hsTargets").innerHTML = ""; renderCopier(); };
  $("hsTargets").onchange = () => { HS.preview = null; renderCopyResult(); };
  $("hsVolumes").onchange = () => { HS.preview = null; renderCopyResult(); };
  $("swPreview").onclick = swPreview;
  $("swApply").onclick = swApply;
  $("swNew").onchange = () => { SW.preview = null; renderSwapResult(); };
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("injectBtn").onclick = injectOsu;
  $("injectAllPreviewBtn").onclick = injectAllPreview;
  $("hsdPreviewBtn").onclick = () => hsdfPreview();
  $("hsdWriteBtn").onclick = () => hsdfWrite();
  ["hsdSource", "hsdFill"].forEach((id) => $(id).addEventListener("change", () => { HSDF.preview = null; hsdfRender(); }));
  $("injectAllBtn").onclick = injectAllApply;
  wireDrop();
  $("trace").addEventListener("mousemove", onTraceMove);
  $("trace").addEventListener("mouseleave", () => { $("tip").hidden = true; drawTrace(); });
  $("trace").addEventListener("click", (e) => {
    if (!S.result || !geom) return;
    // The click that ends a drag or a pan selects nothing.
    if (TL.suppressClick) { TL.suppressClick = false; return; }
    selectPoint(governing(S.result, geom.S(tlX(e))));
  });
  $("trace").addEventListener("mousedown", tlDown);
  window.addEventListener("mousemove", tlMove);
  window.addEventListener("mouseup", tlUp);
  $("trace").addEventListener("wheel", tlWheel, { passive: false });
  $("tlFit").onclick = tlFit;
  document.querySelectorAll("#pulseSwitch button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("#pulseSwitch button").forEach((o) => o.classList.toggle("on", o === b));
  });
  document.querySelectorAll("#presetSwitch button").forEach((b) => b.onclick = () => {
    const p = S.presets[b.dataset.preset]; if (!p) return;
    $("delta").value = p.delta; $("persistence").value = p.persistence; $("confidence").value = p.confidence;
    $("confidenceRange").value = p.confidence;
    readOptions(); markPreset();
    // A preset moves the minimum change and persistence too, which reading
    // the sections again at another confidence alone would not show.
    confLiveClear();
  });
  ["delta", "persistence", "confidence"].forEach((id) => $(id).addEventListener("input", () => { readOptions(); markPreset(); }));
  // The confidence, typed or slid, is tried on the analysis on screen.
  $("confidence").addEventListener("input", () => {
    $("confidenceRange").value = $("confidence").value;
    confLiveSchedule();
  });
  $("confidenceRange").addEventListener("input", () => {
    $("confidence").value = $("confidenceRange").value;
    readOptions(); markPreset();
    confLiveSchedule();
  });
  $("confLiveApply").onclick = confLiveApply;
  $("songOptBack").onclick = songOptionsBack;
  $("drawer").addEventListener("input", songOptionsTouched);
  $("drawer").addEventListener("change", songOptionsTouched);
  ["pulseSwitch", "presetSwitch"].forEach((id) => $(id).addEventListener("click", songOptionsTouched));
  document.querySelectorAll("#langSwitch button").forEach((b) => b.onclick = () => {
    S.lang = b.dataset.lang; translate(); if (api()) api().set_language(S.lang);
  });
  $("themeBtn").onclick = themeToggle;
  window.addEventListener("resize", () => { drawTrace(); drawBands(); drawSpec(); });
  // How the focused control got focus: Tab means the user is driving the
  // keyboard, a click means the button merely kept focus afterwards.
  document.addEventListener("mousedown", () => { focusByKey = false; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Tab") focusByKey = true; }, true);
  // The digits walk the rail in the order it shows.
  const viewKeys = {};
  [...document.querySelectorAll("#nav [data-view]")].map((b) => b.dataset.view)
    .filter((v, i, all) => all.indexOf(v) === i)
    .forEach((view, i) => { if (i < 10) viewKeys[String((i + 1) % 10)] = view; });
  $("keysClose").onclick = () => $("keysSheet").close();
  window.addEventListener("keydown", (e) => {
    // The sheet is modal: it takes no shortcut but its own (Esc closes it natively).
    if ($("keysSheet").open) {
      if (e.key === "?") { e.preventDefault(); $("keysSheet").close(); }
      return;
    }
    if (e.key === "Escape") { openDrawer(false); return; }
    // A field, a slider or a list keeps its own keys (an arrow moves a select).
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
    if (e.key === " " && S.result && !typing) {
      e.preventDefault();
      pbToggle();
      return;
    }
    if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
        && S.result && !typing) {
      e.preventDefault();
      tapNow(e);
      return;
    }
    // Typing an offset or a detection value must not trigger shortcuts:
    // Enter inside the point editor would otherwise start a full analysis.
    if (typing) return;
    // AltGr types [ and ] on a Spanish keyboard, and Windows reports it as
    // Ctrl+Alt: a key AltGr produced is a plain key, not a chord.
    const plain = (e.getModifierState && e.getModifierState("AltGraph"))
      || (!e.ctrlKey && !e.metaKey && !e.altKey);
    if (e.key === "?" && plain) { e.preventDefault(); openKeys(); return; }
    if (plain && !$("drawer").classList.contains("open")) {
      if (viewKeys[e.key] && !e.shiftKey) { e.preventDefault(); setView(viewKeys[e.key]); return; }
      if (S.result && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const step = (e.shiftKey ? 0.01 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        pbSeek(Math.min(Math.max(pbPosition() + step, 0), S.result.duration), true);
        return;
      }
      if (S.result && (e.key === "[" || e.key === "]")) { e.preventDefault(); jumpLine(e.key === "]" ? 1 : -1); return; }
      if (S.result && !e.repeat && (e.key === "l" || e.key === "L")) { e.preventDefault(); toggleCheck("pbLoop"); return; }
      if (S.result && !e.repeat && (e.key === "c" || e.key === "C")) { e.preventDefault(); toggleCheck("pbClick"); return; }
    }
    // Enter on a button reached with Tab (a nav item, an export) presses that
    // button; it must not be swallowed by the analyze shortcut below. A button
    // that only kept focus after a mouse click (Open audio) does not count,
    // so "open, then Enter to analyze" still works.
    if (e.key === "Enter" && focusByKey && e.target.closest && e.target.closest("button, a")) return;
    // The arrows walk the points table, so only where the table is.
    if (S.result && S.view === "timing" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = S.result.points.length, step = e.key === "ArrowDown" ? 1 : -1;
      selectPoint(Math.max(0, Math.min(n - 1, (S.selected < 0 ? (step > 0 ? -1 : n) : S.selected) + step)), false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); openAudio(); }
    // Inside a field the browser's own undo wins; everywhere else it is the map's.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
        || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")) { e.preventDefault(); redo(); return; }
    if ((e.key === "Enter" || e.key === "F5") && !$("drawer").classList.contains("open")) { e.preventDefault(); analyze(); }
  });
}

async function boot() {
  wire();
  const st = await api().state();
  S.lang = st.language; S.presets = st.presets;
  S.recent = st.recent || [];
  if (st.playback) {
    P.levels = { song_volume: st.playback.song_volume, click_volume: st.playback.click_volume,
                 hitsound_volume: st.playback.hitsound_volume ?? 0.7 };
    TAP.latency = st.playback.tap_latency_ms || 0;
  }
  renderTaps();
  stLoad();
  songsLoad();
  $("pbSongVol").value = String(Math.round(P.levels.song_volume * 100));
  $("pbClickVol").value = String(Math.round(P.levels.click_volume * 100));
  $("pbHsVol").value = String(Math.round(P.levels.hitsound_volume * 100));
  S.rustAvailable = !!st.rust_available;
  $("version").textContent = st.version;
  if (st.logo) $("logo").src = st.logo;
  applyOptions(st.options);
  setFile(st.file);
  translate();
  hsdProfilesLoad();
  // Offered only where built; a saved choice without a binary falls back.
  $("rustEngine").disabled = !S.rustAvailable;
  if (!S.rustAvailable) $("rustNote").textContent = t("t_rust_missing");
  setView(S.view);  // Library until an analysis finishes
  syncActions();
  syncLocks();
  if (st.autorun && S.file) analyze();
}

window.addEventListener("pywebviewready", boot);
