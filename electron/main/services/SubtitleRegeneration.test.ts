import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleGenerationOptions } from '@shared/types'

const state = vi.hoisted(() => ({
  root: '',
  extract: vi.fn(),
  transcribe: vi.fn(),
  engine: vi.fn(),
  trash: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.root, isPackaged: false },
  shell: { trashItem: state.trash },
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
vi.mock('./SubtitleRuntime', () => ({
  extractSubtitleAudio: state.extract,
  transcribeSubtitleAudio: state.transcribe,
  getSubtitleEngineInfo: state.engine,
}))

import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { createAbortError } from '../ffmpeg/queue'
import { drainLibraryWork, withLibraryWork } from './LibraryWorkService'
import {
  initializeSubtitleQueue,
  listSubtitleQueue,
  pauseSubtitleJob,
  regenerateSubtitles,
  removeSubtitleJob,
  resumeSubtitleJob,
  shutdownSubtitleQueue,
  startSubtitleGeneration,
  setSubtitleConcurrency,
} from './SubtitleGenerationService'

const options = { model: 'base', language: 'auto', translateToKorean: true } as const
const srt = '1\n00:00:00,000 --> 00:00:02,000\nOld subtitle\n'
interface Worker {
  directory: string
  options: SubtitleGenerationOptions
  reject: (error: Error) => void
  resolve: (result: { language: string; cueCount: number; translated: boolean }) => void
}
let root: string
let db: ReturnType<typeof openDatabase>
let workers: Worker[]

function source(videoId = 'first'): string {
  return join(root, videoId + '.mp4')
}

function external(suffix: string, videoId = 'first'): { id: string; path: string } {
  const id = randomUUID()
  const path = join(root, videoId + suffix)
  writeFileSync(path, srt)
  new SubtitleRepository(db).insert({ id, videoId, filePath: path, type: 'srt', isEmbedded: false })
  return { id, path }
}

async function worker(index = 0): Promise<Worker> {
  await vi.waitFor(() => expect(workers.length).toBeGreaterThan(index))
  return workers[index]
}

function job(id: string) {
  return listSubtitleQueue().find((entry) => entry.id === id)
}

async function complete(current: Worker) {
  writeFileSync(
    join(current.directory, 'original.srt'),
    srt.replace('Old subtitle', 'Fresh original'),
  )
  writeFileSync(join(current.directory, 'ko.srt'), srt.replace('Old subtitle', '새 자막'))
  current.resolve({ language: 'en', cueCount: 1, translated: true })
  await vi.waitFor(() =>
    expect(listSubtitleQueue().find((entry) => current.directory.endsWith(entry.id))?.phase).toBe(
      'completed',
    ),
  )
}

function holdLibrary() {
  let release!: () => void
  const done = withLibraryWork(
    root,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  return { release, done }
}

function reloadSavedQueue() {
  state.root = join(root, 'empty-user-data')
  try {
    initializeSubtitleQueue()
    expect(listSubtitleQueue()).toEqual([])
  } finally {
    state.root = root
    initializeSubtitleQueue()
  }
}

async function failedJob() {
  const job = startSubtitleGeneration(root, 'first', options)
  const current = await worker()
  writeFileSync(join(current.directory, 'checkpoint.json'), 'old completed transcript')
  current.reject(new Error('fixture worker failed'))
  await vi.waitFor(() =>
    expect(listSubtitleQueue().find((entry) => entry.id === job.id)?.phase).toBe('failed'),
  )
  return { job, current }
}

function holdTrash() {
  let finish: (() => void) | undefined
  state.trash.mockImplementationOnce(
    (path: string) =>
      new Promise<void>((resolve) => {
        finish = () => {
          unlinkSync(path)
          resolve()
        }
      }),
  )
  return async () => {
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    return finish!
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-subtitle-regenerate-test-'))
  state.root = root
  workers = []
  db = openDatabase(root, ':memory:')
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
  state.engine.mockReset().mockResolvedValue({ available: true, message: 'Ready' })
  state.trash.mockReset().mockImplementation(async (path: string) => unlinkSync(path))
  state.extract.mockReset().mockImplementation(async (_video: string, audio: string) => {
    writeFileSync(audio, 'new audio')
  })
  state.transcribe.mockReset().mockImplementation(
    (
      _audio: string,
      directory: string,
      requested: SubtitleGenerationOptions,
      signal: AbortSignal,
    ) =>
      new Promise((resolve, reject) => {
        workers.push({ directory, options: { ...requested }, reject, resolve })
        signal.addEventListener('abort', () => reject(createAbortError()), { once: true })
      }),
  )
})

afterEach(async () => {
  await shutdownSubtitleQueue()
  await drainLibraryWork()
  closeAllDatabases()
  const target = resolve(root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-subtitle-regenerate-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { force: true, recursive: true })
})

describe('subtitle regeneration', () => {
  beforeEach(() => setSubtitleConcurrency(1))

  it('regenerates separate videos concurrently and leaves a waiting replacement untouched', async () => {
    setSubtitleConcurrency(2)
    const first = external('.srt')
    const second = external('.srt', 'second')
    const third = external('.srt', 'third')
    const one = await regenerateSubtitles(root, 'first', [first.id], options)
    const two = await regenerateSubtitles(root, 'second', [second.id], options)
    const three = await regenerateSubtitles(root, 'third', [third.id], options)
    const firstWorker = await worker(0)
    const secondWorker = await worker(1)
    expect(firstWorker.directory).toContain(one.id)
    expect(secondWorker.directory).toContain(two.id)
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(false)
    expect(existsSync(third.path)).toBe(true)
    expect(job(three.id)?.phase).toBe('queued')
    await complete(secondWorker)
    const thirdWorker = await worker(2)
    expect(thirdWorker.directory).toContain(three.id)
    expect(existsSync(third.path)).toBe(false)
    await complete(firstWorker)
    await complete(thirdWorker)
  })

  it('replaces confirmed sidecars with a fresh job, drops old checkpoints, and preserves embedded tracks', async () => {
    const previous = await failedJob()
    const tracks = ['.srt', '.ai.srt', '.ai.ko.srt'].map((suffix) => external(suffix))
    const embeddedId = randomUUID()
    new SubtitleRepository(db).insert({
      id: embeddedId,
      videoId: 'first',
      filePath: source(),
      type: 'srt',
      trackIndex: 2,
      isEmbedded: true,
    })
    const requested = { model: 'tiny', language: 'en', translateToKorean: true } as const
    const next = await regenerateSubtitles(
      root,
      'first',
      tracks.map((track) => track.id),
      requested,
    )
    const fresh = await worker(1)

    expect(next.id).not.toBe(previous.job.id)
    expect(next.options).toEqual(requested)
    expect(fresh.options).toEqual(requested)
    expect(fresh.directory).not.toBe(previous.current.directory)
    expect(existsSync(previous.current.directory)).toBe(false)
    expect(existsSync(join(fresh.directory, 'checkpoint.json'))).toBe(false)
    expect(listSubtitleQueue().map((job) => job.id)).toEqual([next.id])
    expect(tracks.every((track) => !existsSync(track.path))).toBe(true)
    expect(new SubtitleRepository(db).findByVideoId('first').map((track) => track.id)).toEqual([
      embeddedId,
    ])
    expect(readFileSync(source(), 'utf8')).toBe('video fixture first')
  })

  it.each(['queued', 'running', 'paused'] as const)(
    'rejects regeneration of a %s job before deleting any subtitle',
    async (phase) => {
      if (phase === 'queued') startSubtitleGeneration(root, 'second', options)
      const job = startSubtitleGeneration(root, 'first', options)
      if (phase !== 'queued') await worker()
      if (phase === 'paused') await pauseSubtitleJob(job.id)
      const track = external('.srt')
      await expect(async () =>
        regenerateSubtitles(root, 'first', [track.id], options),
      ).rejects.toThrow()
      expect(state.trash).not.toHaveBeenCalled()
      expect(existsSync(track.path)).toBe(true)
      expect(listSubtitleQueue().some((entry) => entry.id === job.id)).toBe(true)
    },
  )

  it('preserves existing subtitles if the engine is unavailable', async () => {
    const track = external('.srt')
    state.engine.mockResolvedValueOnce({ available: false, message: 'Engine unavailable' })
    const queued = await regenerateSubtitles(root, 'first', [track.id], options)
    await vi.waitFor(() => expect(job(queued.id)?.phase).toBe('failed'))
    expect(job(queued.id)?.message).toContain('Engine unavailable')
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(track.path)).toBe(true)
    expect(listSubtitleQueue()).toHaveLength(1)
  })

  it('preserves existing subtitles in a read-only library', async () => {
    const track = external('.srt')
    db.pragma('query_only = ON')
    await expect(async () =>
      regenerateSubtitles(root, 'first', [track.id], options),
    ).rejects.toThrow('읽기 전용')
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(track.path)).toBe(true)
    expect(listSubtitleQueue()).toEqual([])
  })

  it('blocks duplicate regeneration, generation and old failed-job resume while replacement waits in the queue', async () => {
    const previous = await failedJob()
    const track = external('.srt')
    const lock = holdLibrary()
    const queued = await regenerateSubtitles(root, 'first', [track.id], options)
    try {
      expect(job(queued.id)?.phase).toBe('queued')
      expect(() => startSubtitleGeneration(root, 'first', options)).toThrow()
      expect(() => resumeSubtitleJob(previous.job.id)).toThrow()
      await expect(async () =>
        regenerateSubtitles(root, 'first', [track.id], options),
      ).rejects.toThrow()
      expect(state.trash).not.toHaveBeenCalled()
    } finally {
      lock.release()
      await lock.done
    }
    await worker(1)
    expect(listSubtitleQueue()).toHaveLength(1)
  })

  it('retains a failed partial deletion and retries only the remaining confirmed subtitle', async () => {
    const first = external('.srt')
    const second = external('.ai.ko.srt')
    state.trash
      .mockImplementationOnce(async (path: string) => unlinkSync(path))
      .mockRejectedValueOnce(new Error('Trash unavailable'))
    const queued = await regenerateSubtitles(root, 'first', [first.id, second.id], options)
    await vi.waitFor(() => expect(job(queued.id)?.phase).toBe('failed'))
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(true)
    expect(new SubtitleRepository(db).findByVideoId('first').map((track) => track.id)).toEqual([
      second.id,
    ])
    expect(listSubtitleQueue()).toHaveLength(1)
    expect(state.extract).not.toHaveBeenCalled()
    expect(resumeSubtitleJob(queued.id)).toBe(true)
    await worker()
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([
      first.path,
      second.path,
      second.path,
    ])
    expect(new SubtitleRepository(db).findByVideoId('first')).toEqual([])
    expect(existsSync(second.path)).toBe(false)
  })

  it('waits for in-flight trash during shutdown and restores a paused replacement without trashing twice', async () => {
    const track = external('.srt')
    const finish = holdTrash()
    const queued = await regenerateSubtitles(root, 'first', [track.id], options)
    const release = await finish()
    let exited = false
    const shutdown = shutdownSubtitleQueue().then(() => {
      exited = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(exited).toBe(false)
    } finally {
      release()
      await shutdown
    }
    expect(job(queued.id)?.phase).toBe('paused')
    expect(state.extract).not.toHaveBeenCalled()
    reloadSavedQueue()
    expect(job(queued.id)?.phase).toBe('paused')
    expect(resumeSubtitleJob(queued.id)).toBe(true)
    await worker()
    expect(state.trash).toHaveBeenCalledTimes(1)
    expect(existsSync(track.path)).toBe(false)
  })

  it('queues during unrelated library work and keeps originals until the library becomes idle', async () => {
    const track = external('.srt')
    const lock = holdLibrary()
    let queued
    try {
      queued = await regenerateSubtitles(root, 'first', [track.id], options)
      expect(queued.phase).toBe('queued')
      expect(job(queued.id)?.phase).toBe('queued')
      expect(existsSync(track.path)).toBe(true)
      expect(new SubtitleRepository(db).findByVideoId('first')).toHaveLength(1)
      expect(state.engine).not.toHaveBeenCalled()
      expect(state.trash).not.toHaveBeenCalled()
    } finally {
      lock.release()
      await lock.done
    }
    const current = await worker()
    expect(current.directory).toContain(queued!.id)
    expect(existsSync(track.path)).toBe(false)
  })

  it('runs two replacements in FIFO order behind a running subtitle job from the same library', async () => {
    const active = startSubtitleGeneration(root, 'third', options)
    const activeWorker = await worker()
    const first = external('.srt')
    const second = external('.srt', 'second')
    const one = await regenerateSubtitles(root, 'first', [first.id], options)
    const two = await regenerateSubtitles(root, 'second', [second.id], options)
    expect([job(one.id)?.phase, job(two.id)?.phase]).toEqual(['queued', 'queued'])
    expect(state.trash).not.toHaveBeenCalled()
    await complete(activeWorker)
    expect(job(active.id)?.phase).toBe('completed')
    const firstWorker = await worker(1)
    expect(firstWorker.directory).toContain(one.id)
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(true)
    await complete(firstWorker)
    const secondWorker = await worker(2)
    expect(secondWorker.directory).toContain(two.id)
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([first.path, second.path])
  })

  it('can pause and remove waiting replacements without deleting their subtitles', async () => {
    startSubtitleGeneration(root, 'third', options)
    await worker()
    const first = external('.srt')
    const second = external('.srt', 'second')
    const one = await regenerateSubtitles(root, 'first', [first.id], options)
    const two = await regenerateSubtitles(root, 'second', [second.id], options)
    expect(await pauseSubtitleJob(one.id)).toBe(true)
    expect(await removeSubtitleJob(two.id)).toBe(true)
    expect(job(one.id)?.phase).toBe('paused')
    expect(job(two.id)).toBeUndefined()
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(first.path)).toBe(true)
    expect(existsSync(second.path)).toBe(true)
  })

  it('persists a waiting replacement and resumes its original deletion selection after restart', async () => {
    startSubtitleGeneration(root, 'second', options)
    await worker()
    const track = external('.srt')
    const queued = await regenerateSubtitles(root, 'first', [track.id], options)
    await shutdownSubtitleQueue()
    expect(existsSync(track.path)).toBe(true)
    expect(state.trash).not.toHaveBeenCalled()
    reloadSavedQueue()
    expect(job(queued.id)?.phase).toBe('paused')
    expect(resumeSubtitleJob(queued.id)).toBe(true)
    const resumed = await worker(1)
    expect(resumed.directory).toContain(queued.id)
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([track.path])
  })

  it('preserves a selected subtitle replaced on disk while its regeneration was queued', async () => {
    const track = external('.srt')
    const lock = holdLibrary()
    let queued
    try {
      queued = await regenerateSubtitles(root, 'first', [track.id], options)
      writeFileSync(track.path, 'New user edits after regeneration was queued')
    } finally {
      lock.release()
      await lock.done
    }
    await vi.waitFor(() => expect(job(queued!.id)?.phase).toBe('failed'))
    expect(state.trash).not.toHaveBeenCalled()
    expect(readFileSync(track.path, 'utf8')).toBe('New user edits after regeneration was queued')
  })
})
