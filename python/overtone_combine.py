"""Overtone's compilation builder: several maps and their songs as one map.

A compilation keeps what it borrows. Each source difficulty gives a range of
its own song and the objects inside that range, and the only thing that
changes is where in time they sit: an object that landed on a snare in its
own map lands on the same snare here. Nothing is redrawn — not a position,
not a curve, not a slider's shape ([`04-ui-ux.md`] §9, decided 2026-10-03).

This module holds the parts that need no audio: reading a source and saying
what is wrong with it, the document the plan lives in, and the shift that
puts every borrowed timestamp where it belongs. Cutting the audio, merging
the hitsounds and writing the folder follow in their own rows (roadmap
Phase 25).

**Nothing here writes.** A source is opened read-only even to fix it: a
repair is recorded against the plan, never against someone else's map.

Two words carry the weight of the reporting:

- a **repair** is something odd the reader could resolve or had to work
  around. It carries ``fixed``: True when the reader did something about it,
  False when it is only reported. A build in strict mode refuses on any
  repair; the default builds and keeps the list.
- a **refusal** means the segment cannot be used at all. A refused segment
  still comes back, with ``usable`` False and the reason, so the plan can
  show the whole picture instead of dying on the first bad file.
"""

from __future__ import annotations

import os
from pathlib import Path, PurePath

import overtone as ta

#: The compilation document's own format. A document from a newer one is
#: refused rather than guessed at, as the library index refuses a newer
#: schema: the fields a future version adds are exactly the ones this code
#: would ignore silently.
PLAN_FORMAT = 1

#: Silence kept before a segment's first object and after its last sound when
#: the range is taken from the objects rather than given. A map's own lead-in
#: habit is one to two seconds, and the junction's fade needs somewhere to
#: live; the reference tool cut up to five seconds and faded three, which is
#: most of a phrase.
DEFAULT_LEAD_MS = 2000.0
DEFAULT_TAIL_MS = 2000.0

#: What osu! itself will load as a mapset's audio. The reader accepts any of
#: them; which one the builder *writes* is row 25.4's decision.
AUDIO_SUFFIXES = (".mp3", ".ogg", ".wav")

#: Game modes, by the number in ``[General] Mode``.
MODE_NAMES = {0: "osu", 1: "taiko", 2: "catch", 3: "mania"}

#: The sample set a hit sample's first two numbers name. 0 means "whatever
#: the timing point says", which is why it is not a set but a deferral.
SAMPLE_SET_NAMES = {0: "auto", 1: "normal", 2: "soft", 3: "drum"}

#: The engine's own timing-line parser, osu!'s defaults for omitted fields
#: included. One reader for the format, not two.
_timing_point_fields = ta._timing_point_fields


def _repair(code: str, what: str, fixed: bool = False, **extra) -> dict:
    """One line of the repair log: the code a UI switches on, the sentence a
    person reads, and whether anything was actually done about it."""
    return {"code": code, "what": what, "fixed": bool(fixed), **extra}


def _number(values: dict, key: str) -> float | None:
    """A ``Key: value`` number, or None when it is absent or not a number."""
    try:
        text = str(values[key]).strip()
    except (KeyError, TypeError):
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value == value and abs(value) != float("inf") else None


def _int_or_none(value: float | None) -> int | None:
    return int(round(value)) if value is not None else None


def _folder_index(folder: Path) -> dict[str, Path]:
    """Every file in the folder by lowercased name, for case-blind lookups.

    Windows finds ``Audio.mp3`` from ``audio.mp3`` and osu! on Linux does
    not, so a mapset that plays here can be silent there. The builder treats
    the mismatch as something to report and resolve, not as a non-event.
    """
    try:
        return {entry.name.lower(): entry for entry in folder.iterdir() if entry.is_file()}
    except OSError:
        return {}


def _find_audio(folder: Path, named: str | None) -> tuple[Path | None, str, list[dict]]:
    """The segment's audio file from what ``AudioFilename`` says, and how.

    Four things go wrong in real mapsets and each gets its own answer: the
    field is missing, it carries a path or quotes instead of a name, its case
    does not match the file, or its extension does not. When none of those
    land and the folder holds exactly one audio file, that file is taken and
    the guess is labelled a guess — a mapset has one song, so it is a good
    guess, but it is not what the map said.
    """
    repairs: list[dict] = []
    files = _folder_index(folder)
    text = (named or "").strip().strip('"')
    if not text:
        repairs.append(_repair("audio_unnamed", "The map names no AudioFilename."))
        name = ""
    else:
        name = PurePath(text.replace("\\", "/")).name
        if name != text:
            repairs.append(_repair(
                "audio_path", f"AudioFilename carries a path ({text!r}); "
                f"osu! reads only the name, {name!r}.", True))
    if name:
        # The folder's own listing is the truth, not ``(folder / name).is_file()``:
        # Windows answers that with the file it has whatever its case, so the
        # mismatch that silences the map on a case-sensitive filesystem is
        # invisible from here. Asking the listing finds it on either platform.
        found = files.get(name.lower())
        if found is None and not files and (folder / name).is_file():
            return folder / name, "named", repairs   # a folder that would not list
        if found is not None:
            if found.name == name:
                return found, "named", repairs
            repairs.append(_repair(
                "audio_case", f"AudioFilename says {name!r}; the file is {found.name!r}.",
                True))
            return found, "case", repairs
        stem = PurePath(name).stem.lower()
        same_stem = [path for key, path in sorted(files.items())
                     if PurePath(key).stem == stem and path.suffix.lower() in AUDIO_SUFFIXES]
        if same_stem:
            repairs.append(_repair(
                "audio_extension",
                f"AudioFilename says {name!r}; the audio beside it is {same_stem[0].name!r}.",
                True))
            return same_stem[0], "extension", repairs
    audio = [path for key, path in sorted(files.items())
             if path.suffix.lower() in AUDIO_SUFFIXES]
    if len(audio) == 1:
        repairs.append(_repair(
            "audio_guessed",
            f"No file matches AudioFilename; taking the folder's only audio, "
            f"{audio[0].name!r}.", True))
        return audio[0], "guessed", repairs
    repairs.append(_repair(
        "audio_missing",
        f"No audio file in {folder.name!r} matches AudioFilename"
        + (f" ({name!r})." if name else ".")))
    return None, "missing", repairs


