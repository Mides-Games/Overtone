"""robustness: the audit's edge-case probes end cleanly."""
from __future__ import annotations

import os
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import overtone as ta  # noqa: E402


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Robustness — the audit's edge-case probes as one command (roadmap Phase 23)
# ---------------------------------------------------------------------------

#: What a refusal may raise. Anything else (IndexError, TypeError, ...) is a
#: crash dressed as an error, and the app would show a traceback.
CLEAN_ERRORS = (ValueError, RuntimeError, OSError)


def _write_wav(path: Path, y: np.ndarray, sr: int) -> None:
    import wave
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sr)
        out.writeframes((np.clip(y, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def _clicks(sr: int, seconds: float, bpm: float = 150.0) -> np.ndarray:
    """Noise-burst clicks from 0.5 s, every fourth one louder."""
    y = np.zeros(int(seconds * sr))
    rng = np.random.default_rng(7)
    n = int(0.03 * sr)
    burst = np.exp(-np.arange(n) / (0.004 * sr))
    k, t = 0, 0.5
    while t < seconds - 0.2:
        start = int(t * sr)
        y[start:start + n] += (0.9 if k % 4 == 0 else 0.5) * burst * (rng.random(n) - 0.5)
        k, t = k + 1, t + 60.0 / bpm
    return y


def robustness() -> int:
    """Short, empty, junk and silent audio; odd sample rates; junk and
    read-only .osu files. Each must end in a clean refusal or a right answer,
    never a crash, and a failed write must leave the map byte-identical."""
    import os
    import stat
    import tempfile

    failures = 0

    def check(label: str, ok: bool, detail: str) -> None:
        nonlocal failures
        failures += 0 if ok else 1
        print(f"{label:<38} {'ok' if ok else 'FAIL'}  {detail}")

    def refused(label: str, call, must_say: str) -> None:
        try:
            out = call()
        except CLEAN_ERRORS as exc:
            check(label, must_say in str(exc), f"{type(exc).__name__}: {exc}"[:110])
        except Exception as exc:  # noqa: BLE001 -- the gate reports crashes
            check(label, False, f"crashed: {type(exc).__name__}: {exc}"[:110])
        else:
            check(label, False, f"answered instead of refusing: {out!r}"[:110])

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        _write_wav(folder / "short.wav", _clicks(44_100, 1.0), 44_100)
        (folder / "empty.wav").write_bytes(b"")
        (folder / "text.wav").write_text("not audio at all")
        _write_wav(folder / "silence.wav", np.zeros(44_100 * 5), 44_100)
        refused("audio: 1 s", lambda: ta.analyze_audio(str(folder / "short.wav")),
                "at least two seconds")
        refused("audio: empty file", lambda: ta.analyze_audio(str(folder / "empty.wav")),
                "empty")
        refused("audio: text named .wav", lambda: ta.analyze_audio(str(folder / "text.wav")),
                "Could not decode")
        refused("audio: missing file", lambda: ta.analyze_audio(str(folder / "nope.wav")),
                "No audio file")
        refused("audio: 5 s of silence", lambda: ta.analyze_audio(str(folder / "silence.wav")),
                "No rhythmic pulse")

        for sr in (8_000, 22_050, 32_000, 48_000, 96_000):
            path = folder / f"clicks-{sr}.wav"
            _write_wav(path, _clicks(sr, 12.0), sr)
            try:
                bpm = float(ta.analyze_audio(str(path)).global_bpm)
                check(f"audio: 150 BPM clicks at {sr} Hz", abs(bpm - 150.0) < 0.01,
                      f"{bpm:.4f} BPM")
            except Exception as exc:  # noqa: BLE001
                check(f"audio: 150 BPM clicks at {sr} Hz", False,
                      f"{type(exc).__name__}: {exc}"[:110])

        junk = {
            "empty.osu": b"",
            "binary.osu": bytes(range(256)) * 4,
            "utf16.osu": "osu file format v14\r\n\r\n[TimingPoints]\r\n0,500,4,1,0,100,1,0\r\n"
                         .encode("utf-16"),
            "nosections.osu": b"hello\r\n",
        }
        for name, data in junk.items():
            (folder / name).write_bytes(data)
            refused(f"osu: red lines of {name}",
                    lambda name=name: ta.read_osu_red_lines(str(folder / name)), "")
        bad = folder / "badlines.osu"
        bad.write_bytes(b"osu file format v14\r\n\r\n[TimingPoints]\r\nabc,def\r\n"
                        b"1e999,nan,4\r\n,,,,\r\n100,-50,4,1,0,100,0,0\r\n")
        try:
            lines = ta.read_osu_red_lines(str(bad))
            check("osu: junk timing lines skipped", lines == [], f"{lines!r}")
        except Exception as exc:  # noqa: BLE001
            check("osu: junk timing lines skipped", False, f"{type(exc).__name__}: {exc}"[:110])

        analysis = ta.analyze_audio(str(folder / "clicks-48000.wav"))
        good = (b"osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.wav\r\n\r\n"
                b"[TimingPoints]\r\n500,400,4,1,0,100,1,0\r\n\r\n[HitObjects]\r\n"
                b"256,192,500,1,0,0:0:0:0:\r\n")
        locked = folder / "locked.osu"
        locked.write_bytes(good)
        os.chmod(locked, stat.S_IREAD)
        try:
            refused("osu: inject into a read-only map",
                    lambda: ta.inject_osu_timing_points(str(locked), analysis), "")
            check("osu: read-only map left byte-identical", locked.read_bytes() == good,
                  f"{len(locked.read_bytes())} bytes")
        finally:
            os.chmod(locked, stat.S_IWRITE | stat.S_IREAD)
        refused("osu: inject into a missing map",
                lambda: ta.inject_osu_timing_points(str(folder / "gone.osu"), analysis),
                "is not a file")

    print(f"\nrobustness: {'ok' if not failures else f'{failures} failure(s)'}")
    return 1 if failures else 0
