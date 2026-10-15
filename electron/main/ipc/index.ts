import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, IPC_SCHEMAS, type InvokeChannel, type InvokeArgs } from '@shared/ipc'
import { isLibraryWorkBlocked, type LibraryWorkKind } from '../services/LibraryWorkService'
import { createLogger } from '../infra/logger'
import { isTrustedIpcSender } from '../infra/windowSecurity'
import { registerHighlightHandlers } from './highlights'
import { registerLibraryHandlers } from './library'
import { registerPlaybackHandlers } from './playback'
import { registerStatsHandlers } from './stats'
import { registerThumbnailHandlers } from './thumbnails'
import { registerVideoHandlers } from './videos'
import { registerMetadataImportHandlers } from './metadataImport'
import { registerAppHandlers } from './app'
import { registerDataImportHandlers } from './dataImport'
import { registerSubtitleGenerationHandlers } from './subtitleGeneration'
import { registerDiscoveryHandlers } from './discovery'
import { registerMaintenanceHandlers } from './maintenance'

const log = createLogger('ipc:index')
const mutationWorkKinds = new Map<string, LibraryWorkKind>([
  [IPC.LIBRARY.CLOSE, 'exclusive'],
  [IPC.LIBRARY.DELETE, 'exclusive'],
  [IPC.VIDEOS.UPDATE_META, 'exclusive'],
  [IPC.METADATA_IMPORT.APPLY, 'exclusive'],
  [IPC.VIDEOS.DELETE, 'exclusive'],
  [IPC.VIDEOS.RESTORE, 'exclusive'],
  [IPC.HIGHLIGHTS.CREATE, 'thumbnails'],
  [IPC.HIGHLIGHTS.UPDATE, 'thumbnails'],
  [IPC.HIGHLIGHTS.DELETE, 'thumbnails'],
  [IPC.THUMBNAILS.SET_PRIMARY, 'thumbnails'],
  [IPC.THUMBNAILS.ENSURE_FOR_VIDEO, 'thumbnails'],
  [IPC.THUMBNAILS.CAPTURE_AT_TIME, 'thumbnails'],
  [IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE, 'thumbnails'],
])

type IpcHandler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeArgs<C>
) => unknown

export function registerIpcHandler<C extends InvokeChannel>(
  channel: C,
  handler: IpcHandler<C>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      return { ok: false, error: '허용되지 않은 화면의 요청입니다.' }
    }
    const parsed = IPC_SCHEMAS[channel].safeParse(args)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false, error: `잘못된 IPC 입력: ${issue?.message ?? '검증 실패'}` }
    }

    try {
      const libraryId = parsed.data[0]
      const workKind = mutationWorkKinds.get(channel)
      if (workKind && typeof libraryId === 'string' && isLibraryWorkBlocked(libraryId, workKind))
        return {
          ok: false,
          error: '진행 중인 라이브러리 작업을 완료하거나 취소한 뒤 다시 시도하세요.',
        }
      return await handler(event, ...(parsed.data as InvokeArgs<C>))
    } catch (error) {
      log.error({ err: error, channel }, 'IPC 처리 실패')
      return { ok: false, error: error instanceof Error ? error.message : '알 수 없는 IPC 오류' }
    }
  })
}

export function registerAllHandlers(): void {
  registerDiscoveryHandlers()
  registerAppHandlers()
  registerDataImportHandlers()
  registerLibraryHandlers()
  registerVideoHandlers()
  registerMetadataImportHandlers()
  registerPlaybackHandlers()
  registerThumbnailHandlers()
  registerHighlightHandlers()
  registerStatsHandlers()
  registerSubtitleGenerationHandlers()
  registerMaintenanceHandlers()
  log.info('모든 IPC 핸들러 등록 완료')
}
