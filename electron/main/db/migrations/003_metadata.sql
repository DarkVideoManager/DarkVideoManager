DROP TRIGGER IF EXISTS trg_play_history_insert;
DROP TRIGGER IF EXISTS trg_play_history_update;
CREATE TRIGGER trg_play_history_insert AFTER INSERT ON play_history BEGIN
  UPDATE videos SET last_played_at = NEW.started_at,
    play_count = COALESCE(play_count, 0) + 1,
    resume_pos_sec = COALESCE(NEW.pos_end_sec, NEW.pos_start_sec)
  WHERE id = NEW.video_id;
END;
CREATE TRIGGER trg_play_history_update AFTER UPDATE OF ended_at, pos_end_sec, duration_watched_sec ON play_history BEGIN
  UPDATE videos SET last_played_at = COALESCE(NEW.ended_at, NEW.started_at),
    play_time_sec = MAX(0, COALESCE(play_time_sec,0) + COALESCE(NEW.duration_watched_sec,0) - COALESCE(OLD.duration_watched_sec,0)),
    resume_pos_sec = COALESCE(NEW.pos_end_sec,resume_pos_sec)
  WHERE id = NEW.video_id;
END;
UPDATE videos SET play_time_sec = COALESCE((SELECT SUM(COALESCE(ph.duration_watched_sec,0)) FROM play_history ph WHERE ph.video_id = videos.id),0);
