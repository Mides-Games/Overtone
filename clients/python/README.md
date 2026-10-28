# overtone-client (Python)

A client for the [Overtone](https://overtone.midesprojects.com) public API with a
personal token. One module, `overtone_client.py`, standard library only (`urllib`),
Python 3.9 or later.

Community-maintained alongside the site, in the same repository
(`clients/python`); the API's reference is the site's `/developers` page. The
JavaScript client (`clients/js`) has the same surface in camelCase.

## Install

Copy `overtone_client.py` next to your script, or:

```bash
pip install ./path/to/Overtone/clients/python
```

## Tokens

Make a token at `/settings/tokens` on the site (signed in). It is shown once; keep it
in an environment variable. Scopes: `read:analyses` (your analyses and their exports),
`upload` (send songs as your account, within its daily quota) and `read:timings`
(everyone's published timings).

## Use

```python
import os
from overtone_client import Overtone, RateLimited

overtone = Overtone(os.environ["OVERTONE_TOKEN"])

# Upload and wait. A song the engine already analysed is answered from its
# SHA-1 without uploading anything.
row = overtone.analyze_file("song.mp3", on_update=lambda a: print(a["status"]))
if row["status"] == "refused":
    print("No steady pulse:", row["result"]["refusal"]["message"])
else:
    print(row["result"]["global_bpm"], row["result"]["red_lines"])

print(overtone.analysis_timing_text(row["id"]))   # the [TimingPoints] block
print(overtone.analysis_timing_csv(row["id"]))    # the red lines as CSV

for past in overtone.all_my_analyses(status="done"):
    print(past["id"], past["bpm"])

page = overtone.timings(q="camellia", bpmMin=170, limit=10)
one = overtone.timing(page["timings"][0]["id"])
```

| method | route | scope |
|---|---|---|
| `health()`, `me()` | `GET /health`, `GET /me` | any |
| `upload(data, filename, *, mode, options, private, title, artist, duration, lookup)` | `POST /analyses/lookup`, `POST /analyses` | `upload` |
| `wait_for(id, *, interval, timeout, on_update)` | polls `GET /analyses/{id}` | `read:analyses` |
| `analyze(data, filename, ...)`, `analyze_file(path, ...)` | both of the above | `upload` + `read:analyses` |
| `analysis(id)`, `analysis_versions(id)` | `GET /analyses/{id}`, `.../versions` | `read:analyses` |
| `analysis_timing_text(id)`, `analysis_timing_csv(id)` | `GET /analyses/{id}/timing.txt`, `.csv` | `read:analyses` |
| `my_analyses(**filters)`, `all_my_analyses(**filters)` | `GET /me/analyses` | `read:analyses` |
| `timings(**filters)`, `timing(id)` | `GET /timings`, `GET /timings/{id}` | `read:timings` |
| `timing_text(id)`, `timing_csv(id)` | `GET /timings/{id}/timing.txt`, `.csv` | `read:timings` |
| `request(method, path, ...)` | anything else a token may call | |

## Errors

Everything raised is an `OvertoneError` with `status`, `code` (the API's own),
`details` and `retry_after`; subclasses `AuthenticationError` (401,
`INVALID_TOKEN`), `PermissionDenied` (403, `TOKEN_NOT_ALLOWED` / `TOKEN_SCOPE`),
`NotFound` (404), `RateLimited` (429: `RATE_LIMITED`, `QUOTA_EXCEEDED`,
`PENDING_LIMIT`), `Timeout` (`TIMEOUT`), `NetworkError` (`NETWORK`) and
`AnalysisFailed` (`ANALYSIS_FAILED`, with `.analysis`).

A 429 with `Retry-After` is waited out and retried, up to `max_retries` (3) and never
longer than `max_retry_wait` (60 s); a 429 without it (the daily quota, the cap on
songs waiting) is raised at once. Every request times out after `timeout` (30 s;
uploads `upload_timeout`, 300 s); `wait_for` gives up after its own `timeout`
(30 min) and polls through a passing 502/503/504.

## Examples

```bash
OVERTONE_TOKEN=ot_... python examples/analyze.py song.mp3
OVERTONE_TOKEN=ot_... python examples/recent.py camellia
```

A Discord-style example (posting results through a webhook) is in
`clients/js/examples/discord-webhook.mjs`.

## Tests

```bash
python -m unittest discover -s clients/python -v
```

From the repository root. They start the site's real API with Node
(`clients/testing/api.mjs`), so they need Node 22 (`OVERTONE_NODE`, or `node` on
PATH) and `pnpm install` done; without Node the API tests are skipped and say so.
They are not part of the engine's suite (`tests/`).
