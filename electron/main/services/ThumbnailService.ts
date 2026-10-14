import { getDatabase } from '../db/connection'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { Thumbnail } from '@shared/types'

export function getThumbnailsForVideo(libraryId: string, videoId: string): Thumbnail[] {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  return new ThumbnailRepository(db).findByVideoId(videoId)
}

export function setPrimaryThumbnail(libraryId: string, thumbnailId: string, videoId: string): void {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  new ThumbnailRepository(db).setPrimary(thumbnailId, videoId)
}

export {
  ensureThumbnailForVideo,
  captureThumbnailAtTime,
  saveThumbnailImageCapture,
} from './ThumbnailCaptureService.js'
