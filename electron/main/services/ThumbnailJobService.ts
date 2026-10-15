import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ThumbnailJob } from '@shared/types'
import { createAbortError, isAbortError, thumbnailQueue } from '../ffmpeg/queue'
import { getThumbnailsDir } from '../infra/paths'
import { throwIfWorkCancelled } from './LibraryWorkService'

interface JobEntry {
  job: ThumbnailJob
  controller: AbortController
  finishedAt?: number
}

export interface ThumbnailWork {
  signal: AbortSignal
  outputDir: string
  committed: boolean
  reportProgress: (completed: number, total: number) => void
}

const jobs = new Map<string, JobEntry>()
const TERMINAL_HISTORY_LIMIT = 100
const TERMINAL_HISTORY_MS = 5 * 60_000
export const THUMBNAIL_JOB_TIMEOUT_MS = 120_000

function jobKey(libraryId: string, videoId: string): string {
  return JSON.stringify([libraryId, videoId])
}

async function removeJobOutput(root: string, outputDir: string): Promise<void> {
  const child = relative(root, resolve(outputDir))
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new Error('Invalid thumbnail cleanup directory')
  await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

function pruneHistory(): void {
  const terminal = [...jobs.entries()].filter(([, entry]) => entry.finishedAt !== undefined)
  terminal.sort((a, b) => a[1].finishedAt! - b[1].finishedAt!)
  for (const [index, [key, entry]] of terminal.entries()) {
    if (
      index < terminal.length - TERMINAL_HISTORY_LIMIT ||
      Date.now() - entry.finishedAt! > TERMINAL_HISTORY_MS
    )
      jobs.delete(key)
  }
}

export function listThumbnailJobs(libraryId: string): ThumbnailJob[] {
  pruneHistory()
  return [...jobs.values()]
    .filter((entry) => entry.job.libraryId === libraryId)
    .map(({ job }) => ({ ...job }))
}

export function clearThumbnailJobHistory(libraryId: string): void {
  for (const [key, entry] of jobs) {
    if (entry.job.libraryId === libraryId && entry.finishedAt !== undefined) jobs.delete(key)
  }
}

export function assertThumbnailJobAllowed(libraryId: string, videoId: string): void {
  const entry = jobs.get(jobKey(libraryId, videoId))
  if (entry && entry.finishedAt === undefined)
    throw new Error(
      '이 동영상의 썸네일 작업이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도하세요.',
    )
}

export function cancelThumbnailJob(libraryId: string, videoId: string): boolean {
  const entry = jobs.get(jobKey(libraryId, videoId))
  if (!entry || entry.finishedAt !== undefined || entry.controller.signal.aborted) return false
  entry.job.phase = 'cancelling'
  entry.controller.abort()
  return true
}

export async function runThumbnailJob<T>(
  options: {
    libraryId: string
    videoId: string
    fileName: string
    total?: number
    signal?: AbortSignal
  },
  operation: (work: ThumbnailWork) => Promise<T>,
): Promise<T> {
  const { libraryId, videoId, fileName, signal } = options
  throwIfWorkCancelled(signal)
  assertThumbnailJobAllowed(libraryId, videoId)
  pruneHistory()
  const entry: JobEntry = {
    job: { libraryId, videoId, fileName, phase: 'queued', completed: 0, total: options.total ?? 1 },
    controller: new AbortController(),
  }
  jobs.set(jobKey(libraryId, videoId), entry)
  const cancel = () => cancelThumbnailJob(libraryId, videoId)
  signal?.addEventListener('abort', cancel, { once: true })
  const jobSignal = entry.controller.signal
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timeoutError: Error | undefined
  try {
    const result = await thumbnailQueue.add(async () => {
      throwIfWorkCancelled(jobSignal)
      entry.job.phase = 'running'
      // Frame-level limits alone still allow many slow failed seeks to occupy
      // a queue slot for minutes. Bound the complete running video job as well.
      deadline = setTimeout(() => {
        if (jobSignal.aborted) return
        timeoutError = new Error(
          '썸네일 생성 시간이 2분을 초과했습니다. 다른 동영상으로 계속 진행합니다.',
        )
        timeoutError.name = 'ThumbnailTimeoutError'
        entry.job.phase = 'cancelling'
        entry.controller.abort()
      }, THUMBNAIL_JOB_TIMEOUT_MS)
      const root = resolve(getThumbnailsDir(libraryId))
      const outputDir = await mkdtemp(join(root, 'capture-'))
      const work: ThumbnailWork = {
        signal: jobSignal,
        outputDir,
        committed: false,
        reportProgress: (completed, total) => {
          if (jobSignal.aborted) return
          entry.job.total = Math.max(1, total)
          entry.job.completed = Math.max(0, Math.min(completed, entry.job.total))
        },
      }
      try {
        throwIfWorkCancelled(jobSignal)
        return await operation(work)
      } finally {
        if (!work.committed) await removeJobOutput(root, outputDir)
      }
    }, jobSignal)
    entry.job.phase = 'completed'
    entry.job.completed = entry.job.total
    return result
  } catch (error) {
    if (timeoutError) {
      entry.job.phase = 'failed'
      entry.job.error = timeoutError.message
      throw timeoutError
    }
    if (isAbortError(error) || jobSignal.aborted) {
      entry.job.phase = 'cancelled'
      throw createAbortError()
    }
    entry.job.phase = 'failed'
    entry.job.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (deadline) clearTimeout(deadline)
    signal?.removeEventListener('abort', cancel)
    entry.finishedAt = Date.now()
    pruneHistory()
  }
}
