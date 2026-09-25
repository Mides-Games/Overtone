"""Tests for the web shell bridge (overtone_web.py).

No window is opened: the bridge is plain Python, so everything the frontend
receives can be checked here. The engine itself is covered by
test_overtone.py; these tests pin that the bridge (1) calls it exactly
as the Tk GUI does, (2) returns only JSON types, and (3) never touches the
user's real ~/.overtone.json.
"""
import base64
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import overtone_web as web
import overtone as ta

from test_overtone import _drum_track

def _analysis(points, beats=None, engine="precision", residual=0.4, onset_frames=5000):
    beats = np.arange(0.5, 60.0, 0.4) if beats is None else np.asarray(beats, dtype=float)
    return ta.Analysis(
        source="C:/songs/Artist - Title/audio.mp3", duration=60.0, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=points, hop_length=512,
        sample_rate=22050, subdivision=1.0, global_bpm=150.0, stability=0.9,
        onset=np.linspace(0, 1, onset_frames, dtype=np.float32), engine=engine,
        fit_residual_ms=residual)


class _IsolatedConfig(unittest.TestCase):
    """Every test sees an empty config and records writes instead of saving.

    LOCALAPPDATA is also redirected: the result cache and drop staging must
    never touch the real machine, and one test's cache entry must never make
    another test skip its engine run.
    """

    def setUp(self) -> None:
        self.saved: list[dict] = []
        patches = [mock.patch.object(ta, "load_config", return_value={}),
                   mock.patch.object(ta, "save_config", side_effect=lambda d: self.saved.append(dict(d)))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        env = mock.patch.dict(os.environ, {"LOCALAPPDATA": scratch.name})
        env.start()
        self.addCleanup(env.stop)


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
                                  "force_subdivision": 0.5,
                                  # Not a Tk argument: which engine runs, v3 unless asked.
                                  "engine": "python"})
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


