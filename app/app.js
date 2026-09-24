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
    mapset_sub: "Every difficulty of one beatmap folder side by side: red lines, audio settings and metadata that must match. Read only: differences are listed, never fixed.",
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
    trace_title: "Tempo map", trace_sub: "Local BPM over time · click to select the governing red line",
    no_song: "No song open", no_song_hint: "Open an audio file to start", analyze_last: "Analyze the last song",
    k_open: "open", k_analyze: "analyze", table_hint: "↑ ↓ to move", f_preset: "Preset",
    d_song: "Song", d_point: "Timing point", d_offset: "Offset", d_beat: "Beat length", d_meter: "Meter",
    d_conf: "Confidence", d_span: "Governs", d_until: "until {t}", d_end: "to the end", d_bars: "{n} bars",
    d_duration: "Duration", d_first: "First beat", d_engine: "Engine", d_residual: "Grid residual",
    d_pulse: "Pulse", d_sections: "Grid sections", d_hint: "Select a timing point in the list or on the tempo map to inspect it.",
    d_meter_known: "Bar found in the accents: this red line sits on a downbeat.",
    d_meter_guess: "No bar evidence: the red line sits on a beat, and the meter is the analysis default.",
    lg_tempo: "tempo", lg_points: "timing points", lg_onsets: "onsets",
    table_title: "Timing points", col_offset: "Offset (ms)", col_beat: "Beat (ms)", col_meter: "Meter", col_conf: "Confidence",
    detection: "Detection settings", preset_variable: "Variable tempo", preset_steady: "Steady",
    f_delta: "Min change (BPM)", f_persist: "Confirm beats", f_conf: "Min confidence (%)", f_pulse: "Pulse (octave)", auto: "Auto",
    t_prefer: "Prefer map BPM (120–300)", t_refine: "Re-anchor beats to transients",
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
    mapset_sub: "Todas las dificultades de una carpeta, lado a lado: líneas rojas, ajustes de audio y metadatos que deben coincidir. Solo lectura: las diferencias se listan, nunca se corrigen.",
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
    trace_title: "Mapa de tempo", trace_sub: "BPM local en el tiempo · clic para elegir la línea roja que lo gobierna",
    no_song: "Ninguna canción abierta", no_song_hint: "Abrí un archivo de audio para empezar", analyze_last: "Analizar la última canción",
    k_open: "abrir", k_analyze: "analizar", table_hint: "↑ ↓ para moverte", f_preset: "Preajuste",
    d_song: "Canción", d_point: "Timing point", d_offset: "Offset", d_beat: "Duración del beat", d_meter: "Compás",
    d_conf: "Confianza", d_span: "Gobierna", d_until: "hasta {t}", d_end: "hasta el final", d_bars: "{n} compases",
    d_duration: "Duración", d_first: "Primer beat", d_engine: "Motor", d_residual: "Residuo de la rejilla",
    d_pulse: "Pulso", d_sections: "Secciones de rejilla", d_hint: "Elegí un timing point en la lista o en el mapa de tempo para inspeccionarlo.",
    d_meter_known: "Compás hallado en los acentos: esta línea roja cae en un downbeat.",
    d_meter_guess: "Sin evidencia de compás: la línea roja cae en un beat y el compás es el valor por defecto.",
    lg_tempo: "tempo", lg_points: "timing points", lg_onsets: "ataques",
    table_title: "Timing points", col_offset: "Offset (ms)", col_beat: "Beat (ms)", col_meter: "Compás", col_conf: "Confianza",
    detection: "Ajustes de detección", preset_variable: "Tempo variable", preset_steady: "Estable",
    f_delta: "Cambio mínimo (BPM)", f_persist: "Beats de confirmación", f_conf: "Confianza mínima (%)", f_pulse: "Pulso (octava)", auto: "Auto",
    t_prefer: "Preferir BPM de mapa (120–300)", t_refine: "Re-anclar beats a transitorios",
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
    import_folder: "Importar carpeta…",
    imported: "Carpeta: {audio} + {n} {difficulties}.",
    difficulties: "dificultades",
    no_audio: "Esa carpeta no tiene audio legible — sus mapas igual sirven para comparar.",
    bad_folder: "Elegí primero una carpeta real.",
    done: "Listo: {n} timing points · {bpm} BPM", rescaled: "Pulso ×{f}: {n} timing points · {bpm} BPM",
    error: "Error: {detail}",
  },
};

