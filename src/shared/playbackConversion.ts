export interface PlaybackConversionJob {
  id: string
  libraryId: string
  videoId: string
  title: string
  fileName: string
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed'
  phase: 'waiting' | 'checking' | 'remuxing' | 'transcoding' | 'validating' | 'completed'
  /** Real encoded media time / duration, or null while progress is unknown. */
  progress: number | null
  processedSec: number
  durationSec: number
  createdAt: string
  updatedAt: string
  error?: string
  queuePosition?: number
}
