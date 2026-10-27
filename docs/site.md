# The Overtone website (`site/`)

The website of docs/16-web-platform.md: Overtone as a public Mides Projects
site for timings, signed in with a Mides account. Phases W2 and W3.4: it
signs people in, takes an upload with or without an account, queues it,
analyses it with the v3 engine and gives the timing back.

```
site/api/   Express 5 + pg, plain ES modules (modelled on cavernia-api)
site/web/   React 19 + Vite + Tailwind 4 + react-router 7 + i18next EN/ES
worker/     the analysis worker: Python, standard library + python/overtone.py
```

## How an analysis goes

```
browser --POST raw audio--> api --spool/<id>.audio, songs + analyses + jobs rows
worker  --POST /api/internal/jobs/claim--> api        (Bearer WORKER_TOKEN)
worker  --GET  .../audio, run overtone.py, POST .../progress, POST .../result
api     --deletes the spooled audio, stores timing-result v1
browser --GET /api/v1/analyses/<id> (polls) -> result, timing.txt, timing.csv
```

- **The API owns every piece of state** (ADR-W5): the queue, the spool and the
  results. The worker is an HTTP client of `/api/internal`, so it carries no
  database driver and no new Python dependency.
- **The audio is never kept** (ADR-W4). It streams to `SPOOL_DIR/<id>.audio`,
  named by the analysis id only, and is deleted when the result or the failure
  arrives, when a job runs out of attempts, and at once on a cache hit.
- **Cache.** An analysis is keyed by the audio's SHA-1 and the engine hash the
  worker announces at every claim (`worker/timing_result.py`: the engine source,
  the result builder, and whether the Beat This! vote ran). The same audio
  through the same engine is answered at once and not counted in the quota.
- **Who may read it.** The id is 128 random bits; the analysis is readable by
  the session account or the anonymous `__Host-overtone_anon` cookie that created it
  (the row keeps its SHA-256), and by nobody else: they get the same 404 as for
  an id that does not exist.
- **Quota** (ADR-W6): `ANON_DAILY_LIMIT` a UTC day per client address without
  an account, `USER_DAILY_LIMIT` with one. The address is stored as an HMAC of
  the address and the day. A separate limit allows 10 uploads per address per
  10 minutes.
- **Retries.** A job running longer than `JOB_TIMEOUT_S` goes back to the
  queue; the second time it fails. Every worker call names its attempt, so a
  late answer from an abandoned attempt gets a 409.
- **What the worker runs.** `analyze_audio` with the defaults a fresh desktop
  install had (`default_params()` in `worker/timing_result.py`), the Beat This!
  vote included, never anybody's saved settings. A `ValueError` from the engine
  is a **refusal**, stored as a result with no BPM and its reason (white noise
  ends here, CLAUDE.md rule 2); anything else is a failed job.
- **`timing-result v1`**: `engine`, `engine_hash`, `beat_vote`, `duration_s`,
  `global_bpm`, `offset_ms`, `meter`, `red_lines` (`time_ms`, `bpm`, `meter`),
  `sections` (confidence and level: high, medium, check by ear), the engine's
  validation `findings`, `refused`/`refusal`, and `osu_timing`, the engine's
  own `[TimingPoints]` rows. The schema is in `site/api/docs/openapi.yaml`.
  The three levels are a reading of the engine's confidence (0.90 and 0.75)
  and its residual (30 ms), not a measured accuracy.
