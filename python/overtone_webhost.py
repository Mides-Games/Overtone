"""The app's own page in a browser: overtone_web.Api behind HTTP instead of pywebview.

The desktop window and the web page are the same ``app/`` files talking to
the same :class:`overtone_web.Api`. Only the transport differs:

- page -> Python: ``app/web.js`` turns ``window.pywebview.api.method(...)``
  into ``POST /api/v1/bridge/<method>``, answered by :meth:`WebHost.call`;
- Python -> page: the one place the Api pushes into the page
  (``_window.evaluate_js``) lands in :class:`WebWindow`, which queues it on
  an :class:`EventHub` the page reads as server-sent events;
- the six native file dialogs become a dialog the page draws: the Api's
  thread waits while the browser uploads a file or picks one the server
  holds, and gets back paths on the server, as a desktop dialog would.

Files the browser may read or write go through :meth:`WebHost.resolve`,
which accepts only paths under the roots it was given (the Songs folder,
uploads, exports). One user, one Api: the server is the owner's.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import inspect
import itertools
import json
import os
import re
import secrets
import sys
import threading
import time
import types
from pathlib import Path

#: How long an Api thread waits for the browser to answer a file dialog.
DIALOG_TIMEOUT_S = 30 * 60
#: Events kept for a page that reconnects (EventSource's Last-Event-ID).
EVENTS_KEPT = 500
#: The largest single upload.
MAX_UPLOAD = 1024 * 1024 * 1024
#: Exports the page is offered to download to the computer it runs on.
DOWNLOADABLE = (".osz", ".osu", ".csv", ".wav", ".zip")
#: A file name as an upload keeps it: no folders, nothing a shell reads.
_SAFE_NAME = re.compile(r"[^\w.\- ()\[\]&',!+]+", re.UNICODE)
#: Api arguments and settings keys that name a file or a folder on the server.
_PATH_NAME = re.compile(r"(^|_)(path|paths|folder|folders|dir|directory|file|source|targets"
                        r"|audio|filename)$")
#: Of those, the ones that are always a full path, never a name inside a folder.
_PATH_ONLY = re.compile(r"(^|_)(path|paths|folder|folders|dir|directory)$")


def _climbs(value: str) -> bool:
    """Whether a relative path steps out of where it starts (``..``)."""
    return ".." in re.split(r"[\\/]", value)


def ensure_webview_names() -> None:
    """The Api reads ``webview.OPEN_DIALOG`` and friends at each dialog. A
    server has no pywebview, so its names come from a stand-in; with
    pywebview installed, its own module is left alone."""
    try:
        import webview  # noqa: F401 -- only whether it imports
    except ImportError:
        stand_in = types.ModuleType("webview")
        stand_in.OPEN_DIALOG, stand_in.FOLDER_DIALOG, stand_in.SAVE_DIALOG = 10, 20, 30

        def missing(name: str):
            # Python's own questions (__file__, __path__, ...) get a plain
            # "no": inspect and unittest ask every module, through hasattr,
            # which only an AttributeError answers.
            if name.startswith("__") and name.endswith("__"):
                raise AttributeError(name)
            # Anything else is the desktop window's, which needs the real
            # package: say so rather than half-work.
            raise AttributeError(f"webview.{name}: pywebview is not installed. The desktop "
                               "window needs it (pip install pywebview); the web page does not.")

        stand_in.__getattr__ = missing
        sys.modules["webview"] = stand_in


def dialog_kind(value) -> str:
    """``open``, ``folder`` or ``save`` for pywebview's dialog constant
    (an int in the stand-in, a ``FileDialog`` enum in pywebview 6)."""
    import webview
    dialogs = getattr(webview, "FileDialog", None)
    if dialogs is not None:   # pywebview 6; its *_DIALOG names warn when read
        names = (("OPEN", "open"), ("FOLDER", "folder"), ("SAVE", "save"))
        source = dialogs
    else:
        names = (("OPEN_DIALOG", "open"), ("FOLDER_DIALOG", "folder"), ("SAVE_DIALOG", "save"))
        source = webview
    for name, kind in names:
        if value == getattr(source, name, object()):
            return kind
    text = str(value).lower()
    return "folder" if "folder" in text else "save" if "save" in text else "open"


def free_path(folder: Path, name: str) -> Path:
    """``folder / name``, or ``name (2)``, ``(3)``... when that is taken:
    an export never lands on an earlier one."""
    clean = WebHost.clean_name(name, "export")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / clean
    stem, suffix = target.stem, target.suffix
    number = 2
    while target.exists():
        target = folder / f"{stem} ({number}){suffix}"
        number += 1
    return target


class EventHub:
    """What Python pushed into the page, numbered, kept for a while so a page
    that reconnects misses nothing, and handed to every page listening."""

    def __init__(self, kept: int = EVENTS_KEPT) -> None:
        self._events: collections.deque = collections.deque(maxlen=kept)
        self._ids = itertools.count(1)
        self._changed = threading.Condition()

    def publish(self, event: dict) -> int:
        with self._changed:
            number = next(self._ids)
            self._events.append((number, event))
            self._changed.notify_all()
        return number

    def since(self, last: int, timeout: float) -> list[tuple[int, dict]]:
        """Every event after ``last``, waiting up to ``timeout`` for one."""
        with self._changed:
            self._changed.wait_for(lambda: self._events and self._events[-1][0] > last, timeout)
            return [(n, e) for n, e in self._events if n > last]


class WebWindow:
    """The part of a pywebview window the Api uses: ``evaluate_js`` and
    ``create_file_dialog``."""

    def __init__(self, hub: EventHub, save_folder: Path | None = None,
                 shared=lambda _path: True) -> None:
        self._hub = hub
        #: Where a save dialog opens when the Api names no shared folder.
        self._save_folder = save_folder
        self._shared = shared
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._waiting: dict[int, tuple[threading.Event, list]] = {}

    def evaluate_js(self, code: str) -> None:
        self._hub.publish({"kind": "js", "code": code})

    def create_file_dialog(self, dialog_type=None, directory: str = "", allow_multiple=False,
                           save_filename: str = "", file_types=()):
        """Ask the page, and wait for its answer: a tuple of server paths, or
        None when it was cancelled, left unanswered or the page went away.

        A save is not asked: on a server, where the file lands is the
        server's business, and what the person wants is the file on their own
        computer. It goes under exports (the folder the Api named, when that
        is shared, else exports itself) under a free name, and the page then
        offers it for download (``WebHost.call``)."""
        kind = dialog_kind(dialog_type)
        directory = str(directory or "")
        if directory and not self._shared(directory):
            directory = ""   # a desktop path the page could not open
        if kind == "save" and self._save_folder is not None:
            return (str(free_path(Path(directory or self._save_folder),
                                  save_filename or "export")),)
        with self._lock:
            number = next(self._ids)
            answered, answer = threading.Event(), []
            self._waiting[number] = (answered, answer)
        self._hub.publish({"kind": "dialog", "id": number, "type": kind,
                           "directory": directory, "multiple": bool(allow_multiple),
                           "save_filename": str(save_filename or ""),
                           "file_types": [str(t) for t in (file_types or ())]})
        try:
            answered.wait(DIALOG_TIMEOUT_S)
        finally:
            with self._lock:
                self._waiting.pop(number, None)
        paths = answer[0] if answer else None
        return tuple(paths) if paths else None

    def answer(self, number: int, paths) -> bool:
        """The page's answer to dialog ``number``; False when nobody waits."""
        with self._lock:
            waiting = self._waiting.get(int(number))
        if waiting is None:
            return False
        answered, answer = waiting
        answer.append([str(p) for p in paths] if paths else None)
        answered.set()
        return True

    def pending(self) -> list[int]:
        with self._lock:
            return sorted(self._waiting)


