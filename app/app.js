// Overtone web shell — talks to overtone_web.Api through window.pywebview.api.
// Python pushes analysis events back through window.overtone.on*.
"use strict";

const I18N = {
  en: {
    tagline: "Timing for osu! maps", nav_timing: "Timing", offline: "offline, nothing leaves this PC",
    nav_sections: "Sections", nav_library: "Library", nav_mapcheck: "Map check", nav_export: "Export", nav_settings: "Settings",
    close: "Close",
    need_title: "Nothing analyzed yet",
    need_body: "{view} works on the analyzed song, the same one every section shares. Open an audio file and analyze it.",
    need_busy: "Analyzing… {view} fills in as soon as it finishes.",
    need_analyze: "Analyze {name}", need_library: "Go to Library",
    mapcheck_sub: "One difficulty you mapped, checked against this analysis. Read only: nothing is written.",
    export_sub: "Everything here writes the current timing points, edits included.",
    exp_osu_t: "osu! timing points", exp_osu_d: "The red lines as [TimingPoints] text, ready to paste into a .osu.",
    exp_csv_t: "CSV table", exp_csv_d: "Offset, BPM, beat and confidence per point, for a spreadsheet.",
    exp_click_t: "Click track", exp_click_d: "A metronome WAV on these red lines, to hear any drift against the song.",
    exp_osz_t: ".osz package", exp_osz_d: "The audio plus a new beatmap carrying this timing.",
    exp_inject_t: "Inject into a .osu", exp_inject_d: "Replaces the red lines of a difficulty you already have. You confirm first, and a backup is kept.",
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
    trace_title: "Tempo map", trace_sub: "Wheel to zoom · drag to pan · drag a red line to move it (it snaps to an attack; Alt moves it freely) · click selects, double-click plays",
    no_song: "No song open", no_song_hint: "Open an audio file to start", analyze_last: "Analyze the last song",
    k_open: "open", k_analyze: "analyze", table_hint: "↑ ↓ to move", f_preset: "Preset",
    d_song: "Song", d_point: "Timing point", d_offset: "Offset", d_beat: "Beat length", d_meter: "Meter",
    d_conf: "Confidence", d_span: "Governs", d_until: "until {t}", d_end: "to the end", d_bars: "{n} bars",
    d_duration: "Duration", d_first: "First beat", d_engine: "Engine", d_residual: "Grid residual",
    d_pulse: "Pulse", d_sections: "Grid sections", d_hint: "Select a timing point in the list or on the tempo map to inspect it.",
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
    engine_precision: "precision grid", engine_legacy: "beat tracker fallback",
    constant: "constant", variable: "variable", points_n: "{n} points", meter_known: "bar found", meter_guess: "bar assumed",
    time_at: "time", tempo_at: "tempo", line_at: "red line",
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
    copied: "Timing points copied — paste into the .osu [TimingPoints].",
    clipboard_failed: "Could not reach the clipboard: {detail}",
    saved_to: "Saved to {path}",
    injected: "Injected {added} red lines ({replaced} replaced, {greens} green kept).",
    inject_confirm: "Replace {reds} red lines with {n} new ones in {file}?{warn}",
    inject_greens: "\nIt also adds {g} green lines so slider velocity and hitsounds play as before.",
    inject_warn: "\nThe .osu audio ({osu}) differs from the analyzed file ({src}).",
    drop_title: "Drop the audio", drop_body: "Release to time it with the current detection settings.",
    recent: "Recent",
    hs_title: "Copy hitsounds", hs_preview: "Preview", hs_apply: "Copy hitsounds",
    hs_sub: "Each sound of the chosen difficulties takes the source's sound at the same moment (within 5 ms): additions, sample sets and index. Sounds with nothing under them are left as they are. Only hitsound fields change, and every file is backed up first.",
    hs_source: "From", hs_targets: "Onto",
    hs_volumes: "Copy volumes too (usually the green lines' job; they are not copied)",
    hs_no_targets: "Choose at least one difficulty to copy onto.", hs_same_file: "A difficulty cannot be copied onto itself.",
    hs_t_diff: "Difficulty", hs_t_sounds: "Sounds", hs_t_matched: "With a source sound", hs_t_changed: "Will change",
    hs_t_unmatched: "Nothing under them", hs_t_conflicts: "Index conflicts",
    hs_conflict_note: "An index conflict is a sound whose sample index comes from a green line the target does not have, or a slider edge whose index differs from its head's: the copy leaves those indexes as they are.",
    hs_confirm: "Write the hitsounds of {source} into {n} difficulties? Only hitsound fields change; each file is backed up first.",
    hs_done: "Hitsounds copied into {n} difficulties ({objects} objects). Backups kept beside each file.",
    hs_nothing: "Nothing to change: these difficulties already sound like {source}.",
    st_theme: "Theme", st_theme_system: "System", st_theme_dark: "Dark", st_theme_light: "Light",
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
    stx_note: "Letters are families of sections that repeat. Edges snap to the nearest proven bar line within {snap} s: a bar near the change, not proof the phrase starts on it. A change within {edge} s of either end cannot be placed. Click a section to open it in Timing.",
    songs_title: "osu! Songs",
    songs_scan: "Scan",
    songs_rescan: "Rescan",
    songs_scanning: "Scanning…",
    songs_pick: "Folder…",
    songs_search: "Search artist, title, mapper, difficulty, tags",
    songs_listing: "Listing the folder…",
    songs_progress: "{done} / {total} folders",
    songs_none: "Not indexed yet: Scan reads {root} once.",
    songs_missing: "No Songs folder at {root}: choose one.",
    songs_info: "{n} maps in {s} sets · scanned {when}",
    songs_other: "Index of {root} ({n} maps): Rescan for the current folder.",
    songs_scanned: "Library: {n} maps in {s} sets ({changed} read, {removed} gone) in {sec} s.",
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
    sug_hint: "Changes Overtone hears that this map has no red line for. Inject .osu… writes them.",
    sug_show: "Show",
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
    nav_report: "Report",
    report_sub: "Every finding about one difficulty as osu! editor timestamps, ready to paste into a mod post. A timestamp opens the editor there. Read only: nothing is written.",
    rp_title: "Mod report", rp_pick: "Choose .osu…", rp_copy: "Copy all",
    rp_empty: "Choose the .osu of a difficulty to gather every finding about it: red lines to check, red lines it is missing, unsnapped objects and objects away from the music.",
    rp_counts: "{n} findings", rp_none: "Nothing to report on this difficulty.",
    rp_src_reference: "Red lines", rp_src_suggestion: "Missing red lines", rp_src_snap: "Snapping", rp_src_alignment: "Away from the music",
    rp_hint: "The lines are in English, as mod posts are. Untick a group to leave it out of the copy.",
    rp_copied: "Report copied: paste it into your mod post.",
    rp_open: "Open in the osu! editor",
    bad_stamp: "That is not an editor timestamp.",
    no_osu: "osu! did not open — is it installed? ({detail})",
    pb_play: "Play / pause (Space)", pb_from_line: "From red line", pb_seek: "Position",
    pb_click: "Click", pb_loop: "Loop section", pb_song: "Song", pb_click_vol: "Click",
    pb_hint: "Space plays and pauses · double-click the tempo map to play from there · the click follows your edits",
    pb_loading: "Loading the song… {n}/{of}",
    pb_failed: "The song could not be played: {detail}",
    no_audio_staged: "The song is not loaded; press play again.",
    pb_rate: "Speed: slower lowers the pitch, so every attack stays exactly in place",
    lane_wave: "wave", tl_zoom: "{a} – {b}", tl_fit: "Show all", lg_drift: "drift",
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
    nav_sections: "Secciones", nav_library: "Biblioteca", nav_mapcheck: "Revisar mapa", nav_export: "Exportar", nav_settings: "Ajustes",
    close: "Cerrar",
    need_title: "Todavía no hay nada analizado",
    need_body: "{view} trabaja sobre la canción analizada, la misma que comparten todas las secciones. Abrí un audio y analizalo.",
    need_busy: "Analizando… {view} se completa apenas termine.",
    need_analyze: "Analizar {name}", need_library: "Ir a la Biblioteca",
    mapcheck_sub: "Una dificultad que mapeaste, contrastada con este análisis. Solo lectura: no se escribe nada.",
    export_sub: "Todo lo de acá escribe los timing points actuales, ediciones incluidas.",
    exp_osu_t: "Timing points de osu!", exp_osu_d: "Las líneas rojas como texto de [TimingPoints], listas para pegar en un .osu.",
    exp_csv_t: "Tabla CSV", exp_csv_d: "Offset, BPM, beat y confianza por punto, para una planilla.",
    exp_click_t: "Pista de clic", exp_click_d: "Un WAV de metrónomo sobre estas líneas rojas, para oír si derivan contra la canción.",
    exp_osz_t: "Paquete .osz", exp_osz_d: "El audio más un beatmap nuevo con este timing.",
    exp_inject_t: "Inyectar en un .osu", exp_inject_d: "Reemplaza las líneas rojas de una dificultad que ya tenés. Confirmás antes y se guarda un respaldo.",
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
    trace_title: "Mapa de tempo", trace_sub: "Rueda para acercar · arrastrá para desplazarte · arrastrá una línea roja para moverla (se imanta a un ataque; con Alt, libre) · clic elige, doble clic reproduce",
    no_song: "Ninguna canción abierta", no_song_hint: "Abrí un archivo de audio para empezar", analyze_last: "Analizar la última canción",
    k_open: "abrir", k_analyze: "analizar", table_hint: "↑ ↓ para moverte", f_preset: "Preajuste",
    d_song: "Canción", d_point: "Timing point", d_offset: "Offset", d_beat: "Duración del beat", d_meter: "Compás",
    d_conf: "Confianza", d_span: "Gobierna", d_until: "hasta {t}", d_end: "hasta el final", d_bars: "{n} compases",
    d_duration: "Duración", d_first: "Primer beat", d_engine: "Motor", d_residual: "Residuo de la rejilla",
    d_pulse: "Pulso", d_sections: "Secciones de rejilla", d_hint: "Elegí un timing point en la lista o en el mapa de tempo para inspeccionarlo.",
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
    engine_precision: "rejilla de precisión", engine_legacy: "tracker de respaldo",
    constant: "constante", variable: "variable", points_n: "{n} puntos", meter_known: "compás hallado", meter_guess: "compás supuesto",
    time_at: "tiempo", tempo_at: "tempo", line_at: "línea roja",
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
    copied: "Timing points copiados — pegalos en el [TimingPoints] del .osu.",
    clipboard_failed: "No se pudo llegar al portapapeles: {detail}",
    saved_to: "Guardado en {path}",
    injected: "Inyectadas {added} líneas rojas ({replaced} reemplazadas, {greens} verdes intactas).",
    inject_confirm: "¿Reemplazar {reds} líneas rojas por {n} nuevas en {file}?{warn}",
    inject_greens: "\nTambién agrega {g} líneas verdes para que la velocidad de sliders y los hitsounds suenen igual.",
    inject_warn: "\nEl audio del .osu ({osu}) difiere del analizado ({src}).",
    drop_title: "Soltá el audio", drop_body: "Soltá para timearlo con los ajustes actuales.",
    recent: "Recientes",
    hs_title: "Copiar hitsounds", hs_preview: "Vista previa", hs_apply: "Copiar hitsounds",
    hs_sub: "Cada sonido de las dificultades elegidas toma el sonido de la fuente en el mismo momento (a menos de 5 ms): adiciones, sample sets e índice. Los sonidos sin nada debajo quedan como están. Solo cambian los campos de hitsound, y cada archivo se respalda antes.",
    hs_source: "Desde", hs_targets: "Hacia",
    hs_volumes: "Copiar también los volúmenes (suelen ser trabajo de las líneas verdes, que no se copian)",
    hs_no_targets: "Elegí al menos una dificultad de destino.", hs_same_file: "Una dificultad no se puede copiar sobre sí misma.",
    hs_t_diff: "Dificultad", hs_t_sounds: "Sonidos", hs_t_matched: "Con sonido fuente", hs_t_changed: "Van a cambiar",
    hs_t_unmatched: "Sin nada debajo", hs_t_conflicts: "Conflictos de índice",
    hs_conflict_note: "Un conflicto de índice es un sonido cuyo índice de sample viene de una línea verde que el destino no tiene, o un borde de slider con un índice distinto al de su cabeza: la copia deja esos índices como están.",
    hs_confirm: "¿Escribir los hitsounds de {source} en {n} dificultades? Solo cambian los campos de hitsound; cada archivo se respalda antes.",
    hs_done: "Hitsounds copiados en {n} dificultades ({objects} objetos). Los respaldos quedan junto a cada archivo.",
    hs_nothing: "Nada que cambiar: estas dificultades ya suenan como {source}.",
    st_theme: "Tema", st_theme_system: "Sistema", st_theme_dark: "Oscuro", st_theme_light: "Claro",
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
    stx_note: "Las letras son familias de secciones que se repiten. Los bordes se ajustan a la línea de compás probada más cercana, a menos de {snap} s: un compás cerca del cambio, no la prueba de que la frase empiece ahí. Un cambio a menos de {edge} s de cada punta no se puede ubicar. Hacé clic en una sección para abrirla en Timing.",
    songs_title: "Songs de osu!",
    songs_scan: "Escanear",
    songs_rescan: "Reescanear",
    songs_scanning: "Escaneando…",
    songs_pick: "Carpeta…",
    songs_search: "Buscá artista, título, mapper, dificultad, tags",
    songs_listing: "Listando la carpeta…",
    songs_progress: "{done} / {total} carpetas",
    songs_none: "Sin índice todavía: Escanear lee {root} una vez.",
    songs_missing: "No hay carpeta Songs en {root}: elegí una.",
    songs_info: "{n} mapas en {s} sets · escaneado {when}",
    songs_other: "Índice de {root} ({n} mapas): reescaneá para la carpeta actual.",
    songs_scanned: "Biblioteca: {n} mapas en {s} sets ({changed} leídos, {removed} quitados) en {sec} s.",
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
    sug_hint: "Cambios que Overtone detecta y este mapa no tiene como línea roja. Inyectar .osu… los escribe.",
    sug_show: "Ver",
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
    nav_report: "Reporte",
    report_sub: "Cada hallazgo sobre una dificultad como timestamps del editor de osu!, listo para pegar en un mod. Un timestamp abre el editor ahí. Solo lectura: no se escribe nada.",
    rp_title: "Reporte de mod", rp_pick: "Elegir .osu…", rp_copy: "Copiar todo",
    rp_empty: "Elegí el .osu de una dificultad para juntar cada hallazgo sobre ella: líneas rojas a revisar, líneas rojas que le faltan, objetos sin snap y objetos lejos de la música.",
    rp_counts: "{n} hallazgos", rp_none: "Nada que reportar en esta dificultad.",
    rp_src_reference: "Líneas rojas", rp_src_suggestion: "Líneas rojas faltantes", rp_src_snap: "Snap", rp_src_alignment: "Lejos de la música",
    rp_hint: "Las líneas van en inglés, como los mods. Destildá un grupo para dejarlo fuera de la copia.",
    rp_copied: "Reporte copiado: pegalo en tu mod.",
    rp_open: "Abrir en el editor de osu!",
    bad_stamp: "Eso no es un timestamp del editor.",
    no_osu: "osu! no se abrió — ¿está instalado? ({detail})",
    pb_play: "Reproducir / pausar (Espacio)", pb_from_line: "Desde la línea roja", pb_seek: "Posición",
    pb_click: "Click", pb_loop: "Repetir sección", pb_song: "Canción", pb_click_vol: "Click",
    pb_hint: "Espacio reproduce y pausa · doble clic en el mapa de tempo para reproducir desde ahí · el click sigue tus ediciones",
    pb_loading: "Cargando la canción… {n}/{of}",
    pb_failed: "No se pudo reproducir la canción: {detail}",
    no_audio_staged: "La canción no está cargada; volvé a darle play.",
    pb_rate: "Velocidad: más lento baja el tono, así cada ataque queda exactamente en su lugar",
    lane_wave: "onda", tl_zoom: "{a} – {b}", tl_fit: "Ver todo", lg_drift: "deriva",
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

const S = { lang: "en", view: "library", mapset: null, file: null, options: null, presets: {}, result: null, busy: false, selected: -1, locks: [], compare: null, comparePath: null, align: null, density: null, snap: null, ref: null, refFind: null, assist: null, report: null, recent: [] };
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
  renderSong();
  renderRecents();
  renderSongs();
  renderStructure();
  renderNeedSong();
  renderMapset();
  if (typeof renderCopier === "function") renderCopier();
  if (S.result) renderResult(S.result);
  if (S.busy) $("analyzeText").textContent = t("analyzing");
}

// ------------------------------------------------------------------ views
// One analysed song is shared by every view: switching only changes what is
// visible, never the session. Views that read the analysis show the
// "analyze first" panel until there is one, instead of blank space.
const VIEWS = ["library", "timing", "structure", "mapcheck", "mapset", "report", "export", "settings"];
const VIEW_LABEL = { library: "nav_library", timing: "nav_timing", structure: "nav_structure", mapcheck: "nav_mapcheck", mapset: "nav_mapset", report: "nav_report", export: "nav_export", settings: "nav_settings" };

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
  if (view === "timing" && S.result) { drawTrace(); waveLoad(); }
  if (view === "structure" && S.result) stxLoad();
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
  if (message !== undefined) $("progressText").textContent = message;
  syncActions();
  renderNeedSong();
}

