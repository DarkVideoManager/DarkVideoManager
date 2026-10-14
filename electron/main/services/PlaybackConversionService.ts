import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PlaybackConversionJob } from '@shared/playbackConversion'
import type { Video } from '@shared/types'
import { getPlaybackProxyDir, getUserDataPath } from '../infra/paths'
import { getDatabase, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { loadConfig } from '../infra/config'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { ensurePlaybackProxy, getCachedPlaybackProxy } from '../ffmpeg/playback.js'
import { createLogger } from '../infra/logger'

const log = createLogger('PlaybackConversionService')
const jobs = new Map<string, PlaybackConversionJob>()
const listeners = new Set<() => void>()
const removing = new Set<string>()
interface Waiter {
  resolve: (source: string) => void
  reject: (error: Error) => void
}
const waiters = new Map<string, Waiter[]>()
let initialized = false
let initializationError: Error | undefined
let stopping = false
let active: { id: string; controller: AbortController; work: Promise<void> } | undefined
let lastProgressNotification = 0
const MAX_JOBS = 1000
const JobZ = z.object({
  id: z.string().uuid(),
  libraryId: z.string().min(1),
  videoId: z.string().min(1),
  title: z.string().max(4096),
  fileName: z.string().max(4096),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'failed']),
  phase: z.enum(['waiting', 'checking', 'remuxing', 'transcoding', 'validating', 'completed']),
  progress: z.number().finite().min(0).max(100).nullable(),
  processedSec: z.number().finite().nonnegative(),
  durationSec: z.number().finite().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().optional(),
})
const JournalZ = z
  .object({ version: z.literal(1), jobs: z.array(JobZ).max(MAX_JOBS) })
  .refine(
    ({ jobs: saved }) =>
      new Set(saved.map((job) => job.id)).size === saved.length &&
      new Set(saved.map((job) => JSON.stringify([job.libraryId, job.videoId]))).size ===
        saved.length,
    '중복된 변환 작업이 있습니다.',
  )

function queuePath(): string {
  return getUserDataPath('playback-conversion-queue.json')
}

function persist(): void {
  if (initializationError) throw initializationError
  const target = queuePath()
  const temporary = target + '.tmp.' + randomUUID()
  let fd: number | undefined
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fd = fs.openSync(temporary, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ version: 1, jobs: [...jobs.values()] }), 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, target)
  } catch (error) {
    throw new Error('재생 변환 대기열을 저장하지 못했습니다. 저장 공간과 파일 권한을 확인하세요.', {
      cause: error,
    })
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function changed(strict = false): void {
  let failure: Error | undefined
  try {
    persist()
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    log.error({ error }, '재생 변환 대기열 저장 실패')
    for (const job of jobs.values()) job.error = failure.message
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      log.warn({ error }, '재생 변환 대기열 알림 실패')
    }
  }
  if (strict && failure) throw failure
}

function settle(id: string, error?: Error, source?: string): void {
  const pending = waiters.get(id) ?? []
  waiters.delete(id)
  for (const waiter of pending) {
    if (error) waiter.reject(error)
    else if (source) waiter.resolve(source)
  }
}

function waitFor(job: PlaybackConversionJob): Promise<string> {
  return new Promise((resolve, reject) => {
    const pending = waiters.get(job.id) ?? []
    pending.push({ resolve, reject })
    waiters.set(job.id, pending)
  })
}

function findJob(id: string): PlaybackConversionJob {
  initializePlaybackConversionQueue()
  const job = jobs.get(id)
  if (!job || removing.has(id)) throw new Error('재생 변환 작업을 찾을 수 없습니다.')
  return job
}

function pauseMessage(): Error {
  return new Error(
    '재생 변환이 일시정지되었습니다. 홈의 변환 대기열에서 재개하면 처음부터 다시 변환합니다.',
  )
}

function touch(job: PlaybackConversionJob): void {
  job.updatedAt = new Date().toISOString()
}

function toQueued(job: PlaybackConversionJob): void {
  job.status = 'queued'
  job.phase = 'waiting'
  job.progress = job.durationSec > 0 ? 0 : null
  job.processedSec = 0
  delete job.error
  touch(job)
  // A resumed job joins the tail, keeping earlier requests ahead of it.
  jobs.delete(job.id)
  jobs.set(job.id, job)
}

