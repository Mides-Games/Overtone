"""What every gate shares: the bench's paths, the pinned files and one analysis read as a row."""
from __future__ import annotations

import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import benchmark as bm  # noqa: E402
import local_data  # noqa: E402
import overtone as ta  # noqa: E402


HERE = Path(__file__).resolve().parent.parent
SNAPSHOT = HERE / "bpm_snapshot.json"
REAL_SNAPSHOT = local_data.REAL_SNAPSHOT
PERF_SNAPSHOT = HERE / "perf_snapshot.json"
#: The real-audio smoke set: Corpus B tracks (bench/corpus_b.local.json names them
#: by folder, file and SHA-1; the audio is never committed), one or two per
#: path the engine takes on real music: a steady grid, a drifting live band,
#: a rubato intro, a signature change, an octave-swap and the fallback tracker.
REAL_AUDIO = ("take-you-down", "camisa-negra", "shinkou", "noble", "palette",
              "calm-down-juliet")

#: The snapshot pins absolute BPM. A tolerance this tight still absorbs
#: float-order noise between numpy/scipy releases while catching any octave
#: flip (which moves a BPM by a factor of two) and any real drift.
BPM_EPS = 0.01
#: Coverage is the fraction of grid slots carrying an attack. A sustained drop
#: this large means the note rate changed, not that a few hits were missed.
COVERAGE_DROP = 0.25


# ---------------------------------------------------------------------------
# F-07 — the octave is a decision, so pin it
# ---------------------------------------------------------------------------

def _analyse(name: str, audio_dir: Path, engine: str):
    path = audio_dir / f"{name}.wav"
    if not path.exists():
        bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
    return ta.analyze_audio(str(path), engine=engine)


def _reading(analysis) -> dict:
    """The octave-bearing facts, un-normalized. This is what must not drift."""
    return {
        "global_bpm": round(float(analysis.global_bpm), 4),
        "section_bpms": [round(float(s.bpm), 4) for s in analysis.sections],
        "point_bpms": [round(float(p.bpm), 4)
                       for p in ta.snap_timing_points(analysis.points)],
        "meter": str(analysis.meter),
        "meter_beats": int(analysis.meter_beats),
        "engine": str(analysis.engine),
    }
