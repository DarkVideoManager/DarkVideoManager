import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../ffmpeg/ffprobe', () => ({ probeVideo: vi.fn() }))
vi.mock('../ffmpeg/thumbnail', () => ({ generateThumbnails: vi.fn() }))

import {
  createLibrary,
  importFolder,
  importFiles,
  listLibraries,
  refreshLibrary,
  closeLibrary,
  deleteLibrary,
} from './LibraryService'
import {
  withLibraryWork,
  cancelLibraryWork,
  cancelAllLibraryWork,
  isLibraryBusy,
} from './LibraryWorkService'
import { FsScanner } from './FsScanner'
import { closeAllDatabases, getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { updateConfig } from '../infra/config'
import { probeVideo } from '../ffmpeg/ffprobe'
import { generateThumbnails } from '../ffmpeg/thumbnail'
import { createAbortError, thumbnailQueue } from '../ffmpeg/queue'

let root: string
const events: Array<{ libraryId?: string; phase: string }> = []
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (_channel: string, payload: { libraryId?: string; phase: string }) => {
      if (payload.phase) events.push(payload)
    },
  },
} as unknown as Electron.BrowserWindow
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-library-work-test-'))
  state.userData = join(root, 'data')
  mkdirSync(state.userData)
  vi.mocked(probeVideo).mockReset().mockResolvedValue({ durationSec: 10 })
  vi.mocked(generateThumbnails).mockReset().mockResolvedValue([])
  events.length = 0
})
afterEach(() => {
  cancelAllLibraryWork()
  closeAllDatabases()
  vi.restoreAllMocks()
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-library-work-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})
function movie(directory: string, name: string): string {
  const file = join(directory, name + '.mp4')
  writeFileSync(file, 'fixture')
  return file
}
function makeLibrary() {
  const directory = join(root, 'videos')
  mkdirSync(directory)
  const library = createLibrary('Test', directory)
  const db = getDatabase(library.id)!
  return { library, db, directory, repository: new VideoRepository(db) }
}

describe('selected video file imports', () => {
  it('imports only selected files and matching sidecars without scanning or registering folders', async () => {
    const { library, repository, db } = makeLibrary()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const selected = movie(outside, 'selected')
    movie(outside, 'selected.other')
    const nested = join(outside, 'nested')
    mkdirSync(nested)
    movie(nested, 'unselected')
    writeFileSync(join(outside, 'selected.ai.ko.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n')
    writeFileSync(join(outside, 'selected.other.srt'), '1\n00:00:01,000 --> 00:00:02,000\nOther\n')
    const scan = vi.spyOn(FsScanner.prototype, 'scan')
    const result = await importFiles(library.id, [selected, selected], win)
    expect(result).toEqual({ added: 1, skipped: 0, removed: 0, errors: [] })
    expect(scan).not.toHaveBeenCalled()
    expect(probeVideo).toHaveBeenCalledTimes(1)
    expect(generateThumbnails).toHaveBeenCalledTimes(1)
    expect(repository.count()).toBe(1)
    const video = repository.findByPath(selected)!
    expect(new SubtitleRepository(db).findByVideoId(video.id)).toMatchObject([
      { filePath: join(outside, 'selected.ai.ko.srt'), lang: 'ko' },
    ])
    expect(listLibraries().find((entry) => entry.id === library.id)?.folderPaths).toEqual([
      library.folderPath,
    ])
    repository.updateMeta(video.id, { rating: 5, memo: 'preserved' })
    expect(await importFiles(library.id, [selected], win)).toMatchObject({
      added: 0,
      skipped: 1,
      errors: [],
    })
    expect(probeVideo).toHaveBeenCalledTimes(1)
    expect(repository.findById(video.id)).toMatchObject({ rating: 5, memo: 'preserved' })
    unlinkSync(selected)
    expect(await refreshLibrary(library.id, win)).toMatchObject({ removed: 0, errors: [] })
    expect(repository.findById(video.id)?.removalMode).toBeUndefined()
    expect(events.at(-1)?.phase).toBe('done')
  })

  it('rejects unsupported files, directories and missing paths while adding valid selections', async () => {
    const { library, directory, repository } = makeLibrary()
    const valid = movie(directory, 'valid')
    const text = join(directory, 'notes.txt')
    writeFileSync(text, 'not a video')
    const fakeVideoDirectory = join(directory, 'folder.mp4')
    mkdirSync(fakeVideoDirectory)
    const result = await importFiles(
      library.id,
      [text, fakeVideoDirectory, join(directory, 'missing.mp4'), valid],
      win,
    )
    expect(result).toMatchObject({ added: 1, skipped: 0, removed: 0 })
    expect(result.errors).toHaveLength(3)
    expect(repository.count()).toBe(1)
    expect(probeVideo).toHaveBeenCalledExactlyOnceWith(valid, expect.any(AbortSignal))
  })

  it('cancels a selected-file probe and releases the library without importing other siblings', async () => {
    const { library, directory, repository } = makeLibrary()
    const selected = movie(directory, 'selected')
    movie(directory, 'untouched')
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(probeVideo).mockImplementation(async (_file, signal) => {
      started()
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(createAbortError()), { once: true }),
      )
    })
    const work = importFiles(library.id, [selected], win)
    await didStart
    expect(cancelLibraryWork(library.id)).toBe(true)
    expect(await work).toMatchObject({ cancelled: true, added: 0, errors: [] })
    expect(repository.count()).toBe(0)
    expect(generateThumbnails).not.toHaveBeenCalled()
    expect(isLibraryBusy(library.id)).toBe(false)
    expect(events.at(-1)?.phase).toBe('cancelled')
  })
})

