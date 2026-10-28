# Discord, osu! and the bot (W9)

Phase W9 of `docs/16-web-platform.md`: an Overtone account linked to Discord
(W9.1) and to osu! (W9.2), and a Discord bot (`bot/`) that times songs and reads
timings through the API (W9.3-W9.5). Built on 2026-10-27 with **no secret in
existence yet**: no Discord bot token, no osu! OAuth app. Every part is off until
its environment variables are set, and says so (the API's start log, the profile,
the bot's one line).

| Part | Turned on by | Off looks like |
|---|---|---|
| Discord through Mides | `MIDES_WEB_URL` here **and** the two things Mides must add (below) | the profile offers the bot's code instead, or says linking is unavailable |
| The bot's routes in the API | `BOT_TOKEN` (site/api) | `503 BOT_OFF` on `/api/internal/bot/*`; the profile hides the code button |
| The bot | `DISCORD_TOKEN`, `BOT_TOKEN`, `OVERTONE_API` (bot/) | `[overtone-bot] OFF: ... not set`, exit 0 |
| osu! | `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSU_REDIRECT_URI` (all three) | "Linking osu! is not available on this server yet." |

## W9.1, linking Discord

The account keeps one Discord id (`accounts.discord_id`, unique). It arrives two ways:

1. **From Mides, at sign-in.** `services/mides.service.js` `toUser` reads
   `discord_id` from the SSO exchange's user when it is a snowflake (17-20 digits).
   When Mides sends one it wins: it is written on the account and taken off any
   other account that held it. When Mides sends none, the stored one is kept.
2. **From the bot, with a code** (the fallback while Mides cannot do 1). The
   profile's "Link with the bot" makes a code (`XXXX-XXXX`, 31 unambiguous
   characters, ten minutes, one per account, only its HMAC stored in
   `discord_link_codes`); the person types `/link XXXX-XXXX` to the bot, and the
   bot sends the code with the Discord id Discord gave the interaction. The site
   session proves the account, Discord proves the Discord user.

The profile's "Link on Mides" (`GET /links/discord/start`) sends the browser to
`${MIDES_WEB_URL}${MIDES_DISCORD_LINK_PATH}?app=overtone&return_to=${SITE_URL}/profile?linked=discord`.
Coming back, `/profile?linked=discord` signs in again (Overtone keeps no Mides
token to ask with; Mides has a session, so the trip is a bounce), and the new
sign-in brings the profile with its `discord_id`. At most once a minute per tab.

Unlinking (`DELETE /links/discord`) clears the id and turns the DMs off. A Mides
that sends `discord_id` links it again at the next sign-in: to stop that, unlink
Discord in Mides.

### What Mides (Mides-Dev-Web) must offer

Not built here: that repository is not this task's to change. For "Link on Mides"
to work, Mides needs:

1. **`discord_id` in the SSO exchange's user for the `overtone` app**
   (`POST /api/auth/sso/exchange`): the linked Discord user's id as a string, and
   absent or `null` when the account has no Discord. Nothing else of the Discord
   connection (no token, no username) is needed.
