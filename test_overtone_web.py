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
        # the 90->200 BPM ramp: music from 0.5 s, only red line at 70 s.
        # The engine owns the rule now; the shell only translates the key.
        notes = web.analysis_payload(_analysis([ta.TimingPoint(70_393.1, 196.5, 0.74, 150)]))["warnings"]
        late = [n for n in notes if n["key"] == "v_late_first"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0]["values"], {"line": "70.4", "beat": "0.5", "n": 1})

    def test_engine_findings_surface_with_shell_levels(self) -> None:
        notes = web.analysis_payload(_analysis(
            [ta.TimingPoint(1000.0, 120.0, 0.9, 0),
             ta.TimingPoint(1200.0, 120.0, 0.9, 1)]))["warnings"]
        dup = [n for n in notes if n["key"] == "v_dup_points"]
        self.assertEqual(len(dup), 1)
        self.assertEqual(dup[0]["level"], "warn")  # engine errors read as banners
        halved = web.analysis_payload(_analysis(
            [ta.TimingPoint(0.0, 140.0, 0.9, 0),
             ta.TimingPoint(30000.0, 280.0, 0.9, 70)]))["warnings"]
        octave = [n for n in halved if n["key"] == "v_octave_check"]
        self.assertEqual(len(octave), 1)
        self.assertEqual(octave[0]["level"], "info")
        json.dumps(halved)

    def test_fixing_a_duplicate_clears_its_banner(self) -> None:
        api = web.Api()
        api._analysis = _analysis(
            [ta.TimingPoint(1000.0, 120.0, 0.9, 0),
             ta.TimingPoint(1200.0, 120.0, 0.9, 1)])
        before = [w["key"] for w in web.analysis_payload(api._analysis)["warnings"]]
        self.assertIn("v_dup_points", before)
        reply = api.edit_nudge(1, 5000.0)
        self.assertTrue(reply["ok"])
        after = [w["key"] for w in reply["result"]["warnings"]]
        self.assertNotIn("v_dup_points", after)

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


class _FakeWindow:
    """Stands in for the pywebview window: answers file dialogs, nothing else."""

    def __init__(self, choice: str | None) -> None:
        self.choice = choice

    def create_file_dialog(self, *args, **kwargs):
        return [self.choice] if self.choice else None


def _api_with_points() -> web.Api:
    api = web.Api()
    api._analysis = _analysis([ta.TimingPoint(1000.0, 120.0, 0.9, 0),
                               ta.TimingPoint(9000.0, 150.0, 0.8, 10)])
    return api


class EditTests(_IsolatedConfig):
    def test_apply_replaces_offset_and_bpm(self) -> None:
        api = _api_with_points()
        # 9200 ms stays off the previous 500 ms grid, so no snap hides the edit.
        reply = api.edit_apply(1, 9200.0, 160.0)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["selected"], 1)
        self.assertAlmostEqual(api._analysis.points[1].offset_ms, 9200.0)
        self.assertAlmostEqual(api._analysis.points[1].bpm, 160.0)
        json.dumps(reply["result"])

    def test_add_inserts_sorted_and_selects_the_new_point(self) -> None:
        api = _api_with_points()
        reply = api.edit_add(5000.0, 140.0)
        self.assertTrue(reply["ok"])
        self.assertEqual([p.offset_ms for p in api._analysis.points], [1000.0, 5000.0, 9000.0])
        self.assertEqual(reply["selected"], 1)
        self.assertEqual(reply["result"]["points"][1]["bpm"], 140.0)

    def test_delete_removes_and_clamps_the_selection(self) -> None:
        api = _api_with_points()
        reply = api.edit_delete(1)
        self.assertTrue(reply["ok"])
        self.assertEqual(len(api._analysis.points), 1)
        self.assertEqual(reply["selected"], 0)

    def test_delete_refuses_the_first_point_like_the_tk_editor(self) -> None:
        reply = _api_with_points().edit_delete(0)
        self.assertFalse(reply["ok"])
        self.assertIn("anchors", reply["detail"])

    def test_nudge_shifts_and_clamps_at_zero(self) -> None:
        api = _api_with_points()
        reply = api.edit_nudge(0, -5000.0)
        self.assertTrue(reply["ok"])
        self.assertAlmostEqual(api._analysis.points[0].offset_ms, 0.0)
        self.assertEqual(reply["selected"], 0)

    def test_rescale_section_doubles_one_sections_bpm(self) -> None:
        api = _api_with_points()
        reply = api.edit_rescale(0, 2.0)
        self.assertTrue(reply["ok"])
        self.assertAlmostEqual(api._analysis.points[0].bpm, 240.0)
        self.assertEqual(reply["selected"], 0)
        self.assertFalse(api.edit_rescale(0, 3.0)["ok"])

    def test_edits_need_a_result_and_valid_values(self) -> None:
        self.assertEqual(web.Api().edit_apply(0, 1000.0, 120.0)["key"], "first")
        self.assertEqual(web.Api().edit_add(1000.0, 120.0)["key"], "first")
        self.assertEqual(web.Api().edit_delete(0)["key"], "first")
        self.assertEqual(web.Api().edit_nudge(0, 5.0)["key"], "first")
        self.assertEqual(web.Api().edit_rescale(0, 2.0)["key"], "first")
        api = _api_with_points()
        self.assertFalse(api.edit_apply(7, 1000.0, 120.0)["ok"])
        self.assertFalse(api.edit_apply(0, 1000.0, -3.0)["ok"])
        self.assertFalse(api.edit_add(1000.0, float("nan"))["ok"])


