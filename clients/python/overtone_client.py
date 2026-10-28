"""overtone_client: the Overtone public API with a personal token (W13.22).

One module, standard library only (``urllib``), Python 3.9+. A token belongs
in a script, a bot or a server; make one at ``/settings/tokens``.

    from overtone_client import Overtone
    overtone = Overtone(token=os.environ["OVERTONE_TOKEN"])
    analysis = overtone.analyze_file("song.mp3")
    print(analysis["result"]["global_bpm"])

What it does for you, and nothing else:

- the token in ``Authorization: Bearer``, the ``/api/v1`` prefix, JSON in and out;
- every error as an :class:`OvertoneError` carrying the API's own ``code``
  (``INVALID_TOKEN``, ``TOKEN_SCOPE``, ``QUOTA_EXCEEDED``...), its HTTP
  status and ``details``, with a subclass per kind you are likely to catch;
- a 429 that says ``Retry-After`` is waited out and retried (up to
  ``max_retries``, never longer than ``max_retry_wait``); a 429 without it
  (the daily quota, the pending cap) is raised at once;
- every request has a timeout (``timeout``; uploads ``upload_timeout``);
- an upload first asks whether the same audio was analysed already (its
  SHA-1), so a known song costs no upload.

The JavaScript client (``clients/js``) has the same surface in camelCase.
"""

from __future__ import annotations

import email.utils
import hashlib
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, Optional, Union

__all__ = [
    "Overtone", "OvertoneError", "AuthenticationError", "PermissionDenied", "NotFound",
    "RateLimited", "Timeout", "NetworkError", "AnalysisFailed", "DEFAULT_BASE_URL",
    "api_root", "query_of", "retry_after_seconds",
]

__version__ = "0.1.0"
DEFAULT_BASE_URL = "https://overtone.midesprojects.com"


class OvertoneError(Exception):
    """Any error from the API, the network or a timeout. ``code`` is the API's when it gave one."""

    def __init__(self, message: str, *, status: Optional[int] = None, code: Optional[str] = None,
                 details: Optional[dict] = None, retry_after: Optional[int] = None):
        super().__init__(message)
        self.message = message
        #: The HTTP status, or None when no answer came.
        self.status = status
        #: The API's stable code, or the client's own (TIMEOUT, NETWORK, ANALYSIS_FAILED).
        self.code = code
        #: The API's ``details`` object, when it sent one.
        self.details = details
        #: Seconds the API asked to wait (Retry-After), or None.
        self.retry_after = retry_after

    def __str__(self) -> str:
        return f"{self.code}: {self.message}" if self.code else self.message


class AuthenticationError(OvertoneError):
    """401: the token is missing, malformed or revoked (``INVALID_TOKEN``)."""


class PermissionDenied(OvertoneError):
    """403: not open to tokens (``TOKEN_NOT_ALLOWED``) or a missing scope (``TOKEN_SCOPE``)."""


class NotFound(OvertoneError):
    """404: no such analysis or timing, or not yours (the API does not tell the two apart)."""


class RateLimited(OvertoneError):
    """429: ``RATE_LIMITED`` (after the retries ran out), ``QUOTA_EXCEEDED`` or ``PENDING_LIMIT``."""


class Timeout(OvertoneError):
    """A request, or a wait for an analysis, took longer than allowed. ``code`` is ``TIMEOUT``."""


class NetworkError(OvertoneError):
    """No answer at all: DNS, refused connection, reset. ``code`` is ``NETWORK``."""


class AnalysisFailed(OvertoneError):
    """The analysis ended ``failed``. ``code`` is ``ANALYSIS_FAILED``; ``analysis`` is the row."""

    analysis: Optional[dict] = None


_BY_STATUS = {401: AuthenticationError, 403: PermissionDenied, 404: NotFound, 429: RateLimited}
_TERMINAL = {"done", "refused", "failed"}
_TRANSIENT = {502, 503, 504}


