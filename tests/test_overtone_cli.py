"""Engine tests: The command line, the logo and the product version."""
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from overtone import TimingPoint, analysis_report, main

from engine_support import (_click_track, _grid_analysis, _run_cli,
                            _validation_analysis, setUpModule, tearDownModule)  # noqa: F401


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


class CliCheckTests(unittest.TestCase):
    """``--check MAP.osu``: the modder's report for one map, from the command
    line, with an exit code a script can read (3: findings, 0: clean)."""

    @staticmethod
    def _analysis():
        analysis = _grid_analysis([(1000.0, 120.0)])
        # Attacks on the 120 BPM grid from 1 s, as the grid engine keeps them.
        analysis.attack_times = np.arange(1.0, 29.0, 0.5)
        analysis.attack_weights = np.ones_like(analysis.attack_times)
        return analysis

    @staticmethod
    def _map(tmp: str, red_ms: int) -> Path:
        lines = ["osu file format v14", "", "[General]", "AudioFilename: song.wav", "",
                 "[Difficulty]", "SliderMultiplier:1.4", "",
                 "[TimingPoints]", f"{red_ms},500,4,1,0,100,1,0", "", "[HitObjects]"]
        lines += [f"256,192,{1000 + k * 500},1,0,0:0:0:0:" for k in range(40)]
        path = Path(tmp) / "map.osu"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_a_map_off_the_music_is_reported_and_exits_3(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            osu = self._map(tmp, 1010)
            before = osu.read_bytes()
            code, out, err = _run_cli([str(Path(tmp) / "song.wav"), "--check", str(osu)],
                                      self._analysis())
            self.assertEqual(osu.read_bytes(), before)            # read only
        self.assertEqual(code, 3, err)
        self.assertRegex(out, r"\d\d:\d\d:\d\d\d")                # editor timestamps
        self.assertNotIn("500.000000000000", out)                 # no red lines on stdout

    def test_a_clean_map_exits_0(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = _run_cli([str(Path(tmp) / "song.wav"), "--check",
                                       str(self._map(tmp, 1000))], self._analysis())
        self.assertIn(code, (0, None), err)
        self.assertEqual(out.strip(), "No findings.")

    def test_json_carries_the_analysis_and_the_check(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _err = _run_cli([str(Path(tmp) / "song.wav"), "--json", "--check",
                                        str(self._map(tmp, 1010))], self._analysis())
        body = json.loads(out)
        self.assertEqual(code, 3)
        self.assertEqual(set(body), {"analysis", "check"})
        self.assertTrue(body["check"]["items"])
        self.assertIn("points", body["analysis"])

    def test_refusals(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, _out, err = _run_cli([tmp, "--check", "map.osu"], self._analysis())
            self.assertEqual(code, 2)
            self.assertIn("--check", err)
            code, _out, err = _run_cli([str(Path(tmp) / "song.wav"), "--check",
                                        str(Path(tmp) / "gone.osu")], self._analysis())
            self.assertEqual(code, 1)
            self.assertIn("Error checking", err)


class CliOutputTests(unittest.TestCase):
    def test_a_click_path_soundfile_cannot_write_is_an_error_not_a_traceback(self):
        analysis = _grid_analysis([(1000.0, 120.0)])
        with tempfile.TemporaryDirectory() as tmp:
            for click, words in ((Path(tmp) / "click", "extension"),
                                 (Path(tmp) / "no such folder" / "click.wav", "Folder not found")):
                with self.subTest(click=click.name):
                    code, out, err = _run_cli([str(Path(tmp) / "song.wav"), "--click", str(click)],
                                              analysis)
                    self.assertEqual(code, 1)
                    self.assertIn("Error writing output", out + err)
                    self.assertIn(words, out + err)

    def test_stdout_carries_only_the_timing(self):
        # `overtone.py song.mp3 > timing.txt` wrote the progress lines ahead of
        # the red lines, and "Wrote x.osz" after them -- after the JSON too.
        analysis = _grid_analysis([(1000.0, 120.0), (11000.0, 140.0)])

        def analyse(path, delta, persistence, prefer, confidence, progress, *rest, **options):
            progress("Loading and normalizing audio…")
            return analysis

        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "song.wav"
            audio.write_bytes(b"RIFF")
            osz = str(Path(tmp) / "map.osz")
            code, out, err = _run_cli([str(audio), "--osz", osz], analyse)
            self.assertEqual(code, 0)
            lines = [line for line in out.splitlines() if line]
            self.assertTrue(lines[0].startswith("// Generated"), lines[0])
            self.assertTrue(all(line.startswith("//") or line.count(",") == 7 for line in lines),
                            lines)
            self.assertIn("Loading", err)
            self.assertIn("Wrote", err)
            code, out, err = _run_cli([str(audio), "--json", "--osz", osz], analyse)
            self.assertEqual(json.loads(out)["global_bpm"], 120.0)
            code, out, err = _run_cli([str(Path(tmp) / "missing.wav")])
        self.assertEqual((code, out), (1, ""))
        self.assertIn("Error:", err)


class CliEncodingTests(unittest.TestCase):
    def test_redirected_output_takes_any_file_name(self):
        # Redirected, Windows hands Python its ANSI code page, and a Japanese
        # name in a batch row ended the run in a UnicodeEncodeError traceback.
        import io
        import sys
        from unittest import mock
        import overtone
        rows = [{"file": "東方 テスト.wav", "ok": False, "global_bpm": 0.0, "points": 0,
                 "duration": 0.0, "error": "No rhythmic pulse found"}]
        out, err = io.BytesIO(), io.BytesIO()
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sys, "argv", ["overtone.py", tmp]), \
                mock.patch.object(sys, "stdout", io.TextIOWrapper(out, encoding="cp1252")) as stdout, \
                mock.patch.object(sys, "stderr", io.TextIOWrapper(err, encoding="cp1252")), \
                mock.patch.object(overtone, "analyze_batch", return_value=rows), \
                self.assertRaises(SystemExit) as done:
            main()
        stdout.flush()
        self.assertEqual(done.exception.code, 1)               # the row failed, the run did not
        self.assertIn("東方 テスト.wav", out.getvalue().decode("utf-8"))


class CliFlagTests(unittest.TestCase):
    """A flag that cannot act is refused: --inject with the audio forgotten
    opened the window, and --title without --osz wrote nothing, both silently."""

    def test_the_audio_is_required_with_or_without_flags(self):
        # The command line is the only Python interface since the desktop
        # window was parked: no arguments is a usage error, not a window.
        for argv in (["--inject", "map.osu"], []):
            code, out, err = _run_cli(argv)
            self.assertEqual(code, 2, argv)
            self.assertIn("the following arguments are required: audio", err)
            self.assertEqual(out, "")

    def test_flags_that_need_another_flag_say_so(self):
        analysis = _grid_analysis([(1000.0, 120.0)])
        with tempfile.TemporaryDirectory() as tmp:
            audio = str(Path(tmp) / "song.wav")
            for argv, words in (([audio, "--title", "X", "--artist", "Y"], "--osz"),
                                ([audio, "--no-backup"], "--inject")):
                with self.subTest(argv=argv[1:]):
                    code, out, err = _run_cli(argv, analysis)
                    self.assertEqual((code, out), (2, ""))
                    self.assertIn(words, err)

    def test_a_folder_refuses_offsets_and_honours_the_engine(self):
        from unittest import mock
        import overtone
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = _run_cli([tmp, "--decimal-offsets", "3"])
            self.assertEqual(code, 2)
            self.assertIn("--decimal-offsets need a single audio file", err)
            with mock.patch.object(overtone, "analyze_batch", return_value=[]) as batch:
                code, out, err = _run_cli([tmp, "--engine", "legacy", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(batch.call_args.kwargs["engine"], "legacy")


class LogoIconTests(unittest.TestCase):
    """The committed window icon: every size Windows asks for, readable by the
    title bar's .NET, and drawn for its own size."""

    @staticmethod
    def _entries():
        import struct
        data = (Path(__file__).resolve().parent.parent / "assets" / "logo.ico").read_bytes()
        _, kind, count = struct.unpack("<HHH", data[:6])
        entries = {}
        for k in range(count):
            w, _h, _c, _r, _p, bpp, size, off = struct.unpack("<BBBBHHII", data[6 + 16 * k:22 + 16 * k])
            entries[w or 256] = (bpp, data[off:off + size])
        return kind, entries

    def test_every_windows_size_is_there_and_small_ones_are_bmp(self):
        kind, entries = self._entries()
        self.assertEqual(kind, 1)
        self.assertEqual(sorted(entries), [16, 20, 24, 32, 40, 48, 64, 256])
        for size, (bpp, body) in entries.items():
            with self.subTest(size=size):
                self.assertEqual(bpp, 32)
                # .NET Framework's Icon, which the title bar goes through, does
                # not read PNG frames: it fell back from 256 to 64 when tried.
                self.assertEqual(body[:4] == b"\x89PNG", size == 256)

    def test_the_16_px_frame_is_drawn_for_16_px(self):
        import struct
        _kind, entries = self._entries()
        body = entries[16][1]
        self.assertEqual(struct.unpack("<IiiHH", body[:16])[1:5], (16, 32, 1, 32))
        rows = body[40:40 + 16 * 16 * 4]

        def pixel(x, y):  # rows are stored bottom-up as BGRA
            i = ((15 - y) * 16 + x) * 4
            b, g, r, a = rows[i:i + 4]
            return r, g, b, a
        # Scaled from 256, the corner radius was larger than the icon and the
        # frame was a red corner fragment. Now: transparent rounded corners,
        # the panel colour, and the red line where it belongs.
        self.assertLess(pixel(0, 0)[3], 64)          # antialiased, mostly clear
        self.assertLess(pixel(15, 15)[3], 64)
        self.assertEqual(pixel(13, 8), (0x1E, 0x1B, 0x27, 255))
        self.assertEqual(pixel(6, 8)[:3], (0xFF, 0x5D, 0x6C))


class ProductVersionTests(unittest.TestCase):
    """Phase 10.13 (R5): every written .osu names the release, not the engine
    generation, and Overtone's own files live in one known folder.
    """

    @staticmethod
    def _paths():
        import overtone_paths
        return overtone_paths

    def test_a_checkout_reports_the_workspace_version(self) -> None:
        paths = self._paths()
        cargo = (Path(__file__).resolve().parent.parent / "Cargo.toml").read_text(encoding="utf-8")
        self.assertIn(f'version = "{paths.app_version()}"', cargo)
        self.assertNotEqual(paths.app_version(), "3.0")

    def test_overtones_own_files_live_under_local_app_data(self) -> None:
        paths = self._paths()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": tmp}):
                self.assertEqual(paths.data_root(), Path(tmp) / "Overtone")


class WatchModeTests(unittest.TestCase):
    """`--watch`: one run now, one per finished change, none per poll."""

    def test_a_change_is_analysed_once_it_holds_still(self) -> None:
        import overtone
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "song.wav"
            audio.write_bytes(b"a")
            # Each poll is a step of a scripted edit: idle, a write that
            # keeps growing for one poll, then still, then idle again.
            script = iter([None, b"ab", b"abc", None, None, None])
            runs: list[bytes] = []

            def sleep(_seconds: float) -> None:
                step = next(script, None)
                if step is not None:
                    audio.write_bytes(step)
                    stamp = os.stat(audio).st_mtime_ns + len(step) * 1_000_000
                    os.utime(audio, ns=(stamp, stamp))

            polls = iter(range(6))
            count = overtone.watch_file(audio, lambda: runs.append(audio.read_bytes()),
                                        lambda _message: None, sleep=sleep,
                                        stop=lambda: next(polls, None) is None)
            self.assertEqual(runs, [b"a", b"abc"])
            self.assertEqual(count, 2)

    def test_a_missing_file_is_waited_for(self) -> None:
        import overtone
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "song.wav"
            runs = []
            polls = iter(range(3))
            overtone.watch_file(audio, lambda: runs.append(1), lambda _message: None,
                                sleep=lambda _s: None, stop=lambda: next(polls, None) is None)
            self.assertEqual(runs, [])


if __name__ == "__main__":
    unittest.main()
