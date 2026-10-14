import type { WebContents } from 'electron'
import type { Thumbnail } from '../../../src/shared/types'
export function ensureThumbnailForVideo(
  libraryId: string,
  videoId: string,
  webContents: WebContents,
  force?: boolean,
): Promise<boolean>
export function captureThumbnailAtTime(
  libraryId: string,
  videoId: string,
  timeSec: number,
  webContents: WebContents,
  notify?: boolean,
  makePrimary?: boolean,
): Promise<Thumbnail>
export function saveThumbnailImageCapture(
  libraryId: string,
  videoId: string,
  timeSec: number,
  dataUrl: string,
  webContents: WebContents,
  makePrimary?: boolean,
): Thumbnail
