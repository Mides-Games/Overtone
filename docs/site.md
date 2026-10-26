# The Overtone website (`site/`)

The website of docs/16-web-platform.md: Overtone as a public Mides Projects
site for timings, signed in with a Mides account. This is the skeleton of
phase W3: it runs, signs people in and shows the pages, and it does not
analyse anything yet.

```
site/api/   Express 5 + pg, plain ES modules (modelled on cavernia-api)
site/web/   React 19 + Vite + Tailwind 4 + react-router 7 + i18next EN/ES
```

The root `package.json` and `pnpm-workspace.yaml` make the two one pnpm
workspace. The engine (`python/`, `crates/`) is not part of it.

## Run it on another machine

Node 22 or newer and pnpm (`corepack enable` provides it). From the
repository root:

```bash
pnpm install && pnpm dev
```

That starts the API on http://localhost:3001 and the web on
http://localhost:5173 (open this one; it proxies `/api` to the API). `pnpm dev`
turns on `MIDES_DEV_LOGIN`, so **Sign in** with Discord or Google signs you in
as a test account without Mides, and with no `DATABASE_URL` the accounts live
in memory and vanish when the API restarts. No secret and no database are
needed to try it.

Other commands:

```bash
pnpm build                          # the web's production build, into site/web/dist
pnpm check                          # schema.sql applied twice to a throwaway schema (skips without DATABASE_URL)
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
| `TOKEN_KEY` | random per process | Seals Mides refresh tokens at rest (AES-256-GCM, HKDF). 32+ characters. **Required in production.** Separate from `SESSION_SECRET`, so rotating one does not void the other. |
| `MIDES_AUTH_URL` | none | The Mides identity API, e.g. `https://midesprojects.com/api`; the service calls `${MIDES_AUTH_URL}/auth/...`. |
| `MIDES_WEB_URL` | none | The Mides site that serves `/authorize`, e.g. `https://midesprojects.com`. |
| `MIDES_APP` | `overtone` | The app name registered in Mides' `SSO_APPS`. |
| `MIDES_DEV_LOGIN` | off (`pnpm dev` turns it on) | Fake sign-in without Mides. **Refused when `NODE_ENV=production`.** Set `0` in `.env` to try the real SSO in development. |
| `ANON_DAILY_LIMIT` | `5` | Analyses a day without an account (shown on Analyze; not enforced yet). |
| `MAX_AUDIO_SECONDS` | `600` | Longest song (checked in the browser today; the server check comes with W3.4). |

## Sign-in

Mides SSO only, as the `web` app type (ADR-W2). `GET /api/v1/auth/sso/start`
builds `${MIDES_WEB_URL}/authorize?app=overtone&redirect_uri=${SITE_URL}/login/callback&provider=discord|google`
on the server and sets a signed, ten-minute `overtone_sso` cookie. Mides
returns to `/login/callback#code=…`, the web posts the code to
`/api/v1/auth/sso/exchange`, and the API exchanges it with
`${MIDES_AUTH_URL}/auth/sso/exchange`. The exchange refuses a browser without
the SSO cookie and without the web's own note of the trip (login CSRF). The
browser then holds one HttpOnly `overtone_session` cookie, an HMAC over the
account id, expiry and session version. The Mides refresh token is stored
sealed and never sent to the browser. Only public profile fields are cached:
no email, no phone.

The real SSO needs W3.2 first: `overtone` registered in Mides-Dev-Web's
`SSO_APPS` with this site's origins and `/login/callback`.

The endpoints are described in `site/api/docs/openapi.yaml`.

## What is stubbed

- `POST /api/v1/analyses` answers **501** without reading the body. The queue,
  the worker and the results (W2, W3.4) are not built; the Analyze page says so.
- The anonymous quota (`ANON_DAILY_LIMIT`) is shown, not enforced (W3.6).
- Profile is a placeholder: counters show a dash, timings come with publishing (W5).
- The schema already holds every table of the plan's data model (songs,
  analyses, jobs, timings, ratings, reactions, uses, comments, collections,
  reports, notifications); only `accounts` and `mides_tokens` are used.
- No tests yet beyond `pnpm check`; the flows were checked by hand (below).

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
