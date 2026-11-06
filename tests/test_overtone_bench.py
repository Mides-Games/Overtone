"""Engine tests: The bench and the server's tooling: deploy, measurement runs, gates, Corpus B, parity, the osu!.db audit."""
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
from bench.mapper_agreement import OsuDbFormatError, parse_osu_db

from engine_support import (_click_track, _mapset_osu, setUpModule, tearDownModule)  # noqa: F401


class DeployScriptTests(unittest.TestCase):
    """The server's updater and the root-run script that installs it."""

    DEPLOY = Path(__file__).resolve().parent.parent / "deploy"

    def test_the_setup_script_writes_the_committed_units_byte_for_byte(self):
        import re
        # Root runs this script from a copy it reviewed; it must not reach
        # back into the overtone-owned checkout for anything it installs.
        script = (self.DEPLOY / "setup-deploy-user.sh").read_bytes().decode("utf-8")
        for name in ("overtone-update.service", "overtone-update.timer"):
            found = re.search(rf"^cat > /etc/systemd/system/{re.escape(name)} <<'UNIT'\n"
                              r"(.*?)^UNIT$", script, re.S | re.M)
            self.assertIsNotNone(found, name)
            self.assertEqual(found.group(1),
                             (self.DEPLOY / name).read_bytes().decode("utf-8"), name)
        outside = re.sub(r"<<'UNIT'\n.*?^UNIT$", "", script, flags=re.S | re.M)
        code = "\n".join(line for line in outside.splitlines()
                         if not line.lstrip().startswith("#"))
        for reach in ("dirname", "/opt/overtone", "cp "):
            self.assertNotIn(reach, code, reach)

    def _update(self, api_state, active: bool = True, cloned: str = "master") -> tuple[bool, str]:
        """Run overtone-update.sh against a checkout one commit behind its
        origin's master, with systemctl and sudo stubbed, the runs API
        answering ``api_state`` (a queue, or None for no answer) and the
        script's own default branch. ``cloned`` is the branch the checkout is
        on: "experimental" is a server from before master was the only branch
        (its origin keeps an experimental at the first commit). Whether the
        checkout moved, and what the script said."""
        import shutil
        import subprocess
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        for tool in ("sh", "git", "curl"):
            if shutil.which(tool) is None:
                self.skipTest(f"{tool} is not on PATH")
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        tmp = Path(scratch.name)
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
               "GIT_CONFIG_GLOBAL": str(tmp / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}

        def git(*args, cwd=tmp):
            subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)

        upstream, checkout = tmp / "upstream", tmp / "checkout"
        git("init", "-q", "-b", "master", str(upstream))
        (upstream / "a.txt").write_text("one\n", encoding="utf-8")
        git("add", "a.txt", cwd=upstream)
        git("commit", "-q", "-m", "one", cwd=upstream)
        git("branch", "experimental", cwd=upstream)
        git("clone", "-q", "-b", cloned, str(upstream), str(checkout))
        (upstream / "a.txt").write_text("two\n", encoding="utf-8")
        git("commit", "-q", "-am", "two", cwd=upstream)

        stubs = tmp / "bin"
        stubs.mkdir()
        python = Path(sys.executable).as_posix()
        for name, body in (("systemctl", f'[ "$1" = is-active ] && exit {0 if active else 3}\n'
                                         'exit 0\n'),
                           ("sudo", "exit 0\n"),
                           ("python3", f'exec "{python}" "$@"\n')):
            (stubs / name).write_bytes(f"#!/bin/sh\n{body}".encode())
            (stubs / name).chmod(0o755)
        token = "t" * 40
        (tmp / "token").write_text(token + "\n", encoding="utf-8")

        class Runs(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 -- the base class's name
                ok = self.headers.get("Authorization") == f"Bearer {token}"
                body = json.dumps({"queue": api_state}).encode()
                self.send_response(200 if ok else 401)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        api = HTTPServer(("127.0.0.1", 0), Runs)
        port = api.server_address[1]
        if api_state is None:
            api.server_close()  # nothing listens there: no answer
        else:
            threading.Thread(target=api.serve_forever, daemon=True).start()
            self.addCleanup(api.server_close)
            self.addCleanup(api.shutdown)
        before = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, env=env,
                                capture_output=True, text=True, check=True).stdout
        env.update(PATH=str(stubs) + os.pathsep + env.get("PATH", ""),
                   OVERTONE_REPO=str(checkout),
                   OVERTONE_TOKEN_FILE=str(tmp / "token"), OVERTONE_API=f"http://127.0.0.1:{port}",
                   OVERTONE_CARGO="false")
        done = subprocess.run(["sh", str(self.DEPLOY / "overtone-update.sh")], env=env,
                              capture_output=True, text=True, timeout=120)
        after = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, env=env,
                               capture_output=True, text=True, check=True).stdout
        return before != after, done.stdout + done.stderr

    def test_the_updater_deploys_when_the_server_says_it_is_idle(self):
        moved, said = self._update({"running": None, "queued": []})
        self.assertTrue(moved, said)

    def test_the_updater_waits_while_a_run_is_going(self):
        moved, said = self._update({"running": "r1", "queued": []})
        self.assertFalse(moved, said)
        self.assertIn("a run is going", said)

    def test_the_updater_waits_when_the_running_server_does_not_answer(self):
        # Fails closed: no answer could be a server in the middle of a run.
        moved, said = self._update(None)
        self.assertFalse(moved, said)
        self.assertIn("did not say whether a run is going", said)

    def test_a_server_still_on_experimental_moves_to_master_once(self):
        # 2026-10-28: master became the only branch. A clean checkout on
        # experimental that master contains switches over and is deployed.
        moved, said = self._update({"running": None, "queued": []}, cloned="experimental")
        self.assertTrue(moved, said)
        self.assertIn("moved", said)

    def test_a_rewritten_master_moves_an_archived_checkout_and_spares_a_local_one(self):
        # 2026-10-28: master was squashed and the old history archived under
        # refs/tags/history/*. A checkout on an archived commit follows the
        # new master; a commit made on the server is still left alone.
        import shutil
        import subprocess
        for tool in ("sh", "git", "curl"):
            if shutil.which(tool) is None:
                self.skipTest(f"{tool} is not on PATH")
        for local_commit, expect_moved in ((False, True), (True, False)):
            with self.subTest(local_commit=local_commit):
                scratch = tempfile.TemporaryDirectory()
                self.addCleanup(scratch.cleanup)
                tmp = Path(scratch.name)
                env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
                       "GIT_CONFIG_GLOBAL": str(tmp / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}

                def git(*args, cwd=tmp):
                    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                                          capture_output=True, text=True).stdout.strip()

                upstream, checkout = tmp / "upstream", tmp / "checkout"
                git("init", "-q", "-b", "master", str(upstream))
                for text in ("one", "two"):
                    (upstream / "a.txt").write_text(text + "\n", encoding="utf-8")
                    git("add", "a.txt", cwd=upstream)
                    git("commit", "-q", "-m", text, cwd=upstream)
                git("clone", "-q", "-b", "master", str(upstream), str(checkout))
                if local_commit:
                    (checkout / "b.txt").write_text("server\n", encoding="utf-8")
                    git("add", "b.txt", cwd=checkout)
                    git("commit", "-q", "-m", "made on the server", cwd=checkout)
                # The rewrite: archive the old master, squash it to one root commit.
                git("tag", "history/test", "master", cwd=upstream)
                tree = git("rev-parse", "master^{tree}", cwd=upstream)
                root = git("commit-tree", tree, "-m", "squashed", cwd=upstream)
                git("update-ref", "refs/heads/master", root, cwd=upstream)
                stubs = tmp / "bin"
                stubs.mkdir()
                for name, body in (("systemctl", "[ \"$1\" = is-active ] && exit 3\nexit 0\n"), ("sudo", "exit 0\n")):
                    (stubs / name).write_bytes(f"#!/bin/sh\n{body}".encode())
                    (stubs / name).chmod(0o755)
                env.update(PATH=str(stubs) + os.pathsep + env.get("PATH", ""), OVERTONE_REPO=str(checkout),
                           OVERTONE_TOKEN_FILE=str(tmp / "none"), OVERTONE_API="http://127.0.0.1:9",
                           OVERTONE_CARGO="false")
                done = subprocess.run(["sh", str(self.DEPLOY / "overtone-update.sh")], env=env,
                                      capture_output=True, text=True, timeout=120)
                head = git("rev-parse", "HEAD", cwd=checkout)
                self.assertEqual(head == root, expect_moved, done.stdout + done.stderr)

    def test_the_updater_deploys_to_a_server_that_is_not_running(self):
        # A stopped service runs nothing, and may be waiting for this very fix.
        moved, said = self._update(None, active=False)
        self.assertTrue(moved, said)


