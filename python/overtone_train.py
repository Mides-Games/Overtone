"""Overtone's rate and difficulty trainer: a practice copy of one map at speed.

A practice copy keeps what it borrows. One difficulty gives every object it
has, and the only thing that changes is the rate: an object that landed on a
snare in its own map lands on the same snare here, sooner or later. Nothing
is redrawn — not a position, not a curve, not a slider's shape
([`04-ui-ux.md`] §9, decided 2026-10-03 for compilations and applying here
unchanged: a rate change is the same bookkeeping with a different
multiplier).

The reference this phase answers
([`funorange/osu-trainer`](https://github.com/funorange/osu-trainer)) divides
every timestamp by the rate and rounds each on its own, so a map's snapping
decays silently. This module applies the rate to the **grid** instead: each
red line's ``beatLength`` is scaled exactly, every object's time is recomputed
from the beat position it already held, and rounding happens once at the end.
The snap audit (Phase 7) then proves the copy instead of hoping for it.

This module holds the parts that need no audio: the practice document, the
source read through row 25.2's repair pass, the grid scaling with one rule
per timestamp the format has, the HP/CS/AR/OD settlement, the honest target
BPM, and the naming that keeps a copy from passing as the ranked map it came
from. Cutting the audio (26.5), the encoder delay (26.7) and the self-check
against the written audio (26.17) follow in their own rows, as do the output
folder (26.14) and the Train section (26.21).

**Nothing here writes.** The source is opened read-only: a practice copy is
reported against the plan, never against someone else's map.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import overtone as ta
import overtone_combine as tc

#: The practice document's own format. A document from a newer one is refused
#: rather than guessed at, as the compilation document refuses a newer
#: schema: the fields a future version adds are exactly the ones this code
#: would ignore silently.
TRAIN_FORMAT = 1

#: The rates a copy may ask for. Below 0.25x a map is no longer the map, and
#: past 4.0x its timestamps crowd past what the format's integer milliseconds
#: can hold on a long song; both are refused with the window named. Never a
#: division by zero: a rate of 0 is refused where it is read.
RATE_MIN = 0.25
RATE_MAX = 4.0

#: The format the copy writes. Sources are read from v3 up; one version is
#: written, and it is the one osu!stable writes itself.
WRITE_FORMAT = 14

#: Places kept on a time that does not land on a whole millisecond. Whole
#: milliseconds stay whole — what osu!stable reads — and a source that came
#: from lazer keeps its decimals rather than being rounded into place.
WRITE_DECIMALS = 3

#: How the copy's audio is made. Resampling is the default because it is what
#: the game's own DT does and it cannot move an attack relative to the grid;
#: the pitch-kept stretch (26.6) stays a separate row, gated on the attack
#: grade, and is not named here until it passes it.
AUDIO_METHODS = ("resample",)

#: What each of HP/CS/AR/OD may be told to do. ``keep`` leaves the number the
#: mapper wrote, ``scale`` moves AR/OD with the rate through the millisecond
#: windows below, and a number locks the stat to that value. HP and CS are
#: not times, so they move only when locked; ``scale`` on either is refused.
STAT_MODES = ("keep", "scale")

#: The largest timestamp the format's integer milliseconds can hold. A rate
#: below 1.0 pushes every time of the map up, and past this the copy cannot
#: be written; the plan refuses with the ceiling named.
MAX_TIME_MS = float(2 ** 31 - 1)


def _repair(code: str, what: str, fixed: bool = False, **extra) -> dict:
    """One line of the repair log: the code a UI switches on, the sentence a
    person reads, and whether anything was actually done about it."""
    return {"code": code, "what": what, "fixed": bool(fixed), **extra}


def _finite(value) -> float | None:
    """A finite float, or None when the value is not a number at all."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


# ---------------------------------------------------------------------------
# The numbers a rate moves, and the ones it must not (Phase 26, § "Every number")
# ---------------------------------------------------------------------------

def ar_to_ms(ar: float) -> float:
    """An ApproachRate as the preempt milliseconds the player feels.

    ``1800 - 120·AR`` at AR 5 and under, ``1200 - 150·(AR-5)`` above: AR 0 is
    1800 ms, AR 5 is 1200 ms, AR 10 is 450 ms. The reference's own formulas,
    written out so the implementation cannot drift.
    """
    ar = float(ar)
    if ar <= 5.0:
        return 1800.0 - 120.0 * ar
    return 1200.0 - 150.0 * (ar - 5.0)


def ms_to_ar(ms: float) -> float:
    """The ApproachRate a preempt window in milliseconds asks for."""
    ms = float(ms)
    if ms >= 1200.0:
        return (1800.0 - ms) / 120.0
    return 5.0 + (1200.0 - ms) / 150.0


