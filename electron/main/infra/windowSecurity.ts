import { shell, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createLogger } from './logger'

const trustedRenderers = new WeakMap<WebContents, string>()
const log = createLogger('window-security')

/** Hash routes belong to the app; another document or query does not. */
export function isAppDocument(candidate: string, entry: string): boolean {
  try {
    const target = new URL(candidate)
    const expected = new URL(entry)
    target.hash = ''
    expected.hash = ''
    return target.href === expected.href
  } catch {
    return false
  }
}

export function isWebLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isTrustedDocument(contents: WebContents | null, url: string): boolean {
  if (!contents) return false
  try {
    const entry = trustedRenderers.get(contents)
    return Boolean(
      entry &&
        !contents.isDestroyed() &&
        isAppDocument(contents.mainFrame.url, entry) &&
        isAppDocument(url, entry),
    )
  } catch {
    return false
  }
}

export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  try {
    return Boolean(
      event.senderFrame &&
        event.senderFrame === event.sender.mainFrame &&
        isTrustedDocument(event.sender, event.senderFrame.url),
    )
  } catch {
    // A frame can be detached or destroyed between delivery and inspection.
    return false
  }
}

async function openWebLink(contents: WebContents, url: string): Promise<void> {
  try {
    if (isTrustedDocument(contents, contents.mainFrame.url) && isWebLink(url)) {
      await shell.openExternal(url)
    }
  } catch (error) {
    log.warn({ err: error }, '외부 링크를 열지 못했습니다')
  }
}

export function secureWindow(win: BrowserWindow, rendererUrl: string): void {
  const contents = win.webContents
  trustedRenderers.set(contents, rendererUrl)
  contents.once('destroyed', () => trustedRenderers.delete(contents))

  contents.setWindowOpenHandler(({ url }) => {
    void openWebLink(contents, url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event) => {
    if (!isAppDocument(event.url, rendererUrl)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isAppDocument(event.url, rendererUrl)) event.preventDefault()
  })
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isAppDocument(event.url, rendererUrl)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())

  // Playing local media needs no camera, microphone, device, or filesystem permission.
  // Keep the player's fullscreen control available only to the trusted main document.
  contents.session.setPermissionCheckHandler((sender, permission, _origin, details) =>
    permission === 'fullscreen' &&
    details.isMainFrame &&
    isTrustedDocument(sender, details.requestingUrl ?? ''),
  )
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    callback(
      permission === 'fullscreen' &&
        details.isMainFrame &&
        isTrustedDocument(sender, details.requestingUrl),
    )
  })
  contents.session.setDevicePermissionHandler(() => false)
}