def _audio_facts(path: Path | None) -> tuple[dict, list[dict]]:
    """Rate, channels and length from the header alone, never a decode.

    A plan holds several songs and a decode is the heavy job this repo keeps
    to one at a time; the length is all the plan needs, and libsndfile reads
    it out of the header. A file libsndfile cannot open may still decode
    later through the engine's own fallbacks, so that is a repair, not a
    refusal, and the length stays unknown rather than invented.
    """
    facts: dict = {"sample_rate": None, "channels": None, "duration_ms": None,
                   "bytes": None, "format": None}
    if path is None:
        return facts, []
    try:
        facts["bytes"] = path.stat().st_size
    except OSError:
        pass
    try:
        info = ta.sf.info(str(path))
    except Exception as exc:                       # libsndfile raises its own types
        return facts, [_repair(
            "audio_unreadable",
            f"{path.name}'s header did not read ({exc}); its length is unknown here.")]
    if info.samplerate <= 0 or info.frames <= 0:
        return facts, [_repair("audio_empty", f"{path.name} holds no audio.")]
    facts.update({"sample_rate": int(info.samplerate), "channels": int(info.channels),
                  "duration_ms": round(info.frames / info.samplerate * 1000.0, 3),
                  "format": str(info.format or "")})
    return facts, []


def _object_facts(objects: list[dict]) -> tuple[dict, list[dict]]:
    """What the objects are, when they start, and when the last one stops.

    ``last_ms`` is the last sound the file states: a spinner's and a mania
    hold's end are written down, a slider's is not — it follows from the
    slider's length, the map's multiplier and the velocity in force, which is
    row 25.9's arithmetic, not this reader's. So a map whose last object is a
    slider has a ``last_ms`` at that slider's head, and the tail padding is
    what covers its body. Said here rather than discovered later.
    """
    kinds = {"circle": 0, "slider": 0, "spinner": 0, "hold": 0, "unparsed": 0}
    first: float | None = None
    last: float | None = None
    out_of_order = 0
    decimal_times = 0
    previous: float | None = None
    for obj in objects:
        kind = str(obj.get("kind", "unparsed"))
        kinds[kind] = kinds.get(kind, 0) + 1
        if kind == "unparsed":
            continue
        time = float(obj["time"])
        end = float(obj.get("end_time", time)) if obj.get("end_time") is not None else time
        if previous is not None and time < previous:
            out_of_order += 1
        previous = time
        if time != round(time) or end != round(end):
            decimal_times += 1
        first = time if first is None else min(first, time)
        last = max(end, time) if last is None else max(last, end, time)
    facts = {**kinds, "total": sum(kinds.values()),
             "played": sum(n for kind, n in kinds.items() if kind != "unparsed"),
             "first_ms": None if first is None else round(first, 3),
             "last_ms": None if last is None else round(last, 3),
             "out_of_order": out_of_order, "decimal_times": decimal_times}
    repairs: list[dict] = []
    if kinds["unparsed"]:
        repairs.append(_repair(
            "objects_unparsed",
            f"{kinds['unparsed']} object line(s) do not read as objects; "
            f"they are carried as written.", count=kinds["unparsed"]))
    if out_of_order:
        repairs.append(_repair(
            "objects_unordered",
            f"{out_of_order} object(s) sit out of time order; the build sorts them.",
            True, count=out_of_order))
    if decimal_times:
        repairs.append(_repair(
            "objects_decimal_times",
            f"{decimal_times} object time(s) carry decimals (osu!lazer writes them); "
            f"a whole-millisecond build rounds them.", count=decimal_times))
    return facts, repairs


def _timing_facts(lines: list[str]) -> tuple[dict, list[dict]]:
    """The timing section counted and checked, reds and greens apart."""
    points = []
    unusable = 0
    for raw in lines:
        text = str(raw).strip()
        if not text or text.startswith("//"):
            continue
        fields = _timing_point_fields(text)
        if fields is None:
            unusable += 1
            continue
        points.append(fields)
    reds = [p for p in points if p["red"]]
    greens = [p for p in points if not p["red"]]
    first_red = min((p["time"] for p in reds), default=None)
    seen: dict[float, int] = {}
    for point in reds:
        seen[point["time"]] = seen.get(point["time"], 0) + 1
    duplicates = sorted(time for time, n in seen.items() if n > 1)
    early_greens = [p["time"] for p in greens
                    if first_red is not None and p["time"] < first_red]
    facts = {"reds": len(reds), "greens": len(greens), "unusable": unusable,
             "first_red_ms": None if first_red is None else round(first_red, 3),
             "first_bpm": round(60000.0 / reds[0]["beat_length"], 4)
                          if reds and reds[0]["beat_length"] > 0 else None,
             "duplicate_reds": [round(t, 3) for t in duplicates],
             "greens_before_red": len(early_greens)}
    repairs: list[dict] = []
    if unusable:
        repairs.append(_repair(
            "timing_unusable",
            f"{unusable} timing line(s) hold no numbers osu! could read; they are dropped.",
            True, count=unusable))
    if duplicates:
        repairs.append(_repair(
            "timing_duplicate_reds",
            f"{len(duplicates)} time(s) carry more than one red line; osu! obeys the last.",
            count=len(duplicates), at=[round(t, 3) for t in duplicates[:8]]))
    if early_greens:
        repairs.append(_repair(
            "timing_green_before_red",
            f"{len(early_greens)} green line(s) sit before the first red one, where osu! "
            f"has no beat to inherit.", count=len(early_greens)))
    return facts, repairs


def _events_facts(lines: list[str]) -> tuple[dict, list[dict]]:
    """Breaks, background and the events this phase does not carry yet.

    A break is ``2,start,end`` (older maps write ``Break``). Backgrounds and
    videos are ``0,…`` and ``1,…`` or ``Video,…``; storyboard lines are
    everything else, and counting them is how row 25.12 stays honest about
    what it drops instead of dropping it quietly.
    """
    breaks: list[dict] = []
    background: str | None = None
    video = 0
    storyboard = 0
    for raw in lines:
        text = str(raw).strip()
        if not text or text.startswith("//"):
            continue
        fields = [f.strip() for f in text.split(",")]
        kind = fields[0].lower()
        if kind in ("2", "break") and len(fields) >= 3:
            try:
                start, end = float(fields[1]), float(fields[2])
            except ValueError:
                continue
            if end > start:
                breaks.append({"start_ms": round(start, 3), "end_ms": round(end, 3)})
        elif kind == "0" and len(fields) >= 3 and background is None:
            background = fields[2].strip().strip('"')
        elif kind in ("1", "video"):
            video += 1
        elif kind not in ("0", "2", "break"):
            storyboard += 1
    facts = {"breaks": breaks, "background": background,
             "video": video, "storyboard": storyboard}
    repairs: list[dict] = []
    if video:
        repairs.append(_repair(
            "events_video", f"{video} video event(s) are not carried into a compilation.",
            count=video))
    if storyboard:
        repairs.append(_repair(
            "events_storyboard",
            f"{storyboard} storyboard event line(s) are not carried into a compilation.",
            count=storyboard))
    return facts, repairs