def retry_after_seconds(value: Optional[str], now: Optional[float] = None) -> Optional[int]:
    """Seconds from a Retry-After header (delta-seconds or an HTTP date), or None."""
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip()
    if text.isdigit():
        return int(text)
    try:
        at = email.utils.parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0, int(-(-(at - (time.time() if now is None else now)) // 1)))


def query_of(filters: Optional[Dict[str, Any]] = None) -> str:
    """The query string of ``filters``, without empty values."""
    pairs = [(k, str(v)) for k, v in (filters or {}).items() if v is not None and v != ""]
    return f"?{urllib.parse.urlencode(pairs)}" if pairs else ""


def api_root(base_url: str) -> str:
    """``https://site``, ``https://site/`` or ``https://site/api/v1`` -> ``https://site/api/v1``."""
    trimmed = str(base_url).rstrip("/")
    return trimmed if trimmed.endswith("/api/v1") else f"{trimmed}/api/v1"


def _quote(value: str) -> str:
    # As JavaScript's encodeURIComponent, which is what the API decodes.
    return urllib.parse.quote(value, safe="-_.!~*'()")


class Overtone:
    """A client for one token.

    :param token: a personal token from /settings/tokens (``ot_...``).
    :param base_url: the site, e.g. https://overtone.midesprojects.com (or its /api/v1).
    :param timeout: seconds per request.
    :param upload_timeout: seconds per upload.
    :param max_retries: retries of a 429 that sent Retry-After.
    :param max_retry_wait: the longest Retry-After (seconds) waited out; a longer one is raised.
    """

    def __init__(self, token: str, base_url: str = DEFAULT_BASE_URL, *, timeout: float = 30.0,
                 upload_timeout: float = 300.0, max_retries: int = 3, max_retry_wait: float = 60.0,
                 user_agent: Optional[str] = None):
        if not isinstance(token, str) or not token.startswith("ot_"):
            raise ValueError("An Overtone token starts with ot_: make one at /settings/tokens.")
        self._token = token
        self.root = api_root(base_url or DEFAULT_BASE_URL)
        self.timeout = timeout
        self.upload_timeout = upload_timeout
        self.max_retries = max_retries
        self.max_retry_wait = max_retry_wait
        self.user_agent = user_agent or f"overtone-client-python/{__version__}"

    def __repr__(self) -> str:  # never the token
        return f"Overtone(base_url={self.root!r})"

    # ── The one call ──────────────────────────────────────────────────────

    def request(self, method: str, path: str, *, body: Optional[bytes] = None,
                headers: Optional[Dict[str, str]] = None, as_text: bool = False,
                timeout: Optional[float] = None) -> Any:
        """One call: the parsed JSON, the text (``as_text``) or None (204). Raises OvertoneError."""
        attempt = 0
        while True:
            try:
                return self._send(method, path, body, headers or {}, as_text, timeout or self.timeout)
            except RateLimited as error:
                wait = error.retry_after
                if wait is None or attempt >= self.max_retries or wait > self.max_retry_wait:
                    raise
                attempt += 1
                time.sleep(wait)

    def _send(self, method: str, path: str, body: Optional[bytes], headers: Dict[str, str],
              as_text: bool, timeout: float) -> Any:
        request = urllib.request.Request(f"{self.root}{path}", data=body, method=method)
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", self.user_agent)
        for key, value in headers.items():
            request.add_header(key, value)
        request.add_header("Authorization", f"Bearer {self._token}")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if response.status == 204 or not raw:
                    return None
                text = raw.decode("utf-8")
                return text if as_text else json.loads(text)
        except urllib.error.HTTPError as answer:
            raise self._error_of(answer) from None
        except (socket.timeout, TimeoutError) as cause:
            raise Timeout(f"{method} {path} took longer than {timeout} s.", code="TIMEOUT") from cause
        except urllib.error.URLError as cause:
            if isinstance(cause.reason, (socket.timeout, TimeoutError)):
                raise Timeout(f"{method} {path} took longer than {timeout} s.", code="TIMEOUT") from cause
            raise NetworkError(f"{method} {path} got no answer: {cause.reason}", code="NETWORK") from cause
        except (ConnectionError, OSError) as cause:
            raise NetworkError(f"{method} {path} got no answer: {cause}", code="NETWORK") from cause

    @staticmethod
    def _error_of(answer: urllib.error.HTTPError) -> OvertoneError:
        try:
            payload = json.loads(answer.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError, OSError):
            payload = None
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        if not isinstance(error, dict):
            error = {}
        kind = _BY_STATUS.get(answer.code, OvertoneError)
        return kind(error.get("message") or f"HTTP {answer.code}", status=answer.code,
                    code=error.get("code"), details=error.get("details"),
                    retry_after=retry_after_seconds(answer.headers.get("Retry-After")))

    @staticmethod
    def _id(value: str) -> str:
        return urllib.parse.quote(str(value), safe="")

    # ── Reads ─────────────────────────────────────────────────────────────

    def health(self) -> dict:
        """``{status}`` of the API. Any token."""
        return self.request("GET", "/health")

    def me(self) -> dict:
        """The token's account: ``{account}``. Any token."""
        return self.request("GET", "/me")

    def analysis(self, analysis_id: str) -> dict:
        """One of your analyses: status, queue position, progress, and the result once done. ``read:analyses``."""
        return self.request("GET", f"/analyses/{self._id(analysis_id)}")

    def my_analyses(self, **filters: Any) -> dict:
        """One page of your analyses: ``{analyses, next}``. Filters: q, status, bpmMin, bpmMax, from, to, limit, cursor."""
        return self.request("GET", f"/me/analyses{query_of(filters)}")

    def all_my_analyses(self, **filters: Any) -> Iterator[dict]:
        """Every analysis of yours under ``filters``, page after page."""
        cursor = filters.pop("cursor", None)
        while True:
            page = self.my_analyses(**filters, cursor=cursor)
            yield from page["analyses"]
            cursor = page.get("next")
            if not cursor:
                return

    def analysis_versions(self, analysis_id: str) -> dict:
        """The saved versions of one of your analyses (W12.21). ``read:analyses``."""
        return self.request("GET", f"/analyses/{self._id(analysis_id)}/versions")

    def analysis_timing_text(self, analysis_id: str) -> str:
        """Your analysis's ``[TimingPoints]`` block. ``read:analyses``."""
        return self.request("GET", f"/analyses/{self._id(analysis_id)}/timing.txt", as_text=True)

    def analysis_timing_csv(self, analysis_id: str) -> str:
        """Your analysis's red lines as CSV. ``read:analyses``."""
        return self.request("GET", f"/analyses/{self._id(analysis_id)}/timing.csv", as_text=True)

    def timings(self, **filters: Any) -> dict:
        """One page of everyone's published timings: ``{timings, next}``. ``read:timings``."""
        return self.request("GET", f"/timings{query_of(filters)}")

    def timing(self, timing_id: str) -> dict:
        """One published timing, with its result. ``read:timings``."""
        return self.request("GET", f"/timings/{self._id(timing_id)}")

    def timing_text(self, timing_id: str) -> str:
        """A published timing's ``[TimingPoints]`` block. ``read:timings``."""
        return self.request("GET", f"/timings/{self._id(timing_id)}/timing.txt", as_text=True)

    def timing_csv(self, timing_id: str) -> str:
        """A published timing's red lines as CSV. ``read:timings``."""
        return self.request("GET", f"/timings/{self._id(timing_id)}/timing.csv", as_text=True)

    # ── Uploads ───────────────────────────────────────────────────────────

    def upload(self, data: Union[bytes, bytearray, memoryview], filename: str, *, mode: Optional[str] = None,
               options: Optional[dict] = None, private: bool = False, title: Optional[str] = None,
               artist: Optional[str] = None, duration: Optional[float] = None, lookup: bool = True) -> dict:
        """Sends a song as the token's account (``upload``), within its daily quota.

        Returns ``{id, status, cached}`` at once; :meth:`wait_for` waits for
        the result. ``filename``'s extension names the format (mp3, ogg, wav,
        flac, m4a, opus). With ``lookup`` (the default) the audio's SHA-1 is
        asked first, and a song the engine already knows is not uploaded.
        """
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError("upload() needs a filename, with its extension.")
        data = bytes(data)
        if lookup:
            ask: Dict[str, Any] = {"sha1": hashlib.sha1(data).hexdigest(), "filename": filename,
                                   "size": len(data), "private": bool(private)}
            for key, value in (("title", title), ("artist", artist), ("mode", mode),
                               ("options", options), ("duration", duration)):
                if value is not None:
                    ask[key] = value
            found = self.request("POST", "/analyses/lookup", body=json.dumps(ask).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
            if found.get("cached"):
                return found
        headers = {"Content-Type": "application/octet-stream", "X-Filename": _quote(filename)}
        if private:
            headers["X-Private"] = "1"
        if title:
            headers["X-Title"] = _quote(title)
        if artist:
            headers["X-Artist"] = _quote(artist)
        if mode:
            headers["X-Mode"] = mode
        if options:
            headers["X-Options"] = _quote(json.dumps(options, separators=(",", ":")))
        if duration is not None:
            headers["X-Duration"] = str(duration)
        return self.request("POST", "/analyses", body=data, headers=headers, timeout=self.upload_timeout)

    def wait_for(self, analysis_id: str, *, interval: float = 2.0, timeout: float = 1800.0,
                 on_update: Optional[Callable[[dict], None]] = None) -> dict:
        """Polls one of your analyses until it is done, refused or failed, and returns it.

        A refusal (``status == "refused"``: no steady pulse) is an answer, not
        an error; ``failed`` raises :class:`AnalysisFailed`. A passing
        502/503/504 or lost connection is polled through (five in a row raise).
        """
        deadline = time.monotonic() + timeout
        strikes = 0
        while True:
            row = None
            try:
                row = self.analysis(analysis_id)
                strikes = 0
            except (NetworkError, Timeout):
                strikes += 1
                if strikes >= 5:
                    raise
            except OvertoneError as error:
                if error.status not in _TRANSIENT:
                    raise
                strikes += 1
                if strikes >= 5:
                    raise
            if row is not None:
                if on_update:
                    on_update(row)
                if row.get("status") == "failed":
                    failure = AnalysisFailed(row.get("error") or "The analysis failed.", code="ANALYSIS_FAILED")
                    failure.analysis = row
                    raise failure
                if row.get("status") in _TERMINAL:
                    return row
            if time.monotonic() + interval > deadline:
                raise Timeout(f"Analysis {analysis_id} did not finish within {timeout} s.", code="TIMEOUT")
            time.sleep(interval)

    def analyze(self, data: Union[bytes, bytearray, memoryview], filename: str, *, interval: float = 2.0,
                timeout: float = 1800.0, on_update: Optional[Callable[[dict], None]] = None,
                **upload: Any) -> dict:
        """:meth:`upload` then :meth:`wait_for`: the finished analysis."""
        created = self.upload(data, filename, **upload)
        return self.wait_for(created["id"], interval=interval, timeout=timeout, on_update=on_update)

    def analyze_file(self, path: Union[str, "os.PathLike[str]"], *, filename: Optional[str] = None,
                     **options: Any) -> dict:
        """Reads ``path`` and analyses it, named by its own file name unless ``filename`` says otherwise."""
        with open(path, "rb") as handle:
            data = handle.read()
        return self.analyze(data, filename or os.path.basename(os.fspath(path)), **options)
