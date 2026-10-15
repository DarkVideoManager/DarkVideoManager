import { getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { loadConfig, updateConfig } from '../infra/config'
import { discoverVideos, type DiscoveryQuery } from '@shared/discovery'

function registeredLibrary(libraryId: string) {
  const config = loadConfig()
  if (!config.libraries.some((library) => library.id === libraryId))
    throw new Error('등록된 라이브러리를 찾을 수 없습니다.')
  return config
}
export function getDiscoveryPreferences(libraryId: string) {
  return (
    registeredLibrary(libraryId).discoveryPreferences?.[libraryId] ?? {
      favoriteVideoIds: [],
      preferredTags: [],
    }
  )
}
function repository(libraryId: string) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리를 연 뒤 다시 시도하세요.')
  return new VideoRepository(db)
}
export function queryDiscovery(libraryId: string, query: DiscoveryQuery) {
  const preferences = getDiscoveryPreferences(libraryId)
  return discoverVideos(repository(libraryId).listAll(), preferences, query)
}
export function setDiscoveryFavorite(libraryId: string, videoId: string, favorite: boolean) {
  registeredLibrary(libraryId)
  const video = repository(libraryId).findById(videoId)
  if (!video || video.removalMode) throw new Error('현재 라이브러리에 있는 영상을 선택하세요.')
  updateConfig((config) => {
    const previous = config.discoveryPreferences?.[libraryId] ?? {
      favoriteVideoIds: [],
      preferredTags: [],
    }
    const ids = new Set(previous.favoriteVideoIds)
    if (favorite) ids.add(videoId)
    else ids.delete(videoId)
    return {
      ...config,
      discoveryPreferences: {
        ...config.discoveryPreferences,
        [libraryId]: { ...previous, favoriteVideoIds: [...ids] },
      },
    }
  })
  return getDiscoveryPreferences(libraryId)
}
export function setDiscoveryTags(libraryId: string, tags: string[]) {
  registeredLibrary(libraryId)
  updateConfig((config) => {
    const previous = config.discoveryPreferences?.[libraryId] ?? {
      favoriteVideoIds: [],
      preferredTags: [],
    }
    return {
      ...config,
      discoveryPreferences: {
        ...config.discoveryPreferences,
        [libraryId]: {
          ...previous,
          preferredTags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))],
        },
      },
    }
  })
  return getDiscoveryPreferences(libraryId)
}
