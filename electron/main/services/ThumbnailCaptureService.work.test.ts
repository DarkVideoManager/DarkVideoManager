import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', extract: vi.fn(), generate: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root, isPackaged: false } }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../ffmpeg/thumbnail', () => ({
  extractThumbnailAtTime: state.extract,
  generateThumbnails: state.generate,
}))

import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { getThumbnailsDir } from '../infra/paths'
import { createAbortError } from '../ffmpeg/queue'
import {
  captureThumbnailAtTime,
  ensureThumbnailForVideo,
  saveThumbnailImageCapture,
} from './ThumbnailCaptureService.js'
import { createHighlight, updateHighlight, deleteHighlight } from './HighlightService'
import { previewCsvImport } from './DataImportService.js'
import { drainLibraryWork, withLibraryWork } from './LibraryWorkService'

const libraryId = 'capture-test'
const videoId = 'video-test'
const webContents = { send: vi.fn(), isDestroyed: () => false } as unknown as Electron.WebContents
let db: ReturnType<typeof openDatabase>
let thumbnailRepo: ThumbnailRepository
let existingPath: string

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'dvm-capture-work-test-'))
  state.extract.mockReset()
  state.generate.mockReset()
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  new VideoRepository(db).insert({
    id: videoId,
    filePath: join(state.root, 'video.mp4'),
    fileName: 'video.mp4',
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
  existingPath = join(getThumbnailsDir(libraryId), 'existing.jpg')
  writeFileSync(existingPath, 'existing image')
  thumbnailRepo = new ThumbnailRepository(db)
  thumbnailRepo.insert({
    id: 'existing',
    videoId,
    filePath: existingPath,
    timeSec: 1,
    isPrimary: true,
  })
})

afterEach(async () => {
  await drainLibraryWork()
  closeAllDatabases()
  const target = resolve(state.root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-capture-work-test-'))
    throw new Error('Unsafe test cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('thumbnail and native mutation work isolation', () => {
  it('blocks native highlight and image mutations while an import owns the library', async () => {
    await withLibraryWork(libraryId, async () => {
      expect(() => createHighlight(libraryId, { videoId, timeStart: 2 })).toThrow('다른 작업')
      expect(() => updateHighlight(libraryId, 'existing', { timeStart: 2 })).toThrow('다른 작업')
      expect(() => deleteHighlight(libraryId, 'existing')).toThrow('다른 작업')
      expect(() =>
        saveThumbnailImageCapture(libraryId, videoId, 2, 'data:image/png;base64,AA==', webContents),
      ).toThrow('다른 작업')
      await expect(captureThumbnailAtTime(libraryId, videoId, 2, webContents)).rejects.toThrow(
        '다른 작업',
      )
      expect(state.extract).not.toHaveBeenCalled()
    })
  })

  it.each(['capture', 'regenerate'])(
    'cancels %s and cleans only its new files before drain returns',
    async (kind) => {
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const extraction = async (
        _source: string,
        outputDir: string,
        _id: string,
        _time: number,
        signal: AbortSignal,
      ) => {
        writeFileSync(join(outputDir, 'new.jpg'), 'partially generated image')
        entered()
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(createAbortError()), { once: true })
        })
      }
      state.extract.mockImplementation(extraction)
      state.generate.mockImplementation(extraction)
      const work =
        kind === 'capture'
          ? captureThumbnailAtTime(libraryId, videoId, 2, webContents)
          : ensureThumbnailForVideo(libraryId, videoId, webContents, true)
      const outcome = work.catch((error: Error) => error.name)
      await started
      await expect(previewCsvImport(libraryId, 'unused.csv')).rejects.toThrow('다른 작업')
      await drainLibraryWork()
      expect(await outcome).toBe('AbortError')
      expect(readdirSync(getThumbnailsDir(libraryId))).toEqual(['existing.jpg'])
      expect(existsSync(existingPath)).toBe(true)
      expect(thumbnailRepo.findByVideoId(videoId)).toMatchObject([
        { id: 'existing', isPrimary: true },
      ])
    },
  )

  it('removes a generated image if its database insert fails', async () => {
    state.extract.mockImplementation(async (_source: string, outputDir: string) => {
      const image = join(outputDir, 'new.jpg')
      writeFileSync(image, 'new image')
      return image
    })
    db.pragma('query_only = ON')
    await expect(captureThumbnailAtTime(libraryId, videoId, 2, webContents)).rejects.toThrow()
    expect(readdirSync(getThumbnailsDir(libraryId))).toEqual(['existing.jpg'])
    expect(thumbnailRepo.findByVideoId(videoId)).toMatchObject([
      { id: 'existing', isPrimary: true },
    ])
  })

  it('keeps the new image after a successful atomic primary change', async () => {
    state.extract.mockImplementation(async (_source: string, outputDir: string) => {
      const image = join(outputDir, 'new.jpg')
      writeFileSync(image, 'new image')
      return image
    })
    const thumbnail = await captureThumbnailAtTime(libraryId, videoId, 2, webContents)
    expect(existsSync(thumbnail.filePath)).toBe(true)
    const primary = thumbnailRepo.findByVideoId(videoId).filter((item) => item.isPrimary)
    expect(primary).toMatchObject([{ id: thumbnail.id }])
    expect(existsSync(existingPath)).toBe(true)
  })
})