class MeasurementRunTests(unittest.TestCase):
    """Server runs of the bench's timing stages: one at a time, each in its
    own process, kept on disk with the code that produced it."""

    def setUp(self) -> None:
        import overtone_library
        import overtone_runs
        self.runs = overtone_runs
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)
        self.songs = self.tmp / "Songs"
        self.index = self.tmp / "library.sqlite3"
        self.library = overtone_library.Library(self.index)

    @unittest.skipUnless(hasattr(os, "wait4"), "the peak comes from os.wait4")
    def test_a_run_reports_its_peak_memory_and_a_kill(self) -> None:
        import subprocess
        grow = subprocess.Popen([sys.executable, "-c", "b = bytearray(64 * 1024 * 1024)"])
        code, peak = self.runs._wait(grow)
        self.assertEqual(code, 0)
        self.assertGreaterEqual(peak, 64)
        killed = subprocess.Popen([sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"])
        self.assertEqual(self.runs._wait(killed)[0], -9)

    def _anime_song(self, folder: str) -> None:
        path = self.songs / folder
        path.mkdir(parents=True)
        _click_track(path / "audio.wav", 120.0, duration=24.0)
        text = _mapset_osu("Hard", audio="audio.wav", reds=((250, 500.0, 4),),
                           tags="anime opening", objects=(1000, 23500))
        (path / "Band - Clicks (Mapper) [Hard].osu").write_text(text, encoding="utf-8", newline="")

    def _wait(self, queue, run_id: str) -> dict:
        import time
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            meta = queue.store.meta(run_id)
            if meta["state"] not in ("queued", "running"):
                return meta
            time.sleep(0.1)
        self.fail(f"run {run_id} never ended")

    def test_a_request_becomes_the_tools_own_arguments_or_is_refused(self):
        tool, argv, settings = self.runs.build_args(
            {"tool": "stages", "stage": "anime-single", "split": "dev", "jobs": 2,
             "baseline": "compare"}, "/srv/index.sqlite3", "/srv/Songs")
        self.assertEqual(tool, "stages")
        self.assertEqual(argv, ["anime-single", "--engine", "rust", "--jobs", "2", "--db",
                                "/srv/index.sqlite3", "--split", "dev", "--compare"])
        self.assertFalse(settings["beat_vote"])
        tool, argv, _ = self.runs.build_args({"tool": "single_bpm", "sample": 50, "tv": True},
                                             "/db", "/srv/Songs")
        self.assertEqual(argv[-5:], ["--songs", "/srv/Songs", "--sample", "50", "--tv"])
        for bad in ({"tool": "rm"}, {"stage": "nope"}, {"stage": "anime-single", "jobs": 99},
                    {"stage": "anime-single", "jobs": True}, {"stage": "anime-single", "split": "all"},
                    {"stage": "anime-single", "beat_vote": "yes"}, {"stage": "anime-single",
                    "max_songs": -1}, {"stage": "anime-single", "baseline": "--refresh"}, []):
            with self.assertRaises(ValueError, msg=bad):
                self.runs.build_args(bad, "/db")

    def test_the_app_engine_falls_back_to_v3_where_rust_refuses_as_the_app_does(self):
        bench = str(Path(__file__).resolve().parent.parent / "bench")
        if bench not in sys.path:
            sys.path.insert(0, bench)
        import corpus_b
        import overtone_rust
        self.assertIn("app", self.runs.ENGINES)
        self.assertEqual(self.runs.build_args({"stage": "anime-single", "engine": "app"},
                                              "/db")[1][2], "app")
        audio = self.tmp / "clicks.wav"
        _click_track(audio, 120.0, duration=12.0)
        refusal = overtone_rust.SidecarRefused("No rhythmic pulse found", [])
        with mock.patch.object(overtone_rust, "analyze", side_effect=refusal):
            app = corpus_b.analyse(str(audio), "app", "overtone-cli")
            rust = corpus_b.analyse(str(audio), "rust", "overtone-cli")
        self.assertEqual((app["backend"], app["path"]), ("python", "precision"))
        self.assertIn("SidecarRefused", app["rust_said"])
        self.assertAlmostEqual(app["global_bpm"], 120.0, delta=0.05)
        self.assertEqual(rust["path"], "refused")      # Rust alone gives no answer
        self.assertNotEqual(corpus_b.engine_fingerprint("app", Path(__file__)),
                            corpus_b.engine_fingerprint("python", None))

    def test_an_experiment_is_named_and_switches_its_flags_in_the_run_only(self):
        _, _, settings = self.runs.build_args(
            {"stage": "anime-single", "engine": "app", "experiment": "local-fold-judge"}, "/db")
        self.assertEqual(settings["experiment"], "local-fold-judge")
        self.assertNotIn("experiment", self.runs.build_args({"stage": "anime-single"}, "/db")[2])
        with self.assertRaises(ValueError):
            self.runs.build_args({"stage": "anime-single", "experiment": "rm -rf"}, "/db")
        import overtone
        for flags in self.runs.EXPERIMENTS.values():
            for name, value in flags.items():
                # A switch or a setting, each of the engine's own type.
                self.assertIs(type(getattr(overtone, name)), type(value), name)

    def test_gates_and_the_suite_are_named_runs_and_nothing_else(self):
        tool, argv, settings = self.runs.build_args({"tool": "gates"}, "/db")
        self.assertEqual((tool, argv, settings["gates"]), ("gates", list(self.runs.GATES), "all"))
        tool, argv, settings = self.runs.build_args(
            {"tool": "gates", "only": ["golden", "benchmark"]}, "/db")
        self.assertEqual(argv, ["benchmark", "golden"])            # CLAUDE.md's order
        self.assertEqual(self.runs.build_args({"tool": "suite", "suite": "engine"}, "/db")[1],
                         ["engine"])
        for bad in ({"tool": "gates", "only": ["rm -rf"]}, {"tool": "gates", "only": "golden"},
                    {"tool": "suite", "suite": "../tests"}, {"tool": "suite", "suite": "web"}):
            with self.assertRaises(ValueError, msg=bad):
                self.runs.build_args(bad, "/db")
        # Every gate CLAUDE.md lists for Python is here, as it is written there.
        claude = (Path(__file__).resolve().parent.parent / "CLAUDE.md").read_text(encoding="utf-8")
        for command in self.runs.GATES.values():
            self.assertIn(" ".join(command), claude)

    def test_a_gates_run_reports_each_gate(self):
        import time
        store = self.runs.RunStore(self.tmp / "runs")
        queue = self.runs.RunQueue(store, self.index, self.songs)
        meta = queue.submit({"tool": "gates", "only": ["fixtures"]})
        deadline = time.monotonic() + 120
        while store.meta(meta["id"])["state"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.1)
        done = store.meta(meta["id"])
        self.assertEqual(done["state"], "done", "\n".join(store.log_tail(meta["id"])))
        self.assertEqual(done["summary"], {"checked": 1, "passed": 1, "failed": []})
        report = store.result(meta["id"])
        self.assertEqual([(r["name"], r["exit"]) for r in report["rows"]], [("fixtures", 0)])
        self.assertIn("fixtures.json matches", "\n".join(report["rows"][0]["tail"]))

    def test_ranked_runs_need_an_osu_db_and_use_it_by_default(self):
        osu_db = self.tmp / "osu!.db"
        _, argv, settings = self.runs.build_args({"stage": "anime-single"}, "/db", "", osu_db)
        self.assertNotIn("--ranked-db", argv)
        self.assertFalse(settings["ranked"])
        with self.assertRaises(ValueError):
            self.runs.build_args({"stage": "anime-single", "ranked": True}, "/db", "", osu_db)
        osu_db.write_bytes(OsuDbAuditTests._database([(4, 0)]))
        _, argv, settings = self.runs.build_args({"stage": "anime-single"}, "/db", "", osu_db)
        self.assertEqual(argv[-2:], ["--ranked-db", str(osu_db)])
        self.assertTrue(settings["ranked"])
        _, argv, _ = self.runs.build_args({"stage": "anime-single", "ranked": False}, "/db", "", osu_db)
        self.assertNotIn("--ranked-db", argv)
        with self.assertRaises(ValueError):
            self.runs.build_args({"stage": "anime-single", "ranked": "yes"}, "/db", "", osu_db)

    def test_a_ranked_stage_keeps_only_the_maps_osu_db_lists_as_ranked_or_loved(self):
        bench = str(Path(__file__).resolve().parent.parent / "bench")
        if bench not in sys.path:
            sys.path.insert(0, bench)
        import stages
        self._anime_song("1 Band - Clicks")
        self._anime_song("2 Band - Pending")
        self.library.scan(self.songs)
        osu_db = self.tmp / "osu!.db"
        name = "Band - Clicks (Mapper) [Hard].osu"
        # Ranked, and a pending map of the other song; folder case differs.
        osu_db.write_bytes(OsuDbAuditTests._database([(4, 0, "1 BAND - Clicks", name),
                                                      (2, 0, "2 Band - Pending", name)]))
        ranked, header = stages.ranked_maps(osu_db)
        self.assertEqual((len(ranked), header["version"]), (1, 20260924))
        stage = next(s for s in stages.load_manifest()["stages"] if s["id"] == "anime-single")
        every, _ = stages.build_stage(stage, self.index, 0.3)
        self.assertEqual(sorted(Path(s["folder"]).name for s in every),
                         ["1 Band - Clicks", "2 Band - Pending"])
        kept, skipped = stages.build_stage(stage, self.index, 0.3, ranked)
        self.assertEqual([Path(s["folder"]).name for s in kept], ["1 Band - Clicks"])
        self.assertEqual(skipped, ["1 maps not ranked, approved or loved in osu!.db"])

    def test_the_commit_is_read_from_the_checkout(self):
        commit = self.runs.git_commit()
        self.assertRegex(commit or "", r"^[0-9a-f]{40}$")
        self.assertIsNone(self.runs.git_commit(self.tmp))

    def test_a_run_measures_a_stage_and_keeps_its_report(self):
        import overtone_rust as rs
        if rs.find_cli() is None:
            self.skipTest("overtone-cli is not built (cargo build --release -p overtone-cli)")
        self._anime_song("1 Band - Clicks")
        self.library.scan(self.songs)
        store = self.runs.RunStore(self.tmp / "runs")
        queue = self.runs.RunQueue(store, self.index, self.songs)
        meta = queue.submit({"tool": "stages", "stage": "anime-single", "engine": "rust"})
        self.assertEqual(meta["state"], "queued")
        self.assertEqual(meta["commit"], self.runs.git_commit())
        done = self._wait(queue, meta["id"])
        log = "\n".join(store.log_tail(meta["id"]))
        self.assertEqual((done["state"], done["exit_code"]), ("done", 0), log)
        self.assertIn("Beat This! vote off", log)
        report = store.result(meta["id"])
        self.assertEqual((report["stage"]["id"], report["engine"]), ("anime-single", "rust"))
        self.assertEqual(len(report["maps"]), 1)
        self.assertTrue(report["maps"][0]["tempo_ok"], report["maps"][0])
        self.assertEqual(done["summary"], report["summary"])
        # Caches live under the store, one tree per vote setting.
        self.assertTrue(any((store.cache / "novote").rglob("*.json")))
        self.assertFalse((store.cache / "vote").exists())
        self.assertEqual([m["id"] for m in store.runs()], [meta["id"]])

    def test_runs_go_one_at_a_time_and_can_be_cancelled_or_stopped(self):
        store = self.runs.RunStore(self.tmp / "runs")
        queue = self.runs.RunQueue(store, self.tmp / "missing.sqlite3", self.songs)
        first = queue.submit({"tool": "stages", "stage": "anime-single", "engine": "python"})
        second = queue.submit({"tool": "stages", "stage": "anime-variable", "engine": "python"})
        self.assertTrue(queue.stop(second["id"]))
        self.assertEqual(store.meta(second["id"])["state"], "cancelled")
        ended = self._wait(queue, first["id"])
        # An index that is not there fails the run, and says so in its log.
        self.assertEqual(ended["state"], "failed")
        self.assertTrue(store.log_tail(first["id"]))
        self.assertFalse(queue.stop(first["id"]))
        with self.assertRaises(LookupError):
            store.meta("../../etc")
        with self.assertRaises(LookupError):
            store.result(first["id"])

    def test_a_run_the_server_died_under_is_marked_interrupted(self):
        store = self.runs.RunStore(self.tmp / "runs")
        meta = store.create({"tool": "stages"}, ["stages"])
        meta["state"] = "running"
        store.write(meta)
        self.runs.RunQueue(store, self.index, self.songs)
        self.assertEqual(store.meta(meta["id"])["state"], "interrupted")


class DiagnoseTests(unittest.TestCase):
    """bench/diagnose.py: each timing problem named, and its share of the time."""

    @classmethod
    def setUpClass(cls):
        bench = str(Path(__file__).resolve().parent.parent / "bench")
        if bench not in sys.path:
            sys.path.insert(0, bench)
        import diagnose
        cls.d = diagnose

    def problem(self, ours, truth=(0.0, 200.0)):
        return self.d.stretch_problem(0.0, 30000.0, truth, ours)

    def test_each_reading_is_named(self):
        self.assertEqual(self.problem((0.0, 200.0)), "ok")
        self.assertEqual(self.problem((4.0, 200.0)), "ok")
        self.assertEqual(self.problem((0.0, 100.0)), "half")
        self.assertEqual(self.problem((0.0, 400.0)), "double")
        self.assertEqual(self.problem((0.0, 300.0)), "ratio")
        self.assertEqual(self.problem((0.0, 175.0)), "tempo_wrong")
        self.assertEqual(self.problem((0.0, 202.0)), "bpm_slightly_off")
        self.assertEqual(self.problem((150.0, 200.0)), "offbeat")
        self.assertEqual(self.problem((18.0, 200.0)), "phase_slightly_off")
        self.assertEqual(self.problem((60.0, 200.0)), "phase_off")

    def test_time_shares_add_up_and_follow_the_lines(self):
        secs = self.d.time_problems([(0.0, 200.0)], [(0.0, 200.0), (20000.0, 100.0)], 40000.0)
        self.assertAlmostEqual(secs["ok"], 20.0)
        self.assertAlmostEqual(secs["half"], 20.0)

    def test_line_problems(self):
        step = 300.0
        truth = [(0.0, 200.0), (12000.0, 180.0)]
        self.assertEqual(dict(self.d.line_problems(truth, [(0.0, 200.0)])), {"missed_change": 1})
        late = self.d.line_problems(truth, [(0.0, 200.0), (12000.0 + 40.0, 180.0)])
        self.assertEqual(late["change_off"], 1)
        extra = self.d.line_problems(truth, [(0.0, 200.0), (6000.0, 205.0), (12000.0, 180.0)])
        self.assertEqual(extra["phantom_change"], 1)
        tick = self.d.line_problems([(0.0, 200.0)], [(0.0, 200.0), (6000.0 + 0.2 * step, 200.0)])
        self.assertEqual(tick["double_tick"], 1)
        same = self.d.line_problems([(0.0, 200.0)], [(0.0, 200.0), (6000.0, 200.0)])
        self.assertEqual(same["redundant_line"], 1)

    def test_every_song_weighs_the_same(self):
        rows = [{"offset_ms": 0.0, "bpm": 200.0, "error_ms": 0.0, "bpm_error": 0.0, "octave": 1}]
        right = {"folder": "a", "rows": rows, "lines": [[0.0, 200.0]], "duration_s": 60.0}
        half = {"folder": "b", "rows": rows, "lines": [[0.0, 100.0]], "duration_s": 60.0}
        out = self.d.diagnose([right] * 8 + [half])
        self.assertEqual(out["time"]["ok"], 50.0)
        self.assertEqual(out["time"]["half"], 50.0)


class FixtureManifestTests(unittest.TestCase):
    """Phase 23: one list of bench fixtures, for Python and Rust both."""

    @staticmethod
    def _fx():
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "fixtures", Path(__file__).resolve().parent.parent / "bench" / "fixtures.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_committed_manifest_matches_the_definitions(self) -> None:
        # The check bench/facts.py runs, here too: a case added on one side
        # and not written to the manifest fails the suite, not just the gate.
        self.assertEqual(self._fx().drift(), [])

    def test_every_python_case_is_listed_with_the_command_that_renders_it(self) -> None:
        import sys
        bench = str(Path(__file__).resolve().parent.parent / "bench")
        if bench not in sys.path:
            sys.path.insert(0, bench)
        import benchmark as bm
        import gates
        listed = self._fx().derive()
        for name in list(bm.CASES) + list(gates.COVERAGE_CASES) + list(gates.MEASURE_CASES):
            self.assertIn(name, listed, name)
            self.assertTrue(listed[name]["render"].startswith("python "), name)
        # the three coverage fixtures are the ones with no golden vector, and
        # the reason the Rust bench could not find them by walking bench/golden
        for name in gates.COVERAGE_CASES:
            self.assertFalse(listed[name]["golden"], name)
            self.assertTrue(listed[name]["density"], name)

    def test_golden_is_read_from_the_committed_vectors(self) -> None:
        listed = self._fx().derive()
        vectors = {p.stem for p in (Path(__file__).resolve().parent.parent / "bench" / "golden")
                   .glob("*.json")}
        self.assertEqual({n for n, e in listed.items() if e["golden"]}, vectors)
        # one measure case has no vector on purpose; saying otherwise here
        # would be a second list to drift
        self.assertFalse(listed["downbeat-3-4"]["golden"])

    def test_the_density_gate_measures_the_vectors_and_the_coverage_cases(self) -> None:
        listed = self._fx().derive()
        density = {n for n, e in listed.items() if e["density"]}
        golden = {n for n, e in listed.items() if e["golden"]}
        signature = {n for n, e in listed.items() if e["signature"]}
        self.assertEqual(density, (golden | {"halftime-175-87.5", "halftime-150-75",
                                             "doubletime-110-220"}) - signature)
        self.assertEqual(signature, {"signature-changes"})

    def test_drift_is_named_in_both_directions(self) -> None:
        fx = self._fx()
        listed = fx.derive()
        name = next(iter(listed))
        gone = {k: v for k, v in listed.items() if k != name}
        self.assertEqual(fx.drift(gone), [f"{name}: in the code, not in fixtures.json"])
        extra = {**listed, "made-up-case": dict(listed[name])}
        self.assertEqual(fx.drift(extra), ["made-up-case: in fixtures.json, not in the code"])
        changed = {k: dict(v) for k, v in listed.items()}
        changed[name]["density"] = not changed[name]["density"]
        self.assertEqual(len(fx.drift(changed)), 1)
        self.assertTrue(fx.drift(changed)[0].startswith(f"{name}: "))

    def test_an_older_manifest_is_not_read_as_this_one(self) -> None:
        fx = self._fx()
        body = json.loads(fx.MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(body["format"], fx.FORMAT)
        with tempfile.TemporaryDirectory() as tmp:
            older = Path(tmp) / "fixtures.json"
            older.write_text(json.dumps({**body, "format": fx.FORMAT + 1}), encoding="utf-8")
            self.assertEqual(fx.committed(older), {})
            self.assertEqual(fx.committed(Path(tmp) / "absent.json"), {})


class PerfGateTests(unittest.TestCase):
    """Phase 23: bench/gates.py perf decides on two clocks and two bars each.
    The rule is tested on numbers alone; the gate's own runs measure."""

    @staticmethod
    def _gates():
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "gates", Path(__file__).resolve().parent.parent / "bench" / "gates.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def _t(cpu, wall=None):
        return {"cpu": cpu, "wall": cpu if wall is None else wall}

    def test_every_stage_the_engine_announces_has_an_id(self) -> None:
        import re
        import overtone as ta
        source = "".join(path.read_text(encoding="utf-8")
                         for path in sorted(Path(ta.__file__).parent.glob("*.py")))
        said = re.findall(r'(?:say|progress)\("([^"]+)"', source)
        # Every message named, every name still announced, one id per stage.
        self.assertEqual(sorted(set(said)), sorted(ta.STAGES))
        self.assertEqual(len(set(ta.STAGES.values())), len(ta.STAGES))
        self.assertEqual(ta.stage_id("No fittable grid — falling back to the beat tracker… "
                                     "(ValueError: x)"), "fallback")
        self.assertIsNone(ta.stage_id("Something new…"))

    def test_the_machines_own_spread_passes(self) -> None:
        g = self._gates()
        # 1.11x was the worst an unchanged stage measured here over four runs.
        self.assertEqual(g._perf_slower(self._t(0.047), self._t(0.052)), [])
        self.assertEqual(g._perf_slower(self._t(3.766), self._t(4.180)), [])

    def test_one_bar_alone_never_fails_a_stage(self) -> None:
        g = self._gates()
        # 4x, but 0.048 s: the clock's own step, not a regression.
        self.assertEqual(g._perf_slower(self._t(0.016), self._t(0.064)), [])
        # +2 s, but 1.5x: a long stage growing with the corpus, not by an order.
        self.assertEqual(g._perf_slower(self._t(4.0), self._t(6.0)), [])

    def test_a_stage_that_burns_cpu_is_named_on_both_clocks(self) -> None:
        g = self._gates()
        reasons = g._perf_slower(self._t(0.047), self._t(2.047))
        self.assertEqual(len(reasons), 2)
        self.assertTrue(reasons[0].startswith("CPU 0.047 -> 2.047"))
        self.assertTrue(reasons[1].startswith("wall"))

    def test_a_stage_that_only_waits_is_caught_by_wall_alone(self) -> None:
        g = self._gates()
        # The case the CPU bars cannot see: a lock, a poll, a sleep.
        reasons = g._perf_slower(self._t(0.047, 0.049), self._t(0.047, 1.546))
        self.assertEqual(reasons, ["wall 0.049 -> 1.546 s"])

    def test_every_pinned_case_names_a_fixture_and_an_engine(self) -> None:
        g = self._gates()
        snapshot = json.loads(
            (Path(__file__).resolve().parent.parent / "bench" / "perf_snapshot.json")
            .read_text(encoding="utf-8"))
        self.assertEqual(snapshot["format"], g.PERF_FORMAT)
        self.assertEqual(sorted(snapshot["cases"]), sorted(g.PERF_CASES))
        engines = {case["engine"] for case in snapshot["cases"].values()}
        # both paths are pinned, so a stage of either can be held
        self.assertEqual(engines, {"precision", "legacy"})
        for name, case in snapshot["cases"].items():
            self.assertIn("total", case["stages"], name)
            for stage, clocks in case["stages"].items():
                self.assertEqual(sorted(clocks), ["cpu", "wall"], f"{name}/{stage}")


class CorpusBScoringTests(unittest.TestCase):
    """Phase 10.0: bench/corpus_b.py scores red lines against a map's, on
    made-up lines and temporary files only; the Songs folder is never read."""

    @staticmethod
    def _cb():
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "corpus_b", Path(__file__).resolve().parent.parent / "bench" / "corpus_b.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_same_grid_whole_beats_away_matches_exactly(self):
        cb = self._cb()
        # osu! runs a red line's grid both ways: 8 beats later is the same grid.
        rows = cb.score_track([(1000.0, 120.0)], [(5000.0, 120.0)])
        self.assertAlmostEqual(rows[0]["error_ms"], 0.0, places=9)
        self.assertEqual((rows[0]["octave"], rows[0]["bpm_error"]), (1.0, 0.0))

    def test_the_error_is_signed_positive_when_overtone_is_late(self):
        cb = self._cb()
        late = cb.score_track([(1000.0, 150.0)], [(1026.0, 150.0)])
        early = cb.score_track([(1000.0, 150.0)], [(1000.0 - 7.0 + 400.0, 150.0)])
        self.assertAlmostEqual(late[0]["error_ms"], 26.0, places=9)
        self.assertAlmostEqual(early[0]["error_ms"], -7.0, places=9)

    def test_a_bpm_error_shows_where_the_grid_is_run_to(self):
        cb = self._cb()
        # 0.1 % fast, anchored 100 beats away: the grid walks 60 ms by the map's line.
        rows = cb.score_track([(0.0, 100.0)], [(60000.0, 100.1)])
        beat = 60000.0 / 100.1
        self.assertAlmostEqual(rows[0]["error_ms"], 60000.0 - 100 * beat, places=6)
        self.assertAlmostEqual(rows[0]["bpm_error"], 0.1, places=9)

    def test_a_half_tempo_reading_is_split_and_counted_as_an_octave(self):
        cb = self._cb()
        # 100 BPM read for a 200 BPM map, its beats on the map's odd beats:
        # its half beats land on the line. The octave is reported, not the gap.
        rows = cb.score_track([(1000.0, 200.0)], [(1300.0, 100.0)])
        self.assertAlmostEqual(rows[0]["error_ms"], 0.0, places=9)
        self.assertEqual(rows[0]["octave"], 0.5)
        self.assertEqual(cb.tally(rows)["octaves"], {"x0.5": 1})

    def test_a_double_tempo_reading_is_used_as_it_is(self):
        cb = self._cb()
        on = cb.score_track([(1000.0, 100.0)], [(1300.0, 200.0)])
        between = cb.score_track([(1000.0, 100.0)], [(1150.0, 200.0)])
        self.assertAlmostEqual(on[0]["error_ms"], 0.0, places=9)
        self.assertEqual(on[0]["octave"], 2.0)
        self.assertAlmostEqual(abs(between[0]["error_ms"]), 150.0, places=9)

    def test_the_governing_line_takes_half_a_map_beat_of_slack(self):
        cb = self._cb()
        detected = [(0.0, 120.0), (10150.0, 150.0)]
        # At 150 BPM half a beat is 200 ms: a change found 150 ms late is still it.
        self.assertEqual(cb.governing(detected, 10000.0, 400.0), 1)
        self.assertEqual(cb.governing(detected, 9900.0, 400.0), 0)
        # Before the first detected line, that line runs backwards.
        self.assertEqual(cb.governing([(5000.0, 120.0)], 0.0, 500.0), 0)

    def test_nothing_detected_misses_every_line(self):
        cb = self._cb()
        rows = cb.score_track([(0.0, 120.0), (5000.0, 130.0)], [])
        summary = cb.tally(rows)
        self.assertEqual((summary["lines"], summary["undetected"]), (2, 2))
        self.assertEqual(summary["within"]["50"], 0)
        self.assertEqual(summary["share"]["50"], 0.0)
        self.assertIsNone(summary["error_ms"])

    def test_pooled_shares_count_lines_and_the_mean_counts_tracks(self):
        cb = self._cb()
        drift = cb.score_track([(0.0, 120.0), (2000.0, 120.0), (4000.0, 120.0)], [(0.0, 120.0)])
        single = cb.score_track([(0.0, 120.0)], [(30.0, 120.0)])
        tracks = [{"tally": cb.tally(rows), "rows": rows} for rows in (drift, single)]
        summary = cb.aggregate(tracks)
        self.assertEqual(summary["within"]["5"], 3)
        self.assertAlmostEqual(summary["share"]["5"], 0.75)
        self.assertAlmostEqual(summary["track_mean_share"]["5"], 0.5)
        self.assertEqual(summary["error_ms"]["median"], 0.0)
        json.dumps(summary)

    def test_a_shift_is_only_subtracted_when_asked(self):
        cb = self._cb()
        rows = cb.score_track([(0.0, 120.0), (4000.0, 120.0)], [(26.0, 120.0)])
        self.assertEqual(cb.tally(rows)["within"]["5"], 0)
        self.assertEqual(cb.tally(rows, shift_ms=26.0)["within"]["5"], 2)

    def test_the_osu_map_lead_moves_exported_lines_without_changing_bpm(self):
        cb = self._cb()
        raw = [(1028.0, 150.0), (5028.0, 120.0)]
        self.assertEqual(cb.apply_map_lead(raw, 0.0), raw)
        exported = cb.apply_map_lead(raw, 28.0)
        self.assertEqual(exported, [(1000.0, 150.0), (5000.0, 120.0)])
        rows = cb.score_track([(1000.0, 150.0), (5000.0, 120.0)], exported)
        self.assertEqual([row["error_ms"] for row in rows], [0.0, 0.0])
        with self.assertRaises(ValueError):
            cb.apply_map_lead(raw, float("inf"))

    def test_grid_beats_run_the_first_line_back_and_stop_at_the_next(self):
        cb = self._cb()
        beats = cb.grid_beats([(1250.0, 120.0), (3000.0, 60.0)], 6.0)
        self.assertEqual([round(b, 9) for b in beats],
                         [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.0, 4.0, 5.0])

    def test_the_sound_start_is_read_against_a_grid_to_the_millisecond(self):
        cb = self._cb()
        sr = 44100
        rng = np.random.default_rng(3)
        t = np.arange(12 * sr) / sr
        # A low bed under everything, and a hit 21 ms after every beat: the
        # ranked maps' lines sit about that far before their songs' hits.
        y = 0.2 * np.sin(2 * np.pi * 60 * t)
        beats = np.arange(0.5, 11.5, 0.5)
        n = int(0.03 * sr)
        for beat in beats:
            i = int(round((beat + 0.021) * sr))
            y[i:i + n] += rng.standard_normal(n) * np.exp(-np.arange(n) / (0.005 * sr))
        energy = cb.high_band_energy(y, sr)
        late = cb.sound_start_ms(energy, sr, beats)
        on_it = cb.sound_start_ms(energy, sr, beats + 0.021)
        self.assertAlmostEqual(late["start_ms"], 21.0, delta=1.0)
        self.assertAlmostEqual(on_it["start_ms"], 0.0, delta=1.0)
        self.assertEqual(late["beats"], beats.size)
        self.assertGreater(late["contrast"], 10.0)
        # No beat with a whole window: no reading, rather than a made-up one.
        self.assertIsNone(cb.sound_start_ms(energy, sr, [0.01, 11.95]))

    def test_a_changed_or_missing_file_is_refused_and_a_moved_set_is_found(self):
        cb = self._cb()
        with tempfile.TemporaryDirectory() as tmp:
            songs = Path(tmp)
            folder = songs / "123 Artist - Title"
            folder.mkdir()
            (folder / "map.osu").write_bytes(b"osu file format v14\r\n")
            (folder / "audio.mp3").write_bytes(b"not really audio")
            track = {"id": "t", "set_id": 123, "folder": folder.name, "osu": "map.osu",
                     "audio": "audio.mp3", "sha1_osu": cb.sha1_file(folder / "map.osu"),
                     "sha1_audio": cb.sha1_file(folder / "audio.mp3")}
            self.assertTrue(cb.locate(track, songs)["ok"])
            (folder / "audio.mp3").write_bytes(b"another encode")
            where = cb.locate(track, songs)
            self.assertFalse(where["ok"])
            self.assertIn("audio changed", where["reason"])
            (folder / "audio.mp3").write_bytes(b"not really audio")
            moved = folder.rename(songs / "123 Artist - Title (1)")
            self.assertEqual(cb.locate(track, songs)["folder"], moved)
            (moved / "map.osu").write_bytes(b"osu file format v14\r\nedited\r\n")
            self.assertFalse(cb.locate(track, songs)["ok"])

    def test_the_manifest_holds_the_plans_categories_and_twenty_tracks(self):
        cb = self._cb()
        if not cb.MANIFEST.is_file():
            self.skipTest(f"{cb.MANIFEST.name} is private and not held here (bench/local_data.py)")
        manifest = json.loads(cb.MANIFEST.read_text(encoding="utf-8"))
        tracks = manifest["tracks"]
        self.assertEqual(len(tracks), 20)
        self.assertEqual(len({t["id"] for t in tracks}), 20)
        counts = {name: sum(t["category"] == name for t in tracks)
                  for name in manifest["categories"]}
        # docs/10-precision-plan.md, "The reference set".
        self.assertEqual(counts, {"edm": 4, "rock-pop": 4, "live-drift": 4,
                                  "octave-swap": 3, "rubato-intro": 3, "signature": 2})
        for track in tracks:
            with self.subTest(track=track["id"]):
                self.assertRegex(track["sha1_osu"], r"^[0-9a-f]{40}$")
                self.assertRegex(track["sha1_audio"], r"^[0-9a-f]{40}$")
                self.assertGreater(track["set_id"], 0)
                self.assertTrue(track["folder"].startswith(f"{track['set_id']} "))
                self.assertIn(track["status"], ("ranked", "approved", "loved"))
                self.assertTrue(track["why"])


class ParityGateTests(unittest.TestCase):
    """Phase 23: bench/parity.py says which v3 guarantees the Rust engine holds.

    The manifest is the claim; these hold it to the code, and hold the gate to
    catching the three ways it can go stale."""

    @staticmethod
    def _parity():
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "parity", Path(__file__).resolve().parent.parent / "bench" / "parity.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_manifest_matches_the_engine_and_the_crates(self) -> None:
        # The gate bench/parity.py runs, here too: a stage added with no line
        # in the manifest, or a Rust test renamed out from under one, fails the
        # suite and not only the gate.
        parity = self._parity()
        self.assertEqual(
            parity.problems(parity.committed(), parity.tests(), parity.rust_tests()), [])

    def test_every_v3_test_is_placed_somewhere(self) -> None:
        parity = self._parity()
        touched = parity.tests()
        said = parity.verdict(parity.committed(), touched)
        total = sum(len(per) for per in touched.values())
        placed = len(said["held"]) + sum(len(v) for v in said["outside"].values())
        self.assertEqual(placed, total)
        # Held is the headline, so it must not be able to read high by accident:
        # a test counts as held only through a symbol the manifest calls rust.
        symbols = parity.committed()["symbols"]
        for name in said["held"]:
            cls, test = name.split(".")
            self.assertTrue(any(symbols[s]["where"] == "rust" for s in touched[cls][test]), name)

    def test_a_renamed_rust_test_is_caught(self) -> None:
        parity = self._parity()
        manifest = {"format": 1, "classes": {},
                    "symbols": {"snap_timing_points": {
                        "where": "rust", "rust": ["overtone-tempo/src/points.rs::gone"]}}}
        touched = {"T": {"test_a": {"snap_timing_points"}}}
        found = parity.problems(manifest, touched, {"overtone-tempo/src/points.rs::here"})
        self.assertTrue(any("no crate holds" in line for line in found), found)

    def test_an_untriaged_stage_and_a_stale_line_are_both_caught(self) -> None:
        parity = self._parity()
        manifest = {"format": 1, "classes": {},
                    "symbols": {"gone_from_the_tests": {"where": "shell", "why": "why"}}}
        touched = {"T": {"test_a": {"brand_new_stage"}}}
        found = parity.problems(manifest, touched, set())
        self.assertTrue(any("brand_new_stage" in line and "does not say where" in line
                            for line in found), found)
        self.assertTrue(any("gone_from_the_tests" in line and "no test touches it" in line
                            for line in found), found)

    def test_a_reason_is_required_and_the_vocabulary_is_closed(self) -> None:
        parity = self._parity()
        manifest = {"format": 1, "classes": {"Blind": {"where": "nowhere", "why": ""}},
                    "symbols": {"a": {"where": "shell"}, "b": {"where": "invented", "why": "x"},
                                "c": {"where": "rust", "rust": []}}}
        touched = {"T": {"test_a": {"a", "b", "c"}}, "Blind": {"test_b": set()}}
        found = "\n".join(parity.problems(manifest, touched, set()))
        self.assertIn("no reason given", found)
        self.assertIn("unknown 'where'", found)
        self.assertIn("no test named", found)

    def test_a_fixture_driven_test_is_placed_with_its_class(self) -> None:
        # SoundEventTests reaches the engine only through its own _events
        # helper; counting it as reaching nothing would have left 119 tests
        # unaccounted for, which is how this was found.
        parity = self._parity()
        touched = parity.tests()
        self.assertIn("sound_events", touched["SoundEventTests"]
                      ["test_circles_inherit_from_the_timing_point_then_the_map"])
        blind = {cls for cls, per in touched.items() if not any(per.values())}
        self.assertEqual(blind, set(parity.committed()["classes"]))


class OsuDbAuditTests(unittest.TestCase):
    @staticmethod
    def _string(value: str | None) -> bytes:
        if value is None:
            return b"\0"
        raw = value.encode("utf-8")
        length = len(raw)
        prefix = bytearray()
        while length >= 0x80:
            prefix.append((length & 0x7F) | 0x80)
            length >>= 7
        prefix.append(length)
        return b"\x0b" + bytes(prefix) + raw

    @classmethod
    def _record(cls, status: int, mode: int = 0, folder: str = "123 Artist - Title",
                filename: str = "Artist - Title (Mapper) [Hard].osu") -> bytes:
        strings = ("Artist", "Artist", "Title", "Title", "Mapper", "Hard",
                   "song.mp3", "hash", filename)
        row = b"".join(cls._string(value) for value in strings)
        row += struct.pack("<Bhhhqffffd", status, 100, 50, 2, 0,
                           9.0, 4.0, 5.0, 6.0, 1.6)
        row += b"\0" * 16  # four empty star-rating lists
        row += struct.pack("<iiii", 1, 1000, 800, 0)  # times and no timing points
        row += struct.pack("<iii", 321, 123, 0)  # beatmap, set, thread ids
        row += struct.pack("<BBBBh f B", 0, 0, 0, 0, 0, 0.7, mode)
        row += cls._string("") + cls._string("")
        row += struct.pack("<h", 0) + cls._string("")
        row += struct.pack("<BqB", 0, 0, 0) + cls._string(folder)
        row += struct.pack("<qBBBBB h B", 0, 0, 0, 0, 0, 0, 0, 0)
        return row + b"\0\0"  # opaque v20260924 entry extension

    @classmethod
    def _database(cls, entries: list[tuple]) -> bytes:
        """``(status, mode)`` or ``(status, mode, folder, filename)`` per map."""
        header = struct.pack("<iiBq", 20260924, 1, 0, 0) + cls._string("tester")
        return header + struct.pack("<i", len(entries)) + b"".join(
            cls._record(*entry) for entry in entries) + b"\x05\0\0\0"

    def test_reads_only_ranked_statuses_and_preserves_mode(self) -> None:
        header, maps = parse_osu_db(self._database([(4, 0), (2, 0), (7, 3)]))
        self.assertEqual(header["beatmaps"], 3)
        self.assertEqual([(row.status, row.mode) for row in maps],
                         [("ranked", 0), ("loved", 3)])

    def test_unknown_database_version_refuses(self) -> None:
        data = bytearray(self._database([(4, 0)]))
        struct.pack_into("<i", data, 0, 20260925)
        with self.assertRaises(OsuDbFormatError):
            parse_osu_db(bytes(data))

    def test_truncated_database_refuses(self) -> None:
        with self.assertRaises(OsuDbFormatError):
            parse_osu_db(self._database([(4, 0)])[:-7])


if __name__ == "__main__":
    unittest.main()
