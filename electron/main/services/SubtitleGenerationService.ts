import {
  constants,
  accessSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { Subtitle, SubtitleGenerationJob, SubtitleGenerationOptions } from '@shared/types'
import { SubtitleGenerationOptionsZ } from '@shared/ipc'
import { DEFAULT_SUBTITLE_CONCURRENCY, SubtitleConcurrencyZ } from '@shared/subtitleQueue'
import { SubtitleQueueStorageError, writeSubtitleQueueSnapshot } from './SubtitleQueueStorage'
import { assertSubtitleEnvironmentIdle } from './SubtitleEnvironmentLock'
import { getDatabase, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { getUserDataPath } from '../infra/paths'
import { loadConfig } from '../infra/config'
import { createLogger } from '../infra/logger'
import { isAbortError } from '../ffmpeg/queue'
import { isLibraryWorkBlocked, throwIfWorkCancelled, withLibraryWork } from './LibraryWorkService'
import {
  extractSubtitleAudio,
  getSubtitleEngineInfo,
  transcribeSubtitleAudio,
} from './SubtitleRuntime'
import {
  executeSubtitleDeletion,
  prepareSubtitleDeletion,
  SubtitleDeletionPlanZ,
  type SubtitleDeletionPlan,
} from './SubtitleDeletionService'

const log = createLogger('SubtitleGeneration')
interface QueueEntry {
  job: SubtitleGenerationJob
  videoPath: string
  sourceSize: number
  sourceMtime: number
  audioReady: boolean
  publishing?: string[]
  replacement?: SubtitleDeletionPlan
}
interface ActiveJob {
  entry: QueueEntry
  controller: AbortController
  action?: 'pause' | 'remove' | 'cancel'
  done: Promise<void>
}
const entries = new Map<string, QueueEntry>()
const listeners = new Set<() => void>()
const active = new Map<string, ActiveJob>()
let maxConcurrentJobs = DEFAULT_SUBTITLE_CONCURRENCY
let retryTimer: ReturnType<typeof setTimeout> | undefined
let storageFile: string | undefined
let stopping = false
let storageFailure: SubtitleQueueStorageError | undefined
const terminalPhases = new Set(['completed', 'cancelled', 'failed'])
const QueueFileZ = z.object({
  version: z.literal(1),
  maxConcurrentJobs: SubtitleConcurrencyZ.default(DEFAULT_SUBTITLE_CONCURRENCY),
  entries: z
    .array(
      z.object({
        job: z.object({
          id: z.string().uuid(),
          libraryId: z.string().min(1),
          videoId: z.string().min(1),
          title: z.string(),
          options: SubtitleGenerationOptionsZ,
          createdAt: z.string().datetime(),
          phase: z.enum([
            'queued',
            'pausing',
            'paused',
            'removing',
            'preparing',
            'loading',
            'transcribing',
            'translating',
            'saving',
            'completed',
            'cancelled',
            'failed',
          ]),
          percent: z.number().finite().min(0).max(100),
          message: z.string(),
          outputPaths: z.array(z.string()).optional(),
          storageError: z.string().optional(),
          processing: z
            .object({
              asr: z.enum(['unconfirmed', 'vulkan', 'cpu-legacy']),
              device: z.string().max(100).optional(),
              evidence: z.enum(['engine', 'checkpoint']).optional(),
              translation: z.enum(['cloud', 'ollama', 'original-ko']).optional(),
            })
            .optional(),
        }),
        videoPath: z.string().min(1),
        sourceSize: z.number().nonnegative(),
        sourceMtime: z.number().finite(),
        audioReady: z.boolean(),
        publishing: z.array(z.string()).min(1).max(2).optional(),
        replacement: SubtitleDeletionPlanZ.optional(),
      }),
    )
    .max(1000),
})

function snapshot(job: SubtitleGenerationJob): SubtitleGenerationJob {
  return {
    ...job,
    options: { ...job.options },
    ...(job.processing ? { processing: { ...job.processing } } : {}),
    ...(job.outputPaths ? { outputPaths: [...job.outputPaths] } : {}),
  }
}

function persist(): void {
  if (!storageFile) return
  writeSubtitleQueueSnapshot(storageFile, {
    version: 1,
    maxConcurrentJobs,
    entries: [...entries.values()],
  })
}

function blockForStorage(error: SubtitleQueueStorageError): void {
  storageFailure = error
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
  for (const { job } of entries.values()) {
    job.storageError = error.message
    if (!terminalPhases.has(job.phase)) {
      job.phase = 'paused'
      job.message =
        '대기열 저장 실패로 일시정지했습니다. 진행 내용은 보관하며 자동으로 재시도하지 않습니다.'
    }
  }
  for (const running of active.values()) running.controller.abort()
}

function changed(save = true): void {
  let failure: SubtitleQueueStorageError | undefined
  if (save) {
    try {
      persist()
    } catch (error) {
      failure =
        error instanceof SubtitleQueueStorageError
          ? error
          : new SubtitleQueueStorageError(storageFile ?? 'subtitle-queue.json', error)
      blockForStorage(failure)
    }
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      log.warn({ err: error }, '자막 큐 상태 알림 실패')
    }
  }
  if (failure) throw failure
}

function retryStorage(): void {
  if (active.size)
    throw new Error('자막 작업을 정리하고 있습니다. 잠시 후 저장 다시 시도를 눌러 주세요.')
  for (const { job } of entries.values()) delete job.storageError
  changed()
  storageFailure = undefined
}

function removeQueueEntry(entry: QueueEntry): void {
  entries.delete(entry.job.id)
  try {
    changed()
  } catch (error) {
    // Keep a visible retry control even when the last entry could not be removed durably.
    entry.job.phase = 'cancelled'
    entry.job.message = '작업을 중지했습니다. 대기열에서 삭제한 상태는 아직 저장하지 못했습니다.'
    entries.set(entry.job.id, entry)
    blockForStorage(error as SubtitleQueueStorageError)
    changed(false)
    throw error
  }
}

function directoryFor(entry: QueueEntry): string {
  // IDs are generated here and UUID-validated when restoring; paths are never loaded from disk.
  return getUserDataPath('subtitle-jobs', 'queue-' + entry.job.id)
}

function cleanup(entry: QueueEntry): void {
  const root = getUserDataPath('subtitle-jobs')
  const target = directoryFor(entry)
  if (!/^queue-[a-f0-9-]{36}$/i.test(relative(root, target)))
    throw new Error('자막 임시 경로가 올바르지 않습니다.')
  rmSync(target, { recursive: true, force: true })
  entry.audioReady = false
}

export function initializeSubtitleQueue(): void {
  const file = getUserDataPath('subtitle-queue.json')
  if (storageFile === file) return
  if (active.size) throw new Error('진행 중인 자막 작업이 있습니다.')
  let restored: QueueEntry[] = []
  let restoredConcurrency = DEFAULT_SUBTITLE_CONCURRENCY
  if (existsSync(file)) {
    try {
      const saved = QueueFileZ.parse(JSON.parse(readFileSync(file, 'utf8')))
      restored = saved.entries
      restoredConcurrency = saved.maxConcurrentJobs
      if (new Set(restored.map((item) => item.job.id)).size !== restored.length)
        throw new Error('작업 ID 중복')
    } catch (error) {
      throw new Error('자막 대기열 파일을 읽을 수 없습니다. 기존 파일은 보존했습니다: ' + file, {
        cause: error,
      })
    }
  }
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
  entries.clear()
  maxConcurrentJobs = restoredConcurrency
  storageFile = file
  stopping = false
  storageFailure = undefined
  for (const entry of restored) {
    if (entry.job.processing?.evidence) entry.job.processing.evidence = 'checkpoint'
    if (entry.job.phase === 'removing') {
      cleanup(entry)
      continue
    }
    if (!terminalPhases.has(entry.job.phase)) {
      entry.job.phase = 'paused'
      entry.job.message = '저장된 작업입니다. 재개하면 이어서 처리합니다.'
    }
    entries.set(entry.job.id, entry)
  }
  if (restored.length) {
    try {
      changed()
    } catch (error) {
      log.warn({ err: error }, '저장된 자막 대기열 상태 저장 실패')
    }
  }
}

export function onSubtitleQueueChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function listSubtitleQueue(): SubtitleGenerationJob[] {
  initializeSubtitleQueue()
  return [...entries.values()].map(({ job }) => snapshot(job))
}

export function getSubtitleConcurrency(): number {
  initializeSubtitleQueue()
  return maxConcurrentJobs
}

export function setSubtitleConcurrency(value: number): number {
  const limit = SubtitleConcurrencyZ.parse(value)
  initializeSubtitleQueue()
  if (stopping) throw new Error('앱을 종료하고 있습니다.')
  if (storageFailure && entries.size === 0) retryStorage()
  if (storageFailure) throw storageFailure
  const previous = maxConcurrentJobs
  maxConcurrentJobs = limit
  try {
    changed()
  } catch (error) {
    maxConcurrentJobs = previous
    throw error
  }
  // Lowering the limit lets existing workers finish before admitting more jobs.
  pump()
  return maxConcurrentJobs
}

export function hasPendingSubtitleJobs(): boolean {
  return [...entries.values()].some(({ job }) => !terminalPhases.has(job.phase))
}

export function getSubtitleGenerationStatus(
  libraryId: string,
  videoId: string,
): SubtitleGenerationJob | null {
  initializeSubtitleQueue()
  const found = [...entries.values()]
    .reverse()
    .find(({ job }) => job.libraryId === libraryId && job.videoId === videoId)
  return found ? snapshot(found.job) : null
}

export function cancelSubtitleGeneration(libraryId: string, videoId: string): boolean {
  initializeSubtitleQueue()
  const entry = [...entries.values()].find(
    ({ job }) =>
      job.libraryId === libraryId && job.videoId === videoId && !terminalPhases.has(job.phase),
  )
  if (!entry) return false
  if (storageFailure) retryStorage()
  const running = active.get(entry.job.id)
  if (running) {
    running.action = 'cancel'
    running.controller.abort()
  } else {
    entry.job.phase = 'cancelled'
    entry.job.message = '자막 생성을 취소했습니다.'
    changed()
    cleanup(entry)
  }
  return true
}

function validateOutput(path: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024)
    throw new Error('생성된 자막 파일의 크기가 올바르지 않습니다.')
  if (!/\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}/.test(readFileSync(path, 'utf8')))
    throw new Error('생성된 자막에 유효한 타임코드가 없습니다.')
}

