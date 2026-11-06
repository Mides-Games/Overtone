"""Engine tests: Audio in and the signal under the analysis: loading, stopping, memory, onsets, drums."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import (HOP, _load_audio, _onset_envelope, GridSection, osu_timing_text,
                      analyze_batch)

from engine_support import (_click_track, _drum_track, setUpModule, tearDownModule)  # noqa: F401


class StopInsideStageTests(unittest.TestCase):
    """A stop lands inside the stage it is asked in (roadmap 10.12), asked for
    nothing the engine runs as before, and a request is its own thread's."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls._tmp.name) / "drums.wav"
        _drum_track(cls.path, [(0.5, 150.0)], duration=24.0)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _stop_in(self, stage: str, engine: str) -> list[str]:
        """The stages announced when a stop asked for as soon as ``stage``
        is announced has landed."""
        import overtone as ta

        said: list[str] = []
        with ta.stop_requests(lambda: bool(said) and said[-1].startswith(stage)):
            with self.assertRaises(ta.AnalysisStopped):
                ta.analyze_audio(self.path, progress=said.append, engine=engine)
        return said

    def test_a_stop_lands_inside_every_stage_that_loops(self):
        # Before, a stop waited for the next announcement, so each of these
        # stages ran to its end first. The fallback's half/double stage has no
        # loop, and a stop in it still lands as the next stage is announced.
        for engine, stages in (("auto", ("Loading", "Detecting attacks", "Scanning pulse",
                                         "Resolving the beat octave",
                                         "Fitting tempo sections")),
                               ("legacy", ("Extracting transients", "Tracking beats",
                                           "Computing local tempo"))):
            for stage in stages:
                with self.subTest(stage=stage):
                    said = self._stop_in(stage, engine)
                    self.assertTrue(said[-1].startswith(stage), said)

    def test_a_spectrogram_block_in_runs_is_librosas_own(self):
        # The STFT a run of frames at a time, then the power and the mel
        # projection whole: librosa's own values, bit for bit.
        import librosa
        from unittest import mock

        import overtone as ta

        y, sr = _load_audio(str(self.path), lambda _message: None)
        frames, hop = 1500, ta.FIT_HOP
        segment = np.pad(y, ta.ONSET_N_FFT // 2)[:(frames - 1) * hop + ta.ONSET_N_FFT]
        whole = librosa.feature.melspectrogram(y=segment, sr=sr, n_fft=ta.ONSET_N_FFT,
                                               hop_length=hop, center=False, fmax=11025,
                                               n_mels=128)
        for run in (ta.STFT_RUN, 100, 7):             # whole runs, ragged ends, one batch
            with self.subTest(run=run), mock.patch.object(ta, "STFT_RUN", run):
                ours = librosa.feature.melspectrogram(S=ta._block_power(segment, hop), sr=sr,
                                                      n_fft=ta.ONSET_N_FFT, fmax=11025,
                                                      n_mels=128)
                self.assertTrue(np.array_equal(ours, whole))

    def test_the_octave_tempogram_in_blocks_is_librosas_own(self):
        import librosa
        from unittest import mock

        import overtone as ta

        y, sr = _load_audio(str(self.path), lambda _message: None)
        env = ta._onset_envelope(y, sr, ta.FIT_HOP)
        coarse = env[:env.size // 4 * 4].reshape(-1, 4).max(axis=1).astype(np.float32)
        whole = librosa.feature.tempogram(onset_envelope=coarse, sr=sr,
                                          hop_length=4 * ta.FIT_HOP, win_length=192)
        for columns in (None, 700):                           # several blocks, a ragged last
            with self.subTest(columns=columns), mock.patch.object(ta, "TEMPOGRAM_BLOCK", 300):
                blocks = np.concatenate(list(ta._tempogram(coarse, sr, 4 * ta.FIT_HOP, 192,
                                                           columns=columns)), axis=-1)
                self.assertTrue(np.array_equal(blocks, whole))

    def test_the_decode_in_blocks_is_the_one_calls_samples(self):
        # Several blocks and a ragged last one; lossy codecs seek between them.
        import soundfile as sf
        from unittest import mock

        import overtone as ta

        rng = np.random.default_rng(5)
        cases = [(1, "WAV", "PCM_24"), (2, "WAV", "PCM_16"), (6, "WAV", "FLOAT"),
                 (2, "OGG", "VORBIS")]
        if "MP3" in sf.available_formats():
            cases.append((2, "MP3", "MPEG_LAYER_III"))
        with tempfile.TemporaryDirectory() as tmp:
            for channels, form, subtype in cases:
                path = Path(tmp) / f"{channels}.{form.lower()}"
                data = (rng.standard_normal((44100 * 3 + 17, channels)) * 0.2).astype(np.float32)
                sf.write(str(path), data[:, 0] if channels == 1 else data, 44100,
                         format=form, subtype=subtype)
                whole, rate = sf.read(str(path), dtype="float32", always_2d=False)
                if whole.ndim == 2:
                    whole = np.mean(whole, axis=1, dtype=np.float32)
                with mock.patch.object(ta, "DECODE_BLOCK", 10_000):
                    blocks, block_rate = ta._decode(path)
                with self.subTest(form=form, channels=channels):
                    self.assertEqual(block_rate, rate)
                    self.assertEqual(blocks.dtype, np.float32)
                    self.assertTrue(np.array_equal(blocks, whole))

    def test_asked_for_nothing_the_engine_runs_as_before(self):
        import overtone as ta

        plain = ta.analyze_audio(self.path)
        asked: list[int] = []
        with ta.stop_requests(lambda: asked.append(1) or False):
            listened = ta.analyze_audio(self.path)
        self.assertGreater(len(asked), 20)
        self.assertEqual(listened.points, plain.points)
        np.testing.assert_array_equal(listened.beats, plain.beats)
        np.testing.assert_array_equal(listened.attack_times, plain.attack_times)
        np.testing.assert_array_equal(listened.onset, plain.onset)

    def test_a_checkpoint_asks_only_inside_a_request(self):
        import overtone as ta

        self.assertIsNone(ta.checkpoint())              # nothing installed: nothing
        asked: list[int] = []
        with ta.stop_requests(lambda: asked.append(1) or False):
            ta.checkpoint()
            with ta.stop_requests(lambda: True):
                with self.assertRaises(ta.AnalysisStopped):
                    ta.checkpoint()
            ta.checkpoint()                              # the outer request is back
        ta.checkpoint()                                  # and none after the block
        self.assertEqual(len(asked), 2)
        # Not an Exception: the engine's fallbacks catch those and carry on.
        self.assertFalse(issubclass(ta.AnalysisStopped, Exception))

    def test_a_stop_request_never_reaches_another_thread(self):
        import threading

        import overtone as ta

        seen: dict[str, str] = {}
        inside, release = threading.Event(), threading.Event()

        def ask(name: str) -> None:
            try:
                ta.checkpoint()
                seen[name] = "ran on"
            except ta.AnalysisStopped:
                seen[name] = "stopped"

        def stopping() -> None:
            with ta.stop_requests(lambda: True):
                child = threading.Thread(target=ask, args=("its child",))
                child.start()
                child.join()
                inside.set()
                release.wait(10)
                ask("itself")

        worker = threading.Thread(target=stopping)
        worker.start()
        self.assertTrue(inside.wait(10))
        ask("another thread")
        release.set()
        worker.join()
        self.assertEqual(seen, {"its child": "ran on", "another thread": "ran on",
                                "itself": "stopped"})


class BoundedMemoryTests(unittest.TestCase):
    """Long songs must not take gigabytes, and the blocks must not move a result.

    librosa builds a whole spectrogram for the onset envelope and a whole
    8-second tempogram (twice) for the fallback tracker. For a 5-minute song
    that peaked at 3.7 GB; two analyses at once froze a 16 GB machine. Both are
    now built in blocks that join into the same frames.
    """

    @staticmethod
    def _envelope(seconds: float = 40.0) -> tuple[np.ndarray, int]:
        import overtone as ta
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "drums.wav"
            _drum_track(path, [(0.5, 128.0), (seconds / 2, 140.0)], duration=seconds)
            y, sr = _load_audio(str(path), lambda _message: None)
        return ta._onset_envelope(y, sr, HOP), sr

    def test_blocks_rebuild_librosas_tempogram_exactly(self):
        import librosa
        from unittest import mock
        import overtone as ta
        onset, sr = self._envelope()
        with mock.patch.object(ta, "TEMPOGRAM_BLOCK", 300):   # several blocks, a ragged last one
            for win in (384, 1378):
                pieces = np.concatenate(list(ta._tempogram(onset, sr, HOP, win)), axis=-1)
                whole = librosa.feature.tempogram(onset_envelope=onset, sr=sr,
                                                  hop_length=HOP, win_length=win)
                with self.subTest(win=win):
                    self.assertTrue(np.array_equal(pieces, whole))

    def test_tempo_readings_are_librosas(self):
        import librosa
        import overtone as ta
        onset, sr = self._envelope()
        per_frame, overall = ta._tempo_readings(onset, sr, HOP)
        self.assertTrue(np.array_equal(per_frame, librosa.feature.rhythm.tempo(
            onset_envelope=onset, sr=sr, hop_length=HOP, aggregate=None, std_bpm=1.0)))
        self.assertTrue(np.array_equal(overall, librosa.feature.rhythm.tempo(
            onset_envelope=onset, sr=sr, hop_length=HOP)))

    def test_mel_blocks_match_the_one_shot_spectrogram(self):
        import librosa
        from unittest import mock
        import overtone as ta
        rng = np.random.default_rng(0)
        y = (rng.standard_normal(22050 * 8) * 0.1).astype(np.float32)
        with mock.patch.object(ta, "SPECTROGRAM_BLOCK", 500):
            pieces = ta._mel_power(y, 22050, HOP)
        whole = librosa.feature.melspectrogram(y=y, sr=22050, hop_length=HOP,
                                               fmax=11025, n_mels=128)
        self.assertEqual(pieces.shape, whole.shape)
        # Same frames; only float32 summation order in the mel projection differs.
        self.assertTrue(np.allclose(pieces, whole, rtol=1e-5, atol=1e-6 * float(whole.max())))

    def test_a_two_minute_song_stays_small(self):
        import tracemalloc
        import overtone as ta
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "long.wav"
            _drum_track(path, [(0.5, 128.0)], duration=120.0)
            y, sr = _load_audio(str(path), lambda _message: None)
        tracemalloc.start()
        try:
            start = tracemalloc.get_traced_memory()[0]
            ta._onset_envelope(y, sr, ta.FIT_HOP)
            envelope = tracemalloc.get_traced_memory()[1] - start
            onset = ta._onset_envelope(y, sr, HOP)
            tracemalloc.reset_peak()
            start = tracemalloc.get_traced_memory()[0]
            ta._global_tempo_guides(onset, sr, HOP)
            ta._track_beats_hybrid(onset, sr, HOP)
            tracker = tracemalloc.get_traced_memory()[1] - start
        finally:
            tracemalloc.stop()
        # Measured: 533 MB and 1363 MB before, 160 MB and 131 MB in blocks.
        self.assertLess(envelope / 2**20, 300)
        self.assertLess(tracker / 2**20, 400)

    def test_a_failed_envelope_is_not_swapped_for_another_in_silence(self):
        from unittest import mock
        import overtone as ta
        y = np.zeros(22050 * 3, dtype=np.float32)
        y[::5000] = 1.0
        # Out of memory mid-spectrogram: the caller hears of it. Any failure
        # used to get the flux envelope instead, and a different grid.
        with mock.patch.object(ta, "_mel_power", side_effect=MemoryError), \
                self.assertRaises(MemoryError):
            ta._onset_envelope(y, 22050, HOP)
        # What librosa refuses as audio still gets the flux envelope.
        y[100] = np.nan
        with mock.patch.object(ta, "_fast_onset_envelope",
                               wraps=ta._fast_onset_envelope) as flux:
            ta._onset_envelope(y, 22050, HOP)
        self.assertEqual(flux.call_count, 1)


class LoadErrorMessageTests(unittest.TestCase):
    """A missing, empty or junk file says which it is (roadmap Phase 22).

    All three read "Could not decode audio ... install FFmpeg", which is the
    wrong advice for every one of them.
    """

    def test_missing_empty_and_junk_files_each_get_their_own_message(self):
        import overtone as ta

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            empty = folder / "empty.wav"
            empty.write_bytes(b"")
            junk = folder / "notes.wav"
            junk.write_text("not audio at all")
            cases = {
                folder / "missing.wav": "No audio file at",
                empty: "empty.wav is empty (0 bytes)",
                junk: "Could not decode notes.wav: it is not audio",
                folder: "No audio file at",
            }
            for path, message in cases.items():
                with self.subTest(path=path.name):
                    with self.assertRaises(RuntimeError) as caught:
                        ta.analyze_audio(str(path))
                    self.assertIn(message, str(caught.exception))
                    self.assertNotIn("FFmpeg", str(caught.exception))

    def test_a_compressed_file_that_fails_still_points_at_ffmpeg(self):
        import overtone as ta

        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "song.mp3"
            fake.write_bytes(b"ID3" + bytes(64))
            with self.assertRaises(RuntimeError) as caught:
                ta.analyze_audio(str(fake))
            self.assertIn("FFmpeg", str(caught.exception))


class RustSidecarTests(unittest.TestCase):
    """The v4 engine through overtone-cli builds v3's own Analysis (Phase 22)."""

    REPORT = {
        "source": "song.wav", "duration": 10.0, "global_bpm": 150.0, "stability": 0.99,
        "meter": "4/4", "residual_ms": 0.4,
        "sections": [{"start_s": 0.5, "end_s": 9.8, "bpm": 150.0, "period_s": 0.4,
                      "phase_s": 0.5, "residual_ms": 0.4, "coverage": 0.97, "inliers": 24}],
        "evidence": {"hop": 128, "sample_rate": 44100, "onset": [0.0, 1.0, 0.5],
                     "attack_times": [0.5, 0.9], "attack_weights": [1.0, 0.6],
                     "beats": [0.5, 0.9, 1.3], "local_bpms": [150.0, 150.0, 150.0],
                     "meter_beats": 4, "downbeat_class": 0,
                     "points": [{"offset_ms": 500.25, "bpm": 150.0, "confidence": 0.98,
                                 "section": 0, "meter": 4, "meter_known": True}]},
    }

    def test_a_report_becomes_the_analysis_v3_would_store(self):
        import overtone_rust as rs

        analysis = rs.analysis_from_report(self.REPORT)
        self.assertEqual(analysis.engine, "precision")
        self.assertEqual((analysis.hop_length, analysis.sample_rate), (128, 44100))
        self.assertEqual(analysis.onset.dtype, np.float32)
        np.testing.assert_allclose(analysis.base_frames, np.array([0.5, 0.9, 1.3]) * 44100 / 128)
        point = analysis.points[0]
        self.assertEqual((point.offset_ms, point.beat_index, point.meter, point.meter_known),
                         (500.25, 0, 4, True))
        section = analysis.sections[0]
        self.assertEqual((section.period, section.phase, section.inliers), (0.4, 0.5, 24))
        self.assertIn("500,400.000000000000,4", osu_timing_text(analysis))

    def test_without_a_binary_it_says_so(self):
        from unittest import mock

        import overtone_rust as rs

        self.assertIsNone(rs.find_cli([Path("no/such/overtone-cli.exe")]))
        with mock.patch.object(rs, "find_cli", return_value=None):
            with self.assertRaises(rs.SidecarUnavailable):
                rs.analyze("song.wav")
            with self.assertRaises(rs.SidecarUnavailable):
                rs.ramps("song.wav")

    def test_the_rust_engine_reads_what_v3_reads(self):
        import overtone as ta
        import overtone_rust as rs

        if rs.find_cli() is None:
            self.skipTest("overtone-cli is not built (cargo build --release -p overtone-cli)")
        sr = 44_100
        y = np.zeros(20 * sr, dtype=np.float32)
        rng = np.random.default_rng(3)
        burst = np.exp(-np.arange(1300) / 180.0) * (rng.random(1300) - 0.5)
        for k, t in enumerate(np.arange(0.5, 19.5, 0.4)):
            start = int(t * sr)
            y[start:start + 1300] += (0.9 if k % 4 == 0 else 0.5) * burst
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clicks.wav"
            ta.sf.write(str(path), y, sr, subtype="PCM_16")
            ours, theirs = rs.analyze(path), ta.analyze_audio(str(path))
            noise = Path(tmp) / "noise.wav"
            ta.sf.write(str(noise), (rng.random(10 * sr) - 0.5).astype(np.float32), sr,
                        subtype="PCM_16")
            with self.assertRaises(rs.SidecarRefused) as refused:
                rs.analyze(noise)
        self.assertEqual(theirs.engine, "precision")
        self.assertAlmostEqual(ours.global_bpm, theirs.global_bpm, places=6)
        np.testing.assert_allclose(ours.beats, theirs.beats, atol=1e-6)
        rows = [line.split(",")[0] for line in osu_timing_text(ours).splitlines()[1:]]
        self.assertEqual(rows, [line.split(",")[0]
                                for line in osu_timing_text(theirs).splitlines()[1:]])
        self.assertIn("No rhythmic pulse", str(refused.exception))

    #: A process that would outlive every test here, standing in for the CLI.
    SLEEPER = [sys.executable, "-c", "import time; time.sleep(60)"]

    @staticmethod
    def _spied():
        """Popen as ever, keeping every process it starts."""
        import subprocess
        from unittest import mock

        started, real = [], subprocess.Popen

        def spy(*args, **kwargs):
            started.append(real(*args, **kwargs))
            return started[-1]
        return started, mock.patch.object(subprocess, "Popen", side_effect=spy)

    def test_a_stop_ends_the_sidecar_and_leaves_no_process(self):
        import time

        import overtone as ta
        import overtone_rust as rs

        started, spy = self._spied()
        asked_at = time.perf_counter() + 0.3
        with spy, ta.stop_requests(lambda: time.perf_counter() >= asked_at):
            with self.assertRaises(ta.AnalysisStopped):
                rs._run(self.SLEEPER, timeout=60)
        waited = time.perf_counter() - asked_at
        self.assertEqual(len(started), 1)
        self.assertIsNotNone(started[0].poll())         # ended, and reaped
        self.assertLess(waited, 10.0)                   # not the 60 s it sleeps

    def test_a_sidecar_past_its_timeout_is_ended_too(self):
        import overtone_rust as rs

        started, spy = self._spied()
        with spy, self.assertRaises(RuntimeError) as raised:
            rs._run(self.SLEEPER, timeout=0.5)
        self.assertIn("was stopped", str(raised.exception))
        self.assertIsNotNone(started[0].poll())

    def test_what_the_sidecar_writes_arrives_whole(self):
        # Read in slices between the stop checks, output larger than a pipe
        # holds, written across several slices, loses nothing.
        import overtone_rust as rs

        code = ("import sys, time; sys.stdout.write('x' * 1000000); sys.stdout.flush(); "
                "time.sleep(0.3); sys.stdout.write('y' * 2000000); sys.stderr.write('done')")
        done = rs._run([sys.executable, "-c", code], timeout=60)
        self.assertEqual(done.returncode, 0)
        self.assertEqual(done.stdout, b"x" * 1000000 + b"y" * 2000000)
        self.assertEqual(done.stderr, b"done")

    def test_a_sidecar_that_cannot_start_is_unavailable(self):
        import overtone_rust as rs

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(rs.SidecarUnavailable):
                rs._run([str(Path(tmp) / "overtone-cli.exe"), "analyze"], timeout=5)


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


class AnalysisEvidenceTests(unittest.TestCase):
    """Phase 19, Evidence: the engine's alternatives, octave margin included."""

    def test_a_clean_grid_names_its_octave_with_a_margin(self):
        from types import SimpleNamespace
        from overtone import GridSection, analysis_evidence
        times = np.arange(0.5, 10.0, 0.4)
        section = GridSection(0.5, 10.0, 0.4, 0.5, len(times), 0.1, 0.9)
        analysis = SimpleNamespace(attack_times=times, attack_weights=np.ones_like(times),
                                   sections=[section], engine="precision",
                                   fit_residual_ms=0.1)
        evidence = analysis_evidence(analysis)
        json.dumps(evidence)
        self.assertEqual(evidence["engine"], "precision")
        [row] = evidence["sections"]
        self.assertEqual((row["bpm"], row["residual_ms"], row["coverage"]), (150.0, 0.1, 0.9))
        seeded = row["candidates"][row["seeded"]]["bpm"]
        self.assertLess(abs(seeded / 150.0 - 1), 0.02)
        self.assertIsNotNone(row["half"])
        self.assertAlmostEqual(row["half"]["bpm"] / 75.0, 1.0, delta=0.03)
        self.assertIsNotNone(row["octave_margin"])

    def test_no_attacks_reports_that_instead_of_alternatives(self):
        from types import SimpleNamespace
        from overtone import analysis_evidence
        analysis = SimpleNamespace(attack_times=np.zeros(0), attack_weights=np.zeros(0),
                                   sections=[], engine="legacy", fit_residual_ms=0.0)
        evidence = analysis_evidence(analysis)
        json.dumps(evidence)
        self.assertEqual((evidence["sections"], evidence["note"]), ([], "no_attacks"))


class AudioFileReportTests(unittest.TestCase):
    """Phase 21, Audio file check: facts about the file plus stated bars."""

    @staticmethod
    def _tone(path: Path, gain: float, lead_s: float = 0.0, seconds: float = 4.0,
              sr: int = 44100) -> None:
        import soundfile as sfile
        n = int(seconds * sr)
        t = np.arange(n) / sr
        y = (np.sin(2 * np.pi * 440.0 * t) * gain).astype(np.float32)
        y[:int(lead_s * sr)] = 0.0
        stereo = np.stack([y, y], axis=1)
        sfile.write(str(path), stereo, sr, subtype="PCM_16")

    def test_facts_and_exact_pcm_bitrate(self) -> None:
        from overtone import audio_file_report
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.wav"
            self._tone(path, 0.5)
            report = audio_file_report(path)
            json.dumps(report)
            self.assertEqual((report["sample_rate"], report["channels"],
                              report["duration_s"], report["bitrate_kbps"],
                              report["bitrate_how"]),
                             (44100, 2, 4.0, 1411, "header"))
            self.assertAlmostEqual(report["peak_db"], -6.0, places=1)
            self.assertEqual(report["clipped_share"], 0.0)
            self.assertEqual((report["lead_ms"], report["findings"]), (0.0, []))

    def test_clipping_and_long_lead_flagged(self) -> None:
        from overtone import audio_file_report
        with tempfile.TemporaryDirectory() as tmp:
            loud = Path(tmp) / "loud.wav"
            self._tone(loud, 1.0)
            clipped = audio_file_report(loud)
            self.assertGreater(clipped["clipped_share"], 0.001)
            self.assertEqual([f["key"] for f in clipped["findings"]], ["clipping"])
            gapped = Path(tmp) / "gapped.wav"
            self._tone(gapped, 0.5, lead_s=2.5)
            lead = audio_file_report(gapped)
            self.assertGreaterEqual(lead["lead_ms"], 2400.0)
            self.assertEqual([f["key"] for f in lead["findings"]], ["long_lead"])

    def test_missing_or_empty_refuses(self) -> None:
        from overtone import audio_file_report
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                audio_file_report(Path(tmp) / "missing.wav")
            empty = Path(tmp) / "empty.wav"
            empty.write_bytes(b"")
            with self.assertRaises(ValueError):
                audio_file_report(empty)


class OffsetLabTests(unittest.TestCase):
    """Phase 19, Offset lab: the MP3's own gapless numbers from its header."""

    @staticmethod
    def _mp3(lame=True):
        frame = (b"\xff\xfb\x90\x00" + bytes(32) + b"Xing" + b"\x00\x00\x00\x0f"
                 + bytes(4 + 4 + 100 + 4))
        if lame:
            frame += b"LAME3.99r" + bytes(12) + bytes((0x84, 0x00, 100))
        return b"ID3\x04\x00\x00" + bytes(4) + frame + bytes(2000)

    def test_lame_delay_and_padding_unpack(self):
        from overtone import mp3_gapless_info
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.mp3"
            path.write_bytes(self._mp3())
            info = mp3_gapless_info(path)
        json.dumps(info)
        self.assertEqual((info["present"], info["encoder"], info["sample_rate"],
                          info["delay_samples"], info["padding_samples"]),
                         (True, "LAME3.99r", 44100, 2112, 100))
        self.assertAlmostEqual(info["delay_ms"], 2112 * 1000 / 44100, places=3)

    def test_no_lame_tag_junk_or_other_format_reports_absent(self):
        from overtone import mp3_gapless_info
        with tempfile.TemporaryDirectory() as tmp:
            bare = Path(tmp) / "bare.mp3"
            bare.write_bytes(self._mp3(lame=False))
            self.assertEqual(mp3_gapless_info(bare)["present"], False)
            junk = Path(tmp) / "junk.mp3"
            junk.write_bytes(bytes(100))
            self.assertEqual(mp3_gapless_info(junk)["present"], False)
            other = Path(tmp) / "song.wav"
            other.write_bytes(self._mp3())
            self.assertEqual(mp3_gapless_info(other)["present"], False)
            self.assertEqual(mp3_gapless_info(Path(tmp) / "missing.mp3")["present"], False)


class PercussionTests(unittest.TestCase):
    """Phase 4, percussion-only audition: the drums as playable bytes."""

    def test_percussive_stem_decodes_at_full_length(self):
        import soundfile as sf
        from overtone import percussive_wav
        sr = 44100
        t = np.arange(3 * sr) / sr
        # Clicks over a sustained hum: drums plus something to remove.
        y = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        for k in range(12):
            start = int((0.5 + k * 0.2) * sr)
            y[start:start + 400] += 0.9
        room = tempfile.TemporaryDirectory()
        self.addCleanup(room.cleanup)
        raw = percussive_wav(y, sr)
        self.assertTrue(raw.startswith(b"RIFF"))
        path = str(Path(room.name) / "perc.wav")
        with open(path, "wb") as handle:
            handle.write(raw)
        back, back_sr = sf.read(path, dtype="float32")
        self.assertEqual((len(back), back_sr), (len(y), sr))
        self.assertGreater(float(np.abs(back).max()), 0.0)


class LoudnessCurveTests(unittest.TestCase):
    """How loud the song is over time, against its own loudest moment."""

    SR = 22050

    def test_a_quiet_stretch_reads_lower_than_a_loud_one(self) -> None:
        from overtone import loudness_curve
        loud = np.ones(self.SR, dtype=np.float32) * 0.5
        quiet = np.ones(self.SR, dtype=np.float32) * 0.005     # 40 dB down
        curve, peak = loudness_curve(np.concatenate([loud, quiet]), self.SR, 20)
        self.assertEqual(curve.size, 20)
        self.assertAlmostEqual(float(curve[:10].mean()), 1.0, places=3)
        self.assertAlmostEqual(float(curve[10:].mean()), 1.0 - 40.0 / 60.0, places=2)
        self.assertAlmostEqual(peak, 10.0 * np.log10(0.25), places=2)

    def test_it_is_rms_and_not_one_loud_sample(self) -> None:
        from overtone import loudness_curve
        # A column of near-silence with one full-scale sample is a quiet
        # column; a peak reading would call it the loudest in the song.
        y = np.ones(self.SR * 2, dtype=np.float32) * 0.2
        y[self.SR + 5] = 1.0
        curve, _peak = loudness_curve(y, self.SR, 20)
        self.assertLess(float(curve.max()) - float(curve.min()), 0.05)

    def test_silence_has_no_loudest_moment_to_be_read_against(self) -> None:
        from overtone import LOUDNESS_SILENT_DB, loudness_curve
        # Normalised against its own silence it would draw a full line.
        curve, peak = loudness_curve(np.zeros(self.SR, dtype=np.float32), self.SR, 20)
        self.assertLessEqual(peak, LOUDNESS_SILENT_DB)
        self.assertEqual(float(curve.max()), 0.0)

    def test_nothing_to_read(self) -> None:
        from overtone import loudness_curve
        curve, peak = loudness_curve(np.zeros(0, dtype=np.float32), self.SR, 20)
        self.assertEqual((curve.size, peak), (0, 0.0))
        self.assertEqual(loudness_curve(np.ones(4, dtype=np.float32), self.SR, 20)[0].size, 4)


class PercussiveBlocksTests(unittest.TestCase):
    """HPSS a block at a time reads what the whole song at once reads."""

    def test_blocks_match_the_whole_song(self):
        import librosa
        import overtone
        rng = np.random.default_rng(5)
        sr = 22050
        y = (rng.standard_normal(sr * 7) * 0.1).astype(np.float32)
        y[::sr // 3] += 1.0  # clicks over noise
        whole = librosa.effects.percussive(y, margin=1.0)
        with mock.patch.object(overtone, "PERCUSSIVE_BLOCK_S", 2.0),                 mock.patch.object(overtone, "PERCUSSIVE_PAD_S", 0.5):
            blocks = overtone._percussive_blocks(y, sr, 1.0)
        self.assertEqual(blocks.shape, whole.shape)
        np.testing.assert_allclose(blocks, whole, atol=1e-6)


class PercussiveBalanceTests(unittest.TestCase):
    """How much of a moment is a hit rather than a note."""

    SR = 44100

    def _clicks(self, seconds=3.0, width=0.002):
        rng = np.random.default_rng(3)
        y = np.zeros(int(self.SR * seconds), dtype=np.float32)
        for at in range(self.SR // 2, y.size, self.SR // 2):
            k = int(self.SR * width)
            y[at:at + k] = rng.standard_normal(k).astype(np.float32)
        return y

    def _chord(self, seconds=3.0):
        t = np.arange(int(self.SR * seconds)) / self.SR
        return (sum(np.sin(2 * np.pi * f * t) for f in (220, 277, 330)) / 3).astype(np.float32)

    def test_hits_read_high_and_held_notes_read_low(self) -> None:
        from overtone import percussive_balance
        _lane, _heard, clicks = percussive_balance(self._clicks(), self.SR, 40)
        _lane, _heard, chord = percussive_balance(self._chord(), self.SR, 40)
        self.assertGreater(clicks, 0.9, "a 2 ms click is a hit")
        self.assertLess(chord, 0.2, "three held notes are notes")
        self.assertGreater(clicks - chord, 0.7)

    def test_silence_does_not_vote(self) -> None:
        from overtone import percussive_balance
        # The clicks are 2 ms every half second: unweighted, the silence
        # between them would drown them and the song would read tonal.
        _lane, _heard, loud = percussive_balance(self._clicks(), self.SR, 40)
        quiet = np.zeros(int(self.SR * 3.0), dtype=np.float32)
        quiet[:self.SR] = self._clicks(1.0)
        _lane, _heard, mixed = percussive_balance(quiet, self.SR, 40)
        self.assertGreater(loud, 0.9)
        self.assertGreater(mixed, 0.9)      # two thirds silence, same answer

    def test_the_lane_follows_the_song_where_there_is_one_to_follow(self) -> None:
        from overtone import percussive_balance
        half = np.concatenate([self._chord(2.0), self._clicks(2.0)])
        lane, heard, whole = percussive_balance(half, self.SR, 40)
        self.assertEqual((lane.size, heard.size), (40, 40))
        notes = lane[:18][heard[:18] > 0.002]
        hits = lane[22:][heard[22:] > 0.002]
        self.assertLess(float(notes.mean()), 0.25)     # notes first
        self.assertGreater(float(hits.mean()), 0.6)    # then hits
        self.assertTrue(0.0 <= whole <= 1.0)
        self.assertTrue(np.all((lane >= 0.0) & (lane <= 1.0)))

    def test_a_silent_column_is_marked_unheard_rather_than_called_tonal(self) -> None:
        from overtone import percussive_balance
        # Its share is 0, and 0 on this lane reads as "all notes" -- which
        # would be a claim about silence instead of a reading of it.
        y = np.concatenate([self._chord(2.0), np.zeros(int(self.SR * 1.0), dtype=np.float32)])
        lane, heard, _whole = percussive_balance(y, self.SR, 30)
        self.assertGreater(float(heard[:19].min()), 0.05)
        self.assertEqual(float(heard[-6:].max()), 0.0)
        self.assertEqual(float(lane[-6:].max()), 0.0)
        self.assertAlmostEqual(float(heard.max()), 1.0, places=6)

    def test_nothing_to_separate(self) -> None:
        from overtone import percussive_balance
        lane, heard, whole = percussive_balance(np.zeros(64, dtype=np.float32), self.SR, 40)
        self.assertEqual((lane.size, heard.size, whole), (0, 0, 0.0))
        lane, heard, whole = percussive_balance(np.zeros(self.SR, dtype=np.float32), self.SR, 40)
        self.assertEqual(whole, 0.0)        # silence has no balance to report
        self.assertEqual((float(lane.max()), float(heard.max())), (0.0, 0.0))


class MelImageTests(unittest.TestCase):
    """The drawn spectrogram: the analysis path's own mel, pooled and in dB."""

    def test_it_is_the_analysis_bands_in_db_under_this_songs_peak(self) -> None:
        from overtone import MEL_BANDS, MEL_TOP_DB, mel_image
        sr = 22050
        t = np.arange(int(sr * 3.0)) / sr
        tone = (np.sin(2 * np.pi * 440 * t) * np.clip((t - 0.5) / 0.25, 0, 1)).astype(np.float32)
        grid = mel_image(tone, sr, 120)
        self.assertEqual(grid.shape, (MEL_BANDS, 120))
        self.assertAlmostEqual(float(grid.max()), 0.0, places=5)   # the peak is 0 dB
        self.assertGreaterEqual(float(grid.min()), -MEL_TOP_DB - 1e-6)
        # the loudest row is the one 440 Hz lives in
        from overtone import mel_frequencies
        hz = mel_frequencies()
        self.assertAlmostEqual(float(hz[int(np.argmax(grid.max(axis=1)))]), 440.0, delta=60.0)

    def test_a_column_keeps_the_loudest_frame_under_it(self) -> None:
        from overtone import mel_image
        sr = 22050
        y = np.zeros(int(sr * 4.0), dtype=np.float32)
        y[sr * 2] = 1.0                       # one click, two seconds in
        wide = mel_image(y, sr, 8)            # eight columns over four seconds
        # pooled by max, the click's column still reaches the peak; a mean
        # over ~85 frames would have buried it
        self.assertAlmostEqual(float(wide.max()), 0.0, places=5)
        loudest = int(np.argmax(wide.max(axis=0)))
        self.assertEqual(loudest, 4, wide.max(axis=0).round(1))

    def test_the_frequency_axis_is_the_one_the_engine_listens_on(self) -> None:
        from overtone import MEL_BANDS, MEL_FMAX_HZ, mel_frequencies
        hz = mel_frequencies()
        self.assertEqual(hz.size, MEL_BANDS)
        self.assertAlmostEqual(float(hz[-1]), MEL_FMAX_HZ, delta=1.0)
        self.assertTrue(np.all(np.diff(hz) > 0))

    def test_too_little_audio(self) -> None:
        from overtone import MEL_BANDS, mel_image
        self.assertEqual(mel_image(np.zeros(64, dtype=np.float32), 22050, 100).shape,
                         (MEL_BANDS, 0))


class BandFluxTests(unittest.TestCase):
    """Seven onset-flux bands, ported from the Rust front end."""

    def test_the_edges_are_the_ported_ones(self) -> None:
        from overtone import BAND_COUNT, band_edges
        edges = band_edges()
        self.assertEqual(len(edges), BAND_COUNT + 1)
        # 40 Hz to 11.025 kHz, each band 2.23 times the last
        self.assertAlmostEqual(edges[0], 40.0, places=6)
        self.assertAlmostEqual(edges[-1], 11025.0, places=6)
        ratios = edges[1:] / edges[:-1]
        self.assertTrue(np.allclose(ratios, ratios[0]), ratios)
        self.assertAlmostEqual(float(ratios[0]), (11025.0 / 40.0) ** (1 / 7), places=9)

    def test_a_tone_moves_its_own_band(self) -> None:
        from overtone import BAND_COUNT, band_edges, band_flux
        sr, edges = 22050, band_edges()
        for band in range(BAND_COUNT):
            hz = float(np.sqrt(edges[band] * edges[band + 1]))   # mid of the band, in log
            t = np.arange(int(sr * 2.0)) / sr
            # Faded in over 250 ms on purpose: a tone switched on abruptly is a
            # broadband click with a tone after it, and at 40-89 Hz -- four and
            # a half bins wide at this n_fft -- the click wins its own band.
            tone = np.sin(2 * np.pi * hz * t) * np.clip((t - 0.5) / 0.25, 0, 1)
            flux = band_flux(tone.astype(np.float32), sr, 128)
            self.assertEqual(flux.shape[1], BAND_COUNT)
            peaks = flux.max(axis=0)
            self.assertEqual(int(np.argmax(peaks)), band, f"{hz:.0f} Hz moved {peaks}")

    def test_a_broadband_click_moves_every_band(self) -> None:
        from overtone import band_flux
        sr = 22050
        click = np.zeros(int(sr * 2.0), dtype=np.float32)
        click[sr] = 1.0
        peaks = band_flux(click, sr, 128).max(axis=0)
        self.assertTrue((peaks > 20.0).all(), peaks)

    def test_the_frames_line_up_with_the_onset_envelope(self) -> None:
        from overtone import FIT_HOP, _onset_envelope, band_flux
        from engine_support import _drum_track
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "beat.wav"
            _drum_track(path, [(0.5, 120.0)], duration=6.0)
            y, sr = __import__("soundfile").read(str(path), dtype="float32")
        y = y if y.ndim == 1 else y.mean(axis=1)
        flux = band_flux(y, sr, FIT_HOP)
        envelope = _onset_envelope(y, sr, FIT_HOP)
        # Same rows, so row k is the same moment in both curves -- and the two
        # curves agree on where that is: their correlation peaks at no lag.
        self.assertEqual(flux.shape[0], envelope.size)
        a = flux.sum(axis=1) - flux.sum(axis=1).mean()
        b = envelope - envelope.mean()
        lags = range(-6, 7)
        scores = [float(np.dot(a, np.roll(b, lag))) for lag in lags]
        self.assertEqual(list(lags)[int(np.argmax(scores))], 0, scores)

    def test_silence_and_too_little_audio(self) -> None:
        from overtone import BAND_COUNT, band_flux
        quiet = band_flux(np.zeros(22050, dtype=np.float32), 22050, 128)
        self.assertEqual(quiet.shape[1], BAND_COUNT)
        self.assertEqual(float(quiet.max()), 0.0)     # a floor everywhere is no flux
        self.assertEqual(band_flux(np.zeros(64, dtype=np.float32), 22050, 128).shape,
                         (0, BAND_COUNT))


class StemsDrumsTests(unittest.TestCase):
    """STEMS_DRUMS: the drums stem from the stemsplit CLI, or a clear failure."""

    def setUp(self):
        import overtone
        self.ta = overtone
        self.y = (np.sin(np.arange(22050) * 0.05) * 0.5).astype(np.float32)

    def test_missing_separator_fails_instead_of_measuring_the_mix(self):
        with mock.patch.object(self.ta, "STEMS_DRUMS", True),                 mock.patch.object(self.ta, "STEMSPLIT_CLI", "no-such-stemsplit-binary"):
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                self.ta._percussive(self.y, 22050)

    def test_off_leaves_the_audio_alone(self):
        self.assertIs(self.ta._percussive(self.y, 22050), self.y)

    @unittest.skipUnless(os.environ.get("STEMSPLIT_CLI") and os.environ.get("STEMSPLIT_MODEL"),
                         "needs STEMSPLIT_CLI and STEMSPLIT_MODEL")
    def test_drums_come_back_mono_at_the_input_length(self):
        with mock.patch.object(self.ta, "STEMS_DRUMS", True),                 mock.patch.object(self.ta, "STEMSPLIT_CLI", os.environ["STEMSPLIT_CLI"]),                 mock.patch.object(self.ta, "STEMSPLIT_MODEL", os.environ["STEMSPLIT_MODEL"]):
            out = self.ta._percussive(self.y, 22050)
        self.assertEqual(out.shape, self.y.shape)
        self.assertLessEqual(float(np.max(np.abs(out))), 1.0 + 1e-6)


class EngineLayoutTests(unittest.TestCase):
    """The engine is a package of stage modules; ``overtone`` still behaves as
    the one module it was, for every name a test or an experiment sets."""

    def test_every_name_set_on_overtone_reaches_its_module_and_comes_back(self):
        import overtone as ta
        marker = object()
        for name, module in ta._OWNER.items():
            original = getattr(module, name)
            with mock.patch.object(ta, name, marker):
                self.assertIs(getattr(module, name), marker, name)
                self.assertIs(getattr(ta, name), marker, name)
            self.assertIs(getattr(module, name), original, name)
            self.assertNotIn(name, vars(ta), name)

    def test_a_flag_set_by_name_is_what_the_engine_reads(self):
        import overtone as ta
        with mock.patch.object(ta, "OCTAVE_CAP", False):
            self.assertFalse(ta.params.OCTAVE_CAP)
        setattr(ta, "DBN_TRACKER", True)
        try:
            self.assertTrue(ta.params.DBN_TRACKER)
        finally:
            setattr(ta, "DBN_TRACKER", False)

    def test_a_patched_stage_is_the_one_its_callers_call(self):
        import overtone as ta
        with mock.patch.object(ta, "_load_audio", side_effect=RuntimeError("patched")):
            with self.assertRaisesRegex(RuntimeError, "patched"):
                ta.analyze_audio("song.ogg")


if __name__ == "__main__":
    unittest.main()
