-- Keep video metadata, captures, highlights, and viewing history when a video is removed.
ALTER TABLE videos ADD COLUMN removal_mode TEXT CHECK (removal_mode IN ('trash', 'remove'));
CREATE INDEX IF NOT EXISTS idx_videos_removal_mode ON videos(removal_mode);