def od_to_ms(od: float) -> float:
    """An OverallDifficulty as its 300 hit window in milliseconds.

    ``79.5 - 6·OD`` in standard, which is the number the player is actually
    choosing when they move OD.
    """
    return 79.5 - 6.0 * float(od)


def ms_to_od(ms: float) -> float:
    """The OverallDifficulty a 300 window in milliseconds asks for."""
    return (79.5 - float(ms)) / 6.0


def _scaled_stat(value: float, rate: float, to_ms, from_ms) -> float:
    """A time-like stat through the rate: to milliseconds, divided, back."""
    return from_ms(to_ms(value) / float(rate))


# ---------------------------------------------------------------------------
# The practice document (Phase 26, row 26.1)
# ---------------------------------------------------------------------------

def _bpms_of(reds: list[dict], last_ms: float | None) -> list[dict]:
    """Every tempo the source map holds, with the span each one governs.

    The dominant BPM is the one governing the longest span — the red line's
    own time to the next red, or to the map's last sound. A *target* BPM is
    only offered when there is one of these; otherwise the plan names them
    all, which is the reference tool's two oldest open bugs answered.
    """
    reds = sorted((p for p in reds if p.get("red") and (p.get("beat_length") or 0) > 0),
                  key=lambda p: float(p["time"]))
    if not reds:
        return []
    end_ms = last_ms if last_ms is not None \
        else max(float(p["time"]) for p in reds)
    bpms: list[dict] = []
    for n, red in enumerate(reds):
        start = float(red["time"])
        stop = float(reds[n + 1]["time"]) if n + 1 < len(reds) else float(end_ms)
        bpm = 60000.0 / float(red["beat_length"])
        bpms.append({"bpm": round(bpm, 4),
                     "from_ms": round(start, 3),
                     "span_ms": round(max(0.0, stop - start), 3)})
    return bpms


def _resolve_rate(reds: list[dict], last_ms: float | None,
                  rate, target_bpm, from_bpm) -> tuple[float | None, dict, list[dict]]:
    """The rate the copy is built at, however it was asked for.

    Returns ``(rate, target, refusals)`` where ``target`` is the JSON the UI
    shows beside the rate field: the BPMs the map has, the rate each would
    take for a target, and the dominant one offered with that number on
    screen.
    """
    bpms = _bpms_of(reds, last_ms)
    target: dict = {"bpms": [row["bpm"] for row in bpms],
                    "dominant_bpm": None, "from_bpm": None, "target_bpm": None}
    if bpms:
        dominant = max(bpms, key=lambda row: (row["span_ms"], -row["from_ms"]))
        target["dominant_bpm"] = dominant["bpm"]
    if rate is not None and target_bpm is not None:
        return None, target, [{"code": "both_rate_and_target",
                               "why": "Give a rate or a target BPM, not both: "
                                      "a target is turned into a rate, and two of them "
                                      "cannot both win."}]
    if rate is not None:
        value = _finite(rate)
        if value is None or not value > 0.0:
            return None, target, [{"code": "rate_not_a_number",
                                   "why": f"The rate ({rate!r}) is not a positive number; "
                                          f"never a division by zero."}]
        if not RATE_MIN - 1e-12 <= value <= RATE_MAX + 1e-12:
            return None, target, [{"code": "rate_out_of_range",
                                   "why": f"The rate ({value:g}) sits outside "
                                          f"{RATE_MIN:g}-{RATE_MAX:g}x, which is the window "
                                          f"a copy may ask for."}]
        return float(value), target, []
    # A target BPM from here on.
    if target_bpm is None:
        value = 1.0
        if not RATE_MIN <= value <= RATE_MAX:
            return None, target, [{"code": "rate_out_of_range",
                                   "why": "The default rate 1x sits outside "
                                          f"{RATE_MIN:g}-{RATE_MAX:g}x."}]
        return 1.0, target, []
    wanted = _finite(target_bpm)
    if wanted is None or not wanted > 0.0:
        return None, target, [{"code": "target_not_a_number",
                               "why": f"The target BPM ({target_bpm!r}) is not a "
                                      f"positive number."}]
    target["target_bpm"] = float(wanted)
    if not bpms:
        return None, target, [{"code": "no_timing",
                               "why": "The map has no red line, so no BPM can be "
                                      "aimed at."}]
    if len({row["bpm"] for row in bpms}) == 1:
        only = bpms[0]["bpm"]
        target["from_bpm"] = only
        value = float(wanted) / float(only)
        if not RATE_MIN - 1e-12 <= value <= RATE_MAX + 1e-12:
            return None, target, [{"code": "rate_out_of_range",
                                   "why": f"Aiming at {wanted:g} BPM from {only:g} BPM "
                                          f"takes {value:g}x, outside "
                                          f"{RATE_MIN:g}-{RATE_MAX:g}x."}]
        for row in bpms:
            row["rate_for_target"] = round(float(wanted) / float(row["bpm"]), 6)
        return value, target, []
    for row in bpms:
        row["rate_for_target"] = round(float(wanted) / float(row["bpm"]), 6)
    if from_bpm is None:
        names = ", ".join(f"{row['bpm']:g} BPM ({row['rate_for_target']:g}x)"
                          for row in bpms)
        return None, target, [{
            "code": "ambiguous_target",
            "why": f"The map holds {len(bpms)} tempi, so a target of {wanted:g} BPM "
                   f"means one rate per tempo — {names} — and the dominant "
                   f"({target['dominant_bpm']:g} BPM) is offered with that number on "
                   f"screen. Pick which BPM it means.",
            "bpms": [row["bpm"] for row in bpms]}]
    base = _finite(from_bpm)
    hit = next((row for row in bpms if abs(row["bpm"] - (base or float('nan'))) <= 0.01),
               None) if base is not None else None
    if hit is None:
        return None, target, [{"code": "unknown_from_bpm",
                               "why": f"{from_bpm!r} BPM is not one the map holds "
                                      f"({', '.join(f'{b:g}' for b in target['bpms'])})."}]
    target["from_bpm"] = hit["bpm"]
    value = float(wanted) / float(hit["bpm"])
    if not RATE_MIN - 1e-12 <= value <= RATE_MAX + 1e-12:
        return None, target, [{"code": "rate_out_of_range",
                               "why": f"Aiming at {wanted:g} BPM from {hit['bpm']:g} BPM "
                                      f"takes {value:g}x, outside {RATE_MIN:g}-{RATE_MAX:g}x."}]
    return value, target, []


