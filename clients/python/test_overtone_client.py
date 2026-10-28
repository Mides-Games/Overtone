"""The Python client against the real API, started for the run (W13.22).

    python -m unittest discover -s clients/python -v

Not part of the main suite (tests/): it starts site/api with Node
(clients/testing/api.mjs: in memory, the fake sign-in, a stand-in worker), so
it needs Node 22 and ``pnpm install`` done. Node is ``OVERTONE_NODE`` or the
first ``node`` on PATH; without one the API tests are skipped and say so. The
429 and timeout tests use a local stand-in and run anyway.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import overtone_client as oc  # noqa: E402

TEST_API = HERE.parent / "testing" / "api.mjs"


def _node():
    return os.environ.get("OVERTONE_NODE") or shutil.which("node")


class AgainstTheApi(unittest.TestCase):
    """Uploads, waits, reads and errors on site/api itself. Four uploads of the token's ten."""

    proc = None

    @classmethod
    def setUpClass(cls):
        node = _node()
        if not node:
            raise unittest.SkipTest("no Node: set OVERTONE_NODE or put node on PATH")
        cls.proc = subprocess.Popen([node, str(TEST_API)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        deadline = time.monotonic() + 30
        info = None
        while time.monotonic() < deadline:
            line = cls.proc.stdout.readline()
            if not line:
                break
            if line.startswith("OVERTONE_TEST_API "):
                info = json.loads(line[len("OVERTONE_TEST_API "):])
                break
        if info is None:
            cls.tearDownClass()
            raise RuntimeError("the test API did not start (pnpm install done?)")
        cls.info = info
        cls.client = oc.Overtone(info["token"], info["base"], timeout=5)

    @classmethod
    def tearDownClass(cls):
        if cls.proc:
            try:
                cls.proc.stdin.close()
                cls.proc.wait(timeout=10)
            except Exception:
                cls.proc.kill()

    def test_upload_and_wait_then_read_every_way(self):
        seen = []
        row = self.client.analyze(os.urandom(512), "song-174.mp3", interval=0.03, timeout=10,
                                  on_update=lambda a: seen.append(a["status"]))
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["result"]["global_bpm"], 174)
        self.assertEqual(seen[-1], "done")
        self.assertIn("[TimingPoints]", self.client.analysis_timing_text(row["id"]))
        self.assertIn("174", self.client.analysis_timing_csv(row["id"]))
        versions = self.client.analysis_versions(row["id"])
        self.assertIsInstance(versions["readings"], list)
        ids = [a["id"] for a in self.client.all_my_analyses(limit=1)]
        self.assertIn(row["id"], ids)
        self.assertEqual(len(ids), len(set(ids)))

    def test_lookup_answers_known_audio_and_files_from_disk(self):
        data = os.urandom(400)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "from disk 150.ogg"
            path.write_bytes(data)
            first = self.client.analyze_file(path, interval=0.03, timeout=10)
        self.assertEqual(first["filename"], "from disk 150.ogg")
        self.assertEqual(first["result"]["global_bpm"], 150)
        again = self.client.upload(data, "from disk 150.ogg")
        self.assertTrue(again["cached"])

    def test_a_failed_analysis_raises_with_its_row(self):
        with self.assertRaises(oc.AnalysisFailed) as caught:
            self.client.analyze(os.urandom(256), "will-fail.mp3", interval=0.03, timeout=10)
        self.assertEqual(caught.exception.code, "ANALYSIS_FAILED")
        self.assertEqual(caught.exception.analysis["status"], "failed")

    def test_public_timings(self):
        timing_id = self.info["timingId"]
        self.assertIn(timing_id, [t["id"] for t in self.client.timings(limit=5)["timings"]])
        self.assertEqual(self.client.timing(timing_id)["bpm"], 174)
        self.assertIn("[TimingPoints]", self.client.timing_text(timing_id))
        self.assertIn("174", self.client.timing_csv(timing_id))
        self.assertTrue(self.client.me()["account"]["username"])
        self.assertEqual(self.client.health()["status"], "ok")

    def test_errors_carry_the_api_codes(self):
        with self.assertRaises(oc.NotFound) as caught:
            self.client.timing("0" * 32)
        self.assertEqual((caught.exception.status, caught.exception.code), (404, "NOT_FOUND"))
        read_only = oc.Overtone(self.info["readOnlyToken"], self.info["base"])
        with self.assertRaises(oc.PermissionDenied) as caught:
            read_only.my_analyses()
        self.assertEqual(caught.exception.code, "TOKEN_SCOPE")
        self.assertEqual(caught.exception.details["scope"], "read:analyses")
        with self.assertRaises(oc.AuthenticationError) as caught:
            oc.Overtone("ot_" + "A" * 43, self.info["base"]).me()
        self.assertEqual(caught.exception.code, "INVALID_TOKEN")
        with self.assertRaises(oc.PermissionDenied) as caught:
            self.client.request("GET", "/me/tokens")
        self.assertEqual(caught.exception.code, "TOKEN_NOT_ALLOWED")
        with self.assertRaises(oc.OvertoneError) as caught:
            self.client.upload(b"x" * 10, "notes.txt", lookup=False)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_FORMAT")


class _Stub:
    """A local server answering each request with the next of ``answers``; ``hang`` never answers."""

    def __init__(self, answers, hang=False):
        self.hits = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                stub.hits.append((time.monotonic(), self.headers.get("Authorization")))
                if hang:
                    time.sleep(2)
                    return
                status, headers, body = answers[min(len(stub.hits) - 1, len(answers) - 1)]
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


LIMITED = (429, {"Retry-After": "1"}, {"error": {"status": 429, "message": "Too many.", "code": "RATE_LIMITED"}})


class RetriesAndTimeouts(unittest.TestCase):
    def test_pure_parts(self):
        self.assertEqual(oc.api_root("https://o.test/"), "https://o.test/api/v1")
        self.assertEqual(oc.api_root("https://o.test/api/v1"), "https://o.test/api/v1")
        self.assertEqual(oc.query_of({"q": "a b", "bpmMin": 100, "x": "", "y": None}), "?q=a+b&bpmMin=100")
        self.assertEqual(oc.retry_after_seconds("7"), 7)
        self.assertIsNone(oc.retry_after_seconds("soon"))
        self.assertEqual(oc.retry_after_seconds("Thu, 01 Jan 1970 00:00:10 GMT", now=4), 6)
        with self.assertRaises(ValueError):
            oc.Overtone("nope")
        self.assertNotIn("ot_secret", repr(oc.Overtone("ot_secret")))

    def test_429_with_retry_after_is_waited_out(self):
        stub = _Stub([LIMITED, (200, {}, {"status": "ok"})])
        try:
            self.assertEqual(oc.Overtone("ot_x", stub.base).health(), {"status": "ok"})
            self.assertEqual(len(stub.hits), 2)
            self.assertGreaterEqual(stub.hits[1][0] - stub.hits[0][0], 0.95)
            self.assertEqual(stub.hits[0][1], "Bearer ot_x")
        finally:
            stub.close()

    def test_429_raised_when_retries_run_out_or_no_retry_after(self):
        stub = _Stub([LIMITED])
        try:
            with self.assertRaises(oc.RateLimited) as caught:
                oc.Overtone("ot_x", stub.base, max_retries=0).health()
            self.assertEqual((caught.exception.code, caught.exception.retry_after), ("RATE_LIMITED", 1))
            with self.assertRaises(oc.RateLimited):
                oc.Overtone("ot_x", stub.base, max_retry_wait=0.5).health()
        finally:
            stub.close()
        quota = _Stub([(429, {}, {"error": {"status": 429, "message": "Quota.", "code": "QUOTA_EXCEEDED",
                                            "details": {"limit": 50, "scope": "account"}}})])
        try:
            with self.assertRaises(oc.RateLimited) as caught:
                oc.Overtone("ot_x", quota.base).health()
            self.assertEqual(caught.exception.code, "QUOTA_EXCEEDED")
            self.assertEqual(caught.exception.details["limit"], 50)
            self.assertEqual(len(quota.hits), 1)
        finally:
            quota.close()

    def test_timeout_and_network_error(self):
        stub = _Stub([], hang=True)
        try:
            with self.assertRaises(oc.Timeout) as caught:
                oc.Overtone("ot_x", stub.base, timeout=0.2).health()
            self.assertEqual(caught.exception.code, "TIMEOUT")
        finally:
            stub.close()
        gone = _Stub([])
        base = gone.base
        gone.close()
        with self.assertRaises(oc.NetworkError) as caught:
            # Windows takes about 2 s to give up on a closed port: a wide timeout.
            oc.Overtone("ot_x", base, timeout=15).health()
        self.assertEqual(caught.exception.code, "NETWORK")

    def test_wait_gives_up_at_its_deadline(self):
        stub = _Stub([(200, {}, {"id": "a", "status": "queued", "position": 3})])
        try:
            with self.assertRaises(oc.Timeout):
                oc.Overtone("ot_x", stub.base).wait_for("a", interval=0.02, timeout=0.1)
        finally:
            stub.close()


if __name__ == "__main__":
    unittest.main()