def _sample_facts(beatmap: dict, timing_lines: list[str], folder: Path) -> tuple[dict, list[dict]]:
    """Which custom sample indices and files this segment depends on.

    The indices are what row 25.8 has to remap so two segments cannot claim
    the same number; the named files are the ones an object asks for by name,
    and those can be checked here and now. Whether ``soft-hitclap7.wav``
    exists for index 7 is the remapper's question, since the answer depends
    on the set in force at each object.
    """
    indices: set[int] = set()
    for raw in timing_lines:
        fields = _timing_point_fields(str(raw).strip())
        if fields is not None and fields["sample_index"] > 1:
            indices.add(int(fields["sample_index"]))
    named: set[str] = set()
    for obj in beatmap.get("hitobjects", []):
        sample = obj.get("hit_sample") or {}
        try:
            index = int(sample.get("index") or 0)
        except (TypeError, ValueError):
            index = 0
        if index > 1:
            indices.add(index)
        file = str(sample.get("file") or "").strip()
        if file:
            named.add(file)
    files = _folder_index(folder)
    missing = sorted(name for name in named if name.lower() not in files)
    facts = {"indices": sorted(indices), "files": sorted(named), "missing": missing}
    repairs: list[dict] = []
    if missing:
        repairs.append(_repair(
            "samples_missing",
            f"{len(missing)} sample file(s) an object names are not in the folder: "
            f"{', '.join(missing[:4])}{'…' if len(missing) > 4 else ''}.",
            count=len(missing)))
    return facts, repairs


def _in_range(objects: list[dict], span: dict) -> tuple[int, int]:
    """How many objects the range keeps, and how many of those outlast it.

    An object belongs to the range when it **starts** inside it. A spinner or
    a hold that starts inside and ends past the end is kept and counted
    separately: cutting it would change what the mapper wrote, extending the
    range would change what the user asked for, so the builder says so and
    leaves the choice where it belongs. A derived range cannot produce one —
    the tail padding is longer than the gap it would need — which is why this
    only shows up on a range somebody typed.
    """
    start, end = span["start_ms"], span["end_ms"]
    kept = 0
    overrun = 0
    for obj in objects:
        if obj.get("kind") == "unparsed":
            continue
        time = float(obj["time"])
        if time < start - 1e-6 or time > end + 1e-6:
            continue
        kept += 1
        finish = obj.get("end_time")
        if finish is not None and float(finish) > end + 1e-6:
            overrun += 1
    return kept, overrun


def _bookmarks(editor: dict) -> list[float]:
    marks: list[float] = []
    for text in str(editor.get("Bookmarks", "")).split(","):
        text = text.strip()
        if not text:
            continue
        try:
            marks.append(round(float(text), 3))
        except ValueError:
            continue
    return sorted(marks)


def _range_of(objects: dict, audio: dict, start_ms: float | None, end_ms: float | None,
              lead_ms: float, tail_ms: float) -> tuple[dict, list[dict], list[dict]]:
    """The slice of this song the segment contributes, and where it came from.

    Given both ends, they are used as given. Given neither, the objects
    decide and the padding is added around them, which is what a mapper means
    by "this map". The audio's own length is the ceiling when it is known;
    when it is not, the range stays as computed and row 25.4 clips it against
    the real file, since a header that would not read is not evidence of a
    short song.

    A derived range whose padding runs past the end of the song is cut to the
    song without a word: the padding is this function's own invention, and
    reporting it would bury the lines that matter under one every segment
    whose song ends near its last object produces. A range the caller *gave*
    is reported when it is cut, and an object past the end has its own line
    either way.
    """
    repairs: list[dict] = []
    refusals: list[dict] = []
    duration = audio.get("duration_ms")
    source = "given" if start_ms is not None and end_ms is not None else "objects"
    first, last = objects.get("first_ms"), objects.get("last_ms")
    if start_ms is None:
        start = 0.0 if first is None else max(0.0, float(first) - float(lead_ms))
    else:
        start = float(start_ms)
    if end_ms is None:
        if last is None:
            end = float(duration) if duration else start
        else:
            end = float(last) + float(tail_ms)
    else:
        end = float(end_ms)
    if (start_ms is None) != (end_ms is None):
        source = "part-given"
    if start < 0:
        repairs.append(_repair("range_before_zero",
                               f"The range started at {start:.0f} ms; audio starts at 0.",
                               True))
        start = 0.0
    if duration is not None and end > duration:
        if source != "objects":
            repairs.append(_repair(
                "range_past_audio",
                f"The range ended at {end:.0f} ms, past the song's {duration:.0f} ms; "
                f"it is cut to the song.", True))
        end = float(duration)
    if duration is not None and start >= duration:
        refusals.append({"code": "range_after_audio",
                         "why": f"The range starts at {start:.0f} ms, at or past the "
                                f"song's {duration:.0f} ms."})
    if end <= start:
        refusals.append({"code": "range_empty",
                         "why": f"The range is empty ({start:.0f}-{end:.0f} ms)."})
    inside = None
    if objects.get("played"):
        inside = (first is not None and float(first) >= start - 1e-6
                  and last is not None and float(last) <= end + 1e-6)
        if not inside:
            repairs.append(_repair(
                "range_cuts_objects",
                f"The range {start:.0f}-{end:.0f} ms does not hold every object "
                f"({first:.0f}-{last:.0f} ms); the ones outside it are left out.",
                True))
    return ({"start_ms": round(start, 3), "end_ms": round(end, 3),
             "duration_ms": round(max(0.0, end - start), 3), "from": source,
             "lead_ms": round(float(lead_ms), 3), "tail_ms": round(float(tail_ms), 3),
             "holds_every_object": inside},
            repairs, refusals)


