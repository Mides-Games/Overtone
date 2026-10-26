// Overtone web shell — talks to overtone_web.Api through window.pywebview.api.
// Python pushes analysis events back through window.overtone.on*.
"use strict";

const I18N = {
  en: {
    tagline: "Timing for osu! maps", splash_loading: "Starting up…", nav_timing: "Timing", offline: "offline, nothing leaves this PC",
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
    vd_fit: "fit {ms} ms", vd_steady: "steady {n}%",
    vd_line: "one red line", vd_lines: "{n} red lines",
    vd_loose: "Check this: the attacks sit {ms} ms from the grid on average, well past what live playing explains. The grid is probably on the wrong beat.",
    vd_quiet: "Nothing here looks wrong. The octave is what these numbers cannot check — a grid read at double tempo fits just as well — so if the beat feels half or double, use ×2 or ÷2.",
    vd_fell_back: "Check this: the precision engine found no grid it could stand on, and the fallback tracker answered instead.",
    vd_wobbles: "Check this: the local tempo wanders ({n}% steady). Either the band drifts and the drift lane will show it, or the grid is on the wrong beat.",
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
    stage_sections: "Sections", stage_beatthis: "Beat This! check", stage_fallback: "Beat tracker", stage_transients: "Transients",
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
    hsv_map: "Difficulty",
    hsv_no_rust: "Proposals run on the Rust engine (overtone-cli), and it is not built here: cargo build --release -p overtone-cli.",
    g_v_short_section: "{count} sections last less than a bar. Check them by ear.",
    g_v_octave_check: "{count} sections change tempo by an octave: half-time feel or octave mistakes? Your call.",
    g_v_dup_points: "{count} red lines are duplicates, a few ms from another.",
    g_v_impossible_change: "{count} tempo jumps are detection errors, not music.",
    g_v_negative_offset: "{count} points sit before the audio starts.",
    g_v_past_end: "{count} points sit past the end of the audio.",
    g_v_bad_number: "{count} points have no usable number: re-analyze or delete them.",
    warn_show: "Show them", warn_hide: "Hide", warn_beats: "{beats} beats",
    warn_more: "{n} more notes", warn_fewer: "Show fewer notes",
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
    st_file: "Settings file", st_file_export: "Save settings…", st_file_import: "Open settings…",
    st_file_hint: "Save these settings to a file and open it on another PC. A folder that does not exist there is left at its default.",
    st_file_saved: "Settings saved to {path}", st_file_read: "Settings opened: {n} kept",
    st_file_skipped: "Settings opened: {n} kept; not used here: {names}",
    bad_settings_file: "That is not an Overtone settings file.",
    st_diag: "Diagnostics", st_diag_copy: "Copy diagnostics", st_diag_copied: "Diagnostics copied",
    st_diag_hint: "The version, the build, the engines and your folders as plain text, for a bug report. It is copied to the clipboard only when you press the button; nothing is sent anywhere.",
    st_output: "Exports", st_folder: "Output folder", st_folder_default: "Use the default", st_folder_pick: "Choose folder…",
    st_folder_is_default: "{path} (the default)",
    st_ask: "Ask where to save each export (the dialog opens in the song's folder)",
    st_lead: "Write red lines as osu! maps are timed (28 ms before the sound)",
    st_lead_hint: "Ranked maps put their red lines a little before the sound, and osu! plays them in time. Used by copy, .osz and inject; the click track and CSV stay on the sound. Lines you placed by hand never move.",
    st_clean: "Write clean BPMs (whole, .5 or .1)",
    st_clean_hint: "232.189 is written as 232.2 when every beat stays within 2 ms of the exact grid; on a long section a red line at the same BPM re-syncs it every few bars. Used by copy, .osz and inject; the analysis, the click track and the CSV keep the exact BPM. Lines you placed by hand never change.",
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
    tmap_title: "Where the pulse is",
    tmap_note: "How well the hits agree on every rate from {lo} to {hi} BPM, over {n} windows of 12 s. Bright means that rate explains them. The red line is what the timing actually reports; the bright band can sit an octave above it, because a rate that explains the hits explains twice it too.",
    tmap_reading: "Sweeping every pulse rate…",
    tmap_none: "Too few attacks to sweep: a window needs eight.",
    eng_title: "Loudness and sections",
    eng_note: "Peak {peak} dB RMS, and {floor} dB under it at the foot. The {n} sections behind it are the ones the Structure view found.",
    eng_note_bare: "Peak {peak} dB RMS, and {floor} dB under it at the foot. No sections behind it: those come from the Rust engine, which is not built here.",
    eng_reading: "Reading how loud the song is…",
    eng_loudest: "loudest",
    bal_title: "Hits against notes",
    bal_note: "{pct} % of this song’s sound is hits rather than notes, weighted by how loud each moment is. Above the halfway line a moment is more hit than note.",
    bal_reading: "Separating hits from notes…",
    bal_all_hit: "all hit", bal_all_note: "all note",
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
    rp_src_reference: "Red lines", rp_src_suggestion: "Missing red lines", rp_src_snap: "Snapping", rp_src_alignment: "Away from the music",
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
    key_change: "Change this key", key_press: "Press a key… (Esc keeps it)", key_reset: "Default keys",
    bad_shortcut: "That key is taken by another action or cannot be moved.",
    key_palette: "Search every action", pal_title: "Commands", pal_placeholder: "Type an action or a section…",
    pal_empty: "Nothing matches.", pal_section: "Section", pal_action: "Action",
    note_add: "Add note at the playhead", note_placeholder: "A note for this moment of the song…", note_text: "Note", note_seek: "Play from here", note_delete: "Delete this note",
    bad_note: "Write the note first (up to 500 characters).", too_many_notes: "This song already has 500 notes.",
    note_unsaved: "The note is kept until you close Overtone, but could not be saved: {detail}",
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
    bad_index: "That song is not in the list any more.",
    done: "Done: {n} timing points · {bpm} BPM", rescaled: "Pulse ×{f}: {n} timing points · {bpm} BPM",
    error: "Error: {detail}",
  },
  es: {
    tagline: "Timing para mapas de osu!", splash_loading: "Abriendo…", nav_timing: "Timing", offline: "sin conexión, nada sale de esta PC",
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
    vd_fit: "ajuste {ms} ms", vd_steady: "constante {n}%",
    vd_line: "una línea roja", vd_lines: "{n} líneas rojas",
    vd_loose: "Revisá esto: los ataques caen a {ms} ms de la rejilla en promedio, mucho más de lo que explica tocar en vivo. Lo más probable es que la rejilla esté en el pulso equivocado.",
    vd_quiet: "Nada de esto se ve mal. La octava es lo que estos números no pueden comprobar — una rejilla leída al doble de tempo encaja igual de bien — así que si el pulso se siente a la mitad o al doble, usá ×2 o ÷2.",
    vd_fell_back: "Revisá esto: el motor de precisión no encontró una rejilla en la que apoyarse y respondió el tracker de respaldo.",
    vd_wobbles: "Revisá esto: el tempo local se mueve (constante {n}%). O la banda va a la deriva y el carril de deriva lo muestra, o la rejilla está en el pulso equivocado.",
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
    stage_sections: "Secciones", stage_beatthis: "Revisión con Beat This!", stage_fallback: "Rastreador de pulsos", stage_transients: "Transitorios",
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
    hsv_map: "Dificultad",
    hsv_no_rust: "Las propuestas usan el motor Rust (overtone-cli), y acá no está compilado: cargo build --release -p overtone-cli.",
    g_v_short_section: "{count} secciones duran menos de un compás. Revisalas de oído.",
    g_v_octave_check: "{count} secciones cambian el tempo una octava: ¿half-time o errores de octava? Lo decidís vos.",
    g_v_dup_points: "{count} líneas rojas son duplicados, a pocos ms de otra.",
    g_v_impossible_change: "{count} saltos de tempo son errores de detección, no música.",
    g_v_negative_offset: "{count} puntos están antes de que empiece el audio.",
    g_v_past_end: "{count} puntos están después del final del audio.",
    g_v_bad_number: "{count} puntos no tienen un número usable: re-analizá o borralos.",
    warn_show: "Verlas", warn_hide: "Ocultar", warn_beats: "{beats} beats",
    warn_more: "{n} avisos más", warn_fewer: "Mostrar menos avisos",
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
    st_file: "Archivo de ajustes", st_file_export: "Guardar ajustes…", st_file_import: "Abrir ajustes…",
    st_file_hint: "Guardá estos ajustes en un archivo y abrilo en otra PC. Una carpeta que allí no existe queda en su valor predeterminado.",
    st_file_saved: "Ajustes guardados en {path}", st_file_read: "Ajustes abiertos: {n} aplicados",
    st_file_skipped: "Ajustes abiertos: {n} aplicados; no se usan acá: {names}",
    bad_settings_file: "Eso no es un archivo de ajustes de Overtone.",
    st_diag: "Diagnóstico", st_diag_copy: "Copiar diagnóstico", st_diag_copied: "Diagnóstico copiado",
    st_diag_hint: "La versión, el build, los motores y tus carpetas como texto plano, para un reporte. Se copia al portapapeles solo cuando apretás el botón; no se envía nada a ningún lado.",
    st_output: "Exportaciones", st_folder: "Carpeta de salida", st_folder_default: "Usar la predeterminada", st_folder_pick: "Elegir carpeta…",
    st_folder_is_default: "{path} (la predeterminada)",
    st_ask: "Preguntar dónde guardar cada exportación (el diálogo abre en la carpeta de la canción)",
    st_lead: "Escribir las líneas rojas como se timean los mapas de osu! (28 ms antes del sonido)",
    st_lead_hint: "Los mapas rankeados ponen sus líneas rojas un poco antes del sonido, y osu! las reproduce a tiempo. Se usa al copiar, en el .osz y al inyectar; el click y el CSV quedan sobre el sonido. Las líneas que pusiste a mano nunca se mueven.",
    st_clean: "Escribir BPMs limpios (enteros, .5 o .1)",
    st_clean_hint: "232.189 se escribe como 232.2 si cada beat queda a menos de 2 ms de la grilla exacta; en una sección larga, una línea roja con el mismo BPM la vuelve a sincronizar cada pocos compases. Se usa al copiar, en el .osz y al inyectar; el análisis, el click y el CSV guardan el BPM exacto. Las líneas que pusiste a mano no cambian.",
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
    tmap_title: "Dónde está el pulso",
    tmap_note: "Qué tan de acuerdo están los golpes con cada ritmo de {lo} a {hi} BPM, sobre {n} ventanas de 12 s. Brillante significa que ese ritmo los explica. La línea roja es lo que el timing reporta de verdad; la banda brillante puede quedar una octava por encima, porque un ritmo que explica los golpes también explica su doble.",
    tmap_reading: "Barriendo cada ritmo de pulso…",
    tmap_none: "Muy pocos ataques para barrer: una ventana necesita ocho.",
    eng_title: "Volumen y secciones",
    eng_note: "Pico {peak} dB RMS, y {floor} dB por debajo en el suelo. Las {n} secciones de atrás son las que encontró la vista Estructura.",
    eng_note_bare: "Pico {peak} dB RMS, y {floor} dB por debajo en el suelo. Sin secciones detrás: vienen del motor Rust, que acá no está compilado.",
    eng_reading: "Leyendo qué tan fuerte suena la canción…",
    eng_loudest: "más fuerte",
    bal_title: "Golpes frente a notas",
    bal_note: "El {pct} % del sonido de esta canción son golpes y no notas, ponderado por lo fuerte que suena cada momento. Por encima de la línea media, un momento es más golpe que nota.",
    bal_reading: "Separando golpes de notas…",
    bal_all_hit: "todo golpe", bal_all_note: "todo nota",
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
    rp_src_reference: "Líneas rojas", rp_src_suggestion: "Líneas rojas faltantes", rp_src_snap: "Snap", rp_src_alignment: "Lejos de la música",
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
    key_change: "Cambiar esta tecla", key_press: "Apretá una tecla… (Esc la deja)", key_reset: "Teclas predeterminadas",
    bad_shortcut: "Esa tecla ya la usa otra acción o no se puede mover.",
    key_palette: "Buscar cualquier acción", pal_title: "Comandos", pal_placeholder: "Escribí una acción o una sección…",
    pal_empty: "No hay coincidencias.", pal_section: "Sección", pal_action: "Acción",
    note_add: "Agregar nota en el cabezal", note_placeholder: "Una nota para este momento de la canción…", note_text: "Nota", note_seek: "Reproducir desde acá", note_delete: "Borrar esta nota",
    bad_note: "Escribí primero la nota (hasta 500 caracteres).", too_many_notes: "Esta canción ya tiene 500 notas.",
    note_unsaved: "La nota queda hasta que cierres Overtone, pero no se pudo guardar: {detail}",
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
    bad_index: "Esa canción ya no está en la lista.",
    done: "Listo: {n} timing points · {bpm} BPM", rescaled: "Pulso ×{f}: {n} timing points · {bpm} BPM",
    error: "Error: {detail}",
  },
};