describe('cancellable folder work', () => {
  it('scans overlapping refresh roots once and handles an odd number of thumbnail jobs', async () => {
    const { library, directory, repository } = makeLibrary()
    const nested = join(directory, 'nested')
    mkdirSync(nested)
    movie(directory, 'first')
    movie(directory, 'second')
    movie(nested, 'third')
    await importFolder(library.id, directory, win)
    updateConfig((config) => ({
      ...config,
      libraries: config.libraries.map((entry) => ({ ...entry, folderPaths: [directory, nested] })),
    }))
    const scan = vi.spyOn(FsScanner.prototype, 'scan')
    const result = await refreshLibrary(library.id, win)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ added: 0, skipped: 3, removed: 0, errors: [] })
    expect(repository.count()).toBe(3)
    expect(events.every((event) => event.libraryId === library.id)).toBe(true)
    expect(events.at(-1)?.phase).toBe('done')
  })

  it('preserves completed imports and old metadata when refresh is cancelled during probing', async () => {
    const { library, directory, repository, db } = makeLibrary()
    const keptPath = movie(directory, 'kept'),
      missingPath = movie(directory, 'missing')
    await importFolder(library.id, directory, win)
    const kept = repository.findByPath(keptPath)!,
      missing = repository.findByPath(missingPath)!
    repository.updateMeta(kept.id, { memo: 'keep my notes', rating: 5 })
    new HighlightRepository(db).insert({
      id: 'favorite',
      videoId: missing.id,
      timeStart: 2,
      color: 'yellow',
      createdAt: new Date().toISOString(),
    })
    unlinkSync(missingPath)
    movie(directory, 'new-one')
    movie(directory, 'new-two')
    vi.mocked(probeVideo)
      .mockReset()
      .mockResolvedValueOnce({ durationSec: 10 })
      .mockImplementationOnce(async (_file, signal) => {
        cancelLibraryWork(library.id)
        expect(signal?.aborted).toBe(true)
        throw createAbortError()
      })
    const result = await refreshLibrary(library.id, win)
    expect(result).toMatchObject({ cancelled: true, added: 1, removed: 0, errors: [] })
    expect(repository.findById(kept.id)).toMatchObject({ memo: 'keep my notes', rating: 5 })
    expect(repository.findById(missing.id)?.removalMode).toBeUndefined()
    expect(new HighlightRepository(db).findByVideoId(missing.id)).toHaveLength(1)
    expect(repository.count()).toBe(3)
    expect(events.at(-1)).toMatchObject({ phase: 'cancelled', libraryId: library.id })
    expect(isLibraryBusy(library.id)).toBe(false)
  })

  it('waits for thumbnail cancellation cleanup and blocks close/delete while busy', async () => {
    const { library, directory, repository } = makeLibrary()
    movie(directory, 'first')
    movie(directory, 'second')
    movie(directory, 'third')
    let started!: () => void, releaseCleanup!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    vi.mocked(generateThumbnails).mockImplementation(
      async (_file, _output, _id, _duration, signal) => {
        started()
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        await cleanup
        throw createAbortError()
      },
    )
    const work = importFolder(library.id, directory, win)
    await didStart
    expect(isLibraryBusy(library.id)).toBe(true)
    expect(() => closeLibrary(library.id)).toThrow('작업이 진행 중')
    expect(() => deleteLibrary(library.id)).toThrow('작업이 진행 중')
    await expect(withLibraryWork(library.id, async () => 0)).rejects.toThrow('다른 작업')
    expect(cancelLibraryWork(library.id)).toBe(true)
    await Promise.resolve()
    expect(isLibraryBusy(library.id)).toBe(true)
    releaseCleanup()
    expect(await work).toMatchObject({ added: 3, cancelled: true, errors: [] })
    expect(repository.count()).toBe(3)
    expect(isLibraryBusy(library.id)).toBe(false)
    expect(thumbnailQueue.pending).toBe(0)
    expect(thumbnailQueue.size).toBe(0)
  })

  it('does not sync subtitles or generate thumbnails for deliberately removed videos', async () => {
    const { library, directory, repository, db } = makeLibrary()
    const filePath = movie(directory, 'removed')
    const subtitlePath = join(directory, 'removed.srt')
    writeFileSync(subtitlePath, 'caption')
    await importFolder(library.id, directory, win)
    const video = repository.findByPath(filePath)!
    const subtitles = new SubtitleRepository(db)
    const original = subtitles.findByVideoId(video.id)
    repository.markRemoved(video.id, 'remove')
    unlinkSync(subtitlePath)
    vi.mocked(generateThumbnails).mockClear()
    expect(await refreshLibrary(library.id, win)).toMatchObject({
      removed: 0,
      skipped: 1,
      errors: [],
    })
    expect(repository.findById(video.id)?.removalMode).toBe('remove')
    expect(subtitles.findByVideoId(video.id)).toEqual(original)
    expect(generateThumbnails).not.toHaveBeenCalled()
  })
})
