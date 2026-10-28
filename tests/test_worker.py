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

        # v1.1: still a v1 for every v1 reader, plus the evidence the page draws;
        # v1.2: how it was asked for, which by default is as it always was.
        self.assertEqual((result["version"], result["minor"]), (1, 2))
        self.assertEqual((result["mode"], result["options"], result["hint_checks"], result["stretch"]),
                         ("normal", {}, [], None))
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

    def test_fast_mode_never_asks_beat_this_and_leaves_the_engine_as_it_was(self):
        asked = []
        original = tr.ta._beat_this_judge_beats
        try:
            def spy(_y, _sr):
                asked.append(1)

            tr.ta._beat_this_judge_beats = spy
            result = tr.analyse(self.change, vote=True, hash_="test", mode="fast")
            self.assertIs(result["beat_vote"], False)
            self.assertEqual(result["mode"], "fast")
            self.assertEqual(asked, [])
            self.assertEqual([round(line["bpm"], 2) for line in result["red_lines"]], [128.0, 142.0])
            # Put back after the job, whatever the mode switched.
            self.assertIs(tr.ta._beat_this_judge_beats, spy)
        finally:
            tr.ta._beat_this_judge_beats = original
        self.assertEqual(tr.ta.MAP_OCTAVE_RANGE, (120.0, 240.0))

    def test_a_stretch_is_read_back_in_the_songs_timeline(self):
        whole = tr.analyse(self.change, vote=False, hash_="test")
        part = tr.analyse(self.change, vote=False, hash_="test", options={"start_s": 6.0, "end_s": 20.0})
        self.assertFalse(part["refused"])
        self.assertEqual(part["stretch"], {"start_ms": 6000.0, "end_ms": 20000.0})
        self.assertAlmostEqual(part["duration_s"], 24.0, places=2)
        self.assertEqual([round(line["bpm"], 2) for line in part["red_lines"]], [128.0, 142.0])
        # Its grid is the whole song's grid: each line's beats land on the other's.
        for mine, theirs in zip(part["red_lines"], whole["red_lines"], strict=True):
            beat = mine["beat_length_ms"]
            gap = (mine["time_ms"] - theirs["time_ms"]) % beat
            self.assertLess(min(gap, beat - gap), 2.0)
        self.assertGreaterEqual(part["red_lines"][0]["time_ms"], 6000.0)
        self.assertGreaterEqual(min(part["onsets"]["t_ms"]), 6000)
        self.assertEqual(part["onset_envelope"]["start_ms"], 6000)
        rows = [r for r in part["osu_timing"].splitlines() if r and not r.startswith("//")]
        self.assertEqual([int(r.split(",")[0]) for r in rows], [round(line["time_ms"]) for line in part["red_lines"]])

    def test_a_stretch_too_short_is_refused_and_says_why(self):
        result = tr.analyse(self.change, vote=False, hash_="test", options={"start_s": 18.0, "end_s": 40.0})
        self.assertTrue(result["refused"])
        self.assertEqual(result["refusal"]["code"], "bad_stretch")

    def test_hints_the_audio_contradicts_are_flagged_not_obeyed(self):
        result = tr.analyse(self.change, vote=False, hash_="test",
                            options={"tempo": "constant", "bpm": 135.0, "meter": 3})
        self.assertEqual([round(line["bpm"], 2) for line in result["red_lines"]], [128.0, 142.0])
        keys = {check["key"]: check for check in result["hint_checks"]}
        self.assertEqual(keys["tempo_not_constant"]["values"], {"count": 2})
        self.assertNotIn("bpm_far", keys)  # 128 is within a tenth of 135
        self.assertEqual(result["options"], {"tempo": "constant", "bpm": 135.0, "meter": 3})


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

    def test_the_memory_watch_is_skipped_where_there_is_no_proc_or_it_is_off(self):
        self.assertFalse(self.isolate.can_watch_memory(0))
        has_proc = Path("/proc/self/status").exists()
        self.assertEqual(self.isolate.can_watch_memory(1800), has_proc)
        if has_proc:
            self.assertGreater(self.isolate.resident_mb("self"), 0)
        else:
            self.assertIsNone(self.isolate.resident_mb("self"))

    def test_a_child_past_its_resident_limit_is_stopped_as_too_heavy(self):
        # The child holds 64 MB live; a 16 MB limit stops it from outside.
        isolate = self.isolate
        if not isolate.can_watch_memory(16):
            self.skipTest("no /proc here: the limit is Linux-only")
        runner = isolate.Runner(None, isolate.Limits(memory_mb=16), self_test=False, child=_hungry_child)
        try:
            runner.start()
            with self.assertRaises(isolate.JobFailed) as caught:
                runner.analyse("ignored", max_seconds=60)
            self.assertEqual(caught.exception.code, "too_heavy")
            self.assertIn("16 MB limit", str(caught.exception))
            self.assertFalse(runner.alive())
        finally:
            runner.close()


