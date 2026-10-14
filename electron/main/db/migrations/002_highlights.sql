CREATE TABLE IF NOT EXISTS highlights (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  time_start REAL NOT NULL,
  time_end   REAL,
  label      TEXT,
  color      TEXT NOT NULL DEFAULT 'yellow',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_highlights_video_id ON highlights(video_id);
CREATE INDEX IF NOT EXISTS idx_highlights_time ON highlights(time_start);
