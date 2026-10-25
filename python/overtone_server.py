"""Overtone's library API: a Songs folder's index and BPM cache over HTTP.

For a machine that holds the Songs folder and analyses it on its own, such
as a server: ``scan`` brings the index in step with the folder, ``analyze``
reads every song's audio once and keeps the result (``Library.analyze``),
and ``songs`` searches the index with each map's cached analysis beside it.
Long runs are background jobs, one of each at a time, polled with
``status``; a run stopped or cut short keeps what it finished.

It is the standard library's threaded HTTP server, JSON in and out, and
nothing else: no framework, no outbound connection. Every request carries
``Authorization: Bearer <token>``. It listens on 127.0.0.1 unless told
otherwise; reach it through an SSH tunnel, or put a TLS proxy in front
before exposing it (docs/server.md).

    python python/overtone_server.py --songs /srv/osu/Songs

Endpoints:

    GET  /api/status                   index, cache counts, jobs, engine
    POST /api/scan                     start a scan of the Songs folder
    POST /api/analyze  {"limit": n}    start analysing what is not cached
    POST /api/stop                     ask the running analysis to stop
    GET  /api/songs?q=text&limit=n     search, each map with its analysis
    GET  /api/analysis?path=<audio>    one audio file's cached analysis
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import overtone as ta
import overtone_library
import overtone_rust
from overtone_paths import data_root

#: Where a generated token is kept, so a restart keeps the clients working.
TOKEN_FILE = "api-token"
#: The token is read from here before any file.
TOKEN_ENV = "OVERTONE_API_TOKEN"
#: The largest request body read; every request body is a small JSON object.
MAX_BODY = 64 * 1024



class Job:
    """One background run (a scan or an analysis): at most one at a time,
    its progress and its last result readable while it runs."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.stop = threading.Event()
        self._lock = threading.Lock()
        self._state = {"running": False, "done": 0, "total": 0, "started_at": None,
                       "finished_at": None, "result": None, "error": None}

    def state(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self, work) -> bool:
        """Run ``work(progress, stop)`` on its own thread; False when one is
        already running."""
        with self._lock:
            if self._state["running"]:
                return False
            self._state.update(running=True, done=0, total=0, result=None, error=None,
                               started_at=overtone_library._now(), finished_at=None)
        self.stop.clear()
        threading.Thread(target=self._run, args=(work,), name=f"overtone-{self.name}",
                         daemon=True).start()
        return True

    def _progress(self, done, total, *_rest) -> None:
        with self._lock:
            self._state.update(done=int(done), total=int(total))

    def _run(self, work) -> None:
        result = error = None
        try:
            result = work(self._progress, self.stop)
        except Exception as exc:  # reported through status, never lost in a thread
            error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        with self._lock:
            self._state.update(running=False, result=result, error=error,
                               finished_at=overtone_library._now())


class Service:
    """What the endpoints do, apart from HTTP so the tests can call it."""

    def __init__(self, songs: str | os.PathLike[str], index: str | os.PathLike[str] | None = None,
                 engine: str | None = None, jobs: int | None = None) -> None:
        self.songs = os.path.abspath(songs)
        self.library = overtone_library.Library(index)
        self.engine = engine
        self.jobs = jobs
        self.scan_job = Job("scan")
        self.analyze_job = Job("analyze")

    def status(self) -> dict:
        cli = overtone_rust.find_cli()
        return {"songs": self.songs, "index": self.library.stats(),
                "analysis": self.library.analysis_counts(),
                "engine": self.engine or ("rust" if cli is not None else "python"),
                "beat_vote": overtone_library.beat_vote(load=False),
                "rust_cli": str(cli) if cli is not None else None,
                "jobs": {"scan": self.scan_job.state(), "analyze": self.analyze_job.state()}}

    def scan(self) -> tuple[int, dict]:
        started = self.scan_job.start(
            lambda progress, _stop: self.library.scan(self.songs, progress))
        return self._started(started, "scan")

    def analyze(self, limit=None) -> tuple[int, dict]:
        if limit is not None:
            try:
                limit = max(0, int(limit))
            except (TypeError, ValueError):
                return HTTPStatus.BAD_REQUEST, {"error": "limit must be a whole number."}
        if self.scan_job.state()["running"]:
            return HTTPStatus.CONFLICT, {"error": "A scan is running; analyse once it ends."}
        started = self.analyze_job.start(
            lambda progress, stop: self.library.analyze(self.engine, progress, limit, stop,
                                                        self.jobs))
        return self._started(started, "analyze")

    def stop(self) -> tuple[int, dict]:
        if not self.analyze_job.state()["running"]:
            return HTTPStatus.OK, {"stopping": False}
        self.analyze_job.stop.set()
        return HTTPStatus.ACCEPTED, {"stopping": True}

    def _started(self, started: bool, name: str) -> tuple[int, dict]:
        if not started:
            return HTTPStatus.CONFLICT, {"error": f"A {name} is already running."}
        return HTTPStatus.ACCEPTED, {"started": name}

    def songs_search(self, text: str = "", limit=overtone_library.SEARCH_LIMIT) -> tuple[int, dict]:
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            return HTTPStatus.BAD_REQUEST, {"error": "limit must be a whole number."}
        found = self.library.search(text, limit)
        audio = {}
        for group in found["sets"]:
            for beatmap in group["beatmaps"]:
                if beatmap["audio_file"]:
                    audio[beatmap["id"]] = os.path.join(group["folder"], beatmap["audio_file"])
        cached = self.library.analyses(audio.values())
        for group in found["sets"]:
            for beatmap in group["beatmaps"]:
                path = audio.get(beatmap["id"])
                beatmap["audio_path"] = path
                beatmap["analysis"] = cached.get(path) if path else None
        return HTTPStatus.OK, found

    def analysis(self, path: str) -> tuple[int, dict]:
        if not path:
            return HTTPStatus.BAD_REQUEST, {"error": "path is required."}
        found = self.library.analyses([path]).get(path)
        if found is None:
            return HTTPStatus.NOT_FOUND, {"error": "No analysis of that audio is cached."}
        return HTTPStatus.OK, found


