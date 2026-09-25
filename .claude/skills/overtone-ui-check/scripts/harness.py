"""Serve app/ with the real bridge behind fetch, so the web shell runs in a browser.

    python harness.py [audio-file] [--pick FOLDER] [--port 8766]

The page gets window.pywebview.api as a Proxy: every call is POSTed to
/api/<method> and runs on a real overtone_web.Api. Nothing of the user's is
touched: the config is never read or written (load/save patched), and
LOCALAPPDATA points at a fresh scratch folder, so the result cache, drops and
the library index start empty. Audio is silent: every connection to the
speakers goes through a gain-0 node, installed before app.js runs.

``--pick`` is what every folder or file dialog answers (none by default).
"""
import argparse
import json
import os
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

# repo/.claude/skills/overtone-ui-check/scripts/harness.py
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

parser = argparse.ArgumentParser()
parser.add_argument("audio", nargs="?", default="")
parser.add_argument("--pick", default="")
parser.add_argument("--port", type=int, default=8766)
ARGS = parser.parse_args()

os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="overtone-harness-")
import overtone as ta  # noqa: E402

mock.patch.object(ta, "load_config", return_value={}).start()
mock.patch.object(ta, "save_config", lambda data: None).start()
import overtone_web as web  # noqa: E402

API = web.Api(ARGS.audio)
EVENTS: list[str] = []


class FakeWindow:
    def evaluate_js(self, script: str) -> None:
        EVENTS.append(script)

    def create_file_dialog(self, *args, **kwargs):
        return [ARGS.pick] if ARGS.pick else None


API._window = FakeWindow()
SHIM = b"""
<script>
// Silent: whatever the page connects to the speakers goes through gain 0.
(() => {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      if (!ctx.__sink) { ctx.__sink = ctx.createGain(); ctx.__sink.gain.value = 0; connect.call(ctx.__sink, ctx.destination); }
      return connect.call(this, ctx.__sink, ...rest);
    }
    return connect.call(this, dest, ...rest);
  };
})();
window.pywebview = { api: new Proxy({}, { get: (_t, name) => async (...args) => {
  const r = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(args) });
  return r.json();
} }) };
// Engine events (onResult, onProgress...) arrive by polling, as evaluate_js
// would run them. One poll at a time: a slow server must not pile them up.
(async function poll() {
  try { const r = await fetch('/events'); for (const s of await r.json()) eval(s); } catch (e) {}
  setTimeout(poll, 150);
})();
window.addEventListener('load', () => window.dispatchEvent(new Event('pywebviewready')));
</script>
"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO / "app"), **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/events":
            out, EVENTS[:] = list(EVENTS), []
            return self._json(out)
        if self.path in ("/", "/index.html"):
            html = (REPO / "app" / "index.html").read_bytes()
            html = html.replace(b'<script src="app.js">', SHIM + b'<script src="app.js">')
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html)
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        name = self.path.rsplit("/", 1)[-1]
        args = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"[]")
        if name.startswith("_") or not hasattr(API, name):
            return self._json({"ok": False, "key": "no_such_call"})
        try:
            result = getattr(API, name)(*args)
        except Exception as exc:  # noqa: BLE001 -- the page shows it, the harness goes on
            result = {"ok": False, "key": "error", "detail": f"{type(exc).__name__}: {exc}"}
        return self._json(result)

    def _json(self, value):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()
