import type { Database } from 'better-sqlite3'
import { Subtitle } from '@shared/types'

interface SubtitleRow {
  id: string
  video_id: string
  file_path: string
  lang: string | null
  encoding: string | null
  type: string
  track_index: number | null
  is_embedded: number
}

function rowToSubtitle(r: SubtitleRow): Subtitle {
  return {
    id: r.id,
    videoId: r.video_id,
    filePath: r.file_path,
    lang: r.lang ?? undefined,
    encoding: r.encoding ?? undefined,
    type: r.type as Subtitle['type'],
    trackIndex: r.track_index ?? undefined,
    isEmbedded: r.is_embedded === 1,
  }
}

export class SubtitleRepository {
  constructor(private db: Database) {}

  insert(sub: Subtitle): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO subtitles (id, video_id, file_path, lang, encoding, type, track_index, is_embedded)
         VALUES (@id, @videoId, @filePath, @lang, @encoding, @type, @trackIndex, @isEmbedded)`,
      )
      .run({
        id: sub.id,
        videoId: sub.videoId,
        filePath: sub.filePath,
        lang: sub.lang ?? null,
        encoding: sub.encoding ?? null,
        type: sub.type,
        trackIndex: sub.trackIndex ?? null,
        isEmbedded: sub.isEmbedded ? 1 : 0,
      })
  }

  findByVideoId(videoId: string): Subtitle[] {
    const rows = this.db
      .prepare('SELECT * FROM subtitles WHERE video_id = ? ORDER BY type, lang')
      .all(videoId) as SubtitleRow[]
    return rows.map(rowToSubtitle)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM subtitles WHERE id = ?').run(id)
  }

  deleteByVideoId(videoId: string): void {
    this.db.prepare('DELETE FROM subtitles WHERE video_id = ?').run(videoId)
  }
}
