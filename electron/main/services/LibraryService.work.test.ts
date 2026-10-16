import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from 'node:fs'
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
vi.mock('./NativePlayerService', () => ({ closeManagedNativePlayers: vi.fn() }))
vi.mock('./MpvSessionService.js', () => ({ closeAllMpvSessions: vi.fn() }))

import {
  createLibrary,
  importFolder,
  importFolders,
  importFiles,
  listLibraries,
  refreshLibrary,
  closeLibrary,
  deleteLibrary,
  openLibrary,
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
import { loadConfig, saveConfig, updateConfig } from '../infra/config'
import { probeVideo } from '../ffmpeg/ffprobe'
import { generateThumbnails } from '../ffmpeg/thumbnail'
import { createAbortError, thumbnailQueue } from '../ffmpeg/queue'
import { cancelThumbnailJob, listThumbnailJobs } from './ThumbnailJobService'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { closeManagedNativePlayers } from './NativePlayerService'
import { closeAllMpvSessions } from './MpvSessionService.js'

let root: string
const events: Array<{ libraryId?: string; phase: string; currentFile?: string; current?: number }> =
  []
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
  vi.mocked(closeManagedNativePlayers).mockReset()
  vi.mocked(closeAllMpvSessions).mockReset()
  root = mkdtempSync(join(tmpdir(), 'dvm-library-work-test-'))
  state.userData = join(root, 'data')
  mkdirSync(state.userData)
  vi.mocked(probeVideo).mockReset().mockResolvedValue({ durationSec: 10 })
  vi.mocked(generateThumbnails)
    .mockReset()
    .mockImplementation(async (_file, output, id) => {
      const filePath = join(output, id + '.jpg')
      writeFileSync(filePath, 'frame')
      return [{ filePath, timeSec: 1 }]
    })
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

describe('multi-folder libraries and live switching', () => {
  it('creates one library from distinct roots and removes duplicate or contained selections', async () => {
    const first = join(root, 'first')
    const nested = join(first, 'nested')
    const second = join(root, 'second')
    mkdirSync(nested, { recursive: true })
    mkdirSync(second)
    movie(first, 'one')
    movie(nested, 'nested')
    movie(second, 'two')
    const library = createLibrary('Combined', [nested, first, first, second])
    expect(library.folderPath).toBe(first)
    expect(library.folderPaths).toEqual([first, second])
    expect(await refreshLibrary(library.id, win)).toMatchObject({ added: 3, errors: [] })
    expect(probeVideo).toHaveBeenCalledTimes(3)
    expect(listLibraries()).toHaveLength(1)
  })

  it('validates every selected root before creating or registering a library', () => {
    const first = join(root, 'first')
    mkdirSync(first)
    const before = loadConfig()
    expect(() => createLibrary('Invalid', [first, join(root, 'offline')])).toThrow()
    expect(loadConfig()).toEqual(before)
    expect(() => createLibrary('Empty', [])).toThrow()
    const file = movie(first, 'file')
    expect(() => createLibrary('Not a folder', [first, file])).toThrow()
    expect(listLibraries()).toHaveLength(0)
  })

  it('imports selected roots together and refreshes them after reopening a legacy library', async () => {
    const { library, directory, repository } = makeLibrary()
    updateConfig((config) => ({
      ...config,
      libraries: config.libraries.map((entry) => ({ ...entry, folderPaths: undefined })),
    }))
    const second = join(root, 'second')
    const third = join(root, 'third')
    mkdirSync(second)
    mkdirSync(third)
    movie(second, 'two')
    movie(third, 'three')
    expect(await importFolders(library.id, [second, third, second], win)).toMatchObject({
      added: 2,
      errors: [],
    })
    expect(repository.count()).toBe(2)
    expect(listLibraries()[0].folderPaths).toEqual([directory, second, third])
    closeLibrary(library.id)
    openLibrary(library.id)
    movie(third, 'later')
    expect(await refreshLibrary(library.id, win)).toMatchObject({
      added: 1,
      skipped: 2,
      errors: [],
    })
  })

  it('does not import or register any selected root when another selected root is inaccessible', async () => {
    const { library, repository } = makeLibrary()
    const valid = join(root, 'valid')
    mkdirSync(valid)
    movie(valid, 'not-imported')
    const before = loadConfig()
    await expect(importFolders(library.id, [valid, join(root, 'offline')], win)).rejects.toThrow()
    expect(repository.count()).toBe(0)
    expect(probeVideo).not.toHaveBeenCalled()
    expect(loadConfig()).toEqual(before)
    const originalScan = FsScanner.prototype.scan
    vi.spyOn(FsScanner.prototype, 'scan').mockImplementation(async function (
      this: FsScanner,
      folder,
      options,
    ) {
      if (folder === root) throw new Error('Unreadable child folder')
      return originalScan.call(this, folder, options)
    })
    await expect(importFolders(library.id, [valid, root], win)).rejects.toThrow(
      'Unreadable child folder',
    )
    expect(repository.count()).toBe(0)
    expect(loadConfig()).toEqual(before)
  })

  it('opens another library while background work keeps its original database and cancellation scope', async () => {
    const { library, db } = makeLibrary()
    const secondFolder = join(root, 'second')
    mkdirSync(secondFolder)
    const second = createLibrary('Second', secondFolder)
    await withLibraryWork(
      library.id,
      async (signal) => {
        expect(openLibrary(second.id).id).toBe(second.id)
        expect(getDatabase(library.id)).toBe(db)
        expect(isLibraryBusy(library.id)).toBe(true)
        expect(isLibraryBusy(second.id)).toBe(false)
        expect(signal.aborted).toBe(false)
        expect(() => closeLibrary(library.id)).toThrow('진행 중')
        expect(loadConfig().lastActiveLibraryId).toBe(second.id)
        expect(() => openLibrary('missing')).toThrow()
        expect(loadConfig().lastActiveLibraryId).toBe(second.id)
        expect(getDatabase(library.id)).toBe(db)
      },
      'subtitles',
    )
  })
})

describe('managed playback during library switching', () => {
  it('stops playback on switching and preserves the current library when stopping fails', () => {
    const { library, db } = makeLibrary()
    const secondFolder = join(root, 'second')
    mkdirSync(secondFolder)
    const second = createLibrary('Second', secondFolder)
    openLibrary(library.id)
    closeLibrary(second.id)
    vi.mocked(closeManagedNativePlayers)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error('외부 플레이어를 종료하지 못했습니다.')
      })
    vi.mocked(closeAllMpvSessions).mockClear()
    expect(() => openLibrary(second.id)).toThrow('외부 플레이어를 종료하지 못했습니다.')
    expect(loadConfig().lastActiveLibraryId).toBe(library.id)
    expect(getDatabase(library.id)).toBe(db)
    expect(getDatabase(second.id)).toBeNull()
    expect(closeAllMpvSessions).not.toHaveBeenCalled()
    expect(openLibrary(second.id).id).toBe(second.id)
    expect(closeManagedNativePlayers).toHaveBeenCalledTimes(2)
    expect(closeAllMpvSessions).toHaveBeenCalledTimes(1)
    expect(loadConfig().lastActiveLibraryId).toBe(second.id)
  })
})

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
  it('announces the running file and skips a cancelled video while later videos finish', async () => {
    const { library, directory, repository, db } = makeLibrary()
    movie(directory, 'first')
    movie(directory, 'second')
    movie(directory, 'third')
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelledOutput = ''
    vi.mocked(generateThumbnails).mockImplementation(
      async (file, output, id, _duration, signal, onProgress) => {
        expect(
          events.some(
            (event) =>
              event.phase === 'thumbnails' && event.currentFile === file.split(/[\\/]/).at(-1),
          ),
        ).toBe(true)
        const filePath = join(output, id + '.jpg')
        writeFileSync(filePath, 'frame')
        if (file.endsWith('first.mp4')) {
          cancelledOutput = output
          started()
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(createAbortError()), { once: true }),
          )
        }
        onProgress?.(5, 5)
        return [{ filePath, timeSec: 1 }]
      },
    )
    const work = importFolder(library.id, directory, win)
    await didStart
    const first = repository.findByPath(join(directory, 'first.mp4'))!
    expect(cancelThumbnailJob(library.id, first.id)).toBe(true)
    expect(await work).toMatchObject({ added: 3, errors: [] })
    expect(existsSync(cancelledOutput)).toBe(false)
    expect(new ThumbnailRepository(db).findByVideoId(first.id)).toEqual([])
    expect(listThumbnailJobs(library.id).find((job) => job.videoId === first.id)?.phase).toBe(
      'cancelled',
    )
    expect(listThumbnailJobs(library.id).filter((job) => job.phase === 'completed')).toHaveLength(2)
    expect(events.at(-1)?.phase).toBe('done')
    expect(isLibraryBusy(library.id)).toBe(false)
  })

  it('reports empty extraction as a failed video and lets remaining thumbnails finish', async () => {
    const { library, directory } = makeLibrary()
    movie(directory, 'broken')
    movie(directory, 'healthy')
    let failedOutput = ''
    vi.mocked(generateThumbnails).mockImplementation(async (file, output, id) => {
      const filePath = join(output, id + '.jpg')
      writeFileSync(filePath, 'frame')
      if (file.endsWith('broken.mp4')) {
        failedOutput = output
        return []
      }
      return [{ filePath, timeSec: 1 }]
    })
    const result = await importFolder(library.id, directory, win)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('broken.mp4')
    expect(result.cancelled).toBeUndefined()
    expect(existsSync(failedOutput)).toBe(false)
    expect(listThumbnailJobs(library.id)).toMatchObject([
      { fileName: 'broken.mp4', phase: 'failed' },
      { fileName: 'healthy.mp4', phase: 'completed' },
    ])
  })
  it.skipIf(process.platform !== 'win32')(
    'creates a library with a read-only backup that already protects the empty registry',
    () => {
      saveConfig({ libraries: [] })
      const backupPath = join(state.userData, 'config.json.bak')
      const backup = JSON.stringify({ libraries: [] })
      writeFileSync(backupPath, backup)
      chmodSync(backupPath, 0o444)
      try {
        const library = createLibrary('New library', root)
        expect(loadConfig().libraries).toEqual([library])
        expect(loadConfig().lastActiveLibraryId).toBe(library.id)
        expect(readFileSync(backupPath, 'utf8')).toBe(backup)
        expect(getDatabase(library.id)).toBeDefined()
        expect(readdirSync(state.userData).filter((name) => name.includes('.tmp.'))).toEqual([])
      } finally {
        chmodSync(backupPath, 0o600)
      }
    },
  )

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