- **`timing-result v1.1`** (2026-10-27) keeps `version: 1` and adds `minor: 1`,
  so every v1 reader (the API's check, the exports) reads it unchanged. It adds
  only what the engine already computed, rounded for the page: `beats` (the
  engine's beats in whole ms and its local tempo at each), `downbeats_ms` (the
  click track's bar starts), `onsets` (the attacks the grid was fitted to, whole
  ms, weights 0-100), `onset_envelope` (pooled to at most 4000 values),
  `swing` (swing_lane's swung spans), `pulse_hints` (density_hints), and per
  section `drift_ms`, `drift_p90_ms`, `drift_bias_ms` and `onsets`: how far
  the attacks under a red line sit from its nearest 1/1-1/4 tick, measured as
  the desktop drift lane measured it. About 15 kB for a 60 s song and 49 kB
  for `long-6min.wav`. A v1.0 result stored before has none of it, and the
  page draws what there is.

The root `package.json` and `pnpm-workspace.yaml` make the two one pnpm
workspace. The engine (`python/`, `crates/`) is not part of it.

## Run it on another machine

Node 22 or newer and pnpm (`corepack enable` provides it). From the
repository root:

```bash
pnpm install && pnpm dev
```

You need the engine's Python environment too, for the worker: a `.venv` at
the repository root with `python/requirements.lock` installed.

That starts the API on http://localhost:3001, the web on
http://localhost:5173 (open this one; it proxies `/api` to the API) and the
analysis worker. `pnpm dev`
turns on `MIDES_DEV_LOGIN`, so **Sign in** with Discord or Google signs you in
as a test account without Mides, and with no `DATABASE_URL` the accounts and
analyses live in memory and vanish when the API restarts. No secret and no
database are needed to try it.

The worker is `worker/main.py`, started by the API's dev launcher
(`site/api/src/dev.js`) with the repository's `.venv` Python
(`.venv/Scripts/python.exe` on Windows, `.venv/bin/python` elsewhere) and a
`WORKER_TOKEN` generated for that run. Without a `.venv` the launcher says so
and the site still runs; uploads then wait in the queue. Set `OVERTONE_PYTHON`
to use another interpreter, or `OVERTONE_WORKER=0` to run a worker yourself:

```bash
OVERTONE_API=http://127.0.0.1:3001 WORKER_TOKEN=<the API's> .venv/Scripts/python.exe worker/main.py
```

The `.venv` is the engine's (`python/requirements.lock`), and the Beat This!
model is a Git LFS file: with only the pointer in the checkout the worker runs
without the vote and says so (`vote OFF`), and its results are cached under a
different engine hash. The first analysis after a start loads the model (a few
seconds); a 60 s song then takes about 10 s with the vote.

Other commands:

```bash
pnpm build                          # the web's production build, into site/web/dist
pnpm check                          # schema.sql applied twice to a throwaway schema (skips without DATABASE_URL)
pnpm test                           # site/api's unit tests (node:test): the guards and the upload helpers
pnpm --dir site/api db:migrate      # apply schema.sql to DATABASE_URL (idempotent)
pnpm --dir site/api start           # the API without the dev login, reading site/api/.env
```

## Configuration (`site/api/.env`)

`site/api/.env.example` lists the names; copy it to `.env`. Development
needs none of them. Production refuses to start when one marked required
is missing.

| Name | Default | What it is |
|---|---|---|
| `PORT` | `3001` | The API's port. Vite's proxy reads `API_PORT` if you change it. |
| `HOST` | every interface | `127.0.0.1` behind a reverse proxy. |
| `NODE_ENV` | `development` | `production` turns on HSTS, hides 5xx details and enforces the required names below. |
| `TRUST_PROXY` | `0` | Proxies in front (1 behind Caddy or nginx; 2 in the panel deployment, the TLS proxy plus `deploy/web/serve.mjs`). Decides the IP the rate limit counts: too low puts every visitor in one bucket, too high lets a client pick its own address. |
| `DATABASE_URL` | none (memory) | PostgreSQL. **Required in production.** |
| `SITE_URL` | `http://localhost:5173` | Where the web is served. The SSO `redirect_uri` is `${SITE_URL}/login/callback`. **https in production.** |
| `SESSION_SECRET` | random per process | Signs the session and SSO cookies. 32+ characters. **Required in production.** Changing it signs everyone out. |
| `SESSION_DAYS` | `30` | How long a session lasts. |
| `MIDES_CLIENT_SECRET` | random per process | This server's secret for Mides' code exchange: the same value as `SSO_SECRET_OVERTONE` in Mides-Dev-Web. Without the right one Mides refuses every code (sign-in answers 503 and the log says which setting). 32+ characters. **Required in production.** |
| `MIDES_AUTH_URL` | none | The Mides identity API, e.g. `https://midesprojects.com/api`; the service calls `${MIDES_AUTH_URL}/auth/...`. |
| `MIDES_WEB_URL` | none | The Mides site that serves `/authorize`, e.g. `https://midesprojects.com`. |
| `MIDES_IMAGE_ORIGINS` | none | Other origins Mides serves profile pictures from (comma-separated). A picture on any origin but these and `MIDES_WEB_URL`'s is not kept (initials instead), and overtone-web's `img-src` allows the same list. |
| `MIDES_APP` | `overtone` | The app name registered in Mides' `SSO_APPS`. |
| `MIDES_DEV_LOGIN` | off (`pnpm dev` turns it on) | Fake sign-in without Mides. **Refused when `NODE_ENV=production`.** Set `0` in `.env` to try the real SSO in development. |
| `ANON_DAILY_LIMIT` | `5` | Analyses a UTC day per client address without an account. |
| `USER_DAILY_LIMIT` | `50` | Analyses a UTC day with a Mides account. |
| `MAX_AUDIO_SECONDS` | `600` | Longest song: checked in the browser, then by the worker from the file's header (or the decoded length) before it is timed. |
| `MAX_UPLOAD_MB` | `40` | Largest upload: refused on `Content-Length` before a byte is read, and cut off while the body streams. |
| `SPOOL_DIR` | `<OS temp>/overtone-spool` | Where uploads wait for the worker (mode 0700). Without a database it is emptied at start, since the queue died with the process. |
| `SPOOL_MAX_MB` | `1280` | The spool's budget: waiting audio plus the uploads still arriving, each of which reserves its `Content-Length` (or `MAX_UPLOAD_MB`) before a byte is read. Past it, 503 `SPOOL_FULL`. Counted by the API process, since a panel's disk limit is not visible to `statfs`. |
| `SPOOL_MIN_FREE_MB` | `256` | Free space an upload must leave on the spool's filesystem, checked too (503 `SPOOL_FULL`). |
| `QUEUE_MAX` | `30` | Songs waiting, running or still arriving, everyone's together (503 `QUEUE_FULL`). The default keeps `QUEUE_MAX × MAX_UPLOAD_MB` inside `SPOOL_MAX_MB`; the API warns at start when it does not. |
| `WORKER_TOKEN` | random per process | The bearer of `/api/internal`. 32+ characters. **Required in production.** `pnpm dev` generates one and hands it to the worker it starts. |
| `JOB_TIMEOUT_S` | `900` | A job running longer goes back to the queue; two attempts in all. |
| `PROXY_SECRET` | none | The header overtone-web (`deploy/web/serve.mjs`) adds to everything it forwards; without it the API answers 404, except `/api/internal`. 32+ characters. **Required in production** (docs/deploy.md). Not needed with Vite's proxy. |
| `OVERTONE_PYTHON` | `.venv`'s | `pnpm dev` only: the Python that runs the worker. |
| `OVERTONE_WORKER` | on | `pnpm dev` only: `0` starts the API without its worker. |
| `WORKER_POLL_S` | `2` | The worker's wait between claims while the queue is empty. |

## Sign-in

Mides SSO only, as the `web` app type (ADR-W2). `GET /api/v1/auth/sso/start`
builds `${MIDES_WEB_URL}/authorize?app=overtone&redirect_uri=${SITE_URL}/login/callback&provider=discord|google`
on the server and sets a signed, ten-minute `overtone_sso` cookie. Mides
returns to `/login/callback#code=…`, the web posts the code to
`/api/v1/auth/sso/exchange`, and the API exchanges it with
`${MIDES_AUTH_URL}/auth/sso/exchange`. The exchange refuses a browser without
the SSO cookie and without the web's own note of the trip (login CSRF). The
browser then holds one HttpOnly `__Host-overtone_session` cookie (plain
`overtone_session` over http, where a `__Host-` cookie would be dropped; a name
sent twice counts as absent), an HMAC over the
account id, expiry and session version. The exchange sends this app's slug and
`MIDES_CLIENT_SECRET`, so a code taken from a browser is good to nobody else.
Mides answers with an access token of audience `app:overtone`, which opens
none of its own API, no refresh token, and the minimal profile (id, username,
names, avatar, banner, `is_moderator`): Overtone keeps no Mides token at all,
and a breach of this server takes no Mides account with it.

The real SSO needs W3.2 first: `overtone` registered in Mides-Dev-Web's
`SSO_APPS` with this site's origins and `/login/callback`.

The endpoints are described in `site/api/docs/openapi.yaml`.

## What is stubbed

- The `.osu` with the timing injected and the click track as a file are not
  offered yet; the Analyze page lists them as "soon". Copy `[TimingPoints]`,
  `timing.txt` and the CSV work, and the result page plays the clicks live.
- An account's history: an analysis made while signed in is readable from any
  browser of that account, but there is no list of them yet (the Analyze page's
  "recent" list is this browser's own storage).
- Profile is a placeholder: counters show a dash, timings come with publishing (W5).
- The schema holds every table of the plan's data model; `accounts`,
  `songs`, `analyses` and `jobs` are used. `mides_tokens` was dropped on 2026-10-27.
- The PostgreSQL store of the queue (`services/analysis.service.js`) has not
  run against a database yet: the end-to-end checks below ran on the in-memory
  store. `pnpm check` should be run on a real server before W4.
- Upload progress is reported; the worker's progress is coarse (one step per
  engine stage, from its progress messages).

## Look

The site uses the desktop app's "Console" look (`app/styles.css`), one step
darker: violet graphite surfaces, one signal-cyan accent, flat panels with
hairline borders, DIN headings (Bahnschrift on Windows, DIN Alternate on
macOS), monospaced readouts, and the app's reserved colours (red = timing
points, amber = check by ear, lavender = tempo). midesprojects.com was the
reference for structure (ticker, navigation, footer, avatar, loader) and for
the storage keys, `mides.theme` and `mides.lang`, which are shared across the
ecosystem. Its palette and its Horizon headline font are not used. Horizon's
licence is unknown and this repository is public, so dropping it also means
no font file has to be kept out of git. Every face is a system face and
nothing is fetched from the network.

## How it was checked (2026-10-26)

- `pnpm install`, `pnpm build` (346 kB JS, 110 kB gzip).
- API with no database: health, dev round trip (start → exchange → `/me` →
  logout → 401), an exchange without the CSRF header (403), and a replayed
  one (400 `SSO_STATE_MISSING`).
- API on PostgreSQL 18.6 through PGlite's socket server: `check` (14 tables,
  applied twice), `db:migrate` twice, the same round trip, and an old cookie
  refused after sign-out.
