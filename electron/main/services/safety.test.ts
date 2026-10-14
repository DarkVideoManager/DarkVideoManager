import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { PlayHistoryRepository } from '../db/repositories/PlayHistoryRepository'
import { deleteVideo, restoreVideo } from './VideoService'
import { getStats } from './StatsService'

const state = vi.hoisted(() => ({ db: null as SqliteDatabase | null, trashItem: vi.fn() }))
vi.mock('electron', () => ({ shell: { trashItem: state.trashItem } }))
vi.mock('../db/connection', () => ({
  getDatabase: () => state.db,
  isDatabaseReadOnly: () => false,
}))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../infra/paths', () => ({ getPlaybackProxyDir: vi.fn() }))
vi.mock('../ffmpeg/playback.js', () => ({
  needsPlaybackProxy: vi.fn(),
  ensurePlaybackProxy: vi.fn(),
}))
vi.mock('./NativePlayerService', () => ({
  findNativePlayer: vi.fn(),
  openInNativePlayer: vi.fn(),
}))
vi.mock('./MpvSessionService.js', () => ({ openInMpv: vi.fn(), seekMpvSession: vi.fn() }))
vi.mock('./PlaybackService', () => ({ endPlayback: vi.fn() }))

let directory: string
let repository: VideoRepository
let filePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dvm-safe-removal-'))
  filePath = join(directory, 'movie.mp4')
  writeFileSync(filePath, 'disposable test media')
  state.db = new Database(':memory:')
  runMigrations(state.db, ':memory:')
  repository = new VideoRepository(state.db)
  repository.insert({
    id: 'video',
    filePath,
    fileName: 'movie.mp4',
    title: 'Keep title',
    rating: 5,
    memo: 'Keep memo',
    tags: 'keep-tag',
    resumePosSec: 0,
  })
  new HighlightRepository(state.db).insert({
    id: 'highlight',
    videoId: 'video',
    timeStart: 3,
    color: 'yellow',
    label: 'Keep highlight',
    createdAt: new Date().toISOString(),
  })
  new ThumbnailRepository(state.db).insert({
    id: 'thumbnail',
    videoId: 'video',
    filePath: join(directory, 'capture.jpg'),
    timeSec: 3,
    isPrimary: true,
  })
  new SubtitleRepository(state.db).insert({
    id: 'subtitle',
    videoId: 'video',
    filePath: join(directory, 'movie.srt'),
    type: 'srt',
    isEmbedded: false,
  })
  new PlayHistoryRepository(state.db).insert({
    id: 'history',
    videoId: 'video',
    startedAt: new Date().toISOString(),
    posStartSec: 0,
    durationWatchedSec: 20,
  })
  state.trashItem.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  state.db?.close()
  state.db = null
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-safe-removal-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

function expectMetadataPreserved(): void {
  expect(repository.findById('video')).toMatchObject({
    title: 'Keep title',
    rating: 5,
    memo: 'Keep memo',
    tags: 'keep-tag',
  })
  expect(new HighlightRepository(state.db!).findByVideoId('video')).toMatchObject([
    { id: 'highlight', label: 'Keep highlight' },
  ])
  expect(new ThumbnailRepository(state.db!).findByVideoId('video')).toMatchObject([
    { id: 'thumbnail', isPrimary: true },
  ])
  expect(new SubtitleRepository(state.db!).findByVideoId('video')).toMatchObject([
    { id: 'subtitle' },
  ])
  expect(new PlayHistoryRepository(state.db!).findByVideoId('video')).toMatchObject([
    { id: 'history', durationWatchedSec: 20 },
  ])
}

