// Recovered from the shipped 0.1.0 implementation and maintained as a focused service.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import ffmpeg from 'fluent-ffmpeg'
import { getFfmpegPath, getFfprobePath } from './ffmpegPath'
import { createLogger } from '../infra/logger'
import { beginPlaybackCacheLease } from '../services/CacheService'
import { createAbortError } from './queue'
import { needsCompatiblePlayback, needsVideoTranscode } from '@shared/playback'
const log = createLogger('playback')
const PLAYBACK_PROXY_VERSION = 'v3'
let pathsSet = false
function ensurePaths() {
  if (pathsSet) return
  ffmpeg.setFfmpegPath(getFfmpegPath())
  ffmpeg.setFfprobePath(getFfprobePath())
  pathsSet = true
}
export function needsPlaybackProxy(filePath, codec) {
  return needsCompatiblePlayback(filePath, codec)
}
function throwIfCancelled(signal) {
  if (signal?.aborted) throw createAbortError()
}
async function generatePlaybackProxy(sourcePath, outputDir, videoId, signal, codec, report) {
  throwIfCancelled(signal)
  ensurePaths()
  const outputPath = path.join(outputDir, `${videoId}.${PLAYBACK_PROXY_VERSION}.mp4`)
  const tempPath = `${outputPath}.tmp`
  const metadataPath = outputPath + '.source.json'
  const lease = beginPlaybackCacheLease(path.basename(outputDir), videoId + ':generation')
  let committed = false
  let validated = false
  let rebuilding = false
  let replacedOutput = false
  try {
    // Reserve the whole output/temp/fingerprint group before the first await.
    lease(outputPath)
    lease(tempPath)
    lease(metadataPath)
    validated = true
    const sourceStat = fs.statSync(sourcePath)
    report('checking', 0)
    const fingerprint = JSON.stringify({ size: sourceStat.size, mtimeMs: sourceStat.mtimeMs })
    let cachedFingerprint
    try {
      cachedFingerprint = fs.readFileSync(metadataPath, 'utf8')
    } catch {
      /* first generation */
    }
    if (
      cachedFingerprint === fingerprint &&
      fs.existsSync(outputPath) &&
      (await isPlayableMp4(outputPath, signal))
    ) {
      const now = new Date()
      fs.utimesSync(outputPath, now, now)
      fs.utimesSync(metadataPath, now, now)
      committed = true
      report('completed')
      return outputPath
    }
    rebuilding = true
    safeRemove$1(tempPath)
    if (needsVideoTranscode(codec)) {
      await transcodeToMp4(sourcePath, tempPath, signal, report)
      report('validating')
      if (!(await isPlayableMp4(tempPath, signal))) {
        throw new Error('Generated playback proxy is invalid')
      }
    } else {
      await remuxToMp4(sourcePath, tempPath, signal, report)
      report('validating')
      if (!(await isPlayableMp4(tempPath, signal))) {
        safeRemove$1(tempPath)
        await transcodeToMp4(sourcePath, tempPath, signal, report)
        report('validating')
        if (!(await isPlayableMp4(tempPath, signal))) {
          throw new Error('Generated playback proxy is invalid')
        }
      }
    }
    throwIfCancelled(signal)
    fs.renameSync(tempPath, outputPath)
    replacedOutput = true
    fs.writeFileSync(metadataPath, fingerprint, 'utf8')
    committed = true
    report('completed')
    return outputPath
  } finally {
    if (validated && rebuilding) safeRemove$1(tempPath)
    if (validated && replacedOutput && !committed) {
      safeRemove$1(outputPath)
      safeRemove$1(metadataPath)
    }
    lease.release()
    // The caller pins the returned path immediately. Do not await cache cleanup
    // here: it could delete the completed proxy before ownership transfers.
  }
}
async function remuxToMp4(sourcePath, outputPath, signal, report) {
  report('remuxing', 0)
  try {
    await runConversion(
      ffmpeg(sourcePath)
        .format('mp4')
        .outputOptions(['-c:v copy', '-c:a aac', '-movflags +faststart', '-fflags +genpts'])
        .output(outputPath),
      signal,
      report,
      'remuxing',
    )
  } catch (error) {
    throwIfCancelled(signal)
    log.warn({ err: error, sourcePath }, 'Copy remux failed, retrying with full transcode')
    safeRemove$1(outputPath)
    await transcodeToMp4(sourcePath, outputPath, signal, report)
  }
}
function transcodeToMp4(sourcePath, outputPath, signal, report) {
  report('transcoding', 0)
  return runConversion(
    ffmpeg(sourcePath)
      .format('mp4')
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset veryfast', '-pix_fmt yuv420p', '-movflags +faststart'])
      .output(outputPath),
    signal,
    report,
    'transcoding',
  )
}
function runConversion(command, signal, report, phase) {
  return new Promise((resolve, reject) => {
    let settled = false
    let killTimer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(createAbortError())
      else if (error) reject(error)
      else resolve()
    }
    const abort = () => {
      try {
        command.kill('SIGTERM')
      } catch {
        /* already exited or not started yet */
      }
      if (!killTimer)
        killTimer = setTimeout(() => {
          killTimer = undefined
          try {
            command.kill('SIGKILL')
          } catch {
            /* already exited */
          }
        }, 1000)
      // Await fluent-ffmpeg's terminal event before releasing its lease or files.
    }
    command
      .on('codecData', (data) => report(phase, undefined, parseTimemark(data.duration)))
      .on('progress', (progress) => {
        const seconds = parseTimemark(progress.timemark)
        if (seconds !== undefined) report(phase, seconds)
      })
      .on('start', () => {
        if (signal?.aborted) abort()
      })
      .on('end', () => finish())
      .on('error', (error) => finish(error))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      finish(createAbortError())
      return
    }
    try {
      command.run()
    } catch (error) {
      finish(error)
    }
  })
}
function isPlayableMp4(filePath, signal) {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    let killTimer
    const abort = () => {
      child.kill('SIGTERM')
      if (!killTimer)
        killTimer = setTimeout(() => {
          killTimer = undefined
          child.kill('SIGKILL')
        }, 1000)
    }
    // Manual cancellation intentionally waits for execFile's close callback;
    // rejecting at the AbortSignal error alone can precede process termination.
    const child = execFile(
      getFfprobePath(),
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        clearTimeout(killTimer)
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) {
          reject(createAbortError())
          return
        }
        if (error) {
          resolve(false)
          return
        }
        try {
          const metadata = JSON.parse(stdout)
          resolve(
            Number(metadata?.format?.duration) > 0 &&
              metadata?.streams?.some(
                (stream) =>
                  stream.codec_type === 'video' &&
                  ['h264', 'av1', 'vp9'].includes(stream.codec_name),
              ),
          )
        } catch {
          resolve(false)
        }
      },
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
function safeRemove$1(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (err2) {
    log.warn({ err: err2, filePath }, 'Failed to remove stale playback proxy')
  }
}

