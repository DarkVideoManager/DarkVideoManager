import { expect, it, vi } from 'vitest'

const exposeInMainWorld = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
// A sandboxed Electron preload cannot require external npm packages.
vi.mock('zod', () => { throw new Error('Zod must never be loaded by the preload') })

it('loads the isolated preload without importing main-process schema dependencies', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  try {
    await import('./index')
    expect(exposeInMainWorld).toHaveBeenCalledWith('api', expect.objectContaining({
      app: expect.any(Object), videos: expect.any(Object), dataImport: expect.any(Object),
    }))
  } finally {
    if (descriptor) Object.defineProperty(process, 'contextIsolated', descriptor)
    else Reflect.deleteProperty(process, 'contextIsolated')
  }
})
