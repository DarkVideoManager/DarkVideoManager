import type { Database } from 'better-sqlite3'
import {
  Video,
  SearchQuery,
  SearchResult,
  VideoMeta,
  ProbeData,
  VideoMetadataOptions,
} from '@shared/types'
import {
  collectVideoMetadataOptions,
  hasVideoTag,
  normalizeVideoCategory,
  normalizeVideoTag,
  parseVideoSearch,
  serializeVideoTags,
} from '@shared/videoMetadata'

const metadataFunctionsRegistered = new WeakSet<Database>()

interface VideoRow {
  id: string
  file_path: string
  file_name: string
  file_hash: string | null
  duration_sec: number | null
  width: number | null
  height: number | null
  codec: string | null
  fps: number | null
  bitrate: number | null
  container: string | null
  size_bytes: number | null
  title: string | null
  rating: number
  memo: string
  tags: string
  category: string
  play_count: number
  play_time_sec: number
  has_subtitles: number
  created_at: string
  updated_at: string
  last_played_at: string | null
  resume_pos_sec: number
  primary_thumbnail_path: string | null
  removal_mode: 'trash' | 'remove' | null
}

function rowToVideo(row: VideoRow): Video {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileHash: row.file_hash ?? undefined,
    durationSec: row.duration_sec ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    codec: row.codec ?? undefined,
    fps: row.fps ?? undefined,
    bitrate: row.bitrate ?? undefined,
    container: row.container ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    title: row.title ?? undefined,
    rating: row.rating,
    memo: row.memo,
    tags: row.tags ?? '',
    category: row.category ?? '',
    playCount: row.play_count ?? 0,
    playTimeSec: row.play_time_sec ?? 0,
    hasSubtitles: row.has_subtitles === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPlayedAt: row.last_played_at ?? undefined,
    resumePosSec: row.resume_pos_sec,
    primaryThumbnailPath: row.primary_thumbnail_path ?? undefined,
    removalMode: row.removal_mode ?? undefined,
  }
}

export class VideoRepository {
  constructor(private db: Database) {
    if (!metadataFunctionsRegistered.has(db)) {
      // Match complete normalized tags before counting/paginating, without rewriting legacy CSV.
      db.function('dvm_has_video_tag', { deterministic: true }, (tags, tag) =>
        typeof tag === 'string' && hasVideoTag(typeof tags === 'string' ? tags : '', tag) ? 1 : 0,
      )
      metadataFunctionsRegistered.add(db)
    }
  }

