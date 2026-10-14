import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false },
  protocol: {},
}))
vi.mock('../ffmpeg/ffprobe', () => ({
  probeVideo: vi.fn(async () => ({ durationSec: 7200, width: 640, height: 360 })),
}))
vi.mock('../ffmpeg/thumbnail', () => ({
  generateThumbnails: vi.fn(async () => []),
  extractThumbnailAtTime: vi.fn(async () => {
    throw new Error('synthetic extraction failure')
  }),
}))

import { closeAllDatabases, getDatabase } from '../db/connection'
import { createLibrary, importFolder, refreshLibrary } from './LibraryService'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { previewCsvImport, importCsvData, importDeepDarkDbData } from './DataImportService.js'
import { startPlayback, heartbeat, endPlayback, finishPlaybackSessions } from './PlaybackService'
import { ensureThumbnailForVideo } from './ThumbnailService'
import { convertSrtToVtt } from './SubtitleService'
import { createMediaResponse, parseRange } from '../infra/localMedia'
import { cancelLibraryWork, isLibraryBusy } from './LibraryWorkService'
import { getThumbnailsDir } from '../infra/paths'

const win = {
  isDestroyed: () => false,
  webContents: { send: vi.fn(), isDestroyed: () => false },
} as unknown as Electron.BrowserWindow
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-restored-test-'))
  state.userData = join(root, 'data')
  mkdirSync(state.userData)
})
afterEach(async () => {
  await Promise.resolve()
  finishPlaybackSessions()
  closeAllDatabases()
  vi.useRealTimers()
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-restored-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})
function folder(name: string): string {
  const result = join(root, name)
  mkdirSync(result)
  return result
}
function movie(dir: string, name = 'movie'): string {
  const result = join(dir, name + '.mp4')
  writeFileSync(result, 'synthetic video')
  return result
}

async function seeded() {
  const dir = folder('videos')
  const videoPath = movie(dir)
  const library = createLibrary('Test', dir)
  await importFolder(library.id, dir, win)
  const db = getDatabase(library.id)!
  const repo = new VideoRepository(db)
  return { library, db, repo, video: repo.findByPath(videoPath)!, dir }
}

