"""Tests for the site worker's result builder (worker/timing_result.py).

The HTTP loop is exercised end to end against the API (docs/site.md); these
cover what the worker makes of an analysis: the right red lines from a bench
fixture, a refusal for white noise, and the ``timing-result v1`` shape.

Kept fast: the tempo-change fixture is the benchmark's change-128-142 cut to
24 s (the change at 12 s), and the Beat This! vote is off here, since it costs
seconds and the benchmark already gates what it does to red lines.
"""
import json
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "worker"))
sys.path.insert(0, str(ROOT / "bench"))

import numpy as np  # noqa: E402

import timing_result as tr  # noqa: E402


class ResultOnAudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import soundfile as sf
        from benchmark import SR, build_track

        cls.tmp = tempfile.TemporaryDirectory()
        folder = Path(cls.tmp.name)
        cls.change = folder / "change-128-142.wav"
        build_track(cls.change, [(0.4, 128.0), (12.0, 142.0)], 24.0,
                    seed=zlib.crc32(b"change-128-142"))
        # bench/benchmark.py's _noise.wav, made the same way.
        cls.noise = folder / "_noise.wav"
        rng = np.random.default_rng(5)
        sf.write(str(cls.noise), (rng.standard_normal(SR * 20) * 0.2).astype(np.float32), SR)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_a_tempo_change_gives_two_red_lines_at_its_bpms(self):
        stages = []
        result = tr.analyse(self.change, vote=False, hash_="test",
                            progress=lambda stage, fraction: stages.append((stage, fraction)))
        self.assertFalse(result["refused"])
        self.assertEqual([round(line["bpm"], 2) for line in result["red_lines"]], [128.0, 142.0])
        self.assertAlmostEqual(result["red_lines"][0]["time_ms"], 400.0, delta=5.0)
        self.assertAlmostEqual(result["offset_ms"], result["red_lines"][0]["time_ms"])
        self.assertEqual(len(result["sections"]), 2)
        self.assertEqual(result["sections"][0]["end_ms"], result["sections"][1]["start_ms"])
        for section in result["sections"]:
            self.assertIn(section["level"], ("high", "medium", "check"))
        # What the site copies is what the exporter writes: one row per line.
        rows = [r for r in result["osu_timing"].splitlines() if r and not r.startswith("//")]
        self.assertEqual(len(rows), 2)
        self.assertEqual(int(rows[1].split(",")[0]), round(result["red_lines"][1]["time_ms"]))
        # Progress only names known stages and ends on the result.
        self.assertEqual(stages[0][0], "load")
        self.assertEqual(stages[-1], ("result", 0.95))
        json.dumps(result)  # plain JSON all the way down

        # v1.1: still a v1 for every v1 reader, plus the evidence the page draws.
        self.assertEqual((result["version"], result["minor"]), (1, 1))
        beats = result["beats"]
        self.assertEqual(len(beats["t_ms"]), len(beats["bpm"]))
        self.assertEqual(beats["t_ms"], sorted(beats["t_ms"]))
        self.assertTrue(all(isinstance(t, int) for t in beats["t_ms"]))
        # The bars are the click track's: one every four beats of each line, from the line.
        bars = result["downbeats_ms"]
        self.assertEqual(bars[0], round(result["red_lines"][0]["time_ms"]))
        self.assertAlmostEqual(bars[1] - bars[0], 4 * 60000 / 128, delta=1)
        self.assertIn(round(result["red_lines"][1]["time_ms"]), bars)
        onsets = result["onsets"]
        self.assertEqual(len(onsets["t_ms"]), len(onsets["w"]))
        self.assertGreater(len(onsets["t_ms"]), 50)
        self.assertEqual(max(onsets["w"]), 100)
        self.assertTrue(0 < len(result["onset_envelope"]["v"]) <= tr.ENVELOPE_BINS)
        for section in result["sections"]:
            # A synthetic click track sits on its grid to a fraction of a millisecond.
            self.assertLess(section["drift_ms"], 2.0)
            self.assertGreaterEqual(section["drift_p90_ms"], section["drift_ms"])
            self.assertGreater(section["onsets"], 10)
        self.assertEqual(result["swing"]["spans"], [])
        self.assertEqual(result["pulse_hints"], [])
        # Well inside the budget the page is built for (300 kB for six minutes).
        self.assertLess(len(json.dumps(result, separators=(",", ":"))), 40_000)

    def test_white_noise_is_refused_without_a_bpm(self):
        result = tr.analyse(self.noise, vote=False, hash_="test")
        self.assertTrue(result["refused"])
        self.assertEqual(result["refusal"]["code"], "no_pulse")
        self.assertIsNone(result["global_bpm"])
        self.assertEqual(result["red_lines"], [])
        self.assertEqual(result["osu_timing"], "")
        self.assertAlmostEqual(result["duration_s"], 20.0, places=2)

    def test_a_song_over_the_limit_is_refused_before_the_engine_runs(self):
        result = tr.analyse(self.change, vote=False, hash_="test", max_seconds=10)
        self.assertTrue(result["refused"])
        self.assertEqual(result["refusal"]["code"], "too_long")

    def test_a_file_that_is_not_audio_fails_rather_than_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            bogus = Path(tmp) / "song.wav"
            bogus.write_bytes(b"this is not a wave file" * 100)
            with self.assertRaises(tr.AnalysisFailed):
                tr.analyse(bogus, vote=False, hash_="test")


