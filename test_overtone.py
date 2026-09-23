"""Tests for Overtone (v3 engine).

Fast unit tests run without audio; end-to-end tests synthesize click and drum
tracks with known ground truth, so no fixture files are needed. The v2
segmentation and gap-filling helpers are still covered — they remain in the
fallback path used for rubato and non-percussive audio.
"""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from overtone import (
    DEFAULT_LANGUAGE,
    Analysis,
    GridSection,
    TimingAnalyzerApp,
    TimingPoint,
    _choose_subdivision,
    _fill_missed_beats,
    _atomic_grid_candidates,
    _expand_fit,
    _global_tempo_guides,
    _is_red_line,
    _recentre_phase,
    _refine_grid,
    _retime_onsets,
    _robust_local_bpms,
    _segment_tempi,
    _tune_boundary,
    add_timing_point,
    analysis_summary,
    analyze_audio,
    delete_timing_point,
    export_click_track,
    inject_osu_timing_points,
    nudge_timing_point,
    osu_timing_text,
    rebuild_with_subdivision,
    rescale_section,
    export_osz,
    osu_beatmap_text,
    section_measures,
    detect_bar,
    meter_segments,
    points_from_meter,
    _points_from_sections,
    snap_timing_points,
    suggest_section_pulse,
    update_timing_point,
    validate_timing_points,
    read_osu_red_lines,
    compare_map_timing,
    scan_beatmap_folder,
    analyze_batch,
    read_osu_beatmap,
    set_beatmap_reds,
    write_osu_beatmap,
    attack_object_context,
    alignment_report,
    analysis_report,
    density_report,
    suggest_missing_lines,
    main,
)


def _click_track(path: Path, bpm: float, duration: float = 12.0,
                 change_at: float | None = None, second_bpm: float = 140.0,
                 sr: int = 44100) -> None:
    import soundfile as sf
    y = np.zeros(int(sr * duration), dtype=np.float32)
    n = int(0.04 * sr)
    t = np.arange(n) / sr
    kick = (np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.006)).astype(np.float32)
    tt = 0.25
    while tt < duration - 0.2:
        idx = int(tt * sr)
        y[idx:idx + n] += kick
        current = bpm if change_at is None or tt < change_at else second_bpm
        tt += 60.0 / current
    sf.write(str(path), y, sr)


