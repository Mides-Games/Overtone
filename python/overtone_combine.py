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