const inFlight = new Map()
const cacheChecks = new Set()
let stopping = false
function parseTimemark(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** Cache inspection never starts FFmpeg, so a ready video can bypass a busy queue. */
async function checkCachedPlaybackProxy(sourcePath, outputDir, videoId, signal) {
  throwIfCancelled(signal)
  const outputPath = path.join(outputDir, `${videoId}.${PLAYBACK_PROXY_VERSION}.mp4`)
  const metadataPath = outputPath + '.source.json'
  const lease = beginPlaybackCacheLease(
    path.basename(outputDir),
    videoId + ':cache-check:' + randomUUID(),
  )
  try {
    lease(outputPath)
    lease(metadataPath)
    const info = fs.statSync(sourcePath)
    const expected = JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs })
    if (!fs.existsSync(outputPath) || !fs.existsSync(metadataPath)) return null
    if (fs.readFileSync(metadataPath, 'utf8') !== expected) return null
    if (!(await isPlayableMp4(outputPath, signal))) return null
    const now = new Date()
    fs.utimesSync(outputPath, now, now)
    fs.utimesSync(metadataPath, now, now)
    return outputPath
  } finally {
    lease.release()
  }
}

export function getCachedPlaybackProxy(sourcePath, outputDir, videoId, signal) {
  if (stopping) return Promise.reject(createAbortError())
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const item = { controller, work: undefined }
  item.work = checkCachedPlaybackProxy(sourcePath, outputDir, videoId, controller.signal).finally(
    () => {
      signal?.removeEventListener('abort', abort)
      cacheChecks.delete(item)
    },
  )
  cacheChecks.add(item)
  return item.work
}

export function ensurePlaybackProxy(sourcePath, outputDir, videoId, codec, options = {}) {
  if (stopping) return Promise.reject(createAbortError())
  const key = path.join(outputDir, videoId)
  if (inFlight.has(key)) return inFlight.get(key).work
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  let durationSec =
    Number.isFinite(options.durationSec) && options.durationSec > 0 ? options.durationSec : 0
  let processedSec = 0
  const report = (phase, seconds, detectedDuration) => {
    if (detectedDuration > 0 && !durationSec) durationSec = detectedDuration
    if (seconds !== undefined) processedSec = Math.max(0, seconds)
    try {
      options.onProgress?.({
        phase,
        processedSec,
        durationSec,
        progress:
          phase === 'completed'
            ? 100
            : durationSec > 0
              ? Math.min(99.9, (processedSec / durationSec) * 100)
              : null,
      })
    } catch (error) {
      log.warn({ error }, 'Playback progress listener failed')
    }
  }
  const work = generatePlaybackProxy(
    sourcePath,
    outputDir,
    videoId,
    controller.signal,
    codec,
    report,
  ).finally(() => {
    options.signal?.removeEventListener('abort', abort)
    inFlight.delete(key)
  })
  inFlight.set(key, { work, controller })
  return work
}

/** Stop accepting proxies and wait for cancellation, process exit, and cleanup. */
export async function drainPlaybackProxyWork() {
  stopping = true
  for (const { controller } of inFlight.values()) controller.abort()
  for (const { controller } of cacheChecks) controller.abort()
  while (inFlight.size || cacheChecks.size) {
    await Promise.allSettled([...inFlight.values(), ...cacheChecks].map(({ work }) => work))
  }
}