class CompareBridgeTests(_IsolatedConfig):
    def _report_for(self, api, text):
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = Path(tmp) / "map.osu"
            beatmap.write_text(text, encoding="utf-8")
            return api.compare(str(beatmap))

    def test_identical_map_reports_clean_sections(self) -> None:
        api = _api_with_points()
        text = ta.osu_beatmap_text(api._analysis, "audio.mp3")
        reply = self._report_for(api, text)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["file"], "map.osu")
        self.assertEqual(len(reply["report"]["sections"]), 2)
        self.assertEqual(reply["report"]["findings"], [])
        json.dumps(reply["report"])

    def test_shifted_map_line_warns(self) -> None:
        api = _api_with_points()
        lines = ta.osu_beatmap_text(api._analysis, "audio.mp3").splitlines()
        lines = [line.replace("9000,", "9030,") if line.startswith("9000,") else line
                 for line in lines]
        reply = self._report_for(api, "\n".join(lines))
        offset = [f for f in reply["report"]["findings"] if f["key"] == "map_offset"]
        self.assertEqual(len(offset), 1)
        self.assertEqual(offset[0]["values"], {"ms": "30.0"})

    def test_compare_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().compare("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().compare("C:/does/not/exist.osu")["key"], "bad_file")


class AlignBridgeTests(_IsolatedConfig):
    def _map_for(self, tmp: str, times_ms) -> str:
        lines = ["osu file format v14", "", "[General]", "AudioFilename: drums.wav", "",
                 "[HitObjects]"]
        lines += [f"256,192,{t:.1f},1,0,0:0:0:0:" for t in times_ms]
        beatmap = Path(tmp) / "map.osu"
        beatmap.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(beatmap)

    def test_align_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().align("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().align("C:/does/not/exist.osu")["key"], "bad_file")

    def test_align_without_attacks_reports_no_attacks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reply = _api_with_points().align(self._map_for(tmp, [1000.0]))
        self.assertTrue(reply["ok"])
        self.assertEqual([(f["level"], f["key"]) for f in reply["report"]["findings"]],
                         [("info", "no_attacks")])
        json.dumps(reply["report"])

    def test_align_on_real_attacks_matches_and_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "drums.wav"
            _drum_track(wav, [(0.5, 128.0)], duration=16.0)
            api = _api_with_points()
            done = threading.Event()
            api._emit = lambda handler, payload: done.set() if handler == "onResult" else None
            options = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                       "prefer_map_bpm": True, "refine_beats": True}
            self.assertTrue(api.analyze(str(wav), options)["ok"])
            self.assertTrue(done.wait(120), "analysis did not finish")
            attack_ms = [float(t) * 1000.0 for t in api._analysis.attack_times]
            self.assertGreater(len(attack_ms), 0)
            clean = api.align(self._map_for(tmp, attack_ms))
            self.assertTrue(clean["ok"])
            self.assertEqual(clean["report"]["matched"], clean["report"]["objects"])
            shifted = api.align(self._map_for(tmp, [t + 60.0 for t in attack_ms]))
            offenders = shifted["report"]["offenders"]
            self.assertTrue(len(offenders) > 0)
            self.assertTrue(all(o["ms"] >= 60.0 - 0.1 for o in offenders))
            json.dumps(shifted["report"])


class DensityBridgeTests(_IsolatedConfig):
    def _map(self, tmp: str) -> str:
        lines = ["osu file format v14", "", "[HitObjects]"]
        lines += [f"64,192,{n * 100},1,0,0:0:0:0:" for n in range(21)]
        beatmap = Path(tmp) / "map.osu"
        beatmap.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(beatmap)

    def test_density_reports_breakdown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reply = _api_with_points().density(self._map(tmp))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["file"], "map.osu")
        report = reply["report"]
        self.assertEqual(report["objects"], 21)
        self.assertEqual(report["stream"], 21)
        self.assertAlmostEqual(report["peak_per_second"], 4.2)
        json.dumps(report)

    def test_density_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().density("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().density("C:/does/not/exist.osu")["key"], "bad_file")


class SnapBridgeTests(_IsolatedConfig):
    def _map(self, tmp: str) -> str:
        # One red line at 1000 ms, 120 BPM; 1250 sits on 1/2, 1300 on nothing.
        lines = ["osu file format v14", "", "[TimingPoints]", "1000,500,4,1,0,100,1,0",
                 "", "[HitObjects]", "64,192,1250,1,0,0:0:0:0:", "64,192,1300,1,0,0:0:0:0:"]
        beatmap = Path(tmp) / "map.osu"
        beatmap.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(beatmap)

    def test_snap_lists_the_object_off_the_grid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reply = _api_with_points().snap(self._map(tmp))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["file"], "map.osu")
        report = reply["report"]
        self.assertEqual((report["objects"], report["snapped"]), (2, 1))
        self.assertEqual(report["unsnapped"][0]["time_ms"], 1300.0)
        # The loaded result's red lines are the ones an inject would write.
        self.assertIn("with_detected_timing", report)
        json.dumps(report)

    def test_snap_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().snap("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().snap("C:/does/not/exist.osu")["key"], "bad_file")


class ReferenceBridgeTests(_IsolatedConfig):
    """Reference timing: grade any map, load it as the working timing, find
    other maps of the same audio."""

    MAP = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
           "[TimingPoints]", "1000,400,3,1,0,100,1,0", "31000,400,4,1,0,100,1,0", ""]

    def _setup(self, tmp: str, same_bytes: bool = True):
        song = Path(tmp) / "song" / "audio.mp3"
        song.parent.mkdir()
        song.write_bytes(b"ID3" + bytes(range(256)))
        folder = Path(tmp) / "set"
        folder.mkdir()
        (folder / "audio.mp3").write_bytes(song.read_bytes() if same_bytes
                                           else b"ID3" + bytes(reversed(range(256))))
        osu = folder / "map.osu"
        osu.write_text("\n".join(self.MAP), encoding="utf-8")
        api = _api_with_points()
        api._analysis.source = str(song)
        beat = 0.4
        api._analysis.attack_times = np.arange(1.0, 60.0, beat / 2)
        api._analysis.attack_weights = np.where(
            np.arange(api._analysis.attack_times.size) % 2 == 0, 1.0, 0.5)
        return api, str(osu)

    def test_grade_reads_the_songs_attacks_and_names_the_audio(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api, osu = self._setup(tmp)
            reply = api.reference_grade(osu)
            other = self._setup(tempfile.mkdtemp(dir=tmp), same_bytes=False)
            differs = other[0].reference_grade(other[1])["same_audio"]
        json.dumps(reply)
        self.assertTrue(reply["ok"])
        self.assertEqual((reply["file"], reply["same_audio"], differs), ("map.osu", True, False))
        lines = reply["report"]["lines"]
        self.assertEqual([line["verdict"] for line in lines], ["ok", "ok"])
        self.assertEqual([line["meter"] for line in lines], [3, 4])
        self.assertFalse(api._busy.locked())

    def test_attacks_are_detected_once_when_the_engine_kept_none(self) -> None:
        from test_overtone import _drum_track
        with tempfile.TemporaryDirectory() as tmp:
            api, osu = self._setup(tmp)
            wav = Path(tmp) / "legacy.wav"
            _drum_track(wav, [(1.0, 150.0)], duration=20.0)
            api._analysis.source = str(wav)
            api._analysis.attack_times = np.zeros(0)
            api._analysis.attack_weights = np.zeros(0)
            with mock.patch.object(ta, "_detect_attacks", wraps=ta._detect_attacks) as detect:
                first = api.reference_grade(osu)
                api.reference_grade(osu)
        self.assertTrue(first["ok"])
        self.assertEqual(detect.call_count, 1)
        self.assertEqual(first["report"]["lines"][0]["verdict"], "ok")

    def test_grade_waits_for_a_running_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api, osu = self._setup(tmp)
            api._busy.acquire()
            try:
                self.assertEqual(api.reference_grade(osu)["key"], "busy")
            finally:
                api._busy.release()

    def test_load_makes_the_map_the_working_timing_in_one_undo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api, osu = self._setup(tmp)
            reply = api.reference_load(osu)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["loaded"], 2)
        points = reply["result"]["points"]
        self.assertEqual([(p["offset_ms"], p["bpm"], p["meter"]) for p in points],
                         [(1000.0, 150.0, 3), (31000.0, 150.0, 4)])
        self.assertTrue(all(p["confidence"] == 1.0 for p in points))
        self.assertTrue(reply["undo"])
        back = api.undo()
        self.assertEqual([p["offset_ms"] for p in back["result"]["points"]], [1000.0, 9000.0])

    def test_load_keeps_a_locked_point(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api, osu = self._setup(tmp)
            api.set_locked(1, True)                     # 9000 ms, 150 BPM
            reply = api.reference_load(osu)
        self.assertEqual([p["offset_ms"] for p in reply["result"]["points"]],
                         [1000.0, 9000.0, 31000.0])
        self.assertEqual(reply["locks"], [9000.0])

    def test_find_needs_a_songs_folder_and_remembers_the_one_chosen(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api, _osu = self._setup(tmp)
            self.assertEqual(api.reference_find()["key"], "no_songs")
            reply = api.reference_find(tmp)
        json.dumps(reply)
        self.assertTrue(reply["ok"])
        folders = [Path(m["folder"]).name for m in reply["report"]["matches"]]
        self.assertEqual(sorted(folders), ["set", "song"])
        self.assertEqual(self.saved[-1]["songs_folder"], tmp)

    def test_reference_needs_a_result_and_a_real_file(self) -> None:
        for call in ("reference_grade", "reference_load"):
            with self.subTest(call=call):
                self.assertEqual(getattr(web.Api(), call)("C:/x.osu")["key"], "first")
                self.assertEqual(getattr(_api_with_points(), call)("C:/does/not/exist.osu")["key"],
                                 "bad_file")
        self.assertEqual(web.Api().reference_find()["key"], "first")


class HitsoundPlaybackBridgeTests(_IsolatedConfig):
    """The transport's hitsound track: the maps of this song, their samples."""

    def _song(self, tmp: str) -> web.Api:
        folder = Path(tmp)
        (folder / "audio.mp3").write_bytes(b"ID3" + bytes(64))
        lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
                 "[Metadata]", "Version:Hard", "", "[TimingPoints]", "0,500,4,2,0,70,1,0", "",
                 "[HitObjects]", "256,192,1000,1,8,0:0:1:0:", ""]
        (folder / "hard.osu").write_bytes("\r\n".join(lines).encode("utf-8"))
        other = [l.replace("audio.mp3", "other.mp3") for l in lines]
        (folder / "other.osu").write_bytes("\r\n".join(other).encode("utf-8"))
        (folder / "soft-hitclap.wav").write_bytes(b"RIFFclap")
        api = _api_with_points()
        api._analysis.source = str(folder / "audio.mp3")
        return api

    def test_only_this_songs_maps_are_offered_and_their_samples_come_with_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            maps = api.song_maps()
            reply = api.hitsound_playback("hard.osu")
        json.dumps(reply)
        self.assertEqual([m["file"] for m in maps["maps"]], ["hard.osu"])
        self.assertEqual(maps["maps"][0]["difficulty"], "Hard")
        self.assertEqual(reply["events"]["t"], [1.0])
        self.assertEqual(reply["events"]["keys"], [["overtone:soft-hitnormal.wav", "map:soft-hitclap.wav"]])
        self.assertEqual(base64.b64decode(reply["samples"]["map:soft-hitclap.wav"]["data"]), b"RIFFclap")
        self.assertEqual(reply["samples"]["overtone:soft-hitnormal.wav"]["source"], "overtone")
        self.assertEqual((reply["events"]["adds"], reply["objects"]),
                         ([8], {"t": [1.0], "end": [None], "kind": ["circle"]}))

    def test_an_ogg_stream_in_a_wav_header_is_unwrapped_and_nothing_else_is_touched(self) -> None:
        ogg = b"OggS" + bytes(20)
        wrapped = b"RIFF" + (54).to_bytes(4, "little") + b"WAVEfmt " + (18).to_bytes(4, "little") +             (0x674F).to_bytes(2, "little") + bytes(24) + ogg
        pcm = b"RIFF" + bytes(4) + b"WAVEfmt " + bytes(4) + (1).to_bytes(2, "little") + bytes(24) + b"data"
        self.assertEqual(web._playable_sample(wrapped), ogg)
        self.assertEqual(web._playable_sample(pcm), pcm)
        self.assertEqual(web._playable_sample(b"ID3mp3"), b"ID3mp3")

    def test_the_report_places_each_sound_and_refuses_what_is_not_this_songs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            reply = api.hitsound_report("hard.osu")
            refused = api.hitsound_report("..\\hard.osu")
        json.dumps(reply)
        sound = reply["report"]["sounds"][0]
        self.assertEqual((sound["t"], sound["bar"], sound["slot"], sound["sounds"]), (1.0, 1, 8, ["normal", "clap"]))
        self.assertEqual(reply["report"]["additions"]["clap"]["slots"][8], 1)
        self.assertEqual(refused["key"], "bad_file")
        self.assertEqual(web.Api().hitsound_report("hard.osu")["key"], "first")

    def test_a_map_outside_the_songs_folder_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            for name in ("..\\hard.osu", "missing.osu", "audio.mp3", ""):
                with self.subTest(name=name):
                    self.assertEqual(api.hitsound_playback(name)["key"], "bad_file")
        self.assertEqual(web.Api().hitsound_playback("hard.osu")["key"], "first")

    def test_the_hitsound_level_is_remembered_and_optional(self) -> None:
        api = web.Api()
        self.assertEqual(api.set_playback({"song_volume": 0.5, "click_volume": 0.4})["playback"]["hitsound_volume"], 0.7)
        reply = api.set_playback({"song_volume": 0.5, "click_volume": 0.4, "hitsound_volume": 0.9})
        self.assertEqual(reply["playback"]["hitsound_volume"], 0.9)
        self.assertFalse(api.set_playback({"song_volume": 0.5, "click_volume": 0.4,
                                           "hitsound_volume": float("nan")})["ok"])


class HitsoundCopyBridgeTests(_IsolatedConfig):
    """The copier in the Mapset view: a preview that writes nothing, then the copy."""

    SOURCE = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
              "[TimingPoints]", "0,500,4,2,0,70,1,0", "", "[HitObjects]",
              "256,192,1000,1,8,0:0:0:0:", "256,192,2000,1,4,0:0:0:0:", ""]

    def _set(self, tmp: str) -> Path:
        folder = Path(tmp)
        (folder / "hard.osu").write_bytes("\r\n".join(self.SOURCE).encode("utf-8"))
        easy = [line.replace(",8,0:0", ",0,0:0").replace(",4,0:0", ",0,0:0") for line in self.SOURCE]
        (folder / "easy.osu").write_bytes("\r\n".join(easy[:-2] + ["256,192,3000,1,0,0:0:0:0:", ""]).encode("utf-8"))
        return folder

    def test_the_preview_writes_nothing_and_the_copy_writes_with_a_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = self._set(tmp)
            before = (folder / "easy.osu").read_bytes()
            api = web.Api()
            preview = api.hitsound_copy_preview(str(folder), "hard.osu", ["easy.osu"])
            untouched = (folder / "easy.osu").read_bytes()
            done = api.hitsound_copy_apply(str(folder), "hard.osu", ["easy.osu"])
            after = (folder / "easy.osu").read_bytes()
            backup = Path(done["targets"][0]["backup"]).read_bytes()
            again = api.hitsound_copy_preview(str(folder), "hard.osu", ["easy.osu"])
        json.dumps([preview, done])
        row = preview["targets"][0]
        self.assertEqual((row["target_sounds"], row["matched"], row["changed"], row["unmatched"]),
                         (2, 1, 1, 1))
        self.assertEqual(untouched, before)
        self.assertEqual((done["targets"][0]["written"], backup), (True, before))
        self.assertIn(b"256,192,1000,1,8,0:0:0:0:", after)
        self.assertEqual(again["targets"][0]["changed"], 0)

    def test_files_outside_the_folder_or_the_source_as_a_target_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = self._set(tmp)
            api = web.Api()
            for source, targets, key in (("hard.osu", [], "hs_no_targets"),
                                         ("hard.osu", ["hard.osu"], "hs_same_file"),
                                         ("hard.osu", ["..\\easy.osu"], "bad_file"),
                                         ("hard.osu", ["missing.osu"], "bad_file"),
                                         ("hard.osu", ["audio.mp3"], "bad_file")):
                with self.subTest(targets=targets):
                    self.assertEqual(api.hitsound_copy_apply(str(folder), source, targets)["key"], key)
            self.assertEqual(api.hitsound_copy_preview(str(Path(tmp) / "nope"), "a.osu", ["b.osu"])["key"],
                             "bad_folder")


