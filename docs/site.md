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
  10 minutes. The request limits (`middlewares/rate-limit.js`) count in the
  `rate_limits` table when there is a database, so every API process behind
  the proxy shares them (W3.17), and key each address by an HMAC, never the
  address itself.
  10 minutes.
- **Moderation** (W3.18). A Mides moderator sees, on `/queue`, Remove on every
  waiting or running row and Back to the queue on a running one. Remove fails
  the job ("Removed from the queue by a moderator.") and deletes its audio;
  Back to the queue hands a stuck job to the next worker while its audio is
  still spooled. Both go to `moderation_log` with who did it and why.
- **Cancelling** (W3.12). Whoever may read a queued analysis can cancel it
  (`DELETE /api/v1/analyses/<id>`, from its card, its page or `/queue`): the
  job, the row and the spooled audio are deleted, so it costs none of the day's
  quota. Once the worker has claimed it the answer is 409 `NOT_QUEUED`: the
  worker cannot be told to stop mid-stage.
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
  `songs`, `analyses`, `jobs`, `rate_limits`, `moderation_log`, `reports`,
  `suggestions`, `suggestion_votes` and `reviews` are used. `mides_tokens` was dropped on 2026-10-27.
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
- **The .osz** (`lib/osz.js`): the reader's file and a v14 `.osu` holding the red
  lines as the page has them and no hit objects, zipped stored in the browser
  (`lib/zip.js`), named `Artist - Title.osz` from the file's tags or name. It needs
  the file in this session, so after a reload the button waits for it to be picked.
- **The volumes** of the song and the clicks, and the clicks' on/off, are kept in
  `localStorage` (`overtone.player.volumes`) and restored on the next song.
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

### More downloads and "Check here" (W3.20, W3.25, 2026-10-27)

The export row keeps one primary button (the `.osz`) and the copy; everything else
is in a folded "More downloads" group (`components/result/MoreDownloads.jsx`). All of
it is built in the browser; the reader's `.osu` and song never leave it.

- **The reader's own `.osu`, patched** (`lib/osu-patch.js`). The file is read one char
  per byte (not decoded), so a BOM, CRLF, mixed breaks or non-UTF-8 text survive, and
  only the body of `[TimingPoints]` is rebuilt; every other byte comes out identical
  (CLAUDE.md rule 5 in spirit). The download keeps the file's own name; the original
  is not touched.
  - Red lines are replaced by the page's (adjusted when the reader adjusted them), in
    osu!'s order: by time, a red line before a green one at the same ms.
  - Green lines are kept as their own bytes and in their file order. One that now sits
    before the first red line is **kept**: osu! reads it against the first red line,
    as it does for anything before it, and deleting it would lose its slider velocity
    and hitsounds. The page counts them.
  - A red line also carries the hitsound state (sample set, index, volume, kiai) and
    resets the slider velocity. Each new red line takes the state in force where it
    lands; where a removed red line's state would otherwise change (another volume, a
    kiai or a green's velocity running on), a green line (`-100`) with that state is
    added at its time and counted. One red line moved a few ms adds none.
  - Hit objects are not moved (out of scope): the page says how many there are and
    that they may no longer sit on the new grid.
  - Refused with a message: not an `.osu` (first line), no `[TimingPoints]`, over 16 MB.
- **Click track WAV** (`lib/click-track.js`, `lib/wav.js`): an `OfflineAudioContext`
  renders the clicks with the player's own `scheduleClick` (same tones, the bar's first
  beat accented), alone (44.1 kHz mono) or over the song at the player's volumes (the
  decoded song's rate and channels). Capped at 600 s, the site's own analysis limit;
  the render suspends every 10 rendered seconds to move a progress bar.
