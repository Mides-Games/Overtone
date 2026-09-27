"""The Python port of the multi-band flux, printed as `overtone-bench bands`.

The two front ends are meant to read the same seven bands on the same
frames. This prints what `overtone.band_flux` gives — frame count, per-band
totals and each band's loudest frame — in the Rust mode's own format, so the
two outputs diff line for line:

    cargo run --release -q -p overtone-bench -- bands   > /tmp/rust.txt
    .venv/Scripts/python.exe proto/band_lanes.py        > /tmp/python.txt
    diff /tmp/rust.txt /tmp/python.txt

A measurement, not a gate: it says how far apart two float paths are, which
is a number for the timeline, not a pass or a fail.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bench"))

import overtone as ta  # noqa: E402
import fixtures as fx  # noqa: E402

AUDIO = ROOT / "bench" / "audio"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE")
    parser.add_argument("--dir", default=str(AUDIO))
    args = parser.parse_args()
    audio_dir = Path(args.dir)
    names = args.only or [n for n, e in fx.derive().items() if e["golden"]]

    print("Per-band rectified dB flux: 7 log bands over 40 Hz - 11.025 kHz,")
    print("on the onset envelope's own frames, hop 128, n_fft 2048.\n")
    print(f"{'case':<20} {'frames':>7}  band totals (dB), then the loudest frame of each")
    print("-" * 100)
    missing = 0
    for name in names:
        path = audio_dir / f"{name}.wav"
        if not path.is_file():
            print(f"{name:<20}  MISSING — render it with `python bench/benchmark.py`")
            missing += 1
            continue
        y, sr = ta._load_audio(str(path), lambda _m: None)
        flux = ta.band_flux(y, sr, ta.FIT_HOP)
        totals = flux.sum(axis=0)
        peaks = flux.argmax(axis=0) if flux.size else np.zeros(ta.BAND_COUNT, dtype=int)
        sums = ", ".join(f"{t:.3f}" for t in totals)
        where = ", ".join(str(int(p)) for p in peaks)
        print(f"{name:<20} {len(flux):>7}  [{sums}]  [{where}]")
    if missing:
        print(f"\n{missing} case(s) have no audio: nothing was measured for them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
