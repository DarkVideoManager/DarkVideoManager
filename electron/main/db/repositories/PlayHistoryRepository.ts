import type { Database } from 'better-sqlite3'
import { PlayHistoryEntry } from '@shared/types'

interface PlayHistoryRow {
  id: string
  video_id: string
  started_at: string
  ended_at: string | null
  pos_start_sec: number
  pos_end_sec: number | null
  duration_watched_sec: number | null
}

function rowToEntry(row: PlayHistoryRow): PlayHistoryEntry {
  return {
    id: row.id,
    videoId: row.video_id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    posStartSec: row.pos_start_sec,
    posEndSec: row.pos_end_sec ?? undefined,
    durationWatchedSec: row.duration_watched_sec ?? undefined,
  }
}

export class PlayHistoryRepository {
  constructor(private db: Database) {}

  insert(entry: PlayHistoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO play_history (id, video_id, started_at, ended_at, pos_start_sec, pos_end_sec, duration_watched_sec)
         VALUES (@id, @videoId, @startedAt, @endedAt, @posStartSec, @posEndSec, @durationWatchedSec)`,
      )
      .run({
        id: entry.id,
        videoId: entry.videoId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt ?? null,
        posStartSec: entry.posStartSec,
        posEndSec: entry.posEndSec ?? null,
        durationWatchedSec: entry.durationWatchedSec ?? null,
      })
  }

  update(id: string, endedAt: string | null, posEndSec: number, durationWatchedSec: number): void {
    this.db
      .prepare(
        `UPDATE play_history SET ended_at = ?, pos_end_sec = ?, duration_watched_sec = ? WHERE id = ?`,
      )
      .run(endedAt, posEndSec, durationWatchedSec, id)
  }

  findByVideoId(videoId: string, limit = 20): PlayHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM play_history WHERE video_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(videoId, limit) as PlayHistoryRow[]
    return rows.map(rowToEntry)
  }
}