def _hungry_child(conn, threads, memory_mb, vote_wanted, self_test):
    """A stand-in analysis child: ready at once, then holds 64 MB resident and
    waits, as an analysis that outgrows its limit would."""
    conn.send(("ready", False, "0" * 16, True, None, {"normal": "0" * 16}))
    if conn.recv()[0] != "analyse":
        return
    hoard = bytearray(64 * 1024 * 1024)
    for i in range(0, len(hoard), 4096):
        hoard[i] = 1
    import time
    time.sleep(30)


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


class DefaultModeTests(unittest.TestCase):
    """The default mode with no hints calls the engine exactly as the worker
    did before modes existed (W11.1): the same arguments, the vote as the
    worker has it, and no engine switch moved while it runs. The accuracy
    gates pin what that call returns; this pins that it is the same call."""

    def setUp(self):
        import soundfile as sf
        self.tmp = tempfile.TemporaryDirectory()
        self.audio = Path(self.tmp.name) / "song.wav"
        sf.write(str(self.audio), np.zeros(22050 * 3, dtype=np.float32), 22050)
        self.original = tr.ta.analyze_audio
        self.calls = []

        def record(*args, **kwargs):
            self.calls.append((args, kwargs, tr.ta.MAP_OCTAVE_RANGE, tr.ta._beat_this_judge_beats))
            raise ValueError("No rhythmic pulse found (recorded call)")

        tr.ta.analyze_audio = record

    def tearDown(self):
        tr.ta.analyze_audio = self.original
        self.tmp.cleanup()

    def _call(self, **kwargs):
        judge = tr.ta._beat_this_judge_beats
        result = tr.analyse(self.audio, hash_="test", **kwargs)
        self.assertEqual(len(self.calls), 1)
        args, keywords, window, judge_seen = self.calls[0]
        return result, args, keywords, window, judge_seen is judge

    def test_the_default_call_is_the_one_before_modes(self):
        for vote in (True, False):
            self.calls.clear()
            result, args, keywords, window, same_judge = self._call(vote=vote)
            self.assertEqual(args[0], str(self.audio))
            # min_delta, persistence, prefer_map_bpm, min_confidence, progress,
            # force_subdivision, refine_beats: default_params(), in that order.
            self.assertEqual(args[1:5], (1.5, 12, True, 0.75))
            self.assertTrue(callable(args[5]))
            self.assertEqual(args[6:], (0.0, True))
            self.assertEqual(keywords, {"beat_vote": vote})
            self.assertEqual(window, (120.0, 240.0))
            self.assertTrue(same_judge)
            self.assertIs(result["beat_vote"], vote)
            self.assertEqual((result["mode"], result["options"], result["hint_checks"], result["stretch"]),
                             ("normal", {}, [], None))

    def test_naming_normal_or_nothing_is_the_same_call(self):
        _, *first = self._call(vote=True)
        self.calls.clear()
        _, *second = self._call(vote=True, mode="normal", options={})
        self.assertEqual(first[0][:5] + first[0][6:], second[0][:5] + second[0][6:])
        self.assertEqual(first[1:], second[1:])
        self.calls.clear()
        # An unknown mode, or hints that do not parse, fall back to the default call.
        _, args, keywords, window, same_judge = self._call(vote=True, mode="turbo", options={"bpm": "fast"})
        self.assertEqual((keywords, window, same_judge), ({"beat_vote": True}, (120.0, 240.0), True))

    def test_a_hint_inside_the_default_octave_leaves_the_engine_alone(self):
        _, _, _, window, same_judge = self._call(vote=True, options={"bpm": 174, "tempo": "constant"})
        self.assertEqual(window, (120.0, 240.0))
        self.assertTrue(same_judge)