2. **A web page at `/connections/discord/link`** (or wherever
   `MIDES_DISCORD_LINK_PATH` points) taking `app` and `return_to`. It:
   - asks the visitor to sign in to Mides if they are not;
   - runs Mides' own link flow (`connections/discord/link-token`, then Discord's OAuth);
   - sends the browser to `return_to` afterwards, whether it linked or not, **only
     when `return_to` is on an origin registered for that app** (the same origin as
     `SSO_APPS.overtone`'s redirect URI). Any other value goes to Mides' own page:
     otherwise the page is an open redirector.
3. Preferably, **`/authorize` with a live Mides session and no `provider` answers
   at once** (back to the redirect URI with a code, no picker), so the refresh is
   invisible. Without it the person picks Discord or Google once more; it still works.

## W9.2, linking osu!

OAuth 2 of the osu! API v2, authorization code, scope **`identify` only**:

1. `POST /links/osu/start` (session, same-origin): a signed `overtone_osu` cookie
   (Path `/api/v1/links/osu`, HttpOnly, ten minutes) holding a random state, the
   account and an expiry, and the URL of `https://osu.ppy.sh/oauth/authorize` with
   `client_id`, `redirect_uri`, `response_type=code`, `scope=identify`, `state`,
   and `code_challenge` (S256).
2. osu! sends the browser to `OSU_REDIRECT_URI` = `SITE_URL/link/osu` with
   `?code&state`. The page (`pages/OsuLink.jsx`) takes them out of the address bar
   and posts them to `POST /links/osu/exchange`.
3. The API checks the state against its cookie and the session's account, then
   exchanges the code server side (`client_secret`, `redirect_uri`, `code_verifier`),
   reads `GET /api/v2/me` **once**, and keeps four fields: the osu! id, username,
   avatar URL (on `ppy.sh` only) and `ranked_beatmapset_count` (or the older
   `ranked_and_approved_beatmapset_count`). The token is dropped there: not
   stored, logged or returned, and no refresh token is used.

**PKCE:** the verifier is an HMAC of the state under `SESSION_SECRET`, so it never
leaves the server, not even in the cookie. osu!'s API documentation does not
mention PKCE; osu-web's OAuth server (Laravel Passport, league/oauth2-server)
checks a `code_challenge` whenever one is sent. It is on by default; `OSU_PKCE=0`
leaves it out should the first real link fail on it. The state check stays.

One osu! user links to one account: linking proves who holds it now, so an older
link elsewhere is cleared. The profile shows the username (linked to the osu!
profile) and the ranked count. The avatar is stored but not shown: images load
only from this site and Mides (`img-src`), and a page only its owner sees is not
worth a request to `ppy.sh`. `DELETE /links/osu` unlinks.

### What the owner registers on osu!

- On <https://osu.ppy.sh/home/account/edit#oauth>, "New OAuth Application", as
  Mides Projects: name **Overtone**, callback URL **`https://overtone.midesprojects.com/link/osu`**.
  osu! takes one callback per application, so staging needs **its own application**
  with its own `SITE_URL/link/osu`.
- In the API's panel variables: `OSU_CLIENT_ID` (the number osu! shows),
  `OSU_CLIENT_SECRET`, `OSU_REDIRECT_URI` (exactly the callback). The API refuses
  to start with one or two of them set, or with a redirect URI not on `SITE_URL`.

### The osu! API's terms, as this respects them

Read on 2026-10-27 at <https://osu.ppy.sh/docs/index.html> ("Terms of Use" and
"Authorization Code Grant"). In short: use the API responsibly; stay around 60
requests a minute or less; don't poll the same user or beatmap more than once a
minute; don't use it as a database or to harvest data in bulk (data.ppy.sh is
there for that); ask before serious long-term use. `identify` reads the user's
public profile through `/me`.

What Overtone does: one `/me` per link, made by the person pressing "Link osu!",
and nothing else. No polling, no beatmap or score data, no stored token, so no
call can be made later. The app is named as Mides Projects' and never presented as
osu!'s. **W9.6 stays a rule:** no `.osz` or audio is downloaded from osu!; the
person uploads their own file.

## W9.3-W9.5, the bot (`bot/`)