def _settle_stats(source: dict, rate: float, stats: dict | None) -> tuple[dict, list[dict], list[dict]]:
    """HP, CS, AR and OD as keep / lock / scale, with the milliseconds shown.

    AR travels as its preempt window and OD as its 300 window: those are the
    numbers a player is choosing, and the reference hides them behind a
    slider. Above AR 10 and OD 10 a stat cannot be written into a ``.osu``,
    which is why the reference has its compensated-map trick (26.10): without
    that row, an unreachable stat refuses with both numbers named rather than
    writing a clamped one and hoping.
    """
    stats = dict(stats or {})
    unknown = sorted(set(stats) - {"hp", "cs", "ar", "od"})
    if unknown:
        raise ValueError(f"Unknown stat(s): {', '.join(unknown)}. "
                         f"Known: hp, cs, ar, od.")
    original = dict(source.get("difficulty", {}))
    mode = source.get("mode")
    settled: dict = {}
    repairs: list[dict] = []
    refusals: list[dict] = []
    for field in ("hp", "cs", "ar", "od"):
        # Keep is the default for all four: scaling a typical AR 9 past 10 is
        # unrepresentable without row 26.10's compensated map, and a default
        # must never refuse a typical map. Scale is an explicit ask, and the
        # refusal it can produce names both numbers and the escape.
        asked = stats.get(field, "keep")
        current = original.get(field)
        if isinstance(asked, (int, float)) and not isinstance(asked, bool):
            value = float(asked)
            if field == "cs" and mode == 3:
                refusals.append({"code": "mania_cs_locked",
                                 "why": "CircleSize is the key count on a mania map; "
                                        "locking it would change what the map is."})
                continue
            if not 0.0 <= value <= 10.0:
                refusals.append({"code": "stat_out_of_range",
                                 "why": f"{field.upper()} locked to {value:g} sits outside "
                                        f"0-10, which is what a .osu can hold."})
                continue
            settled[field] = {"mode": "lock", "value": value, "ms": None}
            if field == "ar":
                settled[field]["ms"] = round(ar_to_ms(value), 2)
            elif field == "od":
                settled[field]["ms"] = round(od_to_ms(value), 2)
            continue
        if asked == "keep":
            settled[field] = {"mode": "keep", "value": current, "ms": None}
            if field == "ar" and current is not None:
                settled[field]["ms"] = round(ar_to_ms(current), 2)
            elif field == "od" and current is not None:
                settled[field]["ms"] = round(od_to_ms(current), 2)
            continue
        if asked == "scale":
            if field in ("hp", "cs"):
                refusals.append({"code": "stat_cannot_scale",
                                 "why": f"{field.upper()} is not a time, so it cannot scale "
                                        f"with the rate; keep it or lock it to a value."})
                continue
            if current is None:
                settled[field] = {"mode": "scale", "value": None, "ms": None}
                repairs.append(_repair(
                    f"difficulty_{field}_unknown",
                    f"The map states no {field.upper()}, so scaling has nothing to "
                    f"move; it is left unset."))
                continue
            to_ms, from_ms = (ar_to_ms, ms_to_ar) if field == "ar" else (od_to_ms, ms_to_od)
            ms = to_ms(current) / float(rate)
            value = from_ms(ms)
            if not 0.0 - 1e-9 <= value <= 10.0 + 1e-9:
                refusals.append({"code": "stat_unreachable",
                                 "why": f"{field.upper()} {current:g} at {rate:g}x asks for "
                                        f"{field.upper()} {value:.2f} ({ms:.0f} ms), past what a "
                                        f".osu can hold (0-10); row 26.10's compensated map "
                                        f"is the escape, and it is not built yet."})
                continue
            settled[field] = {"mode": "scale", "value": value, "ms": round(ms, 2)}
            continue
        refusals.append({"code": "stat_unknown_mode",
                         "why": f"{field.upper()} asks for {asked!r}; give 'keep', 'scale' "
                                f"or a value to lock it to."})
    values = {field: None if row.get("value") is None else round(float(row["value"]), 4)
              for field, row in settled.items()}
    return {"modes": {f: r["mode"] for f, r in settled.items()},
            "values": values,
            "ms": {f: r["ms"] for f, r in settled.items()}}, repairs, refusals