const S = { lang: "en", view: "library", mapset: null, file: null, options: null, presets: {}, result: null, busy: false, selected: -1, locks: [], compare: null, comparePath: null, align: null, density: null, recent: [] };
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
  renderNeedSong();
  renderMapset();
  if (S.result) renderResult(S.result);
  if (S.busy) $("analyzeText").textContent = t("analyzing");
}

// ------------------------------------------------------------------ views
// One analysed song is shared by every view: switching only changes what is
// visible, never the session. Views that read the analysis show the
// "analyze first" panel until there is one, instead of blank space.
const VIEWS = ["library", "timing", "mapcheck", "mapset", "export"];
const VIEW_LABEL = { library: "nav_library", timing: "nav_timing", mapcheck: "nav_mapcheck", mapset: "nav_mapset", export: "nav_export" };

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
  if (view === "timing" && S.result) drawTrace();
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
  ["copyOsuBtn", "csvBtn", "clickBtn", "oszBtn", "injectBtn", "cmpPick", "alignPick", "denPick"].forEach((id) => { $(id).disabled = !on; });
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
  if (!folder) return;
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
            [t("d_engine"), t(r.engine === "precision" ? "engine_precision" : "engine_legacy")],
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
  try {
    await navigator.clipboard.writeText(reply.text);
    toast(t("copied"));
    return;
  } catch (err) {
    // A local file page may not get the async clipboard; the legacy path works.
    const box = document.createElement("textarea");
    box.value = reply.text;
    document.body.appendChild(box);
    box.select();
    try {
      if (!document.execCommand("copy")) throw new Error("execCommand");
      toast(t("copied"));
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
    <div class="card-head" style="padding-left:0">
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
    ${shown.length ? `<div class="card-sub" style="margin-top:10px">${t("align_uncovered")} ${shown.map((ms) => ms.toFixed(1)).join(", ")}${rest > 0 ? ` ${t("align_more", { n: rest })}` : ""}</div>` : ""}`;
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
}

function msValue(value) {
  if (value === null || value === undefined) return `<span class="card-sub">${t("ms_not_set")}</span>`;
  if (value === "") return `<span class="card-sub">${t("ms_empty_value")}</span>`;
  return esc(value);
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
    <div class="card-sub" style="margin-top:10px">${t("ms_density_note")}</div>`;

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
const C = {
  plot: "#0e1320", grid: "#1a2233", gridText: "#606b80", tempo: "#7f9df0", fill: "rgba(127,157,240,0.10)",
  onset: "#1e2739", red: "#e0606c", redSoft: "rgba(224,96,108,0.16)", section: "rgba(255,255,255,0.018)",
  selected: "rgba(79,192,138,0.08)", cursor: "rgba(232,236,242,0.35)",
};
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

  const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;
  const dur = Math.max(r.duration, 1e-3);
  const X = (s) => x0 + (s / dur) * (x1 - x0);

  // y range: robust to the few wild local fits at a section edge
  const vals = r.trace.bpm.filter((v) => v > 0).slice().sort((a, b) => a - b);
  const pts = r.points.map((p) => p.bpm);
  let lo = vals.length ? vals[Math.floor(vals.length * 0.02)] : Math.min(...pts);
  let hi = vals.length ? vals[Math.floor(vals.length * 0.98)] : Math.max(...pts);
  lo = Math.min(lo, ...pts); hi = Math.max(hi, ...pts);
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const padY = (hi - lo) * 0.12; lo -= padY; hi += padY;
  const Y = (b) => y1 - ((b - lo) / (hi - lo)) * (y1 - y0);
  geom = { x0, x1, y0, y1, dur, X, Y, lo, hi };

  // plot background
  ctx.fillStyle = C.plot;
  roundRect(ctx, x0, y0 - 22, x1 - x0, y1 - y0 + 22, 14); ctx.fill();
  ctx.save(); roundRect(ctx, x0, y0 - 22, x1 - x0, y1 - y0 + 22, 14); ctx.clip();

  // section shading (alternating) and the selected point's span
  const bounds = r.points.map((p) => p.offset_ms / 1000).concat([dur]);
  r.points.forEach((p, i) => {
    const a = X(bounds[i]), b = X(bounds[i + 1]);
    if (i === S.selected) { ctx.fillStyle = C.selected; ctx.fillRect(a, y0 - 22, b - a, y1 - y0 + 22); }
    else if (i % 2 === 1) { ctx.fillStyle = C.section; ctx.fillRect(a, y0 - 22, b - a, y1 - y0 + 22); }
  });

  // onset bed along the bottom third
  const on = r.onset.v, span = r.onset.span_s || dur;
  if (on.length) {
    ctx.fillStyle = C.onset;
    const bedH = (y1 - y0) * 0.26, bw = Math.max((x1 - x0) / on.length, 1);
    for (let i = 0; i < on.length; i++) {
      const h = on[i] * bedH;
      if (h < 0.6) continue;
      ctx.fillRect(X((i / on.length) * span), y1 - h, bw * 0.8, h);
    }
  }

  // horizontal grid + labels
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--mono")}`;
  const ystep = niceStep(hi - lo, 4);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) {
    const y = Y(v);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = C.gridText; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) ctx.fillText(Number.isInteger(v) ? v : v.toFixed(1), x0 - 10, Y(v));

  // time axis
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const tstep = niceStep(dur, Math.max(4, Math.floor((x1 - x0) / 110)));
  for (let s = 0; s <= dur + 1e-6; s += tstep) ctx.fillText(mmss(s), X(s), y1 + 10);

  // tempo curve with a soft fill
  const tt = r.trace.t, bb = r.trace.bpm;
  if (tt.length > 1 && bb.length === tt.length) {
    ctx.save(); roundRect(ctx, x0, y0 - 22, x1 - x0, y1 - y0 + 22, 14); ctx.clip();
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

  // red lines with value chips (staggered when they would overlap)
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  let lastRight = [-1e9, -1e9];
  r.points.forEach((p, i) => {
    const x = Math.round(X(p.offset_ms / 1000)) + 0.5;
    ctx.strokeStyle = C.red; ctx.lineWidth = i === S.selected ? 2 : 1.25;
    ctx.beginPath(); ctx.moveTo(x, y0 - 22); ctx.lineTo(x, y1); ctx.stroke();
    const label = p.bpm.toFixed(p.bpm % 1 ? 2 : 0);
    const w = ctx.measureText(label).width + 16;
    const row = x > lastRight[0] + 4 ? 0 : (x > lastRight[1] + 4 ? 1 : 0);
    lastRight[row] = x + w;
    const top = y0 - 20 + row * 24;
    ctx.fillStyle = C.red; roundRect(ctx, x, top, w, 20, 10); ctx.fill();
    ctx.fillStyle = "#1a0b0d"; ctx.fillText(label, x + 8, top + 10.5);
  });

  // hover cursor
  if (hoverX !== undefined && hoverX >= x0 && hoverX <= x1) {
    ctx.strokeStyle = C.cursor; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(hoverX + 0.5, y0 - 22); ctx.lineTo(hoverX + 0.5, y1); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function governing(r, s) {
  let idx = 0;
  r.points.forEach((p, i) => { if (p.offset_ms / 1000 <= s + 1e-9) idx = i; });
  return idx;
}

function onTraceMove(ev) {
  const r = S.result; if (!r || !geom) return;
  const rect = $("trace").getBoundingClientRect(), x = ev.clientX - rect.left;
  const tip = $("tip");
  if (x < geom.x0 || x > geom.x1) { tip.hidden = true; drawTrace(); return; }
  const s = ((x - geom.x0) / (geom.x1 - geom.x0)) * geom.dur;
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
  $("navSettings").onclick = () => openDrawer(true);
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
  $("msPick").onclick = pickMapset;
  $("msRecheck").onclick = () => { if (S.mapset) runMapset(S.mapset.path, false); };
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("injectBtn").onclick = injectOsu;
  wireDrop();
  $("trace").addEventListener("mousemove", onTraceMove);
  $("trace").addEventListener("mouseleave", () => { $("tip").hidden = true; drawTrace(); });
  $("trace").addEventListener("click", (e) => {
    if (!S.result || !geom) return;
    const x = e.clientX - $("trace").getBoundingClientRect().left;
    selectPoint(governing(S.result, ((x - geom.x0) / (geom.x1 - geom.x0)) * geom.dur));
  });
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
  $("version").textContent = st.version;
  if (st.logo) $("logo").src = st.logo;
  applyOptions(st.options);
  setFile(st.file);
  translate();
  setView(S.view);  // Library until an analysis finishes
  syncActions();
  syncLocks();
  if (st.autorun && S.file) analyze();
}

window.addEventListener("pywebviewready", boot);
