"""Write or remove the browser pane's launch.json for the UI harness.

    python launch.py up   --root SESSION_ROOT [--audio FILE] [--pick FOLDER] [--port 8766]
    python launch.py down --root SESSION_ROOT

``--root`` is the folder the Claude session was opened in: the browser pane
reads ``<root>/.claude/launch.json``. ``down`` deletes the file, and the
``.claude`` folder too when nothing else is in it, so no trace is left
outside the repo. Re-running ``up`` rewrites the file.
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
NAME = "overtone-harness"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("up", "down"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--audio", default="")
    parser.add_argument("--pick", default="")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    folder = Path(args.root) / ".claude"
    target = folder / "launch.json"
    if args.action == "down":
        if target.is_file():
            config = json.loads(target.read_text(encoding="utf-8"))
            names = {c.get("name") for c in config.get("configurations", [])}
            if names != {NAME}:
                print(f"{target} holds other configurations too; left alone.")
                return 1
            target.unlink()
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
        print("removed")
        return 0
    python = REPO / ".venv" / "Scripts" / "python.exe"
    if not python.is_file():
        python = Path(sys.executable)
    run = [str(HERE / "harness.py"), "--port", str(args.port)]
    if args.audio:
        run.insert(1, args.audio)
    if args.pick:
        run += ["--pick", args.pick]
    if target.is_file():
        names = {c.get("name") for c in json.loads(target.read_text(encoding="utf-8"))
                 .get("configurations", [])}
        if names - {NAME}:
            print(f"{target} holds other configurations; not overwritten.")
            return 1
    folder.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"version": "0.0.1", "configurations": [
        {"name": NAME, "runtimeExecutable": str(python), "runtimeArgs": run,
         "port": args.port}]}, indent=2), encoding="utf-8")
    print(f"wrote {target}: preview_start name={NAME}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