class SegmentationTests(unittest.TestCase):
    def test_small_variation_is_ignored(self):
        beats = np.arange(30) * (60 / 225)
        bpms = np.full(30, 225.2)
        bpms[:10] = 225.0
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 1)

    def test_sustained_change_is_emitted(self):
        beats = np.arange(30) * 0.5
        bpms = np.r_[np.full(12, 120.0), np.full(18, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        # One outlier-tolerant window ([120, 140×4]) already confirms the new
        # tempo, so the change is reported a beat before the step completes.
        self.assertEqual(points[1].offset_ms, 5500.0)
        self.assertIn("428.571428571429", osu_timing_text(type("A", (), {"points": points})()))

    def test_backtrack_lands_on_midpoint_crossing(self):
        beats = np.arange(40) * 0.5
        bpms = np.r_[np.full(10, 120.0), [130.0], np.full(29, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        self.assertEqual(points[1].offset_ms, 5000.0)

    def test_single_spike_does_not_veto_real_change(self):
        beats = np.arange(30) * 0.5
        bpms = np.r_[np.full(12, 120.0), [140.0, 140.0, 200.0], np.full(15, 140.0)]
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 2)
        # The spike sits inside the confirming window; tolerance still
        # confirms at the true boundary instead of slipping 3 beats late.
        self.assertEqual(points[1].offset_ms, 6000.0)

    def test_single_spike_does_not_create_section(self):
        beats = np.arange(30) * 0.5
        bpms = np.full(30, 120.0)
        bpms[15] = 200.0  # lone outlier, no sustained change
        points = _segment_tempi(beats, bpms, min_delta=1.5, persistence=5)
        self.assertEqual(len(points), 1)

    def test_double_time_requires_in_between_attacks(self):
        onset = np.zeros(1000)
        onset[np.arange(100, 900, 100)] = 1.0
        onset[np.arange(150, 900, 100)] = 0.9
        self.assertEqual(_choose_subdivision(onset, np.arange(100, 900, 100), True), 2)

    def test_absent_subdivisions_do_not_double(self):
        onset = np.zeros(1000)
        onset[np.arange(100, 900, 100)] = 1.0
        self.assertEqual(_choose_subdivision(onset, np.arange(100, 900, 100), True), 1)

    def test_export_snaps_change_to_previous_grid(self):
        points = [TimingPoint(353, 225, 1, 0), TimingPoint(13160, 222, 1, 48)]
        snapped = snap_timing_points(points)
        self.assertAlmostEqual(snapped[1].offset_ms, 13153.0, places=6)

    def test_out_of_range_base_doubles_with_moderate_evidence(self):
        # Half-time lock scenario: tracker sits on ~112.5 BPM while the song
        # is really ~225 BPM. Off-beat attacks are weaker (0.55) than beats
        # (1.0) — the old stricter gate stayed at half, collapsing 225/222.2
        # sections into one "constant" map.
        onset = np.zeros(2000)
        beats = np.arange(100, 1900, 92)  # ~112.4 BPM at 172.27 frames/sec
        onset[beats] = 1.0
        midpoints = ((beats[:-1] + beats[1:]) / 2).astype(int)
        onset[midpoints] = 0.55
        self.assertEqual(_choose_subdivision(onset, beats, True), 2)

    def test_in_range_base_does_not_double_on_weak_evidence(self):
        onset = np.zeros(2000)
        beats = np.arange(100, 1900, 77)  # ~223 BPM, already in map range
        onset[beats] = 1.0
        midpoints = ((beats[:-1] + beats[1:]) / 2).astype(int)
        onset[midpoints] = 0.15
        self.assertEqual(_choose_subdivision(onset, beats, True), 1)


class RobustnessTests(unittest.TestCase):
    def test_invalid_parameters_rejected_before_io(self):
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", min_delta=-1.0)
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", persistence=1)
        with self.assertRaises(ValueError):
            analyze_audio("whatever.wav", min_confidence=1.5)

    def test_undecodable_file_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                analyze_audio(str(Path(tmp) / "missing.wav"))

    def test_single_bad_interval_does_not_drag_local_bpm(self):
        beats = np.arange(20) * 0.5
        beats[10:] += 0.25  # one doubled gap (missed beat)
        local = _robust_local_bpms(beats)
        self.assertAlmostEqual(float(np.median(local)), 120.0, delta=6.0)

    def test_gap_fill_interpolates_isolated_miss(self):
        frames = np.array([0.0, 40.0, 80.0, 160.0, 200.0, 240.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), 7)
        self.assertAlmostEqual(float(filled[3]), 120.0, delta=1.0)

    def test_gap_fill_leaves_long_silence_alone(self):
        # A whole sparse neighbourhood: the local median grows with the gap.
        frames = np.array([0.0, 40.0, 2000.0, 4000.0, 6000.0, 8000.0, 8040.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_gap_fill_rejects_non_integer_hole(self):
        # One 25× hole: not representable within max_fill → left alone.
        frames = np.array([0.0, 40.0, 80.0, 120.0, 160.0, 200.0, 1200.0, 1240.0, 1280.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_gap_fill_ignores_tempo_jump(self):
        # Abrupt 120 → 240 BPM: shorter intervals must never trigger fills.
        frames = np.array([0.0, 500.0, 1000.0, 1250.0, 1500.0, 1750.0])
        filled = _fill_missed_beats(frames)
        self.assertEqual(len(filled), len(frames))

    def test_english_is_default_language(self):
        self.assertEqual(DEFAULT_LANGUAGE, "English")
        self.assertEqual(list(TimingAnalyzerApp.TEXT.keys())[0], "English")
        for table in TimingAnalyzerApp.TEXT.values():
            self.assertIn("analyze", table)
        self.assertIn("English", TimingAnalyzerApp.TEXT)
        self.assertIn("Español", TimingAnalyzerApp.TEXT)

    def test_variable_preset_is_default(self):
        variable = TimingAnalyzerApp.PRESETS["variable"]
        steady = TimingAnalyzerApp.PRESETS["steady"]
        self.assertEqual(TimingAnalyzerApp.CFG_VERSION, 2)
        # Variable preset: sensitive enough for songs that change often.
        self.assertLessEqual(int(variable["persistence"]), 12)
        self.assertLessEqual(float(variable["confidence"]), 75)
        # Steady preset: strictly more conservative on every axis.
        self.assertGreater(float(steady["delta"]), float(variable["delta"]))
        self.assertGreater(int(steady["persistence"]), int(variable["persistence"]))
        self.assertGreater(float(steady["confidence"]), float(variable["confidence"]))


class EndToEndTests(unittest.TestCase):
    def test_steady_click_reports_correct_global_bpm(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path)
        self.assertGreaterEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.global_bpm, 128.0, delta=128.0 * 0.03)
        self.assertAlmostEqual(analysis.points[0].bpm, 128.0, delta=128.0 * 0.03)
        self.assertGreaterEqual(analysis.stability, 0.7)
        self.assertLess(abs(analysis.points[0].offset_ms - 250), 60)
        text = osu_timing_text(analysis)
        self.assertIn("// Generated", text)
        self.assertIn("Source:", analysis_summary(analysis))

    def test_tempo_change_produces_two_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "variable.wav"
            _click_track(path, bpm=120.0, duration=16.0, change_at=8.0, second_bpm=140.0)
            analysis = analyze_audio(path)
        self.assertGreaterEqual(len(analysis.points), 2)
        bpms = sorted(p.bpm for p in analysis.points)
        self.assertAlmostEqual(bpms[0], 120.0, delta=120.0 * 0.04)
        self.assertAlmostEqual(bpms[-1], 140.0, delta=140.0 * 0.04)

    def test_tempo_guides_contain_true_tempo(self):
        import soundfile as sf
        from overtone import _global_tempo_guides, _onset_envelope
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            y, sr = sf.read(str(path), dtype="float32", always_2d=False)
            onset = _onset_envelope(np.asarray(y, dtype=np.float32), sr, 256)
            guides = _global_tempo_guides(onset, sr, 256)
        self.assertTrue(any(abs(bpm - 128.0) <= max(4.0, 128.0 * 0.03) for bpm, _w in guides),
                        f"guides missing 128 BPM: {guides}")

    def test_no_refine_path_still_reports_tempo(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path, refine_beats=False)
        self.assertGreaterEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.global_bpm, 128.0, delta=128.0 * 0.05)

    def test_click_track_export_is_audible_and_aligned(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            _click_track(path, bpm=128.0)
            analysis = analyze_audio(path)
            out = Path(tmp) / "click.wav"
            export_click_track(analysis, out)
            data, _sr = sf.read(str(out))
            self.assertGreater(float(np.max(np.abs(data))), 0.1)

    def test_rebuild_with_subdivision_doubles_bpm_without_retracking(self):
        # Synthetic grid: strong attacks every 80 frames (~129 BPM) plus
        # weaker off-beat attacks halfway between — so a ×2 grid is musical.
        from overtone import Analysis
        sr, hop = 44100, 256
        onset = np.zeros(2000, dtype=np.float32)
        onset[np.arange(50, 1950, 80)] = 1.0
        onset[np.arange(90, 1950, 80)] = 0.8
        base = np.arange(50, 1950, 80)
        beats = base.astype(float) * hop / sr
        local = np.full(len(beats), 129.2)
        analysis = Analysis("synthetic", float(beats[-1] + 1), beats, local,
                            [TimingPoint(float(beats[0] * 1000), 129.2, 1.0, 0)],
                            hop, sr, 1, 129.2, 1.0, "4/4", onset, base)
        doubled = rebuild_with_subdivision(analysis, 2)
        self.assertEqual(doubled.subdivision, 2)
        self.assertAlmostEqual(doubled.global_bpm, analysis.global_bpm * 2,
                               delta=analysis.global_bpm * 2 * 0.05)
        with self.assertRaises(ValueError):
            rebuild_with_subdivision(analysis, 3)


def _two_points():
    beats = np.arange(0.0, 20.0, 0.5)
    return beats, [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(5000.0, 140.0, 0.8, 10)]


class ManualEditTests(unittest.TestCase):
    def test_add_keeps_sorted_and_snaps_beat_index(self):
        beats, points = _two_points()
        out = add_timing_point(points, beats, 2500.0, 130.0)
        self.assertEqual([p.offset_ms for p in out], [0.0, 2500.0, 5000.0])
        self.assertEqual(out[1].beat_index, 5)
        self.assertEqual(out[1].confidence, 1.0)
        with self.assertRaises(ValueError):
            add_timing_point(points, beats, 2500.0, 0.0)

    def test_update_preserves_confidence_and_resorts(self):
        beats, points = _two_points()
        out = update_timing_point(points, beats, 1, 1000.0, 150.0)
        self.assertEqual([p.offset_ms for p in out], [0.0, 1000.0])
        self.assertEqual(out[1].confidence, 0.8)
        with self.assertRaises(ValueError):
            update_timing_point(points, beats, 7, 1000.0, 150.0)

    def test_delete_protects_first_point(self):
        _, points = _two_points()
        with self.assertRaises(ValueError):
            delete_timing_point(points, 0)
        out = delete_timing_point(points, 1)
        self.assertEqual(len(out), 1)
        with self.assertRaises(ValueError):
            delete_timing_point(points, 5)

    def test_nudge_clamps_at_zero(self):
        beats, points = _two_points()
        out = nudge_timing_point(points, beats, 0, -50.0)
        self.assertEqual(out[0].offset_ms, 0.0)
        out = nudge_timing_point(points, beats, 1, 4.0)
        self.assertAlmostEqual(out[1].offset_ms, 5004.0)

    def test_rescale_section(self):
        _, points = _two_points()
        out = rescale_section(points, 0, 2.0)
        self.assertAlmostEqual(out[0].bpm, 240.0)
        self.assertEqual(out[0].offset_ms, 0.0)
        out = rescale_section(points, 1, 0.5)
        self.assertAlmostEqual(out[1].bpm, 70.0)
        with self.assertRaises(ValueError):
            rescale_section(points, 0, 3.0)
        with self.assertRaises(ValueError):  # 400 × 2 = 800 exceeds the 600 cap
            rescale_section([TimingPoint(0.0, 400.0, 1.0, 0)], 0, 2.0)


def _section_analysis(mid_amp: float, bpm: float = 112.4):
    from overtone import Analysis
    sr, hop = 44100, 256
    step = int(round(60.0 / bpm * sr / hop))
    onset = np.zeros(3000, dtype=np.float32)
    grid = np.arange(50, 2900, step)
    onset[grid] = 1.0
    onset[((grid[:-1] + grid[1:]) / 2).astype(int)] = mid_amp
    beats = grid.astype(float) * hop / sr
    local = np.full(len(beats), bpm)
    return Analysis("synthetic", float(beats[-1] + 2), beats, local,
                    [TimingPoint(float(beats[0] * 1000), bpm, 0.9, 0)],
                    hop, sr, 1, bpm, 1.0, "4/4", onset, grid)


class SectionPulseTests(unittest.TestCase):
    def test_slow_section_with_offbeats_is_suggested(self):
        suggestions = suggest_section_pulse(_section_analysis(0.7))
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0][:2], (0, 2))

    def test_slow_section_without_offbeats_is_not_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.0)), [])

    def test_in_range_section_is_never_suggested(self):
        self.assertEqual(suggest_section_pulse(_section_analysis(0.9, bpm=224.0)), [])

    def test_pulse_hints_only_ever_suggest_doubling(self):
        """Documents a real gap, not desired behaviour — audit finding F-11.

        Every suggestion the helper can emit is ``x2``: it skips any point at
        or above ``low_bpm`` before looking at the audio, so a section reported
        at 175 BPM whose note rate has actually halved to 87.5 gets no hint.
        The benchmark cannot see this either (it normalizes octaves), and
        ``bench/gates.py coverage`` measures the signal that would drive the
        missing halving hint. When v4 adds it, this test should be replaced by
        one asserting the hint appears.
        """
        # A sparse, fast section: attacks on every other beat of the reported
        # grid, which is what a half-time region looks like from here.
        analysis = _section_analysis(0.0, bpm=200.0)
        self.assertEqual(suggest_section_pulse(analysis), [])
        factors = {factor for _idx, factor, _ratio in
                   suggest_section_pulse(_section_analysis(0.7))}
        self.assertEqual(factors, {2}, "the helper has no downward direction")


class OsuInjectTests(unittest.TestCase):
    FAKE_OSU = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n"
                "[TimingPoints]\n"
                "353,266.666666666667,4,2,0,100,1,0\n"
                "1000,500,4,2,0,60,0,0\n"
                "13153,270.270270270270,4,2,0,85,1,1\n"
                "[HitObjects]\n64,80,1000,1,0\n")

    def _analysis(self, source="song.mp3"):
        from types import SimpleNamespace
        return SimpleNamespace(source=source,
                               points=[TimingPoint(360.0, 224.0, 0.95, 1),
                                       TimingPoint(14000.0, 222.0, 0.9, 60)])

    def test_replace_reds_keeps_greens_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            original = self.FAKE_OSU.replace("\n", "\r\n").encode("utf-8")
            target.write_bytes(original)
            summary = inject_osu_timing_points(target, self._analysis())
            out = target.read_bytes()
            self.assertEqual(summary["reds_replaced"], 2)
            self.assertEqual(summary["reds_added"], 2)
            self.assertEqual(summary["greens_kept"], 1)
            self.assertFalse(summary["audio_mismatch"])
            self.assertIn(b"1000,500,4,2,0,60,0,0\r\n", out)  # green untouched
            self.assertNotIn(b"266.666666666667", out)  # old red gone
            self.assertTrue((Path(str(target) + ".bak")).is_file())
            self.assertEqual((Path(str(target) + ".bak")).read_bytes(), original)
            # Idempotent: injecting again changes nothing.
            inject_osu_timing_points(target, self._analysis(), backup=False)
            second = target.read_bytes()
            inject_osu_timing_points(target, self._analysis(), backup=False)
            self.assertEqual(target.read_bytes(), second)

    def test_missing_section_and_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "empty.osu"
            target.write_text("[General]\n[HitObjects]\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                inject_osu_timing_points(target, self._analysis())
            target2 = Path(tmp) / "other.osu"
            target2.write_text("[General]\nAudioFilename: song.mp3\n[TimingPoints]\n", encoding="utf-8")
            summary = inject_osu_timing_points(target2, self._analysis(source="different.wav"),
                                               backup=False)
            self.assertEqual(summary["reds_replaced"], 0)
            self.assertTrue(summary["audio_mismatch"])


def _timing_rows(text: str) -> list[list[str]]:
    rows, inside = [], False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "[TimingPoints]":
            inside = True
            continue
        if inside and stripped.startswith("["):
            break
        if inside and stripped and not stripped.startswith("//"):
            rows.append([f.strip() for f in stripped.split(",")])
    return rows


def _heard_at(text: str, t: float) -> tuple:
    """What osu! plays at time t: (SV, sample set, index, volume, kiai).

    Written independently of the injector on purpose: a red line resets SV to
    1, a green sets it to -100/beatLength, both set the sample fields; points
    at the same time apply red first; before the first point, the first
    point's settings apply.
    """
    points = []
    for n, f in enumerate(_timing_rows(text)):
        length = float(f[1])
        red = length > 0 and (len(f) < 7 or f[6] == "1")
        points.append((float(f[0]), 0 if red else 1, n, length, red,
                       int(f[3]), int(f[4]), int(f[5]), int(f[7]) & 1))
    points.sort()
    active = [q for q in points if q[0] <= t] or points[:1]
    sv, heard = 1.0, None
    for time, _o, _n, length, red, sample_set, index, volume, kiai in active:
        sv = 1.0 if red else (-100.0 / length if length < 0 else sv)
        heard = (sample_set, index, volume, kiai)
    return (round(sv, 9),) + heard


class InjectKeepsWhatPlaysTests(unittest.TestCase):
    """Injection changes the timing and nothing a player hears or sees scroll.

    Before this, every new red line was written as Normal / 100 % / no kiai and
    the section was left out of time order: re-injecting a hitsounded map with
    kiai silently flattened it.
    """

    # Soft 60 % from 400; kiai from 20 s; a red at 30 s re-states Soft 60 with
    # kiai; kiai off at 45 s. A 2.0x slider-velocity green at 22 s.
    MAP = ("osu file format v14\n[General]\nAudioFilename: song.mp3\n\n"
           "[TimingPoints]\n"
           "400,400,4,2,0,60,1,0\n"
           "20000,-100,4,2,0,60,0,1\n"
           "22000,-50,4,2,0,60,0,1\n"
           "30000,375,4,2,0,60,1,1\n"
           "45000,-100,4,2,1,40,0,0\n"
           "\n[HitObjects]\n")
    OBJECTS = [1000, 5000, 19000, 20500, 22500, 25000, 29000, 30500, 31000,
               33000, 39000, 41000, 44000, 46000, 50000]

    def _map(self, tmp: str, text: str = "", newline: str = "\n", bom: bool = False) -> Path:
        text = text or self.MAP + "".join(f"256,192,{t},1,0\n" for t in self.OBJECTS)
        path = Path(tmp) / "map.osu"
        data = text.replace("\n", newline).encode("utf-8")
        path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + data)
        return path

    def _analysis(self):
        from types import SimpleNamespace
        # red lines that do not sit where the old ones were
        return SimpleNamespace(source="song.mp3", meter="4/4",
                               points=[TimingPoint(500.0, 150.0, 0.95, 0),
                                       TimingPoint(25000.0, 160.0, 0.9, 60),
                                       TimingPoint(40000.0, 170.0, 0.9, 100)])

    def test_every_object_plays_as_before(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            before = path.read_text(encoding="utf-8")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            after = path.read_text(encoding="utf-8")
        for t in self.OBJECTS:
            self.assertEqual(_heard_at(after, t), _heard_at(before, t), f"object at {t} ms")

    def test_new_red_lines_carry_the_state_they_land_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            inject_osu_timing_points(path, self._analysis(), backup=False)
            reds = [r for r in _timing_rows(path.read_text(encoding="utf-8")) if r[6] == "1"]
        # offsets as exported (25000 snaps to 24900 on the 150 BPM grid)
        self.assertEqual([r[0] for r in reds], ["500", "24900", "40000"])
        self.assertEqual(reds[0][3:8], ["2", "0", "60", "1", "0"])   # Soft 60, before kiai
        self.assertEqual(reds[1][3:8], ["2", "0", "60", "1", "1"])   # inside the kiai
        self.assertEqual(reds[2][3:8], ["2", "0", "60", "1", "1"])

    def test_timing_section_is_in_time_order_red_before_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp)
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            rows = _timing_rows(path.read_text(encoding="utf-8"))
        keys = [(float(r[0]), 0 if r[6] == "1" else 1) for r in rows]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(summary["reds_replaced"], 2)
        self.assertEqual(summary["reds_added"], 3)
        self.assertEqual(summary["greens_kept"], 3)
        self.assertGreater(summary["greens_added"], 0)  # SV 2.0 around the moved reds

    def test_original_greens_are_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, newline="\r\n")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            out = path.read_bytes()
        for green in (b"20000,-100,4,2,0,60,0,1\r\n", b"22000,-50,4,2,0,60,0,1\r\n",
                      b"45000,-100,4,2,1,40,0,0\r\n"):
            self.assertIn(green, out)
        self.assertNotIn(b"\r\r\n", out)

    def test_injecting_twice_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, newline="\r\n")
            inject_osu_timing_points(path, self._analysis(), backup=False)
            first = path.read_bytes()
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            self.assertEqual(path.read_bytes(), first)
        self.assertEqual(summary["greens_added"], 0)

    def test_bom_and_missing_final_newline_survive(self):
        text = self.MAP + "256,192,1000,1,0"  # no newline at the end of the file
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, text=text, newline="\r\n", bom=True)
            original = path.read_bytes()
            inject_osu_timing_points(path, self._analysis(), backup=False)
            out = path.read_bytes()
        self.assertTrue(out.startswith(b"\xef\xbb\xbfosu file format v14\r\n"))
        head = original[:original.index(b"[TimingPoints]")]
        self.assertTrue(out.startswith(head))
        self.assertTrue(out.endswith(b"\r\n\r\n[HitObjects]\r\n256,192,1000,1,0"))

    def test_a_map_without_timing_gets_plain_red_lines(self):
        text = "osu file format v14\n[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n\n[HitObjects]\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = self._map(tmp, text=text)
            summary = inject_osu_timing_points(path, self._analysis(), backup=False)
            rows = _timing_rows(path.read_text(encoding="utf-8"))
        self.assertEqual(summary["greens_added"], 0)
        self.assertEqual([r[3:8] for r in rows], [["1", "0", "100", "1", "0"]] * 3)