def read_segment(osu_path: str | os.PathLike[str], *,
                 audio: str | os.PathLike[str] | None = None,
                 start_ms: float | None = None, end_ms: float | None = None,
                 lead_ms: float = DEFAULT_LEAD_MS,
                 tail_ms: float = DEFAULT_TAIL_MS) -> dict:
    """One source map as a compilation segment: its facts, its repairs, its range.

    Everything a plan needs about a difficulty and nothing it does not: the
    counts and times, the settings that cannot vary inside one map (mode, key
    count, multipliers, the difficulty numbers), the audio and its length from
    the header alone, the marks and breaks to carry, the custom samples to
    remap — and the two lists that make the builder honest, ``repairs`` and
    ``refusals``.

    The parsed beatmap is deliberately **not** in the result. The document is
    JSON, so a plan can be saved, re-read and reported on without the sources;
    the assembly reads each map again, which costs milliseconds and means a
    saved plan builds the same way tomorrow.

    A file that will not read comes back refused rather than raising: a plan
    of five songs must be able to show all five, including the broken one.
    """
    path = Path(osu_path)
    folder = path.parent
    segment: dict = {"osu": str(path), "folder": str(folder), "name": path.stem,
                     "repairs": [], "refusals": [], "usable": False}
    try:
        beatmap = ta.read_osu_beatmap(path)
    except (OSError, ValueError) as exc:
        segment["refusals"].append({"code": "unreadable", "why": str(exc)})
        return segment

    general = beatmap.get("general", {})
    metadata = beatmap.get("metadata", {})
    difficulty = beatmap.get("difficulty", {})
    repairs: list[dict] = []
    refusals: list[dict] = []

    version = int(beatmap.get("format") or 0)
    if not version:
        repairs.append(_repair(
            "format_unknown",
            "The file does not state an osu! format version; it is read as the newest."))

    mode = _int_or_none(_number(general, "Mode")) or 0
    keys = _int_or_none(_number(difficulty, "CircleSize")) if mode == 3 else None

    named = general.get("AudioFilename")
    if audio is not None:
        audio_path: Path | None = Path(audio)
        how = "given"
        if not audio_path.is_file():
            repairs.append(_repair("audio_missing",
                                   f"The audio given, {audio_path.name!r}, is not a file."))
            audio_path = None
            how = "missing"
    else:
        audio_path, how, found_repairs = _find_audio(folder, named)
        repairs.extend(found_repairs)
    audio_facts, audio_repairs = _audio_facts(audio_path)
    repairs.extend(audio_repairs)

    objects, object_repairs = _object_facts(beatmap.get("hitobjects", []))
    repairs.extend(object_repairs)
    timing_lines = next((s["lines"] for s in beatmap.get("sections", [])
                         if s.get("name") == "TimingPoints"), [])
    timing, timing_repairs = _timing_facts(timing_lines)
    repairs.extend(timing_repairs)
    events_lines = next((s["lines"] for s in beatmap.get("sections", [])
                         if s.get("name") == "Events"), [])
    events, event_repairs = _events_facts(events_lines)
    repairs.extend(event_repairs)
    samples, sample_repairs = _sample_facts(beatmap, timing_lines, folder)
    repairs.extend(sample_repairs)

    if not objects["played"]:
        refusals.append({"code": "no_objects",
                         "why": "The map has no object a compilation could borrow."})
    if not timing["reds"]:
        refusals.append({"code": "no_timing",
                         "why": "The map has no red line, so its beat cannot be kept."})
    elif timing["first_red_ms"] is not None and objects["first_ms"] is not None \
            and objects["first_ms"] < timing["first_red_ms"]:
        repairs.append(_repair(
            "objects_before_first_red",
            f"The first object ({objects['first_ms']:.0f} ms) comes before the first red "
            f"line ({timing['first_red_ms']:.0f} ms), where osu! has no grid.",
            at=objects["first_ms"]))
    if audio_facts["duration_ms"] is not None and objects["last_ms"] is not None \
            and objects["last_ms"] > audio_facts["duration_ms"]:
        repairs.append(_repair(
            "objects_past_audio",
            f"The last object ({objects['last_ms']:.0f} ms) is past the song's end "
            f"({audio_facts['duration_ms']:.0f} ms).", at=objects["last_ms"]))

    span, range_repairs, range_refusals = _range_of(
        objects, audio_facts, start_ms, end_ms, lead_ms, tail_ms)
    repairs.extend(range_repairs)
    refusals.extend(range_refusals)
    kept, overrun = _in_range(beatmap.get("hitobjects", []), span)
    objects.update({"in_range": kept, "ends_past_range": overrun})
    if overrun:
        repairs.append(_repair(
            "objects_end_past_range",
            f"{overrun} object(s) start inside the range and end after it; they are kept "
            f"whole and their sound runs into the next segment.", count=overrun))
    if kept == 0 and objects["played"]:
        refusals.append({"code": "range_holds_nothing",
                         "why": f"No object of the map starts inside "
                                f"{span['start_ms']:.0f}-{span['end_ms']:.0f} ms."})

    approach = _number(difficulty, "ApproachRate")
    overall = _number(difficulty, "OverallDifficulty")
    if approach is None and overall is not None:
        repairs.append(_repair(
            "difficulty_ar_from_od",
            f"The map states no ApproachRate; osu! reads the OverallDifficulty "
            f"({overall:g}) instead, and so does this.", True))
        approach = overall

    preview = _number(general, "PreviewTime")
    segment.update({
        "name": metadata.get("Version") or path.stem,
        "format": version,
        "mode": mode, "mode_name": MODE_NAMES.get(mode, str(mode)), "keys": keys,
        "metadata": {key: metadata.get(key) for key in
                     ("Title", "TitleUnicode", "Artist", "ArtistUnicode", "Creator",
                      "Version", "Source", "Tags")},
        "difficulty": {"hp": _number(difficulty, "HPDrainRate"),
                       "cs": _number(difficulty, "CircleSize"),
                       "od": overall, "ar": approach,
                       "slider_multiplier": _number(difficulty, "SliderMultiplier"),
                       "slider_tick_rate": _number(difficulty, "SliderTickRate"),
                       "stack_leniency": _number(general, "StackLeniency")},
        "audio": {"path": None if audio_path is None else str(audio_path),
                  "named": named, "how": how, **audio_facts},
        "range": span,
        "objects": objects, "timing": timing, "samples": samples,
        "breaks": events["breaks"], "background": events["background"],
        "events": {"video": events["video"], "storyboard": events["storyboard"]},
        "bookmarks": _bookmarks(beatmap.get("editor", {})),
        "preview_ms": None if preview is None or preview < 0 else round(preview, 3),
        "lead_in_ms": _number(general, "AudioLeadIn") or 0.0,
        "repairs": repairs, "refusals": refusals, "usable": not refusals,
    })
    return segment