Node 22+, **discord.js 14.27.0** (pinned; released 2026-07-15), the stack the
roadmap names (cavernia-bot's). Only `src/index.js` imports it; everything else is
plain modules over a `fetch` client, which is what the tests drive.

```
bot/src/index.js        the client: Guilds intent only (slash commands need no privileged intent)
bot/src/config.js       DISCORD_TOKEN, BOT_TOKEN, OVERTONE_API; off when any is missing
bot/src/api.js          the client of /api/internal/bot
bot/src/handlers.js     what each command does
bot/src/attachment.js   an attachment, checked, downloaded under the cap, into memory
bot/src/format.js       the embeds, as plain objects
bot/src/strings.js      EN and rioplatense ES, by the Discord client's locale
bot/src/notifier.js     the DM outbox (W9.4)
bot/src/commands.js     the slash command definitions
bot/src/register.js     one PUT of the whole list to Discord's REST API
bot/scripts/register.mjs  pnpm --dir bot register
```

### Commands

| Command | What it does |
|---|---|
| `/time-song audio [publish] [private]` | Downloads the attachment, uploads it to the API as the linked account (or the Discord user's anonymous quota), edits its reply with the queue position and the progress, and answers with an embed: BPM, offset, red lines, confidence level and number, meter, and a link (the public page when published, the result page when linked). `publish` publishes it when done; `private` keeps it off the public queue. |
| `/timing <link or id>` | A published timing, or one of the caller's own. Takes `…/t/<id>`, `…/analyze/<id>` or the 32-character id. |
| `/queue` | Waiting, analysing, finished in the last hour, and where the caller's songs are. |
| `/compare <a> <b>` | Two timings side by side and the difference (BPM, offset). |
| `/recent [user]` | The latest five published timings of a Discord user with a linked account. |
| `/link <code>` | Links the caller to the account that showed the code (private reply). |
| `/notify on\|off` | DMs when an analysis of the linked account ends (private reply). |

### The attachment and the audio

- Checked before downloading: the extension (the API's list, from `GET /health`),
  Discord's content type (audio, Ogg, octet-stream or none), the declared size
  against the API's own `MAX_UPLOAD_MB`, and the URL's host (`cdn.discordapp.com`,
  `media.discordapp.net`).
- Checked while downloading: no redirects, the response's type, its
  `Content-Length`, and a running byte count that stops reading at the cap.
- **ADR-W4:** the audio is a `Buffer` in memory from the download to the upload and
  dropped after; never written to disk or logged. On the API it follows the site's
  path exactly: spooled, analysed, deleted.

### Unlinked users: decided, and why

An unlinked Discord user gets **the anonymous quota of one visitor**
(`ANON_DAILY_LIMIT`, `ANON_MAX_PENDING`), counted by an HMAC of their Discord id
and the UTC day, never the id. Their analyses are owned by another HMAC of it, so
only they read them back (`/timing`), with the same 404 as a missing id for anyone
else.

Why not refuse them: until Mides sends Discord ids, nobody is linked except through
`/link`, and a bot that only works after a trip to the website would rarely be
used. Why this is not a hole: a Discord account costs about what a fresh address
does, the bot and the API both rate-limit per Discord user, and the queue's own caps
(`QUEUE_MAX`, the spool) hold whatever the per-user quota does not.

### Limits

- In the bot (memory): 20 commands a minute and 5 `/time-song` per 10 minutes per
  Discord user. It spares a download for someone already over.
- In the API (the authority, shared through `rate_limits`): uploads 10 per 10
  minutes, reads 120, link and notify 10, per Discord user; the daily quota and the
  pending caps as for the site.

### Waiting longer than Discord allows

An interaction's reply can be edited for 15 minutes. Past 13 the bot says once that
it will post the result in the channel, keeps asking every `BOT_POLL_MS`, and posts
it there mentioning only the caller (or DMs it when it cannot write in the channel).
It gives up waiting after three hours.

### DMs (W9.4)

Opt-in per account: `/notify on` or the profile's switch (`accounts.discord_notify`,
only with Discord linked). When the worker posts a result or a failure, the API puts
a row in `discord_dms` for an account that asked; the bot claims up to ten every
`BOT_DM_POLL_MS`, marking them sent in the same statement (**at most once**: a lost
notice is cheaper than a doubled one), and sends each as a DM. The Discord id is
read at claim time, so unlinking in between sends nothing. A song the bot already
answered in a channel is not DMed again. A cached answer is not an ended analysis
and sends nothing.

### No chart image

The roadmap asked for an image of the tempo chart rendered with the site's design.
Doing it server side means a headless browser or a canvas library on the worker or
the bot for one picture; it is not worth it now. The embed links the page, which
draws the chart.

### The API side

`/api/internal/bot` (`site/api/src/routes/bot.routes.js`), mounted before the
worker's `/api/internal`:

- its own bearer, `BOT_TOKEN`: the API refuses to start with it equal to
  `WORKER_TOKEN`, the worker's token does not open it and its own does not open the
  worker's;
- `503 BOT_OFF` while unset;
- `X-Discord-User` in a header on every person's request, never in a URL;
- uploads go through the site's own `acceptUpload`, so the bot has exactly the
  site's checks and limits;
- **overtone-web never forwards it**: `deploy/web/serve.mjs` refuses all of
  `/api/internal`, and `test/serve.test.js` tries six spellings of `/api/internal/bot`.

## Running it

```bash
pnpm install --frozen-lockfile            # the workspace now includes bot/
pnpm --dir bot test                       # the fakes, and a contract suite against the real site/api
cp bot/.env.example bot/.env              # DISCORD_TOKEN, BOT_TOKEN (= the API's), OVERTONE_API
pnpm --dir bot register                   # with DISCORD_APP_ID (and DISCORD_GUILD_ID to try it on one server)
pnpm --dir bot start
```

The bot's tests need `site/api`'s dependencies installed: `contract.test.js` imports
the API itself. On the panel it is the `overtone-bot` egg (`docs/deploy.md`).

To create the bot on Discord: Developer Portal, New Application ("Overtone"), Bot,
reset the token (into `DISCORD_TOKEN`, never a file in the repo), no privileged
intents. Invite it with the `bot` and `applications.commands` scopes and the
permissions Send Messages and Embed Links.

## How it was checked (2026-10-27)

- `site/api` 123/123 (23 new): `test/links.test.js` against a stand-in osu! OAuth
  server that checks the client, secret, code, redirect URI and the PKCE verifier
  against the challenge (identify only; state per browser and account; the token
  nowhere in the answer; `/me` once; four fields; bad states refused before osu!
  is called; Mides' `discord_id` filtered; DMs need a link; the bot off);
  `test/bot-routes.test.js` (the two bearers apart; linked and unlinked uploads;
  the anonymous quota per Discord user; ownership 404s; publish; queue; `/link`
  codes spent once and surviving a sign-in; `/notify`; the outbox once; `/recent`);
  `test/serve.test.js` (six spellings of `/api/internal/bot`, none forwarded).
- `bot` 29/29: handlers against a fake API and a fake CDN (progress edits, EN and
  ES, publish and private, every attachment refusal before and while downloading,
  the API's refusals as sentences, the 15-minute window to the channel and to a DM,
  limits, references, compare, queue, recent, link, notify, markdown in names);
  the outbox; the commands' shape; registering against a fake Discord REST; the off
  switch in a child process; discord.js at its pin; and `contract.test.js`, the bot
  against the real `site/api` (memory store) with the worker played over its routes
  (uploaded, analysed, published, the spooled audio gone; the cap; the cache; a
  linked account's DM).
- `site/web` 90/90, `vite build`; the profile in EN and ES, dark and light, 375 px,
  unlinked and linked through a bot code (`/link` sent to the dev API by hand).
- `deploy/eggs/egg.py --check`: 5 eggs.

**Not checked:** a real Discord gateway or REST (no token exists), real osu! OAuth
(no app), whether osu! accepts the PKCE parameters, the Mides page and
`discord_id` (Mides has neither yet), the new tables against PostgreSQL (the memory
store ran; `schema.sql` was not applied to a database in this session), and the
`overtone-bot` egg on the panel.