class HeaderGuardTests(unittest.TestCase):
    """A header that claims too much is refused before anything is decoded."""

    def _wav(self, folder, name, samplerate, channels):
        import soundfile as sf
        path = Path(folder) / name
        sf.write(str(path), np.zeros((64, channels), dtype=np.float32), samplerate)
        return path

    def test_a_rate_past_192_khz_is_refused_as_too_heavy(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = tr.analyse(self._wav(tmp, "fast.wav", 384_000, 1), vote=False, hash_="test")
        self.assertTrue(result["refused"])
        self.assertEqual(result["refusal"]["code"], "too_heavy")
        self.assertIn("384000 Hz", result["refusal"]["message"])

    def test_more_than_eight_channels_is_refused_as_too_heavy(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = tr.analyse(self._wav(tmp, "wide.wav", 44_100, 9), vote=False, hash_="test")
        self.assertEqual(result["refusal"]["code"], "too_heavy")
        self.assertIn("9 channels", result["refusal"]["message"])

    def test_a_frame_count_past_the_limit_is_refused_whatever_the_rate(self):
        from types import SimpleNamespace
        from unittest import mock
        claimed = SimpleNamespace(samplerate=8000, channels=1, frames=600 * 192_000 + 1)
        with mock.patch.object(tr.ta.sf, "info", return_value=claimed):
            self.assertIn("frames", tr.header_refusal("x.wav", 600))
            self.assertIsNone(tr.header_refusal("x.wav", 3600))
        self.assertIsNone(tr.header_refusal(Path(__file__), 600))  # no audio header: not refused here


def fake_child(conn, threads, memory_mb, vote, self_test):
    """A stand-in for isolate.run_child that misbehaves on request: the file
    name says what it does. Module level, so the spawned child can import it."""
    import time as _time
    conn.send(("ready", False, "fake", False, None))
    while True:
        try:
            request = conn.recv()
        except EOFError:
            return
        if request[0] != "analyse":
            return
        name = Path(request[1]).name
        conn.send(("length", 1.0))
        if name == "slow":
            conn.send(("progress", "attacks", 0.2))
            _time.sleep(120)
        elif name == "die":
            import os as _os
            _os._exit(9)
        elif name == "oom":
            conn.send(("failed", "too_heavy", "MemoryError: Unable to allocate 40.0 GiB"))
            return
        elif name == "broken":
            conn.send(("failed", "failed", "Error opening the file"))
        else:
            conn.send(("result", {"ok": name, "threads": threads, "memory_mb": memory_mb}))


class IsolationTests(unittest.TestCase):
    """worker/isolate.py: a job that runs out of time or memory fails alone,
    and the next job is served by a fresh child."""

    def setUp(self):
        import isolate
        self.isolate = isolate
        self.runner = isolate.Runner(2, isolate.Limits(memory_mb=0, timeout_min_s=2, timeout_factor=1),
                                     child=fake_child, ready_timeout_s=60, heartbeat_s=0.5)

    def tearDown(self):
        self.runner.close()

    def test_a_job_past_its_time_is_stopped_and_the_next_one_runs(self):
        beats = []
        started = __import__("time").monotonic()
        with self.assertRaises(self.isolate.JobFailed) as caught:
            self.runner.analyse("slow", max_seconds=600, progress=lambda *a: beats.append(a))
        self.assertEqual(caught.exception.code, "timeout")
        self.assertTrue(str(caught.exception).startswith("timeout: "))
        # The header's length (1 s) set the limit, not max_seconds: max(2 s, 1 x 1 s).
        self.assertLess(__import__("time").monotonic() - started, 30)
        self.assertGreaterEqual(len(beats), 2)  # the stage, then heartbeats repeating it
        self.assertTrue(all(b == ("attacks", 0.2) for b in beats))
        self.assertFalse(self.runner.alive())
        self.assertEqual(self.runner.analyse("song.wav")["ok"], "song.wav")
        self.assertEqual(self.runner.warmups, 2)

    def test_a_child_that_dies_fails_its_job_as_too_heavy(self):
        with self.assertRaises(self.isolate.JobFailed) as caught:
            self.runner.analyse("die")
        self.assertEqual(caught.exception.code, "too_heavy")
        self.assertEqual(self.runner.analyse("next.wav")["ok"], "next.wav")

    def test_a_memory_error_fails_its_job_and_recycles_the_child(self):
        with self.assertRaises(self.isolate.JobFailed) as caught:
            self.runner.analyse("oom")
        self.assertEqual(caught.exception.code, "too_heavy")
        self.assertIn("more memory", str(caught.exception))
        self.assertEqual(self.runner.analyse("next.wav")["ok"], "next.wav")
        self.assertEqual(self.runner.warmups, 2)

    def test_an_engine_failure_keeps_the_child(self):
        with self.assertRaises(self.isolate.JobFailed) as caught:
            self.runner.analyse("broken")
        self.assertEqual((caught.exception.code, str(caught.exception)), ("failed", "Error opening the file"))
        self.assertEqual(self.runner.analyse("next.wav")["threads"], 2)
        self.assertEqual(self.runner.warmups, 1)

    def test_limits_and_timeouts(self):
        isolate = self.isolate
        self.assertEqual(isolate.limits_from_env({}), isolate.Limits(1800, 120.0, 3.0))
        self.assertEqual(isolate.limits_from_env({"WORKER_MEMORY_MB": "0", "WORKER_TIMEOUT_MIN_S": "30",
                                                  "WORKER_TIMEOUT_FACTOR": "x"}),
                         isolate.Limits(0, 30.0, 3.0))
        limits = isolate.Limits()
        self.assertEqual(isolate.timeout_for(20.0, 600, limits), 120.0)
        self.assertEqual(isolate.timeout_for(300.0, 600, limits), 900.0)
        self.assertEqual(isolate.timeout_for(None, 600, limits), 1800.0)  # no header: the longest allowed
        self.assertEqual(isolate.kind_of(RuntimeError("std::bad_alloc")), "too_heavy")
        try:
            try:
                raise MemoryError()
            except MemoryError as exc:
                raise tr.AnalysisFailed("MemoryError") from exc
        except tr.AnalysisFailed as exc:
            self.assertEqual(isolate.kind_of(exc), "too_heavy")
        self.assertEqual(isolate.kind_of(ValueError("no pulse")), "failed")

    def test_the_memory_cap_is_skipped_where_there_is_no_rlimit(self):
        try:
            import resource  # noqa: F401
        except ImportError:
            self.assertFalse(self.isolate.limit_memory(1800))
        self.assertFalse(self.isolate.limit_memory(0))


class IsolatedEngineTests(unittest.TestCase):
    """The real engine through the real child, once (the vote off, as above)."""

    def test_the_child_analyses_what_the_engine_does_in_process(self):
        import soundfile as sf

        import isolate
        from benchmark import build_track
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change.wav"
            build_track(change, [(0.4, 128.0), (12.0, 142.0)], 24.0, seed=zlib.crc32(b"change-128-142"))
            runner = isolate.Runner(None, isolate.Limits(memory_mb=1800), vote=False, self_test=False)
            try:
                runner.start()
                stages = []
                result = runner.analyse(change, max_seconds=600, progress=lambda s, f: stages.append(s))
                self.assertEqual(result, tr.analyse(change, vote=False, hash_=runner.hash, max_seconds=600))
                self.assertEqual([round(line["bpm"], 2) for line in result["red_lines"]], [128.0, 142.0])
                self.assertEqual(stages[-1], "result")
                # A header past the limits never reaches the decoder, in the child either.
                sf.write(str(Path(tmp) / "fast.wav"), np.zeros(64, dtype=np.float32), 384_000)
                self.assertEqual(runner.analyse(Path(tmp) / "fast.wav")["refusal"]["code"], "too_heavy")
                if runner.limited:  # Linux: the cap holds a decoder that asks for too much
                    self.assertEqual(runner.limits.memory_mb, 1800)
            finally:
                runner.close()


class ResultPartsTests(unittest.TestCase):
    def test_defaults_are_the_desktop_apps_fresh_install(self):
        self.assertEqual(tr.default_params(), {
            "min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
            "prefer_map_bpm": True, "refine_beats": True, "force_subdivision": 0.0})

    def test_engine_hash_depends_on_the_vote(self):
        self.assertNotEqual(tr.engine_hash(True), tr.engine_hash(False))
        self.assertEqual(tr.engine_hash(False), tr.engine_hash(False))
        self.assertRegex(tr.engine_hash(False), r"^[0-9a-f]{16}$")

    def test_refusal_codes(self):
        self.assertEqual(tr.refusal_code("No rhythmic pulse found: this audio sounds like noise"), "no_pulse")
        self.assertEqual(tr.refusal_code("Audio must be at least two seconds long."), "too_short")
        self.assertEqual(tr.refusal_code("Audio is longer than 60 minutes; trim the file"), "too_long")
        self.assertEqual(tr.refusal_code("Something else"), "refused")
        self.assertEqual(tr.refusal_code("Audio is too heavy to analyse: its header says 9 channels"), "too_heavy")

    def test_progress_messages_map_to_stages(self):
        self.assertEqual(tr.stage_of("Loading and normalizing audio…"), ("load", 0.05))
        self.assertEqual(tr.stage_of("Checking the beats with Beat This!…")[0], "vote")
        self.assertIsNone(tr.stage_of("Something new"))

    def test_drift_measures_attacks_against_the_lines_grid(self):
        beat = 0.5  # 120 BPM from 1 s
        on_grid = 1.0 + np.arange(16) * beat
        late = on_grid + 0.004                      # every attack 4 ms after its beat
        eighths = 1.0 + (np.arange(8) + 0.5) * beat + 0.002   # fewer, 2 ms late
        times = np.sort(np.r_[late, eighths])
        drift = tr._drift(times, np.ones_like(times), 1.0, 9.0, beat)
        self.assertEqual(drift["onsets"], 24)
        self.assertAlmostEqual(drift["drift_ms"], 4.0, delta=0.01)   # the weighted median
        self.assertAlmostEqual(drift["drift_bias_ms"], 4.0, delta=0.01)
        self.assertAlmostEqual(tr._drift(np.r_[-1.0, 20.0], np.ones(2), 1.0, 9.0, beat)["onsets"], 0)
        self.assertIsNone(tr._drift(on_grid[:3], np.ones(3), 1.0, 9.0, beat)["drift_ms"])

    def test_levels(self):
        self.assertEqual(tr._level(0.99, 0.2, False, "precision"), "high")
        self.assertEqual(tr._level(0.99, 0.2, False, "legacy"), "medium")
        self.assertEqual(tr._level(0.80, None, False, "precision"), "medium")
        self.assertEqual(tr._level(0.70, None, False, "precision"), "check")
        self.assertEqual(tr._level(0.99, 0.2, True, "precision"), "check")
        self.assertEqual(tr._level(0.99, 45.0, False, "precision"), "check")


if __name__ == "__main__":
    unittest.main()