# ---------------------------------------------------------------------------
# The compilation document (Phase 25, row 25.1)
# ---------------------------------------------------------------------------

#: What a plan does when the caller says nothing. Every one of these can be
#: given per plan, and the two paddings per segment.
DEFAULT_SETTINGS: dict = {
    #: Silence before the first segment's range, so a compilation does not
    #: open on a hit. osu!'s own AudioLeadIn exists for the same reason.
    "lead_in_ms": 2000.0,
    #: Silence between two segments. Long enough for osu! to draw a break in,
    #: which is row 25.11's job and this one's reason for a default this wide.
    "gap_ms": 2000.0,
    #: The padding a derived range keeps around the objects.
    "lead_ms": DEFAULT_LEAD_MS,
    "tail_ms": DEFAULT_TAIL_MS,
    #: Refuse instead of repairing: one odd thing in one source and the plan
    #: says no. For a build somebody else will play.
    "strict": False,
}

#: Per-segment keys a source may carry beside its path. ``gap_before_ms``
#: overrides the plan's gap for the junction in front of this segment, and
#: ``gain_db`` is carried for row 25.6, which is the only thing that reads it.
SOURCE_KEYS = ("osu", "audio", "start_ms", "end_ms", "lead_ms", "tail_ms",
               "gap_before_ms", "gain_db")

#: Ceilings, so a wrong plan fails before it writes. Past these the result is
#: not a marathon map, it is a mistake with a long render time.
MAX_TOTAL_MS = 2 * 60 * 60 * 1000.0
MAX_TOTAL_OBJECTS = 200_000


def _source_spec(source) -> dict:
    """One entry of ``sources`` as a dict, whatever shape it arrived in."""
    if isinstance(source, (str, os.PathLike)):
        return {"osu": source}
    if not isinstance(source, dict):
        raise ValueError(f"A source is a path or a dict, not {type(source).__name__}.")
    spec = dict(source)
    unknown = sorted(set(spec) - set(SOURCE_KEYS))
    if unknown:
        raise ValueError(f"Unknown key(s) on a source: {', '.join(unknown)}. "
                         f"Known: {', '.join(SOURCE_KEYS)}.")
    if not spec.get("osu"):
        raise ValueError("A source needs an 'osu' path.")
    return spec


def plan_compilation(sources, settings: dict | None = None) -> dict:
    """Several sources as one ordered, placed, checked compilation document.

    The order given is the order built — an order *proposed* is row 25.19, and
    it will propose, not apply. Each segment keeps its own range; the plan
    says where that range lands in the output (``at_ms``) and what every
    timestamp of that map moves by to get there (``shift_ms``).

    **The shift is a whole number of milliseconds and the gap absorbs the
    remainder.** osu!stable writes object times as integers, so a shift with a
    fraction in it would turn every whole millisecond in a source into a
    rounded one — a map's own snapping, lost to arithmetic nobody asked for.
    Moving the junction by less than a millisecond instead costs nothing
    anybody can hear.

    What refuses the whole plan: a segment that refused itself, two segments
    in different modes or with different mania key counts, a segment with no
    song to cut, the ceilings above, and — under ``strict`` — any repair at
    all. What does not: anything the reader could resolve, which comes back in
    ``repairs`` with the segment it belongs to.

    Plain JSON throughout, deliberately: the document is the thing a build is
    resumed from and a report is written from, so it has to survive being
    written to a file and read back without the sources.
    """
    chosen = {**DEFAULT_SETTINGS, **(settings or {})}
    unknown = sorted(set(chosen) - set(DEFAULT_SETTINGS))
    if unknown:
        raise ValueError(f"Unknown setting(s): {', '.join(unknown)}. "
                         f"Known: {', '.join(DEFAULT_SETTINGS)}.")
    specs = [_source_spec(source) for source in sources]
    if not specs:
        raise ValueError("A compilation needs at least one source.")

    segments: list[dict] = []
    for spec in specs:
        segment = read_segment(
            spec["osu"], audio=spec.get("audio"),
            start_ms=spec.get("start_ms"), end_ms=spec.get("end_ms"),
            lead_ms=float(spec.get("lead_ms", chosen["lead_ms"])),
            tail_ms=float(spec.get("tail_ms", chosen["tail_ms"])))
        segment["gain_db"] = float(spec.get("gain_db") or 0.0)
        segment["gap_before_ms"] = (None if spec.get("gap_before_ms") is None
                                    else float(spec["gap_before_ms"]))
        segments.append(segment)

    refusals: list[dict] = []
    repairs: list[dict] = []
    for n, segment in enumerate(segments):
        for repair in segment["repairs"]:
            repairs.append({"segment": n, **repair})
        for refusal in segment["refusals"]:
            refusals.append({"segment": n, **refusal})
        if segment["usable"] and segment["audio"]["path"] is None:
            refusals.append({"segment": n, "code": "segment_without_audio",
                             "why": f"{Path(segment['osu']).name} has no song to cut; "
                                    f"a segment has to bring its own audio."})

    modes = sorted({segment["mode"] for segment in segments})
    if len(modes) > 1:
        refusals.append({"segment": None, "code": "mode_mismatch",
                         "why": "The sources are in different game modes ("
                                + ", ".join(MODE_NAMES.get(m, str(m)) for m in modes)
                                + "); one map holds one mode."})
    keys = sorted({segment["keys"] for segment in segments
                   if segment["mode"] == 3 and segment["keys"] is not None})
    if len(keys) > 1:
        refusals.append({"segment": None, "code": "keys_mismatch",
                         "why": f"The mania sources want different key counts "
                                f"({', '.join(str(k) for k in keys)}); one map holds one."})

    # Placement. The cursor is where the next segment's range would start; the
    # shift that gets it there is rounded, and ``at_ms`` follows the shift
    # rather than the cursor, so the objects stay on whole milliseconds.
    cursor = float(chosen["lead_in_ms"])
    junctions: list[dict] = []
    for n, segment in enumerate(segments):
        gap = float(chosen["gap_ms"] if segment["gap_before_ms"] is None
                    else segment["gap_before_ms"])
        if n:
            junctions.append({"after": n - 1, "before": n,
                              "ends_ms": round(cursor, 3),
                              "gap_ms": round(gap, 3),
                              "starts_ms": round(cursor + gap, 3)})
            cursor += gap
        start = segment["range"]["start_ms"]
        shift = float(round(cursor - start))
        segment["shift_ms"] = shift
        segment["at_ms"] = round(start + shift, 3)
        segment["ends_at_ms"] = round(segment["at_ms"] + segment["range"]["duration_ms"], 3)
        cursor = segment["at_ms"] + segment["range"]["duration_ms"]

    totals = {
        "segments": len(segments),
        "duration_ms": round(cursor, 3),
        "objects": sum(segment["objects"].get("in_range", 0) for segment in segments),
        "reds": sum(segment["timing"]["reds"] for segment in segments),
        "greens": sum(segment["timing"]["greens"] for segment in segments),
        "songs": len({segment["audio"]["path"] for segment in segments
                      if segment["audio"]["path"]}),
    }
    if totals["duration_ms"] > MAX_TOTAL_MS:
        refusals.append({"segment": None, "code": "too_long",
                         "why": f"The compilation would run "
                                f"{totals['duration_ms'] / 60000.0:.0f} minutes, past the "
                                f"{MAX_TOTAL_MS / 60000.0:.0f}-minute ceiling."})
    if totals["objects"] > MAX_TOTAL_OBJECTS:
        refusals.append({"segment": None, "code": "too_many_objects",
                         "why": f"The compilation would hold {totals['objects']} objects, "
                                f"past the {MAX_TOTAL_OBJECTS} ceiling."})
    if chosen["strict"] and repairs:
        refusals.append({"segment": None, "code": "strict_repairs",
                         "why": f"Strict: {len(repairs)} repair(s) across "
                                f"{len({r['segment'] for r in repairs})} segment(s), and "
                                f"strict builds nothing it had to work around."})

    return {"format": PLAN_FORMAT, "settings": chosen, "segments": segments,
            "junctions": junctions, "totals": totals,
            "mode": modes[0] if len(modes) == 1 else None,
            "keys": keys[0] if len(keys) == 1 else None,
            "repairs": repairs, "refusals": refusals, "usable": not refusals}


