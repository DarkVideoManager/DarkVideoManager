import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root, isPackaged: false } }))

import { getThumbnailsDir } from '../infra/paths'
import { createAbortError, thumbnailQueue } from '../ffmpeg/queue'
import {
  cancelThumbnailJob,
  clearThumbnailJobHistory,
  listThumbnailJobs,
  runThumbnailJob,
  THUMBNAIL_JOB_TIMEOUT_MS,
  type ThumbnailWork,
} from './ThumbnailJobService'

const libraryId = 'job-tests'
const options = (videoId: string) => ({ libraryId, videoId, fileName: `${videoId}.mp4` })

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'dvm-thumbnail-jobs-test-'))
  clearThumbnailJobHistory(libraryId)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  expect(thumbnailQueue.pending).toBe(0)
  expect(thumbnailQueue.size).toBe(0)
  const target = resolve(state.root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-thumbnail-jobs-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('per-video thumbnail jobs', () => {
  it('fails a video that exceeds the overall deadline and releases the queue slot', async () => {
    vi.useFakeTimers()
    let began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const work = runThumbnailJob(options('slow'), async (context) => {
      began()
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener('abort', () => reject(createAbortError()), { once: true }),
      )
    }).catch((error: Error) => error)
    await started
    await vi.advanceTimersByTimeAsync(THUMBNAIL_JOB_TIMEOUT_MS)
    expect(await work).toMatchObject({ name: 'ThumbnailTimeoutError' })
    expect(listThumbnailJobs(libraryId)).toMatchObject([
      { videoId: 'slow', phase: 'failed', error: expect.stringContaining('2분') },
    ])
    expect(await runThumbnailJob(options('next'), async () => 1)).toBe(1)
  })

  it('cancels queued videos without starting them and preserves the two-worker limit', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const operation = (name: string) => async (work: ThumbnailWork) => {
      started.push(name)
      work.reportProgress(2, 5)
      writeFileSync(join(work.outputDir, 'partial.jpg'), 'new frame')
      await new Promise<void>((resolve) => releases.push(resolve))
      return name
    }
    const first = runThumbnailJob(options('first'), operation('first'))
    const second = runThumbnailJob(options('second'), operation('second'))
    const cancelled = runThumbnailJob(options('cancelled'), operation('cancelled')).catch(
      (error: Error) => error.name,
    )
    const last = runThumbnailJob(options('last'), async () => 'last')
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2))
      expect(listThumbnailJobs(libraryId)).toMatchObject([
        { videoId: 'first', phase: 'running', completed: 2, total: 5 },
        { videoId: 'second', phase: 'running' },
        { videoId: 'cancelled', phase: 'queued' },
        { videoId: 'last', phase: 'queued' },
      ])
      expect(cancelThumbnailJob(libraryId, 'cancelled')).toBe(true)
      expect(await cancelled).toBe('AbortError')
      expect(started).toEqual(['first', 'second'])
    } finally {
      releases.forEach((release) => release())
      await Promise.all([first, second, cancelled, last])
    }
    expect(listThumbnailJobs(libraryId).map((job) => job.phase)).toEqual([
      'completed',
      'completed',
      'cancelled',
      'completed',
    ])
    expect(readdirSync(getThumbnailsDir(libraryId))).toEqual([])
  })

  it('retains cancelling state and same-video protection until output cleanup settles', async () => {
    let began!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runThumbnailJob(options('first'), async (work) => {
      writeFileSync(join(work.outputDir, 'partial.jpg'), 'new frame')
      began()
      await new Promise<void>((resolve) =>
        work.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      await cleanup
      throw createAbortError()
    }).catch((error: Error) => error.name)
    await started
    expect(cancelThumbnailJob(libraryId, 'first')).toBe(true)
    try {
      expect(listThumbnailJobs(libraryId)[0].phase).toBe('cancelling')
      expect(cancelThumbnailJob(libraryId, 'first')).toBe(false)
      await expect(runThumbnailJob(options('first'), async () => 1)).rejects.toThrow('진행 중')
      expect(readdirSync(getThumbnailsDir(libraryId))).toHaveLength(1)
    } finally {
      release()
      expect(await first).toBe('AbortError')
    }
    expect(listThumbnailJobs(libraryId)[0].phase).toBe('cancelled')
    expect(readdirSync(getThumbnailsDir(libraryId))).toEqual([])
    expect(await runThumbnailJob(options('first'), async () => 2)).toBe(2)
    expect(listThumbnailJobs(libraryId)[0].phase).toBe('completed')
  })

  it('records failure, releases its slot, and replaces stale failure on retry', async () => {
    await expect(
      runThumbnailJob(options('failed'), async (work) => {
        writeFileSync(join(work.outputDir, 'partial.jpg'), 'new frame')
        throw new Error('decoder failed')
      }),
    ).rejects.toThrow('decoder failed')
    expect(listThumbnailJobs(libraryId)).toMatchObject([
      { phase: 'failed', error: 'decoder failed' },
    ])
    const snapshot = listThumbnailJobs(libraryId)
    snapshot[0].phase = 'completed'
    expect(listThumbnailJobs(libraryId)[0].phase).toBe('failed')
    expect(await runThumbnailJob(options('next'), async () => 1)).toBe(1)
    expect(await runThumbnailJob(options('failed'), async () => 2)).toBe(2)
    expect(listThumbnailJobs(libraryId).find((job) => job.videoId === 'failed')).toMatchObject({
      phase: 'completed',
    })
    expect(
      listThumbnailJobs(libraryId).find((job) => job.videoId === 'failed')?.error,
    ).toBeUndefined()
    expect(readdirSync(getThumbnailsDir(libraryId))).toEqual([])
  })

  it('expires terminal history while keeping active jobs visible', async () => {
    await runThumbnailJob(options('old'), async () => undefined)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1)
    expect(listThumbnailJobs(libraryId)).toEqual([])
    expect(cancelThumbnailJob(libraryId, 'old')).toBe(false)
  })
})
