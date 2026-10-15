-- Existing videos remain uncategorized; all existing metadata and tag strings are preserved.
ALTER TABLE videos ADD COLUMN category TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_videos_active_category
ON videos(category, created_at DESC, id ASC) WHERE removal_mode IS NULL;
