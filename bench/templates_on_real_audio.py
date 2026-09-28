"""Do the instrument templates hold on real music, and what would fix them?

The roadmap's instrument-lane row waits on one number: at the places mappers
put claps, how sure is the classifier that it hears a snare or a clap? On the
Python templates, over 11 songs, the median was 0.138 — too weak to draw a lane
from, so the lanes waited. This re-measures it against the Rust classifier, and
measures the one change that looks likely to fix it.

    python bench/templates_on_real_audio.py            # the mix, as shipped
    python bench/templates_on_real_audio.py --stem     # and the percussive half
    python bench/templates_on_real_audio.py --songs 12 --stem

Mapper claps are the truth here for a reason: a mapper who puts a clap on a
beat is telling us a snare or a clap is audible there, over thousands of
examples, without anyone labelling anything. It is not perfect — some claps
ride a kick, some a vocal — but no other label of real music exists in this
quantity.

``--stem`` writes the percussive half of each song to a scratch file and reads
that instead. Nothing is written beside the user's songs; the stems are
temporary and deleted. It is a probe, not the engine: the engine reads the mix,
and this says what it would read if it did not.
"""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import overtone as ta  # noqa: E402

CLI = ROOT / "target" / "release" / "overtone-cli.exe"
CORPUS = HERE / "genre_corpus.json"
#: A mapper's clap counts as heard when an attack sits this close to it.
TOLERANCE_MS = 50.0
#: Fewer claps than this in a map says nothing about a classifier.
MIN_CLAPS = 20
#: What the Python templates measured, 11 songs, in the timeline's H3 entry.
PYTHON_MEDIAN = 0.138
#: Genres walked, in this order; one map per audio file.
GENRES = ("rock", "metal", "pop", "electronic", "jrock", "punk")


def evidence(audio: Path) -> dict | None:
    """`overtone-cli hitsound-evidence`, or None when it cannot be read."""
    if not CLI.is_file():
        return None
    try:
        out = subprocess.run([str(CLI), "hitsound-evidence", str(audio)],
                             capture_output=True, text=True, timeout=900)
        return json.loads(out.stdout)
    except Exception:  # noqa: BLE001 -- one unreadable song is not a failure
        return None


def heard(found: dict, events: list[dict]) -> list[float]:
    """P(snare) + P(clap) at each mapper clap with an attack under it."""
    times = np.asarray([a["time_s"] * 1000.0 for a in found["attacks"]])
    order = np.argsort(times)
    sorted_times = times[order]
    out: list[float] = []
    for event in events:
        i = int(np.searchsorted(sorted_times, event["time"]))
        best, best_dt = -1, float("inf")
        for candidate in (i - 1, i):
            if 0 <= candidate < sorted_times.size:
                dt = abs(sorted_times[candidate] - event["time"])
                if dt < best_dt:
                    best, best_dt = int(order[candidate]), dt
        if best >= 0 and best_dt <= TOLERANCE_MS:
            classes = {c["class"]: c["probability"]
                       for c in found["attacks"][best]["classes"]}
            out.append(classes.get("snare", 0.0) + classes.get("clap", 0.0))
    return out


def percussive(audio: Path, out: Path) -> bool:
    """Write the percussive half of a song, for the probe only."""
    try:
        import librosa
        import soundfile
        y, sr = librosa.load(str(audio), sr=22050, mono=True)
        soundfile.write(str(out), librosa.effects.percussive(y, margin=3.0), sr)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"    no stem: {type(exc).__name__}: {exc}")
        return False


def songs(limit: int):
    """(folder, audio, clap events) per song of the genre corpus."""
    if not CORPUS.is_file():
        return
    body = json.loads(CORPUS.read_text(encoding="utf-8"))
    root = Path(body["songs_folder"])
    seen: set[Path] = set()
    given = 0
    for genre in GENRES:
        for row in body["genres"].get(genre, {}).get("sets", []):
            if given >= limit:
                return
            folder = root / row["folder"]
            osu = folder / row["file"]
            if not osu.is_file():
                continue
            try:
                beatmap = ta.read_osu_beatmap(str(osu))
            except Exception:  # noqa: BLE001
                continue
            audio = folder / beatmap["general"].get("AudioFilename", "")
            if not audio.is_file() or audio in seen:
                continue
            events = [e for e in ta.sound_events(beatmap)
                      if e["part"] != "body" and "clap" in e["sounds"]]
            if len(events) < MIN_CLAPS:
                continue
            seen.add(audio)
            given += 1
            yield row["folder"], audio, events


def deciles(values: list[float]) -> str:
    values = sorted(values)

    def at(share: float) -> float:
        return values[min(len(values) - 1, int(share * len(values)))]

    return (f"{at(.1):.3f} / {at(.25):.3f} / {at(.5):.3f} / "
            f"{at(.75):.3f} / {at(.9):.3f}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    want = int(args[args.index("--songs") + 1]) if "--songs" in args else 12
    with_stem = "--stem" in args
    if not CLI.is_file():
        print("No overtone-cli built: cargo build --release -p overtone-cli")
        return 0
    if not CORPUS.is_file():
        print(f"No {CORPUS.name}: run bench/genre_corpus.py --update first.")
        return 0

    mix_all: list[float] = []
    stem_all: list[float] = []
    for folder, audio, events in songs(want):
        found = evidence(audio)
        if not found:
            continue
        on_mix = heard(found, events)
        if len(on_mix) < MIN_CLAPS:
            continue
        mix_all += on_mix
        line = (f"{folder[:44]:<46} {len(events):4d} claps, {len(on_mix)} heard, "
                f"mix {statistics.median(on_mix):.3f}")
        if with_stem:
            with tempfile.TemporaryDirectory(prefix="overtone-stem-") as tmp:
                wav = Path(tmp) / "percussive.wav"
                side = evidence(wav) if percussive(audio, wav) else None
            if side:
                on_stem = heard(side, events)
                stem_all += on_stem
                line += f"   stem {statistics.median(on_stem):.3f}"
        print(line, flush=True)

    for name, pooled in (("mix", mix_all), ("percussive stem", stem_all)):
        if not pooled:
            continue
        print(f"\n{name:<16} {len(pooled)} mapper claps with an attack under them")
        print(f"{'':16} P(snare)+P(clap) deciles {deciles(pooled)}")
        print(f"{'':16} median {statistics.median(pooled):.3f}"
              + (f"   (the Python templates measured {PYTHON_MEDIAN} on 11 songs)"
                 if name == "mix" else ""))
        for cut in (0.25, 0.5):
            share = sum(1 for p in pooled if p >= cut) / len(pooled)
            print(f"{'':16} at or above {cut:.2f}: {share * 100:.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
