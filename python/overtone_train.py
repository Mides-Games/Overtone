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

This module holds the whole copy bar the app section: the practice document,
the source read through row 25.2's repair pass, the grid scaling with one
rule per timestamp the format has, the HP/CS/AR/OD settlement, the honest
target BPM, the naming that keeps a copy from passing as the ranked map it
came from, the song resampled in process (26.5) with the encoder delay
measured rather than assumed (26.7), the self-check that grades the written
red lines against the written audio (26.17), the output folder straight
into `Songs` (26.14), and rate ladders as one mapset with one audio file per
distinct rate (26.16). The Train section itself (26.21) is the app's.

**Nothing here touches the source.** It is opened read-only even to fix it:
a repair is recorded against the plan, never against someone else's map.
Overwriting a source file, or an existing `.bak`, is refused outright.
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

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


def od_windows(od: float) -> dict:
    """The 300/100/50 hit windows in milliseconds for a standard OD.

    Standard only: taiko, catch and mania read their own windows, and a
    number from another mode's table would be the one thing on the screen
    that is not exact.
    """
    od = float(od)
    return {"300": round(79.5 - 6.0 * od, 2),
            "100": round(139.5 - 8.0 * od, 2),
            "50": round(199.5 - 10.0 * od, 2)}


#: What each mod does, in the order the game applies it: the number first
#: (HR/EZ), then the speed (DT/NC/HT). A rate change is only right if the
#: arithmetic is shown, so every row carries the sentence the UI prints.
MODS: dict = {
    "HR": {"kind": "number", "factor": 1.4,
           "says": "HR ×1.4 on HP, CS, AR and OD (the game caps at 10)"},
    "EZ": {"kind": "number", "factor": 0.5,
           "says": "EZ ×0.5 on HP, CS, AR and OD"},
    "DT": {"kind": "speed", "factor": 1.5,
           "says": "DT plays at 1.5x speed: approach and hit windows ÷1.5"},
    "NC": {"kind": "speed", "factor": 1.5,
           "says": "NC plays at 1.5x speed, like DT"},
    "HT": {"kind": "speed", "factor": 0.75,
           "says": "HT plays at 0.75x speed: approach and hit windows ÷0.75"},
}


def _check_mods(mods) -> tuple[list[str] | None, list[dict]]:
    """Mod names as a list, or the refusal for an unknown or contradictory one.

    DT and NC are the same speed, so naming both is naming it twice; HT
    against either is two speeds at once, which no game plays.
    """
    names = [str(mod).upper() for mod in (mods or [])]
    unknown = sorted(set(names) - set(MODS))
    if unknown:
        return None, [{"code": "unknown_mod",
                       "why": f"Mod(s) {', '.join(unknown)} are not HR, EZ, DT, NC or HT."}]
    if "HT" in names and ("DT" in names or "NC" in names):
        return None, [{"code": "contradictory_mods",
                       "why": "Half Time against Double Time is two speeds at once; "
                              "pick the speed the copy is for."}]
    seen: list[str] = []
    for name in names:
        if name == "NC" and "DT" in seen:
            continue
        if name == "DT" and "NC" in seen:
            continue
        if name not in seen:
            seen.append(name)
    return seen, []


def _scaled_stat(value: float, rate: float, to_ms, from_ms) -> float:
    """A time-like stat through the rate: to milliseconds, divided, back."""
    return from_ms(to_ms(value) / float(rate))


def _mod_factors(mods: list[str]) -> tuple[float, float]:
    """The number and speed factors the active mods compose to."""
    number, speed = 1.0, 1.0
    for name in mods or []:
        spec = MODS[name]
        if spec["kind"] == "number":
            number *= spec["factor"]
        else:
            speed *= spec["factor"]
    return number, speed


def mod_feel(field: str, written: float | None, mods: list[str]) -> dict:
    """What a written stat feels like with the mods on: the number the player
    gets, the milliseconds beside it, and the arithmetic in words.

    A lock names the feel and the file carries the compensation (row 26.10's
    reference trick); keep and scale name the file and the feel follows. Past
    10 a feel has no number — only the game does that, and only milliseconds
    are exact there — and an HR feel past 10 is capped where the game caps it.
    """
    number_f, speed_f = _mod_factors(mods or [])
    to_ms, from_ms = (ar_to_ms, ms_to_ar) if field == "ar" else \
                     (od_to_ms, ms_to_od) if field == "od" else (None, None)
    if written is None:
        return {"written": None, "feel": None, "feel_ms": None,
                "capped": False, "arithmetic": []}
    arithmetic = [MODS[name]["says"] for name in mods or []]
    if to_ms is None:
        feel = float(written) * number_f
        capped = feel > 10.0
        return {"written": round(float(written), 4),
                "feel": round(min(feel, 10.0), 4), "feel_ms": None,
                "capped": bool(capped), "arithmetic": arithmetic}
    feel_ms = to_ms(min(float(written) * number_f, 10.0)) / speed_f
    feel = from_ms(feel_ms) if feel_ms >= to_ms(10.0) - 1e-9 else None
    if feel is not None and feel > 10.0:
        feel = None                      # past 10: milliseconds only
    return {"written": round(float(written), 4),
            "feel": None if feel is None else round(feel, 4),
            "feel_ms": round(feel_ms, 2),
            "capped": number_f != 1.0 and float(written) * number_f > 10.0,
            "arithmetic": arithmetic}


def mod_compensate(field: str, feel: float, mods: list[str]) -> tuple[float | None, dict]:
    """The number to write so the feel lands where it was asked, or why not.

    The reference's trick with the arithmetic shown: invert the number, then
    the speed. A combination no `.osu` can hold refuses naming the feel, the
    mods and the number it would take.
    """
    number_f, speed_f = _mod_factors(mods or [])
    to_ms, from_ms = (ar_to_ms, ms_to_ar) if field == "ar" else \
                     (od_to_ms, ms_to_od) if field == "od" else (None, None)
    if to_ms is None:
        written = float(feel) / number_f
    else:
        written = from_ms(to_ms(float(feel)) * speed_f) / number_f
    if not 0.0 - 1e-9 <= written <= 10.0 + 1e-9:
        return None, {"code": "mod_unreachable",
                      "why": f"{field.upper()} {feel:g} under "
                             f"{'+'.join(mods) or 'no mods'} asks for {field.upper()} "
                             f"{written:.2f} in the file, past what a .osu can hold (0-10); "
                             f"no combination reaches it."}
    if number_f != 1.0 and written * number_f > 10.0 + 1e-9:
        # The game caps the multiplied number at 10 first, so the feel would
        # never arrive: writing it anyway would be the clamped hope the phase
        # refuses to ship.
        return None, {"code": "mod_unreachable",
                      "why": f"{field.upper()} {feel:g} under {'+'.join(mods)} caps at 10 "
                             f"in the game before the speed applies, so the feel would "
                             f"never arrive; no combination reaches it."}
    return written, {}


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


