import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import {
  previewFilenameCleanup,
  applyFilenameCleanup,
  findExactDuplicates,
  cancelLibraryMaintenance,
} from '../services/LibraryMaintenanceService'

export function registerMaintenanceHandlers(): void {
  registerIpcHandler(IPC.MAINTENANCE.CANCEL, (_event, libraryId) =>
    ok(cancelLibraryMaintenance(libraryId)),
  )
  registerIpcHandler(IPC.MAINTENANCE.PREVIEW_NAMES, async (_event, libraryId, rule) =>
    ok(await previewFilenameCleanup(libraryId, rule)),
  )
  registerIpcHandler(IPC.MAINTENANCE.APPLY_NAMES, async (_event, libraryId, previewId, videoIds) =>
    ok(await applyFilenameCleanup(libraryId, previewId, videoIds)),
  )
  registerIpcHandler(IPC.MAINTENANCE.FIND_DUPLICATES, async (_event, libraryId) =>
    ok(await findExactDuplicates(libraryId)),
  )
}
