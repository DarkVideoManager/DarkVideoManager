import { IPC } from '@shared/ipc'
import { registerIpcHandler } from './index'
import { ok, err } from '@shared/result'
import { HighlightCreate } from '@shared/types'
import {
  listHighlights,
  createHighlight,
  updateHighlight,
  deleteHighlight,
} from '../services/HighlightService'
import { createLogger } from '../infra/logger'

const log = createLogger('ipc:highlights')

export function registerHighlightHandlers(): void {
  registerIpcHandler(IPC.HIGHLIGHTS.LIST, (_e, libraryId: string, videoId: string) => {
    try {
      return ok(listHighlights(libraryId, videoId))
    } catch (e) {
      log.error({ err: e }, 'highlights:list 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.HIGHLIGHTS.CREATE, (_e, libraryId: string, data: HighlightCreate) => {
    try {
      return ok(createHighlight(libraryId, data))
    } catch (e) {
      log.error({ err: e }, 'highlights:create 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.HIGHLIGHTS.UPDATE, (_e, libraryId: string, id: string, patch: Partial<HighlightCreate>) => {
    try {
      updateHighlight(libraryId, id, patch)
      return ok(null)
    } catch (e) {
      log.error({ err: e }, 'highlights:update 오류')
      return err((e as Error).message)
    }
  },)

  registerIpcHandler(IPC.HIGHLIGHTS.DELETE, (_e, libraryId: string, id: string) => {
    try {
      deleteHighlight(libraryId, id)
      return ok(null)
    } catch (e) {
      log.error({ err: e }, 'highlights:delete 오류')
      return err((e as Error).message)
    }
  })
}
