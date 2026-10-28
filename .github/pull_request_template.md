## What changed

<!-- One or two sentences; the diff already says how. -->

## Why

<!-- The problem, the finding or the roadmap item this answers. -->

## Gates run

<!-- Every gate that applies (CLAUDE.md → Verification), each with its command
and its result. Paste the numbers, not "all green". -->

```
.venv/Scripts/python.exe -m unittest discover -s tests   #
.venv/Scripts/python.exe bench/benchmark.py              #
.venv/Scripts/python.exe bench/facts.py                  #
```

## Checklist

- [ ] one logical change per commit, `type(scope/task): description` in English
- [ ] gates green, with numbers above; `bench/facts.py` clean
- [ ] `docs/timeline.md` entry (or why there is none)
- [ ] roadmap updated if a phase changed
- [ ] no accuracy or speed claim without its measurement in the same commit
