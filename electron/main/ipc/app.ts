import { app, dialog, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import { loadConfig, updateConfig } from '../infra/config'
import { getCacheInfo, cleanPlaybackCache, trimPlaybackCache } from '../services/CacheService'
import { discoverNativePlayers, validateNativePlayer } from '../services/NativePlayerService'

// This module is imported synchronously at startup, before whenReady registers IPC.
// Listen now so an update before handler registration is not lost. Electron 31's
// getGPUInfo('basic') resolves immediately and cannot establish feature readiness.
let gpuInfoReady = false
app.once('gpu-info-update', () => {
  gpuInfoReady = true
})

function getSettings() {
  const config = loadConfig()
  return { cacheLimitGb: config.cacheLimitGb ?? 10, nativePlayer: config.nativePlayer ?? null }
}

export function registerAppHandlers(): void {
  registerIpcHandler(IPC.APP.GET_ACCELERATION_INFO, () => {
    if (!gpuInfoReady) {
      return ok({ videoDecodeStatus: 'unknown', gpuCompositingStatus: 'unknown' })
    }
    const status = app.getGPUFeatureStatus()
    return ok({
      videoDecodeStatus: status.video_decode ?? 'unknown',
      gpuCompositingStatus: status.gpu_compositing ?? 'unknown',
    })
  })
  registerIpcHandler(IPC.APP.GET_NATIVE_PLAYERS, async () => ok(await discoverNativePlayers()))
  registerIpcHandler(IPC.APP.SELECT_NATIVE_PLAYER, async (event, name) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: `${name} 실행 파일 선택`,
      properties: ['openFile'],
      filters: [{ name: '실행 파일', extensions: ['exe'] }],
    }
    const choice = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (choice.canceled || !choice.filePaths[0]) return ok(null)
    return ok(await validateNativePlayer({ name, path: choice.filePaths[0] }))
  })
  registerIpcHandler(IPC.APP.GET_SETTINGS, () => ok(getSettings()))
  registerIpcHandler(IPC.APP.GET_CACHE_INFO, async () => ok(await getCacheInfo()))
  registerIpcHandler(IPC.APP.CLEAN_CACHE, async () => ok(await cleanPlaybackCache()))
  registerIpcHandler(IPC.APP.UPDATE_SETTINGS, async (_event, patch) => {
    if (patch.nativePlayer) patch.nativePlayer = await validateNativePlayer(patch.nativePlayer)
    updateConfig((config) => ({ ...config, ...patch }))
    if (patch.cacheLimitGb !== undefined) await trimPlaybackCache()
    return ok(getSettings())
  })
  registerIpcHandler(IPC.APP.QUIT, (event) => {
    // Escape closes the requesting window; pending jobs can keep it in the tray.
    const win = BrowserWindow.fromWebContents(event.sender)
    setImmediate(() => {
      if (win && !win.isDestroyed()) win.close()
    })
    return ok(null)
  })
}