def _practice_name(source: dict, rate: float, naming: dict | None,
                   settled_values: dict | None = None,
                   reds: list[dict] | None = None) -> tuple[dict, list[dict]]:
    """What the copy says it is, so it can never pass as the ranked map.

    The version names the rate (the template may choose the fields), the
    original mapper and difficulty stay credited in ``Tags`` and in the
    report, ``Creator`` stays the original's, and ``BeatmapID``/``BeatmapSetID``
    are blanked: a copy carries no ranked identity.
    """
    naming = dict(naming or {})
    unknown = sorted(set(naming) - {"version", "template"})
    if unknown:
        raise ValueError(f"Unknown naming key(s): {', '.join(unknown)}. "
                         f"Known: version, template.")
    metadata = source.get("metadata", {}) or {}
    version = metadata.get("Version") or source.get("name") or "Practice"
    mapper = metadata.get("Creator") or ""
    bpms = _bpms_of(reds or [], (source.get("objects", {}) or {}).get("last_ms"))
    bpm_text = f"{bpms[0]['bpm']:g}" if len(bpms) == 1 else (
        f"{len({b['bpm'] for b in bpms})} tempi" if bpms else "no tempo")
    settled_stats = dict(settled_values) if settled_values else source.get("difficulty", {}) or {}
    fields = {"version": str(version), "rate": float(rate),
              "bpm": bpm_text, "mapper": str(mapper),
              "ar": settled_stats.get("ar"), "od": settled_stats.get("od"),
              "hp": settled_stats.get("hp"), "cs": settled_stats.get("cs")}
    if naming.get("version") is not None:
        version_text = str(naming["version"])
    elif naming.get("template") is not None:
        try:
            version_text = str(naming["template"]).format(**fields)
        except (KeyError, ValueError) as exc:
            return {"version": None, "tags": None, "creator": mapper,
                    "fields": fields}, [{"code": "naming_template",
                                         "why": f"The naming template cannot be filled: {exc}."}]
    else:
        version_text = f"{version} ({float(rate):g}x)"
    tags = str(metadata.get("Tags") or "")
    tokens = [tok for tok in tags.split() if tok]
    for extra in (mapper, f"{float(rate):g}x", "practice"):
        for word in str(extra).split():
            if word and word not in tokens:
                tokens.append(word)
    return {"version": version_text, "tags": " ".join(tokens), "creator": mapper,
            "fields": {k: (round(v, 4) if isinstance(v, float) else v)
                       for k, v in fields.items()}}, []