# ---------------------------------------------------------------------------
# v3 precision engine
# ---------------------------------------------------------------------------

def _drum_track(path: Path, sections, duration: float = 24.0, sr: int = 44100,
                hats: bool = True, seed: int = 7) -> list[tuple[float, float]]:
    """Kick/snare/hat pattern with a known grid. Returns [(start_s, bpm)]."""
    import soundfile as sf
    rng = np.random.default_rng(seed)

    def kick():
        n = int(0.18 * sr)
        t = np.arange(n) / sr
        sweep = 2 * np.pi * np.cumsum(120 * np.exp(-t / 0.03) + 45) / sr
        return (np.sin(sweep) * np.exp(-t / 0.055)
                + rng.standard_normal(n) * np.exp(-t / 0.0025) * 0.35).astype(np.float32)

    def snare():
        n = int(0.16 * sr)
        t = np.arange(n) / sr
        return ((rng.standard_normal(n) * np.exp(-t / 0.045)) * 0.7
                + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.03) * 0.5).astype(np.float32) * 0.7

    def hat():
        n = int(0.05 * sr)
        t = np.arange(n) / sr
        return (rng.standard_normal(n) * np.exp(-t / 0.008)).astype(np.float32) * 0.28

    KICK, SNARE, HAT = kick(), snare(), hat()
    buffer = np.zeros(int(duration * sr) + sr, dtype=np.float32)

    def place(sample, at, gain=1.0):
        i = int(round(at))
        end = min(len(buffer), i + len(sample))
        if 0 <= i < end:
            buffer[i:end] += sample[:end - i] * gain

    truth, t, beat, si = [], sections[0][0], 0, 0
    truth.append((t, sections[0][1]))
    while t < duration:
        while si + 1 < len(sections) and t >= sections[si + 1][0] - 1e-9:
            si += 1
            truth.append((t, sections[si][1]))
            beat = 0
        step = 60.0 / sections[si][1]
        place(KICK if beat % 4 in (0, 2) else SNARE, t * sr, 1.0 if beat % 4 == 0 else 0.85)
        if hats:
            place(HAT, t * sr, 0.7)
            place(HAT, (t + step / 2) * sr, 0.5)
        t += step
        beat += 1
    peak = float(np.max(np.abs(buffer)))
    sf.write(str(path), (buffer[:int(duration * sr)] / max(peak, 1e-9) * 0.9), sr)
    return truth


def _offset_error_ms(offset_ms: float, true_start_s: float, bpm: float) -> float:
    """Distance from a detected offset to the nearest true beat, in ms."""
    step = 60.0 / bpm
    d = (offset_ms / 1000.0 - true_start_s) / step
    return abs(d - round(d)) * step * 1000.0