# ---------------------------------------------------------------------------
# The shift and the assembly (Phase 25, row 25.3)
# ---------------------------------------------------------------------------

#: The format the builder writes. Sources are read from v3 up; one version is
#: written, and it is the one osu!stable writes itself.
WRITE_FORMAT = 14

#: Places kept on a time that does not land on a whole millisecond. Whole
#: milliseconds stay whole — what osu!stable reads — and a source that came
#: from lazer keeps its decimals rather than being rounded into place.
WRITE_DECIMALS = 3


def _ms_text(value: float, decimals: int = WRITE_DECIMALS) -> str:
    """A time as the writer puts it: whole when it is whole, else ``decimals``
    places. The rule ``_shifted_number`` uses, for numbers this module makes
    rather than moves."""
    whole = round(value)
    if abs(value - whole) < 0.5 * 10 ** -decimals:
        return str(int(whole))
    return f"{value:.{decimals}f}"


def _shift_object_line(raw: str, shift: float, decimals: int) -> str:
    """One object line moved, every other character of it untouched.

    The sixth field is three different things and each needs its own rule: a
    slider's curve (geometry, not a time), a spinner's end time, and a mania
    hold's ``end:sample``. The reference tool treats it as a slider end time,
    which is the one thing it never is.
    """
    fields = raw.split(",")
    fields[2] = ta._shifted_number(fields[2], shift, decimals)
    if len(fields) > 5:
        type_bits = int(fields[3])
        if type_bits & 128:                                  # mania hold
            head, colon, tail = fields[5].partition(":")
            fields[5] = ta._shifted_number(head, shift, decimals) + colon + tail
        elif type_bits & 8:                                  # spinner
            fields[5] = ta._shifted_number(fields[5], shift, decimals)
    return ",".join(fields)


def _shift_timing_line(raw: str, shift: float, decimals: int) -> str:
    """One timing line moved. Only the offset moves: a beat length, meter,
    sample set, volume and effects mean the same thing wherever they sit."""
    fields = raw.split(",")
    fields[0] = ta._shifted_number(fields[0], shift, decimals)
    return ",".join(fields)


def _points_of(beatmap: dict) -> list[dict]:
    """Every timing point with its raw line, in file order."""
    section = next((s for s in beatmap.get("sections", [])
                    if s.get("name") == "TimingPoints"), None)
    points = []
    for raw in (section or {}).get("lines", []):
        text = str(raw).strip()
        if not text or text.startswith("//"):
            continue
        fields = _timing_point_fields(text)
        if fields is None:
            continue
        points.append({**fields, "raw": text})
    return sorted(points, key=lambda p: (p["time"], 0 if p["red"] else 1))


def _state_red(governing: dict, time_ms: float, state, decimals: int) -> str:
    """The segment's own grid and sound, pinned at its start.

    Built from the governing red line's **raw** fields, so the beat length
    keeps the digits the mapper's editor wrote (266.666666666667 rounded to
    three places is a different tempo). The sample set, index, volume and kiai
    come from the state actually in force at that moment, which a green line
    may have changed since that red.
    """
    fields = governing["raw"].split(",")
    while len(fields) < 8:
        fields.append(ta._GREEN_FIELD_DEFAULTS[len(fields)])
    fields[0] = _ms_text(time_ms, decimals)
    fields[3] = str(int(state.sample_set))
    fields[4] = str(int(state.sample_index))
    fields[5] = str(int(state.volume))
    fields[6] = "1"
    fields[7] = str((int(fields[7] or 0) & ~1) | (1 if state.kiai else 0))
    return ",".join(fields[:8])


def _state_green(time_ms: float, state, decimals: int) -> str | None:
    """The slider velocity in force at the segment's start, if it is not 1.

    A red line resets velocity to 1.0, so the green that was carrying 0.8x in
    the source has to be restated or the segment's first sliders are faster
    than the mapper made them. The cross-map part — this segment's
    ``SliderMultiplier`` against the one the compilation writes — is row 25.9,
    and until it lands this green carries the source's own number only.
    """
    if abs(state.sv - 1.0) <= 1e-9:
        return None
    beat = -100.0 / state.sv
    return (f"{_ms_text(time_ms, decimals)},{_ms_text(beat, 6)},4,"
            f"{int(state.sample_set)},{int(state.sample_index)},"
            f"{int(state.volume)},0,{1 if state.kiai else 0}")


