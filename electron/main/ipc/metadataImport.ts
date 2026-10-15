import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import { getDatabase } from '../db/connection'
import { getStashMetadataService } from '../services/StashMetadataService'
import { applyImportedMetadata } from '../services/MetadataApplyService'

export function registerMetadataImportHandlers(): void {
  registerIpcHandler(IPC.METADATA_IMPORT.GET_SETTINGS, () =>
    ok(getStashMetadataService().getSettings()),
  )
  registerIpcHandler(IPC.METADATA_IMPORT.UPDATE_SETTINGS, (_event, patch) =>
    ok(getStashMetadataService().updateSettings(patch)),
  )
  registerIpcHandler(IPC.METADATA_IMPORT.SEARCH, async (_event, query, mode) =>
    ok(await getStashMetadataService().search(query, mode)),
  )
  registerIpcHandler(IPC.METADATA_IMPORT.APPLY, (_event, libraryId, videoId, input) => {
    const db = getDatabase(libraryId)
    if (!db) throw new Error('라이브러리가 열려 있지 않습니다.')
    return ok(applyImportedMetadata(db, videoId, input))
  })
}
