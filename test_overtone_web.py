"""Tests for the web shell bridge (overtone_web.py).

No window is opened: the bridge is plain Python, so everything the frontend
receives can be checked here. The engine itself is covered by
test_timing_analyzer.py; these tests pin that the bridge (1) calls it exactly
as the Tk GUI does, (2) returns only JSON types, and (3) never touches the
user's real ~/.overtone.json.
"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import overtone_web as web
import timing_analyzer as ta
from test_timing_analyzer import _drum_track


def _analysis(points, beats=None, engine="precision", residual=0.4, onset_frames=5000):
    beats = np.arange(0.5, 60.0, 0.4) if beats is None else np.asarray(beats, dtype=float)
    return ta.Analysis(
        source="C:/songs/Artist - Title/audio.mp3", duration=60.0, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=points, hop_length=512,
        sample_rate=22050, subdivision=1.0, global_bpm=150.0, stability=0.9,
        onset=np.linspace(0, 1, onset_frames, dtype=np.float32), engine=engine,
        fit_residual_ms=residual)


class _IsolatedConfig(unittest.TestCase):
    """Every test sees an empty config and records writes instead of saving."""

    def setUp(self) -> None:
        self.saved: list[dict] = []
        patches = [mock.patch.object(ta, "load_config", return_value={}),
                   mock.patch.object(ta, "save_config", side_effect=lambda d: self.saved.append(dict(d)))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class PayloadTests(unittest.TestCase):
    def test_payload_is_plain_json_and_matches_the_snapped_points(self) -> None:
        points = [ta.TimingPoint(512.3456, 150.00004, 0.97, 0, meter=3, meter_known=True),
                  ta.TimingPoint(30512.9, 175.0, 0.81, 70)]
        payload = web.analysis_payload(_analysis(points))
        json.dumps(payload)  # raises on numpy scalars or arrays
        snapped = ta.snap_timing_points(points)
        self.assertEqual([p["offset_ms"] for p in payload["points"]], [p.offset_ms for p in snapped])
        self.assertEqual([p["bpm"] for p in payload["points"]], [p.bpm for p in snapped])
        self.assertEqual(payload["points"][0]["meter"], 3)
        self.assertTrue(payload["points"][0]["meter_known"])
        self.assertAlmostEqual(payload["points"][1]["beat_ms"], 60000 / snapped[1].bpm)
        self.assertEqual(payload["source"], "audio.mp3")

    def test_onset_bed_is_pooled_and_normalised(self) -> None:
        payload = web.analysis_payload(_analysis([ta.TimingPoint(500, 150, 1, 0)], onset_frames=40_000))
        bed = payload["onset"]["v"]
        self.assertLessEqual(len(bed), web.ONSET_BINS)
        self.assertAlmostEqual(max(bed), 1.0)
        # max-pooling keeps a one-frame spike that averaging would erase
        spiky = np.zeros(40_000, dtype=np.float32)
        spiky[12_345] = 1.0
        analysis = _analysis([ta.TimingPoint(500, 150, 1, 0)])
        analysis.onset = spiky
        self.assertEqual(max(web.analysis_payload(analysis)["onset"]["v"]), 1.0)

    def test_trace_keeps_one_value_per_beat(self) -> None:
        payload = web.analysis_payload(_analysis([ta.TimingPoint(500, 150, 1, 0)]))
        self.assertEqual(len(payload["trace"]["t"]), len(payload["trace"]["bpm"]))
        self.assertEqual(payload["beat_count"], len(payload["trace"]["t"]))

    def test_empty_onset_and_no_points_do_not_crash(self) -> None:
        analysis = _analysis([], onset_frames=0)
        payload = web.analysis_payload(analysis)
        self.assertEqual(payload["onset"]["v"], [])
        self.assertEqual(payload["points"], [])


class WarningTests(unittest.TestCase):
    def keys(self, analysis):
        return [w["key"] for w in web.analysis_payload(analysis)["warnings"]]

    def test_clean_precision_result_has_no_warnings(self) -> None:
        self.assertEqual(self.keys(_analysis([ta.TimingPoint(500, 150, 1, 0)])), [])

    def test_fallback_engine_is_flagged(self) -> None:
        self.assertIn("warn_legacy", self.keys(_analysis([ta.TimingPoint(500, 150, 1, 0)], engine="legacy")))

    def test_first_red_line_long_after_the_music_starts_is_flagged(self) -> None:
        # the 90->200 BPM ramp: music from 0.5 s, only red line at 70 s
        notes = web.analysis_payload(_analysis([ta.TimingPoint(70_393.1, 196.5, 0.74, 150)]))["warnings"]
        late = [n for n in notes if n["key"] == "warn_late_first"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0]["values"], {"line": "70.4", "beat": "0.5"})

    def test_loose_grid_is_flagged(self) -> None:
        self.assertIn("warn_loose", self.keys(_analysis([ta.TimingPoint(500, 150, 1, 0)], residual=14.6)))


class ApiTests(_IsolatedConfig):
    def test_state_survives_a_hand_edited_config(self) -> None:
        api = web.Api()
        api._cfg = {"cfg_version": 2, "delta": "abc", "persistence": None, "confidence": "nan",
                    "file": 42, "pulse": "×2"}
        state = api.state()
        self.assertEqual(state["options"]["delta"], 1.5)
        self.assertEqual(state["options"]["persistence"], 12)
        self.assertEqual(state["options"]["confidence"], 75.0)
        self.assertEqual(state["options"]["pulse"], "x2")
        json.dumps(state)

    def test_old_config_versions_get_the_current_defaults(self) -> None:
        api = web.Api()
        api._cfg = {"delta": "2.0", "persistence": "20", "confidence": "85"}  # v1, no cfg_version
        self.assertEqual(api.state()["options"]["delta"], 1.5)

    def test_autorun_fires_once_and_only_for_a_command_line_file(self) -> None:
        self.assertFalse(web.Api().state()["autorun"])
        api = web.Api("C:/x.mp3", autorun=True)
        self.assertTrue(api.state()["autorun"])
        self.assertFalse(api.state()["autorun"])

    def test_params_match_the_tk_argument_contract(self) -> None:
        params = web.Api._params({"delta": "1.5", "persistence": "12", "confidence": "75",
                                  "pulse": "/2", "prefer_map_bpm": False, "refine_beats": True})
        self.assertEqual(params, {"min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
                                  "prefer_map_bpm": False, "refine_beats": True,
                                  "force_subdivision": 0.5})
        with self.assertRaises(ValueError):
            web.Api._params({"delta": 1.5, "persistence": 12, "confidence": 150})

    def test_analyze_refuses_a_missing_file_and_bad_values(self) -> None:
        api = web.Api()
        self.assertEqual(api.analyze("C:/does/not/exist.wav", {})["key"], "bad_file")
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "a.wav"
            wav.write_bytes(b"RIFF")
            self.assertEqual(api.analyze(str(wav), {"delta": "x"})["key"], "bad_values")

    def test_a_second_analysis_while_busy_is_refused(self) -> None:
        api = web.Api()
        api._busy.acquire()
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "a.wav"
            wav.write_bytes(b"RIFF")
            reply = api.analyze(str(wav), {"delta": 1.5, "persistence": 12, "confidence": 75})
        self.assertEqual(reply["key"], "busy")

    def test_settings_are_written_in_the_tk_config_format(self) -> None:
        api = web.Api()
        api._remember("C:/a.mp3", {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "x2",
                                   "prefer_map_bpm": True, "refine_beats": False})
        saved = self.saved[-1]
        self.assertEqual(saved["pulse"], "×2")
        self.assertEqual(saved["cfg_version"], ta.TimingAnalyzerApp.CFG_VERSION)
        self.assertFalse(saved["refine_beats"])
        self.assertEqual(api.state()["options"]["pulse"], "x2")  # round trip

    def test_rescale_needs_a_result(self) -> None:
        self.assertEqual(web.Api().rescale(2)["key"], "first")


class EndToEndBridgeTests(_IsolatedConfig):
    def test_bridge_result_equals_the_direct_engine_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "drums.wav"
            _drum_track(wav, [(0.5, 128.0)], duration=16.0)
            options = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                       "prefer_map_bpm": True, "refine_beats": True}
            direct = ta.analyze_audio(str(wav), 1.5, 12, True, 0.75)
            api = web.Api()
            events: list[tuple[str, object]] = []
            done = threading.Event()

            def emit(handler, payload):
                events.append((handler, payload))
                if handler in ("onResult", "onError"):
                    done.set()

            api._emit = emit  # no window: capture what would go to JS
            self.assertTrue(api.analyze(str(wav), options)["ok"])
            self.assertTrue(done.wait(120), "analysis did not finish")
        kind, payload = events[-1]
        self.assertEqual(kind, "onResult")
        self.assertEqual(payload, web.analysis_payload(direct))
        self.assertTrue(any(k == "onProgress" for k, _ in events))
        # and the pulse buttons work on the stored result
        doubled = api.rescale(2)
        self.assertTrue(doubled["ok"])
        self.assertAlmostEqual(doubled["result"]["global_bpm"], 2 * payload["global_bpm"], places=1)


if __name__ == "__main__":
    unittest.main()
