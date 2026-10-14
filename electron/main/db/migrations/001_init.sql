CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id              TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL UNIQUE,
  file_name       TEXT NOT NULL,
  file_hash       TEXT,
  duration_sec    REAL,
  width           INTEGER,
  height          INTEGER,
  codec           TEXT,
  fps             REAL,
  bitrate         INTEGER,
  container       TEXT,
  size_bytes      INTEGER,
  title           TEXT,
  rating          INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  memo            TEXT NOT NULL DEFAULT '',
  play_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_played_at  TEXT,
  resume_pos_sec  REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS thumbnails (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  time_sec   REAL NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  lang       TEXT,
  encoding   TEXT,
  type       TEXT NOT NULL CHECK (type IN ('srt', 'vtt', 'ass', 'smi'))
);

CREATE TABLE IF NOT EXISTS play_history (
  id                   TEXT PRIMARY KEY,
  video_id             TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  pos_start_sec        REAL NOT NULL DEFAULT 0,
  pos_end_sec          REAL,
  duration_watched_sec REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_file_hash    ON videos(file_hash);
CREATE INDEX IF NOT EXISTS idx_videos_rating       ON videos(rating);
CREATE INDEX IF NOT EXISTS idx_videos_last_played  ON videos(last_played_at);
CREATE INDEX IF NOT EXISTS idx_thumbnails_video_id ON thumbnails(video_id);
CREATE INDEX IF NOT EXISTS idx_subtitles_video_id  ON subtitles(video_id);
CREATE INDEX IF NOT EXISTS idx_play_history_video ON play_history(video_id);
CREATE INDEX IF NOT EXISTS idx_play_history_time  ON play_history(started_at);

CREATE TRIGGER IF NOT EXISTS trg_videos_updated_at
AFTER UPDATE ON videos
BEGIN
  UPDATE videos
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_play_history_insert
AFTER INSERT ON play_history
BEGIN
  UPDATE videos
  SET play_count = play_count + 1,
      last_played_at = COALESCE(NEW.ended_at, NEW.started_at),
      resume_pos_sec = COALESCE(NEW.pos_end_sec, NEW.pos_start_sec)
  WHERE id = NEW.video_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_play_history_update
AFTER UPDATE OF ended_at, pos_end_sec, duration_watched_sec ON play_history
BEGIN
  UPDATE videos
  SET last_played_at = COALESCE(NEW.ended_at, NEW.started_at),
      resume_pos_sec = COALESCE(NEW.pos_end_sec, NEW.pos_start_sec)
  WHERE id = NEW.video_id;
END;