def plan_practice(osu, audio=None, rate=None, target_bpm=None, from_bpm=None,
                  stats: dict | None = None, audio_method: str = "resample",
                  naming: dict | None = None) -> dict:
    """One source map as a practice-copy document: the rate, the stats, the names.

    The plan is data before it is a file, as in Phase 25: the source, the rate
    (or the target BPM and which BPM it was computed from), each of HP/CS/AR/OD
    as *keep*, *lock to a value* or *scale with the rate*, the audio method,
    and the naming — JSON beside the cache, so a build is reproducible, a
    report can be re-read without the source, and a ladder (26.16) is one
    document with several rungs.

    A source that will not read comes back *refused*, not raised, so a plan
    can still be shown. What refuses the plan: an unreadable source, a map
    with no objects or no red line, a rate outside 0.25-4.0x (never a
    division by zero), a target BPM on a multi-tempo map until the BPM it
    means is picked, a stat that cannot be represented, a mania key count told
    to move, and a copy some timestamp of which would not fit the format's
    integer milliseconds. A missing song does **not** refuse the plan: the
    grid scaling needs no audio, and the rows that cut audio (26.5) and write
    the folder (26.14) refuse in their turn.
    """
    if audio_method not in AUDIO_METHODS:
        raise ValueError(f"Audio method {audio_method!r} is not one of "
                         f"{', '.join(AUDIO_METHODS)}.")
    try:
        source = tc.read_segment(osu, audio=audio) if audio is not None \
            else tc.read_segment(osu)
    except (OSError, ValueError) as exc:
        source = None
        source_error = str(exc)
    else:
        source_error = None
    repairs: list[dict] = []
    refusals: list[dict] = []
    if source is None or source_error is not None:
        return {"format": TRAIN_FORMAT, "source": None, "rate": None,
                "target": {"bpms": [], "dominant_bpm": None, "from_bpm": None,
                           "target_bpm": None},
                "stats": {"modes": {}, "values": {}, "ms": {}},
                "naming": {"version": None, "tags": None, "creator": None, "fields": {}},
                "audio_method": audio_method,
                "repairs": repairs, "refusals": [
                    {"code": "unreadable", "why": source_error or "The source would not read."}],
                "usable": False}
    repairs.extend({"source": "read", **repair} for repair in source["repairs"])
    refusals.extend({"source": "read", **refusal} for refusal in source["refusals"])
    if source["objects"]["played"] == 0:
        refusals.append({"code": "no_objects",
                         "why": "The map has no object a practice copy could borrow."})
    if source["timing"]["reds"] == 0:
        refusals.append({"code": "no_timing",
                         "why": "The map has no red line, so its beat cannot be kept."})
    # The grid the rate is applied to: read_segment counts the timing but
    # does not keep the points, so the reds are read here, which costs
    # milliseconds and means a saved plan builds the same way tomorrow.
    try:
        reds = [p for p in tc._points_of(ta.read_osu_beatmap(source["osu"]))
                if p["red"] and p["beat_length"] > 0]
    except (OSError, ValueError):
        reds = []
    last_ms = source["objects"].get("last_ms")

    value, target, rate_refusals = _resolve_rate(reds, last_ms, rate, target_bpm, from_bpm)
    refusals.extend(rate_refusals)
    settled, stat_repairs, stat_refusals = _settle_stats(
        source, value if value is not None else 1.0, stats) \
        if not rate_refusals else ({"modes": {}, "values": {}, "ms": {}},
                                   [], [])
    repairs.extend(stat_repairs)
    refusals.extend(stat_refusals)
    names, name_refusals = _practice_name(source, value if value is not None else 1.0,
                                          naming, settled.get("values"),
                                          reds) if not rate_refusals else (
        {"version": None, "tags": None, "creator": None, "fields": {}}, [])
    refusals.extend(name_refusals)

    if value is not None and not refusals:
        # A rate below 1.0 pushes every time of the map up; past the
        # format's integer milliseconds the copy cannot be written.
        latest = max([source["objects"].get("last_ms") or 0.0,
                      source["timing"].get("first_red_ms") or 0.0,
                      source.get("preview_ms") or 0.0]
                     + [float(m) for m in source.get("bookmarks", [])]
                     + [float(p.get("end_ms") or 0.0) for p in source.get("breaks", [])])
        if latest / float(value) > MAX_TIME_MS:
            refusals.append({"code": "past_integer_range",
                             "why": f"At {value:g}x the map's last time "
                                    f"({latest:.0f} ms) would land past the format's "
                                    f"integer milliseconds."})
        if source["audio"]["path"] is None:
            repairs.append(_repair(
                "audio_missing_for_build",
                "The source brings no song, so the grid scales but rows 26.5 and "
                "26.14 (the audio and the folder) will refuse in their turn."))
    plan = {"format": TRAIN_FORMAT,
            "source": {"osu": str(source["osu"]), "name": source["name"],
                       "format": source["format"], "mode": source["mode"],
                       "mode_name": source["mode_name"], "keys": source["keys"],
                       "metadata": source["metadata"], "difficulty": source["difficulty"],
                       "audio": source["audio"], "objects": {
                           "played": source["objects"]["played"],
                           "first_ms": source["objects"]["first_ms"],
                           "last_ms": source["objects"]["last_ms"],
                           "unparsed": source["objects"]["unparsed"]},
                       "timing": {"reds": source["timing"]["reds"],
                                  "greens": source["timing"]["greens"],
                                  "first_red_ms": source["timing"]["first_red_ms"],
                                  "first_bpm": source["timing"]["first_bpm"]},
                       "breaks": source["breaks"], "bookmarks": source["bookmarks"],
                       "preview_ms": source["preview_ms"],
                       "lead_in_ms": source["lead_in_ms"]},
            "rate": value, "target": target, "stats": settled, "naming": names,
            "audio_method": audio_method,
            "repairs": repairs, "refusals": refusals, "usable": not refusals}
    return plan


