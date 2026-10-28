# The Overtone website (`site/`)

The website of docs/16-web-platform.md: Overtone as a public Mides Projects
site for timings, signed in with a Mides account. Phases W2 and W3.4: it
signs people in, takes an upload with or without an account, queues it,
analyses it with the v3 engine and gives the timing back.

```
site/api/   Express 5 + pg, plain ES modules (modelled on cavernia-api)
site/web/   React 19 + Vite + Tailwind 4 + react-router 7 + i18next, ten languages
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
| `BOT_TOKEN` | none (bot off) | The Discord bot's bearer for `/api/internal/bot` (W9.3, `docs/bot.md`). 32+ characters, never `WORKER_TOKEN`. Unset, those routes answer 503 `BOT_OFF` and the profile offers no bot code. |
| `MIDES_DISCORD_LINK_PATH` | `/connections/discord/link` | The Mides page that links Discord and returns to `/profile?linked=discord` (W9.1). Mides does not serve it yet. |
| `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSU_REDIRECT_URI` | none (osu! off) | The osu! OAuth app (W9.2): all three or none; the redirect URI is `SITE_URL/link/osu`, exactly as registered. |
| `OSU_PKCE` | on | `0` leaves PKCE out of the osu! link, should osu! ever refuse it; the state check stays. |
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
- The schema holds every table of the plan's data model; `accounts`,
  `songs`, `analyses`, `jobs`, `rate_limits`, `moderation_log`, `reports`,
  `suggestions`, `suggestion_votes`, `reviews`, `timing_ratings`, `timing_uses`,
  `timing_comments`, `collections` and `collection_items` are used (the last five on
  published analyses, see "Social v2"); `timings`, `timing_reactions` and
  `notifications` are not yet. `mides_tokens` was dropped on 2026-10-27.
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

### A fuller .osz (W12.9, 2026-10-27)

Under the `.osz` button, ".osz options" (`components/result/OszOptions.jsx`) adds four
things to the archive, each a checkbox. All of it is worked out in the browser from the
reader's own file and the song the page already decoded for the waveform; nothing is sent.

- **The cover** (`readCover` in `lib/tags.js`): ID3v2.3/2.4 `APIC` (MP3; tag-wide and
  per-frame unsynchronisation, the v2.4 data length indicator and UTF-16 descriptions
  handled; compressed or encrypted frames skipped), MP4 `covr` (M4A, `moov` found past an
  `mdat` as the title reader does), FLAC `PICTURE` blocks, and the base64
  `METADATA_BLOCK_PICTURE` comment of Ogg Vorbis and Opus, with the comment packet put back
  together across Ogg pages. The front cover (type 3) wins. Only JPEG and PNG are kept,
  recognised by their first bytes, not the declared MIME; a tag over 16 MB is skipped. It
  goes in as `bg.jpg` / `bg.png` with `0,0,"bg.jpg",0,0` in `[Events]`, and is shown as a
  thumbnail beside the download button. Not read: ID3v2.2 `PIC`, WAV covers, covers in a
  FLAC's Vorbis comment block.
- **`PreviewTime`** (`previewTime` in `lib/osz-suggest.js`): the mean square of the song in
  50 ms frames; the 15 s window with the highest mean, moved back to the earliest start
  still within 5 % of it (so a long chorus previews from its top), snapped to the nearest
  bar start of the red lines as the reader has them. Without it, osu!'s `-1`.
- **`AudioLeadIn`** (`leadIn`): our rule, not osu!'s. The first sound is the earlier of the
  first red line and the engine's first attack. Under 1.5 s from the start, a lead-in that
  brings it to 2 s is suggested, in steps of 100 ms (first sound at 0.4 s → 1600 ms). Why:
  osu! starts the clock early enough for the first approach circle, not for the player to
  catch the beat, and 1.5-2 s is what mappers commonly leave; a song that starts later
  needs none.
- **Kiai** (`kiaiSections`, `kiaiRows`): each bar's RMS in dB, from the first red line on.
  A bar is hot above the midpoint between the song's median bar and its 95th-percentile
  bar, and only if that gap is at least 3 dB (a song mastered flat gets no suggestion, as
  the whole synthetic corpus does). Hot bars are joined across one-bar gaps, runs under 4
  bars dropped, the 3 loudest runs kept. Each becomes green lines (`-100`, effects 1) at
  its first bar and effects 0 at the bar after it; a red line inside a run gets a kiai
  green line at its own time, since a red line carries its own effects (0) and would end
  kiai there.
- **Defaults:** cover on (the reader's own picture; it changes nothing in the timing),
  preview on (it only decides where song select starts playing, and any bar of the loud
  part beats `-1`), lead-in off (it changes when the game starts the song), kiai off (where
  kiai goes is a mapping decision, and loudness is a crude stand-in for "the chorus"). The
  preview, lead-in and kiai rows carry a "suggestion" chip and the area says to check them
  in the editor. An option with nothing to offer is greyed out and says why.
- **Tags:** every `.osu` the site builds carries `Tags:overtone overtone_timings` (owner's
  rule), first and never dropped; `osuFile` takes more tags and keeps them after those two
  (`mapTags`), though the page has no field for them yet. The desktop app's own `.osz`
  (`python/overtone.py`) is engine-side and was not changed.
- **"Open it in osu! when it finishes":** a web page cannot run what it downloads, so the
  `.osz` is saved as before (`.osz`, `application/x-osu-beatmap-archive`) and a
  dismissible tip then says how to let the browser open `.osz` files by itself: Chrome or
  Edge, the download's menu → "Always open files of this type"; Firefox, Settings →
  General → Files and Applications. It also says osu! must be installed with `.osz`
  associated, which its installer does. "Don't show again" is kept in `localStorage`
  (`overtone.osz.openTipDismissed`). `osu://` was considered and dropped: as far as we
  know, both osu!stable and lazer register it for online things only (`osu://b/<id>`,
  `osu://s/<set>`, `osu://dl/<id>`, editor timestamps, spectating), and nothing in it
  imports a local file. That is from their documented links, not from a test against an
  installed client.

Checked in the browser pane on 2026-10-27 with one real worker (Beat This! vote off), two
FLACs built from bench WAVs with a 64×64 PNG `PICTURE` block:

- `with-drop-180`: cover found and shown, preview 0:00.400, lead-in 1600 ms (first sound
  0.4 s in), kiai "no stretch clearly louder" (the corpus is flat: every bar -20 dB but the drop).
- `edm-174` with a ×1.6 "chorus" from 22 to 40 s and ×0.6 elsewhere: preview 0:21.121,
  kiai 0:21.121–0:40.432 (the gain edges are not on bars, so the bar holding each edge is
  hot). With every option on, the `.osz` was built by the page and read back in it: entries
  `audio.flac` (byte size equal), the `.osu` and `bg.png` (7830 bytes, PNG signature, same
  as the thumbnail); the `.osu` with `AudioLeadIn: 1600`, `PreviewTime: 21121`,
  `0,0,"bg.png",0,0`, `Tags:overtone overtone_timings` and the red line followed by the kiai
  on/off green lines. The tip showed after the download and stayed away after "Don't show
  again".
- EN and ES, dark and light, 375 px with nothing past the edge.

