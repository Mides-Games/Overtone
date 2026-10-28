-- The Overtone website's schema (docs/16-web-platform.md, §4 "Data model").
--
-- Idempotent: `pnpm --dir site/api db:migrate` applies it as many times as it
-- likes, and `pnpm --dir site/api check` proves that by applying it twice to a
-- throwaway schema. A column added later goes in as `ADD COLUMN IF NOT EXISTS`
-- below its table, never by editing the CREATE: a database made from the old
-- CREATE would never see it.
--
-- No table names a schema, so the check can run it under its own search_path.
-- gen_random_uuid() is core PostgreSQL from 13 on.

-- ── Identity ────────────────────────────────────────────────────────────────

-- A Mides account as this site knows it. Only public profile fields are
-- cached: no email, no phone. The key is mides_user_id; the username is
-- refreshed at every sign-in because Mides cannot look a user up by id.
CREATE TABLE IF NOT EXISTS accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mides_user_id   text NOT NULL UNIQUE,
  username        text NOT NULL,
  display_name    text,
  avatar_url      text,
  banner_url      text,
  discord_id      text,
  mides_role      text,
  -- Bumped at sign-out: every cookie signed with the old value stops working.
  session_version integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cached_at       timestamptz NOT NULL DEFAULT now()
);

-- Overtone keeps no Mides token: Mides gives it an access with its own audience
-- and no refresh, and the profile is all it needs. The table that held sealed
-- refresh tokens goes, and takes any old ones with it.
DROP TABLE IF EXISTS mides_tokens;

-- W9.1 and W9.2, the linked accounts (docs/bot.md). `discord_id` (above) is
-- the Discord user id, from the Mides profile when Mides sends one, or from
-- the bot's /link code; one Discord user names one account at most.
-- `discord_notify` is the opt-in to a DM from the bot when an analysis ends
-- (W9.4). The osu! columns are what /me of the osu! API said at link time,
-- read once with the `identify` scope; the osu! token itself is never kept.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS discord_notify   boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS osu_user_id      bigint CHECK (osu_user_id > 0);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS osu_username     text CHECK (char_length(osu_username) <= 32);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS osu_avatar_url   text CHECK (char_length(osu_avatar_url) <= 300);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS osu_ranked_count integer CHECK (osu_ranked_count >= 0);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS osu_linked_at    timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_discord_idx ON accounts (discord_id) WHERE discord_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_osu_idx ON accounts (osu_user_id) WHERE osu_user_id IS NOT NULL;

-- W9.1's fallback while Mides sends no Discord id: the profile shows a code,
-- the person types `/link <code>` to the bot, and the bot names the Discord
-- user. Only the code's HMAC is kept; it lives ten minutes, one per account.
CREATE TABLE IF NOT EXISTS discord_link_codes (
  code_hash       text PRIMARY KEY CHECK (char_length(code_hash) <= 64),
  account_id      uuid NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL
);