class PrecisionEngineTests(unittest.TestCase):
    def test_odd_tempo_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "odd.wav"
            truth = _drum_track(path, [(0.6173, 174.37)], duration=26.0)
            analysis = analyze_audio(path)
        self.assertEqual(analysis.engine, "precision")
        self.assertEqual(len(analysis.points), 1)
        self.assertAlmostEqual(analysis.points[0].bpm, 174.37, delta=0.02)
        self.assertLess(_offset_error_ms(analysis.points[0].offset_ms, truth[0][0], 174.37), 3.0)

    def test_two_sections_are_both_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "two.wav"
            truth = _drum_track(path, [(0.41, 150.0), (16.0, 162.0)], duration=34.0)
            analysis = analyze_audio(path)
        points = snap_timing_points(analysis.points)
        self.assertEqual(len(points), 2)
        self.assertAlmostEqual(points[0].bpm, 150.0, delta=0.02)
        self.assertAlmostEqual(points[1].bpm, 162.0, delta=0.02)
        for point, (start, bpm) in zip(points, truth):
            self.assertLess(_offset_error_ms(point.offset_ms, start, bpm), 4.0)
        # The second red line must land on the beat where the tempo changed.
        self.assertLess(abs(points[1].offset_ms / 1000.0 - truth[1][0]), 0.5)

    def test_forced_octave_is_exact_and_reversible(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oct.wav"
            _drum_track(path, [(0.5, 160.0)], duration=24.0)
            base = analyze_audio(path)
            halved = analyze_audio(path, force_subdivision=0.5)
        self.assertAlmostEqual(halved.points[0].bpm, base.points[0].bpm / 2, delta=0.01)
        back = rebuild_with_subdivision(halved, 1.0)
        self.assertAlmostEqual(back.points[0].bpm, base.points[0].bpm, delta=0.01)
        with self.assertRaises(ValueError):
            analyze_audio(path, force_subdivision=3)

    def test_legacy_engine_still_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.wav"
            _drum_track(path, [(0.5, 150.0)], duration=24.0)
            analysis = analyze_audio(path, engine="legacy")
        self.assertEqual(analysis.engine, "legacy")
        self.assertAlmostEqual(analysis.global_bpm, 150.0, delta=150.0 * 0.03)
        with self.assertRaises(ValueError):
            analyze_audio(path, engine="nonsense")

    def test_precision_engine_refuses_ungriddable_audio(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pad.wav"
            sr = 44100
            t = np.arange(sr * 8) / sr
            drone = (np.sin(2 * np.pi * 220 * t) * 0.4).astype(np.float32)
            sf.write(str(path), drone, sr)
            with self.assertRaises(ValueError):
                analyze_audio(path, engine="precision")


class GridMathTests(unittest.TestCase):
    def test_coherence_phase_has_the_right_sign(self):
        # Regression: the phase used to come back negated, putting the seed
        # grid in anti-phase and forcing least squares to start half a beat off.
        period, phase = 0.25, 0.1234
        times = phase + np.arange(120) * period
        weights = np.ones_like(times)
        candidates = _atomic_grid_candidates(times, weights)
        self.assertTrue(candidates)
        best = min(candidates, key=lambda c: abs(c[0] - period))
        self.assertAlmostEqual(best[0], period, places=3)
        self.assertAlmostEqual(best[1] % period, phase % period, places=2)

    def test_least_squares_beats_interval_differencing(self):
        rng = np.random.default_rng(3)
        period, phase = 60.0 / 174.31, 0.4137
        k = np.arange(400)
        times = phase + k * period + rng.normal(0, 0.004, k.size)   # 4 ms jitter
        weights = np.ones_like(times)
        # Seeded 1 % off, as a coherence scan on a short window would be: the
        # expanding fit has to walk that in without slipping a beat index.
        fitted, fitted_phase = _expand_fit(times, weights, period * 1.01, phase + 0.01,
                                           float(times[0]), float(times[-1]))
        self.assertAlmostEqual(60.0 / fitted, 174.31, delta=0.01)
        # The beat-index origin may shift; only the phase modulo one beat means
        # anything, and it must land within a couple of milliseconds.
        drift = ((fitted_phase - phase + period / 2) % period) - period / 2
        self.assertLess(abs(drift), 0.002)
        # For contrast, the v2 approach — differencing consecutive beats — is
        # two orders of magnitude noisier on the very same data.
        naive = float(np.median(60.0 / np.diff(times)))
        self.assertGreater(abs(naive - 174.31), abs(60.0 / fitted - 174.31))

    def test_recentre_phase_picks_the_dense_cluster(self):
        period = 0.5
        beats = np.arange(60) * period
        ghosts = beats[:-1] + 0.04                    # weak, consistently late
        times = np.sort(np.concatenate([beats, ghosts]))
        weights = np.where(np.isin(times, beats), 1.0, 0.45)
        biased = 0.018                                 # what plain LS would settle on
        fixed = _recentre_phase(times, weights, period, biased)
        self.assertLess(abs(((fixed + period / 2) % period) - period / 2), 0.004)

    def test_boundary_lands_where_the_grids_cross(self):
        change = 20.0
        left = GridSection(0.0, change, 0.5, 0.0, 40, 0.5, 1.0)
        right = GridSection(change, 40.0, 0.46, change, 40, 0.5, 1.0)
        times = np.concatenate([np.arange(0, change, 0.5),
                                change + np.arange(0, 20.0, 0.46)])
        weights = np.ones_like(times)
        split = _tune_boundary(times, weights, left, right)
        self.assertAlmostEqual(split, change, delta=0.5)

    def test_attack_retiming_removes_detector_latency(self):
        sr = 44100
        y = np.zeros(sr * 3, dtype=np.float32)
        hits = np.array([0.5, 1.0, 1.5, 2.0])
        n = int(0.12 * sr)
        decay = np.exp(-np.arange(n) / (0.02 * sr)).astype(np.float32)
        tone = (np.sin(2 * np.pi * 90 * np.arange(n) / sr) * decay).astype(np.float32)
        for hit in hits:
            i = int(hit * sr)
            y[i:i + n] += tone
        late = hits + 0.008                            # a flux peak lags the attack
        fixed = _retime_onsets(y, sr, late)
        self.assertTrue(np.all(np.abs(fixed - hits) < 0.003),
                        f"retimed {np.round((fixed - hits) * 1000, 2)} ms off")


class ExportHardeningTests(unittest.TestCase):
    def _analysis(self, points, meter="4/4"):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3", points=points, meter=meter)

    def test_offsets_are_whole_milliseconds_by_default(self):
        text = osu_timing_text(self._analysis([TimingPoint(353.4137, 225.0, 1.0, 0)]))
        self.assertIn("\n353,", text)
        self.assertNotIn("353.4", text)
        detailed = osu_timing_text(self._analysis([TimingPoint(353.4137, 225.0, 1.0, 0)]), decimals=3)
        self.assertIn("353.414,", detailed)

    def test_meter_is_written_from_the_detection(self):
        text = osu_timing_text(self._analysis([TimingPoint(0.0, 120.0, 1.0, 0)], meter="3/4"))
        self.assertTrue(text.splitlines()[1].split(",")[2] == "3")

    def test_impossible_points_are_skipped_not_crashed(self):
        text = osu_timing_text(self._analysis([TimingPoint(0.0, 0.0, 1.0, 0),
                                               TimingPoint(10.0, 120.0, 1.0, 1)]))
        self.assertEqual(len(text.splitlines()), 2)      # comment + one usable row

    def test_snap_keeps_an_exact_offset_it_cannot_improve(self):
        # A change that genuinely does not sit on the old grid must not be
        # dragged onto it — the v3 fit already knows where it is.
        points = [TimingPoint(0.0, 120.0, 1.0, 0), TimingPoint(5250.0, 140.0, 1.0, 10)]
        self.assertEqual(snap_timing_points(points)[1].offset_ms, 5250.0)

    def test_click_track_survives_a_hand_edited_zero_bpm(self):
        from types import SimpleNamespace
        analysis = SimpleNamespace(duration=4.0, points=[TimingPoint(0.0, 120.0, 1.0, 0),
                                                         TimingPoint(2000.0, 0.0, 1.0, 4)])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "c.wav"
            export_click_track(analysis, out)
            self.assertTrue(out.is_file())


class MeasureGridTests(unittest.TestCase):
    """Per-section bars: audit F-03, and Tempora's measure model automated.

    v3 read the meter once, from the first section, wrote that number into
    every red line, and anchored every line after the first to a plain beat.
    A song that moves to 3/4 came out wrong everywhere after the change, and
    osu!'s bar lines drifted out of step with the music.
    """

    @staticmethod
    def _accented(period, phase, count, bar, start_class=0):
        """Attacks on a grid, accented once per `bar` beats."""
        times = np.array([phase + k * period for k in range(count)])
        weights = np.array(
            [1.0 if (k % bar) == start_class else 0.3 for k in range(count)],
            dtype=float,
        )
        return times, weights

    def test_section_measures_reads_each_section_separately(self):
        # 4/4 for 16 bars, then 3/4 for 16 bars, on the same tempo.
        period = 0.5
        a_times, a_weights = self._accented(period, 0.0, 64, 4)
        b_start = 64 * period
        b_times, b_weights = self._accented(period, b_start, 48, 3)
        times = np.r_[a_times, b_times]
        weights = np.r_[a_weights, b_weights]
        sections = [
            GridSection(0.0, b_start, period, 0.0, 64, 0.1, 1.0),
            GridSection(b_start, b_start + 48 * period, period, b_start, 48, 0.1, 1.0),
        ]
        measures = section_measures(sections, times, weights)
        self.assertEqual(measures[0][2], 4, f"first section: {measures[0]}")
        self.assertEqual(measures[1][2], 3, f"second section: {measures[1]}")

    def test_a_proven_bar_anchors_the_red_line_to_a_downbeat(self):
        # The second section's downbeat sits two beats after its start, so a
        # beat-anchored line would land on the wrong beat of the bar.
        period = 0.5
        sections = [
            GridSection(0.0, 10.0, period, 0.0, 20, 0.1, 1.0),
            GridSection(10.0, 20.0, period, 9.0, 20, 0.1, 1.0),
        ]
        measures = [("4/4", 0, 4), ("4/4", 1, 4)]
        points = _points_from_sections(sections, 0.0, 4, 0, 4, 1.0, measures)
        self.assertEqual(len(points), 2)
        second = points[1]
        # phase 9.0, downbeat class 1 -> downbeats at 9.5, 11.5, 13.5 ...
        # The first at or after the section start (10.0) is 11.5.
        self.assertAlmostEqual(second.offset_ms, 11500.0, places=6)
        self.assertTrue(second.meter_known)
        self.assertEqual(second.meter, 4)

    def test_no_evidence_keeps_the_old_beat_anchoring(self):
        # A section whose accents prove nothing must behave exactly as before:
        # anchored to the next beat, not pushed forward to an invented bar.
        period = 0.5
        sections = [
            GridSection(0.0, 10.0, period, 0.0, 20, 0.1, 1.0),
            GridSection(10.0, 20.0, period, 9.0, 20, 0.1, 1.0),
        ]
        measures = [("4/4", 0, 1), ("4/4", 0, 1)]
        points = _points_from_sections(sections, 0.0, 4, 0, 1, 1.0, measures)
        # phase 9.0, beats at 9.0, 9.5, 10.0 -> the first at/after 10.0 is 10.0
        self.assertAlmostEqual(points[1].offset_ms, 10000.0, places=6)
        self.assertFalse(points[1].meter_known)

    def test_each_point_writes_its_own_meter(self):
        analysis = Analysis("s", 30.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, 120.0, 1.0, 0, 4, True),
                             TimingPoint(8000.0, 120.0, 1.0, 1, 3, True)],
                            512, 44100, 1, 120.0, 1.0, "4/4")
        rows = [r for r in osu_timing_text(analysis).splitlines() if not r.startswith("//")]
        self.assertEqual(rows[0].split(",")[2], "4")
        self.assertEqual(rows[1].split(",")[2], "3", "the 3/4 section must say 3")

    def test_an_unknown_meter_falls_back_to_the_analysis(self):
        # A hand-added point knows no bar; writing a hard-coded 4 over a
        # detected 3/4 would invent information the engine did not have.
        analysis = Analysis("s", 30.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, 120.0, 1.0, 0)],
                            512, 44100, 1, 120.0, 1.0, "3/4")
        rows = [r for r in osu_timing_text(analysis).splitlines() if not r.startswith("//")]
        self.assertEqual(rows[0].split(",")[2], "3")

    def test_click_track_accents_on_the_detected_meter(self):
        """Audit F-03: the metronome accented every 4th beat on a waltz."""
        import soundfile as sf
        bpm, bar = 120.0, 3
        analysis = Analysis("s", 8.0, np.zeros(0), np.zeros(0),
                            [TimingPoint(0.0, bpm, 1.0, 0, bar, True)],
                            512, 44100, 1, bpm, 1.0, "3/4")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "click.wav"
            export_click_track(analysis, path)
            y, sr = sf.read(str(path))
        beat = 60.0 / bpm
        # Peak amplitude in a short window at each beat. The accent tone is
        # louder, so accented beats must be the maxima.
        levels = []
        for k in range(12):
            start = int(k * beat * sr)
            levels.append(float(np.max(np.abs(y[start:start + int(0.03 * sr)]))))
        # The unaccented tone is rendered at 0.7 of the accent's gain, so a
        # 0.6 threshold would call every beat an accent. 0.85 separates them.
        accents = [k for k, level in enumerate(levels) if level > 0.85 * max(levels)]
        self.assertTrue(accents, f"no accents found in {levels}")
        self.assertTrue(
            all(k % bar == 0 for k in accents),
            f"accents at {accents} should all be multiples of {bar}",
        )


