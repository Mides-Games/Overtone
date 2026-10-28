"""Analyse one song and print its red lines and the [TimingPoints] block.

    OVERTONE_TOKEN=ot_... python examples/analyze.py path/to/song.mp3

OVERTONE_URL points it at another Overtone (http://127.0.0.1:3001, say).
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from overtone_client import DEFAULT_BASE_URL, Overtone, OvertoneError  # noqa: E402


def status(row):
    text = row["status"]
    if row.get("position"):
        text += f" (#{row['position']} in the queue)"
    if row.get("progress"):
        text += f" {round(row['progress'] * 100)}%"
    sys.stderr.write(f"\r{text}   ")


def main(argv):
    if len(argv) != 1:
        print("usage: python examples/analyze.py <audio file>", file=sys.stderr)
        return 2
    overtone = Overtone(os.environ.get("OVERTONE_TOKEN", ""), os.environ.get("OVERTONE_URL") or DEFAULT_BASE_URL)
    try:
        row = overtone.analyze_file(argv[0], on_update=status)
    except OvertoneError as error:
        print(f"\n{type(error).__name__} {error}", file=sys.stderr)
        return 1
    sys.stderr.write("\n")
    if row["status"] == "refused":
        print(f"No steady pulse: {(row['result'].get('refusal') or {}).get('message', 'refused')}")
        return 0
    for line in row["result"]["red_lines"]:
        print(f"{line['time_ms'] / 1000:9.3f} s  {line['bpm']:.3f} BPM  {line['meter']}/4")
    print(overtone.analysis_timing_text(row["id"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