-- W9.4, the bot's outbox: one row per finished analysis of an account that
-- asked for DMs. The bot claims rows (sent_at set in the same statement), so a
-- notice goes at most once; a lost one is cheaper than a doubled one.
CREATE TABLE IF NOT EXISTS discord_dms (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  public_id       char(32) NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS discord_dms_pending_idx ON discord_dms (id) WHERE sent_at IS NULL;

-- ── Songs, analyses and the queue ───────────────────────────────────────────

-- A song is its audio's SHA-1, the same hash a .osz carries. The audio itself
-- is never stored (ADR-W4).
CREATE TABLE IF NOT EXISTS songs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audio_sha1      char(40) NOT NULL UNIQUE CHECK (audio_sha1 ~ '^[0-9a-f]{40}$'),
  duration_ms     integer CHECK (duration_ms >= 0),
  title           text,
  artist          text,
  beatmapset_id   bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  song_id         bigint NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  -- Hashed client address for the anonymous daily quota (ADR-W6); never the address.
  ip_hash         text,
  engine          text NOT NULL CHECK (engine IN ('v3', 'v4')),
  engine_hash     text NOT NULL,
  result          jsonb,
  confidence      real CHECK (confidence BETWEEN 0 AND 1),
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- W3.4, the upload flow. The bigint id stays internal; the browser and the
-- worker name an analysis by public_id, 128 random bits in hex, so ids cannot
-- be walked. anon_hash is the SHA-256 of the anonymous cookie that created
-- the row (never the cookie). cached_from marks a row answered from an earlier
-- analysis of the same audio and engine: no job, and not counted in the quota.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS public_id   char(32) UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$');
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS anon_hash   text;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS filename    text CHECK (char_length(filename) <= 200);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS size_bytes  bigint CHECK (size_bytes >= 0);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'running', 'done', 'refused', 'failed'));
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS stage       text;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS progress    real CHECK (progress BETWEEN 0 AND 1);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS error       text;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS cached_from bigint REFERENCES analyses (id) ON DELETE SET NULL;
-- W3.8, the public queue. `private` hides the file name, the song and the
-- uploader there. tag_title and tag_artist are what the browser read from the
-- audio's own tags at upload, cleaned like the file name; the queue names a
-- song by them, or by the file name when the file had none.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS private     boolean NOT NULL DEFAULT false;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS tag_title   text CHECK (char_length(tag_title) <= 200);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS tag_artist  text CHECK (char_length(tag_artist) <= 200);
-- W3.27 and W5.1, a timing's own page and the recent list. An analysis is
-- public only once its uploader published it (published_at set): opt-in,
-- never automatic, and undone by clearing it. A column, not a row in
-- `timings`: that table is for timings people edit and fork (W4), and a
-- published analysis is the engine's reading as it came. W3.26, delete-own:
-- deleted_at marks a finished analysis its owner deleted. Its result, names
-- and publication are cleared at once; the row itself stays until the day is
-- over only so it keeps counting in that day's quota (otherwise delete and
-- analyse again would be a way around it).
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS deleted_at   timestamptz;
CREATE INDEX IF NOT EXISTS analyses_published_idx ON analyses (published_at DESC, public_id DESC) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS analyses_song_idx ON analyses (song_id);
-- The queue page reads the unfinished rows and the latest finished ones.
CREATE INDEX IF NOT EXISTS analyses_live_idx ON analyses (status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS analyses_finished_idx ON analyses (finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS analyses_cache_idx ON analyses (song_id, engine_hash) WHERE result IS NOT NULL;
-- W11.1, W3.21, W12.19 and W3.24: how the analysis was asked for. `mode` is
-- how long the person chose to wait (fast, normal, strict); `options` the
-- hints they gave (tempo, BPM, meter, a stretch), NULL for none, and
-- `options_key` the same hints as one canonical string ('' for none). Both
-- are part of the cache key: the same audio asked for another way is another
-- result. `audio_seconds` is the length the browser read, used only for the
-- queue's estimate (W3.16). `reanalysis_of` links a re-analysis in another
-- mode to the result it was made from.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS mode          text NOT NULL DEFAULT 'normal'
  CHECK (mode IN ('fast', 'normal', 'strict'));
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS options       jsonb;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS options_key   text NOT NULL DEFAULT '' CHECK (char_length(options_key) <= 512);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS audio_seconds real CHECK (audio_seconds > 0 AND audio_seconds <= 14400);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS reanalysis_of bigint REFERENCES analyses (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS analyses_cache_mode_idx ON analyses (song_id, engine_hash, mode, options_key) WHERE result IS NOT NULL;
CREATE INDEX IF NOT EXISTS analyses_reanalysis_idx ON analyses (reanalysis_of) WHERE reanalysis_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS analyses_account_idx ON analyses (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analyses_ip_day_idx ON analyses (ip_hash, created_at) WHERE account_id IS NULL;

-- The queue (ADR-W5): workers take rows with SELECT ... FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS jobs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_id     bigint NOT NULL UNIQUE REFERENCES analyses (id) ON DELETE CASCADE,
  state           text NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'running', 'done', 'failed')),
  priority        smallint NOT NULL DEFAULT 0,
  attempts        smallint NOT NULL DEFAULT 0,
  locked_at       timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_queued_idx ON jobs (priority DESC, id) WHERE state = 'queued';
-- W3.9, the fair order: when a person's latest job was taken, so that between
-- equal turns whoever was served longest ago goes first. locked_at cannot say
-- it: it is cleared when the job ends.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS jobs_claimed_idx ON jobs (claimed_at) WHERE claimed_at IS NOT NULL;
-- The sweep that hands a stuck job back (JOB_TIMEOUT_S) reads running rows by age.
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (locked_at) WHERE state = 'running';

-- ── Rate limits ─────────────────────────────────────────────────────────────

-- W3.17: the per-address request limits (middlewares/rate-limit.js), here so
-- that every API process behind the proxy counts together. One row per bucket
-- and client; `client` is an HMAC of the address, never the address. A row is
-- one fixed window: the upsert that counts a request also starts a new window
-- once reset_at has passed, and dead windows are swept a minute later.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket          text NOT NULL CHECK (char_length(bucket) <= 32),
  client          text NOT NULL CHECK (char_length(client) <= 64),
  count           integer NOT NULL CHECK (count >= 1),
  reset_at        timestamptz NOT NULL,
  PRIMARY KEY (bucket, client)
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);

-- ── Timings and the social layer ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  song_id         bigint NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  analysis_id     bigint REFERENCES analyses (id) ON DELETE SET NULL,
  forked_from     bigint REFERENCES timings (id) ON DELETE SET NULL,
  red_lines       jsonb NOT NULL,
  visibility      text NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public', 'unlisted', 'private')),
  notes           text,
  ranked_match    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS timings_song_idx ON timings (song_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS timings_account_idx ON timings (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS timing_ratings (
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  timing_id       bigint NOT NULL REFERENCES timings (id) ON DELETE CASCADE,
  stars           smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, timing_id)
);

CREATE TABLE IF NOT EXISTS timing_reactions (
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  timing_id       bigint NOT NULL REFERENCES timings (id) ON DELETE CASCADE,
  emoji           text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, timing_id, emoji)
);

-- "Used N times": the most honest reputation measure. Anonymous uses count
-- by hashed address.
CREATE TABLE IF NOT EXISTS timing_uses (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  timing_id       bigint NOT NULL REFERENCES timings (id) ON DELETE CASCADE,
  ip_hash         text,
  used_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timing_uses_timing_idx ON timing_uses (timing_id);

CREATE TABLE IF NOT EXISTS timing_comments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timing_id       bigint NOT NULL REFERENCES timings (id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  parent_id       bigint REFERENCES timing_comments (id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  score           integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS timing_comments_timing_idx ON timing_comments (timing_id, created_at);

CREATE TABLE IF NOT EXISTS collections (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id   bigint NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  timing_id       bigint NOT NULL REFERENCES timings (id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, timing_id)
);

-- ── Moderation and notices ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reports (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_kind     text NOT NULL CHECK (target_kind IN ('timing', 'comment', 'account')),
  target_id       text NOT NULL,
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE state = 'open';

-- W3.18, the queue moderated: every job a staff member removed from the queue
-- or handed back to it, and who did it. `moderator` is the username at the
-- time, so the record still says who after the account goes; `public_id` stays
-- after the analysis does (a cancelled one is deleted, W3.12).
CREATE TABLE IF NOT EXISTS moderation_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  moderator       text NOT NULL,
  action          text NOT NULL CHECK (action IN ('remove', 'requeue')),
  analysis_id     bigint REFERENCES analyses (id) ON DELETE SET NULL,
  public_id       char(32),
  reason          text CHECK (char_length(reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_log_created_idx ON moderation_log (created_at DESC);

-- ── Community: suggestions, reviews, and their moderation (W5.2-W5.4) ───────

-- A suggestion from a signed-in account. `public_id` is 128 random bits in
-- hex, as an analysis has. Only staff change `state`; `state_reason` is the
-- latest change's reason (a rejection always has one), and the whole history
-- is in moderation_log. A hidden one is shown to staff only.
CREATE TABLE IF NOT EXISTS suggestions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$'),
  account_id      uuid REFERENCES accounts (id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  state           text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'review', 'planned', 'progress', 'done', 'rejected')),
  state_reason    text CHECK (char_length(state_reason) <= 500),
  hidden          boolean NOT NULL DEFAULT false,
  hidden_reason   text CHECK (char_length(hidden_reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suggestions_created_idx ON suggestions (created_at DESC);

-- One vote per account and suggestion: the primary key is the rule.
CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id   bigint NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, account_id)
);

-- A review of the site: with an account (one per account, editable) or
-- anonymous. `ip_hash` is kept for anonymous ones only, the same daily HMAC an
-- anonymous upload keeps, to count them per address and day; it is never shown.
CREATE TABLE IF NOT EXISTS reviews (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$'),
  account_id      uuid REFERENCES accounts (id) ON DELETE CASCADE,
  ip_hash         text,
  stars           smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  hidden          boolean NOT NULL DEFAULT false,
  hidden_reason   text CHECK (char_length(hidden_reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_account_idx ON reviews (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reviews_created_idx ON reviews (created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_ip_day_idx ON reviews (ip_hash, created_at) WHERE account_id IS NULL;

-- Reports reach suggestions and reviews too, from anyone: an anonymous
-- reporter is known by the daily address HMAC, never the address. One open
-- report per reporter and item; a staff decision on the item resolves them.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ip_hash text;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_kind_check
  CHECK (target_kind IN ('timing', 'comment', 'account', 'suggestion', 'review'));
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_idx
  ON reports (target_kind, target_id, (coalesce(account_id::text, 'ip:' || ip_hash))) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (target_kind, target_id) WHERE state = 'open';

-- One moderation log for the queue and the community (W3.18's table): what
-- was acted on (`target_kind`, `target_ref` its public id), and for a
-- suggestion's state change the state before and after. Rows written before
-- this are the queue's, which the default says.
ALTER TABLE moderation_log ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'analysis'
  CHECK (target_kind IN ('analysis', 'suggestion', 'review'));
ALTER TABLE moderation_log ADD COLUMN IF NOT EXISTS target_ref text CHECK (char_length(target_ref) <= 64);
ALTER TABLE moderation_log ADD COLUMN IF NOT EXISTS from_state text CHECK (char_length(from_state) <= 16);
ALTER TABLE moderation_log ADD COLUMN IF NOT EXISTS to_state text CHECK (char_length(to_state) <= 16);
ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS moderation_log_action_check;
ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check
  CHECK (action IN ('remove', 'requeue', 'hide', 'unhide', 'state'));
CREATE INDEX IF NOT EXISTS moderation_log_target_idx ON moderation_log (target_kind, target_ref);

CREATE TABLE IF NOT EXISTS notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (account_id, created_at DESC) WHERE read_at IS NULL;

-- ── Personal API tokens and versions of a timing (W12.20, W12.21) ──────────

-- A personal API token (services/token.service.js): only the SHA-256 of the
-- secret, which is shown once and never stored. Revoking deletes the row; an
-- account's tokens go with it. `scopes` is a subset of the three the API
-- knows, never empty.
CREATE TABLE IF NOT EXISTS api_tokens (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       char(32) NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$'),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash      char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes          text[] NOT NULL
                    CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['read:analyses', 'upload', 'read:timings']::text[]),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_account_idx ON api_tokens (account_id, created_at DESC);

-- A saved adjustment of a timing (services/version.service.js): the owner's
-- x2 / /2 and nudge, never a copy of the result. The other kind of version, a
-- re-analysis of the same audio, is just another `analyses` row.
CREATE TABLE IF NOT EXISTS analysis_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       char(32) NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$'),
  analysis_id     bigint NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
  factor          real NOT NULL CHECK (factor IN (0.5, 1, 2)),
  nudge_ms        smallint NOT NULL CHECK (nudge_ms BETWEEN -500 AND 500),
  label           text CHECK (char_length(label) <= 60),
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- An edited timing (W7): the owner's own red lines, packed rows checked by
-- version.service.js `parseLines`, and a key of them so the same edit saved
-- twice is one version. A version may now be an edit with no factor or
-- nudge, so the check and the uniqueness the table first had (on factor and
-- nudge alone) are dropped where they exist and replaced by these.
ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS lines jsonb
  CHECK (lines IS NULL OR (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 512));
ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS lines_key text NOT NULL DEFAULT ''
  CHECK (lines_key ~ '^([0-9a-f]{64})?$');
ALTER TABLE analysis_versions DROP CONSTRAINT IF EXISTS analysis_versions_check;
ALTER TABLE analysis_versions DROP CONSTRAINT IF EXISTS analysis_versions_analysis_id_factor_nudge_ms_key;
ALTER TABLE analysis_versions DROP CONSTRAINT IF EXISTS analysis_versions_changes_check;
ALTER TABLE analysis_versions ADD CONSTRAINT analysis_versions_changes_check
  CHECK (factor <> 1 OR nudge_ms <> 0 OR lines_key <> '');
ALTER TABLE analysis_versions DROP CONSTRAINT IF EXISTS analysis_versions_lines_pair_check;
ALTER TABLE analysis_versions ADD CONSTRAINT analysis_versions_lines_pair_check
  CHECK ((lines IS NULL) = (lines_key = ''));
CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_same_idx ON analysis_versions (analysis_id, factor, nudge_ms, lines_key);
-- ── Social v2 on published timings (W5.6, W6, W13.15, W13.18) ───────────────

-- The social tables above were drafted for `timings`, the rows people edit
-- and fork (W4), which do not exist yet. What people publish today is an
-- analysis (`published_at`, /t/<id>), so each table gains `analysis_id` and
-- names exactly one of the two: a rating, a use, a comment or a collection
-- item is on a W4 timing or on a published analysis, never both, never
-- neither. The rules that were primary keys (one rating per account and
-- timing, one item per collection and timing) become unique indexes per
-- target, because a primary key cannot hold a column that may be null. The
-- constraints are dropped and added again by name, so this runs any number
-- of times.

-- A private profile (W13.18): /u/<username> answers 404 and the ranking of
-- timers leaves the account out. Its published timings stay published.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_private boolean NOT NULL DEFAULT false;
-- A profile is found by its Mides username, in any case.
CREATE INDEX IF NOT EXISTS accounts_username_idx ON accounts (lower(username), cached_at DESC);

-- Stars: 1-5, one per account and timing, editable.
ALTER TABLE timing_ratings ADD COLUMN IF NOT EXISTS analysis_id bigint REFERENCES analyses (id) ON DELETE CASCADE;
ALTER TABLE timing_ratings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE timing_ratings DROP CONSTRAINT IF EXISTS timing_ratings_pkey;
ALTER TABLE timing_ratings ALTER COLUMN timing_id DROP NOT NULL;
ALTER TABLE timing_ratings DROP CONSTRAINT IF EXISTS timing_ratings_target_check;
ALTER TABLE timing_ratings ADD CONSTRAINT timing_ratings_target_check CHECK (num_nonnulls(timing_id, analysis_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS timing_ratings_timing_once ON timing_ratings (timing_id, account_id) WHERE timing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS timing_ratings_analysis_once ON timing_ratings (analysis_id, account_id) WHERE analysis_id IS NOT NULL;

-- "I used this": one per account and timing, with an optional osu!
-- beatmapset link kept in its one canonical form (utils/social.js).
-- Anonymous uses (the draft's ip_hash) are not taken: a count anyone can push
-- again from every new address would not be the honest measure §4 wants.
ALTER TABLE timing_uses ADD COLUMN IF NOT EXISTS analysis_id bigint REFERENCES analyses (id) ON DELETE CASCADE;
ALTER TABLE timing_uses ADD COLUMN IF NOT EXISTS beatmap_url text CHECK (char_length(beatmap_url) <= 200);
ALTER TABLE timing_uses ALTER COLUMN timing_id DROP NOT NULL;
ALTER TABLE timing_uses DROP CONSTRAINT IF EXISTS timing_uses_target_check;
ALTER TABLE timing_uses ADD CONSTRAINT timing_uses_target_check CHECK (num_nonnulls(timing_id, analysis_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS timing_uses_analysis_once
  ON timing_uses (analysis_id, account_id) WHERE analysis_id IS NOT NULL AND account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS timing_uses_analysis_idx ON timing_uses (analysis_id, used_at DESC) WHERE analysis_id IS NOT NULL;

-- Comments: named outside by `public_id` as a suggestion is, hidden by staff
-- through the community's moderation (W5.4), and optionally anchored to a
-- time in the song (`at_ms`, W13.15). The API caps a body below the draft's 4000.
ALTER TABLE timing_comments ADD COLUMN IF NOT EXISTS analysis_id bigint REFERENCES analyses (id) ON DELETE CASCADE;
ALTER TABLE timing_comments ADD COLUMN IF NOT EXISTS public_id text UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$');
ALTER TABLE timing_comments ADD COLUMN IF NOT EXISTS at_ms integer CHECK (at_ms BETWEEN 0 AND 86400000);
ALTER TABLE timing_comments ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE timing_comments ADD COLUMN IF NOT EXISTS hidden_reason text CHECK (char_length(hidden_reason) <= 500);
ALTER TABLE timing_comments ALTER COLUMN timing_id DROP NOT NULL;
ALTER TABLE timing_comments DROP CONSTRAINT IF EXISTS timing_comments_target_check;
ALTER TABLE timing_comments ADD CONSTRAINT timing_comments_target_check CHECK (num_nonnulls(timing_id, analysis_id) = 1);
CREATE INDEX IF NOT EXISTS timing_comments_analysis_idx ON timing_comments (analysis_id, created_at) WHERE analysis_id IS NOT NULL;

-- Collections: an account's named lists, private until made public.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS public_id text UNIQUE CHECK (public_id ~ '^[0-9a-f]{32}$');
ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS collections_account_idx ON collections (account_id, created_at DESC);

ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS analysis_id bigint REFERENCES analyses (id) ON DELETE CASCADE;
ALTER TABLE collection_items DROP CONSTRAINT IF EXISTS collection_items_pkey;
ALTER TABLE collection_items ALTER COLUMN timing_id DROP NOT NULL;
ALTER TABLE collection_items DROP CONSTRAINT IF EXISTS collection_items_target_check;
ALTER TABLE collection_items ADD CONSTRAINT collection_items_target_check CHECK (num_nonnulls(timing_id, analysis_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS collection_items_timing_once ON collection_items (collection_id, timing_id) WHERE timing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collection_items_analysis_once ON collection_items (collection_id, analysis_id) WHERE analysis_id IS NOT NULL;

-- Staff hide and unhide a comment through the same log as everything else.
ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS moderation_log_target_kind_check;
ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_target_kind_check
  CHECK (target_kind IN ('analysis', 'suggestion', 'review', 'comment'));