def _settle_stats(source: dict, rate: float, stats: dict | None,
                  mods: list[str] | None = None) -> tuple[dict, list[dict], list[dict]]:
    """HP, CS, AR and OD as keep / lock / scale, with the milliseconds shown.

    AR travels as its preempt window and OD as its 300 window: those are the
    numbers a player is choosing, and the reference hides them behind a
    slider. A lock names the **feel** and the file carries the compensation
    (row 26.10's reference trick, with the arithmetic beside it); keep and
    scale name the file and the feel follows the mods. What cannot be written
    refuses with both numbers named rather than writing a clamped one.
    """
    stats = dict(stats or {})
    mods = list(mods or [])
    unknown = sorted(set(stats) - {"hp", "cs", "ar", "od"})
    if unknown:
        raise ValueError(f"Unknown stat(s): {', '.join(unknown)}. "
                         f"Known: hp, cs, ar, od.")
    original = dict(source.get("difficulty", {}))
    mode = source.get("mode")
    _number_f, speed_f = _mod_factors(mods)
    settled: dict = {}
    repairs: list[dict] = []
    refusals: list[dict] = []
    for field in ("hp", "cs", "ar", "od"):
        # Keep is the default for all four: scaling a typical AR 9 past 10 is
        # unrepresentable without a mod that brings it back, and a default
        # must never refuse a typical map. Scale is an explicit ask, and the
        # refusal it can produce names both numbers and the escape.
        asked = stats.get(field, "keep")
        current = original.get(field)
        felt = mod_feel(field, current, mods) if current is not None \
            else mod_feel(field, None, mods)
        if isinstance(asked, (int, float)) and not isinstance(asked, bool):
            feel_ask = float(asked)
            if field == "cs" and mode == 3:
                refusals.append({"code": "mania_cs_locked",
                                 "why": "CircleSize is the key count on a mania map; "
                                        "locking it would change what the map is."})
                continue
            time_like = field in ("ar", "od")
            if not 0.0 <= feel_ask and (feel_ask <= 10.0 or speed_f != 1.0) \
                    and (not time_like or _feel_ms(field, feel_ask) > 0.0):
                refusals.append({"code": "stat_out_of_range",
                                 "why": f"{field.upper()} {feel_ask:g} as a feel sits outside "
                                        f"what these mods can mean (0-10"
                                        f"{', past 10 only with a speed mod' if speed_f == 1.0 else ''}); "
                                        f"a .osu holds 0-10."})
                continue
            written, bad = mod_compensate(field, feel_ask, mods)
            if bad:
                refusals.append(bad)
                continue
            felt = mod_feel(field, written, mods)
            settled[field] = {"mode": "lock", "value": written,
                              "ms": felt["feel_ms"], "feel": felt}
            continue
        if asked == "keep":
            settled[field] = {"mode": "keep", "value": current,
                              "ms": felt["feel_ms"]
                              if field in ("ar", "od") else None,
                              "feel": felt}
            continue
        if asked == "scale":
            if field in ("hp", "cs"):
                refusals.append({"code": "stat_cannot_scale",
                                 "why": f"{field.upper()} is not a time, so it cannot scale "
                                        f"with the rate; keep it or lock it to a value."})
                continue
            if current is None:
                settled[field] = {"mode": "scale", "value": None, "ms": None,
                                  "feel": mod_feel(field, None, mods)}
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
                                        f".osu can hold (0-10); lock that feel with a speed mod "
                                        f"(DT) that brings it back into range, or keep it."})
                continue
            felt = mod_feel(field, value, mods)
            settled[field] = {"mode": "scale", "value": value,
                              "ms": felt["feel_ms"], "feel": felt}
            continue
        refusals.append({"code": "stat_unknown_mode",
                         "why": f"{field.upper()} asks for {asked!r}; give 'keep', 'scale' "
                                f"or a value to lock it to."})
    values = {field: None if row.get("value") is None else round(float(row["value"]), 4)
              for field, row in settled.items()}
    return {"modes": {f: r["mode"] for f, r in settled.items()},
            "values": values,
            "ms": {f: r["ms"] for f, r in settled.items()},
            "feel": {f: r["feel"] for f, r in settled.items()}}, repairs, refusals


