"""The one list of bench fixtures, for Python and Rust both.

``bench/audio/`` is generated and never committed, so every gate has to cope
with a fixture that is not rendered here. The hazard is the quiet one: a gate
that skips what it cannot find and passes with less measured than its
documented count. Each gate guards against that on its own, but they guarded
against *different lists* — the Rust bench walked ``bench/golden/*.json`` for
its cases, which does not hold the three coverage fixtures, so the density
gate carried a hand-written copy of their names to add them back. A fourth
one added on the Python side would have been invisible to it.

So the list lives once, here, derived from the definitions that already exist
(``benchmark.CASES``, ``gates.COVERAGE_CASES``, ``gates.MEASURE_CASES``, the
signature fixture and the degenerate ones), and is written to
``bench/fixtures.json`` for the Rust bench to read. ``bench/facts.py`` holds
the committed file to what this derives, so the two cannot drift in silence:
adding a case in Python and forgetting to write the manifest fails a check
that is already run before every commit.

    python bench/fixtures.py            # print the manifest as it derives
    python bench/fixtures.py --update   # write bench/fixtures.json

Each entry says how the fixture is rendered (the exact command, which the
Rust bench prints when it finds one missing), and which gates need it:

``golden``     a golden vector is committed for it, so the per-stage check,
               the map gate and the elastic gate iterate it.
``density``    the density gate must measure it; with one missing the gate
               fails rather than reporting a smaller total.
``signature``  a signature-step fixture, judged by ``gates.py signatures``
               and skipped by the others.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import benchmark as bm  # noqa: E402
import gates  # noqa: E402

MANIFEST = HERE / "fixtures.json"
#: Bumped when an entry grows or loses a field, so an older file is named
#: rather than read as this one.
FORMAT = 1

#: How each family is rendered. The Rust bench prints this beside a fixture it
#: cannot find, so it must stay the command that actually makes that file.
RENDER_CORPUS = "python bench/benchmark.py"
RENDER_COVERAGE = "python bench/gates.py coverage"
RENDER_MEASURES = "python bench/gates.py measures"
RENDER_SIGNATURES = "python bench/gates.py signatures"
RENDER_GOLDEN = "python bench/golden.py dump"
RENDER_ELASTIC = "python proto/elastic.py"

#: Degenerate audio: no pulse to find. `benchmark.py` renders them beside the
#: corpus and the robustness and no-grid gates read them.
DEGENERATE = ("_ramp", "_ambient", "_silence", "_noise")
#: The elastic prototype's ramps, rendered by it alone.
ELASTIC_RAMPS = ("ramp-120-160", "ramp-180-140", "ramp-90-200")
#: One fixture whose bar length steps; the signature gate judges it.
SIGNATURE = "signature-changes"


def derive() -> dict[str, dict]:
    """The manifest as the Python definitions and the committed vectors imply
    it, in one order.

    ``golden`` is read from ``bench/golden/`` rather than assumed per family:
    the vectors are committed, and not every fixture has one on purpose —
    ``downbeat-3-4`` is a measure case with no vector, so the gates that walk
    the vectors do not see it, and saying otherwise here would be a second
    list to drift. ``density`` is what the density gate measures today (every
    fixture with a vector, plus the three coverage ones); widening it is a
    change to that gate's totals, to be made and measured on purpose.
    """
    out: dict[str, dict] = {}
    vectors = {path.stem for path in (HERE / "golden").glob("*.json")}

    def add(name: str, render: str, *, density: bool = False) -> None:
        assert name not in out, f"{name} is listed twice"
        golden = name in vectors
        out[name] = {"render": render, "golden": golden,
                     "density": (golden or density) and name != SIGNATURE,
                     "signature": name == SIGNATURE}

    for name in bm.CASES:
        add(name, RENDER_CORPUS)
    for name in gates.COVERAGE_CASES:
        add(name, RENDER_COVERAGE, density=True)
    for name in gates.MEASURE_CASES:
        add(name, RENDER_MEASURES)
    add(SIGNATURE, RENDER_SIGNATURES)
    for name in DEGENERATE:
        add(name, RENDER_CORPUS)
    for name in ELASTIC_RAMPS:
        add(name, RENDER_ELASTIC)
    return dict(sorted(out.items()))


def manifest() -> dict:
    return {"_comment": "The one list of bench fixtures; bench/fixtures.py --update "
                        "writes it, bench/facts.py holds it to the Python definitions",
            "format": FORMAT, "fixtures": derive()}


def committed(path: Path | None = None) -> dict[str, dict]:
    """What the committed manifest holds, or {} when it is absent or older."""
    path = MANIFEST if path is None else path
    if not path.exists():
        return {}
    body = json.loads(path.read_text(encoding="utf-8"))
    return body.get("fixtures", {}) if body.get("format") == FORMAT else {}


def drift(have: dict[str, dict] | None = None) -> list[str]:
    """How the committed manifest differs from the definitions, in words."""
    want = derive()
    have = committed() if have is None else have
    problems = [f"{name}: in the code, not in {MANIFEST.name}" for name in want if name not in have]
    problems += [f"{name}: in {MANIFEST.name}, not in the code" for name in have if name not in want]
    for name in want:
        if name in have and have[name] != want[name]:
            problems.append(f"{name}: {have[name]} -> {want[name]}")
    return problems


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--update" in args:
        MANIFEST.write_text(json.dumps(manifest(), indent=1) + "\n", encoding="utf-8")
        print(f"Wrote {MANIFEST.name}: {len(derive())} fixtures.")
        return 0
    problems = drift()
    for name, entry in derive().items():
        needs = " ".join(k for k in ("golden", "density", "signature") if entry[k]) or "-"
        print(f"{name:<22} {needs:<24} {entry['render']}")
    print(f"\n{len(derive())} fixtures")
    if problems:
        print(f"\n{MANIFEST.name} has drifted:")
        for line in problems:
            print(f"  {line}")
        print("Write it again with --update.")
        return 1
    print(f"{MANIFEST.name} matches.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