const S = { lang: "en", view: "library", mapset: null, file: null, options: null, presets: {}, result: null, timings: null, busy: false, selected: -1, locks: [], compare: null, comparePath: null, align: null, density: null, snap: null, ref: null, refFind: null, assist: null, report: null, recent: [] };
const $ = (id) => document.getElementById(id);
const api = () => (window.pywebview && window.pywebview.api) || null;

// A BPM as the results show it: to the tenth, whole when the tenth is .0
// (240.175 -> 240.2, 222.96 -> 223). For reading only: exports, edits and the
// diagnostic tables keep the exact value, which a title shows on hover. Red
// lines rounded to the tenth in the export lost Corpus B points (timeline,
// 2026-10-25), so the rounding stays on the screen.
function bpmShown(bpm) {
  const v = Math.round(bpm * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

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
  renderStructure();
  renderNeedSong();
  renderMapset();
  if (typeof renderSwapResult === "function" && S.mapset) renderSwap();
  if (S.result) renderResult(S.result);
  if (S.busy) $("analyzeText").textContent = t("analyzing");
}

// ------------------------------------------------------------------ views
// One analysed song is shared by every view: switching only changes what is
// visible, never the session. Views that read the analysis show the
// "analyze first" panel until there is one, instead of blank space.
const VIEWS = ["library", "timing", "structure", "mapcheck", "mapset", "audio", "report", "export", "history", "settings"];
const VIEW_LABEL = { library: "nav_library", timing: "nav_timing", structure: "nav_structure", mapcheck: "nav_mapcheck", mapset: "nav_mapset", audio: "nav_audio", report: "nav_report", export: "nav_export", history: "nav_history", settings: "nav_settings" };

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
    drawTrace(); waveLoad(); svMaps(); divsLoad(); swingLoad(); phLoad(); notesLoad();
  }
  if (view === "structure" && S.result) { stxLoad(); stxBmMaps(); stxKiaiMaps(); stxBreaksMaps(); stxVolMaps(); }
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
  toast(t("rescaled", { f: reply.result.subdivision, n: reply.result.points.length, bpm: bpmShown(reply.result.global_bpm) }));
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
    toast(t("done", { n: result.points.length, bpm: bpmShown(result.global_bpm) }));
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
  if (!sameSong) { S.ref = null; S.refFind = null; S.assist = null; S.report = null; RA.report = null; labCancel(); pbReset(); WARN.open.clear(); WARN.all = false; }
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

