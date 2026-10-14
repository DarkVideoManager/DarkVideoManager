import { execFile } from 'node:child_process'
import { createAbortError } from './queue'
import type { ProbeData } from '@shared/types'
import { createLogger } from '../infra/logger'
import { getFfprobePath } from './ffmpegPath'

const log = createLogger('ffprobe')

interface ProbeMetadata {
  streams: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
  }>
  format: { duration?: string | number; bit_rate?: string | number; format_name?: string }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
function frameRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return finiteNumber(value)
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0)
    return undefined
  return finiteNumber(numerator / denominator)
}

export async function probeVideo(filePath: string, signal?: AbortSignal): Promise<ProbeData> {
  if (signal?.aborted) throw createAbortError()
  return new Promise((resolve, reject) => {
    execFile(
      getFfprobePath(),
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
      { encoding: 'utf8', windowsHide: true, signal, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(createAbortError())
          return
        }
        if (error) {
          log.warn({ err: error, filePath }, 'ffprobe 실패')
          reject(error)
          return
        }
        let metadata: ProbeMetadata
        try {
          metadata = JSON.parse(stdout) as ProbeMetadata
          if (!metadata || !Array.isArray(metadata.streams) || !metadata.format)
            throw new Error('Invalid ffprobe metadata')
        } catch {
          reject(new Error('ffprobe가 올바른 JSON 메타데이터를 반환하지 않았습니다.'))
          return
        }
        const videoStream = (metadata.streams ?? []).find((stream) => stream.codec_type === 'video')
        const durationSec = finiteNumber(metadata.format.duration)
        const width = finiteNumber(videoStream?.width)
        const height = finiteNumber(videoStream?.height)
        const bitrate = finiteNumber(metadata.format.bit_rate)
        const fps = frameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate)

        resolve({
          durationSec,
          width: width === undefined ? undefined : Math.trunc(width),
          height: height === undefined ? undefined : Math.trunc(height),
          codec: videoStream?.codec_name,
          fps,
          bitrate: bitrate === undefined ? undefined : Math.round(bitrate / 1000),
          container: metadata.format.format_name?.split(',')[0],
        })
      },
    )
  })
}