- The real exchange against a mock Mides: the `redirect_uri` built from
  `SITE_URL`, an unknown provider dropped, the email not kept, a
  `javascript:` banner URL turned into `null`.
- Production refusals: dev login, missing secrets, a missing database, and an
  http `SITE_URL`.
- In the browser: the sign-in to the profile, the 501 message on Analyze, EN
  and ES, light and dark, and a 375 px width with no horizontal scroll.

Not checked: a real Mides sign-in (needs W3.2), and a real PostgreSQL server
(PGlite stood in for it).

### The analysis flow (W2 and W3.4, 2026-10-26)

With `pnpm dev` (in-memory store, Node 24.22, Python 3.14 `.venv`, Beat This!
vote on):

- `bench/audio/change-128-142.wav` through the API: queued (position 1),
  running through the stages, done in 11.7 s; red lines at 400 ms, **128 BPM**
  and 30 400 ms, **142 BPM**, both "high"; `timing.txt` and the CSV as
  documented; the spool empty afterwards.
- `bench/audio/_noise.wav`: **refused**, `no_pulse`, no BPM and no red lines,
  in 3.0 s; the spool empty afterwards.
- The same `change-128-142.wav` again: 200 `cached: true`, the same result at
  once, nothing spooled.
- Without the cookie that created it, an analysis is a 404. Refusals answer as
  documented: no CSRF header 403, multipart 415, `.exe` 400, a declared 41 MB
  413 before the body, a streamed 60 MB cut off at the limit with nothing left in
  the spool, a file that is not audio a failed job, the third anonymous upload
  with `ANON_DAILY_LIMIT=2` 429 `QUOTA_EXCEEDED`, the eleventh upload in ten
  minutes 429 `RATE_LIMITED`, `/api/internal` without or with a wrong token 401.
