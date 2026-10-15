import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('./CacheService', () => ({
  releasePlaybackCache: () => false,
  trimPlaybackCache: vi.fn(),
}))

import { openDatabase, closeAllDatabases } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { PlayHistoryRepository } from '../db/repositories/PlayHistoryRepository'
import {
  startPlayback,
  heartbeat,
  recordSeek,
  endPlayback,
  finishPlaybackSessions,
} from './PlaybackService'
import { isSourceFileInUse } from './SourceFileUsage'

const libraryId = 'seek-history-test'
const videoId = 'video-test'
let videos: VideoRepository
let history: PlayHistoryRepository

beforeEach(() => {
  const db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  videos = new VideoRepository(db)
  history = new PlayHistoryRepository(db)
  videos.insert({
    id: videoId,
    filePath: '/synthetic.mp4',
    fileName: 'synthetic.mp4',
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  finishPlaybackSessions()
  closeAllDatabases()
  vi.useRealTimers()
})

describe('explicit playback seek accounting', () => {
  it('releases the closed source and session even when persisting history fails', () => {
    const first = startPlayback(libraryId, videoId)
    expect(isSourceFileInUse('/synthetic.mp4')).toBe(true)
    const update = vi
      .spyOn(PlayHistoryRepository.prototype, 'update')
      .mockImplementationOnce(() => {
        throw new Error('database is unavailable')
      })
    expect(() => endPlayback(libraryId, videoId, 2)).toThrow('database is unavailable')
    expect(isSourceFileInUse('/synthetic.mp4')).toBe(false)
    update.mockRestore()
    expect(startPlayback(libraryId, videoId)).not.toBe(first)
  })
  it('persists small paused seeks without increasing watched time or starting another session', () => {
    const session = startPlayback(libraryId, videoId)
    vi.advanceTimersByTime(4000)
    recordSeek(libraryId, videoId, 1)
    expect(history.findByVideoId(videoId)).toMatchObject([
      { id: session, posEndSec: 1, durationWatchedSec: 0 },
    ])
    expect(videos.findById(videoId)).toMatchObject({
      resumePosSec: 1,
      playTimeSec: 0,
      playCount: 1,
    })
    vi.advanceTimersByTime(4000)
    recordSeek(libraryId, videoId, 1.5)
    heartbeat(libraryId, videoId, 1.5)
    endPlayback(libraryId, videoId, 1.5)
    expect(history.findByVideoId(videoId)).toMatchObject([
      { id: session, posEndSec: 1.5, durationWatchedSec: 0 },
    ])
    expect(videos.findById(videoId)).toMatchObject({
      resumePosSec: 1.5,
      playTimeSec: 0,
      playCount: 1,
    })
  })

  it('keeps playback sampled before the seek and counts subsequent normal playback', () => {
    startPlayback(libraryId, videoId)
    vi.advanceTimersByTime(4000)
    // The renderer samples the actual previous position before starting the seek.
    heartbeat(libraryId, videoId, 4)
    vi.advanceTimersByTime(250)
    recordSeek(libraryId, videoId, 40)
    expect(videos.findById(videoId)).toMatchObject({ resumePosSec: 40, playTimeSec: 4 })
    vi.advanceTimersByTime(3000)
    heartbeat(libraryId, videoId, 43)
    endPlayback(libraryId, videoId, 43)
    expect(history.findByVideoId(videoId)).toMatchObject([{ posEndSec: 43, durationWatchedSec: 7 }])
    expect(videos.findById(videoId)).toMatchObject({
      resumePosSec: 43,
      playTimeSec: 7,
      playCount: 1,
    })
  })
})
