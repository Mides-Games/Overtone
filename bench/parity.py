"""Which v3 engine guarantees the Rust engine holds too, and which it cannot.

Roadmap P0 asked for "the v3 tests by name" and the status line said "partial:
271 Rust tests, not every v3 name" — a sentence nobody could act on. It does
not say which names are missing, and the Rust engine is not a copy of the
Python one: it has no window, writes no map, and never grew the v2 fallback
tracker, so a good part of the 518 Python engine tests *cannot* have a Rust
twin. Without that distinction written down, "not every name" reads as a debt
when most of it is a boundary.

So the boundary lives here, one line per engine symbol, and the gate derives
the rest:

``rust``         the Rust engine implements it, and these named tests hold it.
``legacy``       the v2 fallback tracker. Rust implements the precision engine
                 only; the shell still falls back to Python for rubato and
                 non-percussive audio, so these guarantees stay Python's.
``python-only``  a stage that exists only in Python (the reason says which).
``shell``        window, report or file IO. The Rust engine writes no map.

A test is **held in Rust** when any symbol it touches is ``rust``; a test that
touches only the other three is outside the Rust engine's surface, and saying
so is the point. Every ``rust`` entry names real ``#[test]`` functions and the
gate opens the crates to check they are still there, so a rename cannot leave
a false claim behind, and a new engine symbol with no line here fails rather
than passing unnoticed.

    python bench/parity.py          # the report, and 0 when it holds
    python bench/parity.py --tests  # per test, for reading down the list

What this measures is the *surface*, not one Rust test per Python test: a
symbol with one Rust test beside twelve Python ones counts as held. The count
it prints is therefore an upper bound on parity, and the honest way to read it
is "no engine stage is untested in Rust", not "every scenario is covered".
"""
from __future__ import annotations

import ast
import inspect
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import overtone as ov  # noqa: E402

MANIFEST = HERE / "parity.json"
FORMAT = 1
WHERE = ("rust", "legacy", "python-only", "shell", "bench")

#: Test classes that reach the engine only through ``mock.patch.object`` or a
#: helper too indirect to follow, with what they hold instead. Kept as whole
#: classes: a per-test list here would be a second copy of the test file.
CLASSES = "classes"


def _engine_symbols(tree: ast.Module) -> set[str]:
    """Every engine name the test file names, imported or reached as ``ov.x``.

    A test patching ``overtone.os`` names a module, not a guarantee, so the
    check asks the engine itself rather than keeping a list of stdlib names.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("overtone"):
            names |= {a.asname or a.name for a in node.names}
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                and node.value.id in ("ov", "overtone"):
            names.add(node.attr)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "object" and node.args \
                and isinstance(node.args[0], ast.Name) \
                and node.args[0].id in ("ov", "overtone"):
            names |= {a.value for a in node.args[1:]
                      if isinstance(a, ast.Constant) and isinstance(a.value, str)}
    return {n for n in names
            if hasattr(ov, n) and not inspect.ismodule(getattr(ov, n))}


def _used(node: ast.AST, pool: set[str], helpers: dict[str, set[str]]) -> set[str]:
    """The engine symbols a function body reaches, one helper deep."""
    found: set[str] = set()
    for inner in ast.walk(node):
        if isinstance(inner, ast.Name):
            if inner.id in pool:
                found.add(inner.id)
            elif inner.id in helpers:
                found |= helpers[inner.id]
        elif isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name):
            if inner.value.id in ("ov", "overtone") and inner.attr in pool:
                found.add(inner.attr)
            # ``self._events(...)``: a helper on the class, which the caller
            # reaches the engine through.
            elif inner.value.id == "self" and inner.attr in helpers:
                found |= helpers[inner.attr]
        # ``mock.patch.object(overtone, "_load_audio")`` names its target in a
        # string, and patching a stage is as much a use of it as calling it.
        elif isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) \
                and inner.func.attr == "object" and inner.args \
                and isinstance(inner.args[0], ast.Name) \
                and inner.args[0].id in ("ov", "overtone"):
            found |= {a.value for a in inner.args[1:]
                      if isinstance(a, ast.Constant) and a.value in pool}
    return found


def tests() -> dict[str, dict[str, set[str]]]:
    """``{class: {test: {symbol, ...}}}`` for every test in the v3 test file.

    A test that builds its input in a fixture (``setUp``, a shared helper on
    the class) can reach the engine without naming it, so one whose own body
    names nothing takes the symbols its class names between them. The class is
    one behaviour either way, and the alternative — a per-test line in the
    manifest for every fixture-driven test — is a second copy of the test file.
    """
    tree = ast.parse((ROOT / "test_overtone.py").read_text(encoding="utf-8"))
    pool = _engine_symbols(tree)
    helpers: dict[str, set[str]] = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            helpers[node.name] = _used(node, pool, {})
    for node in tree.body:  # a helper calling a helper, resolved once
        if isinstance(node, ast.FunctionDef):
            helpers[node.name] = _used(node, pool, helpers)
    out: dict[str, dict[str, set[str]]] = {}
    for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
        local = dict(helpers)
        for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
            if not fn.name.startswith("test_"):
                local[fn.name] = _used(fn, pool, helpers)
        for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
            if fn.name.startswith("test_"):
                out.setdefault(cls.name, {})[fn.name] = _used(fn, pool, local)
    for per in out.values():
        shared = set().union(*per.values()) if per else set()
        for name, syms in per.items():
            if not syms:
                per[name] = set(shared)
    return out


def rust_tests() -> set[str]:
    """Every ``#[test]`` in the workspace, as ``crate/path.rs::name``."""
    import re

    found: set[str] = set()
    for path in sorted((ROOT / "crates").glob("*/**/*.rs")):
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        rel = path.relative_to(ROOT / "crates").as_posix()
        for m in re.finditer(r"#\[test\]\s*\n\s*fn (\w+)", text):
            found.add(f"{rel}::{m.group(1)}")
    return found