  insert(
    video: Omit<
      Video,
      | 'createdAt'
      | 'updatedAt'
      | 'primaryThumbnailPath'
      | 'tags'
      | 'playCount'
      | 'playTimeSec'
      | 'hasSubtitles'
      | 'removalMode'
    > &
      Partial<Pick<Video, 'tags' | 'playCount' | 'playTimeSec'>>,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO videos
         (id, file_path, file_name, file_hash, duration_sec, width, height,
          codec, fps, bitrate, container, size_bytes, title, rating, memo, resume_pos_sec, tags, category, play_count, play_time_sec, last_played_at)
         VALUES
         (@id, @filePath, @fileName, @fileHash, @durationSec, @width, @height,
          @codec, @fps, @bitrate, @container, @sizeBytes, @title, @rating, @memo, @resumePosSec, @tags, @category, @playCount, @playTimeSec, @lastPlayedAt)`,
      )
      .run({
        id: video.id,
        filePath: video.filePath,
        fileName: video.fileName,
        fileHash: video.fileHash ?? null,
        durationSec: video.durationSec ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        codec: video.codec ?? null,
        fps: video.fps ?? null,
        bitrate: video.bitrate ?? null,
        container: video.container ?? null,
        sizeBytes: video.sizeBytes ?? null,
        title: video.title ?? null,
        rating: video.rating,
        memo: video.memo,
        resumePosSec: video.resumePosSec,
        tags: video.tags ?? '',
        category: normalizeVideoCategory(video.category),
        playCount: video.playCount ?? 0,
        playTimeSec: video.playTimeSec ?? 0,
        lastPlayedAt: video.lastPlayedAt ?? null,
      })
  }

  findById(id: string): Video | null {
    const row = this.db
      .prepare(
        `SELECT v.*, t.file_path AS primary_thumbnail_path, EXISTS (SELECT 1 FROM subtitles s WHERE s.video_id = v.id) AS has_subtitles
         FROM videos v
         LEFT JOIN thumbnails t ON t.video_id = v.id AND t.is_primary = 1
         WHERE v.id = ?`,
      )
      .get(id) as VideoRow | undefined
    return row ? rowToVideo(row) : null
  }

  findByPath(filePath: string): Video | null {
    const row = this.db
      .prepare(
        `SELECT v.*, t.file_path AS primary_thumbnail_path, EXISTS (SELECT 1 FROM subtitles s WHERE s.video_id = v.id) AS has_subtitles
         FROM videos v
         LEFT JOIN thumbnails t ON t.video_id = v.id AND t.is_primary = 1
         WHERE v.file_path = ?`,
      )
      .get(filePath) as VideoRow | undefined
    return row ? rowToVideo(row) : null
  }

  listAll(): Video[] {
    return (
      this.db
        .prepare(
          `SELECT v.*, t.file_path AS primary_thumbnail_path,
      EXISTS (SELECT 1 FROM subtitles s WHERE s.video_id = v.id) AS has_subtitles
      FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id AND t.is_primary = 1
      WHERE v.removal_mode IS NULL
      ORDER BY v.file_name ASC, v.id ASC`,
        )
        .all() as VideoRow[]
    ).map(rowToVideo)
  }

  search(query: SearchQuery): SearchResult {
    const {
      q: rawQuery,
      category,
      tag,
      rating,
      hasSubtitles,
      removed = false,
      sortBy = 'createdAt',
      sortDir = 'desc',
      page = 1,
      pageSize = 50,
    } = query
    const { text: q, tags: queryTags } = parseVideoSearch(rawQuery)
    const requestedTags = [...queryTags]
    if (tag !== undefined && normalizeVideoTag(tag)) requestedTags.push(tag)

    const colMap: Record<string, string> = {
      title: 'COALESCE(v.title, v.file_name)',
      rating: 'v.rating',
      createdAt: 'v.created_at',
      lastPlayedAt: 'v.last_played_at',
      durationSec: 'v.duration_sec',
      fileName: 'v.file_name',
      playCount: 'v.play_count',
      playTimeSec: 'v.play_time_sec',
    }
    const col = colMap[sortBy] ?? 'v.created_at'
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC'

    const conditions: string[] = [removed ? 'v.removal_mode IS NOT NULL' : 'v.removal_mode IS NULL']
    const params: Record<string, unknown> = {}

    if (category !== undefined) {
      conditions.push('v.category = @category')
      params['category'] = normalizeVideoCategory(category)
    }
    requestedTags.forEach((requestedTag, index) => {
      const parameter = `tag${index}`
      conditions.push(`dvm_has_video_tag(v.tags, @${parameter}) = 1`)
      params[parameter] = normalizeVideoTag(requestedTag)
    })
    if (q) {
      conditions.push(
        `(LOWER(v.file_name) LIKE '%' || LOWER(@q) || '%' OR LOWER(COALESCE(v.title,'')) LIKE '%' || LOWER(@q) || '%' OR LOWER(COALESCE(v.tags,'')) LIKE '%' || LOWER(@q) || '%')`,
      )
      params['q'] = q
    }
    if (rating !== undefined) {
      conditions.push('v.rating >= @minRating')
      params['minRating'] = rating
    }
    if (hasSubtitles !== undefined) {
      conditions.push(
        `${hasSubtitles ? '' : 'NOT '}EXISTS (SELECT 1 FROM subtitles s WHERE s.video_id = v.id)`,
      )
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const offset = (page - 1) * pageSize
    // A leading-wildcard LIKE cannot seek these ordering indexes. A sequential table
    // scan avoids an extra table lookup for every row, especially for rare matches.
    const source = q && rating === undefined ? 'videos v NOT INDEXED' : 'videos v'

    const { cnt } = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${source} ${where}`)
      .get(params) as { cnt: number }