Not checked: a real song (only bench audio with a made-up loud stretch), any cover format
but FLAC in the browser (the others by node:test on built bytes), the archive opened in
osu! itself, Firefox's and Safari's own download behaviour, and whether the suggestions
are any good for mapping: they are loudness heuristics, and the page says so.

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
  `overtone.player.volumes`, `overtone.player.latencyMs`, `overtone.player.listening`,
  `overtone.recentAnalyses`, `overtone.sso`). There is
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
  `<title>` ("Name · Overtone") and description tags (`lib/meta.js`, tested). The logo and every
  icon (`favicon.svg`, `favicon-32`, `apple-touch-icon` 180, `icon-192`, `icon-512`, a
  maskable 512 and a 1200x630 `og-image`) are Overtone's own mark, written by
  `assets/logo.py` with the standard library beside the desktop app's icon (2026-10-27:
  they had been a redrawn ring and the Mides mark, which the owner called an imitation).
  The site uses its web variant (`render_web`, `assets/logo-web.svg`): the fundamental
  alone, thicker and inset, and the red line as a rounded bar, because the full icon's
  faint harmonics read as noise in a browser tab. `components/Mark.jsx` shows
  `favicon.svg`; `test/logo.test.js` holds it equal to `assets/logo-web.svg` and every
  PNG at its stated size. The Mides mark (`Logo.jsx`, the
  same path as midesprojects.com's own component) stays only where Mides Projects is named.
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

### Published timings, recent and history (W3.27, W5.1, W3.26, 2026-10-27)

The privacy model, also written at the top of `site/api/src/routes/timings.routes.js`:

- **Nothing is public until its uploader publishes it.** `POST
  /analyses/<id>/publish` on a finished (`done`) analysis sets `published_at`;
  `DELETE` on the same path clears it. Anonymous uploaders can publish too, while
  their cookie lasts; the page then says "anonymous". Anyone but the uploader gets
  the 404 of a missing id.
- **A private analysis** (W3.8) is refused with 409 `PRIVATE` unless the request
  sends `makePublic: true`, which lifts the privacy in the same statement. The web
  asks first. Unpublishing does not make it private again.
- **The public URL is `/t/<id>`**, the analysis's own public id: `/analyses/<id>`
  still needs the uploader's session or cookie, so a second id would protect
  nothing.
- **What anyone sees:** title and artist (tags, else read from the file name as
  "Artist - Title"; never the file name), the result, the uploader's public Mides
  profile or "anonymous", when it was published. Never the audio's SHA-1,
  `anon_hash` or `ip_hash`: the views in `utils/timings.js` are built field by
  field.
- **The .osz on a public page:** the visitor picks their own file, the browser
  hashes it and `POST /timings/<id>/check` answers only `{ match }` (20 per 10
  minutes). On a match the page plays it against the clicks and builds the .osz,
  as for the uploader. The timing's hash never reaches the browser.

`GET /timings` is the recent list (search, `bpmMin`/`bpmMax`, `tempo=single|variable`,
at most 50 a page, a keyset cursor in microseconds so a timing published meanwhile
neither repeats nor skips a row); `GET /me/analyses` is the account's history with
`status`, `from` and `to` as well. `DELETE /analyses/<id>` now also deletes a
finished analysis: its result, names and publication are erased at once, and the
marked row stays until its UTC day ends so that it still counts in that day's
quota (a hard delete would hand the quota back); an hourly purge takes it after.

`deploy/web/serve.mjs` serves `/t/<id>` as `index.html` with the timing's title,
description and `og:*` tags in its head, read from `GET /timings/<id>/card` (no
result) within 1.5 s and escaped; otherwise, or for a timing that is not
published, the plain page. The SPA sets the same tags client-side. There is no
Open Graph image yet.

Checked:

- `site/api` 84/84: 13 new in `test/timings.test.js` on the memory store (only
  the uploader publishes; not a queued song or a refusal; private needs
  `makePublic`; the page, the card, the list, the CSV and the check never carry
  the SHA-1, `anon_hash` or `ip_hash`; unpublish takes it down; delete takes it off
  recent and history and the quota still counts it; a running song is not deleted;
  paging with a timing published in between; the filters; the history; strict
  filter parsing), 2 new in `test/serve.test.js` (hostile title, artist and
  username come out escaped; an unpublished or late card gives the plain page).
- The PostgreSQL store against PostgreSQL 18 through PGlite 0.5.12: `check`
  (15 tables, applied twice), `db:migrate` twice, and a script over the store
  (publish lifting privacy, every filter, two pages against one read, no SHA-1 in
  the views, history with status and dates, unpublish, delete today and from an
  earlier day, the purge, a running job not deleted).
- `site/web` 36/36 (3 new for `lib/timings.js`), `vite build`.
- In the browser (dev API in memory, results posted by a stand-in worker):
  publishing from the result page, the private confirmation and delete from
  `/history`, the filters on `/recent`, the public page and its 404, EN and ES,
  dark and light, 375 px wide (a form overflow there was fixed).

Not checked: a real worker's result on a public page, picking a matching file on
the public page in the browser (the check route is tested, the button is not),
a real link preview on Discord, and the HTTP routes against PostgreSQL (the store
was, the routes ran on the memory one).

### Linked accounts and the Discord bot (W9.1-W9.5, 2026-10-27)

The profile gains "Linked accounts": Discord (through Mides, or a code typed to the
bot as `/link`; then the DM switch) and osu! (OAuth, `identify` only, one `/me`, no
token kept). `/link/osu` is osu!'s return page, private (robots.txt, the SEO test's
list). The API gains `/me/links` and `/links/*` (session, same-origin, 30 per 10
minutes), and the bot's own `/api/internal/bot` behind `BOT_TOKEN`, which uploads
through the site's own `acceptUpload`. New: `accounts.discord_notify` and the
`osu_*` columns, the unique indexes on `discord_id` and `osu_user_id`, and the
tables `discord_link_codes` and `discord_dms`.

Everything, from what Mides must add to what the owner registers on osu! and
Discord, the decisions (the anonymous quota per Discord user, no chart image) and
what was and was not checked, is in `docs/bot.md`.

### Other games' formats and the export options (W12.7, W12.8, 2026-10-27)

Both live in the result page's "More downloads" group; the `.osz` stays the one
primary button above it.

**Other games** (`lib/game-formats.js`, `components/result/GameFormats.jsx`): Quaver
`.qua`, StepMania `.sm` (which Etterna reads: it has no timing format of its own, so
the page says so rather than inventing one), StepMania 5 `.ssc` and Clone Hero
`notes.chart`, built in the browser from the red lines as the page has them (×2/÷2
and the nudge included) after the export options. Timing only, no notes, and the
group's title says so. The module's comment holds each format's rules:

- Quaver: absolute `StartTime` (ms, float) and `Bpm` per point, each point its own
  grid, so nothing accumulates. `Signature: Triple` on a 3/4 line; Quaver knows 4/4
  and 3/4 only, so another meter is written as 4/4 and the page counts them.
- StepMania: beat 0 is the first red line, `#OFFSET` its time in seconds, negated;
  every later change is `beat=bpm`, its beat accumulated through the tempi before
  it. A change off the grid is a fractional beat, written as is (6 decimals, as v3).
  StepMania stores a change on a row (48 per beat), so it moves such a change when
  it loads the file; `stepmaniaRowShift` measures that from the written numbers and
  the page shows it from 0.5 ms. `.sm` has no time signatures (the page says the
  meter is lost there); `.ssc` writes `#TIMESIGNATURES` at the first line, at a new
  meter and at a line off the running bar (osu! starts a bar at every red line).
- Clone Hero: `Resolution = 192`, `B` in milli-BPM, `TS` for the meter, `Offset = 0`.
  Tick 0 is the audio's start; a lead-in bar from tick 0 reaches the first line's
  first downbeat at least half a bar in. A change between ticks gets the nearest
  tick, and the BPM before it is fitted (to the milli-BPM) only when keeping it would
  land the change more than 0.5 ms off; the game's own arithmetic is followed, so the
  error does not accumulate. The page counts the fitted sections and their worst miss.

v3's exporters (`quaver_timing_text`, `stepmania_timing_text` in `python/overtone.py`)
are matched character for character but the comment line, including Python's
half-to-even on exact decimal ties (`fixed`). Checked with a one-off script (not
committed) on 67 sets of red lines (7 by hand, 60 random: 1-8 lines, 60-280 BPM at
0-9 decimals, meters 3-7, offsets from -200 ms): 536 texts compared, 0 differ. Two
deliberate differences: the site adds `Signature: Triple` (v3 writes no meter) and
writes an offset of exactly 0 as `0.000000` where v3 writes `-0.000000`.