class ResultPartsTests(unittest.TestCase):
    def test_defaults_are_the_desktop_apps_fresh_install(self):
        self.assertEqual(tr.default_params(), {
            "min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
            "prefer_map_bpm": True, "refine_beats": True, "force_subdivision": 0.0})

    def test_engine_hash_depends_on_the_vote(self):
        self.assertNotEqual(tr.engine_hash(True), tr.engine_hash(False))
        self.assertEqual(tr.engine_hash(False), tr.engine_hash(False))
        self.assertRegex(tr.engine_hash(False), r"^[0-9a-f]{16}$")

    def test_each_mode_has_its_own_hash_and_normal_keeps_the_old_label(self):
        hashes = tr.engine_hashes(True)
        self.assertEqual(set(hashes), set(tr.MODES))
        self.assertEqual(len(set(hashes.values())), 3)
        self.assertEqual(hashes["normal"], tr.engine_hash(True))
        # Fast never votes, whatever the worker has.
        self.assertEqual(tr.engine_hashes(False)["fast"], hashes["fast"])

    def test_options_are_cleaned_to_what_the_engine_can_be_asked(self):
        self.assertEqual(tr.clean_options(None), {})
        self.assertEqual(tr.clean_options({"tempo": "maybe", "bpm": "120", "meter": 3.5, "x": 1}), {})
        self.assertEqual(tr.clean_options({"bpm": 500}), {})
        self.assertEqual(tr.clean_options({"bpm_min": 180, "bpm_max": 90}), {})
        self.assertEqual(tr.clean_options({"bpm_min": 90, "bpm_max": 180, "meter": 3, "tempo": "changes"}),
                         {"bpm_min": 90.0, "bpm_max": 180.0, "meter": 3, "tempo": "changes"})
        self.assertEqual(tr.clean_options({"start_s": 10, "end_s": 15}), {})  # under ten seconds
        self.assertEqual(tr.clean_options({"start_s": 10, "end_s": 40}), {"start_s": 10.0, "end_s": 40.0})
        self.assertEqual(tr.clean_options({"bpm": True}), {})

    def test_a_tempo_hint_moves_the_octave_window_only_outside_the_default(self):
        self.assertIsNone(tr.octave_window({}))
        self.assertIsNone(tr.octave_window({"bpm": 175}))
        self.assertIsNone(tr.octave_window({"bpm_min": 130, "bpm_max": 200}))
        low, high = tr.octave_window({"bpm": 90})
        self.assertAlmostEqual(high / low, 2.0, places=3)
        self.assertLess(low, 90)
        self.assertGreater(high, 90)
        low, high = tr.octave_window({"bpm_min": 240, "bpm_max": 280})
        self.assertLess(low, 240)
        self.assertGreater(high, 280)

    def test_hint_checks(self):
        result = {"global_bpm": 85.0, "red_lines": [{"bpm": 85.0, "meter": 4, "meter_known": True}]}
        checks = {c["key"]: c for c in tr.hint_checks(result, {"bpm": 170.0, "tempo": "changes", "meter": 3}, None)}
        self.assertEqual(checks["bpm_far"]["values"]["factor"], 2.0)
        self.assertEqual(checks["tempo_constant"]["values"], {"bpm": 85.0})
        self.assertEqual(checks["meter_differs"]["values"], {"meter": 3, "found": [4]})
        checks = {c["key"]: c for c in tr.hint_checks(result, {"bpm_min": 80.0, "bpm_max": 100.0}, (70.0, 140.0))}
        self.assertNotIn("bpm_outside", checks)
        self.assertEqual(checks["octave_window"]["values"]["default_bpm"], 170.0)
        self.assertEqual(tr.hint_checks({"global_bpm": None, "red_lines": []}, {"bpm": 120.0}, None), [])

    def test_shift_result_moves_every_time(self):
        result = {"offset_ms": 10.0, "red_lines": [{"time_ms": 10.0}], "sections": [{"start_ms": 10.0, "end_ms": 50.0}],
                  "beats": {"t_ms": [10, 20], "bpm": [120, 120]}, "onsets": {"t_ms": [11], "w": [100]},
                  "downbeats_ms": [10], "onset_envelope": {"span_ms": 40, "v": [1]},
                  "swing": {"measured": 0, "swung": 0, "spans": [{"start_ms": 10, "end_ms": 20}]},
                  "pulse_hints": [{"from_ms": 10, "to_ms": 20, "boundary_ms": 15}]}
        moved = tr.shift_result(result, 1000.5)
        self.assertEqual(moved["offset_ms"], 1010.5)
        self.assertEqual(moved["red_lines"][0]["time_ms"], 1010.5)
        self.assertEqual(moved["sections"][0], {"start_ms": 1010.5, "end_ms": 1050.5})
        self.assertEqual(moved["beats"]["t_ms"], [1010, 1020])
        self.assertEqual(moved["onsets"]["t_ms"], [1012])
        self.assertEqual(moved["downbeats_ms"], [1010])
        self.assertEqual(moved["onset_envelope"]["start_ms"], 1000)
        self.assertEqual(moved["swing"]["spans"][0], {"start_ms": 1010, "end_ms": 1020})
        self.assertEqual(moved["pulse_hints"][0], {"from_ms": 1010, "to_ms": 1020, "boundary_ms": 1016})
        self.assertEqual(result["offset_ms"], 10.0)  # the original is left alone

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