def _segment_lines(segment: dict, beatmap: dict, floor_ms: float,
                   decimals: int) -> tuple[list[tuple], list[tuple], list[dict], list[dict]]:
    """One segment's timing lines and object lines, placed.

    Returns ``(timing, objects, notes, refusals)``, each timing and object
    entry a ``(time, red_first, text)`` tuple so the caller can merge the
    segments and sort once.
    """
    shift = float(segment["shift_ms"])
    start, end = segment["range"]["start_ms"], segment["range"]["end_ms"]
    at = float(segment["at_ms"])
    notes: list[dict] = []
    refusals: list[dict] = []
    points = _points_of(beatmap)
    reds = [p for p in points if p["red"] and p["beat_length"] > 0]
    if not reds:
        return [], [], notes, [{"code": "no_timing",
                                "why": "The segment has no usable red line."}]

    # The red in force at the segment's start: the last one at or before it,
    # else the first one in the map (what osu! itself reads before its first
    # timing point).
    governing = next((p for p in reversed(reds) if p["time"] <= start + 1e-6), reds[0])
    timing: list[tuple] = []
    # A red line carries its own sample set, index, volume and kiai, and resets
    # slider velocity, so a red sitting at or after the range's start already
    # says everything about the state there: nothing to pin, and restating it
    # would overwrite that red's own fields with an earlier green's.
    if governing["time"] < start - 1e-6:
        _beat, state = ta._TimingCursor(beatmap).at(start)
        # Phase, not position: the grid must keep the beat it had, so the pinned
        # red sits at the governing red's own shifted time stepped by **whole
        # beats** into the gap in front of the segment. Rounding it into place
        # instead would move every bar line in the segment by the same error.
        beat = float(governing["beat_length"])
        red_at = governing["time"] + shift
        steps = 0
        if red_at < floor_ms:
            steps = int((floor_ms - red_at) / beat) + 1
            red_at += steps * beat
        notes.append({"code": "grid_pinned",
                      "what": f"The grid is pinned at {red_at:.3f} ms: the governing red "
                              f"line's own phase, stepped {steps} beat(s) forward so it "
                              f"falls in this segment's own time and not the one before."})
        # The first object **of this range**, not of the map: a range typed
        # into the middle of a song leaves every earlier object behind, and
        # comparing against one of those refused a junction that was fine.
        first_object = min((float(obj["time"]) for obj in beatmap.get("hitobjects", [])
                            if obj.get("kind") != "unparsed"
                            and start - 1e-6 <= float(obj["time"]) <= end + 1e-6),
                           default=None)
        if first_object is not None and red_at > first_object + shift + 1e-6:
            refusals.append({
                "code": "junction_too_tight",
                "why": f"The gap in front of this segment is shorter than one of its "
                       f"beats ({beat:.0f} ms), so its grid cannot be pinned before its "
                       f"first object. Widen the gap to at least {beat:.0f} ms."})
            return [], [], notes, refusals
        timing.append((red_at, 0, _state_red(governing, red_at, state, decimals)))
        green = _state_green(max(at, red_at), state, decimals)
        if green is not None:
            timing.append((max(at, red_at), 1, green))

    for point in points:
        if point["time"] < start - 1e-6 or point["time"] > end + 1e-6:
            continue
        timing.append((point["time"] + shift, 0 if point["red"] else 1,
                       _shift_timing_line(point["raw"], shift, decimals)))

    objects: list[tuple] = []
    dropped = 0
    for obj in beatmap.get("hitobjects", []):
        if obj.get("kind") == "unparsed":
            dropped += 1
            continue
        time = float(obj["time"])
        if time < start - 1e-6 or time > end + 1e-6:
            continue
        objects.append((time + shift, 0,
                        _shift_object_line(str(obj["raw"]).strip(), shift, decimals)))
    if dropped:
        notes.append({"code": "objects_dropped",
                      "what": f"{dropped} object line(s) that do not read as objects were "
                              f"left out: a line with no time cannot be placed."})
    return timing, objects, notes, refusals


def _header_sections(plan: dict, audio_name: str, preview_ms: float | None,
                     bookmarks: list[float], background: str | None,
                     breaks: list[tuple], decimals: int) -> list[str]:
    """Everything above [TimingPoints], from the first segment plus the plan.

    Deliberately thin. Metadata, credits and the difficulty reconciliation are
    rows 25.13 and 25.10; until they land these come from the first segment and
    the report says so, which is better than a second set of defaults nobody
    chose.
    """
    first = plan["segments"][0]
    difficulty = first["difficulty"]
    mode = plan["mode"] if plan["mode"] is not None else 0

    def number(value, fallback: str) -> str:
        return fallback if value is None else f"{float(value):g}"

    metadata = first["metadata"]

    def text(key: str, fallback: str = "") -> str:
        value = metadata.get(key)
        return fallback if value is None else str(value).strip()

    lines = [f"osu file format v{WRITE_FORMAT}", "",
             "[General]",
             f"AudioFilename: {audio_name}",
             "AudioLeadIn: 0",
             f"PreviewTime: {-1 if preview_ms is None else int(round(preview_ms))}",
             "Countdown: 0",
             "SampleSet: Normal",
             f"StackLeniency: {number(difficulty['stack_leniency'], '0.7')}",
             f"Mode: {mode}",
             "LetterboxInBreaks: 0",
             "WidescreenStoryboard: 0",
             "",
             "[Editor]",
             *([f"Bookmarks: {','.join(_ms_text(m, decimals) for m in bookmarks)}"]
               if bookmarks else []),
             "DistanceSpacing: 1",
             "BeatDivisor: 4",
             "GridSize: 4",
             "TimelineZoom: 1",
             "",
             "[Metadata]",
             f"Title:{text('Title', 'Compilation')}",
             f"TitleUnicode:{text('TitleUnicode') or text('Title', 'Compilation')}",
             f"Artist:{text('Artist', 'Various Artists')}",
             f"ArtistUnicode:{text('ArtistUnicode') or text('Artist', 'Various Artists')}",
             f"Creator:{text('Creator', 'Overtone')}",
             "Version:Compilation",
             f"Source:{text('Source')}",
             f"Tags:{text('Tags')}",
             "BeatmapID:0",
             "BeatmapSetID:-1",
             "",
             "[Difficulty]",
             f"HPDrainRate:{number(difficulty['hp'], '5')}",
             f"CircleSize:{number(difficulty['cs'], '4')}",
             f"OverallDifficulty:{number(difficulty['od'], '5')}",
             f"ApproachRate:{number(difficulty['ar'], '5')}",
             f"SliderMultiplier:{number(difficulty['slider_multiplier'], '1.4')}",
             f"SliderTickRate:{number(difficulty['slider_tick_rate'], '1')}",
             "",
             "[Events]",
             "//Background and Video events"]
    if background:
        lines.append(f'0,0,"{background}",0,0')
    lines.append("//Break Periods")
    for start, end in breaks:
        lines.append(f"2,{_ms_text(start, decimals)},{_ms_text(end, decimals)}")
    lines.extend(["//Storyboard Layer 0 (Background)", "//Storyboard Layer 1 (Fail)",
                  "//Storyboard Layer 2 (Pass)", "//Storyboard Layer 3 (Foreground)",
                  "//Storyboard Layer 4 (Overlay)", "//Storyboard Sound Samples", ""])
    return lines