describe('restored library and metadata features', () => {
  it('cancels large metadata preparation without changing any rows and releases the library', async () => {
    const { library, repo, video } = await seeded()
    const csv = join(root, 'large.csv')
    writeFileSync(
      csv,
      '_table,filepath,stars\n' +
        Array.from({ length: 10_000 }, () => `files,"${video.filePath}",5`).join('\n'),
    )
    let yielded = false
    setImmediate(() => {
      yielded = true
    })
    await expect(
      importCsvData(
        library.id,
        csv,
        {
          importRatings: true,
          importFavoritesAsHighlights: false,
        },
        (progress) => {
          if (progress.current >= 200) cancelLibraryWork(library.id)
        },
      ),
    ).rejects.toThrow('취소')
    expect(yielded).toBe(true)
    expect(repo.findById(video.id)?.rating).toBe(0)
    expect(isLibraryBusy(library.id)).toBe(false)
    expect((await previewCsvImport(library.id, csv)).matchedRatingRows).toBe(10_000)
  })

  it('rolls back database changes and newly written images if metadata commit fails', async () => {
    const { library, repo, video, dir, db } = await seeded()
    const secondPath = movie(dir, 'second')
    await importFolder(library.id, dir, win)
    const sourcePath = join(root, 'invalid-import.db')
    const source = new Database(sourcePath)
    source.exec(
      'CREATE TABLE Files(uid INTEGER, filepath TEXT, dvdId TEXT, stars INTEGER, fileDate TEXT, playDate TEXT, hashTag TEXT, count INTEGER, thumb BLOB); CREATE TABLE Favorites(uid INTEGER, filepath TEXT, start INTEGER, length INTEGER, thumb BLOB); CREATE TABLE Dvd(dvdId TEXT, dvdTitle TEXT, actors TEXT, genres TEXT, releaseDate TEXT)',
    )
    const insert = source.prepare('INSERT INTO Files VALUES(?,?,NULL,?,NULL,NULL,NULL,0,?)')
    insert.run(1, video.filePath, 4, Buffer.from([137, 80, 78, 71]))
    insert.run(2, secondPath, 99, null)
    source.close()
    const thumbnails = getThumbnailsDir(library.id)
    const before = readdirSync(thumbnails)
    await expect(
      importDeepDarkDbData(library.id, sourcePath, {
        importRatings: true,
        importFavoritesAsHighlights: true,
        importMetadata: true,
        importThumbnails: true,
      }),
    ).rejects.toThrow()
    expect(repo.findById(video.id)?.rating).toBe(0)
    expect(new ThumbnailRepository(db).findByVideoId(video.id)).toEqual([])
    expect(readdirSync(thumbnails)).toEqual(before)
    expect(isLibraryBusy(library.id)).toBe(false)
  })

  it('preserves added-folder metadata and aborts refresh on an unavailable root', async () => {
    const { library, repo, video, dir } = await seeded()
    const extra = folder('extra')
    const extraPath = movie(extra, 'other')
    await importFolder(library.id, extra, win)
    const extraVideo = repo.findByPath(extraPath)!
    repo.updateMeta(extraVideo.id, { memo: 'retain this', tags: 'extra' })
    expect((await refreshLibrary(library.id, win)).removed).toBe(0)
    expect(repo.findById(extraVideo.id)?.memo).toBe('retain this')
    // Rename the test root to simulate a disconnected/unavailable disk.
    const { renameSync } = await import('node:fs')
    renameSync(dir, dir + '-offline')
    const result = await refreshLibrary(library.id, win)
    expect(result.errors.length).toBe(1)
    expect(result.removed).toBe(0)
    expect(repo.findById(video.id)).toBeTruthy()
    expect(repo.findById(extraVideo.id)?.tags).toBe('extra')
  })

  it('imports CSV ratings/highlights idempotently and searches restored tags', async () => {
    const { library, repo, video, db } = await seeded()
    const csv = join(root, 'export.csv')
    writeFileSync(
      csv,
      '_table,filepath,stars,start\nfiles,"' +
        video.filePath +
        '",4,\nfavorites,"' +
        video.filePath +
        '",,2500\n',
    )
    expect((await previewCsvImport(library.id, csv)).matchedRatingRows).toBe(1)
    expect(
      await importCsvData(library.id, csv, {
        importRatings: true,
        importFavoritesAsHighlights: true,
      }),
    ).toMatchObject({ ratingsUpdated: 1, highlightsAdded: 1 })
    expect(
      (
        await importCsvData(library.id, csv, {
          importRatings: true,
          importFavoritesAsHighlights: true,
        })
      ).highlightsAdded,
    ).toBe(0)
    expect(new HighlightRepository(db).findByVideoId(video.id)[0].timeStart).toBe(2.5)
    repo.updateMeta(video.id, { tags: 'travel, korea' })
    expect(repo.search({ q: 'KOREA' }).videos[0]).toMatchObject({
      rating: 4,
      tags: 'travel, korea',
    })
  })

  it('imports DeepDark metadata, rating, thumbnails and favorite timestamps', async () => {
    const { library, repo, video, db } = await seeded()
    const sourcePath = join(root, 'deepdark.db')
    const source = new Database(sourcePath)
    source.exec(
      'CREATE TABLE Files(uid INTEGER, filepath TEXT, dvdId TEXT, stars INTEGER, fileDate TEXT, playDate TEXT, hashTag TEXT, count INTEGER, thumb BLOB); CREATE TABLE Favorites(uid INTEGER, filepath TEXT, start INTEGER, length INTEGER, thumb BLOB); CREATE TABLE Dvd(dvdId TEXT, dvdTitle TEXT, actors TEXT, genres TEXT, releaseDate TEXT)',
    )
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    source
      .prepare('INSERT INTO Files VALUES(1,?,?,5,NULL,?,?,7,?)')
      .run(video.filePath, 'ABC-1', '2026-01-02 03:04:05', 'sample', png)
    source.prepare('INSERT INTO Favorites VALUES(1,?,12000,0,?)').run(video.filePath, png)
    source
      .prepare('INSERT INTO Dvd VALUES(?,?,?,?,?)')
      .run('ABC-1', 'Imported title', 'Actor', 'Genre', '2025-01-01')
    source.close()
    const result = await importDeepDarkDbData(library.id, sourcePath, {
      importRatings: true,
      importFavoritesAsHighlights: true,
      importMetadata: true,
      importThumbnails: true,
    })
    expect(result).toMatchObject({
      ratingsUpdated: 1,
      metadataUpdated: 1,
      thumbnailsImported: 2,
      highlightsAdded: 1,
    })
    expect(repo.findById(video.id)).toMatchObject({
      title: 'Imported title',
      playCount: 7,
      rating: 5,
    })
    expect(
      new ThumbnailRepository(db).findByVideoId(video.id).filter((thumb) => thumb.isPrimary),
    ).toHaveLength(1)
    expect(new HighlightRepository(db).findByVideoId(video.id)[0].timeStart).toBe(12)
  })

  it('keeps existing captures when forced regeneration fails', async () => {
    const { library, video, db } = await seeded()
    const thumbnails = new ThumbnailRepository(db)
    thumbnails.insert({
      id: 'saved',
      videoId: video.id,
      filePath: join(root, 'saved.jpg'),
      timeSec: 0,
      isPrimary: true,
    })
    expect(await ensureThumbnailForVideo(library.id, video.id, win.webContents, true)).toBe(false)
    expect(thumbnails.findByVideoId(video.id)).toMatchObject([{ id: 'saved', isPrimary: true }])
  })

  it('counts playback elapsed time while excluding a one-hour seek and pauses', async () => {
    const { library, video, db, repo } = await seeded()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    startPlayback(library.id, video.id)
    vi.advanceTimersByTime(5000)
    heartbeat(library.id, video.id, 5)
    heartbeat(library.id, video.id, 3600)
    vi.advanceTimersByTime(10000)
    heartbeat(library.id, video.id, 3610)
    vi.advanceTimersByTime(60000)
    heartbeat(library.id, video.id, 3610)
    endPlayback(library.id, video.id, 3610)
    expect(db.prepare('SELECT duration_watched_sec FROM play_history').get()).toEqual({
      duration_watched_sec: 15,
    })
    expect(repo.findById(video.id)).toMatchObject({
      playTimeSec: 15,
      resumePosSec: 3610,
      playCount: 1,
    })
  })

  it('uses separate VTT cache files for equal basenames in different folders', () => {
    const a = join(folder('a'), 'movie.srt'),
      b = join(folder('b'), 'movie.srt')
    writeFileSync(a, '1\n00:00:00,000 --> 00:00:01,000\nFirst')
    writeFileSync(b, '1\n00:00:00,000 --> 00:00:01,000\nSecond')
    const cache = folder('cache')
    const first = convertSrtToVtt(a, cache),
      second = convertSrtToVtt(b, cache)
    expect(first).not.toBe(second)
    expect(readFileSync(first, 'utf8')).toContain('First')
    expect(existsSync(second)).toBe(true)
  })
})

describe('local media streaming', () => {
  it('supports suffix ranges and rejects invalid or unsatisfiable ranges', () => {
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 })
    expect(parseRange('bytes=10-', 10)).toBeNull()
    expect(parseRange('bytes=-', 10)).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
  })
  it('returns the requested bytes and prevents unauthorized file reads', async () => {
    const file = join(root, 'media.mp4')
    writeFileSync(file, '0123456789')
    const request = new Request('local-media://stream/?path=' + encodeURIComponent(file), {
      headers: { range: 'bytes=-3' },
    })
    const response = createMediaResponse(request, () => true)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(await response.text()).toBe('789')
    expect(createMediaResponse(request, () => false).status).toBe(403)
  })
})