def committed() -> dict:
    """The manifest, or {} when it is absent or written to an older format."""
    if not MANIFEST.exists():
        return {}
    body = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return body if body.get("format") == FORMAT else {}


def problems(manifest: dict, touched: dict[str, dict[str, set[str]]],
             have: set[str]) -> list[str]:
    """What the manifest gets wrong about the code as it stands."""
    symbols = manifest.get("symbols", {})
    classes = manifest.get(CLASSES, {})
    out: list[str] = []
    used = {s for per in touched.values() for syms in per.values() for s in syms}
    for name in sorted(used - set(symbols)):
        out.append(f"{name}: a test touches it, {MANIFEST.name} does not say where it lives")
    for name in sorted(set(symbols) - used):
        out.append(f"{name}: in {MANIFEST.name}, no test touches it")
    for name, entry in sorted(symbols.items()):
        where = entry.get("where")
        if where not in WHERE:
            out.append(f"{name}: unknown 'where' {where!r} (expected one of {', '.join(WHERE)})")
            continue
        if where == "rust":
            for ref in entry.get("rust", []):
                if ref not in have:
                    out.append(f"{name}: names {ref}, which no crate holds any more")
            if not entry.get("rust"):
                out.append(f"{name}: 'rust' with no test named")
        elif not entry.get("why"):
            out.append(f"{name}: {where!r} with no reason given")
    blind = {cls for cls, per in touched.items() if not any(per.values())}
    for cls in sorted(blind - set(classes)):
        out.append(f"{cls}: reaches no engine symbol and {MANIFEST.name} does not say why")
    for cls in sorted(set(classes) - blind):
        out.append(f"{cls}: listed as reaching no engine symbol, but it reaches one")
    for cls, entry in sorted(classes.items()):
        if entry.get("where") not in WHERE:
            out.append(f"{cls}: unknown 'where' {entry.get('where')!r}")
        if not entry.get("why"):
            out.append(f"{cls}: listed with no reason given")
    return out


def verdict(manifest: dict, touched: dict[str, dict[str, set[str]]]) -> dict:
    """How many v3 tests the Rust engine holds, and where the rest live."""
    symbols = manifest.get("symbols", {})
    classes = manifest.get(CLASSES, {})
    held, outside, unreached = [], {}, []
    for cls, per in sorted(touched.items()):
        for name, syms in sorted(per.items()):
            full = f"{cls}.{name}"
            if not syms:
                unreached.append(full)
                where = classes.get(cls, {}).get("where")
                if where:
                    outside.setdefault(where, []).append(full)
                continue
            wheres = {symbols.get(s, {}).get("where") for s in syms}
            if "rust" in wheres:
                held.append(full)
            else:
                for w in sorted(w for w in wheres if w):
                    outside.setdefault(w, []).append(full)
    return {"held": held, "outside": outside, "unreached": unreached,
            "classes": classes,
            "symbols": {w: sorted(n for n, e in symbols.items() if e.get("where") == w)
                        for w in WHERE}}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    manifest = committed()
    if not manifest:
        print(f"{MANIFEST.name} is missing or written to another format.")
        return 1
    touched = tests()
    found = problems(manifest, touched, rust_tests())
    said = verdict(manifest, touched)
    total = sum(len(per) for per in touched.values())
    if "--tests" in args:
        for cls, per in sorted(touched.items()):
            for name, syms in sorted(per.items()):
                where = ("rust" if any(manifest["symbols"].get(s, {}).get("where") == "rust"
                                       for s in syms)
                         else ",".join(sorted({manifest["symbols"].get(s, {}).get("where") or "?"
                                               for s in syms})) or "-")
                print(f"{where:<18} {cls}.{name}")
        print()
    for where in WHERE:
        print(f"{where:<12} {len(said['symbols'][where]):3d} engine symbols")
    print()
    print(f"{len(said['held'])} of {total} v3 engine tests touch a stage the Rust engine holds")
    for where, names in sorted(said["outside"].items()):
        print(f"{len(names):4d} outside it: {where}")
    if said["unreached"]:
        print(f"     of those, {len(said['unreached'])} reach no engine symbol at all: "
              f"{len(said['classes'])} classes, each placed by hand with its reason")
    if found:
        print(f"\n{MANIFEST.name} does not match the code:")
        for line in found:
            print(f"  {line}")
        return 1
    print(f"\n{MANIFEST.name} matches: every stage named in it is where it says, "
          f"and every Rust test it names exists.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
