"""The newest published timings, and the first of them as CSV.

    OVERTONE_TOKEN=ot_... python examples/recent.py [search words]
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from overtone_client import DEFAULT_BASE_URL, Overtone  # noqa: E402

overtone = Overtone(os.environ.get("OVERTONE_TOKEN", ""), os.environ.get("OVERTONE_URL") or DEFAULT_BASE_URL)
page = overtone.timings(q=" ".join(sys.argv[1:]), limit=10)
for t in page["timings"]:
    song = " - ".join(x for x in (t.get("artist"), t.get("title")) if x) or "(untitled)"
    print(f"{t['id']}  {t.get('bpm') or '?':>7} BPM  {t['redLines']:>3} lines  {song}")
if page["timings"]:
    print()
    print(overtone.timing_csv(page["timings"][0]["id"]))