_OSU_TEXT = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "",
    "[TimingPoints]",
    "1000,400,4,1,0,100,1,0",
    "2000,-50,4,2,0,100,0,0",
    "",
    "[HitObjects]",
    "",
])


class ExportTests(_IsolatedConfig):
    def test_osu_text_matches_the_engine_verbatim(self) -> None:
        api = _api_with_points()
        reply = api.osu_text()
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["text"], ta.osu_timing_text(api._analysis))
        self.assertEqual(web.Api().osu_text()["key"], "first")

    def test_save_csv_writes_the_same_rows_as_the_engine(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / "t.csv")
            api = _api_with_points()
            api._window = _FakeWindow(target)
            reply = api.save_csv()
            self.assertTrue(reply["ok"])
            self.assertEqual(reply["path"], target)
            lines = Path(target).read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "offset_ms,bpm,beat_index,confidence")
            self.assertEqual(len(lines), 3)

    def test_save_dialog_cancel_is_silence_not_an_error(self) -> None:
        api = _api_with_points()
        api._window = _FakeWindow(None)
        self.assertEqual(api.save_csv()["key"], "cancelled")
        self.assertEqual(api.save_click()["key"], "cancelled")
        self.assertEqual(api.save_osz()["key"], "cancelled")

    def test_save_click_writes_a_wav(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / "click.wav")
            api = _api_with_points()
            api._window = _FakeWindow(target)
            self.assertTrue(api.save_click()["ok"])
            self.assertGreater(Path(target).stat().st_size, 1000)

    def test_save_osz_bundles_audio_plus_timing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "song.wav"
            _drum_track(wav, [(0.5, 128.0)], duration=8.0)
            target = str(Path(tmp) / "song.osz")
            api = _api_with_points()
            api._cfg["file"] = str(wav)
            api._window = _FakeWindow(target)
            reply = api.save_osz()
            self.assertTrue(reply["ok"])
            self.assertGreater(Path(target).stat().st_size, 1000)

    def test_inject_dry_run_writes_nothing_then_apply_writes_with_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = Path(tmp) / "map.osu"
            beatmap.write_text(_OSU_TEXT, encoding="utf-8")
            api = _api_with_points()
            prev = api.inject_preview(str(beatmap))
            self.assertTrue(prev["ok"])
            self.assertEqual(prev["summary"]["reds_replaced"], 1)
            self.assertEqual(prev["summary"]["greens_kept"], 1)
            self.assertEqual(beatmap.read_text(encoding="utf-8"), _OSU_TEXT)
            done = api.inject_apply(str(beatmap))
            self.assertTrue(done["ok"])
            self.assertEqual(done["summary"]["reds_added"], 2)
            self.assertTrue(Path(str(beatmap) + ".bak").is_file())
            # A second inject keeps the pristine original, never the last write.
            api.inject_apply(str(beatmap))
            self.assertEqual(Path(str(beatmap) + ".bak").read_text(encoding="utf-8"), _OSU_TEXT)

    def test_inject_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().inject_preview("C:/x.osu")["key"], "first")
        self.assertEqual(web.Api().inject_apply("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().inject_preview("C:/does/not/exist.osu")["key"], "bad_file")


class DropTests(_IsolatedConfig):
    def test_corrupt_and_oversized_drops_are_refused(self) -> None:
        api = web.Api()
        options = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                   "prefer_map_bpm": True, "refine_beats": True}
        self.assertEqual(api.analyze_bytes("a.wav", "!!!not-base64!!!", options)["key"], "bad_drop")
        with mock.patch.object(ta, "MAX_OSZ_AUDIO_BYTES", 10):
            import base64
            self.assertEqual(
                api.analyze_bytes("a.wav", base64.b64encode(b"0123456789!").decode(), options)["key"],
                "too_big")

    def test_dropped_bytes_analyse_like_the_same_file_on_disk(self) -> None:
        import base64

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

            api._emit = emit
            staged = Path(tmp) / "staged"
            with mock.patch.object(web, "DROP_DIR", staged):
                reply = api.analyze_bytes("drums.wav", base64.b64encode(wav.read_bytes()).decode(), options)
            self.assertTrue(reply["ok"])
            self.assertTrue(done.wait(120), "dropped analysis did not finish")
            self.assertTrue((staged / "drums.wav").is_file())
        kind, payload = events[-1]
        self.assertEqual(kind, "onResult")
        self.assertEqual(payload["points"], web.analysis_payload(direct)["points"])
        self.assertAlmostEqual(payload["global_bpm"], direct.global_bpm)


class UndoTests(_IsolatedConfig):
    def test_undo_restores_and_redo_reapplies(self) -> None:
        api = _api_with_points()
        before = list(api._analysis.points)
        reply = api.edit_apply(1, 9200.0, 160.0)
        self.assertTrue(reply["undo"])
        self.assertFalse(reply["redo"])
        undone = api.undo()
        self.assertTrue(undone["ok"])
        self.assertEqual(api._analysis.points, before)
        self.assertFalse(undone["undo"])
        self.assertTrue(undone["redo"])
        redone = api.redo()
        self.assertTrue(redone["ok"])
        self.assertAlmostEqual(api._analysis.points[1].bpm, 160.0)
        self.assertTrue(redone["undo"])
        self.assertFalse(redone["redo"])
        json.dumps(redone["result"])

    def test_a_new_edit_discards_the_redo_stack(self) -> None:
        api = _api_with_points()
        api.edit_apply(1, 9200.0, 160.0)
        api.undo()
        api.edit_add(5000.0, 140.0)
        self.assertEqual(api.redo()["key"], "no_redo")

    def test_empty_stacks_and_missing_result(self) -> None:
        self.assertEqual(web.Api().undo()["key"], "first")
        self.assertEqual(web.Api().redo()["key"], "first")
        api = _api_with_points()
        self.assertEqual(api.undo()["key"], "no_undo")
        self.assertEqual(api.redo()["key"], "no_redo")
        self.assertEqual(api.history_state(), {"undo": False, "redo": False})

    def test_a_failed_edit_leaves_no_history_entry(self) -> None:
        api = _api_with_points()
        self.assertFalse(api.edit_apply(0, 1000.0, -3.0)["ok"])
        self.assertFalse(api.history_state()["undo"])

    def test_history_is_capped(self) -> None:
        api = _api_with_points()
        for n in range(60):
            self.assertTrue(api.edit_add(2000.0 + n, 140.0)["ok"])
        for _ in range(50):
            self.assertTrue(api.undo()["ok"])
        self.assertEqual(api.undo()["key"], "no_undo")

    def test_a_fresh_analysis_clears_both_stacks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "drums.wav"
            _drum_track(wav, [(0.5, 128.0)], duration=4.0)
            api = _api_with_points()
            api.edit_add(5000.0, 140.0)
            self.assertTrue(api.history_state()["undo"])
            done = threading.Event()
            api._emit = lambda handler, payload: done.set() if handler == "onResult" else None
            self.assertTrue(api.analyze(
                str(wav), {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                           "prefer_map_bpm": True, "refine_beats": True})["ok"])
            self.assertTrue(done.wait(120), "analysis did not finish")
            self.assertEqual(api.history_state(), {"undo": False, "redo": False})


if __name__ == "__main__":
    unittest.main()