- In the browser, through the Analyze form: a synthesized click track at 128
  then 142 BPM came back as two red lines at 128 and 142, in EN and ES, dark
  and light, at 375 px with no horizontal scroll; the downloads come with the
  anonymous cookie.
- `python -m unittest tests.test_worker` (9 tests, about 3 s), `pnpm test`
  (12), `pnpm build` (363 kB JS, 115 kB gzip).
- The worker leaves with the API: stopping the dev process left no Python
  behind.

### The public queue (W3.8, 2026-10-27)

`/queue` polls `GET /api/v1/analyses/queue`: the running and queued rows (at most
100, `more` counts the rest) and those finished in the last hour (at most 20), from
a one-second snapshot shared by every viewer. Each row is shaped by
`site/api/src/utils/queue.js`:

- the song is "Artist - Title" from the tags the browser read (`X-Title`,
  `X-Artist`; `site/web/src/lib/tags.js`), else the file name without extension;
- the uploader is the public Mides profile (username, display name, avatar) or
  "anonymous";
- a row uploaded with "keep it off the public queue" (`X-Private: 1`) shows neither,
  nor whether it was signed in;
- the analysis id is only on the caller's own rows (session or anonymous cookie),
  which link to their result; for anybody else an id would only lead to a 404.

Checked by hand with `pnpm dev` and a fake worker; not against a real PostgreSQL.

