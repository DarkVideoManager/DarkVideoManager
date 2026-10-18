import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import { getAppUpdates, openAppRelease } from '../services/AppUpdateRuntime'

export function registerAppUpdateHandlers(): void {
  registerIpcHandler(IPC.APP_UPDATE.GET, () => ok(getAppUpdates().getState()))
  registerIpcHandler(IPC.APP_UPDATE.CHECK, async () => ok(await getAppUpdates().check()))
  registerIpcHandler(IPC.APP_UPDATE.DOWNLOAD, async () => ok(await getAppUpdates().download()))
  registerIpcHandler(IPC.APP_UPDATE.INSTALL, () => ok(getAppUpdates().requestInstall()))
  registerIpcHandler(IPC.APP_UPDATE.SET_AUTOMATIC, (_event, value) =>
    ok(getAppUpdates().setAutomatic(value)),
  )
  registerIpcHandler(IPC.APP_UPDATE.OPEN_RELEASE, async () => {
    await openAppRelease()
    return ok(null)
  })
}