// The verdict strip. What it may say is decided by Corpus B, 20 ranked maps
// whose red lines a person placed (bench/corpus_b.py, measured 2026-09-28):
//
//   * Of the 9 readings a mapper would reject, the engine's own numbers can
//     flag 5: it fell back or refused (4 of them), or the local tempo curve is
//     unstable, stability under 0.9 (the fifth, and one good reading with it).
//   * Of the 14 it cannot fault, 4 were still wrong -- every one by an octave,
//     with residuals of 11-17 ms and stability 0.90-0.98. A grid read at twice
//     the tempo fits beautifully, which is exactly why those numbers cannot
//     see it, and the octave margin does not separate them either (the three
//     worst margins on the corpus are good readings).
//
// So the quiet state says nothing looks wrong, never that it is right, and
// names the octave as the thing to check by ear, because that is the one
// mistake these numbers are blind to and the user can settle it in a second.
const VERDICT_STABILITY = 0.9;
// The same number the loose-fit banner uses, and for the same reason: on the
// corpus a residual over 30 ms fires on one of the 15 ranked tracks the
// precision engine answers, and that one is the reading a mapper would reject.
const VERDICT_RESIDUAL_MS = 30.0;

function verdict(r) {
  if (!r) return null;
  const precise = r.engine === "precision";
  const facts = [
    t(precise ? "engine_precision" : "engine_legacy"),
    precise ? t("vd_fit", { ms: r.residual_ms.toFixed(1) }) : null,
    t("vd_steady", { n: Math.round(r.stability * 100) }),
    r.points.length === 1 ? t("vd_line") : t("vd_lines", { n: r.points.length }),
  ].filter(Boolean).join(" · ");
  if (!precise) return { doubt: true, facts, says: t("vd_fell_back") };
  if (r.stability < VERDICT_STABILITY) {
    return { doubt: true, facts,
             says: t("vd_wobbles", { n: Math.round(r.stability * 100) }) };
  }
  if (r.residual_ms > VERDICT_RESIDUAL_MS) {
    return { doubt: true, facts, says: t("vd_loose", { ms: r.residual_ms.toFixed(1) }) };
  }
  return { doubt: false, facts, says: t("vd_quiet") };
}

function renderVerdict(r) {
  const said = verdict(r);
  const box = $("verdict");
  box.hidden = !said;
  if (!said) return;
  box.classList.toggle("doubt", said.doubt);
  $("verdictFacts").textContent = said.facts;
  $("verdictSays").textContent = said.says;
}

