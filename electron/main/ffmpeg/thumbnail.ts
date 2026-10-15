import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { createLogger } from '../infra/logger'
import { getFfmpegPath } from './ffmpegPath'
import { createAbortError, isAbortError } from './queue'

const log = createLogger('thumbnail')

export const THUMBNAIL_TIMEOUT_MS = 30_000

export class ThumbnailTimeoutError extends Error {
  constructor() {
    super('썸네일 추출 제한 시간(30초)을 초과했습니다.')
    this.name = 'ThumbnailTimeoutError'
  }
}

export function isThumbnailTimeoutError(error: unknown): error is ThumbnailTimeoutError {
  return error instanceof Error && error.name === 'ThumbnailTimeoutError'
}

function removePartial(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // Windows may still hold the file until the terminated process closes it.
  }
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
  if (signal?.aborted) throw createAbortError()
  const safeDuration =
    durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 10

  mkdirSync(outputDir, { recursive: true })
  const results: ThumbnailResult[] = []

  for (const [index, percentage] of PERCENTAGES.entries()) {
    if (signal?.aborted) {
      for (const result of results) removePartial(result.filePath)
      throw createAbortError()
    }
    const timeSec = safeDuration * percentage
    const outputPath = join(outputDir, `${videoId}_${index}.jpg`)

    try {
      await extractFrame(videoPath, outputPath, timeSec, signal)
      results.push({ filePath: outputPath, timeSec })
    } catch (error) {
      if (isAbortError(error) || isThumbnailTimeoutError(error)) {
        for (const result of results) removePartial(result.filePath)
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
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }
    // An aborted process can close after the caller starts another capture. Only
    // publish a completed frame; late cleanup must never delete the next frame.
    const partialPath = join(dirname(outputPath), `.frame-${randomUUID()}.jpg`)
    const child = spawn(
      getFfmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-ss',
        String(timeSec),
        '-i',
        videoPath,
        '-map',
        '0:V:0',
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=480:-2',
        '-pix_fmt',
        'yuvj420p',
        partialPath,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let settled = false
    let terminationError: Error | undefined
    let stderr = ''
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) {
        removePartial(partialPath)
        reject(error)
      } else {
        resolve()
      }
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // It may already have exited. The close handler still cleans its file.
      }
    }
    const stop = (error: Error) => {
      if (settled) return
      terminationError = error
      kill()
      // Queue slots cannot depend on a process delivering a terminal event.
      finish(error)
    }
    const abort = () => stop(createAbortError())
    const timer = setTimeout(() => stop(new ThumbnailTimeoutError()), THUMBNAIL_TIMEOUT_MS)

    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8192)
    })
    child.on('spawn', () => {
      if (terminationError) kill()
    })
    child.on('error', (error) => finish(terminationError ?? error))
    child.on('close', (code) => {
      if (settled) {
        removePartial(partialPath)
        return
      }
      if (terminationError || signal?.aborted) {
        finish(terminationError ?? createAbortError())
      } else if (code !== 0) {
        finish(new Error(`FFmpeg 썸네일 추출 실패 (${code}): ${stderr.trim()}`))
      } else {
        try {
          if (statSync(partialPath).size === 0) throw new Error('Empty thumbnail')
          renameSync(partialPath, outputPath)
          finish()
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })

    if (signal) signal.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function extractThumbnailAtTime(
  videoPath: string,
  outputDir: string,
  videoId: string,
  timeSec: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw createAbortError()
  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(
    outputDir,
    videoId + '_' + Math.floor(timeSec * 1000) + '_' + Date.now() + '.jpg',
  )
  await extractFrame(videoPath, outputPath, Math.max(0, timeSec), signal)
  return outputPath
}
