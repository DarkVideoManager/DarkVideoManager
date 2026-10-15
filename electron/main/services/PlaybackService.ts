import { randomUUID } from 'crypto'
import { getDatabase } from '../db/connection'
import { PlayHistoryRepository } from '../db/repositories/PlayHistoryRepository'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { releasePlaybackCache, trimPlaybackCache } from './CacheService'
import { createLogger } from '../infra/logger'
import { acquireSourceFile } from './SourceFileUsage'

const log = createLogger('playback-cache')

interface PlaybackSession {
  historyId: string
  libraryId: string
  videoId: string
  lastPosition: number
  lastSampleAt: number
  watchedSec: number
  releaseSource: () => void
}
const activeSessions = new Map<string, PlaybackSession>()
const keyFor = (libraryId: string, videoId: string) => libraryId + ':' + videoId

export function startPlayback(
  libraryId: string,
  videoId: string,
  initialPosition?: number,
): string {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  const key = keyFor(libraryId, videoId)
  const existing = activeSessions.get(key)
  if (existing) return existing.historyId
  const video = new VideoRepository(db).findById(videoId)
  if (!video) throw new Error('Video not found')
  const historyId = randomUUID()
  const position = Math.max(0, initialPosition ?? video.resumePosSec ?? 0)
  new PlayHistoryRepository(db).insert({
    id: historyId,
    videoId,
    startedAt: new Date().toISOString(),
    posStartSec: position,
  })
  activeSessions.set(key, {
    historyId,
    libraryId,
    videoId,
    lastPosition: position,
    lastSampleAt: Date.now(),
    watchedSec: 0,
    releaseSource: acquireSourceFile(video.filePath),
  })
  return historyId
}

function sample(session: PlaybackSession, positionSec: number): void {
  if (!Number.isFinite(positionSec) || positionSec < 0) return
  const now = Date.now()
  const elapsed = Math.max(0, (now - session.lastSampleAt) / 1000)
  const advancement = positionSec - session.lastPosition
  // Position alone is not a duration. Ignore backward/large forward seeks and
  // cap ordinary playback advancement by wall time; paused samples contribute 0.
  if (advancement > 0 && advancement <= elapsed * 2 + 0.5) {
    session.watchedSec += Math.min(advancement, elapsed)
  }
  session.lastPosition = positionSec
  session.lastSampleAt = now
}

export function heartbeat(libraryId: string, videoId: string, positionSec: number): void {
  const db = getDatabase(libraryId)
  const session = activeSessions.get(keyFor(libraryId, videoId))
  if (!db || !session) return
  sample(session, positionSec)
  // Persist cumulative duration on each heartbeat, so an unexpected exit loses
  // at most the current sampling interval rather than the entire viewing session.
  new PlayHistoryRepository(db).update(
    session.historyId,
    null,
    session.lastPosition,
    session.watchedSec,
  )
}

export function endPlayback(libraryId: string, videoId: string, positionSec: number): void {
  if (releasePlaybackCache(libraryId, videoId))
    void trimPlaybackCache().catch((error) => log.warn({ error }, '재생 캐시 정리 실패'))
  const key = keyFor(libraryId, videoId)
  const session = activeSessions.get(key)
  if (!session) return
  try {
    const db = getDatabase(libraryId)
    if (db) {
      sample(session, positionSec)
      new PlayHistoryRepository(db).update(
        session.historyId,
        new Date().toISOString(),
        session.lastPosition,
        session.watchedSec,
      )
    }
  } finally {
    activeSessions.delete(key)
    session.releaseSource()
  }
}

export function finishPlaybackSessions(libraryId?: string): void {
  for (const session of activeSessions.values()) {
    if (!libraryId || session.libraryId === libraryId)
      endPlayback(session.libraryId, session.videoId, session.lastPosition)
  }
}

export function resetPlaybackPosition(
  libraryId: string,
  videoId: string,
  positionSec: number,
): void {
  const session = activeSessions.get(keyFor(libraryId, videoId))
  if (!session || !Number.isFinite(positionSec) || positionSec < 0) return
  session.lastPosition = positionSec
  session.lastSampleAt = Date.now()
}

/** Persist an explicit seek without treating the jumped distance as watched time. */
export function recordSeek(libraryId: string, videoId: string, positionSec: number): void {
  if (!Number.isFinite(positionSec) || positionSec < 0) return
  resetPlaybackPosition(libraryId, videoId, positionSec)
  heartbeat(libraryId, videoId, positionSec)
}