describe('safe video removal and restoration', () => {
  it('uses the trash by default while preserving metadata and historical watch totals', async () => {
    await deleteVideo('library', 'video')
    expect(state.trashItem).toHaveBeenCalledOnce()
    expect(state.trashItem).toHaveBeenCalledWith(filePath)
    expect(repository.findByPath(filePath)).toMatchObject({ id: 'video', removalMode: 'trash' })
    expect(repository.listAll()).toEqual([])
    expect(repository.search({}).total).toBe(0)
    expect(repository.search({ removed: true }).total).toBe(1)
    repository.delete('video')
    expect(repository.findById('video')?.removalMode).toBe('trash')
    expectMetadataPreserved()
    const stats = getStats('library')
    expect(stats).toMatchObject({
      totalVideos: 0,
      avgRating: 0,
      topVideos: [],
      totalWatchedSec: 20,
    })
    expect(stats.dailyStats.reduce((sum, day) => sum + day.watchedSec, 0)).toBe(20)
  })

  it('removes only the listing and restores the same record when the file remains', async () => {
    await deleteVideo('library', 'video', 'remove')
    expect(state.trashItem).not.toHaveBeenCalled()
    expect(existsSync(filePath)).toBe(true)
    expect(repository.findById('video')?.removalMode).toBe('remove')
    // Rescanning finds the original hidden row, so INSERT OR IGNORE cannot create a duplicate.
    repository.insert({
      id: 'duplicate',
      filePath,
      fileName: 'movie.mp4',
      rating: 0,
      memo: '',
      resumePosSec: 0,
    })
    expect(repository.findByPath(filePath)?.id).toBe('video')
    expect(repository.search({ removed: true }).total).toBe(1)
    await restoreVideo('library', 'video')
    expect(repository.findById('video')?.removalMode).toBeUndefined()
    expect(repository.search({}).total).toBe(1)
    expectMetadataPreserved()
    expect(getStats('library')).toMatchObject({ totalVideos: 1, avgRating: 5, totalWatchedSec: 20 })
  })

  it('leaves the DB and source intact when the OS rejects the trash operation', async () => {
    state.trashItem.mockRejectedValueOnce(new Error('Trash unavailable'))
    await expect(deleteVideo('library', 'video')).rejects.toThrow('Trash unavailable')
    expect(repository.findById('video')?.removalMode).toBeUndefined()
    expect(repository.count()).toBe(1)
    expect(existsSync(filePath)).toBe(true)
    expectMetadataPreserved()
    // A failed operation releases the in-flight guard.
    await deleteVideo('library', 'video', 'remove')
    expect(repository.findById('video')?.removalMode).toBe('remove')
  })

  it('checks DB writability before touching the filesystem or trash', async () => {
    rmSync(filePath)
    state.db!.pragma('query_only = ON')
    await expect(deleteVideo('library', 'video')).rejects.toThrow('read-only')
    await expect(deleteVideo('library', 'video', 'remove')).rejects.toThrow('read-only')
    await expect(restoreVideo('library', 'video')).rejects.toThrow('read-only')
    expect(state.trashItem).not.toHaveBeenCalled()
    expect(repository.findById('video')?.removalMode).toBeUndefined()
  })

  it('requires the original file to exist before restoring a removed entry', async () => {
    rmSync(filePath)
    await deleteVideo('library', 'video', 'remove')
    await expect(restoreVideo('library', 'video')).rejects.toThrow()
    expect(repository.findById('video')?.removalMode).toBe('remove')
    mkdirSync(filePath)
    await expect(restoreVideo('library', 'video')).rejects.toThrow('not a file')
    rmSync(filePath, { recursive: true })
    writeFileSync(filePath, 'restored disposable media')
    await restoreVideo('library', 'video')
    expect(repository.findById('video')?.removalMode).toBeUndefined()
  })

  it('rejects concurrent deletion/restoration and never trashes the same record twice', async () => {
    let finish!: () => void
    state.trashItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolvePromise) => {
          finish = resolvePromise
        }),
    )
    const first = deleteVideo('library', 'video')
    await vi.waitFor(() => expect(state.trashItem).toHaveBeenCalledOnce())
    await expect(deleteVideo('library', 'video')).rejects.toThrow('진행 중')
    await expect(restoreVideo('library', 'video')).rejects.toThrow('진행 중')
    // Refresh can observe the missing source before the asynchronous trash call resolves.
    repository.delete('video')
    finish()
    await first
    await deleteVideo('library', 'video')
    expect(state.trashItem).toHaveBeenCalledOnce()
    expect(repository.findById('video')?.removalMode).toBe('trash')
  })

  it('preserves all records if DB persistence fails after a successful trash call', async () => {
    state.db!.exec(
      "CREATE TRIGGER fail_removal BEFORE UPDATE OF removal_mode ON videos BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END",
    )
    await expect(deleteVideo('library', 'video')).rejects.toThrow('파일은 휴지통으로 이동했지만')
    expect(state.trashItem).toHaveBeenCalledOnce()
    expectMetadataPreserved()
    expect(repository.findById('video')?.removalMode).toBeUndefined()
    state.db!.exec('DROP TRIGGER fail_removal')
    // Missing-file refresh uses this operation; it must never cascade away retained metadata.
    repository.delete('video')
    expect(repository.findById('video')?.removalMode).toBe('remove')
    expectMetadataPreserved()
  })

  it('filters removed entries and paginates tied sort values by stable IDs', async () => {
    for (const id of ['c', 'a', 'b']) {
      repository.insert({
        id,
        filePath: join(directory, id + '.mp4'),
        fileName: id + '.mp4',
        rating: 5,
        memo: '',
        resumePosSec: 0,
      })
    }
    await deleteVideo('library', 'video', 'remove')
    const first = repository.search({ sortBy: 'rating', pageSize: 2, page: 1 })
    const second = repository.search({ sortBy: 'rating', pageSize: 2, page: 2 })
    expect(first.videos.map((video) => video.id)).toEqual(['a', 'b'])
    expect(second.videos.map((video) => video.id)).toEqual(['c'])
    expect(first.total).toBe(3)
    expect(
      repository.search({ removed: true, q: 'keep-tag' }).videos.map((video) => video.id),
    ).toEqual(['video'])
    expect(repository.listAll().map((video) => video.id)).toEqual(['a', 'b', 'c'])
  })
})