class OszExportTests(unittest.TestCase):
    """Timing a song from nothing — the part of Tempora's flow v3 could not do.

    v3 could only inject red lines into a beatmap that already existed. These
    cover writing the beatmap.
    """

    def _analysis(self, source="song.wav"):
        return Analysis(source, 30.0, np.zeros(0), np.zeros(0),
                        [TimingPoint(298.0, 224.0, 0.98, 0, 4, True),
                         TimingPoint(13240.0, 226.5, 0.94, 1, 3, True)],
                        512, 44100, 1, 224.0, 1.0, "4/4")

    @staticmethod
    def _audio(path: Path) -> Path:
        import soundfile as sf
        sf.write(str(path), np.zeros(4410, dtype=np.float32), 44100)
        return path

    def test_archive_holds_the_audio_and_one_beatmap(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            written = export_osz(self._analysis(), out, audio)
            self.assertTrue(out.is_file())
            with zipfile.ZipFile(out) as archive:
                self.assertIsNone(archive.testzip())
                names = archive.namelist()
                osu = [n for n in names if n.endswith(".osu")]
                self.assertEqual(len(osu), 1, names)
                self.assertIn("song.wav", names)
                text = archive.read(osu[0]).decode("utf-8")
            # The beatmap must point at the name the archive actually used, or
            # osu! opens a map with no audio.
            self.assertIn(f"AudioFilename: {written['audio']}", text)
            self.assertEqual(written["points"], 2)

    def test_the_beatmap_has_every_section_osu_expects(self):
        text = osu_beatmap_text(self._analysis(), "song.mp3")
        self.assertTrue(text.startswith("osu file format v14"))
        for section in ("[General]", "[Editor]", "[Metadata]", "[Difficulty]",
                        "[Events]", "[TimingPoints]", "[HitObjects]"):
            self.assertIn(section, text, section)

    def test_each_points_own_meter_reaches_the_beatmap(self):
        text = osu_beatmap_text(self._analysis(), "song.mp3")
        body = text[text.index("[TimingPoints]"):]
        rows = [r for r in body.splitlines()[1:] if r.strip()][:2]
        self.assertEqual(rows[0].split(",")[2], "4")
        self.assertEqual(rows[1].split(",")[2], "3")

    def test_unsafe_metadata_cannot_escape_the_filename(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            written = export_osz(self._analysis(), out, audio,
                                 {"artist": "../../evil", "title": 'a:b"c|d?e*f'})
            for bad in ("..", "/", "\\", ":", '"', "|", "?", "*"):
                self.assertNotIn(bad, written["osu"], f"{bad!r} in {written['osu']!r}")
            with zipfile.ZipFile(out) as archive:
                for name in archive.namelist():
                    self.assertFalse(Path(name).is_absolute())
                    self.assertNotIn("..", name)

    def test_an_empty_analysis_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            empty = Analysis("song.wav", 30.0, np.zeros(0), np.zeros(0), [],
                             512, 44100, 1, 0.0, 0.0, "4/4")
            with self.assertRaises(ValueError):
                export_osz(empty, Path(tmp) / "map.osz", audio)

    def test_missing_audio_is_refused_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "map.osz"
            with self.assertRaises(ValueError):
                export_osz(self._analysis(), out, Path(tmp) / "nope.wav")
            self.assertFalse(out.exists())
            self.assertFalse((Path(tmp) / "map.osz.part").exists())

    def test_a_failed_export_leaves_no_half_written_archive(self):
        # An interrupted export must not leave a .osz osu! will refuse and the
        # user will not think to delete.
        with tempfile.TemporaryDirectory() as tmp:
            audio = self._audio(Path(tmp) / "song.wav")
            out = Path(tmp) / "map.osz"
            broken = Analysis("song.wav", 30.0, np.zeros(0), np.zeros(0),
                              [TimingPoint(0.0, 0.0, 1.0, 0)],
                              512, 44100, 1, 0.0, 0.0, "4/4")
            with self.assertRaises(ValueError):
                export_osz(broken, out, audio)
            self.assertFalse(out.exists())
            self.assertFalse((Path(tmp) / "map.osz.part").exists())


class SignatureRegionTests(unittest.TestCase):
    """Tempora's measure model, automated.

    Tempora's physical quantity is measures per second; BPM is a presentation
    of it through the time signature (`MpsToBpm(mps) = mps * 60 * beats`). A
    song can therefore change signature without changing tempo, and v3 — which
    grows sections on measures per second — could only report one BPM for it.
    """

    @staticmethod
    def _track(bar: float, phase: float, regions, bars: int):
        """Attacks on a constant bar, subdivided differently per region."""
        def beats_at(index: int) -> int:
            current = regions[0][1]
            for start, beats in regions:
                if index >= start:
                    current = beats
            return current

        times, weights = [], []
        for index in range(bars):
            beats = beats_at(index)
            beat = bar / beats
            start = phase + index * bar
            for b in range(beats):
                times.append(start + b * beat)
                weights.append(1.0 if b == 0 else 0.3)
        return np.asarray(times), np.asarray(weights, dtype=float)

    def test_detect_bar_finds_the_measure_not_a_hypermeasure(self):
        # Four bars of anything also show some accent contrast; the bar is the
        # strongest reading, not the longest. Getting this wrong gave a
        # 4800 ms measure where the truth is 1200.
        bar, phase = 1.2, 0.168
        times, weights = self._track(bar, phase, [(0, 6)], 60)
        found = detect_bar(times, weights, bar / 6, phase)
        self.assertIsNotNone(found)
        self.assertAlmostEqual(found[0], bar, places=6)
        self.assertAlmostEqual(found[1], phase, places=6)

    def test_detect_bar_refuses_without_accents(self):
        # Every attack equally loud: there is no downbeat, so claiming a bar
        # would move every red line on no evidence.
        times = np.arange(200) * 0.2
        weights = np.ones(200)
        self.assertIsNone(detect_bar(times, weights, 0.2, 0.0))

    def test_meter_segments_splits_on_the_subdivision(self):
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 6)]
        times, weights = self._track(bar, phase, regions, 60)
        segments = meter_segments(times, weights, bar, phase)
        self.assertEqual([beats for _s, _e, beats, _sc in segments], [6, 3, 6])
        for (start, _end, _beats, _score), (index, _b) in zip(segments, regions):
            self.assertAlmostEqual(start, phase + index * bar, places=3)

    def test_meter_segments_is_silent_on_one_signature(self):
        # Nothing to split: the ordinary per-section placement must stand.
        bar, phase = 1.2, 0.0
        times, weights = self._track(bar, phase, [(0, 4)], 60)
        self.assertEqual(meter_segments(times, weights, bar, phase), [])

    def test_bpm_follows_temporas_formula(self):
        # BPM = measures-per-second * 60 * beats-in-bar. A 1.2 s bar written
        # in 6 is 300 BPM, in 3 is 150, in 4 is 200 -- the same tempo.
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 4)]
        times, weights = self._track(bar, phase, regions, 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        points = points_from_meter(sections, times, weights, 4)
        self.assertIsNotNone(points)
        self.assertEqual([round(p.bpm, 6) for p in points], [300.0, 150.0, 200.0])
        self.assertEqual([p.meter for p in points], [6, 3, 4])
        self.assertTrue(all(p.meter_known for p in points))

    def test_every_red_line_lands_on_a_bar_line(self):
        bar, phase = 1.2, 0.168
        regions = [(0, 6), (20, 3), (40, 6)]
        times, weights = self._track(bar, phase, regions, 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        points = points_from_meter(sections, times, weights, 4)
        for point in points:
            bars = (point.offset_ms / 1000.0 - phase) / bar
            self.assertAlmostEqual(bars, round(bars), places=3,
                                   msg=f"{point.offset_ms} is not on a bar line")

    def test_a_forced_octave_falls_back_to_the_ordinary_path(self):
        # points_from_meter derives BPM from the bar, so a user-forced pulse
        # octave has no meaning in it; it must decline rather than ignore the
        # user's choice.
        bar, phase = 1.2, 0.168
        times, weights = self._track(bar, phase, [(0, 6), (20, 3)], 60)
        sections = [GridSection(phase, phase + 60 * bar, bar / 6, phase,
                                len(times), 0.1, 1.0)]
        self.assertIsNone(points_from_meter(sections, times, weights, 4, factor=2.0))


class ConfigAndInjectHardeningTests(unittest.TestCase):
    LEGACY_OSU = ("osu file format v4\n[General]\nAudioFilename: song.mp3\n"
                  "[TimingPoints]\n500,344.827\n1200,-50\n[HitObjects]\n")

    def _analysis(self):
        from types import SimpleNamespace
        return SimpleNamespace(source="song.mp3", meter="4/4",
                               points=[TimingPoint(431.0, 174.0, 0.95, 1)])

    def test_legacy_two_field_red_lines_are_replaced(self):
        self.assertTrue(_is_red_line("500,344.827"))
        self.assertFalse(_is_red_line("1200,-50"))
        self.assertFalse(_is_red_line("1200,-50,4,2,0,60,1,0"))   # negative wins
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "old.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            summary = inject_osu_timing_points(target, self._analysis(), backup=False)
            out = target.read_text(encoding="utf-8")
        self.assertEqual(summary["reds_replaced"], 1)
        self.assertEqual(summary["greens_kept"], 1)
        self.assertNotIn("500,344.827", out)
        self.assertIn("1200,-50", out)

    def test_backup_keeps_the_pristine_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            inject_osu_timing_points(target, self._analysis())
            inject_osu_timing_points(target, self._analysis())
            spare = Path(str(target) + ".bak").read_text(encoding="utf-8")
        self.assertEqual(spare, self.LEGACY_OSU)

    def test_inject_refuses_an_empty_analysis(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(self.LEGACY_OSU, encoding="utf-8")
            with self.assertRaises(ValueError):
                inject_osu_timing_points(
                    target, SimpleNamespace(source="s", points=[], meter="4/4"))
            with self.assertRaises(ValueError):
                inject_osu_timing_points(Path(tmp) / "missing.osu", self._analysis())
            self.assertEqual(target.read_text(encoding="utf-8"), self.LEGACY_OSU)

    def test_config_tolerates_garbage(self):
        import overtone
        with tempfile.TemporaryDirectory() as tmp:
            original = overtone.CONFIG_PATH
            overtone.CONFIG_PATH = Path(tmp) / "cfg.json"
            try:
                overtone.CONFIG_PATH.write_text("[1, 2, 3]", encoding="utf-8")
                self.assertEqual(overtone.load_config(), {})
                overtone.CONFIG_PATH.write_text("{not json", encoding="utf-8")
                self.assertEqual(overtone.load_config(), {})
                overtone.save_config({"language": "English"})
                self.assertEqual(overtone.load_config(), {"language": "English"})
                # An unserialisable value must not raise, and must not corrupt
                # the file that is already there.
                overtone.save_config({"bad": object()})
                self.assertEqual(overtone.load_config(), {"language": "English"})
            finally:
                overtone.CONFIG_PATH = original

    def test_local_bpm_helper_handles_degenerate_input(self):
        self.assertEqual(len(_robust_local_bpms(np.zeros(0))), 0)
        self.assertEqual(len(_robust_local_bpms(np.array([1.0]))), 1)


def _validation_analysis(points, duration=60.0) -> Analysis:
    beats = np.arange(0.5, duration, 0.4)
    return Analysis(
        source="test", duration=duration, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=list(points),
        hop_length=512, sample_rate=22050, subdivision=1.0,
        global_bpm=150.0, stability=0.9,
        onset=np.zeros(100, dtype=np.float32), engine="precision",
        fit_residual_ms=0.4)


class ValidationTests(unittest.TestCase):
    def keys(self, analysis):
        return [(f["level"], f["key"]) for f in validate_timing_points(analysis)]

    def test_clean_map_has_no_findings_and_is_json(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        findings = validate_timing_points(analysis)
        self.assertEqual(findings, [])
        json.dumps(findings)

    def test_two_lines_within_a_beat_are_a_duplicate(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(1200.0, 120.0, 0.9, 1)])
        self.assertIn(("error", "dup_points"), self.keys(analysis))

    def test_section_shorter_than_a_bar_warns(self) -> None:
        # 150 BPM: 3 beats = 1200 ms, under the 4-beat bar.
        analysis = _validation_analysis(
            [TimingPoint(0.0, 150.0, 0.9, 0), TimingPoint(1200.0, 150.0, 0.9, 3)],
            duration=60.0)
        self.assertIn(("warn", "short_section"), self.keys(analysis))

    def test_fourfold_jump_is_impossible_but_twofold_is_a_question(self) -> None:
        impossible = _validation_analysis(
            [TimingPoint(0.0, 120.0, 0.9, 0), TimingPoint(30000.0, 500.0, 0.9, 60)])
        self.assertIn(("error", "impossible_change"), self.keys(impossible))
        halved = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 280.0, 0.9, 70)])
        keys = self.keys(halved)
        self.assertIn(("info", "octave_check"), keys)
        self.assertNotIn(("error", "impossible_change"), keys)
        drift = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 150.0, 0.9, 70)])
        self.assertNotIn(("info", "octave_check"), self.keys(drift))

    def test_bad_numbers_never_raise(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(-50.0, 120.0, 0.9, 0),
             TimingPoint(10000.0, float("nan"), 0.5, 20)])
        keys = self.keys(analysis)
        self.assertIn(("error", "negative_offset"), keys)
        self.assertIn(("error", "bad_number"), keys)
        json.dumps(validate_timing_points(analysis))
        self.assertEqual(validate_timing_points(_validation_analysis([])), [])

    def test_first_line_long_after_the_music_warns(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(70393.1, 196.5, 0.74, 150)], duration=90.0)
        late = [f for f in validate_timing_points(analysis) if f["key"] == "late_first"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0]["values"], {"line": "70.4", "beat": "0.5"})

    def test_point_past_the_end_of_the_audio_warns(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(65000.0, 150.0, 0.9, 150)],
            duration=60.0)
        self.assertIn(("warn", "past_end"), self.keys(analysis))

    def test_trailing_stub_section_warns(self) -> None:
        # Last red line two beats before the song ends.
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(59200.0, 150.0, 0.9, 145)],
            duration=60.0)
        self.assertIn(("warn", "short_section"), self.keys(analysis))

    def test_summary_carries_findings_for_cli_and_gui_details(self) -> None:
        clean = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        self.assertNotIn("Validation", analysis_summary(clean))
        dup = _validation_analysis(
            [TimingPoint(1000.0, 120.0, 0.9, 0), TimingPoint(1200.0, 120.0, 0.9, 1)])
        summary = analysis_summary(dup)
        self.assertIn("Validation (check by ear):", summary)
        self.assertIn("one is a duplicate", summary)
        halved = _validation_analysis(
            [TimingPoint(0.0, 140.0, 0.9, 0), TimingPoint(30000.0, 280.0, 0.9, 70)])
        self.assertIn("octave mistake?", analysis_summary(halved))