### Many songs at once (W3.9, 2026-10-27)

The Analyze form takes several files or a folder and sends them one after another,
each its own analysis with its own card. Three limits hold however many are sent:
the daily quota, `ANON_MAX_PENDING` / `USER_MAX_PENDING` songs of one person waiting
or running at once (429 `PENDING_LIMIT`), and `QUEUE_MAX` for the whole queue (503
`QUEUE_FULL`). Uploads still arriving count toward both (2026-10-27): before, K bodies
sent at once all passed a cap the store only saw once each had landed.

The queue's order is round robin between people: every person's 1st song before
anyone's 2nd, each person's songs in the order sent, and between equal turns
whoever was served longest ago (`jobs.claimed_at`). A person is the account, or
without one the hashed address. The claim, the position a result page shows and
the public queue read the same order.

Checked against PostgreSQL through PGlite (see `timeline.md`) and in the browser;
not with two real addresses taking turns.

### Asking before uploading (W3.11, 2026-10-27)

The form hashes each file in the browser and calls `POST /api/v1/analyses/lookup`
first. A hit is a new analysis from the stored result (no quota, no queue, no
upload); a miss, or a browser that cannot hash, uploads as before.

### The result page (2026-10-27)

`/analyze/:id`, once done, is where a song is timed: what the desktop Timing view
did, from the browser. Code: `site/web/src/pages/AnalysisResult.jsx`,
`components/result/` (the map, the transport, the table, the adjustments),
`lib/timing.js` (grid, drift, exports), `lib/player.js` (Web Audio),
`lib/session-audio.js` and `hooks/useSongAudio.js` (the song in the browser).

