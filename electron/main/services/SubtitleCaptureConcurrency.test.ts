import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleGenerationOptions } from '@shared/types'

const state = vi.hoisted(() => ({
  root: '',
  extractAudio: vi.fn(),
  transcribe: vi.fn(),
  extractThumbnail: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => state.root, isPackaged: false } }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('./SubtitleRuntime', () => ({
  extractSubtitleAudio: state.extractAudio,
  transcribeSubtitleAudio: state.transcribe,
}))
vi.mock('../ffmpeg/thumbnail', () => ({
  extractThumbnailAtTime: state.extractThumbnail,
  generateThumbnails: vi.fn(),
  isThumbnailTimeoutError: (error: Error) => error.name === 'ThumbnailTimeoutError',
}))
vi.mock('../ffmpeg/ffprobe', () => ({ probeVideo: vi.fn() }))

import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { getThumbnailsDir } from '../infra/paths'
import { createAbortError } from '../ffmpeg/queue'
import {
  createHighlight,
  deleteHighlight,
  listHighlights,
  updateHighlight,
} from './HighlightService'
import { captureThumbnailAtTime, saveThumbnailImageCapture } from './ThumbnailCaptureService.js'
import { previewCsvImport } from './DataImportService.js'
import { closeLibrary, deleteLibrary } from './LibraryService'
import { drainLibraryWork, isLibraryBusy, withLibraryWork } from './LibraryWorkService'
import {
  listSubtitleQueue,
  pauseSubtitleJob,
  shutdownSubtitleQueue,
  startSubtitleGeneration,
} from './SubtitleGenerationService'

const libraryId = 'subtitle-capture-test'
const videoId = 'video'
const options = { model: 'base', language: 'en', translateToKorean: false } as const
const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello\n'
const webContents = { send: vi.fn(), isDestroyed: () => false } as unknown as Electron.WebContents
interface PendingWorker<T> {
  signal: AbortSignal
  resolve: (value: T) => void
  reject: (error: Error) => void
  deferAbort: boolean
}
interface Transcript {
  language: string
  cueCount: number
  translated: boolean
}
let db: ReturnType<typeof openDatabase>
let subtitleWorker: (PendingWorker<Transcript> & { directory: string }) | undefined
let captureWorker: (PendingWorker<string> & { filePath: string }) | undefined

function pendingWorker<T>(
  signal: AbortSignal,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
) {
  const worker = { signal, resolve, reject, deferAbort: false }
  signal.addEventListener(
    'abort',
    () => {
      if (!worker.deferAbort) reject(createAbortError())
    },
    { once: true },
  )
  return worker
}

function job(id: string) {
  return listSubtitleQueue().find((entry) => entry.id === id)!
}

async function startSubtitles() {
  const started = startSubtitleGeneration(libraryId, videoId, options)
  await vi.waitFor(() => expect(subtitleWorker).toBeDefined())
  return { jobId: started.id, worker: subtitleWorker! }
}

async function completeSubtitles(jobId: string) {
  writeFileSync(join(subtitleWorker!.directory, 'original.srt'), srt)
  subtitleWorker!.resolve({ language: 'en', cueCount: 1, translated: false })
  await vi.waitFor(() => expect(job(jobId).phase).toBe('completed'))
}

function holdCapture() {
  state.extractThumbnail.mockImplementation(
    (_source: string, outputDir: string, _id: string, _time: number, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const filePath = join(outputDir, 'frame.jpg')
        writeFileSync(filePath, 'pending image')
        captureWorker = Object.assign(pendingWorker(signal, resolve, reject), { filePath })
      }),
  )
  // Attach the rejection handler immediately so cancellation never leaks an unhandled rejection.
  return captureThumbnailAtTime(libraryId, videoId, 4, webContents).catch((error: Error) => error)
}

async function expectExclusiveOperationsBlocked() {
  expect(isLibraryBusy(libraryId)).toBe(true)
  expect(() => closeLibrary(libraryId)).toThrow('작업이 진행 중')
  expect(() => deleteLibrary(libraryId)).toThrow('작업이 진행 중')
  await expect(previewCsvImport(libraryId, 'unused.csv')).rejects.toThrow('다른 작업')
  await expect(withLibraryWork(libraryId, async () => undefined)).rejects.toThrow('다른 작업')
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'dvm-subtitle-capture-test-'))
  subtitleWorker = undefined
  captureWorker = undefined
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  const filePath = join(state.root, 'video.mp4')
  writeFileSync(filePath, 'video fixture')
  new VideoRepository(db).insert({
    id: videoId,
    fileName: 'video.mp4',
    filePath,
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
  const existingPath = join(getThumbnailsDir(libraryId), 'existing.jpg')
  writeFileSync(existingPath, 'existing image')
  new ThumbnailRepository(db).insert({
    id: 'existing',
    videoId,
    filePath: existingPath,
    timeSec: 1,
    isPrimary: true,
  })
  state.extractAudio.mockReset().mockImplementation(async (_source: string, audio: string) => {
    writeFileSync(audio, 'audio fixture')
  })
  state.transcribe.mockReset().mockImplementation(
    (_audio: string, directory: string, _options: SubtitleGenerationOptions, signal: AbortSignal) =>
      new Promise<Transcript>((resolve, reject) => {
        subtitleWorker = Object.assign(pendingWorker(signal, resolve, reject), { directory })
      }),
  )
  state.extractThumbnail
    .mockReset()
    .mockImplementation(async (_source: string, outputDir: string) => {
      const filePath = join(outputDir, 'frame.jpg')
      writeFileSync(filePath, 'captured image')
      return filePath
    })
})

