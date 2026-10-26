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

It is a measurement API, not an interface: the website (``site/``) is
Overtone's interface. The one page it serves is the runs page (``/``, from
``server_page/runs.html``), signed in with the token at ``/login``, which
queues and follows the measurement runs ``bench/remote.py`` also drives.

Endpoints (a browser's cookie or ``Authorization: Bearer <token>``):

    GET  /api/status                   index, cache counts, jobs, engine
    POST /api/scan                     start a scan of the Songs folder
    POST /api/analyze  {"limit": n}    start analysing what is not cached
    POST /api/stop                     ask the running analysis to stop
    GET  /api/songs?q=text&limit=n     search, each map with its analysis
    GET  /api/analysis?path=<audio>    one audio file's cached analysis

    GET  /api/v1/whoami                200 while signed in

    GET  /api/v1/runs                  measurement runs, the queue, the stages
    POST /api/v1/runs                  {"tool": "stages", "stage": ...}: queue one
    GET  /api/v1/runs/<id>             one run and the end of its log
    GET  /api/v1/runs/<id>/result      the tool's own JSON report
    GET  /api/v1/runs/<id>/log         the whole log, plain text
    POST /api/v1/runs/<id>/stop        cancel it, or end it while it runs
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import overtone as ta
import overtone_library
import overtone_runs
import overtone_rust
from overtone_paths import data_root

#: Where a generated token is kept, so a restart keeps the clients working.
TOKEN_FILE = "api-token"
#: The token is read from here before any file.
TOKEN_ENV = "OVERTONE_API_TOKEN"
#: The shortest token accepted from the environment or a file.
MIN_TOKEN = 32
#: The largest request body read; every request body is a small JSON object.
MAX_BODY = 64 * 1024
#: The runs page, served at ``/``: the only page this server has.
RUNS_PAGE = Path(__file__).resolve().parent / "server_page" / "runs.html"
#: The cookie a signed-in browser carries.
SESSION_COOKIE = "overtone_session"


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
                 engine: str | None = None, jobs: int | None = None,
                 osu_db: str | os.PathLike[str] | None = None) -> None:
        self.songs = os.path.abspath(songs)
        #: osu!.db, for runs that score ranked and loved maps only: given, or
        #: beside the Songs folder as osu! keeps it.
        self.osu_db = os.path.abspath(osu_db) if osu_db else os.path.join(
            os.path.dirname(self.songs), "osu!.db")
        self.library = overtone_library.Library(index)
        self.engine = engine
        self.jobs = jobs
        self.scan_job = Job("scan")
        self.analyze_job = Job("analyze")
        self.sessions: Sessions | None = None
        self._runs_lock = threading.Lock()
        self._runs: overtone_runs.RunQueue | None = None

    @property
    def runs(self) -> overtone_runs.RunQueue:
        """Measurement runs, kept beside the index, made on first use."""
        with self._runs_lock:
            if self._runs is None:
                store = overtone_runs.RunStore(self.library.path.parent / "runs")
                self._runs = overtone_runs.RunQueue(store, self.library.path, self.songs,
                                                    osu_db=self.osu_db)
            return self._runs

    def runs_overview(self) -> dict:
        return {"runs": self.runs.store.runs(), "queue": self.runs.state(),
                "stages": overtone_runs.stage_ids(), "tools": list(overtone_runs.TOOLS),
                "engines": list(overtone_runs.ENGINES), "max_jobs": overtone_runs.MAX_JOBS,
                "commit": overtone_runs.git_commit(),
                "osu_db": os.path.isfile(self.osu_db)}

    def run_detail(self, run_id: str) -> dict:
        return {**self.runs.store.meta(run_id), "log": self.runs.store.log_tail(run_id)}

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


class Sessions:
    """Browser sessions as signed cookies: an expiry and a nonce, signed with
    a key drawn from the API token. Nothing is kept on the server, so a
    restart signs nobody out, and a new token signs everybody out."""

    def __init__(self, token: str, ttl: float = 30 * 24 * 3600) -> None:
        self.ttl = ttl
        self._key = hashlib.sha256(b"overtone session|" + token.encode("utf-8")).digest()

    def _sign(self, body: str) -> str:
        return hmac.new(self._key, body.encode("ascii"), hashlib.sha256).hexdigest()

    def new(self) -> str:
        body = f"{int(time.time() + self.ttl)}.{secrets.token_hex(8)}"
        return f"{body}.{self._sign(body)}"

    def valid(self, session: str | None) -> bool:
        try:
            expiry, nonce, signature = str(session or "").split(".")
            body = f"{expiry}.{nonce}"
            return (hmac.compare_digest(signature, self._sign(body))
                    and int(expiry) > time.time())
        except ValueError:
            return False


LOGIN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overtone</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --ink: #14161a; --line: #d5d9e0; --accent: #10b981; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a20; --ink: #e8eaee; --line: #2a2f38; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
       font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
form { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; width: min(360px, calc(100vw - 32px)); box-sizing: border-box; }
h1 { margin: 0 0 6px; font-size: 20px; } p { margin: 0 0 18px; opacity: .75; }
input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
button { margin-top: 14px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { color: #ef4444; margin-top: 10px; min-height: 1.2em; }
</style></head>
<body><form method="post" action="/login">
<h1>Overtone</h1><p>Enter this server's API token.</p>
<input type="password" name="token" autocomplete="current-password" autofocus required aria-label="API token">
<button type="submit">Sign in</button><div class="error">{error}</div>
</form></body></html>
"""


def _long_enough(token: str, source: str) -> str:
    if len(token) < MIN_TOKEN:
        raise SystemExit(f"overtone-server: the token in {source} is shorter than {MIN_TOKEN} "
                         "characters; use a random one (delete the file and one is written).")
    return token


def load_token(explicit_file: str | None = None) -> str:
    """The bearer token: the environment's, else the file's, else a new one
    written to Overtone's data folder (readable by its owner only). One
    shorter than MIN_TOKEN is refused: the token is the whole lock, and the
    wrong-token delay is per connection, so a short one is guessable."""
    if os.environ.get(TOKEN_ENV):
        return _long_enough(os.environ[TOKEN_ENV].strip(), f"${TOKEN_ENV}")
    path = Path(explicit_file) if explicit_file else data_root() / TOKEN_FILE
    if path.is_file():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return _long_enough(token, str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    print(f"overtone-server: a new API token was written to {path}", file=sys.stderr)
    return token


def make_handler(service: Service, token: str, log: bool = True):
    expected = f"Bearer {token}".encode()
    service.sessions = Sessions(token)

    class Handler(BaseHTTPRequestHandler):
        server_version = "Overtone"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 -- the base class's name
            if not log:
                return
            sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.address_string()} "
                             f"{format % args}\n")

        # -- replies ----------------------------------------------------------
        def _send(self, status: int, data: bytes, content_type: str, headers=()) -> None:
            self._drain()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _reply(self, status: int, body: dict, headers=()) -> None:
            self._send(status, json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"),
                       "application/json; charset=utf-8", headers)

        def _redirect(self, where: str, headers=()) -> None:
            self._send(HTTPStatus.SEE_OTHER, b"", "text/plain", (("Location", where), *headers))

        # -- who is asking ------------------------------------------------------
        def _session(self) -> str | None:
            cookie = SimpleCookie(self.headers.get("Cookie") or "")
            morsel = cookie.get(SESSION_COOKIE)
            return morsel.value if morsel else None

        def _signed_in(self, method: str) -> bool:
            """A bearer token, or a session cookie; a cookie alone may change
            nothing without the page's own header (no cross-site form can
            send one)."""
            given = (self.headers.get("Authorization") or "").encode()
            if given and hmac.compare_digest(given, expected):
                return True
            if service.sessions.valid(self._session()):
                return method in ("GET", "HEAD") or self.headers.get("X-Overtone") == "1"
            return False

        def _secure(self) -> bool:
            return (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"

        # -- bodies ---------------------------------------------------------------
        def _drain(self) -> None:
            """Read a small body nobody read. Answering first and closing with
            unread bytes makes the socket reset (Windows does), and the client
            sees an aborted connection instead of the answer."""
            if getattr(self, "_body_taken", False):
                return
            self._body_taken = True
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return
            if 0 < length <= MAX_BODY:
                self.rfile.read(length)

        def _length(self, limit: int) -> int | None:
            self._body_taken = True
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > limit:
                self._reply(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Body too large."})
                return None
            return length

        def _body(self, limit: int = MAX_BODY) -> dict | None:
            length = self._length(limit)
            if length is None:
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

        # -- the page -------------------------------------------------------------
        def _login(self, method: str) -> None:
            if method == "GET":
                page = LOGIN_PAGE.replace("{error}", "")
                self._send(HTTPStatus.OK, page.encode("utf-8"), "text/html; charset=utf-8")
                return
            length = self._length(MAX_BODY)
            if length is None:
                return
            form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
            given = f"Bearer {(form.get('token') or [''])[-1].strip()}".encode()
            if not hmac.compare_digest(given, expected):
                time.sleep(1.0)  # a guess costs a second
                page = LOGIN_PAGE.replace("{error}", "That token is not this server's.")
                self._send(HTTPStatus.UNAUTHORIZED, page.encode("utf-8"), "text/html; charset=utf-8")
                return
            cookie = (f"{SESSION_COOKIE}={service.sessions.new()}; Path=/; HttpOnly; "
                      f"SameSite=Strict; Max-Age={int(service.sessions.ttl)}"
                      + ("; Secure" if self._secure() else ""))
            self._redirect("/", (("Set-Cookie", cookie),))

        def _page(self) -> None:
            self._send(HTTPStatus.OK, RUNS_PAGE.read_bytes(), "text/html; charset=utf-8")

        # -- routing ----------------------------------------------------------------
        def _handle(self, method: str) -> None:
            url = urlparse(self.path)
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            if url.path == "/login" and method in ("GET", "POST"):
                self._login(method)
                return
            if not self._signed_in(method):
                if method == "GET" and not url.path.startswith("/api/"):
                    self._redirect("/login")
                else:
                    self._reply(HTTPStatus.UNAUTHORIZED,
                                {"error": "A valid bearer token is required."})
                return
            try:
                self._route(method, url.path, query)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
            except LookupError as exc:
                self._reply(HTTPStatus.NOT_FOUND, {"error": str(exc).strip("'\"")})
            except (ValueError, TypeError, overtone_library.DamagedIndex) as exc:
                self._reply(HTTPStatus.CONFLICT if isinstance(exc, overtone_library.DamagedIndex)
                            else HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # the page shows it; the server keeps serving
                traceback.print_exc()
                self._reply(HTTPStatus.INTERNAL_SERVER_ERROR,
                            {"error": f"{type(exc).__name__}: {exc}"})

        def _route(self, method: str, path: str, query: dict) -> None:
            if method == "GET" and path == "/api/status":
                self._reply(HTTPStatus.OK, service.status())
            elif method == "GET" and path == "/api/songs":
                self._reply(*service.songs_search(
                    query.get("q", ""), query.get("limit", overtone_library.SEARCH_LIMIT)))
            elif method == "GET" and path == "/api/analysis":
                self._reply(*service.analysis(query.get("path", "")))
            elif method == "POST" and path in ("/api/scan", "/api/analyze", "/api/stop"):
                body = self._body()
                if body is None:
                    return
                if path == "/api/scan":
                    self._reply(*service.scan())
                elif path == "/api/analyze":
                    self._reply(*service.analyze(body.get("limit")))
                else:
                    self._reply(*service.stop())
            elif path == "/api/v1/runs" and method == "GET":
                self._reply(HTTPStatus.OK, service.runs_overview())
            elif path == "/api/v1/runs" and method == "POST":
                body = self._body()
                if body is None:
                    return
                self._reply(HTTPStatus.ACCEPTED, service.runs.submit(body))
            elif path.startswith("/api/v1/runs/"):
                parts = path[len("/api/v1/runs/"):].split("/")
                if method == "GET" and len(parts) == 1:
                    self._reply(HTTPStatus.OK, service.run_detail(parts[0]))
                elif method == "GET" and parts[1:] == ["log"]:
                    self._send(HTTPStatus.OK, service.runs.store.log(parts[0]).encode("utf-8"),
                               "text/plain; charset=utf-8")
                elif method == "GET" and parts[1:] == ["result"]:
                    self._reply(HTTPStatus.OK, service.runs.store.result(parts[0]))
                elif method == "POST" and parts[1:] == ["stop"]:
                    stopped = service.runs.stop(parts[0])
                    self._reply(HTTPStatus.ACCEPTED if stopped else HTTPStatus.OK,
                                {"stopping": stopped})
                else:
                    self._reply(HTTPStatus.NOT_FOUND, {"error": f"No endpoint {method} {path}."})
            elif method == "GET" and path == "/api/v1/whoami":
                self._reply(HTTPStatus.OK, {"signed_in": True})
            elif method == "POST" and path == "/logout":
                self._redirect("/login", (("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; Max-Age=0"),))
            elif method in ("GET", "HEAD") and path in ("/", "/runs.html"):
                self._page()
            else:
                self._reply(HTTPStatus.NOT_FOUND, {"error": f"No endpoint {method} {path}."})

        def do_GET(self):  # noqa: N802 -- the base class's name
            self._handle("GET")

        def do_HEAD(self):  # noqa: N802 -- the base class's name
            self._handle("HEAD")

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
    parser.add_argument("--osu-db", help="osu!.db, so runs can score ranked and loved maps "
                        "only (default: beside the Songs folder)")
    parser.add_argument("--every", type=float, default=0.0,
                        help="Minutes between automatic scan-then-analyse runs (0: only on request)")
    args = parser.parse_args(argv)
    if not os.path.isdir(args.songs):
        parser.error(f"{args.songs} is not a folder.")
    if args.no_beat_vote:
        disable_beat_vote()
    service = Service(args.songs, args.index, args.engine, args.jobs, args.osu_db)
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
        _every_once(service)
        time.sleep(seconds)


def _runs_busy(service: Service) -> bool:
    """A measurement run going or queued: the service's memory is the run's."""
    state = service.runs.state()
    return bool(state["running"] or state["queued"])


def _every_once(service: Service, poll: float = 2.0) -> None:
    """One pass of ``_every``. The analysis yields to measurement runs: it does
    not start while one is going or queued, and stops (keeping what it
    committed) when one arrives, so the two never share the memory cap."""
    if _runs_busy(service):
        return
    if service.scan()[0] == HTTPStatus.ACCEPTED:
        while service.scan_job.state()["running"]:
            time.sleep(poll)
    if _runs_busy(service):
        return
    service.analyze()
    while service.analyze_job.state()["running"]:
        if _runs_busy(service):
            service.analyze_job.stop.set()
        time.sleep(poll)


if __name__ == "__main__":
    sys.exit(main())
