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
import type { SubtitleGenerationJob, SubtitleGenerationOptions } from '@shared/types'

const state = vi.hoisted(() => ({
  root: '',
  extract: vi.fn(),
  transcribe: vi.fn(),
  failWrites: false,
  failCompletion: false,
  failEmpty: false,
  writes: 0,
}))
vi.mock('./SubtitleQueueStorage', async (original) => {
  const actual = await original<typeof import('./SubtitleQueueStorage')>()
  return {
    ...actual,
    writeSubtitleQueueSnapshot: (
      file: string,
      value: { entries: { job: SubtitleGenerationJob }[] },
    ) => {
      state.writes++
      if (
        state.failWrites ||
        (state.failEmpty && !value.entries.length) ||
        (state.failCompletion && value.entries.some(({ job }) => job.phase === 'completed'))
      )
        throw new actual.SubtitleQueueStorageError(
          file,
          Object.assign(new Error('Injected queue lock'), { code: 'EPERM' }),
        )
      actual.writeSubtitleQueueSnapshot(file, value)
    },
  }
})
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
import { drainLibraryWork, isLibraryBusy, withLibraryWork } from './LibraryWorkService'
import {
  initializeSubtitleQueue,
  listSubtitleQueue,
  pauseSubtitleJob,
  removeSubtitleJob,
  resumeSubtitleJob,
  shutdownSubtitleQueue,
  startSubtitleGeneration,
  getSubtitleConcurrency,
  setSubtitleConcurrency,
  cancelSubtitleGeneration,
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
  update: (patch: Partial<SubtitleGenerationJob>) => void
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
  state.failWrites = false
  state.failCompletion = false
  state.failEmpty = false
  state.writes = 0
  roots = []
  root = createRoot()
  state.root = root
  libraryId = root
  workers = []
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  for (const videoId of ['first', 'second', 'third', 'fourth']) {
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
      update: Worker['update'],
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
          update,
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
  state.failWrites = false
  state.failCompletion = false
  state.failEmpty = false
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

describe('parallel subtitle jobs', () => {
  it('runs two videos in the same library by default and fills freed slots in FIFO order', async () => {
    expect(getSubtitleConcurrency()).toBe(2)
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const one = await worker(0)
    const two = await worker(1)
    expect([one.directory, two.directory]).toEqual([
      expect.stringContaining(first.id),
      expect.stringContaining(second.id),
    ])
    expect(one.directory).not.toBe(two.directory)
    expect(job(third.id)?.phase).toBe('queued')
    await complete(two)
    const three = await worker(2)
    expect(three.directory).toContain(third.id)
    expect(one.signal.aborted).toBe(false)
    expect(isLibraryBusy(libraryId)).toBe(true)
    await complete(one)
    await complete(three)
    for (const videoId of ['first', 'second', 'third']) {
      const tracks = new SubtitleRepository(db).findByVideoId(videoId)
      expect(tracks).toHaveLength(2)
      expect(tracks.every((track) => basename(track.filePath).startsWith(videoId + '.ai'))).toBe(
        true,
      )
    }
    expect(isLibraryBusy(libraryId)).toBe(false)
  })

  it('starts waiting work when the limit grows and lets all current work finish when it shrinks', async () => {
    startSubtitleGeneration(libraryId, 'first', options)
    startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const fourth = startSubtitleGeneration(libraryId, 'fourth', options)
    const one = await worker(0)
    const two = await worker(1)
    setSubtitleConcurrency(3)
    const three = await worker(2)
    expect(three.directory).toContain(third.id)
    setSubtitleConcurrency(1)
    expect([one, two, three].every(({ signal }) => !signal.aborted)).toBe(true)
    await complete(two)
    expect(job(fourth.id)?.phase).toBe('queued')
    await complete(three)
    expect(job(fourth.id)?.phase).toBe('queued')
    await complete(one)
    const four = await worker(3)
    expect(four.directory).toContain(fourth.id)
    await complete(four)
  })

  it.each(['pause', 'remove', 'cancel'] as const)(
    'isolates %s from another running job',
    async (operation) => {
      const first = startSubtitleGeneration(libraryId, 'first', options)
      const second = startSubtitleGeneration(libraryId, 'second', options)
      const third = startSubtitleGeneration(libraryId, 'third', options)
      const one = await worker(0)
      const two = await worker(1)
      two.update({ phase: 'transcribing', percent: 37 })
      if (operation === 'pause') expect(await pauseSubtitleJob(first.id)).toBe(true)
      else if (operation === 'remove') expect(await removeSubtitleJob(first.id)).toBe(true)
      else expect(cancelSubtitleGeneration(libraryId, 'first')).toBe(true)
      const three = await worker(2)
      expect(three.directory).toContain(third.id)
      expect(one.signal.aborted).toBe(true)
      expect(two.signal.aborted).toBe(false)
      expect(job(second.id)).toMatchObject({ phase: 'transcribing', percent: 37 })
      await complete(two)
      await complete(three)
    },
  )

  it('keeps a stopping worker in its slot until its process has actually exited', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const one = await worker(0)
    await worker(1)
    one.deferAbort = true
    const removal = removeSubtitleJob(first.id)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(one.signal.aborted).toBe(true)
      expect(workers).toHaveLength(2)
      expect(job(third.id)?.phase).toBe('queued')
      expect(existsSync(one.audio)).toBe(true)
    } finally {
      one.reject(createAbortError())
      await removal
    }
    expect((await worker(2)).directory).toContain(third.id)
    expect(existsSync(one.directory)).toBe(false)
  })

  it('keeps other jobs running after a worker fails and advances the waiting job', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const one = await worker(0)
    const two = await worker(1)
    one.reject(new Error('GPU memory fixture failure'))
    const three = await worker(2)
    expect(job(first.id)?.phase).toBe('failed')
    expect(three.directory).toContain(third.id)
    expect(two.signal.aborted).toBe(false)
    await complete(two)
    await complete(three)
  })

  it('skips an exclusively locked library while filling slots from another library', async () => {
    let release!: () => void
    const lock = withLibraryWork(
      libraryId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const otherId = libraryId + '-other'
    const otherDb = openDatabase(otherId, ':memory:')
    runMigrations(otherDb, ':memory:')
    for (const id of ['first', 'second'])
      new VideoRepository(otherDb).insert({
        id,
        fileName: id + '.mp4',
        filePath: source(id),
        rating: 0,
        memo: '',
        resumePosSec: 0,
      })
    try {
      const waiting = startSubtitleGeneration(libraryId, 'first', options)
      startSubtitleGeneration(otherId, 'first', options)
      startSubtitleGeneration(otherId, 'second', options)
      await worker(1)
      expect(workers).toHaveLength(2)
      expect(job(waiting.id)?.phase).toBe('queued')
      await complete(workers[0])
      await complete(workers[1])
    } finally {
      release()
      await lock
    }
    expect((await worker(2)).signal.aborted).toBe(false)
  })

  it('aborts every worker on storage failure and waits for all cleanup before allowing recovery', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const third = startSubtitleGeneration(libraryId, 'third', options)
    const one = await worker(0)
    const two = await worker(1)
    two.deferAbort = true
    writeFileSync(join(one.directory, 'checkpoint.json'), 'first checkpoint')
    writeFileSync(join(two.directory, 'checkpoint.json'), 'second checkpoint')
    state.failWrites = true
    expect(() => one.update({ phase: 'transcribing', percent: 14 })).toThrow('EPERM')
    const writes = state.writes
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(one.signal.aborted && two.signal.aborted).toBe(true)
      expect(listSubtitleQueue().map(({ phase }) => phase)).toEqual(['paused', 'paused', 'paused'])
      state.failWrites = false
      expect(() => resumeSubtitleJob(first.id)).toThrow('정리하고 있습니다')
      expect(state.writes).toBe(writes)
    } finally {
      two.reject(createAbortError())
      two.deferAbort = false
    }
    await vi.waitFor(() => expect(isLibraryBusy(libraryId)).toBe(false))
    expect(resumeSubtitleJob(first.id)).toBe(true)
    const resumed = await worker(2)
    expect(readFileSync(join(resumed.directory, 'checkpoint.json'), 'utf8')).toBe(
      'first checkpoint',
    )
    expect(readFileSync(join(two.directory, 'checkpoint.json'), 'utf8')).toBe('second checkpoint')
    expect(job(second.id)?.phase).toBe('paused')
    expect(job(third.id)?.phase).toBe('paused')
    await complete(resumed)
  })

  it('waits for all workers on shutdown and restores their progress and concurrency without auto-start', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    startSubtitleGeneration(libraryId, 'third', options)
    const one = await worker(0)
    const two = await worker(1)
    for (const current of [one, two]) {
      current.deferAbort = true
      writeFileSync(
        join(current.directory, 'checkpoint.json'),
        'saved ' + basename(current.directory),
      )
    }
    let stopped = false
    const stopping = shutdownSubtitleQueue().then(() => {
      stopped = true
    })
    try {
      expect(one.signal.aborted && two.signal.aborted).toBe(true)
      one.reject(createAbortError())
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stopped).toBe(false)
    } finally {
      one.reject(createAbortError())
      two.reject(createAbortError())
      await stopping
    }
    state.root = createRoot()
    initializeSubtitleQueue()
    state.root = root
    initializeSubtitleQueue()
    expect(getSubtitleConcurrency()).toBe(2)
    expect(listSubtitleQueue().every(({ phase }) => phase === 'paused')).toBe(true)
    expect(workers).toHaveLength(2)
    expect(resumeSubtitleJob(first.id)).toBe(true)
    expect(resumeSubtitleJob(second.id)).toBe(true)
    const resumedOne = await worker(2)
    const resumedTwo = await worker(3)
    expect([resumedOne.directory, resumedTwo.directory]).toEqual([one.directory, two.directory])
    expect(state.extract).toHaveBeenCalledTimes(2)
    await complete(resumedOne)
    await complete(resumedTwo)
  })

  it('validates and persists the limit and defaults old journals to two workers', () => {
    writeFileSync(join(root, 'subtitle-queue.json'), JSON.stringify({ version: 1, entries: [] }))
    expect(getSubtitleConcurrency()).toBe(2)
    for (const value of [0, 5, 1.5, NaN, Infinity])
      expect(() => setSubtitleConcurrency(value)).toThrow()
    setSubtitleConcurrency(4)
    state.root = createRoot()
    initializeSubtitleQueue()
    expect(getSubtitleConcurrency()).toBe(2)
    state.root = root
    initializeSubtitleQueue()
    expect(getSubtitleConcurrency()).toBe(4)
    state.failWrites = true
    expect(() => setSubtitleConcurrency(3)).toThrow('EPERM')
    expect(getSubtitleConcurrency()).toBe(4)
    state.failWrites = false
    expect(setSubtitleConcurrency(1)).toBe(1)
  })
})

