-- Cover the default and commonly selected library orderings, including stable pagination ties.
-- Removed entries do not enlarge the interactive library indexes.
-- The low-selectivity status-only index makes SQLite choose a full sort on normal libraries.
DROP INDEX IF EXISTS idx_videos_removal_mode;
CREATE INDEX IF NOT EXISTS idx_videos_active_created ON videos(created_at DESC, id ASC) WHERE removal_mode IS NULL;
CREATE INDEX IF NOT EXISTS idx_videos_active_filename ON videos(file_name ASC, id ASC) WHERE removal_mode IS NULL;
CREATE INDEX IF NOT EXISTS idx_videos_active_rating ON videos(rating DESC, id ASC) WHERE removal_mode IS NULL;
CREATE INDEX IF NOT EXISTS idx_videos_active_play_count ON videos(play_count DESC, id ASC) WHERE removal_mode IS NULL;
