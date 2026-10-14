import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Video } from '@shared/types'
import type { PlaybackProxyOptions } from '../ffmpeg/playback.js'

interface Worker {
  videoId: string
  options: PlaybackProxyOptions
  resolve: (source: string) => void
  reject: (error: Error) => void
}
const state = vi.hoisted(() => ({
  root: '',
  cached: vi.fn(),
  workers: [] as Worker[],
  videos: new Map<string, Video>(),
  dbOpen: true,
  openDatabase: vi.fn(),
  migrate: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
vi.mock('../db/connection', () => ({
  getDatabase: () => (state.dbOpen ? {} : null),
  openDatabase: state.openDatabase,
}))
vi.mock('../db/migrator', () => ({ runMigrations: state.migrate }))
vi.mock('../infra/config', () => ({
  loadConfig: () => ({ libraries: [{ id: 'library', dbPath: 'configured-library.db' }] }),
}))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById(id: string) {
      return state.videos.get(id) ?? null
    }
  },
}))
vi.mock('../ffmpeg/playback.js', () => ({
  getCachedPlaybackProxy: state.cached,
  ensurePlaybackProxy: (
    _source: string,
    _directory: string,
    videoId: string,
    _codec: string,
    options: PlaybackProxyOptions,
  ) =>
    new Promise<string>((resolve, reject) =>
      state.workers.push({ videoId, options, resolve, reject }),
    ),
}))

let service: typeof import('./PlaybackConversionService')
function video(id: string): Video {
  const result = {
    id,
    filePath: path.join(state.root, id + '.avi'),
    fileName: id + '.avi',
    durationSec: 100,
    codec: 'mpeg4',
  } as Video
  state.videos.set(id, result)
  return result
}
function request(id: string): Promise<string | Error> {
  return service.enqueuePlaybackConversion('library', video(id)).catch((error: Error) => error)
}
function job(id: string) {
  return service.listPlaybackConversionJobs().find((entry) => entry.videoId === id)!
}
async function worker(index: number): Promise<Worker> {
  await vi.waitFor(() => expect(state.workers.length).toBeGreaterThan(index))
  return state.workers[index]
}

beforeEach(async () => {
  vi.resetModules()
  state.root = fs.mkdtempSync(path.join(tmpdir(), 'dvm-conversion-queue-'))
  state.workers = []
  state.videos.clear()
  state.dbOpen = true
  state.openDatabase.mockReset().mockReturnValue({})
  state.migrate.mockReset()
  state.cached.mockReset().mockResolvedValue(null)
  service = await import('./PlaybackConversionService')
})

