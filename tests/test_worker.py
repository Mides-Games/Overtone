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

    def test_progress_messages_map_to_stages(self):
        self.assertEqual(tr.stage_of("Loading and normalizing audio…"), ("load", 0.05))
        self.assertEqual(tr.stage_of("Checking the beats with Beat This!…")[0], "vote")
        self.assertIsNone(tr.stage_of("Something new"))

    def test_levels(self):
        self.assertEqual(tr._level(0.99, 0.2, False, "precision"), "high")
        self.assertEqual(tr._level(0.99, 0.2, False, "legacy"), "medium")
        self.assertEqual(tr._level(0.80, None, False, "precision"), "medium")
        self.assertEqual(tr._level(0.70, None, False, "precision"), "check")
        self.assertEqual(tr._level(0.99, 0.2, True, "precision"), "check")
        self.assertEqual(tr._level(0.99, 45.0, False, "precision"), "check")


if __name__ == "__main__":
    unittest.main()
