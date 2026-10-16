import type { WebContents } from 'electron'
import type { Video } from '../../../src/shared/types'
export function openInMpv(
  mpvPath: string,
  libraryId: string,
  video: Video,
  startTimeSec: number,
  width: number | undefined,
  height: number | undefined,
  x: number | undefined,
  y: number | undefined,
  webContents: WebContents,
  playbackRate?: number,
): Promise<void>
export function seekMpvSession(
  libraryId: string,
  videoId: string,
  timeSec: number,
): Promise<boolean>
export function closeAllMpvSessions(): void

export function setMpvPlaybackRate(
  libraryId: string,
  videoId: string,
  rate: number,
): Promise<boolean>
