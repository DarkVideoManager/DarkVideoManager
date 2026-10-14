import { app, BrowserWindow, dialog } from 'electron'
import { join, resolve } from 'path'
import { mkdirSync } from 'fs'
import { pathToFileURL } from 'node:url'
import { registerMediaScheme, registerLocalMediaProtocol } from './infra/localMedia'
import { secureWindow } from './infra/windowSecurity'
import { finishPlaybackSessions } from './services/PlaybackService'
import { closeAllMpvSessions } from './services/MpvSessionService.js'
import { registerAllHandlers } from './ipc/index'
import { closeAllDatabases } from './db/connection'
import { ensureDirectories } from './infra/paths'
import { loadConfig, takeConfigRecoveryNotice } from './infra/config'
import { drainLibraryWork } from './services/LibraryWorkService'
import { drainPlaybackProxyWork } from './ffmpeg/playback.js'
import { createLogger } from './infra/logger'
import { trimPlaybackCache } from './services/CacheService'
import { BackgroundService } from './services/BackgroundService'
import {
  hasPendingSubtitleSetup,
  onSubtitleSetupChanged,
  shutdownSubtitleSetup,
} from './services/SubtitleSetupService'
import {
  hasPendingSubtitleJobs,
  initializeSubtitleQueue,
  onSubtitleQueueChanged,
  shutdownSubtitleQueue,
} from './services/SubtitleGenerationService'
import {
  hasPendingPlaybackConversionJobs,
  initializePlaybackConversionQueue,
  onPlaybackConversionQueueChanged,
  shutdownPlaybackConversionQueue,
} from './services/PlaybackConversionService'

const isolatedUserData = process.env['DVM_USER_DATA_DIR']
if (isolatedUserData) {
  const directory = resolve(isolatedUserData)
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
}
registerMediaScheme()

// The library databases have their own locks; the shared settings also need one writer.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => {
  if (app.isReady()) background.restore()
})

const isDev = !app.isPackaged
const rendererUrl =
  isDev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
const background = new BackgroundService({
  hasPendingJobs: () =>
    hasPendingSubtitleJobs() || hasPendingPlaybackConversionJobs() || hasPendingSubtitleSetup(),
  getWindow: () => BrowserWindow.getAllWindows()[0],
  createWindow,
  rendererUrl,
})
let stopQueueListener: (() => void) | undefined
let stopConversionQueueListener: (() => void) | undefined
let stopSetupListener: (() => void) | undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  })
  secureWindow(win, rendererUrl)
  background.attachWindow(win)

  win.on('ready-to-show', () => {
    if (process.env['DVM_SMOKE_TEST'] === '1') return
    win.show()
    if (isDev) {
      win.webContents.openDevTools()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  try {
    ensureDirectories()
    loadConfig()
    initializeSubtitleQueue()
    try {
      initializePlaybackConversionQueue()
    } catch (error) {
      // Keep the library usable; the home queue displays the recovery error.
      createLogger('startup').warn({ err: error }, '영상 변환 대기열 복구 실패')
    }
    const recoveryNotice = takeConfigRecoveryNotice()
    if (recoveryNotice) {
      await dialog.showMessageBox({ type: 'warning', title: '설정 복구', message: recoveryNotice })
    }
  } catch (error) {
    dialog.showErrorBox('앱 데이터를 열 수 없습니다', (error as Error).message)
    app.quit()
    return
  }
  registerLocalMediaProtocol()
  registerAllHandlers()
  stopQueueListener = onSubtitleQueueChanged(() => background.update())
  stopConversionQueueListener = onPlaybackConversionQueueChanged(() => background.update())
  stopSetupListener = onSubtitleSetupChanged(() => background.update())
  createWindow()
  void trimPlaybackCache().catch((error) =>
    createLogger('startup').warn({ err: error }, '시작 시 재생 캐시 정리 실패'),
  )

  app.on('activate', () => {
    background.restore()
  })
})

let shutdownRequested = false
let shutdownReady = false
app.on('before-quit', (event) => {
  if (shutdownReady || !hasInstanceLock) return
  event.preventDefault()
  if (shutdownRequested) return
  shutdownRequested = true
  background.beginShutdown()
  void (async () => {
    try {
      // The subtitle worker must save its checkpoint before generic library work is aborted.
      try {
        await shutdownSubtitleQueue()
      } catch (error) {
        // A failed checkpoint write must not leave players or database handles running.
        createLogger('shutdown').error({ err: error }, '종료 중 자막 대기열 저장 실패')
      }
      try {
        // Persist the paused conversion queue and stop its worker before draining proxies.
        await shutdownPlaybackConversionQueue()
      } catch (error) {
        createLogger('shutdown').error({ err: error }, '종료 중 영상 변환 대기열 저장 실패')
      }
      const drains = await Promise.allSettled([
        shutdownSubtitleSetup(),
        drainLibraryWork({ shutdown: true }),
        drainPlaybackProxyWork(),
      ])
      for (const result of drains) {
        if (result.status === 'rejected') {
          createLogger('shutdown').error({ err: result.reason }, '종료 중 작업 정리 실패')
        }
      }
      for (const close of [closeAllMpvSessions, finishPlaybackSessions, closeAllDatabases]) {
        try {
          close()
        } catch (error) {
          createLogger('shutdown').error({ err: error }, '종료 중 리소스 정리 실패')
        }
      }
    } catch (error) {
      createLogger('shutdown').error({ err: error }, '종료 중 작업 정리 실패')
    } finally {
      stopQueueListener?.()
      stopConversionQueueListener?.()
      stopSetupListener?.()
      background.dispose()
      shutdownReady = true
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
