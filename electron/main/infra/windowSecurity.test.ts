import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAppDocument, isTrustedIpcSender, isWebLink, secureWindow } from './windowSecurity'

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(), warn: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: mocks.openExternal } }))
vi.mock('./logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }))

const entry = 'file:///C:/Program%20Files/DarkVideoManager/resources/app.asar/out/renderer/index.html'

function createWindow() {
  const contents = {
    mainFrame: { url: entry + '#/player/lib/video' },
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    },
  }
  secureWindow({ webContents: contents } as unknown as BrowserWindow, entry)
  return contents
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openExternal.mockResolvedValue(undefined)
})

describe('renderer trust boundary', () => {
  it('keeps hash navigation on the exact application document', () => {
    expect(isAppDocument(entry + '#/subtitles', entry)).toBe(true)
    expect(isAppDocument('http://localhost:5173/#/library', 'http://localhost:5173')).toBe(true)
    for (const candidate of [
      entry.replace('index.html', 'other.html'),
      entry + '?redirect=https://example.com',
      'file:///C:/private/index.html',
      'https://example.com/',
      'data:text/html,hello',
      'not a URL',
    ]) expect(isAppDocument(candidate, entry)).toBe(false)
    expect(isAppDocument('http://localhost:5173.evil.example/', 'http://localhost:5173')).toBe(false)
  })

  it('accepts only the registered window main frame and rejects detached/destroyed senders', () => {
    const sender = createWindow()
    const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
    expect(isTrustedIpcSender(event)).toBe(true)
    expect(isTrustedIpcSender({ ...event, senderFrame: null })).toBe(false)
    expect(isTrustedIpcSender({
      ...event, senderFrame: { ...sender.mainFrame },
    } as unknown as IpcMainInvokeEvent)).toBe(false)
    expect(isTrustedIpcSender({
      ...event, sender: { ...sender },
    } as unknown as IpcMainInvokeEvent)).toBe(false)
    sender.mainFrame.url = 'https://example.com/'
    expect(isTrustedIpcSender(event)).toBe(false)
    sender.mainFrame.url = entry
    sender.isDestroyed.mockReturnValue(true)
    expect(isTrustedIpcSender(event)).toBe(false)
    sender.isDestroyed.mockReturnValue(false)
    sender.once.mock.calls.find(([name]) => name === 'destroyed')![1]()
    expect(isTrustedIpcSender(event)).toBe(false)
  })

  it('prevents external navigation, redirects, nested frames, and webviews', () => {
    const contents = createWindow()
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const handler = contents.on.mock.calls.find(([event]) => event === name)![1]
      const allowed = { url: entry + '#/library', isMainFrame: true, preventDefault: vi.fn() }
      handler(allowed)
      expect(allowed.preventDefault).not.toHaveBeenCalled()
      const remote = { ...allowed, url: 'https://example.com/', preventDefault: vi.fn() }
      handler(remote)
      expect(remote.preventDefault).toHaveBeenCalledOnce()
      if (name !== 'will-navigate') {
        const subframe = { ...allowed, isMainFrame: false, preventDefault: vi.fn() }
        handler(subframe)
        expect(subframe.preventDefault).toHaveBeenCalledOnce()
      }
    }
    const preventDefault = vi.fn()
    contents.on.mock.calls.find(([name]) => name === 'will-attach-webview')![1]({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('opens only HTTP(S) links in the external browser and catches failures', async () => {
    const contents = createWindow()
    const open = contents.setWindowOpenHandler.mock.calls[0][0]
    for (const url of ['file:///C:/Windows/system32/cmd.exe', 'javascript:alert(1)', 'ms-settings:', 'data:text/html,hello', 'invalid']) {
      expect(isWebLink(url)).toBe(false)
      expect(open({ url })).toEqual({ action: 'deny' })
    }
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(open({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(isWebLink('http://localhost:8000/help')).toBe(true)
    mocks.openExternal.mockRejectedValueOnce(new Error('Browser unavailable'))
    open({ url: 'https://example.com/docs' })
    await Promise.resolve()
    expect(mocks.warn).toHaveBeenCalledOnce()
    contents.mainFrame.url = 'https://example.com/'
    mocks.openExternal.mockClear()
    open({ url: 'https://example.com/docs' })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('denies device permissions and only permits fullscreen on the app main document', () => {
    const contents = createWindow()
    const check = contents.session.setPermissionCheckHandler.mock.calls[0][0]
    const request = contents.session.setPermissionRequestHandler.mock.calls[0][0]
    const details = { requestingUrl: contents.mainFrame.url, isMainFrame: true }
    expect(check(contents, 'fullscreen', 'file://', details)).toBe(true)
    for (const permission of ['media', 'clipboard-read', 'notifications', 'fileSystem', 'openExternal', 'automatic-fullscreen']) {
      const callback = vi.fn()
      expect(check(contents, permission, 'file://', details)).toBe(false)
      request(contents, permission, callback, details)
      expect(callback).toHaveBeenCalledWith(false)
    }
    for (const untrusted of [
      { ...details, isMainFrame: false },
      { ...details, requestingUrl: 'https://example.com/' },
    ]) {
      const callback = vi.fn()
      expect(check(contents, 'fullscreen', 'file://', untrusted)).toBe(false)
      request(contents, 'fullscreen', callback, untrusted)
      expect(callback).toHaveBeenCalledWith(false)
    }
    expect(check(null, 'fullscreen', 'file://', details)).toBe(false)
    expect(contents.session.setDevicePermissionHandler.mock.calls[0][0]({})).toBe(false)
  })
})