def _feel_ms(field: str, feel: float) -> float:
    """The window a feel asks for, to check it stays positive."""
    to_ms = ar_to_ms if field == "ar" else od_to_ms
    return to_ms(float(feel))


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
                  naming: dict | None = None, mods=None) -> dict:
    """One source map as a practice-copy document: the rate, the stats, the names.

    The plan is data before it is a file, as in Phase 25: the source, the rate
    (or the target BPM and which BPM it was computed from), each of HP/CS/AR/OD
    as *keep*, *lock to a value* or *scale with the rate*, the mods a player
    enables (HR/EZ/DT/NC/HT, with the arithmetic shown and a compensated file
    where a locked feel needs one), the audio method,
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
                "stats": {"modes": {}, "values": {}, "ms": {}, "feel": {}},
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
    if isinstance(mods, str):
        mods = [mods]
    checked_mods, mod_refusals = _check_mods(mods) if not rate_refusals else (None, [])
    refusals.extend(mod_refusals)
    settled, stat_repairs, stat_refusals = _settle_stats(
        source, value if value is not None else 1.0, stats, checked_mods) \
        if not rate_refusals and not mod_refusals else (
            {"modes": {}, "values": {}, "ms": {}, "feel": {}}, [], [])
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
                       "lead_in_ms": source["lead_in_ms"],
                       "samples": source["samples"]},
            "rate": value, "target": target, "stats": settled, "naming": names,
            "mods": checked_mods if checked_mods is not None else [],
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


# ---------------------------------------------------------------------------
# The audio by resample, and the proof it landed (Phase 26, rows 26.5, 26.7, 26.17)
# ---------------------------------------------------------------------------

#: What the copy's song is written as, and what it is not. MP3 is the default
#: because it is measured gapless here (row 25.5: libsndfile 1.2.2 encodes
#: through LAME 3.100, writes the gapless tag and strips it again on read, so
#: a click written at *t* comes back at *t*); WAV is offered for a lossless
#: check. Ogg Vorbis is not offered for the reason row 25.4 measured: writing
#: more than about ten seconds of 44.1 kHz stereo kills this libsndfile build.
AUDIO_FORMATS: dict = {
    "mp3": {"format": "MP3", "subtype": "MPEG_LAYER_III"},
    "wav": {"format": "WAV", "subtype": "PCM_16"},
}
DEFAULT_AUDIO_FORMAT = "mp3"

#: A song longer than this is refused rather than resampled: the resample
#: runs in one piece, and past an hour the peak working set stops being a
#: practice copy's business.
MAX_AUDIO_S = 3600.0

#: How much of the song the audio check correlates. The resample is one
#: linear operation, so a shift anywhere is a shift everywhere; the first
#: thirty seconds prove it without a second full decode.
VERIFY_WINDOW_S = 30.0

#: A copy whose song lands further than this from where the rate puts it
#: fails the check. The arithmetic is sample-exact, so this is a tripwire for
#: a wrong assumption, not a tolerance anybody should need.
VERIFY_TOLERANCE_MS = 1.0

#: The write log's name for this operation, so History lists a practice copy
#: beside every other write.
WRITE_OP = "train"

#: Sample files live in this namespace: ``set-hitnormal.wav`` and friends.
#: The copy keeps its indices (one map, unlike a compilation's remap), so
#: these travel under their own names.
_SAMPLE_NAME = re.compile(r"^(normal|soft|drum)-.*\.(wav|mp3|ogg)$", re.IGNORECASE)

#: Pictures travel; moving pictures do not. A background is still the same
#: picture at another speed, but a video at 1.37x is a desync the copy would
#: own, so videos stay behind with a note saying so.
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")
_VIDEO_SUFFIXES = (".avi", ".mp4", ".mpg", ".mpeg", ".mkv")


def _resample_song(block, source_rate: int, rate: float):
    """The whole song at the rate, each channel the same way.

    soxr at the rate ratio, in process — no child executable — because it is
    the speed change that cannot move an attack relative to the grid: both
    the beat and the sound scale together, which is what the game's own DT
    does. Measured onset-exact on smooth attacks (this machine, librosa
    1.0.0: soxr, polyphase and Fourier resampling agree to the frame on
    raised-cosine onsets; an abrupt synthetic burst's *peak* reshapes under
    any of the three while its edge stays, which is filter ringing, not a
    shift). The grade in :func:`grade_copy` keeps this honest per build.
    """
    import librosa

    data = np.asarray(block, dtype="float32")
    single = data.ndim == 1
    # librosa resamples along the last axis: channels first on the way in.
    # Faster means fewer frames at the same rate, so the target rate is the
    # source's divided by the rate — a 1.37x copy of a 20 s song runs 14.6 s.
    wide = data[None, :] if single else np.ascontiguousarray(data.T)
    out = librosa.resample(wide, orig_sr=float(source_rate),
                           target_sr=float(source_rate) / float(rate))
    narrow = np.asarray(out[0] if single else np.ascontiguousarray(out.T),
                        dtype="float32")
    return narrow


def build_audio(plan: dict, path: str | os.PathLike[str], *,
                audio_format: str = DEFAULT_AUDIO_FORMAT,
                progress=None) -> dict:
    """The source's song at the plan's rate, as one audio file.

    The whole song, start to finish — a practice copy never cuts — resampled
    in one piece and written with nothing normalised, nothing filtered and no
    fade: past the resample the samples are the rate change and nothing else.
    ``progress(step, done, total)`` is called around the resample and the
    encode, so a window has something to show.
    """
    if not plan.get("usable"):
        why = "; ".join(r.get("why") or r.get("code", "?")
                        for r in plan.get("refusals", ())) or "no reason given"
        raise ValueError(f"This plan refused: {why}")
    if int(plan.get("format") or 0) != TRAIN_FORMAT:
        raise ValueError(f"Plan format {plan.get('format')!r} is not {TRAIN_FORMAT}.")
    if audio_format not in AUDIO_FORMATS:
        raise ValueError(f"Unknown audio format {audio_format!r}. "
                         f"Known: {', '.join(AUDIO_FORMATS)}.")
    source = plan["source"]["audio"]["path"]
    if not source:
        raise ValueError(f"{plan['source']['name']} has no song to resample; "
                         f"the grid scales without audio, the audio does not.")
    rate = float(plan["rate"])
    try:
        info = ta.sf.info(str(source))
    except Exception as exc:                       # libsndfile raises its own types
        raise ValueError(f"Could not read {Path(source).name}: {exc}") from exc
    if info.frames / info.samplerate > MAX_AUDIO_S:
        raise ValueError(f"The song runs {info.frames / info.samplerate / 60.0:.0f} minutes, "
                         f"past the {MAX_AUDIO_S / 60.0:.0f}-minute ceiling a resample is done in.")
    if progress is not None:
        progress("audio", 0, 2)
    data, source_rate = ta.sf.read(str(source), dtype="float32", always_2d=True)
    data = _resample_song(data, int(source_rate), rate)
    if progress is not None:
        progress("audio", 1, 2)
    out = Path(path)
    with ta.sf.SoundFile(str(out), mode="w", samplerate=int(source_rate),
                         channels=int(data.shape[1]),
                         **AUDIO_FORMATS[audio_format]) as sink:
        sink.write(data)
    if progress is not None:
        progress("audio", 2, 2)
    return {"path": str(out), "name": out.name, "format": audio_format,
            "method": "resample", "rate": rate,
            "sample_rate": int(source_rate), "channels": int(data.shape[1]),
            "frames": int(data.shape[0]),
            "duration_ms": round(data.shape[0] / float(source_rate) * 1000.0, 3),
            "source_ms": round(info.frames / float(info.samplerate) * 1000.0, 3),
            "bytes": out.stat().st_size}


def verify_audio(plan: dict, audio_path: str | os.PathLike[str],
                 window_s: float = VERIFY_WINDOW_S,
                 tolerance_ms: float = VERIFY_TOLERANCE_MS) -> dict:
    """Where the resampled song actually landed, read back out of the file.

    Three questions, each answered from the files: does the written song run
    as long as the rate says (to two frames), does its start correlate with
    the source's start resampled the same way (the audio swap's own aligner),
    and what does the encoder's own gapless tag say. A wrong assumption about
    a resampler's offset, a frame count or an encoder's delay shows up here
    as a shift, which is the only way row 26.7 can be said to hold rather
    than hoped to.
    """
    out = Path(audio_path)
    source = plan["source"]["audio"]["path"]
    rate = float(plan["rate"])
    gapless = ta.mp3_gapless_info(out)
    try:
        mine_info = ta.sf.info(str(out))
        their_info = ta.sf.info(str(source))
    except Exception as exc:                       # libsndfile raises its own types
        return {"path": str(out), "checked": False, "why": str(exc),
                "gapless": gapless, "ok": False}
    out_rate = int(mine_info.samplerate)
    expected_frames = their_info.frames / rate
    length_ok = abs(mine_info.frames - expected_frames) <= 2.0
    shift_ms, peak, why = None, None, None
    if out_rate % 11025:
        why = (f"{out_rate} Hz is not a multiple of 11025, which the aligner "
               f"downsamples to; correlating it would measure the aligner.")
    else:
        try:
            span = min(float(window_s), their_info.frames / their_info.samplerate)
            take = int(span * their_info.samplerate)
            theirs = ta.sf.read(str(source), dtype="float32", always_2d=True,
                                start=0, stop=take)[0]
            theirs = _resample_song(theirs, int(their_info.samplerate), rate)
            frames = min(len(theirs), int(span / rate * out_rate))
            mine = ta.sf.read(str(out), dtype="float32", always_2d=True,
                              start=0, stop=frames)[0]
            found = ta.shift_samples(np.asarray(theirs[:frames].mean(axis=1),
                                                dtype="float64"),
                                     np.asarray(mine[:frames].mean(axis=1),
                                                dtype="float64"),
                                     out_rate)
            shift_ms, peak = found["shift_ms"], found["peak"]
        except (ValueError, RuntimeError) as exc:
            why = str(exc)
        except Exception as exc:                   # libsndfile raises its own types
            why = f"{type(exc).__name__}: {exc}"
    ok = bool(length_ok) and shift_ms is not None and abs(shift_ms) <= tolerance_ms
    return {"path": str(out), "sample_rate": out_rate, "checked": shift_ms is not None,
            "expected_frames": round(expected_frames, 1), "written_frames": mine_info.frames,
            "length_ok": bool(length_ok), "shift_ms": shift_ms, "peak": peak,
            "tolerance_ms": tolerance_ms, "gapless": gapless,
            "why": why, "ok": ok}


def grade_copy(osu_path: str | os.PathLike[str], audio_path: str | os.PathLike[str],
               text: str | None = None) -> dict:
    """Every red line the copy wrote, graded against the audio it wrote beside.

    The attacks of the built audio, detected the way the reference card
    detects them, graded by the reference timing's own grader. A rate change
    is only right if the sounds are still under the lines after the resample
    and the encode — which is the end of this phase's own argument, and what
    makes a practice copy checkable instead of hopeful. The one heavy job
    here (a decode and the attack pass), so the build asks for it.
    """
    built = ta.read_osu_beatmap(osu_path)
    try:
        y, sample_rate = ta._load_audio(audio_path, lambda _message: None)
        times, weights, _env = ta._detect_attacks(y, sample_rate, ta.FIT_HOP)
        report = ta.grade_reference_timing(built, times, weights,
                                           len(y) / float(sample_rate))
        return {"ok": bool(report.get("ok")), "reason": report.get("reason"),
                "counts": report.get("counts"),
                "common_offset_ms": report.get("common_offset_ms"),
                "worst_ms": max((abs(line["offset_error_ms"])
                                 for line in report.get("lines", ())
                                 if line.get("offset_error_ms") is not None),
                                default=None),
                "lines": [{"offset_ms": line["offset_ms"],
                           "verdict": line["verdict"],
                           "attacks": line.get("attacks"),
                           "offset_error_ms": line.get("offset_error_ms"),
                           "issues": line.get("issues", [])}
                          for line in report.get("lines", ())]}
    except (ValueError, OSError) as exc:
        return {"ok": False, "reason": str(exc), "counts": None,
                "common_offset_ms": None, "worst_ms": None, "lines": []}


# ---------------------------------------------------------------------------
# The output: a folder somebody can drop into Songs (Phase 26, row 26.14)
# ---------------------------------------------------------------------------

def _refuse_source_folder(plan: dict, out: Path) -> None:
    """Never write a copy into the folder it came from."""
    try:
        same = out.resolve() == Path(plan["source"]["osu"]).parent.resolve()
    except OSError:
        same = False
    if same:
        raise ValueError("A practice copy never overwrites its source: "
                         "it is written beside it, never in it.")


def _zip_folder(folder: Path, target: Path) -> dict:
    """The folder zipped flat, built in a temp file and renamed into place."""
    import tempfile
    import zipfile

    target = Path(target)
    names = sorted(path.name for path in folder.iterdir() if path.is_file())
    with tempfile.NamedTemporaryFile(delete=False, dir=str(target.parent),
                                     suffix=".osz.part") as handle:
        part = Path(handle.name)
    try:
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                archive.write(folder / name, name)
        part.replace(target)
    finally:
        if part.exists() and part != target:
            part.unlink()
    return {"name": target.name, "path": str(target), "bytes": target.stat().st_size,
            "files": names}


def _copy_support(plan: dict, out: Path) -> tuple[list[dict], list[dict], str | None]:
    """The files a copy needs beside its song and its map, copied, never moved.

    The copy keeps its sample indices (one map, unlike a compilation's
    remap), so the sample files travel under their own names; a background
    still shows the same picture at another speed and travels too. A video
    would play at the wrong speed under a faster song and stays behind with
    a note saying so — leaving it is honest, carrying it would be a desync.
    """
    folder = Path(plan["source"]["osu"]).parent
    named = set((plan["source"].get("samples") or {}).get("files", []))
    entries: list[dict] = []
    notes: list[dict] = []
    try:
        present = {entry.name: entry for entry in folder.iterdir() if entry.is_file()}
    except OSError:
        present = {}
    wanted: dict[str, str] = {}
    for name in named:
        if name in present:
            wanted[name] = f"a sound the map names ({name})"
    for name in sorted(present):
        if _SAMPLE_NAME.match(name) and name not in wanted:
            wanted[name] = "the map's sample bank"
    background = None
    try:
        beatmap = ta.read_osu_beatmap(plan["source"]["osu"])
        events = next((s for s in beatmap.get("sections", [])
                       if s.get("name") == "Events"), None)
        for raw in (events or {}).get("lines", []):
            fields = [f.strip() for f in str(raw).strip().split(",")]
            if fields and fields[0] == "0" and len(fields) >= 3:
                candidate = fields[2].strip().strip('"')
                if candidate and candidate in present:
                    background = candidate
    except (OSError, ValueError):
        background = None
    if background is not None and background not in wanted:
        wanted[background] = "the map's background"
    left = sorted(name for name in present
                  if Path(name).suffix.lower() in _VIDEO_SUFFIXES)
    if left:
        notes.append({"code": "video_not_carried",
                      "what": f"{len(left)} video file(s) stay behind "
                              f"({', '.join(left[:3])}{'…' if len(left) > 3 else ''}): "
                              f"they would play at the wrong speed under a faster song."})
    import shutil

    for name in sorted(wanted):
        target = out / name
        if target.is_file():
            entries.append({"name": name, "bytes": target.stat().st_size,
                            "why": wanted[name], "kept": True})
            continue
        shutil.copyfile(present[name], target)
        entries.append({"name": name, "bytes": target.stat().st_size,
                        "why": wanted[name], "kept": False})
    return entries, notes, background


def build_practice(plan: dict, folder: str | os.PathLike[str], *,
                   audio_format: str = DEFAULT_AUDIO_FORMAT,
                   audio_name: str | None = None,
                   decimals: int = WRITE_DECIMALS,
                   osz=False, dry_run: bool = False,
                   allow_existing: bool = False,
                   verify: bool = True, grade: bool = False,
                   progress=None) -> dict:
    """The practice copy as a mapset folder, an ``.osz``, or neither.

    Everything is settled before anything is written: the beatmap text itself
    (which is what refuses a build that cannot be made), the audio name, and
    the file list. ``dry_run`` stops there and returns the same report with
    the files it *would* write — the thing to show somebody before they
    commit a folder to it.

    The order on disk is the song, the samples and background, then the
    beatmap, and the ``.osu`` goes through the engine's atomic writer and the
    write log, so History names this build like any other write. The folder
    goes straight into `Songs` — no file association, no import step, which
    is the reference's own open issue about imports — with ``.osz`` still
    available for anyone who wants to move it.

    Refuses a folder that already holds a beatmap unless ``allow_existing``,
    refuses the source's own folder always, and never overwrites a map or a
    ``.bak``: the atomic writer keeps what it replaces.
    """
    def say(step: str, done: int = 0, total: int = 1) -> None:
        if progress is not None:
            progress(step, done, total)

    out = Path(folder)
    if out.exists() and not out.is_dir():
        raise ValueError(f"{out} is not a folder.")
    _refuse_source_folder(plan, out)
    if out.is_dir() and not allow_existing:
        existing = sorted(path.name for path in out.iterdir()
                          if path.suffix.lower() == ".osu")
        if existing:
            raise ValueError(f"{out.name} already holds {existing[0]!r}. Say "
                             f"allow_existing to add this copy to it.")

    say("plan")
    text, beatmap = practice_beatmap(plan, decimals=decimals)
    named_audio = (plan["source"]["audio"] or {}).get("named") or "audio"
    stem = Path(named_audio).stem or "audio"
    suffix = Path(named_audio).suffix.lower()
    audio_file = audio_name or (named_audio if suffix == f".{audio_format}"
                                else f"{stem}.{audio_format}")
    if audio_file != named_audio:
        text = "\r\n".join(_patch_key_lines(text.split("\r\n"),
                                            {"AudioFilename": audio_file}))
    osu_file = f"{ta._safe_component(plan['source']['metadata'].get('Artist') or 'Artist', 'Artist')} - " \
               f"{ta._safe_component(plan['source']['metadata'].get('Title') or 'Title', 'Title')} " \
               f"[{ta._safe_component(plan['naming']['version'], 'practice')}].osu"
    files = [{"name": audio_file, "kind": "audio", "bytes": None},
             {"name": osu_file, "kind": "beatmap", "bytes": len(text.encode("utf-8"))}]
    report = {"folder": str(out), "osu": osu_file, "audio_name": audio_file,
              "written": False, "dry_run": bool(dry_run), "files": files,
              "beatmap": beatmap, "rate": plan["rate"], "stats": plan["stats"],
              "naming": plan["naming"], "osz": None, "checks": None}
    if dry_run:
        return report

    out.mkdir(parents=True, exist_ok=True)
    say("audio")
    audio = build_audio(plan, out / audio_file, audio_format=audio_format,
                        progress=progress)
    say("samples")
    copied, support_notes, background = _copy_support(plan, out)
    beatmap["notes"].extend({"copy": True, **note} for note in support_notes)
    for entry in copied:
        files.append({"name": entry["name"],
                      "kind": "background" if entry["name"] == background else "sample",
                      "bytes": entry["bytes"]})
    say("beatmap")
    payload = text.encode("utf-8")
    ta._atomic_write_bytes(out / osu_file, payload)
    ta.log_write(out / osu_file, WRITE_OP, None,
                 {"bytes": len(payload), "rate": plan["rate"],
                  "objects": beatmap["objects"], "audio": audio_file,
                  "source": plan["source"]["osu"],
                  "copied": sorted(entry["name"] for entry in copied)})
    for entry in report["files"]:
        path = out / entry["name"]
        entry["bytes"] = path.stat().st_size if path.is_file() else None
    report.update({"written": True, "audio": audio, "copied": copied})
    if osz:
        if isinstance(osz, bool):
            artist = ta._safe_component(plan["source"]["metadata"].get("Artist") or "Artist",
                                        "Artist")
            title = ta._safe_component(plan["source"]["metadata"].get("Title") or "Title",
                                       "Title")
            target = out.parent / f"{artist} - {title}.osz"
        else:
            target = Path(osz)
        report["osz"] = _zip_folder(out, target)
    if verify:
        say("check")
        report["checks"] = verify_build(plan, out / osu_file, out / audio_file,
                                        text, grade=grade)
    say("done", 1, 1)
    return report


def verify_build(plan: dict, osu_path: str | os.PathLike[str],
                 audio_path: str | os.PathLike[str],
                 text: str | None = None, grade: bool = False) -> dict:
    """What a built practice copy looks like read back (Phase 26, row 26.17's frame).

    Four questions, each answered from the files rather than from the report
    that made them: did the resampled song land where the rate puts it (row
    26.7's aligner), is anything off the grid or before it (the snap audit,
    which is what a mapper would ask), does the beatmap come back through the
    reader and writer byte for byte, and — with ``grade`` — does every red
    line the copy wrote still sit on the attacks of the audio that was built
    (row 26.17). A second decode, so it can be turned off, and on by default
    because a build nobody checked is a build nobody can trust.
    """
    built = ta.read_osu_beatmap(osu_path)
    audio = verify_audio(plan, audio_path)
    try:
        info = ta.sf.info(str(audio_path))
        duration = info.frames / info.samplerate
    except Exception:                                  # libsndfile raises its own types
        duration = None
    snap = ta.snap_audit(built, duration_s=duration)
    round_trip = ta.beatmap_text(built) == (text if text is not None
                                            else ta._load_osu_text(osu_path)[0])
    graded = grade_copy(osu_path, audio_path) if grade else None
    return {"audio": audio, "round_trip": bool(round_trip), "grade": graded,
            "snap": {"objects": snap.get("objects"), "red_lines": snap.get("red_lines"),
                     "unsnapped": len(snap.get("unsnapped", [])),
                     "before_first_red": len(snap.get("before_first_red", [])),
                     "past_audio": len(snap.get("past_audio") or [])},
            "ok": bool(round_trip) and bool(audio["ok"])
                  and not snap.get("unsnapped") and not snap.get("before_first_red")
                  and not (snap.get("past_audio") or [])
                  and (graded is None or bool(graded["ok"]))}


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


# ---------------------------------------------------------------------------
# Undo and clean up: every copy is in the write log already (row 26.15)
# ---------------------------------------------------------------------------

def _logged_copies(history_dir=None) -> dict[str, list[dict]]:
    """Write-log entries from practice builds, by the folder they went to."""
    folders: dict[str, list[dict]] = {}
    for entry in ta.read_history(history_dir):
        if entry.get("op") != WRITE_OP or not entry.get("path"):
            continue
        folders.setdefault(str(Path(entry["path"]).parent), []).append(entry)
    return folders


def list_copies(history_dir=None) -> dict:
    """Every practice copy the write log knows, with dates, sizes and origins.

    Not a scan for stray mp3s: a copy is listed because this tool wrote it,
    with the source map each rung came from. Sizes are measured now, so the
    list says what removing would free; files the log names that are gone
    are listed as missing rather than silently dropped.
    """
    folders = []
    for folder, entries in sorted(_logged_copies(history_dir).items()):
        if not Path(folder).is_dir():
            # Removed already: the log remembers, the list is for cleaning.
            continue
        osu = sorted({Path(e["path"]).name for e in entries})
        present = {name: (Path(folder) / name) for name in osu}
        audio = sorted({str((e.get("summary") or {}).get("audio"))
                        for e in entries if (e.get("summary") or {}).get("audio")})
        copied = sorted({name for e in entries
                         for name in (e.get("summary") or {}).get("copied", [])})
        rates = sorted({str((e.get("summary") or {}).get("rate"))
                        for e in entries if (e.get("summary") or {}).get("rate") is not None})
        sources = sorted({str((e.get("summary") or {}).get("source"))
                          for e in entries if (e.get("summary") or {}).get("source")})
        missing = sorted(name for name, path in present.items() if not path.is_file())
        missing += sorted(name for name in audio + copied
                          if name not in osu and not (Path(folder) / name).is_file())
        held = [path for path in
                [present[name] for name in osu if name not in missing]
                + [Path(folder) / name for name in audio + copied if (Path(folder) / name).is_file()]]
        folders.append({"folder": folder, "osu": osu, "audio": audio, "copied": copied,
                        "rates": rates, "sources": sources,
                        "ts": max((e.get("ts") or "" for e in entries), default=""),
                        "bytes": sum(path.stat().st_size for path in held
                                     if path.is_file()),
                        "missing": sorted(set(missing)),
                        "complete": not missing})
    return {"folders": folders,
            "total_bytes": sum(row["bytes"] for row in folders)}


def remove_copies(folders: list[str], history_dir=None,
                  dry_run: bool = False) -> dict:
    """Remove practice copies, showing what goes before anything goes.

    Only what the log names: each logged `.osu`, its audio and the files the
    build copied beside them. A folder holding a beatmap this log did not
    write is left alone — the logged files leave, the stranger stays — and an
    unknown folder refuses instead of guessing. The folder itself goes when
    nothing is left in it.
    """
    known = {row["folder"]: row for row in list_copies(history_dir)["folders"]}
    removed: list[dict] = []
    for folder in folders:
        row = known.get(str(folder))
        if row is None:
            removed.append({"folder": str(folder), "removed": [], "bytes": 0,
                            "refusal": "Not a practice copy this log knows."})
            continue
        names = [name for name in row["osu"] + row["audio"] + row["copied"]
                 if name not in row["missing"]]
        others = sorted(path.name for path in Path(row["folder"]).iterdir()
                        if path.is_file() and path.suffix.lower() == ".osu"
                        and path.name not in row["osu"]) \
            if Path(row["folder"]).is_dir() else []
        freed, gone = 0, []
        if not dry_run:
            for name in names:
                path = Path(row["folder"]) / name
                try:
                    freed += path.stat().st_size
                    path.unlink()
                    gone.append(name)
                except OSError as exc:
                    removed.append({"folder": row["folder"], "removed": gone,
                                    "bytes": freed,
                                    "refusal": f"{name} would not delete: {exc}"})
                    break
            else:
                try:
                    if Path(row["folder"]).is_dir() and not any(Path(row["folder"]).iterdir()):
                        Path(row["folder"]).rmdir()
                except OSError:
                    pass
        else:
            freed = row["bytes"]
            gone = list(names)
        if not any(r.get("folder") == row["folder"] and "refusal" in r for r in removed):
            removed.append({"folder": row["folder"], "removed": gone, "bytes": freed,
                            "kept": others,
                            **({"note": f"{len(others)} map(s) this log did not write stay."}
                               if others else {})})
    return {"removed": removed,
            "bytes": sum(row["bytes"] for row in removed),
            "dry_run": bool(dry_run)}


# ---------------------------------------------------------------------------
# Presets: a setup saved as a practice document with a name (row 26.20)
# ---------------------------------------------------------------------------

def _presets_path() -> Path:
    """Where named setups live: beside the result cache, never the app.

    ``OVERTONE_TRAIN_PRESETS`` points it at a scratch file, so tests never
    touch the real setups."""
    override = os.environ.get("OVERTONE_TRAIN_PRESETS")
    if override:
        return Path(override)
    from overtone_paths import data_root
    return data_root() / "train_presets.json"


def _read_presets() -> dict:
    try:
        data = json.loads(_presets_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def list_presets() -> dict:
    """Every saved setup, by name, with what each one asks for."""
    return {"presets": _read_presets()}


def save_preset(name: str, settings: dict) -> dict:
    """Keep this setup under a name, so a preset is the same object as a
    build: diffable, shareable as a file, re-readable. A preset carries no
    source map — it is applied to whichever map is picked."""
    name = str(name or "").strip()
    if not name:
        raise ValueError("A preset needs a name.")
    settings = dict(settings or {})
    unknown = sorted(set(settings) - {"rate", "target_bpm", "from_bpm", "stats",
                                      "naming", "mods", "audio_format", "osz"})
    if unknown:
        raise ValueError(f"Unknown setting(s): {', '.join(unknown)}.")
    mods = settings.get("mods")
    if mods is not None:
        if isinstance(mods, str):
            mods = [mods]
        _, refusals = _check_mods(mods)
        if refusals:
            raise ValueError(refusals[0]["why"])
        settings["mods"] = mods
    if settings.get("audio_format") not in (None, "mp3", "wav"):
        raise ValueError(f"Format {settings.get('audio_format')!r} is not mp3 or wav.")
    path = _presets_path()
    presets = _read_presets()
    presets[name] = {"settings": settings,
                     "saved": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    path.parent.mkdir(parents=True, exist_ok=True)
    ta._atomic_write_bytes(path, json.dumps(presets, indent=1).encode("utf-8"))
    return {"name": name, "settings": settings}


def delete_preset(name: str) -> dict:
    """Forget a setup. A name never saved refuses instead of pretending."""
    presets = _read_presets()
    if str(name) not in presets:
        raise ValueError(f"No preset named {name!r}.")
    del presets[str(name)]
    ta._atomic_write_bytes(_presets_path(),
                           json.dumps(presets, indent=1).encode("utf-8"))
    return {"name": str(name), "deleted": True}


def feel_of(osu, rate: float, values: dict, mods: list[str] | None = None) -> dict:
    """What the copy will feel like, computed exactly and each labelled.

    Beside the stats: the BPM (and how many tempi when there is more than
    one), the AR preempt and the OD windows in milliseconds, the object
    density, and the longest stream with its speed in notes per second. No
    star rating: osu! has not used the pre-2021 algorithm for years, and a
    famous approximate number would be the one thing on the screen that is
    not exact. A stream is a maximal run of objects each at most one beat
    after the previous, read off the map's own red lines.
    """
    mods = list(mods or [])
    beatmap = ta.read_osu_beatmap(osu)
    mode = int(beatmap.get("general", {}).get("Mode", 0) or 0)
    times = sorted(float(obj["time"]) for obj in beatmap.get("hitobjects", [])
                   if obj.get("kind") != "unparsed" and "time" in obj)
    reds = sorted((float(p["time"]), float(p["beat_length"]))
                  for p in tc._points_of(beatmap) if p["red"] and p["beat_length"] > 0)
    bpms = sorted({round(60000.0 / beat, 4) for _at, beat in reds})
    if not times:
        return {"rate": float(rate), "mode": mode, "objects": 0, "bpms": bpms,
                "bpm_text": f"{bpms[0]:g}" if len(bpms) == 1 else "no tempo",
                "duration_ms": 0.0, "density_per_s": None,
                "longest_stream": {"notes": 0, "notes_per_s": None,
                                   "from_ms": 0.0, "to_ms": 0.0},
                "mods": mods, "ar_ms": None, "od_windows": None, "feel": {},
                "mode_note": None}

    def beat_at(time_ms: float) -> float | None:
        use = next((beat for at, beat in reversed(reds) if at <= time_ms + 1e-6),
                   reds[0][1] if reds else None)
        return use

    run, best = 1, {"notes": 1, "from_ms": times[0] if times else 0.0,
                     "to_ms": times[0] if times else 0.0}
    start = times[0] if times else 0.0
    for before, after in zip(times, times[1:]):
        beat = beat_at(after)
        if beat is not None and after - before <= beat + 1e-6:
            run += 1
        else:
            if run > best["notes"]:
                best = {"notes": run, "from_ms": start, "to_ms": before}
            run, start = 1, after
    if run > best["notes"]:
        best = {"notes": run, "from_ms": start, "to_ms": times[-1]}
    span_ms = best["to_ms"] - best["from_ms"]
    best["notes_per_s"] = round(best["notes"] / (span_ms / 1000.0), 2) if span_ms > 0 else None
    best["from_ms"] = round(best["from_ms"] / float(rate), 1)
    best["to_ms"] = round(best["to_ms"] / float(rate), 1)

    whole = (times[-1] - times[0]) if len(times) > 1 else 0.0
    feel: dict = {
        "rate": float(rate), "mode": mode, "objects": len(times),
        "bpms": bpms, "bpm_text": f"{bpms[0]:g}" if len(bpms) == 1 else (
            f"{len(bpms)} tempi" if bpms else "no tempo"),
        "duration_ms": round(whole / float(rate), 1),
        "density_per_s": round(len(times) / (whole / 1000.0), 2) if whole > 0 else None,
        "longest_stream": best, "mods": mods,
        "ar_ms": None, "od_windows": None, "feel": {},
        "mode_note": None,
    }
    ar, od = values.get("ar"), values.get("od")
    for field, value in (("ar", ar), ("od", od)):
        felt = mod_feel(field, value, mods)
        feel["feel"][field] = felt
    if mode == 0:
        number_f, speed_f = _mod_factors(mods)
        if ar is not None:
            feel["ar_ms"] = round(ar_to_ms(ar), 2)
        if od is not None:
            capped = min(float(od) * number_f, 10.0)
            feel["od_windows"] = {key: round(window / speed_f, 2)
                                  for key, window in od_windows(capped).items()}
    else:
        feel["mode_note"] = (f"Mode {mode} reads its own approach and hit windows; "
                             f"only the counts, the stream and the tempi are exact here.")
    return feel


# ---------------------------------------------------------------------------
# Rate ladders: one run, one mapset, several rates (Phase 26, row 26.16)
# ---------------------------------------------------------------------------

#: The ladder document's own format, beside the practice document's.
LADDER_FORMAT = 1

#: How many rungs a ladder holds. Each rung is a resample, an encode and a
#: grade; past a dozen the run stops being a practice session's setup and
#: starts being an evening. A longer ladder is two ladders.
MAX_RUNGS = 12


def _ladder_rates(rates) -> tuple[list[float] | None, list[dict]]:
    """The rung rates as numbers, each inside the window, each its own rung."""
    refusals: list[dict] = []
    if rates is None or isinstance(rates, bool):
        return None, [{"code": "rates_not_a_list",
                       "why": "A ladder is a list of rates, not "
                              f"{rates!r}."}]
    try:
        values = [float(rate) for rate in rates]
    except (TypeError, ValueError):
        return None, [{"code": "rates_not_a_list",
                       "why": "A ladder is a list of numbers; one of them is not a number."}]
    if len(values) < 2:
        return None, [{"code": "not_a_ladder",
                       "why": "One rate is a practice copy, not a ladder; "
                              "a ladder climbs at least two rungs."}]
    if len(values) > MAX_RUNGS:
        return None, [{"code": "too_many_rungs",
                       "why": f"{len(values)} rungs past the {MAX_RUNGS} a ladder holds; "
                              f"a longer ladder is two ladders."}]
    for value in values:
        if not value > 0.0:
            return None, [{"code": "rate_not_a_number",
                           "why": f"The rate ({value:g}) is not positive; never a division by zero."}]
        if not RATE_MIN - 1e-12 <= value <= RATE_MAX + 1e-12:
            return None, [{"code": "rate_out_of_range",
                           "why": f"The rate ({value:g}) sits outside "
                                  f"{RATE_MIN:g}-{RATE_MAX:g}x, which is the window "
                                  f"a copy may ask for."}]
    seen: set[float] = set()
    for value in values:
        if value in seen:
            return None, [{"code": "repeated_rung",
                           "why": f"{value:g}x twice is the same rung twice, under one name; "
                                  f"a ladder climbs."}]
        seen.add(value)
    return values, refusals


def _ladder_audio_name(stem: str, rate: float, audio_format: str) -> str:
    """One audio file per distinct rate, named for the rung that needs it."""
    stem = stem or "audio"
    return f"{stem}-{float(rate):g}x.{audio_format}"


def plan_ladder(osu, rates, audio=None, stats: dict | None = None,
                naming: dict | None = None, mods=None,
                audio_method: str = "resample") -> dict:
    """One source map as a ladder document: a practice plan per rung.

    The reference makes one copy at a time; practising is a ladder, so one
    run plans every rung and the build below writes them as one mapset with
    one audio file per distinct rate. Each rung is the same plan a single
    copy would get — the same stats, the same naming with its own rate in the
    fields — so a rung refused is a ladder refused, with the rung named.
    Plain JSON throughout, like the practice document.
    """
    values, refusals = _ladder_rates(rates)
    plans: list[dict] = []
    if values is not None:
        for rate in values:
            plan = plan_practice(osu, audio=audio, rate=rate, stats=stats,
                                 naming=naming, mods=mods, audio_method=audio_method)
            plans.append(plan)
            for refusal in plan["refusals"]:
                refusals.append({"rung": f"{rate:g}x", **refusal})
    usable = values is not None and all(plan["usable"] for plan in plans)
    return {"format": LADDER_FORMAT, "source": str(osu), "rates": values,
            "plans": plans, "refusals": refusals, "usable": usable}


def build_ladder(plan: dict, folder: str | os.PathLike[str], *,
                 audio_format: str = DEFAULT_AUDIO_FORMAT,
                 osz=False, dry_run: bool = False,
                 allow_existing: bool = False,
                 verify: bool = True, grade: bool = False,
                 progress=None) -> dict:
    """The ladder as one mapset folder, an ``.osz``, or neither.

    Every rung is settled before anything is written — the texts, the audio
    names, the file list — so a ladder that cannot be built refuses with
    nothing on disk. ``dry_run`` stops there. Then, rung by rung on one
    progress bar over the lot: one audio file per distinct rate (a rung whose
    rate is already on disk reuses it), each rung's own ``.osu`` through the
    atomic writer and the write log, the shared samples and background once,
    and the checks per rung when asked.

    The same refusals as a single copy: a folder holding a beatmap unless
    ``allow_existing``, the source's own folder always, never overwriting a
    map or a ``.bak``.
    """
    def say(done: int, total: int) -> None:
        if progress is not None:
            progress("ladder", done, total)

    if not plan.get("usable"):
        why = "; ".join((f"rung {r.get('rung')}: " if r.get("rung") else "")
                        + (r.get("why") or r.get("code", "?"))
                        for r in plan.get("refusals", ())) or "no reason given"
        raise ValueError(f"This ladder refused: {why}")
    if int(plan.get("format") or 0) != LADDER_FORMAT:
        raise ValueError(f"Ladder format {plan.get('format')!r} is not {LADDER_FORMAT}.")
    if audio_format not in AUDIO_FORMATS:
        raise ValueError(f"Unknown audio format {audio_format!r}. "
                         f"Known: {', '.join(AUDIO_FORMATS)}.")
    out = Path(folder)
    if out.exists() and not out.is_dir():
        raise ValueError(f"{out} is not a folder.")
    first = plan["plans"][0]
    _refuse_source_folder(first, out)
    if out.is_dir() and not allow_existing:
        existing = sorted(path.name for path in out.iterdir()
                          if path.suffix.lower() == ".osu")
        if existing:
            raise ValueError(f"{out.name} already holds {existing[0]!r}. Say "
                             f"allow_existing to add this ladder to it.")

    named_audio = (first["source"]["audio"] or {}).get("named") or "audio"
    stem = Path(named_audio).stem or "audio"
    texts: list[tuple[str, str, dict]] = []
    for rung in plan["plans"]:
        rate = float(rung["rate"])
        audio_file = _ladder_audio_name(stem, rate, audio_format)
        text, beatmap = practice_beatmap(rung)
        if audio_file != named_audio:
            text = "\r\n".join(_patch_key_lines(text.split("\r\n"),
                                                {"AudioFilename": audio_file}))
        osu_file = f"{ta._safe_component(rung['source']['metadata'].get('Artist') or 'Artist', 'Artist')} - " \
                   f"{ta._safe_component(rung['source']['metadata'].get('Title') or 'Title', 'Title')} " \
                   f"[{ta._safe_component(rung['naming']['version'], 'practice')}].osu"
        texts.append((audio_file, osu_file, {"text": text, "beatmap": beatmap,
                                             "rate": rate, "plan": rung}))
    files = [{"name": audio, "kind": "audio", "bytes": None}
             for audio in dict.fromkeys(audio for audio, _osu, _rep in texts)]
    files += [{"name": osu, "kind": "beatmap", "bytes": len(rep["text"].encode("utf-8"))}
              for _audio, osu, rep in texts]
    report = {"folder": str(out), "rates": plan["rates"], "written": False,
              "dry_run": bool(dry_run), "files": files,
              "rungs": [{"rate": rep["rate"], "osu": osu, "audio_name": audio,
                         "checks": None} for audio, osu, rep in texts],
              "osz": None}
    if dry_run:
        return report

    out.mkdir(parents=True, exist_ok=True)
    by_audio: dict[str, dict] = {}
    copied, support_notes, background = _copy_support(first, out)
    for entry in copied:
        files.append({"name": entry["name"],
                      "kind": "background" if entry["name"] == background else "sample",
                      "bytes": entry["bytes"]})
    say(0, len(texts))
    for n, (audio_file, osu_file, rep) in enumerate(texts):
        if audio_file not in by_audio:
            by_audio[audio_file] = build_audio(rep["plan"], out / audio_file,
                                               audio_format=audio_format)
        payload = rep["text"].encode("utf-8")
        ta._atomic_write_bytes(out / osu_file, payload)
        ta.log_write(out / osu_file, WRITE_OP, None,
                     {"bytes": len(payload), "rate": rep["rate"],
                      "objects": rep["beatmap"]["objects"], "audio": audio_file,
                      "source": rep["plan"]["source"]["osu"],
                      "copied": sorted(entry["name"] for entry in copied),
                      "ladder": [f"{r:g}x" for r in plan["rates"]]})
        say(n + 1, len(texts))
    for entry in report["files"]:
        path = out / entry["name"]
        entry["bytes"] = path.stat().st_size if path.is_file() else None
    report.update({"written": True, "audio": by_audio, "copied": copied,
                   "support_notes": support_notes})
    if osz:
        if isinstance(osz, bool):
            artist = ta._safe_component(first["source"]["metadata"].get("Artist") or "Artist",
                                        "Artist")
            title = ta._safe_component(first["source"]["metadata"].get("Title") or "Title",
                                       "Title")
            target = out.parent / f"{artist} - {title}.osz"
        else:
            target = Path(osz)
        report["osz"] = _zip_folder(out, target)
    if verify:
        for row, (audio_file, osu_file, rep) in zip(report["rungs"], texts):
            row["checks"] = verify_build(rep["plan"], out / osu_file,
                                         out / audio_file, rep["text"], grade=grade)
        report["ok"] = all(row["checks"]["ok"] for row in report["rungs"])
    else:
        report["ok"] = None
    say(len(texts), len(texts))
    return report
