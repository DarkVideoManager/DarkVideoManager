// Recovered from the shipped 0.1.0 implementation and maintained as a focused service.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDatabase } from '../db/connection'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { getThumbnailsDir } from '../infra/paths'
import { generateThumbnails, extractThumbnailAtTime } from '../ffmpeg/thumbnail'
import { createLogger } from '../infra/logger'
import { IPC } from '../../../src/shared/ipc'
import {
  assertLibraryWorkAllowed,
  withLibraryWork,
  throwIfWorkCancelled,
} from './LibraryWorkService'
import { isAbortError } from '../ffmpeg/queue'
const log = createLogger('ThumbnailService')

async function withThumbnailWork(libraryId, operation) {
  return withLibraryWork(
    libraryId,
    async (signal) => {
      const root = path.resolve(getThumbnailsDir(libraryId))
      const outputDir = await fs.promises.mkdtemp(path.join(root, 'capture-'))
      const work = { signal, outputDir, committed: false }
      try {
        throwIfWorkCancelled(signal)
        return await operation(work)
      } finally {
        if (!work.committed) {
          // Only this invocation's newly created directory can be removed.
          const relative = path.relative(root, path.resolve(outputDir))
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Invalid thumbnail cleanup directory')
          await fs.promises.rm(outputDir, { recursive: true, force: true })
        }
      }
    },
    'thumbnails',
  )
}

export function ensureThumbnailForVideo(libraryId, videoId, webContents, force = false) {
  return withThumbnailWork(libraryId, (work) =>
    ensureThumbnailForVideoInternal(libraryId, videoId, webContents, force, work),
  )
}

async function ensureThumbnailForVideoInternal(libraryId, videoId, webContents, force, work) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const thumbnailRepo = new ThumbnailRepository(db)
  const existing = thumbnailRepo.findByVideoId(videoId)
  if (existing.length > 0 && !force) return false
  const videoRepo = new VideoRepository(db)
  const video = videoRepo.findById(videoId)
  if (!video) throw new Error('Video not found')
  const results = await generateThumbnails(
    video.filePath,
    work.outputDir,
    video.id,
    video.durationSec,
    work.signal,
  )
  throwIfWorkCancelled(work.signal)
  if (results.length === 0) {
    const fallbackTimes = buildFallbackTimes(video.durationSec)
    for (const timeSec of fallbackTimes) {
      try {
        const thumbnail = await captureThumbnailAtTimeInternal(
          libraryId,
          videoId,
          timeSec,
          webContents,
          false,
          true,
          work,
        )
        if (thumbnail) {
          return true
        }
      } catch (e) {
        if (isAbortError(e)) throw e
        log.warn({ err: e, libraryId, videoId, timeSec }, 'Fallback thumbnail capture failed')
      }
    }
    log.warn({ libraryId, videoId, filePath: video.filePath }, 'No thumbnails generated')
    return false
  }
  db.transaction(() => {
    if (force) thumbnailRepo.deleteByVideoId(videoId)
    const primaryIndex = Math.min(Math.floor(results.length / 2), results.length - 1)
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      thumbnailRepo.insert({
        id: crypto.randomUUID(),
        videoId: video.id,
        filePath: result.filePath,
        timeSec: result.timeSec,
        isPrimary: index === primaryIndex,
      })
    }
  }).immediate()
  work.committed = true
  notifyThumbnailReady(webContents, videoId)
  return true
}
export function captureThumbnailAtTime(
  libraryId,
  videoId,
  timeSec,
  webContents,
  notify = true,
  makePrimary = true,
) {
  return withThumbnailWork(libraryId, (work) =>
    captureThumbnailAtTimeInternal(
      libraryId,
      videoId,
      timeSec,
      webContents,
      notify,
      makePrimary,
      work,
    ),
  )
}