- **The tempo map.** Two canvases sized to the device pixel ratio: the map,
  repainted when the view or the data change, and an overlay for the playhead,
  the hover cursor and the loop. Lanes: the red lines' chips (BPM, and the meter
  where it changes), the tempo plot (local tempo in lavender, each line's BPM in
  red, each section's level along its foot, the half/double hints in amber), the
  waveform with the onsets as ticks and the beat and bar grid, the drift lane
  (each onset's distance from its line's nearest 1/1-1/4 tick, +-30 ms) and the
  ruler. Before the first red line is hatched: osu! runs that grid backwards.
  Wheel or pinch zooms, drag pans, the overview below moves the view, a click
  seeks or picks a red line, Shift-drag draws a loop snapped to beats (Alt: free).
- **The song never leaves the browser** (ADR-W4). The Analyze form hands each
  file it sends to `holdAudio(id, file)` for the session. Reopened without it
  (a reload, the recent list), the page asks for the file, hashes it with
  SubtleCrypto and plays it only when the SHA-1 equals the analysis's (the API's
  view now carries `sha1`, to its owner only). Decoding is `decodeAudioData`;
  the waveform's min/max peaks are built in chunks so the page keeps painting.
  One decoded song is kept at a time (six minutes of stereo float is ~130 MB).
- **Playback** ports the desktop player: the song through one gain, the clicks
  through another (separate volumes, a mute), clicks scheduled 150 ms ahead on
  the AudioContext clock with the WAV export's three tones, the bar's first beat
  accented. A rate of 0.5-1.5 resamples the song, so its pitch moves and every
  attack stays at t / rate, and each click is placed at t / rate. Loop the
  drawn span, or the red line's section under the playhead; play from a red
  line (one beat early). Keys: Space, arrows (a beat; Shift a bar), + - 0, [ ],
  L, C, F.
- **The clicks are the click track's**: `clickGrid` builds the schedule as
  `click_schedule` does (each line up to, not onto, the next; the last to the
  end inclusive; the bar on the line's meter), from the red lines as the reader
  has them. Its bars equal the worker's `downbeats_ms`.
- **The table** follows the map both ways (hover and selection), with the
  engine's confidence and level, the drift (median, 90th percentile, lean) and
  the fit residual, and a play and a loop button per line.
- **The reader's adjustments**, display and export only: x2 / /2 every BPM, and
  a global nudge in ms. The map, the clicks, the drift and the exports follow
  them; copy and downloads are then built in the page, with a comment line
  saying they were adjusted, and the page says to check them by ear. Unadjusted,
  copy is the engine's `osu_timing` and the downloads are the API's. The
  adjusted drift is measured from onsets in whole ms, so it can read up to
  0.5 ms off the worker's unadjusted figure.

Checked with `pnpm dev` in the browser pane on 2026-10-27, Beat This! vote on,
the page's audio routed through a muted gain:

- `change-128-142.wav`: two red lines at 128 and 142; the clicks, read back from
  the scheduled oscillators against the song's start, within 0.0001 ms of the
  red lines' grid at 0.75, 1 and 1.25, at 1.5 across a drawn loop's wrap (no
  click doubled at the loop end), and at x2 with +5 ms; the exported text and
  CSV after x2 and +5 (`405,234.375000486957,4,...` with its comment line).
- `long-6min.wav` (186 BPM, one line): zoomed in and playing at 1.5 for 8 s,
  399 animation frames, the worst 31.7 ms, no long task, the view turning its
  page with the playhead; six zoom repaints in 33 ms.
- `halftime-150-75.wav`: the half-time hint drawn and explained from 0:29.3.
- A reload asks for the file; another song's file is refused by its SHA-1, the
  right one plays (1.1 s to hash and decode a 60 s WAV).
- EN and ES, dark and light, 375 px with no element past the edge (the rate
  buttons wrap), keys, hover and selection in both directions.

Not checked: Safari and Firefox (Chromium only), a real phone's touch (pinch
was not exercised), a compressed format the browser cannot decode (the page
says so and keeps the timing), and listening: every number above was read, and
nothing was heard.
