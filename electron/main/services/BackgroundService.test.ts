import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundService } from './BackgroundService'

const state = vi.hoisted(() => ({
  quit: vi.fn(),
  trays: [] as Array<{
    icon: string
    handlers: Map<string, () => void>
    setContextMenu: ReturnType<typeof vi.fn>
    setToolTip: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>,
  menu: [] as Array<{ label?: string; click?: () => void }>,
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', quit: state.quit },
  BrowserWindow: {},
  Menu: {
    buildFromTemplate: (menu: typeof state.menu) => {
      state.menu = menu
      return menu
    },
  },
  Tray: class {
    handlers = new Map<string, () => void>()
    setContextMenu = vi.fn()
    setToolTip = vi.fn()
    destroy = vi.fn()
    constructor(public icon: string) {
      state.trays.push(this)
    }
    on(event: string, callback: () => void) {
      this.handlers.set(event, callback)
    }
  },
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }))

class MockWindow extends EventEmitter {
  hide = vi.fn()
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  isMinimized = vi.fn(() => false)
  isDestroyed = vi.fn(() => false)
  loadURL = vi.fn(async () => {})
  webContents = {
    isLoadingMainFrame: vi.fn(() => false),
    getURL: vi.fn(() => 'file:///C:/app/index.html#/'),
    once: vi.fn(),
  }
}

function createService() {
  const win = new MockWindow()
  const hasPendingJobs = vi.fn(() => true)
  const createWindow = vi.fn(() => win as unknown as BrowserWindow)
  const service = new BackgroundService({
    hasPendingJobs,
    getWindow: () => win as unknown as BrowserWindow,
    createWindow,
    rendererUrl: 'file:///C:/app/index.html',
  })
  service.attachWindow(win as unknown as BrowserWindow)
  return { service, win, hasPendingJobs, createWindow }
}

beforeEach(() => {
  state.trays.length = 0
  state.menu = []
  vi.clearAllMocks()
  vi.stubEnv('DVM_SMOKE_TEST', '0')
})
afterEach(() => vi.unstubAllEnvs())

describe('background job lifecycle', () => {
  it('prevents close and hides the window without requesting application shutdown', () => {
    const { win } = createService()
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()
    expect(state.quit).not.toHaveBeenCalled()
    expect(state.trays).toHaveLength(1)
    expect(state.trays[0].icon).toMatch(/icon\.ico$/)
    win.emit('close', { preventDefault: vi.fn() })
    expect(state.trays).toHaveLength(1)
  })

  it('leaves ordinary window closing available when no unfinished jobs remain', () => {
    const { win, hasPendingJobs } = createService()
    hasPendingJobs.mockReturnValue(false)
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()
    expect(state.trays).toHaveLength(0)
  })

  it('restores a minimized window from the tray and opens the queue on the same app page', () => {
    const { win } = createService()
    win.emit('close', { preventDefault: vi.fn() })
    win.isMinimized.mockReturnValue(true)
    state.trays[0].handlers.get('double-click')!()
    expect(win.restore).toHaveBeenCalledOnce()
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    state.menu.find((item) => item.label === '자막 생성 대기열')!.click!()
    expect(win.loadURL).toHaveBeenCalledWith('file:///C:/app/index.html#/subtitles')
    win.webContents.getURL.mockReturnValue('https://example.com/')
    win.loadURL.mockClear()
    state.menu.find((item) => item.label === '자막 생성 대기열')!.click!()
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('opens the conversion queue on the home screen after the renderer finishes loading', () => {
    const { win } = createService()
    win.emit('close', { preventDefault: vi.fn() })
    win.webContents.isLoadingMainFrame.mockReturnValue(true)
    state.menu.find((item) => item.label === '영상 변환 대기열')!.click!()
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function))
    win.webContents.isLoadingMainFrame.mockReturnValue(false)
    win.webContents.getURL.mockReturnValue('file:///C:/app/index.html#/library/example')
    const onLoaded = win.webContents.once.mock.calls[0][1] as () => void
    onLoaded()
    expect(win.loadURL).toHaveBeenCalledWith('file:///C:/app/index.html#/')
    expect(state.trays[0].setToolTip).toHaveBeenCalledWith(
      'DarkVideoManager — 작업이 남아 있습니다',
    )

    win.webContents.getURL.mockReturnValue('https://example.com/')
    win.loadURL.mockClear()
    state.menu.find((item) => item.label === '영상 변환 대기열')!.click!()
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('retains the tray after completion and explicitly quits through the normal quit event', () => {
    const { service, win, hasPendingJobs } = createService()
    win.emit('close', { preventDefault: vi.fn() })
    hasPendingJobs.mockReturnValue(false)
    service.update()
    expect(state.trays[0].destroy).not.toHaveBeenCalled()
    expect(state.trays[0].setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('완료'))
    state.menu.find((item) => item.label === '완전히 종료')!.click!()
    expect(state.quit).toHaveBeenCalledOnce()
    hasPendingJobs.mockReturnValue(true)
    service.beginShutdown()
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    service.dispose()
    expect(state.trays[0].destroy).toHaveBeenCalledOnce()
  })

  it('keeps smoke-test windows hidden when tray or second-instance restore is requested', () => {
    vi.stubEnv('DVM_SMOKE_TEST', '1')
    const { service, win } = createService()
    service.restore(true)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.loadURL).toHaveBeenCalledWith('file:///C:/app/index.html#/subtitles')
  })
})