afterEach(async () => {
  // Ensure an assertion failure cannot strand a deliberately delayed cancellation.
  subtitleWorker?.reject(createAbortError())
  captureWorker?.reject(createAbortError())
  await shutdownSubtitleQueue()
  await drainLibraryWork()
  closeAllDatabases()
  const target = resolve(state.root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-subtitle-capture-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('subtitle generation with highlight and thumbnail capture', () => {
  it.each([false, true])(
    'saves highlights and images with makePrimary=%s while inference runs',
    async (makePrimary) => {
      const { jobId, worker } = await startSubtitles()
      const thumbnail = await captureThumbnailAtTime(
        libraryId,
        videoId,
        2,
        webContents,
        true,
        makePrimary,
      )
      const highlight = createHighlight(libraryId, {
        videoId,
        timeStart: 2,
        label: 'saved while generating',
      })
      updateHighlight(libraryId, highlight.id, { label: 'edited while generating', timeEnd: 3 })
      const discarded = createHighlight(libraryId, { videoId, timeStart: 5 })
      deleteHighlight(libraryId, discarded.id)
      const fallback = saveThumbnailImageCapture(
        libraryId,
        videoId,
        3,
        'data:image/png;base64,aW1hZ2U=',
        webContents,
        makePrimary,
      )
      const thumbnails = new ThumbnailRepository(db).findByVideoId(videoId)
      expect(thumbnails.map((entry) => entry.id)).toEqual(['existing', thumbnail.id, fallback.id])
      expect(thumbnails.filter((entry) => entry.isPrimary).map((entry) => entry.id)).toEqual([
        makePrimary ? fallback.id : 'existing',
      ])
      expect(listHighlights(libraryId, videoId)).toMatchObject([
        { id: highlight.id, label: 'edited while generating', timeEnd: 3 },
      ])
      expect(worker.signal.aborted).toBe(false)
      expect(job(jobId).phase).not.toBe('completed')
      await expectExclusiveOperationsBlocked()
      await completeSubtitles(jobId)
      expect(isLibraryBusy(libraryId)).toBe(false)
      expect(new SubtitleRepository(db).findByVideoId(videoId)).toHaveLength(1)
      expect(readFileSync(job(jobId).outputPaths![0], 'utf8')).toBe(srt)
      expect(new ThumbnailRepository(db).findByVideoId(videoId)).toEqual(thumbnails)
      expect(thumbnails.every((entry) => existsSync(entry.filePath))).toBe(true)
      expect(listHighlights(libraryId, videoId)).toHaveLength(1)
    },
  )

  it('starts subtitles during an existing capture and retains the capture lock after publication', async () => {
    const capture = holdCapture()
    await vi.waitFor(() => expect(captureWorker).toBeDefined())
    const { jobId } = await startSubtitles()
    await completeSubtitles(jobId)
    await expectExclusiveOperationsBlocked()
    expect(captureWorker!.signal.aborted).toBe(false)
    captureWorker!.resolve(captureWorker!.filePath)
    expect(await capture).toMatchObject({ timeSec: 4, isPrimary: true })
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(new ThumbnailRepository(db).findByVideoId(videoId)).toHaveLength(2)
  })

  it('pauses only subtitles while an overlapping capture finishes normally', async () => {
    const { jobId, worker } = await startSubtitles()
    const capture = holdCapture()
    await vi.waitFor(() => expect(captureWorker).toBeDefined())
    expect(await pauseSubtitleJob(jobId)).toBe(true)
    expect(worker.signal.aborted).toBe(true)
    expect(job(jobId).phase).toBe('paused')
    expect(captureWorker!.signal.aborted).toBe(false)
    await expectExclusiveOperationsBlocked()
    captureWorker!.resolve(captureWorker!.filePath)
    expect(await capture).toMatchObject({ timeSec: 4, isPrimary: true })
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(new SubtitleRepository(db).findByVideoId(videoId)).toEqual([])
  })

  it('drains both workers and waits for capture cleanup after subtitle cancellation finishes', async () => {
    const { jobId, worker } = await startSubtitles()
    const capture = holdCapture()
    await vi.waitFor(() => expect(captureWorker).toBeDefined())
    // A delayed capture models ffmpeg process termination and file cleanup during shutdown.
    captureWorker!.deferAbort = true
    let drained = false
    const draining = drainLibraryWork().then(() => {
      drained = true
    })
    await vi.waitFor(() => expect(job(jobId).phase).toBe('cancelled'))
    expect(worker.signal.aborted).toBe(true)
    expect(captureWorker!.signal.aborted).toBe(true)
    expect(drained).toBe(false)
    expect(isLibraryBusy(libraryId)).toBe(true)
    expect(existsSync(captureWorker!.filePath)).toBe(true)
    captureWorker!.reject(createAbortError())
    expect(await capture).toMatchObject({ name: 'AbortError' })
    await draining
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(readdirSync(getThumbnailsDir(libraryId))).toEqual(['existing.jpg'])
    expect(new ThumbnailRepository(db).findByVideoId(videoId)).toMatchObject([{ id: 'existing' }])
    expect(new SubtitleRepository(db).findByVideoId(videoId)).toEqual([])
  })
})
