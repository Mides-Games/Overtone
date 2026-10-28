"""W13.21: can a small offline fingerprint tell "the same song in another encoding" apart?

A study, not a feature (docs/19-fingerprint-study.md). It measures a
Chromaprint-like chroma fingerprint on songs from the local osu! Songs folder
and on the benchmark's synthetic tracks, each re-encoded and altered the ways
a re-upload differs, and prints how far the same song's fingerprints sit from
each other and how close two different songs' ever come.

    .venv/Scripts/python.exe -u proto/fingerprint_study.py --songs 80 --seconds 45 --pairs 30 --workers 11
        # the run docs/19-fingerprint-study.md reports: about 6 minutes on 12 cores
    .venv/Scripts/python.exe -u proto/fingerprint_study.py --songs 10 --pairs 5 --no-synthetic  # a quick look

The fingerprint is what a browser could compute after decoding the file:

1. mono, resampled to 11025 Hz;
2. a Hann STFT of 4096 samples every 1365 (about 8.1 frames a second);
3. each frame's energy from 28 Hz to 3520 Hz folded into 12 pitch classes,
   smoothed over five frames (0.25, 0.75, 1, 0.75, 0.25) and L2-normalised
   (a near-silent frame is all zeros);
4. sixteen fixed Haar-like filters over the chroma image (a window of up
   to 16 frames by up to 12 pitch classes), each response a log ratio of two
   areas, quantised into two Gray-coded bits: 32 bits a frame.

Step 4 uses the filter layout and quantiser thresholds of Chromaprint's
default configuration as published in its source (fingerprinter_configuration
.cpp, "test 2"); nothing is learned here. The chroma front end only follows
Chromaprint's description, so this is Chromaprint-*like*: its values are not
claimed to equal libchromaprint's, bit for bit.

Two fingerprints are compared by their bit error rate (BER): the share of
differing bits over the frames they share, at the best alignment within
±MAX_SHIFT_S seconds (at least MIN_OVERLAP_S seconds of overlap). 0 is
identical; two unrelated songs sit near 0.5.

Re-encoding needs no ffmpeg: libsndfile (through soundfile) writes MP3,
Ogg Vorbis and Ogg Opus. Its Vorbis encoder overflows the main thread's stack
on Windows, so every encode runs in a thread with a 64 MB stack.

A measurement, not a gate. The library's song names never leave this
machine: the output is aggregate numbers only.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import random
import re
import sys
import tempfile
import threading
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent

# ── The fingerprint ─────────────────────────────────────────────────────────

FP_RATE = 11025
FRAME = 4096
HOP = 1365  # 4096 - 4096 * 2 / 3, as Chromaprint's overlap
MIN_FREQ, MAX_FREQ = 28.0, 3520.0
SMOOTH = np.array([0.25, 0.75, 1.0, 0.75, 0.25])

# (filter type, first pitch class, height in pitch classes, width in frames), (three thresholds)
CLASSIFIERS = [
    ((0, 4, 3, 15), (1.98215, 2.35817, 2.63523)),
    ((4, 4, 6, 15), (-1.03809, -0.651211, -0.282167)),
    ((1, 0, 4, 16), (-0.298702, 0.119262, 0.558497)),
    ((3, 8, 2, 12), (-0.105439, 0.0153946, 0.135898)),
    ((3, 4, 4, 8), (-0.142891, 0.0258736, 0.200632)),
    ((4, 0, 3, 5), (-0.826319, -0.590612, -0.368214)),
    ((1, 2, 2, 9), (-0.557409, -0.233035, 0.0534525)),
    ((2, 7, 3, 4), (-0.0646826, 0.00620476, 0.0784847)),
    ((2, 6, 2, 16), (-0.192387, -0.029699, 0.215855)),
    ((2, 1, 3, 2), (-0.0397818, -0.00568076, 0.0292026)),
    ((5, 10, 1, 15), (-0.53823, -0.369934, -0.190235)),
    ((3, 6, 2, 10), (-0.124877, 0.0296483, 0.139239)),
    ((2, 1, 1, 14), (-0.101475, 0.0225617, 0.231971)),
    ((3, 5, 6, 4), (-0.0799915, -0.00729616, 0.063262)),
    ((1, 9, 2, 12), (-0.272556, 0.019424, 0.302559)),
    ((3, 4, 2, 14), (-0.164292, -0.0321188, 0.0846339)),
]
GRAY = np.array([0, 1, 3, 2], dtype=np.uint32)
MAX_WIDTH = max(f[3] for f, _ in CLASSIFIERS)


def _chroma_bins() -> np.ndarray:
    """The pitch class of every FFT bin from MIN_FREQ to MAX_FREQ, -1 elsewhere."""
    freqs = np.arange(FRAME // 2 + 1) * FP_RATE / FRAME
    out = np.full(freqs.shape, -1, dtype=np.int64)
    inside = (freqs >= MIN_FREQ) & (freqs <= MAX_FREQ)
    octave = np.log2(freqs[inside] / (440.0 / 16.0))
    out[inside] = np.floor(12 * (octave - np.floor(octave))).astype(np.int64) % 12
    return out


BINS = _chroma_bins()
WINDOW = np.hanning(FRAME)


def to_fp_rate(mono: np.ndarray, rate: int) -> np.ndarray:
    g = math.gcd(int(rate), FP_RATE)
    return resample_poly(mono.astype(np.float64), FP_RATE // g, int(rate) // g)


def chroma(x: np.ndarray) -> np.ndarray:
    """Frames x 12, smoothed and L2-normalised."""
    if len(x) < FRAME:
        return np.zeros((0, 12))
    n = 1 + (len(x) - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n)[:, None]
    power = np.abs(np.fft.rfft(x[idx] * WINDOW, axis=1)) ** 2
    out = np.zeros((n, 12))
    for c in range(12):
        out[:, c] = power[:, BINS == c].sum(axis=1)
    if n >= len(SMOOTH):
        out = np.stack([np.convolve(out[:, c], SMOOTH, mode="valid") for c in range(12)], axis=1)
    norm = np.linalg.norm(out, axis=1, keepdims=True)
    return np.where(norm > 0.01, out / np.maximum(norm, 1e-12), 0.0)


def _area(ii: np.ndarray, x: np.ndarray, t0: int, c0: int, t1: int, c1: int) -> np.ndarray:
    """Sum of the image over frames x+t0..x+t1-1 and pitch classes c0..c1-1, for every x at once."""
    return ii[x + t1, c1] - ii[x + t0, c1] - ii[x + t1, c0] + ii[x + t0, c0]


def _response(ii: np.ndarray, x: np.ndarray, kind: int, y: int, h: int, w: int) -> np.ndarray:
    a = lambda t0, c0, t1, c1: _area(ii, x, t0, c0, t1, c1)  # noqa: E731
    sub = lambda p, q: np.log1p(p) - np.log1p(q)  # noqa: E731
    if kind == 0:
        return np.log1p(a(0, y, w, y + h))
    if kind == 1:  # upper half of the pitch classes against the lower
        h2 = h // 2
        return sub(a(0, y + h2, w, y + h), a(0, y, w, y + h2))
    if kind == 2:  # later half of the window against the earlier
        w2 = w // 2
        return sub(a(w2, y, w, y + h), a(0, y, w2, y + h))
    if kind == 3:  # one diagonal of quadrants against the other
        h2, w2 = h // 2, w // 2
        return sub(a(0, y + h2, w2, y + h) + a(w2, y, w, y + h2), a(0, y, w2, y + h2) + a(w2, y + h2, w, y + h))
    if kind == 4:  # the middle third of the pitch classes against the outer two
        h3 = h // 3
        return sub(a(0, y + h3, w, y + 2 * h3), a(0, y, w, y + h3) + a(0, y + 2 * h3, w, y + h))
    if kind == 5:  # the middle third of the window against the outer two
        w3 = w // 3
        return sub(a(w3, y, 2 * w3, y + h), a(0, y, w3, y + h) + a(2 * w3, y, w, y + h))
    raise ValueError(kind)


def fingerprint(mono: np.ndarray, rate: int) -> np.ndarray:
    """32 bits a frame (uint32), about 8.1 frames a second."""
    image = chroma(to_fp_rate(mono, rate))
    n = len(image) - MAX_WIDTH + 1
    if n <= 0:
        return np.zeros(0, dtype=np.uint32)
    ii = np.zeros((len(image) + 1, 13))
    ii[1:, 1:] = image.cumsum(0).cumsum(1)
    x = np.arange(n)
    out = np.zeros(n, dtype=np.uint32)
    for (kind, y, h, w), (t0, t1, t2) in CLASSIFIERS:
        r = _response(ii, x, kind, y, h, w)
        q = np.where(r < t0, 0, np.where(r < t1, 1, np.where(r < t2, 2, 3)))
        out = (out << np.uint32(2)) | GRAY[q]
    return out


FPS = FP_RATE / HOP
MAX_SHIFT_S = 5.0
MIN_OVERLAP_S = 12.0


def ber(a: np.ndarray, b: np.ndarray, max_shift_s: float = MAX_SHIFT_S) -> float:
    """The lowest bit error rate of `a` against `b` over shifts within ±max_shift_s; 1.0 when they never overlap enough."""
    best = 1.0
    max_shift = int(round(max_shift_s * FPS))
    min_overlap = int(round(MIN_OVERLAP_S * FPS))
    for s in range(-max_shift, max_shift + 1):
        if s >= 0:
            x, y = a[s:], b
        else:
            x, y = a, b[-s:]
        n = min(len(x), len(y))
        if n < min_overlap:
            continue
        errors = int(np.bitwise_count(x[:n] ^ y[:n]).sum())
        best = min(best, errors / (32 * n))
    return best


def hit_rate(query: np.ndarray, other: np.ndarray) -> float:
    """The share of `query`'s frames whose exact 32-bit value occurs anywhere in `other` (what an inverted index would find)."""
    if not len(query):
        return 0.0
    return float(np.isin(query, other).mean())


