export function needsPlaybackProxy(filePath: string, codec?: string): boolean
export interface PlaybackProxyProgress {
  phase: 'checking' | 'remuxing' | 'transcoding' | 'validating' | 'completed'
  progress: number | null
  processedSec: number
  durationSec: number
}
export interface PlaybackProxyOptions {
  signal?: AbortSignal
  durationSec?: number
  onProgress?: (progress: PlaybackProxyProgress) => void
}
export function getCachedPlaybackProxy(
  sourcePath: string,
  outputDir: string,
  videoId: string,
  signal?: AbortSignal,
): Promise<string | null>
export function ensurePlaybackProxy(
  sourcePath: string,
  outputDir: string,
  videoId: string,
  codec?: string,
  options?: PlaybackProxyOptions,
): Promise<string>
export function drainPlaybackProxyWork(): Promise<void>
