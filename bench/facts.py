"""Check the facts the docs state against the repository they describe.

    python bench/facts.py

Test counts, the crate list and the golden fixture count are written into
CLAUDE.md, AGENTS.md, README.md and the roadmap by hand, and drift the moment
a test lands: the audit found CLAUDE.md still saying 75 Rust tests long after
that stopped being true. This reads the numbers from the source instead and names every
document that disagrees. It runs no analysis and imports nothing heavy.

Counts are static: a Rust test is a `#[test]` attribute, a Python test a
`def test_` method. Both suites have neither parametrised nor inherited tests,
so the static count is what `cargo test` and `unittest` report; if that ever
stops being true, this is the place to say so.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def rust_tests() -> int:
    return sum(len(re.findall(r"^\s*#\[test\]", p.read_text(encoding="utf-8"), re.M))
               for p in (ROOT / "crates").rglob("*.rs"))


def python_tests() -> tuple[int, int]:
    count = [len(re.findall(r"^\s+def test_", (ROOT / name).read_text(encoding="utf-8"), re.M))
             for name in ("test_overtone.py", "test_overtone_web.py")]
    return count[0], count[1]


def crate_dirs() -> list[str]:
    return sorted(p.parent.name for p in (ROOT / "crates").glob("*/Cargo.toml"))


def workspace_members() -> list[str]:
    text = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
    block = re.search(r"members\s*=\s*\[(.*?)\]", text, re.S)
    return sorted(Path(m).name for m in re.findall(r'"([^"]+)"', block.group(1))) if block else []


def golden_vectors() -> int:
    return len(list((ROOT / "bench" / "golden").glob("*.json")))


def main() -> int:
    problems: list[str] = []
    rust = rust_tests()
    engine, web = python_tests()
    python = engine + web
    crates = crate_dirs()
    golden = golden_vectors()
    print(f"source: {python} Python tests ({engine} engine + {web} web shell), "
          f"{rust} Rust tests, {len(crates)} crates, {golden} golden vectors")

    def expect(doc: str, what: str, found: list[str], want: int) -> None:
        if not found:
            problems.append(f"{doc}: states no {what} (the pattern was not found)")
        for value in found:
            if int(value) != want:
                problems.append(f"{doc}: says {value} {what}, the source has {want}")

    claude = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    if claude != agents:
        problems.append("AGENTS.md differs from CLAUDE.md; they must be identical")
    for doc, text in (("CLAUDE.md", claude),):
        expect(doc, "Python tests",
               re.findall(r"test_overtone_web\s+# all pass \((\d+) on", text), python)
        expect(doc, "Rust tests",
               re.findall(r"cargo test --workspace\s+# all pass \((\d+) on", text), rust)
        expect(doc, "golden vectors", re.findall(r"(\d+) committed vector files", text), golden)
        expect(doc, "golden cases in the golden check",
               re.findall(r"golden\.py check\s+# (\d+)/\d+", text), golden)
        listed = sorted(set(re.findall(r"^\s+(overtone-[a-z]+)/", text, re.M)))
        if listed != crates:
            problems.append(f"{doc}: layout lists crates {listed}, crates/ holds {crates}")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    badge = re.findall(r"tests-(\d+)%20Python%20%C2%B7%20(\d+)%20Rust", readme)
    expect("README.md badge", "Python tests", [b[0] for b in badge], python)
    expect("README.md badge", "Rust tests", [b[1] for b in badge], rust)
    expect("README.md", "Python tests",
           re.findall(r"test_overtone_web\s+# (\d+) tests", readme), python)
    expect("README.md", "Rust tests",
           re.findall(r"cargo test --workspace\s+# (\d+) tests", readme), rust)

    roadmap = (ROOT / "docs" / "07-roadmap.md").read_text(encoding="utf-8")
    line = re.findall(r"Tests: \*\*(\d+)\*\* Python \((\d+) engine \+ (\d+) web shell\) "
                      r"· \*\*(\d+)\*\* Rust", roadmap)
    expect("roadmap", "Python tests", [m[0] for m in line], python)
    expect("roadmap", "engine tests", [m[1] for m in line], engine)
    expect("roadmap", "web shell tests", [m[2] for m in line], web)
    expect("roadmap", "Rust tests", [m[3] for m in line], rust)

    members = workspace_members()
    if members != crates:
        problems.append(f"Cargo.toml: workspace members {members}, crates/ holds {crates}")

    for problem in problems:
        print("MISMATCH", problem)
    print("facts: ok" if not problems else f"facts: {len(problems)} mismatch(es)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
