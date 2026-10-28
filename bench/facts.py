"""Check the facts the docs state against the repository they describe.

    python bench/facts.py

Test counts, the crate list and the golden fixture count are written into
CLAUDE.md, AGENTS.md, README.md and the roadmap by hand, and drift the moment
a test lands: the audit found CLAUDE.md still saying 75 Rust tests long after
that stopped being true. This reads the numbers from the source instead and names every
document that disagrees. It also holds the library index's two sides together:
the schema version library.sql states and the one overtone_library.py reads. It runs no analysis and imports nothing heavy.

Counts are static: a Rust test is a `#[test]` attribute, a Python test a
`def test_` method, a site test a top-level `test(` call in `site/api/test`,
`site/web/test` or `bot/test`. None of the suites has parametrised, inherited or nested
tests, so the static count is what `cargo test`, `unittest` and `node --test`
report; if that ever stops being true, this is the place to say so.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def rust_tests() -> int:
    return sum(len(re.findall(r"^\s*#\[test\]", p.read_text(encoding="utf-8"), re.M))
               for p in (ROOT / "crates").rglob("*.rs"))


def _count(path: Path) -> int:
    return len(re.findall(r"^\s+def test_", path.read_text(encoding="utf-8"), re.M))


def python_tests() -> tuple[int, int, int]:
    """(all, engine, worker): every tests/test_*.py file, which is what
    `unittest discover -s tests` runs, and the two the docs break out."""
    total = sum(_count(p) for p in (ROOT / "tests").glob("test_*.py"))
    engine, worker = (_count(ROOT / "tests" / name) for name in ("test_overtone.py", "test_worker.py"))
    return total, engine, worker


def site_tests() -> tuple[int, int]:
    """(site/api, site/web): the `test(` calls `node --test "test/*.test.js"` runs
    in each package, one per test since none is nested or generated."""
    def count(package: str) -> int:
        return sum(len(re.findall(r"^test\(", p.read_text(encoding="utf-8"), re.M))
                   for p in (ROOT / "site" / package / "test").glob("*.test.js"))
    return count("api"), count("web")


def bot_tests() -> int:
    """The Discord bot's `test(` calls (bot/test), counted as the site's are."""
    return sum(len(re.findall(r"^test\(", p.read_text(encoding="utf-8"), re.M))
               for p in (ROOT / "bot" / "test").glob("*.test.js"))


def crate_dirs() -> list[str]:
    return sorted(p.parent.name for p in (ROOT / "crates").glob("*/Cargo.toml"))


def workspace_members() -> list[str]:
    text = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
    block = re.search(r"members\s*=\s*\[(.*?)\]", text, re.S)
    return sorted(Path(m).name for m in re.findall(r'"([^"]+)"', block.group(1))) if block else []


def golden_vectors() -> int:
    return len(list((ROOT / "bench" / "golden").glob("*.json")))


def library_schema() -> tuple[int | None, int | None]:
    """The schema version library.sql states, and the one overtone_library.py
    reads. Two languages describe one database; this is where they meet."""
    sql = re.search(r"^--\s*schema-version:\s*(\d+)",
                    (ROOT / "python" / "library.sql").read_text(encoding="utf-8"), re.M)
    code = re.search(r"^SCHEMA_VERSION = (\d+)",
                     (ROOT / "python" / "overtone_library.py").read_text(encoding="utf-8"), re.M)
    return (int(sql.group(1)) if sql else None), (int(code.group(1)) if code else None)


def main() -> int:
    problems: list[str] = []
    rust = rust_tests()
    python, engine, worker = python_tests()
    if python != engine + worker:
        problems.append(f"tests/ holds {python - engine - worker} tests outside the two files "
                        "the docs break out; name the new file in python_tests() and the roadmap")
    crates = crate_dirs()
    golden = golden_vectors()
    site_api, site_web = site_tests()
    bot = bot_tests()
    print(f"source: {python} Python tests ({engine} engine + {worker} worker), "
          f"{rust} Rust tests, {len(crates)} crates, {golden} golden vectors, "
          f"{site_api} site/api, {site_web} site/web and {bot} bot tests")

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
               re.findall(r"discover -s tests\s+# all pass \((\d+) on", text), python)
        expect(doc, "Rust tests",
               re.findall(r"cargo test --workspace\s+# all pass \((\d+) on", text), rust)
        expect(doc, "golden vectors", re.findall(r"(\d+) committed vector files", text), golden)
        expect(doc, "golden cases in the golden check",
               re.findall(r"golden\.py check\s+# (\d+)/\d+", text), golden)
        expect(doc, "site/api tests",
               re.findall(r"pnpm --dir site/api test\s+# all pass \((\d+) on", text), site_api)
        # site/web had no tests when this check was written: its line is
        # required from the first one on, and must not outlive the last.
        stated_web = re.findall(r"pnpm --dir site/web test\s+# all pass \((\d+) on", text)
        if site_web or stated_web:
            expect(doc, "site/web tests", stated_web, site_web)
        expect(doc, "bot tests",
               re.findall(r"pnpm --dir bot test\s+# all pass \((\d+) on", text), bot)
        listed = sorted(set(re.findall(r"^\s+(overtone-[a-z]+)/", text, re.M)))
        if listed != crates:
            problems.append(f"{doc}: layout lists crates {listed}, crates/ holds {crates}")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    badge = re.findall(r"tests-(\d+)%20Python%20%C2%B7%20(\d+)%20Rust", readme)
    expect("README.md badge", "Python tests", [b[0] for b in badge], python)
    expect("README.md badge", "Rust tests", [b[1] for b in badge], rust)
    expect("README.md", "Python tests",
           re.findall(r"discover -s tests\s+# (\d+) tests", readme), python)
    expect("README.md", "Rust tests",
           re.findall(r"cargo test --workspace\s+# (\d+) tests", readme), rust)

    roadmap = (ROOT / "docs" / "07-roadmap.md").read_text(encoding="utf-8")
    line = re.findall(r"Tests: \*\*(\d+)\*\* Python \((\d+) engine \+ (\d+) worker\) "
                      r"· \*\*(\d+)\*\* Rust", roadmap)
    expect("roadmap", "Python tests", [m[0] for m in line], python)
    expect("roadmap", "engine tests", [m[1] for m in line], engine)
    expect("roadmap", "worker tests", [m[2] for m in line], worker)
    expect("roadmap", "Rust tests", [m[3] for m in line], rust)

    sql_version, code_version = library_schema()
    print(f"library schema: library.sql v{sql_version}, overtone_library.py v{code_version}")
    if sql_version is None or sql_version != code_version:
        problems.append(f"library.sql states schema {sql_version}, "
                        f"overtone_library.py reads {code_version}")

    members = workspace_members()
    if members != crates:
        problems.append(f"Cargo.toml: workspace members {members}, crates/ holds {crates}")

    # The fixture manifest the Rust bench reads, against the Python
    # definitions and the committed vectors it is derived from. Adding a case
    # on one side and forgetting the other is the drift this catches.
    import fixtures as fx
    drifted = fx.drift()
    print(f"fixtures: {len(fx.derive())} in the code, "
          f"{len(fx.committed())} in {fx.MANIFEST.name}")
    problems += [f"{fx.MANIFEST.name}: {line}" for line in drifted]

    # Where each v3 engine guarantee lives: the claim the roadmap's P0 row
    # makes is this manifest, so state its count with the others and fail on a
    # stage nobody has placed rather than on a sentence going quietly stale.
    import parity
    manifest, touched = parity.committed(), parity.tests()
    said = parity.verdict(manifest, touched)
    total = sum(len(per) for per in touched.values())
    print(f"rust parity: {len(said['held'])} of {total} v3 engine tests held in Rust, "
          f"{len(manifest.get('symbols', {}))} stages placed")
    problems += [f"{parity.MANIFEST.name}: {line}"
                 for line in parity.problems(manifest, touched, parity.rust_tests())]

    for problem in problems:
        print("MISMATCH", problem)
    print("facts: ok" if not problems else f"facts: {len(problems)} mismatch(es)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