**Export options** (`lib/export-options.js`, `components/result/ExportOptions.jsx`),
remembered in this browser under `overtone.exports` and read defensively: offset
decimals 0-3 (Quaver's StartTime and StepMania's #OFFSET; osu! always gets whole ms,
Clone Hero ticks), the BPM rounded to 0-3 decimals with the drift that causes by the
end of the worst line (the song's end for the last one), the first red line only,
and a whole-ms offset added to every line. That offset is not the nudge: the nudge
is a correction the reader hears in the clicks; this one is a target's convention
and moves only what is written, so it stays out of the clicks, and since it is
remembered across songs the line under the `.osz` names every option in force.
They apply to the `.osz`, the copied `[TimingPoints]` (which then carries a comment
naming them), the patched `.osu` and the games' files; not to the clicks, the CSV,
the summary or the JSON.

Checked in the browser pane (5192/3022, no worker: a generated WAV uploaded and a
hand-made result posted to `/api/internal` as the worker): the group at desktop width
and at 375 px in ES, dark and light, nothing past the edge; BPM to 2 decimals and
+9 ms set, the drift line (1.15 ms by the end of line 1) and the amber "options on"
line shown, both kept after a reload; the four files caught in the page and read
back, their caveats listed (StepMania's rows, the .sm meter, one Clone Hero section
fitted). `site/web` tests: `game-formats.test.js` (fixture lines with a change on a
non-whole beat and a meter change, each format read back by its own rules) and
`export-options.test.js`.

Not checked: opening any of the files in Quaver, StepMania, Etterna or Clone Hero
(no game was run; the rows rule and Clone Hero's Offset handling are from what we
know of those games' loaders, not from a test), Safari and Firefox.

### Listening tools: latency, tap tempo, tap offset, A/B, subdivisions (W12.2-W12.6, 2026-10-27)

A panel under the transport (`components/result/Listening.jsx`) for checking a timing
by ear. The rules are pure functions in `lib/listening.js`, tested in
`test/listening.test.js`; the player (`lib/player.js`) carries the audio side.

- **Subdivisions (W12.6).** `clickGrid(lines, duration, { subdivision })` in
  `lib/timing.js` adds 1, 2 or 3 `SUB` clicks between beats, counted from each line's
  offset exactly as the engine's `click_schedule` does, so none crosses into the next
  line. They sound with the existing level-0 tone (1318.5 Hz, 0.4) through their own
  gain under the clicks' bus (muting the clicks mutes them), at their own volume
  (default 60 % of the clicks'). Off, 1/2, 1/3, 1/4 and the volume are kept in
  `overtone.player.listening`. The map draws them dashed under the beat lines once
  they are 7 px apart, and the legend names them. The click-track WAV offers "with
  the 1/n subdivisions" (on by default when they are on) at the same volume.
  The map, the arrow keys, the loop snapping and the taps keep the beats-only grid.
- **A/B (W12.5).** Once the reader has adjusted the lines, the player also holds the
  engine's own lines' clicks; "Your lines / The engine's" (or A) swaps them at the
  same playhead: the clicks already handed to the audio context are dropped and
  scheduled again from now, the song untouched. Unadjusted, the switch is disabled
  and says the two are the same.
- **Tap tempo (W12.3).** The Tap button (pointer down, Space or Enter on it) or T
  anywhere. A run restarts after a 2 s pause and keeps the last 24 taps. From 4 taps:
  the median interval with stray intervals dropped (beyond 3 robust deviations, or
  10 % of the interval when the hand is steadier than that), as BPM, with the spread
  of the kept intervals' BPM. Divided by the playback rate, then compared with the red
  line at the playhead: "matches" within 4 %, "about ×2" or "about ×0.5" within 4 % of
  those, the ratio otherwise.
- **Tap offset (W12.4).** While the song plays, each tap is also placed on the song's
  timeline where it was heard (`heardPositionAt`, the context's output timestamp) less
  the calibrated latency, and measured against the nearest beat of the reader's
  current lines. From 8 kept taps (stray ones beyond 3 robust deviations or 15 ms
  dropped): the median signed offset and its spread, proposed as current nudge plus
  that offset. "Set the global offset to …" applies it through the existing
  adjustment and clears the taps; nothing changes before the press. Without a
  calibrated latency the page says a late hand reads as a late song.
- **Latency (W12.2).** "Calibrate…" opens a modal `<dialog>` (Esc closes it, focus goes
  back to the button): 24 clicks at 100 BPM, nothing to look at on purpose, tapped with
  Space, Enter, T or a pad. The first four are not counted. Each tap is placed in
  context time with the same output-timestamp mapping, so the latency the browser
  reports is already out; what is measured is what it does not report plus the
  person's own timing. The median of the counted taps, stray ones dropped; refused
  under 8 kept taps or over a 40 ms spread. "Save" keeps it in
  `overtone.player.latencyMs` (validated on read, ±500 ms); Reset forgets it.
- **What the latency moves.** The taps, always. The clicks only when the reader ticks
  "Play the clicks that much early" (off by default, kept in
  `overtone.player.listening`): the song and the clicks leave through the same audio
  context and output, so any device delay reaches both alike, and moving the clicks
  alone would put them off the song by that much. The roadmap asked for the clicks
  to move; the switch keeps that available without making it the default (see the
  timeline). No export ever carries it.
- **Keys:** T taps, A swaps the clicks, S steps the subdivision; `tempo.keys` says so.
  Every page-wide key goes through `lib/keys.js` `pageKeyIgnored`, which now also
  steps aside while a modal dialog is open (Space in the calibration does not play
  the song).

Checked with the dev site (5191/3021, the real worker, Beat This! vote off) in the
browser pane, `change-128-142.wav`, the song at volume 0:

- Tap tempo: 12 T presses timed to the grid read 128 BPM ±0.0, "matches the red line
  here (128)". The same presses 20 ms after each beat proposed +20 ms ±2.0 (12 kept);
  applied, the global offset read 20. With a latency of 20 ms saved and taps 40 ms
  after the moved grid, it proposed +19 ms ±5.2 (9 of 12 kept), i.e. 39 ms in all.
- Calibration: 24 taps 35 ms after each click, one 200 ms off: 35 ms ±1.0, 19 kept and
  1 dropped; saved, shown as "35 ms", read back after a reload. Esc and Close both
  close it, focus returns to Calibrate, Space while it is open did not start the song.
- A swaps `abEngine` once the lines are adjusted; S set 1/2 and the grid went from
  135 to 269 clicks; the subdivision survived a reload.
- The map drew the dashed subdivisions when zoomed in (11 to 49 lines across four
  zoom levels) and none further out.
- The clicks-only WAV with 1/2 at a 50 % subdivision volume: 269 clicks, the 269 of the
  grid, the subdivisions at 0.20 peak (0.4 × 0.5), the first at 0.6345 s (0.400 +
  0.234 s).
- 375 px wide in ES, light: nothing past the edge but the red-line table, which scrolls
  in its own box as before; the dialog fits (18-357 px).
- `site/web` 101/101 (11 new), `vite build`, `bench/facts.py` ok.

Not checked: listening (the pane's audio was at volume 0, and every number above
was read, not heard), a human hand on the calibration (the taps were synthesised at
exact times), Bluetooth or any device whose reported latency is wrong, Safari and
Firefox, a phone's touch taps, screenshots of the dialog and the map (the pane was
hidden most of the time, so they were checked through the DOM and the canvas
calls), and the dark theme of the dialog beyond its tokens.

### Comparing timings (W12.10, W12.11, 2026-10-27)

Two timings of one song side by side, all in the browser. Code: `lib/compare.js` (the
math, pure), `components/compare/` (the report and the map panel), `pages/Compare.jsx`.

- **Grids, not first beats.** A red line a whole number of beats from the other's, at the
  same tempo, is the same grid: osu! plays the same clicks. Lines are paired in order when
  within four beats of the slower one (at least 1 s). Per pair: the BPM difference (or
  ×2 / ×½), the offset as the phase of B's grid against A's at the later of the two lines
  (the sparser grid's beat, the denser grid's nearest one), the same at their last shared
  beat (a difference that grows is drift), the meter, and which beat the bar starts on.
  A line only one side has is listed, saying whether the other grid already agrees there.
- **The verdict** looks up every beat of the sparser grid, from the later first line to
  the end, in the other grid, judging each beat by the line its partner belongs to:
  `same` (every beat within 5 ms and every tempo within 0.05 BPM, the accuracy baseline's
  tolerances, named on the page), `offset` (one constant shift past 5 ms), `double`,
  `half`, or `different` with the share on the same grid, the share at half or double and
  the first beat that parts. Signs read B minus A.
- **With a map (W12.10)**, on the result page and a published timing's page: the reader
  picks an `.osu` (16 MB and 2000 red lines at most). It is read with `File.text()` and
  kept in the page's state only, never uploaded or stored. The map's lines are dashed in
  `--compare` blue on the tempo plot and the overview, with their BPM along the plot's
  foot; the tooltip adds the map's BPM; "Clicks from" plays the map's grid instead of the
  result's (the drawn grid and the loops stay the result's). It compares against the
  lines as the reader adjusted them, and warns when the map's `AudioFilename` is not the
  analysed file's name (a hint: maps rename their audio).
- **Two analyses (W12.11)**, `/compare?a=<id>&b=<id>`, each side optionally `ax`/`bx`
  (×0.5 or ×2) and `an`/`bn` (a nudge, ±1000 ms). A side is read as the visitor's own
  (`GET /analyses/:id`) or else as published (`GET /timings/:id`), with one 404 text for
  both; a missing side is picked from the account's history (this browser's list without
  an account), as the other side at ×2 or ×0.5, or by pasting a `/t/` link or an id. The
  song is A's audio from the visitor's file, checked as on the result page; the clicks
  play A's or B's grid. When both are the visitor's and their SHA-1s differ, the page
  says the two are different audio. Offered from the history, a public timing and the
  result page (and "the engine's against your adjusted one" when adjusted). Out of the
  sitemap and disallowed in robots.txt: the page depends on who asks.

Checked with the dev site (5194/3024, one real worker, Beat This! off), uploads made from
the page so the browser owned them, `.osu` and audio handed to the inputs as `File`s:

- `change-128-142.wav` against a hand-made map (second line 2 ms late, in 3/4): "same grid
  within 1.9 ms", the meter change reported; "Clicks from: Map" put the player on the
  map's 136-click grid. The map's dashed lines and labels drawn, dark theme.
- `/compare` with that analysis against itself at ×2 +3 ms: "double within 3.0 ms" (this
  read `different` before the fix in the timeline); at -8 ms by typing in the nudge field:
  "8.0 ms earlier on every beat"; against `halftime-150-75.wav`: different, the unpaired
  line listed; B's clicks (269) over the picked song.
- The picker: this browser's list, then the account's history after the dev sign-in; a
  pasted `/t/` link used, a bad one refused; an unknown id given the shared 404 text.
- A published timing's page: "Compare" in the header, the map panel at 375 px in ES, dark
  (the table scrolls in its own box, the page does not); `/compare` at 375 px in ES, light.
  The history's "Compare" links (this browser's list).

