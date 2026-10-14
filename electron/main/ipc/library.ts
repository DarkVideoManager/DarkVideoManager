import { dialog, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { registerIpcHandler } from './index'
import { ok, err } from '@shared/result'
import {
  listLibraries,
  openLibrary,
  createLibrary,
  closeLibrary,
  deleteLibrary,
  importFolder,
  refreshLibrary,
} from '../services/LibraryService'
import { createLogger } from '../infra/logger'
import { cancelLibraryWork } from '../services/LibraryWorkService'

const log = createLogger('ipc:library')

export function registerLibraryHandlers(): void {
  registerIpcHandler(IPC.LIBRARY.CANCEL_WORK, (_event, libraryId) => ok(cancelLibraryWork(libraryId)))
  registerIpcHandler(IPC.LIBRARY.REFRESH, async (event, libraryId) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return err('윈도우를 찾을 수 없습니다')
    return ok(await refreshLibrary(libraryId, win))
  })
  registerIpcHandler(IPC.LIBRARY.LIST, () => {
    try {
      return ok(listLibraries())
    } catch (e) {
      log.error({ err: e }, 'library:list 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.OPEN, (_e, libraryId: string) => {
    try {
      return ok(openLibrary(libraryId))
    } catch (e) {
      log.error({ err: e }, 'library:open 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.CREATE, (_e, name: string, folderPath: string) => {
    try {
      return ok(createLibrary(name, folderPath))
    } catch (e) {
      log.error({ err: e }, 'library:create 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.CLOSE, (_e, libraryId: string) => {
    try {
      closeLibrary(libraryId)
      return ok(null)
    } catch (e) {
      log.error({ err: e }, 'library:close 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.DELETE, (_e, libraryId: string) => {
    try {
      deleteLibrary(libraryId)
      return ok(null)
    } catch (e) {
      log.error({ err: e }, 'library:delete 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.SELECT_FOLDER, async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return ok(null)
      return ok(result.filePaths[0])
    } catch (e) {
      log.error({ err: e }, 'library:selectFolder 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.LIBRARY.IMPORT_FOLDER, async (e, libraryId: string, folderPath: string) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return err('윈도우를 찾을 수 없습니다')
      const result = await importFolder(libraryId, folderPath, win)
      return ok(result)
    } catch (e) {
      log.error({ err: e }, 'library:importFolder 오류')
      return err((e as Error).message)
    }
  })
}
