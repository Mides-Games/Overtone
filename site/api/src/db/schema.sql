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

CREATE TABLE IF NOT EXISTS notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (account_id, created_at DESC) WHERE read_at IS NULL;