function renderResult(r) {
  const precise = r.engine === "precision", stable = r.stability >= 0.75;
  $("statGlobal").textContent = bpmShown(r.global_bpm);
  $("statGlobal").title = `${r.global_bpm.toFixed(3)} BPM`;
  $("statPoints").innerHTML = `${r.points.length}<small>${r.meter}</small>`;
  $("statBeats").innerHTML = `${r.beat_count}<small>${mmss(r.duration)}</small>`;
  $("statStability").innerHTML = `${Math.round(r.stability * 100)}<small>% ${t(stable ? "constant" : "variable")}</small>`;
  $("statEngine").innerHTML = `<span class="pill ${precise ? "accent" : "amber"}">${t(precise ? "engine_precision" : "engine_legacy")}</span>`
    + (precise ? `<span class="pill">${r.residual_ms.toFixed(2)} ms</span>` : "");
  renderSong();

  renderVerdict(r);
  renderWarnings(r.warnings);

  $("tableCount").textContent = t("points_n", { n: r.points.length });
  $("rows").innerHTML = r.points.map((p, i) => {
    const c = p.confidence, cls = c >= 0.9 ? "" : c >= 0.75 ? "mid" : "low";
    const locked = (S.locks || []).includes(p.offset_ms);
    return `<tr data-i="${i}" class="${i === S.selected ? "sel" : ""}${locked ? " locked" : ""}">
      <td><span class="idx">${i + 1}</span></td>
      <td class="num">${p.offset_ms.toFixed(1)}</td>
      <td class="num" title="${p.bpm.toFixed(3)} BPM">${bpmShown(p.bpm)}</td>
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
      <div class="detail-big" title="${r.global_bpm.toFixed(3)} BPM">${bpmShown(r.global_bpm)}<small>BPM</small></div>
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
    <div class="detail-big" title="${p.bpm.toFixed(3)} BPM">${bpmShown(p.bpm)}<small>BPM</small></div>
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

// ------------------------------------------------------------------ dates
function when(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !isNaN(date) ? date.toLocaleString(S.lang, { dateStyle: "medium", timeStyle: "short" }) : "—";
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
  await tmapLoad();
  await engLoad();
  await balLoad();
  await bandsLoad();
}

// ------------------------------------------------------------------ tempo map
// R(t, f) as a surface: how well the attacks agree on every pulse rate, all
// through the song. Bright where a rate explains the hits. The rows are even
// in log2 period, so an octave is the same height anywhere on it.
const TMAP = { data: null, image: null, for: "", loading: false };

async function tmapLoad() {
  if (!api() || !S.result) return;
  if (TMAP.for === S.result.path || TMAP.loading) { drawTmap(); return; }
  TMAP.loading = true;
  $("tmapNote").textContent = t("tmap_reading");
  try {
    const reply = await api().tempo_map();
    if (!reply.ok) {
      $("tmapNote").textContent = reply.key === "busy" ? t("audio_busy") : "";
      if (reply.key !== "busy") editFailure(reply);
      return;
    }
    TMAP.data = reply;
    TMAP.image = reply.columns ? tmapPaint(reply) : null;
    TMAP.for = S.result.path;
  } finally {
    TMAP.loading = false;
  }
  drawTmap();
}

function tmapPaint(data) {
  const bytes = atob(data.cells);
  const off = document.createElement("canvas");
  off.width = data.columns; off.height = data.rows;
  const ctx = off.getContext("2d");
  const image = ctx.createImageData(data.columns, data.rows);
  const low = rgbOf(C.plot), high = rgbOf(C.tempo);
  for (let row = 0; row < data.rows; row++) {
    // row 0 is the longest period: slow at the foot, fast at the top
    const y = data.rows - 1 - row;
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

function drawTmap() {
  const wrap = $("tmapWrap"), canvas = $("tmapCanvas"), data = TMAP.data;
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
  if (!data || !TMAP.image) {
    if (data) $("tmapNote").textContent = t("tmap_none");
    return;
  }
  $("tmapNote").textContent = t("tmap_note", {
    lo: Math.round(data.bpm_lo), hi: Math.round(data.bpm_hi), n: data.columns,
  });
  const padL = 74, padR = 14, padT = 8, padB = 22;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const first = data.centres[0], last = data.centres[data.centres.length - 1];
  const span = Math.max(last - first, 1e-6);
  const T = (s) => x0 + ((s - first) / span) * (x1 - x0);
  // even in log2 period, which is even in log2 BPM the other way up
  const lo = Math.log2(data.bpm_lo), hi = Math.log2(data.bpm_hi);
  const B = (bpm) => y1 - ((Math.log2(bpm) - lo) / Math.max(hi - lo, 1e-12)) * (y1 - y0);
  ctx.save();
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 6); ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(TMAP.image, x0, y0, x1 - x0, y1 - y0);
  // What the engine actually reports, over what the sweep sees. The ridge
  // can sit an octave above it: R peaks at the pulse and at its multiples.
  ctx.strokeStyle = C.red; ctx.lineWidth = 2; ctx.lineJoin = "round";
  ctx.beginPath();
  data.points.forEach(([at, bpm], i) => {
    const y = B(Math.min(Math.max(bpm, data.bpm_lo), data.bpm_hi));
    const next = data.points[i + 1];
    if (i === 0) ctx.moveTo(x0, y); else ctx.lineTo(T(at), y);
    ctx.lineTo(next ? T(next[0]) : x1, y);
  });
  if (data.points.length) ctx.stroke();
  ctx.restore();
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const bpm of [60, 90, 120, 180, 240, 360, 600]) {
    if (bpm < data.bpm_lo || bpm > data.bpm_hi) continue;
    ctx.fillText(String(bpm), x0 - 10, B(bpm));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = niceStep(span, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = Math.ceil(first / step) * step; s <= last + 1e-6; s += step) {
    ctx.fillText(mmss(s), T(s), y1 + 5);
  }
}

// ------------------------------------------------------------------ loudness
// How loud the song is over time, with the structure's own sections behind
// it where there are any. The sections come from the Rust sidecar, so the
// curve has to stand on its own without them, and say so.
const ENG = { data: null, for: "", loading: false };

async function engLoad() {
  if (!api() || !S.result) return;
  if (ENG.for === S.result.path || ENG.loading) { drawEng(); return; }
  ENG.loading = true;
  $("engNote").textContent = t("eng_reading");
  try {
    const reply = await api().audio_energy();
    if (!reply.ok) {
      $("engNote").textContent = reply.key === "busy" ? t("audio_busy") : "";
      if (reply.key !== "busy") editFailure(reply);
      return;
    }
    ENG.data = reply;
    ENG.for = S.result.path;
  } finally {
    ENG.loading = false;
  }
  // Best effort: without the sidecar there are no phrases, and the curve is
  // still worth drawing, so a refusal here is not the lane's failure.
  if (!STX.view || STX.file !== S.result.path) {
    try {
      const phrases = await api().structure();
      if (phrases.ok) { STX.view = phrases.view; STX.file = phrases.file; }
    } catch (err) { /* the curve stands without them */ }
  }
  drawEng();
}

function drawEng() {
  const wrap = $("engWrap"), canvas = $("engCanvas"), data = ENG.data;
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
  if (!data || !data.curve.length) return;
  const sections = (STX.view && STX.view.sections) || [];
  $("engNote").textContent = sections.length
    ? t("eng_note", { peak: data.peak_db.toFixed(1), floor: data.floor_db, n: sections.length })
    : t("eng_note_bare", { peak: data.peak_db.toFixed(1), floor: data.floor_db });
  const padL = 74, padR = 14, padT = 8, padB = 22;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  ctx.fillStyle = C.plot;
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 6); ctx.fill();
  const span = Math.max(data.span_s, 1e-3);
  const T = (s) => x0 + (Math.min(Math.max(s, 0), span) / span) * (x1 - x0);
  ctx.save();
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 6); ctx.clip();
  // the sections behind the curve, alternating as the tempo map shades its own
  sections.forEach((s, i) => {
    const a = T(s.start_s), b = T(s.end_s);
    if (b <= a) return;
    if (i % 2 === 1) { ctx.fillStyle = C.section; ctx.fillRect(a, y0, b - a, y1 - y0); }
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(a) + 0.5, y0);
    ctx.lineTo(Math.round(a) + 0.5, y1); ctx.stroke();
  });
  const X = (i) => x0 + (i / Math.max(data.curve.length - 1, 1)) * (x1 - x0);
  const Y = (v) => y1 - v * (y1 - y0);
  ctx.beginPath();
  data.curve.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineWidth = 2; ctx.strokeStyle = C.tempo; ctx.lineJoin = "round"; ctx.stroke();
  ctx.lineTo(X(data.curve.length - 1), y1); ctx.lineTo(X(0), y1); ctx.closePath();
  ctx.fillStyle = C.fill; ctx.fill();
  // each section named where it starts, while there is room for the word
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  ctx.fillStyle = C.gridText; ctx.textAlign = "left"; ctx.textBaseline = "top";
  sections.forEach((s) => {
    const label = t(`stx_${s.kind}`) || s.kind;
    if (T(s.end_s) - T(s.start_s) > ctx.measureText(label).width + 10) {
      ctx.fillText(label, T(s.start_s) + 4, y0 + 3);
    }
  });
  ctx.restore();
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText(t("eng_loudest"), x0 - 10, Y(1) + 6);
  ctx.fillText(`${data.floor_db}`, x0 - 10, Y(0) - 6);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = niceStep(span, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = 0; s <= span + 1e-6; s += step) ctx.fillText(mmss(s), T(s), y1 + 5);
}

// ------------------------------------------------------------------ hits vs notes
// The percussive share of each moment, 0 at the foot (all note) to 1 at the
// top (all hit). One curve, so it says its own number too: a lane read
// without a figure beside it invites the eye to guess.
const BAL = { data: null, for: "", loading: false };

async function balLoad() {
  if (!api() || !S.result) return;
  if (BAL.for === S.result.path || BAL.loading) { drawBal(); return; }
  BAL.loading = true;
  $("balNote").textContent = t("bal_reading");
  try {
    const reply = await api().audio_balance();
    if (!reply.ok) {
      $("balNote").textContent = reply.key === "busy" ? t("audio_busy") : "";
      if (reply.key !== "busy") editFailure(reply);
      return;
    }
    BAL.data = reply;
    BAL.for = S.result.path;
  } finally {
    BAL.loading = false;
  }
  drawBal();
}

function drawBal() {
  const wrap = $("balWrap"), canvas = $("balCanvas"), data = BAL.data;
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
  if (!data || !data.lane.length) return;
  $("balNote").textContent = t("bal_note", { pct: Math.round(data.whole * 100) });
  const padL = 74, padR = 14, padT = 8, padB = 22;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  ctx.fillStyle = C.plot;
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 6); ctx.fill();
  const X = (i) => x0 + (i / Math.max(data.lane.length - 1, 1)) * (x1 - x0);
  const Y = (v) => y1 - v * (y1 - y0);
  // halfway is the line a mapper reads against: more hit than note above it
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, Math.round(Y(0.5)) + 0.5);
  ctx.lineTo(x1, Math.round(Y(0.5)) + 0.5); ctx.stroke();
  // Drawn only where the song was heard: a silent column's share is 0, and
  // 0 on this lane reads as "all notes", which is a claim about silence.
  const HEARD = 0.002;
  ctx.lineWidth = 2; ctx.strokeStyle = C.tempo; ctx.lineJoin = "round";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      ctx.beginPath();
      run.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.lineTo(run[run.length - 1][0], y1); ctx.lineTo(run[0][0], y1); ctx.closePath();
      ctx.fillStyle = C.fill; ctx.fill();
    }
    run = [];
  };
  data.lane.forEach((v, i) => {
    if ((data.heard[i] ?? 1) < HEARD) flush();
    else run.push([X(i), Y(v)]);
  });
  flush();
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText(t("bal_all_hit"), x0 - 10, Y(1) + 6);
  ctx.fillText(t("bal_all_note"), x0 - 10, Y(0) - 6);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = niceStep(data.span_s, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = 0; s <= data.span_s + 1e-6; s += step) {
    ctx.fillText(mmss(s), x0 + (s / data.span_s) * (x1 - x0), y1 + 5);
  }
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
  levels: { song_volume: 0.8, click_volume: 0.6 },
};
const PB_LOOKAHEAD = 0.15, PB_TICK_MS = 25, PB_LEAD = 0.06;

function pbContext() {
  if (!P.ctx) {
    P.ctx = new (window.AudioContext || window.webkitAudioContext)();
    P.song = P.ctx.createGain(); P.song.connect(P.ctx.destination);
    P.click = P.ctx.createGain(); P.click.connect(P.ctx.destination);
    pbApplyLevels();
  }
  return P.ctx;
}

function pbApplyLevels() {
  if (!P.ctx) return;
  P.song.gain.value = P.levels.song_volume;
  P.click.gain.value = $("pbClick").checked ? P.levels.click_volume : 0;
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
    P.sched += len > 1e-9 ? len : 1e-6;
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

async function pbPlay(from) {
  if (!api() || !S.result) return;
  if (!(await pbLoad())) return;
  const ctx = pbContext();
  if (ctx.state === "suspended") await ctx.resume();
  pbStop();
  try { if (SCRUB.source) SCRUB.source.stop(); } catch (err) { /* already ended */ }
  let pos = Math.min(Math.max(0, from ?? P.pos), P.buffer.duration - 0.01);
  P.loop = $("pbLoop").checked ? pbLoopFor(pos) : null;
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
  P.levels = { song_volume: +$("pbSongVol").value / 100, click_volume: +$("pbClickVol").value / 100 };
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
const RP_SOURCES = ["reference", "suggestion", "snap", "alignment"];

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
    if (TMAP.data && TMAP.image) TMAP.image = tmapPaint(TMAP.data);
    if (S.result) { drawTrace(); drawBands(); drawSpec(); drawBal(); drawEng(); drawTmap(); }
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
  $("stLead").checked = s.map_lead;
  $("stClean").checked = s.clean_bpm;
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
  $("stFileExport").onclick = async () => {
    if (!api()) return;
    const reply = await api().export_settings();
    if (reply.ok) toast(t("st_file_saved", { path: reply.path }));
    else if (reply.key !== "cancelled") toast(t(reply.key, { detail: reply.detail || "" }), true);
  };
  $("stFileImport").onclick = async () => {
    if (!api()) return;
    const reply = await api().import_settings();
    if (!reply.ok) {
      if (reply.key !== "cancelled") toast(t(reply.key, { detail: reply.detail || "" }), true);
      return;
    }
    stTake(reply);
    toast(reply.skipped.length
      ? t("st_file_skipped", { n: reply.imported.length, names: reply.skipped.join(", ") })
      : t("st_file_read", { n: reply.imported.length }));
  };
  $("stDiagCopy").onclick = async () => {
    if (!api()) return;
    const reply = await api().diagnostics();
    if (!reply.ok) return;
    $("stDiag").textContent = reply.text;
    $("stDiag").hidden = false;
    copyText(reply.text, "st_diag_copied");
  };
  $("stAsk").onchange = () => stSet({ export_ask: $("stAsk").checked });
  $("stLead").onchange = () => stSet({ map_lead: $("stLead").checked });
  $("stClean").onchange = () => stSet({ clean_bpm: $("stClean").checked });
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
  S.mapset = { path: folder, name: reply.folder, report: reply.report };
  renderMapset();
  renderSwap();
  renderAudioCheck();
}

function msValue(value) {
  if (value === null || value === undefined) return `<span class="card-sub">${t("ms_not_set")}</span>`;
  if (value === "") return `<span class="card-sub">${t("ms_empty_value")}</span>`;
  return esc(value);
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
const LANES = { wave: 58, swing: 34, drift: 46, gap: 10 };
const TL_MIN_SPAN = 0.5;          // seconds: the closest zoom
const TL_SNAP_PX = 6;             // a dragged red line snaps to an attack this close
const DRIFT_MS = 30;              // the drift lane's half height
const SWING_LATE_MAX = 0.84;      // the swing lane's top: the engine's own bound
const VIEW = { a: 0, b: 0, for: null };
const WAVE = { for: null, bin: 256, rate: 0, min: null, max: null };
const NOTES = { list: [], for: null };
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
  // The lanes stack up from the drift lane's foot, and the swing lane takes
  // no room unless the song swings.
  const swung = !!(SWING.report && SWING.report.spans.length);
  let foot = H - PAD.b;
  const yD1 = foot, yD0 = yD1 - LANES.drift;
  foot = yD0;
  let yS0 = foot, yS1 = foot;
  if (swung) { yS1 = foot - LANES.gap; yS0 = yS1 - LANES.swing; foot = yS0; }
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

  // notes: a flag over the waveform where each one is pinned
  if (NOTES.for === r.path && NOTES.list.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    for (const n of NOTES.list) {
      if (n.time_s < v.a || n.time_s > v.b) continue;
      const x = Math.round(X(n.time_s)) + 0.5;
      ctx.fillRect(x - 0.5, yW0, 1, yW1 - yW0);
      ctx.beginPath(); ctx.moveTo(x, yW0); ctx.lineTo(x + 7, yW0 + 4); ctx.lineTo(x, yW0 + 8); ctx.fill();
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
      : bpmShown(p.bpm) + (meterChange ? ` · ${p.meter}/4` : "");
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
// The keys the sheet lets the user move (overtone_web.SHORTCUT_DEFAULTS);
// a row's third element names the action behind each of its keys.
const KEY_DEFAULTS = { play: " ", tap: "t", loop: "l", click: "c", line_prev: "[", line_next: "]", sheet: "?" };
const KEY_MODIFIERS = ["Shift", "Control", "Alt", "Meta", "AltGraph"];
const KEYCAP = { action: null };

function keyFor(action) {
  const saved = ST.settings && ST.settings.shortcuts;
  return (saved && saved[action]) || KEY_DEFAULTS[action];
}

function pressed(e, action) {
  return e.key.toLowerCase() === keyFor(action);
}

function keyName(key) {
  return key === " " ? t("kb_space") : key.length === 1 ? key.toUpperCase() : key;
}

const KEYS = [
  [[["kb_space"]], "key_play", ["play"]],
  [[["←"], ["→"]], "key_seek"],
  [[["kb_shift", "←"], ["kb_shift", "→"]], "key_seek_fine"],
  [[["["], ["]"]], "key_lines", ["line_prev", "line_next"]],
  [[["↑"], ["↓"]], "key_points"],
  [[["L"]], "key_loop", ["loop"]],
  [[["C"]], "key_click", ["click"]],
  [[["T"]], "key_tap", ["tap"]],
  [[["1–9"], ["0"]], "key_views"],
  [[["Ctrl", "O"]], "key_open"],
  [[["kb_enter"], ["F5"]], "key_analyze"],
  [[["Ctrl", "Z"]], "key_undo"],
  [[["Ctrl", "Y"], ["Ctrl", "kb_shift", "Z"]], "key_redo"],
  [[["Ctrl", "K"]], "key_palette"],
  [[["?"]], "key_sheet", ["sheet"]],
  [[["Esc"]], "key_close"],
];

// A movable key is a button: pressed, it waits for the next key and keeps
// it. The bridge refuses a key another action holds or a fixed one.
function renderKeys() {
  const kbd = (k) => `<kbd>${esc(k.startsWith("kb_") ? t(k) : k)}</kbd>`;
  const movable = (action) => KEYCAP.action === action
    ? `<button class="keycap waiting" data-action="${action}">${esc(t("key_press"))}</button>`
    : `<button class="keycap" data-action="${action}" title="${esc(t("key_change"))}"><kbd>${esc(keyName(keyFor(action)))}</kbd></button>`;
  $("keysList").innerHTML = KEYS.map(([alts, what, actions]) =>
    `<dt>${actions ? actions.map(movable).join(" / ")
                   : alts.map((chord) => chord.map(kbd).join(" + ")).join(" / ")}</dt><dd>${esc(t(what))}</dd>`).join("");
  $("keysReset").hidden = !Object.keys(KEY_DEFAULTS).some((a) => keyFor(a) !== KEY_DEFAULTS[a]);
}

async function keyTake(e) {
  e.preventDefault();
  e.stopPropagation();
  if (KEY_MODIFIERS.includes(e.key)) return;   // a modifier alone is not a key yet
  const action = KEYCAP.action;
  KEYCAP.action = null;
  if (e.key !== "Escape" && api()) {
    const shortcuts = Object.fromEntries(Object.keys(KEY_DEFAULTS).map((a) => [a, keyFor(a)]));
    shortcuts[action] = e.key.toLowerCase();
    const reply = await api().set_settings({ shortcuts });
    if (reply.ok) stTake(reply); else toast(t(reply.key), true);
  }
  renderKeys();
}

function openKeys() {
  const sheet = $("keysSheet");
  if (sheet.open) { sheet.close(); return; }
  renderKeys();
  sheet.showModal();
}

// Ctrl+K: the palette. Built when opened, from what the window has right
// then: every section, the global actions, and every enabled button the
// current section shows -- so a new button is in it without a list to keep.
const PAL = { items: [], shown: [], at: 0 };

function palFold(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function palItems() {
  const items = [];
  document.querySelectorAll("#nav [data-view]").forEach((b) => {
    if (items.some((it) => it.view === b.dataset.view)) return;
    items.push({ label: t(VIEW_LABEL[b.dataset.view] || b.dataset.view), where: t("pal_section"),
                 view: b.dataset.view, run: () => setView(b.dataset.view) });
  });
  [["key_open", () => openAudio()], ["key_analyze", () => analyze()], ["key_undo", () => undo()],
   ["key_redo", () => redo()], ["key_sheet", () => openKeys()]]
    .forEach(([key, run]) => items.push({ label: t(key), where: t("pal_action"), run }));
  const here = t(VIEW_LABEL[S.view] || S.view);
  document.querySelectorAll(".content > [data-view]:not([hidden]) button").forEach((b) => {
    const label = (b.textContent || "").replace(/\s+/g, " ").trim();
    if (!label || b.disabled || b.offsetParent === null) return;
    items.push({ label, where: here, run: () => b.click() });
  });
  return items;
}

function palRender() {
  const words = palFold($("paletteInput").value).split(/\s+/).filter(Boolean);
  PAL.shown = PAL.items.filter((it) => {
    const text = palFold(`${it.label} ${it.where}`);
    return words.every((w) => text.includes(w));
  }).slice(0, 60);
  PAL.at = Math.min(PAL.at, Math.max(0, PAL.shown.length - 1));
  $("paletteList").innerHTML = PAL.shown.map((it, i) =>
    `<li role="option" data-i="${i}" aria-selected="${i === PAL.at}"><span>${esc(it.label)}</span>`
    + `<span class="where">${esc(it.where)}</span></li>`).join("");
  $("paletteEmpty").hidden = PAL.shown.length > 0;
  const on = $("paletteList").children[PAL.at];
  if (on) on.scrollIntoView({ block: "nearest" });
}

function palRun(i) {
  const it = PAL.shown[i];
  $("palette").close();
  if (it) it.run();
}

function openPalette() {
  const sheet = $("palette");
  if (sheet.open) { sheet.close(); return; }
  PAL.items = palItems();
  PAL.at = 0;
  $("paletteInput").value = "";
  $("paletteInput").placeholder = t("pal_placeholder");
  palRender();
  sheet.showModal();
  $("paletteInput").focus();
}

function palWire() {
  $("paletteInput").oninput = () => { PAL.at = 0; palRender(); };
  $("paletteInput").onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = PAL.shown.length;
      if (n) PAL.at = (PAL.at + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      palRender();
    } else if (e.key === "Enter") {
      e.preventDefault();
      palRun(PAL.at);
    }
  };
  $("paletteList").onclick = (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) palRun(+li.dataset.i);
  };
  // A click on the backdrop lands on the dialog itself: it closes, like Esc.
  $("palette").onclick = (e) => { if (e.target === $("palette")) $("palette").close(); };
}

// Notes: free text pinned to a time of the song, kept beside its project.
async function notesLoad() {
  if (!api() || !S.result) return;
  const path = S.result.path;
  const reply = await api().notes();
  if (!S.result || S.result.path !== path) return;
  notesTake(reply, path);
}

function notesTake(reply, path) {
  if (!reply.ok) { toast(t(reply.key), true); return; }
  NOTES.list = reply.notes;
  NOTES.for = path || (S.result && S.result.path);
  if (reply.error) toast(t("note_unsaved", { detail: reply.error }), true);
  notesRender();
  drawTrace();
}

function notesRender() {
  $("noteText").placeholder = t("note_placeholder");
  const shown = S.result && NOTES.for === S.result.path ? NOTES.list : [];
  $("notesList").innerHTML = shown.map((n) =>
    `<li data-id="${n.id}"><button class="btn small num" data-seek="${n.time_s}" title="${esc(t("note_seek"))}">${esc(fmtTime(n.time_s))}</button>`
    + `<input class="input" maxlength="500" value="${esc(n.text)}" aria-label="${esc(t("note_text"))}">`
    + `<button class="btn small" data-del="${n.id}" title="${esc(t("note_delete"))}">×</button></li>`).join("");
}

async function noteAdd() {
  const text = $("noteText").value.trim();
  if (!text || !S.result) return;
  const reply = await api().note_add(pbPosition(), text);
  if (reply.ok) $("noteText").value = "";
  notesTake(reply);
}

function notesWire() {
  $("noteAdd").onclick = noteAdd;
  $("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); noteAdd(); } });
  $("notesList").onclick = async (e) => {
    const seek = e.target.closest("[data-seek]"), del = e.target.closest("[data-del]");
    if (seek) pbSeek(+seek.dataset.seek, true);
    if (del) notesTake(await api().note_delete(+del.dataset.del));
  };
  $("notesList").onchange = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li || e.target.tagName !== "INPUT") return;
    const text = e.target.value.trim();
    notesTake(await (text ? api().note_edit(+li.dataset.id, text) : api().note_delete(+li.dataset.id)));
  };
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
  ["pbSongVol", "pbClickVol"].forEach((id) => {
    $(id).addEventListener("input", () => {
      P.levels = { song_volume: +$("pbSongVol").value / 100, click_volume: +$("pbClickVol").value / 100 };
      pbApplyLevels();
    });
    $(id).addEventListener("change", pbLevels);
  });
  $("trace").addEventListener("dblclick", (e) => {
    if (!S.result || !geom) return;
    pbPlay(Math.max(0, geom.S(tlX(e))));
  });
  ["asFirst", "asSecond", "asBars", "asMeter"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); assistFit(); } });
  });
  $("msPick").onclick = pickMapset;
  $("msRecheck").onclick = () => { if (S.mapset) runMapset(S.mapset.path, false); };
  $("swPreview").onclick = swPreview;
  $("swApply").onclick = swApply;
  $("swNew").onchange = () => { SW.preview = null; renderSwapResult(); };
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("injectBtn").onclick = injectOsu;
  $("injectAllPreviewBtn").onclick = injectAllPreview;
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
  window.addEventListener("resize", () => { drawTrace(); drawBands(); drawSpec(); drawBal(); drawEng(); drawTmap(); });
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
  $("keysSheet").addEventListener("close", () => { KEYCAP.action = null; });
  $("keysList").onclick = (e) => {
    const cap = e.target.closest(".keycap");
    if (!cap) return;
    KEYCAP.action = KEYCAP.action === cap.dataset.action ? null : cap.dataset.action;
    renderKeys();
  };
  $("keysReset").onclick = async () => {
    const reply = await api().set_settings({ shortcuts: {} });
    if (reply.ok) { stTake(reply); renderKeys(); }
  };
  palWire();
  notesWire();
  window.addEventListener("keydown", (e) => {
    // Ctrl+K opens the palette from anywhere, a field included; open, it
    // keeps every key but its own toggle.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("keysSheet").open) $("keysSheet").close();
      openPalette();
      return;
    }
    if ($("palette").open) return;
    // The sheet is modal: it takes no shortcut but its own (Esc closes it
    // natively), and while a key waits to be changed, the next key is it.
    if ($("keysSheet").open) {
      if (KEYCAP.action) { keyTake(e); return; }
      if (pressed(e, "sheet")) { e.preventDefault(); $("keysSheet").close(); }
      return;
    }
    if (e.key === "Escape") { openDrawer(false); return; }
    // A field, a slider or a list keeps its own keys (an arrow moves a select).
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
    if (pressed(e, "play") && S.result && !typing) {
      e.preventDefault();
      pbToggle();
      return;
    }
    if (pressed(e, "tap") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
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
    if (pressed(e, "sheet") && plain) { e.preventDefault(); openKeys(); return; }
    if (plain && !$("drawer").classList.contains("open")) {
      if (viewKeys[e.key] && !e.shiftKey) { e.preventDefault(); setView(viewKeys[e.key]); return; }
      if (S.result && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const step = (e.shiftKey ? 0.01 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        pbSeek(Math.min(Math.max(pbPosition() + step, 0), S.result.duration), true);
        return;
      }
      if (S.result && (pressed(e, "line_prev") || pressed(e, "line_next"))) {
        e.preventDefault(); jumpLine(pressed(e, "line_next") ? 1 : -1); return;
      }
      if (S.result && !e.repeat && pressed(e, "loop")) { e.preventDefault(); toggleCheck("pbLoop"); return; }
      if (S.result && !e.repeat && pressed(e, "click")) { e.preventDefault(); toggleCheck("pbClick"); return; }
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

// --------------------------------------------------------------- splash ---
// The overlay comes down when boot() has the config, the strings and the first
// view, never before 420 ms (a flash reads as a glitch) and never after 6 s
// (a bridge that never answers must not leave the window covered: the page
// behind it is still usable, and a covered window looks hung).
const SPLASH = { shown: performance.now(), done: false };

function splashHide() {
  if (SPLASH.done) return;
  SPLASH.done = true;
  const el = $("splash");
  if (!el) return;
  const wait = Math.max(0, 420 - (performance.now() - SPLASH.shown));
  setTimeout(() => {
    el.classList.add("going");
    // Removed from the page, not just faded: a transparent overlay still eats
    // every click, which is the way this goes wrong.
    const drop = () => { el.hidden = true; el.remove(); };
    el.addEventListener("transitionend", drop, { once: true });
    setTimeout(drop, 400);
  }, wait);
}

setTimeout(splashHide, 6000);

async function boot() {
  wire();
  const st = await api().state();
  S.lang = st.language; S.presets = st.presets;
  S.recent = st.recent || [];
  if (st.playback) {
    P.levels = { song_volume: st.playback.song_volume, click_volume: st.playback.click_volume };
    TAP.latency = st.playback.tap_latency_ms || 0;
  }
  renderTaps();
  stLoad();
  $("pbSongVol").value = String(Math.round(P.levels.song_volume * 100));
  $("pbClickVol").value = String(Math.round(P.levels.click_volume * 100));
  S.rustAvailable = !!st.rust_available;
  $("version").textContent = st.version;
  if (st.logo) $("logo").src = st.logo;
  applyOptions(st.options);
  setFile(st.file);
  translate();
  // Offered only where built; a saved choice without a binary falls back.
  $("rustEngine").disabled = !S.rustAvailable;
  if (!S.rustAvailable) $("rustNote").textContent = t("t_rust_missing");
  setView(S.view);  // Library until an analysis finishes
  syncActions();
  syncLocks();
  splashHide();
  if (st.autorun && S.file) analyze();
}

window.addEventListener("pywebviewready", boot);