- **Files:** the CSV (the API's, or built here when adjusted), the result as JSON as the
  API served it (never adjusted), and a plain-text summary (readings, one row per red
  line, the "check here" spans; English, as the other exports).
- **"Check here"** (`lib/check-spans.js`, `components/result/CheckHere.jsx`), between the
  map and the exports: sections graded `check` or `medium`, sections whose
  `drift_p90_ms` is over 20 ms, the `pulse_hints`, and the swing spans, sorted by
  time; neighbouring sections with the same reasons are one span. "Show" draws the span
  as the map's loop band and brings it into view (no audio needed); ⟲ loops it with the
  clicks. An empty list says so and still says to listen. The 20 ms threshold was
  measured on 2026-10-27 (see the timeline).

Checked with the dev site (5185/3015, the real worker, Beat This! vote off: the
worktree has no model) in the browser pane, the page's audio routed through a gain-0
node and every download caught in the page instead of saved:

- `change-128-142.wav`: "Check here" empty. The clicks-only WAV: 135 clicks, the 135
  of the grid, each within 0.024 ms (one sample) of its red line's beat, the bar's
  first beat at 0.98 peak and the others at 0.68. The mix: 5,760,044 bytes (60 s at the
  decoded 48 kHz). Both rendered in about 1 s, the progress bar seen at 0-67 %.
- A fixture `.osu` patched in the page: head and `[HitObjects]` byte-identical, the
  engine's two red lines in, a green before the first red line kept, one green carried
  where a removed red line had set volume 40, ended a kiai and reset a 0.5x
  velocity, the report shown. The JSON and the summary read back.
- `swing-120.wav`: two items (swing, and drift at p90 39.9 ms); Show lit the item and
  drew the band without audio; ⟲ disabled until the song was picked, then looped it.
- `halftime-150-75.wav`: one pulse item, 0:29.3-0:54.9; Show on a zoomed-in map moved
  the view to hold the span whole.
- 375 px in ES, light and dark: no element past the edge; on a phone a check item puts
  its time and buttons on one row and its reasons under them.

Not checked: opening the patched `.osu` or the WAVs in osu! or an audio editor (every
number above was read), Safari and Firefox, a 10-minute render's memory on a phone,
and listening.

### The queue, moderated (W3.18, 2026-10-27)

Staff is Mides' `is_moderator`, which sign-in keeps as `accounts.mides_role`
(`moderator`) and refreshes at every sign-in, so losing the role in Mides takes
effect here at the next one. `GET /analyses/queue` adds `staff: true` and a `ref`
on every live row for them; a private row still shows them no song and no
uploader, since removing or requeueing needs neither.
`POST /analyses/:id/moderate { action, reason? }` (same-origin, session, staff;
anyone else 401 or 403 `STAFF_ONLY`):

- `remove`: a waiting or running job fails, its audio goes. A worker already on
  it finishes its stage and its answer is refused as stale. The uploader's page
  says a moderator took it off the queue (`removed: true`).
- `requeue`: a running job goes back to the queue (409 `NOT_RUNNING` otherwise,
  409 `AUDIO_GONE` without its audio). Its attempt count is kept, so the next
  claim's attempt is new and the old worker's late answer is refused.

Each one writes `moderation_log` (who by username at the time, the action, the
analysis, the reason) in the same transaction as the change; `GET
/analyses/moderation` returns the last 50 for staff. With `MIDES_DEV_LOGIN` the
Google dev user is a moderator and the Discord one is not, so both sides can be
tried.
### A rate limit shared by every process (W3.17, 2026-10-27)

With `DATABASE_URL` set, each request's window is one upsert into `rate_limits`
(`bucket`, `client`, `count`, `reset_at`): `ON CONFLICT` takes the row's lock, so
two processes counting the same client are serialised, and the database computes
the wait, so their clocks need not agree. `client` is the first 32 hex digits of
an HMAC-SHA256 of the address (an IPv6 client's /64, `utils/client-ip.js`) under `SESSION_SECRET`, which every process already
shares. Dead windows are swept a minute after they end. If the table cannot be
reached, the request is counted in the process's memory and passes or fails on
that, with one warning per outage: the limit never takes the site down. Without
a database (development) the count stays in memory, as before.

Checked with two API processes on one PostgreSQL (PGlite behind `pglite-socket`):
twelve uploads sent alternately to both, the first ten passed (415, no body) and
the last two were refused with 429 and a Retry-After, whichever process got
them; the table held the HMAC and the count, no address.
### Knowing when a batch is done (W3.14, 2026-10-27)

While two songs or more are on the upload page, the tab's title reads
"finished/total ready" (done, refused, failed or cancelled count as finished;
one still uploading counts in the total, so two cached answers cannot end a
batch of five). A checkbox, shown only where the browser has notifications and
they were not denied, asks for permission; the notification goes once, when the
last song finishes. The counts come from the statuses the cards already poll,
so nothing new is sent anywhere. `lib/batch.js` holds the rules and
`site/web/test/batch.test.js` their tests. Since W3.22/W3.23 (below) the title
and the notification belong to the tray, on every page; the checkbox is the
tray's notification setting.

### A batch in one download (W3.15, 2026-10-27)

Once a song of a batch has its timing, a button under the cards downloads
`overtone-timings.zip`: one `<song>-timing.txt` per song that is done, named and
written exactly as `GET /analyses/:id/timing.txt` would (`lib/timing.js`, tested
against the API's own `utils/upload.js`). The archive is built in the browser
from the results the cards already polled (`lib/zip.js`): entries stored, not
compressed, since a timing is a few kilobytes; UTF-8 names; a name repeated in
the batch gets " (2)". Refused, failed and unfinished songs are left out.
### Cancelling a queued song (W3.12, 2026-10-27)

`DELETE /api/v1/analyses/<id>` deletes the analysis while its job is still
queued, in one statement (`DELETE ... USING jobs WHERE state = 'queued'`), so a
worker's claim and a cancel are decided by the same row lock. Checked over HTTP
in `test/cancel.test.js` (the owner cancels and gets the quota back; a stranger
gets 404, a request without the same-origin header 403; a claimed job 409) and
against PostgreSQL 18 through PGlite.

### The analysis tray and its notices (W3.22, W3.23, 2026-10-27)

Every song this tab sends is followed on every page, not only on `/analyze`.

- **One store.** `lib/tracker.js` keeps the ids being followed and reads
  `GET /analyses/:id` for each one still queued or running; `lib/tracking.js`
  builds the site's one instance. The Analyze page's cards, the result page and
  the tray all read it (`useTracker`, `useAnalysis`), so an id is polled once
  however many of them show it. Checked in the browser: a queued song on its
  result page, with the tray following it too, made 6 requests in 6 s. The
  result page also starts following a song of yours that is still in flight
  (only its uploader can read it at all), so a song opened from the recent list
  joins the tray.
- **Polite polling** (`pollDelay`): every 1 s for the first 20 s, every 2 s up
  to a minute, then every 3 s; one more second per place past third in the
  queue (up to 10 s); with N songs in flight each waits at least N × 0.5 s, so
  the tab stays near two requests a second against the API's 300 a minute; a
  failed read backs off 3, 6, 12, 24, 30 s; a hidden tab reads every 15 s and
  catches up the moment it is shown. Finished songs are not read again.
- **Survives a reload.** The ids, names, last status, batches and the inbox go
  to `sessionStorage` (`overtone.tray`), read back field by field (ids must be
  32 hex, statuses known, names stripped of control and bidi characters). Per
  tab on purpose: a second tab does not poll and notify the same songs twice.
  The API did not change: `GET /analyses/:id` was already readable by the
  uploader's cookie.
- **The tray** (`components/Tray.jsx`): name (a link to the result), state,
  queue place, stage and %, Cancel for a queued one (`CancelButton`, which now
  also tells the store), × to drop a finished one, "Clear finished", and the
  inbox of the last 20 notices with its own Clear. From md (768 px) up it is a
  corner button, open by default, with a spacer under the footer. Narrower, its
  button sits in the navbar's top row and the panel opens as a bottom sheet
  only when asked: a floating button on a phone sat on top of the Analyze
  page's full-width button (seen at 375 px, so it moved). Escape closes it from
  anywhere and gives focus back to the button that opened it; state changes are
  read out by a polite live region. Nothing is drawn until there is something.
- **Notices** (`songFinished`, `batchEnded`, `alertFor`): a song is announced
  when it goes from queued/running to done, refused or failed (cancelled and
  gone are not news); a batch (two or more songs sent together) once, when the
  upload loop is over and every song is finished. A browser notification goes
  only if the person turned them on, the browser granted it and the tab is not
  the one in focus; a song of a batch replaces the batch's notification (same
  `tag`) instead of stacking. The chime (`lib/chime.js`: two sine notes from
  Web Audio, no file) is off by default, is not played for songs inside a
  batch, and plays only after a click unlocked audio. The tab title reads
  "3 in progress · Overtone" while anything is, unsent songs of a running batch
  included. Sound and notifications are remembered in `localStorage`
  (`overtone.traySettings`).

Checked: `site/web/test/tracker.test.js` (16 tests: the schedule, the notice
rules, defensive reads, a reload, blocked storage, one poll per id, batches,
cancelling) with a fake clock and a fake API. In the browser (API on its own
port without the worker, and a scripted fake worker on `/api/internal` moving
jobs through progress, result and fail): a batch of three sent from
`/analyze`, followed from `/queue` and `/` with a reload in between; the
running stage and %, "has a timing", a cancel from the tray, a failure, and
"Batch finished: 1 of 3"; a single song on its result page at 375 px in Spanish
and the light theme; Escape; the sound switch remembered. **Not checked:** a
real browser notification (the preview browser had them denied, so only the
rules are tested), hearing the chime, a screen reader, Safari, a real worker run.

### Legal pages, credits, the status page and the site's face (W4.5-W4.8, W10.3, W10.4, 2026-10-27)

- **Pages.** `/terms`, `/privacy`, `/disclaimer`, `/credits` and `/status`, each its own
  route, EN and ES, linked from a new Legal column in the footer (Status sits under
  Site). Terms and privacy carry a **draft** note: they are written for the owner's
  review, and what only the owner can decide (the operator's legal name and address,
  the jurisdiction, a contact address, how long analyses are kept, which hosting
  providers keep logs) is a `[[...]]` placeholder that `components/LegalPage.jsx`
  draws as an amber "To be set" box, never as settled text.
- **Where the privacy text comes from.** Each line is read from the code, not
  guessed: `schema.sql` and `analysis.service.js` (SHA-1, duration, size, file name,
  tags, `private`, the result, status and times, `anon_hash` as the SHA-256 of the
  anonymous cookie, `ip_hash` as an HMAC of the address and the UTC day keyed with
  `SESSION_SECRET`); `account.service.js` (the Mides fields kept, no e-mail or token);
  `session.service.js` (the three cookies, their lifetimes and flags); the spool and
  ADR-W4 (when the audio is deleted); `rate-limit.js` (windows swept a minute after
  they end); the web's `localStorage` keys (`mides.theme`, `mides.lang`,
  `overtone.player.volumes`, `overtone.recentAnalyses`, `overtone.sso`). There is
  **no expiry job** for analyses, songs, accounts or the moderation log, and the page
  says so ("no automatic expiry is set yet") instead of naming a period. It also says
  plainly that the IP hash is keyed, not anonymous. A change to what is stored has to
  change this text too.
- **Disclaimer.** Its own page; the result page's "Check by ear" chip and a new
  "What 'check by ear' means" link go to it instead of repeating it. It quotes only
  the synthetic benchmark (24/24 within 0.05 BPM and 5 ms) and says real songs are
  harder; no Corpus B figure is quoted, since none is published on the site yet.
- **Credits** are generated, never typed: `node site/web/scripts/credits.mjs [--venv
  <virtualenv>]` writes `src/data/credits.json` from `LICENSE`, the Beat This! card
  and licence in `assets/models/`, `python/requirements.lock` with each pin's licence
  from its installed `*.dist-info/METADATA` (License-Expression, else a one-line
  License, else the classifiers, else "unknown"), and the web's and API's
  `package.json` with every package the runtime ones pull in, walked through
  `node_modules`, each with its own `license`. Build tools are listed without their
  dependencies (they do not ship). `index.css` has no `@font-face`, so the fonts
  section says the site downloads none. The output has no date, so a re-run on the
  same install is byte-identical; `test/credits.test.js` fails when a pin or a direct
  dependency is missing from it. The page is loaded lazily (its own 15 kB chunk).
- **SEO and icons (W10.3).** `public/robots.txt` (crawlers off `/api/`, `/analyze/`,
  `/login`, `/profile`), `public/sitemap.xml` (the eight public routes on
  `https://overtone.midesprojects.com`; `test/seo.test.js` diffs it against
  `App.jsx`), `public/manifest.webmanifest`, Open Graph and Twitter tags in
  `index.html`, and `hooks/usePageMeta.js`, which every page calls to set its
  `<title>` ("Name · Overtone") and description tags (`lib/meta.js`, tested). The PNG
  icons (`favicon-32`, `apple-touch-icon` 180, `icon-192`, `icon-512`, a maskable 512
  and a 1200x630 `og-image`) are drawn from `public/favicon.svg` by
  `node site/web/scripts/icons.mjs`: Node's own zlib and a small rasterizer, no
  package. It reads the SVG's rect, path, stroke and transform and refuses any shape
  it does not draw; `test/icons.test.js` decodes the committed PNGs and compares them
  pixel for pixel with a fresh render.
- **`deploy/web/serve.mjs`** serves `.xml` as `application/xml` (it fell to
  `application/octet-stream` before); `.txt` and `.webmanifest` already had their
  types, and the manifest needs nothing new in the CSP (`default-src 'self'`). A test
  in `site/api/test/serve.test.js` serves the real `public/` files through it.
- **Robustness (W10.4).** `components/ErrorBoundary.jsx`: one around the routes in
  `Layout`, keyed by the path so another page starts clean, and one around the whole
  app in `main.jsx`. Its page says something went wrong, offers Reload and Home, and
  shows no message or stack (those go to the console). `/status` reads
  `GET /api/v1/health`, which now also says whether a worker called `/api/internal`
  in the last 120 s (`utils/worker-status.js`; `unknown` until one calls after a
  restart; it does not change the status code). The page reads the body of a 503
  too, asks again every 30 s, after a failure at 5, 10, 20, 40, 80 then 120 s
  (`lib/backoff.js`), and not at all while the tab is hidden. The other pages already
  had their loading and empty states (queue, result, profile); none was added.

How it was checked: `site/api` 73/73, `site/web` 50/50, `pnpm --dir site/web build`,
`bench/facts.py` ok. In the browser pane (`vite` on 5182, the API on 3012 with
`OVERTONE_WORKER=0`): `/terms`, `/privacy`, `/credits` and `/status` at 375 px, EN and
ES, dark and light, no horizontal scroll, the tab title and description tags following
the page and the language; `/status` showed the API working, the database "in memory
(development)" and the worker "not seen yet".

Not checked: the error page in a real crash (nothing in the site throws on purpose,
and no test renders React); the result page's new links with a finished analysis (the
worker was off); link previews as a social network renders them (they need the
production URL); the manifest's install prompt; the icons on a real phone. The worker
status is per API process: with several behind a balancer, each would report only the
calls it received. Staging serves the same `robots.txt` as production, so it is not
kept out of search engines by it.