Not checked: a real ranked map (`.osu` files were made by hand), the published-side
fallback of `/compare` as a stranger (the browser that published it also owned it; the
`/timings/:id` read is the one the public page uses), listening, Safari and Firefox.

### Command palette, shortcuts and settings (W12.14, W12.15, 2026-10-27)

**The palette** (`components/CommandPalette.jsx`). Ctrl+K (⌘K on a Mac) or the
search button in the bar opens it on every page; on a phone the button leads the
places' row, because the top row has no room left at a large font size. It lists
the tray's in-flight analyses first, then this browser's recent ones
(`lib/recent.js`), the pages, and the actions: each of the ten languages, the three themes,
high contrast on or off, open settings, the shortcut help, sign in or out. Each
page and action also matches its name in English and Spanish ("inicio" finds Home).

- The ranking is `lib/commands.js`, a subsequence match that favours word starts
  and runs and ignores case and accents, falling back to a plain left-to-right walk
  when jumping to a word start would strand a later character. Ties keep the
  palette's own order.
- Both dialogs are native modal `<dialog>`s: the page behind is inert, Tab stays
  inside, Escape closes, and the focus goes back where it was. The palette is the
  ARIA combobox pattern: the field (`role=combobox`) owns a `listbox`, the arrows,
  Home, End and the page keys move `aria-activedescendant`, Enter runs the option,
  and the inside is remounted on every open, so it starts empty.
- `?` opens the shortcut help: the global keys and the result page's
  (`components/result/TempoMap.jsx`, which now uses the same `isTyping` and
  ignores keys from inside an open dialog). `?` never fires in a text field;
  Ctrl+K does, as in editors, because it never types anything.

**`/settings`** (`pages/Settings.jsx`, `context/SettingsContext.jsx`,
`lib/settings.js`). Everything is stored in this browser and applies at once:

- **Theme**: system, dark or light, in the existing `mides.theme` key (shared with
  midesprojects.com), which gains the value `system`; `ThemeContext` follows the
  OS's switch while it is chosen. Not duplicated in `overtone.settings`.
- `overtone.settings` = `{ contrast, fontScale, palette, reducedMotion }`, each
  read defensively; they reach `<html>` as the classes `contrast-more`,
  `palette-cb`, `motion-reduce` / `motion-allow` and the property `--font-scale`.
- **High contrast**: one more token set in `src/index.css` per theme. Every text
  token is at 7:1 or more on every surface down to `--surface-3`, and the strong
  line at 3:1 on the page; `test/settings.test.js` computes each ratio from the CSS.
- **Font size**, 90 to 130 % in fives: it scales the root size (so rem spacing
  grows with the text) and the px text tokens. The few arbitrary `text-[Npx]`
  sizes (the wordmark, some headings) and the tempo map's 11 px canvas labels
  do not scale.
- **Colour-blind-safe palette**: the map already drew only with tokens; the one
  colour it hard-coded, the ink on a red chip, is now `--red-ink`. The palette
  moves `--red`, `--amber` and `--lavender` on the whole site, so the map, the
  table and the chips keep agreeing; the accent stays. The values came from a
  random search over hues near each meaning, scored by the smallest CIELAB distance
  between the map's four colours under Machado et al.'s (2009) simulation of
  protanopia, deuteranopia and tritanopia. The test recomputes that distance.
- **Motion**: the reduced-motion rule now runs under the media query unless
  `motion-allow` is set, and always under `motion-reduce`.
- **Player**: the default volumes write `overtone.player.volumes` through the
  player's own `savedVolumes` / `saveVolumes` (now exported). The device latency
  (`overtone.player.latencyMs`, written by W12.2's calibration) is shown, can be
  typed (-250 to 1000 ms, a comma or "ms" allowed) or forgotten, and links to the
  visitor's latest result, or to `/recent` when there is none.
- **Language**: the same `mides.lang` as the bar's toggle.

**Before the first frame.** `index.html`'s one inline script already set the theme
and the language; it now also applies `overtone.settings` and the `system` theme.
`deploy/web/serve.mjs` allows that script by its hash, computed from the built
file, so no CSP change was needed; a new test in `site/api/test/serve.test.js`
serves the real `index.html` and checks `script-src` names exactly its hash and
that nothing says `unsafe-inline`. `test/settings.test.js` runs the inline script
in a `vm` against stored values (valid, invalid and broken) and checks it leaves
`<html>` exactly as `lib/settings.js` does, so the page never jumps when the app
starts. Setting a style through the CSSOM is allowed under `style-src 'self'`.

`/settings` is not in the sitemap and `robots.txt` disallows it (a browser's own
settings have nothing to find); it is linked from the account menu and the footer.

Checked:

- `site/web` 113/113: 13 new in `test/commands.test.js` (matching, ranking,
  keywords, ties, positions, typing targets, the global keys) and 10 in
  `test/settings.test.js` (reading, writing, applying, latency parsing, the early
  script against the library, the contrast ratios and the colour-blind distances);
  `test/seo.test.js` now lists `/settings` as private. `vite build`.
- `site/api` 101/101 (1 new in `test/serve.test.js`).
- In the browser at 800 px and 375 px, EN and ES, dark, light and "as the system"
  with the OS scheme emulated both ways (it follows a live switch): each setting
  reaches `<html>` and storage; the stored ones apply on a reload before the app
  (contrast, palette, motion with the ticker stopped, 120 % font); the latency
  field refuses "abc" and takes "42,5 ms"; the palette opens from the keyboard,
  from a field and from the phone's button, ranks, matches Spanish names, runs a
  page and a theme, closes on Escape and gives the focus back; the help lists
  every key; the account menu and the footer link to `/settings`. At 130 % the
  bar's places pushed the sign-in button off at 800 px and the top row overflowed
  at 375 px: the places now scroll and the phone's search button moved to the
  second row. No horizontal overflow at 375 px at 100 % or 130 % on `/settings`.

Not checked: the tempo map's canvas repainting under high contrast and the
colour-blind palette (no finished analysis without the worker; the map re-reads
the tokens on every class change of `<html>`, which is how the theme already
worked), a real `?` key press (the browser tool's key events did not produce `?`,
so it was dispatched as a `KeyboardEvent`), a screen reader, a real colour-blind
reader, every other page at 130 % (only `/settings`, the home page and the bar
were looked at; the home page's example offset wraps at 130 % on 800 px), and the
latency written by W12.2's real calibration, which is on another branch.

### How it works, questions, the glossary and the statistics (W12.12, W12.13, 2026-10-27)

**Pages.** `/how-it-works`, `/faq`, `/glossary` and `/stats`, each with `usePageMeta`, in
the sitemap and in a new Learn column of the footer. Their text is in the locale files
under `learn` and `siteStats`.

- **How it works** (`pages/HowItWorks.jsx`): six steps, each written from and citing the
  file that specifies it (`docs/05-dsp-pipeline.md` A.1-A.11, `docs/site.md`,
  `python/overtone.py` `analyze_audio`, `_beat_this_vote`, `_follow_drift`,
  `worker/timing_result.py` `HIGH`, `MEDIUM`, `LOOSE_RESIDUAL_MS`, `STAGES`), linked on
  GitHub through `lib/repo.js`, which accepts only a plain relative path. The only
  accuracy figures are the synthetic benchmark's, as on the disclaimer; Corpus B is
  described (20 hand-timed ranked maps, red lines within 5 ms) without a number, since
  the site publishes none. The time an analysis takes is the figure from "Run it on
  another machine" above (about 10 s for 60 s with the vote, on the development
  machine), and the page points to `/stats` for this site's own. The diagram
  (`components/learn/PipelineDiagram.jsx`) is inline SVG with Tailwind's fill and stroke
  utilities over the theme tokens; each box links to its step.
- **FAQ** (`pages/Faq.jsx`): the limits are read from `GET /api/v1/health`, never
  written in the text; if the API does not answer, the page says so and links `/status`.
  The formats are `utils/upload.js` `AUDIO_EXTENSIONS`; what is kept of the audio is the
  privacy page's reading of the code.
- **Glossary** (`pages/Glossary.jsx`, `lib/glossary.js`): twelve terms. An entry's
  anchor is its id (`/glossary#drift`); the router does not scroll to a hash, so the
  page does, and outlines the entry. Spanish uses the site's "deriva" for drift.
- **`<Term id>`** (`components/Term.jsx`): a dotted underline (`.term` in `index.css`)
  that is a button. It opens a non-modal popover with the short definition and a link to
  the entry; Enter or Space opens it and moves the focus into it, Escape, Close or
  tabbing past either end closes it and returns the focus to the word; a click outside,
  a scroll or a resize closes it. The popover is portalled to `<body>` and `fixed` from
  the word's box, because the red lines table scrolls and its header is sticky. It sits
  on the result page's readouts (BPM, offset, meter, red lines), the confidence legend
  and the table's BPM, meter, confidence, drift and fit headers, so the public `/t/<id>`
  page has it too.

**Statistics.** `GET /api/v1/stats` (`routes/stats.routes.js`, `utils/stats.js`, a
`stats()` on both stores in `services/analysis.service.js`):

- Totals of the engine's own runs (done, refused, failed), published timings and
  distinct songs; cache hits are their own total; a deleted analysis counts nowhere.
- The main BPM of done analyses in 20-BPM buckets from 80 to 260, open at both ends. The
  memory store buckets as PostgreSQL's `width_bucket(bpm, edges)` does, with the same
  edges array, and its percentile is `percentile_cont`'s, so the two stores agree.
- One tempo against tempo changes, read as `utils/timings.js` `isVariable` reads it (red
  lines at more than one BPM).
- The median and 90th percentile of `finished_at - created_at` for done runs of the last
  30 days: upload to result, queue wait included, said so on the page. Null below five.
- Queued and running jobs.

The pg store reads it all in one statement. The answer is built field by field by
`shapeStats`, cached for a minute per process (concurrent requests share one
computation), served with `Cache-Control: public, max-age` for what is left of the
minute, and limited to 60 requests per address per 10 minutes. No schema change.

The page (`pages/Stats.jsx`, `lib/stats.js`) draws the histogram as horizontal bars and
the tempo share as one split bar, inline SVG at the box's pixel width (ResizeObserver),
each an image with a summary, every bar with its count as text, and the histogram's
numbers as a table behind "Show as a table". The accent and lavender pass the dataviz
validator on colour-blind separation and contrast in both themes; it flags their
lightness and chroma bands, which the labels and the table cover.

Checked:

- `site/api` 107/107: 7 new in `test/stats.test.js` (bucket edges and percentiles against
  the PostgreSQL definitions; the totals, histogram, tempo share, median 30 s and p90
  46 s and the queue over HTTP; a cache hit and a deletion not counted; the minute's
  cache; the whole body searched for every id, SHA-1, hash, file name, tag and username
  the rows carried, and every key checked against the ones `shapeStats` writes; the rate
  limit).
- The pg store's `stats()` against PostgreSQL through PGlite 0.5.11 behind
  `pglite-socket` (a scratch install outside the repository), schema applied twice, the
  same rows: every figure as on the memory store.
- `site/web` 96/96: `test/learn.test.js` (every glossary term in both languages, every
  underlined id a term, the same steps and questions in both languages, every cited file
  present in the repository, every FAQ link a route) and `test/stats.test.js`; `vite
  build`; `bench/facts.py` ok.
- In the browser pane (web on 5195, the API on 3025 with `OVERTONE_WORKER=0`, results
  posted by a stand-in worker): the four pages at 375 px and desktop, EN and ES, dark and
  light, no horizontal scroll; the result page's popovers by keyboard (focus in, Escape
  back to the word) and by click; the glossary link landing on its entry below the
  sticky header; the FAQ's limits as `/health` stated them.

