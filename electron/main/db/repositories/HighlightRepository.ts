import type { Database } from 'better-sqlite3'
import { Highlight, HighlightCreate } from '@shared/types'

interface HighlightRow {
  id: string
  video_id: string
  time_start: number
  time_end: number | null
  label: string | null
  color: string
  created_at: string
}

function rowToHighlight(r: HighlightRow): Highlight {
  return {
    id: r.id,
    videoId: r.video_id,
    timeStart: r.time_start,
    timeEnd: r.time_end ?? undefined,
    label: r.label ?? undefined,
    color: r.color as Highlight['color'],
    createdAt: r.created_at,
  }
}

export class HighlightRepository {
  constructor(private db: Database) {}

  insert(h: Highlight): void {
    this.db
      .prepare(
        `INSERT INTO highlights (id, video_id, time_start, time_end, label, color)
         VALUES (@id, @videoId, @timeStart, @timeEnd, @label, @color)`,
      )
      .run({
        id: h.id,
        videoId: h.videoId,
        timeStart: h.timeStart,
        timeEnd: h.timeEnd ?? null,
        label: h.label ?? null,
        color: h.color,
      })
  }

  update(id: string, patch: Partial<HighlightCreate>): void {
    const fields: string[] = []
    const params: Record<string, unknown> = { id }
    if (patch.timeEnd !== undefined) { fields.push('time_end = @timeEnd'); params.timeEnd = patch.timeEnd }
    if (patch.label !== undefined) { fields.push('label = @label'); params.label = patch.label }
    if (patch.color !== undefined) { fields.push('color = @color'); params.color = patch.color }
    if (fields.length === 0) return
    this.db.prepare(`UPDATE highlights SET ${fields.join(', ')} WHERE id = @id`).run(params)
  }

  findByVideoId(videoId: string): Highlight[] {
    const rows = this.db
      .prepare('SELECT * FROM highlights WHERE video_id = ? ORDER BY time_start ASC')
      .all(videoId) as HighlightRow[]
    return rows.map(rowToHighlight)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM highlights WHERE id = ?').run(id)
  }
}