### Community: suggestions, reviews, moderation and the changelog (W5.2-W5.5, 2026-10-27)

`/community` has three tabs (`?tab=reviews`, `?tab=changelog`), linked from the
navbar. The routes are in `site/api/src/routes/community.routes.js`, the two
stores in `services/community.service.js`, the page in `src/pages/Community.jsx`
and `src/components/community/`.

**Suggestions.** Anyone reads them; posting needs a Mides account, and so does
voting (one vote per account: `PUT`/`DELETE /community/suggestions/:id/vote`, the
primary key of `suggestion_votes` is the rule). Anonymous suggestions are not
taken: a suggestion is a thread its author follows, a state change is the
answer and a rejection says why, so a post with nobody behind it to read the
answer invites spam and helps no one; reviews are where an anonymous opinion
goes. Title 3-120 characters, body 1-4000, counted in code points after
cleaning; too long is refused (`TOO_LONG`), never cut. Sorted by votes or date,
filtered by state, 50 a page. States: `open`, `review`, `planned`, `progress`,
`done`, `rejected`. Only staff (`isStaff`) change one, from any state to any
other (a rejected one can be reopened), and a rejection needs a reason. Every
change writes `moderation_log` (who by username, when, from, to, why) in the
same transaction; `GET /community/suggestions/:id` returns them as the
suggestion's history, for anyone to read.