function syncActions() {
  const on = !!S.result && !S.busy;
  ["copyOsuBtn", "csvBtn", "clickBtn", "oszBtn", "injectBtn", "cmpPick", "alignPick", "denPick", "snapPick", "refPick", "refFind", "asFit", "rpPick", "rpCopy"].forEach((id) => { $(id).disabled = !on; });
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

async function rescale(mult) {
  if (!api() || S.busy) return;
  const reply = await api().rescale(mult);
  if (!reply.ok) { toast(t(reply.key, { detail: reply.detail || "" }), true); return; }
  S.selected = -1;
  S.locks = reply.locks || [];
  showResult(reply.result);
  syncHistory(reply);
  toast(t("rescaled", { f: reply.result.subdivision, n: reply.result.points.length, bpm: reply.result.global_bpm.toFixed(2) }));
}

window.overtone = {
  onProgress(message) { $("progressText").textContent = message; },
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
    showResult(result);
    // A finished analysis lands on Timing, unless the user is already on a
    // view that was waiting for it (Map check, Export): that one fills in.
    if (!needsResult(S.view)) setView("timing");
    syncHistory();
    syncLocks();
    refreshRecents();
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
  S.result = result;
  S.compare = null;  // these cards belong to one map and one point list
  S.align = null;
  S.density = null;
  S.snap = null;
  // A grade depends on the map and the song's attacks, not on the point list:
  // it stays through edits and goes with the song.
  if (!sameSong) { S.ref = null; S.refFind = null; S.assist = null; S.report = null; pbReset(); }
  if (!sameSong) { STX.view = null; STX.file = ""; STX.error = null; }
  if (!sameSong) S.comparePath = null;  // a map belongs to one song
  setView(S.view);  // lifts the "analyze first" panel off the current view
  syncActions();
  renderResult(result);
  // Same song, new point list (edit, undo, redo, pulse): recompare so the
  // suggestions stay current instead of vanishing until the map is re-picked.
  if (S.comparePath) refreshCompare();
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

  $("warnings").innerHTML = r.warnings.map((w) => `
    <div class="banner ${w.level === "info" ? "info" : ""}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div>${t(w.key, w.values)}</div>
    </div>`).join("");

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
  renderRef();
  renderAssist();
  renderReport();
  renderTaps();
  if (S.view === "timing") waveLoad();
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
            [t("d_sections"), r.sections.length || "—"], [t("d_pulse"), `×${r.subdivision}`]])}
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
  } else if (action === "lock") {
    if (sel < 0) { toast(t("no_selection"), true); return; }
    const off = S.result.points[sel].offset_ms;
    reply = await api().set_locked(sel, !(S.locks || []).includes(off));
    if (reply.ok) message = t(reply.locked ? "locked_on" : "locked_off", { n: sel + 1 });
  }
  if (!reply) return;
  if (!reply.ok) {
    if (reply.key === "locked") toast(t("point_locked", { n: sel + 1 }), true);
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
  toast(t("saved_to", { path: reply.path }));
}