# ---------------------------------------------------------------------------
# The rate on the grid (Phase 26, rows 26.3 and 26.4)
# ---------------------------------------------------------------------------

def _rate_number(text: str, rate: float, decimals: int = WRITE_DECIMALS) -> str:
    """A time field at the rate: divided once, rounded once.

    Whole milliseconds stay whole — what osu!stable reads — and a source that
    came from lazer keeps its decimals. The rounding happens here and nowhere
    else, so a mapper's own snapping is never re-rounded by arithmetic nobody
    asked for.
    """
    value = round(float(text) / float(rate), decimals)
    whole = round(value)
    if abs(value - whole) < 0.5 * 10 ** -decimals:
        return str(int(whole))
    return f"{value:.{decimals}f}"


def _beat_text(value: float) -> str:
    """A beat length as the file puts it: up to six places, no trailing zeros.

    The rate is applied to the grid, so this number has to be exact: a
    velocity worked out from two multipliers lands on -69.99999999999999 as
    readily as on -70, and "-70.000000" in a file nobody can diff is worse
    than either.
    """
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def _scaled_object_line(raw: str, rate: float, decimals: int) -> str:
    """One object line at the rate, every other character of it untouched.

    The sixth field is three different things and each needs its own rule: a
    slider's curve (geometry, not a time), a spinner's end time, and a mania
    hold's ``end:sample``. The reference tool treats it as a slider end time,
    which is the one thing it never is.
    """
    fields = raw.split(",")
    fields[2] = _rate_number(fields[2], rate, decimals)
    if len(fields) > 5:
        try:
            type_bits = int(fields[3])
        except ValueError:
            type_bits = 0
        if type_bits & 128:                                  # mania hold
            head, colon, tail = fields[5].partition(":")
            fields[5] = _rate_number(head, rate, decimals) + colon + tail
        elif type_bits & 8:                                  # spinner
            fields[5] = _rate_number(fields[5], rate, decimals)
    return ",".join(fields)


def _scaled_timing_line(raw: str, rate: float, decimals: int) -> str:
    """One timing line at the rate. Only the offset always moves.

    A red line's beat length is divided by the rate exactly — BPM is
    ``60000/beatLength``, so this *is* the rate change. A green line's
    ``-100/beatLength`` SV is **unchanged**: SV is a multiplier on a
    beat-relative speed, both the beat and the speed scale, so scroll speed
    rises with the rate on its own — which is what DT feels like.
    ``SliderMultiplier`` and ``SliderTickRate`` never move for the same reason:
    both are beat-relative, and a rate change has one map where a compilation
    mixes several (25.9).
    """
    fields = raw.split(",")
    parsed = ta._timing_point_fields(raw.strip())
    fields[0] = _rate_number(fields[0], rate, decimals)
    if parsed is not None and parsed["red"] and len(fields) > 1:
        try:
            fields[1] = _beat_text(float(fields[1]) / float(rate))
        except ValueError:
            pass
    return ",".join(fields)


def _patch_key_lines(raw_lines: list, updates: dict) -> list[str]:
    """Section lines with some ``Key: value`` rows repointed, byte for byte.

    Everything else — comments, blank lines, unknown keys and the separator
    each line used — comes out as it went in, so a 1.0x copy has nothing to
    say on a line it did not change. A key with no line and a value to carry
    is appended in ``Key:value`` form.
    """
    out: list[str] = []
    done: set[str] = set()
    for raw in raw_lines:
        text = str(raw)
        stripped = text.strip()
        key = stripped.split(":", 1)[0].strip() if ":" in stripped else ""
        if key and not stripped.startswith("//") and updates.get(key) is not None:
            at = text.index(":")
            gap = text[at + 1:len(text) - len(text[at + 1:].lstrip())]
            out.append(f"{text[:at + 1]}{gap}{updates[key]}")
            done.add(key)
            continue
        out.append(text)
    for key, value in updates.items():
        if value is not None and key not in done:
            out.append(f"{key}:{value}")
    # The blank line separating two sections belongs to neither: strip the
    # trailing ones here so the assembler puts exactly one back.
    while out and not out[-1].strip():
        out.pop()
    return out


