import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import {
  queryDiscovery,
  setDiscoveryFavorite,
  setDiscoveryTags,
} from '../services/DiscoveryService'
import {
  getPrivacySettings,
  savePrivacySettings,
  exitPrivateView,
} from '../services/PrivacyService'

export function registerDiscoveryHandlers() {
  registerIpcHandler(IPC.DISCOVERY.QUERY, (_event, libraryId, query) =>
    ok(queryDiscovery(libraryId, query)),
  )
  registerIpcHandler(IPC.DISCOVERY.FAVORITE, (_event, libraryId, videoId, favorite) =>
    ok(setDiscoveryFavorite(libraryId, videoId, favorite)),
  )
  registerIpcHandler(IPC.DISCOVERY.TAGS, (_event, libraryId, tags) =>
    ok(setDiscoveryTags(libraryId, tags)),
  )
  registerIpcHandler(IPC.PRIVACY.GET, () => ok(getPrivacySettings()))
  registerIpcHandler(IPC.PRIVACY.SAVE, (_event, settings) => ok(savePrivacySettings(settings)))
  registerIpcHandler(IPC.PRIVACY.EXIT, async () => ok(await exitPrivateView()))
}