_MAP_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "",
    "[TimingPoints]",
    "// a comment line",
    "1000,400,4,1,0,100,1,0",
    "2000,-50,4,2,0,100,0,0",
    "3000,500",
    "4000.5,333.333333333333,4,1,0,100,1,0",
    "oops,not-a-line",
    "",
    "[HitObjects]",
    "",
])


def _write_osu(tmp: str, text: str, name: str = "map.osu") -> str:
    target = str(Path(tmp) / name)
    Path(target).write_text(text, encoding="utf-8")
    return target


def _compare_analysis(points, duration=60.0) -> Analysis:
    beats = np.arange(0.5, duration, 0.4)
    return Analysis(
        source="test", duration=duration, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=list(points),
        hop_length=512, sample_rate=22050, subdivision=1.0)


class MapReaderTests(unittest.TestCase):
    def test_reads_reds_skips_greens_and_broken_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reds = read_osu_red_lines(_write_osu(tmp, _MAP_OSU))
        self.assertEqual(len(reds), 3)
        self.assertAlmostEqual(reds[0][0], 1000.0)
        self.assertAlmostEqual(reds[0][1], 150.0)
        self.assertAlmostEqual(reds[1][0], 3000.0)  # legacy two-field line
        self.assertAlmostEqual(reds[1][1], 120.0)
        self.assertAlmostEqual(reds[2][0], 4000.5)  # lazer decimal offset
        self.assertAlmostEqual(reds[2][1], 180.0, places=4)

    def test_missing_section_missing_file_or_no_reds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                read_osu_red_lines(_write_osu(tmp, "[General]\n", name="a.osu"))
            with self.assertRaises(ValueError):
                read_osu_red_lines(str(Path(tmp) / "missing.osu"))
            greens = _write_osu(tmp, "[TimingPoints]\n2000,-50,4,2,0,100,0,0\n", name="b.osu")
            self.assertEqual(read_osu_red_lines(greens), [])

    def test_round_trip_through_the_own_exporter(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        with tempfile.TemporaryDirectory() as tmp:
            reds = read_osu_red_lines(
                _write_osu(tmp, osu_beatmap_text(analysis, "audio.mp3")))
        snapped = snap_timing_points(analysis.points)
        self.assertEqual(len(reds), len(snapped))
        for (offset, bpm), point in zip(reds, snapped):
            self.assertLessEqual(abs(offset - point.offset_ms), 0.5)  # whole-ms file
            self.assertAlmostEqual(bpm, point.bpm, places=6)


class MapCompareTests(unittest.TestCase):
    def _report(self, analysis, text):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            report = compare_map_timing(_write_osu(tmp, text), analysis)
        json.dumps(report)  # sections and findings stay plain JSON types
        return report

    def test_identical_map_is_clean(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        report = self._report(analysis, osu_beatmap_text(analysis, "audio.mp3"))
        self.assertEqual(len(report["sections"]), 2)
        for row in report["sections"]:
            self.assertLess(row["bpm_error"], 0.05)
            self.assertLessEqual(row["offset_error_ms"], 0.5)
            self.assertEqual(row["octave"], 1)
        self.assertEqual(report["findings"], [])

    def test_shifted_line_warns_with_milliseconds(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        lines = osu_beatmap_text(analysis, "audio.mp3").splitlines()
        lines = [line.replace("30500,", "30530,") if line.startswith("30500,") else line
                 for line in lines]
        report = self._report(analysis, "\n".join(lines))
        offset = [f for f in report["findings"] if f["key"] == "map_offset"]
        self.assertEqual(len(offset), 1)
        self.assertEqual(offset[0]["level"], "warn")
        self.assertEqual(offset[0]["values"], {"ms": "30.0"})

    def test_doubled_map_bpm_is_an_octave_question(self) -> None:
        analysis = _compare_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        lines = osu_beatmap_text(analysis, "audio.mp3").splitlines()
        # Halve the second line's beat length: the map runs at 2x detection.
        for n, line in enumerate(lines):
            if line.startswith("30500,"):
                fields = line.split(",")
                fields[1] = repr(float(fields[1]) / 2)
                lines[n] = ",".join(fields)
        report = self._report(analysis, "\n".join(lines))
        octave = [f for f in report["findings"] if f["key"] == "map_octave"]
        self.assertEqual(len(octave), 1)
        self.assertEqual(octave[0]["level"], "info")
        self.assertEqual(octave[0]["values"]["octave"], "x0.5")
        self.assertNotIn("map_bpm", [f["key"] for f in report["findings"]])

    def test_empty_sides_report_instead_of_crashing(self) -> None:
        greens = "[TimingPoints]\n2000,-50,4,2,0,100,0,0\n"
        report = self._report(_compare_analysis([TimingPoint(500.0, 150.0, 0.9, 0)]), greens)
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("error", "map_no_reds")])
        report = compare_map_timing("whatever.osu", _compare_analysis([]))
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("error", "no_detected")])


