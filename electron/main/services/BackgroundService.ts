import { app, BrowserWindow, Menu, Tray } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../infra/logger'

interface BackgroundOptions {
  hasPendingJobs: () => boolean
  getWindow: () => BrowserWindow | undefined
  createWindow: () => BrowserWindow
  rendererUrl: string
}

/** Closing a window is separate from explicitly quitting the application. */
export class BackgroundService {
  private tray: Tray | null = null
  private quitting = false

  constructor(private readonly options: BackgroundOptions) {}

  attachWindow(win: BrowserWindow): void {
    win.on('close', (event) => {
      if (this.quitting || !this.options.hasPendingJobs()) return
      event.preventDefault()
      try {
        this.ensureTray()
        win.hide()
      } catch (error) {
        // Keep the window available if Windows could not create a tray icon.
        createLogger('background').error({ err: error }, '백그라운드 트레이를 만들지 못했습니다')
      }
    })
  }

  restore(showQueue: boolean | '/' | '/subtitles' = false): void {
    if (this.quitting) return
    let win = this.options.getWindow()
    if (!win || win.isDestroyed()) win = this.options.createWindow()
    if (showQueue) this.openQueue(win, showQueue === true ? '/subtitles' : showQueue)
    if (process.env['DVM_SMOKE_TEST'] === '1') return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  update(): void {
    this.tray?.setToolTip(
      this.options.hasPendingJobs()
        ? 'DarkVideoManager — 작업이 남아 있습니다'
        : 'DarkVideoManager — 작업 완료',
    )
  }

  beginShutdown(): void {
    this.quitting = true
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private ensureTray(): void {
    if (this.tray) return
    const icon = app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(app.getAppPath(), 'resources/icon.ico')
    this.tray = new Tray(icon)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '열기', click: () => this.restore() },
        { label: '영상 변환 대기열', click: () => this.restore('/') },
        { label: '자막 생성 대기열', click: () => this.restore(true) },
        { type: 'separator' },
        { label: '완전히 종료', click: () => app.quit() },
      ]),
    )
    this.tray.on('double-click', () => this.restore())
    this.tray.on('click', () => this.restore())
    this.update()
  }

  private openQueue(win: BrowserWindow, route: '/' | '/subtitles'): void {
    if (!win.webContents.getURL() || win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) this.openQueue(win, route)
      })
      return
    }
    const current = new URL(win.webContents.getURL())
    const expected = new URL(this.options.rendererUrl)
    current.hash = ''
    expected.hash = ''
    // Navigation is restricted to a hash on the known application page.
    if (current.href !== expected.href) return
    current.hash = route
    void win
      .loadURL(current.href)
      .catch((error) =>
        createLogger('background').warn({ err: error }, '작업 대기열을 열지 못했습니다'),
      )
  }
}
