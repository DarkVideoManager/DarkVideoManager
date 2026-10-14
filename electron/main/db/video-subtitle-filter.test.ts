import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchQuery } from '@shared/types'
import { runMigrations } from './migrator'
import { SubtitleRepository } from './repositories/SubtitleRepository'
import { VideoRepository } from './repositories/VideoRepository'

let db: SqliteDatabase
let videos: VideoRepository
let subtitles: SubtitleRepository

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, ':memory:')
  videos = new VideoRepository(db)
  subtitles = new SubtitleRepository(db)
  for (const [id, rating, tags, title] of [
    ['a-external', 5, 'travel', 'External'],
    ['b-none', 4, 'travel', 'First'],
    ['c-embedded', 5, '', 'Embedded'],
    ['d-none', 5, '', 'Travel second'],
    ['e-ai', 4, 'travel', 'AI'],
    ['f-none', 2, 'travel', 'Low rating'],
    ['g-removed-none', 5, 'travel', 'Removed'],
    ['h-removed-subtitle', 5, 'travel', 'Removed with subtitle'],
  ] as const) {
    videos.insert({
      id,
      filePath: `/videos/${id}.mp4`,
      fileName: `${id}.mp4`,
      title,
      rating,
      tags,
      memo: '',
      resumePosSec: 0,
    })
  }
  const addSubtitle = (videoId: string, suffix: string, isEmbedded = false): void => {
    subtitles.insert({
      id: `${videoId}-${suffix}`,
      videoId,
      filePath: `/videos/${videoId}.${suffix}`,
      type: 'srt',
      isEmbedded,
      ...(isEmbedded ? { trackIndex: 1 } : {}),
    })
  }
  addSubtitle('a-external', 'srt')
  addSubtitle('c-embedded', 'mp4', true)
  addSubtitle('e-ai', 'ai.srt')
  addSubtitle('e-ai', 'ai.ko.srt')
  addSubtitle('h-removed-subtitle', 'srt')
  videos.markRemoved('g-removed-none', 'remove')
  videos.markRemoved('h-removed-subtitle', 'trash')
})

afterEach(() => db.close())

function search(query: SearchQuery) {
  return videos.search({ sortBy: 'fileName', sortDir: 'asc', ...query })
}

describe('video subtitle filtering', () => {
  it('keeps all active videos by default and treats every registered subtitle type as present', () => {
    expect(search({}).total).toBe(6)
    const missing = search({ hasSubtitles: false })
    expect(missing.total).toBe(3)
    expect(missing.videos.map((video) => video.id)).toEqual(['b-none', 'd-none', 'f-none'])
    expect(missing.videos.every((video) => video.hasSubtitles === false)).toBe(true)

    const present = search({ hasSubtitles: true })
    expect(present.total).toBe(3)
    expect(present.videos.map((video) => video.id)).toEqual(['a-external', 'c-embedded', 'e-ai'])
    expect(present.videos.every((video) => video.hasSubtitles === true)).toBe(true)
  })

  it('combines text and rating filters and counts matches before paginating', () => {
    const query = { hasSubtitles: false, q: 'TRAVEL', rating: 4, pageSize: 1 }
    expect(search({ ...query, page: 1 })).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      videos: [{ id: 'b-none', hasSubtitles: false }],
    })
    expect(search({ ...query, page: 2 })).toMatchObject({
      total: 2,
      videos: [{ id: 'd-none', hasSubtitles: false }],
    })
    expect(search({ ...query, page: 3 })).toMatchObject({ total: 2, videos: [] })
    expect(search({ ...query, rating: 5 }).videos.map((video) => video.id)).toEqual(['d-none'])
    expect(search({ hasSubtitles: false, q: 'absent' })).toMatchObject({ total: 0, videos: [] })
    expect(search({ hasSubtitles: false, q: 'TRAVEL' }).total).toBe(3)
  })

  it('applies the subtitle filter inside the removed-video scope', () => {
    const query = { q: 'TRAVEL', rating: 5, removed: true }
    expect(search(query).total).toBe(2)
    expect(search({ ...query, hasSubtitles: false })).toMatchObject({
      total: 1,
      videos: [{ id: 'g-removed-none', hasSubtitles: false }],
    })
    expect(search({ ...query, hasSubtitles: true })).toMatchObject({
      total: 1,
      videos: [{ id: 'h-removed-subtitle', hasSubtitles: true }],
    })
  })

  it('changes membership only after the last subtitle is removed and reflects newly added tracks', () => {
    const query = { q: 'e-ai', hasSubtitles: false }
    expect(search(query).total).toBe(0)
    subtitles.delete('e-ai-ai.srt')
    expect(search(query).total).toBe(0)
    subtitles.delete('e-ai-ai.ko.srt')
    expect(search(query)).toMatchObject({ total: 1, videos: [{ id: 'e-ai', hasSubtitles: false }] })
    subtitles.insert({
      id: 'regenerated',
      videoId: 'e-ai',
      filePath: '/videos/e-ai.ai.srt',
      type: 'srt',
      isEmbedded: false,
    })
    expect(search(query).total).toBe(0)
    expect(search({ ...query, hasSubtitles: true })).toMatchObject({
      total: 1,
      videos: [{ id: 'e-ai', hasSubtitles: true }],
    })
  })
})