class HitsoundDecideBridgeTests(_IsolatedConfig):
    """The decision editor's bridge: propose once, preview, apply, one undo."""

    LINES = ["osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "",
             "[TimingPoints]", "0,500,4,2,0,70,1,0", "", "[HitObjects]",
             "256,192,1000,1,0,0:0:0:0:", "256,192,1500,1,0,0:0:0:0:", ""]

    UNITS = [{"object": 0, "part": "circle", "edge": None, "time_ms": 1000.0,
              "proposal": {"bank": "soft", "additions": ["finish"], "bits": 4}},
             {"object": 1, "part": "circle", "edge": None, "time_ms": 1500.0,
              "proposal": {"bank": "drum", "additions": ["clap"], "bits": 8}}]

    def _song(self, tmp: str) -> web.Api:
        folder = Path(tmp)
        (folder / "audio.mp3").write_bytes(b"ID3" + bytes(64))
        (folder / "hard.osu").write_bytes("\r\n".join(self.LINES).encode("utf-8"))
        api = _api_with_points()
        api._analysis.source = str(folder / "audio.mp3")
        return api

    def _proposed(self, api: web.Api):
        with mock.patch.object(web.overtone_rust, "hitsound",
                               return_value={"units": self.UNITS}):
            return api.hitsound_decide_propose("hard.osu")

    def test_propose_caches_and_preview_counts_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            before = Path(tmp, "hard.osu").read_bytes()
            reply = self._proposed(api)
            preview = api.hitsound_decide_preview("hard.osu", [[1, "circle", None]])
            untouched = Path(tmp, "hard.osu").read_bytes()
            json.dumps([reply, preview])
            self.assertEqual((len(reply["units"]), preview["units"], preview["accepted"],
                              preview["would_change"]),
                             (2, 2, 1, 1))
            self.assertEqual(untouched, before)
            self.assertEqual(api.hitsound_decide_preview("hard.osu")["accepted"], 2)

    def test_apply_writes_with_a_backup_and_one_undo_restores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            before = Path(tmp, "hard.osu").read_bytes()
            self._proposed(api)
            done = api.hitsound_decide_apply("hard.osu")
            changed = Path(tmp, "hard.osu").read_bytes()
            undone = api.hitsound_decide_undo()
            restored = Path(tmp, "hard.osu").read_bytes()
            nothing_left = api.hitsound_decide_undo()
            json.dumps([done, undone])
            self.assertEqual((done["changed"], done["written"], done["undo"]), ([0, 1], True, True))
            self.assertNotEqual(changed, before)
            self.assertEqual((restored, undone["ok"], nothing_left["key"]),
                             (before, True, "no_undo"))
            self.assertTrue(Path(tmp, "hard.osu.bak").is_file())

    def test_apply_onto_a_copy_leaves_the_source_alone(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            before = Path(tmp, "hard.osu").read_bytes()
            self._proposed(api)
            done = api.hitsound_decide_apply("hard.osu", copy=True)
            dest = Path(tmp, "hard_hitsounded.osu")
            json.dumps(done)
            self.assertEqual((Path(done["dest"]).name, done["undo"]), ("hard_hitsounded.osu", False))
            self.assertEqual(Path(tmp, "hard.osu").read_bytes(), before)
            self.assertIn(b"256,192,1500,1,8,", dest.read_bytes())

    def test_without_a_proposal_or_a_binary_it_says_so(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            self.assertEqual(api.hitsound_decide_preview("hard.osu")["key"], "no_proposal")
            self.assertEqual(api.hitsound_decide_apply("hard.osu")["key"], "no_proposal")
            with mock.patch.object(web.overtone_rust, "hitsound",
                                   side_effect=web.overtone_rust.SidecarUnavailable("gone")):
                self.assertEqual(api.hitsound_decide_propose("hard.osu")["key"], "no_rust")
            self.assertEqual(api.hitsound_decide_propose("..\\hard.osu")["key"], "bad_file")
        self.assertEqual(web.Api().hitsound_decide_propose("hard.osu")["key"], "first")
        self.assertEqual(web.Api().hitsound_decide_undo()["key"], "first")

    def test_a_moved_map_refuses_at_preview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = self._song(tmp)
            api._decisions["hard.osu"] = {"units": [
                {**self.UNITS[0], "time_ms": 1200.0}]}
            reply = api.hitsound_decide_preview("hard.osu")
        self.assertEqual(reply["key"], "error")
        self.assertIn("1200", reply["detail"])


class StructureBridgeTests(_IsolatedConfig):
    """The Structure view: the Rust report once per file, bars every call."""

    def _api(self, tmp: str) -> web.Api:
        song = Path(tmp) / "song.wav"
        song.write_bytes(b"RIFF" + bytes(64))
        api = _api_with_points()
        api._analysis.source = str(song)
        return api

    def test_the_audio_is_read_once_and_the_bars_every_call(self) -> None:
        from test_overtone import _structure_report
        report = _structure_report([16.3, 32.2, 48.1], ["verse", "chorus", "verse", "chorus"],
                                   [0, 1, 0, 1], [-6.0, 0.0, -6.0, 0.0])
        with tempfile.TemporaryDirectory() as tmp:
            api = self._api(tmp)
            api._analysis.points = [ta.TimingPoint(0.0, 120.0, 0.9, 0, 4, True)]    # 2 s bars
            with mock.patch.object(web.overtone_rust, "structure", return_value=report) as run:
                first = api.structure()
                api._analysis.points = [ta.TimingPoint(500.0, 120.0, 0.9, 0, 4, True)]
                second = api.structure()
        json.dumps([first, second])
        self.assertTrue(first["ok"])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(first["file"], "song.wav")
        self.assertEqual(len(first["view"]["sections"]), 4)
        self.assertEqual([s["start_s"] for s in first["view"]["sections"]], [0.0, 16.0, 32.0, 48.0])
        self.assertEqual([s["start_s"] for s in second["view"]["sections"]], [0.0, 16.5, 32.5, 48.5])

    def test_without_a_song_or_an_engine_it_says_which(self) -> None:
        self.assertEqual(web.Api().structure()["key"], "first")
        with tempfile.TemporaryDirectory() as tmp:
            api = self._api(tmp)
            with mock.patch.object(web.overtone_rust, "find_cli", return_value=None):
                self.assertEqual(api.structure()["key"], "no_rust")
            with mock.patch.object(web.overtone_rust, "structure",
                                   side_effect=RuntimeError("Cannot load song.wav: junk")):
                failed = api.structure()
        self.assertEqual((failed["key"], failed["detail"]), ("error", "Cannot load song.wav: junk"))
        gone = _api_with_points()
        gone._analysis.source = "C:/no/such/song.wav"
        self.assertEqual(gone.structure()["key"], "bad_file")

    @unittest.skipIf(web.overtone_rust.find_cli() is None, "overtone-cli is not built")
    def test_the_real_engine_reads_a_two_part_song(self) -> None:
        sr = 22050
        t = np.arange(int(sr * 16.0)) / sr

        def chord(root, amp):
            return amp * (np.sin(2 * np.pi * root * t) + 0.6 * np.sin(2 * np.pi * root * 1.2599 * t)
                          + 0.6 * np.sin(2 * np.pi * root * 1.4983 * t))

        y = np.concatenate([chord(220.0, 0.12), chord(174.61, 0.3)] * 2).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "abab.wav"
            ta.sf.write(path, y, sr)
            report = web.overtone_rust.structure(path)
        kinds = [s["kind"] for s in report["sections"]]
        self.assertEqual(kinds, ["verse", "chorus", "verse", "chorus"])
        self.assertEqual(len(report["energy"]), 128)


class LibraryBridgeTests(_IsolatedConfig):
    """The Songs browser: scan, search, and same-audio from the index."""

    def _songs(self, tmp: str) -> Path:
        songs = Path(tmp) / "Songs"
        folder = songs / "1 Band - Song"
        folder.mkdir(parents=True)
        (folder / "audio.mp3").write_bytes(b"ID3" + bytes(range(256)))
        (folder / "map.osu").write_text("\n".join(ReferenceBridgeTests.MAP[:5] + [
            "[Metadata]", "Title:Song", "Artist:Band", "Version:Hard", ""]
            + ReferenceBridgeTests.MAP[5:]), encoding="utf-8")
        return songs

    def test_state_before_any_scan_says_nothing_is_indexed(self) -> None:
        reply = web.Api().library_state()
        json.dumps(reply)
        self.assertTrue(reply["ok"])
        self.assertEqual((reply["index"]["beatmaps"], reply["current"], reply["scanning"]),
                         (0, False, False))
        self.assertEqual(web.Api().library_scan()["key"], "no_songs")

    def test_scan_then_search_and_the_folder_is_remembered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            songs = self._songs(tmp)
            api = web.Api()
            reply = api.library_scan(str(songs))
            found = api.library_search("band")
            state = api.library_state()
        json.dumps([reply, found, state])
        self.assertTrue(reply["ok"])
        self.assertEqual((reply["report"]["sets"], reply["report"]["beatmaps"]), (1, 1))
        self.assertEqual(self.saved[-1]["songs_folder"], str(songs))
        self.assertEqual([s["name"] for s in found["result"]["sets"]], ["1 Band - Song"])
        self.assertTrue(state["current"])

    def test_one_scan_at_a_time_and_no_reset_during_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            songs = self._songs(tmp)
            api = web.Api()
            api._scanning.acquire()
            try:
                self.assertEqual(api.library_scan(str(songs))["key"], "scan_running")
                self.assertEqual(api.library_reset()["key"], "scan_running")
            finally:
                api._scanning.release()
            api.library_scan(str(songs))
            reset = api.library_reset()
        self.assertEqual(reset["index"]["beatmaps"], 0)

    def test_same_audio_answers_from_the_index_and_walks_when_it_finds_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            songs = self._songs(tmp)
            api = _api_with_points()
            api._analysis.source = str(songs / "1 Band - Song" / "audio.mp3")
            api.library_scan(str(songs))
            indexed = api.reference_find(str(songs))
            late = songs / "2 Late - Add"          # added after the scan
            late.mkdir()
            (late / "audio.mp3").write_bytes(b"ID3" + bytes(range(256)))
            (late / "map.osu").write_text("\n".join(ReferenceBridgeTests.MAP), encoding="utf-8")
            (songs / "1 Band - Song" / "map.osu").unlink()
            walked = api.reference_find(str(songs))
        self.assertTrue(indexed["report"]["indexed"])
        self.assertEqual([Path(m["folder"]).name for m in indexed["report"]["matches"]],
                         ["1 Band - Song"])
        self.assertNotIn("indexed", walked["report"])
        self.assertEqual([Path(m["folder"]).name for m in walked["report"]["matches"]
                          if m["beatmaps"]], ["2 Late - Add"])


class AssistedBridgeTests(_IsolatedConfig):
    """Assisted timing: fit from two marks, then add the line in one undo."""

    @staticmethod
    def _api() -> web.Api:
        api = _api_with_points()          # 1000 ms @ 120, 9000 ms @ 150
        times = np.arange(1.0, 60.0, 0.2)                  # 150 BPM 8ths
        api._analysis.attack_times = times
        api._analysis.attack_weights = np.where(np.arange(times.size) % 2 == 0, 1.0, 0.5)
        return api

    def test_fit_then_add_is_one_undo_step(self) -> None:
        api = self._api()
        reply = api.assisted_fit(9020, 10580, 1, 4)
        json.dumps(reply)
        self.assertTrue(reply["ok"] and reply["fit"]["ok"])
        self.assertAlmostEqual(reply["fit"]["bpm"], 150.0, delta=0.01)
        added = api.assisted_apply()
        self.assertTrue(added["ok"])
        # The grid holds the whole song, so the detected lines inside it go.
        self.assertEqual([(round(p["offset_ms"], 3), round(p["bpm"], 2)) for p in added["result"]["points"]],
                         [(1000.0, 150.0)])
        self.assertEqual(added["selected"], 0)
        self.assertTrue(added["undo"])
        self.assertEqual(api.assisted_apply()["key"], "no_fit")   # used once
        back = api.undo()
        self.assertEqual([p["offset_ms"] for p in back["result"]["points"]], [1000.0, 9000.0])

    def test_a_refusal_is_an_answer_and_leaves_nothing_to_add(self) -> None:
        api = self._api()
        reply = api.assisted_fit(9000, 9050, 1, 4)
        self.assertTrue(reply["ok"])
        self.assertEqual((reply["fit"]["ok"], reply["fit"]["reason"]), (False, "bpm_range"))
        self.assertEqual(api.assisted_apply()["key"], "no_fit")

    def test_a_locked_point_survives_the_new_line(self) -> None:
        api = self._api()
        api.set_locked(1, True)
        api.assisted_fit(9020, 10580, 1, 4)
        reply = api.assisted_apply()
        self.assertEqual([round(p["offset_ms"], 3) for p in reply["result"]["points"]], [1000.0, 9000.0])
        self.assertEqual(reply["locks"], [9000.0])

    def test_assisted_needs_a_result_and_waits_for_an_analysis(self) -> None:
        self.assertEqual(web.Api().assisted_fit(1, 2, 1, 4)["key"], "first")
        self.assertEqual(web.Api().assisted_apply()["key"], "first")
        api = self._api()
        api._busy.acquire()
        try:
            self.assertEqual(api.assisted_fit(9020, 10580, 1, 4)["key"], "busy")
        finally:
            api._busy.release()


class PlaybackBridgeTests(_IsolatedConfig):
    """Playback: the click the page plays, the song's bytes, the levels."""

    def test_the_payload_carries_the_click_the_wav_export_writes(self) -> None:
        analysis = _analysis([ta.TimingPoint(1000.0, 120.0, 0.9, 0),
                              ta.TimingPoint(5000.0, 150.0, 0.9, 8)])
        clicks = web.analysis_payload(analysis)["clicks"]
        want = ta.click_schedule(analysis)
        self.assertEqual(len(clicks["t"]), len(want))
        self.assertEqual(clicks["t"][:3], [1.0, 1.5, 2.0])
        self.assertEqual(clicks["level"][:5], [2, 1, 1, 1, 2])
        self.assertEqual(clicks["t"].count(5.0), 1)

    def test_the_payload_carries_the_attacks_scaled_to_the_strongest(self) -> None:
        analysis = _analysis([ta.TimingPoint(1000.0, 120.0, 0.9, 0)])
        self.assertEqual(web.analysis_payload(analysis)["attacks"], {"t": [], "w": []})
        analysis.attack_times = np.array([1.000004, 1.5, 2.0])
        analysis.attack_weights = np.array([2.0, 1.0, 4.0])
        attacks = web.analysis_payload(analysis)["attacks"]
        json.dumps(attacks)
        self.assertEqual(attacks, {"t": [1.0, 1.5, 2.0], "w": [0.5, 0.25, 1.0]})

    def test_the_song_arrives_in_chunks_byte_for_byte(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.mp3"
            data = bytes(range(256)) * 9000                  # 2.2 MB: three chunks
            song.write_bytes(data)
            api = _api_with_points()
            api._analysis.source = str(song)
            opened = api.audio_open("file")
            self.assertEqual((opened["size"], opened["chunks"], opened["mime"]),
                             (len(data), 3, "audio/mpeg"))
            got = b"".join(__import__("base64").b64decode(api.audio_chunk(i)["data"])
                           for i in range(opened["chunks"]))
            self.assertEqual(got, data)
            self.assertEqual(api.audio_chunk(3)["key"], "no_audio_staged")
            api.audio_close()
            self.assertEqual(api.audio_chunk(0)["key"], "no_audio_staged")

    def test_a_format_the_browser_cannot_read_comes_as_overtones_own_wav(self) -> None:
        from test_overtone import _drum_track
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.wav"
            _drum_track(song, [(0.5, 120.0)], duration=3.0)
            api = _api_with_points()
            api._analysis.source = str(song)
            opened = api.audio_open("wav")
            wav = b"".join(__import__("base64").b64decode(api.audio_chunk(i)["data"])
                           for i in range(opened["chunks"]))
        self.assertEqual((wav[:4], wav[8:12], opened["mime"]), (b"RIFF", b"WAVE", "audio/wav"))
        import io
        y, sr = ta.sf.read(io.BytesIO(wav))
        self.assertEqual(sr, ta.TARGET_SR)
        self.assertAlmostEqual(len(y) / sr, 3.0, delta=0.05)

    def test_levels_are_clamped_remembered_and_offered_back(self) -> None:
        api = web.Api()
        self.assertEqual(api.state()["playback"],
                         {"song_volume": 0.8, "click_volume": 0.6, "hitsound_volume": 0.7,
                          "tap_latency_ms": 0.0})
        reply = api.set_playback({"song_volume": 2, "click_volume": -1})
        self.assertEqual((reply["playback"]["song_volume"], reply["playback"]["click_volume"]),
                         (1.0, 0.0))
        self.assertEqual((self.saved[-1]["song_volume"], self.saved[-1]["click_volume"]), (1.0, 0.0))
        self.assertEqual(api.set_playback({"song_volume": "loud"})["key"], "bad_values")
        self.assertEqual(api.set_playback({"song_volume": float("nan"), "click_volume": 1})["key"],
                         "bad_values")
        self.assertEqual(web.Api().audio_open()["key"], "first")

    def test_tap_latency_is_remembered_and_refused_past_a_quarter_second(self) -> None:
        api = web.Api()
        self.assertEqual(api.set_tap_latency(38.5)["playback"]["tap_latency_ms"], 38.5)
        self.assertEqual(self.saved[-1]["tap_latency_ms"], 38.5)
        for bad in (400, "late", float("inf")):
            with self.subTest(bad=bad):
                self.assertFalse(api.set_tap_latency(bad)["ok"])
        # A hand-edited config past the limit is ignored, not trusted.
        api._cfg["tap_latency_ms"] = 900
        self.assertEqual(api.state()["playback"]["tap_latency_ms"], 0.0)


class SettingsBridgeTests(_IsolatedConfig):
    """Settings: every option checked, remembered, and used by the exports."""

    def test_defaults_come_back_and_a_hand_edited_config_falls_back_per_value(self) -> None:
        api = web.Api()
        reply = api.settings()
        json.dumps(reply)
        self.assertEqual(reply["settings"], {
            "output_folder": "", "export_ask": True, "offset_decimals": 0,
            "click_subdivision": 1, "click_accent": True, "ui_scale": 1.0,
            "reduced_motion": False, "theme": "dark"})
        self.assertTrue(reply["output_default"].endswith(str(Path("Documents") / "Overtone")))
        api._cfg.update({"offset_decimals": 9, "click_subdivision": 5, "ui_scale": "huge",
                         "export_ask": "no", "output_folder": 7})
        s = api.settings()["settings"]
        self.assertEqual((s["offset_decimals"], s["click_subdivision"], s["ui_scale"],
                          s["export_ask"], s["output_folder"]), (0, 1, 1.0, True, ""))

    def test_the_theme_is_dark_unless_asked_and_only_a_known_one_is_kept(self) -> None:
        api = web.Api()
        self.assertEqual(api.settings()["settings"]["theme"], "dark")
        for bad in ("blue", "", None, 1):
            with self.subTest(bad=bad):
                self.assertFalse(api.set_settings({"theme": bad})["ok"])
        for theme in ("light", "system", "dark"):
            self.assertEqual(api.set_settings({"theme": theme})["settings"]["theme"], theme)
        self.assertEqual(self.saved[-1]["theme"], "dark")
        api._cfg["theme"] = "neon"                      # a hand-edited config
        self.assertEqual(api.settings()["settings"]["theme"], "dark")

    def test_each_value_is_checked_before_any_is_kept(self) -> None:
        api = web.Api()
        for bad in ({"offset_decimals": 4}, {"click_subdivision": 5}, {"ui_scale": 3},
                    {"export_ask": "yes"}, {"output_folder": "C:/does/not/exist"},
                    {"nonsense": 1}, {"offset_decimals": 2, "ui_scale": float("nan")}):
            with self.subTest(bad=bad):
                self.assertFalse(api.set_settings(bad)["ok"])
        self.assertEqual(self.saved, [])
        with tempfile.TemporaryDirectory() as tmp:
            reply = api.set_settings({"offset_decimals": 2, "output_folder": tmp,
                                      "reduced_motion": True})
        self.assertEqual((reply["settings"]["offset_decimals"], reply["settings"]["output_folder"],
                          reply["settings"]["reduced_motion"]), (2, tmp, True))
        self.assertEqual(self.saved[-1]["offset_decimals"], 2)

    def test_click_settings_rebuild_the_payloads_clicks(self) -> None:
        api = _api_with_points()
        reply = api.set_settings({"click_subdivision": 2, "click_accent": False})
        clicks = reply["result"]["clicks"]
        self.assertEqual(clicks["t"][:3], [1.0, 1.25, 1.5])
        self.assertEqual(clicks["level"][:3], [1, 0, 1])
        self.assertNotIn("result", api.set_settings({"reduced_motion": True}))

    def test_exports_land_in_the_songs_output_folder_without_asking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = _api_with_points()
            api._analysis.source = str(Path(tmp) / "2438 Band - Song" / "audio.mp3")
            api.set_settings({"output_folder": tmp, "export_ask": False, "offset_decimals": 1})
            first, second = api.save_csv(), api.save_csv()
            folder = Path(tmp) / "Band - Song"
            self.assertEqual(Path(first["path"]), folder / "overtone-timing.csv")
            self.assertEqual(Path(second["path"]), folder / "overtone-timing (2).csv")
            self.assertTrue(Path(second["path"]).is_file())
        # Decimals reach the .osu text.
        first_red = next(line for line in api.osu_text()["text"].splitlines()
                         if line and not line.startswith("//"))
        self.assertEqual(first_red.split(",")[0], "1000.0")

    def test_asked_exports_open_the_dialog_in_the_output_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = _api_with_points()
            api.set_settings({"output_folder": tmp})
            window = mock.Mock()
            window.create_file_dialog.return_value = None
            api._window = window
            self.assertEqual(api.save_csv()["key"], "cancelled")
            self.assertEqual(window.create_file_dialog.call_args.kwargs["directory"], tmp)

    def test_the_cache_reports_its_size_and_clears(self) -> None:
        api = web.Api()
        entry = api._cache_dir() / "abc.pickle"
        entry.write_bytes(b"x" * 1234)
        info = api.settings()["cache"]
        self.assertEqual((info["entries"], info["bytes"]), (1, 1234))
        self.assertEqual(api.cache_clear()["cache"]["entries"], 0)
        self.assertFalse(entry.exists())


class ModReportBridgeTests(_IsolatedConfig):
    """The mod report: gathered lines for one difficulty, editor links."""

    def test_report_names_the_difficulty_and_is_plain_json(self) -> None:
        api = AssistedBridgeTests._api()
        lines = ["osu file format v14", "", "[Metadata]", "Version:Insane", "",
                 "[TimingPoints]", "1000,400,4,1,0,100,1,0", "", "[HitObjects]",
                 "64,192,1205,5,0,0:0:0:0:"]
        with tempfile.TemporaryDirectory() as tmp:
            osu = Path(tmp) / "map.osu"
            osu.write_text("\n".join(lines) + "\n", encoding="utf-8")
            reply = api.mod_report(str(osu))
        json.dumps(reply)
        self.assertTrue(reply["ok"])
        self.assertEqual((reply["file"], reply["difficulty"]), ("map.osu", "Insane"))
        self.assertIn("00:01:205 (1) - unsnapped", reply["report"]["text"])
        self.assertFalse(api._busy.locked())

    def test_only_a_timestamp_reaches_the_shell(self) -> None:
        opened = []
        with mock.patch.object(web, "_open_link", side_effect=opened.append):
            self.assertTrue(web.Api().open_in_editor("01:02:345 (1,2)")["ok"])
            self.assertEqual(web.Api().open_in_editor("01:02:345 & del *")["key"], "bad_stamp")
        self.assertEqual(opened, ["osu://edit/01:02:345%20(1,2)"])
        with mock.patch.object(web, "_open_link", side_effect=OSError("no handler")):
            self.assertEqual(web.Api().open_in_editor("00:00:001")["key"], "no_osu")

    def test_report_needs_a_result_a_file_and_no_running_analysis(self) -> None:
        self.assertEqual(web.Api().mod_report("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().mod_report("C:/does/not/exist.osu")["key"], "bad_file")


class EngineChoiceTests(_IsolatedConfig):
    """The Rust engine is opt-in, falls back to v3, and says when it did."""

    PARAMS = {"min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
              "prefer_map_bpm": True, "refine_beats": True, "force_subdivision": 0.0}

    @staticmethod
    def _clicks(folder: str) -> str:
        sr = 44_100
        y = np.zeros(20 * sr, dtype=np.float32)
        burst = np.exp(-np.arange(1300) / 180.0) * (np.random.default_rng(3).random(1300) - 0.5)
        for k, t in enumerate(np.arange(0.5, 19.5, 0.4)):
            start = int(t * sr)
            y[start:start + 1300] += (0.9 if k % 4 == 0 else 0.5) * burst
        path = Path(folder) / "clicks.wav"
        ta.sf.write(str(path), y, sr, subtype="PCM_16")
        return str(path)

    def test_the_choice_travels_through_params_and_config(self) -> None:
        api = web.Api()
        options = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                   "prefer_map_bpm": True, "refine_beats": True, "engine": "rust"}
        self.assertEqual(api._params(options)["engine"], "rust")
        self.assertEqual(api._params({**options, "engine": "bogus"})["engine"], "python")
        api._remember("C:/song.wav", options)
        self.assertEqual(self.saved[-1]["engine"], "rust")
        self.assertIn("rust_available", api.state())

    def test_python_is_the_default_and_carries_no_note(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = web.run_analysis(self._clicks(tmp), dict(self.PARAMS))
        self.assertEqual((result.backend, result.backend_note), ("python", ""))
        payload = web.analysis_payload(result)
        self.assertEqual(payload["backend"], "python")
        self.assertNotIn("warn_rust_fallback", [w["key"] for w in payload["warnings"]])

    def test_a_missing_binary_falls_back_and_says_so(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(web.overtone_rust, "find_cli", return_value=None):
            result = web.run_analysis(self._clicks(tmp), {**self.PARAMS, "engine": "rust"})
        self.assertEqual(result.backend, "python")
        self.assertIn("not built", result.backend_note)
        keys = [w["key"] for w in web.analysis_payload(result)["warnings"]]
        self.assertIn("warn_rust_fallback", keys)

    def test_a_forced_pulse_goes_to_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = web.run_analysis(self._clicks(tmp), {**self.PARAMS, "engine": "rust",
                                                         "force_subdivision": 2.0})
        self.assertEqual(result.backend, "python")
        self.assertIn("own pulse", result.backend_note)

    def test_the_rust_engine_answers_when_built(self) -> None:
        if web.overtone_rust.find_cli() is None:
            self.skipTest("overtone-cli is not built (cargo build --release -p overtone-cli)")
        with tempfile.TemporaryDirectory() as tmp:
            path = self._clicks(tmp)
            rust = web.run_analysis(path, {**self.PARAMS, "engine": "rust"})
            python = web.run_analysis(path, dict(self.PARAMS))
        self.assertEqual(rust.backend, "rust")
        self.assertAlmostEqual(rust.global_bpm, python.global_bpm, places=6)
        self.assertEqual(web.analysis_payload(rust)["backend"], "rust")
        # What gets written: the whole-millisecond offsets of the .osu lines.
        rows = lambda a: [line.split(",")[0] for line in ta.osu_timing_text(a).splitlines()[1:]]
        self.assertEqual(rows(rust), rows(python))


class SuggestBridgeTests(_IsolatedConfig):
    def _map(self, tmp: str, reds) -> str:
        lines = ["osu file format v14", "", "[TimingPoints]"]
        lines += [f"{offset},{60000.0 / bpm:.12f},4,1,0,100,1,0" for offset, bpm in reds]
        beatmap = Path(tmp) / "map.osu"
        beatmap.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(beatmap)

    def test_suggest_proposes_what_the_map_lacks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = _api_with_points()  # (1000, 120) and (9000, 150)
            reply = api.suggest(self._map(tmp, [(1000.0, 120.0)]))
        self.assertTrue(reply["ok"])
        self.assertEqual(len(reply["suggestions"]), 1)
        self.assertEqual(reply["suggestions"][0]["index"], 1)
        self.assertAlmostEqual(reply["suggestions"][0]["offset_ms"], 9000.0)
        json.dumps(reply["suggestions"])

    def test_complete_map_suggests_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            api = _api_with_points()
            reply = api.suggest(self._map(tmp, [(1000.0, 120.0), (9000.0, 150.0)]))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["suggestions"], [])

    def test_suggest_needs_a_result_and_a_real_file(self) -> None:
        self.assertEqual(web.Api().suggest("C:/x.osu")["key"], "first")
        self.assertEqual(_api_with_points().suggest("C:/does/not/exist.osu")["key"], "bad_file")


class EvidenceBridgeTests(_IsolatedConfig):
    """The Evidence tab: alternatives, margins and residuals, cached."""

    def test_without_attacks_it_says_so_and_caches_per_analysis(self) -> None:
        api = _api_with_points()
        first = api.evidence()
        second = api.evidence()
        json.dumps([first, second])
        self.assertTrue(first["ok"])
        self.assertEqual(first["evidence"]["note"], "no_attacks")
        self.assertIs(api._evidence[0], api._analysis)
        self.assertEqual(first["evidence"], second["evidence"])
        self.assertEqual(web.Api().evidence()["key"], "first")


class HistoryBridgeTests(_IsolatedConfig):
    """The History section: every write listed, diffed, restorable."""

    MAP = ["osu file format v14", "", "[TimingPoints]", "1000,500,4,2,0,70,1,0", "",
           "[HitObjects]", "256,192,1000,1,0,0:0:0:0:", ""]

    def _map(self, tmp: str) -> Path:
        path = Path(tmp) / "map.osu"
        path.write_bytes("\r\n".join(self.MAP).encode("utf-8"))
        return path

    def test_empty_history_lists_nothing(self) -> None:
        reply = web.Api().history()
        json.dumps(reply)
        self.assertEqual(reply["entries"], [])

    def test_a_write_is_listed_diffed_and_restored(self) -> None:
        import overtone as ta
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            before = path.read_bytes()
            written = ta.write_object_hitsounds(path, {0: {"bits": 8}})
            moved = before.replace(b"1000,500,", b"1000,400,")
            path.write_bytes(moved)
            api = web.Api()
            listing = api.history()
            diff = api.history_diff(0)
            restored = api.history_restore(0)
            back = path.read_bytes()
            json.dumps([listing, diff, restored])
            entry = listing["entries"][0]
            self.assertEqual((entry["op"], entry["file"], written["backup"] is not None), ("hitsounds", "map.osu", True))
            self.assertEqual(entry["backup"], Path(written["backup"]).name)
            self.assertEqual((diff["diff"]["n_changed"], diff["diff"]["changed"][0]["new_bpm"]), (1, 150.0))
            self.assertEqual((restored["ok"], back), (True, before))
            self.assertTrue(Path(tmp, "map.osu.bak2").is_file())

    def test_a_swap_diff_reads_past_the_move(self) -> None:
        import overtone as ta
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.osu"
            path.write_bytes("\r\n".join(
                ["osu file format v14", "", "[TimingPoints]", "1000,500,4,2,0,70,1,0", "",
                 "[HitObjects]", "256,192,1000,1,0,0:0:0:0:", ""]).encode("utf-8"))
            ta.apply_audio_swap([path], 26.0)
            api = web.Api()
            diff = api.history_diff(0)["diff"]
        json.dumps(diff)
        self.assertEqual((diff["n_added"], diff["n_removed"], diff["n_changed"]), (0, 0, 0))

    def test_bad_indices_and_missing_backups_refuse(self) -> None:
        import overtone as ta
        with tempfile.TemporaryDirectory() as tmp:
            api = web.Api()
            self.assertEqual(api.history_diff(0)["key"], "bad_index")
            self.assertEqual(api.history_restore("x")["key"], "bad_index")
            ta.log_write(str(Path(tmp) / "ghost.osu"), "write", None, {})
            ghost = api.history_diff(0)
            self.assertEqual(ghost["key"], "bad_file")
            ta.log_write(str(Path(tmp) / "map.osu"), "write", None, {})
            self._map(tmp)
            missing = api.history_diff(0)
            self.assertEqual(missing["key"], "no_backup")
            self.assertEqual(api.history_restore(0)["key"], "no_backup")


class RampsBridgeTests(_IsolatedConfig):
    """Ramps in Timing: fit through the sidecar, Use loads hand-placed points."""

    REPORT = {"lines": [{"offset_s": 0.5, "offset_ms": 500.0, "bpm": 150.0,
                         "start_k": 0.0, "end_k": 10.0, "max_drift_ms": 1.0, "attacks": 11},
                        {"offset_s": 5.0, "offset_ms": 5000.0, "bpm": 160.0,
                         "start_k": 10.0, "end_k": 20.0, "max_drift_ms": 2.0, "attacks": 11}],
              "drift_ms": 5.0,
              "tradeoff": [{"drift_ms": 1.0, "lines": 4}, {"drift_ms": 5.0, "lines": 2}],
              "recommend_ramps": True}

    def test_fit_caches_and_use_loads_hand_placed_points(self) -> None:
        with mock.patch.object(web.overtone_rust, "ramps", return_value=self.REPORT) as run:
            api = _api_with_points()
            first = api.ramps(5.0, None)
            second = api.ramps(5.0, None)
            self.assertEqual(run.call_count, 1)
            used = api.ramps_use()
        json.dumps([first, second, used])
        self.assertTrue(first["ok"])
        self.assertEqual(len(first["report"]["lines"]), 2)
        self.assertEqual(first["report"], second["report"])
        self.assertEqual([p.bpm for p in api._analysis.points], [150.0, 160.0])
        self.assertTrue(all(p.manual for p in api._analysis.points))
        self.assertEqual(used["loaded"], 2)
        self.assertTrue(api.history_state()["undo"])

    def test_bad_numbers_missing_fit_and_sidecar_refuse(self) -> None:
        api = _api_with_points()
        self.assertEqual(api.ramps(0)["key"], "bad_values")
        self.assertEqual(api.ramps("x")["key"], "bad_values")
        self.assertEqual(api.ramps(5.0, 0)["key"], "bad_values")
        self.assertEqual(api.ramps_use()["key"], "no_ramps")
        with mock.patch.object(web.overtone_rust, "ramps",
                               side_effect=web.overtone_rust.SidecarUnavailable("gone")):
            self.assertEqual(api.ramps()["key"], "no_rust")
        with mock.patch.object(web.overtone_rust, "ramps",
                               side_effect=web.overtone_rust.SidecarRefused("thin", [])):
            self.assertEqual(api.ramps()["key"], "no_grid")
        self.assertEqual(web.Api().ramps()["key"], "first")
        self.assertEqual(web.Api().ramps_use()["key"], "first")


class FolderImportTests(_IsolatedConfig):
    def _song(self, tmp: str) -> Path:
        root = Path(tmp) / "123 Artist - Title"
        root.mkdir()
        (root / "song.mp3").write_bytes(b"ID3.....")
        (root / "map [Easy].osu").write_text(
            "[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n1000,400,4,1,0,100,1,0\n",
            encoding="utf-8")
        return root

    def test_import_adopts_the_audio_and_lists_difficulties(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._song(tmp)
            api = web.Api()
            reply = api.import_folder(str(root))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["file"]["name"], "song.mp3")
        self.assertEqual(len(reply["beatmaps"]), 1)
        self.assertEqual(reply["folder"], str(root))
        self.assertEqual(self.saved[-1]["file"], str(root / "song.mp3"))
        json.dumps(reply)

    def test_maps_without_audio_still_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "song"
            root.mkdir()
            (root / "map.osu").write_text("[TimingPoints]\n1000,400,4,1,0,100,1,0\n",
                                          encoding="utf-8")
            reply = web.Api().import_folder(str(root))
        self.assertTrue(reply["ok"])
        self.assertIsNone(reply["file"])
        self.assertEqual(len(reply["beatmaps"]), 1)

    def test_import_refuses_a_non_folder(self) -> None:
        self.assertEqual(web.Api().import_folder("C:/does/not/exist")["key"], "bad_folder")

    def test_pick_folder_returns_the_chosen_directory(self) -> None:
        api = web.Api()
        api._window = _FakeWindow("C:/osu!/Songs/123")
        self.assertEqual(api.pick_folder(), "C:/osu!/Songs/123")
        api._window = _FakeWindow(None)
        self.assertIsNone(api.pick_folder())


class MapsetBridgeTests(_IsolatedConfig):
    def _set(self, tmp: str) -> Path:
        root = Path(tmp) / "123 Artist - Title"
        root.mkdir()
        for version, audio in (("Easy", "song.mp3"), ("Hard", "song.mp3"), ("Insane", "other.mp3")):
            (root / f"map [{version}].osu").write_text(
                f"[General]\nAudioFilename: {audio}\n\n[Metadata]\nVersion:{version}\n\n"
                "[TimingPoints]\n1000,400,4,1,0,100,1,0\n", encoding="utf-8")
        (root / "map [Broken].osu").write_bytes(b"\xff\xfe\x00")
        return root

    def test_mapset_check_reports_every_difficulty_without_an_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reply = web.Api().mapset_check(str(self._set(tmp)))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["folder"], "123 Artist - Title")
        report = reply["report"]
        self.assertEqual(len(report["difficulties"]), 4)
        self.assertEqual(report["unreadable"], 1)
        audio = next(f for f in report["fields"] if f["field"] == "AudioFilename")
        self.assertEqual([d["difficulty"] for d in audio["differences"]], ["Insane"])
        json.dumps(reply)

    def test_mapset_check_is_read_only_and_remembers_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._set(tmp)
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            api = web.Api()
            api.mapset_check(str(root))
            after = {p.name: p.read_bytes() for p in root.iterdir()}
        self.assertEqual(before, after)
        self.assertEqual(self.saved, [])
        self.assertNotIn("file", api._cfg)

    def test_mapset_check_refuses_a_non_folder(self) -> None:
        self.assertEqual(web.Api().mapset_check("C:/does/not/exist")["key"], "bad_folder")
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\n", encoding="utf-8")
            self.assertEqual(web.Api().mapset_check(str(target))["key"], "bad_folder")


class SwapBridgeTests(_IsolatedConfig):
    """Audio swap in the Mapset view: measure, preview, write with backups."""

    @staticmethod
    def _clicks(seconds=6.0, bpm=150.0, seed=7):
        import math
        rng = np.random.default_rng(seed)
        y = np.zeros(int(seconds * 44100), dtype=np.float64)
        k = 0
        while True:
            t = 0.5 + k * 60.0 / bpm
            if t > seconds - 0.2:
                break
            n = int(0.03 * 44100)
            burst = np.exp(-np.arange(n) / (0.004 * 44100)) * (rng.random(n) - 0.5)
            y[int(t * 44100):int(t * 44100) + n] += (0.9 if k % 4 == 0 else 0.5) * burst
            k += 1
        return (y / max(1e-9, np.abs(y).max()) * 30000).astype(np.int16)

    def _set(self, tmp: str):
        import soundfile as sf
        root = Path(tmp) / "set"
        root.mkdir()
        y = self._clicks()
        sf.write(str(root / "old.wav"), y, 44100)
        shift = int(round(26.0 / 1000 * 44100))
        delayed = np.zeros_like(y)
        delayed[shift:] = y[:len(y) - shift]
        sf.write(str(root / "new.wav"), delayed, 44100)
        fast = self._clicks(bpm=165.0)
        sf.write(str(root / "fast.wav"), fast, 44100)
        (root / "map.osu").write_bytes("\r\n".join(
            ["osu file format v14", "", "[General]", "AudioFilename: old.wav", "",
             "[TimingPoints]", "500,400,4,2,0,70,1,0", "", "[HitObjects]",
             "256,192,500,1,0,0:0:0:0:", "256,192,900,1,0,0:0:0:0:", ""]).encode("utf-8"))
        return root

    def test_audios_listed_preview_measures_apply_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._set(tmp)
            api = web.Api()
            listed = api.swap_audios(str(root))
            self.assertEqual((listed["audios"], listed["current"]),
                             (["fast.wav", "new.wav", "old.wav"], "old.wav"))
            preview = api.swap_preview(str(root), "old.wav", "new.wav")
            before = (root / "map.osu").read_bytes()
            done = api.swap_apply(str(root), "old.wav", "new.wav")
            after = (root / "map.osu").read_bytes()
            json.dumps([listed, preview, done])
            self.assertAlmostEqual(preview["shift"]["shift_ms"], 26.0, delta=0.5)
            self.assertTrue(all(row["ok"] for row in preview["maps"]))
            self.assertIn(b"AudioFilename: new.wav", after)
            self.assertIn(b"256,192,526,1,0,0:0:0:0:", after)
            self.assertNotEqual(before, after)
            self.assertTrue((root / "map.osu.bak").is_file())

    def test_tempo_twins_and_same_file_refuse_writing_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._set(tmp)
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            api = web.Api()
            refused = api.swap_preview(str(root), "old.wav", "fast.wav")
            self.assertEqual(refused["key"], "error")
            self.assertIn("Tempo", refused["detail"])
            self.assertEqual(api.swap_preview(str(root), "old.wav", "old.wav")["key"], "sw_same_file")
            self.assertEqual(api.swap_preview(str(root), "old.wav", "missing.wav")["key"], "bad_file")
            self.assertEqual(api.swap_audios(str(root / "nope"))["key"], "bad_folder")
            self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, before)


class RecentTests(_IsolatedConfig):
    OPTIONS = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
               "prefer_map_bpm": True, "refine_beats": True}

    def test_remember_orders_dedupes_and_caps(self) -> None:
        api = web.Api()
        for n in range(10):
            api._remember(f"C:/songs/{n}.mp3", self.OPTIONS)
        self.assertEqual(api._cfg["recent"][:2], ["C:/songs/9.mp3", "C:/songs/8.mp3"])
        self.assertEqual(len(api._cfg["recent"]), 8)
        api._remember("C:/songs/5.mp3", self.OPTIONS)
        self.assertEqual(api._cfg["recent"][:2], ["C:/songs/5.mp3", "C:/songs/9.mp3"])
        json.dumps(api._cfg["recent"])

    def test_state_lists_only_files_that_still_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            alive = str(Path(tmp) / "a.wav")
            Path(alive).write_bytes(b"RIFF")
            api = web.Api()
            api._cfg["recent"] = [alive, "C:/gone/b.wav", alive]
            recent = api.state()["recent"]
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["name"], "a.wav")
        json.dumps(recent)


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


class LockTests(_IsolatedConfig):
    def test_lock_unlock_roundtrip(self) -> None:
        api = _api_with_points()
        reply = api.set_locked(0, True)
        self.assertTrue(reply["ok"])
        self.assertTrue(reply["locked"])
        self.assertEqual(reply["locks"], [1000.0])
        self.assertEqual(api.locks(), {"locks": [1000.0]})
        released = api.set_locked(0, False)
        self.assertFalse(released["locked"])
        self.assertEqual(api.locks(), {"locks": []})
        json.dumps(reply)

    def test_locked_points_refuse_the_editor(self) -> None:
        api = _api_with_points()
        api.set_locked(0, True)
        before = list(api._analysis.points)
        self.assertEqual(api.edit_apply(0, 1100.0, 130.0)["key"], "locked")
        self.assertEqual(api.edit_delete(0)["key"], "locked")
        self.assertEqual(api.edit_nudge(0, 5.0)["key"], "locked")
        self.assertEqual(api.edit_rescale(0, 2.0)["key"], "locked")
        self.assertEqual(api._analysis.points, before)
        # Neighbours stay editable, and release re-opens the point.
        self.assertTrue(api.edit_nudge(1, 5.0)["ok"])
        api.set_locked(0, False)
        self.assertTrue(api.edit_nudge(0, 5.0)["ok"])

    def test_lock_needs_a_result_and_a_valid_index(self) -> None:
        self.assertEqual(web.Api().set_locked(0, True)["key"], "first")
        self.assertFalse(_api_with_points().set_locked(7, True)["ok"])

    def test_undo_of_a_locked_add_prunes_the_lock(self) -> None:
        api = _api_with_points()
        api.edit_add(5000.0, 140.0)
        api.set_locked(1, True)
        self.assertEqual(len(api.locks()["locks"]), 1)
        api.undo()
        self.assertEqual(api.locks(), {"locks": []})
        api.redo()
        self.assertEqual(api.locks(), {"locks": []})  # pruned, not resurrected

    def test_fresh_analysis_remerges_locks_and_rescale_scales_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "drums.wav"
            _drum_track(wav, [(0.5, 128.0)], duration=16.0)
            api = _api_with_points()
            api.edit_add(12345.6, 140.0)
            api.set_locked(2, True)
            done = threading.Event()
            api._emit = lambda handler, payload: done.set() if handler == "onResult" else None
            options = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
                       "prefer_map_bpm": True, "refine_beats": True}
            self.assertTrue(api.analyze(str(wav), options)["ok"])
            self.assertTrue(done.wait(120), "analysis did not finish")
            merged = [p for p in api._analysis.points if abs(p.offset_ms - 12345.6) < 0.01]
            self.assertEqual(len(merged), 1)
            self.assertEqual(merged[0].confidence, 1.0)
            self.assertEqual(merged[0].bpm, 140.0)
            self.assertIn(12345.6, api.locks()["locks"])
            # No lock duplicates a line the fresh map already found.
            offsets = sorted(p.offset_ms for p in api._analysis.points)
            self.assertTrue(all(b - a >= 1.0 for a, b in zip(offsets, offsets[1:])))
            # A global pulse change carries the locks with their sections.
            first_bpm = api._analysis.points[0].bpm
            api.set_locked(0, True)
            self.assertTrue(api.rescale(2)["ok"])
            by_offset = {lock["offset_ms"]: lock["bpm"] for lock in api._locked}
            self.assertAlmostEqual(by_offset[api._analysis.points[0].offset_ms],
                                   2 * first_bpm, places=6)


