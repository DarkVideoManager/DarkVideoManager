import ffmpeg from 'fluent-ffmpeg'
import { mkdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../infra/logger'
import { getFfmpegPath, getFfprobePath } from './ffmpegPath'
import { createAbortError, isAbortError } from './queue'

const log = createLogger('thumbnail')

let ffmpegPathSet = false

function ensurePaths(): void {
  if (ffmpegPathSet) return
  ffmpeg.setFfmpegPath(getFfmpegPath())
  ffmpeg.setFfprobePath(getFfprobePath())
  ffmpegPathSet = true
}

const PERCENTAGES = [0.1, 0.3, 0.5, 0.7, 0.9] as const

export interface ThumbnailResult {
  filePath: string
  timeSec: number
}

export type ThumbnailProgressHandler = (completed: number, total: number) => void

export async function generateThumbnails(
  videoPath: string,
  outputDir: string,
  videoId: string,
  durationSec?: number,
  signal?: AbortSignal,
  onProgress?: ThumbnailProgressHandler,
): Promise<ThumbnailResult[]> {
  ensurePaths()
  if (signal?.aborted) throw createAbortError()
  const safeDuration =
    durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 10

  mkdirSync(outputDir, { recursive: true })
  const results: ThumbnailResult[] = []

  for (const [index, percentage] of PERCENTAGES.entries()) {
    if (signal?.aborted) throw createAbortError()
    const timeSec = safeDuration * percentage
    const outputPath = join(outputDir, `${videoId}_${index}.jpg`)

    try {
      await extractFrame(videoPath, outputPath, timeSec, signal)
      results.push({ filePath: outputPath, timeSec })
    } catch (error) {
      if (isAbortError(error)) {
        try {
          rmSync(outputPath, { force: true })
        } catch {
          // A partially written frame is best-effort cleanup.
        }
        throw error
      }
      log.warn({ err: error, videoId, timeSec }, '썸네일 추출 실패')
    } finally {
      onProgress?.(index + 1, PERCENTAGES.length)
    }
  }

  return results
}

function extractFrame(
  videoPath: string,
  outputPath: string,
  timeSec: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(videoPath)
      .seekInput(timeSec)
      .frames(1)
      .output(outputPath)
      .outputOptions(['-q:v', '3', '-vf', 'scale=480:-2'])

    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const abort = () => {
      try {
        command.kill('SIGTERM')
      } catch {
        // The process may have exited before the abort signal was delivered.
      }
      // Wait for the terminal event before deleting output files. Cancellation can
      // arrive while fluent-ffmpeg is preparing a process that has not started yet.
    }

    command
      .on('start', () => {
        if (signal?.aborted) abort()
      })
      .on('end', () =>
        finish(() => {
          if (signal?.aborted) {
            reject(createAbortError())
            return
          }
          try {
            if (statSync(outputPath).size === 0) throw new Error('Empty thumbnail')
            resolve()
          } catch (error) {
            reject(error)
          }
        }),
      )
      .on('error', (error) => {
        if (signal?.aborted) {
          finish(() => reject(createAbortError()))
          return
        }
        finish(() => reject(error))
      })

    if (signal) signal.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      finish(() => reject(createAbortError()))
      return
    }
    command.run()
  })
}

export async function extractThumbnailAtTime(
  videoPath: string,
  outputDir: string,
  videoId: string,
  timeSec: number,
  signal?: AbortSignal,
): Promise<string> {
  ensurePaths()
  if (signal?.aborted) throw createAbortError()
  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(
    outputDir,
    videoId + '_' + Math.floor(timeSec * 1000) + '_' + Date.now() + '.jpg',
  )
  try {
    await extractFrame(videoPath, outputPath, Math.max(0, timeSec), signal)
    return outputPath
  } catch (error) {
    rmSync(outputPath, { force: true })
    throw error
  }
}
