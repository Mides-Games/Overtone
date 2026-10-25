"""Measurement runs on the user's Overtone server, from the command line.

The server (python/overtone_server.py) runs bench/stages.py and
bench/single_bpm.py over the Songs folder it holds and keeps every report
(python/overtone_runs.py). This asks it for runs and fetches what they
found. It talks to that one server only, the one named by ``--url`` (default
http://127.0.0.1:8765: an SSH tunnel to it), with the token from
``$OVERTONE_API_TOKEN`` or ``--token-file``.

    python bench/remote.py status
    python bench/remote.py run anime-single --split dev --jobs 2
    python bench/remote.py run anime-single --baseline save
    python bench/remote.py run bands-variable --all-maps   # graveyard maps too
    python bench/remote.py run --tool single_bpm --sample 200
    python bench/remote.py runs
    python bench/remote.py show <id>
    python bench/remote.py wait <id>
    python bench/remote.py result <id> --out bench/.cache/remote/<id>.json
    python bench/remote.py stop <id>

A report holds one row per map with its folder name, so it stays in
bench/.cache (git-ignored), never in the repository. A measurement, not a gate.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8765"
TOKEN_ENV = "OVERTONE_API_TOKEN"
CACHE = Path(__file__).resolve().parent / ".cache" / "remote"


class Remote:
    def __init__(self, url: str, token: str, timeout: float = 60.0) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as reply:
                return json.loads(reply.read())
        except urllib.error.HTTPError as exc:
            with exc:
                raw = exc.read()
            try:
                detail = json.loads(raw).get("error", raw.decode("utf-8", "replace"))
            except ValueError:
                detail = raw.decode("utf-8", "replace")
            raise SystemExit(f"{method} {path}: HTTP {exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise SystemExit(f"Cannot reach {self.url} ({exc.reason}). "
                             "Is the SSH tunnel open and the service running?") from None


def _token(path: str | None) -> str:
    if os.environ.get(TOKEN_ENV):
        return os.environ[TOKEN_ENV].strip()
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    raise SystemExit(f"No token: set {TOKEN_ENV} or pass --token-file.")


def _pct(value) -> str:
    return "-" if value is None else f"{100.0 * value:.1f}%"


def _line(meta: dict) -> str:
    settings = meta.get("settings", {})
    what = settings.get("stage") or settings.get("tool", "?")
    extra = " ".join(f"{k}={v}" for k, v in settings.items()
                     if k not in ("tool", "stage") and v not in (None, "", False))
    took = f"{meta['seconds']:.0f} s" if meta.get("seconds") is not None else ""
    commit = (meta.get("commit") or "")[:8]
    return f"{meta['id']}  {meta['state']:<11} {what:<16} {extra:<40} {commit}  {took}"


def _summary(summary: dict | None) -> None:
    if not summary:
        return
    for part in ("dev", "holdout"):
        block = summary.get(part)
        if isinstance(block, dict):
            shown = ", ".join(f"{k} {_pct(v) if isinstance(v, float) and v <= 1 else v}"
                              for k, v in block.items() if not isinstance(v, (dict, list)))
            print(f"  {part:<8} {shown}")
    if "convention_ms" in summary:
        print(f"  convention {summary['convention_ms']:+.1f} ms (fitted on dev)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--token-file")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="the server, its index and its runs")
    commands.add_parser("runs", help="every run, newest first")
    run = commands.add_parser("run", help="queue a run")
    run.add_argument("stage", nargs="?", help="a stage of bench/stages.json (tool stages)")
    run.add_argument("--tool", default="stages", choices=("stages", "single_bpm"))
    run.add_argument("--engine", default="rust", choices=("rust", "python"))
    run.add_argument("--split", choices=("dev", "holdout"))
    run.add_argument("--jobs", type=int, default=1)
    run.add_argument("--max-songs", type=int, default=0)
    run.add_argument("--sample", type=int, default=0, help="single_bpm: a seeded sample")
    run.add_argument("--tv", action="store_true", help="single_bpm: TV Size only")
    run.add_argument("--beat-vote", action="store_true", help="with the Beat This! vote (~1.5 GB a job)")
    run.add_argument("--baseline", choices=("save", "compare"))
    run.add_argument("--all-maps", action="store_true",
                     help="every map of the stage, not only ranked and loved (default when "
                          "the server has an osu!.db)")
    run.add_argument("--wait", action="store_true", help="and follow it to its end")
    for name in ("show", "wait", "stop"):
        commands.add_parser(name).add_argument("id")
    result = commands.add_parser("result", help="download a run's report")
    result.add_argument("id")
    result.add_argument("--out", help=f"where (default {CACHE}/<id>.json)")
    args = parser.parse_args(argv)
    remote = Remote(args.url, _token(args.token_file))

    if args.command == "status":
        status = remote.call("GET", "/api/status")
        index = status["index"]
        print(f"server  {status['songs']}  engine {status['engine']}, "
              f"vote {'on' if status.get('beat_vote') else 'off'}")
        print(f"index   {index['sets']} sets, {index['beatmaps']} maps, scanned {index['scanned_at']}")
        overview = remote.call("GET", "/api/v1/runs")
        print(f"code    {(overview.get('commit') or '?')[:12]}, osu!.db "
              f"{'present: runs score ranked and loved maps' if overview.get('osu_db') else 'missing: runs score every map'}")
        print(f"runs    {len(overview['runs'])}, running {overview['queue']['running'] or '-'}, "
              f"queued {len(overview['queue']['queued'])}")
        print("stages  " + ", ".join(s["id"] for s in overview["stages"]))
        return 0
    if args.command == "runs":
        for meta in remote.call("GET", "/api/v1/runs")["runs"]:
            print(_line(meta))
        return 0
    if args.command == "run":
        request = {"tool": args.tool, "engine": args.engine, "jobs": args.jobs,
                   "beat_vote": args.beat_vote, "max_songs": args.max_songs}
        if args.tool == "stages":
            if not args.stage:
                raise SystemExit("Name a stage (python bench/remote.py status lists them).")
            request.update(stage=args.stage, split=args.split or "", baseline=args.baseline or "")
            if args.all_maps:
                request["ranked"] = False
        else:
            request.update(sample=args.sample, tv=args.tv)
        meta = remote.call("POST", "/api/v1/runs", request)
        print(f"queued {meta['id']} (code {(meta.get('commit') or '?')[:12]})")
        if not args.wait:
            return 0
        args.id = meta["id"]
        args.command = "wait"
    if args.command in ("show", "wait"):
        last: str | None = None
        while True:
            detail = remote.call("GET", f"/api/v1/runs/{args.id}")
            log = detail.pop("log", [])
            if args.command == "show":
                print(_line(detail))
                print("\n".join(log[-25:]))
                _summary(detail.get("summary"))
                return 0
            # The server sends the log's tail: print what follows the last
            # line already printed (all of it when that line scrolled away).
            start = 0
            if last is not None and last in log:
                start = len(log) - log[::-1].index(last)
            for line in log[start:]:
                print(line)
            if log:
                last = log[-1]
            if detail["state"] not in ("queued", "running"):
                print(_line(detail))
                _summary(detail.get("summary"))
                return 0 if detail["state"] == "done" else 1
            time.sleep(5)
    if args.command == "result":
        report = remote.call("GET", f"/api/v1/runs/{args.id}/result")
        out = Path(args.out) if args.out else CACHE / f"{args.id}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=1), encoding="utf-8")
        print(f"written: {out} ({len(report.get('maps', []))} maps)")
        _summary(report.get("summary"))
        return 0
    if args.command == "stop":
        print(remote.call("POST", f"/api/v1/runs/{args.id}/stop"))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