def combine_beatmap(plan: dict, audio_name: str = "audio.mp3",
                    decimals: int = WRITE_DECIMALS) -> tuple[str, dict]:
    """The compilation as one ``.osu``: every borrowed timestamp where it belongs.

    What moves, and the rule for each, is the specification this row exists
    for: object starts; a spinner's and a mania hold's end; every timing
    point's offset; the breaks; the bookmarks; the preview point. What does not
    move: a slider's curve, which is geometry, and the fields that say what a
    line *means* rather than when it happens.

    Each segment is pinned at its start with the grid and the sound its own map
    had there — the governing red line's own beat length, built from that
    line's raw digits, placed by whole beats so the phase is the phase the
    mapper set, plus the sample set, index, volume, kiai and slider velocity in
    force at that moment. Without that pinning a segment inherits the state the
    previous song happened to end in.

    Returns the text and a report. The report's ``pending`` list is the honest
    part: the hitsound indices are not remapped yet (row 25.8), the slider
    multipliers are not reconciled (25.9), the difficulty numbers come from the
    first segment (25.10), and the metadata is its metadata (25.13). Each entry
    names the row that will answer it, so what this builds today is not
    mistaken for what it will build.

    Writing the file is row 25.16; this returns text, which is also what makes
    it testable against a reader.
    """
    if not plan.get("usable"):
        why = "; ".join(r.get("why") or r.get("code", "?")
                        for r in plan.get("refusals", ())) or "no reason given"
        raise ValueError(f"This plan refused: {why}")
    if int(plan.get("format") or 0) != PLAN_FORMAT:
        raise ValueError(f"Plan format {plan.get('format')!r} is not {PLAN_FORMAT}.")

    timing: list[tuple] = []
    objects: list[tuple] = []
    bookmarks: list[float] = []
    breaks: list[tuple] = []
    notes: list[dict] = []
    refusals: list[dict] = []
    per_segment: list[dict] = []
    preview: float | None = None
    floor_ms = 0.0

    for n, segment in enumerate(plan["segments"]):
        beatmap = ta.read_osu_beatmap(segment["osu"])
        shift = float(segment["shift_ms"])
        start, end = segment["range"]["start_ms"], segment["range"]["end_ms"]
        rows, hits, segment_notes, segment_refusals = _segment_lines(
            segment, beatmap, floor_ms, decimals)
        timing.extend(rows)
        objects.extend(hits)
        notes.extend({"segment": n, **note} for note in segment_notes)
        refusals.extend({"segment": n, **refusal} for refusal in segment_refusals)
        for mark in segment["bookmarks"]:
            if start - 1e-6 <= mark <= end + 1e-6:
                bookmarks.append(mark + shift)
        for period in segment["breaks"]:
            if period["end_ms"] <= start or period["start_ms"] >= end:
                continue
            breaks.append((max(period["start_ms"], start) + shift,
                           min(period["end_ms"], end) + shift))
        if preview is None and segment["preview_ms"] is not None \
                and start - 1e-6 <= segment["preview_ms"] <= end + 1e-6:
            preview = segment["preview_ms"] + shift
        per_segment.append({"segment": n, "name": segment["name"],
                            "at_ms": segment["at_ms"], "shift_ms": shift,
                            "objects": len(hits), "timing_lines": len(rows)})
        floor_ms = float(segment["ends_at_ms"])

    if refusals:
        raise ValueError("The assembly refused: " + "; ".join(
            f"segment {r['segment']}: {r['why']}" for r in refusals))

    first = plan["segments"][0]
    written_multiplier = first["difficulty"]["slider_multiplier"]
    pending: list[dict] = []
    if len(plan["segments"]) > 1:
        sampled = [n for n, s in enumerate(plan["segments"])
                   if s["samples"]["indices"] or s["samples"]["files"]]
        if sampled:
            pending.append({"row": "25.8", "code": "samples_not_remapped",
                            "what": "Custom hitsound indices and files are carried as "
                                    "written, so two segments can claim the same number.",
                            "segments": sampled})
        differing = [n for n, s in enumerate(plan["segments"])
                     if s["difficulty"]["slider_multiplier"] != written_multiplier]
        if differing:
            pending.append({"row": "25.9", "code": "multiplier_not_reconciled",
                            "what": f"These segments were made at a different "
                                    f"SliderMultiplier than the "
                                    f"{written_multiplier} written, so their sliders "
                                    f"move at the wrong speed.",
                            "segments": differing})
        pending.append({"row": "25.10", "code": "difficulty_from_first_segment",
                        "what": "HP, CS, OD, AR and stack leniency are the first "
                                "segment's: one map holds one set of them."})
    pending.append({"row": "25.13", "code": "metadata_from_first_segment",
                    "what": "Title, artist, creator and tags are the first segment's; "
                            "nothing credits the other mappers yet."})

    body = _header_sections(plan, audio_name, preview, sorted(bookmarks),
                            first["background"], sorted(breaks), decimals)
    body.append("[TimingPoints]")
    body.extend(text for _t, _r, text in
                sorted(timing, key=lambda row: (row[0], row[1])))
    body.extend(["", "[HitObjects]"])
    body.extend(text for _t, _r, text in sorted(objects, key=lambda row: row[0]))
    body.append("")
    text = "\r\n".join(body)

    report = {"audio_name": audio_name, "format": WRITE_FORMAT, "decimals": decimals,
              "segments": per_segment,
              "objects": len(objects), "timing_lines": len(timing),
              "bookmarks": len(bookmarks), "breaks": len(breaks),
              "preview_ms": None if preview is None else round(preview, 3),
              "duration_ms": plan["totals"]["duration_ms"],
              "notes": notes, "pending": pending}
    return text, report