async function injectOsu() {
  if (!api() || !S.result || S.busy) return;
  const target = await api().pick_osu(S.lastFolder || "");
  if (!target) return;
  const prev = await api().inject_preview(target);
  if (!prev.ok) { editFailure(prev); return; }
  const s = prev.summary;
  const warn = (s.audio_mismatch ? t("inject_warn", { osu: s.osu_audio, src: s.analysed_audio }) : "")
    + (s.greens_added ? t("inject_greens", { g: s.greens_added }) : "");
  const name = String(target).split(/[\\/]/).pop();
  if (!confirm(t("inject_confirm", { reds: s.reds_replaced, n: s.reds_added, file: name, warn }))) return;
  const done = await api().inject_apply(target);
  if (!done.ok) { editFailure(done); return; }
  const d = done.summary;
  toast(t("injected", { added: d.reds_added, replaced: d.reds_replaced, greens: d.greens_kept }));
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
const SONGS = { state: null, result: null, query: "", timer: 0, scanning: false, progress: null };

function when(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !isNaN(date) ? date.toLocaleString(S.lang, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

async function songsLoad() {
  if (!api()) return;
  const reply = await api().library_state();
  SONGS.state = reply.ok ? reply : null;
  if (reply.ok && reply.index.beatmaps) await songsSearch();
  else renderSongs();
}

async function songsSearch() {
  const reply = await api().library_search(SONGS.query);
  if (!reply.ok) toast(t("error", { detail: reply.detail || "" }), true);
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
    toast(t("songs_scanned", { n: r.beatmaps, s: r.sets, changed: r.added + r.updated,
                               removed: r.removed, sec: r.seconds.toFixed(1) }));
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
  const st = SONGS.state, idx = st && st.index, indexed = !!(idx && idx.beatmaps);
  $("songsQuery").placeholder = t("songs_search");
  $("songsQuery").hidden = !indexed;
  $("songsScanText").textContent = t(SONGS.scanning ? "songs_scanning" : indexed ? "songs_rescan" : "songs_scan");
  $("songsScan").disabled = SONGS.scanning;
  $("songsPick").disabled = SONGS.scanning;
  let info = "";
  if (SONGS.scanning) {
    info = SONGS.progress ? t("songs_progress", SONGS.progress) : t("songs_listing");
  } else if (st && !indexed) {
    info = t(st.songs_found ? "songs_none" : "songs_missing", { root: esc(st.songs) });
  } else if (st) {
    info = t(st.current ? "songs_info" : "songs_other",
             { n: idx.beatmaps, s: idx.sets, when: esc(when(idx.scanned_at)), root: esc(idx.root) });
  }
  $("songsInfo").innerHTML = info;
  $("songsInfo").title = $("songsInfo").textContent;
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
    ${v.one_family ? `<div class="card-sub mb-m">${t("stx_one_family")}</div>` : ""}
    <div class="table-scroll"><table class="stx-table">
      <thead><tr><th>${t("stx_h_start")}</th><th>${t("stx_h_bar")}</th><th>${t("stx_h_len")}</th><th>${t("stx_h_part")}</th><th>${t("stx_h_why")}</th><th>${t("stx_h_moved")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="card-sub mt-m">${t("stx_note", { snap: v.snap_s, edge })}</div>`;
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
      <td class="num">${s.bpm.toFixed(3)}</td>
      <td class="num">${s.nearest_ms === null ? "—" : s.nearest_ms.toFixed(1)}</td>
      <td><button class="btn small" data-show="${s.index}">${t("sug_show")}</button></td>
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
  S.ref = { path: reply.path, file: reply.file, report: reply.report, same: reply.same_audio };
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
      const audio = ref.same === true ? ["info", "ref_same"] : ref.same === false ? ["", "ref_other"] : ["info", "ref_unknown"];
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
  if (P.buffer && P.bufferFor === path) return true;
  if (P.loading) return P.loading;
  P.loading = (async () => {
    const ctx = pbContext();
    try {
      try {
        P.buffer = await ctx.decodeAudioData(await pbFetch("file"));
      } catch (err) {
        // The browser cannot read every format Overtone can (AIFF): take
        // Overtone's own decode instead of refusing.
        P.buffer = await ctx.decodeAudioData(await pbFetch("wav"));
      }
      P.bufferFor = path;
      waveBuild();
      $("pbStatus").textContent = t("pb_hint");
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
      pbClickAt(P.startCtx + P.sched + (clicks.t[i] - s0) / P.rate, clicks.level[i]);
    }
    P.sched += len > 1e-9 ? len : 1e-6;
  }
  if (!P.loop && pbPosition() >= P.buffer.duration) { pbStop(); P.pos = 0; pbDraw(); }
}

function pbLoopFor(pos) {
  // The section under the playhead: from its red line to the next one.
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

function pbSeek(pos) {
  if (P.playing) pbPlay(pos);
  else { P.pos = Math.max(0, pos); pbDraw(); }
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
  if (P.loop && P.playing) {
    ctx.fillStyle = C.loop;
    ctx.fillRect(geom.X(P.loop.a), geom.y0 - 22, geom.X(P.loop.b) - geom.X(P.loop.a), geom.y1 - geom.y0 + 22);
  }
  if (!P.playing && pos <= 0) return;
  const x = Math.round(geom.X(Math.min(pos, dur))) + 0.5;
  ctx.strokeStyle = C.playhead; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, geom.y0 - 22); ctx.lineTo(x, geom.y1); ctx.stroke();
}

function pbReset() {
  // A new song: its buffer, position and loop are the old song's no more.
  pbStop();
  P.buffer = null; P.bufferFor = null; P.pos = 0; P.loop = null;
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
    if (S.result) drawTrace();
  }
}
SYSTEM_LIGHT.addEventListener("change", stTheme);

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
const LANES = { wave: 58, drift: 46, gap: 10 };
const TL_MIN_SPAN = 0.5;          // seconds: the closest zoom
const TL_SNAP_PX = 6;             // a dragged red line snaps to an attack this close
const DRIFT_MS = 30;              // the drift lane's half height
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
  const yD1 = H - PAD.b, yD0 = yD1 - LANES.drift, yW1 = yD0 - LANES.gap, yW0 = yW1 - LANES.wave;
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
  geom = { x0, x1, y0, y1, yW0, yW1, yD0, yD1, dur, X, S: Sx, Y, lo, hi };

  const plotTop = y0 - 22;
  const panels = [[plotTop, y1], [yW0, yW1], [yD0, yD1]];
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

  // the beat grid, once beats are far enough apart to read
  const ct = (r.clicks && r.clicks.t) || [], cl = (r.clicks && r.clicks.level) || [];
  const beats = [];
  for (let i = 0; i < ct.length && beats.length < 2; i++) if (cl[i] >= 1) beats.push(ct[i]);
  const pxPerBeat = beats.length > 1 ? ((x1 - x0) / span) * (beats[1] - beats[0]) : 0;
  if (pxPerBeat >= 7) {
    for (let i = lowerBound(ct, v.a); i < ct.length && ct[i] <= v.b; i++) {
      if (!(cl[i] >= 1)) continue;
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

  // the compared map's red lines, as ghosts
  ctx.save(); clipAll();
  ctx.strokeStyle = C.ghost; ctx.lineWidth = 1.25; ctx.setLineDash([3, 4]);
  for (const s of ghostLines()) {
    const x = Math.round(X(s)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, plotTop + 22); ctx.lineTo(x, yD1); ctx.stroke();
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
    ctx.strokeStyle = C.red; ctx.lineWidth = i === S.selected || (dragging && dragging.i === i) ? 2 : 1.25;
    ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, yD1); ctx.stroke();
    const label = dragging && dragging.i === i ? `${(s * 1000).toFixed(1)} ms` : p.bpm.toFixed(p.bpm % 1 ? 2 : 0);
    const w = ctx.measureText(label).width + 16;
    const row = x > lastRight[0] + 4 ? 0 : (x > lastRight[1] + 4 ? 1 : 0);
    lastRight[row] = x + w;
    const top = y0 - 20 + row * 24;
    ctx.fillStyle = C.red; roundRect(ctx, x, top, w, 20, 4); ctx.fill();
    ctx.fillStyle = C.redInk; ctx.fillText(label, x + 8, top + 10.5);
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

function tlDown(ev) {
  if (ev.button !== 0 || !S.result || !geom) return;
  const x = tlX(ev), i = tlLineAt(x);
  TL.moved = false;
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
    <div class="row"><span class="k">${t("line_at")}</span><span class="num">${g ? g.bpm.toFixed(3) : "—"}</span></div>`;
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
  $("halfBtn").onclick = () => rescale(0.5);
  $("doubleBtn").onclick = () => rescale(2);
  $("rows").onclick = (e) => { const tr = e.target.closest("tr"); if (tr) selectPoint(+tr.dataset.i); };
  $("stxBody").addEventListener("click", (e) => {
    const el = e.target.closest("[data-stx]");
    if (el) stxShow(+el.dataset.stx);
  });
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
  $("detail").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) editAction(btn.dataset.action);
  });
  $("cmpBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-show]");
    if (!btn || !S.result) return;
    const i = +btn.dataset.show;
    if (!(i >= 0 && i < S.result.points.length)) return;
    setView("timing");  // the tempo map and the point live in Timing
    selectPoint(i, false);
    document.querySelector(".trace-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("copyOsuBtn").onclick = copyOsu;
  $("csvBtn").onclick = () => saveAs("save_csv");
  $("clickBtn").onclick = () => saveAs("save_click");
  $("oszBtn").onclick = () => saveAs("save_osz");
  $("cmpPick").onclick = compareOsu;
  $("alignPick").onclick = alignOsu;
  $("denPick").onclick = densityOsu;
  $("snapPick").onclick = snapOsu;
  $("refPick").onclick = refPick;
  $("refFind").onclick = refFind;
  $("asFit").onclick = assistFit;
  $("rpPick").onclick = reportPick;
  $("rpCopy").onclick = copyReport;
  $("pbPlay").onclick = pbToggle;
  $("pbFromLine").onclick = () => {
    if (!S.result) return;
    const i = S.selected >= 0 ? S.selected : governing(S.result, pbPosition());
    pbPlay(S.result.points[i].offset_ms / 1000);
  };
  $("pbSeek").addEventListener("input", () => { if (S.result) pbSeek((+$("pbSeek").value / 1000) * S.result.duration); });
  $("pbClick").addEventListener("change", pbApplyLevels);
  $("pbLoop").addEventListener("change", () => { if (P.playing) pbPlay(pbPosition()); });
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
    $(id).addEventListener("input", () => { P.levels = { song_volume: +$("pbSongVol").value / 100, click_volume: +$("pbClickVol").value / 100 }; pbApplyLevels(); });
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
  $("hsPreview").onclick = hsPreview;
  $("hsApply").onclick = hsApply;
  $("hsSource").onchange = () => { HS.preview = null; $("hsTargets").innerHTML = ""; renderCopier(); };
  $("hsTargets").onchange = () => { HS.preview = null; renderCopyResult(); };
  $("hsVolumes").onchange = () => { HS.preview = null; renderCopyResult(); };
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("injectBtn").onclick = injectOsu;
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
    readOptions(); markPreset();
  });
  ["delta", "persistence", "confidence"].forEach((id) => $(id).addEventListener("input", () => { readOptions(); markPreset(); }));
  document.querySelectorAll("#langSwitch button").forEach((b) => b.onclick = () => {
    S.lang = b.dataset.lang; translate(); if (api()) api().set_language(S.lang);
  });
  window.addEventListener("resize", () => drawTrace());
  // How the focused control got focus: Tab means the user is driving the
  // keyboard, a click means the button merely kept focus afterwards.
  document.addEventListener("mousedown", () => { focusByKey = false; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Tab") focusByKey = true; }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { openDrawer(false); return; }
    if (e.key === " " && S.result && !(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
      e.preventDefault();
      pbToggle();
      return;
    }
    if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
        && S.result && !(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
      e.preventDefault();
      tapNow(e);
      return;
    }
    // Typing an offset or a detection value must not trigger shortcuts:
    // Enter inside the point editor would otherwise start a full analysis.
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
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
    P.levels = { song_volume: st.playback.song_volume, click_volume: st.playback.click_volume };
    TAP.latency = st.playback.tap_latency_ms || 0;
  }
  renderTaps();
  stLoad();
  songsLoad();
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
  if (st.autorun && S.file) analyze();
}

window.addEventListener("pywebviewready", boot);