class CacheTests(_IsolatedConfig):
    OPTIONS = {"delta": 1.5, "persistence": 12, "confidence": 75, "pulse": "auto",
               "prefer_map_bpm": True, "refine_beats": True}

    def _local_app(self, tmp: str) -> web.Api:
        import os
        self._env = mock.patch.dict(os.environ, {"LOCALAPPDATA": tmp})
        self._env.start()
        self.addCleanup(self._env.stop)
        return web.Api()

    def test_key_tracks_content_options_and_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            one = Path(tmp) / "a.wav"
            one.write_bytes(b"RIFF....")
            api = web.Api()
            params = web.Api._params(self.OPTIONS)
            key = api._cache_key(str(one), params)
            self.assertEqual(key, api._cache_key(str(one), params))
            altered = dict(self.OPTIONS, confidence=80)
            self.assertNotEqual(key, api._cache_key(str(one), web.Api._params(altered)))
            one.write_bytes(b"RIFF....!")
            self.assertNotEqual(key, api._cache_key(str(one), params))
            self.assertIsNone(api._cache_key(str(Path(tmp) / "gone.wav"), params))

    def test_save_load_round_trip_and_corrupt_cache_is_a_miss(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            one = Path(tmp) / "a.wav"
            one.write_bytes(b"RIFF....")
            api = self._local_app(tmp)
            params = web.Api._params(self.OPTIONS)
            original = _analysis([ta.TimingPoint(500, 150, 1, 0)])
            api._cache_save(str(one), params, original)
            loaded = api._cache_load(str(one), params)
            self.assertEqual(loaded.points, original.points)
            self.assertEqual(loaded.global_bpm, original.global_bpm)
            key = api._cache_key(str(one), params)
            (api._cache_dir() / (key + ".pickle")).write_bytes(b"not a pickle")
            self.assertIsNone(api._cache_load(str(one), params))

    def test_prune_keeps_newest_within_both_caps(self) -> None:
        import os
        import time
        with tempfile.TemporaryDirectory() as tmp:
            api = self._local_app(tmp)
            cache = api._cache_dir()
            for n in range(5):
                entry = cache / f"e{n}.pickle"
                entry.write_bytes(b"x" * 100)
                os.utime(entry, (1000 + n, 1000 + n))
            with mock.patch.object(web.Api, "CACHE_ENTRIES", 3):
                api._prune_cache()
            self.assertEqual(sorted(p.name for p in cache.glob("*.pickle")),
                             ["e2.pickle", "e3.pickle", "e4.pickle"])
            with mock.patch.object(web.Api, "CACHE_BYTES", 250):
                api._prune_cache()
            self.assertEqual(sorted(p.name for p in cache.glob("*.pickle")),
                             ["e3.pickle", "e4.pickle"])

    def test_second_analysis_of_the_same_file_skips_the_engine(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "a.wav"
            wav.write_bytes(b"RIFF....")
            api = self._local_app(tmp)
            fixed = _analysis([ta.TimingPoint(500, 150, 1, 0)])
            events: list[tuple[str, object]] = []
            done = threading.Event()

            def emit(handler, payload):
                events.append((handler, payload))
                if handler in ("onResult", "onError"):
                    done.set()

            api._emit = emit
            with mock.patch.object(web, "run_analysis", return_value=fixed) as run:
                self.assertTrue(api.analyze(str(wav), self.OPTIONS)["ok"])
                self.assertTrue(done.wait(30))
                done.clear()
                events.clear()
                self.assertTrue(api.analyze(str(wav), self.OPTIONS)["ok"])
                self.assertTrue(done.wait(30))
                self.assertEqual(run.call_count, 1)
            kinds = [k for k, _ in events]
            self.assertEqual(kinds, ["onResult"])
            self.assertEqual(events[0][1]["points"], web.analysis_payload(fixed)["points"])

    def test_active_locks_bypass_the_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "a.wav"
            wav.write_bytes(b"RIFF....")
            api = self._local_app(tmp)
            api._locked = [{"offset_ms": 500.0, "bpm": 150.0, "meter": 4, "meter_known": False}]
            fixed = _analysis([ta.TimingPoint(500, 150, 1, 0)])
            done = threading.Event()
            api._emit = lambda handler, payload: done.set() if handler == "onResult" else None
            with mock.patch.object(web, "run_analysis", return_value=fixed) as run:
                self.assertTrue(api.analyze(str(wav), self.OPTIONS)["ok"])
                self.assertTrue(done.wait(30))
                self.assertEqual(run.call_count, 1)

    def test_byte_twins_share_the_entry_but_keep_their_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.wav"
            b = Path(tmp) / "b.wav"
            a.write_bytes(b"RIFF....")
            b.write_bytes(b"RIFF....")
            api = self._local_app(tmp)
            fixed = _analysis([ta.TimingPoint(500, 150, 1, 0)])
            payloads: list[dict] = []
            done = threading.Event()

            def emit(handler, payload):
                if handler == "onResult":
                    payloads.append(payload)
                    done.set()

            api._emit = emit
            with mock.patch.object(web, "run_analysis", return_value=fixed) as run:
                self.assertTrue(api.analyze(str(a), self.OPTIONS)["ok"])
                self.assertTrue(done.wait(30))
                done.clear()
                self.assertTrue(api.analyze(str(b), self.OPTIONS)["ok"])
                self.assertTrue(done.wait(30))
                self.assertEqual(run.call_count, 1)
            self.assertEqual([p["path"] for p in payloads], [fixed.source, str(b)])


if __name__ == "__main__":
    unittest.main()
