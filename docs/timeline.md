# Timeline

Engineering log for Overtone: what changed, **why**, and what it measurably did.

Newest first. One entry per release. Each entry keeps the same four sections so a
future reader can skim for the one they need:

- **Changed** — what the release does differently.
- **Fixed** — bugs, with the root cause, not just the symptom.
- **Hardening** — robustness and security work.
- **Measured** — numbers, or "not measured" if there aren't any.

A `Rejected / tried and dropped` section is worth adding whenever an approach was
attempted and abandoned — the reasoning is the expensive part, and re-deriving it
later costs more than writing it down now.

Work that has landed but is not in a published version is headed
**Unreleased**, in the same order as everything else. The newest published
version is `v1.0.0-stable` (2026-10-28).

---

## Unreleased — 2026-10-31 · Which timing problems cost the most

### Changed

- **`bench/diagnose.py`** (owner's request: know which problems to attack first). A stage
  report is cut wherever the map's red line or ours changes, and each stretch gets one
  cause (right, half, double, another ratio, tempo wrong, BPM slightly off, offbeat,
  beats shifted), so the shares add up to the songs' time; line problems (missed, late,
  phantom changes, double ticks, lines that change nothing) are counted per minute. Every
  song weighs the same. `bench/stages.py` prints it after its summary and keeps it in the
  report (`diagnosis`), maps now record `duration_s`, and `remote.py diagnose <id>
  --compare <id>` reads any server run.

- **Red lines above 260 BPM are read at half (OCTAVE_CAP)**, the diagnosis's first lead.
  By our line's BPM, on the dev reports below: above 260 no stretch of anime-single or
  anime-variable was right and 70-97 % of it was the map's double (about 3 % of their
  time); bands' fallback lines there were 18 % right and 24 % double (about 6 % of bands'
  time). 240-260 is mixed (bands' precision lines 83 % right), so the cap starts above it.
  The half grid takes the beat with the stronger attacks, and a run of capped lines keeps
  one grid. Benchmark, bpm-snapshot and golden unchanged; on the server, experiment
  `octave-cap-off` is the comparison.

### Fixed

- Found while writing its tests: half a beat away read +half at one end of a stretch and
  -half at the other, whose median is 0, so an offbeat grid counted as right. The phase is
  now wrapped into one half-open beat.
- Then two more, found on Vampires against its ranked set: a ranked map times bar by bar,
  each bar a BPM or so from the next, so judging a stretch by its BPM called right beats
  "slightly off"; a stretch is now judged by its beats. And two ends alone missed a drift
  of exactly one beat (202 against 200 over 30 s), which wraps to 0: 17 beats spread over
  the stretch are checked. (A set's own audio, never another set's: the unranked set's
  audio.mp3 has another offset, and against the ranked lines read 0 % right.)
- A change, for the line problems, is now a BPM more than 1 % away: a ranked map's
  bar-by-bar lines (94.04 then 94.11) counted as changes we missed. Bands' missed changes
  went from 3.75 to 3.17 a minute, anime-variable's from 4.39 to 3.70: still the largest
  line problem.

### Measured

Dev, server reports of 5fdf765 (bands: against bb624b0 before phrases), share of time:

| | right | worst three time problems | worst line problem |
|---|---|---|---|
| bands-variable | 55.7 % (+1.3) | beats 10-25 ms off 9.6, tempo wrong 8.5, BPM slightly off 7.0 (−3.1) | missed changes 3.75 / min (37 % of songs) |
| anime-variable | 58.4 % | read at double 10.5, beats 10-25 ms off 9.4, BPM slightly off 9.3 | missed changes 4.39 / min (54 %) |
| anime-single | 70.8 % | beats 10-25 ms off 15.7, read at double 5.5, offbeat 2.3 | phantom changes 0.47 / min (8 %) |

"Beats 10-25 ms off" is mostly the mappers' own offsets (see the tool's limits), so the
engine's first targets are double readings, missed changes and BPMs slightly off.

## Unreleased — 2026-10-31 · Phrase red lines, and the gates they broke

### Changed

- **Red lines as phrases (PHRASE_LINES, #103–#108).** Jittery lines merge into one per
  phrase; a change lands on a downbeat or where the music eases off; on the fallback
  tracker (live bands) each phrase is then timed bar by bar with a continuous grid, as the
  ranked set 2437969 (My Chemical Romance - Vampires Will Never Hurt You) is: 85 % of its
  236 lines are one bar long and 94 % start on the previous line's grid. Ours: 239 lines,
  76 % on the previous grid.
- **BPMs with two decimals** (TIDY_BPM_DECIMALS, the owner's request after the same
  ranked set: 94.04, 94.11 ...). The one-decimal rule of 2026-10-30 stays behind the
  constant. Benchmark, bpm-snapshot and golden unchanged.
- **A live band's hint (`band`) separates the drums** for that job (STEMS_DRUMS through
  the worker's engine settings), the owner's decision on the stems-drums run below. The
  engine cannot tell a band from the rest (residual and stability overlap with
  anime-variable), so the person says it. A worker without the separator analyses the mix
  and the result says so (`band_no_separator`). The separator takes ~2.4 GB and ~2.5 min
  a song on the server's 6 cores, more than a 2 GB worker holds.

### Fixed

- **The benchmark fell to 21/24 and `signatures` failed** (server gates of 5fdf765). The
  downbeat, quiet and onset bonuses that place a phrase change also ran on the precision
  engine, whose change points are exact: on secs-2 two candidates fit equally and a 0.001
  bonus moved the 142 line one beat late. The bonuses now apply to the fallback tracker
  only. Phrases also merged a 6/4 line into a 3/4 one; a song whose lines change meter is
  now left as read.
- **First lines read at half** (bands-variable dev, octave x1 85.4 → 82.1 %). The halving
  rule halved a 217 intro of a 226 song (Pierce The Veil - King For A Day) because the
  intro has no half beats. A part within PHRASE_HALVE_SAME (8 %) of the rest of the song's
  tempo is now kept; Alesana - Seduction's 235 ending of a 200 song is still halved to ~116.

### Measured

Locally: benchmark 24/24 (median 0.0000 BPM, 0.14 ms), bpm-snapshot 24/24, golden 27/27,
signatures, measures, coverage, reference, assisted and robustness pass. real-audio needs
the server's library (it pinned noble 14 → 4 and calm-down-juliet 102 → 1 lines on
5fdf765, the intended merges); perf's Beat This! stage needs the model, absent here.

Server, app engine (5fdf765 unless named), tempo ok / octave x1 / beats within 10 ms:

| | bands dev | bands held out | anime-single held out |
|---|---|---|---|
| base, bb624b0 (before phrases) | 52.0 / 85.4 / 70.6 | 65.4 / 87.9 | 83.5 / 93.8 (lines-on-downbeats) |
| base, 5fdf765 | 56.4 / 82.1 / 69.4 | 71.3 / 85.7 | 85.5 / 93.8 |
| percussive, bb624b0 | 59.9 / 81.8 / 71.2 | 67.6 / 92.3 | 83.7 / 90.3 |
| stems-drums | 58.0 / 83.2 / **78.8** | 71.0 / 88.2 | failed (jobs 4, out of memory) |

Held-out beats are not comparable: a held-out run fits no convention of its own.

### Rejected / tried and dropped

- **Percussive input by default.** It trades octave for tempo on bands (dev octave −3.6,
  held out +4.4) and costs anime-single 3.5 points of octave. Kept as an experiment.
- **Stems-drums by default, for now.** Beats within 10 ms rise 9.4 points on bands, the
  biggest single gain measured, but a song takes ~74 s instead of ~12 s on the server and
  the site's worker would need the separator; anime is not measured yet.

## Unreleased — 2026-10-31 · The fallback tracker's octave jumps and ramps

### Changed

- **Experiments added, both off** (owner's report: a Senses Fail song at ~225 BPM came
  back mostly at 112 and 150, with ramps between). The song took the fallback tracker
  (no fittable grid), where none of the octave fixes run (they ask for
  `engine == "precision"`). `local-step` (`LOCAL_STEP_JUMPS`): a change of more than 8 %
  between two windows happens at once, half-way, instead of the straight line that wrote
  206, 198, 188 ... BPM over ~4 s. `local-octave-up` (`LOCAL_OCTAVE_UP`): where the path
  reads X on at least 10 % of the windows and ~X/2 elsewhere, and X is at most
  MAP_OCTAVE_RANGE's 240, the X/2 windows are read at X. `local-step-octave-up` is both.

### Measured

That song alone, v3 locally, no Beat This! vote (onnxruntime not installed here), seconds
of red line at each tempo:

| | lines | ~112 | ~150 | ~225 | ~266 | other (ramps) |
|---|---|---|---|---|---|---|
| base | 169 | 57.5 | 70.5 | 35.0 | 65.5 | 15.5 |
| local-step | 125 | 64.4 | 70.1 | 40.6 | 65.5 | 3.4 |
| local-octave-up | 134 | 0.0 | 65.3 | 100.8 | 65.5 | 12.4 |
| both | 115 | 0.0 | 69.3 | 104.8 | 65.5 | 4.5 |

The ~150 (2/3 of 225) and ~266 parts are not octave errors and stay. Not yet measured on
the server's stages: that waits for the deploy, since the server runs `master`.

### Rejected / tried and dropped

- **The octave rule's off-beat ratio, read on the onset envelope** (the legacy tracker
  keeps no attacks): over this song's 112 parts it ran 0.15 to 1.04 window to window, so
  OCTAVE_RULE_DOUBLE's 0.9 would have doubled some parts of one tempo and not others.
- **LOCAL_OCTAVE_HALVE off**: no change on this song; it never fired.

## Unreleased — 2026-10-30 · Out of the OOM loop; tidy, octave, drums and downbeats

### Fixed

- **The server in an OOM restart loop all day** (#91). `PERCUSSIVE_INPUT = 1.0` by
  default (#89, no gates run) changed the engine hash, so the service re-analysed all
  4693 songs, each through librosa's whole-song HPSS in the service process: 1.75 GB a
  five-minute song, four at a time, past the 7.3 GB memory cap before one song was
  committed. The kernel killed it every ~3.7 min from 08:12, with every measurement run,
  gate and suite with it. Drums-only input back off by default.
- **Real decimal tempos rounded away** (#92). #90 wrote every BPM with one decimal:
  128.37 -> 128.4, ~40 ms of drift over a three-minute line (benchmark decimal-128.37
  MISS, test_odd_tempo_is_exact). One decimal now only where the line's ends move
  `TIDY_BPM_DRIFT_MS` (2 ms) or less; 233.433 still reads 233.4 on lines up to ~1.5 min.
- **The octave rule halved fast songs** (#94). With nothing on the half beats it cannot
  tell a slow song read at double from a fast one without subdivision: 174 and 180 BPM
  click tracks read 87 and 90, camisa-negra 194 -> 97. Its halving is off
  (`OCTAVE_RULE_HALVE_FLOOR = inf`); the doubling stays.
- **The update never restarted the service on a fix** (found, not changed): with the
  service in its kill loop the busy check got no answer and every tick waited. Stopping
  `overtone-api` by hand let it through, as the script intends.

### Changed

- **HPSS in 20 s blocks** (#93), padded 2 s and aligned to the STFT hop: output
  identical to the whole song (difference 0.0), peak 207 MB instead of 1.75 GB.
- **Experiments added, all off:** `lines-on-downbeats` (#95, roadmap 27.7: a tempo
  change moves by whole beats of its own onto the previous line's next bar line, kept
  only if the 10 ms fit loses at most 0.002), `stems-drums` (#88, Stemsplit's drums
  stem through its CLI; the server has the binary and the epoch-30 model),
  `octave-rule-floor`, `octave-rule-no-halve`.
- **bench/stages.py reports `line_on_bar`**: the share of the engine's red lines after
  the first that start within 20 ms of one of the map's bar lines (4/4 assumed).

### Measured

Rust engine, 08501366, ranked maps, dev [held out]:

| | bands tempo ok | bands octave x1 | bands beats 10 ms | anime-single tempo ok |
|---|---|---|---|---|
| base | 47.6 [61.0] | 63.2 [75.7] | 54.0 | 78.4 [82.2] |
| octave-rule-floor | 47.6 [61.0] | 63.2 [75.7] | 54.0 | 78.0 [82.2] |
| octave-rule-no-halve | 47.6 [61.0] | 63.2 [75.7] | 54.0 | 78.1 [82.2] |
| percussive | **59.7 [64.3]** | **72.3 [77.6]** | **63.1** | (running) |

Halving never fired on bands. Percussive answered 526 of 636 bands dev maps (base 450).
The rust engine refuses where app falls back to v3, so these sit below app's numbers
(app, ed3b02f: bands 51.3 [65.4], anime-single 84.2 [84.4]); app runs are queued.

## Unreleased — 2026-10-29 · The .osz kept on this device, to download again

### Changed

- Every .osz downloaded from a result, a published timing or the batch's "all as .osz"
  is kept in the visitor's browser (IndexedDB, `site/web/src/lib/kept-osz.js`): the
  exact zipped bytes that were downloaded, with the song's title and artist, the page
  and id it came from, its size, its date and the adjustment and options that built it.
  The .osz is built from the visitor's own audio, which the page no longer has once it
  is left; until now, so was the .osz.
- The page it came from shows **Download the .osz again**, with the date, the size and
  a delete, without asking for the song. **/downloads** lists every kept .osz with the
  total and what the browser grants the site, each one downloaded again or deleted, or
  all at once. It is linked from the account menu, the footer and the command palette,
  and works without an account: the files are this device's, and the page says so.
- One entry per page and id: building it again, with the same options or others,
  replaces it. The newest build is the one the visitor wanted, and every copy is a
  whole song.
- The privacy page names the library (`overtone-kept-osz`) beside the local storage
  keys, in all ten languages.

### Hardening

- The library is capped at 1 GB or half the quota the browser grants the site,
  whichever is smaller, and makes room by dropping the least recently downloaded first;
  the page names what it dropped. A file larger than the cap is not kept. Out of quota
  under the cap (another tab, the rest of the site), it drops the oldest and tries
  again.
- The browser is asked once, when the first file is kept, to make the storage
  persistent (`navigator.storage.persist()`); never on page load.
- Nothing about it can stop a download: IndexedDB missing (some private windows),
  blocked or full makes the page say quietly that no copy was kept, and the download
  has already gone. Listing reads no song: entries and bytes are two object stores.

### Measured

- 13 node tests for the library over an in-memory IndexedDB stand-in (keep, replace,
  order, eviction, cap, quota, persist once, delete, storage unavailable or refusing),
  and one for the batch handing each .osz over. Bundle budgets: see the commit.
- Not measured: how much a real visitor keeps, or how each browser treats a persisted
  1 GB origin under disk pressure.

### Rejected / tried and dropped

- **Keeping the built .osz on the server**, so it could be downloaded from any device.
  The site promises everywhere (FAQ, privacy page, upload form) that the audio is
  deleted from the server after analysis, and an .osz is the audio plus a few
  kilobytes: storing it breaks that promise. For someone else's timing it would also
  mean the server handing out copyrighted music to whoever opens the page, and the API
  server has a 2 GB disk, which a hundred songs fill. Kept on the visitor's own device
  instead, only the bytes that already went to them.
- **An audio-less .osz** (just the .osu, a few kB) from any timing: left out for now.
  The page already gives the same lines without the song (the [TimingPoints] copy, the
  timing file and the patched .osu), and what osu!stable does on importing a set whose
  `AudioFilename` is missing was not checked.

---

## v1.0.0-stable — 2026-10-28 · Tidy BPMs on, and three bands experiments

### Changed

- `TIDY_BPM` is on: a red line keeps two decimals at most, one where that is within
  0.011 (180.19 → 180.2, 180.178 → 180.18), its middle beat held where it was.
- Three engine experiments, off by default, for the server to measure:
  - `OCTAVE_RULE`: a song under 130 BPM whose half beats carry at least 0.9 of the
    beats' attack weight is doubled (fast punk read at half); one over 160 BPM with
    under 0.3 is halved. Fitted on the tidy-bpm runs' evidence.
  - `PERCUSSIVE_INPUT`: the grid is fitted on the percussive part of the audio (HPSS),
    the drums without the sustained guitars and bass; Beat This! keeps the mix. The
    Rust engine reads it from a temporary WAV.
  - `CHANGE_POINTS`: a one-line song is followed beat by beat on its strongest attacks,
    and the beats found are split by optimal partitioning into steady stretches; a split
    stands only where the stretches differ by 0.4 % and fit the attacks 15 % better.
    On synthetic attacks it finds 178 → 174, 180 → 185 → 180 and 200 → 195 → 200 at
    the right BPM, and splits no steady song with 5, 10 or 15 ms of jitter (0 of 30).

### Measured

- tidy-bpm on the server (2026-10-28, 045aeac): tempo ok unchanged on every stage run
  (bands dev 51.1, held out 59.9; anime-variable dev 31.9, held out 21.5).
- The octave rule, on the per-map evidence of those runs: the precision path's first
  lines at the right octave +63 maps dev (1677), +44 held out (681). Not yet measured end
  to end.
- `PERCUSSIVE_INPUT` and `CHANGE_POINTS`: not measured on real maps yet.

### Rejected / tried and dropped

- **Shorter drift windows** (2026-10-28, anime-variable dev, tempo ok): base 31.9;
  48 beats 31.1, 32 beats 31.7, 32 with a looser guard 30.6, 16 looser 27.5; bands dev
  51.1 → 50.2 (32) and 46.1 (32 looser), held out 59.9 → 52.6 (32 looser). A window cuts
  where it ends, not where the tempo moves, and a looser guard invents changes.
- **Piecewise variants on the tracker path**: minimum 32 beats, bands dev 52.2 (octave
  87.6) but held out 57.7; with drift 32, dev 51.3.
- **OCTAVE_CONTINUITY**: changed no map on any stage; the octave mixes it was meant for
  were counted on the map's lines, not the engine's.

---

## v1.0.0-stable — 2026-10-28 · Fifteen-minute songs, and the memory to time them

### Changed

- **Songs up to 15 minutes** (`MAX_AUDIO_SECONDS` 900, was 600), and uploads up to
  95 MB (`MAX_UPLOAD_MB`, was 40; under the 100 MB a request may carry through
  Cloudflare).

### Fixed

- **`too_heavy` on songs of about nine minutes.** The worker's Beat This! sessions each
  kept an ONNX Runtime arena that grows by doubling, so the largest chunk's overshoot
  stayed held: an owner's song stopped at 1985 MB against `WORKER_MEMORY_MB`'s 1800.
  The worker now registers one shared CPU arena that grows by what a run asks for
  (`worker/timing_result.py`, `_shared_arena`). The engine's own loader is untouched.
  The edit changes the engine hash, so stored results are recomputed on their next
  upload.

### Measured

- Peak committed memory of one worker analysis on this machine (Windows, 4 ONNX
  threads, the vote on), minutes apart on the same build:

  | song | before | shared arena | arena off |
  |---|---|---|---|
  | 543 s | 2369 MB, 62 s | 1864 MB, 60 s | 1739 MB, 83 s |
  | 758 s | -- | 1943 MB, 83 s | 1818 MB |

  Same BPM, offset and red lines in every run. Per stage, the peak is Beat This!'s
  inference (`_beat_this_logits`, +1000 MB over the stage before it with the old
  arenas). Growth is about 22 MB a minute of audio, so 900 s lands near 2000 MB
  committed, below the 2369 MB of a 543 s song before, which is the size of song that
  failed on the server. Not measured there: its resident peak is the real check.
  Rejected: the arena off (35 % slower for 125 MB more).
- site/api, site/web, bot and the worker's tests as listed in the commit. Not run on
  the server's Linux worker yet: its first 15-minute song is the first real check.

---

## v1.0.0-stable — 2026-10-28 · Songs timed on the front page, visits on a profile

### Changed

- **Songs timed, ever and lately.** `GET /stats` adds `timed { total, last7Days,
  last30Days }`: done analyses the engine ran (the rows `totals.done` counts), by when
  they finished. A refusal, a failure, a cache hit and a deleted analysis are not one.
  The windows are rolling, so the pages say "last 7 days" and "last 30 days", not
  "this week" or "this month". The front page's live numbers show the three beside the
  queue (two to a row on a phone); `/stats` has them in their own row, with the
  site-wide count of profile visits.
- **Profile visits.** A public profile shows its visits, ever and over the last 30
  days, under the username. One visit is one visitor on one profile on one UTC day: the
  signed-in account, or the address when signed out, each kept only as an HMAC salted
  with the day. The page counts it with `POST /users/<name>/visit` once it has drawn
  the profile, so a link preview or a crawler (which never runs the page) counts
  nothing; the owner's own visit and a private profile count nothing, and a private
  profile shows no count, to its owner either.

### Hardening

- The visitor hashes are kept only for today and yesterday (`profile_visitors`, swept
  once a minute per process); after that only the per-day counts stay
  (`profile_visits`). Nothing links one day's visitor to the next. The POST takes the
  same-origin header and its own rate limit (120 per 10 minutes); a user agent that
  says it is a bot is not counted.
- `/stats` stays aggregate-only: its test now also allows only the new count fields.

### Measured

- site/api 217 tests (8 new: dedupe per day, the owner, a private profile, the
  same-origin header and a bot, no hash in the answers, the site-wide total, the 7- and
  30-day windows over backdated rows) and site/web 335, all passing; `pnpm --dir
  site/web budget` ok. Checked in the browser on a seeded memory store, in Spanish, at
  375 px and desktop, dark and light: the front page's numbers, `/stats`, and a profile
  whose count went up once and not on reload. Not run: the PostgreSQL queries and the
  schema's double apply (`pnpm --dir site/api check`), no database here.

---

## v1.0.0-stable — 2026-10-28 · The profile: edited on Overtone, the osu! card, and a sign-in that never strands

### Changed

- **The profile is edited here.** An About text (600 characters, cleaned, rendered as
  text), a shown name over Mides' one (empty falls back), four links (osu!, website,
  YouTube, Twitch; https only, each read to its own site and kept in one canonical form,
  rendered `rel="noopener nofollow ugc"`), an accent from a six-colour palette, and up to
  six pinned timings with reorder. Photo, banner and username stay Mides', refreshed at
  every sign-in; the editor says so and links to Mides' `/settings`. `PUT /me/profile`
  takes any of the fields, behind `requireSameOrigin`, its rate limit and
  `utils/profile.js`; both stores; new `accounts` columns in `schema.sql`.
- **The osu! card.** Linking reads rank, country rank, pp, accuracy, play count, country
  and ranked maps from the `/me` the identify scope already gets; "Refresh" reads
  `/users/{id}/osu` with the app's own client-credentials token (the link's token was
  never kept), at most once per five minutes per account and ten an hour per address.
  No page view asks osu! anything. Shown on `/profile` and, unless private, on
  `/u/<name>`. A linked account with ranked maps earns the new **Ranked mapper** badge.
- **More on a profile:** the BPM spread and single/variable split of the published
  timings (the `/stats` charts, now `components/StatsCharts.jsx`), the most used timing,
  badge dates (derived from the records, never stored), a paged public activity
  (`GET /users/<name>/activity`: published, used by others without naming them,
  confirmed on time as a mapper, reviews, accepted suggestions; nothing private or
  hidden), "Copy profile link", and Open Graph tags for `/u/<name>` written by
  `serve.mjs` from `GET /users/<name>/card` (asked without cookies, so a private profile
  gets none). Public collections stay on the page. The Discord username shows on the
  linked-accounts card when Mides sends one (it did not on 2026-10-28).
- **Sign-in.** A pre-flight reads where Mides' SSO start would send the browser, without
  following it: an app Mides does not know lands on Mides' own error page, so `/login`
  now says "Sign-in through Mides is not available right now" with the reason instead
  of sending anyone there. Mides' `#error=` returns are said in words on `/login`; a 403
  from the exchange is `MIDES_FORBIDDEN`. "Sign in" links come back to the page they
  were on.

### Fixed

- The Discord "Link on Mides" button sent people to `/connections/discord/link`, a page
  Mides does not have (its `App.jsx` routes): a 404 on another site. The path is now
  unset by default and the button appears only once it is configured; the bot's
  `/link` code covers it meanwhile.
- `/login/callback` read a Mides refusal (`#error=…` with no code) as "did not start in
  this browser". It now shows Mides' reason.
- The link fields were `type="url"`, so the browser refused `osu.ppy.sh/u/name` before
  the API, which reads it as https, saw it.

### Hardening

- The accent is a palette name, never a colour from the request; each colour is
  checked by `test/accents.test.js` at 4.5:1 on every surface of its theme, and its ink
  on it, with the surfaces read from `index.css`. High contrast keeps its own accent.
- The osu! avatar is not shown: `a.ppy.sh` stays out of `img-src`, since every visitor
  of a public profile would tell osu!'s host whose page they read, for a second photo
  when the Mides one is there.
- A pinned timing must be the account's own and published (else the 404 of a missing
  timing); one unpublished later drops out of the showcase when read.

### Measured

- site/api 208 tests and site/web 335 (with master's), all passing; `pnpm --dir site/web
  budget` ok after raising the language chunks (Polish reached 50.4 kB gzip of its 50,
  French 49.7, Russian 57.6 of 58; the profile adds about 4 kB per language) and the
  changelog's (16.2 kB of 16, with this entry). Checked by hand at
  375 px in Spanish, dark and light: the edit, a refused YouTube link, the saved
  profile in violet. Not checked: the osu! card and the charts with real data (no osu!
  app and no finished analysis in development), the pre-flight against the real Mides.

---

## v1.0.0-stable — 2026-10-28 · The notification panel

### Changed

- The bell opens a panel at the right edge of the bar: "Mark all as read" and "Delete
  read", All and Unread tabs, each notification with its kind's icon, a relative time
  (`Intl.RelativeTimeFormat`), an unread dot and its own read/unread and delete buttons,
  "See all" and an empty state. Arrow keys move between rows, Enter opens one, Delete
  removes it, Escape closes and gives the focus back to the bell. The panel is its own
  chunk, loaded the first time the bell opens.
- A click marks it read and lands where it happened: `/t/<id>` (a comment's anchor on it),
  `/analyze/<id>`, `/community?suggestion=<id>` (shown first even when the list's filter
  or paging would leave it out) or `/staff`.
- `/notifications` gains the same actions in bulk (tick some or the page), a filter by
  kind and numbered pages kept in the address.
- New API: `POST /me/notifications/unread`, `DELETE /me/notifications/<id>`,
  `DELETE /me/notifications?read=true`, `?kind=` on the list, and a `target` on every
  item. New kind `staff`: moderators hear of a report and of a vote's correction.
- Signed in, under 420 px the bar shows the mark without the wordmark, so the bell and
  the account fit beside the menu button.

### Fixed

- At 375 px on a touch screen the signed-in bar was 24 px wider than the screen (the
  bell's 44 px target was added to the row without taking anything away), pushing the
  menu button half off it.

### Hardening

- A notification's link is built by the API from a fixed shape and a checked id, and
  checked again by the page: always a path on this site, never a URL read from a row.
- Deleting is the 404 of a missing id for another account's; marking someone else's
  changes nothing. A bare `DELETE /me/notifications` is a 400: only `?read=true` empties
  anything. Deletes have their own rate limit (120 in ten minutes).
- The `staff` kind is widened in `schema.sql`'s one CHECK, not by a later DROP/ADD that a
  narrower earlier ADD would refuse on the next boot.

### Measured

- Not measured beyond the checks: no engine change. `site/api` 198/198, `site/web`
  331/331, `budget` ok, the axe spec for the bell's panel and `/notifications` 4/4 (dark
  and light).

### Rejected / tried and dropped

- A stored `target` column: every kind's payload already holds its ids, so the target is
  derived from them (old rows included); a row may carry `payload.target` when a kind
  cannot be derived, as the staff rows do.

---

## v1.0.0-stable — 2026-10-28 · The studio look: community and account pages

### Changed

- The community and account pages follow `docs/design.md` §11: `/community` (suggestions,
  reviews, changelog, moderation), `/recent`, `/history`, `/timers`, `/u/<name>`,
  `/c/<id>`, `/profile` with its tabs and linked accounts, `/login` and the two return
  pages, `/settings`, `/settings/tokens`, `/developers`, `/notifications`, the bell and
  `/staff`. Sentence-case headlines, a section header per section, lists as hairline rows
  instead of boxed cards, forms as the one panel, skeletons and empty states in place of
  the loader and grey boxes, and the icon set in place of `★`, `→`, `↗` and `×`.
- New shared pieces: `components/ui/PageHeader.jsx`, `components/ui/Tabs.jsx` (arrow keys,
  Home, End) and `components/ListControls.jsx` (search, BPM range, sort, "show more"); new
  icons in `Icon.jsx`.
- Colour meanings kept: a suggestion's state, a hidden item and an API method no longer
  borrow red, amber or the tempo green (`docs/design.md` §10).

### Fixed

- An avatar's initials carried an `aria-label` on a plain `div`, which ARIA does not
  allow there; they are now an image with that name, or hidden where the name is written
  beside them.

### Measured

- Not measured beyond the checks: no engine change. The bundle stays inside its budget
  (`scripts/budget.mjs`: ok).

## v1.0.0-stable — 2026-10-28 · The studio look: Analyze, the queue and the result pages

### Changed

- `/analyze`, `/queue`, the result page, `/t/:id` and `/compare` follow `docs/design.md`:
  sentence-case headlines, section headers, panels only for what is operated (the upload
  form, the tempo map, the tables, the export panel, Compare's two sides), hairlines
  elsewhere, readouts with units, skeletons and empty states instead of spinners.
- The result page is grouped into listen, check and export zones with jump links. The
  .osz is the page's one primary action; practice and the by-ear tools, and the .osz
  options with the beat-snap chart, are folded under one line each. Every feature, key
  and shortcut is where it was or one click away; the red lines table moved into Check.
- Controls drawn with characters (▶, ⟲, ✎, ⧉, ×, →, ↗, ▸, ▾, ★) use the icon set.

### Fixed

- Two e2e language tests still looked for the EN/ES toggle the ten-language selector
  replaced; they use the selector now.
- The progress bars on Analyze, the queue and a running result animated their width;
  they move by `scaleX`.

### Hardening

- axe also audits the result page with every fold open, a published timing page and a
  comparison, in both themes.

### Measured

- `site/web` 326/326; build and budget ok, the result chunk 30.1 kB gzip (its budget
  raised from 30 to 32 kB); e2e 82/82 in Chromium. No engine change, so no engine
  measurement.

---

## v1.0.0-stable — 2026-10-28 · The studio look: content and tool pages

### Changed

- The legal pages, credits, how it works, the FAQ, the glossary, statistics, status, the
  calculator, the microphone tool, the 404, the error page and the embed follow
  `docs/design.md` section 11: sentence-case headings, text at a 70ch measure inside the
  wide layout with a sticky contents list that marks the section in view, callouts
  instead of boxed notes, readouts on hairlines instead of tiles, icons instead of
  arrow characters. `components/ui/Doc.jsx` and `.prose` / `.doc-heading` / `.callout`
  carry the long-form layout.
- The pipeline on `/how-it-works` is an HTML signal chain (six, three or two across)
  instead of a fixed-width vertical SVG.
- The microphone tool's one button is Listen, Stop and Again in turn, so the keyboard's
  focus is never dropped mid-reading.

### Fixed

- Legal pages in Russian and Japanese gave every section the same empty anchor (only
  `a-z0-9` was kept): duplicate ids and React keys, contents links that went nowhere.
- The microphone's level meter was invisible: it used `bg-lavender`, which the `--tempo`
  rename left without a colour.
- The credits said no fonts are downloaded; the three self-hosted faces are listed now.

### Hardening

- axe covers `/tools/calculator` and `/tools/tap-mic` in both themes.

### Measured

- `site/web` 326/326 (314 before master's tip); the build and the budget ok. e2e 78/80 with axe clean on every public
  page in both themes; the two failures are the EN/ES toggle tests that predate the
  language selector and fail on master too.
- No sideways scroll and no console error on any of these pages at 375, 1024 and 1440 px,
  dark and light, in en, de, ja and ru (Playwright screenshots).

---

## v1.0.0-stable — 2026-10-28 · Clients for the API, a stream overlay, and a fingerprint study

### Changed

- `clients/js` and `clients/python` (W13.22): dependency-free clients for the token API,
  covering the token-scoped routes (upload and wait, your analyses and their exports,
  published timings), with typed errors carrying the API's codes, `Retry-After` honoured
  on 429, timeouts on every call, READMEs and examples, one of them a Discord-style
  webhook script. `/developers` has a Clients section.
- `/overlay/<id>` (W13.23): a transparent stream overlay of a published timing for OBS,
  with the BPM, the red line and a pulse on every beat. It cannot hear the stream and
  says so: it is started with Space/S or `?t0=<epoch ms>`, and nudged with the arrows.
  Linked from the result page's "Image and embed" panel. Ten languages.
- W13.21 is a study, `docs/19-fingerprint-study.md`, with `proto/fingerprint_study.py`:
  a Chromaprint-like chroma fingerprint. **Not shipped**; see Rejected.

### Hardening

- Only `/overlay/<id>` joins `/embed/<id>` as framable (`serve.mjs`, tested on look-alike
  paths), and only that path is see-through: the early script marks it before the first
  frame and the CSS clears the background under that class alone.
- The clients never print the token (not an enumerable field in JS, not in Python's
  `repr`), and wait out only a 429 that says how long; a quota 429 is thrown at once.

### Measured

- Fingerprint, 80 library songs (first 45 s) and 24 synthetic tracks, 10 variants each:
  every re-encode within BER 0.080 of its original (MP3 80-320 kbps, Vorbis, Opus,
  48 kHz, -6 dB, 0.3-1 s of silence added or cut); 0 false matches among 9,480
  real-song pairs at 0.30 (closest 0.321, one true duplicate aside); drum-only synthetic
  tracks collide (136 of 276 pairs under 0.30). 0.5-0.7 s of Python per audio minute,
  1.9 kB a minute, about 1 ms a pair with a ±5 s search (96 s for 100k timings unindexed).
- `clients/js` 13/13, `clients/python` 10/10 (both against the real API in memory);
  site/web 261/261 after the merge, site/api 174/174; `pnpm --dir site/web budget` ok
  (overlay chunk 0.67 kB); `bench/facts.py` ok, now counting the clients' tests.
- Not measured: the overlay inside OBS itself, the clients against production.

### Rejected / tried and dropped

- Shipping the "already timed?" hint now. The numbers separate re-encodes from other real
  songs, but the different-song tail was measured on 9.5k pairs where one live lookup at
  scale is 100k comparisons, drum-only audio cannot be told apart without a guard nobody
  has built, rate and pitch edits and other cuts were not measured, and it would need a
  bit-exact JS port, a table, an index and a route for a hint the SHA-1 lookup already
  covers for identical files. Next: 500+ songs on the owner's server, then decide.
- A 150-song run of the study: its output was buffered and it showed no progress for 25
  minutes, so it was stopped and the 80-song run above taken instead.
- Retrying the client's requests on 5xx in general: only the wait for an analysis polls
  through a passing 502/503/504; a single call fails at once, as an upload retried
  blindly could be counted twice.

---

## v1.0.0-stable — 2026-10-28 · W11.2: the oracle study, and no room for a router

### Changed

- `bench/oracle.py`: joins the per-map reports of several server stage runs (one per
  configuration) and reports each configuration, the per-song oracle, the gap, a
  bootstrap interval, the best pair and a one- or two-split router fitted on dev and read
  on held-out. A measurement, not a gate. Report in `docs/18-oracle-study.md`.

### Fixed

- `bench/remote.py` was a SyntaxError on Python 3.14: a literal line break inside the
  f-string that prints why a run was killed. Every remote command failed before it
  started.

### Measured

- Server, ranked and loved maps, code `239849c8`. Five configurations on the same first
  60 songs of each stage: 180 songs, 955 maps, 46 of them held-out songs.
  - The configurations: `rust`, `app`, `rust --beat-vote`, `python --beat-vote` (v3) and
    `python` (v3 without the vote).
  - Held out, best configuration alone against the per-song oracle: tempo ok 59.3 / 59.3,
    octave x1 92.8 / 92.8, beats within 10 ms 78.4 / 78.5 (gap 95 % interval
    0.0..0.1), red lines within 5 ms 24.1 / 24.1.
  - Dev gaps: +0.9, +0.9, +0.7 and +0.0.
  - In 121 of the 180 songs every configuration scores the same.
  - Far below the +5 points W11.3 needs.
- The local-tempo octave variants, the 2026-10-26 runs over whole S1 and S3: none, fold,
  fold + halve, and fold + halve + judge. Oracle gap held out +0.0 / +0.0 / +0.1 / +0.0;
  dev at most +0.2.
- The router fitted on dev ("rust where the voted and unvoted readings agree, else v3",
  712 rules tried; the depth-2 version tried 126,736) moves dev tempo ok 54.3 -> 55.2 and
  changes nothing held out.
- Cost: about 2.4 h of server time across the runs (rust and app over whole stages
  1305 + 2683 s; the four 60-song configurations 4583 s). Locally only a 7-song pilot.

### Rejected / tried and dropped

- Building the W11.3 router from today's configurations: they share one core (Rust and v3
  read alike, as `golden.py` pins), so they fail on the same songs. S2 held-out tempo ok
  is 0 % in all five. Their only real difference is the Beat This! vote, which trades
  beats for tempo and octave on S3 held out.
- A local oracle run with Beat This! alone and the forced tracker. One decode, fit and
  Beat This! pass per song was shared by every configuration; the memo checked out line
  for line against a plain v3 run on 3 songs. Stopped after 7 songs under the owner's
  2026-10-28 rule (heavy runs on the server only). Those two configurations need
  `EXPERIMENTS` entries before the server can measure them. The 7 songs are not reported.
- Measuring `song-octave` and `piecewise-cg` here. Another session cancelled the queued
  runs, and #31 changed both afterwards.

---

## v1.0.0-stable — 2026-10-28 · Votes on timings, a mapper's badge, a notification bell and a staff panel

### Changed

- A published timing takes one vote per account (W13.14): "on time", or "off" with an
  optional proposed BPM and offset. The page shows the counts and names nobody; a
  correction waits for staff, and the voter may tick a box to let the engine's stages
  use it as data (stored only).
- A mapper's "on time" (an account whose linked osu! profile had ranked maps) puts a
  "verified by a mapper" badge with their name on the timing and on `/recent` (W13.16).
- Timed comments are marks on the tempo map: hover or focus shows them, a click plays
  from there (W13.15).
- A bell in the navbar and `/notifications` (W13.17): suggestion states, comments, a
  first use, votes and analyses that ended unseen. Polled once a minute while the tab
  is visible.
- `/staff` (W13.19): the queue and the worker (with its memory, which the worker now
  sends with each claim on Linux), the week's failures with their codes, open reports,
  the corrections queue, the whole moderation log and what waits for review. A 404 for
  everyone else, in the page and the API.
- A refusal for the daily quota, the stored-results cap or the pending cap says why
  and when it frees up, with a live countdown to 00:00 UTC (W13.20).

### Hardening

- Votes are anonymous except a verifying mapper's; a vote's notification never names
  its voter. A comment's notification carries who and where, not the text. Every new
  write has the same-origin guard and a per-address limit (30 votes in ten minutes);
  another account's notification ids mark nothing.

### Measured

- site/api 189/189 (15 new), site/web 247/247 (7 new) on the branch; 191 and 321 after merging master; `budget` ok (Staff 3.3 kB,
  Notifications 1.2 kB), 3 new worker tests run alone, `facts: ok`. In the browser at
  375 px: the marks and their note, a vote with a correction, the bell, `/staff` (as
  staff, and the 404 as a member), and both limit notices; ES and EN, dark and light.
  Not measured: the PostgreSQL store (only the memory one ran), the worker's memory
  report from a real Linux worker.

---

## v1.0.0-stable — 2026-10-28 · The studio look: foundation and front page

### Changed

- The site follows a written design direction, `docs/design.md`: a studio monitor, not a
  dashboard. Neutral cool ink instead of violet graphite, the logo's cyan as the one
  accent, colour only as signal, and the waveform with red lines as the signature.
- The tempo colour is green and its token `--tempo` (it was `--lavender`), everywhere the
  site paints it: the map, the table, the chips, the stats, the map image.
- Type is Archivo (wide, for headings), Geist (text) and Geist Mono (every number),
  self-hosted from pinned packages; it was the visitor's system faces.
- The old classes (`btn-primary`, `btn-ghost`, `tool-btn`, `field`, `panel`, `label`,
  `readout`, `chip-*`) take the new look in place, so every page changed without its
  markup; the new primitives and `components/ui/` are there for the pages' own rework.
- The bar is one slim row; below 1024 px a sheet menu holds the places, the palette and
  the sign-in. The ticker stands still and scrolls away. The footer and the front page
  lose their boxes: sections are separated by space and hairlines.
- The front page: an asymmetric hero with the example strip as the product shot, the
  benefits as a spec sheet, the steps on one ruler, entrances staggered on scroll.

### Fixed

- The focus ring set `border-radius: 4px` on whatever it focused, squaring round
  controls (the avatar) while focused; the outline now follows each element's rounding.
- The tray's progress bar animated its width (a layout change every frame); it moves by
  transform now.

### Hardening

- `test/design.test.js`: the design file's colour table must equal `index.css`'s tokens,
  and every `var(--…)` the source names must be declared (a stale `--lavender` would fail).
- Text fields have an edge at 3:1 on their panels (`--line-control`, WCAG 1.4.11); the
  light signal colours read 4.6:1 or more on their own chip tints, red and tempo included.
- External links in the footer and on the front page say, to a screen reader, that they
  open a new tab; the `theme-color` meta follows the site's theme switch.

### Measured

- Contrast from the tokens: every text token 4.65:1 or more on every surface in dark and
  4.76 in light (dim on the wells the lowest); high contrast 7.18 and 7.28. Colour-blind
  separation: default light 3.7, dark 11.5 ΔE; colour-blind palette 32.6 and 42.2.
- axe-core on every public page, the palette, a result page and the signed-in pages, dark
  and light: 50/50 clean.
- Fonts: 142,632 bytes of Latin woff2 for the three faces (Archivo 90,104, Geist 29,400,
  Geist Mono 23,128), loaded by `unicode-range` as text needs them. Build against master:
  CSS 52.7 → 66.1 kB (10.1 → 13.0 kB gzip), entry JS 390.7 → 397.9 kB (125.2 → 127.9
  kB gzip); initial JS 163.8 kB gzip of the 200 kB budget.
- At 1024 px the seven places need 383-563 px across the ten languages, against 566-593
  free; below 1024 they do not fit, hence the sheet there.
- site/web 258/258 (2 new), site/api 174/174; the build is clean.

### Rejected / tried and dropped

- The draft's 7/5 hero split: the strip's four readouts were cramped and it read small.
- The sheet below 768 px as drafted: between 768 and 1023 px the places would have
  scrolled inside the bar with nothing to show it.
- A ticker that keeps scrolling: the only perpetual motion the rules allow is the hero's
  playhead.
- Holding entering content at opacity 0 by CSS alone: a page without its script, a
  thumbnail or a print would show nothing. `Reveal` holds back only what starts below the
  fold, and only once its script runs.

---

## v1.0.0-stable — 2026-10-28 · The timing editor in the browser

### Changed

- **W7, W12.17:** the result page's tempo map has an Edit mode. Red lines drag (snapped
  to the attacks or the beats, Alt free), move by 1 or 10 ms on the arrow keys, are
  added at the playhead or by double-click, deleted, retimed and re-barred by typing;
  sections split at the playhead, merge, double and halve, refitted to their attacks as
  the desktop app did. Undo and redo (Ctrl+Z, Ctrl+Shift+Z) with the history in view,
  every step spoken to a screen reader. The edits feed the clicks, the copy, the .osz
  and every export as the nudge does, marked `Edited`; the engine's reading stays as it
  came. Kept per analysis in the browser and, for the owner, as a saved version.
- The offset lab, the desktop's: the MP3's gapless delay read in the browser, and the
  blind click-shift test with Wilson intervals, its answer applied as the nudge.
- `POST /analyses/:id/versions` takes `lines` (up to 512 packed red lines);
  `analysis_versions` gains `lines` and `lines_key`, and its uniqueness moves to
  (factor, nudge, lines key). Ten languages.

### Hardening

- The saved lines are checked line by line (numbers only, BPM 1-5000, meter 1-16,
  sorted at least 1 ms apart, at most 512); a body with lines that do not read is
  refused, never saved without them. Only that route's JSON limit rises, to 48 kB.

### Measured

- The JS editor against the desktop's Python helpers on 16 fixed cases
  (`site/web/test/fixtures/editor-golden.json`): every red line within 1e-6 ms and
  BPM, every refit share within 1e-9, the same refusals. The engine is not touched: no
  gate or benchmark run concerns it.
- After merging `master`, the result page went to 31.4 kB gzip (budget 30): the editor
  and its offset lab now load on their own (`TimingEditor` 5.1 kB). With the listening
  lanes merged too, the page is 28.9 kB and the Russian file 52.6 kB (budget 58).

### Rejected / tried and dropped

- Baking the ×2 and the nudge into the edits on the first edit: it would have turned a
  saved factor-and-nudge version into lines and made the ×2 unpressable after an edit.
  The edits are kept before both instead.
- The desktop's decoder comparison (Python's first attack against Rust's): the browser
  has neither engine, and the server never sees the audio again.

---

## v1.0.0-stable — 2026-10-28 · Bands, a spectrogram, practice mode, a microphone BPM and the cover's colour

### Changed

- The tempo map has two optional lanes under the waveform, both read from the reader's
  own decoded song in a Web Worker: the attacks of three frequency bands (low, mid,
  high; on by default) and a spectrogram at the map's zoom (off by default) (W13.6,
  W13.7). Chosen once per browser.
- Practice mode under the transport: the drawn loop or the section under the playhead,
  3 to 8 times from 0.5× to 1×, after a bar counted in (W13.8).
- `/tools/tap-mic`: the browser listens for 6 to 15 seconds and proposes a BPM with its
  confidence and its octave neighbours, or says it heard no pulse (W13.12). Nothing is
  uploaded; the microphone is asked for only on the button.
- The cover in the song's tags tints the header of the result and public timing pages,
  kept at AA, and not under high contrast (W13.24).

### Hardening

- The microphone's worklet is emitted as its own file (`?url&no-inline`): Vite would
  have inlined it as a data: URL, which the site's `script-src 'self'` refuses.
- The cover is decoded with `createImageBitmap`, not loaded from a blob: URL that
  `img-src` does not allow.

### Measured

- Six minutes of stereo 44.1 kHz (`node site/web/scripts/spectral-cost.mjs`): bands and
  spectrogram 1.30 s in one pass (2.6 s before two-frame FFTs, `sqrt` for `hypot` and
  compressing only the bins a band reads), downmix 135-218 ms in slices. In the browser
  (dev build): 2.42 s in the worker, 2.65 s end to end, the page's longest stall 27 ms.
- Node tests: site/web 258/258 (18 new, on synthetic drums, clicks, noise, silence and
  covers); the budget passes; `bench/facts.py` ok. Not measured: a real microphone, a
  phone, Safari and Firefox; no screenshot (the shared browser pane was hidden).

### Rejected / tried and dropped

- A filter bank in an OfflineAudioContext for the bands: three renders of the song
  where one STFT gives the bands and the spectrogram together.
- Log compression of raw FFT magnitudes: a kick's spectral splatter lit the high band at
  20 % of a hat. Magnitudes are now scaled by 2/N first, and the picker's floor is a
  fifth of the band's loud end, not a tenth: each band then reports only its own
  instrument on the synthetic drums.
- The plain autocorrelation peak for the microphone: a click train at 128 BPM read as
  64, its period falling between two frames. The envelope is smoothed, each candidate
  refined to a twentieth of a frame, and the faster octave wins when it scores 80 % of
  the slower.

---

## v1.0.0-stable — 2026-10-28 · A timing calculator, DAW tempo maps and four more games

### Changed

- `/tools/calculator` (W13.9): BPM ↔ ms, ms ↔ ticks, the gap between two red lines,
  drift and the BPMs within an accepted drift, and the BPM from two timestamps. Keyboard
  first; the result page opens it with its first red line filled in.
- "More downloads" gains a MIDI tempo map (type 1, 960 PPQ) and a Reaper project (W13.10).
  Ableton gets no file of its own: Live has no tempo-map text format, so the page sends
  its users to the MIDI file and says so.
- Four more games' timing files (W13.11): Beat Saber v3 `bpmEvents`, A Dance of Fire and
  Ice `.adofai`, Friday Night Funkin' legacy chart JSON, Rhythm Doctor `.rdlevel`.

### Measured

- MIDI read back by an independent parser in the tests: every red line within 0.5 ms of
  its time on 40 changes off the grid (the worst is printed on the page; 0.08 ms on the
  browser check's two-line result). The games' files read back by each game's arithmetic,
  all under 0.5 ms. `site/web` tests 264/264 on the branch (240 before), 280/280 after merging master, budget ok (AnalysisResult
  24.6 of 30 kB, Calculator 2.5 kB). No file was opened in a game or a DAW.

### Rejected / tried and dropped

- ADOFAI changes off the beat by an angled tile (a fractional beat): exact, but which way
  an angle counts is easy to get backwards untested, and a wrong guess would be silent.
  An odd tile with its own speed is visible in the editor and right either way.
- Fitting the whole span's BPM so a change lands on a whole tile or section (as Clone Hero
  does between ticks): over a long span it moves the grid by up to half a beat against the
  music before the change; the odd unit keeps the grid exact everywhere else.

---

## v1.0.0-stable — 2026-10-28 · Mapping helpers on the result page

### Changed

- The `.osz` can carry more than the Timing difficulty (W13.1, W13.5): the game mode
  (osu!, taiko, catch, mania with 4K-10K as `CircleSize`), empty Easy-to-Expert
  difficulties with the same timing, and a playable "Overtone test (1/1)" or "(1/2)":
  a circle on every beat or half beat, a combo and a finish on the bar's first beat, a
  whistle on the half beats, so a mapper plays the timing and feels whether it is off.
  All off until asked for: by default the `.osz` is still one Timing difficulty.
- The result page shows where the attacks fall (W13.3): per red line and for the song,
  the share on 1/1, 1/2, 1/3, 1/4, 1/6, 1/8 or none, and the suggested divisor, which the
  `.osz` writes as `BeatDivisor` (on by default; it only sets the editor's snapping).
- Long silences can go into the `.osz` as breaks (W13.4, off by default), inside osu!'s
  gaps and minimum.
- Patching your own `.osu` can also snap its hit objects to the new grid (W13.2, off by
  default, 1/1 to 1/16): only the moved times change, spinners' and holds' ends with
  them; the page says how many moved and by how much.

### Hardening

- The snap rewrites only the numbers it moves, row by row; the rest of the file keeps
  its bytes (a test diffs everything before `[HitObjects]` against the plain patch).
- A divisor osu! does not offer is no snap at all; a mode or divisor out of range falls
  back to osu!'s defaults; the test map is capped at 20 000 objects.

### Measured

- site/web 256/256 (16 new: `test/mapping.test.js`, and the snap and the set in
  `osu-patch.test.js` and `osz.test.js`); `pnpm --dir site/web budget` ok (the new
  `mapping` chunk 1.75 kB); `bench/facts.py` ok.
- Driven with Playwright at 375 px, EN and ES, dark and light, against the e2e fake
  worker: the `.osz` read back with five entries, and a `.osu` snapped at 1/4.
- Not measured: whether the suggested divisor and breaks agree with what mappers chose on
  ranked maps (Corpus B could say), and none of it was opened in osu!.

### Rejected / tried and dropped

- **Keeping a slider's length in ms when the beat changes.** It would mean rewriting its
  pixel length, which changes its shape on the playfield. Kept in beats instead: osu!
  works the end out from the beat, so a slider that starts on the grid ends on it.
- **Breaks from every 1.3 s pause**, osu!'s own minimum gap. Too many for a suggestion: a
  pause that short is a rest a mapper maps around. Ours start at 5 s of silence.

---

## v1.0.0-stable — 2026-10-28 · Long songs no longer fail for memory they did not use

### Fixed

- A song on the staging site failed with `too_heavy` inside Beat This!'s Softmax. The
  worker capped the analysis child's **address space** (`RLIMIT_AS`, 1800 MB), and ONNX
  Runtime, numba and the thread pools reserve far more address space than they touch,
  so an allocation hit the cap while the real use was well below it (W2.4 measured
  ~1.2 GB resident for a 10-minute song with the vote). The worker now reads the
  child's **resident** memory from /proc every 0.5 s and stops it past
  `WORKER_MEMORY_MB`, with how much it used in the message; the container's OOM killer
  stays the backstop.
- The result page said a stopped job's file "may be damaged". A job stopped for memory
  or time now says so, in all ten languages.

### Measured

- `tests/test_worker.py` `IsolationTests` 7/7 locally (the new over-the-limit test runs
  only where /proc exists, so it was skipped on Windows); site/web 240/240. Not
  measured: the failing song itself (it never reached this machine) and the server run.

---

## v1.0.0-stable — 2026-10-28 · The site in ten languages, chosen by flag

### Changed

- The navbar's EN/ES toggle is a language selector: a button with the current flag and
  code opens a listbox of ten languages, each by its own name (W12.16). French and German
  are new; Italian, Polish, Brazilian Portuguese, Japanese, Korean and Russian, translated
  on their own branches, are moved onto the selector's keys.
- English and Spanish stay in the main bundle; the other eight are found by file name
  (`src/locales/<code>.json`) and fetched on first use. A first visit follows the
  browser's languages; only a visitor's own choice is stored in `mides.lang`.
- `/settings` lists the ten with their flags; the command palette has one action per
  language. The legal pages say, in every language but English, that the English
  version prevails.
- The privacy page no longer says `mides.lang` holds "English or Spanish".

### Hardening

- `test/i18n.test.js` checks all ten files: keys within English's, placeholders and the
  legal pages' `[[...]]` marks equal, plural forms by language, no empty string, and 100 %
  coverage for es, fr, de and any file that has begun. It also holds the list, the locale
  files, the flags and `index.html`'s early script to the same ten codes.
- The app waits for the starting language's strings before its first frame, showing the
  loader's beats, so a French visitor never sees English flash.

### Measured

- Coverage on 2026-10-28: all ten at 100 % of `en.json` (1,583 strings).
- Build: `fr` 116.4 kB and `de` 109.2 kB as their own chunks (39.0 and 38.5 kB gzip),
  outside the main bundle.
- Navbar places at 1024 px before the spacing change: fr 608 of 586 px, pl 593 of 586,
  ru 645 of 611 (overflowing); after: all ten fit (fr 580, ru 617 of their boxes).
- site/web: 238 tests pass; the build is clean.

### Rejected / tried and dropped

- Emoji flags: Windows renders none. Image files: ten more requests for 18 px.
- Storing the detected language: it would pin a visitor to the browser's language of
  their first visit.

---

## v1.0.0-stable — 2026-10-28 · One branch: master

### Changed

- `master` is the only long-lived branch (owner's decision). Everything that was on
  `experimental` and the language branches is in it; `experimental` and the `parked/`
  branches are deleted. The parked desktop app stays reachable through the tags
  `v3-desktop-app` and `v3-desktop-full`.
- `deploy.yml` deploys on a push to `master`, and `deploy/overtone-update.sh` follows
  `master` by default. A server checkout still on `experimental`, clean and contained
  in `master`, moves to `master` once by itself, so the VPS needs no hand-run step.
- CONTRIBUTING, CLAUDE.md, docs/server.md and docs/deploy.md describe the one-branch flow.

### Measured

- `DeployScriptTests`: 6/6, one new (the move from experimental to master).

---

## v1.0.0-stable — 2026-10-27 · W10: budgets, accessibility, end-to-end tests and the review routine

### Changed

- **Every page but home and the 404 is its own chunk** (`React.lazy`), and the Spanish
  strings load only for a Spanish visitor (a lazy i18next backend; `main.jsx` waits for
  the stored language, so nothing flashes half-translated).
- **`deploy/web/serve.mjs` compresses** text files of 1 kB or more, brotli (q 11) or
  gzip (9) by `Accept-Encoding`, once per file version, in a 128-entry LRU, with `Vary`.
- **The page area is at least a screen tall**, so the footer starts below the fold: on
  a short page (404, sign-in) it is one scroll away.
- Light theme only: `--accent` `#0a737f` → `#076672`, `--amber` `#8f5e08` → `#835606`;
  links inside a `p` or `dd` are underlined. Nothing else restyled.
- New one-line checks: `pnpm --dir site/web budget` (gate) and `pnpm --dir site/e2e test`
  (gate, 76 tests); `pnpm --dir site/e2e vitals` (measurement). New dev dependencies,
  pinned: `@playwright/test` 1.64.0 and `@axe-core/playwright` 4.13.0 (`site/e2e`, not
  shipped).
- `docs/security-review.md` (W10.7) and three project skills in `.claude/skills/`
  (W10.5): `site-ui-check` (with `site/e2e/screens.mjs`), `release-checklist`,
  `security-review`.

### Fixed

- Accessibility (axe-core, WCAG 2.2 AA tags): contrast of accent and amber on their own
  tints in light (4.15-4.45:1 → 4.6-5:1); links told from their sentence by colour only;
  `/status`'s `dl` with its `dt` nested in a `div`; the merged `/developers` page's
  inline link. Three progress bars got names; the tempo map's canvas names the red-lines
  table, its text alternative, in `aria-describedby`.
- Layout shifts: pages that fill in after a request pushed a visible footer (CLS
  0.19-1.0 on a phone).

### Measured

- **Initial JS, gzip** (`scripts/budget.mjs`): 181.5 → 143.3 kB with the split, before
  the merges. After merging experimental (first time): 235.7 kB for experimental as it
  was (every page eager) → 148.8 kB here. After the second merge and `master`: 276.4 →
  162.3 kB. Budget 200 kB; on-demand chunks each under their own budget (12 kB default;
  result page 30, changelog 16, shared result player 20, upload form 20, API reference
  24, Spanish 36).
- **axe:** before, 46 nodes in 19 of 32 audits (color-contrast 22, link-in-text-block 16,
  definition-list 2, dlitem 6); after, 0 in every audit: 22 pages, a result page running
  and done, the palette open, profile and history signed in, each in dark and light.
- **e2e:** `pnpm --dir site/e2e test` 76/76 in 3.7 min.
- **LCP and CLS** (`vitals.mjs`: the build behind `serve.mjs`, Lighthouse's mobile
  profile, 150 ms, 1.6 Mbit/s, CPU x4, median of 3, service worker blocked):
  - experimental at the first merge (one bundle, no compression): LCP 5.0-5.9 s on
    every page; CLS 0.561 on `/credits` and a result page;
  - this branch then: LCP 1.9-2.8 s (home 1.92 s, a result page 2.76 s), CLS
    0.000-0.024 after the footer fix;
  - after merging `master` (the new front page, analysis options, PWA): LCP home 2.85 s,
    `/analyze` 4.18 s, `/queue` 2.93 s, a result page 3.27 s, the others 2.16-2.48 s;
    CLS 0.000-0.024. Over 2.5 s on four pages: what the merged features add to the first
    paint was not investigated here.
- site/api 174/174 (1 new), site/web 235/235 (2 new), `bench/facts.py` ok. The Python
  suite, the benchmark and the gates were not run (owner's rule: they run on the server;
  no engine code changed).

### Rejected / tried and dropped

- **A screen-tall loader instead of a screen-tall page.** It fixed the lazy chunks' shift
  (`/terms` 0.561 → 0) but not the pages that fill in after their own request (`/queue`
  0.364, a result page 1.016): the footer moved each time.
- **Counting e2e tests in `bench/facts.py`.** The specs make tests in loops, so counting
  `test(` calls would be wrong; the run prints its own count.

---

## v1.0.0-stable — 2026-10-27 · Releases carry executables, built in one line

### Changed

- `scripts/release.py <version>` builds a release's assets into `dist/release/<version>/`:
  the Rust engine's `overtone-cli-<version>-windows-x64.exe`; the Python engine's
  command line frozen by PyInstaller into `overtone-engine-<version>-windows-x64.zip`
  (`overtone.exe` with the Beat This! model, so the vote works offline and no Python is
  needed); the site for self-hosting in `overtone-site-<version>.zip` (built web, the
  API's tracked source, `serve.mjs`, a README); `SHA256SUMS.txt`; and `notes.md`, the
  "Changed" bullets of every timeline entry since the previous release tag.
  `--publish` tags `v<version>`, pushes the tag and runs `gh release create`, as a
  prerelease for `alpha`, `beta` and `rc`. docs/release.md is the routine.
- One version everywhere: the script refuses to build unless Cargo.toml's workspace
  version (which the Python engine's `app_version()` reads), the crates' path pins,
  Cargo.lock and both site packages agree. `scripts/release.py bump <version>` sets
  them all; the site's packages, still at 0.1.0, were aligned to 0.2.0-alpha with it.
- PyInstaller is pinned in `scripts/requirements-release.txt`, apart from the
  engine's requirements; the script refuses a venv that differs from the pins.

### Hardening

- `--publish` refuses a dirty tree, any branch but `master`, an existing tag and notes
  over GitHub's 125,000 characters, before anything is built.
- The frozen engine is smoke-tested before it is zipped: one run in a scratch profile
  with PATH holding only Windows' folders, on the benchmark's `change-128-142` case. It
  must print exactly two red lines within 0.05 BPM under a `v<version>` header, and the
  run is checked for writes into its own folder.
- The site ZIP takes the API from `git ls-files`, so neither `node_modules` nor a real
  `.env` can ride along; a Git LFS pointer in place of the model stops the build.

### Measured

- 2026-10-27, this machine, version 0.2.0-alpha, `--since v0.2.0-alpha`: CLI 5.01 MB,
  engine ZIP 198.70 MB (594 files, 397.7 MB unpacked), site ZIP 0.45 MB (80 files);
  `sha256sum -c` passes on all three.
- Smoke: `overtone.exe` read `400,468.750000973913` and `30400,422.535211267606`, that is
  128.000 and 142.000 BPM, in 23.3 s and 23.7 s on two builds; no writes into its folder.
- Build times, cold then warm: cargo 84.2 s / 0.2 s, PyInstaller 98.2 s / 62.8 s, site
  build 1.8 s / 1.5 s; the warm run took 113.6 s end to end. Notes: 94 entries since
  v0.2.0-alpha, 63,586 characters.
- Not measured: the executables on a clean Windows without Python or the Visual C++
  runtime; any Linux or macOS build (none exists); the Rust executable is built, not
  smoke-tested.

### Rejected / tried and dropped

- A release workflow in GitHub Actions: CLAUDE.md keeps Actions to deploying, and a
  check a person cannot run in one line does not exist.
- Bundling the model into `_internal` as the desktop spec did: the engine now reads its
  data one folder above its code, which frozen is the folder holding `overtone.exe`, so
  the model and a one-line version file go there instead and the engine's code is left
  as it is.
- The site's API with its `node_modules` (`pnpm deploy --prod`): the asset is source for
  self-hosting, and a native module built here would not match the host it lands on.

---

## v1.0.0-stable — 2026-10-27 · API tokens, versions, whole batches, images, the app and copied rows

### Changed

- A public API with personal tokens (W12.20): `/settings/tokens` (linked from
  `/settings` and the profile) makes, lists and revokes them; the secret is shown once
  and kept as a SHA-256. Three scopes: `read:analyses`, `upload`, `read:timings`. A
  token reaches an allow-list of `/api/v1` reads and the upload, each under its scope,
  with its own rate limit (120 a minute, and every route's own limit counted per
  token). `/developers` explains it and renders `site/api/docs/openapi.yaml`.
- Versions of a timing (W12.21): the owner's re-analyses of the same audio and the
  adjustments saved on them (factor and nudge only, never a copy of the result), on the
  result page, with Apply and the difference per red line between any two.
- Whole batches (W12.22): one ×2 / ÷2 and nudge for every song of the Analyze page's
  batch, and every song's `.osz` in one zip, built one song at a time.
- The tempo map as PNG and SVG, and `/embed/<id>` for a published timing (W12.18).
  `deploy/web/serve.mjs` lets that path, and only that path, be framed.
- An installable app (W12.23): `public/sw.js` keeps the shell and the visitor's own
  final results for offline reading, and the manifest's share target sends an audio
  file shared from a phone to the Analyze page.
- Copy one red line, or ticked rows (Shift-click for a stretch), as `[TimingPoints]`
  rows ready to paste (W12.24), written with the export options as the whole block is.
- Decided: a token request drops its cookies and never falls back to them, skips the
  same-origin header (an `Authorization` header is not ambient: no other site can make
  a browser send it) and is refused everywhere outside its allow-list. No CORS: tokens
  are for scripts and servers, not other sites' pages.
- Decided: the API reference is rendered by a YAML reader of our own at build time,
  not Swagger UI (about a megabyte for one page) or a YAML package; it throws on any
  YAML it does not read, so nothing is misread into the page.
- Decided: the tokens stay on their own sub-page of `/settings`, not a section of it:
  the settings are this browser's and need no account, tokens are an account's.
- Decided: a batch's `.osz` zip is capped at 1 GiB of audio (inside a zip without
  zip64 and a phone's patience), said before it starts.
- Decided: the worker caches only `GET /analyses/<id>` once final, never public
  timings (they can be unpublished), lists, the account, tokens or audio, and the copies
  go on sign-out.

### Fixed

- Publishing from the result page called a setter the page no longer had, so a
  published timing showed "could not publish". Experimental fixed the same bug with
  `tracker.patch`; this branch's fix was dropped in the merge in favour of it.
- Two flow descriptions in `openapi.yaml` held an unquoted comma, which YAML reads as a
  second key: both are quoted. The new reader refuses that construct.

### Hardening

- `requireSameOrigin` passes a token request only because its cookies are already gone;
  tests send a token beside another account's session cookie, a broken Bearer beside a
  valid cookie, and token requests to publish, delete, save a version, mint a token,
  post a suggestion and sign out: every one is a 401 or 403 and nothing changes.
- A test holds the document's `x-token-scope` marks equal to the allow-list.
- `/embed/<id>` has `frame-ancestors *` and no `X-Frame-Options`; look-alike paths keep
  `'none'` and `DENY` (tested). The card has nothing to click but its link.

### Measured

- Not measured: nothing here touches the engine. `site/api` 173/173, `site/web` 233/233 (after merging experimental),
  `vite build`. The `/developers` chunk is 59 kB (13 kB gzip). A two-song batch's `.osz`
  zip was 10.6 MB; a two-line PNG 2800×748, 90 kB.

### Rejected / tried and dropped

- Swagger UI and a YAML dependency for `/developers` (above).
- Answering CORS preflights for token requests: it would weaken the reasoning the
  same-origin guard rests on, for a use (another site's page holding a token) that
  should not exist.
- A section of `/settings` holding the whole tokens UI (above).

---

## v1.0.0-stable — 2026-10-27 · Analysis modes, hints, a stretch, re-analysis and the queue's estimate

### Changed

- **Modes (W11.1).** Each job runs in a mode the person picks by how long they want to
  wait. `fast`: no Beat This! vote and no octave judges (each judge reads "no answer"
  as "keep the engine's octave"). `normal`: the call the worker always made, untouched.
  `strict`: `normal` for now (see Rejected). The worker announces one engine hash per
  mode, the result says its mode (`timing-result v1.2`), and the API keys every cache
  lookup by mode and hints: the same audio asked another way is another result.
- **Hints (W3.21)** touch the engine only where it has a real knob. An expected tempo
  outside 120-240 moves `MAP_OCTAVE_RANGE`, the engine's own octave preference, for that
  job (restored after); a meter fills only the bars the engine could not prove, where
  its fallback was a guess. "One BPM" / "it changes" have no honest knob and only flag
  the result. Every hint is compared with the result (`hint_checks`): a hint the audio
  contradicts is said on the page, never folded silently into the timing.
- **A stretch (W12.19)** is cut by the worker out of the engine's own decode, analysed
  alone and shifted back into the song's timeline; the page says what it covered.
- **Re-analysis (W3.24)** from the result page, with the file the browser holds or one
  picked again and checked by SHA-1; the two results are linked (`reanalysis_of`) and
  each links to `/compare?a=&b=`.
- **The queue's estimate (W3.16):** each live row says "done in ≈ a – b", from W2.4's
  cost per audio minute and mode, one worker assumed, "at least" behind a job of unknown
  length.

### Hardening

- Options are validated on the API (known keys only, bounds, 512 bytes in the header)
  before the upload's body is read; a re-analysis of someone else's analysis is the 404
  of one that does not exist, and of other audio a 400 `NOT_SAME_AUDIO`.
- A stored result's mode and hints are taken from the result, not from the request: a
  worker from before modes cannot file a normal result under `fast`.

### Measured

- `long-6min` of the benchmark, one fresh process per run, four threads, on this PC
  while other sessions loaded it: **fast 7.2 s and 14.3 s, normal 94.5 s and 82.3 s**
  (engine and model load apart: 5-13 s), the same reading (186 BPM, one red line).
  In the dev stack, a 60 s click track: fast on a 40 s stretch 5.7 s, normal on the
  whole 61.4 s.
- The default path is pinned by construction, not by a local gate run (the owner's
  rule: no suite or gates on this PC): `DefaultModeTests` checks the exact
  `analyze_audio` call, the octave window and the judges for the default mode. The
  suite and the gates run on the server after merging.
- `strict` candidates: not measured. A first local pass ran without the Beat This!
  model (the worktree held its Git LFS pointer), so its numbers are void and not
  recorded.

### Rejected / tried and dropped

- **Trimming in the browser** (W12.19's first idea): the browser's decoder is not the
  engine's (an MP3's encoder delay would shift every time), a WAV of the stretch changes
  the SHA-1 the cache and re-analysis rely on, and can pass the upload cap. The worker
  cuts instead; the whole file is uploaded.
- **Hints as constraints** (`min_delta` high for "one BPM", `force_subdivision` for a
  tempo): the first hides a real change behind the hint, the second skips the osu!
  conventions, the vote and drift following. Left for W11.5, which measures first.
- **Turning on PIECEWISE_GRID, CONSTANT_GRID or SONG_OCTAVE_BEAT_THIS for strict:**
  each is "off until measured on the server" and has no held-out number; strict stays
  normal until W11.3/W11.4.

---

## v1.0.0-stable — 2026-10-27 · A front page that answers why

### Changed

- `/` is a landing page (W12.25, the owner's request): what a mapper gains, how it
  works in three steps, recently timed songs, live numbers from `GET /stats`, who
  makes Overtone, five questions and a closing call, in EN and ES. Every claim is
  one the site keeps today (`docs/site.md`, "The front page").
- The example strip on it has four red lines (174, 186, a passage in 3/4, 160) and
  plays them: a playhead crosses in real time and the BPM, offset, meter, confidence
  and `[TimingPoints]` row follow the line under it (the owner's request). The data
  is osu! timing: whole-ms offsets on downbeats, `beatLength = 60000 / BPM`.

### Hardening

- The strip runs only on screen and in a visible tab, and with reduced motion (the
  system's or the site setting) steps a line every 4 s instead of sweeping.
- The live numbers hide on any failure of `/stats`, and while nothing has been
  analysed: they are colour, never an error.

### Measured

- Not measured: the page's load time and the strip's frame cost. The strip renders
  React only on a line change (four times a 13 s loop) and moves one SVG transform
  per frame.

### Rejected / tried and dropped

- Guessing the `/stats` shape before it existed: the first version read several
  likely field names. Once W12.13 landed it reads exactly `totals.done` and
  `queue.queued + queue.running`, so a renamed field shows as a hidden block, not a
  wrong number.
- Showing "0 analyses done" on a fresh site: dropped, the block waits for the first.

---

## v1.0.0-stable — 2026-10-27 · Linked accounts and the Discord bot (W9)

### Changed

- An account links Discord (W9.1) and osu! (W9.2) from its profile, and a Discord
  bot (`bot/`, discord.js 14.27.0) times songs and reads timings through a new
  `/api/internal/bot` (W9.3-W9.5): `/time-song`, `/timing`, `/queue`, `/compare`,
  `/recent`, `/link`, `/notify`. DMs when an analysis ends, opt-in (W9.4).
  Everything is off until its secrets exist, and says so. `docs/bot.md`.
- Discord through Mides needs two things Mides does not have yet (`discord_id` in
  the SSO's user, a link page with `return_to`); until then a ten-minute code from
  the profile, typed to the bot as `/link`, links the Discord user the bot names.
- **Decided:** an unlinked Discord user gets the anonymous quota of one visitor,
  counted by an HMAC of their id per day. Refusing them would leave the bot unused
  until Mides sends Discord ids; a Discord account costs about what a fresh address
  does, and both the bot and the API limit per Discord user.
- The API's upload became `acceptUpload`, shared by the browser's route and the
  bot's, so the bot is held to exactly the site's checks. A new `overtone-bot` egg.

### Hardening

- `BOT_TOKEN` is its own key: refused when equal to `WORKER_TOKEN`, neither opens
  the other's routes, and overtone-web refuses `/api/internal/bot` in any spelling
  (a test tries six).
- The Discord id travels in a header, never a URL, and is stored raw only on the
  account it is linked to (the DMs need it); quotas and limits count an HMAC of it.
- osu!: state in a signed cookie bound to the account, a PKCE verifier derived
  server side (never in the browser), the token dropped after one `/me`, the
  avatar kept only on `ppy.sh`. Link codes are stored as an HMAC and spent once.
- The bot checks an attachment before downloading (extension, type, the API's
  `MAX_UPLOAD_MB`, Discord's CDN hosts) and while downloading (no redirects, type,
  a byte count cut at the cap); the audio lives in memory until uploaded (ADR-W4).
  A song name cannot write markdown or mentions into an embed.

### Measured

- Not measured: no performance claim. Tests: `site/api` 123 (23 new), `bot` 29,
  `site/web` 90; the bot's contract suite runs it against the real API.

### Rejected / tried and dropped

- An image of the tempo chart in the embed: rendering the site's chart server side
  needs a headless browser or a canvas library for one picture. The embed links
  the page.
- Refusing unlinked Discord users (above).
- Showing the osu! avatar: widening the site's `img-src` to `ppy.sh` for a picture
  only its owner sees is not worth a third-party request.

---

## v1.0.0-stable — 2026-10-27 · Stars, uses, comments, collections and timer profiles

### Changed

- Published timings get the social layer (W5.6, W6, W13.15, W13.18): 1-5 stars (one
  per account, editable), "I used this" with an optional osu! beatmapset link, comments
  that can point at a time in the song (its m:ss moves the player there), and
  collections, private or public, with their own page (`/c/:id`).
- `/recent` orders by newest, best rated or most used; each row shows its stars and
  uses. `/u/<username>` is a timer's public profile (published timings, totals, badges,
  public collections); `/profile` gains Timings and Collections tabs and a private
  switch. `/timers` ranks timers by uses or by stars. Navbar link to Timers.
- Decisions taken in the owner's absence:
  - "Best rated" counts a timing from **3** ratings and orders by a Bayesian average
    (3 prior ratings at 3 stars), as docs/16 §4 asks: 3 is the least that says more
    than one person agreed; a higher bar would leave the sort empty while the site is
    small. The page shows the plain average and states the bar.
  - The timer ranking needs **3** uses by others or **5** ratings received, again small
    on purpose, and stated on the page.
  - The uploader can neither rate nor mark their own timing used.
  - Uses need an account; the draft's anonymous uses by address hash were dropped (a
    count anyone could push again from each new address).
  - Comment moderation reuses the community's (reports, hide with reason,
    `moderation_log`) with `comment` as a third kind: one place for staff.
  - A private profile is a 404 and leaves the ranking; its published timings stay
    published with the name on them.
- Schema: the drafted social tables pointed at `timings` (W4, not built yet). Each
  gained `analysis_id` and a check naming exactly one target, so W4 reuses them; the
  one-per-account primary keys became unique indexes per target. `accounts` gained
  `profile_private`; `moderation_log` admits `comment`.

### Hardening

- Every new mutating route has the same-origin guard, a per-address rate limit and
  capped, cleaned input; "not yours" is the same 404 as "not there" for collections,
  comments and private profiles. Beatmap links are stored only as
  `https://osu.ppy.sh/beatmapsets/<set>[#<mode>/<map>]` and rendered as their own text
  with `rel="noopener nofollow ugc"`. A test reads every response the social suite
  saw and finds no SHA-1, address hash or anonymous hash in any of them.

### Measured

- site/api 121/121 (13 new), site/web 186/186 (3 new), `vite build` ok, after merging
  `origin/experimental`. Before the merge, the 13 social tests also passed against
  PostgreSQL 18.6 through PGlite 0.5.12 over HTTP, and `check` applied the schema
  twice. No performance figure: not measured.

### Rejected / tried and dropped

- New `published_*` tables beside the drafted ones: they would have left two sets of
  social tables once W4 lands. Amending the drafted ones keeps one.
- A keyset cursor for "best rated" and "most used": a cursor over a score that moves
  while someone reads skips or repeats rows just the same, so those orders page by
  offset (`o<n>`) and say so.

---

## v1.0.0-stable — 2026-10-27 · Other games' formats and export options

### Changed

- "More downloads" offers the red lines for Quaver (`.qua`), StepMania and Etterna
  (`.sm`), StepMania 5 (`.ssc`) and Clone Hero (`notes.chart`), timing only, built in
  the browser (W12.7). The Quaver and StepMania timing matches v3's exporters.
- Export options (W12.8): offset decimals, the BPM rounded (with the drift it causes
  by the song's end), the first red line only, and an offset added to every line.
  They shape the `.osz`, the copy, the patched `.osu` and the games' files, never the
  clicks; remembered in `overtone.exports`, and named under the `.osz` while on.
- Decided: the added offset is separate from the nudge. The nudge is a correction
  heard in the clicks and forgotten with the page; the added offset is a target's
  convention (a game's or a pack's sync), so it must not move the clicks, and it is
  remembered, which is why the page always says when it is on.
- Decided: Clone Hero's `[Song] Offset` is written as 0 and a lead-in bar puts the
  first downbeat on its time, because the field is treated as legacy by Moonscraper
  as far as we know and its sign has not been read the same way everywhere.
- Decided: StepMania keeps v3's fractional beats rather than bending BPMs onto its
  1/48 rows, so the two exporters agree; the page shows how far the game will move
  each change instead (from 0.5 ms).

### Measured

- The site's Quaver and StepMania text against v3's `quaver_timing_text` and
  `stepmania_timing_text`: 67 sets of red lines, 536 texts, 0 differ (one-off script,
  not committed; see `docs/site.md`).
- On the fixture lines (a change 151.3 ms past beat 75 at 150 BPM), StepMania's rows
  would move the change 1.3 ms; Clone Hero lands every change within 0.02 ms.
- Not measured: whether any game opens the files. None was run.

### Rejected / tried and dropped

- Fitting StepMania's BPMs so each change sits on a row: exact in the game, but the
  file would no longer match v3's, and the BPMs written would not be the reader's.
- Writing Clone Hero's first line at `Offset` = its time: simpler, but it rests on a
  field whose meaning we are least sure of.

---

## v1.0.0-stable — 2026-10-27 · A fuller .osz

### Changed

- W12.9: the site's `.osz` can carry the file's own cover as `bg.jpg`/`bg.png` (ID3 `APIC`,
  MP4 `covr`, FLAC `PICTURE`, Ogg Vorbis/Opus `METADATA_BLOCK_PICTURE`), a suggested
  `PreviewTime` (the loudest 15 s, on a bar), a suggested `AudioLeadIn` (first sound under
  1.5 s → brought to 2 s) and suggested kiai green lines (bars clearly louder than the
  song, at most three runs). Checkboxes under ".osz options": cover and preview on, lead-in
  and kiai off, because the first two change nothing a player feels and the last two are
  mapping decisions a loudness heuristic should not make unasked. The rules and their
  reasons are in `docs/site.md`.
- Every `.osu` the site builds is tagged `overtone overtone_timings` (owner's rule), so maps
  made with it can be found; extra tags are kept after those two.
- After the `.osz` downloads, a dismissible tip says how to make the browser open `.osz`
  files in osu! by itself (Chrome/Edge "Always open files of this type", Firefox's Files and
  Applications) and that osu! must be installed with `.osz` associated.

### Hardening

- The cover reader never throws, skips tags over 16 MB, keeps only images whose first bytes
  are JPEG or PNG, and bounds every walk (boxes, blocks, Ogg pages) by a step count.

### Measured

- Not measured on real music: the suggestions were checked on two bench-derived FLACs
  (see `docs/site.md`), where the whole synthetic corpus is flat (-20 dB a bar) and
  rightly gets no kiai. site/web tests 90 → 114.

### Rejected / tried and dropped

- Opening the `.osz` in osu! straight from the page: a page cannot run a download, and
  `osu://` (stable and lazer) only reaches online beatmaps, not a local file. Anything
  more would need the reader's machine configured behind their back.
- Considered, not built: a fixed-percentile kiai threshold (top quarter of bars), which on
  a song mastered flat would mark noise as the chorus; the 3 dB spread requirement refuses
  instead. And the preview at the loudest window's own start, which on a long chorus is an
  arbitrary tie somewhere inside it; walking back to the earliest start within 5 % finds
  the top (the 61.3 s chorus test pins it).

---

## v1.0.0-stable — 2026-10-27 · Listening tools: latency, taps, A/B, subdivisions

### Changed

- The result page has a listening panel under the transport (W12.2-W12.6): clicks at
  1/2, 1/3 or 1/4 between beats with their own quieter tone and volume, also drawn on
  the zoomed-in map and offered in the click-track WAV; an A/B (A) between the
  engine's lines' clicks and the reader's adjusted ones at the same playhead; a tap
  pad (T) that reads a tempo with its spread and compares it with the red line there
  (matches, about ×2, about ×0.5); while playing, the taps' median offset from the
  grid proposed as the global nudge, applied only on a press; and a latency test in a
  dialog, saved in `overtone.player.latencyMs`.
- `clickGrid` takes `{ subdivision }` and builds the engine's `click_schedule`
  subdivisions (level 0, counted from the line's offset).
- A change of clicks (A/B, subdivision, adjustment, latency switch) is heard at once:
  the scheduled clicks are dropped and rescheduled from the playhead, the song plays on.

### Hardening

- Every stored value (latency, subdivision, its volume, the shift switch) is read
  inside a try and validated field by field; a broken one falls back alone.
- The page-wide keys step aside while a modal dialog is open.

### Measured

- Not measured on people. With synthesised taps in the browser pane: 128 BPM ±0.0 read
  from 12 taps on the grid; taps 20 ms late proposed +20 ms ±2.0; a 35 ms calibration
  with one stray tap read 35 ms ±1.0 (1 dropped). Figures in `docs/site.md`.

### Rejected / tried and dropped

- **Moving the clicks by the latency by default.** The roadmap row says the latency
  moves the clicks. The song and the clicks go through the same audio context and the
  same output, so any device delay reaches both alike: moving the clicks alone puts
  them off the song by exactly the latency, which is what the reader is trying to
  judge. Decided (owner away): the latency always corrects the taps, and moving the
  clicks is a switch, off by default, with the reason in its note. The exports never
  carry it.
- **A flash or moving marker in the calibration.** People tap to what they see rather
  than what they hear; the test is audio only, as osu!'s offset wizard.
- **Tempo from a least-squares line through the taps.** Slightly more exact on a steady
  hand, but one missed tap shifts every index after it; the median interval with
  stray ones dropped survives a missed or doubled tap.

---

## v1.0.0-stable — 2026-10-27 · Comparing timings

### Changed

- W12.10: the result page (and a published timing's page) compares the result with an
  `.osu` the reader picks: a verdict in plain words, a table of matched red lines, the
  lines only one side has, the map's lines dashed in a new blue on the tempo map, and its
  clicks playable instead of the result's. The `.osu` is read in the browser and kept in
  the page's state only: never uploaded, never stored.
- W12.11: `/compare?a=<id>&b=<id>` puts two timings side by side: the visitor's own
  analyses or published ones, each with its own x0.5 / x2 and nudge in the address, so
  "an analysis against its adjusted version" is one link. Offered from the history, a
  public timing and the result page. No API change.
- The comparison (`site/web/src/lib/compare.js`) compares **grids**, not first-beat
  times: a red line a whole number of beats from the other's, at the same tempo, is the
  same grid in osu!. Each pair's offset is the phase of one grid against the other where
  both lines start, and again at their last shared beat (a growing difference is drift);
  the verdict checks every beat of the sparser grid from the later first line to the end.
- Decided (owner away): the tolerances are the accuracy baseline's, 0.05 BPM and 5 ms,
  and the page names them. Two red lines pair when they are within four beats of the
  slower one (at least 1 s), in order; a verdict is `same`, `offset` (one constant shift
  past 5 ms), `double`, `half` or `different` (with the share on the same grid, the share
  at half or double, and where they first part). `/compare` is private-ish: out of the
  sitemap and disallowed in robots.txt, since what it shows depends on who asks.

### Fixed

- A tempo change a few ms apart in the two timings (x2 and +3 ms on a two-line song) read
  as `different`: for those ms the governing lines are an unrelated tempo. Each beat is now
  judged against the line that owns the other grid's nearest beat. Found in the browser.

### Measured

- `site/web` 107/107 (17 new in `test/compare.test.js`), `vite build`, `bench/facts.py` ok.
- In the browser, against the dev API with one real worker (Beat This! off):
  `change-128-142.wav` against a hand-made map with its second line 2 ms late and in 3/4,
  "same grid within 1.9 ms" with the meter change named; the same analysis at x2 +3 ms,
  "double within 3.0 ms"; at -8 ms, "8.0 ms earlier on every beat". The map's clicks: 136,
  including one at 30.400 s that the map's own lines imply 2 ms before its second line.
- Speed not measured: one comparison is a few thousand beat lookups and an alignment of
  at most 2000 x 2000 lines, done once per change.

### Rejected / tried and dropped

- Comparing first-beat times (offset = map's time minus the result's): a map whose red line
  sits one bar later on the same grid would read hundreds of ms off. Phase is what osu! plays.
- Counting agreeing beats from both grids: where both are as dense every beat was counted
  twice, so a song half agreeing read 67 %. Only A's beats count there, weighted by length.

---

## v1.0.0-stable — 2026-10-27 · Command palette and settings

### Changed

- **Command palette (W12.14).** Ctrl+K (⌘K) or the bar's search button: pages, this
  browser's analyses (the tray's in-flight ones first), and actions (language, theme,
  high contrast, settings, sign in or out, the shortcuts), ranked by a subsequence
  match in `lib/commands.js`. `?` lists every shortcut, the result page's included.
- **`/settings` (W12.15).** Theme (system, dark, light), high contrast, font size 90 to
  130 %, a colour-blind-safe palette, motion (system, reduce, allow), the default
  volumes, the device latency of W12.2 (shown, typed or forgotten) and the language,
  all in this browser. Linked from the account menu and the footer; kept out of the
  sitemap and disallowed in `robots.txt`, since a browser's own settings have nothing
  to find.
- The theme stays in `mides.theme`, shared with midesprojects.com, which gains the
  value `system`; a reader there that knows only `light` falls back to its dark
  default, as for a missing key. The other settings are `overtone.settings`.
- The colour-blind palette moves red lines, "check by ear" and tempo on the whole
  site, not only on the map, so the map, the table and the chips keep meaning the same.
- The result page's keys ignore key presses from inside an open dialog.

### Fixed

- The tempo map hard-coded the ink of its red chips: it is a token now (`--red-ink`),
  so a palette that moves the red can move its ink.

### Hardening

- `index.html`'s inline script applies the stored settings before the first frame. It
  is still the only inline script and `serve.mjs` still allows it by its hash; a new
  serve test checks the policy names exactly the real script's hash and no
  `unsafe-inline`, and a web test runs the script in a `vm` and checks it leaves
  `<html>` as the library does, so the page never jumps when the app starts.
- Every stored value is read defensively: a font scale out of range is ignored (not
  clamped) by both the early script and the library, so the two agree.

### Measured

- High contrast: every text token at 7:1 or more against every surface, down to the
  darkest panel, in both themes; the strong line at 3:1 against the page. Computed
  from `index.css` by `test/settings.test.js`.
- Colour-blind palette: the smallest CIELAB distance between the map's four colours,
  over normal vision and Machado et al.'s (2009) protanopia, deuteranopia and
  tritanopia at full severity, goes from 14.1 to 33.7 in light and from 30.4 to 42.1
  in dark (the default's weakest pair in light was amber and red under deuteranopia).
  Every new colour is at 5.5:1 or more against the panel.
- Tests: `site/web` 90 to 113, `site/api` 100 to 101.

### Rejected / tried and dropped

- **Okabe-Ito colours by hand** (vermillion, yellow, reddish purple): scored worse than
  the default in light (5.8 against 14.1, vermillion and dark yellow collapse under
  deuteranopia once darkened to 4.5:1 on white). The search, with the contrast floor
  as a constraint, replaced them.
- **Clamping a stored font scale** into range: the early script cannot share the
  library's code, and a clamp in one and a refusal in the other made the text jump
  when the app started. Both now ignore an out-of-range value.
- **The palette's search button in the phone's top row:** at 130 % the row overflowed
  375 px by 29 px; it leads the places' row instead.
- **Ctrl+K blocked inside fields**, like `?`: it never types a character, and editors
  open their palettes from anywhere, so it fires from a field too.

---

## v1.0.0-stable — 2026-10-27 · How it works, a glossary, and the site's statistics

### Changed

- `/how-it-works` explains the pipeline for a mapper (decode, attacks, tempo sweep and
  grid fit, octave and the Beat This! vote, sections and red lines, confidence levels),
  what "check by ear" means, why an analysis takes the time it does, and what the
  synthetic benchmark measures against what Corpus B is still measuring. Each step cites
  the file it was written from. W12.12.
- `/faq` answers the ten questions of the roadmap row; its limits are read from
  `GET /api/v1/health`. `/glossary` holds twelve terms, and `components/Term.jsx` puts
  them on the result page: a dotted underline on the readouts, the confidence legend and
  the red lines table's headers that opens the short definition. W12.12.
- `GET /api/v1/stats` and `/stats`: totals, the BPM histogram, one tempo against tempo
  changes, the median and 90th-percentile time from upload to result over 30 days, and
  the queue. Aggregates only, cached a minute per process, rate limited. W12.13.
- A Learn column in the footer; the GitHub docs link there is now "Documentation".

### Hardening

- The statistics are built field by field (`utils/stats.js` `shapeStats`) from counts the
  stores make; a test reads the whole body for every id, hash, file name, title and
  username the rows carried, and for any field `shapeStats` does not write.
- The analysis times are withheld below five finished analyses in the window: a median
  of two jobs looks measured and is not (CLAUDE.md rule 2).
- `lib/repo.js` links only plain relative paths, so a locale string cannot become a link
  elsewhere.

### Measured

- Not measured: these pages state the engine's existing numbers (the synthetic
  benchmark's 24/24 within 0.05 BPM and 5 ms, median 0.16 ms; about 10 s for a 60 s song
  with the vote, from docs/site.md) and measure nothing new. The pg store's `stats()` gave
  the same answer as the memory store's on the same rows through PGlite 0.5.11.

### Rejected / tried and dropped

- Counting cache hits as analyses: one song looked up ten times would count ten. They
  are their own total; the BPM histogram and the times read only the engine's runs.
- A vertical BPM histogram: at 375 px its eleven bucket names shrink below reading size.
  Horizontal rows, drawn at the box's own pixel width, keep them at 12 px.
- A chart library: two charts did not justify a dependency.
- Keeping the table headers' `title` hints next to the popovers: they said what the
  glossary's short definitions say.

---

## v1.0.0-stable — 2026-10-27 · One grid where the tracker drifts, and two ideas dropped

### Changed

- `CONSTANT_GRID` is on, at 30 ms and 0.8: where the precision grid gives way to the
  beat tracker and Beat This!'s beats over the whole song sit on one steady grid, the
  song is read as that one red line instead of the tracker's dozens. On bands-variable
  dev every one of the 185 maps that reached the tracker missed the tempo; 72 of them
  are mapped with a single line, and the tracker gave a median of 78.
- The piecewise grid (`PIECEWISE_GRID`, still off) now splits only the tracker's lines;
  the precision grid's one line is never split.

### Fixed

- A stage report keeps an analysis error's message, so a map lost to an error names
  its cause instead of only the word "error".

### Measured

On the server, ranked maps, engine `app`, tempo ok / octave ×1 (2026-10-27):

| Run | bands dev | bands held out | anime-variable dev | anime-variable held out |
|---|---|---|---|---|
| base | 46.7 / 83.5 | 59.9 / 82.4 | 31.5 / 84.8 | 19.5 / 77.6 |
| constant grid, 20 ms / 0.9 | 50.3 / 83.5 | 59.9 / 82.4 | 31.5 / 85.1 | 20.4 / 77.6 |
| constant grid, 30 ms / 0.8 | 51.1 / 83.5 | 59.9 / 82.4 | — | — |
| constant grid, 40 ms / 0.7 | 51.1 / 83.5 | — | — | — |

anime-single (78.8 / 92.8 dev, 81.9 / 94.3 held out) never reaches the tracker, so the
constant grid cannot move it. The 30 ms setting is on for its dev gain; its anime
numbers come with the next round on the server. Gates 15 of 15 on 1a2441f and 239849c.

The perf gate on the server (run 20261028-025947-3a9144, 9231b97) caught the cost: on
`_ramp`, the one perf case on the tracker path, `local` went from 0.047 s to 15.2 s of
CPU (0.056 -> 2.8 s wall), Beat This! now heard to test the grid. Every other stage
held. The `_ramp` budget in `bench/perf_snapshot.json` takes the server's reading;
the cost is the feature, paid only by songs the precision grid gives up on.

### Rejected / tried and dropped

- **The song's octave from Beat This! (`SONG_OCTAVE_BEAT_THIS`).** bands dev 46.7 → 43.7,
  held out 59.9 (octave ×1 82.4 → 84.9); anime-single dev 78.8 → 73.6 and octave ×1
  92.8 → 86.7, held out 81.9 → 75.8. On bands it fixed 4 maps and broke 8, and both
  groups halved to the same 92–115 BPM, so no rule on the tempo tells them apart.
- **Splitting the precision grid's line into steady stretches** (`_piecewise_grid` on
  the precision path). bands dev 46.7 → 32.4 (penalty 40), 32.4 (penalty 120), 33.5
  (with the constant grid); held out 59.9 → 30.1. Map by map, 23 one-line songs split
  into 2–10 lines lost 119 maps and an error lost 8, against 8 gained. A penalty three
  times higher changed nothing: Beat This!'s beats wander by more than 1.5 % within a
  steady song, which no price per line separates from a real change. On the tracker
  path the same split gained 28 maps and lost none, so it stays there to be measured.

---

## v1.0.0-stable — 2026-10-27 · A cleaner logo for the web

### Changed

- The owner found the full logo untidy in a browser tab. `assets/logo.py` gains a web
  variant of the same mark (`web_svg_text`, `render_web`): the fundamental alone,
  thicker and inset from the edges, and the red line as a rounded bar inside the
  panel; no faint harmonics, which turned to noise at 16 px. Every site icon and the
  favicon use it; `logo.png` and `logo.ico` keep the desktop app's full mark.

### Measured

- `logo.png` and `logo.ico` byte-identical (md5 unchanged). Looked at in the browser
  pane at 256, 64, 32, 22 and 16 px on the light and dark page colours.

---

## v1.0.0-stable — 2026-10-27 · The site shows Overtone's own logo

### Fixed

- The site's mark was a redrawn ring with a bar, and its favicon and icons the Mides
  mark: the owner called it an imitation of the app's logo. `assets/logo.py`, which
  drew the desktop app's icon, now also writes `assets/logo.svg` (the same geometry as
  vectors) and the site's icons from the same renderer; `Mark.jsx` shows that SVG in
  the navbar, footer and sign-in. The Mides mark stays where Mides Projects is named.
  `site/web/scripts/icons.mjs`, which rasterised the old favicon, is gone.

### Measured

- `assets/logo.png` and `logo.ico` come out byte-identical (md5 unchanged); the new
  files take 2 min 24 s to render on this machine (the 512-px ones, in pure Python).
- site/web 88/88 (`icons.test.js`, 4 tests, replaced by `logo.test.js`, 2).

---

## v1.0.0-stable — 2026-10-27 · Quieter defaults, and the roadmap's W12

### Changed

- The song and the clicks start at 20 % (were 80 % and 60 %), at the owner's request:
  most people keep the browser and the system at full volume. A volume the reader
  set is still remembered and wins.
- `docs/16-web-platform.md` gains phase W12, 24 tools for timers (latency calibration,
  tap tempo and tap offset, A/B clicks, subdivisions, other games' formats, export
  options, a fuller .osz, comparing with an existing map or another timing, how-it-works,
  FAQ and glossary, site stats, a command palette, settings and accessibility, and more).

### Measured

- Not measured: a default.

---

## v1.0.0-stable — 2026-10-27 · The analysis tray and its notices

### Changed

- W3.22: a tray on every page lists the songs this tab sent — name, state, queue
  place, stage and %, a link to the result, Cancel while queued — so the person
  can browse while they wait. Wide screens get a corner button, open by default;
  phones get a button in the navbar and a bottom sheet, closed by default.
- The polling moved out of the Analyze page's cards and the result page into one
  store (`site/web/src/lib/tracker.js`): every view reads it and each id is read
  once. It slows with age, queue place, the number in flight, failures and a
  hidden tab, and stops when a song is final.
- The ids, statuses, batches and inbox survive a reload in `sessionStorage`
  (per tab, so two tabs do not notify twice); sound and notifications are
  remembered in `localStorage`.
- W3.23: a browser notification per finished song and per finished batch (opt-in,
  only after the browser grants it, only when the tab is not in focus), an
  optional two-note chime made with Web Audio (off by default), the tab title
  counting everything in flight on any page ("3 in progress"), and an inbox of
  the last 20 notices, cleared by the person.
- W3.14's "2/5 ready" title and its once-per-batch notification are replaced by
  the above; its checkbox on the Analyze page is now the tray's setting.

### Hardening

- Saved state is read field by field: 32-hex ids, known statuses, short batch ids,
  names stripped of control and bidi characters; anything else is dropped, and
  blocked storage means a tray that forgets on reload rather than one that breaks.
- With N songs in flight each id waits at least N × 0.5 s, so a batch stays near two
  requests a second, well inside the API's 300 a minute per address.

### Measured

- site/web tests: 33 → 47 (16 new in `tracker.test.js`; W3.14's two title and
  notification tests moved there as `trayTitle` and `alertFor`).
- A queued song on its result page, with the tray following it: 6 requests in 6 s
  (one per id per second), not two streams.
- Build: 459 kB JS (147 kB gzip), up from 457 kB.

### Rejected / tried and dropped

- **A floating corner button on phones.** At 375 px it sat on top of the Analyze
  page's full-width button; the phone button moved into the navbar's top row.
- **localStorage for the ids.** Every open tab would poll the same songs and send
  the same notification; sessionStorage keeps the work with the tab that started it
  and still survives a reload.
- **A notification even while the person looks at the page.** The tray, the title
  and the live region already say it there; a system notification on top was noise.
- **A chime per song of a batch.** Ten songs, ten chimes: a batch's songs only
  update its one notification (same `tag`), and the batch's end chimes once.
- **An API change** (a batch endpoint, server-sent events): not needed; the
  per-id GET is cheap and the API stays as it was.

---

## v1.0.0-stable — 2026-10-27 · Terms, privacy, disclaimer, credits and a status page

### Changed

- New pages, EN and ES, linked from the footer: `/terms`, `/privacy`, `/disclaimer`,
  `/credits`, `/status`. **The terms and the privacy page are drafts** for the owner's
  review, and say so on the page: the operator's legal name and address, the
  jurisdiction, a contact address, how long analyses are kept and which hosting
  providers keep logs are marked placeholders, not invented. The privacy text is read
  from the code (schema, services, cookies, `localStorage` keys); where the code has
  no expiry (analyses, songs, accounts, the moderation log) it says none is set yet.
- The result page's "Check by ear" note links to `/disclaimer` instead of repeating it.
- `/credits` lists the team (founder githalt, Mides Projects), Overtone's MIT licence,
  Beat This! (MIT) and every Python pin and npm package with its licence, generated by
  `site/web/scripts/credits.mjs` from the installed packages' own metadata.
- `GET /api/v1/health` adds `worker: { status, seenSecondsAgo }`: whether a worker
  called `/api/internal` in the last 120 s. `/status` shows it with the API and the
  database, and retries with backoff while the API does not answer.
- Every page sets its own `<title>` and description (`usePageMeta`); `index.html`
  carries Open Graph and Twitter tags; `robots.txt`, `sitemap.xml`, a web app manifest
  and PNG icons (favicon, apple-touch, 192, 512, maskable, a link-preview image) are in
  `site/web/public`. The PNGs are drawn from `favicon.svg` by `scripts/icons.mjs`
  without a new dependency.
- An error boundary around the routes and one around the app: a page that throws
  shows a reload button and no stack trace.

### Hardening

- `deploy/web/serve.mjs` serves `.xml` as `application/xml`; with `nosniff` the
  sitemap would otherwise have gone out as `application/octet-stream`.

### Measured

- `site/api` 73/73 (4 new: the worker status, serve.mjs serving the new static files),
  `site/web` 50/50 (17 new: credits shape and readers, icons pixel for pixel, the
  title helper, the backoff, sitemap against routes). `pnpm --dir site/web build`:
  main chunk 481.38 kB (154.46 kB gzip), the credits page its own 15.28 kB chunk.
  `bench/facts.py` ok. `credits.mjs` run twice wrote the same bytes.
- In the browser pane at 375 px, EN/ES, dark/light: the new pages, no horizontal
  scroll. Not measured: Lighthouse or any SEO score; link previews on a real network.

### Rejected / tried and dropped

- **A rasterizer package for the icons** (sharp, resvg): a native or WebAssembly
  binary in the install for six PNGs from one rounded square and one stroked path.
  Drawing the shape's distance field with Node's zlib is a small script, and the test
  compares its output with the committed files.
- **Using the Overtone ring mark for the favicon set** instead of the Mides mark that
  `favicon.svg` already holds: the owner picked that favicon, so the PNGs follow it.
- **Counting the worker as down for the health status code**: an API without a worker
  still answers and queues uploads; a 503 there would page a monitor for a queue that
  is only waiting. The worker's state is a field, the code stays the database's.

---

## v1.0.0-stable — 2026-10-27 · More downloads and "Check here"

### Changed

- The result page patches the reader's own `.osu` in the browser (W3.20): its red
  lines replaced by the page's, every byte outside `[TimingPoints]` identical, green
  lines kept as written (also those that end up before the first red line: osu! reads
  them against it, and deleting them would lose velocity and hitsounds). Where a
  removed red line's hitsound state or velocity reset would otherwise change, a green
  line carries it; hit objects are not moved and the page warns that they may be off
  the new grid. The file never reaches the server.
- A click-track WAV, rendered with an `OfflineAudioContext` by the player's own click
  function: the clicks alone, or over the song at the player's volumes. Capped at
  600 s, the site's analysis limit (ten minutes of 16-bit stereo at 48 kHz is 115 MB).
- The result as JSON (as the API served it) and a plain-text summary. The CSV moved
  with them into a folded "More downloads" group; the `.osz` stays the one primary
  button.
- "Check here" (W3.25): one list, sorted by time, of the `check`/`medium` sections,
  the sections with a 90th-percentile drift over 20 ms, the half/double hints and the
  swing spans, each shown on the map or looped with the clicks. Evidence the engine
  already reported, gathered; not a new reading.

### Measured

- The drift threshold, on 2026-10-27, through the worker's own `build_result` with
  the vote off (scratch script, not committed): the 34 synthetic files (exact grids)
  have every section's `drift_p90_ms` under 10 ms (median 0.5) except the two built to
  be hard, very-noisy-132 (27.0) and swing-120 (39.9). Corpus B's 20 hand-timed songs
  (one refused): 30 sections with a drift, p10 22.0, median 29.3, max 50.2 ms; 28 over
  20 ms, and all 30 already graded `check`. So 20 ms keeps a clean grid off the list
  with twice the margin, and on real music the level is what flags it: the measure
  nears its ceiling there (an eighth of a beat, 34 ms at 222 BPM) and cannot tell a
  right grid from a wrong one.
- The click track of `change-128-142.wav`: 135 of 135 clicks within 0.024 ms (one
  sample) of the grid, accents on the bar; rendered in about 1 s for 60 s of audio.

### Rejected / tried and dropped

- Dropping green lines that end up before the first red line: osu! reads them, and a
  silent loss of slider velocity or hitsounds is worse than a line in an odd place.
- A green line for every removed red line: a red line moved 2 ms would leave a green
  line 2 ms before it for nothing. Only where the state would change.
- Decoding the `.osu` as UTF-8 (or `TextDecoder('latin1')`, which is really
  windows-1252): either can change bytes. One char per byte is lossless.
- A drift threshold relative to the beat (p90 over half the eighth-beat ceiling): it
  would flag most Corpus B sections too (the ones worked out by hand sit at 0.53-0.8
  of the ceiling), and those are already `check`; an
  absolute 20 ms is simpler to explain and separates the synthetic corpus the same way.

---

## v1.0.0-stable — 2026-10-27 · W5.2-W5.5: a Community page

### Changed

- The site has a Community page with three tabs. **Suggestions**: anyone reads,
  a Mides account posts and votes (one vote each), sorted by votes or date and
  filtered by state; staff move a suggestion through open, under review,
  planned, in progress, done or rejected, a rejection always with a reason, and
  every change is on the suggestion for anyone to read. **Reviews**: 1 to 5
  stars and a few words, with an account (one, editable) or anonymous, with the
  average and the distribution; an anonymous review counts half in the average,
  and the page says so. **Changelog**: the latest 30 entries of this timeline,
  their titles, dates and Changed bullets, in English.
- Anyone can report a suggestion or a review; staff hide or unhide it with a
  reason, and see the open reports and the log of what they did.

### Hardening

- Anonymous reviews: two a day per address, counted by the daily address HMAC
  the uploads already use, a hidden honeypot field and a signed form token at
  least 3 s old. No third-party CAPTCHA, since the site calls no outside
  service. Suggestions need an account: a suggestion is answered by its state
  changes, and an anonymous one has nobody to answer.
- A hidden item is the same 404 as a missing one for everyone but staff and its
  author. Text is cleaned of control and bidi characters and rendered as text;
  too long is refused, never cut. The changelog's markdown becomes tokens, not
  HTML, and only absolute http(s) links stay links. Same-origin guard and a
  per-address rate limit on every new mutating route.
- One moderation log: `moderation_log` (W3.18) gained `target_kind`,
  `target_ref` and the states before and after; the queue's log reads its own
  rows only.

### Measured

- `node --test` in `site/api`: 81/81 (12 new). The same 12 and the queue's 5
  moderation tests against PostgreSQL 18.6 (PGlite 0.5.11 behind
  `pglite-socket`): 12/12 and 5/5; `check` applies the schema twice, 18 tables.
- `node --test` in `site/web`: 36/36 (3 new). `vite build` passes; the main
  bundle is 476 kB as before, the changelog its own 31 kB chunk (10 kB gzipped).
- In the browser: a staff review moved the average from 3.75 to 4.17, as
  computed by hand with anonymous reviews at half.

### Rejected / tried and dropped

- Anonymous suggestions: see Hardening. Reviews are where an anonymous opinion goes.
- A generated `changelog.json` committed or written into `src/`: it would go
  stale the first time the timeline changed without a build. A Vite virtual
  module reads the timeline on every build instead.
- A client-reported time on the form: it can be any number. The minimum time is
  a server-signed token instead.

---

## v1.0.0-stable — 2026-10-27 · Published timings, recent ones and a history

### Changed

- A finished analysis can be published by its uploader (W3.27): opt-in, one press,
  undone by Unpublish. It then has a public page at `/t/<id>` with the result, title
  and artist, who uploaded it (Mides username or "anonymous") and when. A private
  upload is published only when the same action makes it public, after the page asks.
- `/recent` and a section on Home list published timings from everyone (W5.1), with
  search, a BPM range, single or variable tempo and cursor paging.
- `/history` lists everything a signed-in account analysed (W3.26), searchable and
  filtered by status, BPM and date, with publish, unpublish and delete per row.
  Signed out it shows this browser's own list and asks to sign in.
- `DELETE /analyses/:id` also deletes a finished analysis, not only a queued one.
- `deploy/web/serve.mjs` writes `/t/<id>`'s title and Open Graph tags into the
  served HTML, so link previewers that do not run scripts see the song.
- Schema: `analyses.published_at` and `analyses.deleted_at` (idempotent `ADD COLUMN
  IF NOT EXISTS`) and a partial index for the recent list.

### Hardening

- The public views never carry the audio's SHA-1, the file name, `anon_hash` or
  `ip_hash`; they are built field by field, and the tests look for each value in
  every public body.
- A visitor's file is checked by `POST /timings/:id/check`, which answers only
  match or no match (20 per 10 minutes), so the hash never leaves the server.
- Every new mutating route has the same-origin header and a rate limit; the list
  reads are rate limited and capped at 50 a page; filters are parsed strictly (a
  malformed one is a 400, never "everything"); search text loses control and bidi
  characters; LIKE wildcards in it are taken literally.
- Deleting a finished analysis keeps the erased, marked row until its UTC day ends,
  so delete-and-analyse-again cannot get around the daily quota.
- Open Graph values are stripped of control and bidi characters and escaped for an
  attribute; the served page is never cached, so an unpublish stops the preview.

### Measured

- `site/api` 84/84 (15 new), `site/web` 36/36 (3 new), `vite build` ok,
  `bench/facts.py` ok.
- PostgreSQL 18 through PGlite 0.5.12 (temporary install outside the repository):
  `check` (15 tables, twice), `db:migrate` twice, and the store's publish, list,
  history, delete and purge paths in one script: all as on the memory store.
- No timing or accuracy number moves: the engine is untouched.

### Rejected / tried and dropped

- **A row in `timings` per published analysis.** That table is for timings people
  edit and fork (W4); a published analysis is the engine's reading as it came, and a
  column keeps one source of truth for its result.
- **A second, publish-only id.** It would only matter if the analysis id were a
  secret, and it is not: reading `/analyses/<id>` still needs the uploader.
- **No .osz on public pages.** Simpler, but the visitor would get a timing they
  cannot hear against the song; the match-only check costs one rate-limited route.
- **Truncating `published_at` to milliseconds** so a JS Date reads it back exactly:
  the cursor carries microseconds computed in SQL instead, and two publishes in the
  same millisecond still page correctly.
- **A hard delete of a finished analysis.** It handed the day's quota back.
- **Filters in the URL.** Search text in a URL ends up in logs and history; the
  filters live in the page.

---

## v1.0.0-stable — 2026-10-27 · The result page hands over an .osz

### Changed

- The result page downloads a `.osz`: the reader's own file as `audio.<ext>` and one
  `.osu` (format v14) with the red lines as the page has them (×2 / ÷2 and the
  nudge included), no hit objects and no comment rows. Opened, osu!stable imports
  it as a new set ready for the editor. Title and artist are the file's tags, else
  its name read as `Artist - Title`; ASCII in `Title`/`Artist`, the spelling as
  written in the `*Unicode` fields; the creator is the signed-in Mides username or
  "Overtone". It is built in the browser (ADR-W4): the audio is never sent again.
  The API's per-analysis view now carries `tagTitle` and `tagArtist` for it.
- "Download timing.txt" is gone from the page (the owner's call: the .osz replaces
  it). Copying the `[TimingPoints]` block and the CSV stay, and so does the API's
  `timing.txt` route, for scripts and the batch zip.
- The song and click volumes, and whether the clicks are on, are kept in this
  browser's storage and restored on the next result page. Storage that is blocked
  falls back to the old defaults.

### Measured

- `site/web` tests 33/33 (6 new, `osz.test.js`: the rows, an adjusted timing,
  non-ASCII names, the audio byte for byte with its CRC, cleaned file names).
- In the browser pane, `pnpm dev`: `change-128-142.wav` uploaded as
  `Test Band - Two Tempos.wav` gave `Test Band - Two Tempos.osz`, 5 293 087 bytes:
  `audio.wav` (5 292 044, the file's size) and the `.osu` with `400,468.750000973913`
  and `30400,422.535211267606`. Volumes set to 35 and 20 read back 35 and 20 after a
  reload. Without the file (after a reload) the button is disabled and says why.
- Not checked: importing the .osz in osu!stable itself (no osu! on this machine), and
  lazer.

---

## v1.0.0-stable — 2026-10-27 · The measurement server, hardened

A security review of the measurement server (`python/overtone_server.py`, the library
behind it) and its updater (`deploy/`) found four problems. All four are fixed here.

### Fixed

- **The updater's busy check failed open.** When the runs API did not answer (or
  refused the token), the check read "idle", so a loaded server got its code moved
  and restarted under a measurement. It now waits unless the API says the queue is
  empty, and logs why it waited. A service systemd reports as not running is the
  one exception: its runs are its own processes, so none can be going, and waiting
  would keep a crashed server from ever getting its fix.

### Hardening

- **Root no longer runs anything from the checkout.** `setup-deploy-user.sh` copied
  `overtone-update.service` and `.timer` out of `/opt/overtone`, a tree `overtone`
  can write, into `/etc/systemd/system` as root. The script now carries both units
  inline (a test holds them byte for byte to the committed files) and is run from
  a root-owned copy the owner has read. `docs/server.md` runs every git and git-lfs
  step on the checkout as `sudo -u overtone -H git` (no `safe.directory`), and the
  venv, cargo, first-start and bench-audio steps as `overtone` too.
- **Connections are capped and timed out.** Each connection had a thread and no
  socket timeout. Now a connection silent for 30 s is dropped, at most 64 are
  served at once, and one more is answered 503 from the accepting thread and closed.
- **Wrong tokens are limited across the server.** The 1 s sleep per wrong token
  held a thread asleep per guess, so parallel guesses piled up sleeping threads.
  It is replaced by a server-wide limiter: past 20 wrong tokens (bearer or
  `/login`) a minute, no token is checked, the right one included, and the reply
  is 429 with `Retry-After`. An open browser session keeps working.
- **An .osu's audio name stays inside its song folder.** `AudioFilename` was joined
  to the folder as written, then stat'ed and decoded: `../../x`, an absolute path or
  a link out sent the decoder to any file the server could read. The scan keeps
  only a bare file name, and analysis and health open an audio file only when,
  with links followed, it is a regular file inside its folder. An older index keeps
  old names, so the check is where files are opened; a refused name is a
  `no_audio` row that says why.

### Measured

- Suite: 511 tests OK in 1239 s, 5 skipped (500 before; 11 new: `DeployScriptTests` 5, `LibraryAudioPathTests`
  4, `LibraryServerTests` 2). The updater tests run the real script against a
  scratch checkout one commit behind its origin, with `systemctl` and `sudo`
  stubbed; the no-answer case fails on the old script.
- `bench/facts.py` ok, `bench/parity.py` matches (247 of 502), `bench/fuzz_reader.py`
  3000 mutants with no crash, `sh -n` on both deploy scripts.
- Headless smoke (a free port, a temp Songs folder, `LOCALAPPDATA` in a temp dir):
  401 without the token, a scan and `/api/songs` with it; with 55 idle connections
  open a real request answered 200 in 0.19 s; with 64 open the 65th got
  `503 Service Unavailable`; after closing them, 200.
- Not measured: the engine gates (no engine code changed), anything on the server
  itself, Caddy in front.

### Rejected / tried and dropped

- **A per-address limiter.** Behind Caddy every client is 127.0.0.1, and
  `X-Forwarded-For` is only as honest as the proxy's configuration; a server-wide
  count needs neither. The price: someone sending wrong tokens can keep bearer
  clients (scripts, the updater) out while they do. The updater then waits, which
  is the safe side, and an open browser session still works.
- **Letting the right token through while limited.** Then the limiter would slow
  nothing: the guess that is right still gets in.

---

## v1.0.0-stable — 2026-10-27 · Security hardening of the site and its servers

A security review of the site once every Reviactyl allocation port turned out to be
public (overtone-web on a public port, soon behind Cloudflare; the API and Postgres
reachable from every container on the node) found thirteen things to fix. One commit
each on `fix/security-hardening`.

### Changed

- `QUEUE_MAX` defaults to 30 (was 200), so `QUEUE_MAX × MAX_UPLOAD_MB` fits the new
  spool budget on the API server's 2 GB disk.
- New variables: worker `WORKER_MEMORY_MB` (1800), `WORKER_TIMEOUT_MIN_S` (120),
  `WORKER_TIMEOUT_FACTOR` (3); API `SPOOL_MAX_MB` (1280), `SPOOL_MIN_FREE_MB` (256),
  `MIDES_IMAGE_ORIGINS`; web `TRUSTED_PROXY_ADDRS`, `API_TIMEOUT_S` (60),
  `MIDES_WEB_URL`, `MIDES_IMAGE_ORIGINS`; db `DB_ROLE`, `DB_ROLE_STAGING` (required).
- Over https the session and anonymous cookies are `__Host-overtone_session` and
  `__Host-overtone_anon`. Deploying this signs everyone out once, and anonymous
  uploads from before it are no longer readable by their uploader.
- The worker no longer imports the engine: a warm child process does.

### Hardening

- **Decompression bombs (high).** A header claiming more than 192 kHz, 8 channels or
  `max_seconds × 192000` frames is refused (`too_heavy`) before decoding. Each
  analysis runs in a spawned child kept warm between jobs, with a wall-clock limit of
  `max(120 s, 3 × length)` and, on Linux, `RLIMIT_AS` of `WORKER_MEMORY_MB`; a job
  that runs out of time or memory, or whose child is killed, fails alone (`timeout`,
  `too_heavy`) and the next job gets a fresh child. The child proves itself on 8 s of
  clicks before the worker says ready. The worker re-sends the last progress every
  60 s, so the API's `JOB_TIMEOUT_S` sweep never takes a long live job for a dead one.
- **Spool exhaustion (medium-high).** Uploads reserve their size against
  `SPOOL_MAX_MB` (and the disk's free space less `SPOOL_MIN_FREE_MB`) before a byte is
  read and release it in a `finally`; past it, 503 `SPOOL_FULL`. Uploads in flight
  count toward the person's pending cap and the queue's. serve.mjs cuts a forwarded
  request whose API connection is idle for `API_TIMEOUT_S` (504).
- **Forged X-Forwarded-For (medium).** serve.mjs reads the header only from a peer
  inside `TRUSTED_PROXY_ADDRS` (Cloudflare's ranges are in docs/deploy.md §9); from
  anyone else it discards it, and `-Proto`/`-Host`, and forwards the socket address.
  With `TRUST_PROXY=2`, `req.ip` is the real client either way.
- **IPv6 rotation (medium).** Rate limits, the anonymous quota and the queue's turns
  count IPv6 clients by their /64, and `::ffff:a.b.c.d` as `a.b.c.d`.
- **Postgres open to every container (medium).** The db egg's own
  `pg_hba.overtone.conf`: the superuser by the container's socket only, each
  environment's role to its own database with scram, everything else rejected;
  Wings points `hba_file` at it and rewrites its lines on every start. Existing
  servers need one Reinstall with `DB_ROLE`/`DB_ROLE_STAGING` set.
- **Backups (medium).** The nightly `pg_dump` uses `-h /tmp` (the old line failed
  since the socket moved, and left an empty dump named for the day), `umask 077`, a
  `.partial` file renamed only after a successful dump and a `pg_restore --list`
  read, and runs at 04:00, before the panel's 04:30 stop. To be run once by hand.
- **Cookies (low).** `__Host-` names over https (Secure, Path=/, no Domain), so no
  sibling `*.midesprojects.com` host can plant an anonymous cookie and read a
  visitor's uploads; a cookie name sent twice counts as absent.
- **Labels (low).** File names and tags lose C1 controls, bidi marks, overrides and
  isolates, zero-width characters and the BOM.
- **Result validation (low).** Every red-line and section number must be finite and
  in range, `level` one of high/medium/check, arrays capped at 2000 and strings at
  fixed sizes; unknown fields still pass. CSV text cells starting with `= + - @` get
  a leading apostrophe.
- **Avatars (low).** A profile picture is kept only on `MIDES_WEB_URL`'s origin or
  `MIDES_IMAGE_ORIGINS`; serve.mjs's `img-src` is `'self' data:` and those origins
  (was any `https:`), so no uploader's chosen host learns who views the queue.
- **Return path (low).** The sign-in return path is resolved and kept only when it
  stays on this origin (`/\evil.example` read as `//evil.example` before).
- **Deploy (low).** `start.sh` unsets `GIT_TOKEN` after the checkout; `package.json`
  pins `pnpm@11.25.0` by its sha512 for corepack. docs/deploy.md: panel subusers on
  these servers get no file, SFTP, startup or backup permission, since anyone who can
  edit files can read every secret.

### Measured

- Python suite: 794 tests, all pass (8 skipped), up from 784: 10 new worker tests.
  Worker tests 19/19. `pnpm --dir site/api test`: 56/56, up from 31 (25 new, among
  them serve.mjs run in front of stand-in APIs and the upload route against a real
  server). `pnpm --dir site/web build` passes. `egg.py --check`, `node --check
  deploy/web/serve.mjs`, `sh -n`/`bash -n` on the scripts pass.
- Worker, 120 s bench track with the vote, Windows: warm-up 24.9 s in process
  (no self-test) against 42.8–55.5 s in the child (with it); per analysis the same
  within this machine's noise: child medians 45.4 and 59.3 s, in process 46.8 s
  (and 26–84 s in other in-process runs the same morning).
- Not measured or not run: `RLIMIT_AS` on Linux (the start-up log prints the
  child's peak address space after the self-test: the number to size
  `WORKER_MEMORY_MB` by), pg_hba against real PostgreSQL and Wings, corepack with the
  pin, anything on NA-01.

### Not fixed here

- Python dependencies are pinned but not hash-checked (`pip --require-hashes` needs a
  hashed lock of the worker's manylinux wheels; a W-item).
- The refusal code `too_heavy` has no sentence of its own in the site's two languages
  yet: the result page falls back to "could not time this audio" plus the engine's
  English message (left for the result-view branch, which is rewriting that page).

---

## v1.0.0-stable — 2026-10-27 · Timing a song on the site

### Changed

- The result page is a tempo map instead of a table: the red lines over the
  waveform, the local tempo, each section's level, the beat and bar grid, the
  onsets and their drift from the grid, swing and the half/double hints, with
  zoom, pan, an overview and a following playhead. The song plays from the
  reader's own file with the red lines' clicks mixed over it, at 0.5-1.5, looped
  over a drawn span or a section, from any red line, by keys. The red lines'
  table follows the map both ways and shows drift and the fit residual. x2 / /2
  and a global nudge in ms change the map, the clicks and the exports together,
  labelled as the reader's adjustment to check by ear. docs/site.md has it all.
- The worker writes `timing-result v1.1`: `version` 1, `minor` 1, plus the
  engine's beats and local tempo, the click track's bar starts, the attacks, the
  onset envelope, swing_lane's spans, density_hints, and each red line's drift.
  All read-only: `python/overtone.py` is untouched. The engine hash takes the
  minor, so v1.0 results are not served from the cache as v1.1.
- The API's analysis view carries the audio's `sha1`, for its owner.

### Hardening

- The audio still never reaches the server's answers (ADR-W4): playback and the
  waveform come from the file the reader picked, kept in the page for the
  session. A reopened result asks for the file again and plays it only when its
  SHA-1 equals the analysis's, so another song is never lined up with these red
  lines.

### Measured

- Payload, vote off: 14.7 kB for `change-128-142.wav` (60 s), 49.2 kB for
  `long-6min.wav`, against a budget of 300 kB for six minutes.
- Clicks against the red lines' grid, read back from the scheduled oscillators:
  within 0.0001 ms at rates 0.75, 1, 1.25 and 1.5, across a loop's wrap, and
  after x2 with +5 ms. The page's bar starts equal the worker's `downbeats_ms`.
- `long-6min.wav` playing at 1.5 for 8 s, zoomed in: 399 frames, the worst
  31.7 ms, no long task (the machine was running other agents' benchmarks).
- `tests.test_worker` 10 (one new, and the v1.1 fields checked on audio),
  `pnpm test` 31, `pnpm build` 428 kB JS / 137 kB gzip, `bench/facts.py` ok after
  the stated counts moved to 785. The full Python suite: 785 OK, 8 skipped, in
  1349 s (other agents' suites and benchmarks were running beside it). The engine
  gates were not run: no engine file changed.
- Not measured: Safari, Firefox, a real phone, and nothing was listened to (the
  page's output was muted during the checks).

### Rejected / tried and dropped

- Sending onsets at 0.1 ms: twice the bytes for a drift the page only recomputes
  after the reader nudges, where whole ms read at most 0.5 ms off the worker's
  own figure, which the table shows unadjusted.
- A pitch-kept time stretch for the slower rates: the desktop app measured one
  moving attacks by about 24 ms, which is the error the clicks are there to hear.
  Resampling keeps every attack at t / rate.

---

## v1.0.0-stable — 2026-10-27 · overtone-cli writes timing-result v1

### Changed

- `overtone-cli analyze <audio> --timing-result` prints the `timing-result v1` document
  the worker writes from v3, key for key, with `engine` "v4": red lines snapped as the
  exporter snaps them, one section per red line with its level (the worker's 0.90 /
  0.75 / 30 ms, copied), the `[TimingPoints]` rows, and a refusal with the engine's
  reason when there is no grid. W2.1 said both engines emit it; until now only v3 did.
- Three differences, on purpose: `findings` is absent (v4 does not validate timing
  points yet, and an empty list would claim it did); `beat_vote` is false (the vote is
  not ported); `engine_hash` is FNV-1a over the running executable, so a cache keyed by
  it never mixes the two engines and any rebuild that changes the code changes it.
  `site/api/docs/openapi.yaml` still says `engine: const v3`; the API does not check
  that field, and the site is another session's.

### Measured

- `tests/test_worker.py` (2 new): on the golden fixture `change-128-142`, v3 (vote off)
  and v4 write the same keys and JSON types at every level, red lines 128 and 142
  within 0.01 BPM and 5 ms of each other, the same levels and meter. Not measured: how
  often v4 refuses where v3 falls back, on real music (Corpus B's business).

---

## v1.0.0-stable — 2026-10-27 · W2.4: what one worker job costs

### Changed

- `bench/worker_perf.py`: each job in a fresh process, as a worker runs it (engine and
  model loaded, then `timing_result.analyse`), threads capped as `deploy/eggs/start.sh`
  caps them from `WORKER_THREADS` (4, prod). Prints load time, job time, seconds per
  minute of audio and peak memory, vote on and off, for 1, 6 and 10 minutes (the API's
  `MAX_AUDIO_SECONDS`). Fails past 45 s per audio minute (a 600 s track in half of
  `JOB_TIMEOUT_S`) or past the container's memory.

### Fixed

- The worker's thread-capped Beat This! loader (`limit_onnx_threads`, used by every
  deployed worker) built its own ONNX Runtime session without the
  `enable_mem_pattern = False` the engine's loader got in #20, so the deployed path kept
  the old peak. It sets it now: 1824 -> 1200 MB with the vote at 10 minutes.
- `docs/deploy.md` said a worker without the vote fits in 512 MB. Never measured: a
  10-minute track peaks at 565 MB. It now says 768 MB, and the gate holds that.

### Measured

- Windows, 12 cores, 4 threads, one pass per case. First run: machine loaded by other
  sessions, before the loader fix. Second run: quiet machine, with #20 and the fix.

  | audio | vote | s/min loaded | peak MB before | s/min quiet | peak MB fixed |
  |---|---|---|---|---|---|
  | 60 s | on | 34.1 | 1628 | 8.2 | 1002 |
  | 60 s | off | 10.6 | 291 | 2.1 | 292 |
  | 360 s | on | 15.5 | 1738 | 5.4 | 1113 |
  | 360 s | off | 3.3 | 445 | 0.9 | 444 |
  | 600 s | on | 20.7 | 1824 | 5.4 | 1200 |
  | 600 s | off | 4.7 | 565 | 0.9 | 566 |

  Load (engine + model, once per worker start): 7-38 s loaded, 1.5-4.8 s quiet. The
  machine's load moved the times by four, more than any code did; the peak moved only
  with the fix. The cost has a fixed part, so short tracks are the worst per minute.
  W3.16 can quote 35 s per audio minute with the vote (the loaded figure), marked as
  an estimate, until the container is measured.
- Not measured: the Linux container (same blocker as W2.3); Windows' peak working set
  is not Linux's peak RSS, so the margin is to be re-read there.

### Rejected / tried and dropped

- Keeping 512 MB as the no-vote budget: the gate would be red for a figure nobody
  measured. The first run's peak (565 MB) rounded up is the budget instead.

---

## v1.0.0-stable — 2026-10-27 · W3.19: the site's checks in the verification list

### Changed

- W3.19 of [the web platform](16-web-platform.md): the Verification section of
  `CLAUDE.md` and `AGENTS.md` lists `pnpm --dir site/api test`, with its count, and
  `pnpm --dir site/web build`, to run before any commit that touches `site/`.
- `bench/facts.py` counts the top-level `test(` calls in `site/api/test` and
  `site/web/test`, as `node --test` runs them, and fails when the stated count
  differs. `site/web` has no tests on `master` yet: its line is required from its
  first test on, and refused once it has none.

### Measured

- `facts.py`: ok, with 31 `site/api` tests read from the source, the same number
  `node --test` reports. With the stated count set to 30 it named the mismatch;
  with one `site/web` test added and no line for it, it said so.
- `node --test` in `site/api`: 31/31. `vite build` passes.
## v1.0.0-stable — 2026-10-27 · W3.5–W3.7 checked against the code

### Changed

- W3.5, W3.6 and W3.7 of [the web platform](16-web-platform.md) were open in the
  roadmap although the site had shipped them. Read against the code, they are done:
  the ticker, the user menu and the Home, Analyze, Result and Login pages (W3.5);
  separate anonymous and account quotas, the address stored as a daily HMAC (W3.6);
  every string in English and Spanish (W3.7).
- Recorded as deviations, not changed: the palette and type are the desktop app's
  "Console" look rather than midesprojects.com's (whose Horizon font has no known
  licence), and the navigation is underlined tabs, not a pill. The rate limit's
  key becomes a hash with W3.17.

### Rejected / tried and dropped

- A pill navigation, as W3.5's row words it. Decided under the owner's delegation:
  the tabs belong to the app's look the site already adopted, work on a phone and
  with a keyboard, and a pill would change only the style, not what anyone can do.

### Hardening

- `site/web/test/i18n.test.js` holds W3.7 in place: it fails when a key exists in
  one language only, when a string's `{{placeholders}}` differ between the two,
  when a plural lacks its `_one` or `_other`, or when the code asks for a key that
  does not exist. `site/web` gets a `test` script for it.

### Measured

- `node --test` in `site/web`: 4/4; with one Spanish placeholder removed on
  purpose it failed on that key, as it should. `site/api` 31/31, untouched.
  `vite build` passes.
## v1.0.0-stable — 2026-10-27 · W3.18: the queue, moderated

### Changed

- W3.18 of [the web platform](16-web-platform.md), the first piece of W6's
  moderation panel: a Mides moderator sees on `/queue` a Remove button on every
  waiting or running job and Back to the queue on a running one, each asking for
  an optional reason, and the moderation log under the queue.
- `POST /api/v1/analyses/:id/moderate` and `GET /api/v1/analyses/moderation`,
  staff only; the new `moderation_log` table records who did what, when and why,
  in the same transaction as the change.
- A removed song's page says a moderator took it off the queue instead of
  suggesting the file was damaged.
- The dev login's Google user is a moderator, so the buttons can be tried without
  Mides.

### Fixed

- `site/api/docs/openapi.yaml` did not parse on this branch either (see W3.12);
  the same fix is carried here so the new paths could be added.

### Hardening

- Staff get an opaque `ref` on live rows, not the `id` that opens a result, and a
  private row still shows them no song and no uploader.
- A requeue keeps the attempt count, so the worker that had the job cannot
  overwrite the next attempt's answer; it is refused without its spooled audio.
- The log keeps the moderator's username at the time, so it still says who after
  the account is gone.

### Measured

- `node --test` in `site/api`: 36/36 (5 new, over HTTP with dev sign-ins: only
  staff may act or read the log; staff see a `ref` and a private row stays
  private; a removal fails the job, deletes its audio, tells the uploader and is
  logged with reason and username; a requeued job waits again, the old attempt is
  refused and the next claim's attempt is higher; no requeue without audio).
  `vite build` passes.
- Against PostgreSQL 18.6 (PGlite 0.5 behind `pglite-socket`, a temporary install
  outside the repository): `check` passes with 14 tables; remove, a second remove
  refused, requeue of a running job, its stale answer refused, a new claim at
  attempt 2, the log read back newest first.
- In the browser (`pnpm dev` in memory, signed in as the Google dev user): the
  staff row showed Remove and Back to the queue; a running job went back to
  position 1, a queued one was removed, and the log listed both with the reason.

---
## v1.0.0-stable — 2026-10-27 · W2.3: the worker against the pinned BPMs

### Changed

- `bench/worker_parity.py`: the 24 benchmark cases through `worker/timing_result.py`
  as a job runs them (the Beat This! vote on), each `timing-result v1` checked against
  `bench/bpm_snapshot.json` with its own tolerance (0.01 BPM): global BPM, every red
  line, their count, the meter and the engine path. `gates.py bpm-snapshot` pins the
  engine; this pins what the worker makes of it -- written-out parameters, snapping,
  the filter on non-finite points, the rounding into JSON. It imports neither
  `gates.py` nor the desktop shell, and refuses to run without the vote, since a host
  missing the model would differ for that reason alone.

### Measured

- Windows (Python 3.14.7, numpy 2.5.3, scipy 1.18.1, libsndfile 1.2.2, worker engine
  `88089672ec54bf2d`): **24/24** match. Wall time 10.8-37.3 s per case, 129 s for
  `long-6min`, on a machine shared with other runs.
- **Linux: not measured.** This machine has no WSL distribution (`wsl.exe` only
  prints its usage; turning it on needs admin and a reboot) and no Docker; the
  measurement server tracks `feature/library-api`, which has no `worker/`. On the
  VPS, in a clone of its own so the running server is untouched:

  ```bash
  git clone --branch bench/worker-parity https://github.com/Mides-Projects/Overtone.git /opt/overtone-w23
  cd /opt/overtone-w23 && git lfs install --local && git lfs pull && ls -la assets/models/beat_this_final0.onnx
  cd /opt/overtone-w23 && UV_PYTHON_INSTALL_DIR=/opt/uv-python ~/.local/bin/uv venv --python 3.14 .venv && grep -vE '^(bottle|clr-loader|proxy-tools|pythonnet|pywebview)==' python/requirements.lock > /tmp/w23.lock && ~/.local/bin/uv pip install --python .venv/bin/python -r /tmp/w23.lock
  cd /opt/overtone-w23 && .venv/bin/python bench/worker_parity.py && .venv/bin/python bench/gates.py bpm-snapshot
  ```

  W2.3 is done when both print 24/24 there.

### Rejected / tried and dropped

- Queuing the Linux run on the measurement server now (decided 2026-10-27, owner away
  and decisions delegated). `bench/remote.py run` only queues `stages` and
  `single_bpm` against the code the server already runs (`feature/library-api`, no
  `worker/`), so the gate cannot go through that queue. Switching the server's branch
  or opening an SSH shell beside it would cut into the engine experiment matrix it is
  running for hours, and the matrix's timings with it. So the run waits for the matrix
  to finish, then follows the steps above in a separate clone.

---

## v1.0.0-stable — 2026-10-27 · W3.17: one rate limit for every API process

### Changed

- W3.17 of [the web platform](16-web-platform.md): with a database, the request
  limits (`/api` 300 a minute, uploads 10 and lookups 120 per ten minutes,
  sign-in 20 per ten minutes) count in a new `rate_limits` table, one upsert per
  request, so two APIs behind the proxy share every count. Without a database
  they count in memory, as before.

### Hardening

- The address is no longer the key, even in memory: it is an HMAC under
  `SESSION_SECRET`, so the table holds no address (the rate-limit half of W3.6).
- A client alternating between two processes used to get twice every limit.
- If the table cannot be reached, the request is counted in the process's own
  memory and the outage is logged once: a limit must not take the site down.

### Measured

- `node --test` in `site/api`: 36/36 (5 new: the 429 and its Retry-After, two
  processes apart in memory and together on one counter, the counter seeing only
  the hash, the fallback when the count fails, a window starting again).
- Against PostgreSQL 18.6 (PGlite 0.5 behind `pglite-socket`, a temporary install
  outside the repository): `check` passes with 14 tables; two API processes on one
  database, twelve uploads sent alternately: ten passed, the 11th and 12th got 429
  (Retry-After 588 s) from whichever process they hit; `rate_limits` held the HMAC
  and the count, no address.
- Not measured: the upsert's cost on the server's PostgreSQL. It adds one write to
  every request; PGlite's timings say nothing about a real server.

---

## v1.0.0-stable — 2026-10-27 · W3.15: a batch in one ZIP

### Changed

- W3.15 of [the web platform](16-web-platform.md): under the cards of a batch, a
  button downloads `overtone-timings.zip` with the `timing.txt` of every song that
  is done. It is built in the browser from the results the cards already polled:
  no request, no server code, no dependency.
- `lib/zip.js` writes a stored (uncompressed) ZIP with UTF-8 names and a CRC-32;
  `lib/timing.js` writes each file exactly as the API's `timing.txt` does. Each
  card now hands the page its whole analysis, not only its status (W3.14).

### Hardening

- A name repeated within a batch (two `intro.mp3` from different folders) gets
  " (2)" before its extension, compared without case, so no entry hides another
  when unpacked on Windows.

### Rejected / tried and dropped

- Deflate. A `[TimingPoints]` block is a few kilobytes and a batch at most 50 of
  them: compression would save little and need a dependency or a hand-written
  deflater. The row asked for none if a stored ZIP would do, and it does.

### Measured

- `node --test` in `site/web`: 10/10 (6 new: the CRC against `zlib.crc32`, an
  archive read back entry by entry from its central directory, repeated names,
  an empty batch, the timing file byte for byte against the API's helpers, which
  songs go in). `vite build` passes.
- An archive from `zipStore` opens in Python's `zipfile` (`testzip()` clean) and
  in Windows' `Expand-Archive`, accented names included.
- In the browser (`pnpm dev` in memory, a fake worker): a batch of two finished
  songs offered "Download all 2 timings (ZIP)" and produced a 322-byte
  `overtone-timings.zip` whose first entry was `zip one-timing.txt`.

---

## v1.0.0-stable — 2026-10-27 · W3.14: a batch says when it is done

### Changed

- W3.14 of [the web platform](16-web-platform.md): while a batch runs, the tab's
  title carries its count ("2/5 ready · Overtone"), and goes back to the page's
  own title when the page is left. A checkbox under the list asks the browser for
  permission to notify; if granted, one notification says "3 of 5 songs have a
  timing" when the last one finishes.
- Each card reports the status it polls to the page, which is all the count
  needs: nothing leaves the browser that did not before.
- `site/web` gets a `test` script (`node --test`) for its pure modules.

### Hardening

- A file still uploading or waiting to upload counts in the batch's total, so
  two songs answered at once from the cache do not end a batch of five early.
- The notification is sent once per batch, only when asked for and granted; a
  browser that only notifies from a service worker (Android Chrome) gets the
  title alone instead of an error.

### Measured

- `node --test` in `site/web`: 4/4 (the count, the single-song case, the title,
  when the notification goes). `site/api` 31/31, untouched. `vite build` passes.
- In the browser (`pnpm dev` in memory, a fake worker answering one job at a
  time, `Notification` stubbed to record calls): the title read 0/3, 1/3 and
  3/3 ready; one notification, "3 of 3 songs have a timing."; the title came back
  on leaving the page.
- Not checked: a real system notification (the pane's permission prompt was
  stubbed).

---
## v1.0.0-stable — 2026-10-27 · W3.12: cancel your own queued song

### Changed

- W3.12 of [the web platform](16-web-platform.md): `DELETE /api/v1/analyses/:id`
  takes back a song that is still waiting. Whoever may read the analysis (the
  session or the anonymous cookie that created it) may cancel it; anyone else
  gets the same 404 as for an id that does not exist. The job, the row and the
  spooled audio are deleted, so the song does not count against the day's quota.
- A Cancel button on the upload card, on the analysis page while it is queued and
  on the caller's own queued rows in `/queue`. A cancelled analysis is dropped
  from the browser's recent list.

### Fixed

- `site/api/docs/openapi.yaml` was not YAML since W3.11: a `$'` in that edit's
  replacement string meant "the text after the match", which pasted a second copy
  of the queue and analysis paths into the lookup's `sha1` pattern. Two unquoted
  descriptions did not parse either. It loads again, each path once.

### Hardening

- A song the worker has claimed is not cancelled (409 `NOT_QUEUED`): the worker
  has no way to hear about it mid-stage. The delete checks `state = 'queued'` in
  the same statement, so a claim and a cancel arriving together are decided by
  the job's row lock, not by whichever read first.

### Measured

- `node --test` in `site/api`: 34/34 (3 new, over HTTP against the app: the
  owner cancels and the row, the audio and the quota count go; a stranger gets
  404 and a request without the same-origin header 403; a claimed job gets 409).
  `vite build` passes.
- Against PostgreSQL 18.6 (PGlite 0.5 behind `pglite-socket`, a temporary install
  outside the repository): `schema.sql` applied twice; a queued analysis
  cancelled, the day's count went from 2 to 1; a claimed one refused.
- In the browser (`pnpm dev` in memory, no worker): cancelled from `/queue`, from
  the analysis page (back to `/analyze`) and from a batch card; the queue showed
  each one gone.

---
## v1.0.0-stable — 2026-10-27 · W3.13: M4A and WAV tags

### Changed

- `site/web/src/lib/tags.js` reads the `©nam`/`©ART` atoms of MP4/M4A
  (`moov > udta > meta > ilst`) and the `INAM`/`IART` strings of a WAV's
  `LIST/INFO` chunk, or an `id3 ` chunk through the existing ID3v2 parser. Both
  are found by walking box and chunk headers with `file.slice`, because encoders
  often put `moov` after `mdat` and tagging tools append `LIST` after `data`,
  past the 256 KB head. A `moov` over 8 MB or a chunk over 1 MB is skipped, and a
  walk stops after 512 headers. INFO strings are UTF-8 when valid, else Latin-1.
- `site/web` has a `test` script (`node --test`), its first.

### Measured

- `pnpm --dir site/web test`: 13/13, with every fixture built in the test (M4A
  with `moov` before and after a 300 KB `mdat`, a 64-bit box size, WAV with INFO
  before and after a long `data`, UTF-8 and Latin-1 strings, an `id3 ` chunk,
  untagged files, garbage and truncated sizes, plus one ID3v2 and one Vorbis case
  for the old paths). `vite build` passes; `site/api` stays 31/31.
- Not checked: a real M4A from iTunes or ffmpeg, or a WAV tagged by a real
  editor; the fixtures follow the specs, not any one tool's output.

---
## v1.0.0-stable — 2026-10-27 · Beat This! without ONNX Runtime's memory pattern

### Changed

- `_load_beat_this` turns off `enable_mem_pattern`. The pattern plans a buffer layout
  per input shape and keeps it; the vote runs 1500-frame chunks plus a last chunk of
  another length on every song, so it only adds to the peak.

### Measured

- Beat This! alone over three Corpus B songs (135, 257 and 477 s) in one process,
  ONNX Runtime 1.31.0, this PC with other sessions' runs in the background: peak
  working set 1904 MB (twice) -> 1278 MB. CPU seconds 116 / 179 / 392 against
  120-121 / 238-248 / 422-507 for the default. Every beat of the 1425 within 1 ms
  of the default's.
- Gates: see the PR.

### Rejected / tried and dropped

- `enable_cpu_mem_arena = False`: 1045 MB, beats identical, but the CPU cost moved
  between +23 % and -27 % per song; not a clear win on a contended machine.
  Both switches off: 991 MB at +40 % CPU.
- Dynamic int8 quantisation (`quantize_dynamic`, QInt8): the model shrinks 83 -> 23 MB
  and the peak to 955 MB, but 2-4 % of the beats move by more than 1 ms and 1-2 %
  by more than 20 ms. That is a precision change; it waits for a Corpus B run.

---

## v1.0.0-stable — 2026-10-27 · Sign-in keeps no Mides token

### Changed

- The code exchange sends `app` and `MIDES_CLIENT_SECRET`, and Mides (branch
  `feat/web-sso-scoped` of Mides-Dev-Web) answers Overtone with an access token of
  audience `app:overtone`, no refresh token and the minimal profile. Overtone stores
  no Mides token: `keepMidesToken`, `refreshAccess`, `utils/secret-box.js` and
  `TOKEN_KEY` are gone, and `schema.sql` drops `mides_tokens` with any token in it.
- The account's role is now only "moderator" (Mides' `is_moderator`) or none; the
  global Mides role and the Discord id are no longer sent, so they are not kept.

### Hardening

- Before, the exchange took a bare code and Mides answered with the same session
  tokens as its own website, plus the full profile. A code stolen from a browser
  was a whole Mides account, and this server held a refresh token worth one for
  every user. Now a code is useless without this server's secret, and this server
  holds nothing a breach could use against Mides.

### Measured

- `node --test` in `site/api`: 31/31 (3 new, with `fetch` stubbed: the exchange's
  body, the profile mapping, a refused secret reported as 503 to the person and by
  name in the log). The Mides side is tested by its smoke (not run here: no Python).
- Not checked: a real exchange between the two servers. **Deploy order:** set
  `SSO_SECRET_OVERTONE` in Mides and `MIDES_CLIENT_SECRET` here to one value, merge
  Mides' branch, then deploy this one; until both are in, Overtone's sign-in fails
  closed (503).

---

## v1.0.0-stable — 2026-10-27 · The queue under concurrency

A security and performance review of the site (API, worker, web, deploy) found
five problems that show up only with parallel requests or a second worker. All
five are fixed here.

### Fixed

- **Two workers could take the same job.** The claim ranked queued jobs in a
  subquery and locked one with `SKIP LOCKED`, but neither the lock nor the
  `UPDATE` checked the job's state again. A worker whose snapshot predated
  another's commit got the same job once the lock was free: two analyses, and
  the first one's answer refused as stale. Both now check `state = 'queued'`.
  One worker never hit it; W3.10 would have.
- **A long analysis was timed out while it ran.** Only the claim set
  `jobs.locked_at`, so any song past `JOB_TIMEOUT_S` (900 s) went back to the
  queue however well its worker was doing. Each progress report now moves
  `locked_at` (a heartbeat); a worker that stops reporting is still swept.
- **Parallel uploads passed the quota and the pending cap.** The counts were read
  before the body and the row inserted after it, so K uploads at once all passed.
  The store now re-checks every limit inside the insert: PostgreSQL under a
  transaction advisory lock, the memory store with no await between check and
  insert. The early checks stay, to spare reading a body that would be refused.
- **`/lookup` could flood the public queue without any quota** (from W3.11).
  Each call made a finished row with the caller's tags, held only to the rate
  limit (about 17 000 a day from one address). Asking again for audio one already
  has today now returns that same analysis, and new stored-result copies have a
  daily cap of their own, `CACHE_DAILY_LIMIT` (100), refused with 429
  `CACHE_LIMIT`. The upload's cached path has the same rules.
- **Every poll of a queued analysis ranked the whole queue.** `GET /analyses/:id`
  now reads the position from the one-second queue snapshot that `/queue`
  already shares; only a row past its first 100 is ranked on its own. The
  snapshot keeps its promise, so requests arriving during a slow read wait for it
  instead of each starting one.

### Measured

- `node --test` in `site/api`: 28/28 (5 new: the refusal order, the cap on
  stored results, four parallel inserts against a cap of two, the heartbeat
  against the sweep, the reused copy). `vite build` passes.
- Against PostgreSQL (PGlite 0.3 through `pglite-socket`, a temporary install
  outside the repository): `schema.sql` applied twice; four inserts against a
  pending cap of two gave ok, ok, `PENDING_LIMIT`, `PENDING_LIMIT`; after an hour
  without reports the job that sent progress stayed running and the other went
  back to the queue; a second stored-result copy over a cap of one gave
  `CACHE_LIMIT`, and the same person's copy was found again. The claim's new SQL
  ran.
- Not checked: true parallel connections. PGlite serves one connection, so the
  advisory lock and the double-claim fix were run in sequence, not interleaved.
  The real check is two workers and parallel uploads on the server's PostgreSQL.
- By hand with `pnpm dev`: two uploads read positions 1 and 2 from the snapshot.

### Not fixed here

- The browser reads each whole file to hash it (one at a time, so one file's
  size in memory).
- If the web's port can be reached without the TLS proxy, `X-Forwarded-For` can
  be forged (`deploy/web/serve.mjs`); that depends on the panel's ports and is
  for the Reviactyl admin to confirm.

---

## v1.0.0-stable — 2026-10-27 · W3.11: ask before uploading

### Changed

- W3.11 of [the web platform](16-web-platform.md): before uploading, the browser
  hashes the audio (SHA-1, Web Crypto) and sends `POST /api/v1/analyses/lookup`
  with the hash, the file name, the size, the privacy switch and the tags. When the
  current engine has analysed that audio, the answer is a new analysis made from the
  stored result, exactly what uploading the same file would have given, and nothing
  is uploaded. Otherwise `{ cached: false }` and the upload goes on as before; a
  browser that cannot hash, or a lookup that fails, also just uploads.
- A hit costs no quota and no place in the queue, so it is not refused by the
  pending limit of W3.9, which an upload of a cached song was before it was read.
- The upload and the lookup build the queue's fields (privacy, tags, uploader) with
  one helper.

### Hardening

- The lookup has its own rate limit (120 per address per ten minutes), wider than
  uploads because it sends no audio. A hash gives the same trust the upload's cache
  already gave: knowing the SHA-1 of a file stands in for having it.

### Measured

- With `pnpm dev` and a fake worker: a lookup of new audio answered
  `cached: false`; after uploading it and finishing the job, two lookups answered
  `cached: true` with `done` and new ids, both shown on the queue under the tag sent
  with them; a malformed hash got 400 `BAD_SHA1`. `vite build` passes. `node --test`
  23/23, unchanged: the route has no test of its own yet.

---

## v1.0.0-stable — 2026-10-27 · W3.9: many songs at once, in fair turns

### Changed

- W3.9 of [the web platform](16-web-platform.md): the Analyze form takes several
  files, a dropped folder (opened recursively, audio only) or a folder chosen with
  "Choose a folder". They are sent one after another; each is its own analysis with
  its own card, which follows its upload, its place in the queue, its stage and its
  outcome, and links to its result. A single file still goes straight to its result
  page. A batch stops at the first refusal the rest would get too (quota, pending
  limit, full queue, rate limit, network).
- Limits, all set in `site/api/.env`: `ANON_MAX_PENDING` (3) and `USER_MAX_PENDING`
  (10) songs of one person waiting or running at once, refused with 429
  `PENDING_LIMIT`; `QUEUE_MAX` (200) for the whole queue, refused with 503
  `QUEUE_FULL`. Both are checked before the body is read, like the daily quota, which
  is unchanged. Without an account a person is the hashed address, as for the quota,
  so clearing the cookie does not reset it. `/health` reports the two pending limits.
- The queue is fair between people instead of first come, first served: each
  person's songs are numbered in the order they sent them, the queue takes every
  person's 1st before anyone's 2nd, and between equal turns whoever was served longest
  ago goes first (`jobs.claimed_at`, new). The claim, the position on a result page
  and the public queue all use the one order (`fairOrder` in memory,
  `FAIR_POSITIONS` in SQL).

### Fixed

- The first version of the fair order gave a batch's next song turn 1 again the
  moment its first one was taken, and it won the tie against a newcomer's 1st by being
  older: the batch still went first in full. The new test of claiming in a row caught
  it; the "served longest ago" tie-break is the fix.

### Measured

- `node --test` in `site/api`: 23/23 (4 new). `vite build`: 378 kB JS, 119 kB gzip.
- Against PostgreSQL (PGlite 0.3 behind `pglite-socket`, a temporary install outside
  the repository): `schema.sql` applied twice; three songs from one address, one
  private from another and one tagged from an account queued as positions 1 to 5 in
  the order batch, single, account, batch, batch; the claim, finishing each song
  before the next, took them in that order; `countPending`, the result-page position,
  the account's username on the queue and the last hour's list were right. That also
  covers the W3.8 queue query, which had not been run against PostgreSQL.
- In the browser (`pnpm dev`, in memory, no worker): five files, one of them
  `.txt`: three queued as positions 1 to 3, the fourth refused with the pending
  limit, the `.txt` refused before sending; at 375 px with no horizontal scroll.
- Not checked: two real people from two addresses taking turns in the browser (the
  dev machine is one address), a real worker, a real Mides account.

---

## v1.0.0-stable — 2026-10-27 · W3.8: the queue in sight

### Changed

- W3.8 of [the web platform](16-web-platform.md): `/queue` shows every analysis
  waiting or running and the ones that finished in the last hour: position, uploader
  (Mides avatar and @, or "anonymous"), song, status with the running stage and its
  progress, and how long it has taken. The page polls `GET /api/v1/analyses/queue`
  every 3 s while something is in the queue, every 10 s when it is empty, and not at
  all from a hidden tab. Polling rather than SSE: the answer is one snapshot shared by
  every viewer for a second, and the reverse proxy needs nothing new.
- The song is "Artist - Title" from the audio's own tags, read in the browser
  (`site/web/src/lib/tags.js`: ID3v2.3/2.4 for MP3, Vorbis comments for OGG, Opus
  and FLAC, from the first 256 kB) and sent as `X-Title`/`X-Artist`. Without tags it
  is the file name without its extension. The server parses no audio and gains no
  dependency.
- The upload form has "keep it off the public queue". A private row shows only its
  status, position and timing: no song, no file name, no uploader, not even whether
  it was signed in.
- `analyses` gains `private`, `tag_title` and `tag_artist` (`ADD COLUMN IF NOT
  EXISTS`), and two partial indexes for the queue's two reads.

### Hardening

- The queue never carries an analysis id except on the caller's own rows, so it
  cannot be walked into other people's results; it never carries the file's path,
  the account id, the anonymous hash or the audio hash. The route sits under
  `/api/v1/analyses` so the anonymous cookie, scoped to that path, still reaches it.

### Measured

- `node --test` in `site/api`: 19/19 (7 new, for the queue entry, the song label,
  the tag cleaning and the in-memory queue order). `vite build`: 373 kB JS, 118 kB gzip.
- By hand with `pnpm dev` (in-memory store, no worker: this machine had no `.venv`)
  and a fake worker over `/api/internal`: three uploads, one tagged, one private, one
  untagged, showed as "Camellia - Ghost" running at 40 %, a private upload at #1 and
  "my cool track" at #2; only the uploading cookie got ids. In the browser at desktop
  width and at 375 px. The tag reader returned title and artist for a hand-built
  ID3v2.3 and Vorbis head, and nothing for a file without tags.
- Not checked: a real PostgreSQL server (the window query was not run against one),
  a real Mides account's avatar on the page, and a real worker. The Python suite and
  the engine gates were not run (no `.venv` here); nothing under `python/`,
  `worker/` or `crates/` changed.

---

## v1.0.0-stable — 2026-10-26 · W2 + W3.4: the site analyses a song

### Changed

- Phases W2 and W3.4 of [the web platform](16-web-platform.md): on a dev machine
  `pnpm dev` starts the API, the web and an analysis worker, and a person can open
  http://localhost:5173, upload an audio file without an account, watch it queue and
  run, and get the real timing back: BPM, offset, meter, red lines, confidence per
  section, a refusal when there is no pulse, and `[TimingPoints]` to copy, as
  `timing.txt` or as CSV. How it fits together is in `docs/site.md`.
- `worker/`: `main.py`, an HTTP client of the API's `/api/internal` routes (claim,
  audio, progress, result, fail; one job at a time), and `timing_result.py`, which runs
  `analyze_audio` with a fresh install's defaults and writes `timing-result v1`. The
  engine is called directly: no desktop shell import, no saved settings, no engine edit.
- `site/api`: the upload streams to a spool file named by a 128-bit id, hashed on the
  way, with the size, format, quota and rate limit checked before it is read; songs,
  analyses and jobs in Postgres (`FOR UPDATE SKIP LOCKED`) or in memory without a
  database; a cache by audio SHA-1 and engine hash; retries after `JOB_TIMEOUT_S`
  with attempt numbers; `timing.txt` and `timing.csv`. `schema.sql` gains the
  columns idempotently.
- `site/web`: the Analyze page uploads with progress; `/analyze/:id` follows the queue
  and shows the result, EN and ES.
- `deploy/`: `PROXY_SECRET` between overtone-web and the API, which answers 404 to
  anything without it (the panel's ports are all public), `serve.mjs` never forwards
  `/api/internal`, and the worker egg's variables are the worker's.
- `bench/facts.py` counts every `tests/test_*.py`, as `unittest discover` does, and
  the roadmap line names the worker's tests.

### Hardening

- The audio is deleted on result, failure, last timeout and cache hit (ADR-W4); a
  file's name never becomes a path; the anonymous quota stores an HMAC of address and
  UTC day, never the address (ADR-W6); an analysis is readable only by the account or
  anonymous cookie that made it, with the same 404 as a missing one for anyone else;
  the worker token and the proxy secret are compared in constant time; a late answer
  from a timed-out attempt is refused (409).
- The worker finishes the job in hand on a first ^C and caps Beat This!'s ONNX Runtime
  threads at `WORKER_THREADS`, by wrapping the engine's loader from the worker.

### Measured

- End to end on the in-memory store, Beat This! vote on: `change-128-142.wav` came back
  as red lines at 400 ms / 128 BPM and 30 400 ms / 142 BPM in 11.7 s (worker 10.2 s);
  `_noise.wav` refused (`no_pulse`, no BPM) in 3.0 s; the second upload of the same
  file a cache hit; the spool empty after each. Through the browser form, a synthesized
  128-then-142 click track: 128 and 142.
- `tests/test_worker.py`: 9 tests in about 3 s (the fixture cut to 24 s, vote off).
  The suite: 784 tests OK in 788 s, 8 skipped (523 engine + 252 web shell + 9 worker;
  run in a fresh worktree with no `overtone-cli` built, whose tests skip themselves;
  W1's run had 1 skip). `pnpm --dir site/api
  test` 12 pass; `pnpm --dir site/web build` 363 kB JS, 115 kB gzip.
- `facts.py` ok; `fixtures.py` 38 = 38; `sbom.py --check` 40 wheels; `notices.py
  --check` 91 components, nothing missing; `egg.py --check` 4 eggs. `python/overtone.py`
  was not touched, so the engine gates were not re-run and nothing was re-baselined.
- Not measured: the PostgreSQL queue against a real server (no Postgres on this
  machine; the end-to-end runs used the in-memory store), the worker on Linux, and the
  cost per minute of audio (W2.4).

### Rejected / tried and dropped

- **Buffering the upload with `express.raw`**, as first planned: it would hold up to
  `MAX_UPLOAD_MB` in memory per concurrent upload. The body streams to disk with the
  same limit instead, the contract (a raw `application/octet-stream` body) unchanged.
- **A database driver in the worker**: it would add a Python dependency (lock, SBOM and
  notices gates) and a second owner of the queue. The API claims with `SKIP LOCKED`
  and the worker asks it over HTTP.
- **Reading the defaults from `overtone_web.Api`**: that shell is leaving the
  repository, and a server must never pick up a developer's saved settings; the
  defaults are written out in the worker.

---

## v1.0.0-stable — 2026-10-26 · W1: the unfinished desktop extras parked

### Changed

- Phase W1 of [the web platform](16-web-platform.md): master keeps timing. Four
  unfinished desktop extras left it, deleted rather than switched off, because every one
  of them is kept whole on the protected branch `parked/desktop-extras` and the tag
  `v3-desktop-full`.
- The app has ten sections: Library (open a song or a beatmap folder, recents), Timing,
  Structure, Map check, Mapset, Audio, Report, Export, History and Settings. The
  transport plays the song and the click; the mod report has four sources (reference,
  suggestion, snap, alignment).
- `overtone-cli` keeps `analyze`, `structure` and `ramps`; `analyze`'s output is
  unchanged (its stdout, plain, `--json` and `--full`, is the same before and after
  on 12 `bench/audio` files, `timings_s` aside).
- `bench/parity.py`: the Rust `.osu` reader lived in `overtone-hitsound`, so
  `read_osu_beatmap`, `read_osu_red_lines`, `sound_events`, `_TimingCursor`,
  `_is_red_line` and `_parse_red_line` are now `shell`, and 254 of 523 v3 engine tests are
  held in Rust. That is the reader parked, not a timing stage lost: every tempo stage
  is where it was.

### Parked

What went where, and why. W1's reason is the same for all four: the site is a timing
tool, and none of these had reached the bar it was built against.

- **Hitsounds** — the engine's hitsound half (writer, copier, proposals, hitsound
  difficulty, playback plan, sample bank, report, consistency and silence checks, genre
  classifier, object context), the Hitsounds view, the transport's hitsound playback and
  object lane, the Samples card, the Mapset copier and the hitsound-difficulty card,
  their bridge methods, `crates/overtone-hitsound` and the CLI's `hitsound`,
  `hitsound-evidence` and `hitsound-classify`, `profiles/`, `assets/kits.json`,
  `assets/samples/` with `assets/samples.py`, the benches `genre_corpus.py`,
  `genre_samples.py`, `fit_kits.py`, `sample_banks.py`, `eval_hitsounds.py`,
  `eval_proposals.py`, `eval_audio_only.py`, `templates_on_real_audio.py` and
  `labels.py`, and docs 06 and 15. Why: measured against mappers on 1,000 local maps the
  simple rules it had to beat scored clap-on-2-and-4 F1 0.59 and finish-on-downbeat F1
  0.42, and the audio-only proposal scored clap F1 0.29 against that 0.59 on 6 songs.
- **Compile** — `overtone_combine.py`, its view, its bridge methods and the `combine`
  gate.
- **Train** — `overtone_train.py`, `overtone_hotkey.py`, the view, the bridge methods
  and the `train` gate.
- **Library, the page only** — the Songs browser and the health check's page, and the
  bridge methods only they used. `overtone_library.py` and `library.sql` stay:
  `overtone_server.py`, `bench/stages.py`, `single_bpm.py`, `health_sample.py` and
  `mapper_agreement.py` read them, and Map check still asks the index for same-audio
  maps when one covers the folder.

### Kept on purpose

- `sound_events`, `_TimingCursor` and `MIN_SAMPLE_VOLUME`: the breaks, kiai and
  section-volume tools read what each object plays.
- `OBJECT_WINDOW_MS` and the stream/jump rule (`_pattern_class`, `_object_step`): the
  alignment and density reports use them; they sat in the hitsound object-context block.
- `HITSOUND_SAMPLE_NAME` in the bridge: Audio swap uses it to keep a mapset's samples
  out of its encode candidates.
- `ramps` still times the structure stage it no longer reads, so its report keeps its
  shape.
- `proto/timbre_group.py` still names `bench/labels.py`, which is parked: a prototype's
  record, left as written.

### Fixed

- The Compile strings redefined `no_audio`, so importing a beatmap folder without
  readable audio said "That song has no audio to read." It says what it was written to
  say again.

### Measured

- Every gate in CLAUDE.md that remains, on the final tree, 2026-10-26: the suite 775
  tests OK (523 engine + 252 web shell, 1 skipped); `benchmark.py` 24/24, median
  0.0000 BPM and 0.14 ms; `gates.py bpm-snapshot` 24/24 readings unchanged;
  `golden.py check` 27/27 stage for stage; `coverage`, `measures` (3/3), `signatures`
  (6/6), `robustness`, `reference` (24/24), `assisted` (70 marked sections) and `perf`
  (3 cases inside budget) pass; `real-audio` checks nothing here (no local library);
  `fixtures.py` 38 = 38; `parity.py` matches (254 of 523); `facts.py` ok;
  `fuzz_reader.py` 3000 mutants, no crash or hang; `sbom.py --check` 40 wheels;
  `notices.py --check` 91 components, nothing missing. Rust: `cargo test --workspace`
  231 passed; `overtone-bench` golden 27/27, nogrid, density 4/4 with 0 false
  positives, elastic and map pass. No accuracy number moved, so nothing was
  re-baselined.
- Tests: 1077 -> 775 Python (755 -> 523 engine, 322 -> 252 web shell), 292 -> 231 Rust.
- Size: 94 files, 31,620 lines out and 320 in against `origin/master`
  (`git diff --shortstat`), this entry included.

---

## v1.0.0-stable — 2026-10-26 · red lines read at their song's octave

### Changed

- `SECTION_OCTAVE_JUDGE` on: a red line near 2x or 1/2 of the tempo that holds
  most of its song is read at the song's octave where Beat This!, over that
  line's span, hears it there; a halved line keeps the phase nearest Beat
  This!'s beats. Report: a song at ~155 BPM with sections at 290-310.

### Measured

- Server, app engine, ranked and loved maps, jobs 1 (`section-octave` vs the
  base at 45b7cab): bands-variable held out tempo ok 57.7 -> 59.9 %, octave x1
  80.1 -> 82.4 %; dev unchanged (46.7 %, 83.5 %, beat F10 69.8 -> 69.9 %).
  anime-single held out unchanged (81.9 %, 94.3 %). anime-single dev not
  measured: the run was killed twice mid-way, likely memory.


---

## v1.0.0-stable — 2026-10-26 · local-tempo octave experiments, off by default

### Changed

- The local-tempo octave work, ported to the stable branch behind three
  flags, all off (v3 reads as it did): LOCAL_OCTAVE_FOLD doubles a local
  tempo below MAP_OCTAVE_RANGE; LOCAL_OCTAVE_HALVE reads one at 2x or 4x of
  the reading it replaced back at that octave, keeping the beats on that
  reading's (_thin_local); LOCAL_OCTAVE_JUDGE halves only where Beat This!
  hears the slower pulse (_beat_this_tempo, its own session, so the judge
  works where the vote is off, and asked only when a halving is in doubt).
- Server runs take `experiment` (local-fold, local-fold-halve,
  local-fold-judge): the flags set in the run's own process, caches of its
  own. An engine change is measured on the server before it is on.

### Rejected / tried and dropped

- In-between beat energy as the octave judge: on 24 songs whose local
  tempo doubled the tracker's, the slow ones read twice and the really fast
  ones overlapped at 0.6-1.0 (between/kept onset strength); the best cut
  saved two and broke one.

### Measured

- Server stages, app engine, ranked maps, 2026-10-26 (octave x1, dev /
  held out): anime-single base 91.7 / 92.4 %, local-fold 91.7 / 92.4,
  local-fold-halve 92.8 / 94.3, local-fold-judge 92.8 / 94.3;
  bands-variable base 81.1 / 79.4 %, local-fold 81.1 / 79.4,
  local-fold-halve 80.0 / 80.1 (dev maps at x0.5 32 -> 54),
  local-fold-judge 83.5 / 80.1 (x0.5 stays 32, x2 81 -> 68). Tempo ok
  unchanged everywhere; beat F at 10 ms -0.1 to +0.2. The judge is on by
  default from this entry; doubling alone changed nothing.

---

## v1.0.0-stable — 2026-10-26 · the suite and the gates as a server runs them

### Fixed

- A read-only .osu was rewritten on Linux: `_atomic_write_bytes` renames a
  finished temp file over the map, and a rename replaces a read-only file
  wherever its folder is writable. It now refuses a file it may not write,
  as Windows always did (robustness gate, first run on the owner's server).
- On a machine without pywebview, every Api method that names a dialog
  failed to import it (8 web tests on the server). overtone_web now takes
  the dialog names from the web host's stand-in there; the desktop window
  still needs the real package and says so.

### Changed

- Server gates leave out sbom and notices: they check the Windows build's
  venv and read the crates through cargo, where the installer is built.
- The updater pulls Git LFS files when git-lfs is installed: Beat This!'s
  model is one, and a clone without it holds a pointer (two Beat This!
  tests and perf's beatthis stage on the server).
- `/api/v1/runs/<id>/log` and `bench/remote.py log` give a run's whole log.

### Measured

- First server suite (34f449f, 2026-10-26): 1062 run, 11 failed: 8 the
  missing pywebview, 2 the LFS pointer, 1 to read. First server gates:
  15 of 19 pass, every accuracy gate among them (benchmark, bpm-snapshot,
  golden, reference, real-audio); robustness (the read-only map above),
  perf (the missing model), sbom and notices (the release build's) failed.
- After these fixes, on the server (6f4030d, 2026-10-26): suite engine
  748/748 and web 314/314, each in its own process; gates 17/17,
  robustness and perf among them. In one process the suite went past the
  3 GB cap: the OOM killer took the whole service three times (systemd's
  OOMPolicy=stop, then the largest process, the server). The server unit
  now has OOMPolicy=continue, each run volunteers to be killed first
  (oom_score_adj 800), and "all" runs the two modules one after the other.

---

## v1.0.0-stable — 2026-10-26 · a push updates the server

### Changed

- `.github/workflows/deploy.yml`: a push to `feature/library-api` signs in
  to the owner's server as `overtone-deploy` and starts
  `overtone-update.service`; that user's key runs that one forced command
  and nothing else (no shell, no forwarding, no terminal, key only), set up
  once by `deploy/setup-deploy-user.sh`. root keeps its key and password.
- `deploy/overtone-update.sh` does the update: fetch, fast-forward only,
  rebuild overtone-cli when the Rust code changed, restart. A run going or
  queued postpones it; a checkout left on another branch is left alone. Its
  timer runs it every five minutes as the fallback.
- CLAUDE.md / AGENTS.md, CI: GitHub Actions deploys and only deploys (the
  owner's decision); no check runs there, and the deploy key is the only
  secret.

### Rejected / tried and dropped

- Actions signing in as root: the server asks root for a key and a
  password, and neither belongs in a workflow's secrets.
- A webhook into Overtone: the server listens on 127.0.0.1 only, behind an
  SSH tunnel, and stays that way.

### Measured

- Not measured: the first deploy on the server is pending its setup.

---

## v1.0.0-stable — 2026-10-26 · gates and the suite on the server

### Changed

- Server runs take `gates` (every Python gate of CLAUDE.md, in its order,
  or the ones named) and `suite` (all of it, the engine's or the web
  shell's). Each runs as a person runs it from the repository root, its
  own process, the vote as installed; the report says which passed and,
  for the suite, which tests failed. From the Tests page and from
  `bench/remote.py gates|suite`. Asked for: the PC lagged under them.
- The bench reads the Songs folder from `OVERTONE_SONGS` when set (the
  real-audio gate on a server); runs set it to the server's.

### Fixed

- `RunQueue` read every run's `beat_vote`, which gates and suite runs do
  not have.

### Measured

- Not measured: the suite and the gates on the server are this entry's
  first job.

---

## v1.0.0-stable — 2026-10-26 · measuring what the app runs

### Changed

- `corpus_b.py`, `single_bpm.py`, `stages.py` and server runs take an
  `app` engine: the Rust engine, and v3 wherever Rust refuses or fails,
  as `overtone_web.run_analysis` does. Each answer records which engine
  gave it and what Rust said (`backend`, `rust_said`).

### Measured

- Why: the first server run (anime-single, ranked, Rust alone, 2026-10-26)
  counted 493 of 4,119 maps (88 songs) as refused, every one
  `no_coherent_pulse` (best share 0.25-0.55). The app answers those with
  v3: on 30 of the 88 songs, 12 at the map's tempo (within 0.05 BPM), 8 at
  the right tempo an octave off (x2: 274 for 137, 240 for 120), 10 wrong
  or refused. Rust alone measured a refusal the app does not make.
- Checked: Corpus B with `--engine app`, calm-down-juliet (Rust refuses)
  read by v3's tracker, 71 % of its red lines within 5 ms; martyr by Rust.

---

## v1.0.0-stable — 2026-10-26 · clean BPMs in what is written for osu!

### Changed

- What the app writes for osu! (copy, .osz, inject) carries clean BPMs, on
  by default (Settings, "Write clean BPMs"): each detected red line takes
  the cleanest BPM -- whole, then half, then tenth -- whose grid stays
  within 2 ms of the exact one over its whole span, its offset moved by
  half the drift; where none does, the tenth is kept and the span is cut
  into blocks of whole bars, each re-synced by a red line at that BPM.
  Ranked maps read better at 232.2 than at 232.189 (asked for). The
  analysis, the click track, the CSV and lines placed by hand keep their
  exact BPM; the engine is untouched (`overtone_web.clean_bpm_points`).
- The bound is the difference from the dropped attempt below: that one
  moved red lines to the tenth with no limit on the drift.

### Measured

- Corpus B, Rust engine, the same cached analyses scored twice by
  corpus_b's own scoring with the map lead (540 scored lines of the tracks
  the engine answered), 2026-10-26: within 2 ms 4.6 -> 4.6 %, 5 ms 11.5 ->
  12.2 %, 10 ms 24.8 -> 25.4 %, 50 ms 46.1 -> 46.1 %. Red lines written
  40 -> 51 (re-syncs: freedom-dive 333.329 -> 333.3 with 2, yui-again
  140.084 -> 140.1 with 7, torikago 113.95 -> 113.9 with 2); every written
  BPM on a tenth or rounder (51/51).

---

## v1.0.0-stable — 2026-10-25 · BPMs shown to the tenth

### Changed

- The results show BPMs to the tenth, whole when the tenth is .0 (240.175
  -> 240.2, 222.96 -> 223, 192.000 -> 192): the song's BPM, the timing
  points table, both detail panels, the red-line labels on the tempo map
  and the analysis toasts. Hovering shows the exact value. Exports, the
  edit field and the diagnostic tables (reference card, evidence,
  map comparisons) keep the exact BPM: rounding the exported red lines
  lost Corpus B points (the entry below), so it stays on the screen.

### Measured

- Checked in the page on this machine (2026-10-25): "If You Can't Hang"
  shows 192 with 192.000 BPM on hover; the toast reads the same in English
  and Spanish; no app.js error in the console. test_overtone_web 310/310.

---

## v1.0.0-stable — 2026-10-25 · BPMs rounded to the tenth: tried and dropped

### Rejected / tried and dropped

- Asked for: exported red lines at the nearest tenth of a BPM (240.175 ->
  240.2, 222.96 -> 223), as mappers type them. Tried as a second candidate
  after the whole BPM in `_snap_whole_bpm` and `_snap_whole_lines`, behind
  the same audio test (inliers kept >= 95 %, rms <= x1.2 + 0.5 ms), so a
  song's own fractional tempo (decimal-128.37) stays put.
- Every gate stayed green (benchmark 24/24, median 0.0000 BPM / 0.14 ms;
  bpm-snapshot 24/24 unchanged; golden 27/27; real-audio 6/6; perf), but
  Corpus B, Rust engine, the same build with and without it (2026-10-25):
  within 5 ms 5.4 -> 4.3 % of 540 scored lines, within 10 ms 11.6 -> 9.5 %,
  within 2 ms per track 5.1 -> 5.9 %, BPM within 0.05 unchanged (71/540).
  The loss is yui-again (live drift, 262 lines): within 10 ms 39 -> 29 %.
  torikago gained (within 2 ms 0 -> 17 %).
- Tenths on the sections only, whole BPMs only on the finished lines (drift
  following's included): the same 4.3 / 9.5 %, the same yui-again loss. The
  section's tenth itself is off the song's tempo and the drift lines are
  built on it.
- Dropped: a change that moves Corpus B down is a regression. A rounded BPM
  for reading (the app's display, the export untouched) remains open; it
  needs no engine change.

---

## v1.0.0-stable — 2026-10-25 · exports from the web page land on the person's computer

### Changed

- In the browser, an export (.osz package, CSV, click track) no longer asks
  where to save it on the server: it lands under exports, under a free name
  (`Song (2).osz`), and the page offers it for download to the computer it
  runs on -- through the browser's own save dialog where there is one
  (Chrome, Edge), else as an ordinary download. The notice follows the
  page's language.
- The bridge marks such answers (`download`): only files under exports, of
  an export kind, that exist. On a server the app's exports folder defaults
  to exports.

### Measured

- Checked by hand on this machine (2026-10-25): an analysed song's "Save
  .osz" wrote exports/audio.osz with no dialog, the page offered it, and
  the download endpoint returned all 1,129,566 bytes, a valid zip.

---

## v1.0.0-stable — 2026-10-25 · stages scored on ranked and loved maps only

### Changed

- `bench/stages.py --ranked-db <osu!.db>` keeps only the maps the local
  osu!.db lists as ranked, approved or loved (read by
  `mapper_agreement.parse_osu_db`, matched by song folder and file name,
  case ignored), counts the rest in one skipped line, and keeps its own
  report and baseline (`<stage>-<engine>-ranked.json`), since the two
  answer different questions. Server runs use it by default whenever an
  osu!.db sits beside the Songs folder (`--osu-db` to name another).

### Fixed

- The stages took every map that matched a stage's condition as truth,
  graveyard timings included: a map whose own red lines are wrong counted
  as an engine failure.

### Measured

- `bench/stages.py --list` over this machine's index (4,879 sets) and its
  osu!.db (v20260924, 19,574 ranked, approved or loved maps), 2026-10-25:
  anime-single 832 -> 749 songs (4,611 -> 4,119 maps), anime-variable
  491 -> 433 (2,599 -> 2,278), bands-variable 339 -> 167 (1,540 -> 887).
  Half the bands stage was unranked. How the engine scores on the ranked
  part: not measured yet (the server's first full runs).

---

## v1.0.0-stable — 2026-10-25 · measurement runs on the server

### Changed

- `overtone_runs.py`: the server runs `bench/stages.py` and
  `bench/single_bpm.py` over the Songs folder it holds, one run at a time,
  each in its own process, and keeps each in a folder (what was asked, the
  commit that answered, the log, the tool's own JSON report). A run the
  server died under is marked interrupted on the next start.
- `/api/v1/runs` queues, lists, shows, stops and serves them; the web page
  has a Tests page (`app/runs.html`); `bench/remote.py` drives them from a
  PC through the tunnel.
- Nothing in the engine or the bench changed: a run calls the tool's own
  `main` after turning the Beat This! vote off when asked and pointing the
  caches at one tree per vote setting (the tools' cache keys name the
  engine's code, not the vote). Parallel analyses fork from that process
  and keep both; on Windows, which cannot fork, a vote-free run analyses
  one song at a time.

### Fixed

- A request answered before its body was read (a 401, a 404) could reach
  the client as an aborted connection on Windows: the socket closed with
  unread bytes and reset. Small unread bodies are now drained first.

### Hardening

- A run request is translated into the tool's arguments field by field
  (tool, stage, engine, split, jobs 1-8, counts, two flags, baseline); it
  can never name a path or a flag of its own. Run ids are matched against
  their pattern before any file is opened.

### Measured

- On this machine, through `bench/remote.py` against the local server and
  the real Songs folder (2026-10-25): anime-single, dev part, first 5
  songs, Rust engine without the vote: 30 maps, 0.6-1.4 s a song, 33 s
  for the run; tempo ok 100.0 %, joint 5 ms 0.0 %, conv. 10 ms 73.3 %,
  signed error +35.8 ms. Five songs: a smoke test of the pipeline, not a
  reading of the engine.

---

## v1.0.0-stable — 2026-10-25 · the app as a web page

### Changed

- `overtone_server.py` serves `app/` at `/`: the same page as the desktop
  window, signed in at `/login` with the server's token, its analyses
  running on the server. `app/web.js` carries the pywebview bridge over HTTP
  (`POST /api/v1/bridge/<method>`) when the page comes from http(s), and
  does nothing when the desktop window loads it from disk.
- `overtone_webhost.py`: the Api's one push into the page (`evaluate_js`)
  becomes server-sent events, replayed by `Last-Event-ID` after a reconnect;
  the six native file dialogs become a dialog the page draws -- upload from
  the browser, or pick what the server holds -- while the Api thread waits
  for its answer, so no Api method changed.
- On a server, the page's Songs folder is the server's.
- Rule 6 (CLAUDE.md, AGENTS.md) reads "offline by default": a server is
  opt-in, the user's own, and gets only what the work needs.

### Hardening

- The browser reaches files only under Songs, `uploads` and `exports`
  (real paths, so `..` and links cannot leave them); uploads are written
  under a cleaned name, atomically, up to 1 GiB.
- Sessions are HttpOnly, SameSite=Strict cookies signed with a key drawn
  from the token (Secure behind an HTTPS proxy); a cookie alone changes
  nothing without the page's `X-Overtone` header; a wrong token at
  `/login` costs a second. The bridge reaches public Api methods only.

### Measured

- Through the page, on this machine (2026-10-25, the server on 127.0.0.1):
  "Shiggy Jr - oyasumi" opened from the server's Songs through the web
  dialog, analysed to 200.00 BPM on the precision grid with live progress;
  a scan of the 4,882-folder Songs folder reported its progress live.
  Request latency and throughput: not measured.

### Rejected / tried and dropped

- In-memory sessions: every server restart signed the page out.
- Reading `webview.OPEN_DIALOG` and friends to name a dialog: pywebview 6
  warns on every read; `FileDialog` is read when present, and a stand-in
  module supplies the names on a server without pywebview.

---

## v1.0.0-stable — 2026-10-25 · the library API and its BPM cache

### Changed

- `python/overtone_server.py`: the library index over HTTP (standard
  library only, JSON, a bearer token on every request, 127.0.0.1 by
  default) for a machine that holds the Songs folder, such as a VPS.
  Scans and analyses run as background jobs, one of each at a time;
  `--every` repeats scan-then-analyse. Setup in `docs/server.md`.
- The library index gains its BPM cache (schema v3, table `analysis`,
  `Library.analyze`): one row per audio file a beatmap plays, kept while
  the file's size and mtime and the engine's code are unchanged, so a rerun
  reads only what is new. The fingerprint is `bench/corpus_b.py`'s (overtone.py,
  plus the bridge and the binary for Rust) and also names whether the
  Beat This! vote ran, since the vote moves red lines.
- `--no-beat-vote` turns the vote off for the server's process.

### Hardening

- A refusal is a verdict (`refused`, the engine's reason, no BPM), not a
  guess; an unreadable file is `error`, a missing one `no_audio`.
- The token is compared in constant time, generated once into the data
  folder with mode 0600 when none is given; request bodies are capped at
  64 KiB and must be a JSON object.

### Measured

- One 90 s fixture (`breakdown-175.wav`), this machine, 2026-10-25, peak
  working set: `overtone-cli` alone 56 MB, 0.43 s; the Rust path as the app
  runs it (bridge, octave and whole-BPM conventions, Beat This! vote)
  1.46 GB, 49.9 s; the same without the vote 101 MB, 2.3 s, same 175.000
  BPM; v3 `analyze_audio` 1.78 GB, 42.0 s. Hence the Rust engine is the
  server's default, two jobs at a time without the vote, one with it.
- Whole-Songs-folder throughput: not measured (no VPS run yet).

### Rejected / tried and dropped

- A web framework (FastAPI/uvicorn): it would add wheels to inventory for
  six JSON endpoints that the standard library serves.
- Setting the server's status from the loaded ONNX session: the first load
  took over 10 s on a busy machine and timed the endpoint out; status now
  reads whether the runtime and the model are present, and only an
  analysis loads it.
## v1.0.0-stable — 2026-10-25 · notes pinned to the song

### Changed

- Timing has notes: type one and *Add note at the playhead*, and it shows
  as a flag over the waveform and a row under the transport. The time
  seeks there, the text edits in place, and × (or clearing the text)
  deletes it.

### Fixed

- Nothing.

### Hardening

- Notes live in `<song> [hash].notes.json` beside the song's project,
  written atomically and keyed by the audio's SHA-256, so they follow the
  bytes, not the name. They are kept apart from the project on purpose:
  restoring saved timing, or undoing it, never takes a note away. With
  projects off (tests, the UI harness) they stay in memory. A note is
  1-500 characters at a time inside the song; 500 notes per song at most.

### Measured

- Not measured: no engine path changes. Checked in the page through the
  UI harness on a 20 s synthetic 128 BPM drum track: two notes added in
  time order, one edited, one deleted, the flag drawn at 5.25 s, Spanish
  strings, no console errors.

---

## v1.0.0-stable — 2026-10-25 · the single-key shortcuts move

### Changed

- In the keyboard sheet (?), each single-key action -- play, tap, loop,
  click, previous/next red line and the sheet itself -- is a button: press
  it, then the new key. *Default keys* puts them all back. The chords
  (Ctrl+O/Z/Y/K), the arrows, Enter/F5, Esc and the digits that walk the
  menu stay where they are: they are conventions, and moving them would
  only make the app harder to learn.

### Fixed

- Nothing.

### Hardening

- The bridge refuses a key another action already holds, a digit, Enter,
  F5, Esc, Tab or an arrow, so no action can become unreachable. A
  hand-edited set that breaks a rule falls back to the defaults as a
  whole, never half. Only moved keys are saved.

### Measured

- Not measured: no engine path changes. Checked in the page through the
  UI harness: L moved to O (Shift ignored until a real key), O refused for
  Click with the toast, *Default keys* restores L, Spanish strings shown,
  no console errors.

---

## v1.0.0-stable — 2026-10-25 · Ctrl+K finds any action

### Changed

- **Ctrl+K** opens a command palette: every section, Open audio, Analyze,
  Undo, Redo, the keyboard sheet, and every enabled button the open
  section shows. Type words in any order (accents ignored), arrows pick,
  Enter runs. Listed in the keyboard sheet; English and Spanish.

### Fixed

- Nothing.

### Hardening

- The list is read from the page when the palette opens, not kept by
  hand, so a button added later is in it without anything else to
  update, and a disabled or hidden one is not.

### Measured

- Not measured: no engine path changes. Checked in the page through the
  UI harness: 23 entries on the empty Library page, "sett" + Enter opens
  Settings, "seccion biblio" finds Biblioteca in Spanish, no console errors.

---

## v1.0.0-stable — 2026-10-25 · settings carried to another PC

### Changed

- Settings has a **Settings file** card: *Save settings…* writes the page's
  values to a JSON file, *Open settings…* reads one back. Recent files,
  window state and per-song options stay on this PC.

### Fixed

- Nothing.

### Hardening

- The file is written atomically. On opening, each value goes through
  the same checks as the page (`set_settings`), one by one: a value this
  PC cannot use, such as a folder that does not exist here, is skipped
  and named in the toast instead of sending every export nowhere. A file
  without the `overtone_settings` marker, or with broken JSON, or over the
  config size cap, changes nothing; a BOM is read.

### Measured

- Not measured: no engine path changes.

---

## v1.0.0-stable — 2026-10-25 · the command line watches a file

### Changed

- `--watch` analyses the audio once, then again each time it is saved,
  with every other option given (`--csv`, `--inject`, `--json` ...).
  Each run is a fresh process, so a run that fails or exits 3 leaves the
  watch going.

### Fixed

- Nothing.

### Hardening

- A save counts once the file holds still for one poll, so a render still
  being written is not analysed half done; a file deleted and renamed back
  by its editor is waited for. Tests drive both with a scripted clock.

### Measured

- Not measured: no engine path changes. The poll is 0.5 s.

---

## v1.0.0-stable — 2026-10-25 · every finished red line at the whole BPM

### Changed

- The precision path reads its finished red lines at the whole BPM beside
  them where the song's attacks agree (`_snap_whole_points`, the test
  `_snap_whole_bpm` already applies to sections: within 0.5 BPM, at least
  95 % of the inliers kept, rms no worse than x1.2 + 0.5 ms), after drift
  following and the Beat This! vote, in both engines; lines that then
  continue each other merge into one.
- `bench/stages.py --split dev|holdout` analyses one part only (the conv.
  figures then have no dev convention and are not read).

### Fixed

- Mappers time anime at whole BPMs, but drift following and the vote wrote
  lines a few hundredths off them (ASCA - Selfrontier: 142.08 / 141.94 /
  141.75 for one 142 line), and `_snap_whole_bpm` runs on the sections
  before either. That, not the vote alone, was S1's tempo-ok loss: the snap
  on the vote's lines only changed no held-out song.

### Hardening

- Two tests: lines a few tenths off a whole BPM snap and merge; a fractional
  BPM the attacks keep (128.37) is kept.

### Measured

- S1 anime-single, master `e20e56a` -> this change. Dev (571 songs): tempo
  ok 73.5 -> 77.2 %, conv. 10 ms 62.7 -> 64.7 %, beats within 10 / 20 ms
  76.2 / 91.3 -> 77.0 / 91.4 %, octave 90.5 % unchanged. Held out (243
  songs): tempo ok 68.7 -> 75.9 %, conv. 10 ms 56.4 -> 61.1 %, beats within
  10 / 20 ms 72.4 / 88.6 -> 72.5 / 88.7 %, octave 89.5 % unchanged.
- S2 held out, beats within 10 / 20 ms 67.3 / 84.6 -> 67.2 / 84.6 %; S3 held
  out 45.9 / 63.4 -> 47.0 / 63.4 %, octave 73.7 % unchanged.
- real-audio: noble 163.9733 BPM / 17 red lines -> 164.0 / 14, on purpose
  (its drift lines read at the whole BPM); re-pinned. Every other gate
  passes: 1026 Python tests, benchmark 24/24 (median 0.0000 BPM, 0.14 ms),
  bpm-snapshot 24/24, golden 27/27, coverage, measures, signatures,
  robustness, reference 24/24, assisted, combine, perf, fixtures, parity,
  fit_kits, facts, fuzz_reader, sbom, notices. Rust not rebuilt: no crate
  changed.

### Rejected / tried and dropped

- The snap on Beat This!'s lines alone: no held-out S1 map changed.
## v1.0.0-stable — 2026-10-25 · a config saved by Notepad is read, not reset

### Changed

- Nothing a user sees, unless they edited `config.json` by hand.

### Fixed

- `load_config` read the file as plain UTF-8, so a config saved by Notepad
  (which writes a BOM) failed `json.loads` and both shells silently started
  from defaults. It now decodes `utf-8-sig`. That closes the roadmap's
  "Config type checks" row: wrong types were already dropped in both shells
  (they share `load_config`), the BOM was the last silent reset.
- The roadmap's "CSV save errors" row was stale: both the classic window and
  the web shell already turn a locked CSV into an error message, with tests
  (`test_overtone.py`, `test_overtone_web.py`). Marked done.

### Hardening

- The config test writes a BOM-prefixed file and expects it read.

### Measured

- Not measured: no engine path changes.

---

## v1.0.0-stable — 2026-10-24 · score Corpus B as osu! exports it

### Changed

- `bench/corpus_b.py` applies the default 28 ms osu! map lead when scoring
  red lines, matching the app's default export. `--map-lead-ms 0` reproduces
  the raw engine-grid score; cached analyses remain unchanged.

### Fixed

- The Corpus B headline no longer omits the output adjustment users get by
  default, so it measures the exported `.osu` timing rather than the internal
  grid.

### Hardening

- A scoring test checks the zero-lead baseline, the default shift, unchanged
  BPMs and rejection of non-finite lead values.

### Measured

- On the same 20 local Corpus B maps (1,152 red lines), Python rises from
  2.0 % to 16.8 % within 5 ms; Rust rises from 1.1 % to 5.2 %. Python's
  within-50 ms share is 55.4 % raw and 55.7 % with the lead. All maps were
  present and matched their manifest hashes; no songs were added to Git.
- `--map-lead-ms 0` reproduces the raw scores. Python and Rust analyses came
  from the cache, so the before/after comparison uses the same engine results.

### Rejected / tried and dropped

- None.

---

## v1.0.0-stable — 2026-10-25 · the full stages with Beat This! voting

### Changed

- Nothing in the engine; numbers only.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- `bench/stages.py <stage> --compare` on master `4ff81cf` (the Beat This!
  vote on), every song analysed again, against the stage baselines; held
  out, with the 2026-10-23 full-stage figures (before the vote) in brackets:
  - S1 anime-single (1,462 maps): beats within 10 / 20 ms 72.4 / 88.6 %
    (72.4 / 87.2), octave 89.5 % (90.4), tempo ok 68.7 % (71.1), conv. 10 ms
    56.4 % (57.1).
  - S2 anime-variable (685 maps): beats within 10 / 20 ms 67.3 / 84.6 %
    (66.1 / 83.5).
  - S3 bands-variable (495 maps): beats within 10 / 20 ms 45.9 / 63.4 %
    (43.8 / 60.1), octave 73.7 % (72.9).
- The vote helps the stages with tempo changes and leaves S1's beats where
  they were, but costs S1 2.4 points of tempo ok: where it takes over a song
  the mapper timed with one whole-BPM red line, its lines carry fractional
  BPMs. The 60-song samples had shown S1 +1.1 at 10 ms; the full stage does
  not.
- The run was interrupted by a shutdown after S2 and resumed from the
  cached analyses (106 of S1's 832 songs).

### Pending (next session)

- Read Beat This!'s lines at the whole BPM where the attacks agree (as
  `_snap_whole_bpm` does for the engine's), or keep the engine's single red
  line when the vote's tempo matches it, and measure S1 again.
- redline-v1 (Tiger14n, trained on ranked osu! maps) on the seeded samples:
  running. Its repository carries no licence, so it can be measured here
  but not shipped without the author's permission.

---

## v1.0.0-stable — 2026-10-24 · the installer with Beat This! inside

### Changed

- `installer/notices.json` states the Python (3.14.7) and Tcl/Tk (9.0:
  tcl90.dll, tcl9tk90.dll, its licence read from `tcl/tk9.0/demos/
  license.terms`) this venv was rebuilt on; `notices.py --check` had failed
  on both since that rebuild, before this session's changes.

### Fixed

- `installer/notices.py --check` passes again: 91 components, 160 notice
  files, 5 source offers, nothing missing.

### Hardening

- Nothing.

### Measured

- `installer/build.py --clean` on master `3f1b2fc`: build ok in 544.8 s.
  Tree 753 files, 439.4 MB; Overtone-0.2.0-alpha-x64.msi 200.0 MB (112.2 MB
  on 2026-10-06, before onnxruntime and the 83 MB model), portable ZIP
  228.7 MB (138.2 MB). ICE: warning ICE61 x1, ICE91 x753 (per-user install,
  as before). The smoke test passes on dist\Overtone, the MSI's
  administrative install and the unpacked ZIP: 174.0000 BPM from both
  engines, self-check 8/8, the portable build writing only to data\.
- The model and onnxruntime's DLLs are in the tree
  (`_internal/assets/models`, `_internal/onnxruntime/capi`), and the frozen
  `overtone-py.exe` votes: on Pierce The Veil - A Match Into Water, where
  the vote turns 1 red line into 332, it writes the same 332 red lines as
  the development engine, byte for byte.

---

## v1.0.0-stable — 2026-10-24 · Beat This! votes (owner decision)

### Changed

- Beat This! (CPJKU, MIT; checkpoint final0) runs inside the engine as an
  extra beat voter, through onnxruntime and without PyTorch: the network is
  `assets/models/beat_this_final0.onnx` (83.2 MB, Git LFS, provenance and
  SHA-256 in `assets/models/beat_this.json`, export recipe in
  `proto/beat_this_export.py`); its log-mel input and peak picking are
  Overtone's own numpy (`_beat_this_spectrogram`, `_beat_this_beats`). After
  the octave, whole-BPM and drift conventions, on the precision path only,
  its beats as red lines replace the engine's where they explain the song's
  attacks better by 0.05 (attack-to-beat F-measure at 15 ms,
  `_beat_this_vote`). `analyze_audio(beat_vote=False)` turns it off; the
  Rust result gets the same vote through `overtone_rust.analyze`.
- A new analysis stage, "Checking the beats with Beat This!…" (`beatthis`),
  shown in the app in EN and ES.
- `onnxruntime==1.31.0` with `flatbuffers==25.12.19` and `protobuf==7.36.2`
  in the lock (`onnxruntime>=1.31` in requirements.txt), the SBOM
  regenerated (40 wheels), the model and its licence in the installer's data
  and in notices.json (a new `from_repo` source for files the repository
  ships); flatbuffers (Apache-2.0) and protobuf (BSD-3-Clause) named in its
  terms, as their wheels carry no licence text.

### Fixed

- Nothing beyond the above.

### Hardening

- Without the model file or onnxruntime the vote is skipped, never an error.
- A checkout without Git LFS holds a pointer instead of the model; a test
  checks the model's size and SHA-256 against beat_this.json.

### Measured

- Inside the engine, Beat This!'s beats against its own (torch) beats on 6
  dev songs: 96.4-99.6 % identical within 0.5 ms (the app decodes the audio
  its own way).
- The shipped engine, held out (60 songs a stage), beats within 10 / 20 ms
  of the map, vote off -> on: S1 80.5 -> 81.6 % / 92.0 -> 93.7 %, S2 64.3 ->
  65.2 % / 85.1 -> 86.6 %, S3 40.7 -> 43.7 % / 64.3 -> 69.8 %. It took over
  on 2, 4 and 6 of the 60 songs.
- Cost (perf gate, re-pinned for the new stage): `beatthis` 6.7 s wall
  (39 s CPU, onnxruntime on every core) on edm-174 and 29.3 s wall (170 s
  CPU) on long-6min; every other stage unchanged.
- Gates: 1024 Python tests, benchmark 24/24, bpm-snapshot 24/24, golden
  27/27 Python and Rust, real-audio 6/6, perf (re-pinned), every other gate
  run passes, `sbom --check` ok. `installer/notices.py --check` still fails
  only on what it failed on before this change: the venv's Python 3.14.7
  and Tcl/Tk 9.0 against notices.json's 3.14.4 and 8.6. Not run: an MSI
  build with the model inside.

---

## v1.0.0-stable — 2026-10-24 · Beat This! through ONNX, without PyTorch

### Changed

- Nothing in the engine or the app; a measurement of what shipping Beat
  This! would cost without PyTorch.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- The network exported to ONNX (opset 17, time axis dynamic): 83.2 MB.
  ONNX Runtime against PyTorch on the same spectrogram: max difference
  2e-5 at 1500 and 900 frames.
- The rest without PyTorch: the log-mel spectrogram in numpy (22.05 kHz,
  1024-point FFT, hop 441, 128 Slaney bands 30 Hz-11 kHz, divided by
  sqrt(n_fft) as torchaudio's normalized="frame_length" does) matches
  torchaudio within 2e-4; the minimal peak picking in numpy. On 20 dev
  songs (53 min of audio), fp32: every beat identical to Beat This!'s own
  (within 0.5 ms, 100.00 %), the network 5.4 s per minute of song on this
  CPU, the spectrogram ~0.14 s a song.
- int8 dynamic quantisation: 23.0 MB, no faster (5.5 s per minute), 96.44 %
  of beats identical -- not worth it.
- onnxruntime 1.31.0 ships a cp314 win_amd64 wheel (15.3 MB, 48 MB once
  installed), so the app's Python 3.14 can run it: about 130 MB on disk with
  the fp32 model, against ~730 MB for PyTorch.

### Rejected / tried and dropped

- int8 weights (above). A first numpy spectrogram divided by the window's
  energy instead of sqrt(n_fft) and moved 14 % of the beats.

### Pending (owner decision)

- Integrating the voter: onnxruntime as a dependency (SBOM, notices), the
  83 MB model in the installer, ~5 s more per minute of song; for the held-
  out gains measured in the previous entry (+1 to +3 points within 10 ms).

---

## v1.0.0-stable — 2026-10-24 · Beat This! as an extra voter (10.3)

### Changed

- Nothing in the engine or the app; a measurement. Beat This! (CPJKU, MIT
  code and weights, checkpoint `final0`, CPU) ran in its own environment
  outside the repository (Python 3.12, torch 2.14.1+cpu, 732 MB with the
  model); the app's dependencies, lock and SBOM are untouched.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- The seeded stage samples (40 dev / 60 held-out songs a stage, 298 files;
  7 failed to decode in Beat This!, ~4-12 s a song on CPU), beats within
  10 / 20 ms of the map:
  - Beat This! alone is worse at 10 ms (held out S1 53.4 %, S2 49.2 %, S3
    42.8 % against the engine's 80.5 / 64.3 / 40.7 %): its beats come on a
    50 fps grid, so they sit up to ~10 ms off; at 20 ms it beats the engine
    on S3 (67.1 against 64.3 %).
  - As a voter -- its beats, made red lines with `_beats_to_lines`, replace
    the engine's where they explain the song's own attacks better by 0.05
    (F-measure at 15 ms), chosen on dev -- held out: S1 80.5 -> 81.6 %
    (F20 92.0 -> 93.7), S2 64.3 -> 65.1 % (85.1 -> 86.4), S3 40.7 -> 43.5 %
    (64.3 -> 69.5). The first variant this session that gains on every
    stage on both splits.
  - Only on the songs the precision engine refuses: worse everywhere (held
    out S3 40.7 -> 36.5 %); the local-tempo tracker stays there.

### Pending (owner decision)

- Shipping it means PyTorch and the model in the installer (~730 MB on
  disk against today's 112 MB MSI) and roughly 5-10 s more per analysis on
  CPU, for +1 to +3 points at 10 ms and up to +5 at 20 ms on held-out songs.
  An ONNX export of the model would cut the runtime; not tried.

---

## v1.0.0-stable — 2026-10-24 · drums alone, the 3:4 readings and the refusals

### Changed

- Nothing in the engine.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- S1's 42 songs more than 5 BPM off on the right octave (master `2865bb2`):
  14 precision-path songs with one red line read at 2:3 or 3:4 of the map
  (188 -> ~141, 200 -> ~133, 210 -> 140: the triplet taken as the beat), 28
  local-tempo songs whose map's first red line sits in an intro at another
  tempo. 1.7 % of S1's songs; left as they are.
- The 6 refused songs (5 measured): pulse gaps 0.054-0.069 against the 0.07
  floor, inside the range random clicks reach (up to 0.078). The floor
  stays: noise gets no BPM.

### Rejected / tried and dropped

- The engine on the percussive part alone (librosa HPSS), 40-song dev
  samples, beats within 10 ms, whole mix -> margin 1 / margin 3: S3 58.2 ->
  62.2 / 64.0 %, but S2 70.5 -> 68.8 / 69.4 % and S1 86.4 -> 89.0 / 84.4 %.
  Gated on the mix analysis' own evidence (fallback path, fit residual 4-14
  ms): every gate that raises S3 lowers S2 or S1 (best S3 68.2 % costs S2
  8 points). Not shipped; held out not run, as no dev variant was a win.

### Pending (next session)

- The remaining gaps (bands with rubato, per-line BPM on dense maps) need a
  beat signal the engine does not have. The roadmap's candidate is Beat This!
  (10.3, MIT code and weights, offline at run time), which needs its weights
  downloaded once -- an owner decision.

---

## v1.0.0-stable — 2026-10-23 · choosing between the two grids per song

### Changed

- Nothing in the engine.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- Browser check of the map-lead setting (overtone-ui-check harness,
  Sledgehammer): on by default, the copied timing's first red line 400 ms
  with it and 428 ms without (28 ms apart), the timing table keeping the
  engine's 428.47 ms; the setting saves both ways; EN and ES strings present;
  no app.js console errors. Not driven there: the .osz and inject writes
  (same helper, covered by the bridge tests).

### Rejected / tried and dropped

- Per song, the local-tempo tracker's lines instead of the precision
  engine's when they explain the song's own attacks better (attack-to-beat
  F-measure at 15 ms, by a margin of 0 / 0.03 / 0.06 / 0.1), on the pickled
  precision-path samples. Best on dev (margin 0.1): S2 81.1 -> 82.0 %, S3
  54.5 -> 58.5 %, but S1 89.9 -> 86.6 % beats within 10 ms; held out S1
  82.0 -> 83.8 %, S2 65.2 -> 66.4 %, S3 36.2 -> 35.9 %. No margin helps every
  stage on both splits; the attacks alone do not say which grid the mapper
  would keep.

### Pending (next session)

- What is left needs new signal, not new thresholds: per-line BPM on maps
  with a line every few beats (S2/S3), bands with rubato and changes under 4
  beats (S3 beats within 10 ms 43.8 %), the 3:4 readings (141 of S1's 4,611
  maps), and the 6 songs the noise guard refuses.

---

## v1.0.0-stable — 2026-10-23 · osu!'s red-line lead at export (owner decision)

### Changed

- Red lines written for osu! sit `MAP_LEAD_MS` = 28 ms before the sound, as
  ranked maps put them (owner decision 2026-10-23, closing 10.0a's open
  question). `overtone.with_map_lead` moves every detected line; lines the
  user placed or edited (`manual`) stay. The web shell applies it to copy
  timing, the .osz, inject (one map and the mapset) and the inject diff;
  the click track, the CSV, Quaver and StepMania keep the grid on the sound,
  and the engine, the bench and the golden vectors never see it.
- Settings → Output: "Write red lines as osu! maps are timed (28 ms before
  the sound)", on by default (`map_lead`), EN and ES.

### Fixed

- Nothing beyond the above.

### Hardening

- The lead is a property of what is written, not of the analysis: the
  analysis object is never changed (`with_map_lead` returns a copy), so undo,
  locks and the timing table keep the engine's positions.

### Measured

- The lead: the median signed distance from the map's red line to the
  engine's grid on the dev songs of all three stages, 27.6 ms pooled (28.0 /
  26.4 / 25.0 by stage), written as 28.
- The map's first red line against the written one, without -> with the
  lead, held out: S1 within 5 ms 1.6 -> 41.5 %, within 10 ms 3.5 -> 68.0 %,
  tempo ok and within 5 ms 0.9 -> 37.5 %; S2 1.9 -> 35.3 %, 7.7 -> 47.3 %,
  0.1 -> 9.5 %; S3 0.4 -> 30.5 %, 1.0 -> 45.3 %, 0.0 -> 9.5 %. Dev: S1 0.9
  -> 47.8 %, S2 4.2 -> 41.8 %, S3 0.9 -> 32.9 % within 5 ms.
- Gates: 1018 Python tests (299 web shell), benchmark 24/24, bpm-snapshot
  24/24, golden 27/27, real-audio 6/6, robustness, combine, parity, facts.
  Not run: the browser check of the new setting (the bridge tests cover its
  default, validation and every export it reaches).

---

## v1.0.0-stable — 2026-10-23 · the Rust path and the song-level octave

### Changed

- Nothing in the engine.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- The Rust engine needs no local-tempo port to benefit: when it refuses a
  song (or fails), `overtone_web` hands the analysis to v3
  (`analyze_audio`, the `# v3 takes over` branch), which now times refused
  songs with the local-tempo tracker; the octave, whole-BPM and drift
  conventions reach Rust results through `overtone_rust.analyze`.
- Song-level octave, on the pickled precision-path samples of all three
  stages: the engine's longest red line is on the octave of the map's
  longest-held tempo for 91.9 % of 397 dev maps and 94.6 % of held-out maps
  (S3 93.5 %). S3's stage-level 72.9 % scores each map's first red line,
  which often sits in an intro at another tempo -- not a song-wide octave
  error.

### Rejected / tried and dropped

- A song-level octave rule from the attack pattern (double when the half
  beats carry as much weight as the beats, halve when every other beat is
  weak; 240 threshold sets swept on dev): best dev 91.9 -> 93.5 %, held out
  94.6 -> 94.9 %, within noise; not shipped.

### Pending (owner decision)

- The export convention (10.0a): decided the same day, see the entry above.

---

## v1.0.0-stable — 2026-10-23 · where S1 still misses, and the first-edge phase

### Changed

- Nothing in the engine; a measurement and a rejected experiment.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- Refusals after the day's changes: 6 songs in all three stages (4 in S3, 2
  in S1), every one by the noise guard ("No rhythmic pulse found"). Small,
  and the rule that noise gets no BPM stands, so left as they are.
- S1 misses on master `b917199`, all 4,611 maps: 4,166 on the map's octave;
  of those 3,377 within 0.05 BPM, 388 within 0.05-1 BPM (347 of them maps
  with a whole BPM; most of their songs carry several drift-following lines,
  each a fractional BPM), 141 more than 5 BPM off (ratios 0.75 and
  0.92-0.97: three-against-four and plain tempo errors). Rounding a drift
  line's BPM would move its beats ~19 ms over a 96-beat window, so the
  0.05-1 band is a trade between matching the mapper's single line and
  landing the beats, not a bug.

### Rejected / tried and dropped

- Phase on the sound's first edge (10.0f): each song's grid moved to where
  its >4 kHz energy starts (`corpus_b.sound_start_ms`), one convention fitted
  on dev. Dev 40 songs within 5 ms 55.5 -> 58.7 %, held out 60 songs 64.5 ->
  57.0 % (within 10 ms 78.9 -> 71.9 %); gating on the onset's contrast was
  worse still. On maps whose tempo is right the grid already sits within
  10 ms of the map after the convention for 79 % (held out) of red lines.

---

## v1.0.0-stable — 2026-10-23 · full-stage measurement after the day's changes

### Changed

- Nothing in the engine; numbers only.

### Fixed

- Nothing.

### Hardening

- Nothing.

### Measured

- `bench/stages.py <stage> --compare`, every song analysed again on master
  `746a009` (octave fold, whole BPM, drift following with its 10 % guard,
  local-tempo tracker), against the baselines of 2026-10-22/23. Held out:
  - S1 anime-single (1,462 maps, 243 songs): tempo ok 58.9 -> 71.1 %, octave
    75.2 -> 90.4 %, conv. 5 ms 24.1 -> 37.5 %, conv. 10 ms 47.0 -> 57.1 %,
    beats within 10 / 20 ms 72.4 / 87.2 %. Red lines matching the map's count
    90.7 -> 71.9 %: drift following adds lines where the mapper kept one.
  - S2 anime-variable (685 maps, 142 songs): beats within 10 ms 42.7 -> 66.1 %,
    within 20 ms 56.4 -> 83.5 %; red lines with the right tempo 18.9 -> 21.2 %.
  - S3 bands-variable (495 maps, 98 songs): beats within 10 ms 25.9 -> 43.8 %,
    within 20 ms 35.6 -> 60.1 %; octave 62.0 -> 72.9 %; tempo ok 19.8 -> 25.1 %.
  - Dev moved the same way (S1 tempo ok 60.1 -> 74.2 %; S2 beats within
    10 ms 51.1 -> 69.1 %; S3 41.4 -> 61.9 %).

### Pending (next session)

- S1: the phase -- 57 % within 10 ms after the convention, 37.5 % within 5 ms.
- S2/S3: red lines with the right tempo stay low (21 %, 3 %) although the
  beats land: mappers' lines every 2-4 beats are judged one by one; S3 still
  has 61 refused or errored maps held out and octave 72.9 %.
- Rust: the conventions reach the Rust engine through overtone_rust.analyze;
  the local-tempo tracker needs the Rust result to carry an onset envelope
  for refused songs, which it does not (Rust refuses them).
- `installer/notices.py --check` fails as on master (Tcl/Tk 8.6 notice).

---

## v1.0.0-stable — 2026-10-23 · local-tempo tracker for the songs v3 refuses

### Changed

- The songs the precision engine refuses no longer keep the v2 tracker's
  red lines: `_local_tempo_track` reads tempo candidates from each 8 s window
  of the onset envelope (autocorrelation peaks and their octaves), takes the
  cheapest path through them (Viterbi: candidate strength, tempo jumps with an
  exact octave cheap, distance outside 140-300 BPM, a slight preference for
  the faster tempo), lets librosa's dynamic-programming beat tracker follow
  that tempo curve (tightness 1000), moves the beats by the song's measured
  envelope lag, and writes a red line wherever a beat leaves the current
  line's refitted grid by more than 8 ms. x2 / /2 scale its lines
  (`Analysis.local_tempo`). `osu_conventions=False` still returns the v2
  tracker, which its tests and the golden vectors keep reading.

### Fixed

- Sledgehammer (The Fall of Troy, the owner's map, 244 red lines between 71
  and 268 BPM) was read at ~128 BPM throughout: beats within 10 ms of the map
  5.7 -> 57.7 %, within 20 ms 12.2 -> 65.8 %.

### Hardening

- The first version took each line's BPM from its first four beats: a tempo
  change left a spurious line between the two tempi (130 -> 173 -> 260) and
  noise split a steady stretch in two. Lines now grow beat by beat, refitted
  on every beat they hold. Without the lag shift the beats sat 7.3 ms late on
  the fallback ramp test (1.3 ms with it).

### Measured

- On the songs that take this path, beats within 10 ms of the map, v2
  tracker -> local tempo (engine code), held out (60-song samples): S1 13.7
  -> 63.1 %, S2 7.4 -> 60.9 %, S3 13.8 -> 45.7 %; dev (40): S1 3.4 -> 67.7 %,
  S2 9.2 -> 53.4 %, S3 31.3 -> 70.3 %. These songs are 26 % of S2's maps and
  30 % of S3's.
- Against the precision engine on the songs it does time, the tracker is
  worse (held out S1 82.0 vs 70.0 %, S2 65.2 vs 60.9 %), so it replaces only
  the fallback.
- real-audio: Calm Down Juliet 3 -> 102 red lines, beats within 10 ms of its
  map 6.3 -> 81.2 %; re-pinned. Gates: 1016 Python tests, benchmark 24/24,
  bpm-snapshot 24/24, golden 27/27 Python and Rust, perf within budget,
  every other gate run passes; installer/notices.py not re-run (fails as on
  master).

### Rejected / tried and dropped

- Phase from each window alone (the envelope maximised on a 48-step phase
  sweep): the tempo was right more often but beats jumped at every window
  seam -- S3 dev 31.3 -> ~21 %.
- Section octave from half-beat density: map-doubled segments do show fuller
  half beats (0.87 against 0.58), but map-halved ones do too (0.93), and on
  Sledgehammer the midpoint-to-beat ratio did not separate its 130 and 260
  parts at all.
- Tightness 3000-30000 and a stronger fast bias (0.2-0.5): all worse on dev.

---

## v1.0.0-stable — 2026-10-23 · drift following on, with a 10 % guard

### Changed

- Drift following is on by default (`DRIFT_FOLLOW = True`): the followed
  grid must now fit the attacks 10 % better than the fixed one
  (`DRIFT_MIN_GAIN = 0.9`), where "at all better" let a steady song through.

### Fixed

- Take You Down no longer gets 5 red lines from drift following.

### Hardening

- Nothing beyond the guard.

### Measured

- Guard chosen on 40-song dev samples among 18 variants (overall RMS gain
  1.0 / 0.9 / 0.8, per-window gain 1.0 / 0.9 / 0.8, minimum parting 15 /
  25 ms), with five real-audio songs beside them. Held out (60 songs per
  stage), beats within 10 ms, engine -> gain 1.0 -> gain 0.9: S1 62.2 ->
  76.7 -> 75.2 %, S2 48.2 -> 54.2 -> 52.8 %, S3 26.9 -> 30.3 -> 30.5 %;
  Take You Down 99.9 -> 81.9 -> 99.9 %, Noble 40.7 -> 58.9 -> 58.9 %.
- Gates on master before this change: every one in CLAUDE.md passes except
  `installer/notices.py --check` (Tcl/Tk 8.6, unrelated). With it: 1013
  Python tests, benchmark 24/24 (median 0.0000 BPM / 0.14 ms), bpm-snapshot
  24/24, golden 27/27; real-audio re-pinned for Noble (1 -> 17 red lines).

### Rejected / tried and dropped

- A per-window gain (a window's refit kept only when it fits that window
  10-20 % better): it costs S1 and S2 0.7-1.4 points on dev for little on S3.

---

## v1.0.0-stable — 2026-10-23 · S2/S3 baselines and drift following

### Changed

- `bench/stages.py` scores beats as well as red lines: the beat F-measure at
  10 and 20 ms (map beats the engine has, engine beats that are real), after
  a beat convention fitted on dev; and red line by red line. On a map with a
  line every two beats, "every line within 0.05 BPM" says little about
  whether it can be mapped; the beats do.
- Drift following (`_follow_drift`, after the octave and whole-BPM
  conventions, in both engines through `overtone_rust.analyze`): the grid is
  re-fitted every 96 beats on that window's attacks, each window moving the
  tempo by at most 3 %, and a red line written where it moved. Kept only when
  the fixed and the followed grids part by more than 15 ms (90th percentile)
  and the followed one fits the attacks better. Each new line inherits its
  meter and confidence from the red line it replaces; the first starts at the
  first attack, whole bars before the first red line.
- `single_bpm.engine_fingerprint` hashes the engine's Python by content with
  line endings normalised, so a commit no longer invalidates every cached
  analysis.

### Fixed

- Nothing beyond the above.

### Hardening

- Drift following never runs without the two guards: with neither, anime
  single-tempo songs lost 6 points of beats within 10 ms on dev.
- The first followed line starts at the first attack: started at the first
  red line (which can sit 93 s in, as on the new test's ramp), the music
  before it kept the fixed grid.

### Measured

- Baselines, held out (beats within 10 / 20 ms, red lines with the right
  tempo): S2 anime-variable 42.7 / 56.4 %, 18.9 %; S3 bands-variable
  25.9 / 35.6 %, 2.5 %, octave 62.0 %. The maps of S2 have a median 10 red
  lines and 8 changes; 1,060 of their 1,388 tempo segments are shorter than
  4 beats, and the engine wrote a median of 1 line.
- Drift following on seeded 60-song held-out samples (chosen on 40-song dev
  samples), beats within 10 ms: S1 62.2 -> 76.8 %, S2 48.2 -> 53.9 %, S3
  26.9 -> 30.3 % (within 20 ms: 71.4 -> 87.1, 63.0 -> 73.0, 40.8 -> 48.2 %).
- Full-stage numbers with drift following: not measured (the run was
  stopped at the owner's request). On the real-audio gate drift following
  took Take You Down from 1 red line and 99.9 % of beats within 10 ms to 5
  lines and 81.9 %, and Noble from 40.7 to 58.9 %: its guard lets a steady
  song through, so it ships **off** (`DRIFT_FOLLOW = False`,
  `analyze_audio(follow_drift=True)` to try it). With it on, the suite passed
  1013/1013, benchmark 24/24, bpm-snapshot 24/24, golden 27/27 in Python and
  Rust, signatures 6/6, reference 24/24. The final gate run after switching
  it off was cut short at the owner's request: not run.

### Pending (next session)

- Re-run every gate in CLAUDE.md on master with drift following off.
- Fix drift following's guard so steady songs are spared (Take You Down),
  then measure S1, S2 and S3 in full with `bench/stages.py --compare` and
  turn it on only if all three improve held out and real-audio holds.
- S3 bands: held-out octave 62 % -- octave choice on songs with tempo
  changes; tempo segments shorter than 4 beats (76 % of S2's).
- S1: the phase (10.0e/f); the 1-point octave gap between two S1 runs.
- Take You Down's bar line one beat early (10.4a).
- `installer/notices.py --check` fails on master (Tcl/Tk 8.6 notice).

### Rejected / tried and dropped

- Smaller section thresholds (min delta 1.0 / 0.5 BPM, persistence 6 / 4
  beats) on 40 S2 dev songs: beats within 10 ms 37.2 -> 38.4 / 36.6 %, and
  the engine still wrote a median of one line. The changes are drift, not
  steps the section growth misses.
- Following windows of 4 and 8 beats: they follow noise (S2 dev 36.2 and
  41.4 % against 48.6 % at 32 beats); 24 to 128 beats were all better, 96
  chosen on dev.

---

## v1.0.0-stable — 2026-10-23 · S1: the whole BPM mappers use

### Changed

- After the octave, each section is read at the whole BPM beside it (within
  0.5) when its attacks agree: the whole-BPM grid, its phase refitted, must
  keep 95 % of the inliers and fit within x1.2 + 0.5 ms of the section's own
  RMS (`_snap_whole_bpm`). A fractional BPM the music has (decimal-128.37)
  fits clearly better and is kept.
- `analyze_audio(..., osu_conventions=False)` returns the engine's own
  reading. The golden harness uses it, so the vectors pin the engine and the
  Rust port is compared on what it computes; `overtone_rust.analyze` applies
  the same octave and whole-BPM conventions to the Rust result.

### Fixed

- Nothing beyond the above.

### Hardening

- The Rust engine now gets the octave fold too (it had none since S1's
  first step); the two tests that compare its BPM with v3's pass again.

### Measured

- S1 `anime-single`, against the 2026-10-22 baseline. Held out: tempo ok
  58.9 -> 64.1 % (60.9 after the octave step), conv. 5 ms 24.1 -> 33.2 %,
  conv. 10 ms 47.0 -> 50.4 %, raw joint 5 ms 0.0 -> 0.9 %, octave 75.2 ->
  85.2 % (86.3 % in the octave step's run; the 1-point gap is not traced).
  Dev: tempo ok 60.1 -> 68.3 %, conv. 10 ms 50.2 -> 56.7 %. Simulated on
  cached analyses before the change: dev 63.9 -> 74.9 % if every BPM were
  rounded; the evidence check gives up part of that to keep real fractions.
- Corpus A: benchmark 24/24, median 0.0000 BPM, offset 0.16 -> 0.14 ms;
  bpm-snapshot 24/24 unchanged; golden 27/27 Python and Rust (vectors
  identical to before, now taken without conventions); real-audio re-pinned:
  Take You Down 174.0156 -> 174.0, Shinkou 189.98 -> 190.0, Noble
  163.97 -> 164.0, Palette 179.97 -> 180.0, each its map's BPM. 1012 Python
  tests pass.

---

## v1.0.0-stable — 2026-10-22 · S1: the beat octave osu! maps use

### Changed

- Every section is read at the octave of the song's longest section
  (`_one_octave`, Python and Rust). Sections seed their own grids, and a near
  tie could seed one at twice the beat of its neighbours: Raise Your Flag came
  out as 145, 290, 145, 290 ... BPM and the red line written was the 290.
- After the analysis, a song whose BPM sits outside [120, 240] is read at the
  octave inside it (`MAP_OCTAVE_RANGE`, `_fold_to_map_octave`), through the
  same path as the ×2 / ÷2 quick fix, so the user can undo it there. Skipped
  when a factor is forced or `prefer_map_bpm` is off.

### Fixed

- Octave flips between sections of one song (above).

### Hardening

- A swung song is never doubled: its off-beat sits at two thirds, so the
  doubled grid lands every other beat on nothing (`shuffle-96`, caught by the
  swing-lane test, now reads 96 as before).
- The fold leaves a hair of slack: 59.9999 BPM doubled is 120, not a reason
  to double again.

### Measured

- S1 `anime-single`, Python engine, against the 2026-10-22 baseline. Held
  out (1,462 maps, 243 songs): exact octave 75.2 → 86.3 %, tempo ok 58.9 →
  60.9 %, conv. 10 ms 47.0 → 46.1 %. Dev (3,149 maps): octave 76.6 → 86.9 %,
  tempo ok 60.1 → 63.5 %. The range was chosen on dev alone (simulated 95 %;
  the real engine gives less because songs it reads as half or double in
  every section are not all moved by the global fold).
- Of the 4,000 maps now on the right octave, 547 sit 0.05–0.5 BPM off and
  563 more than 0.5; 97 % of the misses are maps with a whole-number BPM.
  That is S1's next target.
- Corpus A unchanged: benchmark 24/24 (median 0.0000 BPM / 0.16 ms),
  `bpm-snapshot` 24/24, golden 27/27 in Python and Rust (signature-changes
  re-dumped: its second section's intermediate grid is read at the long
  section's octave; the final red lines and the `signatures` gate, 6/6, are
  unchanged). `real-audio`: Noble 164.12 → 163.97 against its map's 164,
  re-pinned. Take You Down: a section the old engine read at 43.26 BPM (a
  quarter of 174) now reads 173.32, and its red line moves one beat, from the
  map's bar line (beat 16 after the map's line) to beat 15 -- the grid stays
  on the beat, the bar is a beat early. A known cost, left for 10.4a's
  downbeat work, not hidden. 1012 Python and 292 Rust tests pass; every gate passes except
  `installer/notices.py --check`, which fails the same way on master (Tcl/Tk
  8.6 ships no notice text).

### Rejected / tried and dropped

- The global fold alone: held-out octave only 75.2 → 76.3 %, because the
  section flips were below it.

---

## v1.0.0-stable — 2026-10-22 · Phase 10 stage plan and the anime baseline

### Changed

- No engine behaviour changed. Phase 10 is now worked one slice of the Songs
  folder at a time (roadmap, "Stage plan"): S1 anime one tempo, S2 anime tempo
  changes, S3 live bands that drift and change tempo, S4 the rest. Owner
  decision: the folder's mapper timings are the truth, so 10.0b's listening
  audit is replaced, not owed.
- Added `bench/stages.py` and `bench/stages.json`: each stage is an SQL
  condition over the library index; songs split by folder hash into dev (70 %)
  and held out (30 %); every red line of every map scored; analyses share
  `single_bpm.py`'s cache.

### Fixed

- Nothing fixed; this is a measurement.

### Hardening

- The red-line convention shown beside the raw score is fitted on dev only and
  applied to held out, so the held-out figure is not flattered by its own fit.

### Measured

- S1 `anime-single`, Python engine, 832 songs / 4,611 maps (40 s, almost all
  from the cache; 4 songs errored on decode). Dev 3,149 maps: tempo ok 60.1 %,
  octave x1 76.6 %, joint 5 ms 0.2 %, after the +27.7 ms dev convention
  32.3 % within 5 ms and 50.2 % within 10 ms, signed error +26.0 ms
  [+19.7..+32.5]. Held out 1,462 maps: tempo ok 58.9 %, octave x1 75.2 %,
  conv. 5 ms 24.1 %, conv. 10 ms 47.0 %. Wrong octaves: x2 550, x0.5 434,
  x0.25 61, x4 21 of 4,611 -- the octave (10.0g) is S1's first target,
  then the phase (10.0e/f).

---

## v1.0.0-stable — 2026-10-16 · T6 resumable independent-sample audit

### Changed

- No product behavior changed. `bench/labels.py` now persists one row at a time,
  resumes only an identical seed/exclusion/sample, verifies map and audio SHA-1
  before reusing a completed row, and caches successful structure results by
  audio and CLI hashes. Documented the reproducible command in `docs/workflow.md`.
- Replaced the stale roadmap priority snapshot with current 0.3.0 blockers and
  longer-term work; corrected the installer and compile-phase summaries in the
  roadmap and status graph.
- Closed T6 for 0.3.0 by measured disposition: no section labels ship, and the
  existing Kiai card remains conservative. Reopen only for a new signal tested
  on an untouched confirmation split.
- Ran a fresh 100/100 T6 split with seed 61, excluding every folder in the prior
  seed-60 sample; its JSON and structure cache stayed in ignored `bench/.cache/`.

### Fixed

- Nothing fixed; this was a research audit.

### Hardening

- Kept the 100-folder halves intact. Rows without a proposed chorus remain in
  the sample and are reported as unscored; no feature or accuracy claim follows
  from only the maps with chorus spans.

### Measured

- Zero folder overlap with the seed-60 sample. Tune: 16/100 maps had nonempty
  chorus spans; mean chorus-under-kiai 33.8%, chance 22.3%, lift +11.5 points
  (paired per-map t interval 2.7–20.4). Held-out: 10/100 scored; 45.1% vs
  30.8%, lift +14.3 points (interval 6.4–22.1). Both miss the pre-set +15-point
  bar; the intervals are wide and cross that bar, so this is not a general
  accuracy claim. Remaining maps had no kiai or no proposed chorus.
- Re-running the same command resumed the exact split and completed in about
  five seconds from saved rows and cached structure results.
- `bench/facts.py` passed and `bench/labels.py` compiled with `py_compile`;
  the test suite was not run.

### Rejected / tried and dropped

- Do not tune an adjustment against this held-out half after seeing its score.
  A new approach needs a fresh split and must keep its confirmation half unseen.

---

## v1.0.0-stable — 2026-10-16 · H6/H7 measured disposition for T7

### Changed

- Closed 0.3.0 row T7 by measured disposition. H7's audio-only Propose surface
  shipped on 2026-10-07; keep it as an evidence-backed proposal without an
  accuracy claim. H6 sample→role recommendation remains withheld.
- Corrected `docs/15-hitsound-plan.md`: its H7 section said the app surface was
  still open even though the 2026-10-07 implementation had landed.

### Fixed

- `bench/templates_on_real_audio.py` now rejects sidecar JSON errors and responses
  without an `attacks` list as unreadable rows, prints the skip reason, and
  continues. Previously an access-denied audio file returned valid JSON with an
  `error` key and crashed the measurement at `heard()`.

### Hardening

- Kept instrument lanes, the clap-mismatch rule and sample→role recommendation
  gated; a weak confidence score is not a class verdict. The H7 surface stays a
  proposal and does not assert accuracy.

### Measured

- `.venv/Scripts/python.exe bench/templates_on_real_audio.py`: 9 readable songs,
  2,859 matched mapper claps; median `P(snare)+P(clap)` 0.194 (deciles
  0.019/0.051/0.194/0.472/0.698). 43% scored ≥0.25 and 23% ≥0.50. Three of the
  12 selected audios were skipped because Windows denied access. This remains a
  measurement, not a gate; the remeasured evidence supports withholding the
  confidence-dependent features.
- The existing H7 comparison remains its 6-song measurement: median coverage
  0.31, same-sound agreement 0.12, mapper clap F1 0.29 vs the 0.59 P-6 rule.
  No engine code or accuracy baseline changed. No test suite was run.

---

## v1.0.0-stable — 2026-10-16 · Graphify project status map

### Changed

- Added a compact interactive Graphify graph for shipped capabilities, release
  rows, longer-term tasks, open decisions and offline constraints. The graph
  cites its roadmap source on every node and keeps status separate from the
  code-symbol graph.
- Added `docs/project-status.json` and `scripts/graphify_project_status.py` as
  the curated status index and deterministic local graph builder; linked the
  map from `docs/project-map.md` and extended the workflow for future roadmap
  updates.

### Fixed

- The code-only graph alone did not show task state. The project map now has an
  explicit current status view, including R6, T6 and T7 as open release rows.

### Hardening

- Graph edges retain their cited document and line. The status view is built
  locally with Graphify and does not use semantic or network extraction.
- The map distinguishes shipped, partial, open, deferred, dropped and policy-
  constrained work; it does not treat older README accuracy figures as fresh.

### Measured

- Graphify status graph: 24 nodes and 26 documented relationships; clustered
  locally into 5 communities and rendered to interactive HTML. No tests or
  analysis benchmarks were run; this change updates project documentation.

---
## v1.0.0-stable — 2026-10-15 · Repository map and Graphify workflow

### Changed

- Added `docs/project-map.md` with the current repository architecture, ownership
  areas, main data flows and source facts. Added its link to the README and made
  map refresh part of every project change in `docs/workflow.md`.
- Installed Graphify 0.9.91 into a temporary isolated environment and added a
  code-only, local generation workflow; its graph, report and interactive HTML
  are checked in under `graphify-out/`.

### Fixed

- No defects fixed; this is documentation and workflow guidance.

### Hardening

- The workflow now requires reviewing the map against source changes and forbids
  semantic/cloud extraction or a network-backed graph-generation step.
- Graphify's disposable cache, incremental manifest and machine-specific root
  marker are ignored; the portable graph, report and HTML stay in the repository.

### Measured

- `.venv/Scripts/python.exe bench/facts.py`: `facts: ok`; 1,008 Python tests,
  291 Rust tests, 7 crates, 27 golden vectors, 38 fixtures and library schema v2.
- Graphify 0.9.91 local code-only graph: 5,439 nodes, 12,695 edges, 233
  communities; `graphify query` and `graphify god-nodes` returned results.
- `git diff --check`: clean. No analysis or accuracy benchmark was run.

---

## v1.0.0-stable — 2026-10-15 · Mapper-agreement harness for single-BPM maps

### Changed

- Added `bench/mapper_agreement.py`, a repeatable read-only audit of ranked,
  approved and loved standard maps with one red line. It cross-checks `osu!.db`
  identities against Overtone's local library index, validates the current map
  files, groups byte-identical audio, and compares each pair in both directions.
- Added a seeded, round-robin stratified human-review sheet at
  `bench/.cache/mapper_agreement.md`; local paths and audio hashes stay out of Git.

### Fixed

- No engine behavior changed. The measurement now separates mapper independence
  from exact timing copies, which made the aggregate agreement look stronger.

### Hardening

- The reader accepts only the locally audited Stable `osu!.db` version
  (20260924), rejects truncation or unexpected layout, and opens the library
  SQLite index in read-only mode. Map paths must resolve under Songs, and
  beatmap/set IDs, mode and red-line count are rechecked from disk.
- Stale index rows, missing audio, and permission-denied audio reads are named
  and skipped; they are not classified as invalid references. The audit sheet
  is generated under the ignored local cache.

### Measured

- Local database: 24,709 maps, 19,493 ranked/approved/loved entries. The current
  index yielded 174 validated one-red-line maps in 73 byte-identical audio
  groups, or 117 pairs. 80 pairs had identical timing; including these gave
  84.6 % directional agreement within 5 ms. Among the 37 non-identical pairs
  (74 directions), only 38/74 (51.4 %) were within 5 ms; the BPM≤0.05 and exact
  octave checks passed all directional comparisons, so 38/74 also passed
  jointly. Signed offset median was 0 ms, with quartiles −5 and +5 ms.
- The seeded sheet contains 25 of the 37 non-identical pairs, sampled across
  tempo, audio format and TV Size strata. Human verdicts are still outstanding;
  10.0b remains open until those are reviewed and the primary denominator and
  exclusion ledger are locked. The index also reported 25 stale maps, 7 missing
  audio files and 20 audio hash reads blocked by Windows permissions.
- These local counts are not a locked benchmark and do not establish a general
  mapper-error distribution. No accuracy or engine improvement is claimed.

### Rejected / tried and dropped

- Treating exact timing matches as independent mapper agreement was dropped:
  they can be copied between mapsets and raised the apparent 5 ms agreement
  from 51.4 % on differing pairs to 84.6 % overall.

---

## v1.0.0-stable — 2026-10-15 · Single-BPM accuracy target and work plan

### Changed

- Made the user's single-BPM quality requirement explicit: a song-clustered lower
  95 % confidence bound of at least 95 % joint success for exact octave, BPM
  error ≤0.05, and offset error ≤5 ms across all valid one-red-line maps in a
  held-out slice.
- Added separate roadmap steps for reference truth, offset convention, phase
  estimation, octave/tempo resolution, and the final joint gate.

### Fixed

- Replaced a broad “real-audio accuracy” placeholder with acceptance criteria
  that prevent BPM-only gains or answer-only scoring from being called success.

### Hardening

- Refusals and errors count as misses in the primary score. Difficulty rows
  sharing one audio are grouped by song for confidence intervals; every
  invalid-reference exclusion must be audited, listed, and counted against
  coverage.
- Candidate offsets must earn gains on held-out songs; the known average bias
  cannot be subtracted as an unvalidated production constant.

### Measured

- Planning only; no engine code or accuracy claim changed. Baseline remains
  Python: 1.9 % within 5 ms, 70.3 % within 0.05 BPM across all maps, and 72.6 %
  exact octave on answered maps. The previously measured +24.6 ms bias correction
  reaches only 37.1 % within 5 ms, a diagnostic rather than a result.

### Rejected / tried and dropped

- A single constant offset correction is not the accuracy plan: the measured
  diagnostic still misses the 5 ms target on most maps and does not address
  wrong tempo octaves.

---

## v1.0.0-stable — 2026-10-15 · Hitsounds roadmap reconciled

### Changed

- Recorded H7 as complete in the design plan: its audio-only Propose toggle and
  shared inspector, audition and write path shipped on 2026-10-07.
- Clarified T7's actual remaining scope: H6 sample→role recommendations,
  instrument lanes and the clap-mismatch rule still depend on classifier
  evidence that transfers to real audio.

### Fixed

- Removed the stale claim that H7's app surface was still open, which conflicted
  with the roadmap and the 2026-10-07 implementation entry.

### Hardening

- Kept the unverified browser harness and sidecar-on-real-songs check explicit;
  shipped UI status does not imply those checks were completed.

### Measured

- No new classifier measurement. The existing 2026-10-07 Rust results remain
  the basis for deferring H6: median `P(snare)+P(clap)` 0.189 and crash-vs-snare
  0.408 over 12 songs.

---

## v1.0.0-stable — 2026-10-15 · Single-BPM bulk truth: Rust scored on the revalidated slice

### Changed

- **Completed the Rust side of 10.0d** and re-scored the current map slice with
  Python from cache, so both engines are compared on the same audios and maps.
  The available files now yield fewer maps than the 2026-10-14 Python run.

### Fixed

- Nothing: this was a measurement, not an engine change.

### Hardening

- No source files or baselines changed. The scan re-checked every one-red-line map
  against the local Songs folder; missing maps stayed named in the skipped count.

### Measured

- Current revalidated slice: 3,229 songs, 16,069 maps, 1,059 maps skipped during
  slice reconstruction (the 2026-10-14 run skipped 29, leaving this comparison
  with 1,030 fewer scored maps).
  Rust: 1.3 % within 5 ms, 76.8 % within 50 ms, signed offset +25.1 ms
  [19.0..32.3], BPM≤0.05 on 11,083/14,083 answered maps (78.7 %, 69.0 % of
  all maps), exact octave on 10,023/14,083 (71.2 %); 452 refusals and 23 errors.
  Its agreeing-map subset (15,096 maps) is 1.3 % within 5 ms, 77.5 % within
  50 ms, with BPM≤0.05 on 10,527/13,277.
- Python on the same slice: 1.9 % within 5 ms, 83.5 % within 50 ms, signed
  offset +25.0 ms [17.0..32.2], BPM≤0.05 on 11,290/15,878 answered maps
  (71.1 %, 70.3 % of all maps), exact octave on 11,530/15,878 (72.6 %);
  21 refusals and 24 errors. Its agreeing-map subset is 1.8 % within 5 ms,
  83.9 % within 50 ms, with BPM≤0.05 on 10,708/14,921.
- Refusals and errors are separate outcomes. Rust's summed analysis time was
  4,845 s (2,925 uncached; run time 4,645 s), while Python used 3,205 cached
  analyses and 24 recomputations (run time 433 s); these are not a speed
  comparison. Rust falls below Python within 5 ms, so the result supports no
  accuracy improvement claim. `bench/facts.py` checked after the documentation
  update.

---

## v1.0.0-stable — 2026-10-14 · Single-BPM bulk truth: full slice measured

### Changed

- **The full run**: all 3,425 one-red-line songs through `bench/single_bpm.py`
  (python engine, 3 at a time, 3.1 h wall / 9.1 h CPU, 108 from the cache).

### Measured

- 17,099 maps scored, 29 skipped (missing files, named), 24 errors (audio no
  decoder here opens — formats wanting FFmpeg, each named), 23 refused.
  Precision path 2,921 songs, fallback 457.
- BPM≤0.05 octave-normalised **11,914/16,906 (70.5 %)**, median |error|
  0.013; same octave 12,138 (71.8 %), half 2,017, double 2,334, deeper 416.
- Offsets raw: ≤5 ms 1.9 %, ≤50 ms 83.7 %, signed **+24.6 ms** — the 10.0a
  convention again, reported raw; less that constant, 37.1 % would sit within
  5 ms (diagnostic, not a result).
- The agreeing subset (2,612 songs whose difficulties match within 10 ms /
  0.05 BPM, 16,029 maps) reads **71.1 %** — no better than the slice. Mapper
  disagreement is not the gap; octave errors are, both directions at once.
- Worst miss is gimmick truth, not an engine failure: a minigame map with a
  1,280 BPM red line, read sanely.
- `bench/facts.py` ok. Rust engine through the same slice still owed; no bar
  set, so nothing passes or fails yet.

---

## v1.0.0-stable — 2026-10-14 · Single-BPM bulk truth: harness built, pilot measured

### Changed

- **`bench/single_bpm.py`**: the engine against every one-red-line map in the
  user's Songs folder — 17,128 of 25,171 maps over 3,062 songs (TV Size 2,338
  over 381), found through the library index and re-checked on disk, one
  analysis per song with every difficulty scored on it. Mapper agreement
  (offsets within 10 ms, tempi within 0.05 BPM) splits the repeatable-truth
  subset out. Cached per audio size+mtime and engine code, so the full run is
  resumable; `--tv`, `--sample 7`-seeded, `--max-songs`, `--jobs` and
  `--engine rust` shape it. A measurement, not a gate — roadmap row 10.0d.

### Measured

- 12-song pilot (python, 58 maps): BPM≤0.05 **57/58**, median |error| 0.008;
  signed offset +24.7 ms — the 10.0a convention, and 60.3 % would sit within
  5 ms less exactly that constant (diagnostic, not a result).
- TV-100 (python, 100 songs, 619 maps, 1 undecodable audio named, 1 refusal):
  BPM≤0.05 **485/608**, median 0.013; same octave 513/608 (x0.5 28, x2 67);
  signed +30.4 ms, ≤50 ms 91.9 %. Worst misses are honest: e.g. 210 BPM read
  at 140 (a 3:2 feel, not an octave). All 100 TV songs' difficulties agree
  with each other, so the subset equals the slice here.
- `bench/facts.py` ok. Full 3,062-song run owed; nothing claimed off the pilot.

---

## v1.0.0-stable — 2026-10-14 · T3 closed: the trainer's nicer rows were already in

### Changed

- **T3 closed without new code**: 26.9, 26.10, 26.15 landed in #97 and 26.16
  in #96, but the 0.3.0 table still read `todo (26.16 in progress)`. The
  owner's T1 harness pass (#107) already covers the ladder, copies, presets,
  mods, detect and hotkey rows — 26.21 says so — so the row now reads done.
  R6's 25 verdicts stay the only owner item; T6 and T7 are still open research.

### Measured

- `bench/facts.py` ok; `bench/gates.py train` green (1.0x byte-identical bar
  the version line, 1.37x worst 6.75e-07 beats / 0.19 ms, ladder rungs grade
  1.0x worst 0.45 ms and 1.37x worst 0.34 ms).

---

## v1.0.0-stable — 2026-10-07 · No certificate: 0.3.0 keeps one apology

### Changed

- **T2 dropped by owner decision**: no certificate purchase, so every release keeps
  shipping unsigned with the hash to check. 0.3.0's heading changed accordingly —
  "almost no apologies" instead of "without apologies". The row returns if that changes.

### Measured

- Nothing: this is scope. `bench/facts.py` ok.

---

## v1.0.0-stable — 2026-10-07 · Train harness passes by owner hand

### Changed

- **T1 closed**: the owner ran the Train section in the browser harness and it works.
  The static pass stays recorded as what it was — necessary, not sufficient.

### Measured

- Nothing: this is a witnessed check. `bench/facts.py` ok.

---

## v1.0.0-stable — 2026-10-07 · Timbre grouping: the best lead yet, still a miss

### Measured

- Regrouping sections by chroma AND MFCC-timbre cosine (`proto/timbre_group.py`):
  tune lift **+19.8** at 0.95 (28 lit, clears +15), held-out **+13.8** on 13 songs
  (miss by 1.2). Nothing ported: the bar missed twice in a row across two different
  adjustments, and a miss is a miss at any distance.
- What it says about the problem: timbre splits the mega-family where level cannot
  (recall 30→41 lit), and precision holds (~39-49 % vs ~35 %). The next attempt
  inherits the halves, the bar — and the warning that n≈13 held-out songs make ±7
  point noise, so it should bring a bigger sample or a significance-aware bar.

---

## v1.0.0-stable — 2026-10-07 · Templates on real audio, re-measured: still blocked

### Measured

- Rust classifier at mappers' claps, 12 songs: median `P(snare)+P(clap)` **0.189**
  (Python measured 0.138 on 11). Crash-vs-snare 0.408 — worse than chance, as before.
  Lanes, the mismatch rule and sample→role stay waiting.
- The refit alongside (0.752/0.846) is not a ship candidate, now explicitly: two
  labels over thirteen classes, nothing checking the other eleven. A rebake from it
  would move every class on evidence about two.
- One direction noted, not taken: sample→role by similarity to the map's own bank
  instead of by absolute templates would dodge the transfer problem entirely — but
  that redesigns H6 rather than executing it, so it waits for a decision, not a turn.

---

## v1.0.0-stable — 2026-10-07 · Audio-only evidence for the Propose card

### Changed

- **H7's app surface**: an evidence toggle beside Propose — map+audio, or audio only.
  The song's strong attacks decide with no map, each takes the picked map's nearest
  sound event inside 50 ms and moves its time onto it (what it was heard at stays in
  the inspector), and one event takes its nearest attack. Attacks with no object are
  counted, not placed: there is nothing to write a hitsound onto. Inspector, audition
  and write path unchanged, fed by ears instead of context — best on bare maps, where
  the map context it replaces is empty anyway.

### Measured

- 1008 Python tests (2 new), all green — and a real find on the way: importing a
  `TestCase` across test modules runs it twice under discover (12 phantom runs
  here), so the web tests reach engine fixtures through the module, not the class.
- `facts.py` green; static UI pass clean EN/ES.
- Not checked: the browser harness, and the sidecar on real songs through this path
  (the engine's own 0.29 clap F1 stands as the number).

---

## v1.0.0-stable — 2026-10-07 · Labels measured against kiai: a miss, recorded

### Changed

- **`bench/labels.py`**: chorus seconds under mapper kiai vs chance, on a 100/100
  tune/held-out split with the bar (+15 lift both halves) set before measuring.
  Ground truth stated plainly: mapper kiai, not ranked (no `osu!.db` reader yet).

### Measured

- At 2.0: tune 24 lit, 33.1/25.6 (+7.5); held-out 6 lit, 37.0/25.1 (+11.9). MISS both.
- The failure is recall: ~75 % of kiai-bearing songs propose no chorus at all —
  full mixes collapse to one chroma family with 0-2.5 dB spreads, and the 3 dB
  split never fires. A sweep put the best tune lift at +14.1 (ratio 1.3); the one
  allowed adjustment (1.5, midway between measured unevenness and compressed lifts)
  scored +9.7/+14.2 on the real binary — MISS both halves — and was reverted, since
  a bar that misses twice is not a bar. `bench/labels.json` keeps the 1.5 numbers
  stamped as the experiment they are.
- 292 Rust tests green (classify included); the vectors never moved.

### Rejected / tried and dropped

- **Lowering the split to ship the recall.** At 1.5 more songs light (30→49) at
  equal-or-better precision, which tempts — but the bar missed twice, and more
  proposals at 38 % precision on a card that *writes* kiai is not the same as
  better proposals. The conservative refusal stands until a better signal exists.

---

## v1.0.0-stable — 2026-10-07 · Setup choices without bespoke XML

### Changed

- **The installer offers a feature tree** (T5's second half): `.osz` on Typical,
  the five audio kinds and a desktop icon at level 1000 for Custom or `ADDLOCAL`.
  The first version was bespoke — a custom dialog with three checkboxes and
  conditions under the components — and the compiler refused all of it: WiX v4
  takes no `Condition` under `Component` or `Feature` and no inner text in
  `Publish`. The stock `WixUI_FeatureTree` does the same job with zero custom
  XML, translated and tested by WiX.
- Bare `.osu` stays unassociated on purpose (no song, nothing to analyse);
  context menu and URI scheme stay documented-open.

### Measured

- Feature table 1/1/1000/1000; stock chain License→Customize→VerifyReady read back
  out of the package. Default install: `.osz` ours, audio and desktop untouched;
  `ADDLOCAL=ALL`: `.mp3` reads `Overtone.audio`, desktop icon on the (OneDrive)
  desktop; uninstall takes all three plus the program, user data untouched.
- Full `build.py --clean` green (414.6 s) with the new WiX; same ICE warnings.
- Worth writing down: a `--clean` build that dies at WiX leaves `dist/` without
  an MSI — the "cannot open package" on reinstall was that, not corruption. The
  machine was restored from the published release (hash matches `22339437…`).
- Right-click "Analyze with Overtone" rides the AudioAssoc feature
  (`SystemFileAssociations\audio`, past any player's ProgId): present with
  `ADDLOCAL=ALL`, absent by default, gone after uninstall. URI stays out: no
  linker exists, and a scheme nobody links to is dead surface.

---

## v1.0.0-stable — 2026-10-07 · Dropping spinners, allowed and named

### Changed

- **Row 26.12 built on the owner's yes**: an explicit "drop spinners" ask removes
  spinner objects from the copy — spinners only, because a short slider or hold stays
  playable while spinning has a physical minimum. Never by default; the plan shows each
  spinner's length at the rate before the choice, and the count and kind land in the
  report, the version (`Hard (1.5x), no spinners`) and the tags. `04-ui-ux.md` §9 now
  records the carve-out instead of the open question.

### Measured

- 1005 Python tests (4 new), all green; `facts.py`, `parity.py` green.
- Not checked: the browser harness.

---

## v1.0.0-stable — 2026-10-07 · One hotkey, no hook

### Changed

- **Ctrl+Alt+B builds the copy that is set up, from anywhere** (row 26.19): one
  `RegisterHotKey` on its own thread with a message-only window, firing the same
  build as the button. No keystroke but that one passes through Overtone, which is
  the whole point next to the reference's `WH_KEYBOARD_LL` lag issues. Remembered in
  the config; taken combinations and non-Windows refuse saying so.

### Measured

- Register/unregister/reuse, a posted `WM_HOTKEY` firing the callback, a failing
  callback not ending the wait — all against real Win32, all green. Worth writing
  down: `ctypes.wintypes` carries no `WNDCLASSW`/`MSG`/`LRESULT` (defined locally)
  and `DefWindowProcW` needs explicit argtypes or LPARAM overflows.
- 1001 Python tests, all green; `facts.py`, `parity.py` green.
- Not checked: the browser harness, and a physical keypress (a posted message covers
  everything this code owns; the OS delivers the rest).

---

## v1.0.0-stable — 2026-10-07 · Picking the map, opening .osz, refusing pitch-keeping

### Changed

- **Picking the map from live signals** (row 26.18): `detect_map` tries the osu!
  window title, the newest replay and the newest `.osu` in order, resolving each
  against Songs and reporting everything tried; `osu!.db` reads its header and never
  picks. A Detect button on the source card; a miss names what was looked at and the
  library search stays the answer.
- **`.osz` opens with Overtone** (S5's first half): a per-user ProgId launching the
  app with the archive, which `import_osz` copies into Songs — never moved, never over
  a folder that already holds beatmaps — and opens its song. Twice opens instead of
  copying; whatever refuses still opens the window. The custom setup screen stays open.
- **Pitch-keeping refused with numbers** (row 26.6): a WSOLA probe grades ok on clean
  clicks (worst 1.75 ms) but displaces real attacks a median 8-9 ms, p90 23-26 ms, max
  ~45 ms on three Songs — the grade it would have to pass is the one it fails, so
  resample stays the only method and the refusal is the row's answer.

### Measured

- Live signals on this machine: replay filenames parse and resolve to their map end to
  end; `osu!.db` v20260924 with 4325 folders reads; no osu! window to title against.
  Newest-`.osu` walk: 22,886 maps in 6.9 s.
- Real MSI install writes `HKCU\Software\Classes\.osz → Overtone.osz → "…Overtone.exe" "%1"`;
  full rebuild green with the same ICE warnings.
- 997 Python tests (12 new), all green; `facts.py`, `parity.py` green.
- Not checked: the browser harness.

---

## v1.0.0-stable — 2026-10-07 · Phase 26: feel, mods, copies, presets

### Changed

- **What the copy will feel like** (row 26.9): `feel_of` beside the stats — BPM range,
  density, the longest stream with its speed, exact AR/OD windows on standard. Other
  modes name whose tables they read instead of borrowing standard's.
- **Mod emulation** (26.10): HR/EZ/DT/NC/HT composing with keep/lock/scale. A lock names
  the feel and the file carries the compensation with the arithmetic shown (AR 9 under
  DT writes 7); contradictory pairs and game-capped combinations refuse saying so.
- **Undo and clean up** (26.15): the copies card lists the write log with dates, sizes
  and origins; the first click shows what goes, the second removes only what the log
  names — a stranger's map in the folder stays.
- **Presets** (26.20): named setups beside the cache, the same object as a build,
  applied onto the Train view with one click.

### Measured

- 985 Python tests (11 new), all green; `facts.py`, `parity.py` green; static UI pass
  clean in both languages.
- Not checked: the browser harness, like the section's.

---

## v1.0.0-stable — 2026-10-07 · Phase 26: rate ladders, one run one mapset

### Changed

- **`plan_ladder` / `build_ladder`** (row 26.16): a practice plan per rung, settled
  together so a refused rung refuses the ladder naming it; one audio file per
  distinct rate, each rung's own `.osu` through the atomic writer and the write log,
  samples and background once, checks per rung. At most a dozen rungs — past that a
  ladder is two ladders. One rate is a copy and twice the same rate climbs nowhere:
  both refuse with the reason.
- **A ladder card on the Train section**: comma-separated rates, one worker on the
  Train lock, one progress bar over the lot (`train_build_ladder`,
  `onTrainProgress` rung by rung), and a per-rung report with each rung's grade.
  Reports carry their kind so the copy and the ladder share the view.

### Measured

- Gate ladder on clicks: 1.0x worst 0.45 ms, 1.37x worst 0.34 ms, every rung's
  `.osu` naming its own song. 976 Python tests, all green; `train` gate green.
- Not checked: the browser harness, like the section's.

### Rejected / tried and dropped

- **Reusing one audio file across rungs.** Different speeds need different samples;
  sharing would mean resampling on load, which no player does. One file per distinct
  rate is the only shape an osu! folder can hold honestly.

---

## v1.0.0-stable — 2026-10-07 · The way out of alpha: 0.3.0 scoped, 1.0.0 pathed

### Changed

- **Release 0.3.0 scoped in the roadmap**: the first version without apologies — R6's
  verdicts, the Train harness pass, bought-and-integrated signing, the trainer's nicer
  rows (ladders, feel with mods, undo), every open question settled, file associations,
  section labels, H6/H7 or measured rejections. Real-audio accuracy stays out: that
  program is 1.0.0's.
- **Release 1.0.0 pathed as exit criteria, not a date**: Corpus B ≥ 40 % within 5 ms
  with median |error| ≤ 5 ms and every refusal explained, the 10.0a convention decided,
  no shipped word without a number, the auto-update question answered. For scale, today
  reads 2.1 % — the bar is ambitious on purpose, and the version waits for the
  measurement rather than the reverse.
- **R6 moves to 0.3.0 required**, with the override recorded: the verdicts were never
  given and the prerelease was ordered anyway. The sample, the sheet and the bar stand;
  nothing was silently dropped.

### Measured

- Nothing: this is scope. `bench/facts.py` ok.

---

## v1.0.0-stable — 2026-10-06 · The 0.2.0-alpha checklist, run end to end

### Changed

- **The product version is 0.2.0-alpha**, in a commit of its own: one line in
  `Cargo.toml`, the sixteen inter-crate pins with it, `Cargo.lock` following —
  the same shape as 0.1.0's bump.
- **`bench/corpus_b.py` fingerprinted the engine where it lives.** It hashed
  `ROOT/overtone.py`, which has not existed since the engine moved to `python/`
  in Phase 0, so every invocation crashed before scoring anything. It hashes
  `python/overtone.py` (and `python/overtone_rust.py` for the Rust engine) now.
- **The .NET SDK is per-user again** (10.0.401, the pinned one): the 0.1.0 session's
  install was gone — runtime only on PATH, sentinels in `~\.dotnet` — and the build
  refuses without it. Installed with Microsoft's `dotnet-install.ps1` to
  `%LOCALAPPDATA%\Microsoft\dotnet`, where `find_dotnet` looks second.

### Measured

- Every gate green on the bumped commit: 971 Python tests, 291 Rust tests, benchmark
  24/24 (median 0.0000 BPM / 0.16 ms), bpm-snapshot 24/24, golden 27/27, coverage,
  measures 3/3, signatures 6/6, robustness, reference 24/24, assisted 70/70,
  real-audio 4/6 (camisa-negra and shinkou absent here, named), perf inside every
  budget, combine, train (1.37x MP3 grades 1/1, worst 0.34 ms), fixtures 38,
  parity 386/687, facts, 3000 fuzz mutants (2838 read, 162 refused, none crashed),
  fit_kits 42/42, sbom 37 wheels, notices 87 components / 156 files / 5 offers.
  Rust: golden 27/27, nogrid refused, density 4/4 with 0 FP, elastic, map.
- Corpus B, 13 of 20 tracks (7 folders absent here, named): v3 2.1 % within 5 ms
  (82 s), Rust 0.4 % with 4 refusals by design (18 s); onsets median +23.0 ms after
  the maps' lines, -6.4 ms after Overtone's. A measurement, not a gate; the 1.7 %
  in the roadmap was the full 20 on 2026-09-26, so the two numbers cover different
  tracks and are not a drift.
- `build.py --clean`: `build: ok`, 468.5 s. Tree 1671 files / 316.9 MB. MSI 112.2 MB
  (`22339437…9b3638`), ZIP 138.2 MB (`82d2c5e1…ed2eda`), SBOM 87 components
  (`0930bbd6…62323a15`). ICE no error (ICE91 ×1671, ICE61 ×1, both as intended).
  Three smokes ok, each edm-174 at 174.0000 BPM through both engines and 8/8
  self-checks; the ZIP's writes stayed in `data\`, none in the profile.
- Installed over the machine's 0.1.0 with `msiexec /i /qn` from a non-elevated shell:
  the installed copy's own `--self-check` green at version 0.2.0-alpha, no
  `portable.txt`. Uninstalled: program folder gone, Start menu entry gone, the user's
  `.overtone.json` and `%LOCALAPPDATA%\Overtone` untouched. Reinstalled 0.2.0 after,
  self-check green — the machine keeps a working app, one alpha newer than it had.
- Not published: no tag, no GitHub release. R6's verdicts are still owed, and a
  release is the one thing that cannot be taken back.

---

## v1.0.0-stable — 2026-10-06 · Phase 25 closed: per-song backgrounds stay out

### Changed

- **Row 25.12 decided, not deferred**: per-segment backgrounds through an `.osb` move to
  Rejected ideas with the reason. Each song showing its own art mid-marathon is cosmetic,
  and nothing here can verify an `.osb` in osu! itself — a storyboard whose fades
  mistime is worse than one background that is right. The build carries the first
  segment's background through `[Events]` and counts every dropped event, video and
  storyboard line by name instead of silently. If a user asks for per-song art, the row
  comes back with a game to check it in. Phase 25 reads whole.

### Measured

- Nothing: this is a decision. `bench/facts.py` ok, so the counts these documents
  state still match the source.

---

## v1.0.0-stable — 2026-10-06 · Phase 26 step 3: the Train section

### Changed

- **A thirteenth sidebar section, Train** (row 26.21), with four cards: the source map,
  the rate and stats, the names, and what it would build. The whole view is drawn from
  one bridge reply: **every change re-plans in Python**, so the rate field, the feel
  line and the file list cannot drift apart. Eleven bridge calls, each returning the
  whole state; the build runs on **its own lock** with `onTrainProgress` / `onTrainDone`,
  refusing the analysis and the compilation while it runs.
- The stats carry their milliseconds beside every AR and OD (600 ms beside AR 9, not
  just the number), the feel line reads BPM, AR/OD windows, object count and the time
  at the rate, and a target BPM on several tempi offers each tempo with its rate until
  one is picked — the reference's two oldest bugs, answered in the UI where they bite.
- Bilingual EN/ES like every section; the i18n key-and-placeholder check holds both
  tables together.

### Measured

- 971 Python tests (5 new bridge tests), all green; `facts.py`, `parity.py` green.
- Static pass over the new view: every id it reads exists in the page, every string it
  names exists in both languages, every bridge call it makes exists on `Api`, every
  event the worker emits has a handler.
- Not checked: the browser harness in either language, which needs the pane. The row
  says so until somebody runs it.

---

## v1.0.0-stable — 2026-10-06 · Phase 26 step 2: the song at the rate, and the folder

### Changed

- **`build_audio`** (row 26.5): the whole song resampled in process with soxr at the rate
  ratio, nothing normalised or faded. **`verify_audio`** (26.7): the written length to
  two frames, the start correlated at 0.0 ms peak 1.0, and the encoder's own gapless tag
  read. **`grade_copy`** (26.17): the attacks of the built audio graded against the red
  lines written beside them — the end of the phase's own argument. **`build_practice`**
  (26.14): the folder straight for `Songs` (dry run, the song, the samples and
  background, the beatmap through the atomic writer and the write log, `.osz` flat),
  refusing existing folders and the source's own.
- Sample files and the background travel under their own names — the copy keeps its
  indices, unlike a compilation's remap. **Videos stay behind with the reason**: at
  another speed they would be a desync the copy owns.
- **`gates.py train` is whole** (26.22): the 1.37x MP3 folder with `.osz` builds and its
  one red line grades ok against the resampled clicks.

### Measured

- Gate's 1.37x MP3 on clicks: length exact, shift 0.0 ms, LAME tag present (13.061 ms
  written, stripped on read), grade 1 of 1 ok, worst 0.34 ms, common shift 0.34 ms. WAV
  grades the same, so the encoder adds nothing.
- soxr's suspected delay settled by measurement: a one-shot resample was read 1.9 ms
  late on abrupt bursts by peak-picking, but soxr, polyphase and Fourier agree **to the
  frame** on smooth onsets — filter ringing on the peak, not a shift of the edge — so no
  trim is applied and the grade keeps it honest per build.
- 966 Python tests (5 new audio/output tests since the 961), all green; `train` and
  `combine` gates green; `facts.py`, `parity.py` green.

### Rejected / tried and dropped

- **Trimming a resampler delay.** The probe was built (impulse through the same ratio)
  and then the measurement showed there is nothing to trim: the edge agrees across three
  resamplers. A per-build trim of a delay that does not exist would be arithmetic nobody
  asked for — the same rule the grid rows follow.
- **Carrying videos into the copy.** A 20 s video at 1.37x plays 14.6 s of pictures over
  14.6 s of song only if something re-times it, and nothing here does. The note names the
  files left behind.

---

## v1.0.0-stable — 2026-10-06 · Phase 26 step 1: the rate goes on the grid

### Changed

- **`python/overtone_train.py`**, the trainer's first three build-order steps minus the
  audio: the practice document (`plan_practice`, rows 26.1-26.2) through row 25.2's repair
  pass, the rate on the grid (26.3-26.4), the HP/CS/AR/OD settlement with the milliseconds
  beside every AR and OD (26.8), the honest target BPM (26.11) and the naming that keeps a
  copy from passing as the ranked map (26.13). Nothing here writes: the source is opened
  read-only and a practice copy is text plus a report.
- **The assembly preserves the file it was given.** Sections are patched in the file's own
  order — only the lines the rate or the naming reaches are repointed, with each line's
  own separator kept — and sections the phase knows nothing about (colours, variables)
  travel verbatim. A 1.0x copy is the source byte for byte bar the version line, which is
  what the gate checks.
- **Keep is the default for all four stats**, because scaling a typical AR 9 at 1.37x asks
  for AR 10.08 and a default must never refuse a typical map. An explicit scale past 10
  refuses with both numbers and names row 26.10's compensated map as the escape. HP and CS
  cannot scale (neither is a time) and mania's CircleSize cannot move at all.
- **Storyboard and video lines are carried as written and counted**, not scaled into a
  guess — the one deliberate gap in row 26.4's field list, said out loud in the docstring.
- **`bench/gates.py train`** (26.22's first half): the 1.0x round trip, every beat phase at
  1.37x against a pinned rounding bound, the AR/OD round trips, a target BPM refused on
  two tempi until one is picked, and 60 fuzzed sources. The written-audio grade waits for
  rows 26.5 and 26.17.

### Measured

- At 1.37x on the gate fixture: worst 6.75e-07 beats and 0.0002 ms from the beat each
  object sat on; the gate pins 0.01 beats and 1.0 ms, which is the rounding bound rather
  than a number tuned to a fixture. Snap audit on the copy: 0 of 4 unsnapped.
- 961 Python tests (12 new), all green; `gates.py train` green in 0.1 s; `facts.py`,
  `parity.py` green (the two new classes placed as python-only, like the combine rows).

### Rejected / tried and dropped

- **Scale as the AR/OD default.** It is the musically righter default for DT practice and
  it was the first version: AR 9 at 1.37x refuses (10.08 > 10), which would make the
  trainer refuse the maps it is for until row 26.10 exists. Keep never refuses; scale
  stays one explicit ask away with the refusal explaining itself.
- **Rebuilding the header sections from parsed dicts.** The first version wrote
  `[General]`/`[Editor]`/`[Metadata]`/`[Difficulty]` from dicts and added an `AudioLeadIn`
  the source never stated, so 1.0x differed by two lines instead of one. Patching the raw
  lines keeps the file's own separators and never invents a key.

---

## v1.0.0-stable — 2026-10-04 · Portable data, a real version, and a copy-out for bug reports

### Fixed

- **The portable ZIP shared a profile with the installed copy.** It was the installed tree in a ZIP, so both wrote settings, the result cache, the write history, the library index, dropped files and browser storage to `%LOCALAPPDATA%\Overtone` and `~\.overtone.json`. Running both on one machine made them overwrite each other's recents. `python/overtone_paths.py` now decides the folder: a build with `portable.txt` beside its executable keeps all of that in `data\` beside it. Only the ZIP carries the marker. An installed copy and a checkout resolve to exactly the paths they had before, so no existing install loses its preferences.
- **The window, the about box and every written `.osu` said "v3.0".** That was the Python engine's generation number, shown as the product's version. `app_version()` now reads the release: a frozen copy from the `build_info.json` its build stamps into `_internal`, a checkout from the workspace `Cargo.toml`, the same line `release.py` reads.

### Changed

- **A diagnostics card in Settings** copies the product version, the build's commit and time, the platform, the Python, whether the copy is portable and where its data is, the Rust engine found and the library index, as plain text. The window shows the text it copied, so the person sees exactly what leaves. Nothing is sent. The card has no error log: the app does not keep one yet.
- **The smoke test learns portability.** For a portable tree a run may change files only inside `data\`, and the scratch profile must hold none of Overtone's own state. The platform's own writes (numba's cache, the self-check's temporary audio) stay expected. The ZIP's verification runs this on its unpacked copy, so a portable build that writes to a profile fails the build.

### Measured

- A full `build.py --clean` at `f81efe5`: `build: ok`. The portable ZIP's unpacked copy: 1672 files identical to the tree, smoke ok, and the smoke test's own line reads `portable: writes stayed in data\, none in the profile`. The MSI's administrative install: 1671 files identical, smoke ok, and no `portable.txt`.
- The stamp in the built copy reads `0.1.0-alpha`, commit `f81efe5`. The window's `app_version()` in the checkout reads the same.
- Installed with `msiexec /qn` from a non-elevated shell: exit 0, no `portable.txt`, `build_info.json` present, the installed self-check `ok` with version `0.1.0-alpha`, and the self-check run against a scratch profile so the real cache was not touched. Uninstalled, exit 0, program folder gone, the user's `.overtone.json` untouched.
- In the browser harness, at 1280x800 and at 375x812: the card renders, the copy button is inside its card, no horizontal scroll, the text it copies reads correctly, and the Spanish strings read through. The copy itself is blocked in the harness's pane (`execCommand` refused by the browser), which the card's own fallback message reports; the same text stays visible beneath the button for copying by hand. Not checked: the two themes side by side.
- 949 tests, all green. `parity.py`, `facts.py` ok.

### Rejected / tried and dropped

- **Reading a last error for the copy-out.** The window shows errors inline and nothing keeps them, so the copy-out cannot carry one without a new error log. That is a row of its own if it is wanted; putting a half-kept log in a bug report would be worse than none.
- **Keeping `APP_VERSION = "3.0"` for the .osu headers.** It is the engine's generation, and a header that says v3.0 in a 0.1.0 release is a file that names a version nobody downloaded.

---

## v1.0.0-stable — 2026-10-03 · What 0.2.0-alpha has to hold

### Changed

- **A release scope in the roadmap**, which this repository has never had:
  seven **required** rows without which the version is not 0.2.0-alpha, seven
  that should be in it and will be if the required ones land early, and six
  that are deliberately out with the reason for each. 0.1.0-alpha was about
  being allowed to publish and added nothing a user could see; this one is the
  first with a reason to download it, and saying so in a table is cheaper than
  arguing about it later.
- The required rows are the rate trainer through its section and its gate
  (Phase 26, steps 1-4 of its own build order), Phase 25's last row settled
  either way, the portable ZIP's own `data\` folder, a diagnostics copy-out,
  the library health check's precision sample, and the release checklist run
  end to end. Two of those are debts rather than features: the ZIP currently
  shares a profile with the installed copy although the documentation promises
  otherwise, which is a bug in a published artefact, and the health check has
  been labelling maps actionable or weak since 2026-09-30 with no hand-checked
  number behind the words.
- **A diagnostics copy-out** is a new Phase 20 row, and required, because
  0.1.0-alpha is the first build strangers can install and there is no way for
  one of them to say what broke. Everything in it exists already -- the
  self-check writes it, the build summary names the toolchain -- and what is
  missing is a button that puts it on the clipboard. Nothing leaves the
  machine unless they paste it.
- Code signing stays out, named as the owner's purchase rather than left
  looking like unfinished work. Real-audio accuracy stays out too, with the
  sentence that matters written down: 0.2.0-alpha must not claim a number it
  did not move.

### Fixed

- **Two statements that had gone stale.** The pending list's third item and
  Phase 19's own introduction both said the Audio section was still to come.
  It has been in since 2026-09-27, holding all five of its panels, and the
  "Where we are" table had been counting it among the twelve sections for a
  week. Nobody had to make the two agree until a release had to be scoped out
  of them, which is an argument for scoping one.

### Measured

Nothing: this is a plan. `bench/facts.py` ok, so the counts these documents
state still match the source.

---

## v1.0.0-stable — 2026-10-03 · The octave stage's cost: a block eight times too wide

The one red gate the alpha shipped with, settled. It was not a regression: no
commit grew this cost, and the previous entry's suspect is wrong.

### Fixed

- **`long-6min/octave` cost 1.1 CPU s because `_tempo_hints` asked for
  tempogram blocks eight times wider than the constant that exists to keep
  them narrow.** The stage is two calls. `_beat_from_atoms` reads only the
  anchored window, so its cost does not grow with the track and measures
  0.000 s; all of the stage is `_tempo_hints`, and all of `_tempo_hints` is
  one `librosa.feature.tempogram` (decimate 0.000, join 0.016, mean 0.000,
  peak-picking 0.000). It passed `columns=8 * TEMPOGRAM_BLOCK`, on the stated
  grounds that the window is short enough that a wide block "cost little more
  than the call (0.05-0.08 s of CPU on a six to eight minute song)". That
  number was never true of this fixture: six minutes is 31,008 columns, and at
  192 lags of float64 an 8,192-column block is 12.6 MB whose FFT axis is
  strided 64 KB apart, with a 47.6 MB array to join after it. `TEMPOGRAM_BLOCK`
  already carries the reason in its own comment -- small "for the tempogram,
  whose column FFTs then stay in cache" -- so the override contradicted the
  constant it was built from. It is gone; the default stands.
- **Nothing the engine reports moves.** `_tempogram`'s blocks join bit for bit,
  which is its documented contract, so the aggregate the hints are picked from
  is unchanged -- `array_equal`, not a tolerance, at every width from 64 to
  8,192 on both perf cases. The accuracy gates agree: golden 27/27 stage for
  stage, which compares the octave decision itself, and bpm-snapshot 24/24.

### Measured

- `long-6min/octave`: **1.109 -> 0.328 CPU s**, 1.101 -> 0.367 wall, against
  the 0.453/0.449 pinned on 2026-09-27. `gates.py perf` green on all three
  cases, and `bench/perf_snapshot.json` is **untouched** -- the stage came back
  under the baseline it already had.
- The tempogram aggregate alone on long-6min, fastest of three, single-threaded:
  1.094 s at 8,192 columns, 0.953 at 4,096, 0.516 at 2,048, **0.359 at 1,024**,
  0.312 at 512, 0.188 at 256, 0.250 at 128, 0.266 at 64 -- bit-identical at
  every one. edm-174 is 5,168 columns and 7.9 MB and is flat across the whole
  sweep (0.031-0.078 s): it never leaves cache. That is why only the long case
  moved, and it is the cliff rather than the length that did it.
- Everything else green: 939 Python tests, benchmark 24/24 at median 0.0000 BPM
  and 0.16 ms, bpm-snapshot 24/24 unchanged, golden 27/27, coverage, measures
  3/3, signatures 6/6, robustness, reference 24/24, assisted, combine,
  real-audio 4/6 (two Songs folders are not on this machine; the gate skips and
  names them), fixtures 38, parity, facts, fit_kits 42 sounds, 3000 fuzzed
  `.osu` files, `sbom --check`, `notices --check`.
- **Not run: the Rust gates.** The whole diff is one expression in
  `python/overtone.py`; no Rust source and no golden vector moved, so running
  them would measure the build and not the change.

### Rejected / tried and dropped

- **`a3db993` "Sweep the pulse across the whole song, not just its seed" as the
  cause**, which the previous entry named on the reasoning that only the long
  case moved and that commit's cost is the one that scales with length. Wrong
  twice over. `coherence_map` and `map_ridge` are reached by nothing but their
  own tests -- the commit is additive and the analysis path never calls them --
  and, decisively, **the engine as it stood at the pinning commit itself costs
  1.078 CPU s in that stage today** against the 0.453 it recorded. Measured by
  loading `6b10b5b`'s `overtone.py` and `master`'s side by side in one process
  and running the perf gate's own stage timing on both, same fixture, same
  single-threaded environment: load 0.109/0.094, attacks 3.094/2.609,
  coherence 0.016/0.016, **octave 1.078/1.109**, sections 0.188/0.141. Their
  envelopes are identical too (same shape, same dtype, same 19,404 non-zeros),
  so it was not the data either. No commit grew this cost, and bisecting the
  seven would have found nothing.
- **Re-pinning the baseline**, which is where the suspicion led and which would
  have been the wrong answer: the cost was not bought for accuracy, so there
  was no trade to quote, and re-pinning would have been exactly the
  make-the-gate-green move the rule forbids. Why the pin reads ~0.44 s twice
  (`3ce8dbf` 0.438, `6b10b5b` 0.453, six days apart, both single-threaded) for
  work that measures 1.08 s on the same fixture, the same code and the
  versions `requirements.lock` names is **unexplained**. It stopped mattering:
  removing the waste put the stage back under the old pin, so the baseline
  stands as pinned and nothing was re-baselined.
- **256-column blocks**, the sweep's optimum at 0.188 s against 0.359.
  `TEMPOGRAM_BLOCK` already carries the cache reason and the fallback tracker's
  own tempogram is blocked by it, so a second width tuned to this machine's L2
  would be a number to re-measure whenever the machine changes, for 0.17 s on
  one stage of one fixture. 0.359 s is inside the pin with room.

---

## v1.0.0-stable — 2026-10-03 · A rate trainer, specified

### Changed

- **[Phase 26](07-roadmap.md#phase-26--rate-and-difficulty-trainer-practice-copies)**,
  twenty-two rows: a practice copy of one difficulty at another speed, with
  HP/CS/AR/OD where the user wants them. Asked for with
  [`funorange/osu-trainer`](https://github.com/funorange/osu-trainer) as the
  reference — 447 stars, C# WinForms, no licence file, last pushed
  2024-07-29. Its source, its thirteen releases and its 42 open issues were
  read on 2026-10-03; it was not run here.
- The features it has are the right features, so the phase is about what it
  leaves out, and its own issue tracker made the case better than a review
  could:
  - It divides every timestamp by the rate and rounds each on its own, so a
    map's snapping decays silently. **Phase 26 applies the rate to the
    grid**: scale each red line's `beatLength` exactly, recompute every
    object's time from the beat position it already held, round once, and let
    the snap audit prove it.
  - It takes the rate from one BPM, which is its two oldest open bugs (#19,
    #24). A rate scales every timing point; a *target* BPM is only offered
    when the map has one, and otherwise names the BPMs it has with the rate
    each would take.
  - It shells out to `soundstretch.exe` and LAME, and its issue #4 is the
    8-10 ms the re-encode moves the audio by. soxr is already pinned and
    libsndfile already writes MP3, in process, and the encoder delay is the
    problem **25.5 measured to 0.0 ms**.
  - It defaults to a pitch-preserving stretch, which moves the very attacks
    the red lines claim not to have moved. **Phase 4 already measured that**
    — a phase vocoder shifted attacks a median 23-24 ms, and a feature was
    dropped over it. So resampling is the default here, because it is what
    the game's own DT does, and the pitch-kept version is gated on the attack
    grade.
  - Five of its thirteen releases are "fix song detection after the newest
    osu! update", with three issues still open saying no maps appear, because
    it signature-scans osu!'s process memory through a GPL-3.0 library.
    **Nothing here reads another process's memory**: the map comes from the
    library index, and any live signal has to be something osu! writes
    outside itself and has to be measured before it is relied on.
  - Three of its issues are a laggy PC or a laggy tablet while it runs, which
    is what a `WH_KEYBOARD_LL` hook does to a machine. `RegisterHotKey`
    delivers one combination and lets every other keystroke alone.
- Four decisions recorded in **Rejected ideas** rather than left implicit: no
  invented star rating, no process-memory reading, no low-level keyboard
  hook, and no pitch-preserving stretch as the default.
- `04-ui-ux.md` §9 gains the one question this phase cannot answer for
  itself: the rule forbids drawing, moving and reshaping an object and says
  nothing about **subtraction**, which row 26.12 needs — a three-second
  spinner becomes two at 1.5x and unspinnable. The proposal is written down
  and the row is marked blocked until the owner settles it.

### Measured

Nothing. No code was written: this is a specification, and it says so. The
numbers it leans on are ones this repository already measured — 25.5's 0.0 ms
decoder delay, Phase 4's 23-24 ms of attack movement under a phase vocoder,
25.15's grade of a written red line against written audio — which is the
reason the phase can claim the reference tool's problems are already solved
here rather than hoping they are.


## v0.1.0-alpha — 2026-10-03 · The first release anyone else can install

The first artefact of this repository that leaves it. Everything here is
about being allowed to publish one and being honest about what it is.

### Changed

- **A `LICENSE` file.** `Cargo.toml` had declared MIT since the workspace
  existed and the README said so, but the text was never added, so nobody
  could legally redistribute a build. MIT, in the repository owner's name.
- **`installer/notices.py` gathers the bundled licences into the tree.**
  `docs/11-msi-distribution.md` had said since the first MSI that neither
  artefact should be published before this existed. The tree carries Python,
  31 wheels, 51 Rust crates and five native components, and most of their
  licences ask that their notice travel with the binary; four ask for the
  source as well. So the notices are read out of this build's own files — a
  wheel's from its `.dist-info` or from the package itself (soundfile keeps
  libsndfile's `COPYING` beside the DLL), a crate's from the cargo source
  cache the engine compiled from, Python's and Tcl/Tk's from the interpreter
  the venv was made from — and written as `LICENSE.txt` and
  `THIRD-PARTY-NOTICES.txt` in the tree's root. `installer/notices.json`
  holds only what no package carries: the five natives, the three components
  whose package ships no text, and one written source offer per copyleft
  family.
- **The MSI shows a licence page**, which it had skipped because there was
  nothing to put on it. `build.py` renders `LICENSE` to RTF at build time, so
  there is no second copy of the licence to drift from the first.
- **The release's SBOM and checksums.** `sbom.py --cyclonedx` builds
  CycloneDX 1.6 from the same component list the notices come from, so the
  inventory a tool reads and the one a person reads cannot disagree; the
  checksums file carries one SHA-256 line per published file and the two
  commands to check them.
- **The product version is 0.1.0-alpha**, not 4.0.0-dev. The old number was
  the engine generation — v3 is the Python engine, v4 the Rust one — and not a
  version of a program anyone had been given. Everything that names a version
  reads this one, so one line moves the artefacts' names, the MSI's numeric
  version and both executables' version resources.
- **A release checklist** in `docs/11-msi-distribution.md` (10.13.7), in
  order, with nothing automated: a release is the one thing here that cannot
  be taken back.

### Fixed

- **Two entries of `notices.json` named files the tree does not have**: the
  MSVC runtime's claimed the `api-ms-win-crt-*` stubs, and PyInstaller copies
  only `VCRUNTIME140.dll` and `VCRUNTIME140_1.dll`. They were written from
  what the documentation said the tree held instead of from the tree. A
  notice that over-claims is still wrong, and this one is read by whoever has
  to check what they installed.
- **This document's claim that the tree has no `_tcl_data` folder.** It does:
  this machine's Python 3.14.4 carries Tcl/Tk 8.6, whose script library is a
  folder, where the Python of the 2026-09-26 build carried Tk 9 with its
  scripts inside the DLL. That is most of why the tree went from 734 files to
  1670.

### Hardening

- **`notices.py --check` runs in `build.py`'s preflight**, not at the end: a
  missing notice is a reason not to build the artefact, not a failure after
  twenty minutes. It refuses a component with neither a notice text nor
  stated terms, a licence the package never declared, a **copyleft licence
  with no source offer recorded against it**, an offer that covers nothing
  the tree ships, and a hand-written native version that no longer matches
  the machine. The last one is the only way the five natives' versions can be
  kept honest, since no lock file holds them.
- The copyleft components are named and answered rather than hidden:
  libsndfile and libsoxr (LGPL-2.1), certifi and Symphonia's fifteen crates
  (MPL-2.0), and PyInstaller's bootloader (GPLv2 with the exception that
  makes a frozen application distributable at all). libsndfile's offer says
  the honest thing — the DLL is a separate file soundfile opens by name, so a
  build of your own replaces it — and libsoxr's says the other honest thing,
  that it is linked statically and replacing it means rebuilding that one
  module.

### Measured

`build.py --clean` at commit `c505211`, **325.7 s** in all: PyInstaller
109.5 s, the MSI 106.6 s, ICE 11.9 s, the ZIP 12.7 s.

| | |
|---|---|
| Tree | 1670 files, 316.8 MB, of which the notices are 1.08 MB (156 notice files from 87 components) |
| MSI | 112.2 MB, sha256 `6b2b147b…254b` |
| ZIP | 138.1 MB, sha256 `1b28a764…ec79` |
| SBOM | 87 components, sha256 `b7deca7f…7fb5` |
| ICE | no error; ICE91 ×1670 and ICE61 ×1, both as intended |

- **Three smoke tests, all ok**: the tree, the MSI's files by administrative
  install, and the ZIP unpacked. Each read edm-174 as **174.0000 BPM** through
  both frozen engines and passed **8 of 8** self-checks, each was byte for
  byte identical to the tree, and each came out of its run unchanged.
- **Installed and uninstalled on a real profile**, which the build cannot
  do for itself: installed with `msiexec /i /qn` from a **non-elevated** shell (exit 0),
  1670 files and 302.1 MB under `%LOCALAPPDATA%\Programs\Overtone`, both
  licence files there, and the installed copy's own `--self-check` green.
  The uninstall (exit 0) took the program folder, the Start menu shortcut,
  the `HKCU\Software\Overtone` bookkeeping key and the Apps-list entry with
  it, and left the app's own settings and cache alone. Worth writing down:
  the Apps-list entry lands in **HKLM**'s uninstall key, not HKCU's, even
  though the install needs no administrator and puts every file under the
  user's profile — a first check that looked only in HKCU concluded there was
  no entry at all
- The MSI's own tables, read back out of the package: `ProductVersion` 0.1.0,
  the `UpgradeCode` unchanged, and the chain
  WelcomeDlg → **LicenseAgreementDlg** → InstallDirDlg → VerifyReadyDlg with
  `LicenseAccepted = "1"` on the Next. The licence text sits in the `Control`
  table as the page's `ScrollableText` and not in the `Binary` table, which is
  worth writing down: looking in the wrong one of the two is a convincing way
  to conclude the page is blank.
- Every gate green on the published commit except one, Python and Rust
  both: 939 Python tests, 291 Rust tests, 24/24 on the benchmark, 27/27
  golden vectors, the octave snapshot, the measure, signature, robustness,
  reference, assisted, combine and real-audio gates, 3000 fuzzed `.osu`
  files, the five `overtone-bench` modes.
- **`gates.py perf` is red, and was red on `master` before this branch**
  (`ba6de58`, measured): `long-6min/octave` costs 1.062 CPU s against a
  baseline of 0.453, reproducibly, while every other stage of every case
  lands on its baseline. Nothing here touches the engine, and the baseline
  was pinned on 2026-09-27 (`6b10b5b`); the engine has changed seven times
  since, and `a3db993` "Sweep the pulse across the whole song, not just its
  seed" is the suspect, because it is the one that would cost more on a long
  track and only the long case moved. **Not re-baselined**: the rule is that
  a cost which grew on purpose is re-pinned in the commit that grew it, with
  the reason, and guessing which commit that was is not the same as knowing.
  It is a CPU budget on one stage and no accuracy gate moved, so it does not
  hold the alpha; it is the next thing to settle. (Settled in the entry above,
  and the suspect was wrong: no commit grew it. `_tempo_hints` had been asking
  for tempogram blocks eight times too wide since before either pin.)

### Rejected / tried and dropped

- **Code signing for this release** (10.13.6). It is a certificate to buy,
  not code to write, and an unsigned artefact that says so is better than a
  delayed one. SmartScreen will warn; the notes say it will, and give the
  `certutil -hashfile` line to check the download against the checksums
  instead.
- **WiX 6 or 7.** Both still ship the Open Source Maintenance Fee EULA and
  ask for its acceptance, which is the maintainer's decision and not the
  build's, so `dotnet-tools.json` stays on 5.0.2 (MS-RL alone). `dotnet tool
  restore` offers the upgrade on every run; the answer is still no.
- **Licences as CycloneDX `expression` fields.** Half of these strings
  ("BSD License", "Apache Software License") are what a wheel's own metadata
  says and are not SPDX at all. A `name` field states what is known; an
  expression would have claimed more.
- **True peak for the loudness cap**, from the previous entry, stands
  rejected for the same reason: it needs oversampling and the number is for
  headroom, not compliance.

## v4.0.0-dev — 2026-10-03 · A song's phrases, as the range to borrow

### Changed

- **`compile_sections`** (row 25.18) runs `overtone-cli structure` on one
  segment's song and returns its phrases — kind, start, end, level, repeats —
  kept by path, size and modification time, so the same song is read once
  however often it is asked about. The structure view's own engine, asked
  about a file instead of about the open song, and no analysis needed.
- In the app: **Phrases…** on each song's row, the phrases as chips, and
  clicking one makes it that segment's range through the same
  `compile_update` a typed range uses. So `start_on_downbeat` is what puts
  its edges on a bar line, and the repair list says if it leaves objects
  outside — which is usually the point: a chorus-only compilation is objects
  left outside on purpose.
- Without the Rust engine built it says `no_rust` rather than reporting that
  the song has no phrases.

### Fixed

- A third test that read its temp folder after the folder was gone. The
  zeroed shape a refused read now answers with made it fail quietly instead
  of raising, which is the behaviour the plan wanted and a poor error
  message for a test. Worth writing down: assertions belong inside the
  `with`.

### Measured

- In the harness, on a 20 s fixture: the phrase list came back as one verse
  0:00-0:20, the chip set the range to exactly that (`from: "given"`), the
  chips folded away, and both languages read clean. 929 tests, all green;
  the `combine` gate green.

## v4.0.0-dev — 2026-10-03 · The last check: every borrowed red line, on the built audio

### Changed

- **`verify_build(..., grade=True)`** closes row 25.15's fourth question:
  the attacks of the audio the build just wrote, graded against the red lines
  it wrote beside them (`_detect_attacks` and `grade_reference_timing`, the
  reference card's own tools). A borrowed red line is only right if the sound
  it was timed to is still under it after the cut, the resample and the
  encode, and nothing else in the phase could say that.
- Off by default and asked for, because it is the one heavy job here: a
  decode of the built audio and the attack pass over it.
- `build_compilation(grade=True)` passes it through, and the `combine` gate
  asks for it on its three-song MP3.

### Fixed

- **A test fixture whose clicks ignored its own grid.** Its audio put a burst
  every beat from 400 ms while its red line sat at 1000 with a 400 ms beat,
  so the grade read it as 200 ms off — correctly. The fixture now clicks from
  the line it writes. Nothing in the builder changed; the check found a bad
  fixture, which is what a check is for.

### Measured

- The gate's three-song compilation, written as MP3 and read back: **6 of 6
  red lines graded ok, none flagged, worst offset error 0.47 ms, common shift
  -0.05 ms**. The gate takes 8.5 s with the grade in it, up from about 5.
- 928 tests, all green.

## v4.0.0-dev — 2026-10-03 · An order to put the songs in, proposed

### Changed

- **`order_plan`** (row 25.19) proposes an order and never applies one. By
  **tempo**: every segment is tried as the opener, each one then takes the
  nearest tempo left, and the cheapest of those walks wins — exact enough for
  the handful of songs a marathon holds, and explainable in a sentence, which
  matters more for something that is shown rather than done. By **loudness**:
  quietest first, which needs row 25.6's measurement and says so when it is
  missing.
- It reports the jumps before and after, says when the order is already the
  one it would ask for, and leaves a song with no tempo of its own at the end
  instead of dropping it from the proposal.
- In the app: **Suggest an order** in the Songs card, with the proposal and a
  **Use it** beside it. The rule follows what is known — loudness once the
  volumes have been measured, tempo otherwise — because a proposal from
  numbers nobody has measured is a guess with a button on it.
- `compile_reorder` refuses an order that is not a permutation of the list,
  and drops the loudness measurement when the segments move, since a level
  was measured per segment.

### Measured

- Four songs at 180, 120, 175 and 125 BPM: the proposal is 180, 175, 125,
  120 and the jumps fall from **165 BPM to 60**. In the harness, three
  fixtures at 150, 128 and 174: "By tempo: 1 → 3 → 2. The jumps add up to 46
  BPM instead of 68", the same line in Spanish, and Use it applied it.
- 928 tests (652 engine + 276 web shell), 6 of them new.

## v4.0.0-dev — 2026-10-03 · Compilations: matched volumes and shaped junctions

### Changed

- **`segment_loudness`** measures a range the way ITU-R BS.1770 says to:
  K-weighted, 400 ms blocks every 100 ms, the absolute (-70 LUFS) and
  relative (-10 LU) gates both applied, every channel weighted 1.0. The two
  filters are **derived from the standard's analog parameters** rather than
  copied from the digital coefficients it prints for 48 kHz, so a 44.1 kHz
  song is measured without being resampled first. Read in chunks with the
  filter state carried across, so the answer is the same as one pass and the
  memory is one chunk.
- **`loudness_plan`** matches every song to the **median** of them (or the
  first, the quietest, or a number in LUFS) and caps what it asks for: never
  more than 12 dB, and never past the sample-peak headroom. A capped gain
  says which cap bit, and a range with nothing above the absolute gate in it
  gets no level at all rather than an invented one.
- **The gap can be counted in bars of the outgoing song** — it is that
  song's groove the gap is finishing — measured off the grid in force where
  its range ends, per plan or per junction.
- **`start_on_downbeat`** pulls each segment's range back to its own bar
  line, never forward: forward would eat the padding and could reach an
  object.
- **Fades in and out**, per plan or per segment, over the same ramp the 5 ms
  declick guard uses — the longer of the two wins, so asking for a fade can
  never remove the guard.
- In the app: **Match volumes** in the Songs card (on the build's own lock,
  with its own progress), each song's measured level beside its gain, and the
  four new joining controls.

### Measured

- The derivation reproduces the standard's published 48 kHz coefficients to
  **12 decimal places**, and a 1 kHz sine at -20 dBFS RMS reads **-20.0
  LUFS** in one channel — the standard's own calibration sentence. Halving
  the amplitude takes 6.02 LU off. Chunking the file changes nothing.
- In the harness, two fixture songs 10 dB apart: measured -23.05 and -33.05
  LUFS, matched to the median -28.05, gains -5.0 and +5.0 dB, both uncapped.
  A gap of 2 bars at 150 BPM in 4/4 came out 3200 ms.
- 922 tests (647 engine + 275 web shell), 16 of them new.

### Rejected / tried and dropped

- **The crossfade** row 25.7 asked for. The junction is silence by design: a
  break covers it, the health bar stops draining, and each song keeps its own
  grid. An overlap puts two tempos over each other for a second, which is a
  mix decision about music this tool does not otherwise make, and it would
  cost the streaming writer its one-block memory. Fades in and out do the
  audible part of the job.
- **True peak** for the clipping cap. It needs oversampling, and what the
  number is for is headroom — how far this segment may be raised — not a
  compliance claim. Said so in the docstring rather than implying more.

## v4.0.0-dev — 2026-10-03 · The Compile section: a compilation from the app

### Changed

- **A twelfth sidebar section, Compile** (row 25.14), with four cards: the
  songs in the order they will play, the joining settings, the names with the
  `credits.txt` it would write, and what it would build. The whole view is
  drawn from one bridge reply: **every change re-plans in Python**, so the
  list, the numbers under it and the file list cannot drift apart. Planning
  reads a few `.osu` files and each song's header, which costs milliseconds;
  a list that cannot disagree with its plan is worth more than that.
- **The app's first reorderable list.** Nothing in the shell let the user
  order rows before this — points sort by time, reports sort by severity —
  and here the order *is* the content, so each song carries Earlier, Later
  and Take out, and its own range, gain and gap.
- **Eleven bridge calls**, each returning the whole state: `compile_state`,
  `compile_add`, `compile_add_open_song`, `compile_remove`, `compile_clear`,
  `compile_move`, `compile_update`, `compile_settings`, `compile_metadata`,
  `compile_format`, `compile_pick_folder`, `compile_build`.
- **The build runs on its own lock**, beside the analysis's rather than
  sharing it: the analysis's lock belongs to one analysis and
  `stop_analysis` reads it to decide whether anything is running. The two
  **refuse each other** — this machine runs one heavy job at a time — and the
  build pushes `onCompileProgress` / `onCompileDone`, as the library health
  check does, instead of borrowing the analysis's progress bar and Stop.
- A folder that already holds a beatmap takes **two clicks**: the first says
  what is in the way, the second builds into it. Adding to a mapset is
  reasonable and a bad thing to do by accident.

### Fixed

- **`plan_compilation` crashed on a source it could not read.** The reader
  promised a refused segment would come back so a plan could show the whole
  picture, and then returned a short dict the plan asked `["mode"]` of. A
  refused read now answers every field a good one does. Found by a bridge
  test that outlived its temp folder.
- **The UI harness had been broken since the layout move**: it put the repo
  root on `sys.path` and the engine now lives in `python/`, so
  `/overtone-ui-check` could not start at all.

### Measured

- Checked in the browser harness at 1280x800, in English and Spanish, on two
  synthetic mapsets with real 44.1 kHz audio: added, reordered, a typed range
  (reported as cutting objects), a wider gap (the second song moved to
  22.952 s), names typed by hand, then built to MP3 — 6 files, **every
  segment's audio 0.0 ms out, 0 of 24 objects off the grid, the map
  byte-identical through the reader and writer**. No console error, no
  horizontal overflow, no clipped name, the credits box scrolling at 220 px.
  Not checked: the pywebview window itself, which cannot be driven.
- 905 tests (631 engine + 274 web shell), 11 of them new.

### Rejected / tried and dropped

- **Sharing the analysis's lock and progress panel** for the build. It is
  fewer moving parts and it would have made an encode look like an analysis:
  `setBusy` disables Analyze, every result-needing view says "Analyzing…",
  and the Stop button would have reached `stop_analysis`, which has nothing
  to stop.
- **A Stop for the build.** A half-written mapset is worse than waiting for a
  short job, and the longest build measured here is seconds.

## v4.0.0-dev — 2026-10-03 · Phase 25: a compilation builds end to end

### Changed

- **`metadata_plan` and `credits_text`** (row 25.13) settle what a
  compilation says it is. The artist and title are the ones the songs agree
  on, else "Various Artists" and "Compilation (N songs)"; a Unicode twin is
  carried only while the romanised field is still the songs' own, since under
  a label this builder invented it would be a different name for a different
  thing. `Creator` is a **placeholder** the report flags, because osu! wants
  the uploader's own name there and no source mapper made this.
- Credit is part of the feature. `Tags` carry every source mapper and artist
  as deduplicated tokens, and `credits.txt` travels with the mapset: every
  song in playing order with its difficulty, its mapper and the file it came
  from, and the one thing the tool cannot decide — whether those mappers are
  willing to have their work in somebody else's compilation.
- **`build_compilation`** (row 25.16) settles every plan and builds the
  beatmap text **before it writes a byte**, so a build that cannot be made
  refuses with nothing on disk. `dry_run` stops there and returns the list of
  files it would write. Then the audio, the samples, the `.osu` through the
  engine's atomic writer and the write history (so History names this build
  like any other write), `credits.txt`, and the background.
- It refuses a folder that already holds a beatmap unless told to add to it,
  and refuses **a source's own folder always**: a compilation reads other
  people's folders and has no business writing in one. `osz=True` zips the
  folder flat, built in a temp file and renamed into place.
- **`verify_build`** (row 25.15, three of its four checks) runs after every
  build unless turned off: each segment's audio correlated against its own
  song, the snap audit on the written map, and the text back through the
  reader and writer. The reference grade is the one left, since it needs
  attack detection over the built audio — the one heavy job in the phase.

### Measured

- The gate's three-song compilation now builds a whole mapset: **5 files**,
  `audio.mp3` 1.33 MB, the two custom samples, the `.osu` and `credits.txt`,
  plus a 1.19 MB `.osz`; **0 of 116 objects off the grid or before it, every
  segment's audio at 0.0 ms, and the beatmap text byte-identical through the
  reader and writer**. A dry run writes nothing. 894 tests (630 engine + 264
  web shell), 12 of them new.

### Rejected / tried and dropped

- **Writing a source mapper's name into `Creator`.** It is the only field
  with an obvious value and the wrong one: osu! reads `Creator` as the person
  uploading, so copying a mapper's name there would credit them with a
  compilation they did not make and did not agree to. A flagged placeholder
  says more than a plausible wrong answer.

## v4.0.0-dev — 2026-10-03 · Phase 25 step 3c: the junctions

### Changed

- **A break covers every junction** wide enough for one. It opens after the
  previous segment's last **sound** — a spinner or a hold is still playing
  after it starts, so a break that opened on the last object's time would
  open over gameplay — and closes before the next segment's first object,
  with 200 ms of air either side. Without it, the silence between two songs
  drains health.
- Breaks that meet or overlap are **merged into one**, since a junction
  break often swallows a source's own break sitting in the same silence, and
  two breaks over one moment is not something a map can mean.
- A break with no object on **both** sides of it is dropped with a count:
  osu! draws a break between objects, not off either end of a map, and a
  range that cut its objects can leave a source's break doing exactly that.
- **Kiai travels with its segment**, in the timing lines it brings and in the
  line pinned at its start, so a range that begins mid-kiai plays lit — and
  because the next segment brings its own red line, a span cannot leak into
  the next song.
- **A bookmark marks where each segment starts**, beside every source
  bookmark, so a compilation can be navigated song by song in the editor.
- **`preview_from`** takes `"first"` (the first segment with a preview point
  inside its range) or a segment number. Junction breaks and junction
  bookmarks can each be turned off.

### Measured

- The gate's compilation: **2 breaks for 2 junctions**, 4 in the file with
  the sources' own, 7 bookmarks for 3 segments. 882 tests (618 engine + 264
  web shell), 7 of them new.

## v4.0.0-dev — 2026-10-03 · Phase 25 step 3b: one set of numbers, and the slider speed it owes

### Changed

- **`difficulty_plan`** settles the numbers a beatmap holds one of — HP, CS,
  OD, AR, slider multiplier, tick rate, stack leniency — as the first
  segment's (the map the compilation opens with), the median, or a dict of
  values, with any field left out falling back to the first's and then to
  osu!'s own default. Every deviation is reported per segment in its field's
  own units: this is the one promise a compilation cannot keep, since AR 9
  and AR 7 cannot both be true, and the honest thing is to say which maps are
  being played at numbers their mapper did not choose.
- **Slider velocity is kept** where the difficulty cannot be. A slider's
  speed is the map's `SliderMultiplier` times the velocity in force, so a
  segment made at 2.0 under a compilation written at 1.4 keeps its own speed
  at 1.4286x. That ratio goes into **every** green line the segment brings
  and into a new one after **every** red line it brings — a red resets
  velocity to 1.0, and 1.0 under another multiplier is the wrong speed, so
  compensating only the first line would have left every later section of
  that segment running fast.
- **A velocity a green line cannot carry refuses the build**, naming the
  segment and the range of multipliers that would hold it. The bar is the
  0.1x-10x osu!'s own editor offers, which is the range a mapper can check.
- `SliderTickRate` has no such escape — nothing in a green line touches it —
  so a segment whose tick rate differs is reported and its sliders tick at
  the compilation's rate. Said out loud rather than left to be noticed.

### Fixed

- **A beat length written as `-70.000021`.** The velocity ratio was rounded
  to six places in the report and then used to compute the line, so the one
  number that had to be exact was the one that had been rounded for display.
  The ratio is kept exact and beat lengths are written with up to six places
  and no trailing zeros, so `-70` and `-87.5` come out as themselves.

### Measured

- The gate's third source is made at `SliderMultiplier` 2.0 against the 1.4
  written: **4 of its 4 red lines carry the 1.429x**, the two segments at the
  written multiplier gain nothing, and `slider_multiplier` is named as what
  that segment gave up. 875 tests (611 engine + 264 web shell), 8 of them
  new.

## v4.0.0-dev — 2026-10-03 · Phase 25 step 3a: whose hitsound plays

### Changed

- **`sample_plan`** gives every segment its own sample indices, and
  **`build_samples`** copies the files under their new names into a folder
  the caller gives it — copies, never moves, and never writes into a source
  folder. Two segments both asking for index 3 ask for the same
  `soft-hitclap3.wav`, and only one of those can sit in a mapset folder:
  whichever was copied second silently replaced the other's hitsounds. That
  is the reference tool's one real trick and the easiest thing in this phase
  to get subtly wrong.
- **Index 0 is never remapped.** On a timing point it means "the skin's" and
  on an object "whatever the timing point says": instructions, not files.
  **Index 1 is remapped** like any other, because the bare
  `soft-hitclap.wav` it asks this folder for is a name two segments can both
  want.
- Every line that asks for an index or a file is rewritten with it: the
  timing lines, the lines the builder pins at a segment's start, and the
  objects — where a slider's hit sample is the eleventh field, a spinner's
  the seventh, and a mania hold's shares the sixth with its end time. The
  reference tool reads that field as a slider end time, which is the one
  thing it never is.
- A file an object names outright keeps its name where it can. Two segments
  naming one file with different bytes rename the second and its objects
  follow; two naming the same bytes share one copy (SHA-1). Numbered bank
  files are copied per index even when identical, because there the index
  *is* the name.
- An index whose file the folder does not have stays missing after the
  remap, so osu! falls back to the skin exactly as it did in the source.
  That is reported as `falls_back`, not as a fault: it is what most maps do.
- The segment reader now lists every index **1 and up** as used, with the
  numbered ones as `custom` beside it. The `pending` entry for row 25.8 is
  gone from the build report, replaced by the plan it owes.

### Measured

- The gate's two sources that both ask for index 3 with different sounds in
  it: index maps `{3: 1}`, `{3: 2}`, `{3: 3}`, both files copied, **neither
  replaced**, and no source folder written to. 867 tests (603 engine + 264
  web shell), 10 of them new.

## v4.0.0-dev — 2026-10-03 · Phase 25 step 2: the audio cut, and nothing to compensate

### Changed

- **`build_audio`** writes one audio file holding every segment's range where
  the plan put it. The plan's `at_ms` is the authority, not a running sum:
  the shift was rounded to a whole millisecond so the objects could keep
  their snapping, and the audio has to land on the same rounding or the two
  drift apart. Each segment goes in at `round(at_ms * rate / 1000)` frames
  with silence in front of it, so what the plan calls a gap is simply the
  silence between two of them.
- Written a block at a time: the peak working set is one block, not one
  compilation — two hours of 44.1 kHz stereo float32 in one buffer would be
  2.5 GB. A segment whose song runs at another rate is resampled in one
  piece (`resample_poly`, exact rational arithmetic) and the report says
  which segments that happened to.
- Output rate is the highest any segment brings, so nothing is downsampled
  into a compilation, and stereo if any segment is stereo. Nothing is
  normalised, nothing is filtered: past a 5 ms declick ramp at the edges of a
  range that brought its own padding, the samples written are the sources'
  own, bit for bit. A range somebody typed gets no ramp at all — it starts
  where they said, hit or no hit.
- **`verify_audio`** reads the written file back and correlates each
  segment's own window against its own song (`shift_samples`, the audio
  swap's aligner), so row 25.5 can be said to hold rather than hoped to. The
  gate runs it on both formats.

### Fixed

- **The junction check correlated past the end of a segment**, into the gap
  and the next song, and read a peak of 0.643 where the answer is 1.000. The
  window is now the segment's own length. Found by the test for it.

### Measured

- **MP3 is gapless here, so there is nothing to compensate.** libsndfile
  1.2.2 encodes through LAME 3.100, writes the tag (delay 576 samples,
  padding 972) and strips it again on read: a click written at *t* comes back
  at *t* — 0.0 ms on four probes through a 45 s file, frame count identical,
  correlation peak 1.000. Row 25.5 was written expecting to measure a delay
  and fold it into the offsets; the measurement says the fold is zero.
- The gate's three-song, 162 s compilation: **WAV 14.3 MB written in 0.3 s,
  samples bit for bit the sources' own, every segment at 0.0 ms, peaks
  1.000**; **MP3 1.3 MB in 0.9 s, every segment at 0.0 ms, peaks 0.998**.
  Checking each costs 0.3-0.5 s.
- Tests 857 (593 engine + 264 web shell), 10 of them new.

### Rejected / tried and dropped

- **Ogg Vorbis as the default**, which the phase was written around because
  it is sample-exact and osu! reads it. Writing more than about ten seconds
  of 44.1 kHz stereo through this libsndfile build **kills the process**:
  exit 127, no exception, nothing written (5 s and 10 s fine; 20 s, 30 s and
  45 s dead, reproducible). **Opus** refuses 44.1 kHz outright — it takes 8,
  12, 16, 24 and 48 kHz. So the format decision was made by what survives,
  not by what reads best on paper.

## v4.0.0-dev — 2026-10-03 · Phase 25 step 1: a compilation's plan, read and shift

### Changed

- **`python/overtone_combine.py`**, a new module, holds the compilation
  builder's first three rows. Nothing writes a file yet: `read_segment` reads
  one source and says what is wrong with it, `plan_compilation` places an
  ordered list of them, and `combine_beatmap` returns the assembled `.osu` as
  text.
- **The shift is a whole number of milliseconds and the junction absorbs the
  remainder.** osu!stable writes object times as integers, so a fractional
  shift would re-round every whole millisecond a source had — a mapper's own
  snapping, lost to arithmetic nobody asked for. Half a millisecond on a gap
  this builder invented is inaudible.
- **Each segment is pinned at its start with the grid and the sound its own
  map had there**: the governing red line's own beat length, taken from that
  line's raw digits, placed by **whole beats** so the phase is the one the
  mapper set, plus the sample set, index, volume, kiai and slider velocity in
  force at that moment. Without it a segment inherits whatever state the
  previous song ended in. A red sitting at or after the range's start is left
  alone — a red says everything about the state at its own time, and
  restating it would overwrite its fields with an earlier green's.
- **`bench/gates.py combine`** (row 25.17's first half) compiles three songs
  and measures the result against the maps it borrowed from, recomputing
  rather than believing the report.
- The report carries a `pending` list naming what rows 25.8, 25.9, 25.10 and
  25.13 still owe — unremapped hitsound indices, unreconciled slider
  multipliers, the first segment's difficulty and its metadata — so what the
  builder writes today is not mistaken for what it will write.

### Fixed

- **A map naming `song.wav` for a `Song.WAV` read as correct on Windows.**
  `(folder / name).is_file()` answers with the file it has whatever the case,
  so the mismatch that silences a mapset on a case-sensitive filesystem was
  invisible from here. The folder's own listing is now the truth, and finds it
  on either platform. Found by the test for it failing.
- **The pin's safety check compared against the first object of the map, not
  of the range**, so a range typed into the middle of a song refused a
  junction that was fine. Found by the gate on its second run, on the one
  case given a typed range.

### Hardening

- 60 mutants of a source map from `fuzz_reader.mutate` go through the reader
  each time the gate runs: 60 read, 6 of them refused, 0 crashed.
- A file that will not read comes back refused rather than raising, so a plan
  of five songs can show all five including the broken one. An unknown
  setting or source key raises instead of silently keeping the default.
- The reader never decodes audio — the length comes from the header — so a
  plan of several songs is not several heavy jobs.

### Measured

- Three songs compiled (edm-174; odd-222.22 from the middle of its song, so
  its grid has to be pinned; secs-4, four red lines, a different
  `SliderMultiplier`): 116 objects, **worst displacement inside a segment
  0.00e+00 ms**, worst phase error 1.14e-13 ms on a carried grid and
  **2.84e-04 ms on the pinned one** — the three decimals the file writes, 20
  nanoseconds of audio at 44.1 kHz. Every beat length digit for digit, 0 of
  116 objects off the grid or before it, and the writer gives the text back
  byte for byte. The gate runs in 2.0 s.
- Tests 847 (583 engine + 264 web shell), 42 of them new.

### Rejected / tried and dropped

- **Putting the pinned red line at the segment's start** instead of stepping
  the mapper's own line there by whole beats. It is simpler, and it moves
  every bar line in the segment by however far that start happens to sit from
  the mapper's beat — up to a whole beat, which is 270 ms on the gate's
  222.222 BPM case.

## v4.0.0-dev — 2026-10-03 · The compilation builder, specified; §9's line redrawn

Documentation only. Nothing was built, measured on the corpus or shipped.

### Changed

- **Phase 25 — Compilation builder (marathon maps)** in the roadmap, asked for with
  `frankhjwx/osu-map-combiner` as the reference: several maps and their songs into one
  map and one audio file, every borrowed object on the beat of the sound it had. Twenty
  rows, the build order, every timestamp the shift has to touch, the repair pass for
  half-wrong input, what it refuses, and the gate (`gates.py combine`) that would hold
  it. The reference's source was read, not run; the comparison table says which of its
  choices this repo cannot make (timing points found by substring, format v14 hardcoded,
  the sixth field read as a slider end time when it is a curve, a spinner's end time and
  a mania hold's `end:sample` in turn, breaks and events dropped, `SliderMultiplier`
  compensated only for negative BPM, GB18030 filenames, FFmpeg).
- **`04-ui-ux.md` §9** drew its line where the reason for it was. "No beatmap editing
  beyond hitsounds and timing" now reads: Overtone never draws, moves or reshapes an
  object on its own; copying whole maps' objects unchanged and moving them in time with
  their audio is bookkeeping and allowed. Decided by the owner, 2026-10-03. The Rhythm
  guide, which would invent objects from the audio, is still out — so the proposals
  waiting on a decision go from three to two.
- The sidebar gains a **Compile** entry in the target layout and the proposed-modes
  table.

### Measured

- **libsndfile 1.2.2, already pinned behind `soundfile`, writes audio as well as reads
  it**: `sf.available_formats()` lists MPEG Layer I/II/III and OGG with Vorbis and Opus
  subtypes. So the reference tool's hard FFmpeg dependency is not needed here, for the
  same reason FFmpeg left the engine in the first place (audit **F-06**), and the phase
  can cut and join audio offline with what is installed. The encoder's own delay is not
  measured yet — row 25.5 exists to measure it rather than assume it is zero.

### Rejected / tried and dropped

- **Tempo-matched junctions** (25.20) are written down as unlikely, not planned. Phase 4
  measured the phase vocoder moving attacks a median 23-24 ms when it was tried for the
  pitch-kept slow loop, which is the error this whole phase exists to avoid. It ships
  only if a measurement on the corpus says otherwise.
- **Per-segment combo colours** are not a trade-off, they are impossible: osu! holds one
  `[Colours]` block per map and cannot change it mid-map. Per-segment *backgrounds* can
  be done, through an `.osb` with timed fades, and that is row 25.12.

## v4.0.0-dev — 2026-10-03 · H7 engine: hitsound proposals with no map

### Changed

- **`overtone-cli hitsound <audio>` with no map** proposes on the song
  alone: strong attacks on the detected grid (weight ≥ 0.5, residual ≤ 5 ms;
  null-residual passing on loudness) become the object set — no combos, no
  prior, the map-default bank, no bar numbers and so no phrase-symmetry
  bonus — decided by the same emission+Viterbi core H4 runs, reported with
  `"mode": "audio-only"`. `Unit.object` is now `Option` (null for these).
  The bridge takes `osu=None` for it. Bare `hitsound` still exits 2; a
  missing audio file exits 1.
- **`bench/eval_audio_only.py`** (a measurement, like Corpus B): H4 vs
  audio-only joined at ±50 ms (coverage, same-sound agreement), plus mapper
  clap/finish/whistle F1 over the same join, tails aside on both sides.

### Measured

- On 6 mapped songs: median H4 coverage 0.31, same-sound agreement 0.12;
  mapper clap F1 0.29, whistle 0.06 (finish too rare to score) against
  P-6's clap rule 0.59. The bare-map control localises the gap: full H4 vs
  H4 on sounds-stripped copies agrees only 0.19, while stripped-H4 vs
  audio-only agrees 0.50 — half the gap is the mapper prior, which
  audio-only lacks by design, and the rest is different unit sets plus no
  combos or symmetry. Modest for a v1, and honest about why.
- The app surface is still open (a Propose that needs no map, and somewhere
  to write it), so H7 stays open in the roadmap with the engine marked done.

## v4.0.0-dev — 2026-10-03 · hitsound-classify; isolated one-shots don't transfer

### Changed

- **`overtone-cli hitsound-classify <sample.wav> [...]`** (H6 groundwork).
  Each isolated sample's instrument class from the baked templates over the
  same extractor the song path runs, best first with probabilities, as JSON.
  The first detected attack is read; a sample that starts at full amplitude
  has no peak for the song detector (edges are never peaks), so one with no
  attack is read at its first sample above 0.02, else at its middle. Exit 1
  when a file cannot be read (the rest are still classified), 2 on a bad
  command.
- **`overtone-audio::load_sample`**: decode, resample, scrub and
  peak-normalise like `load` but with no two-second floor — a hitsound is
  shorter than a song by design. `load` keeps refusing short files; the
  shared tail now lives in one `prepare()`.

### Measured

- **Baked templates do not transfer to isolated one-shots**, so H6's
  sample→role recommendation is not shippable on them. Over Overtone's own
  18 samples (`assets/samples/`, recipes known): finishes read cymbal 3/3
  (0.77–0.86); soft-hitclap reads clap 0.52; drum-hitclap reads snare 0.45;
  drum-hitnormal (150→52 Hz sweep, a kick by recipe) reads snare 0.86,
  normal-hitclap (a clap) reads kick 0.64, normal-hitwhistle (a 1760 Hz
  tone) reads snare 0.72. A textbook 60 Hz decaying kick reads snare 0.97.
  Padding with 0.5 s of leading silence changes nothing (same tops), so it
  is not framing — the baked fit is song-context narrow. Ranking per role
  fails the same way (kick role would take normal-hitclap at 0.64).
- The command itself is exact: silence reads `other` 1.0 with null
  `attack_s`; a rendered corpus kick's attack lands at 0.5 s; two runs are
  byte-identical JSON; 13 classes sum to 1.0 best first.

### Rejected / tried and dropped

- **Top-1 sample→role recommendation off the classifier.** It would offer
  a clap for the kick role and a snare for the whistle. Dropped after the
  table above; `recommend` waits with instrument lanes and the clap-mismatch
  rule until the templates hold on real audio. The `hitsound-classify`
  command stays: it is the instrument to measure that work with.

## v4.0.0-dev — 2026-09-30 · Corpus B refusals, explained; the tie-break stands

### Measured

- **Four Rust-only refusals are by design.** one-step-closer, vampires,
  calm-down-juliet and day-to-story refuse with `no_coherent_pulse` (best
  share 0.26–0.47); v3-precision refuses them too and the legacy fallback
  answers (4, 22, 3 and 3 lines). Rust has no fallback by design and the app
  falls back to v3, so there is nothing to fix.
- **The Raven is refused by both** (Rust share 0.46): even the fallback's
  periodicity gate fails (gap 0.024 under the 0.07 floor) on the 363-line
  prog epic. Genuinely hard; assisted timing is the route.
- **FREEDOM DiVE is understood to the stage.** Attacks identical (4,668 and
  4,668), sections identical, global BPM identical (222.22), same 2,160 ms
  bar grid with downbeats 69 bars apart -- and the points stage diverges: v3
  keeps the opening 8-beat segment (807 ms, 222.22, matching the map's 4/4 at
  222.22) while Rust keeps a mid-track 12-beat one (149.8 s, 333.33). The
  three meter segments score 0.386/0.386/0.374, all under the 0.75 bar, and
  12 µs of upstream phase noise moves the winning score 4.3e-4, flipping the
  best-confidence survivor.

### Rejected / tried and dropped

- **Keeping the earliest weak survivor.** It repairs FREEDOM DiVE (BPM 0/1 →
  1/1) but moves jungle-dragon 3/7 → 0/7 and noble 5/10 → 0/10 within
  0.05 BPM on Corpus B (BPM −7 net): weak survivors are track-dependent
  noise, and neither max nor earliest dominates. Reverted and re-verified;
  the divergence stands as understood, not safely fixable by tie-break. A
  real fix lives upstream (phase noise) or in a better confidence model.

## v4.0.0-dev — 2026-09-30 · The pinned wheels' licences, inventoried

### Changed

- **`installer/sbom.py` + `sbom.json`** (Phase 10.13, SBOM groundwork). The
  MSI/ZIP tree bundles the venv's wheels, so publishing needs their licence
  notices, starting from knowing what is in there: every pin of
  `requirements.lock` (shipped) and `requirements-build.lock` (build-time
  only) with the licence its installed metadata declares, as a short
  identifier (SPDX, OSI classifier, or short License line, else an explicit
  UNKNOWN). `sbom.py --check` fails on drift, and a unit test holds the
  committed file to both locks.

### Measured

- 37 wheels: 31 shipped. One LGPL (soxr), one MPL (certifi) and 2 UNKNOWNs
  (clr-loader, pyinstaller-hooks-contrib) flagged for the notice-gathering
  step; scipy's multi-kilobyte License field (GPL text included) stays out
  of the inventory by rule. Native bits no wheel carries (libsndfile, Tcl/Tk,
  WebView2, MSVC runtime, Python itself) are out of scope here by decision.
- 803 Python tests (539 + 264), 287 Rust; facts green.

## v4.0.0-dev — 2026-09-30 · The hitsound role reads the map's red lines

### Changed

- **`map::map_role` and a map-first hand rule** (docs/06 §11). The hand role
  rule read the audio grid's division and weight, which match the map's bars
  a quarter of the time; on bare maps every profile placed claps at chance.
  Where the caller read a map grid -- the CLI's decide step always has one
  -- the hand rule now uses the object's division and weight off its
  governing red line (slot 0 the downbeat, as `bar_slots` counts it).
  Measured tables, the silence behavior and `hitsound-evidence` (audio-only
  by design) are untouched.

### Measured

- 12 drum-style bare maps, Balanced, same sample before and after: clap F1
  0.331 → 0.429, finish 0.093 → 0.403. Two Rust unit tests pin the rule and
  its priority over the audio grid (the priority one fails inverted).
- 799 Python tests (535 + 264), 287 Rust; workspace, facts and parity green.

### Rejected / tried and dropped

- **Moving the whistle arm with the role.** Mapper whistles sit 72.6 % on
  quarters over 1,241 whistles of the same sample, so the old off-beat
  preference had the sign backwards -- but rewarding quarters whistles bare
  kicks (a Viterbi arrangement test holds that), and staying neutral
  proposes fewer whistles than either (F1 0.124 against 0.165). Position
  alone cannot tell melody-on-beat from drums-on-beat, so the hand whistle
  rule stays until it gets a measured table or a fit of its own; the
  marginal stands as the datum for that work.

## v4.0.0-dev — 2026-09-30 · The library health check gets its page

### Changed

- **Timing health in Library** (Phase 19/21). The engine half graded every
  map and kept it; there was no page, and its flags could not separate steady
  maps from moving ones (26 of 44 steady flagged). The page lists flags with
  the evidence behind each line and marks a map worth a look only when a
  flagged line rests on a solid fit (12 or more attacks, share 0.60 or more);
  the rest read as weak leads, never as wrong maps.
- **The rule decision** (the roadmap's open item): presentation-layer, no
  engine change. Attack counts overlap a real flag (14 attacks, share 1.0 on
  clean clicks) with the artifacts (11-19 attacks, share 0.41), so the share
  separates and the count is only a sanity floor above the grading's own
  minimum of 8.
- `Api.health_state/health_start/health_stop/health_report`: a resumable run
  on a worker thread (never blocks a bridge call), progress and end as JS
  events, stoppable at the next audio file; the report carries per-map
  evidence and the actionable mark.

### Measured

- Synthetic: a +20 ms moved line grades `check` with relative −20 ms and
  reads actionable; its on-grid twin reads `ok` (bridge tests).
- Real, 20 audio files and 91 maps through the Rust sidecar: 41 flagged, 32
  actionable, 9 weak leads at share 0.52–0.59 — the mediocre-fit flags the
  audit worried about, demoted instead of listed as wrong.
- 799 Python tests (535 engine + 264 web shell), 285 Rust; facts and parity
  green. No precision claim: separating moving from steady maps still wants
  the hand-checked sample.

## v4.0.0-dev — 2026-09-28 · A crash and a snare read the same to the engine

### Measured

- **Two labels instead of one.** A mapper's clap says snare-or-clap and a
  finish says crash, and a moment carrying both is a crash on a snare (21 % of
  finishes), which belongs to neither. Over 12 ranked songs, 7,772 held-out
  attacks with 1,301 snares and 152 crashes among them, fitted on the other
  eight songs:

```
                                  as it ships    curves on real audio
  snare against everything else         0.525                   0.753
  cymbal against everything else        0.563                   0.636
  cymbal against snare only             0.491                   0.810
```

- **The last row is the one that matters.** Asked which of two sounds a moment
  is — the question a softmax puts every time it decides — the engine answers
  0.491 on real music. That is a coin toss, on the distinction its whole
  hitsound proposal rests on: a crash takes a finish, a snare takes a clap.
- **Fitted together on real audio, the same features answer at 0.810.** Nothing
  was added, no class was invented; the curves were placed between the tenth
  and ninetieth percentile of real attacks and the three classes were fitted as
  one softmax, so they compete exactly as they do in the engine.
- This also answers the worry that re-placing the curves would unbalance the
  classes against each other: the mutual separation is what improves most.

### Rejected / tried and dropped

- **Shipping this fit.** It knows three classes — snare, crash, everything else
  — and the engine has thirteen. Dropping ten of them would lose the kick, the
  hats, the toms and every melodic class, which are what keep a clap off a bass
  note. What this measures is that the ceiling is far above where the engine
  sits, and that the gap is placement rather than evidence.

## v4.0.0-dev — 2026-09-28 · The classifier is worse than its own best feature

### Measured

- **On real music the classifier barely tells a clapped attack from a bare
  one.** Over 7,772 held-out attacks of songs the numbers below never fitted
  on, `P(snare)+P(clap)` ranks a clapped attack above a bare one **52.6 %** of
  the time. Chance is 50.

```
  the classifier as it ships                     0.526
  the best single feature (percussive ratio)     0.687
  the same features, knots on real audio, refit  0.743
```

- **It is beaten by one of its own ingredients**, and by three of them: the
  percussive ratio alone reads 0.687, flux 0.680, the low-mid ratio 0.670. A
  classifier that scores worse than a feature it already carries is not short
  of evidence; it is throwing evidence away.
- **The knots are where it goes.** The response curves were placed on isolated
  synthetic drums. The percussive ratio has to reach 0.45 before it counts for
  anything, and real attacks sit between 0.08 and 0.44 — so the single most
  discriminating feature contributes **zero almost everywhere**. Flatness asks
  for 0.25 and real claps read 0.036. The weights never see those features,
  whatever they are set to, because the clipping happens first.
- **Put the same curves where the data is and the same features reach 0.743**,
  fitted on two thirds of the songs and scored on the other third. Nothing was
  added: the features, the shapes and the fitter are the ones already there.

### Rejected / tried and dropped

- **Shipping that fit.** A mapper's clap labels one thing — snare-or-clap —
  and the classifier has thirteen classes. Re-placing two of them from this
  label would leave the other eleven on synthetic knots and the softmax
  comparing the two domains against each other. What this measures is the
  headroom, and the headroom is large; spending it needs labels for more than
  one class, which is what the P-6 corpus row is for.
- **Re-fitting the weights alone** (keeping the knots): 0.534, against 0.526.
  It confirms the diagnosis rather than fixing anything — the weights are not
  where the loss is.

## v4.0.0-dev — 2026-09-28 · The templates lean on the features that say nothing

### Measured

- **Before moving a knot, the prior question**: on real music, does a feature
  separate the attacks mappers clap from the attacks they do not?
  `bench/templates_on_real_audio.py --features` answers it over 5 ranked songs,
  2,770 clapped attacks against 14,948 bare ones, as the chance a random
  clapped attack reads higher than a random bare one.

```
  feature            AUC     clapped p25/med/p75        bare p25/med/p75
  flux             0.683     0.355  0.455  0.554        0.285  0.356  0.441
  percussive_ratio 0.678     0.122  0.246  0.444        0.085  0.133  0.217
  low_mid_ratio    0.657     0.166  0.262  0.405        0.089  0.163  0.310
  sub_ratio        0.363     0.006  0.019  0.075        0.010  0.089  0.184
  decay_tau_s      0.422     0.282  0.876  2.000        0.420  2.000  2.000
  flatness         0.417     0.019  0.031  0.041        0.027  0.035  0.053
  high_ratio       0.570     0.007  0.016  0.031        0.005  0.012  0.023
  high_mid_ratio   0.560     0.057  0.092  0.140        0.042  0.080  0.127
  zcr              0.525     harmonicity 0.521   f0 0.517   formant 0.510
  rise_s           0.509     mid_ratio 0.494   centroid_hz 0.492   air 0.479
  sustain_s        0.461     sub_attacks 0.451
```

- **The two best discriminators are not in the snare or clap template at all.**
  Flux (0.683) and low-mid ratio (0.657) are absent from both; percussive ratio
  (0.678) is the one they do carry. Meanwhile the snare template's heaviest
  term is the mid ratio, which reads 0.494 — a coin toss — and the clap
  template weights sub-attacks at 1.0, which reads 0.451.
- **Flatness points the wrong way.** The snare template asks for it to rise
  from 0.25 to 0.55; on real audio clapped attacks read *lower* than bare ones
  (0.031 against 0.035, AUC 0.417) and never reach the first knot at all. It is
  not that the knots are misplaced — the curve is upside down for real music.
- What this does not say is that the templates are wrong about drums. They were
  fitted on isolated synthetic hits and they separate those cleanly; the
  measurement is about a mix, where a snare arrives with a bass note, a guitar
  and a voice inside the same window.

### Rejected / tried and dropped

- **Re-setting the knots from these numbers and re-baking.** The weights are
  fitted on the synthetic corpus, so a term the corpus cannot see gets a weight
  near zero however well it separates real music: adding flux and low-mid to
  the snare template and re-fitting on synthetic drums would change nothing
  where it matters. The fit has to see real audio before the knots are worth
  moving, and that is a corpus and a fitting path, not an edit — stated here
  with its numbers so the next attempt starts from them.

## v4.0.0-dev — 2026-09-28 · The separation was not the cause. The corpus is

### Fixed

- **Yesterday's conclusion was wrong, and this is the correction.** The entry
  above it says the instrument templates read the mix and would read real drums
  far better from the percussive half — median `P(snare)+P(clap)` 0.171 against
  0.458 at mappers' claps. Built into the engine, the separation measured
  **0.138**, which is *worse* than the mix. The probe that found 0.458 had
  changed two things at once: `librosa.load(sr=22050)` resamples as well as
  separates, and the resampling is what moved the number.
- Isolated on the same three songs, one change at a time:
  the stem at 22 kHz reads **0.314**, the same stem at 44.1 kHz **0.156**, a
  gentler mask at 44.1 kHz **0.188**, and the mix itself 0.171-0.195. Cutting
  everything above 11 kHz is the whole effect; separating is inside the noise.

### Measured

- **What is wrong is the calibration's domain, and it is visible feature by
  feature.** At real mapper claps, against what the snare template asks for:

```
  feature           p10     median      p90     the snare template wants
  air_ratio       0.000      0.003    0.025     falling  [0.05, 0.20]   fine
  high_mid_ratio  0.095      0.214    0.354     rising   [0.10, 0.35]   half
  flatness        0.016      0.036    0.051     rising   [0.25, 0.55]   none
```

  Flatness is the one that matters: the corpus renders claps and snares as
  band-passed noise, which is flat, and the knots ask for 0.25 and up. A real
  clap inside a mix measures 0.036 — a tenth of the first knot — so that
  feature contributes nothing for practically every real drum, and it is one of
  the features the snare and clap templates lean on. Cutting at 11 kHz nudges
  the ratio, which is why the 22 kHz stem looked like a fix.

### Changed

- **An inverse STFT, and a whole-track percussive signal.** `complex_frame_range`
  keeps the phase a mask needs, `istft`/`istft_into` put frames back into
  samples, and `hpss::percussive_signal` rebuilds a track's percussive half a
  block at a time — the same answer at any block size, which is the test it is
  held to, and the reason the overlap-add is finished once rather than per
  block. They are not wired into the features, because the measurement above
  says not to; they are what the next attempt needs, and they are tested.
- The per-attack alternative is measured too, so nobody tries it again:
  separating around each attack cost **71 s** against 7.3 s for the whole
  evidence pass, and once per track costs 9.4 s.

### Rejected / tried and dropped

- **Reading the per-attack features from the percussive signal.** It is the
  obvious idea, it is implemented, and on real songs it reads 0.138 where the
  mix reads 0.171-0.195. A change that makes the measured number worse does not
  ship, however good the reasoning sounded.

## v4.0.0-dev — 2026-09-28 · Why the templates do not hear real drums

### Measured

- **The precondition the instrument lanes wait on is re-measured**, against the
  Rust classifier rather than the Python one it was set with, and it still is
  not met: over 12 ranked songs and 2,724 mapper claps, `P(snare)+P(clap)` has
  a median of **0.168** where the Python templates measured 0.138 on 11 songs.
  A lane drawn from that would be a lane of noise — only 21 % of mapper claps
  read above 0.50.
- **And the cause is not the templates.** They read their spectral and temporal
  features from the mix, where a snare sits under guitars, vocals and
  everything else; only one feature, the percussive ratio, comes from a
  separation. Reading the same songs from their percussive half instead takes
  the median from **0.171 to 0.458** on the six songs measured both ways —
  every song improves, one from 0.060 to 0.606 — and the share at or above 0.25
  from 41 % to 65 %.
- `bench/templates_on_real_audio.py` is that measurement, so the number the
  lanes wait on can be taken again rather than quoted from a year ago.

```
12 songs, 2,724 mapper claps, the mix as the engine reads it:
  deciles 0.017 / 0.047 / 0.168 / 0.448 / 0.675   at or above 0.25: 40 %

6 of those songs, both ways:
  mix              1,598 claps   deciles 0.018 / 0.045 / 0.171 / 0.451 / 0.674
  percussive stem  1,623 claps   deciles 0.038 / 0.150 / 0.458 / 0.773 / 0.921
                                 at or above 0.25: 41 % -> 65 %
```

### Rejected / tried and dropped

- **Shipping the instrument lanes anyway.** The row has waited on a number
  since the Python probe, and the number is still short. Drawing a lane that is
  right a fifth of the time would make the engine look certain where it is
  guessing, which is the failure this project keeps refusing.
- **Feeding the classifier an averaged percussive spectrogram** instead of its
  own window FFT. The separation runs at hop 128 with a 2048-point window, so
  the attack window spans 45 overlapping frames; averaging them is a different
  estimator from the single windowed FFT the features are defined by and the
  calibration was fitted to. Reading a percussive *signal* keeps the estimator
  and changes only the input, which is the right shape for the change — and it
  needs an inverse STFT the crate does not have yet. That is the work the row
  now waits on, with a measured ceiling to aim at.

## v4.0.0-dev — 2026-09-28 · Every sound a map plays gets its context

### Fixed

- **The map context skipped a quarter of what a map plays.** It matched each
  attack to the nearest *object start*, and said so — "slider ends and repeat
  hits stay future work". osu! plays a slider at every edge it has, head, each
  repeat and tail, and a spinner at its end, and each of those carries its own
  `edgeSounds`. Over five ranked maps, 1,653 of 6,207 sound events (27 %) are
  those edges, and the context had no row for any of them.
- **Worse than missing: wrong.** An attack landing on a repeat or a tail was
  matched to the object's start, so the context reported the *head's* sound for
  it — and on those same maps 1,179 of the 1,653 (71 %) play something else.
  The reader now matches every sound event (`sound_events`, P-1), reports which
  edge answered, and reports what that edge itself plays.

### Changed

- **The nearest-match stopped scanning every object for every attack.** Both
  sides are sorted, so one `searchsorted` and its two neighbours find it: on a
  1,263-object map the scan alone was 1.84 s, and the whole context is now
  0.05 s.
- A spinner's *start* now answers with nothing, because nothing plays there.
  Saying so is better than pointing at an object that will never carry a sound.

### Measured

```
Five ranked maps of the local library, the difficulty with the most objects:
4,565 objects, 6,207 sound events, 36 % more events than objects.

  1,653 (27 %)  repeats, tails and spinner ends: no context at all before
  1,179 (71 % of those)  play something other than their object's first edge,
                         which is what the old context reported for them

Cost, on the 1,263-object map: the nearest-match scan 1.84 s before, the whole
context 0.05 s now, for the same 1,263 attacks.
```

## v4.0.0-dev — 2026-09-28 · Whether to trust the reading, in one line

### Changed

- **A verdict strip under the stats**: which engine answered, how far the
  attacks sit from its grid, how steady the local tempo is, how many red lines
  — and then, in words, whether any of that is worth doubting. What it may say
  was calibrated on Corpus B, the 20 ranked maps whose red lines a person
  placed, not chosen by taste.
- **Its quiet state does not say the reading is good.** It says nothing looks
  wrong, and then names the octave as the thing these numbers cannot check,
  because that is exactly what the corpus showed: of the 14 readings the engine
  could not fault, 4 were still wrong, every one of them by an octave, with
  residuals of 11-17 ms and stability 0.90-0.98. A grid read at twice the tempo
  fits beautifully. The strip points at ×2/÷2 instead of claiming a verdict it
  cannot support.

### Fixed

- **The loose-fit warning fired on every real song.** `LOOSE_RESIDUAL_MS` was
  5 ms, and over the 15 ranked tracks the precision engine answers it fires on
  all 15 — 10 of which land on the mapper's own red lines. A warning that
  always fires says nothing, and this one contradicted the new strip on screen:
  the banner called an 18.2 ms fit loose while the strip said nothing looked
  wrong. Real music sits at 11-28 ms; the threshold is 30 ms, where it fires on
  exactly one track of the 15, and that one is the reading a mapper would
  reject. A test now holds the page and the bridge to the same number, since
  disagreeing about it is what put two contradictory sentences on screen.

### Measured

```
Corpus B, 20 ranked maps, with the engine's own account of each answer recorded
beside the mapper's (bench/corpus_b.py grew residual, stability, section count,
weakest confidence and octave margin; cache format 3).

A reading worth keeping: at least half the mapper's red lines have a beat of
ours within 50 ms, and at least half the sections read at the mapper's octave.
11 of the 20 qualify.

Of the 9 that do not, the engine's own numbers can flag 5:
  * it fell back or refused          doubts 5, 4 of them bad
  * stability under 0.9              doubts 6, 5 of them bad
  * residual over 30 ms              doubts 1, 1 of them bad
  * the two together                 doubts 6, 5 of them bad; trusts 14, 4 bad

The 4 it cannot flag are diary-of-jane, camisa-negra, imagination and noble -
every one an octave error, and every one with a residual of 11-17 ms and
stability 0.90-0.98.

The octave margin does not save it either. It is reported per section as the
seeded candidate's coherence less the strongest an octave away, and over the
corpus the three worst margins (-0.29, -0.21, -0.19) belong to camisa-negra
and noble (bad) but also palette (good), while diary-of-jane and imagination
sit at exactly 0.0000 alongside steampunk-engines and yui-again, which are
fine. It separates nothing here, which is why the strip says the octave is
unchecked rather than pretending to check it.
```

## v4.0.0-dev — 2026-09-28 · The Rust engine stops doing the same work twice

### Fixed

- **Growth refitted a whole section on every step.** The loop carries a grid
  forward and refits it each time it takes in another chunk, and the refit ran
  over everything since the section began — quadratic in the number of steps,
  for nothing the final fit does not do itself, since that one runs on the
  whole span anyway. v3 shed this on 2026-09-27; the Rust engine still carried
  it, which also means the two had quietly grown different. Both now use a
  trailing window of 128 beats, and a section shorter than the window is fitted
  over everything exactly as before.

### Changed

- **The onset envelope's two per-frame passes go wide.** A six-minute track is
  124,032 frames of 128 mel bands, and the decibel conversion and the flux
  difference each walked all 15.9 million values one at a time. Neither frame
  reads another's answer, so both run in parallel: the decibel pass keeps its
  global maximum by reducing maxima, which is the same number in any order, and
  the flux pass collects back in frame order. Bit for bit the same envelope.
- **The roadmap row said "no rayon stages", and that was already wrong**: the
  STFT, HPSS, the structure matrix and the coherence sweep were parallel
  before today. What was missing was not threads but the quadratic above — the
  single biggest win here came from doing less work, not from doing it on more
  cores.

### Measured

```
Against a baseline binary rebuilt from the previous commit on the same machine,
minutes apart, median of three runs on the six-minute fixture:

                       before     after
  attacks              0.76 s     0.44 s     1.7x
  tempo                1.22 s     0.25 s     4.9x
  the analysis         1.98 s     0.69 s     2.9x

Per stage, from the same fixture instrumented: growth 1.001 -> 0.121 s, the
decibel pass 0.254 -> 0.069 s, the flux pass 0.185 -> 0.031 s. The seed scan
(0.008 s), the octave hints (0.09 s) and settling (0.000 s) were never the
cost.

Over the 27 golden cases, the same binaries: decode 1.04 -> 1.25 s (noise,
this machine varies by a third), attacks 4.01 -> 2.65 s, tempo 2.91 -> 1.71 s,
7.96 -> 5.61 s for the corpus.

Nothing moved: 27/27 cases match v3 stage for stage, nogrid, density, elastic
and map are unchanged, and 280 Rust tests pass.
```

## v4.0.0-dev — 2026-09-27 · Kits fitted to what each genre sounds like

### Changed

- **`bench/genre_samples.py` measures what a genre's hitsounds sound like.**
  The profiles say *where* each genre puts its additions; this says *what* it
  puts there, from the sample files those same mapsets ship: how long the hit
  rings, how bright it is, how much of it is noise, and where its energy sits
  across seven bands. Nothing of anyone's audio is copied, kept or shipped —
  the files are read where they lie and reduced to per-genre medians.
- **`bench/fit_kits.py` aims Overtone's own synthesiser at those medians.** It
  searches the generator's parameters for the setting whose *synthesised* sound
  lands nearest the target, and `assets/kits.json` ships the settings. A kit is
  a description of a sound fitted to a measurement, never a recording of one,
  which is the only way to ship one at all.
- **One shape for every role**, because the roles are not what their names say:
  a `drum-hitclap` in these maps centres at 168 Hz (a tom) and a rock
  `soft-hitwhistle` reads a zero-crossing rate of 0.37 (a hat). Noise and tone
  at one centre in any balance, one hit or a flam of three, between two
  cutoffs.
- **A kit is rendered, not carried.** Eight genres of sounds would be four
  megabytes of generated wav in the repository; the settings are a few
  kilobytes and a sound takes a tenth of a second to make. `write_kit` puts
  them in a folder under osu!'s custom sample index, *beside* a map's own
  samples rather than over them, and a name already taken is kept and reported
  rather than overwritten.

### Measured

```
Measured first: 10,695 sample files over the 748 corpus mapsets, each reduced to
decay, attack, centroid, rolloff, noisiness and seven band ratios, then taken to
a median per genre and role. What that shows before anything is synthesised is
that the names lie: a drum-hitclap in these maps centres at 168 Hz and a rock
soft-hitwhistle reads a zero-crossing rate of 0.37. Metal alone ships 3,525 of
those files; funk 176.

Fitted second, in two stages because the two halves of a hit barely see each
other - the spectrum is decided in the first 50 ms, the envelope in the rest.
Searching them together is 51,840 renders a role and an hour and a half; apart
it is about 1,400 and forty seconds, and a refine pass afterwards keeps the
answer from being a grid point rather than a sound.

42 of the 60 measured roles land inside the tolerance of 0.55 and ship; the
18 that do not are named in the report and left out. Per genre: metal 9 sounds
(from 641 files), rock 6 (148), electronic, jrock, metalcore and punk 5 each,
pop 3, funk and jazz 2. The errors run 0.11 to 0.54, and the worst centroid a
shipped sound misses its target by is a fifth of an octave.

The first attempt did not get near: every role had its own shape, and all nine
rock roles came back between 1.15 and 12.83. The breakdown said why - a crash
with only a floor cutoff reads 9.7 kHz whatever the target says, and a
three-burst clap peaks on its third burst, so its measured attack was 26 ms
against the 1.7 ms wanted. One shape spanning noise and tone fixed both.

bench/fit_kits.py --verify renders all 42 from what is committed and holds each
to the target it was fitted to: every one renders what it says, in 9 s. The
settings are 13 KB; the wav files they make would be about four megabytes, so
they are rendered when a kit is used, not carried.
```

## v4.0.0-dev — 2026-09-27 · The map's own tags pick its hitsound profile

### Changed

- **`hitsound_genre` moves into the engine**, where the app and the bench read
  the same one. The genre a map claims decided which corpus its profile's table
  was measured from; letting the app preselect with a second copy of that rule
  would mean a song graded under one genre and hitsounded under another. A test
  holds `bench/genre_corpus.py` to the engine's function by identity.
- **The Propose card preselects**: opening a difficulty asks the bridge what
  its metadata claims, and the option says so — *Rock — suggested for this map*
  — with the note carrying that genre's own measurement rather than an
  assertion that it differs. The band list wins over the tags, because a My
  Chemical Romance map tagged "rock alternative punk mcr metal emo" names four
  genres and only the artist settles it.
- **A suggestion, never a choice.** The moment the user picks, their pick
  stands and opening another map does not undo it; the suggested one stays
  marked, since what the map asked for is worth seeing even when you decide
  against it. A genre with no profile suggests nothing — jazz is measured and
  deliberately has none — and nothing is decided until Propose is pressed.

### Measured

```
Through the harness on a rock mapset copied out of the library (nothing is
written into Songs): analysed at 201.4 BPM, the Hitsounds view loaded, and the
bridge answered "rock" for a map tagged "Opening Intro English Alternative Rock
TMBG". The card preselected Rock, the option read "Rock — suggested for this
map" and the note "Rock, measured on 110 mapsets: 61 % of claps on beats 2 and
4…". Picking Metal set the chosen profile to metal and left it there across a
reload of the same map, with Rock still marked as the suggestion. Spanish reads
"sugerido para este mapa" and the Metal note in Spanish. No console error.

Nine tests: the classifier (band over tags, the more specific tag, whole words
only, nothing claimed rather than guessed, a beatmap's own metadata) and the
bridge (a genre that has a profile, one that does not, no map, a path that is
not a bare .osu beside the song, and the bench reading the same function).
```

## v4.0.0-dev — 2026-09-27 · Hitsounds by genre, measured instead of guessed

### Changed

- **The metrical criterion is no longer taste.** `role_fit` decided whether a
  finish belongs here and where a clap goes, and its own comment said what it
  was: *"Starting points, not measurements"*. It gave beats 2, 3 and 4 the same
  score, and whistles a penalty on the beat. Measured against 748 mapsets of
  the user's own library, both are wrong: rock puts 26 % of its claps on beat 2
  and 25 % on beat 4 against 10 % on beat 3, and whistles land on the beat as
  often as off it in every genre measured.
- **`bench/genre_corpus.py` measures it, genre by genre**, with the engine's
  own reader and `hitsound_report`, which resolves what osu! actually plays and
  places each sound on a sixteenth of the map's own bar. Genre comes from the
  mapper's tags, most specific first, plus a list of bands whose genre is not in
  doubt. The manifest holds folder names, the file measured and its SHA-1, and
  the counts — no map text, no audio, no samples.
- **Eight profiles ship with their table**: `metal`, `metalcore`, `punk`,
  `rock`, `jrock`, `pop`, `funk`, `electronic`. `profiles/<genre>.json` gained a
  `metrical` block — the share of that addition's placements per slot — and the
  Rust decision reads it where the map's own bar slot is known, falling back to
  the old rule where it is not (no table, no proven bar, a triplet no sixteenth
  names). `balanced` ships no table, so its decisions are bit-for-bit what they
  were. The Propose card lists profiles by file name, so the eight appear there
  with no page change.
- **Jazz ships no table.** It is the one genre whose table lost to the rule on
  maps it never saw, and 28 mapsets of swing and mixed meters have not measured
  enough to overrule anything. Saying so is the point of measuring.

### Measured

```
Estimator, chosen on a third of the maps held back for choosing, never on the
third scored: pooled counts with 2 % of the mass spread evenly beat the mean of
each map's shares and the median of them, at five smoothing levels each
(-3.066 bits against -3.077 for the next).

Held out, one third of each genre's maps never seen by the table, with the hand
rule given its own best temperature on the middle third, in bits a placement
(uniform is -4):

  genre       clap          finish        whistle
  rock        -3.26 -> -2.86 -2.57 -> -2.25 -4.16 -> -3.12
  punk        -3.38 -> -3.16 -2.71 -> -2.50 -4.15 -> -3.09
  metal       -3.85 -> -3.56 -2.89 -> -2.87 -4.13 -> -3.47
  metalcore   -3.94 -> -3.91 -2.92 -> -2.75 -4.14 -> -3.20
  jrock       -3.50 -> -3.28 -3.17 -> -2.76 -4.14 -> -3.13
  pop         -3.23 -> -3.07 -2.75 -> -2.40 -4.11 -> -3.23
  funk        -3.29 -> -2.95 -3.05 -> -2.70 -4.07 -> -3.83
  electronic  -3.06 -> -2.89 -2.78 -> -2.64 -4.08 -> -3.70
  jazz        -3.59 -> -3.68 -3.25 -> -3.21 -4.06 -> -4.32   <- no table shipped

25 of 27 cells go to the table, median +0.29 bits a placement. The two losses
are jazz, which is why it keeps the rule.

What the genres differ by, and it is not small: the share of claps on beats 2
and 4 runs from 72 % in pop and electronic through 61 % in rock and punk to
30 % in metal and 24 % in metalcore, where claps follow the snare wherever the
band puts it. The plain hit's bank differs too — metal plays the drum bank 51 %
of the time, pop the soft bank 63 % — and additions are soft in 72-98 % of every
genre. Additions an object: 1.27 pop, 1.18 rock, 0.94 metal, 0.85 funk.

End to end, through overtone-cli on the maps the table never saw:
not measured end to end yet
```

## v4.0.0-dev — 2026-09-27 · What the window shows while it opens

### Changed

- **A startup overlay.** `boot()` needs a round trip to the bridge for the
  config, the language and the first view; until it came back the window showed
  the shell raw — the sidebar in English whatever the language, empty cards, no
  logo. The overlay covers that and says what the app is while it waits: five
  bars at the heights of the harmonic series (1, 1/2, 1/3, 1/4, 1/5) pulsing one
  after another on a 500 ms beat, which is 120 BPM. A timing tool should open
  in time.
- **It comes down on boot, never before 420 ms and never after 6 s.** A flash
  reads as a glitch, and a bridge that never answers must not leave the window
  covered: the page behind it is usable, and a covered window looks hung. It is
  then **removed from the page**, not merely faded — a transparent overlay still
  takes every click, which is the way this goes wrong.

### Fixed

- **The title bar ignored the app's own theme.** `_dark_caption` forced a dark
  caption always, with the comment "the app is dark either way" — true when it
  was written, false since the theme button landed: a light app sat under a dark
  caption. The caption and the window's `background_color` now both follow the
  saved theme, with `system` asking Windows which app theme it is in (read only)
  and anything unreadable falling back to dark, the app's own default.

### Measured

```
Through the harness at 1280x900, with the overlay measured where it paints
rather than from a screenshot: it covers 1280x900 from (0, 0) at z-index 200,
background rgb(18, 16, 25) in dark and rgb(245, 244, 248) in light, which are
the page's own --bg either way; the five bars stand 74, 45.9, 32.6, 23.7 and
17.8 px, animation splash-pulse at 0.5 s, 100 ms apart. After boot the element
is gone from the page and the point at the centre of the window belongs to the
app behind it. With reduced motion asked for, both animations read `none` and
the progress line fills its 168 px track instead of sweeping. Both languages
read: "Starting up…" and "Abriendo…". No console error.

The window's two colours are now written in two places — styles.css and
overtone_web.py, because the frame is painted before any CSS — so a test reads
--bg out of each theme's block and holds WINDOW_BG to it. 777 Python tests pass
(four new).
```

## v4.0.0-dev — 2026-09-27 · The three properties, over generated tracks

### Changed

- **`crates/overtone-tempo/tests/properties.rs`**: the roadmap's three property
  claims — x2/div2 identity, exact-grid recovery, monotone boundaries — each had
  one hand-built example inside the crate. An example pins the case that once
  broke; what it cannot do is find the input nobody thought of. The same claims
  now run over hundreds of generated tracks, with two more riding along
  (snapping is idempotent and bounded, a written line is whole milliseconds in
  order). No property-testing crate: the build is offline and its dependency
  set is the measured one, a generator is twenty lines of SplitMix64, and every
  failure prints the seed that made it.

### Measured

```
Three of the six properties failed on the first run, and all three failures
were the tests being wrong about the engine rather than the engine being wrong
- which is the useful half of writing them down:

1. A least-squares pass assigns each attack to the nearest slot of the grid it
   is given, so a seed error of e per period has walked half a slot after
   0.5/e of them. At 1.5 % over 400 beats the fit came back 0.65 % off. That is
   the ladder being asked for something it cannot do, and exactly why the
   pipeline seeds inside an 8 s window and widens with `expand`.
2. The same arithmetic applies to the seed window itself: a 0.109 s atom fits
   73 beats into 8 s, where 1 % is three quarters of a slot, and the seed pass
   locks wrong before widening can help (seed 34). What a seed scan must
   deliver is not "1 %" but a fraction of a slot over its own window.
3. The x2/div2 identity is weaker than it reads. A red line must sit on a beat
   of the grid it declares, so at div2 half the beats no longer exist and the
   line moves to a surviving one: 6 of 76 line-and-factor pairs over the 27
   golden vectors, and correct. The seventh is not: the slack in
   `points_from_sections` is a quarter of the *displayed* beat, so the user's
   factor tips the ceil by a whole bar - on very-noisy-132 the first red line
   moves 0.455 s at x2. Read from the section's own grid instead, factor 1 is
   bit-identical on all 27 vectors and that case goes away. It is engine
   behaviour in both languages, so it waits for its own change and the gates;
   the property asserts the bar bound that holds today and names the case.

277 Rust tests pass (six new, 3.1 s for the file). No Python or engine file
changed, so every Python gate is untouched.
```

## v4.0.0-dev — 2026-09-27 · Which v3 guarantees Rust holds, in writing

### Changed

- **`bench/parity.py` and `bench/parity.json`**: the roadmap's one open **P0**
  row asked for "the v3 tests by name" and its status read *"partial — 271 Rust
  tests; not every v3 name"*, a sentence nobody could act on. It names no
  missing test, and it reads as debt when most of the difference is a
  **boundary**: the Rust engine has no window, writes no map, and never grew
  the v2 fallback tracker, so a good part of the Python engine's tests cannot
  have a Rust twin. The boundary is now written down, one line per engine
  stage, as `rust` (with the `#[test]` functions that hold it), `legacy` (the
  v2 tracker), `python-only` (a stage only Python has, with which), `shell`
  (window, report or file IO) or `bench`.
- **The gate derives the rest and opens the crates to check it.** A test counts
  as held in Rust when a stage it touches is `rust`; a stage a test touches
  with no line fails rather than passing unnoticed; a Rust test named by a line
  that no crate holds any more fails too, so a rename cannot leave a false
  claim behind. `bench/facts.py` states the count with the other facts.

### Measured

```
381 of 524 v3 engine tests touch a stage the Rust engine holds; 155 stages are
placed, 52 of them in Rust. The remaining 143 tests are outside that surface
and now say where they live instead: 61 shell, 31 python-only, 29 bench, 16 the
v2 fallback tracker. Of those, 34 reach no engine stage by name at all (7
classes, each placed by hand with its reason).

What the number measures is the surface, not one Rust test per Python test: a
stage with one Rust test beside twelve Python ones counts as held, so 381 is an
upper bound on parity and reads as "no engine stage is untested in Rust". Two
findings came out of building it, both now stated rather than assumed:
`_fill_missed_beats`, `_choose_subdivision`, `_segment_tempi`,
`_robust_local_bpms`, `_tracker_lag` and `_global_tempo_guides` belong to the
v2 tracker, which Rust does not implement at all — the 16 tests over them are
not a porting debt — and the gate's own accounting was wrong the first time:
119 tests looked like they reached no engine stage because a fixture helper
(`self._events(...)`) hid it, which is why a test with a bare body now takes
the stages its class names between them.

The gate was held to catching its three failure modes: a Rust test renamed out
from under a line, a stage no line places, a line no test reaches. 773 Python
tests pass (six new); facts, fixtures and the Rust workspace unchanged.
```

## v4.0.0-dev — 2026-09-27 · Where the pulse is, all through the song

### Changed

- **`coherence_map` and `map_ridge` (engine)**: `R(t, f)` over the whole track — the same
  phase-agreement sweep the seed scan runs, walked across the song on a 12 s window every
  2 s, on a frequency grid every column shares so columns compare. The ridge follows the
  strongest peak with octave continuity: without it a window whose 2x harmonic momentarily
  wins reads as a tempo doubling. A port of `crates/overtone-tempo/src/map.rs` (DSP §B.3)
  as far as the surface and its ridge; what Rust does with it afterwards stays there.
- **`Api.tempo_map`** sends it as a picture — one byte a cell, base64, rows even in **log2
  period** so an octave is the same height anywhere — with the ridge and, beside it, the
  red lines the analysis actually reports. Those are not the same thing and the card says
  so: R peaks at the pulse **and at every multiple of it**, so a bright band an octave
  above the reported BPM is the sweep being honest, not a disagreement.
- **The Audio view draws it**, closing the row: spectrogram, tempo map, loudness with
  sections, hits against notes, and the seven onset bands.

### Measured

```
On change-128-142, which steps at 30 s by construction: the reported lines come back
128 BPM at 0.4 s and 142 at 30.4 — the fixture's own truth — and the ridge reads 768 BPM
then 852, which is 6x each. The same step, six octaves up, which is what a coherence ridge
does and why the reported line is drawn over the surface rather than instead of it. On the
canvas the red line sits higher in the second half (row 303 against 318), so faster reads
higher, and 7,203 pixels of ridge are lit.

The sweep is 0.04-0.05 s a song — 24 windows of a 1,047-point grid. A window with fewer
than 8 attacks carries no peak worth tracking and is skipped; a song with too few says so
instead of drawing noise. A fallback result keeps no attacks, so they are detected once
per song as a reference grading does.

Both pictures repaint with the theme (the heatmap's corner goes rgb(22,20,29) to
rgb(251,250,254) on the rail's theme button). Both languages read, no console error.
767 Python tests pass; benchmark 24/24 at the same median 0.0000 BPM and 0.16 ms, golden
27/27 stage for stage, every other gate unchanged.
```

## v4.0.0-dev — 2026-09-27 · Loudness, with the sections behind it

### Changed

- **`loudness_curve` (engine)**: how loud the song is over time, as RMS per column in dB
  under its own loudest column, mapped so the foot is 60 dB below that. RMS and not a
  sample maximum: a curve about how loud a *stretch* is must not be set by one sample of
  one hit.
- **`Api.audio_energy`** and a lane in the Audio view, under the spectrogram, with the
  Structure view's own sections shaded behind it and named where there is room for the
  word. Those sections come from the Rust sidecar, so the curve stands without them and
  the card says which case it is rather than drawing an empty lane.

### Fixed

- **Silence read as full loudness.** The curve is relative to the song's own peak, and a
  file with nothing in it normalised against its own silence drew a solid line at the top.
  A peak under −80 dB now has no loudest moment to be read against and the curve is flat
  zero. `_silence` read 1.00 everywhere before; it reads 0.00 now.

### Measured

```
On with-drop-180, whose drop is 30-36 s of 70 by construction: the curve reads 0.92 at
26 s, 0.71 at 31, 0.00 at 33 and 0.73 at 38. Through the harness, with the sidecar built,
the structure sections came back 0-30, 30-39 and 39-70 — the middle one is that drop, so
the two pictures agree about where the song stops. Without the sidecar the lane draws the
same curve and the card says the sections come from an engine that is not built here.

_silence 0.00 everywhere (it was 1.00), _ambient 0.88-1.00 for continuous pads. 0.01 s a
song, from the decode the rest of the Audio view already made. 758 Python tests pass;
benchmark 24/24 at the same median 0.0000 BPM and 0.16 ms, golden 27/27 stage for stage,
every other gate unchanged.
```

## v4.0.0-dev — 2026-09-27 · Hits against notes

### Changed

- **`percussive_balance` (engine)**: how much of each moment is a hit rather than a note,
  by Fitzgerald's median separation — a sustained partial is a horizontal line on a
  spectrogram and a median along time keeps it; a hit is a vertical line and a median along
  frequency keeps it; soft Wiener masks split each cell, and the percussive mask's share of
  a frame's energy is the answer. Everything is weighted by energy, including the song's own
  figure: a silent frame has no balance to report, and averaging it in as zero would make a
  quiet song read tonal.
- **`Api.audio_balance`** and a lane in the Audio view, under the spectrogram: 0 at the
  foot is all note, 1 at the top all hit, with the halfway line drawn and the song's own
  percentage in words.

### Measured

```
It runs on the analysis path's mel grid, not on linear bins: 1025 bins cost 22.3 s of
median filtering on a one-minute song against 1.4 s on 128 mel bands, and the answer moves
by 0.003. That is a different grid from `crates/overtone-dsp/src/hpss.rs`, whose kernels
therefore do not carry over — a mel filterbank smears a partial across neighbouring bands
and the frequency median has to step over that smear. Both kernels were chosen by what
they do to signals whose truth is known (2 ms clicks, 40 ms noise snares, a 55 Hz kick
decaying over 150 ms, a held tone, a held chord), energy-weighted:

  time kernel   freq bands   click   snare    kick    tone   chord   worst gap
       100 ms            3   1.000   0.986   0.654   0.302   0.462      +0.524
       100 ms           13   1.000   0.981   0.543   0.000   0.102      +0.879
       150 ms           13   1.000   1.000   0.788   0.000   0.102      +0.898
       300 ms           13   1.000   1.000   0.988   0.000   0.103      +0.897

13 bands wins the gap at every kernel length; at 3 a smeared partial survives and a chord
reads 0.46 percussive. 100 ms is kept over the marginally wider 150 and 300: past it the
gap stops growing and the kick's reading climbs from 0.543 to 0.788 and 0.988, which
claims its sustained body is a transient. A kick being about half hit and half body is
what a kick is.

On fixtures whose nature is known: _ambient (overlapping pads, no percussion) 0.011,
_noise (white noise) 0.486 — neither a line nor a transient, so the masks split it near
half, which is the honest answer rather than 1.0 — and the drum corpus 0.26-0.27, where a
continuous pad carries most of the energy and brief hits carry the rest. 1-2 s per song,
from the decode the other two Audio pictures already made.

Through the harness on edm-174: the lane drew 25,940 pixels of curve, the card read
"26 % of this song's sound is hits rather than notes", both languages, no console error.
751 Python tests pass; benchmark 24/24 at the same median 0.0000 BPM and 0.16 ms, golden
27/27 stage for stage, every other gate unchanged.
```

### Fixed

- **A silent column said "all notes".** Its share is 0, and 0 on this lane is a reading,
  not an absence — a claim about silence rather than of it. The engine returns each
  column's loudness beside its share and the lane is broken where nothing was heard. Found
  by a test that expected a stretch of clicks to average high and got 0.33, because the
  silence between them was being drawn as tonal.

## v4.0.0-dev — 2026-09-27 · The spectrum the engine listened to

### Changed

- **`mel_image` (engine)**: the song's mel spectrogram in dB, pooled to a given number of
  columns. The same 128 bands to 11.025 kHz the analysis path itself reads, through the
  same `_mel_power`, so the picture is the spectrum the engine listened to and not a second
  opinion drawn beside it. Pooled by **maximum**: a drawn column stands for tens of frames
  and a mean turns every transient into a smear, which is the opposite of what a
  spectrogram is looked at for. 0 dB is this song's loudest moment and −80 its floor, so
  the scale is the song's own.
- **`Api.audio_spectrogram`** sends it as 128 rows of one byte a cell, base64: a float a
  cell would be 180,000 numbers of JSON for one picture. The decode is now shared with the
  band lanes through `_read_bands`, so the Audio view reads the song once for both.
- **The Audio section draws it** above the lanes, low band at the foot, with a few mel rows
  named in Hz and the same time axis. The ramp runs from the plot's own background at the
  floor to the tempo ink at the loudest, so the picture belongs to the theme.

### Fixed

- **The two Audio pictures asked for the song at once and one lost.** Both go through the
  same single-job lock, so opening the section fired the spectrogram and the lanes
  together and the lanes came back `busy` — which the page swallowed, leaving "Reading the
  song's bands…" on screen for good. They are asked for in turn now, and a `busy` reply
  says so instead of being ignored.
- **The spectrogram did not follow the theme.** It is painted once into its own bitmap
  from the theme's ink, which makes it the one thing in the app that does not follow a CSS
  token; switching theme left it in the old colours. It is repainted with the rest now —
  which the rail's new theme button makes easy to notice.

### Measured

```
Through the harness on edm-174: 128 rows by 1,400 columns over 1:00, 239 kB of base64 for
the whole picture, the frequency axis running 0 Hz to 11,025 Hz and the beat's striations
visible across it. Pressing the theme button four times alternates the theme and repaints
the bitmap each time (its corner goes rgb(21,19,28) to rgb(252,251,254) and back), with no
unhandled rejection. Both languages read, no key missing.

743 Python tests pass; benchmark 24/24 at the same median 0.0000 BPM and 0.16 ms, golden
27/27 stage for stage, bpm-snapshot, real-audio and perf unchanged.
```

## v4.0.0-dev — 2026-09-27 · Audio: what started, not just that something did

### Changed

- **`band_flux` (engine)**: the onset flux split into seven log-spaced bands over the mel
  path's own range — 40, 89, 199, 445, 992, 2214, 4940, 11025 Hz — on the same frames, pad
  and hop as the default envelope, so row k is the same moment in both and the lanes line
  up with the attacks. Values are absolute dB flux with one global floor, comparable
  between bands: no per-band normalisation, which would invent a kick in a song that has
  none. A port of `crates/overtone-dsp/src/multiband.rs`, constant for constant, because
  the analysis on screen is the Python engine's and nothing surfaced this.
- **`Api.audio_bands`** hands them to the page, each lane max-pooled to 1,600 columns (a
  six-minute song has 124,000 frames and no screen has the pixels; a column keeps the
  loudest frame under it, since a mean flattens exactly what a lane is read for) and all
  of them scaled by one peak. The decode is kept per song: the flux does not change with
  the zoom.
- **An Audio section** in the rail, the first of the row's five parts: seven lanes, low
  band at the foot, each labelled with its own edges, over the song's time axis.
- **`overtone-bench bands`** prints what Rust reads — frames, per-band totals, each band's
  loudest frame — and **`proto/band_lanes.py`** prints the same from the port, so the two
  diff line for line. A measurement, not a gate.

### Measured

```
Python against Rust on all 27 golden fixtures: frame counts identical everywhere, the
loudest frame of every band identical in all 189 of them, and the worst relative
difference in a band total 6.07e-06 (long-6min) — the same order as the mel path's own
documented float32 divergence.

What the bands say, checked against what they should: a tone faded in over 250 ms puts
its peak flux in its own band for all seven, and a single-sample click moves every band
(26.6 to 46.3 dB). A tone switched on **abruptly** does not, below about 200 Hz: it is a
broadband click with a tone after it, and at 40-89 Hz — four and a half bins wide at this
n_fft — the click wins the band. That is the front end working as specified, and the test
fades its tones in for that reason.

Through the harness on edm-174: all seven lanes drawn and labelled 40-89 up to 4.9k-11k,
1,600 columns over 1:00, peak 39.8 dB; the hats put far more ink in the upper lanes than
the kick does in the lower, which is what that fixture is. Both languages, no console
error. 736 Python tests and 271 Rust tests pass; benchmark 24/24 at the same median
0.0000 BPM and 0.16 ms, golden 27/27 stage for stage, every other gate unchanged.
```

## v4.0.0-dev — 2026-09-27 · Growth stops refitting the whole song

### Changed

- **The grid carried through section growth is refit on a trailing window** of
  `GROWTH_WINDOW_BEATS` (128) beats, not on everything since the section began. Every
  growth step refitting the whole span made the loop quadratic, and it bought nothing the
  final fit does not do itself: when growth stops, the section is refit over its whole
  span regardless, and that is the grid that gets reported. The window only has to be good
  enough to judge the next chunk and to seed that final fit. A section shorter than the
  window is fitted over everything, exactly as before — which is most of the corpus.

### Measured

```
Nothing any pinned reading can see moved on the synthetic corpus: benchmark 24/24 within
0.05 BPM and 5 ms at the same median 0.0000 BPM and 0.16 ms, bpm-snapshot 24/24 unchanged,
and golden 27/27 **stage for stage** — the per-stage vectors are identical, because the
final fit converges to the same grid from either seed.

The cost, as the sections stage the engine announces (CPU, single-threaded, fastest of 2):
  long-6min        2.719 s -> 0.188 s   14.5x   (its growth loop refitted 205,604
                                                 attack-rows over 189 passes; now 26,056)
  edm-174          0.047 s -> 0.031 s    1.5x
  freedom-dive     1.297 s -> 1.500 s    0.9x
  yui-again        1.344 s -> 1.250 s    1.1x
  shinkou          1.109 s -> 1.234 s    0.9x
  noble            1.344 s -> 1.281 s    1.0x

**On real music it buys nothing measurable.** The win is on long-6min, which is six
minutes at one tempo and so one very long growth run; real songs spend that stage in
seeding and boundary settling instead, and those are untouched. The change is kept for
the quadratic itself — a 15-minute mix at one tempo is the case it protects — not for a
speed-up on the corpus, which there is not one of.

Corpus B, 19 tracks analysed: 18 report red lines identical to the digit. camisa-negra
changes, and for the better in kind: 3 lines become 1. It read (-333.8 ms, 194.00),
(144409.7 ms, **388.00**) and (188946.2 ms, 194.00) — a section at four times the map's
tempo, and a first line before the audio starts — and now reads one line at
(286.7 ms, 194.00) against the ranked map's own single line at (270 ms, 97). Its distance
from that line grows 14.8 -> 16.7 ms and its BPM error 0.0008 -> 0.0018, both far inside
the 21-26 ms the maps' own lines sit from the sound. `bench/real_audio_snapshot.json` is
pinned again for it, and `bench/perf_snapshot.json` for the sections stage.
```

### Rejected / tried and dropped

- **Counting every `_refine_grid` call as the measure of this change.** The first profile
  said Corpus B refitted 1,672,682 attack-rows before and 1,653,095 after, and reading
  that as "no improvement" would have been as wrong as reading long-6min's 20x as a
  general one: most of those calls are the seeding, the boundary settling and the final
  per-section fits, which this does not touch. The stage the engine announces is what a
  user waits for and what the perf gate holds, so that is what is quoted above.
- **A shorter window.** 128 beats is 32 bars of 4/4 and already far longer a lever arm
  than a growth step needs; since the stage is not where real songs spend their time,
  shortening it would trade a reading's stability for a saving that does not show.

## v4.0.0-dev — 2026-09-27 · Another game's timing, read back

### Changed

- **`read_timing_file`** reads a Quaver `.qua` or a StepMania `.sm`/`.ssc` into the red
  lines it states — the counterpart of the two writers added the same day, and the same
  conventions in reverse: a `.sm`'s beat numbers become times through the tempi before
  them, and its negated `#OFFSET` becomes where the first line sits. What comes back is
  the shape `grade_reference_timing` already grades, so **`Api.reference_grade` takes one
  of these where it took an `.osu`** and the whole Map check card works unchanged: the
  file picker offers them, every line is graded against the song's own attacks, and the
  card names the game it came from.
- Whether the chart's audio is this exact file is answered for an `.osu` and left
  unanswered for the others, which name their audio but are not read for it; the card says
  so in its own banner rather than borrowing the `.osu` wording about a missing file.

### Fixed

- **The verification readers were not reader enough to be imports.** Written to check what
  the exporters had just written, they took every `StartTime` they saw — and a real `.qua`
  carries `SliderVelocities:` entries with a `StartTime` of their own, which would have
  been imported as tempo changes. They now read the `TimingPoints:` block as a block. The
  StepMania one drops `//` comments and reads only the **first** `#OFFSET` and `#BPMS`: a
  `.ssc` may repeat both per chart after `#NOTEDATA`, and those belong to one difficulty.
- **A rate that cannot be played is refused for StepMania and skipped for Quaver**, and
  the difference is the formats': StepMania accumulates times through the tempi, so a pair
  thrown away does not lose only itself — every beat after it lands somewhere else. Quaver
  states each time outright, so there a point with no `Bpm` costs only itself. The first
  version dropped both alike and silently moved a chart's whole tail; a test holds each
  now.
- **`verify_export` reports a text it cannot read instead of raising through its caller.**
  It is a check; a broken file is a result it has.

### Measured

```
Through the harness on edm-174, analysed at 174.000 BPM with its line at 431.3 ms: the
.qua and .sm this very analysis wrote were read back and graded against the song — both
one line, verdict "ok", the .sm at 431.3 ms and the .qua at 431, which is the whole
millisecond its export rounds to. Two hand-written charts of another song (150 and
87.5 BPM) graded "weak" and "check" against it, as they should. The card named the game
and said the audio was not checked, in both languages; no console error.

Both readers were also given a realistic file each: the .qua's SliderVelocities were not
read as timing, and the .ssc's per-chart #OFFSET and #BPMS after #NOTEDATA were not read
as the song's. 728 Python tests pass; fuzz_reader still reads 3000 mutant .osu files.
```

## v4.0.0-dev — 2026-09-27 · The theme, one press away

### Changed

- **A theme switch in the rail**, under the views and above the language one, where
  Settings' three-way (System / Dark / Light) was the only way to it. It shows the theme it
  would move to — the sun while the dark one is on, the moon while the light one is — with
  the words beside it saying the same, so the icon never carries it alone; on the narrow
  rail the label goes and the name stays in `title` and `aria-label`, as the nav items do.
  It writes the same setting, so the three-way follows it and the choice is remembered.
  Pressed while the theme is **System**, it answers with the theme it was offering rather
  than a third state.

### Measured

```
Through the harness: dark to light and back, the setting, the Settings three-way and the
button's own icon and words following each press; pressed from System it wrote "light",
the theme it showed. Contrast of the label on the button 7.76:1 on the dark theme and
6.78:1 on the light one. At 1100 px the rail collapses to 76 px and the button keeps its
icon inside it with the name in title and aria-label. Both languages, including the label
changing language while the light theme is on. No console error.
```

### Rejected / tried and dropped

- **Three states in the rail.** The rail would then hold a copy of the Settings control,
  and the press that matters — the one the request was about — would take two. System stays
  where it was chosen; the rail switches between the two themes it can show.

## v4.0.0-dev — 2026-09-27 · The same timing, for the other games

### Changed

- **`quaver_timing_text`** writes the red lines as a `.qua` `TimingPoints:` block. Quaver's
  points carry an absolute `StartTime` in milliseconds and a `Bpm`, which is what a red
  line already is, so the conversion is a change of spelling; the offset follows the app's
  own decimals setting, whole milliseconds by default as for osu!.
- **`stepmania_timing_text`** writes `#OFFSET` and `#BPMS` for a `.sm` or `.ssc`. Both
  tags are where such a conversion goes wrong, so both are spelled out in the code:
  StepMania counts from **beat 0**, which is the first red line, and `#OFFSET` says where
  that beat sits **in seconds and negated** (a first beat 1.234 s in is `-1.234000`, which
  is why real files carry negative offsets); every later change is a `beat=bpm` pair with
  the beat counted forward through the tempi before it, so a change 30 s into a 150 BPM
  song is beat 75, not second 30.
- **`verify_export`** reads a written export back and compares its grid with Overtone's,
  line for line. This is the only check available here and the reply says so plainly: no
  game has opened one of these files, and nothing claims a game accepts them. What it does
  catch is what actually goes wrong — a flipped sign, a beat read as a second, a lost line.
- **`Api.other_game_text(game)`** and two rows in Export that copy the text and print what
  the check found ("every beat within 0.477 ms of the timing above"), in amber with "do not
  use this text" if it ever fails to read back.

### Measured

```
Every reading this repo pins — the 27 golden vectors' points and the 6 real songs of the
real-audio snapshot, 33 in all — written to both formats and read back: no failures.
Worst beat error quaver 0.478 ms, stepmania 0.000500 ms. Quaver's is the whole-millisecond
StartTime the app's default asks for (at most half a millisecond, per line); StepMania
keeps the sub-millisecond offset, so it stays under a microsecond.

Through the harness on halftime-150-75: Copy .qua gave `- StartTime: 500 / Bpm: 150.000674`
and read back within 0.477 ms; Copy #BPMS gave `#OFFSET:-0.499528; #BPMS:0.000000=150.000674`
within 0.005 ms. Both languages read, no console error.
```

### Fixed

- **StepMania at three decimals walked off its own beats.** Three decimals is what most
  hand-written files use, and rounding a BPM there alone put the pinned readings up to
  3.7 ms from their own grid over an hour of beats — the engine fits finer than that. Six
  decimals costs a few bytes and puts it under a microsecond. Found by `verify_export`
  before either writer was wired to anything.

### Rejected / tried and dropped

- **Writing a whole `.qua` or `.sm` file.** Overtone has no notes for those games, and a
  file with timing and no chart is not something either editor wants to open. The row asks
  for timing, and timing is what transfers; the text goes to the clipboard for the editor
  the mapper is already in.
- **Comparing beat number against beat number across the whole song** in the check. A line
  rounded half a millisecond earlier fits one more beat before the next one, and every beat
  after that gets compared with its neighbour — which reads as a whole beat of error (413 ms
  on `three-sections`) where there is half a millisecond of it. Each line is compared
  against its own counterpart over its own beats instead.

## v4.0.0-dev — 2026-09-27 · One list of fixtures

### Changed

- **`bench/fixtures.json`**, written by **`bench/fixtures.py`** from the definitions that
  already existed (`benchmark.CASES`, `gates.COVERAGE_CASES`, `gates.MEASURE_CASES`, the
  signature fixture, the degenerate ones and the elastic ramps) plus the committed golden
  vectors. Each entry says the exact command that renders that fixture and which gates
  need it: `golden` (a vector is committed, so the stage, map and elastic gates walk it),
  `density` (the density gate must measure it) and `signature` (judged by
  `gates.py signatures`, skipped by the others).
- **The Rust bench reads it** instead of walking `bench/golden/*.json` for its cases, and
  its hand-written copy of the three coverage fixtures' names is gone, as is the hard-coded
  list of signature fixtures and the guesswork in `render_hint`. A manifest that is absent,
  unparseable or of another format is named with the command that writes it, rather than
  read as this one.
- **`bench/facts.py` holds the committed manifest to what Python derives**, so a fixture
  added on one side and not written to the other fails a check already run before every
  commit — and a test says the same thing inside the suite.

### Fixed

- **A fixture added on the Python side was invisible to the Rust gates.** They took their
  cases from `bench/golden/*.json`, which by design does not hold the three coverage
  fixtures (`halftime-175-87.5`, `halftime-150-75`, `doubletime-110-220`) — so the density
  gate carried a hand-written copy of those three names to add them back. A fourth would
  have been silently unmeasured. `downbeat-3-4` is a second case of the same shape: a
  measure fixture with no vector on purpose, which no Rust gate could see.

### Measured

```
The five Rust gates read the same cases as before and answer identically: golden 27/27
attack for attack, density 4/4 real changes with worst 1.54 s off and 0 false positives,
nogrid, elastic (median invented drift 0.000 %) and map all pass. 271 Rust tests and 710
Python tests pass.

The drift, demonstrated: a fourth coverage fixture added to gates.COVERAGE_CASES made
facts.py say "halftime-200-100: in the code, not in fixtures.json"; after
`bench/fixtures.py --update`, the Rust density gate listed it, printed the command that
renders it and failed with "1 case(s) have no audio: nothing was measured for them".
Before this, that fixture reached no Rust gate at all.

The audio-missing hazard the row also names was checked and was already covered: with
bench/audio/ empty, and with one file in it, all five Rust gates fail (golden, nogrid,
density, elastic, map). A manifest of a future format is refused by name; an absent one
is reported with the command that writes it.
```

## v4.0.0-dev — 2026-09-27 · Half and double time, said out loud

### Changed

- **`density_hints` (engine, read only)** — audit F-11. A section that goes half- or
  double-time keeps one reported BPM, because the grid is continuous: every hit of the slow
  half still lands on the fast half's grid, so the inlier share the growth loop watches
  never moves. What moves is **coverage** on the beat halved and quartered, which that loop
  computes and throws away. Coverage alone would flag a drop, a breakdown and a sparse bar
  too; the discriminator is **parity** — in a half-time stretch the filled slots share one
  residue mod 2, in a thinned-out one they are scattered. Eight beats at a time: a run of
  windows both empty enough (≤ 70 % of slots) and regular enough (≥ 85 % of the weight on
  one residue), at least two windows long, at least 0.2 of coverage under the rest of its
  section, and not the whole section (that means the subdivision guess is too fine). Each
  hint says where the change sits, which end thinned out, the coverage and parity in and
  out, and a score. It changes no BPM and no red line: DSP §B.2 asks for a hint, surfaced.
  - The detector already existed in Rust (`crates/overtone-tempo/src/density.rs`) and as
    `proto/density.py`, but the analysis on screen is the Python engine's and nothing
    surfaced it. This is the prototype, moved into the engine with its constants named.
- **`Api.density_hints`** hands them to the page. It costs nothing beyond the attacks the
  analysis already holds, so it takes no turn among the heavy jobs; the fallback tracker
  reports no sections, so it has nothing to look inside.
- **A ribbon on the tempo map and a card** in the Timing view: the stretch as a band over
  the confidence ribbon, the beat the change sits on dashed through the plot, and one line
  per hint saying what to do about it — ÷2 or ×2 on that section, or a red line there —
  with the evidence under it in words ("8 of 17 windows, 53 % of the slots filled against
  98 % elsewhere, 100 % of the weight on every other one against 64 %"). Half and double
  have inks of their own and are named in the text, never carried by colour alone.

### Measured

```
Corpus A and the coverage fixtures (27 cases): identical to proto/density.py in every
field of every hint, and identical to the Rust detector's own gate to the digits it
prints — 4 of 4 real changes found (halftime-150-75 at 29.3 s, halftime-175-87.5 and
change-175-87.5 at 33.5 s, doubletime-110-220 at 27.0 s), 0 false positives on the other
23. The Rust gate reads the same coverage and parity pairs: 0.53/0.98 and 1.00/0.64,
0.62/0.98 and 0.94/0.69, 0.54/1.00 and 0.99/0.70.

Corpus B, 19 of 20 tracks analysed (the-raven is refused by the engine as before): 5 hints
in all. None of them on the three tracks whose maps alternate octave — calm-down-juliet,
jungle-dragon, martyr — and that is the detector working as specified rather than failing:
it only looks *inside* one reported section, and the engine had already split those into
0, 6 and 12 sections, so the change was reported and there was nothing left to find. The
5 fall on tracks whose maps keep one BPM throughout (noble 3, nana-hitsuji 1,
camisa-negra 1), which is what a half-time feel looks like to a mapper who kept one red
line. They are not checked by ear, so they are reported as what they are: hints.

Through the browser harness on halftime-150-75: the card reads "From 0:29: section 1
reads 150.00 BPM, but 0:29 – 0:55 plays at 75.00", the band covers 1,997 pixels against
the 2,000 its stretch spans (not the whole plot), and the boundary is dashed at 0:29. On
edm-174 the card says no section holds one, and the band and its legend key are gone.
Both languages read, no key missing and no placeholder mismatched, no console error.
```

### Rejected / tried and dropped

- **Calling the Rust sidecar for the hints.** It has the detector already, but the result
  on screen is usually the Python engine's, and its sections are what a hint indexes; going
  out to the sidecar would have meant a second analysis to index against. The port is held
  to the prototype field for field instead, and both to the Rust gate's printed numbers.
- **Splitting the section automatically.** The whole point of F-11 is that mapping the
  track at the reported BPM stays defensible: a half-time chorus is a feel, and the mapper
  decides whether it deserves a red line. The hint says what it found and what the two
  ways out are.

## v4.0.0-dev — 2026-09-27 · A budget for every stage

### Changed

- **`bench/gates.py perf`**: every stage the engine announces is held to the CPU and wall
  seconds it cost when pinned in `bench/perf_snapshot.json`. Three cases, one per path the
  engine takes: a short grid track, the six-minute one where the heavy stages actually
  cost something, and a ramp, which no grid fits, so the fallback tracker's stages are
  timed too. Nothing else here would notice a stage that became ten times slower — every
  accuracy gate stays green while someone waits.
  - **Single-threaded, in a child process of its own.** numpy's and numba's pools are
    sized when they are imported, so the gate re-runs itself with them pinned to one
    thread; it is still one command. It matters: with the pools free, attack detection on
    edm-174 cost 1.72, 2.94 and 3.11 CPU seconds for identical work.
  - **Two clocks, two bars each.** CPU says whether the engine does more work; wall says
    whether the user waits longer, which CPU cannot see at all when a stage starts waiting
    on a lock or a poll — and the engine now checkpoints inside its loops. A stage fails
    past 2x **and** +0.3 s of CPU, or 3x **and** +1 s of wall; one bar alone would fail a
    16 ms stage that landed on the other side of the clock's own step.
  - The fastest of three runs counts, which also discards the first, where numba compiles.
    A stage that disappears, a new one, and an engine that changed path all fail too.
  - `--update` pins again, for a change said here; `--only` and `--runs` narrow a run.
- CLAUDE.md, AGENTS.md and the README list it with the other gates.

### Measured

```
Pinned on this machine, single-threaded, fastest of 3: edm-174 0.78 s total (attacks 0.61,
octave 0.06, sections 0.05), long-6min 6.47 s (attacks 3.77, sections 2.06, octave 0.44),
_ramp 3.73 s on the fallback (transients 2.42, attacks 0.63). The whole gate: 37 s.

Two further runs against that baseline: every stage inside its budget, the worst unchanged
stage reading 1.11x on CPU and 1.06x on wall — the 2x bar sits well clear of the spread.

Both kinds of regression, injected into the sections stage and caught by name:
1.5 s of waiting (CPU 0.047 -> 0.047, wall 0.049 -> 1.546) failed on wall alone, and the
total stayed "ok" at 2.9x, which is the argument for holding each stage rather than the
run; 2 s of arithmetic (CPU 0.047 -> 2.047) failed on both clocks.

With the pools left free, the same unchanged stage measured 1.72-3.11 CPU seconds
(CPU over wall 2.06-3.60) — a gate built on that would have failed on its second run.
```

### Rejected / tried and dropped

- **CPU time alone.** It was the first design, for the reason that a busy machine steals
  wall time from every stage at once. A deliberate `sleep(1)` inside a stage then passed
  the gate untouched: CPU time cannot see a stage that waits, and waiting is exactly what
  the new checkpoints could introduce. Both clocks are held, the wall one loosely.
- **Letting the thread pools alone and widening the bars instead.** The spread reached
  3.6x for identical work, which is wider than the regressions worth catching.

## v4.0.0-dev — 2026-09-27 · One analysis for every difficulty

### Changed

- **`overtone-cli hitsound <audio> <map.osu> [<map.osu> ...]`** takes a mapset, not one
  map. Deciding a map's sounds is mostly the audio's work — decode, attacks, the evidence
  behind every attack — and that work does not change with the map, so it is done once and
  every map is decided on it. The report keeps its shape for one map; for several it holds
  `maps`, one entry per map in the order given, each with its own `units` or its own
  `error`, so a map that cannot be read costs the others nothing. Exit 1 still means the
  audio or the profile could not be read.
- **`overtone_rust.hitsound`** takes one map or a list of them, and **`Api`** grew three
  calls on it: `hitsound_decide_propose_all` proposes for every difficulty beside the song
  in one sidecar run and caches each map's units as the single proposal already was,
  `hitsound_decide_cached` hands back a cached one without running anything, and
  `hitsound_decide_proposed` says which difficulties hold one, with its profile and how
  many sounds. One heavy job at a time, as before; nothing is written.
- **"Every difficulty"** beside Propose in the Hitsounds view runs that one pass and says
  how many difficulties came back, naming any the sidecar could not read. Afterwards each
  difficulty shows its own proposal the moment it is picked: choosing one asks for its
  cached units before it would ask the sidecar, so the whole set is decided once and
  browsed freely. The single Propose is untouched, for a difficulty proposed again on its
  own or with another profile.

### Measured

```
Take You Down (8 difficulties, MP3, 3:41): one by one 148.0 s, one call 19.1 s — 7.8x, and
every map's sounds identical map for map (541, 520, 544, 447, 618, 580, 422, 334 units).
Roar of the Jungle Dragon (7 difficulties, OGG, 5:21): 296.4 s against 40.1 s - 7.4x, the
same 1,274 to 427 units map for map.

675 Python tests and 271 Rust tests pass; the Rust side gained a test for a mapset whose
second map cannot be read.

Through the browser harness on that same set: "Every difficulty" took 18.9 s for the eight
and said so, the difficulty on screen showing its 541 proposals; moving to each of the next
four then took 0.55-0.75 s, each with its own cached sounds (520, 544, 447, 618) — the same
counts the CLI gives map by map. Both languages read; the Spanish count of unreadable maps
needed a singular of its own.
```

## v4.0.0-dev — 2026-09-27 · Where the music swings

### Changed

- **`swing_lane` (engine, read only)**: eight beats of the working grid at a time, where
  the off-beat eighth falls inside the beat — halfway (straight), later (swing: about
  0.58 a light one, 0.67 the triplet swing, 0.75 a shuffle), or on the thirds as well
  (triplets). Each window is measured from **its own beat**, the densest place its attacks
  sit around the red lines' beats, so a grid a few ms off moves no verdict, and that
  distance comes back as `on_ms`. A window swings when the late eighth sits two tolerances
  past the straight one (so the two can never be read for each other), on at least half its
  beats, carrying a tenth of the window's attack weight, with the straight eighth nearly
  empty; one with neither says `none` rather than guessing. Each swung window also reports
  the pair's ratio, how many ms late, and the coarsest editor snap within 15 ms
  (`2/3`, `3/4`, `7/12`…) — what a mapper would actually set. Consecutive swung windows of
  one feel and tempo merge into a span.
- **`Api.swing_lane`** hands it to the page. A fallback result keeps no attacks, so they
  are detected once per song as a reference grading does, and that case alone waits its
  turn behind another heavy job.
- **A lane on the tempo map**, under the waveform, and a Swing card in the Timing view.
  The lane draws each window as a mark at the height its eighth sits (0.5 at its foot, the
  engine's 0.84 bound at its top) with the straight half, 2/3 and 3/4 ruled across, so a
  stretch that drifts from the triplet swing towards the shuffle is visible as a slope
  rather than a number. It takes no room at all on a song that does not swing: the lanes
  stack from the drift lane's foot and the two conditional ones (objects, swing) collapse,
  so a straight song's chart is exactly what it was. The card names each swung stretch with
  its editor snap, the ratio and how many ms late, or says the song reads straight.

### Measured

```
Corpus A, the two fixtures whose swing is known exactly (bench/benchmark.py places each
off-beat hat at step/2 + swing*step): swing-120 reads 0.580 on all 15 windows against a
truth of 0.58, shuffle-96 reads 0.660 on all 12 against 0.66. The other 13 Corpus A
tracks: not one swung window.

Against the mappers, on 34 local maps whose reading is the map's own pulse (12 of
Corpus B, 22 tagged swing or jazz), the map's objects read in the map's own grid so its
21-24 ms line convention moves nothing: of 185 windows called swung, the mapper snapped
the off-beats late in 134 (72 %); of 1,525 called straight, only 98 (6 %) had late
objects. Where both say swing, the engine's eighth sits a median 0.001 of the beat from
the mapper's (IQR -0.020..+0.034, n=134). Every threshold pair from 0.15-0.35 (straight
eighth) and 0.05-0.20 (weight share) lands between 65 % and 87 %, at 6-7 %, so neither
bar is tuned to a song.

23 further tracks read another pulse than their map (half or double, mostly) and cannot
be compared window for window; the-raven is refused by the engine as before.

Through the browser harness, on Fleeting Lullaby (the fallback tracker's path, so the
bridge detects the attacks): 44 of 49 measured windows swung, in 13 stretches, the first
reading 0.64 of the beat and snapping to 2/3 — the card and the lane say the same. The
lane holds 34 px under the waveform without touching the drift lane, and 1,512 pixels of
its ink are drawn. On edm-174 nothing swings: the card says so, the lane and its legend
key are gone, and the waveform sits 10 px above the drift lane as before. Both languages
read, no key falls through, no console error.
```

### Rejected / tried and dropped

- **Measuring the phase from the red line's own beat.** A window's attacks then carry the
  grid's offset error, and on real songs that error is not small: of the 3,741 windows with
  a beat of their own, 1,091 (29 %) sit past 15 ms from the grid's beat, enough to read a
  swung eighth for a straight one. Reading each window's own beat first costs one more peak
  and removes it.
- **Judging the mapper's objects in the engine's grid** (how this was first scored). The
  maps' lines sit 21-24 ms before the attacks, which at 178 BPM drags a mapper's 2/3 below
  the cut and reads as disagreement: the same rule scored 43 % that way and 72 % in the
  map's own grid. The map's grid is what the mapper snapped to, so that is where their
  objects are read.

## v4.0.0-dev — 2026-09-26 · A stop that lands inside the stage

The stop landed only when the engine announced its next stage, so the running stage bounded
the wait: 11 to 53 s on real songs with the machine busy, when the stop was added. Roadmap,
Phase 3 "Stop inside a stage" and 10.12. Where the time goes inside the stages was measured
first, and that decided where the engine now asks.

### Changed

- **The engine asks inside its long loops.** `checkpoint()` calls the stop request the
  running thread installed with `stop_requests()` and raises `AnalysisStopped` when it says
  yes; with none installed it is one thread-local read, so the CLI, the classic window and
  every other thread run as they did. It is asked:
  - in attack detection: between runs of a quarter of each spectrogram block's STFT (a
    block whole took 0.5-1.6 s), before each block's mel projection, before `power_to_db`
    and before `onset_strength`, and every 1024 re-timed attacks;
  - in the pulse scan: each block of the coherence sweep, each seed candidate's fit, each
    of the pulse gap's six passes;
  - in the octave decision: each block of its tempogram, which it now reads in blocks of
    8192 columns (one call took up to a second);
  - in section growth: each pass and each growth step (189 refits make most of long-6min's
    8.8 s stage), each merge, each boundary and each refit;
  - in the fallback: the envelope as above, the pulse gap's passes, each tempogram block of
    both tempo readings, and between the three trackers;
  - in the load: the decode, now 2^20 frames at a time, each block mixed down on its own.
- **`AnalysisStopped` is the engine's**, a `BaseException` as before: the precision fit's
  fallback and the places that pass over librosa's failures catch `Exception`, never a stop.
- **The Rust engine's process is ended on a stop.** `overtone_rust._run` starts
  `overtone-cli` with `Popen` and reads its output in 50 ms slices, asking the same
  checkpoint between them. A stop, the timeout or any other exit kills and reaps the
  process before the exception leaves, and v3 does not take over, since `run_analysis`
  falls back on `Exception` only. The five CLI calls share it instead of five copies.
- **The bridge installs the request** around the engine, on the worker's thread only:
  `stop_requests(self._stop.is_set)`. The stage announcements and the check before a result
  replaces the one on screen stay as they were.
- **The Stop button's hint** says it stops where the analysis is, without waiting for the
  stage to end (EN/ES).
- 14 tests: a stop asked as each looping stage begins lands inside it (8 stages, both
  engines); asked for nothing, the engine returns what it returned; a checkpoint asks only
  inside a request, which never reaches another thread (one started inside the block, one
  outside); the STFT runs, the octave tempogram and the decode equal the one calls they
  replace, bit for bit; a stopped or timed-out sidecar leaves no process, its output
  arrives whole across slices, and one that cannot start says so; through the bridge, a
  stop as attack detection begins lands before the envelope is finished (on the old code
  the envelope was finished first), a stop ends the Rust engine's process without v3
  taking over, and a refusal after a stop reads as the stop.

### Fixed

- **A stop pressed in the last stage of a song the engine then refuses never landed**: the
  worker checked once more only on the way to a result, and the refusal showed instead. The
  Raven, stopped in its transients stage, reported its refusal 1.8-4.4 s later. An engine
  failure after a stop now reads as the stop, since the user asked for nothing more.

### Hardening

- **Every split is the one call it replaces, bit for bit.** The STFT runs are whole
  batches of the 32 columns librosa.stft hands scipy's FFT at a time, written into one
  matrix with librosa's layout, so the calls are its calls; the octave tempogram joins
  from blocks as the fallback's tempo readings already do exactly, and the mean is taken on
  the joined array; the decode reads as `sf.read` reads and mixes each row down as the
  whole array was mixed.
  - libsndfile seeks between the decode's blocks. That is exact for PCM; for MP3 and Ogg
    the samples came out the same on all 20 Corpus B files (18 MP3, two of them at 48 kHz,
    and 2 Ogg), and so did the whole loader's output on those and on three fixtures.
- **Nothing global.** A request lives in a `threading.local` and is put back when its
  block ends: a reference grade or a library scan on another thread never sees a stop.

### Measured

```
where the time goes: cProfile after a warm-up, the machine loaded by other jobs
  long-6min 6:00, grid         attacks 15.0 s: 16 spectrogram blocks of ~0.9 s (STFT 0.31,
                               mel projection 0.41, power 0.19), power_to_db 0.65,
                               onset_strength 0.55; sections 8.8 s: 189 refits of ~40 ms
  Take You Down 2:15, grid     attacks 6.2 s: 6 blocks of ~1.05 s; sections 2.1 s, 1.4 of it
                               in 13 seed scans
  Vampires 5:27, fallback      transients 38.2 s: 110 tempogram blocks of 0.22 s plus 0.11 s
                               of tempo reading each; attacks 14.5 s; tracking 3.9 s, 1.0 s
                               once librosa's tracker is compiled
  The Raven 7:57, refused      attacks 31.2 s: 32 blocks of ~1.2 s; load 2.5 s: decode 1.5,
                               mix-down 0.8; pulse scan 3.8 s: 6 pulse-gap passes of 0.44 s
the longest wait between two stop points in a stage (checkpoints, stage announcements, the
engine's return), a full analysis of each song stamping every one
  before                       the stage itself, up to 39 s (Vampires' transients)
  one checkpoint a block       0.5-1.0 s, 1.6 s with the machine busier: a block
  as committed                 0.55 s at most in any stage of the four songs (the fallback's
                               beat_track), the machine loaded; 1.17 s (power_to_db on The
                               Raven) with it busy enough to double every analysis. Mean
                               wait by stage 0.01-0.37 s
stop latency through the bridge, stop_analysis() to onStopped, pressed 25/50/75 % into each
stage of the four songs (the middle of stages under 1 s)
  before      37 stops, median 0.87 s, max 35.6 s (Vampires' transients); attack detection
              3.6-6.0 s on long-6min and 2.3-7.5 s on The Raven; the 3 in The Raven's last
              stage never landed (Fixed)
  after       44 stops, median 0.06 s, max 0.40 s, the machine 2-3 times slower than for the
              before run; an earlier run, before the last two edits, 42 stops, median 0.03
              s, max 0.48 s (the fallback's tracker)
  Rust        pressed 25/50/75 % into the CLI's run: before 4.54/2.83/2.19 s (FREEDOM DiVE,
              48 kHz) and 2.58/1.76/0.52 s (long-6min); after 0.05/0.03 s (the third run
              answered first) and 0.09/0.07/0.05 s; no overtone-cli process left behind
the cost with no stop: CPU time with BLAS on one thread (the machine's other jobs inflate it
less than wall time); 7 rounds, old / new / new inside a request as the app runs it, the
order rotating each round; the outputs identical every run
  long-6min        11.00 / 11.20 / 10.97 s; per-round ratio to old 1.034 / 1.012
  Take You Down     4.23 /  4.38 /  4.31 s;                         1.007 / 1.021
  single runs spread about 10 %; wall time 1.013-1.024. The rewritten pieces alone, old
  against new: load 0.94-1.07, spectrogram 1.00-1.03, octave hints 1.14-1.18 (+0.06-0.16
  s: the joined blocks, for an exact mean). A checkpoint is 0.3 us; 216-722 in an analysis
Python unittest   675 -> 689, all pass (6 skipped, as on master)
                  · facts ok · fuzz_reader 3000 mutants
engine gates      benchmark 24/24 within 0.05 BPM and 5 ms, median 0.0000 BPM and 0.16 ms;
                  bpm-snapshot 24/24 unchanged; golden 27/27 stage for stage; coverage,
                  measures, signatures, robustness, reference 24/24, assisted (70 marked
                  sections) and real-audio 6/6 all as they were
```

### Rejected / tried and dropped

- **One checkpoint per spectrogram block**, the roadmap's "between the envelope's chunks".
  Tried first: a block was the longest wait left, 0.5-1.0 s and 1.6 s with the machine
  busier. Its STFT is about 70 % of it, so a checkpoint before the mel projection alone
  would have left about a second; runs of its STFT leave the projection, 0.3-0.6 s.
- **Smaller spectrogram blocks** instead of the runs (not tried): the block is where the
  mel projection's float32 sums are cut, which is why `_mel_power` matches the one-shot call
  only to ~2e-6. Another size would move every envelope by as much.
- **Octave tempogram blocks of 1024 columns**, the fallback's size: 0.09-0.13 s of CPU over
  the one call on a six to eight minute song, against 0.05-0.08 s for 8192, which still
  stops within 0.3 s.
- **The decode left whole**: 1.0 s for an eight-minute MP3, and 0.8 s more to mix it down,
  in two calls a stop could not enter.
- **The analysis in a worker process that can be ended**, the roadmap's other road (not
  tried): every analysis would pay the imports and numba's compile again, or hold a second
  process warm, to win the last half second.

Left open:

- `power_to_db` and `onset_strength` stay whole-track calls: 0.4-0.5 s each on a six to
  eight minute song here, 1.2 s with the machine busy. They grow with the song, as do the
  fallback's `beat_track` (0.5-0.9 s) and a resample; a 30-minute mix was not measured.
- A first call compiles numba kernels in one piece. The window's warm-up takes them before
  the first analysis, but not when the window opens with a song to analyse.
- Formats libsndfile cannot read go to `librosa.load`, one call.
- `structure`, `hitsound`, `ramps` and `attacks` share `_run` but run on threads with no
  request: they end on their timeout as before, and have no Stop.

## v4.0.0-dev — 2026-09-26 · Real songs as a gate

### Changed

- **`bench/gates.py real-audio`**: six real songs of the local Songs folder must keep
  analysing, never refused, on the same engine path and to the readings pinned in
  `bench/real_audio_snapshot.json` (global BPM and every red line's BPM within 0.01, the
  same count of red lines), as `bpm-snapshot` pins the synthetic corpus. The songs are
  Corpus B tracks, named by folder, file and SHA-1 in `bench/corpus_b.json`, one or two per
  path the engine takes on real music: a steady grid (take-you-down), an octave swap
  (camisa-negra), a drifting live band (shinkou), a rubato intro (noble), a signature
  change (palette) and the fallback tracker (calm-down-juliet). The audio is the user's
  and never committed: a track this machine does not hold, or holds changed, is skipped
  and named, and with none held nothing is checked, which the gate says. `--update`
  pins again, for a change said in the timeline.
- CLAUDE.md, AGENTS.md and the README list it with the other gates.

### Measured

```
Pinned on this machine: 6 of 6 tracks analysed, 5 on the grid engine, 1 on the fallback
tracker; 119 s. A second run: 6 of 6 as pinned. A reading moved by hand (palette's
global BPM + 1): the gate fails and names it. The Songs folder moved away: both tracks
asked for skipped and named, exit 0
```

## v4.0.0-dev — 2026-09-26 · A .osz named after its song, not "Unknown Artist"

### Changed

- **A `.osz` takes its song's name.** From the web window it was always "Unknown Artist"
  and the audio's file name; from the command line too, unless `--artist` and `--title`
  said otherwise. Now a map beside the audio that plays it names it best, and its
  [Metadata] is taken as the mapper wrote it (romanised and Unicode fields apart, and the
  source). Without one, the audio's own tags answer (ID3, Vorbis comments, RIFF INFO,
  through libsndfile): a tag goes to the Unicode field as written, and to the romanised
  one only when it is plain ASCII, since romanising is a judgement Overtone does not make;
  otherwise the romanised title stays the file name, as before. A name given on the
  command line still wins, and names both fields.
- **The Unicode fields are written apart**: `TitleUnicode` and `ArtistUnicode` were copies
  of the romanised ones. A value with a line break is written on one line.
- The window's save says what it named the song and where the name came from.

### Measured

```
Every 20th folder of the local Songs folder (241), each audio file a map there plays (249:
215 .mp3, 34 .ogg), its tags against that map's [Metadata], read only:
  tags readable                        249
  a title tag                          125 (of those, 105 plain ASCII)
  an artist tag                        115
  the tag equals the map's field       title 78 of 125, artist 85 of 115 (Unicode or
                                       romanised, case aside)
  read time                            median 19 ms a file, max 548 ms
libmpg123 prints a note to stderr for some malformed ID3 frames; the tag is still read
Python unittest   654 -> 658, all pass
```

## v4.0.0-dev — 2026-09-26 · osu!lazer's maps, measured: read, written back and timed like stable's

### Measured

```
The local Songs folder, read only (scratchpad lazer_scan.py): 25,174 .osu files by their
first line: v14 23,562, v128 (osu!lazer's export) 270, older versions 1,333, no version
line 9.
The 270 lazer maps: 270 read and written back byte for byte; an inject dry run with a
one-line analysis ok on 270; decimal offsets in the timing points of 3 (read, kept on
every write that does not change them, and written by Overtone when Settings → Offset
precision asks for decimals); a decimal object time in none. Nothing failed.
```

The roadmap row asked for lazer's decimal offsets and ".osu v14+ specifics": the first is
built (Offset precision, 0-3 decimals); the second, measured on every lazer map here,
turned out to need nothing the reader and writer did not already do.

## v4.0.0-dev — 2026-09-26 · The confidence tried live on a fallback result too

### Changed

- **The confidence slider now works on the beat tracker's results.** It reads a fallback
  result's stored beats again at another minimum confidence, as ×2 and ÷2 do, now that a
  rebuild at the result's own pulse gives the result back. Only a result with neither
  fitted sections nor stored beats still refuses.

### Measured

```
The four Corpus B songs that fall back to the tracker (audio read only) and Corpus A's
three ramps: read again at their own 75 %, 7 of 7 identical to the analysis. The
threshold moves red lines on all 7: Vampires 26 at 0 %, 22 at 75 %, 9 at 90 %;
ramp-120-160 10, 8 and 1; Calm Down Juliet 6, 3 and 1
Python unittest   653 -> 654, all pass
```

## v4.0.0-dev — 2026-09-26 · Re-anchoring off holds through ÷2 and ×2

With "Re-anchor beats to transients" off, the fallback analysis leaves every beat where the
tracker's split puts it, but a ×2/÷2 rebuild re-anchored them all regardless: at its own
pulse every beat moved, on each of 6 analyses tried (left open in the entry below).

### Fixed

- **A rebuild re-anchored the tracker's beats whatever the analysis had been asked.** The
  switch reaches the analysis as `refine_beats`, and the rebuild never saw it. The result now
  keeps it (`Analysis.refine_beats`) and the rebuild hands it to `_tracker_result`, so with
  the switch off a rebuild leaves its beats where the split puts them, as the analysis does.
  Its lag stays 0: without re-anchoring the analysis reads none.
- 1 test on the entry below's kit with the switch off: the rebuild at its own pulse gives the
  analysis back, and ×2 gives what the analysis forced to ×2 gives. It fails on the old code,
  all 47 beats different, up to 95.8 ms.

### Measured

```
re-anchoring off, 5 Corpus A fixtures with the tracker forced and the tests' kit; one-off
script, not committed
  rebuilt at its own pulse      0 of 6 identical -> 6 of 6. Before, every beat moved (up to
                                95.8 ms) and change-128-142 read 280.73 BPM for 283.18
  rebuilt at x2 and /2, against the analysis forced to that pulse
                                0 of 12 identical -> 12 of 12. Before, change-128-142 at x4
                                came to 19 red lines for the forced analysis's 2
re-anchoring on, as in the entry below: the 32 fallback analyses 0 of 32 differ at their own
  pulse, x2 then /2 and /2 then x2 0 of 32; against the code before both entries the
  analyses are identical, 33 of 33 with pulse Auto and 50 of 50 forced or re-anchoring off
  (compared as the entry below compares them)
Corpus B, the four fallback songs (bench/corpus_b.py --only, analysed afresh)
                                exported red lines identical, 6/16/31/150 of 249 within
                                2/5/10/50 ms
Python unittest  652 -> 653, all pass (none skipped) · facts ok
engine gates     benchmark 24/24 (0.0000 BPM / 0.16 ms), bpm-snapshot 24/24, golden 27/27,
                 coverage, measures, signatures, robustness, reference 24/24, assisted 70,
                 fuzz_reader 3000: each one's output line for line the same as on the tree
                 before both entries (timings and temporary paths aside)
Rust             no file changed; cargo test 270 pass, golden 27/27, nogrid, density 4/4 with
                 0 false positives, elastic, map: all pass
```

## v4.0.0-dev — 2026-09-26 · A fallback result comes back from ÷2 then ×2

Pressing ÷2 and then ×2 should give back the result the analysis gave. On the fallback
tracker's results it did not where the tracker had doubled its own pulse: 11 of the 32
fallback analyses of the retiming work ("The fallback tracker's beats, moved onto their
attacks") came back changed, Calm Down Juliet with 10 red lines for 3. That work found it
and left it open.

### Fixed

- **The analysis and the ×2/÷2 rebuild finished the tracker's beats in two copies of the
  same steps, and held a beat with no peak under it differently.** After splitting the
  tracked beats, both snap each beat to the loudest point of the onset envelope within ±25-90
  ms. Where that point is the window's edge (a silent stretch, a neighbour's tail or rise),
  the beat has no attack of its own. The analysis holds such a beat in place only at a pulse
  the user asked for, and otherwise lets the snap drag it to the edge, up to 95.8 ms (holding
  on the tracker's own doubling changed 9 of 27 real songs with no net gain, 2026-09-23). The
  rebuild held it at every pulse above 1, the tracker's own doubling included, so a rebuild
  at the analysis's own pulse was a different result.
- **Both now end in one function, `_tracker_result`**, from the tracked beats to the red
  lines; `_moved_by` then takes the lag off. The result keeps the pulse the tracker chose
  itself (`Analysis.auto_subdivision`), and a beat with no peak under it is held only away
  from it: the analysis's own rule, now the rebuild's as well. ÷2 then ×2, ×2 then ÷2, and ×2
  after an analysis forced to ÷2 all come back to the tracker's own result.
  - No analysis changes, field for field, and a rebuild away from the tracker's own pulse
    holds its beats as before.
- 3 tests on a 90 BPM kit with three silent seconds, which the tracker reads doubled: the
  rebuild at its own pulse, both round trips, and ×2 after a forced ÷2 give the analysis
  back. All three fail on the old code, 9 of the 47 beats up to 95.8 ms apart.

### Measured

```
the 32 fallback analyses of the retiming work (Corpus A's 24 fixtures with the tracker forced,
the 4 renders that fall back with engine auto, Corpus B's 4 fallback songs), each rebuilt at
its own pulse; one-off scripts, not committed
  before  11 of 32 differ, each where the tracker doubled its own pulse (17 of the 32; the
          other 6 have no beat without a peak under it):
            Corpus A  breakdown-175 2 -> 3 red lines, change-175-87.5, heavy-jitter-168,
                      slow-92 (global 184.140 -> 184.584 BPM), with-drop-180
            renders   ramp 100->140 16 -> 15 red lines (global 249.47 -> 253.56),
                      free-then-steady
            Corpus B  One Step Closer 4 -> 3 red lines, Vampires 22 -> 22 (12 of them
                      different), Calm Down Juliet 3 -> 10, Day to Story 3 -> 5
          over the 11: 60 red lines -> 68 (29 not given back, 37 new), 24 section BPMs not
          given back, the global BPM moved on 7, 224 beats moved, added or dropped (up to
          95.8 ms); x2 then /2 and /2 then x2 11 of 32 each
  after   0 of 32 at the own pulse; x2 then /2 and /2 then x2 0 of 32
the analyses themselves, old code against new, identical: 33 of 33 with pulse Auto (the 32
          and the benchmark's degenerate ramp), every field but the new one; 50 of 50 with
          the pulse forced x0.25-x4 or re-anchoring off, on 8 Corpus A fixtures and the
          tests' kit, in beats, red lines, local tempo, meter, tracked beats and lag (5 of
          the 50 the same refusal)
for contrast, the precision engine on Corpus A: 24 of 24 already came back, own pulse and
          x2 then /2
Corpus B, the four fallback songs (bench/corpus_b.py --only, analysed afresh)
          exported red lines identical; within 2/5/10/50 ms 6/16/31/150 of 249 before and
          after, sections within 0.05 BPM 0 and within 1 BPM 44
Python unittest  649 -> 652, all pass (overtone-cli built in the worktree, none skipped) · facts ok
engine gates     benchmark 24/24 (0.0000 BPM / 0.16 ms), bpm-snapshot 24/24, golden 27/27,
                 coverage, measures, signatures, robustness, reference 24/24, assisted 70,
                 fuzz_reader 3000: each one's output line for line the same as on the
                 unchanged tree (timings and temporary paths aside)
Rust             no file changed; cargo test 270 pass, golden 27/27, nogrid, density 4/4 with
                 0 false positives, elastic (worst 4.865 %, as documented), map: all pass
```

### Rejected / tried and dropped

- **Agreeing the other way: holding those beats in the analysis too**, the rule the rebuild
  had. Measured as the old rebuild at each analysis's own pulse, which is that rule with the
  analysis's lag kept.
  - Corpus B's four songs: the maps' red lines within 2/5/10/50 ms 6/16/31/150 -> 5/18/31/142
    of 249; sections within 0.05 BPM 0 -> 6, within 1 BPM 44 -> 55. Calm Down Juliet 3 -> 10
    red lines for the map's 7, Day to Story 3 -> 5 for its 5.
  - Corpus A, the 11 fixtures the tracker reads doubled: slow-92 0.070 -> 0.292 BPM,
    breakdown-175 0.150 -> 0.131 BPM with 3 sections for its 1 (2 before); the other nine
    score the same.
  - Mixed, and it would change 11 of the 32 analyses; on 27 real songs on 2026-09-23 it
    made no net gain either. The analysis keeps its rule and the rebuild takes it.

Left open:

- With "Re-anchor beats to transients" off, the analysis leaves every beat where the tracker
  put it, but a rebuild re-anchors them all: at its own pulse, 6 of 6 tried differ in every
  beat (change-128-142 283.18 -> 280.73 BPM).
- A pulse forced past ×4 of the tracked beats (×4 where the tracker doubled reads ×8) has no
  way back through ×2/÷2: a rebuild takes ×0.25-×4 only.

## v4.0.0-dev — 2026-09-26 · A map checked from the command line

### Changed

- **`--check MAP.osu`**: after the analysis, the command line prints the modder's report
  for that map instead of the red lines, the one the Report section posts: red lines to
  check with their error, tempo changes the map lacks, objects off the map's own grid or
  away from the music, each under its editor timestamp. It exits 3 when it found something
  and 0 when the map is clean ("No findings."), so a script can tell; errors stay 1 and
  usage 2. With `--json` the output is `{"analysis": ..., "check": ...}`. The map is only
  read. A fallback result keeps no attacks, so they are found once for the check.
- A folder with `--check` is refused, as the other single-file flags are.

### Measured

```
Three Corpus B maps (read only), as a process: palette 14 findings, yui-again 115,
calm-down-juliet 11; exit 3 each; 12.0, 16.5 and 80.5 s (the last one's analysis falls
back to the tracker, and its attacks are found for the check); every map's bytes
unchanged. The first line of each is the whole map sitting 22-32 ms from the attacks,
the late reading the precision plan explains (10.0a)
Python unittest   645 -> 649, all pass
```

## v4.0.0-dev — 2026-09-26 · A stopped song heard where the position lands

### Changed

- **Scrubbing is heard.** With the song stopped, moving the position by hand (dragging the
  seek bar, the arrow keys, Shift and an arrow for 10 ms steps, a jump to the previous or
  next red line) plays a 120 ms grain of the song there, faded in and out over 8 ms so it
  does not click, through the song's own volume (and the percussive part alone when that is
  what plays). Each grain cuts the one before, and a drag is heard at most once per 45 ms,
  the newest position kept, so a fast drag ends on the grain where it stops. A place found
  by eye can be checked by ear without playing from a second before it.
- Moves the page makes by itself (opening a section, a hitsound row) stay silent, and a
  playing song still just jumps. The transport's hint and the keyboard sheet say so.

### Measured

```
The page, through the UI harness (audio routed to a silent output, as always) on a scratch
song: 40 seek-bar moves over 887 ms gave 15 grains, the last one at the final position
(9.452 s); five Shift+Right presses 80 ms apart gave five grains 10 ms apart; a move while
playing restarted the song and added no grain; every grain 120 ms long; no page errors
Python unittest   645, all pass (the page's two languages still hold the same keys)
```

## v4.0.0-dev — 2026-09-26 · A ×2 or ÷2 kept with the song

### Changed

- **The song keeps the octave on screen.** A ×2 or ÷2 after an analysis becomes the song's
  own pulse setting (×2, ÷2...), so analysing it again lands where the mapper put it
  instead of back on the octave the engine picked; while the analysis stands at the octave
  it found, the song keeps the pulse option its analysis ran with (Auto stays Auto). Undo
  and redo move it back and forth with the grid, and the Detection drawer's pulse follows.
- `rescale`, `undo` and `redo` replies carry the pulse the song keeps when it changed.

### Measured

```
Analysing again with the kept pulse against the ×2 or ÷2 it keeps, red lines compared
line by line: identical on 16 of 18 (eight Corpus A fixtures and camisa-negra, ×2 and
÷2 each); the 2 that differ are the fallback tracker's (ramp-180-140), whose rebuild at
another pulse does not reproduce an analysis there (a fix in progress)
The page, through the UI harness on a scratch song: Auto at 145 BPM; ×2 put the drawer
and the song at ×2 (290 BPM); undo, Auto and 145; redo, ×2; Analyze, 290 BPM at ×2
Python unittest   643 -> 645, all pass
```

## v4.0.0-dev — 2026-09-26 · Suggestions at an octave of the map's tempo, marked in the list

### Changed

- **A suggestion at ×2, ×4, ÷2 or ÷4 the map's own tempo says so in the list**, beside
  its BPM, with the map's tempo in its tooltip: such a line is more often the same pulse
  counted differently than a change the map lacks, and before this the list showed it like
  any other, the warning coming only in the consent to add it.
- **One rule for both places**: each suggestion carries `map_bpm` (the map's red line in
  force there, its first before it begins) and `octave`, read with the band the octave
  finding already uses between sections (0.15 in log2). The consent now reads the
  engine's answer instead of a narrower rule of its own (3 %), which let a suggestion at
  2.14× the map's tempo through unmarked.

### Measured

```
Corpus B, the 20 ranked maps (read only) with master's Corpus B analyses:
  suggestions                        23 on 5 maps
  marked as an octave                6 (×4 once, ×2 five times; 1.975 to 4.000 the
                                     map's tempo)
  moving slider ends past 25 ms      5, all 5 among the marked (159 to 559 ms)
  unmarked                           17, all within 4 % of the map's tempo
Engine commit, on the master before the sample bank: unit tests 631 OK; benchmark,
bpm-snapshot 24/24, golden 27/27, reference 24/24, assisted, coverage, measures,
signatures, robustness; fuzz_reader 3000
Python unittest   642 -> 643 on the master with the sample bank, all pass
```

## v4.0.0-dev — 2026-09-26 · The Samples card: a folder's samples heard, and the skin playback asks

The bank (next entry) had no page, and nothing let a mapper point playback at their own
skin. `06` §8 names the part that matters: hearing a sample against the song at the
selected object. The transport made it cheap, so it is in.

### Changed

- **A Samples card at the end of the Hitsounds section**, reading this song's folder, the
  playback skin, or another folder (a folder dialog that opens in osu!'s Skins beside the
  Songs folder, or beside the skin in use). The bank is a grid, set by set: the four hits,
  the slide and the whistle slide. A cell gives the file's format and size, "empty" for a
  file with no audio, and "→ skin" or "→ Overtone" for a missing one, its title naming the
  file that plays instead. Under it, the custom indices (on a skin: numbered files osu!
  never asks a skin for), and the names never played, with why. A line counts it all.
- **Every sample heard.** A click plays it alone and keeps it; a missing cell plays what
  plays in its place, and an empty one says it plays nothing. **Hear it at the selected
  sound** plays the song from a second before the sound selected in the Sounds table, the
  kept sample in that sound's place at the sound's own volume, the transport's other
  hitsounds as they are, and stops 1.5 s after it: one sample swapped for the sounds at
  one moment, in the scheduler that already plays the hitsounds, with no loop.
- **The playback skin is a setting** (`skin_folder`, through `set_settings`). "Use for
  playback" offers any folder without maps but the song's own; "Stop using a skin" clears
  it. The transport loads what it plays again with it, and its status and the Hitsounds
  summary count the skin's samples beside the map's and Overtone's. A skin folder that
  moved is said on the card, and Overtone's own play meanwhile.
- **A mute is not a decode failure.** A sample with no audio in it was counted among the
  ones "this window cannot decode"; it is now said as a mute and not decoded. Skins mute
  their slides this way (previous entry).
- Bridge: `sample_bank(folder)`, `pick_sample_folder()`, `sample_audition(folder, file)`;
  `hitsound_playback` and `hitsound_decide_playback` pass the skin. English and Spanish.
  5 bridge tests; the settings test holds the new key.

### Hardening

- The folders are only read. The bank, the dialog and the audition list and read files;
  choosing a skin writes only the app's own config, which tests and the harness replace.
- `sample_audition` reads only a file named as a hitsound sample (set, sound, index, then
  .wav, .ogg or .mp3), alone, inside an absolute folder: an .osu, the song's audio, a
  name with a path in it and a relative folder are refused. `skin_folder` is an absolute
  folder that exists, or empty; anything but a string is refused.

### Measured

```
the page, through the UI harness at 1280x800 (its own functions driven, its sound at gain 0),
on "2543600 NOA LONE - way up (nightcore & cut ver)" (expert: 262 sounds, 81 slider slides)
and the local skin "-    rafis blue cursor"
  the song's folder   7 of 12 hits, 1 of 6 slider sounds, 10 missing to Overtone's, 3 empty;
                      custom indices 2 and 3, 14 samples
  the skin            12 of 12 and 6 of 6, 10 empty; 12 numbered, not played; 1 never played;
                      15 shadowed; its name (a leading dash, runs of spaces) read as it is
  use for playback    the transport: 462 map / 149 Overtone's -> 462 map / 149 the skin's;
                      the song's folder: its 10 missing now the skin's; stop: 149 Overtone's
  heard alone         the song's clap (1.48 s), a missing whistle from the skin (0.80 s);
                      an empty slide said as playing nothing
  over the song       a clap at 20.302 s (bar 18 · 2): the song from 19.302, the sample
                      scheduled once, at 20.302 and the sound's 70 %; no map sound there,
                      its neighbours at 20.155 and 20.449 played; stopped at 21.802
  a skin that moved   (a scratch folder, then deleted) said in both languages, the song's
                      folder shown, Overtone's own played, no error
  layout              no horizontal overflow; 18 cells of 137 px, no text cut; the head and
                      both action rows on one line in English and Spanish; light theme
                      read from the theme's tokens
  console             no errors
Python unittest   611 -> 616, all pass (6 skipped: overtone-cli is not built in this worktree)
facts             ok
```

Not checked: narrower windows, and anything heard (the harness is silent by design); the
timings above are song times, not the harness's.

## v4.0.0-dev — 2026-09-26 · The sample bank, read: what a skin or beatmap folder holds

P-3 promised samples found as osu! finds them, "beatmap folder custom index, then skin,
then defaults", and the skin was never read: a sound the map's folder could not answer
went straight to Overtone's own. The first half of H6 (`06` §8, roadmap Phase 6 "Sample
bank") is the engine under the card that comes next: read a folder, and let playback ask
a skin.

### Changed

- **`sample_bank(folder, skin=None)`** reads a skin or a beatmap folder with the same
  lookup playback uses: for each set, the four hits and the slide and whistle slide a
  slider body loops, each by its bare name, wav then ogg then mp3, in any case; every
  numbered name (`soft-hitclap2.wav`) as a custom index. Each missing cell names what
  plays instead: the skin's, when a skin is given and has it, else Overtone's own. Apart
  it lists files that hold no audio (0 bytes, or a WAV whose empty data chunk ends the
  file: the header alone that mutes a sound), files another extension of the same name
  shadows, and names no lookup reaches (`soft-hitnormal1.wav`: osu! asks for index 1
  bare; a leading zero). A folder with an .osu reads as a beatmap folder, any other as a
  skin. Read only, and a listing plus the headers of WAVs up to 4 KB, nothing more.
- **Playback asks a skin** (`hitsound_playback(beatmap, folder, skin=None)`): index 0, and
  an index the map's folder lacks, play the skin's sample before Overtone's own. A skin
  is asked for the bare name only: only a beatmap's folder has custom indices (the rule
  osu!lazer's legacy skins keep for stable's sake; stable itself is not verified here),
  so a skin's `soft-hitclap2.wav` is listed by the bank and never played. The source is
  counted as `skin`. With no skin, every sound plays what it played before.
- **`bench/sample_banks.py OSU_FOLDER`**: every skin, and 200 beatmap folders by a rule
  written in the script before its first run (the Songs folders sorted by name, every
  k-th from the first; `--offset` for a disjoint sample), read through `sample_bank`.
- 6 engine tests: a skin folder cell by cell, a beatmap folder falling back to a skin
  then to Overtone's, playback with a skin (bare names only), the bank agreeing with
  what playback plays for every hit of every set, what counts as empty, a non-folder
  refused.

### Fixed

- **A skin's missing samples fell back to the skin in use** when the bank read a skin
  with one given, as the Samples card would when it shows a skin to choose: choosing a
  skin replaces the one in use, so what a skin lacks plays Overtone's own. Only a beatmap
  folder's missing samples fall back to a skin. 1 engine test.

### Hardening

- The measurement only lists folders and reads the first 4 KB of small WAVs under
  `C:\osu!`: nothing was written, renamed or created there.

### Measured

```
bench/sample_banks.py "C:\osu!": 60 skins, 200 of 4,801 beatmap folders (every 24th by name)

skins (60)
  the 12 hits          59 have all 12, one has 11
  the 6 slides         53 have all 6; the fewest, 1
  numbered samples     240 in 22 skins (6 to 14 each, index 2 for most, one up to 222):
                       osu! plays none of them from a skin
  empty samples        304 in 52 skins, 280 of them a slide or whistle slide
                       (112 of 0 bytes, 192 a WAV header alone)
  never played         26 unreachable names in 20 skins (an index 1 written out);
                       140 files shadowed by another extension, in 9
  extensions           .ogg 706 · .wav 597 · .mp3 0
beatmap folders, the rule's 200 (bare names are what a map's index 1 asks for)
  the 12 hits          min 0 · p25 0 · median 3 · p75 5 · max 11; none in 64, all 12 in 0
  the 6 slides         none in 105; the most, 3
  custom indices       in 102 folders, 1,536 samples: per folder with any, median 8,
                       p75 13, max 193; the highest index a folder has, median 5.5,
                       p75 22, max 100
  empty samples        292 in 122 folders, 286 of them the slide; every one a WAV header
                       alone, none of 0 bytes
  never played         0 unreachable names; 43 shadowed files in 3 folders
  extensions           .wav 1,679 · .ogg 570 · .mp3 0
beatmap folders, a second 200 (--offset 13, disjoint)
  the 12 hits          median 2; none in 77, all 12 in 1
  custom indices       in 101 folders, 1,452 samples, up to 220 in a folder, index up to 999
  empty samples        310 in 119 folders; .mp3 2

reading one folder (sample_bank, this machine)
  beatmap, first read  median 1.97 ms · p90 8.08 · max 176.68   (the second 200, which no
                       run of this session had read: cold, as far as it can tell)
  beatmap, again       median 0.51 ms · p90 1.30 · max 5.06
  beatmap, the rule's 200 read a second time today: median 0.48 ms · max 6.03
  skins, warm          median 2.55 ms · p90 4.61 · max 8.50 (their one cold read was by
                       the first version, below: median 12.16 · p90 229 · max 402)

Python unittest   604 -> 611, all pass (6 skipped: overtone-cli is not built in this worktree)
facts             ok; no analysis code changed, so the engine gates were not run
```

A beatmap folder rarely holds a whole set, and nothing about that is wrong: the median
has 3 of the 12 hits under their bare names, 64 of 200 have none, and 102 carry custom
indices instead. What a map asks for and does not find plays the skin's, as `06` §8
records. Skins are the opposite: 59 of 60 hold all 12, and most mute something with an
empty file, which the bank shows as empty instead of as a sample.

### Rejected / tried and dropped

- **Reading every WAV's header to find the empty ones.** The first version opened each
  WAV the bank found. On the rule's 200, read for the first time in this session, it took
  a median 58.76 ms per beatmap folder (p90 190 ms, max 1,947 ms). Timed step by step (a
  scratch script, not committed) on a third disjoint 200, the rule from the 7th folder,
  also unread before: the listing took a median 0.81 ms (0.29 s in all), a stat per
  sample 1.21 ms (0.50 s), the headers of WAVs up to 4 KB 1.34 ms (1.55 s), and the
  headers of larger WAVs 48.31 ms (21.41 s). Those last can never be empty here (the
  data chunk must end the file inside the 4 KB read), so they are no longer opened, and
  sizes come from the listing, which carries them on Windows. The rule's 200 and the 60
  skins, read again after the change, give every count above unchanged.
- **Detecting digital silence** (a sample of zeros) would need a decode of every sample,
  ogg included; the bank marks only files with no audio at all, and says so.

## v4.0.0-dev — 2026-09-26 · Undoing a ×2/÷2 puts the whole pulse back

### Fixed

- **Undo after a ×2 or ÷2 left the doubled grid under the old red lines.** The undo stack
  kept point lists only, and a pulse change is the one edit that replaces the analysis
  itself: its beats, pulse and global tempo, and the locks' BPMs with them. Undo put the
  points back and left the rest, so the tempo map read 256 BPM under a 128 BPM red line,
  the click followed the old points over the new grid, and the next ×2 went to ×4. Each
  entry now keeps the analysis it replaced and, when the edit changed them, the locks.
- **Undoing a restored project now drops its locks too**: restoring was the other edit that
  replaces the locks, and undo brought back the points without them.

### Measured

```
A 128 BPM drum track, x2 then undo then x2: the grid read 128 -> 256 -> 256 -> 512 BPM
(beats 32 -> 65 -> 65 -> 131) before the fix; 128 -> 256 -> 128 -> 256 (32 -> 65 -> 32
-> 65) after, the locks' BPM back to 128 on undo and 256 on redo
Python unittest   630, all pass (the lock and project tests hold undo and redo now)
```

## v4.0.0-dev — 2026-09-26 · The confidence threshold, tried live on the tempo map

### Changed

- **A slider beside the minimum confidence** in the Detection drawer. With a grid analysis
  on screen, moving it (or typing a value) reads that analysis's fitted sections again at
  the new confidence, as ×2 and ÷2 read them at another pulse, so nothing is analysed
  again. The tempo map dashes the red lines it would add and fades the ones it would drop,
  and a line under the slider says how many there would be against how many there are.
  "Apply to this analysis" makes them the red lines on screen as one undoable edit, locked
  lines kept, and keeps the value as the setting the next analysis starts from, the
  song's own included. Closing the drawer, a preset, an analysis or an edit leaves the
  trial unapplied.
- **The drawer's veil lifts while a confidence is tried**: the map stays sharp, and the
  wheel and drags reach it, to bring into view the lines the drawer covers.
- `confidence_preview(percent)` and `confidence_apply(percent)` in the bridge. A fallback
  result keeps no sections and answers `no_grid`; there the value still applies on the
  next analysis, as before.

### Measured

```
Corpus A (31 grid analyses of bench/audio) and Corpus B (15 grid analyses; 4 of its 20
fall back to the tracker, 1 is refused), each analysed at the defaults, then read again
at 0 to 90 %:
  read again at 75 %: the same number of red lines as the analysis on 46 of 46, and
  the same offsets and BPMs on the six fixtures compared line by line
  Corpus A: no candidate below 75 %, so the threshold changes nothing on any of 31
  Corpus B: candidates below 75 % on 13 of 15 (confidence 0.32 to 0.74); at 0 %
  Noble reads 15 red lines where 75 % shows 1, and camisa-negra reads 7 at 50-60 %,
  5 at 70 %, 3 at 75 % and 1 at 80-90 %
Python unittest   625 -> 630, all pass
The page, through the UI harness at 1280 px on a scratch copy of camisa-negra: at 60 %
7 red lines against 3 (4 dashed), at 80 % 1 against 3 (3 faded), at 75 % the same 3 with
Apply off; Apply gave 7 and Undo 3; closing the drawer left the trial; the wheel zoomed
the map with the drawer open; English and Spanish; no page errors
```

## v4.0.0-dev — 2026-09-26 · Each song's own detection settings, put back

### Changed

- **A song remembers the detection settings its last finished analysis ran with**: the
  preset values, pulse, BPM preference and re-anchoring. Choosing the song again (Open,
  recents, the Songs browser, a drop) puts them back in the Detection drawer when they
  differ from the ones on screen, says so in a toast, marks the drawer's button with a dot,
  and heads the drawer with a note naming them ("Steady · pulse ×2") and a button that puts
  back the ones they replaced. Changing a setting by hand makes it the mapper's again: the
  note goes, the change stays.
- **The engine is not a song setting**: Rust or Python is a choice about speed, so it stays
  one setting for every song.
- `song_options(path)` in the bridge; kept in the config as `song_options`, keyed by the
  first 16 hex digits of the audio's SHA-256, so a moved, copied or dropped file keeps
  them; the 200 most recently analysed songs are kept.
- **Not in the project file**, as the roadmap row had it: a project exists only once the
  timing has been edited, and the settings matter from the first analysis on.

### Hardening

- A failed or stopped analysis leaves nothing. Settings that do not read back whole and
  in range (a hand-edited config, a later shape) are ignored, never applied, and a
  `song_options` that is not a map is dropped when the config is read.
- The song's settings are stored before the result reaches the page, so a dropped file,
  which the page chooses again when its result arrives, reads the settings that result
  ran with.

### Measured

```
Recognising a song (SHA-256 of its audio), on the 20 Corpus B audio files (2.2-11.5 MB,
median 5.6 MB), read only: median 28 ms the first time, max 81 ms; the same file again
(size and modification time unchanged) 0.2 ms
Config: 182 bytes a song as written, 36 kB for 200 (the config's limit is 256 kB)
Bridge commit: unit tests 625 OK; benchmark, bpm-snapshot 24/24, golden 27/27, reference
24/24, assisted, coverage, measures, signatures, robustness (the engine file's only change
is the config type)
Python unittest   621 -> 625, all pass
The page, through the UI harness at 1280 px with two scratch songs: song A analysed with
Steady and pulse x2, song B with Variable and Auto; choosing B kept the settings on
screen (it had none); choosing A again put Steady and x2 back, with the toast, the dot
and the drawer's note; "Use the previous ones" restored Variable and Auto; a pulse
clicked by hand kept its value and cleared the note; the note in Spanish; no page errors
```

## v4.0.0-dev — 2026-09-26 · The fallback tracker's beats, moved onto their attacks

When no grid fits, v3 falls back to the v2 beat tracker, and the roadmap said its beats land
5-35 ms late (Phase 22, "Fallback re-timing"). Measured first, against truth that needs no
map: with the tracker forced on Corpus A, its beats land a median 7.4-8.9 ms after the hits
(13 and 17 ms under noise); on the four Corpus B songs that reach it, the sound starts 21-24
ms before them. Each song's lag is now read on its waveform and taken off every beat and red
line. The tempo the tracker reads is untouched, and so is everything the precision engine
does.

### Fixed

- **The fallback's beats sat on the onset envelope's peaks, after the sound.** The tracker
  follows librosa's onset strength at 5.8 ms frames, and `_refine_beats_to_transients` ends
  each beat on that envelope's peak. The peak comes after the attack starts, by as long as
  the flux takes to rise: 7-9 ms for drums over silence, more when noise or a bed fills the
  bands (13-17 ms), 12-17 ms on the real songs. The precision engine removes the same lag by
  re-timing each attack on the waveform (`_retime_onsets`). The fallback had no such step.
- **`_tracker_lag`** re-times each of the tracker's beats that way. The median shift of the
  beats that moved is the song's lag; it is read only when at least 8 moved, and at least
  half of them. Every beat and every red line moves by it, none before 0 s.
  - Sections, BPMs, the pulse octave and the meter are still read on the tracker's own
    beats, so they come out identical (checked on all 32 fallback analyses below).
- **`Analysis.beat_shift_s`** keeps the shift, 0 for the precision engine.
  - A ×2/÷2 rebuild has no audio to read a lag on, so it moves its beats by the song's own.
    Its beats, read on the audio, lag within 2.5 ms of it (×0.5 to ×4, Corpus A and B).
  - The pulse suggestion reads the envelope where the tracker put each beat. Moved 20 ms
    earlier, a beat's ±2-frame window misses the peak and the suggestion would vanish.
- 5 tests: a click ramp through the fallback lands on its clicks, and so does its ÷2
  rebuild (+6.1 and +6.5 ms on the old code); only positions move; the suggestion reads the
  envelope; no lag without attacks under the beats.

### Measured

```
every beat against the nearest sound placed (signed, + when the beat is later); one-off
scripts, not committed
Corpus A, the tracker forced (engine="legacy"), 24 fixtures
  beats            per-fixture medians +7.43..+8.91 ms (+13.24 noisy-140, +17.18 very-noisy-132),
                   0 % within 5 ms  ->  -0.20..+0.23 ms, 99.3-100 % within 5 ms
  lag read         -7.34..-8.99 ms, -13.12 and -17.04 under noise
  red lines        |error| median 7.81 -> 0.72 ms; within 5 ms 0 -> 34 of 35 (the 35th sits in
                   with-drop-180's silence, 237 ms from any hit)
  benchmark.py --engine legacy   offsets median 8.03 -> 1.18 ms, within 5 ms 0 -> 17 of 24;
                   BPM unchanged (median 0.1974, the tracker's median of beat gaps), 0 -> 1 of
                   24 cases within both bars. The seven offsets still over 5 ms are the
                   tracker's tempo (its grid drifts from the line to the true change) or a
                   grid started on noise; tiny-change 6.85 -> 11.37, where the lag had hidden
                   part of that drift
renders that reach the fallback with engine auto (60 s, every hit at a known sample)
  ramp 100->140, kit and off-beat hats       +8.66 -> +0.18 ms; within 5 ms 0 -> 95.8 %
  ramp 170->120                              +7.88 -> +0.16;  0 -> 100 %
  96 BPM ±9 % under a loud pad and noise     +15.23 -> +0.09; 0 -> 100 %
  ±10 % for 20 s, then 140 steady            +8.70 -> +0.19;  0 -> 100 %
  red lines        |error| median 8.46 -> 0.68 ms; within 5 ms 0 -> 23 of 24 (the ramp's first
                   sits on a beat the tracker put between hits, 48.5 -> 40.0 ms)
  three rubato renders (the tempo swinging ±6-9 % around 120-150 BPM) were fitted by the
  precision engine and never reach the fallback
the benchmark's degenerate ramp (120 -> 160)   the same 8 sections and BPMs, so its printed
                   line is unchanged; beats +7.71 -> +0.11 ms (0 -> 100 % within 5 ms), red
                   lines +6.5..+8.7 -> -1.1..+1.1 ms
Corpus B, the four songs that fall back (The Raven is refused before any tracking)
  lag read         One Step Closer -17.2, Vampires -16.4, Calm Down Juliet -12.0,
                   Day to Story -14.8 ms
  the sound's start after the tracker's own beats (--onsets' measure, on its beats rather
  than on a grid drawn from its red lines; contrast in brackets)
                   -21.8 (3.0) -> -4.2 (2.8), -20.7 (3.7) -> -4.3 (3.6),
                   -21.8 (2.8) -> -9.7 (2.7), -24.4 (2.4) -> -9.6 (2.4)
  against the maps' beats, beat by beat (median, and the interquartile width)
                   +36.9 (5.1) -> +19.9 (5.3), +31.9 (13.6) -> +15.9 (12.9),
                   +41.8 (9.6) -> +30.1 (6.6), +46.0 (5.8) -> +31.3 (5.7) ms; the maps put their
                   lines 7-23 ms before the sound on these four (10.0a)
  red lines against the maps, within 2 / 5 / 10 / 50 ms
                   One Step Closer 0/0/0/0 -> 0/0/0/0 of 1; Vampires 5/14/34/134 ->
                   5/14/29/144 of 236; Calm Down Juliet 0/0/1/2 -> 0/1/1/4 of 7;
                   Day to Story 0/0/1/2 -> 1/1/1/2 of 5
Corpus B, all 20 tracks (bench/corpus_b.py, analysed afresh before and after)
  within 2/5/10/50 ms   0.5 / 1.6 / 4.6 / 46.9 % -> 0.6 / 1.7 / 4.2 / 47.9 % of the 1,152 red
                        lines (6 / 18 / 53 / 540 -> 7 / 20 / 48 / 552); per track 0.1 / 0.9 / 5.4 /
                        68.4 -> 1.1 / 2.6 / 5.3 / 70.0 % (one more line on each of two maps of 7
                        and 5 lines)
  signed error          median +25.1 -> +23.4 ms; within 50 ms +27.4 -> +26.5; the tracks' own
                        medians +24.0 -> +24.0
  BPM per section       72 of 789 within 0.05, unchanged
  unchanged             the 15 tracks on the grid, red line for red line, and The Raven's refusal
  --onsets              after Overtone's grids, median -7.9 -> -4.9 ms over 19 tracks. The four
                        fallback songs read +54.3 -> +73.0, -28.0 -> -9.9, -15.9 -> -1.0 and
                        -5.0 -> +24.6, at contrast 1.0-1.3: a grid drawn from their few red lines
                        does not follow them, and nothing starts clearly on it. The reading on the
                        tracker's own beats (above) is the one that measures the beats
cost             _tracker_lag 80 ms on a 6-minute song's 1,114 beats (median of 7 runs, the
                 machine loaded; 7 ms on 140 beats)
Python unittest  581 -> 586, all pass (overtone-cli built in the worktree, none skipped) · facts ok
engine gates     benchmark 24/24 (0.0000 BPM / 0.16 ms), bpm-snapshot 24/24, golden 27/27,
                 coverage, measures, signatures, robustness, reference 24/24, assisted 70:
                 all pass, each one's output line for line the same as on the unchanged tree
                 (timings and temporary paths aside). The benchmark's ramp is the only input
                 among them the tracker times, and the line it prints does not move
fuzz_reader      3000 mutants, no crash, no hang
```

What the numbers say:

- **The beats now sit where the precision engine's attacks do.** On the fixtures that is the
  hit, to a fraction of a millisecond. On the real songs it is 4-10 ms after the first
  high-frequency edge, the full band's rise, as the precision engine's grids sit (-7.9 ms,
  10.0a).
- **The fallback's red lines barely move against the maps**: within 5 ms 14 -> 16 of those
  four songs' 249 lines, within 10 ms 36 -> 31, within 50 ms 138 -> 150. What separates
  them is the tracker's tempo, not its lag: Vampires gets 22 red lines for the map's 236, and
  a red line run over the beats between them drifts. The maps' own convention adds 7-23 ms.
  Within 10 ms loses 5 lines on Vampires. Errors there spread over a wide band (IQR -15.9 to
  +54.3 ms), so moving every line 16 ms moves some in and some out of the bar.

### Rejected / tried and dropped

- **Each beat on its own re-timed attack.** The roadmap's candidate, as `_retime_onsets` on
  each beat, or snapped to the nearest of the precision engine's attacks within 40 ms before
  and 10 ms after.
  - Tighter on the clean fixtures: interquartile widths of 0.3-0.6 ms, against 0.8-2.0 ms
    for one shift.
  - But it scattered the real songs' beats. Against the maps' beats the interquartile width
    went 5.1 -> 8.6 ms (One Step Closer), 9.6 -> 16.3 (Calm Down Juliet) and 5.8 -> 13.7 (Day
    to Story); 19.7, 17.3 and 16.0 with the nearest attack. Vampires 13.6 -> 12.8.
  - The sound's start on their average smeared: contrast 3.0 -> 2.4 and 2.8 -> 1.7 (sharper
    on Vampires, 3.7 -> 4.8).
  - Under the loud pad render, 72 % of the beats landed within 5 ms, against 100 % for one
    shift.
  - A fallback red line sits on a single beat, so its scatter goes straight into the offset.
- **Reading the tempo on the re-timed beats as well.** It split the songs differently.
  Vampires went from 22 red lines to 14-17, within 50 ms of the map 134 -> 104-126. On
  Corpus A the benchmark went 0 -> 3-4 of 24, with fixtures worse as well as better
  (odd-222.22 0.075 -> 0.249 BPM, decimal-128.37 0.237 -> 0.010). The tracker's BPM is a median
  of beat gaps and not this row's subject; kept as it was.
- **A running median of the shifts** (±8 or ±32 beats), and each beat's own shift kept
  where it agrees with that median within 1-2 ms. Never tighter than one median for the
  song: widths 6.4 and 5.5 against 5.3 (One Step Closer), 10.8 and 8.5 against 6.6 (Calm Down
  Juliet), 7.2 and 6.4 against 5.7 (Day to Story).
- **One constant for every song.** The lag runs from 7.3 to 17 ms over these tracks, by the
  sound (clean drums, noise, a bed, a mix): any one number is 5 ms or more off somewhere.

Left open:

- Found here, not fixed: rebuilding a fallback result at its own pulse is not the identity
  when the tracker doubled its own pulse. The analysis holds no inserted beat without a peak
  (`hold_without_peak` only when the user asked); the rebuild holds them for any factor above
  1. It is the same on the old code: 11 of the 32 fallback analyses here differ, and Calm
  Down Juliet goes from 3 red lines to 10.
- The 4-10 ms left on the real songs belong with the precision engine's own (10.0a), not to
  the fallback.

## v4.0.0-dev — 2026-09-26 · One suggested red line, added with consent

### Changed

- **Add, beside each suggestion** in Map check: one suggested red line goes into the map on
  its own, after a confirmation that names it (time, BPM, beats a bar), the green line that
  keeps slider velocity when one is needed, how many objects follow the new beat until the
  next red line, and how far the ends of the sliders among them move. The file is backed
  up first (`.bak`, never overwritten), the write is logged in History as a suggested red
  line, and the list is read again after, so the answered suggestion leaves it. Inject
  still writes every line; Add writes one.
- **The new line carries what the map plays there**: the sample set, index, volume and kiai
  of the timing point in force, and it goes before any green at its own time, the order
  osu! reads. Its bar is the one the detector proved there, else the map's own there, not
  an assumed 4.
- **A suggestion at ×2 or ×4 the map's own tempo says so** in the confirmation (÷2 and ÷4
  too): on Corpus B every slider-end shift past 25 ms came from one of these, the same
  pulse counted differently rather than a change the map lacks.
- `add_red_line(beatmap, offset_ms, bpm, meter, decimals)` in the engine, with the map's
  tempo in force in its summary; `suggest_preview` and `suggest_apply` in the bridge;
  suggestions carry the proven `meter`.

### Hardening

- **Nothing the page did not show is written.** Apply reads the map and the list again and
  takes only the suggestion at the index and time the page showed (within 0.5 ms): a
  changed map, a new analysis, a second click after the write, or an index that is not a
  whole number is refused as `suggestion_gone`, the file untouched.
- **Every other line keeps its bytes and its place**: the BOM, CRLF, a bare LF line, the
  blank lines closing the section, as the tests hold on a mixed-ending map.
- `bench/fuzz_reader.py` runs the insertion over its 3000 mutant maps: no crash, no hang.

### Measured

```
Corpus B: the 20 ranked maps read from the Songs folder (never written), with the Corpus B
analyses of the fallback re-timing branch (engine 3780f3d43ba0d38f); every suggestion
applied alone, in memory:
  suggestions                      23, on 5 maps (15 maps have none)
  every original line kept         23 of 23, byte for byte and in order, plus the red
                                   line and the greens reported and nothing else
  a green needed for velocity      15 of 23
  objects under the new lines      1,677; 545 sliders, of which 400 end elsewhere
  furthest slider-end shift        median 4.7 ms over the 18 suggestions with sliders
                                   under them; 159 to 559 ms on the five at ×2 or ×4
                                   the map's tempo, the only five past 25 ms
Engine commit (add_red_line): unit tests 612 OK; benchmark 24/24, bpm-snapshot 24/24,
golden 27/27, reference 24/24, assisted 70 sections, coverage, measures, signatures,
robustness; fuzz_reader 3000 mutants, 2838 read, no crash
Python unittest   604 -> 616, all pass
The page, through the UI harness at 1280 px on a scratch copy of a test song: the
confirmation's lines (a green, 3 objects, 2 slider ends, the furthest 23.8 ms earlier)
as worked out by hand; cancel writes nothing; Add writes exactly the red line and its
green (diffed against the .bak); History names the write; the ×2 warning on a
half-tempo map, in English and Spanish; no page errors
```

### Rejected / tried and dropped

- **Applying a suggestion through inject**: inject rewrites every red line from the
  analysis, so the lines a mapper timed by hand would change along with the one they
  agreed to.

## v4.0.0-dev — 2026-09-26 · The hitsound profile, chosen on the Propose card

### Changed

- **A Profile selector on its own line above Propose** in the Hitsounds section's Propose
  card: Balanced first, then every profile `profiles/` holds (Drum-focused today), named in
  English and Spanish, with a line under it saying what the chosen one does. Beside Propose
  it pushed the buttons past a 1280 px window and left Undo alone on a second line. The
  status names the profile that decided the proposals shown, and when another is chosen
  afterwards the card says so until Propose runs again. With Balanced alone there is
  nothing to choose: no selector, no note, no name in the status, the card as it was.
- **The bridge lists the profiles**: `hitsound_profiles` gives `balanced` first, then every
  `profiles/<name>.json` whose name is lowercase letters, digits, `-` and `_`, and
  `hitsound_decide_propose(file, profile)` decides with the one named. Balanced stays the
  baked one, with no file handed over, as before profiles. `overtone_rust.hitsound` passes
  `--profile` to the sidecar.

### Hardening

- **A profile is a listed name, never a path.** A name the folder does not list, a path
  (relative, absolute, or the folder's own file), a name with its extension, another case,
  an empty string or anything not a string is refused as `bad_profile` before the sidecar
  runs.
- **The page's two languages are held together by a test**: the English and Spanish tables
  must hold the same keys with the same placeholders (795 each). Nothing checked that
  before; they already matched.

### Measured

```
Python unittest   600 -> 604, all pass (with the CLI built)
facts
the page, through the UI harness at 1280 px on a scratch song: both profiles listed, the
selector held while proposing, the reply's profile named in the status (Balanced, then
Drum-focused), the reminder while the choice differs from what decided the proposals,
the row hidden with Balanced alone, the buttons on one line in English and Spanish,
no page errors. Not checked: narrower windows.
```

## v4.0.0-dev — 2026-09-26 · Hitsound profiles held to their own style: Drum-focused ships, Minimal does not

### Changed

- **`profiles/drum_focused.json`**, the second profile (`06` §11: kick, snare and hats drive
  everything, vocals ignored), as data only. The drum classes choose the sound in
  Balanced's banks (snare and clap 1.2, cymbal 1.2, hats plain); bass, guitar, keys,
  vocals and anything unnamed only vote for the plain sound in the object's own set (0.7);
  every class but the cymbal leans a little (0.2) to a finish, which the context term turns
  into a finish where the map opens a combo, because drum mappers put 64 % of their
  finishes on new-combo sounds (below); and it decides object by object: switch cost 0.05
  and streams 0.1, where Balanced has 0.5 and 1.4. `overtone-cli hitsound --profile
  profiles/drum_focused.json` reads it; choosing it in the app is the next entry.
- **`bench/eval_proposals.py` holds a profile to maps of its own style.** `--profile`
  decides with a profile file; `--style minimal|drum` keeps the songs whose mapper
  hitsounds in that style, by a rule read from the mapper's own sounds before anything is
  proposed (`in_style`); `--bare` proposes on a copy of each map with every hitsound
  stripped and still scores against the mapper's sounds, since the prior speaks only
  where the mapper left a sound. Every run also reports the proposals' character beside
  the mapper's: additions per object and their share on a beat. Without the new options
  it selects and scores as before.
- **The style rule**, set before any proposal from 4,543 local songs in 4/4 (the mappers'
  own sounds; each threshold is where it falls in that spread): *minimal* is 0.1-0.4
  additions per object (under 0.1 a map is not hitsounded yet; 0.4 closes the sparsest
  4 % of the rest), at least 80 % of them on a beat (p75 0.76), and 20 claps or 10
  finishes, so one of them can be scored; *drum-focused* is more than 0.4 per object (never
  both), 20 claps with 75 % on beats 2 and 4 (p75 0.73), 10 finishes with 70 % on the
  downbeat (p75 0.72), and whistles at most 40 % of the additions (p25 0.40). Each mapset
  is judged by its first map that is not a hitsound difficulty, and a mapper gives one song
  at most: listing the samples first showed compilation sets and one mapper filling a
  third of a sample, and both amendments were made before anything was proposed. A
  style's first 11 songs tune, the next 11 confirm.

### Fixed

- **One slow song ended a whole evaluation.** A CLI run past the timeout raised
  `TimeoutExpired`, which the per-song loop does not catch, so the run stopped there (a
  drum confirm run did, after 6 maps). It is now one failed song like any other, and the
  timeout is 1,800 s rather than 300: under other sessions' load one song's evidence took
  546 s. The stopped run was run again whole.

### Hardening

- Bare copies are written to a temporary folder, never beside the song. On the 44 style
  maps the originals were byte-identical before and after (sha256), and every copy had the
  same objects, every other section unchanged and no sound left but the plain one.

### Measured

```
style rule, from 4,543 local songs in 4/4 (one map per audio file, the mappers' sounds)
  additions per object p10 0.08 · p25 0.67 · median 1.04; share on a beat p75 0.76, p90 0.87
  claps on beats 2 and 4 p75 0.73 (20+ claps); finishes on the downbeat p75 0.72 (10+)
  whistles of all additions p25 0.40
samples: a fresh scan of the Songs folder into a scratch index (ids in folder order), one
  song per mapper, 11 to tune and the next 11 to confirm per style; 0 errors in any run

F1: median over maps with 20+ claps / 10+ finishes of the mapper's own; character: medians
                  clap F1      finish F1    additions/object  on a beat
                  mapped bare  mapped bare  mapped bare       mapped bare
minimal maps, tune (replica, below)             mappers 0.33       mappers 0.89
  balanced        0.34   0.26  0.60   0.08  1.04   1.06       0.49   0.49
  minimal         0.53   0.24  0.88   0.13  0.54   0.35       0.77   0.75
minimal maps, confirm (bench/eval_proposals.py)  mappers 0.37      mappers 0.85
  balanced        0.43   0.20  0.64   0.07  0.98   1.06       0.61   0.54
  minimal         0.72   0.18  0.82   0.12  0.42   0.38       0.83   0.77
drum-led maps, tune (replica)                   mappers 0.80       mappers 0.87
  balanced        0.57   0.35  0.75   0.09  1.16   1.14       0.63   0.60
  drum-focused    0.63   0.34  0.77   0.09  0.96   0.80       0.83   0.81
drum-led maps, confirm (bench/eval_proposals.py) mappers 0.63      mappers 0.90
  balanced        0.54   0.33  0.69   0.08  1.09   1.09       0.63   0.60
  drum-focused    0.69   0.36  0.80   0.13  0.82   0.67       0.76   0.74
general maps, the default selection's first 11 songs (10: one mp3 the CLI cannot
decode); replica                                mappers 1.17       mappers 0.67
  balanced        0.69   0.29  0.71   0.08  1.13   1.09       0.65   0.60
  minimal         0.82   0.31  0.84   0.13  0.99   0.51       0.71   0.74
  drum-focused    0.79   0.33  0.77   0.13  1.04   0.81       0.71   0.73
Python unittest   528 -> 534, all pass, with the CLI built (the shipped profiles load in
                  its strict loader)
facts
```

**The gate**, written down before anything was proposed: a profile ships only if, on its
style's confirm sample, its clap and finish medians are both at least Balanced's with the
maps as mapped, one of them higher, and neither is lower on the same maps stripped bare.
Drum-focused clears every clause. Minimal clears the mapped ones by the widest margin
here and the bare finish, but its bare clap is 0.18 against 0.20: not shipped (Rejected,
below). The confirm numbers come from `bench/eval_proposals.py` and the real CLI (88 runs).
The tune and general numbers come from a replica of the CLI's decide stage fed by one
`hitsound-evidence` run per song (a scratch port of `map.rs`, the units, emission and
Viterbi, not committed), equal to the CLI on 11 runs covering both shipped files and
Minimal's, mapped and bare: 6,425 of 6,425 proposals, probabilities within 2.2e-13.

**What moves a profile.** Balanced's switch cost makes an addition standing alone pay
twice, into it and out of it, so its path stays inside additions: about one per object on
minimal maps whose mappers use a third of that, with half of them on a beat against the
mappers' nine in ten. Deciding object by object is what lifts both profiles with the
mappers' sounds in place, far more than their weights: on drum-led tune maps, Minimal's
weights score clap 0.67 and finish 0.82 as mapped, above Drum-focused's 0.63 and 0.77.
The styles differ in how much they propose and where, and on bare maps.

**Why bare maps are near chance for every profile.** The role term reads the audio's own
bar, not the map's red lines. On the 22 tune songs it gives no role at all on 5 (no grid
to sit on), and elsewhere the metrical weight it gives equals the one the map's own lines give
at a median of 12 % (minimal) and 28 % (drum) of the map's beats: it finds the beats,
rarely which one opens the bar. Bare, a proposed clap is right about as often as a clap is
there at all (precision 0.15 against a clap rate of 0.13 on minimal maps, 0.30-0.34
against 0.26 on drum-led ones), so clap F1 follows how many claps a profile proposes, and
the one proposing most scores best: on the bare minimal tune maps Balanced proposes 7,337
claps for the mappers' 1,846. Finishes are the part the map does tell: 70 % (minimal) and 64 %
(drum) of the mappers' finishes are on new-combo sounds, and 23-28 % of new combos carry
one against 1-2 % of other sounds; claps are not (9-10 % of new combos).

### Rejected / tried and dropped

- **Minimal** (`06` §11: drums only on strong beats), not shipped. On its own confirm maps
  as mapped it beats Balanced by the widest margin measured (clap F1 0.72 against 0.43,
  finish 0.82 against 0.64) at its mappers' own density (0.42 additions per object against
  their 0.37 and Balanced's 0.98), and bare its finishes still win (0.12 against 0.07); its
  bare claps are 0.18 against 0.20, and the gate asked for not lower. The bare clap is
  chance for every profile here, and a sparse profile proposes fewer claps at the same
  precision, so this is the clause a Minimal cannot clear until the role reads the map's
  own grid. The profile tried, to rebuild it: every class votes for the plain sound in
  the object's own set (`inherit`, 0.9) but snare and clap (clap, 1.0) and cymbal (finish,
  1.0); role 1.0, context 0.3, prior 1.2; switch cost 0.05, streams 0.1, phrase symmetry
  0.9, finish spacing 2.0.
- Tuned through the replica on the tune samples only: 22 Minimal and 13 Drum-focused
  variants. None cleared the bare clause on tune; each profile was chosen as the one with
  the mapped clauses cleared and the smallest bare shortfall, the style's own character
  breaking the tie. What did not help:
  - **Style weights on Balanced's transitions.** Drum weights at switch cost 0.5 scored
    below Balanced on drum-led maps (clap F1 0.52-0.54 against 0.57, finish 0.40-0.71
    against 0.75): the path stays inside additions either way, and the weights only moved
    which ones. A Minimal at switch cost 0.8 dropped the mappers' own isolated claps and
    finishes (F1 0.33 and 0.37 as mapped, against 0.53 and 0.88 deciding per object) and
    proposed almost nothing bare (0.03 additions per object).
  - **More clap evidence for Minimal** (snare and clap at 1.5-2.0): no gain bare (clap F1
    0.22-0.23 against 0.24), a loss as mapped (0.42-0.47 against 0.53). The templates read
    snare or clap at a median 0.138 at mappers' claps; weighting a weak reading harder adds
    claps where there are none.
  - **Minimal leaning to finishes on new combos** (the 0.2 finish vote and context 0.6 that
    Drum-focused has): bare finish F1 0.17 against 0.13, but 0.81 against 0.88 as mapped
    and more additions bare (0.42 per object against 0.35).
  - **A weaker role term for Minimal** (0.5): better as mapped (clap 0.54, finish 0.94),
    worse bare (clap 0.21 against Balanced's 0.26, finish 0.075 against 0.083), and the
    bare clauses were the ones at risk.

## v4.0.0-dev — 2026-09-26 · A red line's bar length, set by hand

The engine reads a section's meter where it can and guesses 4/4 where it cannot, and a
bar-length change at the same BPM (4/4 to 3/4) it does not find at all: the measures gate
names that case open. Nothing in the app let the mapper say what the bar is. Roadmap,
Phase 5: "Bar-length change", its by-hand half.

### Changed

- **Beats per bar** in the point editor: 1 to 16, `set_meter` in the engine. The line
  keeps its BPM and its offset where it is shown, and its meter is known from then on (the
  mapper said so). The click's accents, the map's bar lines and the red line's "· 3/4"
  chip follow it. One undo step; a locked line refuses, as with any edit.
- 1 engine test, 1 bridge test.

### Measured

```
synthetic "Secs" track through the harness page, line 2 (152 BPM, 24.3 to 46.0 s)
  4/4 (a guess) -> 3/4 by hand   bar accents in the section 14 -> 19; offset 24310.1 ms
                                 and 152.000 BPM unchanged; "Point #2: 3/4, the beat
                                 unchanged"; undo: 4/4, 14
  Spanish                        "Pulsos por compás"; the row fits the panel
Python unittest      592 -> 594, all pass · facts ok
engine gates         benchmark 24/24, bpm-snapshot 24/24, golden 27/27, reference 24/24,
                     coverage, measures, signatures, robustness, assisted: all pass (no
                     analysis sets a meter this way, so none could move)
```

## v4.0.0-dev — 2026-09-26 · Each section's confidence along the tempo map

How sure the engine was of each red line showed only as a bar in the points list, so a
weak section had to be looked up line by line. Roadmap, Phase 3: "Confidence ribbon".

### Changed

- A 4 px strip along the tempo plot's foot, each section in the colour of its line's
  confidence bar in the list: 90 % and up, 75 % and up, below. The colours are chart tokens
  pointing at the theme's own accent, blue and amber, so both themes follow; a pixel
  separates two sections of the same colour. The legend names it, and the hover over the
  map adds the governing line's confidence. No Python changed.

### Measured

```
synthetic "Secs" track through the harness page, three lines (confidence set to 100, 80
and 50 % in the page for the other two levels), a pixel read at each section's middle
  dark    rgb(63,208,220) / rgb(169,150,255) / rgb(245,180,74)  = #3fd0dc #a996ff #f5b44a
  light   rgb(10,115,127) / rgb(91,69,214) / rgb(143,94,8)      = #0a737f #5b45d6 #8f5e08
  hover   "confidence 100%" under the red line's BPM
web shell tests      189, all pass (the page's bracket and string checks included)
```

## v4.0.0-dev — 2026-09-26 · Each song's timing work kept between sessions

Everything lived in memory. Closing the app lost every red line the user had moved, and
opening the song again brought back the analysis from the result cache, as if nothing had
been done; only an export or an inject kept the work. Roadmap, Phase 14: "Project format".

### Changed

- **A project file per song**: `<output folder>/Projects/<song> [<first 8 of the audio's
  SHA-256>].oto`, JSON: the red lines with their confidence, meter and hand-placed flag,
  and the locks, with the audio's name, path and hash. Written atomically after every
  edit, undo, redo and lock; never after an analysis, so a fresh one cannot overwrite the
  work it is about to be offered.
- **Offered back after an analysis**: when the song's project is not what the analysis
  gave, the Timing view says when the work was done and how many lines (and locks) it
  holds: Restore my work, or Keep the analysis. Restoring is one undo step.
- A project whose format, audio hash or points do not hold (a damaged file, another
  song's, a BPM that is not positive) is not offered.
- **Off unless the window asks** (`Api(save_projects=True)`): every test and every
  earlier check built the bridge with the user's real Documents under it.

### Hardening

- The UI check's harness points USERPROFILE at its temp folder too, not LOCALAPPDATA
  alone: exports and projects default to Documents\Overtone under it, and a check must not
  write there.

### Measured

```
through the harness page, synthetic "Secs" track
  first analysis                    no project, no offer
  +5 ms on line 2                   project written (3 lines); on screen = saved
  analysed again (from the cache)   the offer: "You worked on this song's timing on …:
                                    3 red lines. This analysis does not have that work."
  Restore my work                   24315.1 ms back, "Your work is back: 3 red lines. Undo
                                    returns to the analysis."; undo: 24310.1
  a lock, analysed again, Spanish   "(1 con candado)"; Keep the analysis hides the offer
  where it wrote                    the harness's temp Documents; the real one untouched
Python unittest      587 -> 592 on master, all pass · facts ok · engine untouched, gates not re-run
```

Not measured: a project written by the installed app across a real restart; the harness
builds a new bridge per start, so the "next session" above is a second analysis of the song.

## v4.0.0-dev — 2026-09-26 · Structure edges where the song repeats itself

88 % of ranked maps' kiai starts had no structure edge within 2 bars. Measured first: the
checkerboard novelty the edges came from sits no closer to a kiai start than chance, so no
threshold on it could find them. Edges where the song starts or stops repeating something
(structure features, over the same half-second windows) find 58-63 % of kiai starts, and 40 %
of them sit near a kiai change against 15-16 % today. The finder was chosen on sample A and
confirmed on sample B, read once, against a bar written down before it was read.

### Changed

- **`overtone-cli structure` takes its section edges from repetition**
  (`structure::phrases`). Each half-second window's fingerprint is its chroma and level over
  1.5 s. Two windows recur when each is among the other's nearest 4 %. Laid out by lag (row:
  window, column: how far ahead it recurs) and smoothed over 4 s, a row changes where the song
  starts or stops repeating something. An edge is a peak of that change 0.1 of its maximum
  over its 14 s moving median, merged at 4 s. None falls in the 4 s at either end, as before.
  The JSON keeps its shape; `rules` names the new constants beside the old ones.
- **The hitsound engine keeps the checkerboard edges** (`structure::analyze`, unchanged). Its
  phrase breaks (where a change of sound is allowed) and the phrase positions it reports
  were measured with them; moving it to the new edges is its own measurement.
- `overtone-bench structure <case>` runs the edges the command prints.
- 7 Rust tests: the edges of an intro and A B C A C B of changing chords, the same with a
  louder return, the checkerboard's held-chord A B A B, one chord that only changes level
  (one edge, recorded as measured), no edge in the end spans, the blocked lag matrix against
  the whole one, and the moving median. The silence and short-audio tests cover the new
  finder too. The CLI's structure test now plays the intro and A B C A C B, with the labels
  it gets.

### Measured

The truth, the pairing and the samples are the phrase level rule's (entry below): kiai starts
of 4+ bar spans on ranked maps, paired one to one with an edge within 2 bars; A (500 songs)
to choose, B (500) held out. Precision counts the edges within 2 bars of any start or end of
a 4+ bar kiai span. An edge far from both is not proven false, since a verse start has no
kiai. So each number stands beside its chance: the same song's edges shifted at random, 50
times, over the span an edge may sit in.

Where today's missed kiai starts sit (A, 1045 of 1189 missed):

```
a novelty peak within 2 bars, under the 0.30 x max threshold   1010  (96.7 %)
   its height over the song's maximum   0.20-0.30: 86   0.15-0.20: 84   0.10-0.15: 130
                                        0.05-0.10: 228  under 0.05: 482
   its rank among the song's local maxima: median 25th (quartiles 14-43),
   where a song has a median 53
no novelty peak within 2 bars                                     16   (1.5 %)
over the threshold, merged into a stronger peak 2+ bars away      14   (1.3 %)
within 8 s of an end                                               5   (0.5 %)
restarts (kiai off for under 2 bars before)                      307 of the 1045
```

There is no cap on the edge count in the code; the threshold is the only limit. The curve
itself carries nothing about kiai starts. Its highest value within a bar of a start sits at
the 49.7th percentile of the same statistic across the song (0.5 = no information). The
other curves, on A:

```
                              kiai starts   kiai ends
novelty, 4 s kernel (today)       0.497        0.537
novelty, 8 / 12 s kernel          0.509 / 0.524
level rise over 2 s               0.668        0.366
level step either way, 2 s        0.609        0.599
timbre (log-mel), 4 s kernel      0.526        0.576
repetition (structure features)   0.629        0.630
```

Tried on A, read at the same number of edges (6 per song), with the finder's first version
(ends zeroed, lags smoothed 0.5 s):

```
                                 recall  precision   chance recall / precision
novelty, 4 s kernel              16.5 %   17.6 %      20.6 / 17.8 %
novelty, 8 s kernel              25.7 %   21.9 %      23.5 / 17.8 %
level step either way, 2 s       30.6 %   25.2 %      22.2 / 18.1 %
repetition, 3 s fingerprint      48.1 %   35.1 %      21.8 / 17.3 %
repetition, 1.5 s fingerprint    50.0 %   37.6 %      22.0 / 17.5 %
repetition + level step, mixed   43.8 %   34.1 %      21.2 / 17.6 %
```

The finder that shipped, today's edges against it, from the two builds' own reports:

```
                                 A (tuning)                  B (held out, read once)
                                 today       repetition      today       repetition
kiai starts, edge within 2 bars  12.1 %      63.3 %          11.6 %      58.0 %
  (chance)                       16.5 %      24.3 %          16.7 %      23.3 %
  after 2+ bars without kiai     13.2 %      66.8 %          13.4 %      63.7 %
  found by one only              41          650             49          630
  sign test                      p 5e-142                    p 1.4e-129
edges near a kiai change         16.3 %      41.5 %          14.6 %      39.8 %
  (chance)                       17.6 %      17.0 %          17.2 %      16.5 %
  far from any                   1913        1831            2141        1977
edges per song, median           3 (1-6)     6 (4-9)         3 (1-7)     6 (4-9)
  most in one song               39          22              35          16
new edges with none of today's within 2 bars
                                             2570, 42.2 %                2657, 41.4 %
                                             near a change               near a change
today's edges with no new one within 2 bars
                                 1673, 9.9 % near a change   1837, 9.0 % near a change
the Kiai card (chorus sections against the map's kiai)
  chorus time under kiai         31.1 %      32.9 %          28.6 %      33.0 %
  kiai starts with a chorus
    start within 2 bars          3.8 %       9.1 %           4.3 %       10.9 %
  songs with a chorus            89          72              99          87
  kiai time under a chorus       20.8 %      16.8 %          22.3 %      20.6 %
the level rule on the pairs, kiai's own bar
  nearest bar / level rule       42.4 / 64.6 % 53.9 / 60.4 % 45.5 / 55.9 % 57.4 / 60.6 %
of all kiai starts, an edge on the kiai's own bar (level rule)
                                 7.8 %       38.3 %          6.5 %       35.1 %
```

- **The bar, written down before B was read:** recall at least 10 points over today with the
  sign test under 0.01; precision no lower than today's and at least 1.5 times its own
  chance; the added edges near a kiai change at least as often as today's edges are; and the
  Kiai card no less precise (chorus time under kiai, and kiai starts with a chorus start).
  B cleared all four: +46.4 points, 39.8 % against 14.6 % (1.5 x chance is 24.8 %), 41.4 %
  added against 14.6 %, and 33.0 % / 10.9 % against 28.6 % / 4.3 %.
- **The Kiai card lights fewer songs**: 87 against 99 on B, and less of the kiai (20.6 against
  22.3 %). A chorus needs two repeated families, and the classifier groups sections by their
  mean chroma, which a full mix makes alike. In the median song, one family holds every
  section, with either finder. With the repetition edges (7 sections a song against 4), the
  songs with one repeated family go from 312 to 408 of B's 500, and those with two or more
  from 100 to 88 (A: 313 -> 420, 90 -> 76). That is the labels' limit more than the edges'. It is
  left as a decision (roadmap: Section labels from repetition).
- **Rust against the numpy model the finder was chosen with**: the same edges on all 499 songs
  of A that decode.
- **Time and memory** of `overtone-cli structure`, old and new, two runs each: a 140 s song
  0.44-0.51 against 0.53 s for the structure stage, 44-45 against 42 MB at peak; a 502 s song
  1.61-1.62 against 1.62-1.69 s, 156-157 against 154-156 MB; the 6-minute fixture 1.43-1.47
  against 1.33-1.37 s, 80-81 against 78 MB. A 54-minute input (that fixture 9 times, every
  window recurring 8 times) took 10.8 against 11.3 s, 657 MB at peak both. The lag matrix is
  built 64 lags at a time, never whole.
- Rust tests 263 -> 270, all pass. The bench gates all pass: golden 27/27 attack for attack,
  nogrid, density 4/4 with no false positive, elastic (worst 4.865 %, as recorded), map.
  The Python gates all pass: 546 tests, benchmark 24/24 (median 0.0000 BPM, 0.16 ms),
  bpm-snapshot 24/24, golden 27/27, coverage, measures, signatures, robustness, reference
  24/24, assisted (70 marked sections), facts, and 3000 fuzzed .osu files.

### Rejected / tried and dropped

- **Thresholds on the novelty curve.** Lower fractions of the song's maximum (0.25-0.10),
  median + 2-6 MAD, and the top 1.5-4.5 peaks per minute all raise recall only as fast as
  chance does (0.10 x max: 35.7 % against 38.1 % by chance), at 13-17.5 % precision. The
  curve has nothing to threshold.
- **Wider checkerboards** (8-12 s): 19-20 % precision against 17-18 % by chance.
- **Level steps**, rises or either way, 2-8 s either side, the low band alone. A rise over
  2 s is the best single sign of a kiai start (0.668), but at 2-3 dB it reads 19-31 % recall
  at 22-23 % precision. Mixed into the repetition curve, it lowered both.
- **Timbre in the fingerprint** (log-mel alone, or beside the chroma): 47 and 71 % recall
  at 26 and 29 % precision, against 78 and 31 % for the chroma at the same threshold (on
  the first 214 songs of A).
- **Adding the repetition edges to today's** instead of replacing them: recall 66.0 against
  63.9 %, precision 28.9 against 36.8 % (A, first finder). Today's edges sit at chance, and
  those the new finder drops are near a kiai change 9-10 % of the time.
- **Smoothing along lag** as well as time (0.25-1 s): F1 of recall and precision 43.6-46.6
  against 46.7 without it.
- **The curve zeroed over the blind spans at either end.** The first window past them became
  a peak whenever the curve fell from there: 299 of 3738 edges on A, 3 near a kiai change.
  Kept whole and cut after peak picking: precision 36.8 -> 41.5 %, recall 63.9 -> 63.3 %.
- **The first windows' rows held at the first full fingerprint's**, since their fingerprints
  are padding: F1 49.7 against 50.2.
- **The parameters around the one chosen**: fingerprints of 1-2 s, smoothing 3-5 s, nearest
  4-6 %, thresholds 0.04-0.2 over the median. The best F1 on A was 50.5 (5 s smoothing,
  0.07); 50.2 at 4 s and 0.1 was within half a point, and the rule set beforehand kept the
  defaults then.
- **The Kiai card guard as first written** (kiai time under a chorus and the time F1 no
  lower than today's). The zeroed finder cleared it on A only through its 4 s first
  sections: tiny quiet first and last sections let the classifier split a song into a quiet
  and a loud family, and call most of it chorus (F1 32.1 against 24.9). It was replaced by
  the card's precision before B was read, and the coverage is reported instead.

## v4.0.0-dev — 2026-09-26 · Phrase starts on the phrase's bar: the level rule, confirmed

The Structure view snapped each phrase edge to the nearest proven bar. A rule that takes the
bar where the level changes was measured against ranked maps' kiai starts on two samples of
500 songs. It fell short on the held-out one: p 0.024, against a bar of 0.01 set before that
sample was read. The rule was then frozen and run once on the 673 eligible songs neither
sample used, against the same bar. It cleared it there, so it ships.

### Changed

- **Each phrase edge moves to the proven bar where the level changes most.** That is the
  nearest proven bar or the proven bar either side of it. For each, the view compares the
  bar after the line with the bar before it on the report's energy lane. The sections' levels
  give the direction: the largest rise wins when the section after the edge is louder, the
  largest fall otherwise. A neighbour takes the edge from the nearest bar only by 0.5 dB more
  (`STRUCTURE_PHRASE_MARGIN_DB`). The rest is as before: an edge with no proven bar within
  1.5 s stays on the 0.5 s grid, and a bar the accents did not prove is never taken.
- Each section says which rule placed it (`snap`: `nearest` or `level`) and the change at its
  bar (`change_db`), and the view carries the margin (`phrase_margin_db`). The Structure
  page's note says what the rule does (its own commit).
- 3 tests: an edge takes the bar where the level changes, the sections' levels choose rise
  or fall, and the nearest bar stays when the change is under the margin or the louder bar
  is not proven.

### Measured

The truth is the kiai starts of ranked maps from the local Songs folder, read only. Each song
contributes one standard difficulty, the one with the most objects. A map qualifies with a
single red line (60-300 BPM, 3/4 or 4/4) and a kiai of 4 bars or more that starts 6 s or
more from either end. Its red line counts as a proven bar, as reference timing loads it.

A kiai start's bar is the bar line it sits on, or the next one when it starts on a pickup up
to one beat before it. Of kiai starts on spans that long, 87.6 % sit on the downbeat and 6 %
on such a pickup; the other mid-bar starts are left out.

There were 1673 eligible songs, one per artist and title. A fixed seed shuffled them. Two
disjoint samples of 500 came first: A chose the rule, and B was held out and read once. C,
the other 673, was read once after the rule was frozen. No audio file is shared between
samples. Some titles recur as another cut or another song of that name: 36 of B's 481 in A,
and 81 of C's 638 in A or B. `overtone-cli structure` ran on every song; one MP3 of A did not
decode. The chance of the exact bar is 20 %: one of the five bars in the ±2-bar window an edge
is paired within.

```
                              A (tuning)       B (held out)     C (confirmation)
songs with a kiai start       484              492              664
kiai starts                   1189 (84 mid-    1252 (78 mid-    1677 (101 mid-
                              bar left out)    bar left out)    bar left out)
  with an edge within 2 bars  144 (12.1 %)     145 (11.6 %)     203 (12.1 %)
  within 4 bars               16.3 %           16.5 %           16.7 %
inner edges per song          median 3         median 3         median 3

today (nearest proven bar), on those pairs
  on the kiai's bar           42.4 %           45.5 %           35.5 %
  one bar early / late        26.4 / 16.0 %    21.4 / 17.9 %    30.0 / 16.7 %
  two or more early / late    11.8 / 3.5 %     15.2 / 0.0 %     11.8 / 5.9 %
the level rule
  on the kiai's bar           64.6 %           55.9 %           48.8 %
  one bar early / late        15.3 / 3.5 %     26.2 / 5.5 %     24.6 / 5.4 %
  two or more early / late    12.5 / 4.2 %     11.0 / 1.4 %     13.8 / 7.4 %
  against today               +40 fixed,       +27 fixed,       +46 fixed,
                              -8 broken        -12 broken       -19 broken
  sign test                   p < 0.0001       p 0.024          p 0.0011
  gain, 95 % interval         +22.2 points     +10.3 points     +13.3 points
                              (13.5 to 30.9)   (2.1 to 18.6)    (5.7 to 20.9)
kiai ends (the next section's first bar, mostly falls), a guard
  today / level rule          41.8 / 45.9 %    41.5 / 44.7 %    49.7 / 51.8 %
every snapped edge of those songs, not only the paired ones
  moved off the nearest bar   48.5 %           47.3 %           47.9 %
                              (1095 of 2257)   (1162 of 2457)   (1564 of 3265)
median move from the novelty peak
  today / level rule          253 / 717 ms     232 / 637 ms     242 / 653 ms
edges on a 4-bar line from the red line (25 % by chance)
  today / level rule          30.5 / 30.1 %    29.6 / 30.2 %    29.9 / 33.0 %
```

The bar for C was written down before C was read: the kiai's own bar at least 10 points
over today on the same pairs, a two-sided sign test on the pairs the rules split under 0.01,
and kiai ends no worse. C read +13.3 points, p 0.0011, and kiai ends 49.7 -> 51.8 %.
Before C was read, the patched view and the rule measured on A and B were checked to place
every snapped edge alike on all three samples. Today's rule read on C also matched the view
before the patch. The view also reproduced A's and B's numbers above to the pair.

The larger limit is not the snap. About 88 % of kiai starts have no edge within 2 bars, so a
structure stage that finds more edges would place more kiai than any snap rule can.

### Rejected / tried and dropped

- **Shipping on B alone.** On B the rule gained 10.3 points (95 % interval about 2-19),
  +27/-12, sign test p 0.024. The size cleared the bar; the p-value did not. The gain halved
  from A to B, as a margin fitted to A would lead one to expect. Simulated from B's result,
  a fresh sample of 673 would clear the bar about half the time. So the rule was frozen,
  with no retuning, and confirmed on C instead.
- **Level variants read on B after that decision**, for the record only. Every one-bar
  level variant beat today on B's kiai starts (51.0-58.6 % against 45.5 %). Two would have
  cleared the bar there: reach 2 bars at 1 dB (57.9 %, +27/-9, p 0.004) and at 2 dB (56.6 %,
  +20/-4, p 0.002), with kiai ends at 46.5 and 48.4 %. Neither was best on A (61.8 and
  59.7 %), and taking one would have been choosing on the held-out sample. C read only the
  rule chosen on A.
- **Other reaches and margins on A.** Reach 1-2 bars and margins 0-3 dB all read 55-65 %;
  1 bar at 0.5 dB was best (0.25 dB tied, and the larger margin was kept).
- **4-bar lines from the red line.** This takes the nearest bar on a 4-bar line, if one is
  within a bar. Kiai starts do sit on those lines 47.7 % of the time (A; 25 % by chance), and
  69 % of the gaps between a song's kiai starts are whole 4-bar multiples.
  - The edges do not follow: 50.7 % on the kiai's bar against 42.4 % (+25/-13, p 0.07).
  - It leans on a red line that sits on a phrase start: a mapper's does, a detected one need
    not.
  - A phase voted from the song's own edges: 43.8 %. A 0.5-2 dB bonus for those lines on top
    of the level rule: net +2 to +4 pairs (p 0.56-0.69).
- **Rises only.** 61.8 % on A's kiai starts, but kiai ends fell from 41.8 % to 28.1 %: edges
  into quieter parts moved to a rise. The direction has to come from the song.
- **The largest change either way.** 59.7 % on A. It can take the stop bar before a chorus,
  whose fall can be as large as the chorus's rise.
- **The direction read locally**, over 4 s either side of the novelty peak (what the kernel
  sees): 56-58 % on A, below the sections' levels.
- **Two bars either side for the level**: 56-57 % on A, below one bar.

## v4.0.0-dev — 2026-09-26 · The engines warmed up while the user picks a song

The first analysis in each session paid for what first calls compile and set up (librosa's
numba kernels, scipy's filters, the FFT plans): measured in fresh processes on the same
20 s fixture, a first grid analysis took 1.0-1.4 s longer than the second, a first
fallback one 3.5-4.0 s longer. Roadmap, Phase 22: "Pre-warm the engine".

### Changed

- **`warm_up()`**: both engines, the grid and the fallback tracker, once each on the
  self-check's 20 s of clicks in a temporary folder. It holds no lock and changes no
  state, so an analysis started meanwhile runs as ever, and it reports a failure instead
  of raising.
- The window starts it on a background thread when it opens, except when it was opened
  with a song, whose analysis is about to run. 3 bridge tests.

### Measured

```
bench/audio/downbeat-4-4.wav, a fresh process each, 3 rounds interleaved, machine busy
                      first analysis, cold     first analysis after warm_up()
  grid (auto)         2.46 / 2.65 / 3.22 s     0.90 / 1.09 / 1.24 s   median -1.56 s
  fallback (legacy)   5.21 / 5.74 / 5.81 s     2.65 / 2.66 / 3.13 s   median -3.08 s
  warm_up() itself    grid 1.44-3.12 s + fallback 2.50-3.36 s, on its own thread
Python unittest      581 -> 584, all pass · facts ok · engine untouched, gates not re-run
```

The warm-up's own seconds are spent while the window is open and a song is being picked;
an analysis that starts before it ends shares the machine with it, and still finds the
compiled kernels it has already built.

## v4.0.0-dev — 2026-09-26 · Bars on the map at every zoom, and signatures on the red lines

Zoomed out past 7 px a beat, the map drew no grid at all, so a whole song showed no bars;
and which red lines changed the bar's length showed only in the points table's meter
column. Roadmap, Phase 3: "Measures on the map".

### Changed

- When the beats are too close to draw, the bar lines are drawn alone while they are 8 px
  apart or more; zoomed in, the full grid returns at 7 px a beat, as before.
- A red line whose bar differs from the line before it (the first one, from 4/4) adds the
  signature to its chip: "150.00 · 3/4". A line that keeps the bar keeps its plain chip.
  No Python changed.

### Measured

```
signature-changes.wav (the signatures gate's fixture: 6/4, 3/4, 6/4, 3/4, 6/4, 4/4, all
proven), through the harness page
  chips                        300.00 · 6/4, 150.00 · 3/4, 300.00 · 6/4, 150.00 · 3/4,
                               300.00 · 6/4, 200.00 · 4/4
  whole song (122 s on 876 px) 90 bar lines across a row of the plot (bars 8.6 px apart;
                               none before, at 1.4 px a beat)
  4 s at 150 BPM               10 lines, one a beat: the full grid
web shell tests      181, all pass
```

## v4.0.0-dev — 2026-09-26 · A keyboard map: every key on one sheet

The page answered Space, T, ↑/↓, Ctrl+O/Z/Y and Enter/F5, and said so nowhere but a hint
under the transport. The transport itself had no keys: seeking, stepping between red lines
and turning the loop or the click on meant the mouse. Roadmap, Phase 3: "Keyboard map".

### Changed

- **`?` shows the sheet**: every key with what it does, in both languages, as a modal
  dialog; `?`, Esc and Close shut it, and while it is open no other key acts.
- **New keys**: ←/→ seek 1 s and with Shift 10 ms; `[`/`]` go to the red line before or
  after the playhead and select it; L turns the loop on and off (the drawn one when there
  is one) and C the click, through the transport's own check boxes, with a note; 1–9 and 0
  open the rail's ten sections in order. The transport's hint names `?`.

### Fixed

- **A focused list took shortcuts meant for the page**: an arrow on the hitsound source
  list would also have sought, Enter started an analysis. Lists now keep their keys, as
  fields and sliders did.
- Found before it shipped: on a Spanish keyboard `[` and `]` are typed with AltGr, which
  Windows reports as Ctrl+Alt, and the first cut refused any modifier. A key AltGr produced
  now counts as a plain key; a real Ctrl+Alt chord still does nothing.

### Measured

```
through the harness page (synthetic "Secs" track, red lines at 0.310, 24.310, 46.021 s)
  ? / ? again / Close / a real Esc     open / shut / shut / shut; 15 rows, EN and ES
  Space with the sheet open            nothing played
  1, 0, 2                              Library, Settings, Timing
  → from 30 s, ← twice, Shift+→        31, 29, 29.01 s
  ] ] from 30 s, then [ [ [            46.021 (line 3); 24.310, 0.310, 0.310 (line 1 holds)
  ] with AltGr / with Ctrl+Alt         46.021 / nothing
  L, C                                 "Loop section: on", "Click: off"; boxes follow
  → and 2 typed in the offset field    no seek, no view change; → on the list: no seek
  960 x 640, Spanish                   the sheet fits (576 px), nothing cut
web shell tests      181, all pass (the page's bracket and string checks included)
```

Not checked: a real `?` press. The harness's typing inserts text without key events, so
`?` was dispatched as the key the browser reports; that is the character, whatever the
layout.

## v4.0.0-dev — 2026-09-26 · An installer: a per-user MSI and a portable ZIP, in one line

### Changed

- **`installer\build.py` builds Overtone for a machine with no Python and no Rust**
  (roadmap 10.13.1, 10.13.5 and part of 10.13.2). One line: the Rust engine; PyInstaller's
  tree, `Overtone.exe` (the window), `overtone-py.exe` (the Python engine's command line)
  and `_internal\` with Python 3.14, the locked wheels, the app's own files and the Rust
  engine; a smoke test of that tree; a per-user MSI made with WiX 5.0.2; the same tree as a
  ZIP. Then both are unpacked in temporary folders, the MSI by an administrative install
  that registers nothing, compared with the tree file by file and smoke-tested. Outputs go
  to `dist\`, git-ignored, with a summary of sizes, SHA-256, step times and smoke results.
- **The MSI needs no administrator**: it installs per user into
  `%LOCALAPPDATA%\Programs\Overtone`, with a Start menu shortcut that carries the app's
  taskbar identity, and welcome, folder and install pages. Its uninstall is authored to
  remove the program folder, the shortcut and the installer's own registry key (not run
  here: see Measured). The app's data (settings in
  `~\.overtone.json`, `%LOCALAPPDATA%\Overtone\`, exports, `.bak` files) lies outside the
  program folder, and the MSI never creates or deletes it. `docs/11` now lists where each
  piece really lives: the plan's `%APPDATA%\Overtone\` was never used by the code.
- **`Overtone.exe --self-check [REPORT.json]`**: the window's executable looks for what it
  reads where the code looks for it (page, icon, samples, library schema), loads the
  window's libraries without opening a window (it fails without the WebView2 runtime), and
  runs both engines on twenty seconds of clicks at 150 BPM, the Rust one through the app's
  own sidecar call. Exit 0 only when all pass. It is how the build checks the window's
  executable without a window; anyone can run it on an installed copy.
- Not built yet, and said so in `docs/11`: signing, licence notices and an SBOM (so neither
  artefact should be published yet), file associations, the portable `data\` folder, and an
  install and uninstall on a real profile.

### Fixed

- **An installed copy never cached an analysis.** The result cache stamps its keys with
  `overtone.py`'s modification time, so that editing the DSP invalidates them. A frozen
  build packs `overtone.py` inside the executable: the module still reports a `__file__`,
  but no file is there, the stamp raised OSError, and every key came out None, so every
  song was analysed again, silently. A frozen build now stamps its executable, which a
  rebuild replaces. The new test fails on the old code (the key is None).

### Hardening

- The build refuses a venv whose wheels differ from `requirements.lock` or
  `installer\requirements-build.lock` (PyInstaller 6.22.3 and its five dependencies): the
  bundle carries whatever the venv holds, and the locks are what was measured.
- The smoke test runs every executable with a scratch profile (USERPROFILE, LOCALAPPDATA,
  APPDATA, TEMP, TMP) and a PATH of Windows' own folders: the frozen app cannot touch the
  user's config, cache or history, nor lean on a DLL only a developer's PATH provides. It
  fails if the tree changes at all, since a program that writes into its own folder leaves
  files an uninstall does not remove.
- The MSI's file list is one component per folder, each with an HKCU key path and a
  RemoveFolder, which is what Windows Installer asks of a per-user package: its validation
  finds no error, and every folder has its removal authored, the 35 of the tree's 168 that
  hold only folders included.
- The Rust engine ships in `_internal`, beside the MSVC runtime it links
  (`VCRUNTIME140.dll`, which PyInstaller copies there): found there without a copy in
  `System32`, and where `overtone_rust` already looks.
- Toolchain, per user and without an administrator: the .NET SDK 10.0.401 from Microsoft's
  signed `dotnet-install.ps1`, which leaves PATH alone; every `dotnet` the build runs has
  telemetry, update checks and the first run's PATH and certificate changes turned off.
  One setup command here ran without those two variables, and the SDK's first run added
  `%USERPROFILE%\.dotnet\tools` to the user PATH and an untrusted `CN=localhost`
  development certificate to the personal store; `docs/11` lists the variables for that
  reason. The build itself reaches no network.
- **WiX 6 and 7 are not used**: their NuGet packages carry the Open Source Maintenance Fee
  EULA and require accepting it (`requireLicenseAcceptance`); that is the owner's decision,
  not the build's. WiX 5.0.2 is MS-RL alone and asks nothing.

### Measured

```
installer\build.py --clean at 9356249, this machine, other sessions running on it
  toolchain   Python 3.14.7 · PyInstaller 6.22.3 (hooks 2026.7) · rustc 1.98.1
              · .NET SDK 10.0.401 · WiX 5.0.2
  tree        734 files, 314.5 MB (llvmlite 120.4, scipy 50.4, numpy + scipy DLLs 41.5,
              Overtone.exe 20.0, overtone-py.exe 19.4, the Rust engine 5.5)
  MSI         113.0 MB   sha256 72d6ce1d87c30b500be1bf67b256b015e5ed35b3cac92fc2ab2fc1d38a49ffe7
  ZIP         138.4 MB   sha256 2a29151dd474c7e4564bb602d523ad2583dfb6bced4a6218919bc0d9a67b94ed
  ICE         0 errors; warnings ICE91 x734 (per-user folder), ICE61 x1 (same-version upgrade)
  steps       cargo 0.6 s (built; 5 min 10 s from nothing) · PyInstaller 485.8 s · smoke 59.0 s
              · MSI 316.9 s · ICE 60.3 s · ZIP 41.9 s · admin install 46.9 s · unzip 5.0 s
              · total 1296.2 s; an earlier clean build, more loaded: 1947.2 s
smoke                  overtone-py.exe       overtone-cli.exe      Overtone.exe --self-check
  dist\Overtone        174.0000 BPM 29.4 s   174.0000 BPM 2.6 s    8/8 26.1 s
  MSI, admin install   174.0000 BPM 16.1 s   174.0000 BPM 2.2 s    8/8 35.7 s
  ZIP, unpacked        174.0000 BPM 13.7 s   174.0000 BPM 1.3 s    8/8 31.3 s
  every copy's 734 files identical to the tree; every tree unchanged by its runs; the
  scratch profile got numba's cache (2 files, 8 kB) and nothing else
edm-174 read by the frozen Python engine 174.00000407786123, by overtone.py in the checkout
  the same to the last digit, by the Rust engine 174.00000407791484
MSI Word Count 10 (compressed, no elevation needed), no ALLUSERS; the administrative
  install asked for nothing
Python unittest     +8 tests (528 -> 536 on its own base), all pass · facts ok
```

Not measured: a real install and uninstall (not run, by instruction), the window itself
and the classic Tk window (they open windows). The Tk window's Tcl and Tk scripts were
checked inside `tcl90.dll` and `tcl9tk90.dll`, where Python 3.14's Tcl/Tk 9 keeps them.

### Rejected / tried and dropped

- **WiX 5's `<Files>` harvesting**: one component per file, the file as its key path. In a
  per-user package Windows Installer's validation reported 734 ICE38 and 194 ICE64 errors
  (a key path in the user profile must be an HKCU value; a folder there must be removed
  explicitly). The build now writes the file list itself, one component per folder: no
  error.
- **A dual-purpose package** (`Scope="perUserOrMachine"` into `ProgramFiles64Folder`, which
  Windows points at `%LOCALAPPDATA%\Programs` for a per-user install): it avoids those
  errors, but WiX leaves the "no elevation needed" bit unset (Word Count 2, against 10 for
  `perUser`), so whether Windows would ask for an administrator was not something this
  build could show without installing. `Scope="perUser"` sets it.
- **The Rust engine beside `Overtone.exe`**, where a user would find it: there it depends
  on a system copy of the MSVC runtime (see Hardening).

## v4.0.0-dev — 2026-09-26 · The Library, measured: scans that say what they did, and the health check's engine

### Changed

- **A first scan opens four files at a time.** On `C:\osu!\Songs` (4,802 folders, 25,174
  `.osu`, read only) the first scan took 263 s and the next one 17 s: the difference is the
  first open of each `.osu`, about 10 ms whatever its size (small hitsound samples never
  opened: 10.05 ms each; once read, 0.24 ms). Those waits overlap, so four reader threads
  list and read folders ahead, while parsing and every database write stay on the scanning
  thread. It builds the same index, row for row, and warm it is no slower.
- **Progress counts folders that are in the index**: "0 / 4802" as soon as the Songs
  folder is listed, then at most 0.25 s apart, and the last folder only once it is
  written. When rows of maps that are gone are about to be deleted, the page says how many.
  Commits go by time (1 s) instead of every 100 folders.
- **A search of one letter lists the maps in the index's order**: ranking every map a
  letter matches was most of such a search's time. Two letters and more rank as before.
- **The library health check, engine half** (Phase 21). `Library.health()` grades each
  indexed map's red lines against its own audio with the reference timing card's grading
  (`grade_reference_timing`), on the attacks between the map's first and last objects,
  where it is played. The attacks are found once per audio file, by the Rust sidecar when
  it is found (`overtone-cli analyze --full`, read even when the engine refuses a grid,
  through the new `overtone_rust.attacks`), else by v3's detector; the difficulties of a
  set that share their red lines and played range are graded once. Each verdict (check,
  error, no_audio, unsure, no_timing, ok) goes into the index's new `health` table with the
  sizes and times of the `.osu` and the audio it was made from and the grading's version,
  committed per audio file: a run cut short by a limit or a stop loses nothing, and a
  rerun grades only what changed. `health_report()` lists them worst first, by the largest
  disagreement among a map's flagged lines, each line with the evidence the reference card
  shows. There is no page for it, and its flags are not yet a list to show (Measured).
- **The Songs browser says what happened** (to be seen in the browser): the damaged index
  and that Rescan rebuilds it, and that it did; "no beatmaps in {folder}" for a folder
  scanned empty; how many maps a scan is removing; a Songs folder that is no longer there;
  and how many files could not be read, named in the line's tooltip. English and Spanish.

### Fixed

- **A folder the scan could not list lost its maps, reported removed.** It was skipped,
  and then every map the index had for it was deleted as gone, with no failure named: in
  a probe with one set denied by ACL, 2 maps removed and 0 failed. Its rows now stay and
  the folder is named. A `.osu` another program holds open keeps its row too: it was
  counted both failed and removed, and left search until the next scan, which now reads it
  again.
- **Empty `.osu` files were difficulties with no name.** The local folder holds nine 0-byte
  `.osu` files; they were indexed as blank maps, and one set held nothing else. A file with
  none of [General], [Metadata], [TimingPoints] and [HitObjects] is now a named failure.
- **A damaged index was a dead end.** Junk, a truncated file or overwritten pages made
  every library call fail, a scan included, and nothing on the page led out but deleting
  the file by hand. A scan now rebuilds it, since the Songs folder is the truth; only
  SQLITE_CORRUPT and SQLITE_NOTADB count as damage, so a busy index is still waited on and
  one from a newer schema still refused.
- **Progress was one folder ahead of the work** at every report, and 100 % came before
  the removals: 6.05 s of a 6.31 s scan when an index moved to another folder.
- **The page** went blank when the index could not be read, and said "Not indexed yet" of
  a folder just scanned and found empty.
- **At the window's narrowest, Folder and Rescan sat off screen** (found in the browser
  check before merging). The empty views' grid had one `auto` column, which grew to the
  full width of the Library's one-line status: at 960 px a long "is not there" line pushed
  the header past the window, reachable only by scrolling sideways. The column is now the
  view's width, and the line truncates as it was meant to.
- **The unreadable files' tooltip named each file twice** ("broken.osu: broken.osu is
  empty…"); a reason that already names its file is no longer prefixed with it.

### Hardening

- A search reply that lands after a newer one is dropped: one-letter searches took up to
  331 ms under load, past the page's 120 ms typing pause.
- A reader thread stops at the 16 MB a `.osu` may have, where the scan used to read an
  oversized file whole before refusing it; the refusal still names the true size.
- Schema 2. `MIGRATIONS[2]` is `library.sql`'s health table as it stands, frozen; a test
  holds an index migrated from version 1 to a new one, and a copy of the full local index
  migrated on open with its 25,165 maps.

### Measured

```
C:\osu!\Songs, read only (4,802 folders, 25,174 .osu, 5,232 audio files); every index in
a temp folder. Other agents' audio jobs shared the machine throughout (CPU at 100 % in
the later runs), so timings moved by up to 3x between runs: only runs interleaved in one
session are compared, and CPU time is given where it could be read.
first scan, first read of the files   263.2 s (18 folders/s, 96 .osu/s), 255.4 s of it
                                      reading headers (437 s on 2026-09-24)
full scan, warm, before               17.1 s (282 folders/s, 1,477 .osu/s)
full scan, warm, interleaved rounds   before 23.6 / 21.1 / 52.4 s, after 14.2 / 21.9 /
                                      28.8 s; CPU time 21.5 s before, 22.1 s after
first read, the cold path             Songs was warm after the first scan, so fresh copies
                                      of 1,211 .osu in 300 folders: 29.0, 28.5 s -> 7.1,
                                      7.7 s (in both orders); again under the evening's
                                      heavier load, 68.8, 65.7 s -> 16.9, 16.9 s; small
                                      cold files 10.05 ms each alone, 2.95 ms on 4
                                      threads, 3.25 ms on 8
first scan of Songs, after            218.2 s, once, in the evening (its rescan took 3.8 s
                                      against 1.3 s in the morning): not comparable with
                                      the 263 s before, and whether the files were cold
                                      again is not known
peak working set                      +6 to +31 MB over the process's own ~100 MB
rescan, nothing changed               1.29-1.38 s; interleaved 1.17-4.14 s before,
                                      0.98-1.57 s after
rescan after changes, full size       10 edited + 10 new + 10 deleted maps 2.19 s, 100
  (simulated on the index)            each 2.63 s, 1,000 each 4.66 s; counts exact
rescan after real edits               74 copied folders: 5 edited, 3 deleted, a folder
                                      deleted, one renamed, two added: counts exact, 0.85 s
progress, before                      49 reports, each one folder ahead of the work; gaps
                                      of 6.5 s (median) to 10.4 s on the first scan
progress, after                       69 reports on a warm full scan, 0.32 s apart at most;
                                      "removing 25,165" 5.6 s before the end, then done
search, before, 670 queries x 3       p50 10.6 ms, p95 95.3, max 331; one letter p50 72,
                                      p95 157; 3-8 ms of each is opening the database
search, interleaved, 1,755 queries    same maps returned for every one; one letter p50 58.3
                                      -> 14.6 ms, p95 186 -> 57; every prefix of typed
                                      artist and title p95 78.6 -> 53.5, max 366 -> 156
same-audio                            first 33-646 ms (hashing), then 5.8-11.5 ms; the walk
                                      3.2-4.0 s; the same matches for 3 of 3
edge cases                            empty and missing Songs folders end cleanly; a
                                      denied folder 2 removed / 0 failed -> 0 / 1, maps
                                      kept; a held file kept and read next time; empty,
                                      junk, UTF-16 and 16 MB .osu named; junk, truncated
                                      and overwritten indexes rebuilt by the next scan
long paths                            the longest .osu path here is 249 characters; under
                                      osu!'s default %LOCALAPPDATA%\osu!\Songs, 178 of
                                      25,174 would pass 259, and long paths are off on
                                      this machine: they are named failures, not fixed
health check, 30 random mapsets       155 maps, 54 audio files, CPU held at 100 % by other
  (seed 21), both engines             jobs: the Rust sidecar 275.8 s, 5.11 s per audio
                                      file (median 4.47, max 20.3), 1.78 s per map; v3
                                      564.1 s, 10.45 s per audio file (median 7.70, max
                                      77.1), 3.64 s per map. The same verdict for 155 of
                                      155 maps, flag sizes within 0.01 ms
                                      a rerun with nothing changed: 0 graded, 0.06 s
                                      75 maps flagged in 17 of 30 sets, 6 unsure, 74 ok
a whole Songs folder                  5,236 audio files: about 7.4 h with the sidecar at
                                      that pace, 15 h with v3; not measured
are the flags real?                   an independent reference: where each map's own
                                      objects fall against the attacks, quarter by quarter
                                      of the map. Of 104 maps it can judge, 60 move by
                                      8 ms or more and 44 stay within 4 ms. Graded where
                                      each map is played, the flags catch 23 of the 60
                                      and hit 26 of the 44; graded on the whole audio file,
                                      as the reference card does, 18 and 27
                                      the five largest flags read 54-694 ms; those maps'
                                      objects show 3-14 ms: two steady, three moving by
                                      9-14 ms. The sizes come from fits anchored far from
                                      what the map plays (a red line 68 s before its
                                      first object), 131 gimmick lines of a mania map,
                                      spans of 11-19 attacks, and grids that explain 41 %
                                      of the attacks
                                      one small flag is plainly real: sajou no hana -
                                      Evergreen's objects walk 20 ms across 215 s
index migration                       a copy of the full local index, schema 1 with 25,165
                                      maps, opened as schema 2 in 22 ms, every map kept
browser check before merging (the harness on this branch; the Songs folder read only)
  first scan of the Songs folder      "Listing the folder…", then 15 -> 1006 / 4802 folders
                                      in 32 s, never ahead of the work; 25,165 maps in
                                      168.5 s, machine busy; "9 could not be read", named
  another folder                      "Removing 25165 maps that are no longer in the folder…"
  empty folder, moved folder          "No beatmaps in … · scanned …"; "… is not there: the
                                      index (1 maps) is from …"
  a 0-byte .osu, a junk index         "· 1 could not be read", the file in the tooltip; the
                                      damaged message, then "The damaged index was rebuilt."
                                      and the list back
  overlapping searches                only the latest drawn ("a" asked before "fox
                                      stevenson"; typing "camellia" fast)
  960 px, Spanish, longest line       buttons at 654-832 px after the grid fix (963-1141
                                      before, off screen); line truncated; 1280 px unchanged
Python unittest     +14 tests (528 -> 542 on its own base), all pass (the Rust health test ran with OVERTONE_CLI set)
facts
```

### Rejected / tried and dropped

- **Parsing on the reader threads.** The same wall time as reading only, and more CPU
  (23.4-31.5 s against 22.1-28.0 s over three interleaved rounds): parsing stays on the
  scanning thread, where it does not contend.
- **An FTS5 prefix index** (`prefix='1 2'`). Same rows, one-letter queries twice as fast
  (124 -> 63 ms median over common letters), but a schema migration that rebuilds the
  full-text index (3.6 s over 25,174 maps) and 18 % more file (25.8 -> 30.5 MB). The cost
  was ranking, not matching (matching "s" took 15 ms of 136), so not ranking one letter
  does more with no migration.
- **Ranking and limiting before the joins** (a subquery). The same rows, and not faster.
- **Grading every attack of the audio file**, as the reference card does for the song it
  has open. Pack and practice maps play part of a long file, and the songs around them
  moved the fit: a synthetic pack read 723 ms of drift, a local one 1,019 ms. Graded
  between its first and last objects the synthetic map is clean, and over the 30 mapsets
  the flags matched the reference slightly better (above). It does not fix a red line
  placed long before the part a map plays: the fit is anchored there, with nothing to hold
  it, and the local pack map still reads 694 ms.

### Open items

- **What the health check should call wrong** (a decision). The reference grading was
  built for one song a mapper is checking, and across a library its bar (5 ms and two
  standard errors) flags steady maps as often as moving ones. The engine keeps every
  verdict with its evidence, and `HEALTH_GRADER` regrades everything when the rule
  changes. Two ways on: grade what the map plays, its objects against the attacks (the
  reference used above, which no ear has checked either); or keep the reference grading
  behind a floor in ms and a minimum of attacks per span, with gimmick maps (lines under a
  beat long) set apart. Either wants a hand-checked sample before a page lists maps.

## v4.0.0-dev — 2026-09-26 · The CLI writes UTF-8 when its output is redirected

Redirected to a file or a pipe, Windows hands Python its ANSI code page (cp1252 here), not
the console's Unicode. A batch run over a folder with a Japanese file name printed its
header, then ended in a `UnicodeEncodeError` traceback at that name's row; an error message
naming such a path did the same. Roadmap, Phase 22: "CLI Unicode output".

### Fixed

- `main()` writes stdout and stderr as UTF-8 (unencodable text replaced, never raised) when
  they are not a console. A console is left as it is: Python already writes it as Unicode.
  The timing lines and the JSON are ASCII either way.

### Measured

```
batch over a folder holding "東方 テスト.wav" (3 s of silence), stdout piped,
PYTHONIOENCODING unset
  before    header, then UnicodeEncodeError: 'charmap' codec can't encode characters
  after     the row, "東方 テスト.wav ... FAILED: No rhythmic pulse found", as UTF-8;
            exit 1 because the row failed, not the run
the new test on the old code   the same UnicodeEncodeError
Python unittest      558 -> 559, all pass · facts ok
engine gates         benchmark 24/24, bpm-snapshot 24/24, golden 27/27, reference 24/24,
                     coverage, measures, signatures, robustness, assisted: all pass
```

This session's own shell sets `PYTHONIOENCODING=utf-8`, which is why no earlier run here
saw it; the test hands `main()` cp1252 streams instead of relying on the environment.

## v4.0.0-dev — 2026-09-26 · The late reading: ranked maps put their lines before the sound

Corpus B read every category a median +24 ms after the mappers' red lines, steady songs
included (roadmap 10.0a). The audio itself says whose milliseconds those are. Ranked maps put
their red lines a median 21 ms before the sound starts: on 100 of 100 held-out maps, and on
LAME MP3, other MP3 and OGG alike. Overtone puts its own a few milliseconds after the sound's
first edge. The first part is not in the audio, so the engine cannot correct it. The second
is the engine's; the correction tried for it made the tempo worse on six real songs and was
dropped. No engine code changed. `--onsets` makes the split repeatable.

### Changed

- **`bench/corpus_b.py --onsets`**: where each track's sound starts, against the map's beats
  and against Overtone's.
  - The signal is the energy above 4 kHz. A click, a snare and a hat start there at their
    first sample; a kick's body or a bass swells for milliseconds. It is filtered both ways
    and smoothed over a centred millisecond, so it adds no lag.
  - Each beat's window is scaled to its own peak and averaged. The start is the last point
    before the average's peak at 10 % of its rise.
  - On Corpus A's truth it reads the hits 0.45-0.48 ms early on 22 of the 24 fixtures (its
    millisecond of smoothing). The two jittered fixtures read earlier, -4.8 and -12.1 ms:
    the earliest hits set the reading, so it can understate a lead but never invent one.
  - Two tests.

### Measured

```
where the sound starts, + when after the beat (bench/corpus_b.py --onsets, cached analyses)
  Corpus B, after the map's beats    median +21.3 ms, IQR +14.8..+23.8 (20 tracks)
                                     LAME MP3 +19.1 (12), other MP3 +22.9 (6), OGG +18.1 (2)
  Corpus B, after Overtone's beats   median -7.9 ms, IQR -14.4..-0.9 (19 tracks);
                                     Rust's grids -4.9 (15 tracks)
  the scorer, for comparison         Overtone's lines +24.0 ms after the maps' (17 tracks)
held out, a one-off script (not committed): 100 ranked or loved osu!standard maps with one
red line (94 ranked, 6 loved; status from a copy of osu!.db; no online or local offset; MP3
or OGG; none of Corpus B's sets; one per audio file; the first 100 of 3,632 in a seeded
shuffle)
  after the map's beats              median +21.4 ms, IQR +18.1..+23.9, range +6.7..+42.4;
                                     after the line on 100 of 100
  by decoder (the 95 clear ones)     LAME MP3 +21.6 (52), other MP3 +22.6 (35), OGG +20.0 (8)
  full band instead, same 84 maps    median +26.5 ms, IQR +21.9..+40.0 (width 18.2 ms, against
                                     5.4 above 4 kHz): the lines follow the first high edge
  within 5 ms of +21.4 ms            69 of 100, the most any one constant covers (19.7-21.7 ms)
the engine's attacks against the sound (Corpus B, each map beat's nearest attack; one-off)
  envelope peak                      the high band starts 19.5 ms before it (median; IQR 12.6..20.8)
  re-timed attack                    1.1 ms before it (median; IQR 0.5..6.5); the full band 0.3
synthetic kick, snare and hats over a pad, bass and noise bed, 128 BPM (one-off), re-timed
  snares, any bed                    +0.04..+0.75 ms after the true onset
  kicks, no bed or a light one       +0.5..+1.4 ms (+9 ms when rising over 20 ms, light bed)
  kicks under the loud bed           +0.5..+2.0 ms with a click, rising in 0-5 ms; +4.6..+19.7
                                     without one, or rising over 10 ms or more
  envelope peaks, every case         +6.3..+15.7 ms, later as the bed grows
decoder      libsndfile's MP3 (LAME encode, mpg123 decode) and Vorbis round trips of clicks:
             0 samples of lag. Every LAME-tagged file of Corpus B decodes to its frames x 1152
             less its delay and padding (12 of 12)
diagnostic   less the held-out 21.4 ms, not fitted on Corpus B: 10.9 % of its red lines within
             5 ms today (the scorer's diagnostic, fitted on Corpus B at +27.4 ms: 14.4 %)
Corpus A     unchanged, no engine change: 24/24, 0.0000 BPM / 0.16 ms, re-run for this entry
Corpus B     unchanged: v3 1.6 %, Rust 1.4 % within 5 ms, both analysed afresh for this entry
Python unittest 556 -> 558 on master (543 -> 545 on its own base), all pass · facts ok · other engine gates not re-run (no engine
                code changed)
```

What the measurements say:

- **Most of the +24 ms is the maps'.** On 100 held-out ranked maps the sound starts a median
  21.4 ms after the red line, after the line on every one of them, and on every decoder.
  - The decode is exact (above).
  - A decoder difference could not produce it anyway. An encoder delay that osu! kept would
    put the sound later in osu! than here, and so the lines after the sound here, never
    before it.
  - Why ranked maps sit there is not in the audio. It may be osu!'s playback, or how mappers
    place a line by ear; neither was measured here. The audio says only that it is one
    convention, and how tight it is (IQR 18-24 ms).
- **The rest is the engine's, a few milliseconds.**
  - The envelope peaks about 20 ms after the sound starts (librosa's centred flux shifts it
    9 frames, 26.1 ms, at the fitting hop).
  - The re-timing takes that away: the attacks land on the full band's rise, a median 1 ms
    after the first high edge.
  - But the full band can rise well after the first edge: 12 ms after it on camisa-negra,
    and 20 ms on a synthetic kick whose body swells under a loud low bed. The fitted grids
    sit a median 7.9 ms after the sound on Corpus B.
  - The re-timing explains about half of those 7.9 ms: moving each line by what the first
    difference does to its attacks takes 3.5 ms off (median, below). The rest was not traced
    here: the fit, the off-beats of grids read an octave up, or both.
- **Corpus A sees neither.** Its fixtures are timed to the sample, not to osu!'s convention.
  Its drums start at full amplitude over silence or a soft pad, where the full band's rise
  and the first edge coincide.
- **What is left to decide** (the roadmap's 10.0a row):
  - Whether Overtone writes osu!'s convention (the sound's first edge less about 21 ms) or the
    sound's own time. It belongs at the export, not in the engine, so Corpus A stays exact.
  - The value would come from maps outside Corpus B, as above. A repeatable mode needs
    10.0b's osu!.db reader.
  - Only once that is settled can the engine's own few milliseconds be measured on Corpus B's
    5 ms headline.

### Rejected / tried and dropped

- **Moving the engine by the convention.** The 21 ms are not in the audio. Shifting attacks or
  lines by them inside the engine would move every Corpus A offset by four times its 5 ms
  bar, to agree with a habit of osu! maps. It would be a constant, not a correction. Whether
  the export should follow osu!'s convention is the decision above.
- **Re-timing on the waveform's first difference** (a +6 dB-per-octave tilt, so the first
  edge sets the rise, not the swell under it).
  - It did what it was for. On all 20 tracks the high band now starts 0.3-0.5 ms before the
    attacks; today it starts up to 12.3 ms before them, over 5 ms on six tracks. Corpus A
    improved: 24/24, median 0.16 -> 0.08 ms, worst 2.26 -> 1.67 ms (shuffle-96). Corpus B's
    offsets improved too: within 5 ms 1.6 -> 2.5 %, signed median +25.1 -> +18.4 ms, per
    track +24.0 -> +21.8.
  - But it moved the grid on real songs, worse on six and better on four. Steampunk Engines
    went 165.00 -> 357.77 BPM, Nana Hitsuji 189.98 -> 81.42 in 3/4, and FREEDOM DiVE from one
    line to 11 flipping between 444 and 889. Take You Down went 174.01 -> 87.03, and Palette
    and Noble lost the 0.05 BPM bar on 7 of 7 and 4 of 10 sections. One Step Closer and Calm
    Down Juliet went from the fallback tracker to the grid. In all, 72 -> 68 of 789 lines
    within 0.05 BPM.
  - Where there is no edge, it is worse. A 55 Hz kick swelling over 15 ms under a 70 Hz bed
    reads +9.5 ms on the waveform and +13.7 ms on the first difference. With a 5 kHz click at
    its onset it reads +0.015 ms.
- **The first difference for the phase only**, the grids left as they are.
  - Estimated, not run through the engine: today's grids, each line moved by the mean shift
    of its inlier attacks.
  - The shifts were -0.5 to -7.1 ms (median -3.5). Within 5 ms went 1.6 -> 2.1 %, and less the
    held-out 21.4 ms, 10.9 -> 12.3 %.
  - Not built. Until the convention is settled, Corpus B's one-line songs cannot come within
    5 ms whatever the engine does (their sound starts 10-26 ms after their lines), so Corpus B
    cannot show what it is worth.
- **The envelope's centring as the cause.** librosa's onset strength shifts the envelope by
  lag + n_fft / (2 x hop) frames, and its peaks do land about 20 ms after the sound. The
  re-timing removes that on real songs as on Corpus A, so the red lines do not carry it.
- **The MP3 decoder**, on the counts above: exact round trips, no difference between tagged
  MP3, untagged MP3 and OGG, and a sign no decoder delay can produce.

## v4.0.0-dev — 2026-09-26 · The song before the first red line, hatched on the map

A banner said when the first red line came late, but the map did not show the stretch it
meant. osu! runs the first line's grid back over everything before it, which holds only
if the intro keeps that tempo. Roadmap, Phase 3: "Uncovered-intro shading".

### Changed

- The map hatches the song before the first red line across every lane, in the grid's
  own ink so it follows the theme, and the hover there adds "before the first red line:
  its grid runs back here". A line at or before 0 ms hatches nothing. No Python changed.

### Measured

```
Take You Down through the harness page (first red line at 16.6 s, music from 11.1 s)
  a row of the tempo plot, 1-15 s     luminance 23.9, spread 5.2 (the stripes)
  the same row, 30-60 s               luminance 20.1, spread 0.0
  hover at 0:04.9 / 0:40              the line above / nothing added; both languages
web shell tests      171, all pass (the page's bracket and string checks included)
```

## v4.0.0-dev — 2026-09-26 · A failed onset envelope is no longer swapped in silence

The roadmap still listed the envelope's memory as open. Its blocks landed with audit #38
(3.7 → 0.55 GB peak on a five-minute song, the same red lines); what was left was the
row's second half, "no silent MemoryError fallback". `_onset_envelope` fell back to a
spectral-flux envelope on any exception. The loader already zeroes samples that are not
finite and refuses less than two seconds, so in an analysis that fallback could only catch
a MemoryError or a bug, and answer with a different envelope: different attacks, a
different grid, and a result that still read as the precision engine's.

### Fixed

- The flux envelope now takes only what librosa refuses as audio (`ParameterError`, for
  callers that skip the loader). Anything else reaches the caller. In an analysis that is
  the precision fit's own handler: it falls back to the beat tracker and says why in its
  stage message, and the result carries the fallback engine's banner.

### Measured

```
the new test on the old code        fails: "MemoryError not raised"
what makes librosa's path raise     only samples that are not finite (ParameterError);
                                    empty, 1, 100 and 2048 samples and silence all pass
Python unittest      555 -> 556, all pass · facts ok
engine gates         benchmark 24/24, bpm-snapshot 24/24, golden 27/27, reference 24/24,
                     coverage, measures, signatures, robustness, assisted: all pass (no
                     fixture reaches the fallback, so none could move)
```

## v4.0.0-dev — 2026-09-26 · A loop drawn on the map

The transport could loop the section under the playhead and nothing smaller or larger:
a fill across two sections, or four bars inside a long one, meant looping the whole
section. Roadmap, Phase 4: "Scrub + loop", its drawn selection.

### Changed

- **Shift-drag on the tempo map draws a loop.** Its ends go on the nearest beats of the
  analysis, so it repeats whole beats and the click folds into it as it does in the
  section loop; with Alt they stay where the pointer lets go. It shows on the map while
  paused, the transport's check box reads "Loop 0:10.241 – 0:13.138", and it wins over
  the section loop until a Shift-click clears it. Drawn while playing, playback goes on
  inside it. A new song clears it.
- The note gives the length in beats when both ends are on beats, in seconds otherwise.
- The map's hint names the gesture in both languages. No Python changed.

### Measured

```
Synthetic "Secs" track (145 -> 152 -> 145 BPM, 68 s), through the harness page
  Shift-drag 10.2 -> 13.1 s     loop 10.2412 - 13.1377 s, both ends on beats: 7 beats,
                                0.4138 s each = 145.0 BPM; band drawn inside, none outside
  Alt+Shift-drag 20.1 -> 22.8   20.027 - 22.744 s, off the beats: "2.717 s"
  drawn while playing           playback moved into it (30.231 -> 30.771 s 0.6 s later)
  playing                       every position read stayed inside the loop
  Shift-click                   cleared: "Loop section" again, band gone
Python unittest      555, all pass (the page's bracket and stage-name checks included)
```

Not checked: the wrap at the loop's end by ear or by position. The harness pane was in
the background and its audio clock ran slow (0.6 s in 4 s), so it never reached the end;
the wrap is the section loop's own code, unchanged.

## v4.0.0-dev — 2026-09-26 · Edits start from the line as it is shown

The roadmap asked for a snap indicator: say when export snapping moved an offset, so a
±1 ms nudge is not silently undone. Snapping never moves a hand-placed line, and an edited
line is hand-placed; the quieter problem was one step earlier. The table shows, and the
.osu writes, a detected line within 1 ms of the previous grid (`SNAP_TOLERANCE_MS`) on that
grid, but a nudge started from the raw offset. On a line detected at 5000.6 and shown at
5000.0, -1 ms showed 4999.6 and still wrote 5000, and +1 ms jumped to 5001.6. ×2/÷2 of a
section, split and merge kept the raw offset too, so the line they kept in place moved by
the same amount once it was hand-placed and no longer snapped.

### Fixed

- **`_shown_offset`**: where the table shows a line and the .osu writes it. A nudge starts
  from it; ×2/÷2, split (the kept line, and the grid the new one goes on) and merge (the
  kept line, and the removed one it reports) keep it. The new test fails on the old code at
  every step: 4999.6, 5001.6 and 5005.6 for -1, +1 and +5, and 5000.6 after ×2.
- No indicator was built: with the cause gone there is nothing left for it to say.

### Measured

```
raw vs shown, precision engine's own section changes   0.005-0.026 ms (the measurement
                                                       behind SNAP_TOLERANCE_MS), under
                                                       the 0.1 ms the table shows
the full 1 ms                                          only lines that land near the
                                                       previous grid another way: the
                                                       fallback tracker, a loaded map
how often, on real songs                               not measured
Python unittest      554 -> 555, all pass · facts ok
engine gates         benchmark 24/24, bpm-snapshot 24/24, golden 27/27, reference 24/24,
                     coverage, measures, signatures, robustness, assisted: all pass (no
                     gate edits a point, so none could move)
```

## v4.0.0-dev — 2026-09-26 · Analysis stages named and timed, and a stop between them

The progress bar showed the engine's English message and nothing else: no time, and no
way out of a long analysis of the wrong song but to wait. Roadmap, Phase 3: "Progress
panel" (P1) and "Cancellable analysis" (P2).

### Changed

- **Each stage named and timed.** The bridge sends every stage the engine announces with
  an id, the time since the start and what each finished stage took; the page names it in
  the user's language, ticks the finished ones with their times, and runs the stage's and
  the total's clocks between events. The ids live in one table, `STAGES`, and a test holds
  it to every message the engine sends, so a reworded message cannot lose its name.
- **Stop.** `stop_analysis` sets a flag the worker checks at every stage the engine
  announces and once more before a result replaces the one on screen. The progress
  callback raises `AnalysisStopped`, a `BaseException` as asyncio's `CancelledError` is:
  the engine falls back to the beat tracker on any `Exception` from the precision fit, and
  a stop is not a failed fit. The page says "Stopping" until the stage ends, then that the
  analysis stopped and the result on screen stayed. The Rust engine runs as one stage and a
  cached result as none: a stop asked for meanwhile holds when they return.
- **The song panel keeps the times** (`analysis_timings`): the total ("from the cache"
  when nothing ran) and each stage. The last stage ends when the engine returned; the total
  also counts the cache check before and the save after.
- `onResult` still carries exactly the engine's payload, so the page asks for the timings
  instead of finding them attached. 5 bridge tests.

### Measured

```
Per stage, analyze_audio called from Python, with five other jobs running on the machine
  Take You Down          2:15   17.2 s  audio 1.6   attacks 11.3  pulse 0.3  octave 0.5
                                        sections 3.5
  FREEDOM DiVE           4:36   45.6 s  audio 15.2 (the process's first analysis)
                                        attacks 19.6  pulse 0.4  octave 4.4  sections 6.0
  Vampires (fallback)    5:27   83.5 s  audio 2.6   attacks 19.8  pulse 0.5
                                        transients 53.1  beats 7.0  half/double 0.4  local 0.2
  The Raven (refused)    7:57   78.1 s  audio 6.1   attacks 47.7  pulse 4.6  transients 19.7
  the longest stage, 11.3 to 53.1 s, is the longest a stop waits
Through the harness page, Take You Down
  full run      9.9 s: audio 0.9  attacks 5.9  pulse 0.3  octave 0.5  sections 2.2
  again         0.05 s, from the cache
  Stop          pressed about 2 s into attacks; stopped at 5.3 s, when that stage ended;
                the 174.01 BPM result on screen stayed
Python unittest      549 -> 554, all pass · facts ok · engine gates not re-run (overtone.py
                     untouched)
```

The harness's clocks include its event polling; they are not the app's.

### Rejected / tried and dropped

- **The timings attached to `onResult`**: that event carries exactly the engine's payload,
  and a cached result sends it alone; both are held by tests.
- **Handing the page back at once while the stage finishes behind it**: the page would say
  "stopped" while the machine is still busy and the next analysis waits all the same. It
  says "Stopping" until that is true.
- **The analysis in a subprocess, ended on stop**: instant, but every analysis would pay
  the imports and numba's compile again (the pre-warm row puts that at ~2.3 s). Kept for
  the new "Stop inside a stage" task, as a worker process that stays warm, or checkpoints
  between the envelope's chunks once the envelope memory bound chunks it.

## v4.0.0-dev — 2026-09-26 · Split and merge sections, refitted to their attacks

The editor could add and delete a red line, not split a section where its tempo moves or
merge two that are one. Either meant placing a line by ear and typing both BPMs. Roadmap,
Phase 4: "Add / delete / split / merge, with recalculation".

### Changed

- **Split at playhead** (`split_section`): the new red line goes on the section's own beat
  nearest the playhead, a beat or more after its line and half a beat or more before the
  next; anywhere else is refused (the page asks for the playhead inside the section first).
  Its meter is the section's, marked unknown: a beat need not be a bar.
- **Merge with next** (`merge_sections`): the next red line goes and the whole span is
  refitted from this one's line.
- **The refit** (`_refit_section`) is the reference grading's fit (`_grade_span`), started
  from the grid the section already had: phase locked at the line, least squares on windows
  doubling forward, read at 1/1 to 1/4. Offsets are held; only the BPM moves, at most
  0.8-1.25x, so a half cannot flip an octave. Fewer than 8 attacks, or a grid holding under
  40 % of their weight, keeps the old BPM with the reason (`kept: few / weak`) instead of a
  guess. The note says each section's BPM and its share on grid, the words the assisted
  card uses. A fallback result, which keeps no attacks, detects them once per song as
  reference grading does.
- Both are one undo step, and locked lines refuse like any edit; a merge refused by the
  next line's lock names that line.
- 4 engine tests (split on the grid and both halves refitted; a split off the section
  refused; merge refits the whole span; too few or scattered attacks keep the BPM) and 2
  bridge tests (split, merge, undo; every refusal).

### Measured

```
Synthetic "Secs" track (145 -> 152 -> 145 BPM, 68 s), through the harness page
  split the 152 section at 0:35     line at 34968.0 ms, 27 beats after 24310.1
                                    both halves 152.000 BPM, 100 % on grid
  merge 145 with that 152 half      145.001 BPM, 76 % on grid
  merge 145 with all of the 152     144.999 BPM
  undo                              the three lines back, to the 0.1 ms shown
Python unittest      543 -> 549, all pass · facts ok
engine gates         benchmark 24/24, bpm-snapshot 24/24, golden 27/27, reference 24/24,
                     coverage, measures, signatures, robustness, assisted: all pass (the
                     engine only gained functions; no reading moved)
```

Not measured: on real songs, how often a split's refit lands within 0.05 BPM of a mapper's
red line. Corpus B names 1,087 such lines on its four drift maps; it is the place to do it.

## v4.0.0-dev — 2026-09-26 · Corpus B: 20 hand-timed ranked maps, and where both engines stand

Phase 10's rule is that nothing ships without a measured gain on Corpus B, and Corpus B was
a table in the plan. The only real-song number was one track's 4.7 %, measured on
2026-09-22 by a method nobody wrote down. This builds the corpus and its scorer (roadmap
10.0) and measures both engines on it. No engine code changed.

### Changed

- **`bench/corpus_b.json`**: 20 ranked or loved maps from the local Songs folder, in the
  precision plan's six categories and counts (4 constant-tempo EDM, 4 constant-tempo
  rock/pop, 4 live bands that drift, 3 octave swaps, 3 rubato intros, 2 signature
  changes). Each is named by folder, truth difficulty and audio file with their SHA-1s,
  plus a line on why it was chosen; Vampires is one of them. The audio and the maps are
  never committed. Chosen from 25,174 local `.osu` files: ranked, approved or loved in
  osu!.db (read from a copy), BeatmapSetID > 0, no online or local offset, and every
  difficulty of the set on the same red lines; MP3 or OGG. 1,152 red lines in all, 1,087
  of them on the four drift maps.
- **`bench/corpus_b.py`**, one line to run. Per red line of the map: does the timing
  Overtone would export put a beat within 2, 5, 10 or 50 ms of it? The detected red line
  in force there (the benchmark's half beat of slack) is run to the map's line; the signed
  gap to its nearest beat is the error, + when Overtone is later. A grid read an octave
  slow is split to the map's beat and the octave counted apart; a refusal misses every
  line. Reported pooled over the lines and averaged over the tracks, per category and per
  track: the signed error's median, quartiles and worst, the median of each track's own
  error, and per map section the BPM against the map's, octave-normalised.
- **A changed file is refused, never guessed at.** Each track is found by its folder, or
  by its set ID when a set was downloaded again, and skipped with the reason when either
  hash differs. Analyses are cached in `bench/.cache/` (git-ignored) per audio hash and
  the hash of the code that produced them, so an engine change is never served an old
  answer. `--engine rust` runs overtone-cli; `--jobs` runs several analyses at once.
- 11 tests of the scorer on made-up red lines and temporary files. No test reads the
  Songs folder.

### Measured

```
Corpus B, Python v3 (the app's default): 20 of 20 tracks, 1,152 red lines
  within 5 ms        1.6 % of the red lines (18)       0.9 % averaged over the tracks
  within 2/10/50 ms  0.5 / 4.6 / 46.9 %                 0.1 / 5.4 / 68.4 %
  signed error       median +25.1 ms, IQR -15.1..+36.5, |error| median 35.1, worst 212.5
                     (789 lines; The Raven's 363 have no reading)
    within 50 ms     median +27.4 ms, IQR +17.1..+35.2 (540 lines)
    per track        median +24.0 ms over 17 tracks' own; MP3 +19.6 (15), OGG +32.7 (2)
  BPM per section    72 of 789 within 0.05, 222 within 1, octave-normalised;
                     read at x2 49, x4 5, x8 1
  paths              15 on the grid, 4 fell back to the tracker, The Raven refused
  per category       within 5 / 50 ms, pooled
    edm 0 / 75 %        rock-pop 0 / 75 %          live-drift 1.6 / 45.4 %
    octave-swap 0 / 68 %  rubato-intro 4.8 / 57.1 %  signature 0 / 100 %
  Vampires           14 of 236 within 5 ms (5.9 %), from the tracker's 22 red lines
  time               598 s of analysis, 4.8-85.5 s a track (17 of them two at a time:
                     296 s wall); a re-score from the cache 0.4-1.4 s
Corpus B, Rust (overtone-cli): 20 of 20 tracks
  within 5 ms        1.4 % of the red lines (16)       0.8 % averaged over the tracks
  within 2/10/50 ms  0.4 / 3.3 / 23.4 %                 0.1 / 3.4 / 54.2 %
  refused            5, where v3 falls back or refuses: One Step Closer, Vampires,
                     The Raven, Calm Down Juliet, Day to Story (612 lines unread)
  signed error       per track median +25.6 ms over 13 tracks
  time               96 s one at a time, 1.1-8.8 s a track
diagnostic only: less one constant (the median error of the lines within 50 ms),
  v3 would put 14.4 % within 5 ms, Rust 6.0 %
two ranked maps of the same audio, each scored against the other (the same scorer, a
one-off script over the Songs folder, not committed): 319 pairs from different sets
over 198 byte-identical audio files, 4,966 red lines both ways
  within 2/5/10/50 ms  79.1 / 81.8 / 86.1 / 92.3 %
  173 pairs hold the same red lines to the millisecond (copied, or found alike); the 146
  that differ agree on 73.8 % within 5 ms, 81.7 % within 10 ms
Python unittest      532 -> 543, all pass · facts ok · engine gates not re-run (no engine
                     code changed)
```

What the corpus says, beyond the headline:

- **The late reading is most of the gap on steady songs.** Six of the eight one-line maps
  have an Overtone beat 14.6 to 35.5 ms after their red line, none within 5 ms, while
  their BPMs hold (7 of 8 within 0.05). The median, +24 to +27 ms, is the offset reference
  timing found on 30 random maps (+26.2), now on the red lines Overtone writes. Less one
  constant (+27.4 ms), 10 of the two signature maps' 11 red lines would be within 5 ms.
- **Drift is the other half.** On the drift maps v3 writes one red line (YUI, Shinkou) or
  the tracker's 22 (Vampires) against the mappers' 226 to 363, and none on The Raven;
  less the same constant, 13.8 % of their lines would be within 5 ms.
- **v3 refuses a real song.** The Raven fails the no-pulse check ("No rhythmic pulse
  found"): its pulse gap is 0.024, under the 0.07 threshold and near white noise's
  0.014-0.022, where the 55 real songs that set the threshold all scored 0.090 or more.
- **Rust writes v3's red lines on 13 of the 15 songs v3 fits a grid to** (within 1 ms and
  0.01 BPM), and refuses the four where v3 falls back to the tracker. The two others:
  Shinkou, an OGG, decodes to 4,206 attacks against v3's 4,181 (655 ms / 190.22 against
  660 / 189.98); FREEDOM DiVE has the same 4,668 attacks but one red line at 149.8 s,
  333.33 BPM in 12/4 (confidence 0.39, kept as the best of a weak set), where v3 writes
  222.22 from 0.8 s, after Rust's per-section octave read 222/444/222/111/222. The golden
  gate pins parity on the fixtures, not on real audio.
- **Octave:** v3 reads four of the eight one-line songs an octave up (Imagination at 408,
  The Diary of Jane at 167, La Camisa Negra at 194, I Remember at 220).
- **Phase 10.1 cannot be scored on it as it stands.** Every track is in the Songs folder
  that fingerprint reuse would search, so 10.1 is measured with each track's own mapset
  held out, or it finds its own answer.

### Rejected / tried and dropped

- **Matching red lines by their own times.** A detected line anchored on another bar of
  the same grid misses by whole beats while osu! plays the two maps alike. The detected
  grid is run to the map's line instead.
- **Each track's own median as the diagnostic's offset.** On a one-line map it is exact by
  construction, so eight tracks would read 100 %. One constant for the corpus is used.
- **The median of every line as that constant.** Grids that do not fit spread their errors
  over half a beat and pulled it to +25.1 ms (v3) and +9.7 (Rust); the lines within 50 ms
  give +27.4 and +21.6.
- **A pooled share alone.** The drift maps hold 1,087 of the 1,152 lines; the mean over
  tracks is printed beside it, so one song does not stand for twenty.
- **BeatmapSetID > 0 as proof of a ranked map.** Graveyarded sets have IDs too: the local
  osu!.db lists 4,458 of its 24,565 difficulties as pending or graveyard. The status comes
  from osu!.db.

## v4.0.0-dev — 2026-09-26 · Phrase starts on the phrase's bar: measured, not shipped

### Changed

- Nothing in the app. The Structure view still snaps each phrase edge to the nearest proven
  bar within 1.5 s. A rule that moves the edge to the bar where the level changes was built
  and measured against ranked maps' kiai starts. It helped on the held-out sample, but by
  less than the bar set before that sample was read, so it stays out (below).

### Measured

The truth is the kiai starts of ranked maps from the local Songs folder, read only. Each song
contributes one standard difficulty, the one with the most objects. A map qualifies with a
single red line (60-300 BPM, 3/4 or 4/4) and a kiai of 4 bars or more that starts 6 s or
more from either end. Its red line counts as a proven bar, as reference timing loads it.

A kiai start's bar is the bar line it sits on, or the next one when it starts on a pickup up
to one beat before it. Of kiai starts on spans that long, 87.6 % sit on the downbeat and 6 %
on such a pickup; the other mid-bar starts are left out.

There were 1673 eligible songs, one per artist and title. A fixed seed shuffled them into two
disjoint samples of 500: A chose the rule, and B was held out and read once, at the end. No
audio file is shared; 36 of B's 481 titles recur in A as another cut or another song of that
name. `overtone-cli structure` ran on every song (one MP3 did not decode). The chance of the
exact bar is 20 %: one of the five bars in the ±2-bar window an edge is paired within.

```
                                 sample A (tuning)        sample B (held out)
songs with a kiai start          484                      492
kiai starts                      1189 (84 mid-bar out)    1252 (78 mid-bar out)
  with an edge within 2 bars     144 (12.1 %)             145 (11.6 %)
  within 4 bars                  16.3 %                   16.5 %
inner edges per song             median 3                 median 3

today (nearest proven bar), on those pairs
  on the kiai's bar              42.4 %                   45.5 %
  one bar early / late           26.4 / 16.0 %            21.4 / 17.9 %
  two or more early / late       11.8 / 3.5 %             15.2 / 0.0 %
the level rule (rejected below)
  on the kiai's bar              64.6 %                   55.9 %
  one bar early / late           15.3 / 3.5 %             26.2 / 5.5 %
  two or more early / late       12.5 / 4.2 %             11.0 / 1.4 %
  against today                  +40 fixed, -8 broken     +27 fixed, -12 broken,
                                                          sign test p 0.024
kiai ends (the next section's first bar, mostly falls), a guard
  today / level rule             41.8 / 45.9 %            41.5 / 44.7 %
all snapped edges on a 4-bar line from the red line (25 % by chance)
  today                          30.5 %                   29.6 %
```

The larger limit is not the snap. About 88 % of kiai starts have no edge within 2 bars, so a
structure stage that finds more edges would place more kiai than any snap rule can.

### Rejected / tried and dropped

- **The bar where the level changes most, the way the sections' levels go.** The rule looks
  at the nearest proven bar and the proven bar either side of it. For each, it compares the
  bar after the line with the bar before it on the report's energy lane. It takes the bar
  with the largest rise when the section after is louder, or the largest fall otherwise, but
  leaves the nearest bar only for 0.5 dB more.
  - Reach 1-2 bars and margins 0-3 dB all read 55-65 % on A; 1 bar at 0.5 dB was best
    (0.25 dB tied, and the larger margin was kept).
  - On B it gained 10.3 points (95 % interval about 2-19), +27/-12, sign test p 0.024. The bar
    set before B was read was +10 points and p < 0.01. The size cleared it; the p-value did
    not.
  - The gain halved from A to B, as a margin fitted to A would lead one to expect. Kiai ends
    did not suffer (41.5 -> 44.7 %).
  - It moves 47 % of all snapped edges off the nearest bar (1175 of 2482 on B), and the
    median move from the novelty peak grows from 233 to 640 ms. Kiai starts and ends check
    145 and 159 of those edges; the rest move unchecked.
  - More songs would not settle it. Simulated from B's own result, a fresh sample clears the
    bar about half the time, with the 673 unused songs or even with 1500: the size bar sits
    at the effect itself. Whether about 10 points is worth shipping is a decision, not a
    measurement.
  - Every variant below was also read on B, after the decision and for the record only.
    Every one-bar level variant beat today on B's kiai starts (51.0-58.6 % against
    45.5 %). Two would have cleared the bar: reach 2 bars at 1 dB (57.9 %, +27/-9, p 0.004)
    and at 2 dB (56.6 %, +20/-4, p 0.002), with kiai ends at 46.5 and 48.4 %. Neither was
    best on A (61.8 and 59.7 %). Picking one now would be choosing on the held-out
    sample, so a rule frozen now must be confirmed on the 673 eligible songs neither
    sample used.
- **4-bar lines from the red line.** This takes the nearest bar on a 4-bar line, if one is
  within a bar. Kiai starts do sit on those lines 47.7 % of the time (A; 25 % by chance), and
  69 % of the gaps between a song's kiai starts are whole 4-bar multiples.
  - The edges do not follow: 50.7 % on the kiai's bar against 42.4 % (+25/-13, p 0.07).
  - It leans on a red line that sits on a phrase start: a mapper's does, a detected one need
    not.
  - A phase voted from the song's own edges: 43.8 %. A 0.5-2 dB bonus for those lines on top
    of the level rule: net +2 to +4 pairs (p 0.56-0.69).
- **Rises only.** 61.8 % on A's kiai starts, but kiai ends fell from 41.8 % to 28.1 %: edges
  into quieter parts moved to a rise. The direction has to come from the song.
- **The largest change either way.** 59.7 % on A. It can take the stop bar before a chorus,
  whose fall can be as large as the chorus's rise.
- **The direction read locally**, over 4 s either side of the novelty peak (what the kernel
  sees): 56-58 % on A, below the sections' levels.
- **Two bars either side for the level**: 56-57 % on A, below one bar.

## v4.0.0-dev — 2026-09-26 · The .osu reader under a fuzzer

### Changed

- **`bench/fuzz_reader.py`**, one line like every other check: seeded mutant .osu files
  (lines deleted, duplicated and swapped; fields replaced by hostile tokens such as `inf`,
  `2**64`, `|||`; truncated or corrupted bytes; BOMs; stray line breaks) must read or be
  refused with a ValueError, write back byte for byte, and pass 13 consumers of a parsed
  map (sound events, the hitsound report, consistency and silence checks, playback, the
  hitsound difficulty, snap audit, reference grading, alignment, the mod report, scroll
  profile, proposals, the copier) with no other exception and no hang (faulthandler ends
  a run stuck past 5 s with its stack). A failure saves the mutant for replay.

### Fixed

- **A section header with a stray space or tab came back without it** (`[General]\t`).
  The reader matched the header stripped and the writer rebuilt it from the name; the
  header line is now kept as written.
- **Unicode line separators split lines osu! keeps whole.** `str.splitlines` breaks at
  `\v`, `\f`, `\x1c`-`\x1e`, `\x85`, `\u2028` and `\u2029` besides CR and LF; osu!
  reads lines at CR and LF only. A title holding one was two lines in the reader, and the
  text-level writers (inject, hitsound fields, shift, the timing section) counted lines
  the same wrong way, so an edit could land on the wrong line. Every split of .osu text
  now goes through one helper that breaks where osu! does.
- **A timing line with `inf` in a field crashed every sound-event reader**
  (`OverflowError`), and `nan` or `inf` times and beat lengths were taken as numbers. Such
  a line is now skipped as unreadable, as osu! skips it.
- **A meter of 2**64 made the hitsound report ask for a 2**66-slot list.** A meter past
  1024 reads as 4, the reader's rule for an unreadable one; the largest meter in the
  25,174 local .osu files is 16.

### Measured

```
bench/fuzz_reader.py, 3000 mutants per seed
  seed 1 found the header, the line separators and inf; seed 3 found the meter
  after the fixes, seeds 1-5: 15,000 mutants, none crashes, none hangs, every one read
  is written back byte for byte; 125-162 per seed refused with a reason; slowest mutant
  515 ms; 70-160 s a seed
meters in 25,174 local .osu files: 1 to 16 (16 four times)
the four regression tests fail on the old reader and pass on the new one
Python unittest     528 -> 532, all pass
benchmark.py 24/24 · bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures,
signatures, robustness, reference 24/24, assisted 70 · facts
```

## v4.0.0-dev — 2026-09-26 · Missing hitsound samples: measured, not reported

### Rejected / tried and dropped

- **Missing sample files as mod report findings** (P7, "missing samples, silent
  assignments"). The plan called a sound whose sample the beatmap folder lacks
  "playable-but-silent" and a validation error. It is neither: osu! plays the skin's
  default sample there, and the playback already counts it. Measured before building the
  finding, on 800 local maps: 624 (78 %) ask for a sample their folder lacks, 601 of them
  in mapsets that ship samples of their own, nearly always an index-1 hitnormal
  (`soft-hitnormal`, `normal-hitnormal`) that the mapper leaves to the skin on purpose
  while shipping custom additions. A finding would accuse correct maps three times in
  four. The one unambiguous case, a custom filename named on an object and missing from
  the folder, occurs on 0 of the 800. `06-hitsound-engine.md` §8, the roadmap row and the
  README now say so.

### Measured

```
800 local maps (one difficulty each, read only)
  ship hitsound samples              662
  ask for an index >= 1 sample       672
  ask for one the folder lacks       624: 601 that ship samples, 23 that ship none
  missing names per map (shipping)   median 4, p90 10, max 70
  a named custom file missing        0
```

## v4.0.0-dev — 2026-09-26 · A hitsound difficulty for the whole mapset

### Changed

- **The Export section writes a hitsound difficulty**: a new
  `Artist - Title (Mapper) [Hitsounds].osu` beside the others, with a circle at every
  time a sound falls. The source's sounds come first (the densest difficulty is offered
  first); then, unless unticked, every time another difficulty sounds where the source
  has none, with that difficulty's sound. Each circle writes its sound in full (additions,
  both sets, index, volume, custom file), so it plays what it played where it came from
  whatever the green lines say. Everything else is the source's own, byte for byte, but
  the metadata's Version (`Hitsounds`) and BeatmapID (0). It never replaces a file: one
  already there is named in the card instead. History lists the write. The mapper
  hitsounds it in one place (the Hitsounds section opens it like any difficulty) and
  copies it everywhere with the Mapset copier.
- **What a circle cannot carry is counted, not guessed**: an index of 0, which the format
  can only inherit, where the source's green lines give another; and the source's sounds
  that share their time with a different one (a mania chord, stacked objects), where one
  circle keeps the first. Combining them would change what each object plays.

### Measured

```
300 local mapsets with two or more difficulties (in memory, Songs only read): the
densest as the source, the others filling in
  276944 circles: 246589 from the source, 30355 from the others; 878518 sounds shared
  within 5 ms
  cannot play exactly (the index-0 case): 976 circles (0.35 %), in 25 mapsets
  the source's sounds sharing a time with a different one: 7978, reported
  copied back onto its source with H1, volumes included: 7978 of 258676 sounds change,
  every one of them where the source plays a different sound within 5 ms, 0 otherwise;
  slider bodies changed 0
Jester (5 difficulties), in the browser (harness), EN and ES
  Transcending Dimensions offered first; preview: 2102 circles, 1937 from it and 165
  from the others, 4035 sounds shared, every circle exact; unticking the fill: 1937
  written: the new difficulty appears in every list and opens in the Hitsounds section
  (2102 sounds); History lists it with no backup, so no restore; a second preview names
  the file already there, in the card, in both languages
  the Mapset copier with it as the source: every sound of the 5 difficulties finds its
  circle (0 unmatched); onto Transcending Dimensions 0 change, onto the others 6 to 16
  objects, where they sound unlike the source
Python unittest     524 -> 528, all pass
benchmark.py 24/24 · bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures,
signatures, robustness, reference 24/24, assisted 70 · facts
```

## v4.0.0-dev — 2026-09-26 · Slider bodies heard: the slide loops head to tail

### Changed

- **The transport plays a slider's body**: its slide in the normal set and, when the
  slider has its whistle bit, the whistle slide in the addition set, looped from head to
  tail at the body's volume and found by index as the hits are. A body already sounding
  when playback starts, or when a section loop wraps, joins in at once; the loop's end
  cuts it; at 75 and 50 % it lasts as long as the slower song does. Playing a difficulty
  "as it would be written" counts a slide that changes (an edited slider's volume) among
  the sounds unlike the file.
- **Overtone's own samples gain six loops** (`assets/samples.py`): per set, one second of
  hiss for the slide and a held whistle, at whole-number frequencies and vibrato so the
  end meets the start; the hiss fades its start into what follows its end. They sit at 0.3
  of full scale against the hits' 0.7, because a loop sounds for as long as a slider
  lasts. The twelve hit samples come out byte-identical.
- A custom filename on a slider stays with its hits: what osu! loops then is not verified
  here, so nothing is guessed.

### Measured

```
the generator: 18 samples, the 12 hits byte-identical to before; each of the 6 slides is
44100 samples, and its end-to-start jump is no bigger than its largest step inside
Jester [Trynna's Hard], in the browser (harness, silent)
  456 slider bodies, all on Overtone's slides here, at the green lines' volume (40 %
  around 53 s)
  playback from inside a body (53.301 s, body 53.201-53.724): it joins at once for the
  0.423 s left; at 50 % the same body holds 0.847 s of context time
  the bodies after it start within 1 ms of their song times and stop at their tails
  a 0.4 s section loop set by hand (this song has one section): the body is cut at the
  loop's end and starts again at each wrap, once
Python unittest     522 -> 524, all pass
benchmark.py 24/24 · bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures,
signatures, robustness, reference 24/24, assisted 70 · facts
```

## v4.0.0-dev — 2026-09-26 · Why a sound was proposed

### Changed

- **`overtone-cli hitsound` says what it heard under each decided sound**: the matched
  attack's time, its three likeliest instruments with their probabilities, and its
  division and metrical weight; null over silence, and on tails, which follow instead.
- **A row's inspector explains its proposal** (docs/06 §7, at the level of the terms). A
  click on a row with a proposal opens it over the table: the proposal and its runner-ups,
  what was heard ("clap 64 % · bass 22 % · kick 10 % · on an eighth") or that nothing
  was, and every term the engine added up there, signed and drawn to scale: the
  instrument heard, the place in the bar, a new combo, what the map plays now, the sound
  before it, and their sum. A tail says what it follows, or that it stays bare. The row
  stays marked until the inspector closes. The features behind each instrument stay in
  `overtone-cli hitsound-evidence`: the page shows what the decision used.

### Measured

```
overtone-cli hitsound on 8 local maps, one difficulty each: 5602 decided sounds
  something heard under it: 5387 (96.2 %); over silence: 215
  the term that weighs most in the proposal's score: what the map plays now 57.8 %,
  the instrument heard 21.8 %, the place in the bar 10.0 %, a new combo 7.1 %, the
  sound before it 3.2 %
  heard, yet the proposal takes nothing from the instrument: 1325 of 5387 (24.6 %)
  -> on maps already hitsounded the proposals mostly keep what the mapper wrote, by
     design (the prior weighs 1.2); the inspector is what makes that visible
Jester [Trynna's Hard], in the browser (harness, silent), EN and ES
  1311 proposals: 840 heard, 15 over silence, 456 slider tails (none with an object
  under it, so all bare); the first circle: clap 64 % heard, soft+whistle proposed on
  its place in the bar (+0.40) and a new combo (+0.80), the audio adding nothing to it,
  score +1.20, with normal+clap behind at 8 %
  the inspector's sum equals the terms the CLI sent; close hides it and unmarks the row
Python unittest     522, all pass (no count change) · facts
cargo test --workspace 263 pass (the hitsound CLI test now checks heard and silence)
Rust gates: golden 27/27 · nogrid refused · density 4/4, 0 false · elastic · map
```

## v4.0.0-dev — 2026-09-26 · A proposal swapped for one of its alternatives

### Changed

- **Each proposal in the sounds table is a choice**: the proposal or one of the two
  runner-ups the decision engine ranks behind it, each with how likely it is there on its
  own. A runner-up chosen ticks itself, and is what the preview, the transport and the
  write use. A slider tail follows its head and has no choice. With that, H5 is in but for
  the Export section's surface.
- **The card says what the percentages are**: a sound's chance on its own, over the 24
  sounds the engine weighs. The proposal is the one that fits the whole sequence best, so a
  runner-up can score higher alone, and on real maps one does for 23 % of the sounds
  (below). Without the note that reads as a wrong proposal.
- A tick or a choice no longer moves the playhead; a click elsewhere on the row still does.
- Proposal labels are compact ("soft+whistle 7 %"), and the table's headers may wrap while
  its cells never do, so the choice fits beside eight columns at 1280 px in both languages.

### Hardening

- A choice the sound does not have, or one for a sound with no proposal, refuses the
  preview, the hearing and the write alike.

### Measured

```
overtone-cli hitsound on 8 local maps, one difficulty each: 5602 sounds that are not
slider tails, each with 2 runner-ups
  the proposal on its own: median 12.8 %, p10 6.5 %, p90 21.3 %; the best runner-up:
  median 8.5 %
  a runner-up more likely on its own than the proposal: 1287 of 5602 (23.0 %)
Jester [Trynna's Hard], in the browser (harness, silent), EN and ES
  1311 proposals; the 456 slider tails have no choice; the first circle: soft+whistle
  7 % proposed, normal+clap 8 % and normal+whistle 7 % behind
  normal+clap chosen on an unticked row: it ticks itself; preview "1311 of 1311
  proposals ticked, 1 of them an alternative: 734 objects would change"; the transport
  plays normal+clap there; the copy written after plays exactly what was heard and holds
  normal+clap on that circle; the playhead did not move
  1280 px: EN and ES fit, no row wraps; 1024 px with proposals shown: the table scrolls
  sideways inside its card (41 px EN, 95 ES), the page does not
Python unittest     521 -> 522, all pass
facts
```

## v4.0.0-dev — 2026-09-26 · Volume and sample index by hand

### Changed

- **The Propose card edits volume and sample index too** ("Propose and edit hitsounds").
  A volume (0-100 %) or a sample index set on the sounds the table shows goes to their
  objects as the object's own value; 0 follows the green line again. The format keeps one
  volume and one index per object, so a slider takes them for every edge and its body, and
  the card says so. Edits need no proposal, and so no Rust; with a proposal they go into
  the same write as the ticked sounds, with one backup and one undo. The table shows each
  edit beside what plays now ("60 % → 40 %", "→ the line's"); the preview and the
  transport count them, and "Hear before writing" (was "Hear the proposal") plays it all
  over the song as the write would make it. Empty or out-of-range values say so.
- **The sounds table takes a range of bars** beside its addition filter. All, None, Set and
  Clear act on the sounds it shows, every page of them, so ticking or unticking one
  section's proposals, or setting its volume, is one click. A new song starts from all bars.
- Clearing the last edits while the transport plays them puts the file as written back in
  it.

### Hardening

- An edit carries the sound it was set on. A sound that moved since, two edits giving one
  object different values, or a value osu! could not read refuse the whole write, as a
  moved proposal does; the bridge refuses edits that are not a list of objects.

### Measured

```
800 local maps (copies): random proposals on half of each map's sounds, half of those
ticked, and edits (volume, index or both, 0 included) on a quarter of the objects
  heard == written: 799; different: 0; refused alike by both: 1 (the Aspire map of the
  entry below)
  edits alone, 132438 objects (45696 sliders): every sound plays what it played but the
  edited volume and index, which are the edit's (or the line's for 0): wrong 0;
  lines of objects not edited changed 0; bytes outside [HitObjects] changed 0
Jester [Trynna's Hard], in the browser (harness, silent), EN and ES
  bars 17-20: 40 sounds on 23 objects; volume 40 -> preview "23 objects would change";
  heard: 43 sounds unlike the file (the 40, and 3 edges of sliders crossing the range's
  ends); the copy plays exactly what was heard: 43 sounds at 40 %, no other sound changed
  bars 30-31, None: the 20 proposals there unticked, 1291 of 1311 left; with 12 objects at
  25 %: 734 objects would change; written in place it plays what was heard, and the undo
  restores the file's playback exactly
  1280 and 1024 px wide: the bars and the edit row fit, no page scroll
Python unittest     514 -> 521, all pass
benchmark.py 24/24 · bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures,
signatures, robustness, reference 24/24, assisted 70 · facts
```

## v4.0.0-dev — 2026-09-26 · Hearing a hitsound proposal before it is written

### Changed

- **The Propose card plays the proposal over the song before anything is written.** "Hear
  the proposal" puts the difficulty *as proposed* in the transport: the ticked proposals
  made to the map in memory, exactly as the write makes them, then resolved to samples as
  osu! plays the written file. It plays from the playhead, or, from the song's start, a
  second before the first sound that changes. The card says how many sounds play unlike
  the file and when the first falls.
- **File and proposal side by side.** The transport's "Hitsounds from" offers "<difficulty>,
  as proposed" next to the difficulty from Propose until a write, an undo or another
  difficulty, so the two can be switched while playing. Between a file and its proposal
  the old sounds play on until the new ones are in, so the switch leaves no gap. Ticking
  while the proposal plays is heard once the ticking pauses (a quarter second, one bridge
  call for a burst). A row's ▶ plays what the transport holds, so with the proposal in it,
  the sound as proposed; the object lane shows the proposal's additions.
- A song's samples decode once, not on every pick: their keys name files of the song's
  folder, the same for every difficulty.

### Fixed

- **An older hitsound pick could undo a newer one** (found reading the code, not seen in
  use). The transport checked whether another pick had come in only after a successful
  reply, so a refusal that arrived late turned hitsounds off under the pick that replaced
  it. A token now orders picks, refusal or not.
- **The Propose card counted objects and called them sounds.** Its write confirmation
  and toast take the number of object lines that change: "727 sounds" on Jester
  [Trynna's Hard], while the hearing line beside them said 979 sounds unlike the file
  (a slider is one line, and a sound per edge). They say objects now, and so does the
  preview, which said lines.

### Hardening

- A proposal that cannot be heard (none cached, or a sound moved since the decision) says
  why and leaves the file as written playing. Nothing is written by hearing: the bridge
  test checks the file's bytes, and that the proposal's playback equals the playback of the
  copy the write then makes (events, objects, samples, counts).

### Measured

```
heard == written, 800 local maps (758 standard, 21 taiko, 3 catch, 18 mania): random
proposals on 70 % of each map's sounds, half of them ticked
  the proposal's playback equals the written copy's on 799; different on 0; refused
  alike by both on 1 (an Aspire map whose 529 sliders of negative length leave no tail
  to place)
  545436 proposals, 273113 ticked, 262389 sounds heard unlike the file
Jester [Trynna's Hard], in the browser (harness, silent), EN and ES
  1311 proposals, 988 sounds unlike the file, the first at 2.969 s; the page's own count
  of changed events agrees; the copy written after it plays exactly what was heard
  10 unticks 40 ms apart: one bridge call; 1301 of 1311 ticked, 979 unlike the file
  file <-> proposal while playing: 30 polls during the switch, no empty track
  after a write, an undo, or a proposal the bridge refuses: the file as written plays
Python unittest     513 -> 514, all pass
facts
```

## v4.0.0-dev — 2026-09-26 · Constant scroll scales every green; section volumes keep the mapper's

### Changed

- **Constant scroll scales every green under a BPM change** by the reference over that
  BPM, so the mapper's own SV changes keep their shape at the reference's speed; before,
  only a green at the red line went in, and the map's next green undid it. A span that
  already reads constant (normalised by hand, or by a first run) is kept. **A map where a
  slider starts in a span it would scale is refused**: a slider lasts by the SV it starts
  under, so scaling it moves its tail and repeats off their beats. The card says how many
  and where. A second run is refused too, in any session: History keeps the scroll
  profile the write left, which kiai and volume writes do not change.
- **Section volumes keep the mapper's volumes.** A section where the map sets its own
  (at its start or anywhere inside) is left as it is; a section the map plays at one
  volume is set all the way through: its start, every green inside, a green at each red
  line inside (a red line carries its own volume), and a green giving the next section its
  own volume back. The scale hangs from the volume the loudest section plays longest, not
  the one at its start, and never goes under osu!'s 5 %. The card counts sections set,
  already right and left to the mapper, apart from the lines it writes.

### Fixed

- **Constant scroll moved slider ends.** Its first version wrote SV under sliders on 194 of
  225 local standard maps with BPM changes, while its card said sound never moves.
- **A green meant to follow a red line could land before it**: times were rounded to three
  decimals, and a lazer-precision red line at 17837.0114440535 got its green at 17837.011,
  then undid it. Greens written at a line's time now carry its exact time (kiai, volumes,
  scroll).
- **Nothing is written before a map's first red line**: osu! reads the first line's
  settings back to the song's start, so a green at 20 s before a first red line at 44 s
  became what the whole intro read, and a second volumes run rescaled the map from it.
- A fade 47 dB under the loudest section got volume 0.

### Measured

```
constant scroll, local maps with a BPM change, of up to 400 drawn per mode
  mania     117: written 100, refused for sliders 0,   out of range 8, constant already 9
  taiko     132: written 103, refused for sliders 18,  out of range 3, constant already 8
  catch      38: written 7,   refused for sliders 31
  standard  249: written 22,  refused for sliders 221, out of range 5, constant already 1
  slider or note times moved on written maps: 0 (the first version: 194 of 225 standard)
  a second run with no guard would have scaled 55 of 103 taiko and 63 of 100 mania maps
  again (their own green at each red line); History's scroll profile refuses it, and holds
  through kiai and volume writes on 400 of 400 maps
  Presti - Veritas [Vespere] (mania): the mapper's 0.85/0.87/0.90/0.92/0.95x, written for
  175 BPM, now read exactly so at the 170 BPM reference; 1591 notes unmoved
section volumes, 800 local maps cut in 20 s sections
  6480 sections: 1296 set all the way through (20 %), 193 at their volume, 4976 left to
  the mapper (77 %); a mapper's section changed 0; a set section not through 0; a second
  run changes 0
  Master of Tides [Master of the Seas]: 2 of 11 sections set, 1 at its volume already
  (with the 5 % floor); in [FinallyV's Extra] the 8 left to the mapper play the same
  volumes as before, read every 250 ms
median time a map   1.0 ms (scroll)
Python unittest     499 -> 513, all pass
benchmark.py        24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures, signatures, robustness,
reference 24/24, assisted 70 · facts
```

## v4.0.0-dev — 2026-09-26 · Harness pass: the 19 owed surfaces, and what they hid

### Changed

- **The 19 surfaces owed a browser pass were exercised in the browser pane**, on scratch
  copies of two local mapsets (Culprate & Skorpion - Jester, 5 difficulties, a steady
  172 BPM the precision engine reads; Lindsey Stirling - Master of Tides, 3 difficulties,
  which goes to the fallback), in both themes and both languages: every card previewed,
  every write applied to the copies and read back from disk, History diffing and
  restoring them. The first thing it found is its own entry: app.js did not load.

### Fixed

- **Kiai lit almost nothing on a real map.** It touched only each chorus's edges: the
  map's own greens inside a chorus carry a kiai bit (off) and switched it off at the first,
  and at a seam between two choruses the close sorted after the next open. Master of
  Tides read "Kiai on 9 choruses" and lit 4 % of the first. Touching choruses now light as
  one run, every point inside reads kiai, and the end gives back the map's own kiai.
- **Audio swap refused almost every encode with less silence up front**: it moved
  AudioLeadIn, a wait before the song, and "AudioLeadIn: 0" landed below zero. It also
  refused maps with a red line before zero, which osu! allows, counted greens as red
  lines, and listed the folder's hitsound samples as new encodes, so the card showed on
  every mapset with custom samples.
- **Re-snap offered a second move.** After moving 746 objects the card previewed 165 more
  against the map's old red lines; applying would have moved them twice. The bridge now
  refuses while the file holds what the re-snap wrote.
- **Ramps offered lines the engine itself turned down**: on real songs the fit cuts the
  attacks' jitter into two-attack grids at any BPM, and Use loaded them. Use now follows
  the engine's selector.
- **History** logged six tools as a bare "write" and missed the hitsound undo; its time
  column took the row while file names wrapped a word per line.
- **Messages**: "0 breaks into X: ." for nothing to write, a hitsound copy's toast naming
  the original, a raw "{file}" after a swap, a refused swap preview leaving the previous
  one on screen. Bookmarks, in both writers, keep osu!'s comma-only format.

### Hardening

- An old green line short of fields is padded with osu!'s defaults, not empty fields
  (osu! reads a character from them), and a line inserted into [TimingPoints] leaves every
  other line's own ending alone (kiai and section volumes).

### Measured

```
kiai, Master of Tides [FinallyV's Extra]  choruses lit before 0/0/0/0/54/0/48/0/90 %,
                              the old tool the same (4 % of the first); now 100 % of each,
                              0 % outside; 0 of 1876 sound events changed; a second run
                              writes nothing
audio swap, 3000 local maps   a timing line before zero 7.3 %, "AudioLeadIn: 0" 95.6 %;
                              refused at +40 ms 6.1 % -> 0.2 %, at -40 ms 96.0 % -> 3.0 %
                              (an object, preview or bookmark in the first 40 ms)
ramps on real songs           Jester 184 lines at 173-794 BPM, Master of Tides 71 at
                              16-459 BPM, both recommend_ramps false; the synthetic
                              ramp-120-160 16 lines at 121-159 BPM, recommended
re-snap, Master of Tides      746 moved; 165 more offered before, refused now
UI                            EN/ES tables 704 -> 714 keys each, same placeholders;
                              no raw key, empty {placeholder} or page overflow in the
                              10 sections (Spanish, 1280x800); the light theme looked at
                              in Structure, Mapset and History
Python unittest               492 -> 499, all pass
benchmark.py                  24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage, measures, signatures, robustness,
reference 24/24, assisted 70 · facts
```

### Found, not fixed (a decision each)

- **Constant scroll** writes greens only at red lines: after a BPM change the map's own
  greens stay relative to the new BPM, so the scroll holds only until the next green
  (5.5 s on a scratch map with a 140 BPM change). Rescaling every green needs a rule that
  keeps a second run from rescaling them again.
- **Section volumes** write only at section starts: the map's own greens (volumes 60, 70,
  85 in Master of Tides) take over at the next one, and a red line inside a section
  (Jester's intro) sets its own volume back. Overwriting a mapper's volumes is not this tool's call to make.
- **Ramps on real audio**: the lines are two-attack grids whose median, 344 BPM on a
  172 BPM song, is the atomic pulse's rate; only the selector keeps them out of the map.
- **Structure labels**: Jester reads as two sections (a 4 s intro, a 267 s "outro"); Master
  of Tides as 9 choruses out of 11, so kiai lights nearly the whole song. A bookmark lands
  at 0 ms for a section that starts with the song.

## v4.0.0-dev — 2026-09-26 · The app loads again: a merge had cut app.js short

### Fixed

- **app.js did not load** since 851f368 ("Bring section volumes to master"): the
  merge dropped the closing brace of `renderVolumes`, the browser stopped at
  "Unexpected end of input", and the window showed its frame with nothing behind
  it: no analysis, no section, no button. Every test stayed green, because none of
  them reads app.js. Found by the first harness pass since the merge.
- **`stxBmMaps` was declared twice** since cc9c249: the second, older copy won and
  dropped the Bookmarks card's reset when the song changes, so a preview of the
  last song's difficulty could still read as current.

### Hardening

- `AppScriptTests` read app.js as text: its brackets must balance (strings,
  template literals, comments and regex literals skipped) and no top-level name
  may be declared twice. Both fail on the old file, at the brace of line 2077 and
  on `stxBmMaps`. No JavaScript engine is installed here (Node is Phase 24), so
  this is a count, not a parse; it catches what merges drop.

### Measured

```
app.js at b094b2f             SyntaxError: Unexpected end of input; no function defined
app.js now                    loads; a real mapset (Master of Tides, 3 difficulties,
                              a scratch copy) analysed through the harness: 128.06 BPM
new tests on the old file     brackets [('{', 2077)]; declared twice ['stxBmMaps']
ids app.js reads              242, all present in index.html (checked once, by hand)
Python unittest               489 -> 492, all pass
```

## v4.0.0-dev — 2026-09-26 · Audio file card in Mapset

### Changed

- **Audio-file card in Mapset**: the folder's own audio with its facts
  (format, rate, channels, length, bitrate with its method, peak) and the
  findings behind it, or a clean bill. Read only, runs with the mapset
  check. EN/ES.

### Measured

```
synthetic mapset                WAV facts exact, no findings; missing audio refused
Python unittest                 467 -> 468, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages
                                cross-checked. Harness pass owed, stated.
```

## v4.0.0-dev — 2026-09-26 · Audio file check, engine half: facts plus stated bars

### Changed

- **`audio_file_report(path)`**: rate, channels, duration and exact PCM
  bitrate (file-size average otherwise, labeled) from the header; peak,
  clipped share and leading near-silence measured on the raw decode, never
  the peak-normalized analysis buffer. Findings carry the tool's own bars.

### Rejected / tried and dropped

- **Encoding ranking numbers.** The row says "against ranking rules", but no
  threshold was verifiable offline, so none is encoded: bitrate ships without
  a verdict, and the clipping, lead and rate bars are the tool's own, stated
  in the constants. A ranking cross-check stays future work with a criteria
  source in hand.

### Measured

```
synthetic WAVs                  1411 kbps exact, -6.0 dB peak, clipping flagged
                                at full scale, 2.5 s lead flagged, missing refused
Python unittest                 464 -> 467 (new suites green)
facts                           ok
```

---

## v4.0.0-dev — 2026-09-26 · Section volumes from Structure

### Changed

- **Volume card in Structure**: one difficulty's picker, preview counts
  (added, rewritten, kept) and a confirmed write greening each section to its
  energy volume — sets, samples and kiai never move, every file backed up
  first. EN/ES.

### Measured

```
synthetic map, verse/chorus     1 added at 35, 1 kept; written with backup,
                                second run all kept
Python unittest                 467 -> 469, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

## v4.0.0-dev — 2026-09-26 · Volume by section, engine half: loud sets the scale

### Changed

- **`set_section_volumes(beatmap, sections)`**: each section at the loudest
  section's volume scaled by their dB distance, written as greens — a green
  already at a boundary gets only its volume rewritten. The scale hangs from
  the volume in force at the loudest start, which the tool never touches, so
  a second run keeps instead of turning down again. Sets, index and kiai ride
  along untouched.

### Measured

```
verse -8 dB, chorus -14 dB      chorus green at 35 (70 x 10^(-6/20)), verse kept,
                                sounds identical, second run all kept
Python unittest                 464 -> 467 (writer suites green)
facts                           ok
```
## v4.0.0-dev — 2026-09-26 · Re-snap objects from Map check

### Changed

- **Re-snap card in Map check**: any `.osu` previewed (to move, times
  changing, staying with the first stayers listed) and moved with one
  confirmation, backed up first — then inject. Runs before injecting, while
  the map still has its old red lines; a second run writes nothing. EN/ES.

### Measured

```
synthetic map                 1 moved 1 staying in preview, written with backup;
                              second run 0 changed, nothing written
Python unittest                 477 -> 479, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```


---

## v4.0.0-dev — 2026-09-26 · Re-snap, engine half: snapped stays snapped

### Changed

- **`resnap_objects(beatmap, pairs)`**: object starts on the old grid move by
  their span's drift onto the same beat of the new timing — slider heads move
  with tails following the slider's own length, spinner and hold ends by the
  drift at their time. Off-grid objects stay put and are listed with nearest
  divisor and miss; times rewrite whole-millisecond over the files' own lines.

### Measured

```
+10 ms shift                   4 moved (circle, circle, slider head, spinner
                               with end), 1 off-grid listed, bytes otherwise kept
120 -> 150 BPM                  object at 1500 lands 1400, exactly
diff shapes                     inject_diff pairs feed resnap directly
Python unittest                 474 -> 477 (new suites green)
facts                           ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Snap divisors, one line per section in Timing

### Changed

- **Snap-divisors card in Timing**: read only, one line per section with its
  divisor and the thirds/sixths counts behind it. EN/ES.

### Measured

```
Python unittest                 473 -> 474, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · Snap divisors, engine half: thirds have to be loud

### Changed

- **`snap_divisors(analysis)`**: per section, every attack takes the coarsest
  1/1-1/16 grid within 15 ms and the section reads 1/6, 1/3 or 1/4 — the
  verdict following attack weight, with counts and weight shares reported so
  the mapper judges.

### Rejected / tried and dropped

- **Count-share verdicts.** The first cut read 6 of 34 corpus sections as
  1/3 or 1/6 on straight material. Probed: the drum samples re-trigger
  detection ~166 ms in, which lands on the triplet grid exactly when the
  tempo puts a third near it (120-132 BPM), all on one triplet slot; noise
  fills both. Count shares hit 20 % on echoes, weight shares stay under 7 %,
  so the verdict follows weight (10 % bar, 3 attacks). After the change 33
  of 34 read 1/4; the one 1/3 is shuffle-96, whose swung hats sit 4 ms off
  the triplet grid by construction — the honest mapping recommendation.

### Measured

```
synthetic thirds/sixths/quarters/swing   exact verdicts; tight tol recovers other
24-track corpus, 34 sections             33 read 1/4, 1 reads 1/3 (shuffle, by design)
Python unittest                          469 -> 473 (new suites green)
facts                                    ok
```

No writes anywhere in this change, so no backup logic; no analysis code
touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Constant scroll from Timing

### Changed

- **Constant-scroll card in Timing**: one difficulty's picker, preview counts
  against its first red's BPM and a confirmed write greening every BPM change
  away — sound, kiai and barlines never move, every file backed up first. EN/ES.

### Measured

```
synthetic map, 120 -> 150     1 added at -125, written with backup; greens read
                              exactly [-125]
Python unittest                 467 -> 469, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · SV normaliser, engine half: greens cancel the BPM

### Changed

- **`set_constant_scroll(beatmap)`**: the first red's BPM is the reference;
  every later red on another BPM gets a green carrying reference-over-own
  (red before green), a green already there kept or rewritten to the value,
  reference-tempo reds untouched and uncounted. New greens carry the audible
  state and the red's own effects, so sound, kiai and barlines read as before.

### Measured

```
120 -> 150 BPM               one green at -125 (150 x 0.8 = 120), sound_events
                             identical, second run all kept
Python unittest              464 -> 467 (writer suites green)
facts                           ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Inject diff beside every preview

### Changed

- **Diff in Export**: the single inject's confirm lists each changed red line
  (old → new with the drift at its span end, first 10 then a count, unchanged
  lines tallied), and every inject-all row shows its worst drift. Both
  previews carry the full pairs; the mapset engine reports them per file. EN/ES.

### Measured

```
synthetic maps                single preview 1 pair + 1 added; inject-all entries
                              carry pairs; bytes unchanged by previews
Python unittest                 463 -> 464, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages
                                cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · Inject diff, engine half: old beside new, drift included

### Changed

- **`inject_diff(osu_path, analysis)`**: the map's reds paired with the
  analysis' new ones by order — what the inject actually writes — each pair
  with both offsets, BPMs and meters, the deltas, and the drift an object at
  the old span's end lands off the new grid (exact given the pairing; None
  past the last line). Longer sides ride along as removed/added. Read only.

### Fixed

- Two of my own drafts before committing: the section scan broke out of the
  file before reaching [TimingPoints], and the test misread the fixture's
  green line as a third red — the drift it then "expected" was mine, not the
  code's (−49.89 hand-verified: 7 ms shift plus 12.8 s at −1 BPM).

### Measured

```
Python unittest              460 -> 463 (inject suites green)
facts                        ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Inject the whole mapset from Export

### Changed

- **Inject-all row in Export**: a preview listing every `.osu` beside the
  analyzed song (reds replaced and new, greens added, audio mismatches,
  unreadable files) and one confirmation writing them all — each file backed
  up first, one bad map never stopping the rest. EN/ES.

### Measured

```
synthetic 3-map set         2 ok 1 failed in preview, nothing written; apply
                            writes both with backups; bytes change, errors ride along
Python unittest                 458 -> 460, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · Inject everywhere, engine half: one bad map stops nothing

### Changed

- **`inject_mapset(folder, analysis)`**: every `.osu` in the folder through
  the same inject, dry-run or backed-up write — one bad map rides along in
  its own entry instead of stopping the rest. A missing folder or a folder
  with no difficulties refuses outright.

### Measured

```
Python unittest              456 -> 458 (inject suites green)
facts                        ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Breaks: quiet spans written from Structure

### Changed

- **Breaks card in Structure**: one difficulty's picker, a preview listing
  each span (time range, section kind) and a confirmed write adding
  `2,start,end` lines after `//Break Periods` — every file backed up first.
  A song with nothing quiet and long enough says so instead of writing. EN/ES.

### Measured

```
synthetic map, 1 quiet gap    1 span (10.0–30.0 s, chorus, −6.0 dB, 28.0 s gap),
                              written with backup; second run 0 added 1 kept
Python unittest                 454 -> 456, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · Breaks, engine half: quiet spans, cut on gaps

### Changed

- **`suggest_breaks(beatmap, sections)`**: sections 6 dB under the loudest,
  merged where adjacent, cut by the map's own sound gaps — only intersections
  5 s or longer become spans, each with its kind, depth and gap. Both bars are
  the tool's own and adjustable; the preview will show them, never a claim
  about the client's.
- **`set_map_breaks(beatmap, spans)`**: spans as `2,start,end` lines after
  `//Break Periods`, covered spans kept, zero-length spans and a missing
  [Events] refusing the map. Comments and blanks stay put.

### Measured

```
Python unittest              450 -> 454 (writer suites green)
facts                        ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-26 · Kiai: chorus spans lit from Structure

### Changed

- **Kiai card in Structure**: one difficulty's picker, preview counts (added,
  flipped, kept) and a confirmed write putting kiai on the chorus sections as
  green lines — sound never changes, every file backed up first. A song with
  no chorus says so instead of writing nothing. EN/ES.

### Measured

```
synthetic map, 1 chorus     2 added 0 flipped 0 kept, sound_events identical,
                            backup kept; greens read 1 at the open, 0 at the close
Python unittest                 448 -> 450, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-26 · Kiai, engine half: chorus spans as green lines

### Changed

- **`set_chorus_kiai(beatmap, spans)`**: each chorus span opens kiai at its
  start and closes it at its end — a green already at the boundary gets its
  kiai bit flipped, otherwise a new green carries the audible state in force
  there (SV, sets, index, volume), so nothing plays differently. A boundary
  whose kiai already reads right is left alone, so a second run is a no-op.

### Measured

```
Python unittest              446 -> 448 (writer suites green)
facts                        ok
```

No analysis code touched, so no benchmark run here.

---

## v4.0.0-dev — 2026-09-25 · Bookmarks: section starts, merged not replaced

### Changed

- **Bookmarks card in Structure**: one difficulty's picker, preview counts, and a
  confirmed write merging section starts into its editor bookmarks — the mapper's
  survive, every file backed up first. EN/ES.

### Measured

```
a real 3-map set, 11 sections   11 added onto 4 kept per map, 1 line moved each,
                                0 non-bookmark moves, backups kept
Python unittest                 444 -> 446, all pass
benchmark.py                    24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                              unit-tested bridge only; ids, both languages, no
                                duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-25 · Bookmarks, engine half: merge, never delete

### Changed

- **`set_editor_bookmarks(beatmap, times_ms)`**: whole-millisecond section starts
  merged into the map's own bookmarks, sorted — the mapper's survive, negatives
  dropped, junk refusing the map instead of vanishing silently. Only the
  bookmarks line moves. `[Editor]` is universal locally (500/500 maps), so a
  missing one refuses rather than invents file structure.

### Measured

```
Python unittest              442 -> 444 (writer suites green)
facts                        ok
```

---

## v4.0.0-dev — 2026-09-25 · Preview point: the chorus, or the loudest part

### Changed

- **`suggest_preview_time` in the Structure view**: the loudest chorus's start,
  the loudest non-intro/outro part's without one, each with its reason. Read
  only: a suggestion, never a write. EN/ES.

### Measured

```
4 real songs                   3 fall back to the loudest part (labels fire
                               rarely, as known); 1 with real choruses previews
                               the loudest one's start at 36.5 s
Python unittest                440 -> 442, all pass
benchmark.py                   24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                             one render line plus one string per language,
                               cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-25 · Percussion-only audition in the transport

### Changed

- **Percussion only toggle**: the HPSS stem through the same chunk transport as
  the song, cached per analysis, decoded and looped like the song with the click
  on top — judging timing against drums alone. The waveform lane follows the
  buffer, so it shows what plays.

### Measured

```
a real song, 90 s             HPSS 11.1 s once, cached; 99/99 strong attacks kept
                              within 50 ms on the stem; 12 % of the energy
Python unittest               438 -> 440, all pass
benchmark.py                  24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                            unit-tested bridge only; ids, both languages, no
                              duplicates cross-checked. Harness pass owed, stated.
```

No Rust resynthesis was written: the crate's HPSS stops at masks, and librosa's
reference HPSS is already a dependency. Porting ISTFT for parity's sake alone
would be code without a measurement behind it.

---

## v4.0.0-dev — 2026-09-25 · Offset lab: the blind test with an interval

### Changed

- **Blind test in the Offset lab card**: 18 trials, six shifts (±10/±20/±30 ms)
  against 0 in shuffled blind order, 6-second windows from the loop or first
  red line, both presentations heard before either vote counts. Per shift the
  wins with a Wilson 95 % interval; the preferred shift is the argmax, or
  nothing when 0 is unbeaten. Read only, one output-millisecond hook in the
  click scheduler (identity at 0), shift restored after every window and run.

### Measured

```
Python unittest              438, all pass (no new tests: client-side only)
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           ids, both languages, no duplicates, function
                             cross-checks. Harness pass owed, stated — this
                             one moves sound, so the debt matters more here.
```

Two bugs caught in review before commit: a call to a trial function that was
never written, and vote tallies with no entry for the zero side.

---

## v4.0.0-dev — 2026-09-25 · Offset lab: the file's delay, both decoders

### Changed

- **Offset lab card in Timing**: the analysed file's gapless numbers from its own
  header, and the first attack through each decoder side by side on its own
  button (two decodes under the one-job lock). EN/ES.

### Measured

```
first attack, Python vs    6 real songs: identical to 0.00 ms on all six — the
  Rust decoders            +26 ms reference bias is not a decoder difference,
                           so the lab points elsewhere (mapper convention)
Python unittest            436 -> 438, all pass
benchmark.py               24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                         unit-tested bridge only; ids, both languages, no
                           duplicates cross-checked. Harness pass owed, stated.
```

The blind listening test from the roadmap row is still to build.

---

## v4.0.0-dev — 2026-09-25 · Offset lab, engine half: the header's numbers

### Changed

- **`mp3_gapless_info(path)`**: the MP3's own gapless numbers — ID3v2 skipped,
  first frame found, MPEG version setting the Xing offset, LAME tag unpacked
  (delay and padding, 12 bits each at LAME+21) in samples and milliseconds at
  the file's rate. Anything without a LAME tag reports absent instead of
  guessed: nearly half the local folder has none.

### Measured

```
8,071 local MP3s               4,428 LAME tags (delay 576 in 4,393, 35 odd ones),
                               3,643 without; 0 errors, read only
Python unittest                434 -> 436, all pass
facts                          ok
```

---

## v4.0.0-dev — 2026-09-25 · Ramps in Timing: fit, price, use

### Changed

- **Ramps card in Timing**: drift and at-most-N inputs, Fit through the sidecar
  (cached per analysis and settings), the lines with offset, BPM and attacks,
  the count-against-drift trade-off with the recommendation beside it, and Use,
  which loads the lines as hand-placed points through the editor's own path —
  one undo, locks kept. EN/ES.

### Measured

```
Python unittest              432 -> 434, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           unit-tested bridge only; ids, both languages, no
                             duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-25 · Ramps, engine half: the curve as red lines

### Changed

- **`ramps.rs` + `overtone-cli ramps`**: longest least-squares grids back to back
  over the elastic beat indices, each keeping every covered attack within the
  drift — greedy, which is optimal for fewest segments under monotone coverage.
  `--drift` (default 5 ms) picks the rung, `--max-lines` takes the cheapest rung
  that fits, and the trade-off table (1/2/5/10/20 ms) prices every rung. The
  selector recommends ramps past degree 1 when the elastic residual beats the
  piecewise one, or when it found no sections at all.

### Fixed

- **Grids fitted through ghost notes.** The first version demanded every attack
  within drift of a beat, and off-beat 8ths snapped to their neighbour's index
  read as zero drift for standing still: a 120→160 ramp came out as 70 doubled
  lines of 3 attacks. Red lines anchor on strong attacks (half the peak and up,
  the alignment report's own bar); ornaments ride between. Same run now reads
  16 lines, 121 to 159 BPM.

### Measured

```
ramp-120-160, 5 ms           16 red lines, first 121.1 BPM, last 159.4 BPM,
                             worst drift 3.4 ms; tradeoff 31/23/16/11/8 lines
click track                  1 line at the tempo, recommend false
Rust tests                   256 -> 263, all pass, no warnings
golden 27/27 · elastic · facts
```

---

## v4.0.0-dev — 2026-09-25 · Audio swap: one shift for the mapset, in Mapset

### Changed

- **Audio swap card in the Mapset view**: the folder's encodes beside the mapped
  one, a preview with the measured shift (peak and tempo beside it) and per-map
  red/object counts, then a confirmed apply moving every time with backups —
  logged as swaps, so History diffs read past the move. Same-folder encodes
  only; storyboards stay where they were, stated.
- Bridge `swap_audios`, `swap_preview`, `swap_apply` behind it (EN/ES); heavy
  decode under the one-job lock; offset decimals follow the user's setting like
  inject, so stable maps stay whole-millisecond.

### Measured

```
Python unittest              430 -> 432, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           unit-tested bridge only; ids, both languages, no
                             duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-25 · Audio swap, engine half: one shift for a mapset

### Changed

- **Measuring the shift** (`shift_samples`, `audio_shift`): full cross-correlation
  at 11 kHz, parabolically refined, with peak, sharpness and an octave-aware
  tempo ratio beside it. Refuses a weak peak, a dull one, and any tempo past
  0.5 % — a different cut refuses on its peak before its tempo is even asked.
- **Moving the map** (`shift_osu_text`, `preview_audio_swap`, `apply_audio_swap`):
  red and green offsets, object starts, spinner/hold ends, PreviewTime,
  AudioLeadIn, bookmarks and optionally the AudioFilename; lines keep their
  shape, storyboards stay as parsed-nowhere (stated). Negative landings and
  missing sections refuse the whole set; every file is backed up and logged.
- History diffs read past the move: a swap entry compares backup-shifted
  against current, so the diff names real changes instead of remove-plus-add
  noise.

### Measured

```
synthetic shifts             +26.000 ms -> +26.018, -40.500 -> -40.498,
                             +123.456 -> +123.447, 0 exact
real music, known silence    +26.37 -> +26.38, -150, 0 and +5230 all within 0.005 ms
refusals                     150->165 BPM, nightcore-style pairs and different
                             cuts (peaks 0.01-0.11) all refused
a real 3-map set, +26 ms     717 lines moved, all backups kept, 43 ms;
                             red diff after the move: no changes besides it
Python unittest              425 -> 430, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

Two probe bugs died in the design probe, recorded so nobody re-derives them: an
FFT slice that cut the wrapped negative lags (keep the circular output whole),
and an 8 ms STFT envelope whose window alignment biased sub-frame shifts by a
full frame (compare the audio itself, downsampled).

---

## v4.0.0-dev — 2026-09-25 · Write history: list, diff, restore

### Changed

- **History section**: every `.osu` write the app made (inject, hitsound fields,
  full writes), newest first with operation, file, backup and summary; per-write
  red-line diff against the backup; confirmed restore that keeps the current file
  as a new backup first. Global like Library — no song needed. Bridge endpoints
  `history`, `history_diff`, `history_restore` behind it, EN/ES.

### Measured

```
Python unittest              422 -> 425, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           unit-tested bridge only; ids, both languages, no
                             duplicates cross-checked. Harness pass owed, stated.
```

---

## v4.0.0-dev — 2026-09-25 · Write history, engine half: every write logged

### Changed

- **Write log, restore and red diff** in the engine: `log_write` appends one JSON
  line per `.osu` write (inject, hitsound fields, full writes) with the backup
  holding the replaced bytes; `read_history` newest-first past torn lines;
  `restore_write` keeps the current bytes as a new backup before swapping the
  backup in atomically. `diff_reds` pairs offsets within 1 ms and names moved
  BPMs. A log that cannot be kept is skipped, never raised — history must not
  break writing. The suite points `OVERTONE_HISTORY_DIR` at scratch so writer
  tests never land in real history.

### Measured

```
Python unittest              417 -> 422 (writer suites green through the new hooks)
benchmark.py                 not re-run (no analysis code touched)
facts                        ok
```

---

## v4.0.0-dev — 2026-09-25 · Evidence view: the engine shows its alternatives

### Changed

- **`analysis_evidence(analysis)`** + the Timing card: per settled section its BPM,
  residual, coverage and inliers beside the coherence candidates the seed search
  read — BPM and coherence each, seeded marked, half/double readings and the octave
  margin (seeded minus strongest octave-away coherence) alongside. Using a candidate
  writes its BPM into the governing red line through `edit_apply`, so undo, locks
  and snapping behave as usual. Legacy analyses report no-attacks instead of
  alternatives. Candidate sweeps are ~350 ms a dense section, cached on the live
  analysis whose attacks no edit moves.

### Measured

```
Python unittest              414 -> 417, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           unit-tested bridge only; ids, both languages, no
                             duplicates cross-checked. Harness pass owed, stated.
```

Why-the-fallback-ran reads as far as the engine records it: the engine pill plus
`warn_legacy` for a fallback, the residual beside it. A forced-legacy run reads
the same as a fell-back one — the analysis stores no reason — so the card does
not invent one.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H5b surface: tick, preview, write, undo

### Changed

- **The Decide card in the Hitsounds section**: Propose runs the sidecar once and
  lists every proposal in the sounds table (bank + additions, ticked by default);
  All/None, Preview with counts, Write into this file or a copy after a
  confirmation, and Undo. Writing clears the (now stale) proposal cache and
  refreshes the report, the transport samples and the object lane. Per-row ▶ and
  full-song playback audition what is written; pre-hearing a proposal through the
  loaded samples waits for sample-key resolution, stated, not faked.
- Report sounds carry their edge, so units join them exactly.

### Fixed

- Four found in self-review before any commit: a duplicated element id between the
  preview button and its text, an early return leaving the card stale with no
  report, `hsvPick` clearing a live undo on post-write refresh, and preview/write
  without a file-match guard.

### Measured

```
Python unittest              414, all pass (bridge: propose/preview/apply/undo/copy)
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
UI                           unit-tested bridge only; every id resolves, every new
                             string exists in EN and ES, no duplicate ids. The
                             browser harness did not run from this session (no
                             browser tools here) — a harness pass is still owed
                             before this is called verified.
```

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H5b bridge: propose, apply, one undo

### Changed

- **Decision endpoints on the bridge**: `hitsound_decide_propose` runs the CLI once
  under the one-heavy-job lock and caches the units for accept/reject;
  `hitsound_decide_preview` counts on the cache without writing;
  `hitsound_decide_apply` writes in place with a backup or onto a must-not-exist
  `_hitsounded` copy; `hitsound_decide_undo` restores the replaced bytes atomically
  after backing up the current file — one level, stated. A moved map refuses at
  preview through the proposal's own staleness guard; no binary answers `no_rust`.
- `overtone_rust.hitsound(audio, osu)`: the sidecar call beside `analyze` and
  `structure`, same errors.

### Measured

```
Python unittest              409 -> 414, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

The accept/reject surface and audition ride the next commit, against the UI harness.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H5 engine half: the decision onto the map

### Changed

- **`proposal_changes` / `preview_proposals` / `apply_proposals`**: a decision's
  units as P-2 field changes — bank to sample sets, bits to additions keeping bit 0
  as H1 does, slider edges grouped with untouched edges keeping what they play.
  Volume, index and custom files are never touched (H4 proposes no values); a unit
  whose sound moved past 5 ms refuses the whole apply; preview counts on a copy;
  in-place writes keep inject's backups; copies require a must-not-exist dest and
  leave the source byte-identical.

### Measured

```
9 real songs, CLI decisions   every decided unit resolves exactly as proposed:
  applied to copies           5,856/5,856; 0 lines outside [HitObjects] moved;
                              0 volume/index changes; 15.4 s a song, CLI included
Python unittest               403 -> 409, all pass
benchmark.py                  24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4e: better than a rule, twice

### Changed

- **`bench/eval_proposals.py`**, the real-audio gate: `overtone-cli hitsound` over
  index-selected local maps, each proposal scored against the mapper's own sounds
  joined on (object, part, edge), medians over maps where the mapper uses the
  addition — the same ruler as P-6. One map per audio, bodies neither side,
  uncovered joins counted apart. `--offset` skips songs, after a bug skipped map
  rows instead (a set holds many difficulties of one audio) and the first rerun
  overlapped the first sample: fixed, rerun disjoint, the overlapped numbers
  superseded and not cited.

### Measured

```
two disjoint 11-map samples   clap F1 median 0.67 then 0.63 (rule 0.59);
  (1 opus undecodable)        finish F1 median 0.71 then 0.75 (rule 0.42);
                              whistle F1 0.81 and 0.77 (no rule proposes it);
                              uncovered joins 0; ~22 s a song through the CLI
Python unittest               400 -> 403, all pass
benchmark.py                  24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

Both samples clear both bars with margin except clap's lower quartile (0.56-0.62
against the rule's 0.59 median): the engine beats the rule on the typical map, not
yet on every map. That is the honest reading, and H5's editor exists for the rest.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4d: the synthetic gate, and three tunings it drove

### Changed

- **The synthetic exact-truth gate** (`grid_arrangement_decides_the_profiles_sounds`):
  a 150 BPM arrangement composed from the corpus renderer (kicks on and off beats,
  snares on backbeats, a crash opening bar 3, a rest under its ring), bare circles
  on every hit, known grid and bars. 19 proposals: kicks drum-bare, snares
  drum-clap, crash normal-finish, hats percussive-bare — exact, each miss naming
  its class.
- **The prior fires only where the mapper left a sound.** A +1.2 bonus for bare
  candidates on a bare map is a phantom intent vetoing the audio; on bare objects
  affinity, role and context now decide alone.
- **Claps want the backbeat band** (metrical weight 0.4–0.8), not any on-beat, and
  off-beat claps earn nothing by default: the old div-1 rule grew claps on downbeat
  kicks, the div-2 rule bridged them onto hats.
- **Streams are 16ths** (gaps under 0.15 s), not 8ths: at 0.25 the whole 150 BPM
  backbeat grid read as one stream and the −1.4 smoothed every addition bare.

### Measured

```
synthetic gate               19/19 exact (was: hats→drum, then kick+clap, then
                             snares smoothed bare, then a bridged hat clap and a
                             whistle — one tuning each, in that order)
Rust tests                   255 -> 256, all pass, no warnings
```

Hats still read kick-like (closed-hat held-out F1 0.40): the gate holds them to a
percussive bare bank, no additions, and says so. That is a template limit the
real-audio gate will judge, not pipeline behavior to tune around a third time.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4c: `hitsound` proposes every object

### Changed

- **`overtone-cli hitsound <audio> <map.osu> [--profile]`**: the full H4 chain —
  audio through attacks, tempo, structure and baked evidence, the map through
  `map.rs`, every decidable point (circles, slider heads/repeats/tails, spinner
  ends, holds) matched to its attack, scored, and Viterbi-decided, as JSON with
  proposal, marginal alternatives, emission terms and the incoming transition per
  unit. Ticks take nothing and bodies stay as they are (no format field, H5's to
  write); tails follow the decided object landing under them, else stay bare.
  Volume and index are not proposed. Bar slots and slider spans port the Python
  reader's rules (first grid extends back, greens set SV, reds reset it).
- The `analyze` front half is now one shared helper, reused unchanged by
  `hitsound-evidence` (its tests stayed green through the refactor).

### Measured

```
a click track, 12 circles    12 proposals; evidence 0.08 s + decide 0.00 s
Rust tests                   251 -> 255, all pass, no warnings
golden 27/27 · facts
```

The synthetic exact-truth gate and the real-audio gate against P-6's baselines
are still to run: nothing here claims the proposals are good yet, only that
every number in them replays from the computation.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4c: the Viterbi core

### Changed

- **`viterbi.rs`**: the second sum of docs/06 §6 — exact Viterbi over the 24
  candidates with pairwise transitions (switch cost waived on new combos and
  phrase edges, stream consistency inside fast runs, phrase symmetry one bar on,
  a one-step finish refractory), plus forward-backward marginals for alternatives
  and confidences. Wider windows stay out on purpose: they would break the Markov
  structure the exact DP needs.

### Fixed

- **The forward pass started at −∞**, so the first row poisoned the lattice and the
  backpointers walked home to the last state. The brute-force test caught it before
  anything leaned on it: row zero starts at 0, there being no previous state to pay.

### Measured

```
Rust tests                 246 -> 251, all pass, no warnings
DP speed                   not measured (O(n·24²); the CLI gate will time it)
```

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4b: profiles as data, emission scored

### Changed

- **`profiles/balanced.json`**, the affinity table and weights of docs/06 §6 as JSON
  (not TOML: serde_json is already a dependency), loaded strictly by `profile.rs` —
  an unknown class, bank or addition fails naming it, and a class with no affinity is
  refused instead of silently never firing.
- **`emission.rs`**: the first sum of §6 per object — instrument likelihoods through
  affinity (`inherit` resolving to the object's own bank, else the map default), role
  fit, combo emphasis, mapper prior — over 24 candidates (3 banks by 8 subsets, no
  pruning to hide behind), every score itemised term by term. Volume, index and the
  energy term wait for H5, stated here and in the profile. The metrical numbers in
  `role_fit` are starting points the gates will judge, not measurements.
- `match_attack`: the P-5 nearest-attack match for deciding per object.

### Fixed

- **A CRLF conversion one-liner emptied both new files.** `[open(f,'wb').write(..read..)
  for f in ...]` evaluates the truncating `open(f,'wb')` before the read. Both files
  were rewritten from the verified content and the tests re-run green. Conversions
  read first, write after, in separate statements from now on.

### Measured

```
Rust tests                 240 -> 246, all pass, no warnings
golden 27/27 · facts
```

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H4a: the `.osu` reader in Rust

### Changed

- **`overtone-hitsound/src/map.rs`**, the decision input: hit objects (circles, sliders
  with slides/length/edges, spinners, holds) with their sounds, timing lines with red
  vs green told apart as in the Python reader (negative length beats a lying flag),
  the map's sample set and slider multiplier. Read-only and minimal — no writer, no
  storyboards — and one rule from Python: a hand-broken line never hides the rest, so
  bad objects come back `Unparsed` and numberless timing lines are skipped. It lives
  in the hitsound crate instead of a new one: graduating it waits for the Phase 0
  port.

### Measured

```
agreement vs Python, local   25,171 maps, 12,101,556 objects: counts, times and
  Songs folder               kinds match on every object, 0 mismatches
Rust tests                   236 -> 240, all pass
golden 27/27 · facts
```

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H3 audio half: sounds over silence

### Changed

- **`hitsound_silence_check(beatmap, attack_times, attack_weights)`**: finishes and
  claps with no detected attack under them, matched through P-5, in the mod report
  beside the pattern breaks. Needs only the analysis attacks — no CLI run, no
  templates — so it rides the report's existing path. Bodies left out, no attacks at
  all judges nothing, advice never an edit.

### Measured

```
11 songs, evidence+matching   clap events: P(snare)+P(clap) median 0.138, deciles
  (P-4 probs at mapper claps) 0.016/0.045/0.138/0.363/0.611; T=0.10 alone flags 43 %
23 songs, analyze_audio       silence check: 17 of 23 maps with findings, median 1,
                              p90 12, max 21
unmatched by addition         whistle 2.2 %, finish 0.6 %, clap 1.1 %;
  nearest-attack distance     whistle median 66 ms, finish/clap over 70 % past 100 ms
Python unittest               397 -> 400, all pass
benchmark.py                  24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

### Rejected / tried and dropped

- **The clap-mismatch rule** ("a clap over an attack that sounds nothing like a snare
  or clap"). The templates this would judge with are proven only on synthetic drums;
  on 11 real songs they put the median mapper clap at P(snare)+P(clap) 0.138, and any
  readable bar accuses correct mapping by the dozen. This is the measurement P-6 was
  built for: the rule waits for H4's real-audio gate instead of shipping on a hunch.
- **Whistles in the silence check.** Unmatched whistles sit a median 66 ms from attacks
  — melodic overlap, not silence — so flagging them would mislead. Finishes and claps
  ship; the whistle stays out with its number attached.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds H3 map half: the pattern breaks

### Changed

- **`hitsound_consistency(beatmap)`**, the map-only half of the consistency check: on
  4/4 maps with 10+ claps, every beat 2 and 4 carrying a sound is set against the same
  beat of the 8 bars around it — no clap where 15 of the 16 neighbours clap is missing,
  a clap where 1 or none do is extra. All 16 neighbours must exist, so sparse maps and
  song edges stay silent. In the mod report as source "hitsounds", with the Report view
  filtering it like the other groups (EN/ES). Advice with the numbers, never an edit.

### Measured

1,000 local maps, 0 errors:

```
maps with findings           378; median 0 flags, p90 3, max 12: a modder reads that
threshold probe, 932 maps    15/16: p90 2+1, max 12+9; 14/16: p90 4+1, max 22+17;
                             13/16: max 30+21 — the plan's own 15/16 is the readable one
Python unittest              393 -> 397, all pass
benchmark.py                 24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

### Rejected / tried and dropped

- **A finish on an off-beat 16th, as an absolute-position rule.** Finishes off the
  downbeat are the norm, not the break: P-6 measures finish recall on the downbeat at
  0.54, so the rule would flag hundreds per map. Pattern-relative finish rules (an
  extra where neighbours hold none) stay future work, stated, not built on a hunch.
- **Weak-slot clap rules.** Same reason: no corpus number behind any bar, so no rule.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds P-4: evidence through the CLI

### Changed

- **`overtone-cli hitsound-evidence <audio>`**: per attack, the 13 class probabilities
  with each term's contribution (feature, value, response kind and knots, fitted
  weight behind it) and the attack's musical role, as JSON, with the sections, bars
  and phrase edges behind the roles. The calibrated weights ship baked into
  `overtone-hitsound/src/baked.rs` — shapes still from `initial_templates`, numbers
  generated from a fresh fit — and `baked_matches_fresh_fit` holds them bit-for-bit
  to it. It exits 0 where there is no grid: the instrument half never needed one,
  and the role degrades to nulls there.
- `evidence.rs` behind it, with `contributions_replay_the_scores`: bias plus the
  reported contributions is the reported score, term for term, so an explanation
  built on them explains the computation and not a copy of it.

### Measured

```
baked load                 0.036 ms, against 3.50 s for a fresh fit (~100,000x)
a real song (FLARE TV      1,496 attacks with evidence; decode 0.3 + attacks 0.2 +
  Size, 89.7 s)              tempo 0.2 + structure 0.3 + evidence 16.6 s; 16.6 MB of JSON
                           (13 classes with every term, per attack)
Rust tests                 233 -> 236, all pass
golden 27/27 · nogrid · density 4/4 + 0 FP · elastic · map · facts
```

The 16.6 s and 33 MB are the full-evidence price: every term of every class, before
H4 decides which alternatives it keeps. Slimming it (top-N classes) belongs to H4,
not here, and the entry will say so if it happens.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds P-6: the bar on real maps

### Changed

- **`bench/eval_hitsounds.py`**, the read-only evaluation the decision engine must beat:
  maps chosen from the library index (standard, 200+ objects, oldest first), the
  index opened read-only and refused on a newer schema, every `.osu` only read. Each
  sound event is one vote — the mapper's label against the rule's prediction — and
  events no rule can place (off the grid, another meter, no red lines) count apart.
  A map whose mapper never uses the addition is skipped for it: no recall of nothing.

### Measured

1,000 local maps, 0 errors, 37 ms a map:

```
clap on beats 2 and 4    928 maps with 20+ claps: F1 median 0.59, quartiles
                         0.42-0.71; recall median 0.54
finish on the downbeat    923 maps with 10+ finishes: F1 median 0.42, quartiles
                         0.34-0.50; recall median 0.54
whistles                 336,658, unscored: no simple rule proposes them, and H2
                         showed them mostly between sixteenths
Python unittest          388 -> 393, all pass
benchmark.py             24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
```

The "phrase starts" baseline the plan asked for is proxied by the downbeat — phrase
edges need audio structure, which a map-only script cannot read — and the script says
so instead of hiding it.

---

## v4.0.0-dev — 2026-09-25 · Hitsounds P-5: each sound's nearest attack

### Changed

- **`match_sound_events(events, attack_times, attack_weights=None)`**, the object-centric
  half of the hitsound evidence: every sound event takes its nearest attack by binary
  search, with the attack's time, its distance in ms and its weight. Past 50 ms from
  every attack — the alignment report's own bar — or with no attacks at all, the event
  comes back with `attack` None: "no attack here" is a state H3 will read for sounds
  over silence, never an error and never a guess. Slider bodies match at their start.
  Attack times arrive in seconds and read out in ms, like everywhere else.

### Measured

```
Python unittest            382 -> 388, all pass
benchmark.py               24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · facts
match, 2,000 events       21.6 ms total, 10.8 us per event (binary search, no per-event scan)
```

---

## v4.0.0-dev — 2026-09-24 · Hitsounds H2: the Hitsounds section

### Changed

- **A Hitsounds section** in the sidebar, read only, for one difficulty beside the song:
  - a summary: sounds, whistles, finishes and claps (with their share), the sample sets
    used, and how many samples come from the map and how many from Overtone;
  - **where the additions fall**: for each addition, its share on each sixteenth of the
    bar (1 e + a 2 e + a ...), read against the map's own red lines, one scale for the
    three so they compare, and the fewest sixteenths holding 80 % of it in a sentence
    ("clap 96 % on 2, 4"); sounds between sixteenths (triplets) and under another meter
    counted apart;
  - **every sound** with its time, bar and beat, part, additions, sets, index and volume,
    filtered by addition, 200 at a time; ▶ plays that sound alone with the samples the
    transport loaded, and a row puts the playhead a second before it.
- `hitsound_report(beatmap)` behind it: each sound's bar and sixteenth, and the
  distribution per addition.

### Measured

800 standard maps (200+ objects) from the local Songs folder:

```
errors                          0; 9.7 ms median a map, 146 ms at most
claps on beats 2 and 4          4/4 maps with 20+ claps (726): median 57 %, quartiles
                                41-73 %: the backbeat rule covers about half of what
                                mappers do, the bar the decision engine will have to beat
finishes on the downbeat        4/4 maps with 10+ finishes (685): median 55 %
additions between sixteenths    1.7 % (triplet snaps, mostly); under another meter 0.6 %
a real map (Violin Dance)       1,362 sounds; clap 96 % on 2, 4; finish 84 % on 1, 3;
                                whistle mostly between sixteenths (542 of 755)
Python unittest                 379 -> 382, all pass
```

---

## v4.0.0-dev — 2026-09-24 · Hitsounds P-7: the object lane

### Changed

- **An object lane on the timeline**, between the waveform and the drift lane, while a
  difficulty is picked in "Hitsounds from": circles as marks, sliders and spinners as bars
  from start to end, and under them each sound's additions in rows of their own
  (whistle, finish, clap), with keys in the legend. It follows zoom and pan like the other
  lanes, both themes, and goes away with "Off".

### Measured

```
addition colours          dataviz validator, all pairs on the canvas plot: pass in both
                          themes; green and yellow in the colour-blind warning band (6.9),
                          carried by their rows and the legend; the light yellow 2.1:1
a real map (Violin Dance) 946 objects (384 sliders) drawn; the lane zoomed to 60-68 s
                          reads object by object; "Off" gives its height back
Python unittest           379, all pass (the lane's data is held in the existing
                          playback tests)
```

---

## v4.0.0-dev — 2026-09-24 · Hitsounds P-3: hearing them, and warnings that fold

### Changed

- **Hitsounds in the transport**: "Hitsounds from" picks one of the song's difficulties,
  and its sounds play on the playback clock with the song and the click, at their own
  level (remembered). Each sound plays what osu! would find: its custom file alone; else
  per sample the beatmap folder's `<set>-hit<sound><index>` (wav, ogg, mp3); else
  Overtone's own. Slider bodies (the looping slide) are not played yet, and the status
  says so.
- **Overtone's own samples**, `assets/samples.py`: the three sets osu! has, four sounds
  each, synthesised with the standard library and a seeded noise source, so the committed
  WAVs regenerate byte for byte (a test holds them to it). osu!'s own defaults belong to
  ppy and are not ours to ship; a map's custom samples win over these.
- **Warnings fold by kind.** A song with many short sections put a banner per section
  above the tempo map. Findings of one kind now share one banner with the count, their
  points listed (folded) as chips that select the point; past three kinds, the rest
  fold behind a link.
- The Library's empty state is centred in the height it has, not 6 % from the top.

### Fixed

- **Samples the browser cannot decode.** A `.wav` whose header wraps Ogg Vorbis (format
  0x674F), which osu! plays and neither the browser nor libsndfile reads, came through
  silent. The bridge now hands over the Ogg stream inside it, which is intact.

### Measured

```
a real map (Violin Dance)   1,362 sounds; 2,053 samples from the map's own set, 506 from
                            Overtone's; 10 samples decoded, 1 silent before the Ogg fix
local .wav samples          first 20,000 read: PCM 18,093, float 1,745, not RIFF 138,
                            IMA ADPCM 11, Ogg-in-WAV 5, MS ADPCM 5, other 3
warnings                    18 findings of 5 kinds: 18 banners -> 3 and a link, 196 px
empty state, 1280x720       74 px above the block, 112 below (was 6vh from the top)
Python unittest             373 -> 379, all pass
```

---

## v4.0.0-dev — 2026-09-24 · A new look: "Console"

### Changed

- **The interface's whole look**, as asked: the panel of a measuring instrument instead of
  a soft dark app. Violet graphite ground, one signal-cyan accent (was mint), tempo in
  lavender, red lines still red (osu!'s own meaning) and amber still "check by ear". Flat
  panels with hairline borders instead of lifted gradient cards; squarer controls (radii
  3 to 12 px, pills only where something slides); pills became tags. Headings and the big
  readouts in **Bahnschrift**, the DIN that ships with Windows; small-caps labels with
  letter-spacing on stats, table heads and lists. Both themes, dark by default.
- **The logo** in the same palette: graphite tile, cyan trace, red line.
- Song sections take a new categorical set (blue, yellow, green), the hues no reserved
  meaning uses in this palette.

### Measured

```
text contrast, dark        text 13.1, muted 6.3, dim 4.5, accent 8.2, red 5.1, amber 8.4,
  (worst surface, :1)      tempo 6.2; ink on the accent button 8.5
text contrast, light       text 14.6, muted 6.1, dim 4.8, accent 4.6, red 4.6, amber 4.6,
                           tempo 5.3; ink on the accent button 5.6
sections, dark             dataviz validator, all pairs on --surface-2: passes; green and
                           yellow in the colour-blind warning band (6.9), carried by the
                           block labels and the table (secondary encoding)
sections, light            passes; yellow 2.06:1 on the lane, carried by the labels
browser, harness           Library, Timing (canvas), Structure and Settings on a real song,
                           dark and light; Bahnschrift resolves; dark is the default
Python unittest            373, all pass (the logo tests read the new panel and red)
```

### Rejected / tried and dropped

- **Sections in blue, orange and green**: green beside orange failed the colour-blind
  check (ΔE 2.7). **Magenta** sat 9.5 from the timing-point red, **orange** 10.3.

---

## v4.0.0-dev — 2026-09-24 · Hitsounds H1: the copier

### Changed

- **`copy_hitsounds(source, target)`**: every sound of the target (a circle, each slider
  edge, a spinner's end, a hold) takes the source sound at the same moment, within 5 ms:
  its additions, sample sets and index, and its volume when asked (off by default:
  volume is usually the green lines' job, and green lines are not copied). A slider's
  body takes the whistle of a source slider starting with it. Only sounds that would
  change are written, as the source's own raw values where those resolve the same way
  under the target's timing points, explicit values where they would not. A difficulty
  copied onto itself changes nothing.
- **Copy hitsounds, in the Mapset view**: the source difficulty, the ones to copy onto,
  and whether volumes come too; a preview per difficulty (sounds, with a source sound,
  that will change, with nothing under them, index conflicts) that writes nothing; then
  the copy, after a confirmation, each file backed up first. English and Spanish.

### Fixed

- **A slider's body change reached its edges.** A slider without its own edge fields
  plays its hitSound bits on every edge, so the writer, asked to take a whistle off a
  body, took it off the edges too. The writer now fills the missing edge fields with what
  they play before changing the body. Found by the copier's own measurement: 16 sounds on
  300 mapsets.

### Measured

300 local mapsets, in memory (nothing written): the most hitsounded difficulty copied
onto each of the others.

```
copies                     1,494; errors 0; a difficulty onto itself: 0 changes, all sets
sounds                     913,453 target sounds; 813,906 with a source sound (median
                           95.3 % per copy, 10th percentile 80.9 %); 106,605 changed
after the copy             every matched sound resolves like its source but for the
                           sample index: 26,034 (3.2 %), from green lines the target does
                           not share or slider edges whose index is their head's; the
                           copier counts them as conflicts (25,946)
time                       copy and apply 17.2 ms median, 131 ms at most
Python unittest            365 -> 373, all pass
browser, harness           a real 4-difficulty set, copied to a scratch folder: preview
                           (476, 537 and 381 sounds to change), copy, preview again (0
                           left); on disk only [HitObjects] lines changed (325-439 a file),
                           a .bak beside each target, the source untouched; ES strings
```

---

## v4.0.0-dev — 2026-09-24 · The interface on tokens, and a light theme

### Changed

- **Every colour, size and radius behind a token.** The stylesheet had 15 font sizes and
  no scale, 24 colours written into components, 20 more hard-coded in `app.js` for the
  canvas, and 31 inline styles. Now there are eight type steps, a radius scale, washes
  derived from their colour with `color-mix`, and canvas ink (`--chart-*`) read by
  `app.js` at draw time. The inline styles left are the data-driven ones: widths and
  positions.
- **A light theme** (Settings → Theme: System, Dark, Light; Dark stays the default, so
  nobody's window changes on an update). It is the same token set with light values,
  canvas included; "System" follows Windows' app mode, live.
- **One keyboard focus ring** on every control, where two had one.
- **A project skill for checking the UI** (`.claude/skills/overtone-ui-check`): the
  harness, silent from the first frame, the pane's width, both languages, and cleanup.

### Fixed

- **Structure painted sections in reserved colours**: chorus in amber (check by ear),
  bridge in red (timing points). Sections now have their own categorical set, labels in
  text ink and colour on a wash and a top rule.
- **Caption text was under 4.5:1**: `--dim` measured 3.4:1 on the dark surfaces. It is
  4.5:1 or more on every surface of both themes now, axis labels included.
- The Structure table wrapped its lengths and "no proven bar" readouts onto two lines.

### Measured

```
section palette, dark     dataviz validator, all pairs, on --surface-2: every check passes
  (blue, orange, aqua)    (worst colour-blind ΔE 9.4, worst normal 20.9). Tried and failed:
                          magenta beside orange (normal ΔE 11.6), violet beside blue
                          (colour-blind ΔE 1.9)
section palette, light    every check passes; aqua 2.67:1 on the surface, carried by the
                          block labels and the table (the validator's relief rule)
text contrast             dark: text 15.3, dim 3.4 -> 4.5-5.2; light: text 17.3, muted 6.4,
                          dim 4.6-5.4, accent 5.0, red 5.3, amber 4.9, blue 5.7 (:1)
browser, harness          Timing, Structure and Library in both themes, a real song; the
                          canvas repaints on a theme change; System follows the OS in
                          both directions; Tab reaches the focus ring; no console errors
Python unittest           364 -> 365, all pass
```

### Rejected / tried and dropped

- **Keeping the light palette in a `prefers-color-scheme` block too.** It would have
  been written twice. `app.js` resolves "System" to dark or light instead, so the
  stylesheet holds one light block.

---

## v4.0.0-dev — 2026-09-24 · Hitsounds P-2: a writer that touches only hitsounds

### Changed

- **`set_object_hitsounds(beatmap, changes)`** changes an object's hitSound bits, sample
  (sets, index, volume, file) and a slider's per-edge sounds and sets, and nothing else. A
  line whose values do not change keeps its exact text. A slider given a sample but no
  edge fields gets them filled with what its edges already play, so the new fields change
  no sound. Values osu! cannot read are refused before anything changes.
- **`write_object_hitsounds(path, changes)`** does it on disk as edits over the file's own
  text: each changed line is replaced where it stands, with its own line ending, and every
  other byte stays. No change, no write. Atomic, backed up by inject's rules.

### Fixed

- Found while measuring, not fixed here: the section-level writer (`write_osu_beatmap`)
  turns a stray LF inside a CRLF file into CRLF, 1 map in 3,000. The hitsound writer does
  not go through it, for that reason. Handed to its own task.

### Measured

3,000 maps from the local Songs folder, on copies; every object's clap flipped and its
normal set changed, then restored:

```
maps                          2,998 (2 hold a sample set of 43, which the writer refuses)
lines changed by the flip     object lines only, every line ending kept: 2,998 / 2,998
sound after restore           identical to the original: 2,998 / 2,998
bytes after restore           identical: 1,673; the rest gained explicit slider edge
                              fields or a full-form sample, which sound the same
write, full flip              21.9 ms per map
Python unittest               358 -> 364, all pass
```

---

## v4.0.0-dev — 2026-09-24 · Hitsounds P-1: what each object plays

### Changed

- **`sound_events(beatmap)`**, the first prerequisite of `docs/15-hitsound-plan.md`: every
  object as the sounds osu! plays for it. Circles and mania holds sound at their start,
  spinners at their end. A slider sounds at its head, every repeat and its tail, each with
  its own edge sounds and sets, and its body carries the slide. Each sound is resolved
  (object value, else timing point, else the map's `SampleSet`; additions follow the
  normal set; index and volume of 0 inherit; a custom file plays alone), and keeps the raw
  values beside the resolved ones, so a copy writes what the map wrote.
- Where the format leaves a rule open, it follows osu!lazer's legacy decoder and says so:
  a sound reads the timing point in force 5 ms after it. Stable's rule is not verified.

### Measured

3,000 standard maps from the local Songs folder, read only:

```
errors                      0, over 2,604,536 sound events
time                        5.3 ms per map (reading the .osu: 16 ms)
slider lengths              201 of 564,412 sliders (0.04 %) end past the next object's
                            start, all in 7 maps built on overlaps (math tests,
                            minigames, a debug map): the lengths hold
Python unittest             353 -> 358, all pass
```

---

## v4.0.0-dev — 2026-09-24 · Mixed line endings survive the beatmap writer

### Fixed

- **A map with mixed line endings changed on a write that edited nothing.** The section
  reader split lines with `splitlines()`, which drops each line's ending, and
  `beatmap_text` joined them all with one `newline` (CRLF whenever the file held any). A
  CRLF map with one bare LF, as in "575767 BTS - Not Today", came back with that LF turned
  into CRLF, breaking rule 5. `inject_osu_timing_points` already kept each line's own
  ending; the reader and writer now do too:
  - `read_osu_beatmap` records each line's ending: `head_endings`, and a section's
    `endings` beside its `lines` plus `header_ending`.
  - `beatmap_text` writes each line with its own ending. A line with none on record (one
    added since the read) takes `newline`. The file ends with a line break exactly when
    it did.
  - `set_beatmap_reds` keeps the ending of every line it does not replace. The k-th new
    red takes the k-th old red's ending; reds beyond the old count take `newline`.

### Measured

Local Songs folder, read only (every `.osu`, nothing written):

```
maps read                          25,171; 14 mix line endings (4 mapsets)
read -> write, no edit             before: 14 differ (exactly the 14 mixed)   after: 0
read -> set_beatmap_reds(its own   before: 14 change a line that is not a red,
  reds) -> write                     or a red's ending                         after: 0
read_osu_beatmap, 250 maps         8.4 -> 9.0 ms per map (+8 %); beatmap_text 0.12 ->
                                   0.34 ms. Maps are read one at a time (the library
                                   index does not use this reader)
Python tests                       353 -> 354, all pass; benchmark 24/24, median
                                   0.0000 BPM and 0.16 ms; every Python gate green
```

The second row checks everything outside the reds, byte for byte, with each red's ending.
It does not compare whole files: `set_beatmap_reds` moves all reds to where the first one
stood, by design.

---

## v4.0.0-dev — 2026-09-24 · Hitsounds first: the plan

### Changed

- **Hitsounds move to the top of the pending list**, as the most requested feature.
  `docs/15-hitsound-plan.md` lists what exists, the seven prerequisites that must land
  first (P-1 to P-7) and five steps that each ship alone, from a hitsound copier that needs
  no audio analysis to the decision engine, which needs everything else.
- Two corrections to `06-hitsound-engine.md`, recorded in the plan: slider ticks take no
  additions (the format has no field for it), and profiles are JSON (a dependency already
  in the build) rather than TOML.

### Measured

```
local Songs folder, 400 standard   additions on > 5 % of objects: 376 maps (94 %);
maps of 200+ objects (of 18,179)   sliders with per-edge sounds: 377 (94 %);
                                   a custom sample index on an object: none
```

---

## v4.0.0-dev — 2026-09-24 · Structure, a sidebar section

### Changed

- **`overtone-cli structure <audio>`**: phrase boundaries, section labels and the energy
  lane as JSON. The structure and classify stages existed in the DSP crate with no way
  out of it; the app runs this command as it runs `analyze`.
- **Every label carries its evidence.** `classify` labels by rules that read three things
  (which segments repeat, how often, how loud), and each section now reports them:
  repetition group by first appearance, repeats, and level in dB under the loudest
  segment. A caller can say why a section is a chorus instead of asserting it.
- **The Structure view** (Phase 19): the song's sections over its energy lane, each with
  its start, bar, length, family letter (A, B, ... by first appearance), level, the rule
  that labelled it with the numbers that rule read, and how far its edge moved. Edges
  snap to the nearest proven bar line (a bar the accents proved or the mapper set)
  within 1.5 s, and re-snap on every visit, so an edit in Timing moves them. A section
  opens in Timing, the timeline zoomed to it and the playhead at its start. The Rust
  engine reads the audio once per file. English and Spanish.
- When every section reads as one family, the view says so, and why: the labels cannot
  tell verse from chorus there, while the edges and the energy still hold.

### Measured

8 songs from `C:\osu!\Songs` (91-311 s), release build:

```
structure + classify    0.53-2.10 s per song; with decode, 0.98-2.74 s wall
labels on real mixes    6 of 8 songs: every section one family (all Verse, or Verse
                        and an Outro); 1 split verse/chorus by level; 1 Bridge + Outro.
                        Whole-mix chroma looks alike across a pop song's sections, so
                        the repetition rule rarely separates them: the labels are
                        weak on real audio, the boundaries and the energy are not
Rust tests              231 -> 233, all pass; golden 27/27
snapping, 20 songs      against ranked maps' own bars (one red line each, 84 inner
                        edges): all 84 found a bar within 1.5 s, median move 258 ms,
                        max 733 ms; 26 of 84 (31 %) on a 4-bar line from the first red
                        line, against 25 % by chance. The nearest bar is a bar near the
                        change, not the phrase's first bar, and the view says so
browser harness         Structure on a real song (11 sections, no proven bar: every
                        edge left unsnapped and marked), a section opening in Timing,
                        EN and ES; nothing played
Python unittest         346 -> 353, all pass
```

---

## v4.0.0-dev — 2026-09-24 · The Songs folder, indexed and searchable

### Changed

- **A second language joins, SQL, for the library index** (Phase 24; the first pick of
  `docs/14-other-languages.md`). `overtone_library.py` keeps every beatmap of an osu! Songs
  folder in one SQLite file under `%LOCALAPPDATA%\Overtone`: set, difficulty, artist and
  title (romanised and Unicode), creator, source, tags, mode, audio file, red line count,
  first BPM and object count.
  - The schema is `library.sql`, one file with its version on a comment line. The code
    refuses a database from a newer schema, and `facts.py` fails when the file and the
    code disagree.
  - FTS5 full-text search: every word typed, each as a prefix, accents ignored. What the
    user types is quoted, never read as FTS5 syntax.
  - A rescan reads only the `.osu` files whose size or modification time changed, and
    drops the rows of files that are gone. It commits every 100 folders, so a scan
    stopped halfway resumes from there.
  - Same-audio lookup: audio of the same size, hashed once and the hash kept.
- **The Songs browser** in Library: Scan / Rescan with folder progress, search as you
  type, and a set opens like Import folder does. English and Spanish.
- **Maps of this song, from the index.** Reference timing's same-audio search answers from
  the index when it covers the Songs folder and finds a map. When it finds none, the
  folder is walked as before, so a map added after the last scan is still found; a listed
  `.osu` deleted since the scan is left out.

### Hardening

- The index is derived data: the Songs folder stays the truth, and deleting the file
  loses only the next scan's time. A file that is not a database is refused with a
  message, not a crash.
- The header reader decodes [General], [Metadata] and [TimingPoints] only. Storyboards in
  [Events] are skipped, hit objects only counted, and undecodable bytes become U+FFFD
  instead of hiding the map.

### Measured

On `C:\osu!\Songs`, read only: 4,799 folders, 4,797 sets, 25,171 maps, 705 MB of `.osu`.

```
header reader vs read_osu_beatmap   25,171 / 25,171 maps agree: artist, title, difficulty,
                                    tags, audio file, red lines, first BPM, objects
first scan, first read of the files 437 s, once. Not explained: C: is an SSD and warm reads
                                    of all 705 MB take 3-4 s; a per-file first-open cost
                                    (antivirus?) is a guess, not measured
full scan, warm                     13.3-18.5 s over 5 runs (26.6 s before the rework below)
rescan, nothing changed             0.83-1.04 s
search, 7 queries                   4.7-65 ms median; "a", which matches nearly every map, 65 ms
index file                          25 MB
same-audio, 6 songs (3 sharing a    walk 1,042-1,515 ms; index 21-167 ms the first time
  size with another audio file)     (hashing), 2.9-4.9 ms after; same matches for all 6
browser harness                     scan with progress, search, open a set, EN and ES.
                                    Its own event polling slowed its scans (74 s, 30 s):
                                    a harness number, not the app's
Python unittest                     335 -> 346, all pass
```

### Rejected / tried and dropped

- **`^`-anchored multiline regexes** for section headers and object lines. They give the
  regex engine no literal to jump to, so it tries every position of 705 MB. Anchored on
  `\n`, and with `[HitObjects]` found by a plain byte search, the header pass went from
  20.2-23.4 s to 10.1-11.6 s.
- **`_parse_red_line` per timing line**, a numpy scalar per line on about a hundred lines a
  map. The one-pass counter drops green lines on their flag first; it halved that
  function's profile share, but the wall time moved within noise. It stays because it is
  exact (a test holds it to the parser on the edge cases) and it is the loop that grows
  with the maps.

---

## v4.0.0-dev — 2026-09-24 · A window icon that reads at 16 px

### Fixed

- **The icon was broken at every size but 256.** `assets/logo.py` drew each size with the
  256-px geometry: corner radius, stroke widths and the red line in absolute pixels.
  - At 16 px the radius was larger than the icon, and the title bar and small taskbar
    icons showed a red corner fragment.
  - At 32 px the mark came out cropped.

  Every size is now drawn at its own size, from geometry scaled to it. Below 32 px the
  mark is simpler: the fundamental alone, thicker, and a red line on whole pixels.
- **Frames Windows' title bar could not read.** The small entries were PNG-compressed, and
  .NET Framework's `System.Drawing.Icon` (pywebview sets the window icon through it) does
  not read PNG frames: asked for 256, it fell back to 64. Entries under 256 are 32-bit BMP
  now, and the .ico holds 16/20/24/32/40/48/64/256, every size Windows asks for at 100-200 %.
- **The taskbar showed the Python logo.** Windows groups a window under its process's
  application id, and a process without one falls under its executable: `pythonw.exe`.
  Both windows now claim `Overtone.TimingWorkbench` before they open, and the taskbar
  takes the window's own icon.

### Measured

```
.NET Icon(path, 16/20/24/32/48)  each loads at its size: red line pixel (224, 96, 108),
                                 panel (21, 28, 41) at 16-24
LogoIconTests (2 new)            fail on the old .ico, pass on the new one
Python unittest                  332 -> 335, all pass
```

---

## v4.0.0-dev — 2026-09-24 · Settings, in one place

### Changed

- **Settings** is its own sidebar section:
  - the output folder, `Documents/Overtone/<song>` by default, asked or not;
  - offset precision, from whole ms for osu!stable up to 3 decimals for osu!lazer, used by
    copy, `.osz` and inject;
  - clicks per beat (1-4) and the bar accent, for the app and the WAV;
  - interface size (80-150 %) and reduced motion;
  - the cache, with a clear button;
  - what the backups keep.

  Detection stays in its drawer, one button away.
- **The click has levels**: bar, beat and subdivision, in three tones, the same in the app
  and in the WAV.

### Fixed

- **Under the interface size**, the tempo map read the pointer 20 % off at 120 %, so a red
  line could not be caught. The pointer is taken in the canvas's own pixels now; at 80,
  100 and 120 % it lands within 0.5 px.

### Rejected / tried and dropped

- **Timestamped backups.** Every state is already kept: `.bak` stays pristine, and later
  states go to `.bak2`, `.bak3`… Timestamps would only rename them.

### Measured

```
1/2 clicks per beat           clicks rebuilt at once: 0.310, 0.517, 0.724 s, levels 2 0 1
2 decimals                    copied first line 310.14
pointer at 80 / 100 / 120 %   within 0.5 px of the red line (was 57 px off at 120 %)
Python unittest               325 -> 332, all pass
benchmark.py 24/24 · bpm-snapshot · golden.py 27/27 · coverage · measures · signatures
robustness · reference 24/24 · assisted 70/70 · facts
```

---

## v4.0.0-dev — 2026-09-24 · The tempo map becomes a timeline

Phase 3's timeline rows, on the canvas the app already had.

### Changed

- **Zoom and pan.** The wheel zooms at the cursor, down to half a second. Dragging pans,
  and "Show all" resets the view.
- **Two lanes under the tempo curve.**
  - The waveform, built from the audio the page already decodes for playback: min/max per
    256 samples, once per song.
  - A drift lane: each attack's distance from the nearest 1/1-1/4 tick of the red line
    governing it, green within 5 ms, amber within 15, red past.
- **The beat grid** appears once beats are 7 px apart, bars brighter.
- **Drag a red line.** It snaps to an attack within 6 px, and Alt moves it freely. The drag
  goes through the editor's own `edit_apply`, so it is one undo, and a locked line stays.
- **The compared map's red lines** appear as dashed ghosts: from the reference card, else
  the compare card.
- **The payload carries the detected attacks**, which the snap and the drift lane read.

### Rejected / tried and dropped

- **Double-click to add a red line**, as the roadmap row had it. Double-click already plays
  from that point, and the editor adds.
- **A binary transport** for the waveform. The song already reaches the page once, as
  base64 chunks, for playback, and the page builds its own peaks from it.

### Measured

These ran in the built-in browser on the real bridge, silently: the audio graph was routed
through a gain of 0.

```
wheel -500 at x=400        span 68 -> 32.121 s (exp(-0.75)), time under the cursor unchanged
pan 100 px                 -3.6668 s as computed; the click ending it selected nothing
drag 40 ms, no attack      24310.1 -> 24349.7 ms
dropped 3 px from attack   exactly 24704.74 ms, the attack
Alt                        free, within one pixel (1.7 ms at that zoom)
secs-3 drift lane          333 of 342 attacks within 5 ms; 9 weak ones (~0.2) at +28.3 ms
                           every 6.6 s: the generator's ornaments, not a timing error
Python unittest            324 -> 325, all pass
benchmark.py 24/24 · bpm-snapshot · golden.py 27/27 · coverage · measures · signatures
robustness · reference 24/24 · assisted 70/70 · facts
```

---

## v4.0.0-dev — 2026-09-24 · Taps, the slow loop, and why its pitch drops

The rest of Phase 4, but for the percussion-only audition.

### Changed

- **Speed**: 100 / 75 / 50 %, for the song and the section loop; the click keeps its own
  pitch and lands at t / rate.
- **Taps** (T, or the Tap button, taken on pointerdown). Each tap is placed at the song
  time that was sounding when the key went down. `getOutputTimestamp` ties the page's
  clock to the sample leaving the speakers, so the output latency drops out. The tap row
  shows:
  - how many taps;
  - the tempo of the last unbroken run: beats numbered from the median gap, then a
    least-squares line through them;
  - how far the taps land from the click.
- **Tap latency calibration.** Key travel, the hand and the ear are the person's own delay.
  "Calibrate to these taps" measures it against the click and remembers it, up to 250 ms.
- **Assisted timing from taps.** A run that starts on a downbeat becomes the card's marks,
  and the card fits.

### Rejected / tried and dropped

- **A pitch-kept slow loop**, as the roadmap asked. The loop is for judging attacks, and a
  pitch-kept stretch moves them. librosa's phase vocoder, on 12 s of secs-3, put strong
  attacks a median 23-24 ms late at 75 % and at 50 %, and lost some at 75 % (p90 262 ms).
  The loop is resampled instead: the pitch drops, and every attack stays exactly at
  t / rate, crisp. A WSOLA stretch keeps attacks sharper but moves each one by up to its
  search window; it was not measured.

### Measured

These were measured silently. Everything bound for the speakers went through a gain of
0, and the signal was recorded sample by sample before it.

```
50 % from 20 s, 4.5 s of real time     song advanced 2.22 s; clicks 0.014-0.032 ms off
                                       the schedule; attacks against clicks -0.19..-0.13 ms
12 synthetic taps, 20 ms late          read 26.4 ms: the test's timers fire 5.8 ms late on
                                       average; against each event's true time the
                                       mapping errs -1.07..+0.41 ms; tempo 145.016 (145)
after "Calibrate", 12 more             +0.46 ms (sd 5.9)
"Use for assisted timing"              marks 8593 / 11895 ms, 2 bars -> 145.000 BPM,
                                       red line at 310 ms (the true start)
phase vocoder, strong attacks          median 23-24 ms late at 75 % and 50 %; p90 262 ms
                                       at 75 % (attacks lost)
Python unittest                        323 -> 324, all pass
benchmark.py 24/24 · bpm-snapshot · golden.py 27/27 · coverage · measures · signatures
robustness · reference 24/24 · assisted 70/70 · facts
```

---

## v4.0.0-dev — 2026-09-24 · Playback in the app, and a click track that clicked changes twice

Phase 4's first half: the song with a live click from the current red lines, inside the
app. Tapping and the slow loop are next.

### Changed

- **Transport** under the tempo map:
  - play and pause (Space), a position bar, play from the selected red line;
  - double-click the map to play from there;
  - loop the section under the playhead;
  - song and click levels, remembered;
  - a playhead drawn on its own layer over the map.
- **One clock.** The song and the click leave through one AudioContext, and every time
  derives from its clock. Clicks are scheduled 150 ms ahead from the payload's
  `click_schedule`, read on every tick, so an edit is heard on the next beat. The loop is
  the buffer source's own, and the click is folded into it.
- **The song reaches the page** as its own bytes, in 1 MiB chunks, for the browser to
  decode. Where the browser cannot (AIFF), it gets Overtone's own decode as a WAV. The page
  names no path; only the analysed file is served.
- **No click latency offset**, though the roadmap planned a calibration. The click cannot
  drift from a song on the same clock. Latency matters for tapping, and is left for it.

### Fixed

- **Each change of tempo clicked twice** in the exported click track, and so it would have
  in the app. Each red line clicked up to and onto the next line, which then clicked its
  own first beat. On the old grid that made one tone at double level: peak 0.90 against
  0.45 elsewhere. Off it, two clicks milliseconds apart. `click_schedule` stops each line
  short of the next.
- **A NaN level passed as silence**: `max(0.0, nan)` is 0.0 in Python, so clamping ran
  before the finiteness check. The check comes first now.
- Two slips caught in the browser. The play/pause icons are SVG, which has no `.hidden`
  property, so they never switched. The playhead did not redraw after a stop in a hidden
  window, where animation frames pause.

### Measured

Played in the built-in browser on the real bridge (a local harness, not committed). The
output was recorded sample by sample with an AudioWorklet: song on one channel, click on
the other.

```
secs-3 from 20 s for 8 s, across its 145 -> 152 BPM change
  19 clicks against the schedule          0.03-0.07 ms
  drum attacks against the clicks         -0.17..+0.11 ms, median -0.13
section loop 24.31-46.02 s, from 45 s across the wrap
  clicks                                  45.231, 45.626, then 24.310, no double at the seam
  attacks against clicks, 9 beats         -0.23..+0.04 ms
152 BPM line edited to 160 while playing  playback went on; next beats 0.375 s apart (60/160)
Space pause at 39.37 s, Space again       resumed from 39.37 s
AIFF excerpt                              browser refused it, Overtone's WAV played (20 s)
Python unittest                           316 -> 323, all pass
benchmark.py 24/24 · bpm-snapshot · golden.py 27/27 · coverage · measures · signatures
robustness · reference 24/24 · assisted 70/70 · facts
```

These checks played through the PC's speakers, and the person at the PC asked about it.
Later checks ran with the context suspended and the output disconnected, and the checks
after that were silent.

---

## v4.0.0-dev — 2026-09-24 · The Report section, and a snap tolerance that was two constants

The last of the first five sidebar modes. Building it on real maps found a snap audit that
flagged ranked maps' rounding, and a constant defined twice.

### Changed

- **Report** (new sidebar section). Choose a `.osu`, and every finding about that difficulty
  is listed in time order, as a modder posts them:
  - red lines to check, with their error;
  - map-wide notes (the common shift, a split with no majority) under "General";
  - tempo changes the map has no red line for;
  - objects off the map's grid, before its first red line or past the audio;
  - objects away from any attack.

  Timestamps carry the combo numbers the editor counts, and each one opens the local osu!
  editor through `osu://edit/`. The link is built only from a validated timestamp, so
  nothing else reaches the shell. A group can be left out, and "Copy all" copies what is
  shown. The lines are English, as mod posts are.

### Fixed

- **`SNAP_TOLERANCE_MS` was defined twice**, once for export snapping and once for the snap
  audit, and the later definition silently set both. Raising the audit's would have moved
  exported red lines. The audit's is now `OBJECT_SNAP_TOLERANCE_MS`, and a test pins export
  snapping to its own 1 ms.
- **The snap audit called ranked maps' rounding unsnapped.** osu! stores whole milliseconds
  against a red line whose beat is fractional, and a Monstrata map showed five objects
  1.1-1.2 ms off. On 61 ranked maps, 272 of 30,553 objects sat 1-2 ms from a tick and 5 past
  2 ms. The audit's tolerance is now 2 ms.
- **"ms from the nearest sound"** read 4941 ms on a soft intro. That is what the detector
  missed, not where the music is. It now says "from the nearest attack Overtone detects".

### Measured

```
61 ranked maps, 30,553 objects     from the nearest editor tick: <= 1 ms 30,276,
                                   1-2 ms 272, > 2 ms 5
30 random ranked maps, a report    0.31 s median (1.13 s max), attacks given
  lines per map                    median 15.5 for a median 480 objects
  General shift line               30/30 maps (the +26 ms reference timing measured)
  snapping                         4 maps: 532 on an Aspire map (6e302 BPM on purpose),
                                   1 real one (-2.5 ms), 0 elsewhere after the 2 ms bar
  away from any attack             median 12.5, max 150
Python unittest                    308 -> 316, all pass
benchmark.py                       24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures · signatures · robustness
reference 24/24 · assisted 70/70 · facts
```

The section was exercised in the built-in browser against replies frozen from the real
bridge. The data was secs-3 with its last line moved and five objects added:
- 5 findings in time order;
- a timestamp sent "00:00:150 (1)" to the editor link;
- unticking a group removed its row;
- Spanish rendered, with no console errors.

---

## v4.0.0-dev — 2026-09-24 · Assisted timing: two marked downbeats, the grid from the attacks

The precision plan's escape valve, which had no row until the sidebar modes. The marks are
typed in ms for now; tapping them waits for playback (Phase 4).

### Changed

- **Assisted timing** (Timing card). Where the detector refuses, or reads the wrong octave
  or bar, the user supplies what it cannot know: where a bar starts and how many bars lie
  between two marks. That fixes the beat and the downbeat, and the attacks do the rest:
  - each mark snaps to the strongest attack near it;
  - the seed is fitted as a reference line is;
  - it grows both ways as the engine grows a section. It crosses a stretch with no grid
    when the same grid comes back, and stops at one that holds a grid of its own.

  The card answers with the BPM, the red line, the span it holds and in how many bars, and
  how far the marks moved. A grid under 16 bars carries a warning that its BPM can be tenths
  off. It refuses marks out of order, a tempo outside 40-400 BPM, too few attacks, a weak
  grid, or one chance explains, and says which. "Add to timing" replaces the detected lines
  inside the span, except in its last 8 beats, where a line is most likely the change. It is
  one undo step and keeps locked points.

### Fixed

Each was a measured failure of a first version, fixed before it landed:

- **Unsnapped marks at 300 BPM.** One bar is 0.8 s there, and marks 15 ms late and 20 ms
  early made the seed 4.6 % fast. The index slipped and a clean track was refused.
- **A swung song never grew past its marks.** Read at the beat, it puts only 0.54-0.57 of
  its weight on the grid, under the engine's 0.55 growth bar. Growth now asks for 0.8 of
  the seed's own share, between the 0.40 share gate and 0.55.
- **Stopping at the first loose chunk** covered a median 31 % of a ranked map's line.
- **Skipping loose chunks without looking** ran secs-3's first 145 BPM line across its
  152 BPM section. The engine's seed search now tells a gap from a change.
- **The span's edge** ran up to 1.2 s past a 150 -> 120 BPM change. It is now settled on the
  attacks of the last two steps.
- **Adding the line** dropped secs-3's next red line, 0.4 s inside the span's end.

### Hardening

- **`gates.py assisted`**: every section of every corpus case is marked the way a person
  would, a quarter into the section, one and four bars apart, each mark 15-20 ms off.
  - The grid must come back within the benchmark's bar and cover the section.
  - It must stop within a beat of where its grid and the neighbour's part: about six beats
    at 200 -> 203.5 BPM, and never for an octave, which is the same grid (F-11).
  - Noise, pads and silence must be refused.

### Measured

```
gates.py assisted                   70/70; worst 0.0038 BPM, 2.26 ms (shuffle-96), coverage
                                    96.1 % or more; noise, pads, silence refused
30 random ranked maps, local Songs  marked on each map's longest red line, 15-20 ms off
  one bar apart                     answered 18/30, median |dBPM| 0.0034, within 0.05 78 %
  four bars apart                   answered 26/30, median |dBPM| 0.0037, within 0.05 92 %
  coverage of the map's line        median 92-93 % (31-39 % before gaps were crossed)
  offset against the map            median +27.6 ms, the shift reference timing measured
  by bars held                      every fit of <= 11 bars off by 0.25-1.9 BPM, every fit
                                    of >= 22 bars within 0.043
Python unittest                     298 -> 308, all pass
benchmark.py                        24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures · signatures · robustness
reference 24/24 · facts
```

The card was exercised in the built-in browser against replies frozen from the real bridge
on secs-3, marked four bars apart in its 152 BPM section. It put the red line at 24310 ms
(the true start), held 23.9-46.4 s (14 bars) and called the grid short. Marks 50 ms apart
were refused as 4800 BPM. Adding the line kept the 145 BPM line after it. Spanish rendered,
with no console errors.

### Rejected / tried and dropped

- **The least-squares standard error of the BPM, shown as ±.** On the 30 ranked maps it put
  nearly every fit, good ones included, past two of its own errors. Real attacks are not
  independent, and a mapper's "190" is not exact to a thousandth either. The bars held
  predict the error; the ± did not.
- **The engine's chance bar (10^-6).** It suits a search that tries thousands of grids and
  keeps the best. Here the user proposes one, so one in a thousand is the same bar. Marks on
  white noise score 0 to -1, and ranked songs with a short span were refused at -3.0 to -5.7.

---

## v4.0.0-dev — 2026-09-24 · Reference timing, and what 30 ranked maps say about offsets

The next sidebar mode on the roadmap: any map of the song, graded line by line against the
attacks Overtone hears. Measuring it on real ranked maps turned up the offset bias the
roadmap had only guessed at.

### Changed

- **Reference timing** (Map check card). Choose any `.osu` of the song, or find every map of
  the same audio in a Songs folder. Each red line's span is fitted from the map's own grid
  with the engine's tools: the phase mode first, then least squares on windows that double
  forward from the line. It is read at the coarsest of 1/1-1/4 that explains the attacks.
  Per line the card shows:
  - its offset against the map's common shift, and its drift at the span's end, each with
    two standard errors;
  - the fitted BPM and the share of attack weight on the grid;
  - a verdict: ok, check (with offset and/or drift), weak or too few attacks.

  A line is flagged past 5 ms and past two of its own standard errors. The common shift is
  one banner, not a flag per line. Two lines that disagree with no majority say so rather
  than let the median pick a side. "Use as working timing" loads the map's red lines as
  hand-placed points with their own meters, keeps locked points, and is one undo step.
- **Same audio, byte for byte.** The card says whether the map's AudioFilename is the
  analysed file. Two encodes share a name but not an offset.
- **The fallback tracker's songs can be graded.** It keeps no attacks, so the bridge detects
  them once per song, under the one-heavy-job lock.
- **`reference/python-v3` is deferred.** `overtone.py` is the app's default engine and its
  only `.osu` reader and writer. A copy under `reference/` would keep changing, and a frozen
  split would stop the default engine taking fixes. It moves once Rust is the default and
  the osu! I/O is ported (roadmap, Phase 0; rule 4 in CLAUDE.md).

### Fixed

- The roadmap still counted 41 open audit findings after all were closed, and called the
  Rust engine unwired after Settings began running it.
- CLAUDE.md said "the last three" gates exist because the benchmark cannot see them. The
  list has grown to eight since then.

### Hardening

- **`gates.py reference`**: each corpus case timed four ways.
  - The true map must come back clean.
  - The whole map 10 ms late must read as one shift, within 1 ms, with no line flagged.
  - With three or four lines, moving one flags that line alone. With two, it is a split.
  - Every BPM 0.1 % high flags every line for drift.
- A fit that wanders more than -20 %/+25 % from the map's beat is stopped. On one real
  song it shrank every pass until the least squares overflowed.
- The Songs search lists folders with `os.scandir`, which carries each file's size on
  Windows.

### Measured

```
gates.py reference                  24/24; true maps worst 2.26 ms (shuffle-96, as the
                                    benchmark's worst); BPM +0.1 % drift ~1 ms per second
30 random ranked maps, local Songs  every map reads its attacks after its lines:
                                    median +26.2 ms, IQR +23.0..+30.9, range +12.1..+45.6
                                    MP3 +26.1 (n=27), OGG +27.2 (n=3): not the MP3 decoder
  their 318 red lines               207 graded; flagged: 206 against zero, 160 against the
                                    map's shift, 101 against the shift and their own errors;
                                    24 weak, 87 with too few attacks
  time per map                      0.6-10.2 s, decode and attack detection included
same-audio search, 4,798 sets       59,260 audio files; iterdir 20.7 s cold / 9.1 s warm ->
                                    scandir 0.8 s, same one match and four maps
Python unittest                     279 -> 298, all pass
benchmark.py                        24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures · signatures · robustness · facts
cargo test --workspace              231, all pass (no Rust changed)
```

The card was exercised in the built-in browser against replies frozen from the real bridge
on secs-3 with its last line moved 12 ms. It showed 2 ok and 1 to check (-12.5 ms,
offset), found the map by its audio, graded it from the list and loaded it (3 points).
Every banner rendered in Spanish, with no console errors.

### Rejected / tried and dropped

- **Judging each line's offset against zero.** On real songs every line of every ranked map
  was flagged (206 of 207), because of the +26 ms shift nobody has explained yet.
- **A common shift reported only when two or more lines all agree on it.** It hid the shift
  on single-line maps, which are most maps.
- **Weighing the majority by attacks.** With two lines the one with more attacks always
  won, even when it was the one moved. Lines vote, one each.
- **Fitting outward from the middle of the span** (the engine's `_expand_fit`). At the
  middle, a BPM 1.3 % off has already walked a beat, and the fit locked onto the wrong
  one: share 0.25, fitted 152.7 for a true 150. Fitting forward from the red line reads
  150.001 up to 3 % off.
- **A flat 5 ms bar.** Twelve ms of jitter over 40 attacks gives a 10 ms drift by chance.
  Two standard errors let it pass, and take real-map flags from 160 to 101.

---

## v4.0.0-dev — 2026-09-24 · Every audit finding closed; the app gets sections and the Rust engine

The forty low findings, in three batches worked side by side (tempo and bench, Python,
DSP and hitsounds), then the app: a real sidebar, two new map checks, and the v4 engine
behind a switch.

### Changed

- **Sidebar sections.** The sidebar had one entry that did nothing. It now switches between
  Library, Timing, Map check, Mapset, Export and Settings over one shared song. Nothing was
  removed; views that need a song say so. English and Spanish.
- **Mapset check** (new section): every difficulty of a folder side by side. It compares
  red lines, AudioFilename, PreviewTime, lead-in and metadata, and shows kiai spans and
  objects per second. Differences are listed, never fixed.
- **Snap audit** (Map check card): objects off the map's own grid at the editor's divisors,
  with the miss in ms. Also objects before the first red line or past the audio, and what
  injecting the detected timing would unsnap.
- **The Rust engine in the app**, opt-in (Settings). `overtone_rust` runs `overtone-cli
  --full` and builds v3's own `Analysis`. A forced pulse, a missing binary, audio with no
  grid or a file it cannot decode goes to v3, with a note saying why.
- **`overtone-cli`**: `analyze <audio>` prints the red lines; `--json` gives v3's report
  shape and `--full` adds the evidence an app needs. Exit codes: 0 grid, 3 refused,
  1 unreadable, 2 usage.
- **`calibrated_templates()`** is public; the hand-set templates are documented as
  uncalibrated.
- **The legacy tracker's global BPM** is its own median, no longer averaged with a quantised
  tempogram guide.

### Fixed

- **Tempo parity details.** Growth inliers are counted from the refinement mask. Half-weight
  ties in the weighted median, density's rounded score, `.osu` half-millisecond rounding
  and bar-less meters now match v3 and its prototype.
- **DSP.** The HPSS masks lost energy in quiet bins. Band 0's edge padding was too short
  for its ringing. The structure merge could drop a boundary. `role::analyze` panicked past
  the end of the audio. A silent attack read as Snare.
- **Classic window and CLI** (Python):
  - edits kept their selection, so nudges repeat;
  - nudging below zero works;
  - the CSV writes the snapped offsets;
  - the Spanish strings are complete;
  - CLI progress goes to stderr, and bad flags and `--click` paths end with a message;
  - writes are synced before rename.
- **Load errors say what is wrong.** Missing, empty and junk files each get their own
  message, not "install FFmpeg".
- **Three UI slips.** "Section #{n}" was printed literally, the alignment warning icon was
  malformed, and the point editor had a stray `</div>`.

### Hardening

- **Golden** fails on a vector missing a stage, and compares section inliers.
- **`gates.py robustness`** runs the audit's edge-case probes as one command. The CLI tests
  run the same probes on v4.
- **`bench/facts.py`** checks every test count, crate list and fixture count the docs state.
- **`.gitattributes`** keeps `.osu` CRLF.
- **Measuring modes** in the bench: `structure`, `resample`.

### Measured

```
Python unittest                  239 -> 279, all pass
cargo test --workspace           214 -> 231, all pass; fmt and clippy clean
benchmark.py                     24/24, median 0.0000 BPM / 0.16 ms (unchanged)
bpm-snapshot 24/24 · golden.py 27/27 · coverage · measures 3/3 · signatures 6/6 · robustness 18/18
overtone-bench golden 27/27; nogrid, density, elastic, map output identical to before
weighted median, 249,689 constructed exact ties   32,624 disagreements with v3 -> 0
golden section inliers                           up to 62 off -> within 1 (a float tie)
legacy tracker global BPM, 16 cases              median error 0.391 -> 0.173 BPM
Rust engine vs v3 through the app, five fixtures  beats within 6e-12 s, local BPM
                                                  identical, whole-ms .osu offsets identical
overtone-cli, release, one corpus song           ~0.1-0.2 s decode + attacks + tempo
held-out hitsound F1                              0.723, unchanged
```

The app was exercised in the built-in browser against the real bridge (a local harness,
not committed), in both languages:

- Mapset flagged the Hard difficulty's red line 10 ms off.
- Python and Rust both read 174.000 BPM on edm-174.
- Snap audit listed the 40 objects the moved line unsnaps.

### Rejected / tried and dropped

- **A structure edge filter that refuses boundaries in the first 4 s.** It would also drop
  a real change at exactly 4 s (a two-bar intro at 120 BPM). The blind zone is documented
  instead.
- **Rebuilding the multiband layout to match the old docs.** It would move the band bank
  and every B.6 measurement; the docs now describe the bands as built.

### Not measured

- The fsync cost of atomic writes.
- The Rust engine on real songs through the app (the corpus and synthetic clicks only).
- Mapset and snap audit on real mapsets beyond a two-difficulty test folder.

---

## v4.0.0-dev — 2026-09-23 · The last medium findings: elastic parity, memory, the percussive ratio

Eight medium findings, and half of the ninth. Each was reproduced first; each fix landed
with a test that fails on the old code.

### Changed

- **The percussive ratio means percussive** (#74). The HPSS time kernel is 33 frames, not
  17: a transient smears over the 16 hops of the STFT window, and a 17-frame median was
  the median of that smear. The templates had been designed against what the feature
  measured, so only the snare, clap and ride expected a percussive attack. Now every drum
  does, and every tonal source expects a harmonic one.
- **A chorus on the verse's chords is a Chorus** (#75): a repetition group whose members
  fall into a quiet and a loud family (two or more each, 3 dB apart) splits in two.
- **AIFF opens in v4; Opus is refused by name** (#77), with what to convert it to.
- **Two measuring modes in the bench**: `structure <case>` (whole-track spectral
  analyses; peak memory read from outside) and `resample` (speed; every fixture is
  44.1 kHz, so nothing else runs the resampler).

### Fixed

- **Elastic parity** (#69). Three divergences from `proto/elastic.py`, written off as float
  noise near the degree cliff: a tolerance ladder that broke off dropped the whole degree;
  `polyfit` rooted weights already rooted; the local median took the upper middle value.
- **Structure's chroma drift** (#72): 172 STFT frames per window is 0.49923 s, so harmony
  ran 0.37 s ahead of the energy windows by four minutes.

### Hardening

- **No whole-track linear spectrogram** (#71, #73). `stft::map_frames` reduces each frame
  as it is computed; structure, classify and band flux keep 12 or 7 values a frame, and
  the zero padding is read through the index instead of copied. The hitsound HPSS
  separates only the frames it reads, bit for bit what the whole-track one gives there.
- **The resampler tabulates its kernel per phase** (#76): 147 phases for 48 -> 44.1 kHz,
  65 multiply-adds an output instead of 65 `sin()` calls.

### Measured

```
elastic, worst invented drift            29.559 % -> 4.865 %   (prototype: 4.865 %)
  change-128-142 / secs-2                degree 2 -> 1, 15.41 / 12.49 ms, as the prototype
structure mode peak working set, 60 s    204 MB -> 23 MB; six minutes 81-88 MB
Am -> F at 240 s, structure boundary     240.5 s -> 240.0 s
hitsound HPSS, isolated 2 ms click       0.885 -> 1.00 percussive; 40 ms snare 0.55 -> 0.88
hitsound macro F1                        validation 0.677 -> 0.707, held out 0.679 -> 0.723
chorus on the verse's chords, +6 dB      all Verse -> V C V C; 0 of 39 fixtures moved
resample six minutes, 48 kHz             12.25 s -> 0.73 s (96, 32, 22.05 kHz alike)
gates: cargo test 214/214; overtone-bench golden 27/27, nogrid, density 4/4, elastic, map
```

The hitsound kernel and template design were chosen on a validation set (seeds 31-34)
that neither trains nor judges; the held-out set was read once, at the end. Most of the
gain is the tonal terms (Bass 0.84 -> 1.00 on validation), which work at either kernel;
the kernel adds +0.005 macro and lifts Clap, the weakest class, 0.13 -> 0.27 at the
closed hats' expense.

### Rejected / tried and dropped

- **The larger HPSS kernel with the old templates.** Held out it read 0.693, but on
  validation 0.671 against 0.677: the held-out gain was selection on the test set. The
  isolated gate also turned: kicks read as snares once they read as percussive.
- **Kernels past 33.** Validation 0.668-0.674 (41-65 frames), held out falling to 0.657 at
  129: short tonal notes start reading as percussive.
- **Rayon in the resampler.** 0.7 s for six minutes did not call for a new dependency.
- **An Opus decoder in v4.** The mature one binds libopus, a C build on every Windows
  machine. Decided 2026-09-23: Opus stays refused by name, with what to convert it to.

### Not measured

- Real songs, for any of the hitsound or structure numbers: nothing in the pipeline
  labels sections or classifies hits yet. The six-minute "before" memory (~1.2 GB) is
  computed, not run, to keep RAM free.

---

## v4.0.0-dev — 2026-09-23 · The hitsound engine, judged honestly

Six findings in the Rust hitsound engine. The first changes what every later number
means, so it went first.

### Changed

- **Held-out evaluation** (#63). The gate calibrated on render seed 11 and tested on seed
  12, but `render()` keeps one schedule whatever the seed — same hit times, class order
  and neighbours — so "macro F1 0.91" judged a re-draw of the training track, with 3-4
  hits per class and only the macro asserted. `render_shuffled` varies order, gaps and
  level; templates train on four arrangements and are judged on four others, and no
  class may fall below 0.10. **The old templates read 0.485 held out.**
- **Dev builds optimise the FFT dependencies and DSP kernels** (#63). Debug assertions
  and overflow checks stay on; the larger evaluation made the hitsound tests 108 s, and
  the workspace now runs in ~40 s against 46-51 s before.

### Fixed

- **Sub-attacks** are counted over the 30 ms after the attack, not from 10 ms before it (#64).
- **The pitch window** reads the whole 20-300 ms with a Hann window; the 4096-point FFT
  had cut it to 93 ms, rectangular (#65).
- **The metrical role** (#66): 16ths weigh 0.10, not the 8th's 0.25; no grid means no
  division or weight (it read as a downbeat); an unproven bar's beats weigh 0.5; each
  section brings its own bar. Nothing consumes `Role` yet, so no F1 moves.

### Measured

```
held out, 280 hits, 4 shuffled arrangements   old templates 0.485 (the "0.91")
  trained on varied arrangements               0.650
  + sub-attacks after the attack               0.658 (Snare 0.52 -> 0.62)
  + whole pitch window, Hann                   0.679 (Vocal 0.86, Keys 0.67)
hitsound tests (debug)                         108 s -> 23 s with the dev profile
gates: cargo test 202/202; overtone-bench golden 27/27
```

### Rejected / tried and dropped

- **The documented 20-200 ms decay window.** Held out, it collapsed Clap to 0.00 (macro
  0.659): past ~100 ms a dense mix's neighbour tails dominate the fit. The code keeps
  +10 to +120 ms and the doc now says so.
- **Welch averaging for the pitch window** (4096-point frames): 0.666 against 0.679 for
  one Hann-windowed FFT over the whole window.

### Not measured

- Any of this on real songs. Every figure above is synthetic.

---

## v4.0.0-dev — 2026-09-23 · One-window signatures, the peak tie rule, the golden gate's blind spots

### Fixed

- **A one-window signature region** (#57, Python and Rust) was compared with exactly its
  own length in seconds and kept or dropped by the last bit. Runs are counted in whole
  windows; a single window is four bars, which the rule says is enough.
- **Peak picking's tie rule** (#58, Rust). Of two equal peaks within the distance the
  rightmost always won, and the comment said scipy did the same. scipy's order comes from
  an unstable `np.argsort` and follows no rule (`RLRLRLLRRR...` on one envelope), so exact
  parity is out of reach: the earlier peak now wins, pinned by a test. A golden diff on
  an exactly tied case in future is v3's nondeterminism, not a regression.

### Hardening

- **The golden gate reads the envelope and every weight** (#59): envelope sum within
  2e-3 (measured noise at most 0.00098) and each matched weight within 2e-5 (measured
  5.4e-6, the stored rounding). Correlation alone had passed a symmetric Hann window.
- **And each red line's bar** (#60): confidence, meter and meter_known are dumped and
  compared in both checks. The 24 vectors were re-dumped for the fields; long-6min's
  5th-decimal weight drift from #38 went in with them.
- **Three fixtures with a proven bar** (#61): `downbeat-4-4`, `downbeat-4-then-3` and
  `signature-changes`, rendered by the gates' own builders — 8 red lines on a proven bar
  and the measure-grid path, none of which the corpus reached. v3's two bar-branch unit
  tests are ported to Rust by name.

### Measured

```
4-bar 3/4 interlude, 37 start offsets      found 0/37 (1.2 s), 0/37 (1.6 s), 32/37 (1.875 s) -> 37/37
tied peak pairs, distance 9 (Rust)         kept [25, 44] -> [20, 40]
symmetric Hann injected into stft.rs       golden passed -> fails 24/24 (sum 4.7-6.6 off)
red lines with a proven bar under the gate 0 of 34 -> 8 of 42; Rust matches 27/27 vectors
gates: 239/239 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 27/27; coverage, measures, signatures green; cargo test 201/201; overtone-bench
golden 27/27, nogrid 3/3
```

---

## v4.0.0-dev — 2026-09-23 · Rust parity, the audio contract, bench honesty

Eleven more medium findings in four PRs, after #50 and #51 above.

### Fixed

- **Ties** (#52, three findings). `Iterator::max_by` keeps the last of equal maxima;
  v3's `np.argmax` and `max()` keep the first. Every Rust site with a v3 or prototype
  counterpart now iterates in reverse first (octave and meter classes, tempo hint,
  coherence fallback, primary section, fallback red line, density runs, re-timing, the
  bench's best hint); `tempo_hints` orders tied prominences as `argsort()[::-1]`.
- **The Rust hour cap** (#53) counted interleaved samples against 44.1 kHz stereo, so a
  30-minute 96 kHz stereo FLAC was refused at 27.6 min. The decoder now downmixes each
  packet as it arrives (v3's frame mean) and the cap counts mono samples at the file's
  own rate; the rest of `load()` is a pure function with tests for every clause.
- **Bench honesty** (#54, three findings). A missing fixture is a failure naming the
  script that renders it (it was skipped, and 0/0 passed). The bench times decode,
  attacks and tempo apart; "analyse" had timed attacks only.
- **Stale contract** (#55, three findings): peak distance 9 frames / 26.1 ms, re-timing
  dedupe keeps the earlier attack, own-band re-timing recorded as measured and rejected.

### Changed

- **The speed figures.** "The whole corpus analyses in 2.5 s against Python's 21.6 s"
  compared decode + attack detection with Python's whole `analyze_audio`. Like for
  like, on 2026-09-23: 4.2 s against 18.5 s, about 4.4x (the 6-minute fixture 1.12 s +
  decode against 4.6 s). CLAUDE.md, AGENTS.md, the README and the roadmap now say so.

### Measured

```
beat_from_atoms, equal weights (Rust vs v3)   (2, 1) -> (2, 0)
30 min 96 kHz stereo (Rust hour cap)           refused at 27.6 min -> accepted
corpus, Rust whole pipeline                    decode 0.45 + attacks 2.26 + tempo 1.49 = 4.2 s
corpus, Python analyze_audio                   18.5 s
bench with one fixture moved aside             pass -> exit 1, names the script
gates: 238/238 Python; cargo test 197/197; golden 24/24, nogrid 3/3, density 4/4 with 0
false positives, elastic and map green
```

### Not measured

- Decode memory on multichannel files after the per-packet downmix.
- Python and Rust timings vary by up to a third between runs on this machine; the
  figures above are single runs.

---

## v4.0.0-dev — 2026-09-23 · The two findings from the fixes

Both were recorded on 2026-09-23 while fixing others; each was reproduced first and
has a test that fails on the old code.

### Fixed

- **x2 on the fallback tracker dragged the new beats onto old hits** (#50). Inserted
  beats were snapped to the loudest point of their window even when that point was the
  window's edge — the previous hit's tail — so a bare 120 BPM click read 186 at x2. An
  inserted beat now holds when its window's maximum is on the edge. Only for a factor
  the user asked for: on the tracker's own doubling it changed 9 of 27 real songs with
  no net gain against their ranked maps, so auto results are exactly as before.
- **With no bar claimed, the first red line followed noise before the music** (Python and
  Rust). The line was placed from the first attack of any kind; it is now placed from
  the first attack the grid counts as an inlier (within 0.12 of a beat).

### Changed

- **`very-noisy-132` re-dumped, on purpose.** Its noise starts at 0 s and gives an
  attack at 27 ms, 0.136 of a beat off the grid. The first red line sat at -34.65 ms, on
  the grid beat before the music; it is now at 419.897 ms, on the first beat (truth
  420 ms). The other 23 vectors are unchanged (`long-6min`'s 5th-decimal weight drift
  from #38 was again left as committed).

### Measured

```
bare click 120, x2 (fallback)                186.0 -> 240.1 BPM (rebuild 239.9)
kit read at 199.5, x2 (fallback)             519.2 -> 399.2
27 real songs on the fallback, auto          identical to the old code, 27/27
  (holding on auto: within 10 ms of the map 0.128 -> 0.125, not applied)
kit at 420 ms + noise burst at 27 ms         first red line -34.4 -> 420 ms
very-noisy-132 first red line                -34.65 -> 419.897 ms
gates: 238/238 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 after the re-dump; coverage, measures, signatures green; cargo test
194/194; overtone-bench golden 24/24, nogrid 3/3
```

---

## v4.0.0-dev — 2026-09-23 · The classic window's config, clipboard, CSV and .osz

Four medium findings from the classic window and the file writers (five backlog rows —
two described the same config crash), each reproduced first and each with a test that
fails on the old code. No engine code changed; the benchmark and golden vectors are
untouched.

### Fixed

- **A badly typed `~/.overtone.json` crashed the classic window at every launch** (#45).
  `load_config` checked only that the file held a dict. Each known key now has a type; a
  wrong one is dropped so the reader's default applies, `recent` keeps its strings, a
  bool is never taken for a number, unknown keys pass through.
- **Ctrl+C in a text field replaced the clipboard with the timing block** (#46). The
  shortcut, bound on the window, ran after the field's own copy. It now skips text
  fields; the web shell already did.
- **CSV export failed silently** (#47) on a locked file: the error went to stderr. It
  now reports in the status bar and does not count hand edits as exported.
- **`.osz` audio lost its extension** (#48) on names over 80 characters or with "...".
  Stem and extension are sanitised apart, and trimmed again after the cut.
- Re-probed: **×2 / ÷2 discarding hand edits** was already fixed by #20.

### Measured

```
config {"cfg_version": "2", "prefer_map_bpm": "on"}   TypeError at launch -> opens, defaults
Ctrl+C in the offset / BPM fields                     copy_osu 2 calls -> 0 (table: still 1)
CSV to an unwritable path                             FileNotFoundError -> "Error: ..." status
.osz audio "…Club Mix).wav" / "Title....wav"          "…(Extended Club " / "Title_wav" -> ".wav" kept
gates: 236/236 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green
```

### Not measured

- On a real display with a real clipboard: the Ctrl+C test mocks `copy_osu` and selects
  nothing, so it never writes to the clipboard of the machine running it.

---

## v4.0.0-dev — 2026-09-23 · Long mixes, the fallback's pulse factor, scattered clicks

Three more medium findings, each reproduced before its fix and each with a test that
fails on the old code.

### Fixed

- **Section growth stopped after 64 passes** (#41, Python and Rust). A 15-minute mix
  changing tempo every 9 s came out as 64 sections ending at 576.5 s; the last 323 s had
  no red line and nothing said so. Every pass advances at least `seed_s`, so the guard
  is now `ceil(length / seed_s) + 2` (never below 64).
- **The fallback tracker ignored ÷2 / ÷4 and read x1 as "force"** (#42). It took the
  factor as an absolute subdivision of its tracked beats. The factor now multiplies its
  chosen subdivision, as it does the precision engine's; halving keeps every 2nd / 4th
  tracked beat from the first (not the more accented phase — the snare bias again), and
  `rebuild_with_subdivision` shares the helper, so ÷2 in the app works on it too.
- **The fallback tracker answered scattered clicks** (#43). `MIN_PULSE_GAP` 0.05 -> 0.07.

### Measured

```
15-minute grid, 120/127 BPM every 9 s        64 sections to 576.5 s -> to 899.8 s
kit 100 read at 199.5, ÷2 (fallback)         199.5 -> 99.8 BPM, first red line on the 1st kick
kit 170, ÷2 (fallback)                        170.9 -> 84.8, on the first kick
x1 vs auto (fallback), three renders          identical
random-click renders answered                 12/240 -> 1/240 (gap 0.0779 left)
real songs reaching the fallback, refused     0/28 -> 0/28 (lowest gap 0.0956)
gates: 232/232 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 193/193; golden 24/24
```

### Rejected / tried and dropped

- **MIN_PULSE_GAP 0.085**, which refuses the last random render too: 0.005 to spare
  below the lowest of 55 real songs.
- **Attack density** as a second signal for the fallback: random renders reach 22
  attacks/s, above most songs.
- **Chance of the attacks landing on the fallback's own beats:** backwards — the
  tracker follows the clicks, so random renders align better than music does.
- **Halving on the more accented phase:** on a 170 BPM kit it put the grid on the snare.

### Found, not fixed

- x2 on the fallback tracker with nothing between its beats reads an unrelated BPM
  (bare click 120 -> 186).

---

## v4.0.0-dev — 2026-09-23 · No bar without a proven 1

A section's bar was claimed whenever its strongest beat class stood 1.20 above the mean
of the classes. The onset envelope favours broadband hits, so that class was often the
snare: on the backbeat at the song's own tempo, or — read at double tempo, where four
"beats" are two — on every other beat. The red line then sat on the snare.

### Fixed

- **A downbeat must also out-weigh the beat half a bar away** (Python and Rust,
  `HALF_BAR_CONTRAST = 1.25`). A pattern that repeats every half bar cannot say which
  half starts the bar; the section then anchors to a beat, as it does with no accent at
  all. 3/4 has no half-bar class and keeps the rule it had.

### Changed

- **Two golden vectors re-dumped, on purpose.**
  - `slow-92` starts on its downbeat at 750 ms. Its first red line sat at 1402.1 ms, on
    the snare of beat 2; it is now at 749.93 ms, on the 1. `meter.bar_beats` 4 -> 1.
  - `very-noisy-132` starts on its downbeat at 420 ms. Its first red line sat at
    874.4 ms, on the snare of beat 2 (`downbeat_class` 1). It is now at -34.65 ms: with
    no bar claimed the line anchors to the first attack, and noise at 27 ms puts that
    on the grid beat before the music. Still one beat from the 1, now on the other side,
    but no longer claiming a bar the accents do not prove.
  - The benchmark scores offsets modulo one beat, which is how both hid. The other 22
    vectors are unchanged; `long-6min` drifted one weight in the 5th decimal from #38's
    blocks, inside the 1e-3 tolerance, and was left as committed.

### Measured

```
tempo-change renders, change on a bar line      3/60 red lines a beat late -> 0/60
  (all 3 were the renders read at double tempo)
88 ranked maps, first red line on the map's 1   36/88 -> 40/88
  of the 21 that claimed a bar                   5/21 -> 9/21 (5 gained, 1 lost)
  claimed bars by half-bar ratio, before         < 1.25: 0/9 on the 1; 1.25-1.5: 1/7;
                                                 >= 1.5: 4/5
gates: 227/227 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 after the two re-dumps; coverage, measures (3/3), signatures (6/6) green;
cargo test 192/192; overtone-bench golden 24/24, nogrid 3/3
```

### Rejected / tried and dropped

- **A threshold of 1.5.** The ranked maps favour it (15 wrong claims gone, 1 right one
  lost), but the `measures` gate's `downbeat-4-then-3` fixture carries a real accent at
  only 1.29 and would lose its bar. Lowering that fixture's bar to pass would be
  re-baselining. At 1.25 the change removes only claims that were all wrong.
- **Fixing it at the octave.** All three failing renders were read at double tempo,
  but the octave is pinned by `bpm-snapshot` and the same snare-over-kick bias shows
  at the right octave on real songs (the maps' wrong claims were mostly one beat early,
  on beat 4). The real fix is a downbeat cue the snare cannot win: low-frequency (kick,
  bass) onsets. Recorded in the roadmap; not attempted here.

### Not measured

- Songs whose first attack is noise before the music: their first red line follows it
  (`very-noisy-132` above). Recorded as its own finding.

---

## v4.0.0-dev — 2026-09-23 · Backups, dropped packets, and 3.7 GB per song

Two medium audit findings, and one that no audit listed: the user's PC froze while
several analyses ran, and one 5-minute song turned out to peak at 3.7 GB.

### Fixed

- **`.bak` written in place, then never replaced** (#36). A backup write that failed
  halfway left a truncated `.bak`, and the retry trusted it. A map the mapper worked on
  between two injects was overwritten with nothing keeping it, while the summary said
  `backup=True`. Backups now go through a temp file and `os.rename` (which refuses an
  existing target on Windows); the first `.bak` stays pristine and each later write keeps
  what it replaces in the next free `.bak2`, `.bak3`..., unless the newest backup already
  holds those bytes. The result reports the backup's path.
- **Rust decode dropped a rejected packet** (#37). Everything after it moved earlier by
  the packet's length — 26.1 ms for an MP3 frame. The packet now becomes silence of its
  own duration, and `Decoded.concealed_frames` counts it.
- **3.7 GB for one 5-minute song** (#38). librosa built the whole linear spectrogram for
  the onset envelope (~1.3 GB) and the fallback tracker built a whole 8-second tempogram
  twice (~3.5 GB each). Both are now built in blocks, and one tempogram pass feeds both
  of the tracker's tempo readings.

### Hardening

- New test fixture `crates/overtone-audio/testdata/clicks.mp3` (23.6 KB, libsndfile 1.2 /
  LAME): the decoder test corrupts one frame of it in memory.
- A memory test: 2 minutes of audio must stay under 300 MB for the envelope and 400 MB
  for the tempo guides plus tracker (533 and 1363 MB before, 160 and 131 MB now).

### Measured

```
backup write failing halfway              truncated .bak left -> no file left
map edited between two injects            unkept -> kept in .bak2, byte for byte
one rejected MP3 frame (Rust)             1152 frames short, later clicks 26.1 ms early
                                          -> same length, all 16 clicks on the same sample
5-minute song, peak RAM                   3.7 GB -> 0.55 GB, same 8 red lines
5-minute song, time                       14.5-21.7 s -> 16.0-23.0 s (this machine's noise)
2-minute render, envelope / tracker       533 / 1363 MB -> 160 / 131 MB
16 real songs, old vs new                 14 identical; 2 fallback songs moved one BPM in
                                          the 6th decimal, offsets identical
gates: 225/225 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 191/191; golden 24/24
```

### Rejected / tried and dropped

- **One block size for both.** 4096 frames made the tempogram 1.5-2x slower than
  one-shot (its column FFTs fall out of cache) and 512 made the spectrogram slower. They
  now have their own: 8192 frames for the spectrogram, 1024 columns for the tempogram.
- **The tempogram built blockwise but twice**, as v3 did whole: the saving in memory
  came with ~6 s more per fallback song. Sharing one pass removed it.
- **A bit-identical mel spectrogram.** The mel projection's float32 summation order
  follows the block shape (differences up to ~2e-6 of the envelope's range); the golden
  check's tolerances exist for exactly this, and all 24 fixtures match stage for stage.

### Not measured

- The downbeat fix (next item). The ranked-map sweep that should set its threshold was
  lost twice when the app quit; it now appends per song and resumes.

---

## v4.0.0-dev — 2026-09-23 · The six high audit findings

The backlog's six high findings. Each was reproduced with a probe before any change,
fixed in Python and Rust where both apply, and landed as its own PR (#29–#34) with a test
that fails on the old code.

### Fixed

- **÷2 / ÷4 deleted real tempo changes** (#29). The duplicate filter compared factored
  BPMs against the unfactored minimum change, so every change shrank by the factor; the
  20–900 BPM range check read the presented tempo too. Both now read the song's own
  tempo; Rust got the same range rule.
- **Export snapping moved hand-placed red lines** (#30). Any line within a quarter beat
  of the previous grid was pulled onto it. Snapping now removes only rounding noise
  (≤ 1 ms), and a `manual` flag, set by every edit and by re-added locks, keeps the
  mapper's lines where they were put.
- **A change's red line one beat late** (#31). `ceil` skipped the boundary beat when the
  refit left it microseconds before the start; the other sections now get section 0's
  quarter-period slack.
- **A stray click before the music threw the grid away** (#32). Section growth stopped
  when its first seed window held fewer than six attacks; it now moves on to the next
  attack.
- **Sparse random attacks got a grid** (#33). The 0.40 share gate passed about half of
  them. A grid is now refused when the binomial chance of its inliers is above 10^-6
  *and* the fitting envelope's pulse gap is below 0.15. The gap runs on the envelope the
  engine already has, max-pooled in pairs, with SplitMix64-ordered shuffles, so Rust
  reproduces v3's numbers to 1e-9.
- **Rust hitsound flux** (#34) subtracted a 4096-point spectrum from an 8192-point one bin
  by bin, so a steady tone scored 0.9996. It now compares the 50 ms before the attack with
  its first 50 ms, on the same bins.

### Changed

- `docs/13-audit-backlog.md`: the high section is now a record of the fixes; two new
  medium findings recorded (a weak downbeat read one beat late; the fallback tracker
  answering some scattered clicks). Open: 83 — none high, 43 medium, 40 low.
- README: most MP3s open directly, not all — one of the songs tested needs FFmpeg.

### Hardening

- Rust `NoCoherentPulse` now also covers a grid that chance explains (`best_share` is
  then above 0.40); its doc says so.

### Measured

```
÷4, changes kept                        tiny-change 1/2 -> 2/2, secs-4 2/4 -> 4/4
hand-placed red line at 10100 ms        exported 10000 -> 10100
ranked real map, within 10 ms           8.1 % -> 14.4 %   (median error 60.0 -> 42.7 ms)
change red line one beat late           not reproduced end to end (0/77 constructions,
                                        0/100 renders, before and after)
click at 0.3 s, drums at 8 s (150)      fallback 295.3 BPM -> precision 150.000
random attack times given a grid        18, 17, 15, 22, 5 of 40 -> 0 in every case
random-click files answered             63/240 (53 precision) -> 12/240 (0 precision)
real audio (36 fixtures + 40 songs)     76/76 still analysed, 0 newly refused
hitsound flux, steady tone              0.9996 -> ~0
hitsound, seed 12 (the gate)            same 4 misses; macro F1 0.910 -> 0.906
hitsound, seeds 12-20, 450 hits         35 -> 29 wrong; macro F1 0.913 -> 0.931
gates: 219/219 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot and golden
unchanged; coverage, measures, signatures green; cargo test 190/190;
overtone-bench golden 24/24, nogrid 3/3
```

### Rejected / tried and dropped

- **One statistic for the sparse-noise gate.** The binomial chance alone refused real
  songs whose vocals sit off the grid (as weak as 10^-1.3); the pulse gap alone refused a
  rubato ballad (0.035). Only both together separate them.
- **The pulse gap on a second, HOP-256 onset envelope.** It worked in Python, but Rust's
  engine only has the fitting envelope and numpy's shuffle cannot be reproduced there.
  Max-pooling the fitting envelope in pairs and hashing the shuffle gives both engines
  the same number.
- **A 0.10 gap threshold.** It kept two real songs on the precision path but let one of
  240 random attack sets through (gap 0.105). Those two songs' grids put 5 % and 18 % of
  their ranked map's beats within 10 ms, so 0.15 costs nothing worth keeping.

---

## v4.0.0-dev — 2026-09-23 · Five audit leads, five real bugs

The roadmap listed five audit findings as "to verify". Each was re-probed before any
change; all five were real. Three touched the engines.

### Fixed

- **First red line half a beat late** (Python and Rust). The octave stage picks the
  accented atom class counting from the anchor seed's phase; section 0 is seeded again
  during growth and can sit a whole atom away. The class is now re-expressed in section
  0's own frame (halves rounded as `floor(x + 0.5)` in both languages).
- **Meter path swallowing a tempo change** (Python and Rust). The bar measured on one
  section was applied to the whole track, so 128 → 150 BPM with an audible downbeat came
  out as one 128 BPM red line. Every section's beat must now tile that bar (within 0.02
  beats); a signature change over one bar does, a tempo change does not.
- **Rust chroma misplacing bass notes.** Below ~362 Hz a 21.5 Hz bin is wider than a
  semitone; there, only spectral peaks count, at their interpolated frequency. The
  hitsound crate's chord-change feature now ignores bins below 100 Hz, where kick
  fundamentals sit — its test had passed only because the old chroma misfiled a 55 Hz
  kick onto the pad's own class.
- **Licence claims** in the precision, installer and comfort plans, corrected from the
  projects' own licence files; Demucs dropped for HPSS (its weights are research-only).
- **CLAUDE.md / AGENTS.md** counts and layout.

### Changed

- **`bench/golden/fast-300.json` re-dumped, on purpose.** `fast-300` is a 300 BPM render
  read at 150 whose first kick is at 0.2 s. Its red line sat at 400.2 ms — on the snare —
  and passed because the benchmark scores offsets modulo one 300 BPM beat. With the
  section-0 fix it sits at 200.2 ms, on the kick. Only `beat_sections[0].phase_s`,
  `settled_sections[0].phase_s` and `result.points[0].offset_ms` changed; the other 23
  vectors are byte-identical.
- New `docs/13-audit-backlog.md`: the 87 findings the audit's verifiers confirmed that
  are still open, so they live in the repository and not in a temporary file.

### Measured

```
first red line on the off-beat, 8 plain constant-tempo renders     5/8 -> 0/8
tempo change with an audible downbeat (128->150, 120->160)         1 red line -> 2
bass notes E1..D#4 on the wrong pitch class (Rust chroma)          24/36 -> 0/36
hitsound calibration macro F1                                       0.910 -> 0.910
gates: 209/209 Python; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24 (after the fast-300 re-dump); coverage, measures, signatures green;
cargo test 181/181; overtone-bench golden 24/24
```

---

## v4.0.0-dev — 2026-09-23 · Four confirmed bugs fixed

The four bugs the 2026-09-22 audit reproduced with a probe. Each fix has a test
that fails on the old code. The accuracy baseline did not move.

### Fixed

- **Inject changed what a map plays.** Every new red line was written as
  Normal / index 0 / 100 % / no kiai, and all of them went where the first old
  red line was, out of time order. New red lines now carry the sample set,
  index, volume and kiai the map had at their time; where moving red lines
  would still change slider velocity or sounds, a green with the original
  values is added; the section is sorted, red before green at ties; greens,
  the BOM, each line's ending and a missing final newline keep their bytes.
- **White noise got a BPM.** The v2 tracker behind the precision engine always
  finds beats: noise came back as 127.68 BPM, pads as 60.09. The fallback now
  refuses audio whose onset envelope is no more periodic than itself with its
  frames shuffled.
- **Classic window: CSV clipped to 21 px.** Every ghost button inherited the
  clam theme's 11-character minimum; they now size to their labels and the
  minimum window width is 1070.
- **Classic window: ×2 / ÷2 and Analyze dropped hand edits.** They now ask
  while edits are unexported; exports clear the count.

### Hardening

- The pulse check is numpy, not librosa. A first version called librosa's
  tempogram before the tracker and moved the tracker's global BPM on a real
  song (198.07 → 199.27); the numpy version equals librosa's tempogram to
  6e-16 and leaves that song identical.
- Tests: 7 inject (against an independent play-state evaluator), 3 no-pulse,
  1 layout fit, 3 edit guard.

### Measured

```
inject on a ranked map (236 reds, 199 greens, 1341 objects), Overtone's 22 red lines:
  objects whose SV/sampleset/index/volume/kiai changed   old 229   new 0
  section in time order                                  old no    new yes
pulse gap (threshold 0.05):
  white / pink / brown noise + bench noise               +0.014 .. +0.022
  27 real songs from an osu! Songs folder                +0.090 min, +0.225 median
  check cost on a 5-minute song                          ~0.25 s (librosa version ~7 s)
classic window toolbar, clipped buttons (EN/ES x default/minimum)   old 4/4 cases   new 0/4
gates: 205/205 unit tests; benchmark 24/24, 0.0000 BPM / 0.16 ms; bpm-snapshot unchanged;
golden 24/24; coverage, measures, signatures green
```

---

## v4.0.0-dev — 2026-09-22 · A shared grid slot reads as its coarsest division

A bug fix in the hitsound crate's musical role. The tempo engine is untouched.

### Changed

- **`role::grid_position` names a shared slot by its coarsest division.** An
  on-beat is 1/1, a half-beat 1/2, a 16th 1/4, whatever the period. Residuals
  are unchanged to within 1e-9 beats; only the label on coinciding slots moves.

### Fixed

- **On-beats read as triplets.** The loop over divisions 1, 2, 3, 4, 6, 8 kept
  the strictly smallest residual. Slots coincide across divisions (a beat is
  also 3/3 and 6/6, a half-beat is 2/4, 3/6 and 4/8), so for an attack on a
  shared slot every division reads the same residual, and rounding in
  `beat * d` picked the winner. Whenever the attack time was not an exact
  binary fraction of the period, which is every real track, 1/3 or 1/6 could
  win by 1e-13 ms. The division feeds `metrical_weight`, which returns 0.25 for
  1/2 to 1/4 and 0.10 finer, so a kick misread as 1/3 lost its downbeat (1.0)
  or backbeat (0.5) weight, and a hat misread as 1/6 dropped from 0.25 to 0.10
  as if it were a ghost note. The tests passed only because their times were binary
  fractions; one accepted "4 or 8" for a 16th, which was this ambiguity showing
  through. Now the coarsest division within 1e-9 beats of the minimum wins.
  Rounding is ~1e-12 beats even a thousand beats in; distinct slots sit at
  least 1/24 beat apart.

### Hardening

- The 16th test asserts division 4, not "4 or 8".
- New test at 174 BPM, phase off zero, every attack 0.5 ms late: 600 beats ×
  seven slots (1/1, 1/2, 1/3, both 1/4s, 1/6, 1/8) must each read their own
  division and a 0.5 ms residual. Under the strict minimum, 80 of the 600
  on-beats read as triplets. The edm-174 reading that exposed the bug is pinned
  beside it.
- `corpus.rs` and `role.rs` are rustfmt-clean, and `role.rs` is clippy-clean:
  `section_at` walks back from the last section instead of scanning all of
  them, the period guard names NaN explicitly, and `analyze` takes the same
  `too_many_arguments` allow as `points_from_sections`. No behaviour change;
  177/177 tests, golden 24/24.
- The whole workspace is now `cargo fmt --check` and `cargo clippy
  --workspace --all-targets` clean: 28 files reformatted, 35 warnings cleared,
  one commit per crate. Negated float comparisons spell out NaN; loops that
  only wrote one slice iterate it; the elastic solver's matrix loops and the
  five eight-to-nine-input functions keep an `allow` with the reason written
  down. The corpus's metallic decay looked like a lost per-voice value but the
  table already carries one per class, so the identical branch went. No
  behaviour change: every commit passes 177/177 and golden 24/24.

### Measured

Share of attack weight per division, on v3's precision analysis of every
corpus fixture that has a grid (31 of 34; the three ramps fall back to another
engine). Measured through a Python port of the same arithmetic: the hitsound
crate has no corpus harness yet, so this measures the arithmetic, not the Rust
binary.

```
                   before (strict minimum)          after (coarsest tie)
fixture          1/1   1/2   1/3   1/4   1/6   1/8    1/1   1/2   1/3   1/4   1/6   1/8
edm-174         48.9  23.5  17.6   0.0  10.0   0.0   66.5  33.5   0.0   0.0   0.0   0.0
downbeat-4-4    66.5   0.0  33.5   0.0   0.0   0.0  100.0   0.0   0.0   0.0   0.0   0.0
fast-300        25.0  39.4  13.7   0.0  21.9   0.0   38.7  61.3   0.0   0.0   0.0   0.0
shuffle-96      36.5   0.0  58.0   5.4   0.0   0.0   53.4   0.0  41.1   5.4   0.0   0.0
swing-120       34.4   0.0  25.8   0.0   0.0  39.8   53.7   0.0   6.5   0.0   0.0  39.8
very-noisy-132  40.2   9.7  26.9   3.9   9.4   9.8   62.3  15.5   4.9   3.9   3.7   9.8
```

- **Straight fixtures (29):** 1/3 + 1/6 carried 25–39 % of attack weight
  before, 0.0 % after on 26 of them. The other three (noisy-140 0.4 %,
  signature-changes 0.2 %, very-noisy-132 8.6 %) are attacks nearer a triplet
  slot than any other, not ties. On edm-174, 1/3's 17.6 points moved to 1/1 and
  1/6's 10.0 to 1/2: a quarter of the on-beat weight and a third of the
  half-beat weight had been read with the wrong metrical weight.
- **Shuffle-96** keeps its triplet hats at 41.1 %; the other 16.9 points were
  on-beats. **Swing-120** swings its hats to 0.58 beats, nearest the 5/8 slot,
  so they read 1/8 before and after.
- 1/4 and 1/8 shares are identical before and after on every fixture.
- `cargo test --workspace` passes (177 tests, one new). Golden gate 24/24
  attack for attack. The Python gates were not run: the v3 engine is untouched.

### Rejected / tried and dropped

- **A relative tolerance on the residual.** It collapses as the residual
  approaches zero, which is exactly an attack sitting on its slot: a 1e-15
  minimum and a 1e-13 rival are a factor of 100 apart and still a tie. The
  residual is already in beats, so an absolute tolerance is already
  period-relative.

---

## v3.6 — 2026-09-22 · Comfort features plan, and a place for output to live

Not code beyond a small repository hygiene fix; a plan release.

### Changed

- **New doc**: [`docs/12-comfort-features.md`](docs/12-comfort-features.md) —
  Phases 12 through 18, everything that raises the app's *comfort* ceiling
  without changing what it does. PySide6 + pyqtgraph (Phase 12) for the
  timeline, sounddevice for live playback and click (13), a proper `.oto`
  project format with auto-save and undo tree (14), deep osu! integration
  including lazer support and a Songs browser (15), full localization and
  accessibility (16), plugin API and PDF reports (17), MIDI/gamepad/video
  input (18). Every dependency audited: PySide6 LGPL-3.0, pyqtgraph MIT,
  everything else free.

- **Sub-phase 14.4b — Organised output folders** added. Every artefact
  Overtone writes goes under
  `%USERPROFILE%\Documents\Overtone\Exports\<Artist> - <Title>\`, keyed
  by song. Nothing lands loose next to the installed app; `Program Files\`
  is read-only after install. An `Exports\index.sqlite` records what was
  written when and from which project. The user can point the root
  elsewhere in Settings.

- **`STK_timing_points.osu.txt` moved** from the repo root to `fixtures/`,
  where new hand-timed samples will also live as the project grows. This
  is the loose file the user was reacting to.

### Cumulative installer estimate

Comfort deps add ~322 MB on top of Phase 10's precision stack. Total MSI
before size reduction: ~1.5 GB. After 10.13.4 quantisation and drums-only
Demucs: ~800 MB.

### Measured

Nothing. This is a plan. 76/76 tests still pass on the moved fixture.

---

## v3.5 — 2026-09-22 · Distribution model: one MSI, everything inside

Follow-up to v3.4. The user asked for the app to be installable as a single
MSI without any online dependency, portable if possible. That constraint
rewrote two parts of the precision plan.

### Changed

- **New doc**: [`docs/11-msi-distribution.md`](docs/11-msi-distribution.md) —
  the concrete plan to build a single-file Windows installer that bundles
  every model, every wheel, every native DLL. ~1.15 GB before size reduction,
  ~450 MB after (INT8 quantisation, Demucs drums-only, drop madmom as bundled
  dep — no accuracy loss beyond 0.5 %). WiX Toolset v5 for MSI authoring,
  PyInstaller for the Python bundle, Azure Trusted Signing ($10/month) for
  Windows SmartScreen. A portable ZIP variant ships alongside.
- **Phase 10.1 rewritten** in [`docs/10-precision-plan.md`](docs/10-precision-plan.md).
  The earlier plan scraped a public mirror of ranked maps from the osu! API —
  that requires network and does not fit the offline requirement. The rewrite
  indexes the user's own `C:\osu!\Songs\` folder instead. Every ranked map
  they already downloaded is already a ground-truth timing source; a
  Chromaprint fingerprint matches an incoming audio to that local corpus.
- **Phase 10.13 added to the roadmap** — MSI distribution as seven sub-phases
  (build harness, WiX, model manifest, size reduction, portable ZIP, code
  signing, build automation), ~12 days on top of Phase 10's ~4–6 weeks.

### Rejected in this release

- **osu! API scraping at runtime** — needs network permanently. Even a
  one-time build of a public mirror was rejected because 50 GB of downloads
  cannot ship inside a portable installer.
- **Runtime auto-update** — would be a policy change. Users update by
  downloading and re-running the new installer.
- **Cross-platform installers** for macOS and Linux — the app runs on those,
  but the packaging plan is Windows-first.
- **Microsoft Store submission** — GitHub Releases is enough for direct
  distribution.

### Measured

Nothing changes today: this is a plan, not code. The measurable claim in
v3.4 (4.7 % → ~95 % of ranked timing points within 5 ms) holds. The MSI plan
is about *how the product reaches users*, not *what accuracy it reaches*.

---

## v3.4 — 2026-09-22 · A written plan for human-level timing accuracy

Not a code release; a plan release. A user asked what it would take to time a
song as accurately as a mapper who has already done it by hand, using only free
software and offline models, without any budget on how long analysis is allowed
to take.

The answer, worked out in [`docs/10-precision-plan.md`](docs/10-precision-plan.md),
is that **90–95 % of a ranked map's timing points within 5 ms** is a real,
reachable target with the current state of open-source tooling. It takes about
4–6 weeks and twelve sub-phases, and every one of them is measurable.

### Changed

- **`docs/10-precision-plan.md`** — 12 sub-phases with dependencies, licences,
  expected accuracy gains, and a cumulative projection from today's 4.7 %
  within 5 ms on the Vampires reference track to ~95 %. Includes an honest
  audit of what stays outside even this plan.
- **Roadmap gets Phase 10** — a summary that points into the precision plan.

### Measured

Baseline on the reference track (My Chemical Romance – Vampires Will Never Hurt
You, 236 hand-placed red lines):

```
today             median offset error 60.0 ms   within 5 ms   4.7 %
after Phase 10    projected           ~1 ms                  ~95 %
```

The projection is not a promise. Each cell of the projection column is anchored
to published benchmarks for that specific technique (madmom's F-measure gain on
GTZAN, Demucs' SDR on MUSDB, etc), so it can be checked against reality one PR
at a time.

### What was rejected

- **Anything paid.** Spotify's Audio Analysis API is more accurate than an
  open pipeline for the tracks it has, but was rejected outright: the project's
  offline-first policy holds, and Spotify's terms restrict what can be built
  on their data.
- **Anything not free-licence.** RWC Popular Music dataset is skipped
  (commercial licence), even though it would help. Essentia is kept optional
  (AGPL) rather than statically linked.
- **Copying ranked map timings without matching them first** — Phase 10.1
  fingerprints before copying, so the user is not silently given someone
  else's timing for a different song.

---

## v3.3 — 2026-09-22 · Time signatures over a constant bar

A user compared Overtone against a beatmap they had timed by hand in Tempora
and reported a large difference. Reading their timing points made the cause
obvious, and it was not what either of us expected:

```
168    6 x 200 ms    bar 1200 ms         168 -   168 =      0 =  0 x 1200
20568  3 x 400 ms    bar 1200 ms       20568 -   168 =  20400 = 17 x 1200
39768  6 x 200 ms    bar 1200 ms       39768 -   168 =  39600 = 33 x 1200
58968  3 x 400 ms    bar 1200 ms       58968 -   168 =  58800 = 49 x 1200
68568  6 x 200 ms    bar 1200 ms       68568 -   168 =  68400 = 57 x 1200
100968 4 x 300 ms    bar 1200 ms      100968 -   168 = 100800 = 84 x 1200
```

**Every red line sits an exact multiple of 1200 ms from the first, and every
bar is 1200 ms.** The song has no tempo change anywhere. 300, 150 and 200 BPM
are three ways of writing the same measure with 6, 3 and 4 beats — which is
exactly Tempora's model, read from its source:

```csharp
MpsToBpm(mps) => mps * 60 * (TimeSignature[0] * 4f / TimeSignature[1])
measurePosition = (time - point.Offset) * point.MeasuresPerSecond + point.MeasurePosition
```

Measures per second is the physical quantity; BPM is a presentation of it
through the signature. v3 grows sections on measures per second, so a song that
changes only its signature was structurally invisible to it — it reported one
tempo for the whole track.

### Changed

- **`detect_bar`** — how many of a grid's beats make one measure, from accent
  contrast, refusing when the accents prove nothing.
- **`meter_segments`** — splits a track by *how the bar is subdivided*, scoring
  each window against every plausible beats-per-bar with the same
  `share x coverage` ranking the seeder uses. A grid too fine fills half its
  own slots; one too coarse leaves attacks off it; only the written
  subdivision scores on both.
- **`points_from_meter`** — one red line per signature region, on a bar line,
  with BPM derived as Tempora derives it. Declines and leaves the ordinary
  per-section placement alone when there is no provable bar, only one
  signature, or the user forced a pulse octave.
- New gate, `bench/gates.py signatures`, built from the reference track's shape.

### Measured

On a faithful reproduction of that song, against the hand-timed truth:

```
  #        offset        truth      error  beats truth        bpm
  1         168.1        168.0      +0.1ms      6     6    300.000
  2       20568.1      20568.0      +0.1ms      3     3    150.000
  3       39768.1      39768.0      +0.1ms      6     6    300.000
  4       58968.1      58968.0      +0.1ms      3     3    150.000
  5       68568.1      68568.0      +0.1ms      6     6    300.000
  6      100968.1     100968.0      +0.1ms      4     4    200.000
```

Six of six regions, every offset within 0.1 ms of the bar line a human placed
by hand, every signature right. Before this the same audio produced **two**
sections and a single subdivision for all of it.

Accuracy untouched, which the guard is there to ensure: **24/24 within 0.05 BPM
and 5 ms, median 0.0000 BPM / 0.16 ms**, `bpm-snapshot` and the golden vectors
both unchanged. On the 24-case corpus `detect_bar` returns "no bar" on every
fixture — those tracks put a hat on every beat and vary the kick only between
1.0 and 0.8 — so the new path never fires there. 76 unit tests, up from 69.

### Rejected / tried and dropped

- **Preferring the longest bar with usable accent contrast.** A four-bar
  hypermeasure still scores 1.24 on the reference track, beating the true
  three-beat bar at 1.22 under a "longest wins" rule and giving a 4800 ms
  measure where the truth is 1200. Strongest contrast wins instead, with
  near-ties going to the shorter reading — the one a mapper writes.
- **Labelling a region from the window that reads it.** A window wide enough
  to identify a signature is too wide to locate its change: one straddling the
  switch is labelled by whichever side fills more of it, which put every
  boundary exactly one bar early. Boundaries are now settled bar by bar, and
  a single ambiguous bar does not move the line.

### Open items

- **A signature change that keeps the beat and changes the bar's length**
  (4/4 → 3/4 at the same BPM) is a different shape and is not detected. The
  `measures` gate's `downbeat-4-then-3` case records it.
- The reference track is real audio; the reproduction is synthetic. On the real
  recording the offset came out about 20 ms late with 52 % confidence — the
  engine knew it was struggling. Synthetic fixtures remain an upper bound, as
  v3.0 already says of the corpus.

---

## v3.2 — 2026-09-22 · The measure grid, and timing a song from nothing

Tempora (`teamkongehund/Tempora`) times a song by associating points of time in
the music to a timeline of **measures and measure divisions**, by hand. Overtone
already automates the hard half of that — the pairing of audio time to beat
index is exactly `t(k) = offset + k·period`, solved over hundreds of attacks
instead of two hand-placed anchors. What it did not do was measures.

### Changed

- **Per-section time signature.** `section_measures` runs the meter detector on
  each section's own attacks. v3 read the meter once, from the first section,
  and wrote that number into every red line, so a song that moves to 3/4 for a
  bridge came out wrong everywhere after the change.
- **Red lines anchor to downbeats.** v3 anchored only the *first* line to a
  downbeat; every later section took the next plain beat, so osu!'s bar lines
  drifted out of step with the music after the first tempo change. Each section
  now anchors to its own downbeat — but only when its accents prove one.
- `TimingPoint` carries `meter` and `meter_known`. The second field matters:
  a point that does not know its bar falls back to the analysis meter rather
  than to a hard-coded 4, so writing 4 over a detected 3/4 cannot happen.
- New gate, `bench/gates.py measures`.

### Fixed

- **The click track accented every fourth beat regardless of meter** (audit
  **F-03**). A waltz clicked in 4 against the music, and the click track is
  what the README calls the arbiter — a mapper checking a 3/4 song by ear could
  have concluded the timing was wrong when it was not. Now accents on the
  point's own bar.
- **`snap_timing_points` dropped the bar.** It rebuilds each point, and the new
  fields were not carried, so every section silently reset to "unknown" before
  export and the per-section meter never reached the `.osu` or the click track.
  Caught by a test, not by inspection. The same omission was fixed in
  `update_timing_point`, `nudge_timing_point` and `rescale_section`.

### Hardening

- The "no evidence, no bar" rule is preserved exactly: a section whose accents
  do not prove a time signature reports `1` and keeps v3's beat anchoring.
  Guessing a bar without evidence pushes a red line up to three beats past
  where the music changed, which is worse than not knowing.

### Measured

Accuracy unchanged, which is the point: **24/24 within 0.05 BPM and 5 ms,
median 0.0000 BPM and 0.16 ms**, `bpm-snapshot` 24/24 unchanged, golden vectors
24/24 unchanged. 62 unit tests, up from 56.

The new gate needed its own fixtures, and the reason is worth recording. On the
24-case corpus the detector reports "no bar" on **every section**, and it is
right to: `build_track` puts a hat on every beat and varies the kick only
between 1.0 and 0.8, so downbeat contrast lands near 1.05 against a 1.20
threshold. The feature was therefore a no-op on the whole corpus — implemented
but unproven. Rather than lower a threshold with no ground truth to justify it,
three fixtures with an audible downbeat were added:

```
case                        truth     detected   anchored
downbeat-4-4                  [4]          [4]        yes
downbeat-3-4                  [3]          [3]        yes
downbeat-4-then-3          [4, 3]          [4]        yes
```

Anchoring is exact: the emitted offset sits a whole number of bars from its
section's downbeat, to within 2 % of a bar.

### Also changed — `.osz` export

The remaining piece of Tempora's workflow. v3 could only **inject** red lines
into a beatmap that already existed; `export_osz` writes the beatmap: a zip
holding the audio and a complete, openable `.osu` carrying this timing and
nothing else — no hit objects, no background, default difficulty. The point is
a file a mapper opens in the editor with the timing already correct.

`--osz out.osz`, with `--artist` / `--title` / `--creator` for the metadata.

Hardening, because an archive is a filename problem as much as a format one:

- the zip is built in a `.part` file and renamed into place, so an interrupted
  export cannot leave a half-written `.osz` that osu! refuses and the user does
  not think to delete;
- metadata is sanitised into the filename — path separators and the characters
  Windows refuses become `_`, and a run of dots collapses. `../../evil` cannot
  reach outside the archive, and a single dot survives because "Mr. Blue" is a
  legitimate artist;
- the audio is size-capped before anything is written;
- an analysis with no usable points is refused rather than producing a beatmap
  with an empty `[TimingPoints]`.

Seven tests, including that a failed export leaves neither the archive nor the
temporary file behind.

### Open items

- **A time-signature change at constant tempo is not detected.** Sections split
  on tempo, so 4/4 → 3/4 at the same BPM stays one section and only the first
  bar is reported (`downbeat-4-then-3` above). Tempora lets a user set the
  signature per audio block regardless of tempo; matching that needs a
  meter-change detector alongside the tempo one.

---

## v3.1 — 2026-09-22 · Audit, and the v4 design

No engine behaviour changed. This entry exists because the next release is a rewrite, and
a rewrite with no written baseline is how a 0.16 ms tool becomes an 8 ms tool without
anyone noticing.

### Changed

- **`docs/` — nine design documents** covering the audit of v3, a five-way stack
  evaluation, the v4 architecture, the UI/UX language, the DSP porting contract, the
  hitsound engine, the roadmap (phases 0–9), an ML assessment, and naming.
- **README rewritten** around what is measured versus what is designed. Every number now
  carries the date and the environment that produced it.
- **`CLAUDE.md` / `AGENTS.md`**: contributor and agent conventions. No `Co-Authored-By`
  trailers, no GitHub Actions — every gate is a local one-liner.
- `.gitignore` scoped so `.osu` and `.csv` **fixtures can be committed**; the repo-wide
  ignore is why the one sample lives as `STK_timing_points.osu.txt`.
- **`bench/gates.py`** — two gates for things the accuracy benchmark structurally cannot
  see. `bpm-snapshot` pins the **absolute** reported BPM per fixture (`bench/bpm_snapshot.json`,
  24 cases): the benchmark normalizes octaves, so a change to the octave decision could
  halve every track and all 24 rows would stay green. Verified by tampering with the
  baseline — it reports `global BPM 112.5 -> 225.0  <-- OCTAVE FLIP`. `coverage` measures
  the density signal behind F-11 on three half/double-time fixtures, deliberately kept out
  of `benchmark.CASES` so the published 24/24 stays comparable.
- **`bench/golden.py`** — per-stage golden vectors: attacks, coherence candidates, seed
  grids, octave, atom sections, beat sections, meter and points, 362 KB committed across
  the 24 fixtures, with a `check` mode that diffs stage by stage within documented
  tolerances (attacks 0.05 ms, period 1e-6 s, offsets 0.05 ms). This is the harness the
  Rust engine gets pointed at in Phase 1: a port can reach the right BPM through a wrong
  envelope and a compensating peak-picker, and only a stage-by-stage diff catches that.
  It captures by wrapping the private stage functions with recording proxies, so it
  duplicates no pipeline logic — what is recorded is what the shipped path computed.
- **`requirements.lock`** — the exact versions behind the measured baseline.
- One test added (56 total): `test_pulse_hints_only_ever_suggest_doubling`, which
  documents that `suggest_section_pulse` has no downward direction.
- **`proto/` — the two highest-risk roadmap algorithms, prototyped in Python** against the
  existing corpus before committing to them in Rust. Both are Phase 2 items rated
  difficulty *high* / impact *high*, and both would have been expensive to discover wrong
  after a port. Results in [`proto/README.md`](proto/README.md); summary under Measured.
- **Renamed to Overtone.** The repository was `githaltwastaken/Timing-Analyzer`; an
  overtone is a frequency above the fundamental, which is what the coherence sweep spends
  its time separating — `R(f)` peaks at the true pulse and at every multiple of it.
  Renamed: README, all docs, `CLAUDE.md` / `AGENTS.md`, this file, the GUI title and about
  box, the CLI description, and the `.osu` comment. Settings moved to `~/.overtone.json`
  with `~/.timing_analyzer.json` read as a fallback, so an existing install keeps its
  preferences instead of silently losing them. `timing_analyzer.py` keeps its filename on
  purpose — it is the v3 reference implementation and the roadmap already moves it to
  `reference/python-v3/` in the same commit that creates `crates/`; renaming it now would
  touch every import in the suite, the benchmark and all three gates for no gain.

### Fixed

- **`_atomic_grid_candidates` rebound its own `keep` parameter** with a 5000-element index
  array in the dense-audio guard, so `strong[:keep]` would raise `TypeError` and drop the
  whole analysis to the v2 tracker. Currently unreachable — every call site goes through
  `_seed_grid`, whose windows are at most 30 s, and the 25 ms minimum peak spacing caps
  that at ~1200 attacks — but the v4 design widens exactly those windows, and the code's
  own comment at `MAX_SCAN_FREQS` predicts it. Renamed the local to `dense`.
- **`window_of` was defined twice, identically, in `_tune_boundary`.** Copy-paste residue;
  Python binds the second, so behaviour was never affected. Deleted the first.

### Hardening

- Not applicable; no new I/O or parsing paths.

### Measured

The v3 baseline was **reproduced on this machine**, which matters more than quoting it:

| | published | reproduced 2026-09-21 |
|---|---|---|
| median BPM error | 0.0000 BPM | **0.0000 BPM** |
| median offset error | 0.16 ms | **0.16 ms** |
| sections within 0.05 BPM and 5 ms | 24/24 | **24/24** |
| unit tests | 55 | **55/55 pass** (56/56 after this release's addition) |

Environment: Windows 11 26200, Python 3.14.4, numpy 2.5.3, scipy 1.18.1, librosa 1.0.0,
numba 0.67.0. Worth recording because `requirements.txt` has lower bounds only, and the
resolve pulled librosa **1.0.0** — a major version past what v3 was developed against.
Everything passes on it; nothing in the repo would have told us either way.

Corpus wall time: **21.6 s for 24 tracks** single-threaded, worst case 5.0 s on the
6-minute fixture. Cheap enough that the full accuracy gate can run on every commit, which
removes the last excuse for an unmeasured change.

Two results the README did not previously state:

- `change-175-87.5` reports **1 of 2 sections**, and the cause is not what it looked
  like. My first diagnosis blamed the global octave decision; instrumenting the engine
  showed otherwise:

  ```
  ATOMIC grid on 175 region  : share=1.000 coverage=1.000 rms=1.27 ms
  ATOMIC grid on 87.5 region : share=1.000 coverage=0.633 rms=2.18 ms
  growth gate: break when share < 0.55 or rms > 15.43 ms
  ```

  The grid is continuous across the change, so every attack in the slow half still lands
  on the fast half's grid and `share` never moves. What halves is **coverage** — and
  `_grow_sections` computes it and throws it away (`share, _cov, rms = _grid_quality(...)`).
  The statistic `_seed_grid` ranks candidates by is discarded by the loop that decides
  whether a section continues. The signal is strong (drop 0.36–0.46 across three fixtures)
  and localises the change to within one 8-beat window, but it lives on the **subdivided**
  grid: at beat level coverage is 1.000 for the whole track, and the first version of the
  gate measured beat level, found nothing, and would have "proved" the signal absent.

  Whether it *should* split is a separate and genuinely open question — the README's
  policy is to keep the BPM through a half-time section, while the benchmark's ground
  truth asserts two sections. The repository contradicts itself and nothing resolves it.
  Third part of the gap: `suggest_section_pulse` returns early for any point at or above
  120 BPM, so it can only ever propose `×2` and offers nothing here.
- The octave choices are visible for the first time now that they are pinned:
  `slow-92` is reported as **184.000** and `fast-300` as **150.000**. Both were previously
  hidden behind the benchmark's `x2` / `x0.5` notes.
- White noise returns `127.68 BPM` through the legacy tracker. It should refuse.

**Prototype results** (`proto/`, full detail in `proto/README.md`):

*Density detector* — **4/4** real half/double-time changes found, **0 false positives out
of 23**, worst localisation error 1.37 s (one 8-beat window). Zero false positives on the
three fixtures built to look like this — a 6 s drop, a 10 s sparse region, and a track with
both — is the result that matters, and **parity** is what buys it: coverage says "half the
slots are empty", parity says "and it is every other one, not a random half". Verdict:
build it.

*Elastic grid* — a polynomial in `k` (degree 1 *is* v3, degree 2 is a ramp), so IRLS
carries over unchanged.

| case | deg | rms | fitted BPM | BPM err med/max | v3 |
|---|---:|---:|---|---|---|
| ramp-120-160 | 3 | 4.06 ms | 120.65 -> 159.04 | **0.163** / 0.748 | legacy, 8 sections |
| ramp-180-140 | 3 | 2.70 ms | 179.32 -> 140.44 | **0.144** / 0.536 | legacy, 13 sections |
| ramp-90-200 | 3 | 23.79 ms | 98.92 -> 189.51 | 1.387 / 10.739 | legacy, 1 section |

And the test that mattered more — it does **not** invent curvature: **22 of 24** constant
fixtures chose degree 1 with **0.00 % drift**. The two that bent, `secs-4` and
`tiny-change`, both have genuine tempo changes, so the model was noticing real changes and
smoothing them rather than hallucinating. That makes residual a clean **selector**: where
v3's piecewise fit applies it wins by two orders of magnitude (0.15 ms vs 8-15 ms); where
it falls back, elastic wins. The two models are complementary, not competing, and v4
should fit both and report which one answered.

### Rejected / tried and dropped

- **Porting the v2 hybrid tracker to Rust as the v4 fallback.** It means reimplementing
  librosa's DP beat tracker and PLP to reproduce an engine whose measured output on the
  degenerate corpus is an 8-section staircase on a tempo ramp and a confident BPM for
  white noise. Instead: keep the Python v3 runnable as the reference that produces
  `--engine legacy` numbers, ship an elastic (spline) tempo model for genuinely varying
  tempo, and refuse honestly when neither fits.
- **GPU compute for the analysis pipeline.** A 6-minute track is ~124k frames of
  1024-point real FFT; on CPU with rayon that is well under a second against the 5.0 s
  measured in Python. Transfer overhead, driver variance and a second numeric path to
  validate, for a fraction of an already-negligible cost. GPU is used for *rendering*,
  where the timeline genuinely needs it.
- **Extending the elastic tempo curve past its samples with the edge slope.** A ramp
  genuinely keeps ramping, and measurement showed the entire max error on every ramp
  fixture is edge behaviour rather than curve shape, so this looked like the obvious fix.
  It made the extreme fixture *worse* — median 0.63 -> 5.65 BPM, because a steep edge slope
  fed the polynomial-in-k stage badly enough to flip its degree choice — and changed
  nothing on the other two. Clamping at the sample edges is kept.
- **Seeding the elastic fit with a constant period.** Assigning beat indices with one
  period across a 60 s ramp slips indices, and least squares cannot recover a slipped
  index — the same failure mode this file records for the coherence phase sign. It
  returned degree 1 at 30 ms rms and a tempo 17 BPM from truth. The pipeline has to be
  curve-first: sample locally, normalise octaves, fit `period(t)`, integrate to a grid,
  *then* assign indices.
- **Fixing the click track's hardcoded 4-beat accent** (finding F-03, audible on 3/4
  tracks). It is a behaviour change to an audio export with no test covering the accent
  pattern, and the rule is that precision-adjacent code does not change without a test in
  the same commit. Patch is written down in the audit; it lands with its test.

### Open items

Unchanged from v3.0, plus: `_grow_sections` should consult coverage (F-11), and
`suggest_section_pulse` needs a downward direction so a half-time region can be surfaced
the way the global octave already is. Both now have gates that measure the signal; neither
has a fix.

Phase 0's remaining work is blocked on the Rust toolchain (MSVC Build Tools, then rustup
with the `x86_64-pc-windows-msvc` target), which is not installed. Everything in Phase 0
that does not need it is done.

---

## v3.0 — 2026-09-04 · Least-squares grid engine

The headline change: **BPM is no longer derived from the gaps between beats.**

### Why the old approach capped out

v2 computed tempo as `60 / (t[k+1] - t[k])`, smoothed. Every detected beat carries
a few milliseconds of onset-detector jitter, and differencing two jittery numbers
*amplifies* that noise instead of averaging it away. No amount of median filtering
downstream can recover information the differencing threw out. That is why v2 sat
at ~0.2 BPM of wobble and ~8 ms of offset error no matter how the filters were tuned.

v3 fits an explicit model to the attack times instead:

```
t(k) = offset + k · beat_length        (k = integer beat index)
```

by iteratively re-weighted least squares. With N inlier attacks the fitted period
averages the jitter down by √N. That single change is where essentially all of the
accuracy gain comes from; everything else in this entry exists to make sure the fit
is seeded correctly and applied to the right span of audio.

### Changed

- **Attack detection at sample resolution.** Peaks come off a 2.9 ms onset envelope
  (hop 128, was 256) with parabolic sub-frame interpolation, then each one is
  **re-timed on the raw waveform**: a local energy window walked back to its 20 %
  rise. A spectral-flux peak lags the physical attack by roughly one analysis
  window, which is exactly the ~8 ms bias v2 shipped with. Measured after the fix:
  attacks land 0.15 ms from truth with 0.15 ms spread.
- **Circular-coherence pulse sweep.** `R(f) = |Σ w·e^{2πi f t}| / Σ w` scores a
  candidate pulse rate in one O(N) pass, so the whole plausible range is swept
  rather than trusting one tracker's guess. Candidates are ranked by
  *share* × *coverage* (see Rejected, below).
- **Expanding-window least squares.** The fit grows over the track in doubling
  spans, so a 1 % seed error is absorbed without ever slipping a beat index.
- **Octave from accent depth.** Attacks are grouped by index modulo *m*; if *m*
  atoms really make a beat, one class holds the kicks and another the filler, so
  the spread between strongest and weakest class is large. That plus tempogram
  hints read through librosa's log-normal prior picks the beat — and the downbeat.
- **Sections grow and re-seed.** A region extends forward while attacks keep
  landing on its grid; the next region runs **its own** coherence scan instead of
  inheriting a period that just failed. Boundaries then settle on the beat where
  the two grids cross, and every section is refitted on its own attacks alone.
- **Legacy engine kept as a fallback**, not deleted. Rubato, free time and
  non-percussive audio have no grid to fit; those fall through to the v2 hybrid
  tracker and the analysis says so (`engine: legacy` in `--stats`).
- API: `analyze_audio(..., engine="auto"|"precision"|"legacy")`;
  `force_subdivision` is now a float (`0.25 … 4`, so ÷2 finally exists in the GUI
  and CLI); `osu_timing_text(analysis, decimals=0)`; new `GridSection` dataclass and
  `Analysis.sections / attack_times / attack_weights / engine / fit_residual_ms`.
- **The benchmark harness is in the repo** (`bench/benchmark.py`): 24 synthesized
  tracks with exact ground truth plus four no-answer inputs, scoring every section
  rather than only the first, seeded per track so a subset run reproduces a full
  one byte-for-byte. `--engine legacy` reproduces the v2 column of the table below
  from the same code, which is the only way the comparison means anything.
- Docs: README rewritten around the measured numbers and an explicit
  "Honest limits" section. Tests 35 → 55.

### Fixed

- **Coherence phase came back negated.** `z = Σ w·e^{2πi f t}` has
  `arg(z) = 2π f φ`, so `φ = arg(z)/(2πf)` — the code used `-arg(z)`. Every seed
  grid started in **anti-phase**, half a beat off, and least squares cannot recover
  from a slipped beat index. This was the single largest source of error in the
  first working version of the engine. Regression test:
  `GridMathTests.test_coherence_phase_has_the_right_sign`.
- **`_refine_beats_to_transients` had a latent `NameError`**: `dtype(...)` where
  `dtype=...` was meant, on the empty-input branch. Present since v2.1.
- **Variable-tempo tracks collapsed into one section.** A global expanding fit ran
  *before* section growth, so on a 128 → 142 BPM track it locked onto 142 and the
  per-section seeds inherited that. Removed; each section now seeds itself.
- **Section boundaries landed a beat late.** The reach walk that decides where a
  grid stops explaining attacks used a 5 %-of-beat tolerance, loose enough for the
  *old* grid to claim the *new* tempo's first beat. Now driven by each side's own
  fit residual.
- **Swung and ornamented music pulled the offset late.** Least squares balances
  everything inside its tolerance window, so a second population of attacks (swung
  off-beats, ghost notes) dragged the grid halfway toward them — 17 ms on the
  shuffle fixture. `_recentre_phase` scores candidate shifts with a narrow Gaussian
  and snaps to the *mode* rather than the mean. 17 ms → 0.09 ms.
- **`min_delta` was scaled the wrong way** when handed to the atom-level segmenter
  (`/m` instead of `*m`), making the change detector ~m² more sensitive than the
  documented parameter promised.
- `_robust_local_bpms` raised `IndexError` on arrays of 0 or 1 beats.
- The GUI editor located the edited point with `list.index()`, which matches by
  *value* on a frozen dataclass — duplicate points returned the wrong row.

### Hardening

- **`.osu` injection is now atomic** (temp file + rename). Previously a crash or
  power loss between truncate and write destroyed the user's beatmap.
- **An existing `.bak` is never overwritten.** Injecting twice used to back up the
  already-injected file, losing the pristine original for good.
- **Legacy `.osu` red lines are recognised.** Format v3/v4 wrote only
  `time,beatLength`; the old 8-field check treated those as green, so a legacy map
  kept its old red lines *and* gained the new ones. A negative beat length now
  always means inherited, overriding a contradictory flag.
- **Offsets export as whole milliseconds.** The `.osu` format specifies integers and
  osu!stable does not accept decimals; v2.2 wrote `.3f`. The fit is sub-millisecond,
  so rounding costs at most 0.5 ms. `--decimal-offsets N` opts back in for lazer.
- **A corrupt config no longer bricks the app.** `load_config` returned whatever
  JSON it found; a list or a scalar crashed startup with `AttributeError`, which the
  user could only fix by deleting `~/.timing_analyzer.json` by hand. Now validated,
  size-capped, and written atomically.
- **Resource limits** against absurd or hostile input: audio duration is checked
  from the file *header* before decoding, plus caps on `.osu` size, config size,
  click-track length, coherence-sweep frequencies, and onsets fed to the O(N×M)
  kernel scans.
- Division-by-zero guards for hand-edited 0 BPM points along every export path;
  a cap on the legacy peak-tracker's gap reconstruction loop.
- **The fallback is no longer silent.** An unexpected exception inside the precision
  engine used to degrade quietly to the legacy tracker, which hides a real bug
  behind merely-worse numbers. It now reports the exception type in the progress
  message — and this immediately caught a live regression during development (a
  cleanup pass deleted two helper functions and every benchmark silently dropped
  back to v2-quality output).
- Audited and clean: no `eval`/`exec`/`pickle`/`subprocess`/`shell=True`, no
  user-controlled format strings, no writes outside the target file's own directory.

### Measured

24-track synthetic benchmark with exact ground truth (odd tempos incl. 222.222 and
128.37, added noise, ±8 ms performance jitter, swing and shuffle, drops, sparse
breakdown bars, a 6-minute track, and 2–4 tempo changes per song), scoring **every**
section rather than only the first:

| | v2 engine | v3 engine |
|---|---|---|
| median BPM error | 0.1965 BPM | **0.0000 BPM** |
| median offset error | 8.37 ms | **0.16 ms** |
| sections within 0.05 BPM **and** 5 ms | 0 / 24 | **24 / 24** |
| wall time, 60 s track | ~5 s | **~0.7 s** |

Both columns come from the same harness, now committed as `bench/benchmark.py`:
`python bench/benchmark.py` and `python bench/benchmark.py --engine legacy`.

The speedup is incidental: the old tempogram ran at hop 128 and cost ~10 s of the
~11 s total. It only ever fed an octave *hint*, which needs no such resolution, so
it now runs on a 4× max-pooled envelope.

Degenerate inputs behave: a 120 → 160 BPM ramp and pad-only audio fall back to the
legacy tracker, pure silence raises a clear `ValueError`, white noise does not hang.

### Rejected / tried and dropped

- **"Slowest strong coherence peak" as the atomic grid.** `R(f)` is high at the true
  pulse *and every multiple of it*, so the fundamental is the slowest strong peak —
  in theory. In practice a 12-second uniform click track has near-flat coherence and
  a grid at half density (share 0.5) still qualified, halving the tempo. Replaced by
  ranking on *share* × *coverage*: a grid twice too slow explains only half the
  attack energy, a grid twice too fast fills only half its own slots, and only the
  true atom scores on both. Requiring `share ≥ 0.72` instead was tried first and
  rejected — it rejects legitimately ornamented music (the shuffle fixture sits at
  0.53) while still admitting the half-density case at 0.559.
- **Least-squares residual cost for section boundaries.** It is *flat* at the true
  change, because at a real tempo change both grids pass through the same beat and
  fit equally well on either side of it. Measured cost differed by 0.9 % between the
  correct split and one a beat early — noise. What *is* sharp is that the two grids
  share a beat there and drift apart linearly away from it, so the boundary is now
  placed at that crossing.

### Open items

- **The octave remains a judgement call, and always will be.** A 92 BPM song with
  eighth-note hats is a valid 184 BPM map; 225 BPM streams read as 112.5 to any
  estimator carrying a perceptual prior. `Prefer map BPM (120–300)` breaks the tie
  toward osu!'s range and ×2 / ÷2 is now instant and exact, but no detector settles
  this for you.
- Rubato and non-percussive audio still route to the v2 tracker, which emits a
  staircase of sections. Fitting a slowly-varying tempo curve (rather than piecewise
  constant) would serve those tracks properly.
- Swing and shuffle produce exact BPM and offset but a large grid residual, because
  the off-beats genuinely do not sit on a subdivision. That number is honest, but the
  confidence score currently reads it as instability.
- **The benchmark is entirely synthetic.** That is what makes sub-millisecond ground
  truth possible, but synthesized drums are cleaner than recorded ones and the
  numbers above should be read as an upper bound, not a promise about real masters.
  A small set of real tracks hand-timed in the osu! editor would be the honest
  complement — expensive to build, and worth it.

---

## v2.2 — 2026-09-03 · Editing, injection, hardening

Two commits (`0576894`, `ea5cb6e`).

- **Changed**: manual timing-point editor (add / update / delete / nudge ±1 and
  ±5 ms / per-section ×2 and ÷2); `.osu` injection preserving green lines and CRLF
  style with a `.bak` backup; per-section half-time pulse hints; menu bar i18n.
- **Fixed**: CSV column labels; CLI error paths made to exit cleanly instead of
  raising tracebacks; the GUI worker thread stopped touching Tk variables (it now
  captures parameters before the thread starts).
- **Hardening**: parameter validation before any I/O; validation tests.
- **Measured**: not measured — accuracy work in this release was qualitative.

## v2.1 — 2026-09-03 · Hybrid tracking

Commit `a3bc82e`.

- **Changed**: hybrid beat tracking (librosa DP + PLP + peak-picking fallback, most
  clock-regular candidate wins); sub-frame parabolic transient re-anchoring;
  half/double-time resolved from onset evidence at subdivided grid positions rather
  than blind multiplication; defaults retuned for songs that change tempo often;
  English as the default UI language.
- **Fixed**: half-time locks collapsing a whole map into one "constant" section
  (225 vs 222.2 differ by only ~1.4 BPM once halved, below `min_delta`).
- **Measured**: not measured — no ground-truth harness existed yet, which is
  precisely why the v2 error floor went unnoticed until v3.

## v1 — 2026-09-03 · Initial release

Commit `fae9bf7`. Onset-strength envelope, `librosa.beat.beat_track`, tempo from
smoothed beat intervals, persistence-based segmentation, Tk GUI, CSV and `.osu`
text export.

---

## Resumen en español

Este archivo es el registro de ingeniería del proyecto: qué cambió, **por qué**, y
qué efecto medible tuvo. Entradas de más nueva a más vieja, una por versión, cada
una con las mismas cuatro secciones (Changed / Fixed / Hardening / Measured) más,
cuando aplica, `Rejected` — las ideas que se probaron y se descartaron, porque el
razonamiento es lo caro de reconstruir después.

El cambio central de v3.0: el BPM ya no sale de las diferencias entre beats
consecutivos, sino de un ajuste por mínimos cuadrados sobre los tiempos de ataque.
Error mediano 0,0000 BPM y 0,14 ms frente a 0,18 BPM y 8,2 ms en v2.2, y unas 7
veces más rápido. Lo que sigue sin resolverse — y no lo resuelve ninguna
herramienta — está en `Open items`.