Not checked: a screen reader on the popover and the charts; touch on a real phone; the
`/stats` route against PostgreSQL (the store was, the route ran on the memory one); the
cache across several API processes (each keeps its own minute); the text against a
mapper's reading, which only a mapper can give.

### Modes, hints, a stretch, re-analysis and the queue's estimate (W11.1, W3.21, W12.19, W3.24, W3.16, 2026-10-27)

**Asking.** The upload form has a folded *Options* panel (`components/AnalysisOptions.jsx`,
`lib/analysis-options.js`): the mode, one BPM or a changing tempo, an approximate BPM or
a range, beats per bar, and a stretch (one song at a time). Left alone it sends nothing
but the file, as before. The browser checks the API's bounds first; the API checks them
again (`utils/analysis-options.js`): `X-Mode` and `X-Options` (percent-encoded JSON, at
most 512 bytes) on upload, `mode` and `options` in a lookup's body, a 400 `BAD_MODE` /
`BAD_OPTIONS` before a byte of audio is read. `X-Duration` is the length the browser
read, used only for the estimate.

**Storing.** `analyses` gains `mode`, `options`, `options_key` (the hints as one
canonical string), `audio_seconds` and `reanalysis_of`. The worker announces one
engine hash per mode at each claim, and every cache lookup (`findCached`, `findCopy`)
matches mode and `options_key` as well as the hash. When a result arrives the row takes
the mode and hints the result says it was made with (`askedOf` in
`routes/internal.routes.js`).

**The worker** (`worker/timing_result.py`): `MODE_SETTINGS` says what each mode changes
(fast: no vote, no octave judges; strict: as normal for now), `engine_settings` sets and
restores the engine's switches around one job, `octave_window` moves `MAP_OCTAVE_RANGE`
for a tempo hint outside 120-240, a meter fills unproven bars, and a stretch is cut out
of the engine's own decode and shifted back (`shift_result`). `hint_checks` say where
the audio disagrees with a hint. The default mode with no hints is the call it always
was (`DefaultModeTests`).