function currentVideo(job: PlaybackConversionJob): Video {
  let db = getDatabase(job.libraryId)
  if (!db) {
    const library = loadConfig().libraries.find((item) => item.id === job.libraryId)
    if (library) {
      db = openDatabase(job.libraryId, library.dbPath)
      runMigrations(db, library.dbPath)
    }
  }
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다. 라이브러리를 연 뒤 다시 시도하세요.')
  const video = new VideoRepository(db).findById(job.videoId)
  if (!video) throw new Error('영상을 찾을 수 없습니다.')
  if (video.removalMode) throw new Error('제거한 영상은 목록 복구 후 변환할 수 있습니다.')
  return video
}

function pump(): void {
  if (stopping || active) return
  const job = [...jobs.values()].find(
    (entry) => entry.status === 'queued' && !removing.has(entry.id),
  )
  if (!job) return
  const controller = new AbortController()
  job.status = 'running'
  job.phase = 'checking'
  touch(job)
  const work = Promise.resolve().then(async () => {
    try {
      if (controller.signal.aborted) return
      const video = currentVideo(job)
      const source = await ensurePlaybackProxy(
        video.filePath,
        getPlaybackProxyDir(job.libraryId),
        video.id,
        video.codec,
        {
          signal: controller.signal,
          durationSec: video.durationSec,
          onProgress: (progress) => {
            if (job.status !== 'running' || controller.signal.aborted) return
            const previousPhase = job.phase
            Object.assign(job, progress)
            touch(job)
            if (previousPhase !== job.phase || Date.now() - lastProgressNotification >= 500) {
              lastProgressNotification = Date.now()
              changed()
            }
          },
        },
      )
      if (controller.signal.aborted || removing.has(job.id)) return
      job.status = 'completed'
      job.phase = 'completed'
      job.progress = 100
      job.processedSec = job.durationSec || job.processedSec
      delete job.error
      touch(job)
      settle(job.id, undefined, source)
    } catch (error) {
      if (controller.signal.aborted || job.status === 'paused' || removing.has(job.id)) return
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      touch(job)
      settle(job.id, new Error(job.error))
    } finally {
      active = undefined
      changed()
      pump()
    }
  })
  active = { id: job.id, controller, work }
  changed()
}

export function initializePlaybackConversionQueue(): void {
  if (initialized) {
    if (initializationError) throw initializationError
    return
  }
  initialized = true
  try {
    if (!fs.existsSync(queuePath())) return
    if (fs.statSync(queuePath()).size > 8 * 1024 * 1024)
      throw new Error('대기열 파일이 너무 큽니다.')
    const journal = JournalZ.parse(JSON.parse(fs.readFileSync(queuePath(), 'utf8')))
    for (const saved of journal.jobs) {
      const job: PlaybackConversionJob = { ...saved }
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'paused'
        job.error = '앱이 종료되어 변환을 일시정지했습니다. 재개하면 처음부터 다시 변환합니다.'
        touch(job)
      }
      jobs.set(job.id, job)
    }
    persist()
  } catch (error) {
    log.error({ error }, '재생 변환 대기열 복구 실패')
    initializationError = new Error(
      '재생 변환 대기열 파일을 읽거나 복구할 수 없습니다. 기존 파일은 보존했습니다: ' + queuePath(),
      { cause: error },
    )
    throw initializationError
  }
}

export function listPlaybackConversionJobs(): PlaybackConversionJob[] {
  initializePlaybackConversionQueue()
  let position = 0
  return [...jobs.values()].map((job) => ({
    ...job,
    queuePosition: job.status === 'queued' ? ++position : undefined,
  }))
}

export function hasPendingPlaybackConversionJobs(): boolean {
  try {
    initializePlaybackConversionQueue()
  } catch {
    /* A damaged journal must not break window close. */
  }
  return (
    Boolean(active) ||
    [...jobs.values()].some((job) => ['queued', 'running', 'paused'].includes(job.status))
  )
}

export function onPlaybackConversionQueueChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Requests belong to the main-process queue, independent of player/window lifetime. */
export async function enqueuePlaybackConversion(libraryId: string, video: Video): Promise<string> {
  initializePlaybackConversionQueue()
  if (stopping) throw new Error('앱이 종료 중입니다.')
  const cached = await getCachedPlaybackProxy(
    video.filePath,
    getPlaybackProxyDir(libraryId),
    video.id,
  )
  if (stopping) throw new Error('앱이 종료 중입니다.')
  if (cached) return cached
  let job = [...jobs.values()].find(
    (entry) => entry.libraryId === libraryId && entry.videoId === video.id,
  )
  if (job && removing.has(job.id)) throw new Error('재생 변환 작업을 삭제하고 있습니다.')
  if (job?.status === 'paused') throw pauseMessage()
  if (job && (job.status === 'running' || job.status === 'queued')) {
    const result = waitFor(job)
    pump()
    return result
  }
  const previousJobs = new Map(jobs)
  const previousJob = job ? { ...job } : undefined
  if (!job) {
    if (jobs.size >= MAX_JOBS) {
      const oldestTerminal = [...jobs.values()].find((entry) =>
        ['completed', 'failed'].includes(entry.status),
      )
      if (!oldestTerminal)
        throw new Error('변환 대기열이 가득 찼습니다. 필요 없는 작업을 삭제하세요.')
      jobs.delete(oldestTerminal.id)
    }
    const now = new Date().toISOString()
    job = {
      id: randomUUID(),
      libraryId,
      videoId: video.id,
      title: video.title || video.fileName,
      fileName: video.fileName,
      status: 'queued',
      phase: 'waiting',
      progress: video.durationSec ? 0 : null,
      processedSec: 0,
      durationSec: video.durationSec || 0,
      createdAt: now,
      updatedAt: now,
    }
    jobs.set(job.id, job)
  } else if (job.status === 'failed' || job.status === 'completed') {
    toQueued(job)
  }
  try {
    changed(true)
  } catch (error) {
    jobs.clear()
    for (const [id, entry] of previousJobs) jobs.set(id, entry)
    if (previousJob) jobs.set(previousJob.id, previousJob)
    throw error
  }
  const result = waitFor(job)
  pump()
  return result
}

export async function pausePlaybackConversionJob(id: string): Promise<PlaybackConversionJob> {
  const job = findJob(id)
  if (job.status !== 'running' && job.status !== 'queued') return { ...job }
  job.status = 'paused'
  job.error = pauseMessage().message
  touch(job)
  settle(id, pauseMessage())
  const running = active?.id === id ? active : undefined
  running?.controller.abort()
  let saveError: unknown
  try {
    changed(true)
  } catch (error) {
    saveError = error
  }
  await running?.work
  if (saveError) throw saveError
  return { ...job }
}

export async function resumePlaybackConversionJob(id: string): Promise<PlaybackConversionJob> {
  const job = findJob(id)
  if (stopping) throw new Error('앱이 종료 중입니다.')
  if (job.status !== 'paused' && job.status !== 'failed') return { ...job }
  if (active?.id === id) await active.work
  if (stopping || removing.has(id) || !jobs.has(id))
    throw new Error('재생 변환을 재개할 수 없습니다.')
  // Another caller may have resumed this same paused job while cleanup finished.
  if (job.status !== 'paused' && job.status !== 'failed') return { ...job }
  const previous = { ...job }
  toQueued(job)
  try {
    changed(true)
  } catch (error) {
    Object.assign(job, previous)
    throw error
  }
  pump()
  return { ...job }
}

export async function removePlaybackConversionJob(id: string): Promise<void> {
  const job = findJob(id)
  removing.add(id)
  job.status = 'paused'
  settle(id, new Error('재생 변환 작업이 대기열에서 삭제되었습니다.'))
  const running = active?.id === id ? active : undefined
  running?.controller.abort()
  changed()
  await running?.work
  jobs.delete(id)
  removing.delete(id)
  try {
    changed(true)
  } catch (error) {
    // Keep the stopped entry available so the user can retry saving its removal.
    jobs.set(id, job)
    throw error
  }
  pump()
}

export async function shutdownPlaybackConversionQueue(): Promise<void> {
  initializePlaybackConversionQueue()
  stopping = true
  for (const job of jobs.values()) {
    if (job.status !== 'running' && job.status !== 'queued') continue
    job.status = 'paused'
    job.error = '앱이 종료되어 변환을 일시정지했습니다. 재개하면 처음부터 다시 변환합니다.'
    touch(job)
    settle(job.id, new Error(job.error))
  }
  active?.controller.abort()
  changed()
  await active?.work
}
