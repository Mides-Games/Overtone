"""What the health check and the BPM cache ask the engines, and how their answers are kept."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
import overtone as ta
import overtone_rust

from overtone_library.schema import ANALYSIS_FORMAT


def _attacks(audio: str, engine: str):
    """The attacks of one audio file and its length in seconds, as
    ``grade_reference_timing`` takes them."""
    if engine == "rust":
        return overtone_rust.attacks(audio)
    y, sr = ta._load_audio(audio, lambda _message: None)
    times, weights, _envelope = ta._detect_attacks(y, sr, ta.FIT_HOP)
    return times, weights, y.size / sr


def _health_verdict(report: dict) -> tuple[str, int, int, float | None, float | None, str]:
    """A grade as the health table keeps it: the verdict, the lines graded
    and flagged, the largest disagreement among the flagged, the map's
    common shift, and the flagged lines with the evidence behind each."""
    if not report["ok"]:
        verdict = "no_timing" if report["reason"] == "no_red_lines" else "unsure"
        return verdict, 0, 0, None, None, ""
    lines = report["lines"]
    flagged = [line for line in lines if line["verdict"] == "check"]
    verdict = "check" if flagged else "ok" if report["counts"]["ok"] else "unsure"

    def size(line: dict) -> float:
        return max(abs(line["relative_ms"]) if "offset" in line["issues"] else 0.0,
                   abs(line["drift_ms"]) if "drift" in line["issues"] else 0.0)

    def rounded(value):
        return None if value is None else round(value, 2)

    detail = json.dumps([{"index": line["index"], "offset_ms": line["offset_ms"],
                          "end_ms": round(line["end_ms"], 1), "bpm": round(line["bpm"], 3),
                          "fitted_bpm": round(line["fitted_bpm"], 3), "issues": line["issues"],
                          "relative_ms": rounded(line["relative_ms"]),
                          "offset_se_ms": rounded(line["offset_se_ms"]),
                          "drift_ms": rounded(line["drift_ms"]),
                          "drift_se_ms": rounded(line["drift_se_ms"]),
                          "attacks": line["attacks"], "share": round(line["share"], 3)}
                         for line in flagged]) if flagged else ""
    worst = round(max(size(line) for line in flagged), 2) if flagged else None
    return verdict, len(lines), len(flagged), worst, report["common_offset_ms"], detail


_UPSERT_HEALTH = (
    "INSERT INTO health (path, size, mtime_ns, audio_size, audio_mtime_ns, grader, engine, "
    "verdict, lines, flagged, worst_ms, common_ms, detail, graded_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in (
        "size", "mtime_ns", "audio_size", "audio_mtime_ns", "grader", "engine", "verdict",
        "lines", "flagged", "worst_ms", "common_ms", "detail", "graded_at")))

_ANALYSIS_COLUMNS = ("path", "size", "mtime_ns", "engine", "engine_hash", "verdict", "grid",
                     "bpm", "stability", "meter", "residual_ms", "duration", "lines", "detail",
                     "seconds", "analyzed_at")
_UPSERT_ANALYSIS = (
    f"INSERT INTO analysis ({', '.join(_ANALYSIS_COLUMNS)}) "
    f"VALUES ({', '.join('?' for _ in _ANALYSIS_COLUMNS)}) ON CONFLICT(path) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in _ANALYSIS_COLUMNS[1:]))


def beat_vote(load: bool = True) -> bool:
    """Whether Beat This! votes on the red lines in this process: it needs
    onnxruntime and the model, and a server may turn it off
    (``overtone_server --no-beat-vote``). ``load`` False answers without
    loading the model, which takes seconds the first time: from the session
    once loaded, else from whether the runtime and the model are there."""
    if load or ta._BEAT_THIS_SESSION:
        return ta._beat_this_session() is not None
    import importlib.util
    return (importlib.util.find_spec("onnxruntime") is not None
            and (ta.ROOT / "assets" / "models" / ta.BEAT_THIS_MODEL).is_file())


def engine_fingerprint(engine: str, cli: Path | None = None) -> str:
    """The code an analysis came from, as ``bench/corpus_b.py`` keys its
    cache: the overtone package writes the red lines for both engines, and the Rust
    engine adds its bridge and its binary. Any edit to them stales a row, and
    so does turning the Beat This! vote on or off: it moves red lines."""
    files = sorted(Path(ta.__file__).parent.glob("*.py"))
    if engine == "rust":
        files += [Path(overtone_rust.__file__), cli or overtone_rust.find_cli()]
    digest = hashlib.sha1(
        f"library analysis {ANALYSIS_FORMAT} {engine} vote={beat_vote()}".encode())
    for path in files:
        if path is None:
            raise overtone_rust.SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
        with open(path, "rb") as handle:
            digest.update(hashlib.sha1(handle.read()).digest())
    return digest.hexdigest()[:16]


def _analyse_audio(audio: str, engine: str) -> dict:
    """One audio file read by ``engine``, as an analysis row keeps it. A
    refusal is a verdict, not a failure: the engine says why and no BPM is
    stored (the Rust engine's ``SidecarRefused`` is a ``ValueError``, as
    v3's refusals are)."""
    started = time.perf_counter()
    try:
        if engine == "rust":
            analysis = overtone_rust.analyze(audio)
        else:
            analysis = ta.analyze_audio(audio)
    except overtone_rust.SidecarUnavailable:
        raise
    except ValueError as exc:
        return {"verdict": "refused", "detail": str(exc),
                "seconds": round(time.perf_counter() - started, 3)}
    except (RuntimeError, OSError) as exc:
        return {"verdict": "error", "detail": str(exc),
                "seconds": round(time.perf_counter() - started, 3)}
    lines = []
    for line in ta.osu_timing_text(analysis).splitlines():
        fields = line.split(",")
        if line.startswith("//") or len(fields) < 3:
            continue
        lines.append([float(fields[0]), round(60000.0 / float(fields[1]), 4), int(fields[2])])
    return {"verdict": "ok", "grid": analysis.engine, "bpm": round(float(analysis.global_bpm), 4),
            "stability": round(float(analysis.stability), 4), "meter": analysis.meter,
            "residual_ms": round(float(analysis.fit_residual_ms), 4),
            "duration": round(float(analysis.duration), 3), "lines": json.dumps(lines),
            "seconds": round(time.perf_counter() - started, 3)}


def _analysis_dict(row: tuple) -> dict:
    """An analysis row as the API returns it."""
    found = dict(zip(_ANALYSIS_COLUMNS, row))
    found["lines"] = [{"offset_ms": offset, "bpm": bpm, "meter": meter}
                      for offset, bpm, meter in json.loads(found["lines"] or "[]")]
    for key in ("size", "mtime_ns", "engine_hash"):
        del found[key]
    return found


#: A flagged line is worth a look only when its grid is solidly evidenced.
#: The false-positive flags measured on 2026-09-26 came from spans of 11-19
#: attacks and grids explaining about 41 % of the attacks. Attack counts
#: overlap a real flag (14 attacks, share 1.0 on clean clicks), so the share
#: is what separates them and the attacks floor is only a sanity level above
#: the grading's own minimum (8): a coherent short span stays actionable,
#: an incoherent one reads as a weak lead.
HEALTH_MIN_ATTACKS = 12
HEALTH_MIN_SHARE = 0.60


def health_actionable(checks: list[dict] | None) -> bool:
    """Whether a flagged map is worth a look: at least one of its flagged
    lines rests on a solid fit — enough attacks, and a grid that explains a
    good share of them. A flag is a lead, never a verdict of wrong timing."""
    return any(int(line.get("attacks", 0) or 0) >= HEALTH_MIN_ATTACKS
               and float(line.get("share", 0.0) or 0.0) >= HEALTH_MIN_SHARE
               for line in checks or [])