describe('subtitle queue lifecycle', () => {
  beforeEach(() => setSubtitleConcurrency(1))

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
        expect(existsSync(original.directory)).toBe(true)
      } finally {
        rmdirSync(journal)
        writeFileSync(journal, saved)
      }
    },
  )

  it('freezes the whole queue after a persistent save failure and retries only after a user action', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const second = startSubtitleGeneration(libraryId, 'second', options)
    const current = await worker(0)
    const checkpoint = join(current.directory, 'checkpoint.json')
    writeFileSync(checkpoint, 'committed transcript')
    const journal = join(root, 'subtitle-queue.json')
    const durable = readFileSync(journal)
    state.failWrites = true
    expect(() => current.update({ phase: 'transcribing', percent: 15 })).toThrow('EPERM')
    await vi.waitFor(() => expect(isLibraryBusy(libraryId)).toBe(false))
    expect(listSubtitleQueue().map(({ phase }) => phase)).toEqual(['paused', 'paused'])
    expect(job(first.id)?.storageError).toContain('저장 다시 시도')
    expect(readFileSync(journal)).toEqual(durable)
    expect(readFileSync(checkpoint, 'utf8')).toBe('committed transcript')
    const writes = state.writes
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(state.writes).toBe(writes)
    expect(state.transcribe).toHaveBeenCalledOnce()
    expect(() => resumeSubtitleJob(first.id)).toThrow('EPERM')
    expect(job(first.id)?.phase).toBe('paused')
    state.failWrites = false
    expect(resumeSubtitleJob(first.id)).toBe(true)
    await complete(await worker(1))
    expect(job(first.id)?.storageError).toBeUndefined()
    expect(job(second.id)?.phase).toBe('paused')
    expect(state.extract).toHaveBeenCalledOnce()
  })

  it('rejects an unsaved queue admission without retaining a duplicate job', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    await worker(0)
    await pauseSubtitleJob(first.id)
    const durable = readFileSync(join(root, 'subtitle-queue.json'))
    state.failWrites = true
    expect(() => startSubtitleGeneration(libraryId, 'second', options)).toThrow('EPERM')
    expect(listSubtitleQueue().map(({ id }) => id)).toEqual([first.id])
    expect(readFileSync(join(root, 'subtitle-queue.json'))).toEqual(durable)
    state.failWrites = false
    expect(resumeSubtitleJob(first.id)).toBe(true)
    await complete(await worker(1))
  })

  it('preserves published outputs and checkpoints when completion cannot be saved, and never republishes on storage retry', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(0)
    const checkpoint = join(current.directory, 'checkpoint.json')
    writeFileSync(checkpoint, 'finished transcript')
    state.failCompletion = true
    await complete(current)
    await vi.waitFor(() => expect(job(first.id)?.storageError).toContain('EPERM'))
    expect(job(first.id)?.phase).toBe('completed')
    const durable = JSON.parse(readFileSync(join(root, 'subtitle-queue.json'), 'utf8'))
    expect(durable.entries[0].job.phase).toBe('saving')
    expect(durable.entries[0].job.outputPaths).toBeUndefined()
    expect(readFileSync(checkpoint, 'utf8')).toBe('finished transcript')
    const outputs = job(first.id)!.outputPaths!
    expect(outputs.every(existsSync)).toBe(true)
    state.failCompletion = false
    expect(resumeSubtitleJob(first.id)).toBe(true)
    expect(job(first.id)?.storageError).toBeUndefined()
    expect(job(first.id)?.outputPaths).toEqual(outputs)
    expect(new SubtitleRepository(db).findByVideoId('first')).toHaveLength(2)
    expect(state.transcribe).toHaveBeenCalledOnce()
    expect(readdirSync(root).filter((path) => path.endsWith('.srt'))).toHaveLength(2)
  })

  it.each(['running', 'completed'] as const)(
    'retains a retry control if removing the last %s job cannot be saved',
    async (phase) => {
      const first = startSubtitleGeneration(libraryId, 'first', options)
      const current = await worker(0)
      if (phase === 'completed') await complete(current)
      state.failEmpty = true
      await expect(removeSubtitleJob(first.id)).rejects.toThrow('EPERM')
      await vi.waitFor(() => expect(isLibraryBusy(libraryId)).toBe(false))
      expect(job(first.id)).toMatchObject({
        phase: 'cancelled',
        storageError: expect.stringContaining('저장 다시 시도'),
      })
      state.failEmpty = false
      expect(resumeSubtitleJob(first.id)).toBe(true)
      expect(state.transcribe).toHaveBeenCalledOnce()
      expect(await removeSubtitleJob(first.id)).toBe(true)
      expect(listSubtitleQueue()).toEqual([])
      startSubtitleGeneration(libraryId, 'second', options)
      await complete(await worker(1))
    },
  )

  it('restores publication intent after restart and reuses verified outputs instead of creating another pair', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(0)
    writeFileSync(join(current.directory, 'checkpoint.json'), 'finished transcript')
    state.failCompletion = true
    await complete(current)
    await vi.waitFor(() => expect(job(first.id)?.storageError).toContain('EPERM'))
    const outputs = job(first.id)!.outputPaths!
    state.failCompletion = false
    state.root = createRoot()
    initializeSubtitleQueue()
    state.root = root
    initializeSubtitleQueue()
    expect(job(first.id)?.phase).toBe('paused')
    expect(job(first.id)?.outputPaths).toBeUndefined()
    expect(resumeSubtitleJob(first.id)).toBe(true)
    const resumed = await worker(1)
    expect(resumed.directory).toBe(current.directory)
    await complete(resumed)
    expect(job(first.id)?.outputPaths).toEqual(outputs)
    expect(new SubtitleRepository(db).findByVideoId('first')).toHaveLength(2)
    expect(readdirSync(root).filter((path) => path.endsWith('.srt'))).toHaveLength(2)
    expect(state.extract).toHaveBeenCalledOnce()
  })

  it('allows an explicit new attempt after the initial unsaved admission leaves an empty queue', async () => {
    state.failWrites = true
    expect(() => startSubtitleGeneration(libraryId, 'first', options)).toThrow('EPERM')
    expect(listSubtitleQueue()).toEqual([])
    state.failWrites = false
    startSubtitleGeneration(libraryId, 'first', options)
    await complete(await worker(0))
  })

  it('persists confirmed device evidence, isolates snapshots, and marks restored evidence as a previous record', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(0)
    current.update({
      processing: { asr: 'vulkan', device: 'Vulkan0', evidence: 'engine', translation: 'ollama' },
    })
    const copy = job(first.id)!
    copy.processing!.device = 'changed by caller'
    expect(job(first.id)?.processing?.device).toBe('Vulkan0')
    await pauseSubtitleJob(first.id)
    state.root = createRoot()
    initializeSubtitleQueue()
    state.root = root
    initializeSubtitleQueue()
    expect(job(first.id)?.processing).toEqual({
      asr: 'vulkan',
      device: 'Vulkan0',
      evidence: 'checkpoint',
      translation: 'ollama',
    })
    expect(state.transcribe).toHaveBeenCalledOnce()
  })

  it('resumes failed work after storage recovery while retaining its checkpoint', async () => {
    const first = startSubtitleGeneration(libraryId, 'first', options)
    const current = await worker(0)
    writeFileSync(join(current.directory, 'checkpoint.json'), 'partial translation')
    state.failWrites = true
    current.reject(new Error('translation unavailable'))
    await vi.waitFor(() => expect(job(first.id)?.storageError).toContain('EPERM'))
    expect(job(first.id)?.phase).toBe('failed')
    state.failWrites = false
    expect(resumeSubtitleJob(first.id)).toBe(true)
    const resumed = await worker(1)
    expect(readFileSync(join(resumed.directory, 'checkpoint.json'), 'utf8')).toBe(
      'partial translation',
    )
    await complete(resumed)
  })
})
