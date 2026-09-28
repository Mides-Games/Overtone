"""What a genre's hitsounds actually sound like, from the maps that use them.

``bench/genre_corpus.py`` measures *where* each genre puts its additions. This
measures *what it puts there*: the sample files those same mapsets ship beside
their maps, read and reduced to a handful of numbers a synthesiser can be aimed
at — how long the hit rings, how bright it is, how much of it is noise rather
than tone, and where its energy sits across seven bands.

Nothing of anyone's audio is copied, kept or shipped. The files are read where
they lie, reduced to per-genre medians, and only those numbers are written. A
kit built from them is Overtone's own synthesis aimed at a measured target, not
a sample anybody recorded — which is the only way to ship one at all.

    python bench/genre_samples.py                 # the report
    python bench/genre_samples.py --only rock,metal
    python bench/genre_samples.py --update        # write bench/genre_samples.json

Read only, and slow the first time: a few thousand short files decoded. The
result is cached in bench/.cache/genre_samples (git-ignored) by path and size.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import overtone as ta  # noqa: E402

MANIFEST = HERE / "genre_samples.json"
CORPUS = HERE / "genre_corpus.json"
CACHE = HERE / ".cache" / "genre_samples"
FORMAT = 2
#: The four sounds osu! plays for an object. Slides are left out: they loop,
#: and a loop is a different measurement.
SOUNDS = ("hitnormal", "hitwhistle", "hitfinish", "hitclap")
BANKS = ("normal", "soft", "drum")
#: Band edges in Hz, the seven the hitsound crate's spectral features use.
BANDS = (20.0, 60.0, 150.0, 400.0, 1200.0, 3500.0, 8000.0, 20000.0)
#: A sample quieter than this at its loudest is silence with a name.
MIN_PEAK = 1e-4
#: The attack is read up to here and no further. 30 ms was too short and the
#: measurement said so: crashes and open hats all read exactly 30.0, which is a
#: censored number pretending to be one. A cymbal swells for a tenth of a
#: second; past that it is ringing, not starting.
ATTACK_S = 0.12
#: Decay is read to this much of the peak, in dB.
DECAY_DB = -30.0
#: Longer than this and it is a loop or a stem, not a hit.
MAX_S = 4.0


def features(y: np.ndarray, sr: int) -> dict | None:
    """One sample reduced to what a synthesiser can be aimed at."""
    y = np.asarray(y, dtype=np.float64)
    if y.size < 64:
        return None
    peak = float(np.max(np.abs(y)))
    if peak < MIN_PEAK or y.size / sr > MAX_S:
        return None
    y = y / peak
    # Decay: where the envelope falls below -30 dB of its peak and stays.
    env = np.abs(y)
    win = max(1, int(0.003 * sr))
    env = np.convolve(env, np.ones(win) / win, mode="same")
    floor = 10 ** (DECAY_DB / 20.0)
    above = np.nonzero(env > floor)[0]
    decay_ms = float((above[-1] - above[0]) / sr * 1000.0) if above.size else 0.0
    start = int(above[0]) if above.size else 0
    # Attack: from the start of sound to the peak, capped — a pad ramping for
    # a second is not a hit with a slow attack, it is not a hit.
    top = int(np.argmax(env))
    attack_ms = float(min(max(top - start, 0) / sr, ATTACK_S) * 1000.0)
    # Spectrum of the first 50 ms, where an object's sound is decided.
    head = y[start:start + int(0.05 * sr)]
    if head.size < 64:
        return None
    window = np.hanning(head.size)
    spectrum = np.abs(np.fft.rfft(head * window)) ** 2
    freqs = np.fft.rfftfreq(head.size, 1.0 / sr)
    total = float(spectrum.sum())
    if total <= 0.0:
        return None
    centroid = float((freqs * spectrum).sum() / total)
    cumulative = np.cumsum(spectrum)
    rolloff = float(freqs[int(np.searchsorted(cumulative, 0.85 * total))])
    ratios = []
    for lo, hi in zip(BANDS[:-1], BANDS[1:]):
        band = spectrum[(freqs >= lo) & (freqs < hi)].sum()
        ratios.append(round(float(band / total), 5))
    zcr = float(np.mean(np.abs(np.diff(np.sign(head))) > 0))
    return {"decay_ms": round(decay_ms, 1), "attack_ms": round(attack_ms, 2),
            "centroid_hz": round(centroid, 1), "rolloff_hz": round(rolloff, 1),
            "zcr": round(zcr, 4), "bands": ratios}


def read(path: Path) -> dict | None:
    """Features of one sample file, cached by path, size and time."""
    try:
        stat = path.stat()
    except OSError:
        return None
    key = f"{path.as_posix()}|{stat.st_size}|{int(stat.st_mtime)}|{FORMAT}"
    import hashlib
    name = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16] + ".json"
    cached = CACHE / name
    if cached.is_file():
        try:
            return json.loads(cached.read_text(encoding="utf-8")) or None
        except (OSError, ValueError):
            pass
    try:
        # The engine's own decoder, so a sample is read exactly as the app
        # would read it; it peak-normalises, which these features do anyway.
        y, sr = ta._load_audio(str(path), lambda _message: None)
    except Exception:  # noqa: BLE001 -- one unreadable sample is not a failure
        got = None
    else:
        got = features(y, sr)
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(got), encoding="utf-8")
    return got


def role_of(name: str) -> tuple[str, str] | None:
    """``(bank, sound)`` of a sample file name, or None when it is not one."""
    stem = name.rsplit(".", 1)[0].lower()
    for bank in BANKS:
        for sound in SOUNDS:
            head = f"{bank}-{sound}"
            if stem == head or (stem.startswith(head) and stem[len(head):].isdigit()):
                return bank, sound
    return None


def measure(only: list[str] | None = None) -> dict:
    """Per genre and role, the median of every sample the maps ship."""
    body = json.loads(CORPUS.read_text(encoding="utf-8"))
    songs = Path(body["songs_folder"])
    out: dict[str, dict] = {}
    for genre, block in body["genres"].items():
        if only and genre not in only:
            continue
        rows: dict[tuple[str, str], list[dict]] = {}
        files = 0
        for entry in block["sets"]:
            folder = songs / entry["folder"]
            try:
                names = [p for p in folder.iterdir() if p.is_file()]
            except OSError:
                continue
            for path in names:
                role = role_of(path.name)
                if role is None:
                    continue
                got = read(path)
                files += 1
                if got:
                    rows.setdefault(role, []).append(got)
        out[genre] = {"files": files, "roles": {}}
        for (bank, sound), found in sorted(rows.items()):
            if len(found) < 5:
                continue
            out[genre]["roles"][f"{bank}-{sound}"] = {
                "n": len(found),
                **{key: round(float(np.median([f[key] for f in found])), 4)
                   for key in ("decay_ms", "attack_ms", "centroid_hz", "rolloff_hz", "zcr")},
                "bands": [round(float(np.median([f["bands"][b] for f in found])), 5)
                          for b in range(len(BANDS) - 1)],
            }
        print(f"{genre:<11} {files:5d} sample files, "
              f"{len(out[genre]['roles'])} roles with enough of them", flush=True)
    return out


def report(measured: dict) -> None:
    print(f"\n{'genre':<11} {'role':<16} {'n':>5} {'decay':>7} {'attack':>7} "
          f"{'centroid':>9} {'rolloff':>8} {'noise':>6}")
    for genre, block in measured.items():
        for role, row in block["roles"].items():
            print(f"{genre:<11} {role:<16} {row['n']:5d} {row['decay_ms']:6.0f}m "
                  f"{row['attack_ms']:6.1f}m {row['centroid_hz']:8.0f} "
                  f"{row['rolloff_hz']:7.0f} {row['zcr']:6.3f}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not CORPUS.is_file():
        print(f"No {CORPUS.name}: run bench/genre_corpus.py --update first.")
        return 0
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    measured = measure(only)
    report(measured)
    if "--update" in args:
        body = {
            "_comment": "What each genre's hitsounds sound like, measured by "
                        "bench/genre_samples.py from the sample files the corpus mapsets "
                        "ship. Medians only: no audio is copied, kept or shipped, and a "
                        "kit built from these is Overtone's own synthesis aimed at them.",
            "format": FORMAT,
            "measured": "2026-09-27",
            "bands_hz": list(BANDS),
            "genres": measured,
        }
        import re
        text = json.dumps(body, indent=1)
        MANIFEST.write_text(
            re.sub(r"\[\s+((?:-?[\d.eE+-]+,\s+)*-?[\d.eE+-]+)\s+\]",
                   lambda m: "[" + re.sub(r"\s+", " ", m.group(1)) + "]", text) + "\n",
            encoding="utf-8")
        print(f"\nWrote {MANIFEST.name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
