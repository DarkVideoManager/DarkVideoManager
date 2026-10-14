import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleGenerationOptions } from '@shared/types'

const state = vi.hoisted(() => ({ root: '', extract: vi.fn(), transcribe: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root, isPackaged: false } }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
vi.mock('./SubtitleRuntime', () => ({
  extractSubtitleAudio: state.extract,
  transcribeSubtitleAudio: state.transcribe,
}))

import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { createAbortError } from '../ffmpeg/queue'
import { drainLibraryWork, isLibraryBusy } from './LibraryWorkService'
import {
  initializeSubtitleQueue,
  listSubtitleQueue,
  pauseSubtitleJob,
  removeSubtitleJob,
  resumeSubtitleJob,
  shutdownSubtitleQueue,
  startSubtitleGeneration,
} from './SubtitleGenerationService'

const options = { model: 'base', language: 'auto', translateToKorean: true } as const
const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello\n'
interface Result {
  language: string
  cueCount: number
  translated: boolean
  translationError?: string
}
interface Worker {
  audio: string
  directory: string
  options: SubtitleGenerationOptions
  signal: AbortSignal
  resume: boolean
  resolve: (result: Result) => void
  reject: (error: Error) => void
  deferAbort: boolean
}
let db: ReturnType<typeof openDatabase>
let libraryId: string
let root: string
let workers: Worker[]
let roots: string[]

function createRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dvm-subtitle-queue-test-'))
  roots.push(directory)
  return directory
}

function source(videoId: string): string {
  return join(root, videoId + '.mp4')
}

function job(id: string) {
  return listSubtitleQueue().find((entry) => entry.id === id)
}

async function worker(index: number): Promise<Worker> {
  await vi.waitFor(() => expect(workers.length).toBeGreaterThan(index))
  return workers[index]
}

async function complete(
  current: Worker,
  result: Result = { language: 'en', cueCount: 1, translated: true },
) {
  writeFileSync(join(current.directory, 'original.srt'), srt)
  if (result.translated)
    writeFileSync(join(current.directory, 'ko.srt'), srt.replace('Hello', '안녕하세요'))
  current.resolve(result)
  await vi.waitFor(() =>
    expect(
      listSubtitleQueue().find((entry) => 'queue-' + entry.id === basename(current.directory))
        ?.phase,
    ).toBe(result.translationError ? 'failed' : 'completed'),
  )
}

beforeEach(() => {
  roots = []
  root = createRoot()
  state.root = root
  libraryId = root
  workers = []
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  for (const videoId of ['first', 'second', 'third']) {
    writeFileSync(source(videoId), 'video fixture ' + videoId)
    new VideoRepository(db).insert({
      id: videoId,
      fileName: videoId + '.mp4',
      filePath: source(videoId),
      rating: 0,
      memo: '',
      resumePosSec: 0,
    })
  }
  state.extract.mockReset().mockImplementation(async (_video: string, audio: string) => {
    writeFileSync(audio, 'audio fixture')
  })
  state.transcribe.mockReset().mockImplementation(
    (
      audio: string,
      directory: string,
      requested: SubtitleGenerationOptions,
      signal: AbortSignal,
      _update: unknown,
      resume: boolean,
    ) =>
      new Promise<Result>((resolve, reject) => {
        const current = {
          audio,
          directory,
          options: { ...requested },
          signal,
          resume,
          resolve,
          reject,
          deferAbort: false,
        }
        workers.push(current)
        signal.addEventListener(
          'abort',
          () => {
            if (!current.deferAbort) reject(createAbortError())
          },
          { once: true },
        )
      }),
  )
})

afterEach(async () => {
  await shutdownSubtitleQueue()
  await drainLibraryWork()
  closeAllDatabases()
  for (const directory of roots) {
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('dvm-subtitle-queue-test-')
    )
      throw new Error('Unsafe cleanup path')
    rmSync(target, { force: true, recursive: true })
  }
})