class WebHost:
    """The Api served to a browser: its methods, its events, its dialogs,
    and the files a browser may read or write."""

    def __init__(self, roots: dict[str, str | os.PathLike[str]], workdir: str | os.PathLike[str],
                 api=None) -> None:
        ensure_webview_names()
        self.workdir = Path(workdir)
        self.uploads = self.workdir / "uploads"
        self.exports = self.workdir / "exports"
        for folder in (self.uploads, self.exports):
            folder.mkdir(parents=True, exist_ok=True)
        self.roots = {name: Path(os.path.abspath(path)) for name, path in roots.items()}
        self.roots.update(uploads=self.uploads.resolve(), exports=self.exports.resolve())
        self.hub = EventHub()
        self.window = WebWindow(self.hub, self.exports, self.shares)
        if api is None:
            import overtone_web
            api = overtone_web.Api("", autorun=False, save_projects=True)
        api._window = self.window
        # The page's Songs folder is the server's, unless one that exists here
        # was chosen already.
        songs, chosen = self.roots.get("songs"), str(api._cfg.get("songs_folder") or "")
        if songs is not None and not (chosen and Path(chosen).is_dir()):
            api._cfg["songs_folder"] = str(songs)
        # Exports land where the page can download them from.
        if not self.shares(str(api._cfg.get("output_folder") or "")):
            api._cfg["output_folder"] = str(self.exports)
        self.api = api
        self.methods = frozenset(
            name for name, member in inspect.getmembers(type(api), inspect.isfunction)
            if not name.startswith("_"))

    # -- the bridge -----------------------------------------------------------
    def call(self, method: str, args) -> object:
        """``api.method(*args)``, for public methods only, as pywebview would.

        An answer that names a file the call just exported (a ``path`` under
        exports, of a kind in DOWNLOADABLE) also carries ``download``, so the
        page can offer it to the person's own computer."""
        if method not in self.methods:
            raise LookupError(f"No bridge method {method!r}.")
        if not isinstance(args, list):
            raise TypeError("args must be a list.")
        self.check_paths(method, args)
        result = getattr(self.api, method)(*args)
        if isinstance(result, dict) and result.get("ok") and isinstance(result.get("path"), str):
            offer = self.download_offer(result["path"])
            if offer is not None:
                result = {**result, "download": offer}
        return result

    def check_paths(self, method: str, args: list) -> None:
        """Refuse a call that would reach a file outside the shared roots.

        The page names files on the server, and the Api trusts what it is
        given, as it does on the desktop. Over HTTP that trust is the
        browser's: ``import_osz(upload, "/opt/overtone")`` would unpack into
        the server's own code. So every argument the Api reads as a file or
        folder (by its name, or a settings key of that shape) must be a path
        under the roots, and any absolute path anywhere must too. A plain
        file name (no folders, no ``..``) stays allowed: the Api joins it to a
        folder that was checked."""
        try:
            bound = inspect.signature(getattr(self.api, method)).bind(*args)
        except TypeError:
            return      # the call itself raises, as pywebview's would
        # A bare name means a file inside a folder only next to a folder, or
        # as the name a dropped file is staged under.
        in_folder = "folder" in bound.arguments
        for name, value in bound.arguments.items():
            self._check_value(name, value, in_folder or name == "filename")

    def _check_value(self, name: str, value, in_folder: bool = False) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                self._check_value(str(key), item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                self._check_value(name, item, in_folder)
        elif isinstance(value, str) and value:
            if os.path.isabs(value):
                self.resolve(value)
            elif _PATH_NAME.search(name) or _climbs(value):
                if ("/" in value or "\\" in value or _climbs(value) or _PATH_ONLY.search(name)
                        or not in_folder):
                    raise ValueError(f"{name}: a path on the server must be absolute and "
                                     "under the folders this server shares.")

    def download_offer(self, path: str) -> dict | None:
        """``{"path", "name", "size"}`` for an export the page may download."""
        try:
            real = Path(os.path.realpath(path))
            exports = Path(os.path.realpath(self.exports))
        except (OSError, ValueError):
            return None
        if (exports not in real.parents or not real.is_file()
                or real.suffix.lower() not in DOWNLOADABLE):
            return None
        return {"path": str(real), "name": real.name, "size": real.stat().st_size}

    # -- files ------------------------------------------------------------------
    def shares(self, path: str) -> bool:
        """Whether ``path`` lies under one of the roots."""
        try:
            self.resolve(path)
        except ValueError:
            return False
        return True

    def resolve(self, path: str) -> Path:
        """``path`` as a real path under one of the roots, or ValueError."""
        if not path:
            raise ValueError("A path is required.")
        real = Path(os.path.realpath(path))
        for root in self.roots.values():
            real_root = Path(os.path.realpath(root))
            if real == real_root or real_root in real.parents:
                return real
        raise ValueError("That path is outside the folders this server shares.")

    def browse(self, path: str = "") -> dict:
        """A folder's entries, or the roots when no folder is named."""
        if not path:
            return {"path": "", "parent": None, "entries": [
                {"name": name, "path": str(root), "dir": True}
                for name, root in self.roots.items() if root.is_dir()]}
        folder = self.resolve(path)
        if not folder.is_dir():
            raise ValueError(f"{folder} is not a folder.")
        entries = []
        with os.scandir(folder) as listing:
            for entry in listing:
                try:
                    is_dir = entry.is_dir()
                    size = 0 if is_dir else entry.stat().st_size
                except OSError:
                    continue
                entries.append({"name": entry.name, "path": entry.path, "dir": is_dir,
                                "size": size})
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        parent = folder.parent
        try:
            self.resolve(str(parent))
        except ValueError:
            parent = None
        return {"path": str(folder), "parent": str(parent) if parent else "",
                "entries": entries}

    @staticmethod
    def clean_name(name: str, default: str) -> str:
        """A browser's file or folder name as this server writes it: the last
        component only, nothing a shell or a path would read."""
        return _SAFE_NAME.sub("_", os.path.basename(str(name or "").replace("\\", "/"))
                              ).strip(" .") or default

    def receive(self, name: str, stream, length: int, folder: str = "") -> Path:
        """Write ``length`` bytes of ``stream`` as ``name`` under uploads (or
        the uploads sub-folder ``folder``), atomically. Returns the path."""
        if length < 0 or length > MAX_UPLOAD:
            raise ValueError("That upload is too large.")
        base = self.uploads / self.clean_name(folder, "batch") if folder else self.uploads
        base.mkdir(parents=True, exist_ok=True)
        target = base / self.clean_name(name, "upload")
        partial = target.with_name(f".{target.name}.{secrets.token_hex(4)}.part")
        remaining = length
        try:
            with open(partial, "wb") as handle:
                while remaining:
                    chunk = stream.read(min(1 << 20, remaining))
                    if not chunk:
                        raise ValueError("The upload ended early.")
                    handle.write(chunk)
                    remaining -= len(chunk)
            os.replace(partial, target)
        finally:
            if partial.exists():
                partial.unlink()
        return target

    def export_path(self, name: str) -> Path:
        """Where a save dialog with nothing chosen writes ``name``."""
        return self.exports / self.clean_name(name, "export")


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


def event_line(number: int, event: dict) -> bytes:
    """One server-sent event."""
    return f"id: {number}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


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
