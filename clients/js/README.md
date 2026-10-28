# overtone-client (JavaScript)

A client for the [Overtone](https://overtone.midesprojects.com) public API with a
personal token. One ES module, no dependencies, built on `fetch`: Node 18 or later,
Deno, Bun, and browsers (for a tool you run yourself; see "Tokens" below).

Community-maintained alongside the site, in the same repository
(`clients/js`); the API's reference is the site's `/developers` page.

## Install

Copy `overtone.mjs` into your project, or point npm at the folder:

```bash
npm install ./path/to/Overtone/clients/js
```

## Tokens

Make a token at `/settings/tokens` on the site (signed in). It is shown once; keep it
in an environment variable, never in code you publish. Three scopes:

| scope | what it opens |
|---|---|
| `read:analyses` | your analyses, their `timing.txt`, CSV and versions, your history |
| `upload` | sending songs as your account, within its daily quota |
| `read:timings` | everyone's published timings |

A token belongs in a script, a bot or a server. The API has no CORS on purpose, so a
web page on another site cannot call it, and a page that shipped your token would
hand it to everyone who opened it.

## Use

```js
import { Overtone, RateLimitError } from 'overtone-client'

const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN })

// Upload and wait. A song the engine already analysed is answered from its
// SHA-1 without uploading anything.
const analysis = await overtone.analyzeFile('song.mp3', {
  onUpdate: (a) => console.log(a.status, a.position ?? ''),
})
if (analysis.status === 'refused') console.log('No steady pulse:', analysis.result.refusal.message)
else console.log(analysis.result.global_bpm, analysis.result.red_lines)

// The exports.
const timingPoints = await overtone.analysisTimingText(analysis.id)
const csv = await overtone.analysisTimingCsv(analysis.id)

// Your history, every page.
for await (const row of overtone.allMyAnalyses({ status: 'done' })) console.log(row.id, row.bpm)

// Published timings.
const { timings } = await overtone.timings({ q: 'camellia', bpmMin: 170, limit: 10 })
const one = await overtone.timing(timings[0].id)
```

In a browser or anywhere without a file system, pass the bytes yourself:
`overtone.analyze(file, { filename: file.name })` takes a `Blob`/`File`, an
`ArrayBuffer` or a `Uint8Array`.

| method | route | scope |
|---|---|---|
| `health()`, `me()` | `GET /health`, `GET /me` | any |
| `upload(data, { filename, mode, options, private, title, artist, duration, lookup })` | `POST /analyses/lookup`, `POST /analyses` | `upload` |
| `waitFor(id, { intervalMs, timeoutMs, onUpdate, signal })` | polls `GET /analyses/{id}` | `read:analyses` |
| `analyze(data, options)`, `analyzeFile(path, options)` | both of the above | `upload` + `read:analyses` |
| `analysis(id)`, `analysisVersions(id)` | `GET /analyses/{id}`, `.../versions` | `read:analyses` |
| `analysisTimingText(id)`, `analysisTimingCsv(id)` | `GET /analyses/{id}/timing.txt`, `.csv` | `read:analyses` |
| `myAnalyses(filters)`, `allMyAnalyses(filters)` | `GET /me/analyses` | `read:analyses` |
| `timings(filters)`, `timing(id)` | `GET /timings`, `GET /timings/{id}` | `read:timings` |
| `timingText(id)`, `timingCsv(id)` | `GET /timings/{id}/timing.txt`, `.csv` | `read:timings` |
| `request(method, path, options)` | anything else a token may call | |

## Errors

Everything thrown is an `OvertoneError` with `status`, `code` (the API's own:
`NOT_FOUND`, `TOKEN_SCOPE`, `QUOTA_EXCEEDED`...), `details` and `retryAfter`.
Subclasses for what you are likely to catch:

| class | when | `code` |
|---|---|---|
| `AuthenticationError` | 401 | `INVALID_TOKEN` |
| `PermissionError` | 403 | `TOKEN_NOT_ALLOWED`, `TOKEN_SCOPE` (`details.scope`) |
| `NotFoundError` | 404 (or not yours: the API does not say which) | `NOT_FOUND` |
| `RateLimitError` | 429 | `RATE_LIMITED`, `QUOTA_EXCEEDED`, `PENDING_LIMIT` |
| `TimeoutError` | a request or a wait ran out of time | `TIMEOUT` |
| `NetworkError` | no answer at all | `NETWORK` |
| `AnalysisFailedError` | the analysis ended `failed` (`error.analysis` is the row) | `ANALYSIS_FAILED` |

A 429 with `Retry-After` (the per-token rate limit, 120 requests a minute) is waited
out and retried, up to `maxRetries` (3) and never longer than `maxRetryWaitMs` (60 s).
A 429 without it (the daily quota, the cap on songs waiting) is thrown at once.
Every request times out after `timeoutMs` (30 s; uploads `uploadTimeoutMs`, 5 min);
`waitFor` gives up after its own `timeoutMs` (30 min) and polls through a passing
502/503/504.

## Examples

```bash
OVERTONE_TOKEN=ot_... node examples/analyze.mjs song.mp3
OVERTONE_TOKEN=ot_... node examples/recent.mjs camellia
OVERTONE_TOKEN=ot_... DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node examples/discord-webhook.mjs a.mp3 b.ogg
```

`discord-webhook.mjs` is a Discord-style bot in one file: it posts each result to a
channel through a webhook you created, with no library and no bot account. The
official bot, with slash commands, is `bot/` in the repository. `OVERTONE_URL` points
any example at another Overtone (a local one: `http://127.0.0.1:3001`).

## Tests

```bash
node --test --test-concurrency=1 "clients/js/test/*.test.js"
```

They start the site's real API in memory (`clients/testing/api.mjs`: the fake sign-in,
two tokens, a stand-in worker that answers at once), so `pnpm install` must have run
at the repository root. The 429 and timeout cases use a local stand-in that misbehaves
on purpose.