class TwoEnginesOneSchemaTests(unittest.TestCase):
    """``overtone-cli analyze --timing-result`` and the worker write the same
    ``timing-result v1`` document. Checked on one golden fixture,
    change-128-142 (bench/golden/), the 60 s benchmark case with a tempo
    change at 30 s, so both a red-line list and a section split are compared.
    The vote is off on the v3 side: v4 has no vote, and the benchmark gates
    what the vote does. Skipped, and saying so, without a release build of
    overtone-cli (``cargo build --release -p overtone-cli``)."""

    CASE = "change-128-142"

    @classmethod
    def setUpClass(cls):
        import subprocess

        import benchmark as bm
        import overtone_rust

        cls.cli = overtone_rust.find_cli()
        if cls.cli is None:
            raise unittest.SkipTest("no overtone-cli build: cargo build --release -p overtone-cli")
        cls.tmp = tempfile.TemporaryDirectory()
        audio = Path(cls.tmp.name) / f"{cls.CASE}.wav"
        bm.build_track(audio, seed=zlib.crc32(cls.CASE.encode()), **bm.CASES[cls.CASE])
        done = subprocess.run([str(cls.cli), "analyze", str(audio), "--timing-result"],
                              capture_output=True, text=True, timeout=300, check=False)
        cls.v4 = json.loads(done.stdout)
        cls.v4_exit = done.returncode
        cls.v3 = tr.analyse(audio, vote=False, hash_="0123456789abcdef")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @staticmethod
    def _shape(value):
        """Keys and JSON types, values left out; int and float are one type."""
        if isinstance(value, dict):
            return {k: TwoEnginesOneSchemaTests._shape(v) for k, v in value.items()}
        if isinstance(value, list):
            return [TwoEnginesOneSchemaTests._shape(value[0])] if value else []
        if isinstance(value, bool):
            return "bool"
        if isinstance(value, (int, float)):
            return "number"
        return type(value).__name__

    def test_both_engines_write_the_same_keys_and_types(self):
        self.assertEqual(self.v4_exit, 0)
        v3, v4 = self._shape(self.v3), self._shape(self.v4)
        # v4 does not validate timing points yet, and an empty list would
        # claim it did (crates/overtone-cli/src/main.rs): the one absent key.
        v3.pop("findings")
        # v4 writes timing-result v1.0: no `minor`, so no reader looks in it
        # for the v1.1 evidence the result page draws. v1.0 is what both share.
        self.assertNotIn("minor", v4)
        for key in ("minor", "beats", "downbeats_ms", "onsets", "onset_envelope", "swing", "pulse_hints",
                    "mode", "options", "hint_checks", "stretch"):
            v3.pop(key)
        for section in v3["sections"]:
            for key in ("drift_ms", "drift_p90_ms", "drift_bias_ms", "onsets"):
                section.pop(key)
        # The parameters are each engine's own: v3 takes two v4 does not.
        self.assertLessEqual(set(v4.pop("params")), set(v3.pop("params")))
        self.assertEqual(v4, v3)

    def test_both_engines_read_the_fixture_alike(self):
        self.assertEqual((self.v3["format"], self.v3["version"]), ("timing-result", 1))
        self.assertEqual((self.v4["format"], self.v4["version"]), ("timing-result", 1))
        self.assertEqual((self.v3["engine"], self.v4["engine"]), ("v3", "v4"))
        self.assertRegex(self.v4["engine_hash"], r"^[0-9a-f]{16}$")
        self.assertFalse(self.v4["beat_vote"])
        self.assertEqual([round(line["bpm"], 2) for line in self.v4["red_lines"]], [128.0, 142.0])
        for a, b in zip(self.v3["red_lines"], self.v4["red_lines"], strict=True):
            self.assertAlmostEqual(a["bpm"], b["bpm"], delta=0.01)
            self.assertAlmostEqual(a["time_ms"], b["time_ms"], delta=5.0)
        self.assertEqual([s["level"] for s in self.v3["sections"]],
                         [s["level"] for s in self.v4["sections"]])
        self.assertEqual(self.v3["meter"], self.v4["meter"])
        rows = [r for r in self.v4["osu_timing"].splitlines() if r and not r.startswith("//")]
        self.assertEqual(len(rows), 2)