# ── Audio, variants ─────────────────────────────────────────────────────────

SECONDS = 60.0


def _in_big_stack(fn, *args):
    """Run fn in a thread with a 64 MB stack (libsndfile's Vorbis encoder overflows the default one on Windows)."""
    box = {}

    def run():
        try:
            box["value"] = fn(*args)
        except BaseException as exc:  # noqa: BLE001 - handed back to the caller
            box["error"] = exc

    threading.stack_size(64 * 1024 * 1024)
    t = threading.Thread(target=run)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def _encode(mono: np.ndarray, rate: int, fmt: str, subtype: str, level: float) -> tuple[np.ndarray, int, int]:
    def work():
        buf = io.BytesIO()
        kw = {"compression_level": level}
        if fmt == "MP3":
            kw["bitrate_mode"] = "CONSTANT"
        sf.write(buf, mono.astype(np.float32), rate, format=fmt, subtype=subtype, **kw)
        size = len(buf.getvalue())
        buf.seek(0)
        y, r = sf.read(buf, dtype="float32", always_2d=True)
        return y.mean(axis=1), r, size

    return _in_big_stack(work)


def _resample(mono: np.ndarray, rate: int, to: int) -> np.ndarray:
    g = math.gcd(rate, to)
    return resample_poly(mono, to // g, rate // g).astype(np.float32)


def variants(mono: np.ndarray, rate: int, seed: int) -> dict[str, tuple[np.ndarray, int, float | None]]:
    """name -> (audio, rate, kbps or None). Each is how a re-upload of the same song could differ."""
    rng = random.Random(seed)
    out: dict[str, tuple[np.ndarray, int, float | None]] = {}
    secs = len(mono) / rate

    def coded(name, audio, r, fmt, sub, level):
        y, yr, size = _encode(audio, r, fmt, sub, level)
        out[name] = (y, yr, size * 8 / (len(audio) / r) / 1000)

    coded("mp3-320", mono, rate, "MP3", "MPEG_LAYER_III", 0.0)
    coded("mp3-128", mono, rate, "MP3", "MPEG_LAYER_III", 0.65)
    coded("mp3-80", mono, rate, "MP3", "MPEG_LAYER_III", 0.85)
    coded("vorbis-low", mono, rate, "OGG", "VORBIS", 0.9)
    m48 = _resample(mono, rate, 48000) if rate != 48000 else mono
    coded("opus-low", m48, 48000, "OGG", "OPUS", 0.9)
    out["resample-48k"] = (m48, 48000, None)
    out["gain-6dB"] = (mono * 10 ** (-6 / 20), rate, None)
    pad = int(rng.uniform(0.3, 1.0) * rate)
    shifted = np.concatenate([np.zeros(pad, dtype=np.float32), mono])[: len(mono)]
    out["silence+0.3-1s"] = (shifted, rate, None)
    cut = int(rng.uniform(0.3, 1.0) * rate)
    out["cut-0.3-1s"] = (mono[cut:], rate, None)
    coded("silence+mp3-128", shifted, rate, "MP3", "MPEG_LAYER_III", 0.65)
    assert secs > 0
    return out


def load(path: str, seconds: float = SECONDS) -> tuple[np.ndarray, int]:
    with sf.SoundFile(path) as f:
        rate = f.samplerate
        data = f.read(int(seconds * rate), dtype="float32", always_2d=True)
    return data.mean(axis=1), rate


def study_one(job: tuple[str, str, int, float]) -> dict:
    """Decode one original, fingerprint it and its variants. Runs in a worker process."""
    key, path, seed, seconds = job
    try:
        mono, rate = load(path, seconds)
    except Exception as exc:  # noqa: BLE001 - an undecodable file is skipped and counted
        return {"key": key, "error": f"decode: {type(exc).__name__}"}
    if len(mono) < rate * 20 or float(np.abs(mono).max()) < 1e-3:
        return {"key": key, "error": "too short or silent"}
    started = time.perf_counter()
    fp = fingerprint(mono, rate)
    fp_ms = (time.perf_counter() - started) * 1000
    out = {"key": key, "fp": fp, "fp_ms": fp_ms, "seconds": len(mono) / rate, "variants": {}, "kbps": {}}
    try:
        for name, (audio, r, kbps) in variants(mono, rate, seed).items():
            out["variants"][name] = fingerprint(audio, r)
            if kbps:
                out["kbps"][name] = kbps
    except Exception as exc:  # noqa: BLE001
        return {"key": key, "error": f"variant: {type(exc).__name__}: {exc}"}
    return out


def fp_only(job: tuple[str, str, float]) -> dict:
    key, path, seconds = job
    try:
        mono, rate = load(path, seconds)
    except Exception as exc:  # noqa: BLE001
        return {"key": key, "error": f"decode: {type(exc).__name__}"}
    return {"key": key, "fp": fingerprint(mono, rate)}


# ── The library ─────────────────────────────────────────────────────────────

AUDIO_RE = re.compile(r"^AudioFilename:\s*(.+?)\s*$", re.M)


def audio_of(folder: Path) -> Path | None:
    for osu in sorted(folder.glob("*.osu")):
        try:
            m = AUDIO_RE.search(osu.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if m:
            p = folder / m.group(1)
            if p.is_file() and p.suffix.lower() in (".mp3", ".ogg", ".wav", ".flac"):
                return p
    return None


def songs_folder() -> Path | None:
    """The Songs folder Corpus B names (bench/local_data.py), in this checkout or the main one."""
    for base in (ROOT, *ROOT.parents):
        manifest = base / "bench" / "corpus_b.local.json"
        if manifest.is_file():
            folder = Path(json.loads(manifest.read_text(encoding="utf-8"))["songs_folder"])
            return folder if folder.is_dir() else None
    return None


SET_RE = re.compile(r"^\d+\s+(.+)$")


def same_title_pairs(folders: list[Path], limit: int, rng: random.Random) -> list[tuple[Path, Path]]:
    """Pairs of sets whose folder names give the same "artist - title" and whose audio files differ in size."""
    groups: dict[str, list[Path]] = {}
    for f in folders:
        m = SET_RE.match(f.name)
        if m:
            groups.setdefault(m.group(1).strip().lower(), []).append(f)
    pairs = []
    for name in sorted(groups):
        sets = groups[name]
        if len(sets) < 2:
            continue
        a, b = audio_of(sets[0]), audio_of(sets[1])
        if a and b and a.stat().st_size != b.stat().st_size:
            pairs.append((a, b))
    rng.shuffle(pairs)
    return pairs[:limit]


# ── The report ──────────────────────────────────────────────────────────────

def quantiles(values, qs=(0.0, 0.01, 0.05, 0.5, 0.95, 0.99, 1.0)) -> str:
    v = np.asarray(values)
    return " ".join(f"{q:.0%}:{np.quantile(v, q):.3f}" for q in qs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--songs", type=int, default=150, help="originals sampled from the Songs folder")
    parser.add_argument("--pairs", type=int, default=40, help="same-title pairs from different sets")
    parser.add_argument("--seed", type=int, default=1321)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--seconds", type=float, default=SECONDS, help="decoded from the start of each file")
    parser.add_argument("--no-synthetic", action="store_true")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    jobs: list[tuple[str, str, int, float]] = []
    folder = songs_folder()
    folders: list[Path] = []
    if folder:
        folders = sorted(p for p in folder.iterdir() if p.is_dir())
        picked = rng.sample(folders, min(len(folders), args.songs * 2))
        for f in picked:
            a = audio_of(f)
            if a:
                jobs.append((f"lib{len(jobs)}", str(a), rng.randrange(1 << 30), args.seconds))
            if len(jobs) >= args.songs:
                break
        print(f"library: {len(folders)} sets, {len(jobs)} originals sampled (seed {args.seed}), first {args.seconds:.0f} s of each")
    else:
        print("library: not reachable (bench/corpus_b.local.json or its Songs folder missing); synthetic tracks only")

    tmp = Path(tempfile.mkdtemp(prefix="overtone-fp-"))
    if not args.no_synthetic:
        sys.path.insert(0, str(ROOT / "python"))
        sys.path.insert(0, str(ROOT / "bench"))
        import benchmark as bm  # noqa: E402

        for name, kwargs in bm.CASES.items():
            path = tmp / f"{name}.wav"
            kw = dict(kwargs)
            kw["duration"] = min(kw["duration"], args.seconds)
            bm.build_track(path, seed=zlib.crc32(name.encode()), **kw)
            jobs.append((f"syn:{name}", str(path), zlib.crc32(name.encode()), args.seconds))
        print(f"synthetic: {len(bm.CASES)} benchmark tracks (bench/benchmark.py CASES), first {args.seconds:.0f} s")

    started = time.perf_counter()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        results = []
        for r in pool.map(study_one, jobs, chunksize=1):
            results.append(r)
            if len(results) % 10 == 0:
                print(f"  {len(results)}/{len(jobs)} after {time.perf_counter() - started:.0f} s", flush=True)
    skipped = [r for r in results if "error" in r]
    done = [r for r in results if "error" not in r]
    print(f"fingerprinted {len(done)} originals and {sum(len(r['variants']) for r in done)} variants "
          f"in {time.perf_counter() - started:.0f} s wall; skipped {len(skipped)} "
          f"({', '.join(sorted({r['error'].split(':')[0] for r in skipped})) or 'none'})")

    lib = [r for r in done if r["key"].startswith("lib")]
    syn = [r for r in done if r["key"].startswith("syn")]

    # Cost.
    fp_ms = np.array([r["fp_ms"] for r in done])
    secs = np.array([r["seconds"] for r in done])
    per_min = fp_ms / (secs / 60)
    frames_per_min = FPS * 60
    print(f"\ncost: fingerprint {np.median(per_min):.0f} ms per audio minute (median, Python/numpy, decode not included); "
          f"{frames_per_min:.0f} frames = {frames_per_min * 4:.0f} bytes per minute")
    kb = {}
    for r in lib:
        for k, v in r["kbps"].items():
            kb.setdefault(k, []).append(v)
    print("bitrates: " + ", ".join(f"{k} {np.median(v):.0f} kbps" for k, v in kb.items()))
    a, b = (lib + syn)[0]["fp"], (lib + syn)[1]["fp"]
    t = time.perf_counter()
    for _ in range(50):
        ber(a, b)
    pair_ms = (time.perf_counter() - t) / 50 * 1000
    t = time.perf_counter()
    for _ in range(50):
        ber(a, b, max_shift_s=0)
    pair0_ms = (time.perf_counter() - t) / 50 * 1000
    print(f"match: {pair_ms:.2f} ms a pair with ±{MAX_SHIFT_S:.0f} s of shifts, {pair0_ms:.3f} ms at one alignment "
          f"({len(a)} and {len(b)} frames)")

    # Same song: each variant against its original.
    print(f"\nsame song, {len(lib)} library originals: BER of each variant against its original (±{MAX_SHIFT_S:.0f} s)")
    same: dict[str, list[float]] = {}
    hits: dict[str, list[float]] = {}
    for r in lib:
        for name, fp in r["variants"].items():
            same.setdefault(name, []).append(ber(fp, r["fp"]))
            hits.setdefault(name, []).append(hit_rate(fp, r["fp"]))
    for name, values in same.items():
        print(f"  {name:<17} {quantiles(values)}   exact-hash hits median {np.median(hits[name]):.2f}")

    # Different songs: every pair of originals, and each mp3-128 variant against every other original.
    t = time.perf_counter()
    diff = []
    diff_hits = []
    for i in range(len(lib)):
        for j in range(i + 1, len(lib)):
            diff.append(ber(lib[i]["fp"], lib[j]["fp"]))
    for i, r in enumerate(lib):
        q = r["variants"]["mp3-128"]
        for j, o in enumerate(lib):
            if i != j:
                diff.append(ber(q, o["fp"]))
                diff_hits.append(hit_rate(q, o["fp"]))
    print(f"\ndifferent songs, {len(diff)} pairs (originals pairwise, and mp3-128 queries against every other original), "
          f"{time.perf_counter() - t:.0f} s:\n  {quantiles(diff)}   exact-hash hits median {np.median(diff_hits):.3f}, "
          f"max {np.max(diff_hits):.3f}")

    syn_diff = [ber(syn[i]["fp"], syn[j]["fp"]) for i in range(len(syn)) for j in range(i + 1, len(syn))]
    if syn_diff:
        print(f"synthetic, {len(syn_diff)} pairs of different benchmark tracks (drums and pads, hard negatives):\n  {quantiles(syn_diff)}")
        syn_same = [ber(r["variants"][k], r["fp"]) for r in syn for k in r["variants"]]
        print(f"synthetic same-track variants, {len(syn_same)}: {quantiles(syn_same)}")

    # The threshold: below the lowest different-song score, with a margin.
    lowest = min(diff + syn_diff)
    worst_same = {k: max(v) for k, v in same.items()}
    threshold = 0.30
    print(f"\nthreshold {threshold:.2f} (lowest different-song BER seen: {lowest:.3f}; library pairs only: {min(diff):.3f})")
    fm = sum(d < threshold for d in diff)
    fms = sum(d < threshold for d in syn_diff)
    print(f"  false matches: {fm} of {len(diff)} library pairs, {fms} of {len(syn_diff)} synthetic pairs")
    for name, values in same.items():
        miss = sum(v >= threshold for v in values)
        print(f"  misses {name:<17} {miss} of {len(values)}   (worst {worst_same[name]:.3f})")

    # Same title, another set.
    if folder and args.pairs:
        prng = random.Random(args.seed + 1)
        pairs = same_title_pairs(folders, args.pairs, prng)
        flat = [(f"p{i}a", str(a), args.seconds) for i, (a, _) in enumerate(pairs)] + [(f"p{i}b", str(b), args.seconds) for i, (_, b) in enumerate(pairs)]
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            got = {r["key"]: r for r in pool.map(fp_only, flat)}
        scores, wide = [], []
        for i in range(len(pairs)):
            ra, rb = got.get(f"p{i}a"), got.get(f"p{i}b")
            if not ra or not rb or "error" in ra or "error" in rb:
                continue
            scores.append(ber(ra["fp"], rb["fp"]))
            wide.append(ber(ra["fp"], rb["fp"], max_shift_s=30))
        if scores:
            print(f"\nsame folder title in two sets with different audio files, {len(scores)} pairs (cuts and edits included):")
            print(f"  ±5 s:  {quantiles(scores)}   under {threshold}: {sum(s < threshold for s in scores)}")
            print(f"  ±30 s: {quantiles(wide)}   under {threshold}: {sum(s < threshold for s in wide)}")

    ones = np.concatenate([r["fp"] for r in lib])
    balance = [float(((ones >> np.uint32(k)) & np.uint32(1)).mean()) for k in range(32)]
    print(f"\nbit balance over library originals: min {min(balance):.2f}, median {np.median(balance):.2f}, max {max(balance):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
