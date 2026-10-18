import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { IPC } from '@shared/channels'
import { loadConfig, updateConfig } from '../infra/config'
import { AppUpdateService } from './AppUpdateService'

let service: AppUpdateService | undefined

export function getAppUpdates(): AppUpdateService {
  if (service) return service
  const packaged = app.isPackaged && process.platform === 'win32'
  const portable =
    !!process.env['PORTABLE_EXECUTABLE_FILE'] || !!process.env['PORTABLE_EXECUTABLE_DIR']
  const mode = !packaged
    ? 'development'
    : portable
      ? 'portable'
      : existsSync(join(dirname(app.getPath('exe')), 'Uninstall DarkVideoManager.exe'))
        ? 'installer'
        : 'unpacked'
  const enabled = mode === 'installer' || mode === 'portable'
  // The public feed is embedded by electron-builder; no renderer URL or account token is accepted.
  const engine = enabled ? new NsisUpdater() : undefined
  if (engine) engine.logger = null
  service = new AppUpdateService({
    mode,
    version: app.getVersion(),
    engine,
    automatic: loadConfig().autoUpdateEnabled ?? true,
    saveAutomatic: (value) => updateConfig((config) => ({ ...config, autoUpdateEnabled: value })),
    requestQuit: () => setImmediate(() => app.quit()),
  })
  service.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        try {
          win.webContents.send(IPC.EVENTS.APP_UPDATE_CHANGED, state)
        } catch {
          /* window closed during the broadcast */
        }
      }
    }
  })
  return service
}

export function initializeAppUpdates(): void {
  getAppUpdates().start()
}
export function stopAppUpdateChecks(): void {
  service?.stop()
}
export function finishAppUpdateInstall(safe: boolean): void {
  service?.finishInstall(safe)
}
export async function openAppRelease(): Promise<void> {
  await shell.openExternal('https://github.com/DarkVideoManager/DarkVideoManager/releases/latest')
}