class FolderScanTests(unittest.TestCase):
    def _song(self, tmp: str, audio: str = "song.mp3") -> Path:
        root = Path(tmp) / "123 Artist - Title"
        root.mkdir()
        (root / audio).write_bytes(b"RIFF....")
        (root / "map [Easy].osu").write_text(
            "[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n1000,400,4,1,0,100,1,0\n",
            encoding="utf-8")
        (root / "map [Hard].osu").write_text(
            "[General]\nAudioFilename: song.mp3\n\n[TimingPoints]\n1000,500,4,1,0,100,1,0\n",
            encoding="utf-8")
        return root

    def test_finds_audio_and_difficulties_sorted(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            scan = scan_beatmap_folder(self._song(tmp))
        self.assertTrue(scan["audio"].endswith("song.mp3"))
        self.assertEqual(len(scan["beatmaps"]), 2)
        self.assertEqual(scan["beatmaps"], sorted(scan["beatmaps"]))
        self.assertTrue(scan["audio_from"].endswith("[Easy].osu"))
        json.dumps(scan)

    def test_single_audio_without_maps_is_enough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "song"
            root.mkdir()
            (root / "audio.ogg").write_bytes(b"OggS....")
            scan = scan_beatmap_folder(root)
        self.assertTrue(scan["audio"].endswith("audio.ogg"))
        self.assertEqual(scan["beatmaps"], [])
        self.assertIsNone(scan["audio_from"])

    def test_ambiguity_returns_no_audio_rather_than_guessing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "song"
            root.mkdir()
            (root / "a.mp3").write_bytes(b"ID3.....")
            (root / "b.mp3").write_bytes(b"ID3.....")
            scan = scan_beatmap_folder(root)
        self.assertIsNone(scan["audio"])

    def test_missing_named_audio_falls_back_to_the_single_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._song(tmp)
            (root / "song.mp3").unlink()
            (root / "other.wav").write_bytes(b"RIFF....")
            scan = scan_beatmap_folder(root)
        self.assertTrue(scan["audio"].endswith("other.wav"))
        self.assertIsNone(scan["audio_from"])

    def test_not_a_folder_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                scan_beatmap_folder(str(Path(tmp) / "missing"))


class BatchTests(unittest.TestCase):
    def _songs(self, tmp: str) -> Path:
        folder = Path(tmp) / "songs"
        folder.mkdir()
        _click_track(folder / "a-150.wav", bpm=150.0)
        _click_track(folder / "b-140.wav", bpm=140.0)
        (folder / "broken.wav").write_bytes(b"RIFF....")
        (folder / "notes.txt").write_text("not audio", encoding="utf-8")
        return folder

    def test_batch_reports_each_audio_and_never_stops(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            rows = analyze_batch(str(self._songs(tmp)))
        self.assertEqual([row["file"] for row in rows], ["a-150.wav", "b-140.wav", "broken.wav"])
        a, b, broken = rows
        self.assertTrue(a["ok"])
        self.assertAlmostEqual(a["global_bpm"], 150.0, delta=150.0 * 0.04)
        self.assertGreaterEqual(a["points"], 1)
        self.assertTrue(b["ok"])
        self.assertAlmostEqual(b["global_bpm"], 140.0, delta=140.0 * 0.04)
        self.assertFalse(broken["ok"])
        self.assertTrue(broken["error"])
        json.dumps(rows)

    def test_empty_folder_is_empty_and_missing_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "empty"
            empty.mkdir()
            self.assertEqual(analyze_batch(str(empty)), [])
            with self.assertRaises(ValueError):
                analyze_batch(str(Path(tmp) / "missing"))


_FULL_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "AudioLeadIn: 0",
    "Mode: 0",
    "CustomTag: keep me",
    "",
    "[Editor]",
    "Bookmarks: 1000,2000",
    "",
    "[Metadata]",
    "Title:Test",
    "Artist:Me",
    "Creator:Mapper",
    "Version:Hard",
    "",
    "[Difficulty]",
    "HPDrainRate:5",
    "CircleSize:4",
    "",
    "[Events]",
    "//Background and Video events",
    '0,0,"bg.jpg",0,0',
    "",
    "[TimingPoints]",
    "1000,400,4,1,0,100,1,0",
    "2000,-100,4,2,0,100,0,0",
    "",
    "[Colours]",
    "Combo1 : 255,0,0",
    "",
    "[HitObjects]",
    "256,192,1000,1,0,0:0:0:0:",
    "100,100,2000,2,0,B|150:150|200:100,2,120.5,2|1,0:0|0:0,0:0:0:0:",
    "256,192,5000,8,0,8000,0:0:0:0:",
    "192,192,9000,132,0,9500:0:0:0:0:",
    "broken,line",
    "",
])


class MapFullReaderTests(unittest.TestCase):
    def _read(self, text, **kwargs):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            newline = kwargs.get("newline", "\n")
            target.write_bytes(text.replace("\n", newline).encode("utf-8"))
            beatmap = read_osu_beatmap(target)
        json.dumps(beatmap)  # everything stays plain JSON types
        return beatmap

    def test_sections_and_known_keys_with_unknowns_preserved(self) -> None:
        beatmap = self._read(_FULL_OSU)
        self.assertEqual(beatmap["format"], 14)
        self.assertEqual([s["name"] for s in beatmap["sections"]],
                         ["General", "Editor", "Metadata", "Difficulty",
                          "Events", "TimingPoints", "Colours", "HitObjects"])
        self.assertEqual(beatmap["general"]["AudioFilename"], "audio.mp3")
        self.assertEqual(beatmap["general"]["CustomTag"], "keep me")
        self.assertEqual(beatmap["metadata"]["Version"], "Hard")
        self.assertEqual(beatmap["difficulty"]["CircleSize"], "4")
        colours = next(s for s in beatmap["sections"] if s["name"] == "Colours")
        self.assertEqual(colours["lines"], ["Combo1 : 255,0,0", ""])
        events = next(s for s in beatmap["sections"] if s["name"] == "Events")
        self.assertIn('0,0,"bg.jpg",0,0', events["lines"])

    def test_timing_reds_and_greens(self) -> None:
        timing = self._read(_FULL_OSU)["timing"]
        self.assertEqual(timing["reds"], [(1000.0, 150.0)])
        self.assertEqual(timing["greens"], ["2000,-100,4,2,0,100,0,0"])

    def test_hitobjects_all_kinds(self) -> None:
        objects = self._read(_FULL_OSU)["hitobjects"]
        self.assertEqual([o["kind"] for o in objects],
                         ["circle", "slider", "spinner", "hold", "unparsed"])
        circle, slider, spinner, hold, broken = objects
        self.assertEqual((circle["x"], circle["y"], circle["time"]), (256, 192, 1000))
        self.assertFalse(circle["new_combo"])
        self.assertEqual(circle["hit_sample"]["volume"], 0)
        self.assertEqual(slider["curve"], {"curve_type": "B", "points": [(150, 150), (200, 100)]})
        self.assertEqual(slider["slides"], 2)
        self.assertAlmostEqual(slider["length"], 120.5)
        self.assertEqual(slider["edge_sounds"], "2|1")
        self.assertEqual(slider["edge_sets"], "0:0|0:0")
        self.assertEqual(spinner["end_time"], 8000)
        self.assertTrue(hold["new_combo"])  # type 132 carries the combo flag
        self.assertEqual(hold["end_time"], 9500)
        self.assertEqual(broken["raw"], "broken,line")

    def test_crlf_and_missing_file(self) -> None:
        beatmap = self._read(_FULL_OSU, newline="\r\n")
        self.assertEqual(beatmap["format"], 14)
        self.assertEqual(len(beatmap["hitobjects"]), 5)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                read_osu_beatmap(str(Path(tmp) / "missing.osu"))

    def test_decimal_time_survives_as_float(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[HitObjects]\n256,192,1000.5,1,0,0:0:0:0:\n",
                              encoding="utf-8")
            objects = read_osu_beatmap(target)["hitobjects"]
        self.assertEqual(len(objects), 1)
        self.assertEqual(objects[0]["kind"], "circle")
        self.assertAlmostEqual(objects[0]["time"], 1000.5)


class MapWriterTests(unittest.TestCase):
    def _write(self, raw: bytes, name: str = "map.osu"):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / name
            target.write_bytes(raw)
            beatmap = read_osu_beatmap(target)
            out = Path(tmp) / ("out-" + name)
            info = write_osu_beatmap(out, beatmap)
            result = out.read_bytes()
        json.dumps(info)
        return beatmap, result, info

    def test_untouched_file_round_trips_byte_identical(self) -> None:
        for newline in ("\n", "\r\n"):
            raw = _FULL_OSU.replace("\n", newline).encode("utf-8")
            _beatmap, result, info = self._write(raw)
            self.assertEqual(result, raw)
            self.assertTrue(info["bytes"] > 0)
            self.assertFalse(info["backup"])  # new path: nothing to protect

    def test_bom_and_missing_trailing_newline_survive(self) -> None:
        raw = b"\xef\xbb\xbf" + _FULL_OSU.encode("utf-8")
        _beatmap, result, _info = self._write(raw)
        self.assertEqual(result, raw)
        raw = _FULL_OSU.encode("utf-8").rstrip(b"\n")
        _beatmap, result, _info = self._write(raw)
        self.assertEqual(result, raw)

    def test_set_reds_changes_only_reds_with_pristine_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            original = _FULL_OSU.encode("utf-8")
            target.write_bytes(original)
            beatmap = read_osu_beatmap(target)
            replaced = set_beatmap_reds(beatmap, ["1000,60000.000000000000,4,1,0,100,1,0"])
            self.assertEqual(replaced, 1)
            self.assertEqual(beatmap["timing"]["reds"], [(1000.0, 1.0)])
            self.assertEqual(beatmap["timing"]["greens"], ["2000,-100,4,2,0,100,0,0"])
            info = write_osu_beatmap(target, beatmap)
            self.assertTrue(info["backup"])
            kept = [line for line in target.read_text(encoding="utf-8").splitlines()
                    if line.strip() and not line.strip().startswith("//")]
            before = [line for line in original.decode("utf-8").splitlines()
                      if line.strip() and not line.strip().startswith("//")]
            self.assertEqual(len(kept), len(before))
            self.assertEqual([l for l in kept if "Combo1" in l or "bg.jpg" in l],
                             [l for l in before if "Combo1" in l or "bg.jpg" in l])
            # A second write keeps the pristine original, never the last write.
            set_beatmap_reds(beatmap, ["1000,30000.000000000000,4,1,0,100,1,0"])
            write_osu_beatmap(target, beatmap)
            self.assertEqual(Path(str(target) + ".bak").read_bytes(), original)

    def test_set_reds_without_timing_section_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\nAudioFilename: a.mp3\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                set_beatmap_reds(read_osu_beatmap(target), ["1,500,4,1,0,100,1,0"])