describe('subtitle queue lifecycle', () => {
  it('processes different videos from the same library one at a time in FIFO order', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const firstWorker = await worker(0)
    expect(job(second.id)?.phase).toBe('queued')
    expect(job(third.id)?.phase).toBe('queued')
    expect(state.extract).toHaveBeenCalledTimes(1)
    await complete(firstWorker)
    const secondWorker = await worker(1)
    expect(secondWorker.directory).toContain(second.id)
    expect(job(first.id)?.phase).toBe('completed')
    expect(job(third.id)?.phase).toBe('queued')
    await complete(secondWorker)
    const thirdWorker = await worker(2)
    expect(thirdWorker.directory).toContain(third.id)
    await complete(thirdWorker)
    expect(state.extract.mock.calls.map(([video]) => video)).toEqual(
      ['first', 'second', 'third'].map(source),
    )
    expect(isLibraryBusy(libraryId)).toBe(false)
  })

  it('pauses a running job, retains its progress, releases the library, and advances the next job', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const current = await worker(0)
    writeFileSync(join(current.directory, 'checkpoint.json'), 'saved progress')
    expect(await pauseSubtitleJob(first.id)).toBe(true)
    expect(current.signal.aborted).toBe(true)
    expect(job(first.id)?.phase).toBe('paused')
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(readFileSync(join(current.directory, 'checkpoint.json'), 'utf8')).toBe('saved progress')
    expect(existsSync(current.audio)).toBe(true)
    const next = await worker(1)
    expect(next.directory).toContain(second.id)
    await complete(next)
    expect(new SubtitleRepository(db).findByVideoId('first')).toEqual([])
  })

  it('pauses or deletes waiting jobs without starting any worker for them', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const current = await worker(0)
    expect(await pauseSubtitleJob(second.id)).toBe(true)
    expect(await removeSubtitleJob(third.id)).toBe(true)
    expect(job(second.id)?.phase).toBe('paused')
    expect(job(third.id)).toBeUndefined()
    expect(current.signal.aborted).toBe(false)
    await complete(current)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(job(first.id)?.phase).toBe('completed')
    expect(state.extract).toHaveBeenCalledTimes(1)
    expect(state.transcribe).toHaveBeenCalledTimes(1)
    expect(isLibraryBusy(libraryId)).toBe(false)
  })

  it('resumes in the same staging directory with saved audio and immutable job options', async () => {
    const input: SubtitleGenerationOptions = { ...options }
    const first = startSubtitleGeneration(libraryId, 'first', input)
    const original = await worker(0)
    writeFileSync(join(original.directory, 'checkpoint.json'), 'saved transcript')
    await pauseSubtitleJob(first.id)
    input.model = 'tiny'
    first.options.language = 'ko'
    expect(resumeSubtitleJob(first.id)).toBe(true)
    const resumed = await worker(1)
    expect(resumed.directory).toBe(original.directory)
    expect(resumed.audio).toBe(original.audio)
    expect(resumed.options).toEqual(options)
    expect(resumed.resume).toBe(true)
    expect(readFileSync(join(resumed.directory, 'checkpoint.json'), 'utf8')).toBe(
      'saved transcript',
    )
    expect(state.extract).toHaveBeenCalledTimes(1)
    await complete(resumed)
  })

  it('waits for an active worker to exit before deleting its staging directory', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(0)
    current.deferAbort = true
    let removed = false
    const removal = removeSubtitleJob(first.id).then((result) => {
      removed = result
    })
    try {
      await Promise.resolve()
      expect(current.signal.aborted).toBe(true)
      expect(job(first.id)?.phase).toBe('removing')
      expect(removed).toBe(false)
      expect(existsSync(current.directory)).toBe(true)
      expect(isLibraryBusy(libraryId)).toBe(true)
    } finally {
      current.reject(createAbortError())
      await removal
    }
    expect(removed).toBe(true)
    expect(job(first.id)).toBeUndefined()
    expect(existsSync(current.directory)).toBe(false)
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(new SubtitleRepository(db).findByVideoId('first')).toEqual([])
  })

  it('deletes completed queue history while preserving its published subtitles and database tracks', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    await complete(await worker(0))
    const outputs = job(first.id)!.outputPaths!
    const tracks = new SubtitleRepository(db).findByVideoId('first')
    expect(await removeSubtitleJob(first.id)).toBe(true)
    expect(job(first.id)).toBeUndefined()
    expect(outputs.every(existsSync)).toBe(true)
    expect(new SubtitleRepository(db).findByVideoId('first')).toEqual(tracks)
  })

  it('does not resume an old failed task while another task for the same video is pending', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const original = await worker(0)
    original.reject(new Error('temporary service error'))
    await vi.waitFor(() => expect(job(first.id)?.phase).toBe('failed'))
    const replacement = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(1)
    expect(() => resumeSubtitleJob(first.id)).toThrow('다른 자막 작업')
    expect(job(first.id)?.phase).toBe('failed')
    expect(current.directory).toContain(replacement.id)
    expect(state.transcribe).toHaveBeenCalledTimes(2)
    await complete(current)
  })

  it('saves shutdown-paused jobs and restores them without starting work until resumed', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const original = await worker(0)
    writeFileSync(join(original.directory, 'checkpoint.json'), 'saved transcript')
    await shutdownSubtitleQueue()
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(listSubtitleQueue().map((entry) => entry.phase)).toEqual(['paused', 'paused'])
    const journal = JSON.parse(readFileSync(join(root, 'subtitle-queue.json'), 'utf8'))
    expect(journal.entries.map((entry: { job: { phase: string } }) => entry.job.phase)).toEqual([
      'paused',
      'paused',
    ])
    // Switching isolated user-data roots resets service memory, then reloads the saved journal.
    state.root = createRoot()
    try {
      initializeSubtitleQueue()
      expect(listSubtitleQueue()).toEqual([])
    } finally {
      state.root = root
      initializeSubtitleQueue()
    }
    expect(listSubtitleQueue().map((entry) => entry.id)).toEqual([first.id, second.id])
    expect(listSubtitleQueue().every((entry) => entry.phase === 'paused')).toBe(true)
    expect(state.transcribe).toHaveBeenCalledTimes(1)
    expect(resumeSubtitleJob(first.id)).toBe(true)
    const resumed = await worker(1)
    expect(resumed.directory).toBe(original.directory)
    expect(state.extract).toHaveBeenCalledTimes(1)
    await complete(resumed)
    expect(job(second.id)?.phase).toBe('paused')
  })

  it('retries Korean translation without duplicating the already published original track', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const partial = {
      language: 'en',
      cueCount: 1,
      translated: false,
      translationError: 'provider unavailable',
    }
    await complete(await worker(0), partial)
    const originalPath = job(first.id)!.outputPaths![0]
    expect(resumeSubtitleJob(first.id)).toBe(true)
    await complete(await worker(1), partial)
    expect(job(first.id)!.outputPaths).toEqual([originalPath])
    expect(new SubtitleRepository(db).findByVideoId('first')).toHaveLength(1)
    expect(resumeSubtitleJob(first.id)).toBe(true)
    await complete(await worker(2))
    expect(job(first.id)!.outputPaths).toEqual([
      originalPath,
      originalPath.replace(/\.srt$/, '.ko.srt'),
    ])
    expect(
      new SubtitleRepository(db)
        .findByVideoId('first')
        .map((sub) => sub.lang)
        .sort(),
    ).toEqual(['en', 'ko'])
    expect(readdirSync(root).filter((path) => path.endsWith('.srt'))).toHaveLength(2)
    expect(state.extract).toHaveBeenCalledTimes(1)
  })

  it('rejects resume after the source video changes without destroying saved progress', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const original = await worker(0)
    await pauseSubtitleJob(first.id)
    writeFileSync(source('first'), 'replacement video content with a different size')
    expect(() => resumeSubtitleJob(first.id)).toThrow('원본 영상이 변경')
    expect(job(first.id)?.phase).toBe('paused')
    expect(existsSync(original.audio)).toBe(true)
    expect(state.extract).toHaveBeenCalledTimes(1)
    expect(state.transcribe).toHaveBeenCalledTimes(1)
  })

  it.each(['pause', 'remove'] as const)(
    'still stops the worker when %s cannot persist the journal',
    async (action) => {
      const first = startSubtitleGeneration(libraryId, 'first', options)
      const original = await worker(0)
      const journal = join(root, 'subtitle-queue.json')
      const saved = readFileSync(journal)
      // A directory at the journal path gives a deterministic rename failure on Windows.
      unlinkSync(journal)
      mkdirSync(journal)
      try {
        await expect(
          action === 'pause' ? pauseSubtitleJob(first.id) : removeSubtitleJob(first.id),
        ).rejects.toThrow()
        expect(original.signal.aborted).toBe(true)
        expect(isLibraryBusy(libraryId)).toBe(false)
        expect(new SubtitleRepository(db).findByVideoId('first')).toEqual([])
        expect(existsSync(original.directory)).toBe(action === 'pause')
      } finally {
        rmdirSync(journal)
        writeFileSync(journal, saved)
      }
    },
  )
})