def _governing(reds: list[dict], at_ms: float) -> dict | None:
    """The red line in force at a time: the last one at or before it, else the
    first in the map (what osu! itself reads before its first timing point)."""
    use = next((p for p in reversed(reds) if float(p["time"]) <= at_ms + 1e-6),
               reds[0] if reds else None)
    return use


def practice_beatmap(plan: dict, decimals: int = WRITE_DECIMALS) -> tuple[str, dict]:
    """The practice copy as one ``.osu``: every borrowed timestamp at the rate.

    What moves, and the rule for each, is the specification this row exists
    for: each red line's ``beatLength`` divided exactly, then every object's
    time recomputed from the beat position it already held and rounded once;
    spinner and mania hold ends by their own rules, every timing offset, the
    breaks, the bookmarks, the preview point, ``AudioLeadIn`` and the event
    lines' break periods. What does not move: a slider's curve (geometry, not
    time), a green line's SV, ``SliderMultiplier`` and ``SliderTickRate``
    (all beat-relative), and the storyboard and video lines, which are carried
    as written and counted rather than scaled into a guess.

    Returns the text and a report carrying the worst snap error in beats and
    in milliseconds, the settled stats with the milliseconds beside every AR
    and OD, and the naming — so a build can be explained afterwards from the
    report alone. Writing the file is row 26.14; this returns text, which is
    also what makes it testable against a reader.
    """
    if not plan.get("usable"):
        why = "; ".join(r.get("why") or r.get("code", "?")
                        for r in plan.get("refusals", ())) or "no reason given"
        raise ValueError(f"This plan refused: {why}")
    if int(plan.get("format") or 0) != TRAIN_FORMAT:
        raise ValueError(f"Plan format {plan.get('format')!r} is not {TRAIN_FORMAT}.")
    rate = float(plan["rate"])
    source_path = plan["source"]["osu"]
    beatmap = ta.read_osu_beatmap(source_path)

    points = tc._points_of(beatmap)
    reds = [p for p in points if p["red"] and p["beat_length"] > 0]
    if not reds:
        raise ValueError("The source has no usable red line.")

    # Every object's beat position in the source, then at the rate: the grid
    # is the thing being scaled, and the milliseconds are a rendering of it.
    # The written times are the rounded ones, so the error reported is the
    # error osu! reads, not the error the floats hold.
    timing_lines: list[tuple] = []
    beat_worst, ms_worst = 0.0, 0.0
    for point in points:
        raw = str(point["raw"])
        line = _scaled_timing_line(raw, rate, decimals)
        at = float(_rate_number(str(point["time"]), rate, decimals))
        timing_lines.append((at, 0 if point["red"] else 1, line))

    object_lines: list[tuple] = []
    unparsed = 0
    for obj in beatmap.get("hitobjects", []):
        if obj.get("kind") == "unparsed":
            unparsed += 1
            continue
        time = float(obj["time"])
        governing = _governing(reds, time)
        beat = float(governing["beat_length"])
        red_at = float(governing["time"])
        beats = (time - red_at) / beat
        # The same arithmetic the file performs: the red's scaled offset and
        # beat length, stepped by the beats the object already held.
        new_red_at = float(_rate_number(str(red_at), rate, decimals))
        new_beat = float(_beat_text(beat / rate))
        exact = new_red_at + beats * new_beat
        written = float(_rate_number(str(time), rate, decimals))
        err_beats = abs((written - new_red_at) / new_beat - beats)
        beat_worst = max(beat_worst, err_beats)
        ms_worst = max(ms_worst, abs(written - exact))
        object_lines.append((written, 0, _scaled_object_line(
            str(obj["raw"]).strip(), rate, decimals)))
    timing_lines.sort(key=lambda row: (row[0], row[1]))
    object_lines.sort(key=lambda row: row[0])

    section_lines = {s.get("name"): [str(line) for line in s.get("lines", [])]
                     for s in beatmap.get("sections", [])}
    general_updates: dict = {}
    if "AudioLeadIn" in beatmap.get("general", {}):
        general_updates["AudioLeadIn"] = str(int(round(
            float(beatmap["general"].get("AudioLeadIn") or 0.0) / rate)))
    if beatmap.get("general", {}).get("PreviewTime") is not None:
        try:
            preview_ms = None if float(beatmap["general"]["PreviewTime"]) < 0 \
                else float(_rate_number(str(beatmap["general"]["PreviewTime"]),
                                        rate, decimals))
        except ValueError:
            preview_ms = None
        general_updates["PreviewTime"] = str(
            -1 if preview_ms is None else int(round(preview_ms)))

    editor_updates: dict = {}
    if "Bookmarks" in beatmap.get("editor", {}):
        marks: list[str] = []
        for text in str(beatmap["editor"].get("Bookmarks", "")).split(","):
            text = text.strip()
            if not text:
                continue
            try:
                marks.append(_rate_number(text, rate, decimals))
            except ValueError:
                continue
        marks.sort(key=float)
        editor_updates["Bookmarks"] = ",".join(marks)

    metadata_updates = {"Version": plan["naming"]["version"],
                        "Creator": plan["naming"]["creator"]
                                   or beatmap.get("metadata", {}).get("Creator", ""),
                        "Tags": plan["naming"]["tags"]
                                or beatmap.get("metadata", {}).get("Tags", ""),
                        "BeatmapID": "0", "BeatmapSetID": "-1"}
    difficulty_updates: dict = {}
    for field, key in (("hp", "HPDrainRate"), ("cs", "CircleSize"),
                       ("od", "OverallDifficulty"), ("ar", "ApproachRate")):
        value = plan["stats"]["values"].get(field)
        if value is not None:
            difficulty_updates[key] = f"{float(value):g}"

    event_lines: list[str] = []
    breaks = 0
    kept_other = 0
    for raw in section_lines.get("Events", []):
        text = str(raw).strip()
        if not text:
            continue
        if text.startswith("//"):
            event_lines.append(str(raw))
            continue
        fields = [f.strip() for f in text.split(",")]
        if fields[0] in ("2", "Break") and len(fields) >= 3:
            try:
                float(_rate_number(fields[1], rate, decimals))
                float(_rate_number(fields[2], rate, decimals))
            except ValueError:
                event_lines.append(str(raw))
                continue
            event_lines.append(f"2,{_rate_number(fields[1], rate, decimals)},"
                               f"{_rate_number(fields[2], rate, decimals)}")
            breaks += 1
        else:
            event_lines.append(str(raw))
            kept_other += 1

    # The file in its own order, each section patched where the rate or the
    # naming reaches it and verbatim everywhere else — including sections
    # this phase knows nothing about (colours, variables), which are carried,
    # never dropped. A 1.0x copy is the source bar the version, tags and IDs
    # it is required to change.
    out: list[str] = [f"osu file format v{int(beatmap.get('format') or WRITE_FORMAT)}", ""]
    for section in beatmap.get("sections", []):
        name = section.get("name")
        out.append(f"[{name}]")
        if name == "General":
            out.extend(_patch_key_lines(section_lines.get(name, []), general_updates))
        elif name == "Editor":
            out.extend(_patch_key_lines(section_lines.get(name, []), editor_updates))
        elif name == "Metadata":
            out.extend(_patch_key_lines(section_lines.get(name, []), metadata_updates))
        elif name == "Difficulty":
            out.extend(_patch_key_lines(section_lines.get(name, []), difficulty_updates))
        elif name == "Events":
            out.extend(event_lines if event_lines else ["//Background and Video events"])
        elif name == "TimingPoints":
            out.extend(line for _at, _red, line in timing_lines)
        elif name == "HitObjects":
            out.extend(line for _at, _red, line in object_lines)
        else:
            lines = [str(line) for line in section_lines.get(name, [])]
            while lines and not lines[-1].strip():
                lines.pop()
            out.extend(lines)
        out.append("")
    text = "\r\n".join(out)

    report = {"rate": rate, "objects": len(object_lines), "unparsed": unparsed,
              "reds": len(reds), "greens": len(points) - len(reds),
              "worst_beat_error": beat_worst, "worst_ms_error": ms_worst,
              "stats": plan["stats"], "naming": plan["naming"],
              "breaks": breaks, "events_kept": kept_other,
              "notes": ([{"code": "objects_dropped",
                          "what": f"{unparsed} object line(s) that do not read as objects "
                                  f"were left out: a line with no time cannot be placed."}]
                        if unparsed else [])}
    return text, report


def describe_target(plan: dict) -> str:
    """The target-BPM line the UI shows: one BPM, or every BPM with its rate."""
    target = plan.get("target", {})
    bpms = target.get("bpms", [])
    if not bpms:
        return "The map holds no tempo to aim at."
    if len(set(bpms)) == 1:
        return f"{bpms[0]:g} BPM."
    rows = ", ".join(f"{b:g} BPM" for b in bpms)
    return (f"The map holds {len(bpms)} tempi ({rows}); the dominant "
            f"({target.get('dominant_bpm')}) is offered with that rate on screen.")
