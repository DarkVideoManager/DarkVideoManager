import type { Database } from 'better-sqlite3'
import { Thumbnail } from '@shared/types'

interface ThumbnailRow {
  id: string
  video_id: string
  file_path: string
  time_sec: number
  is_primary: number
  created_at: string
}

function rowToThumbnail(row: ThumbnailRow): Thumbnail {
  return {
    id: row.id,
    videoId: row.video_id,
    filePath: row.file_path,
    timeSec: row.time_sec,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
  }
}

export class ThumbnailRepository {
  constructor(private db: Database) {}

  insert(thumbnail: Omit<Thumbnail, 'createdAt'>): void {
    const insert = this.db.transaction(() => {
      if (thumbnail.isPrimary) {
        this.db.prepare('UPDATE thumbnails SET is_primary = 0 WHERE video_id = ?').run(thumbnail.videoId)
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO thumbnails (id, video_id, file_path, time_sec, is_primary)
           VALUES (@id, @videoId, @filePath, @timeSec, @isPrimary)`,
        )
        .run({
          id: thumbnail.id,
          videoId: thumbnail.videoId,
          filePath: thumbnail.filePath,
          timeSec: thumbnail.timeSec,
          isPrimary: thumbnail.isPrimary ? 1 : 0,
        })
    })

    insert.immediate()
  }

  findByVideoId(videoId: string): Thumbnail[] {
    const rows = this.db
      .prepare('SELECT * FROM thumbnails WHERE video_id = ? ORDER BY time_sec ASC')
      .all(videoId) as ThumbnailRow[]
    return rows.map(rowToThumbnail)
  }

  setPrimary(thumbnailId: string, videoId: string): void {
    const setPrimary = this.db.transaction(() => {
      const target = this.db
        .prepare('SELECT 1 AS present FROM thumbnails WHERE id = ? AND video_id = ?')
        .get(thumbnailId, videoId) as { present?: number } | undefined
      if (!target) throw new Error('썸네일을 찾을 수 없습니다.')

      this.db.prepare('UPDATE thumbnails SET is_primary = 0 WHERE video_id = ?').run(videoId)
      this.db.prepare('UPDATE thumbnails SET is_primary = 1 WHERE id = ? AND video_id = ?').run(
        thumbnailId,
        videoId,
      )
    })

    setPrimary.immediate()
  }

  deleteByVideoId(videoId: string): void {
    this.db.prepare('DELETE FROM thumbnails WHERE video_id = ?').run(videoId)
  }
}
