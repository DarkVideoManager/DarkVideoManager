import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { previewCsvImport, importCsvData } from '../services/DataImportService'
import { registerIpcHandler } from './index'
import type { ImportProgress } from '@shared/types'

function progressFor(event: IpcMainInvokeEvent) {
  return (progress: ImportProgress) => {
    if (!event.sender.isDestroyed()) event.sender.send(IPC.EVENTS.IMPORT_PROGRESS, progress)
  }
}

async function selectImportFile(event: IpcMainInvokeEvent, name: string, extensions: string[]) {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name, extensions }],
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  return ok(result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0])
}

export function registerDataImportHandlers(): void {
  registerIpcHandler(IPC.DATA_IMPORT.SELECT_CSV, (event) =>
    selectImportFile(event, 'CSV files', ['csv']),
  )
  registerIpcHandler(IPC.DATA_IMPORT.PREVIEW, async (event, libraryId, csvPath) =>
    ok(await previewCsvImport(libraryId, csvPath, progressFor(event))),
  )
  registerIpcHandler(IPC.DATA_IMPORT.IMPORT, async (event, libraryId, csvPath, options) =>
    ok(await importCsvData(libraryId, csvPath, options, progressFor(event))),
  )
}
