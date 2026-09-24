-- Overtone's library index: every beatmap under an osu! Songs folder.
--
-- The schema's version is the line below; overtone_library.py reads it from
-- here and stores it in PRAGMA user_version, and refuses a database written
-- by a newer schema. bench/facts.py checks the two agree. A change to this
-- file raises the version and adds its step to MIGRATIONS in the module.
--
-- schema-version: 1

-- One row per song folder ("123456 Artist - Title").
CREATE TABLE IF NOT EXISTS sets (
    id       INTEGER PRIMARY KEY,
    folder   TEXT NOT NULL UNIQUE,
    name     TEXT NOT NULL
);

-- One row per .osu, from its header: [General], [Metadata] and the red lines
-- of [TimingPoints]. [HitObjects] is counted, never parsed.
CREATE TABLE IF NOT EXISTS beatmaps (
    id          INTEGER PRIMARY KEY,
    set_id      INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    path        TEXT NOT NULL UNIQUE,
    size        INTEGER NOT NULL,
    mtime_ns    INTEGER NOT NULL,
    artist      TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    artist_unicode TEXT NOT NULL DEFAULT '',
    title_unicode  TEXT NOT NULL DEFAULT '',
    creator     TEXT NOT NULL DEFAULT '',
    version     TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    mode        INTEGER NOT NULL DEFAULT 0,
    audio_file  TEXT NOT NULL DEFAULT '',
    red_lines   INTEGER NOT NULL DEFAULT 0,
    first_bpm   REAL,
    objects     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS beatmaps_set ON beatmaps(set_id);

-- Audio files of the sets, by size; the hash is filled the first time a
-- same-audio lookup needs it, and dropped when the file changes.
CREATE TABLE IF NOT EXISTS audio (
    path      TEXT PRIMARY KEY,
    set_id    INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    size      INTEGER NOT NULL,
    mtime_ns  INTEGER NOT NULL,
    sha256    TEXT
);
CREATE INDEX IF NOT EXISTS audio_size ON audio(size);

-- Full-text search over what a person types to find a map. An external-content
-- table: the text lives once, in beatmaps, and the triggers keep it in step.
CREATE VIRTUAL TABLE IF NOT EXISTS beatmap_search USING fts5(
    artist, title, artist_unicode, title_unicode, creator, version, source, tags,
    content='beatmaps', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS beatmaps_ai AFTER INSERT ON beatmaps BEGIN
    INSERT INTO beatmap_search(rowid, artist, title, artist_unicode, title_unicode, creator, version, source, tags)
    VALUES (new.id, new.artist, new.title, new.artist_unicode, new.title_unicode, new.creator, new.version, new.source, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS beatmaps_ad AFTER DELETE ON beatmaps BEGIN
    INSERT INTO beatmap_search(beatmap_search, rowid, artist, title, artist_unicode, title_unicode, creator, version, source, tags)
    VALUES ('delete', old.id, old.artist, old.title, old.artist_unicode, old.title_unicode, old.creator, old.version, old.source, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS beatmaps_au AFTER UPDATE ON beatmaps BEGIN
    INSERT INTO beatmap_search(beatmap_search, rowid, artist, title, artist_unicode, title_unicode, creator, version, source, tags)
    VALUES ('delete', old.id, old.artist, old.title, old.artist_unicode, old.title_unicode, old.creator, old.version, old.source, old.tags);
    INSERT INTO beatmap_search(rowid, artist, title, artist_unicode, title_unicode, creator, version, source, tags)
    VALUES (new.id, new.artist, new.title, new.artist_unicode, new.title_unicode, new.creator, new.version, new.source, new.tags);
END;

-- When and where the last scan ran.
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