def load_token(explicit_file: str | None = None) -> str:
    """The bearer token: the environment's, else the file's, else a new one
    written to Overtone's data folder (readable by its owner only)."""
    if os.environ.get(TOKEN_ENV):
        return os.environ[TOKEN_ENV].strip()
    path = Path(explicit_file) if explicit_file else data_root() / TOKEN_FILE
    if path.is_file():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    print(f"overtone-server: a new API token was written to {path}", file=sys.stderr)
    return token


def make_handler(service: Service, token: str, log: bool = True):
    expected = f"Bearer {token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "Overtone"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 -- the base class's name
            if not log:
                return
            sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.address_string()} "
                             f"{format % args}\n")

        def _reply(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorised(self) -> bool:
            given = (self.headers.get("Authorization") or "").encode()
            if hmac.compare_digest(given, expected):
                return True
            self._reply(HTTPStatus.UNAUTHORIZED, {"error": "A valid bearer token is required."})
            return False

        def _body(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self._reply(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Body too large."})
                return None
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = None
            if not isinstance(body, dict):
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "The body must be a JSON object."})
                return None
            return body

        def _handle(self, method: str) -> None:
            if not self._authorised():
                return
            url = urlparse(self.path)
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            try:
                if method == "GET" and url.path == "/api/status":
                    self._reply(HTTPStatus.OK, service.status())
                elif method == "GET" and url.path == "/api/songs":
                    self._reply(*service.songs_search(
                        query.get("q", ""), query.get("limit", overtone_library.SEARCH_LIMIT)))
                elif method == "GET" and url.path == "/api/analysis":
                    self._reply(*service.analysis(query.get("path", "")))
                elif method == "POST" and url.path in ("/api/scan", "/api/analyze", "/api/stop"):
                    body = self._body()
                    if body is None:
                        return
                    if url.path == "/api/scan":
                        self._reply(*service.scan())
                    elif url.path == "/api/analyze":
                        self._reply(*service.analyze(body.get("limit")))
                    else:
                        self._reply(*service.stop())
                else:
                    self._reply(HTTPStatus.NOT_FOUND, {"error": f"No endpoint {method} {url.path}."})
            except (ValueError, overtone_library.DamagedIndex) as exc:
                self._reply(HTTPStatus.CONFLICT, {"error": str(exc)})

        def do_GET(self):  # noqa: N802 -- the base class's name
            self._handle("GET")

        def do_POST(self):  # noqa: N802 -- the base class's name
            self._handle("POST")

    return Handler


def disable_beat_vote() -> None:
    """Turn the Beat This! vote off for this process. It reads each song in
    Python and runs its model (1.46 GB and 50 s on a 90 s fixture, against
    101 MB and 2.3 s for the Rust path without it), so a small server goes
    without; the cache keys the choice, so it never mixes the two readings."""
    ta._BEAT_THIS_SESSION[:] = [None]


def serve(service: Service, host: str, port: int, token: str,
          log: bool = True) -> ThreadingHTTPServer:
    """The server, bound and ready; ``serve_forever`` runs it. ``log``: one
    line per request on stderr."""
    server = ThreadingHTTPServer((host, port), make_handler(service, token, log))
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--songs", required=True, help="The osu! Songs folder to index and analyse")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Address to listen on (default 127.0.0.1: local and SSH tunnels only)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--index", help="The index file (default: Overtone's data folder)")
    parser.add_argument("--engine", choices=("rust", "python"),
                        help="Analysis engine (default rust when overtone-cli is built)")
    parser.add_argument("--jobs", type=int, help="Audio files the Rust engine analyses at once "
                        f"(default {overtone_library.ANALYSIS_JOBS})")
    parser.add_argument("--token-file", help=f"Where the bearer token is kept (default: the data "
                        f"folder's {TOKEN_FILE}; ${TOKEN_ENV} wins over both)")
    parser.add_argument("--no-beat-vote", action="store_true",
                        help="Skip the Beat This! vote: about 100 MB per song instead of 1.5 GB, "
                        "red lines as the engine fits them")
    parser.add_argument("--every", type=float, default=0.0,
                        help="Minutes between automatic scan-then-analyse runs (0: only on request)")
    args = parser.parse_args(argv)
    if not os.path.isdir(args.songs):
        parser.error(f"{args.songs} is not a folder.")
    if args.no_beat_vote:
        disable_beat_vote()
    service = Service(args.songs, args.index, args.engine, args.jobs)
    server = serve(service, args.host, args.port, load_token(args.token_file))
    if args.every > 0:
        threading.Thread(target=_every, args=(service, args.every * 60.0), daemon=True,
                         name="overtone-every").start()
    print(f"overtone-server: {service.songs} on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.analyze_job.stop.set()
        server.server_close()
    return 0


def _every(service: Service, seconds: float) -> None:
    """Scan, then analyse what is new, then wait; a run already going is left be."""
    while True:
        if service.scan()[0] == HTTPStatus.ACCEPTED:
            while service.scan_job.state()["running"]:
                time.sleep(1.0)
        service.analyze()
        time.sleep(seconds)


if __name__ == "__main__":
    sys.exit(main())