**Reading.** The result shows *How it was analysed* (`components/result/HowAsked.jsx`):
the mode, the hints, the stretch covered and each check; and *Analyse again*
(`components/result/Reanalyse.jsx`): another mode with the same hints, with the held
file or one picked again and checked by SHA-1, linked both ways, with a link to
`/compare?a=&b=`. `/queue` and the waiting page show "done in ≈ a – b" from
`utils/estimate.js` (W2.4's cost per audio minute and mode, one worker assumed).

How it was checked: `node --test` in site/api (122; `test/modes.test.js` through the
memory store: keys, cache separation, re-analysis ownership and audio, a pre-modes
worker's result, the queue's estimate) and site/web (190), `vite build`, 14 targeted
Python tests (`DefaultModeTests`, `ResultPartsTests`; earlier on this branch the whole
`tests/test_worker.py`, 29). In the browser pane with a real worker: the options panel,
a fast job on a 40 s stretch with a tempo hint (its checks, the stretch note, times in
the song's timeline) and `/queue` with estimates.

Not checked: the PostgreSQL store (no database here: the statements are written, never
ran); the Python suite and the engine gates on this branch (the owner's rule: they run
on the server after merging); Spanish, the light theme and 375 px in the browser; the
re-analysis button end to end (a file pick cannot be driven from here; the API side is
tested, and the dev worker ran out of memory on the shared machine before its second
job); the estimates against real waits on the server.

### The front page (W12.25, 2026-10-27)

`/` is now a landing page for a mapper deciding whether to try Overtone. Code:
`site/web/src/pages/Home.jsx`, `components/home/` (the section heading, the line
icons, the recent list, the live numbers), `lib/home.js` (the section keys and the
stats reader), `components/TimingStrip.jsx` and `lib/strip.js` (the example).

- **Sections, in order:** the hero (one line on what it does, "Analyze a song" and
  "How it works", three facts: free, no account, audio deleted; the "check by ear"
  chip with a link to `/disclaimer`), the live numbers, "What you gain" (five
  benefits and a sixth cell that is the call to act), how it works in three steps
  (linking `/how-it-works`), recently timed, who we are, five questions (linking
  `/faq`), and a closing call with `/community` and `/recent`.
- **Every claim is one the site keeps today**, read from this file and the result
  page: the audio is deleted when its analysis ends or fails (only the timing and
  the SHA-1 stay), clicks, loop and rates down to 0.5, the `.osz` with the song and
  the red lines, no account needed and a higher limit with one, the six formats of
  `AUDIO_EXTENSIONS` (a test reads that list against both FAQ answers), the
  benchmark's 0.05 BPM / 5 ms on synthetic tracks and "a strong first draft" on real
  ones. When the site changes, change the strings.
- **Who we are:** Mides Projects, founded by githalt, open source (MIT) in one
  repository, from the desktop app to this site, not affiliated with osu! or ppy.
  The Mides mark (`Logo.jsx`) sits beside Overtone's (`Mark.jsx`) there.
- **Requests:** two, both after the first paint and neither blocking anything above
  them. `GET /timings?limit=5` shows three placeholder rows while it runs and hides
  the section when it answers with none or fails. `GET /stats` (W12.13; `totals.done`
  and `queue.queued + queue.running`) hides its block on any failure, and while no
  analysis is done: "0 analyses done" sells nothing. Its answer is cached for a minute.
- **The example strip** plays a made-up song of four red lines (offset 1284 ms at
  174 BPM for 3 bars, 186 for 3, 186 in 3/4 for 2, 160 for 2), each a whole-ms
  offset on the previous line's downbeat with `beatLength = 60000 / BPM`. A playhead
  crosses it in real time and the readouts (BPM, offset, meter, confidence in its
  level's colour), the header's "red line n of 4" and a `[TimingPoints]` row follow
  the line under it. The playhead is one SVG element moved by a transform; React
  renders again only when the line changes. It stops when the strip leaves the
  screen (`IntersectionObserver`) or the tab is hidden, and resumes where it was.
  With reduced motion (the system's, or `reducedMotion` in `overtone.settings`) it
  does not sweep: it steps to the next line every 4 s. On a phone the red lines'
  BPM flags are dropped (they would be 6 px text); the readouts carry the numbers.

Checked:

- `site/web` 194/194 (11 new: `test/home.test.js` for the section strings in both
  languages, the FAQ's formats against the API's list, the stats reader and a 404;
  `test/strip.test.js` for the example's osu! timing, its grid, the active line over
  the loop, bar and beat, the readouts and `[TimingPoints]` row, the reduced-motion
  steps), `site/api` 108/108, `vite build`.
- In the browser pane (dev API in memory on 3041, five timings published by a
  stand-in worker posting results to `/api/internal`): with none published and no
  analyses, the recent and live sections are absent; with five, both show. 1366 px
  and 375 px (no element past the edge), EN and ES, dark and light. The strip moving
  and its readouts changing line; with `reducedMotion: reduce` stored, a still
  playhead for 4 s, then the next line.

Not checked: that the strip pauses off-screen. The pane was hidden for that run, and a
hidden pane runs neither `requestAnimationFrame` nor `IntersectionObserver`
callbacks, so neither the pause nor the resume could be observed (the code is the
standard pair: an observer and `visibilitychange`). Safari, Firefox and a real phone;
a screen reader over the sections; the `/how-it-works` and `/faq` pages the links
lead to were not re-read for agreement with the teaser's answers.

### Social v2: stars, uses, comments, collections and profiles (W5.6, W6, W13.15, W13.18, 2026-10-27)

The routes are in `site/api/src/routes/social.routes.js` (the rules are written at its
top), the two stores in `services/social.service.js`, the shared rules in
`utils/social.js`; the web's are `src/lib/social.js`, `src/components/social/` and the
pages `UserProfile.jsx` (`/u/<username>`), `Timers.jsx` (`/timers`),
`CollectionPage.jsx` (`/c/<id>`) and `Profile.jsx` (`/profile`, Timings and
Collections tabs).

- **What a "timing" is here.** A published analysis (`/t/<id>`). schema.sql's drafted
  social tables pointed at `timings`, the W4 rows people will edit and fork; each now
  also has `analysis_id`, and a check says it names exactly one of the two. The
  one-per-account rules that were primary keys are unique indexes per target. Only
  published rows count anywhere: what hangs off a timing its uploader took back stays
  stored, unseen, and returns with it; a deleted analysis takes it all (cascade).
- **Stars.** 1-5, one per account (a second is an edit; pressing your rating again
  takes it back), never on your own timing (403 `OWN_TIMING`). `/t/<id>` and every list
  row show the plain average and the count. "Best rated" on `/recent` counts a timing
  from 3 ratings and orders by a Bayesian average with 3 prior ratings at 3 stars, so
  three 5s (4.0) lead five 4s (3.625), but not two hundred 4.6s. Why 3: the least that
  says more than one person agreed, and a higher bar would leave the sort empty while
  the site is small.
- **"I used this".** One per account, not on your own timing, with an optional link
  that must be an osu.ppy.sh beatmapset (`/beatmapsets/<set>` with an optional
  `#<mode>/<map>`, or the old `/s/<set>`) and is stored in that one https form. The
  page lists the latest 20 uses, the link shown as its own text with
  `rel="noopener nofollow ugc"`. "Most used" orders by them. Anonymous uses are not
  taken. The beatmapset's own metadata is not fetched: that needs the osu! API (W9.2).
- **Comments.** Signed in, 1-1000 characters after `cleanText`, plain text, oldest
  first. An optional time (`atMs`, inside the song's length) shows as an m:ss button
  that moves the result's player there (`Result` takes a `playerRef`) and scrolls the
  map into view; the form can take the player's position. Its author deletes it. Anyone
  reports and staff hide or unhide it through the community's own routes
  (`/community/comments/<id>/report|moderate`): `comment` is a third kind in
  `community.service.js`, logged in `moderation_log`, and the staff panel links a
  reported comment to its timing. A hidden one is listed only for staff and its author.
- **Collections.** Private by default, up to 50 per account and 500 timings each,
  names up to 80 characters. Added to and taken from on `/t/<id>`, managed (rename,
  public or private, delete) in `/profile?tab=collections`. A private collection, or
  one that is not yours, is the same 404 as one that never was, for reading and for
  every change. The page lists only timings that are published now.
- **Profiles.** `/u/<username>` (any case; the most recently signed-in holder of a
  name wins, since Mides cannot be asked by id) shows the Mides public fields, totals,
  badges, published timings (with the three orders) and public collections. Totals:
  published, songs timed (analyses finished and never private: a private upload stays
  out even as a number), uses by others, and the average stars received. Badges are
  counted, never granted: first timing, 10 and 50 published, a suggestion that reached
  planned / in progress / done, used by others. `ranked-match` has its line in
  `badgesOf` and waits for W9.2. A private profile (`PUT /me/profile`) is a 404 for
  everyone but its owner and leaves `/timers`; its timings stay published with the name
  on them, and the timing page then stops linking the name.
- **Timers (W6).** `/timers` ranks by uses by others (3 to enter) or by stars received
  (5 ratings, the same Bayesian order), 50 at most, private profiles out. Both minimums
  are on the page.
- **Pages and SEO.** `/timers` is in the sitemap; `/u/<username>` and `/c/<id>` sit
  beside `/t/<id>` in `test/seo.test.js` as pages with an id, which no static sitemap
  can list. Every new page calls `usePageMeta`. Strings are under `social` in EN and ES.

Checked:

- `site/api` 121/121 after merging `origin/experimental`: 13 new in
  `test/social.test.js` over HTTP on the memory store (permissions and the same-origin
  header on every write; one rating and one use per account; never on your own timing;
  the beatmap link's forms and refusals; the orders, their minimum and offset paging;
  comment cleaning, caps, times and deletion; comment reports and hides through the
  community routes; collections private, capped and showing only published timings;
  profiles, totals, badges and the private 404; the ranking's minimums and private
  profiles; and every response read searched for the uploads' SHA-1s and hashes).
- Before the merge, the same 13 against PostgreSQL 18.6 through PGlite 0.5.12 (a
  temporary install outside the repository) over HTTP: 13/13; `check` applied the
  schema twice (18 tables) and `db:migrate` ran twice. `timings`, `community` and
  `moderation` on PGlite gave 12/13, 8/12 and 5/5, the same failures as the untouched
  `origin/experimental` code (those tests reset only the memory store between cases).
- `site/web` 186/186 (3 new for `lib/social.js`), `vite build`.
- In the browser (dev API in memory, one timing seeded through the worker routes) at
  375 px, dark: `/t/<id>` with its stars, uses, beatmap link and a timed comment, no
  horizontal scroll, the comment's 1:02 moving the player to 1:02.000, the panel in
  Spanish; `/u/dev_discord` with its totals, badges and list; `/timers` empty with its
  minimum stated.

Not checked: signed-in actions in the browser (rating, marking, comments, collections
and the private switch were exercised over HTTP by the tests, not clicked); light mode
and the profile tabs in the browser; screen readers on the star input; the routes on a
real PostgreSQL server (only PGlite); `bench/facts.py` (the owner's 2026-10-27 rule
keeps the Python checks off this machine; the counts in `CLAUDE.md` and `AGENTS.md`
were set by hand to the two suites' totals).

Left for later: the Ranked-match badge and beatmapset metadata (W9.2), posts to the
Mides Feed (needs Mides' API), emoji reactions (`timing_reactions`), threaded comments,
drawing timed comments on the tempo map, and notifying a timer of ratings, uses or
comments (W13.17).
### API tokens, versions, batches, images, the app and copied rows (W12.18, W12.20-W12.24, 2026-10-27)

**Personal API tokens (W12.20).** `services/token.service.js` (memory and PostgreSQL,
table `api_tokens`), `middlewares/token.js`, `routes/tokens.routes.js`; the web's
`pages/Tokens.jsx` at `/settings/tokens` (the "API tokens" section of `/settings` and the
profile lead there) and `pages/Developers.jsx` at `/developers`.

- A token is `ot_` and 256 random bits, shown once; the row keeps its SHA-256, a name,
  its scopes, when it was made and last used (written at most once a minute). At most 5
  an account; revoking deletes the row. Signing out does not revoke them.
- `Authorization: Bearer` on `/api/v1`: the request's Cookie header is dropped before
  any route runs; an invalid or revoked token is 401 `INVALID_TOKEN` and never falls
  back to a cookie; only the allow-list in `middlewares/token.js` is reachable, each
  route under its scope (403 `TOKEN_NOT_ALLOWED`, 403 `TOKEN_SCOPE`). Allowed: health,
  `/me`, your analyses with their `timing.txt`, CSV and versions, your history, the
  upload and the lookup, and the published timings. A token never manages tokens.
- `requireSameOrigin` lets a token request through: `Authorization` is not
  CORS-safelisted, so another site's page cannot make a browser send it, and the cookies
  of that request are already gone. Only the Bearer scheme triggers any of it (`Basic`,
  say a staging site behind basic auth, is a browser request as before).
- Rate limits count per token (`rate-limit.js` keys `t:<id>`): 120 a minute in its own
  bucket instead of the address's 300, and every route's own limit per token. A
  per-address limit of 600 a minute bounds token lookups.
- There is no CORS: tokens are for scripts, bots and servers.
- `/developers` renders `site/api/docs/openapi.yaml` through `scripts/openapi.mjs`, a
  reader of the YAML the document uses (served as `virtual:openapi`, like the
  changelog); it throws, with the line, on anything else. Operations a token reaches
  carry `x-token-scope`; `site/api/test/openapi.test.js` holds those marks equal to the
  allow-list.

**Versions of a timing (W12.21).** `services/version.service.js` (table
`analysis_versions`), `routes/versions.routes.js`, `components/result/Versions.jsx`,
`lib/versions.js`. A reading is another analysis of the same audio (by SHA-1) by the same
owner (account, or the anonymous cookie's hash); a cache copy is not one. A saved version
is a factor (0.5, 1, 2) and a nudge (±500 ms) with an optional label, never a copy of the
result; the same one saved twice is the same row; at most 20 a reading; they go when the
analysis is deleted. The page pairs two versions' red lines closest first within half a
beat and shows the difference per line; a line only one has is its own row. Only the
uploader's page shows versions (not `/t/<id>`).

**Whole batches (W12.22).** `components/BatchTools.jsx`, `lib/batch-export.js`,
`ZipWriter` in `lib/zip.js`. One ×2 / ÷2 and nudge for the batch, applied with the export
options to the timings zip and to "all as .osz". The `.osz` files are built one at a time
from the files the page holds into a zip whose parts are Blobs, so one song's bytes are in
memory at a time; the batch is capped at 1 GiB of audio and the page says so first.

**The tempo map as an image, and the embed (W12.18).** `lib/map-image.js`,
`components/result/MapImage.jsx`, `pages/Embed.jsx`. PNG: the page's own `paintMap` of the
whole song, twice the pixels, under a title line. SVG: a reduced drawing (red lines and
their BPM, each line's tempo, the local tempo curve, levels, a ruler) written as a string.
`/embed/<id>` is a published timing's card outside the layout (song, BPM, red lines, a small
SVG chart, a link back). `deploy/web/serve.mjs` sends `frame-ancestors *` and no
`X-Frame-Options` for exactly `/embed/<32 hex>`; every other page keeps `'none'` and `DENY`.

**The installable app (W12.23).** `public/sw.js`, `lib/pwa.js`, the manifest's
`share_target`. The worker (production builds only) keeps the shell (network first for
pages, cache first for hashed assets) and `GET /api/v1/analyses/<id>` answers once final,
served only when the network fails or the proxy answers 502-504, dropped on a 404, on
delete and on sign-out, at most 50. It never keeps audio, uploads, public timings, lists,
the account or tokens. A shared file is POSTed to `/share-target`, kept in its own cache
for the Analyze page (`?shared=1`), which takes and deletes it. Without a worker,
`serve.mjs` answers that POST with a 303 to `/analyze?shared=unavailable`, unread.
`serve.mjs` serves `/sw.js` with `no-cache, max-age=0` and `Service-Worker-Allowed: /`.

**Copy as rows (W12.24).** `lib/osu-copy.js` and the red lines table: a copy button per
row and ticked rows (Shift-click for a stretch) copy `[TimingPoints]` rows, CRLF, by time,
no header or comment: the engine's own rows unadjusted, the rebuilt ones adjusted, both
through the export options as the whole-block copy is.

Checked: `site/api` 173/173 after merging experimental (tokens, versions and the OpenAPI marks on the memory store;
`serve.test.js` for framing, the worker's headers and the share fallback), `site/web`
233/233 (the YAML reader against the real document, diffs, copy rows, the streaming zip
against `zipStore`, the batch, the SVG, the worker's handlers on an in-memory Cache
Storage), `vite build`. In the browser (dev API on its own port with a stand-in worker):
two readings 6 ms apart compared as −6.0 ms per line; ×2 saved and listed; the PNG and SVG
looked at; the embed card at 560×320; a two-song batch ×2 +5 ms as `.osz` (10.6 MB, both
`.osu` with the adjusted rows) and as timings; `/developers` and `/settings/tokens` at
375 px in Spanish, light and dark, no horizontal scroll; a token made and shown once; the
share hand-off through the cache and the "nothing usable" notice, on `serve.mjs`.

Not checked: the PostgreSQL stores of tokens and versions against a database; the service
worker in a browser (the preview pane refused to register any worker), so installing,
reading a result offline and a real phone's share sheet were not seen; a batch near the
1 GiB cap; how forums actually frame the embed; Safari and Firefox.

### Budgets, accessibility, end-to-end tests and the review routine (W10.1, W10.2, W10.5-W10.7, 2026-10-27)

**Bundle (W10.1).** Every page but home and the 404 is a `React.lazy` chunk (`App.jsx`);
the Spanish strings are a chunk loaded by a small i18next backend (`i18n.js`) only for a
Spanish visitor, and `main.jsx` awaits the stored language before the first frame. A
language added to `LANGS` needs its own `import()` there. `pnpm --dir site/web budget`
builds and runs `scripts/budget.mjs`: the entry plus its modulepreloads must stay under
200 kB gzip, and every on-demand chunk under its budget (`CHUNK_KB`, 12 kB by default);
exit 1 names the chunk. Today 162.3 kB initial (276.4 kB for the same code all eager).

**Serving.** `deploy/web/serve.mjs` sends text files of 1 kB or more brotli or gzip
compressed by `Accept-Encoding` (q=0 honoured, `Vary` set), each compressed once per
path, size and mtime and kept in a 128-entry LRU. Hashed `/assets/` were already cached
for a year. The page area (`Layout.jsx`) is at least a screen tall, so a page that fills
in after a request no longer pushes a visible footer.

**LCP and CLS.** `pnpm --dir site/e2e vitals` (after a build) serves `dist/` with
`serve.mjs` in front of the e2e API, blocks the service worker, and loads nine pages
three times each under Lighthouse's mobile profile (150 ms, 1.6 Mbit/s, CPU x4), reading
LCP and CLS (largest session window) from a `PerformanceObserver`. A red CLS names the
node that moved. `VITALS_DIST` / `VITALS_SERVE` measure another build beside this one.
A measurement, not a gate: the numbers are in the timeline.

**Accessibility (W10.2).** axe-core through Playwright (`site/e2e/tests/a11y.spec.js`,
tags wcag2a/aa, 21a/aa, 22aa) on every public page, the result page while it runs and
when done, the command palette open, and profile and history signed in, in dark and
light. What it found and what changed: the light theme's accent and amber one step
darker (only those two tokens), links inside a `p` or `dd` underlined (`index.css`),
`/status`'s definition list, three unnamed progress bars, an inline link on
`/developers`. The tempo map's canvas has `aria-describedby` pointing at the red-lines
table (`RED_LINES_TABLE_ID`), its text alternative. A keyboard test checks that the skip
link comes first and moves focus to `main`, and that the next stops show an outline. The
progress panels were already `aria-live`.

**End to end (W10.6).** `site/e2e`, one line, `pnpm --dir site/e2e test`, local only.
`playwright.config.js` starts `serve-api.mjs` (the dev API in memory with
`OVERTONE_WORKER=0`, quotas raised, and a fake worker in the same process that answers
every job with `fixture.mjs`'s timing-result v1.1 after a second, eight seconds for a file
named "slow") and Vite, on 3090/5290 (`E2E_API_PORT`, `E2E_WEB_PORT`), at 127.0.0.1, one
worker. Chromium once per machine: `pnpm --dir site/e2e exec playwright install
chromium`. It covers home, an upload of a generated WAV, the queue, the result page (map
painted, table rows, the .osz downloaded from the held file, the CSV), the dev sign-in as
staff and a suggestion posted, the legal pages, the 404, EN/ES (and a Spanish first
visit), the theme, the palette, the keyboard, and 375 px without sideways scroll on 14
pages and a result.

**Skills and the review (W10.5, W10.7).** `.claude/skills/site-ui-check` (with
`site/e2e/screens.mjs`: every page at 1366 and 375 px, dark and light, EN and ES, console
errors and overflow), `release-checklist`, `security-review`; `docs/security-review.md`
is the procedure.

How it was checked: site/api 174/174, site/web 235/235, budget ok, e2e 76/76,
`bench/facts.py` ok, `screens.mjs` 144 screenshots with no problem, vitals as in the
timeline.

Not checked: Lighthouse itself (Playwright with a `PerformanceObserver` stands in), a
real phone or network, Safari and Firefox, a screen reader, brotli through Cloudflare.
Four pages are over 2.5 s LCP on the emulated phone after the merge of `master`; that is
left open in the roadmap.

### Ten languages and the selector (W12.16, 2026-10-28)

English, Español, Français, Deutsch, Italiano, Polski, Português do Brasil, 日本語, 한국어
and Русский. `lib/languages.js` is the one list (code, own name, flag, direction) that
the navbar, `/settings`, the command palette and the tests read.

- **Files by convention.** `src/locales/<code>.json`, the same shape as `en.json`, which
  is the source of truth. English and Spanish are in the main bundle; Vite splits every
  other file into its own chunk (`import.meta.glob`), which a small i18next backend in
  `i18n.js` fetches the first time the language is chosen. A new language is its file
  plus one row in `lib/languages.js`, one flag in `components/Flag.jsx` and the code in
  `index.html`'s early script; the test names any of the four that is missing.
- **The starting language** is `mides.lang` when it holds one of the ten, otherwise the
  browser's first match in `navigator.languages` (exact code, then the primary language:
  `pt` and `pt-PT` read Brazilian Portuguese), otherwise English. A detected language is
  not stored, only a visitor's own pick. `main.jsx` shows the loader's beats, without
  words, until the starting language's strings are in, so the first frame is never
  English by mistake. `<html lang>` and `dir` follow the language. A key a file lacks
  reads in English.
- **The selector** (`components/LanguageSelect.jsx`): a button with the flag and the
  code opens the WAI-ARIA listbox of the ten, each by its own name. Arrows, Home and End
  move, Enter or Space picks, typing jumps by name or code (a repeated letter cycles),
  Escape and Tab close, and focus goes back to the button. On a phone the list is
  pinned to the bar's right edge: the button sits too far left for a list anchored to it.
- **Flags** (`components/Flag.jsx`) are inline SVG on one 3:2 box: no emoji (Windows
  draws none) and no image files. Spanish is Spain's flag (the owner's
  choice, 2026-10-28); English the Union Jack, its saltire simplified; Portuguese Brazil's,
  without the stars; South Korea keeps the taegeuk and the four trigrams.
- **Legal pages** say in every language but English that the translation is for
  convenience and the English version prevails, with a button to switch.
- **The palette** has one action per language, after the others; each answers to its
  name in English and in the current language ("german", "alemán") and to its code.
- **`test/i18n.test.js`** checks every file: its keys are English's (plural forms by
  `Intl.PluralRules` and the brief: `one/few/many/other` for ru and pl, `other` for ja
  and ko, `one/many/other` for fr), the same `{{placeholders}}` (a plural form may leave
  the count out), the legal pages' `[[...]]` marks, no empty string, and 100 % coverage
  for es, fr, de and any file that is not empty. It prints each language's coverage:
  all ten at 100 % on 2026-10-28.

Seen in the browser (web 5221, API 3051, `OVERTONE_WORKER=0`): Home, `/analyze`, the
three legal pages, `/settings`, `/community`, `/how-it-works`, `/queue`, `/recent`,
`/timers` and `/login` in fr and de at 375 px, with a script listing any element wider
than its box or past the viewport: none, but the `[TimingPoints]` line of the front
page's demo, which clips in every language. Spot checks of ja and ru at 375 px. At
1024 px the navbar's places overflowed in French (608 of 586 px), Polish and Russian;
all ten fit after shorter French labels (Attente, Connexion), German's "Queue" and a
little less space between places below 1280 px. Not seen: a result page (no worker
ran), a screen reader on the listbox, Safari and Firefox.

### The timing calculator, DAW tempo maps and four more games (W13.9-W13.11, 2026-10-28)

**The calculator** (`/tools/calculator`, `pages/Calculator.jsx`, the arithmetic in
`lib/calc.js`): BPM ↔ ms per beat (two linked fields), ms ↔ ticks of a beat divisor
(1/1 to 1/16, with the nearest whole tick and how far past it), where a second red line
falls on the first one's grid (gap in ms, beats and bars, nearest beat, how far off,
and the first grid's earliest offset), drift between two BPMs over some bars and the
BPMs that stay within a drift you accept (so "how precise must this BPM be"), and the
BPM from two timestamps and a beat count. Every result is live, fixed decimals (3 for
ms, 6 for BPM) and a button that copies its number. Keyboard first: the first field
has the focus, the arrows step the field in hand (Shift ×10, Alt ×0.1), a comma is a
decimal point. The result page links to it with the first red line's BPM and offset
filled in (`?bpm=&offset=`, timing only, never the file name); the palette and the
footer's Learn column list it; it is in the sitemap. Nothing is sent or kept.

**DAW tempo maps** (`lib/daw-exports.js`, `components/result/DawExports.jsx`), in
"More downloads" after the games, built from the lines as exported:

- A Standard MIDI File, format 1 with one conductor track, 960 PPQ: Set Tempo
  (whole µs per quarter) and Time Signature (n/4) at each red line. Tick 0 is the
  audio's start, so a lead-in bar reaches the first line's first downbeat (the Clone
  Hero rule). A change between ticks gets the nearest tick, and the tempo before it is
  fitted only when keeping it would land the change more than 0.25 ms off; each span
  starts where the file put the last change, so nothing accumulates. The tests parse
  the file back by the spec and time every line through its tempo map: under 0.5 ms
  on 40 changes off the grid; the page prints the worst.
- Reaper: a small `.rpp` project rather than a list, chosen because it is the one text
  route that carries tempo (the region/marker manager's CSV import has no tempo): the
  master tempo envelope (`PT`, square, time signatures packed as num + 65536 × den), a
  marker per red line, and the song as an item on a track when its type is one Reaper
  names (mp3, ogg, wav, flac, opus).
- Ableton Live: no file. Live has no tempo-map text format, so the page sends its users
  to the MIDI file and says how, rather than inventing one.

**Four more games** (`lib/game-formats.js`; its comment holds each format's rules and
where we are least sure): Beat Saber v3 `bpmEvents` in `ExpertStandard.dat` (beats
accumulated; beat 0 the audio's start, so a lead-in beat; the page names the BPM for
Info.dat; v3 chosen because v2 has no official BPM event of its own), A Dance of Fire
and Ice `.adofai` (a straight path, a tile a beat, `SetSpeed` by BPM; a span that is not
whole beats ends on one odd tile at its own speed, rather than an angled tile whose
direction we could get backwards untested), Friday Night Funkin' legacy chart JSON
(sections of 16 steps with `changeBPM`, `lengthInSteps` and Psych's `sectionBeats`; a
lead-in and odd sections of whole steps), Rhythm Doctor `.rdlevel` (`PlaySong` with BPM
and offset, `SetBeatsPerMinute`, `SetCrotchetsPerBar` where a meter starts a bar). Every
position is worked from where the file puts the change before it, so roundings never
accumulate. The page counts the odd tiles and sections and the meters Rhythm Doctor
cannot place. Tests: `game-formats-more.test.js`, against hand-written files in
`test/fixtures/games` and read back by each game's own arithmetic.

Checked in the browser pane (5243/3073, no worker: a generated WAV uploaded and a
hand-made result posted to `/api/internal` as the worker): the calculator at 375 px in
ES and EN, dark and light, nothing past the edge, the link's BPM and offset filled in,
Shift+↑ and Alt+↓ stepping a field (174.3 → 184.2); the result page's "More downloads"
at 375 px with the eight game buttons, the two DAW buttons and their notes; the six new
files caught in the page and read (the MIDI header, the Reaper envelope with the 3/4
packed as 262147, the JSON files). Not checked: any file opened in its game or DAW
(none was run), the clipboard copy in a real click, Safari and Firefox.