    const rows = this.db
      .prepare(
        `WITH matched_page AS MATERIALIZED (
           SELECT v.id, ${col} AS sort_value FROM ${source}
           ${where}
           ORDER BY ${col} ${dir} NULLS LAST, v.id ASC
           LIMIT @pageSize OFFSET @offset
         )
         SELECT v.*, t.file_path AS primary_thumbnail_path, EXISTS (SELECT 1 FROM subtitles s WHERE s.video_id = v.id) AS has_subtitles
         FROM matched_page p JOIN videos v ON v.id = p.id
         LEFT JOIN thumbnails t ON t.video_id = v.id AND t.is_primary = 1
         ORDER BY p.sort_value ${dir} NULLS LAST, p.id ASC`,
      )
      .all({ ...params, pageSize, offset }) as VideoRow[]

    return { videos: rows.map(rowToVideo), total: cnt, page, pageSize }
  }

  metadataOptions(removed = false): VideoMetadataOptions {
    const rows = this.db
      .prepare(
        `SELECT category, tags FROM videos WHERE removal_mode IS ${removed ? 'NOT ' : ''}NULL`,
      )
      .all() as Array<{ category: string; tags: string }>
    return collectVideoMetadataOptions(rows)
  }

  updateMeta(id: string, meta: VideoMeta): void {
    const fields: string[] = []
    const params: Record<string, unknown> = { id }
    if (meta.title !== undefined) {
      fields.push('title = @title')
      params['title'] = meta.title
    }
    if (meta.rating !== undefined) {
      fields.push('rating = @rating')
      params['rating'] = meta.rating
    }
    if (meta.memo !== undefined) {
      fields.push('memo = @memo')
      params['memo'] = meta.memo
    }
    if (meta.tags !== undefined) {
      fields.push('tags = @tags')
      params['tags'] = serializeVideoTags(meta.tags)
    }
    if (meta.category !== undefined) {
      fields.push('category = @category')
      params['category'] = normalizeVideoCategory(meta.category)
    }
    if (meta.lastPlayedAt !== undefined) {
      fields.push('last_played_at = @lastPlayedAt')
      params['lastPlayedAt'] = meta.lastPlayedAt
    }
    if (meta.playCount !== undefined) {
      fields.push('play_count = @playCount')
      params['playCount'] = meta.playCount
    }
    if (meta.playTimeSec !== undefined) {
      fields.push('play_time_sec = @playTimeSec')
      params['playTimeSec'] = meta.playTimeSec
    }
    if (fields.length === 0) return
    this.db.prepare(`UPDATE videos SET ${fields.join(', ')} WHERE id = @id`).run(params)
  }

  updateProbeData(id: string, data: ProbeData): void {
    this.db
      .prepare(
        `UPDATE videos SET
           duration_sec = @durationSec, width = @width, height = @height,
           codec = @codec, fps = @fps, bitrate = @bitrate, container = @container
         WHERE id = @id`,
      )
      .run({
        id,
        durationSec: data.durationSec ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        codec: data.codec ?? null,
        fps: data.fps ?? null,
        bitrate: data.bitrate ?? null,
        container: data.container ?? null,
      })
  }

  delete(id: string): void {
    // Refresh also uses this method for missing files. Never cascade away their metadata.
    this.db
      .prepare("UPDATE videos SET removal_mode = 'remove' WHERE id = ? AND removal_mode IS NULL")
      .run(id)
  }

  markRemoved(id: string, mode: 'trash' | 'remove'): void {
    // An asynchronous trash operation can finish after refresh marks the now-missing file.
    // Its successful outcome is authoritative for the removal reason.
    this.db.prepare('UPDATE videos SET removal_mode = ? WHERE id = ?').run(mode, id)
  }

  restore(id: string): void {
    this.db.prepare('UPDATE videos SET removal_mode = NULL WHERE id = ?').run(id)
  }

  count(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS cnt FROM videos WHERE removal_mode IS NULL').get() as {
        cnt: number
      }
    ).cnt
  }
}