/** Publish both files without ever replacing an existing sidecar. DB failure rolls them back. */
export function publishGeneratedSubtitles(
  libraryId: string,
  videoId: string,
  videoPath: string,
  outputDir: string,
  language: string,
  translated: boolean,
  publishedOriginal?: string,
  beforePublish?: (paths: string[]) => void,
): string[] {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다.')
  const original = join(outputDir, 'original.srt')
  const korean = join(outputDir, 'ko.srt')
  validateOutput(original)
  if (translated) validateOutput(korean)
  const directory = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath))
  // Exact video stems take priority during discovery, including files added during a pause.
  const otherStems = new Set(
    readdirSync(directory)
      .filter((name) => !['.srt', '.vtt', '.ass', '.smi'].includes(extname(name).toLowerCase()))
      .map((name) => basename(name, extname(name)).toLowerCase()),
  )
  // Reuse this job's unchanged original when retrying only a failed translation.
  const repository = new SubtitleRepository(db)
  if (
    publishedOriginal &&
    dirname(publishedOriginal) === directory &&
    /\.ai(?:\.[1-9]\d*)?\.srt$/i.test(publishedOriginal) &&
    existsSync(publishedOriginal) &&
    repository.findByVideoId(videoId).some((sub) => sub.filePath === publishedOriginal) &&
    readFileSync(publishedOriginal).equals(readFileSync(original))
  ) {
    if (!translated) return [publishedOriginal]
    const koreanPath = publishedOriginal.replace(/\.srt$/i, '.ko.srt')
    if (!existsSync(koreanPath) && !otherStems.has(basename(koreanPath, '.srt').toLowerCase())) {
      beforePublish?.([publishedOriginal, koreanPath])
      copyFileSync(korean, koreanPath, constants.COPYFILE_EXCL)
      try {
        repository.insert({
          id: randomUUID(),
          videoId,
          filePath: koreanPath,
          type: 'srt',
          lang: 'ko',
          encoding: 'UTF-8',
          isEmbedded: false,
        })
        return [publishedOriginal, koreanPath]
      } catch (error) {
        unlinkSync(koreanPath)
        throw error
      }
    }
    if (
      existsSync(koreanPath) &&
      repository.findByVideoId(videoId).some((sub) => sub.filePath === koreanPath) &&
      readFileSync(koreanPath).equals(readFileSync(korean))
    )
      return [publishedOriginal, koreanPath]
  }
  for (let number = 1; number <= 10_000; number++) {
    const base = `${stem}.ai${number === 1 ? '' : '.' + number}`
    const pair = [join(directory, base + '.srt'), join(directory, base + '.ko.srt')]
    const paths = translated ? pair : [pair[0]]
    if (
      otherStems.has(base.toLowerCase()) ||
      otherStems.has((base + '.ko').toLowerCase()) ||
      pair.some(existsSync)
    )
      continue
    const created: string[] = []
    try {
      beforePublish?.(paths)
      paths.forEach((path, index) => {
        copyFileSync(index === 0 ? original : korean, path, constants.COPYFILE_EXCL)
        created.push(path)
      })
      db.transaction(() => {
        const repository = new SubtitleRepository(db)
        paths.forEach((filePath, index) => {
          const subtitle: Subtitle = {
            id: randomUUID(),
            videoId,
            filePath,
            type: 'srt',
            lang: index === 0 ? language : 'ko',
            encoding: 'UTF-8',
            isEmbedded: false,
          }
          repository.insert(subtitle)
        })
      })()
      return paths
    } catch (error) {
      for (const path of created) {
        try {
          unlinkSync(path)
        } catch (cleanupError) {
          log.warn({ err: cleanupError, path }, '생성 자막 정리 실패')
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('자막을 저장할 빈 파일 이름을 찾을 수 없습니다.')
}

function writableVideo(libraryId: string, videoId: string, reopen = false) {
  let db = getDatabase(libraryId)
  if (!db && reopen) {
    const library = loadConfig().libraries.find((item) => item.id === libraryId)
    if (library) {
      db = openDatabase(libraryId, library.dbPath)
      runMigrations(db, library.dbPath)
    }
  }
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다.')
  if (db.readonly || db.pragma('query_only', { simple: true }))
    throw new Error('읽기 전용 라이브러리에는 자막을 추가할 수 없습니다.')
  const video = new VideoRepository(db).findById(videoId)
  if (!video || video.removalMode) throw new Error('자막을 생성할 영상을 찾을 수 없습니다.')
  const source = statSync(video.filePath)
  if (!source.isFile()) throw new Error('영상 파일에 접근할 수 없습니다.')
  accessSync(dirname(video.filePath), constants.W_OK)
  return { video, source }
}

export function startSubtitleGeneration(
  libraryId: string,
  videoId: string,
  input: SubtitleGenerationOptions,
): SubtitleGenerationJob {
  return enqueueSubtitleGeneration(libraryId, videoId, input)
}

function enqueueSubtitleGeneration(
  libraryId: string,
  videoId: string,
  input: SubtitleGenerationOptions,
  replacementIds?: string[],
): SubtitleGenerationJob {
  assertSubtitleEnvironmentIdle()
  initializeSubtitleQueue()
  if (stopping) throw new Error('앱을 종료하고 있습니다.')
  if (storageFailure && entries.size === 0) retryStorage()
  if (storageFailure) throw storageFailure
  const options = SubtitleGenerationOptionsZ.parse(input)
  if (
    [...entries.values()].some(
      ({ job }) =>
        job.libraryId === libraryId && job.videoId === videoId && !terminalPhases.has(job.phase),
    )
  )
    throw new Error(
      '이 영상의 자막 작업이 이미 대기열에 있습니다. 다른 작업을 추가하거나 기존 작업을 관리하세요.',
    )
  const { video, source } = writableVideo(libraryId, videoId)
  // Capture the confirmed files now; queue admission never moves or deletes them.
  const replacement = replacementIds
    ? prepareSubtitleDeletion(libraryId, videoId, replacementIds)
    : undefined
  // Keep all unfinished tasks, but bound the history and total queue size.
  const previousEntries = [...entries]
  const retired: QueueEntry[] = []
  for (const [id, entry] of entries) {
    if (entries.size < 100) break
    if (terminalPhases.has(entry.job.phase)) {
      retired.push(entry)
      entries.delete(id)
    }
  }
  if (entries.size >= 500)
    throw new Error('자막 대기열이 가득 찼습니다. 작업을 완료하거나 삭제해 주세요.')
  const entry: QueueEntry = {
    job: {
      id: randomUUID(),
      libraryId,
      videoId,
      title: video.title || video.fileName,
      options,
      createdAt: new Date().toISOString(),
      phase: 'queued',
      percent: 0,
      processing: { asr: 'unconfirmed' },
      message: replacement
        ? '자막 재생성 대기 중입니다. 차례가 오면 기존 자막을 휴지통으로 이동합니다.'
        : '자막 생성 대기 중입니다.',
    },
    videoPath: video.filePath,
    sourceSize: source.size,
    sourceMtime: source.mtimeMs,
    audioReady: false,
    ...(replacement ? { replacement } : {}),
  }
  entries.set(entry.job.id, entry)
  try {
    changed()
  } catch (error) {
    entries.clear()
    for (const [id, previous] of previousEntries) entries.set(id, previous)
    blockForStorage(error as SubtitleQueueStorageError)
    changed(false)
    throw error
  }
  for (const previous of retired) {
    try {
      cleanup(previous)
    } catch (error) {
      log.warn({ err: error, jobId: previous.job.id }, '이전 자막 작업 임시 파일 정리 실패')
    }
  }
  pump()
  return snapshot(entry.job)
}

/** Regeneration shares the bounded FIFO queue; selected sidecars stay intact while waiting. */
export async function regenerateSubtitles(
  libraryId: string,
  videoId: string,
  subtitleIds: string[],
  input: SubtitleGenerationOptions,
): Promise<SubtitleGenerationJob> {
  return enqueueSubtitleGeneration(libraryId, videoId, input, subtitleIds)
}

function pump(): void {
  if (stopping || storageFailure) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
  while (!stopping && !storageFailure && active.size < maxConcurrentJobs) {
    const pending = [...entries.values()].filter(({ job }) => job.phase === 'queued')
    const entry = pending.find(
      ({ job }) => !isLibraryWorkBlocked(job.libraryId, 'subtitles', job.videoId),
    )
    if (!entry) {
      if (pending.length) {
        retryTimer = setTimeout(pump, 500)
        retryTimer.unref()
      }
      return
    }
    const running: ActiveJob = { entry, controller: new AbortController(), done: Promise.resolve() }
    active.set(entry.job.id, running)
    entry.job.phase = 'preparing'
    entry.job.message = entry.audioReady
      ? '저장한 작업을 다시 준비하고 있습니다.'
      : '음성을 추출하고 있습니다.'
    running.done = execute(running)
  }
}

async function execute(running: ActiveJob): Promise<void> {
  const { entry, controller } = running
  const job = entry.job
  const signal = controller.signal
  const update = (patch: Partial<SubtitleGenerationJob>) => {
    if (running.action || signal.aborted || storageFailure) return
    const phaseChanged = patch.phase !== undefined && patch.phase !== job.phase
    const processingChanged =
      patch.processing !== undefined &&
      JSON.stringify(patch.processing) !== JSON.stringify(job.processing)
    Object.assign(job, patch)
    changed(phaseChanged || processingChanged)
  }
  try {
    changed()
    await withLibraryWork(
      job.libraryId,
      async (librarySignal) => {
        const abort = () => {
          running.action ??= 'cancel'
          controller.abort()
        }
        librarySignal.addEventListener('abort', abort, { once: true })
        try {
          throwIfWorkCancelled(signal)
          const { video, source } = writableVideo(job.libraryId, job.videoId, true)
          if (
            video.filePath !== entry.videoPath ||
            source.size !== entry.sourceSize ||
            source.mtimeMs !== entry.sourceMtime
          )
            throw new Error(
              '작업을 추가한 뒤 원본 영상이 변경되었습니다. 작업을 삭제하고 다시 추가하세요.',
            )
          if (entry.replacement) {
            const plan = entry.replacement
            const pendingDeletion = plan.targets.some(
              (target) => !plan.completedIds.includes(target.id),
            )
            if (pendingDeletion) {
              update({
                phase: 'preparing',
                percent: 0,
                message: '재생성 환경을 확인하고 있습니다.',
              })
              const engine = await getSubtitleEngineInfo()
              throwIfWorkCancelled(signal)
              if (!engine.available) throw new Error(engine.message)
              // Superseded failed jobs must not republish an old transcription later.
              const superseded = [...entries.values()].filter(
                (previous) =>
                  previous.job.id !== job.id &&
                  previous.job.libraryId === job.libraryId &&
                  previous.job.videoId === job.videoId,
              )
              for (const previous of superseded) previous.job.phase = 'removing'
              changed()
              for (const previous of superseded) {
                cleanup(previous)
                removeQueueEntry(previous)
              }
              update({
                phase: 'preparing',
                percent: 0,
                message: '기존 자막을 휴지통으로 이동하고 있습니다.',
              })
              await executeSubtitleDeletion(job.libraryId, job.videoId, plan, signal, () =>
                changed(),
              )
              throwIfWorkCancelled(signal)
            }
          }
          const temporary = directoryFor(entry)
          mkdirSync(temporary, { recursive: true })
          const audio = join(temporary, 'audio.wav')
          if (!entry.audioReady || !existsSync(audio)) {
            // A paused extraction may leave an incomplete WAV; only that file is replaced.
            if (existsSync(audio)) unlinkSync(audio)
            entry.audioReady = false
            update({ phase: 'preparing', percent: 0, message: '음성을 추출하고 있습니다.' })
            await extractSubtitleAudio(video.filePath, audio, video.durationSec, signal, update)
            throwIfWorkCancelled(signal)
            entry.audioReady = true
            changed()
          }
          throwIfWorkCancelled(signal)
          update({
            phase: 'loading',
            percent: 0,
            message: '음성 인식 모델과 저장된 진행 내용을 불러옵니다.',
          })
          const result = await transcribeSubtitleAudio(
            audio,
            temporary,
            job.options,
            signal,
            update,
            true,
          )
          throwIfWorkCancelled(signal)
          update({ phase: 'saving', percent: 0, message: '자막 파일을 저장하고 있습니다.' })
          const publishedOriginal = (job.outputPaths ?? entry.publishing)?.find((path) =>
            /\.ai(?:\.[1-9]\d*)?\.srt$/i.test(path),
          )
          const outputPaths = publishGeneratedSubtitles(
            job.libraryId,
            job.videoId,
            video.filePath,
            temporary,
            result.language,
            result.translated,
            publishedOriginal,
            (paths) => {
              // Persist publication intent before creating sidecars, so a crash after the DB
              // commit can recognize this job's byte-identical outputs on explicit resume.
              entry.publishing = paths
              changed()
            },
          )
          // Publication is synchronous and cannot be interrupted between files and DB commit.
          Object.assign(job, {
            phase: result.translationError ? 'failed' : 'completed',
            percent: 100,
            message: result.translationError
              ? `원어 자막은 저장했습니다. 한국어 번역 실패: ${result.translationError}`
              : result.translated
                ? '원어 자막과 한국어 번역 자막을 저장했습니다.'
                : '원어 자막을 저장했습니다.',
            outputPaths: [
              ...new Set([...(job.outputPaths ?? []).filter(existsSync), ...outputPaths]),
            ],
          })
          delete entry.publishing
        } finally {
          librarySignal.removeEventListener('abort', abort)
        }
      },
      'subtitles',
      job.videoId,
    )
  } catch (error) {
    if (!running.action && !storageFailure) {
      job.phase = isAbortError(error) ? 'cancelled' : 'failed'
      job.message = isAbortError(error)
        ? '자막 생성을 취소했습니다.'
        : `자막 생성 실패: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!isAbortError(error)) log.warn({ err: error, jobId: job.id }, '자막 생성 실패')
  } finally {
    try {
      if (!storageFailure) {
        if (running.action === 'remove') {
          changed()
          cleanup(entry)
          removeQueueEntry(entry)
        } else if (running.action === 'pause') {
          job.phase = 'paused'
          job.message = entry.replacement?.targets.some(
            (target) => !entry.replacement!.completedIds.includes(target.id),
          )
            ? '일시정지했습니다. 재개 시 남은 기존 자막 삭제부터 이어갑니다.'
            : entry.audioReady
              ? '일시정지했습니다. 완료된 자막 구간부터 이어서 처리합니다.'
              : '일시정지했습니다. 재개 시 음성 추출부터 처리합니다.'
        } else if (running.action === 'cancel') {
          job.phase = 'cancelled'
          job.message = '자막 생성을 취소했습니다.'
        }
        if (running.action !== 'remove') {
          // Commit completion before removing recovery files. A storage failure retains checkpoints.
          changed()
          if (job.phase === 'completed' || job.phase === 'cancelled') cleanup(entry)
        }
      }
    } catch (error) {
      if (!storageFailure) {
        job.phase = 'failed'
        job.message = `임시 파일 정리에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`
      }
      log.warn({ err: error }, '자막 작업 정리 실패')
      changed(false)
    } finally {
      active.delete(job.id)
      if (!stopping && !storageFailure) setImmediate(pump)
    }
  }
}

export async function pauseSubtitleJob(jobId: string): Promise<boolean> {
  initializeSubtitleQueue()
  const entry = entries.get(jobId)
  if (!entry || terminalPhases.has(entry.job.phase) || entry.job.phase === 'paused') return false
  const running = active.get(jobId)
  if (running) {
    if (running.action && running.action !== 'pause') return false
    running.action = 'pause'
    entry.job.phase = 'pausing'
    entry.job.message = '진행 내용을 보관하고 일시정지하고 있습니다.'
    let saveError: unknown
    try {
      changed()
    } catch (error) {
      saveError = error
    } finally {
      running.controller.abort()
    }
    await running.done
    if (saveError) throw saveError
    if (storageFailure) throw storageFailure
  } else {
    entry.job.phase = 'paused'
    entry.job.message = '대기 중인 작업을 일시정지했습니다.'
    changed()
  }
  return true
}

export function resumeSubtitleJob(jobId: string): boolean {
  assertSubtitleEnvironmentIdle()
  initializeSubtitleQueue()
  if (stopping) throw new Error('앱을 종료하고 있습니다.')
  const entry = entries.get(jobId)
  if (entry?.job.storageError && !active.has(jobId)) {
    retryStorage()
    if (entry.job.phase === 'completed' || entry.job.phase === 'cancelled') {
      try {
        cleanup(entry)
      } catch (error) {
        log.warn({ err: error, jobId }, '저장 복구 후 임시 파일 정리 실패')
      }
      return true
    }
  }
  if (!entry || !['paused', 'failed', 'cancelled'].includes(entry.job.phase) || active.has(jobId))
    return false
  if (
    [...entries.values()].some(
      (other) =>
        other !== entry &&
        other.job.libraryId === entry.job.libraryId &&
        other.job.videoId === entry.job.videoId &&
        !terminalPhases.has(other.job.phase),
    )
  )
    throw new Error('이 영상의 다른 자막 작업이 이미 대기열에 있습니다.')
  const { video, source } = writableVideo(entry.job.libraryId, entry.job.videoId, true)
  if (
    video.filePath !== entry.videoPath ||
    source.size !== entry.sourceSize ||
    source.mtimeMs !== entry.sourceMtime
  )
    throw new Error('원본 영상이 변경되었습니다. 작업을 삭제하고 다시 추가하세요.')
  entry.job.phase = 'queued'
  entry.job.message = '재개 대기 중입니다.'
  changed()
  pump()
  return true
}

export async function removeSubtitleJob(jobId: string): Promise<boolean> {
  initializeSubtitleQueue()
  const entry = entries.get(jobId)
  if (!entry) return false
  if (storageFailure) {
    await Promise.all([...active.values()].map(({ done }) => done))
    retryStorage()
  }
  const running = active.get(jobId)
  if (running) {
    running.action = 'remove'
    entry.job.phase = 'removing'
    entry.job.message = '작업을 중지하고 대기열에서 삭제하고 있습니다.'
    let saveError: unknown
    try {
      changed()
    } catch (error) {
      saveError = error
    } finally {
      running.controller.abort()
    }
    await running.done
    if (saveError) throw saveError
    if (storageFailure) throw storageFailure
    return !entries.has(jobId)
  }
  entry.job.phase = 'removing'
  entry.job.message = '대기열에서 삭제하고 있습니다.'
  changed()
  cleanup(entry)
  removeQueueEntry(entry)
  pump()
  return true
}

export async function shutdownSubtitleQueue(): Promise<void> {
  stopping = true
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
  for (const entry of entries.values()) {
    if (entry.job.phase === 'queued') {
      entry.job.phase = 'paused'
      entry.job.message = '앱 종료로 일시정지했습니다. 다시 실행해 재개할 수 있습니다.'
    }
  }
  const runningJobs = [...active.values()]
  for (const running of runningJobs) {
    if (!running.action) running.action = 'pause'
    running.controller.abort()
  }
  await Promise.all(runningJobs.map(({ done }) => done))
  if (!storageFailure) changed()
}
