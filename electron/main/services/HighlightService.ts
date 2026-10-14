import { randomUUID } from 'crypto'
import { getDatabase } from '../db/connection'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { Highlight, HighlightCreate } from '@shared/types'
import { assertLibraryWorkAllowed } from './LibraryWorkService'

export function listHighlights(libraryId: string, videoId: string): Highlight[] {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  return new HighlightRepository(db).findByVideoId(videoId)
}

export function createHighlight(libraryId: string, data: HighlightCreate): Highlight {
  assertLibraryWorkAllowed(libraryId, 'thumbnails')
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')

  const highlight: Highlight = {
    id: randomUUID(),
    videoId: data.videoId,
    timeStart: data.timeStart,
    timeEnd: data.timeEnd,
    label: data.label,
    color: data.color ?? 'yellow',
    createdAt: new Date().toISOString(),
  }

  new HighlightRepository(db).insert(highlight)
  return highlight
}

export function updateHighlight(
  libraryId: string,
  id: string,
  patch: Partial<HighlightCreate>,
): void {
  assertLibraryWorkAllowed(libraryId, 'thumbnails')
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  new HighlightRepository(db).update(id, patch)
}

export function deleteHighlight(libraryId: string, id: string): void {
  assertLibraryWorkAllowed(libraryId, 'thumbnails')
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  new HighlightRepository(db).delete(id)
}
