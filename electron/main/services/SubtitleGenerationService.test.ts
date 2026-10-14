import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

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
import {
  cancelSubtitleGeneration,
  getSubtitleGenerationStatus,
  publishGeneratedSubtitles,
  startSubtitleGeneration,
  shutdownSubtitleQueue,
  regenerateSubtitles,
  pauseSubtitleJob,
  resumeSubtitleJob,
} from './SubtitleGenerationService'
import { drainLibraryWork, isLibraryBusy } from './LibraryWorkService'
import { setSubtitleEnvironmentInstalling } from './SubtitleEnvironmentLock'
import { createAbortError } from '../ffmpeg/queue'
import { IPC, IPC_SCHEMAS } from '@shared/ipc'

const options = { model: 'base', language: 'auto', translateToKorean: true } as const
const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello\n'
let db: ReturnType<typeof openDatabase>
let videoPath: string
let libraryId: string
let output: string

beforeEach(() => {
  setSubtitleEnvironmentInstalling(false)
  state.root = mkdtempSync(join(tmpdir(), 'dvm-subtitle-test-'))
  libraryId = state.root
  videoPath = join(state.root, "영상 ' & $ test.mp4")
  writeFileSync(videoPath, 'video fixture')
  output = join(state.root, 'staging')
  mkdirSync(output)
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  new VideoRepository(db).insert({
    id: 'video',
    fileName: "영상 ' & $ test.mp4",
    filePath: videoPath,
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
  state.extract.mockReset().mockResolvedValue(undefined)
  state.transcribe.mockReset().mockImplementation(async (_audio, directory: string) => {
    writeFileSync(join(directory, 'original.srt'), srt)
    writeFileSync(join(directory, 'ko.srt'), srt.replace('Hello', '안녕하세요'))
    return { language: 'en', cueCount: 1, translated: true }
  })
})

afterEach(async () => {
  setSubtitleEnvironmentInstalling(false)
  await shutdownSubtitleQueue()
  await drainLibraryWork()
  closeAllDatabases()
  const target = resolve(state.root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-subtitle-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { force: true, recursive: true })
})

async function waitForTerminal() {
  await vi.waitFor(() =>
    expect(['completed', 'failed', 'cancelled']).toContain(
      getSubtitleGenerationStatus(libraryId, 'video')?.phase,
    ),
  )
  return getSubtitleGenerationStatus(libraryId, 'video')!
}

describe('subtitle generation', () => {
  it('blocks new generation during environment installation and permits it afterward', async () => {
    setSubtitleEnvironmentInstalling(true)
    expect(() => startSubtitleGeneration(libraryId, 'video', options)).toThrow('환경 설치')
    expect(getSubtitleGenerationStatus(libraryId, 'video')).toBeNull()
    expect(state.extract).not.toHaveBeenCalled()
    expect(isLibraryBusy(libraryId)).toBe(false)
    setSubtitleEnvironmentInstalling(false)
    startSubtitleGeneration(libraryId, 'video', options)
    expect((await waitForTerminal()).phase).toBe('completed')
  })

  it('blocks regeneration during installation without changing existing subtitles', async () => {
    const original = videoPath.replace(/\.mp4$/, '.srt')
    writeFileSync(original, srt)
    new SubtitleRepository(db).insert({
      id: 'existing',
      videoId: 'video',
      filePath: original,
      type: 'srt',
      isEmbedded: false,
    })
    setSubtitleEnvironmentInstalling(true)
    await expect(regenerateSubtitles(libraryId, 'video', ['existing'], options)).rejects.toThrow(
      '환경 설치',
    )
    expect(readFileSync(original, 'utf8')).toBe(srt)
    expect(new SubtitleRepository(db).findByVideoId('video')).toMatchObject([{ id: 'existing' }])
    expect(getSubtitleGenerationStatus(libraryId, 'video')).toBeNull()
    expect(state.extract).not.toHaveBeenCalled()
  })

  it('keeps paused jobs intact when resume is attempted during installation', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    state.extract.mockImplementation(async (_video, _audio, _duration, signal: AbortSignal) => {
      entered()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(createAbortError()), { once: true }),
      )
    })
    const initial = startSubtitleGeneration(libraryId, 'video', options)
    await started
    expect(await pauseSubtitleJob(initial.id)).toBe(true)
    setSubtitleEnvironmentInstalling(true)
    expect(() => resumeSubtitleJob(initial.id)).toThrow('환경 설치')
    expect(getSubtitleGenerationStatus(libraryId, 'video')?.phase).toBe('paused')
    expect(state.extract).toHaveBeenCalledOnce()
    expect(state.transcribe).not.toHaveBeenCalled()
    setSubtitleEnvironmentInstalling(false)
    state.extract.mockResolvedValue(undefined)
    expect(resumeSubtitleJob(initial.id)).toBe(true)
    expect((await waitForTerminal()).phase).toBe('completed')
  })

  it('publishes original and Korean sidecars, marks the video, and releases work after cleanup', async () => {
    const initial = startSubtitleGeneration(libraryId, 'video', options)
    expect(initial.phase).toBe('preparing')
    expect(isLibraryBusy(libraryId)).toBe(true)
    expect(() => startSubtitleGeneration(libraryId, 'video', options)).toThrow('다른 작업')
    const job = await waitForTerminal()
    expect(job.phase).toBe('completed')
    expect(job.outputPaths).toHaveLength(2)
    expect(readFileSync(job.outputPaths![1], 'utf8')).toContain('안녕하세요')
    expect(
      new SubtitleRepository(db)
        .findByVideoId('video')
        .map((sub) => sub.lang)
        .sort(),
    ).toEqual(['en', 'ko'])
    expect(new VideoRepository(db).findById('video')?.hasSubtitles).toBe(true)
    expect(readdirSync(join(state.root, 'subtitle-jobs'))).toEqual([])
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect(cancelSubtitleGeneration(libraryId, 'video')).toBe(false)
  })

  it('never overwrites existing files and skips output names belonging to another video', async () => {
    const base = videoPath.replace(/\.mp4$/, '')
    writeFileSync(base + '.ai.srt', 'user original')
    writeFileSync(base + '.ai.2.ko.srt', 'user translation')
    writeFileSync(base + '.ai.3.mp4', 'neighbor video')
    startSubtitleGeneration(libraryId, 'video', options)
    const job = await waitForTerminal()
    expect(job.outputPaths).toEqual([base + '.ai.4.srt', base + '.ai.4.ko.srt'])
    expect(readFileSync(base + '.ai.srt', 'utf8')).toBe('user original')
    expect(readFileSync(base + '.ai.2.ko.srt', 'utf8')).toBe('user translation')
  })

  it('cancels only the requested video and waits for the worker before deleting staging', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    state.transcribe.mockImplementation(
      async (_audio, directory: string, _options, signal: AbortSignal) => {
        writeFileSync(join(directory, 'partial.srt'), srt)
        entered()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                expect(existsSync(directory)).toBe(true)
                reject(createAbortError())
              }, 20)
            },
            { once: true },
          )
        })
      },
    )
    startSubtitleGeneration(libraryId, 'video', options)
    await started
    expect(cancelSubtitleGeneration(libraryId, 'different-video')).toBe(false)
    expect(cancelSubtitleGeneration(libraryId, 'video')).toBe(true)
    expect(isLibraryBusy(libraryId)).toBe(true)
    const job = await waitForTerminal()
    expect(job.phase).toBe('cancelled')
    expect(new SubtitleRepository(db).findByVideoId('video')).toEqual([])
    expect(readdirSync(join(state.root, 'subtitle-jobs'))).toEqual([])
  })

  it('drains cancellation before shutdown releases the database', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    state.extract.mockImplementation(async (_video, _audio, _duration, signal: AbortSignal) => {
      entered()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(createAbortError()), { once: true }),
      )
    })
    startSubtitleGeneration(libraryId, 'video', options)
    await started
    await drainLibraryWork()
    expect(isLibraryBusy(libraryId)).toBe(false)
    expect((await waitForTerminal()).phase).toBe('cancelled')
  })

  it('preserves existing metadata and outputs when translation fails', async () => {
    const original = videoPath.replace(/\.mp4$/, '.srt')
    writeFileSync(original, srt)
    new SubtitleRepository(db).insert({
      id: 'existing',
      videoId: 'video',
      filePath: original,
      type: 'srt',
      isEmbedded: false,
    })
    state.transcribe.mockRejectedValue(new Error('번역 서버 연결 실패'))
    startSubtitleGeneration(libraryId, 'video', options)
    expect((await waitForTerminal()).message).toContain('번역 서버 연결 실패')
    expect(new SubtitleRepository(db).findByVideoId('video')).toMatchObject([{ id: 'existing' }])
    expect(readFileSync(original, 'utf8')).toBe(srt)
    expect(readdirSync(join(state.root, 'subtitle-jobs'))).toHaveLength(1)
  })

  it('rolls back new sidecars if the database transaction fails', () => {
    writeFileSync(join(output, 'original.srt'), srt)
    writeFileSync(join(output, 'ko.srt'), srt)
    db.pragma('query_only = ON')
    expect(() =>
      publishGeneratedSubtitles(libraryId, 'video', videoPath, output, 'en', true),
    ).toThrow()
    expect(readdirSync(state.root).filter((name) => name.endsWith('.srt'))).toEqual([])
  })

  it('publishes a usable original with an explicit failure when only Korean translation fails', async () => {
    const oldKorean = videoPath.replace(/\.mp4$/, '.ai.ko.srt')
    writeFileSync(oldKorean, 'existing Korean track')
    state.transcribe.mockImplementation(async (_audio, directory: string) => {
      writeFileSync(join(directory, 'original.srt'), srt)
      return {
        language: 'en',
        cueCount: 1,
        translated: false,
        translationError: '번역 요청 제한 (HTTP 429)',
      }
    })
    startSubtitleGeneration(libraryId, 'video', options)
    const job = await waitForTerminal()
    expect(job.phase).toBe('failed')
    expect(job.message).toContain('원어 자막은 저장했습니다')
    expect(job.outputPaths).toHaveLength(1)
    expect(job.outputPaths![0]).toBe(videoPath.replace(/\.mp4$/, '.ai.2.srt'))
    expect(readFileSync(oldKorean, 'utf8')).toBe('existing Korean track')
    expect(readFileSync(job.outputPaths![0], 'utf8')).toBe(srt)
    expect(new SubtitleRepository(db).findByVideoId('video')).toMatchObject([{ lang: 'en' }])
  })

  it('rejects missing, removed, read-only videos and invalid worker output before publication', () => {
    expect(() => startSubtitleGeneration(libraryId, 'missing', options)).toThrow('영상')
    db.prepare('UPDATE videos SET removal_mode = ? WHERE id = ?').run('remove', 'video')
    expect(() => startSubtitleGeneration(libraryId, 'video', options)).toThrow('영상')
    db.prepare('UPDATE videos SET removal_mode = NULL').run()
    db.pragma('query_only = ON')
    expect(() => startSubtitleGeneration(libraryId, 'video', options)).toThrow('읽기 전용')
    db.pragma('query_only = OFF')
    writeFileSync(join(output, 'original.srt'), 'bad content')
    expect(() =>
      publishGeneratedSubtitles(libraryId, 'video', videoPath, output, 'en', false),
    ).toThrow('타임코드')
    expect(state.extract).not.toHaveBeenCalled()
  })

  it('validates IPC options and disallows paths or arbitrary model arguments', () => {
    const schema = IPC_SCHEMAS[IPC.SUBTITLES.GENERATE]
    expect(schema.safeParse(['lib', 'video', options]).success).toBe(true)
    for (const patch of [
      { model: '../../model' },
      { language: '--help' },
      { translateToKorean: 'true' },
      { filePath: 'C:/other.mp4' },
    ])
      expect(schema.safeParse(['lib', 'video', { ...options, ...patch }]).success).toBe(false)
  })
})