afterEach(async () => {
  const stopping = service.shutdownPlaybackConversionQueue().catch(() => undefined)
  for (const current of state.workers) current.reject(new Error('test cleanup'))
  await stopping
  vi.restoreAllMocks()
  const root = path.resolve(state.root)
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('dvm-conversion-queue-')
  )
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('playback conversion queue', () => {
  it('joins duplicate requests and converts one video at a time in FIFO order', async () => {
    const first = request('first')
    const duplicate = request('first')
    const second = request('second')
    const current = await worker(0)
    expect(state.workers).toHaveLength(1)
    expect(service.listPlaybackConversionJobs()).toHaveLength(2)
    expect(job('second')).toMatchObject({ status: 'queued', queuePosition: 1 })
    expect(service.hasPendingPlaybackConversionJobs()).toBe(true)
    current.resolve('first.mp4')
    expect(await first).toBe('first.mp4')
    expect(await duplicate).toBe('first.mp4')
    const next = await worker(1)
    expect(next.videoId).toBe('second')
    next.resolve('second.mp4')
    expect(await second).toBe('second.mp4')
    expect(job('first')).toMatchObject({ status: 'completed', progress: 100 })
    expect(service.hasPendingPlaybackConversionJobs()).toBe(false)
  })

  it('publishes measured media progress and preserves unknown duration without fabricated percentages', async () => {
    const changed = vi.fn()
    const unsubscribe = service.onPlaybackConversionQueueChanged(changed)
    const result = request('first')
    const current = await worker(0)
    current.options.onProgress!({
      phase: 'transcoding',
      progress: 37.25,
      processedSec: 37.25,
      durationSec: 100,
    })
    expect(job('first')).toMatchObject({
      phase: 'transcoding',
      progress: 37.25,
      processedSec: 37.25,
    })
    current.options.onProgress!({
      phase: 'validating',
      progress: null,
      processedSec: 70,
      durationSec: 0,
    })
    expect(job('first')).toMatchObject({ phase: 'validating', progress: null, processedSec: 70 })
    expect(changed).toHaveBeenCalled()
    unsubscribe()
    current.resolve('first.mp4')
    await result
  })

  it('waits for process exit on pause before starting the next job and resumes from zero at the tail', async () => {
    const first = request('first')
    const second = request('second')
    const current = await worker(0)
    current.options.onProgress!({
      phase: 'transcoding',
      progress: 42,
      processedSec: 42,
      durationSec: 100,
    })
    const paused = service.pausePlaybackConversionJob(job('first').id)
    expect(current.options.signal?.aborted).toBe(true)
    expect(await first).toBeInstanceOf(Error)
    expect(job('first').status).toBe('paused')
    expect(state.workers).toHaveLength(1)
    current.reject(new Error('FFmpeg exited'))
    await paused
    const next = await worker(1)
    await service.resumePlaybackConversionJob(job('first').id)
    expect(job('first')).toMatchObject({ status: 'queued', progress: 0, processedSec: 0 })
    next.resolve('second.mp4')
    await second
    const resumed = await worker(2)
    expect(resumed.videoId).toBe('first')
    resumed.resolve('first.mp4')
    await vi.waitFor(() => expect(job('first').status).toBe('completed'))
  })

  it('can pause/remove waiting entries and safely remove active work without touching the source', async () => {
    const first = request('first')
    const second = request('second')
    const current = await worker(0)
    fs.writeFileSync(state.videos.get('first')!.filePath, 'original')
    await service.pausePlaybackConversionJob(job('second').id)
    expect(await second).toBeInstanceOf(Error)
    await service.removePlaybackConversionJob(job('second').id)
    expect(service.listPlaybackConversionJobs()).toHaveLength(1)
    const removed = service.removePlaybackConversionJob(job('first').id)
    expect(current.options.signal?.aborted).toBe(true)
    expect(await first).toBeInstanceOf(Error)
    current.reject(new Error('terminated'))
    await removed
    expect(service.listPlaybackConversionJobs()).toHaveLength(0)
    expect(fs.readFileSync(state.videos.get('first')!.filePath, 'utf8')).toBe('original')
  })

  it('records failures, advances the queue, and permits an explicit retry', async () => {
    const first = request('first')
    const second = request('second')
    const failed = await worker(0)
    failed.reject(new Error('encoder failed'))
    expect(await first).toMatchObject({ message: 'encoder failed' })
    expect(job('first')).toMatchObject({ status: 'failed', error: 'encoder failed' })
    const current = await worker(1)
    await service.resumePlaybackConversionJob(job('first').id)
    current.resolve('second.mp4')
    await second
    const retried = await worker(2)
    expect(retried.videoId).toBe('first')
    retried.resolve('first.mp4')
    await vi.waitFor(() => expect(job('first').status).toBe('completed'))
  })

  it('returns an existing playable cache immediately while another video is converting', async () => {
    const pending = request('first')
    const current = await worker(0)
    state.cached.mockResolvedValueOnce('cached-ready.mp4')
    expect(await request('ready')).toBe('cached-ready.mp4')
    expect(service.listPlaybackConversionJobs()).toHaveLength(1)
    expect(state.workers).toHaveLength(1)
    current.resolve('first.mp4')
    await pending
  })

  it('persists shutdown as paused, drains cancellation, and restores without auto-starting', async () => {
    const first = request('first')
    const second = request('second')
    const current = await worker(0)
    const stopping = service.shutdownPlaybackConversionQueue()
    expect(current.options.signal?.aborted).toBe(true)
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    current.reject(new Error('terminated'))
    await stopping
    const saved = JSON.parse(
      fs.readFileSync(path.join(state.root, 'playback-conversion-queue.json'), 'utf8'),
    )
    // Also simulate a process crash before shutdown could rewrite its journal.
    saved.jobs[0].status = 'running'
    saved.jobs[1].status = 'queued'
    fs.writeFileSync(path.join(state.root, 'playback-conversion-queue.json'), JSON.stringify(saved))
    vi.resetModules()
    service = await import('./PlaybackConversionService')
    service.initializePlaybackConversionQueue()
    expect(service.listPlaybackConversionJobs().map((entry) => entry.status)).toEqual([
      'paused',
      'paused',
    ])
    expect(service.hasPendingPlaybackConversionJobs()).toBe(true)
    expect(state.workers).toHaveLength(1)
    expect(await request('first')).toBeInstanceOf(Error)
    await service.resumePlaybackConversionJob(job('first').id)
    const resumed = await worker(1)
    resumed.resolve('first.mp4')
    await vi.waitFor(() => expect(job('first').status).toBe('completed'))
  })

  it('fails a stale or removed video without starting FFmpeg', async () => {
    const first = request('first')
    state.videos.get('first')!.removalMode = 'trash'
    expect(await first).toMatchObject({ message: expect.stringContaining('제거한 영상') })
    expect(state.workers).toHaveLength(0)
    expect(job('first').status).toBe('failed')
  })

  it('reopens only the configured library database when resuming a closed library', async () => {
    state.dbOpen = false
    const pending = request('first')
    const current = await worker(0)
    expect(state.openDatabase).toHaveBeenCalledWith('library', 'configured-library.db')
    expect(state.migrate).toHaveBeenCalledWith(expect.anything(), 'configured-library.db')
    current.resolve('first.mp4')
    await pending
  })

  it('coalesces concurrent resumes while a paused process is still exiting', async () => {
    const first = request('first')
    const current = await worker(0)
    const paused = service.pausePlaybackConversionJob(job('first').id)
    const resumeA = service.resumePlaybackConversionJob(job('first').id)
    const resumeB = service.resumePlaybackConversionJob(job('first').id)
    current.reject(new Error('terminated'))
    await Promise.all([first, paused, resumeA, resumeB])
    const resumed = await worker(1)
    expect(state.workers).toHaveLength(2)
    expect(job('first').status).toBe('running')
    resumed.options.onProgress!({
      phase: 'transcoding',
      progress: 20,
      processedSec: 20,
      durationSec: 100,
    })
    expect(job('first').progress).toBe(20)
    resumed.resolve('first.mp4')
    await vi.waitFor(() => expect(job('first').status).toBe('completed'))
  })

  it('preserves a malformed journal and reports it without crashing the background check', async () => {
    const target = path.join(state.root, 'playback-conversion-queue.json')
    const malformed = '{"version":1,"jobs":[{"id":"not-a-uuid"}]}'
    fs.writeFileSync(target, malformed)
    expect(() => service.initializePlaybackConversionQueue()).toThrow('기존 파일은 보존')
    expect(() => service.listPlaybackConversionJobs()).toThrow('기존 파일은 보존')
    expect(service.hasPendingPlaybackConversionJobs()).toBe(false)
    expect(await request('first')).toBeInstanceOf(Error)
    expect(fs.readFileSync(target, 'utf8')).toBe(malformed)
    expect(state.workers).toHaveLength(0)
  })

  it('rejects an enqueue that cannot be saved and does not start unjournaled work', async () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk write denied')
    })
    expect(await request('first')).toMatchObject({
      message: expect.stringContaining('저장하지 못했습니다'),
    })
    expect(state.workers).toHaveLength(0)
    expect(service.listPlaybackConversionJobs()).toHaveLength(0)
    rename.mockRestore()
  })
})