**Reviews.** 1-5 stars and 1-2000 characters, with an account (one each,
`POST` again edits it, `DELETE /community/reviews/mine` removes it) or
anonymous. An anonymous review needs a form token from `GET
/community/reviews/form` (the time it was made and an HMAC of it under
`SESSION_SECRET`; nothing stored) at least 3 s and at most 6 h old, an empty
`website` honeypot field, and at most 2 a day per address, counted in the
store by the same daily address HMAC an anonymous upload keeps (`ipHashOf`),
under an advisory lock so two sent at once cannot both pass. No third-party
CAPTCHA: the site calls no outside service. The average counts an anonymous
review at half and the page says so next to it (W5.3's "pesan menos y lo
dicen"); the distribution counts each review once.

**Moderation (minimal W5.4).** Anyone, signed in or not, can report a
suggestion or a review with a reason; one open report per reporter and item
(`reports_once_idx`; an anonymous reporter is the daily address HMAC). Staff
hide (reason required) or unhide; the action goes to `moderation_log` and
resolves the item's open reports. A hidden item is not listed and is the same
404 as a missing one for everyone but staff and, for its own item, its author
(who sees it marked hidden). An edit of a hidden review keeps it hidden.
`GET /community/moderation` gives staff the open reports and the last 50
actions. `moderation_log` is W3.18's table, not a second one: it gained
`target_kind` (`analysis` by default, so older rows stay the queue's),
`target_ref`, `from_state` and `to_state`, and its action check now admits
`hide`, `unhide` and `state`; the queue's log reads its own rows only.
`reports` gained `ip_hash` and the two new kinds. All text goes through
`utils/text.js` `cleanText` (control characters, bidi overrides and isolates,
zero-width characters, the BOM; line breaks only in bodies) and is rendered as
text. Every mutating route has the same-origin guard and a per-address rate
limit.

**Changelog (W5.5).** `site/web/scripts/changelog.mjs` reads `docs/timeline.md`:
the latest 30 entries' version, date, title and "Changed" bullets.
`vite.config.js` serves them as `virtual:changelog`, read when a build or the
dev server first asks, so nothing generated is committed and it cannot go
stale. Inline markdown becomes tokens (text, code, strong, link) that the page
renders as React elements; only an absolute http(s) link stays a link, and the
timeline's relative links become their text. The entries stay in English, as
the timeline is, and the page says so in both languages. The tab is its own
chunk (31 kB, 10 kB gzipped).

Checked:

- `node --test` in `site/api`: 81/81, 12 new in `test/community.test.js` over
  HTTP on the memory store with the two dev sign-ins: who may post, vote,
  change states and hide; one vote and one review per account; validation and
  caps; text cleaning; hidden items absent for others and present for staff and
  author; reports once per person, resolved by a hide; the anonymous review's
  token, honeypot and daily count; the weighted average.
- The same file and `test/moderation.test.js` against PostgreSQL 18.6 (PGlite
  0.5.11 behind `pglite-socket`, a temporary install outside the repository):
  12/12 and 5/5. `check`: the schema applied twice, 18 tables.
- `node --test` in `site/web`: 36/36, 3 new for the changelog parser (no markup
  or script link survives it; the real timeline parses newest first).
- In the browser (dev, memory store): states, history, hide and the staff panel
  as the Google dev user; an anonymous review through the form; EN and ES, dark
  and light, 375 px wide without horizontal scroll.

Not checked: a real PostgreSQL server (only PGlite); two API processes at once
on the anonymous count (the advisory lock is there for it, untested);
screen readers on the tabs and the star picker; how the honeypot and the 3 s
fare against a real bot.

Left for later (roadmap W5.2-W5.5): comments on suggestions, merging duplicates,
linking a suggestion to the roadmap or a changelog entry, notifying its author
of a state change; the staff's public reply on a review; the word filter and
Mides' sanctions in moderation, and reports on the queue's names; the changelog
naming the suggestions each release closed.