_CONTEXT_OSU = "\n".join([
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "",
    "[TimingPoints]",
    "1000,400,4,1,0,100,1,0",
    "",
    "[HitObjects]",
    "64,192,1000,5,0,0:0:0:0:",
    "80,192,1100,1,0,0:0:0:0:",
    "96,192,1200,1,2,2:0:0:25:",
    "400,100,1400,5,0,0:0:0:0:",
    "100,300,5000,1,0,0:0:0:0:",
    "256,192,8000,8,0,9000,0:0:0:0:",
    "",
])


class ObjectContextTests(unittest.TestCase):
    def _context(self, attacks):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(_CONTEXT_OSU, encoding="utf-8")
            beatmap = read_osu_beatmap(target)
        times = np.array(attacks, dtype=np.float64)
        rows = attack_object_context(times, np.ones(times.size), beatmap)
        json.dumps(rows)
        return rows

    def test_patterns_combos_and_sounds(self) -> None:
        rows = self._context([1.005, 1.103, 1.198, 1.402, 5.0, 8.0, 30.0])
        kinds = [r["object"]["kind"] if r["object"] else None for r in rows]
        self.assertEqual(kinds, ["circle", "circle", "circle", "circle", "circle", "spinner", None])
        self.assertEqual([r["pattern"] for r in rows],
                         ["stream", "stream", "stream", "jump", "single", "single", "none"])
        self.assertEqual([r["combo"] for r in rows], [1, 1, 1, 2, 2, 2, None])
        self.assertEqual([r["new_combo"] for r in rows],
                         [True, False, False, True, False, False, False])
        third = rows[2]
        self.assertAlmostEqual(third["object"]["dt_ms"], 2.0)
        self.assertEqual(third["spacing_prev_ms"], 100.0)
        self.assertEqual(third["spacing_next_ms"], 200.0)
        self.assertEqual(third["hitsound"]["sound"], 2)
        self.assertEqual(third["hitsound"]["sample"]["volume"], 25)
        stray = rows[6]
        self.assertIsNone(stray["object"])
        self.assertIsNone(stray["spacing_prev_ms"])
        self.assertEqual(stray["hitsound"], {})

    def test_tolerance_boundary_and_empty_map(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(_CONTEXT_OSU, encoding="utf-8")
            beatmap = read_osu_beatmap(target)
        # 1050 ms sits exactly 50 ms from the first circle: inclusive by default.
        attack = np.array([1.05])
        default = attack_object_context(attack, np.ones(1), beatmap)
        self.assertIsNotNone(default[0]["object"])
        strict = attack_object_context(attack, np.ones(1), beatmap, tolerance_ms=49.0)
        self.assertIsNone(strict[0]["object"])
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\n", encoding="utf-8")
            beatmap = read_osu_beatmap(target)
        rows = attack_object_context(np.array([1.0]), np.array([1.0]), beatmap)
        self.assertEqual([(r["pattern"], r["object"]) for r in rows], [("none", None)])


def _alignment_analysis(times, weights) -> Analysis:
    beats = np.arange(0.5, 60.0, 0.4)
    return Analysis(
        source="test", duration=60.0, beats=beats,
        local_bpms=np.full(beats.size, 150.0), points=[],
        hop_length=512, sample_rate=22050, subdivision=1.0,
        attack_times=np.asarray(times, dtype=float),
        attack_weights=np.asarray(weights, dtype=float))


def _context_beatmap(tmp: str, text: str = _CONTEXT_OSU):
    target = Path(tmp) / "map.osu"
    target.write_text(text, encoding="utf-8")
    return read_osu_beatmap(target)


class AlignmentTests(unittest.TestCase):
    def test_aligned_map_is_clean(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(tmp)
        times = [1.0, 1.1, 1.2, 1.4, 5.0, 8.0]
        report = alignment_report(
            _alignment_analysis(times, np.ones(len(times))), beatmap)
        self.assertEqual((report["objects"], report["matched"]), (6, 6))
        self.assertEqual((report["attacks"], report["covered"]), (6, 6))
        self.assertEqual(report["offenders"], [])
        self.assertEqual(report["uncovered"], [])
        self.assertEqual(report["findings"], [])
        json.dumps(report)

    def test_shifted_object_and_stray_attack_are_flagged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(
                tmp, _CONTEXT_OSU.replace("80,192,1100,", "80,192,1300,"))
        times = [1.0, 1.1, 1.2, 1.4, 5.0, 8.0, 30.0, 20.0]
        weights = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.1]
        report = alignment_report(_alignment_analysis(times, weights), beatmap)
        self.assertEqual(report["offenders"], [{"time": 1300.0, "kind": "circle", "ms": 100.0}])
        # The abandoned attack joins the stray; the weak one stays unreported.
        self.assertEqual(report["uncovered"], [1100.0, 30000.0])
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("warn", "objects_off_grid"), ("warn", "attacks_without_objects")])
        self.assertEqual(report["findings"][0]["values"], {"n": 1, "worst": 100.0})

    def test_no_attacks_reports_instead_of_inventing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            beatmap = _context_beatmap(tmp)
        report = alignment_report(_alignment_analysis([], []), beatmap)
        self.assertEqual(report["objects"], 6)
        self.assertEqual([(f["level"], f["key"]) for f in report["findings"]],
                         [("info", "no_attacks")])


class DensityTests(unittest.TestCase):
    def _report(self, text, **kwargs):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text(text, encoding="utf-8")
            report = density_report(read_osu_beatmap(target), **kwargs)
        json.dumps(report)
        return report

    def test_stream_section_reads_ten_per_second(self) -> None:
        lines = ["osu file format v14", "", "[HitObjects]"]
        lines += [f"64,192,{n * 100},1,0,0:0:0:0:" for n in range(21)]
        report = self._report("\n".join(lines) + "\n")
        self.assertEqual(report["objects"], 21)
        self.assertEqual(len(report["buckets"]), 1)
        bucket = report["buckets"][0]
        self.assertEqual((bucket["objects"], bucket["stream"]), (21, 21))
        self.assertAlmostEqual(bucket["per_second"], 4.2)
        self.assertEqual(report["peak_per_second"], 4.2)

    def test_mixed_map_splits_stream_jump_single(self) -> None:
        report = self._report(_CONTEXT_OSU)
        self.assertEqual(report["objects"], 6)
        self.assertEqual((report["stream"], report["jump"], report["single"]), (3, 1, 2))
        self.assertEqual(len(report["buckets"]), 2)
        self.assertEqual(report["buckets"][0]["objects"], 4)
        self.assertEqual(report["buckets"][1]["objects"], 2)

    def test_empty_map_and_bad_bucket(self) -> None:
        report = self._report("[General]\n")
        self.assertEqual(report, {"objects": 0, "buckets": [], "peak_per_second": 0.0,
                                  "mean_per_second": 0.0, "stream": 0, "jump": 0, "single": 0})
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "map.osu"
            target.write_text("[General]\n", encoding="utf-8")
            beatmap = read_osu_beatmap(target)
        with self.assertRaises(ValueError):
            density_report(beatmap, bucket_s=0)


def _reds_map(reds) -> dict:
    return {"timing": {"reds": list(reds), "greens": []}}


class SuggestTests(unittest.TestCase):
    def test_missing_section_is_proposed(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        suggestions = suggest_missing_lines(analysis, _reds_map([(500.0, 150.0)]))
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0]["index"], 1)
        self.assertAlmostEqual(suggestions[0]["offset_ms"], 30500.0)
        self.assertAlmostEqual(suggestions[0]["nearest_ms"], 30000.0)
        json.dumps(suggestions)

    def test_complete_and_empty_maps(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        self.assertEqual(suggest_missing_lines(
            analysis, _reds_map([(500.0, 150.0), (30500.0, 152.0)])), [])
        partial = suggest_missing_lines(analysis, _reds_map([]))
        self.assertEqual([s["index"] for s in partial], [1])
        self.assertIsNone(partial[0]["nearest_ms"])  # null, not Infinity: the JS bridge
        self.assertEqual(suggest_missing_lines(_validation_analysis([]), _reds_map([])), [])

    def test_tolerance_is_honoured_and_validated(self) -> None:
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        # 300 ms off a 394.7 ms beat: inside one beat, outside half a beat.
        beatmap = _reds_map([(500.0, 150.0), (30800.0, 152.0)])
        self.assertEqual(suggest_missing_lines(analysis, beatmap), [])
        self.assertEqual(len(suggest_missing_lines(analysis, beatmap, tolerance_beats=0.5)), 1)
        with self.assertRaises(ValueError):
            suggest_missing_lines(analysis, beatmap, tolerance_beats=0)


class JsonReportTests(unittest.TestCase):
    def test_report_carries_snapped_points_and_findings(self) -> None:
        import json
        analysis = _validation_analysis(
            [TimingPoint(500.0, 150.0, 0.9, 0), TimingPoint(30500.0, 152.0, 0.8, 70)])
        report = analysis_report(analysis)
        self.assertEqual(report["global_bpm"], 150.0)
        self.assertEqual(len(report["points"]), 2)
        self.assertEqual(report["points"][0]["offset_ms"], 500.0)
        self.assertEqual(report["findings"], [])
        json.dumps(report)

    def test_cli_json_single_file(self) -> None:
        import contextlib
        import io
        import json
        import sys
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "steady.wav"
            _click_track(wav, bpm=128.0)
            out = io.StringIO()
            with mock.patch.object(sys, "argv", ["overtone.py", str(wav), "--json"]):
                with contextlib.redirect_stdout(out):
                    main()
        report = json.loads(out.getvalue())
        self.assertAlmostEqual(report["global_bpm"], 128.0, delta=128.0 * 0.04)
        self.assertGreaterEqual(len(report["points"]), 1)

    def test_cli_json_batch_folder(self) -> None:
        import contextlib
        import io
        import json
        import sys
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            _click_track(Path(tmp) / "steady.wav", bpm=128.0)
            out = io.StringIO()
            with mock.patch.object(sys, "argv", ["overtone.py", tmp, "--json"]):
                with contextlib.redirect_stdout(out):
                    with self.assertRaises(SystemExit) as done:
                        main()
        self.assertEqual(done.exception.code, 0)
        rows = json.loads(out.getvalue())
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["ok"])


if __name__ == "__main__":
    unittest.main()