async function captureThumbnailAtTimeInternal(
  libraryId,
  videoId,
  timeSec,
  webContents,
  notify,
  makePrimary,
  work,
) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const videoRepo = new VideoRepository(db)
  const thumbnailRepo = new ThumbnailRepository(db)
  const video = videoRepo.findById(videoId)
  if (!video) throw new Error('Video not found')
  const outputDir = work.outputDir
  const requestedTimeSec = normalizeCaptureTime(timeSec, video.durationSec)
  const captureTimes = buildCaptureRetryTimes(requestedTimeSec, video.durationSec, makePrimary)
  let outputPath = null
  let resolvedTimeSec = requestedTimeSec
  let lastError = null
  for (const candidateTimeSec of captureTimes) {
    try {
      outputPath = await extractThumbnailAtTime(
        video.filePath,
        outputDir,
        video.id,
        candidateTimeSec,
        work.signal,
      )
      resolvedTimeSec = candidateTimeSec
      break
    } catch (error) {
      if (isAbortError(error)) throw error
      lastError = error
      log.warn(
        { err: error, libraryId, videoId, requestedTimeSec, candidateTimeSec },
        'Thumbnail capture retry failed',
      )
    }
  }
  if (!outputPath) {
    throw lastError instanceof Error ? lastError : new Error('Thumbnail capture failed')
  }
  throwIfWorkCancelled(work.signal)
  const thumbnail = {
    id: crypto.randomUUID(),
    videoId: video.id,
    filePath: outputPath,
    timeSec: resolvedTimeSec,
    isPrimary: makePrimary,
    createdAt: /* @__PURE__ */ new Date().toISOString(),
  }
  thumbnailRepo.insert({
    id: thumbnail.id,
    videoId: thumbnail.videoId,
    filePath: thumbnail.filePath,
    timeSec: thumbnail.timeSec,
    isPrimary: makePrimary,
  })
  // insert atomically updates the primary flag with the new thumbnail.
  work.committed = true
  if (notify) {
    notifyThumbnailReady(webContents, videoId)
  }
  return thumbnail
}
export function saveThumbnailImageCapture(
  libraryId,
  videoId,
  timeSec,
  dataUrl,
  webContents,
  makePrimary = true,
) {
  assertLibraryWorkAllowed(libraryId, 'thumbnails')
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const videoRepo = new VideoRepository(db)
  const thumbnailRepo = new ThumbnailRepository(db)
  const video = videoRepo.findById(videoId)
  if (!video) throw new Error('Video not found')
  const normalizedTimeSec = normalizeCaptureTime(timeSec, video.durationSec)
  const outputDir = getThumbnailsDir(libraryId)
  const outputPath = path.join(
    outputDir,
    `${video.id}_${Math.floor(normalizedTimeSec * 1e3)}_canvas_${Date.now()}.jpg`,
  )
  const bytes = decodeImageDataUrl(dataUrl)
  fs.writeFileSync(outputPath, bytes)
  const thumbnail = {
    id: crypto.randomUUID(),
    videoId: video.id,
    filePath: outputPath,
    timeSec: normalizedTimeSec,
    isPrimary: makePrimary,
    createdAt: /* @__PURE__ */ new Date().toISOString(),
  }
  thumbnailRepo.insert({
    id: thumbnail.id,
    videoId: thumbnail.videoId,
    filePath: thumbnail.filePath,
    timeSec: thumbnail.timeSec,
    isPrimary: makePrimary,
  })
  if (makePrimary) {
    // Repository maintains the primary flag atomically
    thumbnailRepo.setPrimary(thumbnail.id, videoId)
  }
  notifyThumbnailReady(webContents, videoId)
  return thumbnail
}
function buildFallbackTimes(durationSec) {
  const candidates = [0, 1, 2]
  if (durationSec && Number.isFinite(durationSec) && durationSec > 0) {
    candidates.push(durationSec * 0.25, durationSec * 0.5, Math.max(0, durationSec - 1))
  }
  return candidates
    .map((value) => Math.max(0, Math.floor(value)))
    .filter((value, index, array) => array.indexOf(value) === index)
}
function buildCaptureRetryTimes(timeSec, durationSec, makePrimary = true) {
  const safeDuration =
    durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : void 0
  const nearCandidates = [timeSec, timeSec - 1, timeSec + 1, timeSec - 2, timeSec + 2]
  const candidates = makePrimary
    ? [...nearCandidates, ...buildFallbackTimes(safeDuration)]
    : nearCandidates
  return candidates
    .map((value) => normalizeCaptureTime(value, safeDuration))
    .filter((value, index, array) => array.indexOf(value) === index)
}
function normalizeCaptureTime(timeSec, durationSec) {
  const safeDuration =
    durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : void 0
  const fallbackBase = safeDuration ? Math.min(1, Math.max(0, safeDuration - 0.25)) : 0
  const safeTime = Number.isFinite(timeSec) ? timeSec : fallbackBase
  if (!safeDuration) {
    return Math.max(0, safeTime)
  }
  return Math.max(0, Math.min(safeTime, Math.max(0, safeDuration - 0.25)))
}
function decodeImageDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:image\/(?:jpeg|jpg|png);base64,(.+)$/)
  if (!match) {
    throw new Error('Invalid image data')
  }
  return Buffer.from(match[1], 'base64')
}
function notifyThumbnailReady(webContents, videoId) {
  if (!webContents.isDestroyed()) {
    webContents.send(IPC.EVENTS.THUMBNAIL_READY, { videoId })
  }
}
