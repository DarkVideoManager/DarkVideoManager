import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateService, type UpdateEngine } from './AppUpdateService'

class Engine extends EventEmitter implements UpdateEngine {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  cancellation = { cancel: vi.fn() }
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', { version: '0.3.5' })
    return { cancellationToken: this.cancellation }
  })
  downloadUpdate = vi.fn(async () => ['downloaded.exe'])
  quitAndInstall = vi.fn()
}
function fixture(mode: 'installer' | 'portable' | 'development' = 'installer', automatic = true) {
  const engine = new Engine()
  const saveAutomatic = vi.fn()
  const requestQuit = vi.fn()
  const service = new AppUpdateService({
    mode,
    version: '0.3.4',
    automatic,
    ...(mode !== 'development' ? { engine } : {}),
    saveAutomatic,
    requestQuit,
  })
  return { service, engine, saveAutomatic, requestQuit }
}
afterEach(() => {
  vi.useRealTimers()
})

describe('application updates', () => {
  it('automatically checks and downloads once, while duplicate checks preserve ready state', async () => {
    vi.useFakeTimers()
    const { service, engine } = fixture()
    let complete!: (paths: string[]) => void
    engine.downloadUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    service.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(engine.checkForUpdates).toHaveBeenCalledOnce()
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
    await service.check()
    expect(engine.checkForUpdates).toHaveBeenCalledOnce()
    engine.emit('download-progress', { percent: 120, transferred: -5, total: Infinity })
    expect(service.getState().progress).toEqual({ percent: 100, transferred: 0, total: 0 })
    engine.emit('update-downloaded', { version: '0.3.5' })
    complete(['downloaded.exe'])
    await service.download()
    await service.check()
    expect(service.getState().phase).toBe('ready')
    expect(engine.checkForUpdates).toHaveBeenCalledOnce()
    expect(engine.autoDownload).toBe(false)
    expect(engine.autoInstallOnAppQuit).toBe(false)
    expect(engine.allowDowngrade).toBe(false)
    expect(engine.allowPrerelease).toBe(false)
    service.stop()
  })

  it('persists opt-out, allows a manual check, and never downloads portable updates', async () => {
    vi.useFakeTimers()
    const { service, engine, saveAutomatic } = fixture('portable', false)
    service.start()
    await vi.advanceTimersByTimeAsync(15_000 + 6 * 60 * 60 * 1000)
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    await service.check()
    expect(service.getState().phase).toBe('available')
    service.setAutomatic(true)
    expect(saveAutomatic).toHaveBeenCalledWith(true)
    await service.download()
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(() => service.requestInstall()).toThrow()
    service.stop()
  })

  it('shares an in-flight check and respects disabling automatic download during it', async () => {
    const { service, engine } = fixture()
    let release!: (value: { cancellationToken: typeof engine.cancellation }) => void
    engine.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const first = service.check()
    const second = service.check()
    expect(first).toBe(second)
    service.setAutomatic(false)
    engine.emit('update-available', { version: '0.3.5' })
    release({ cancellationToken: engine.cancellation })
    await first
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    await service.download()
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
    service.stop()
  })

  it('recovers from network and integrity failures without exposing raw server errors', async () => {
    const { service, engine } = fixture('installer', false)
    engine.checkForUpdates.mockRejectedValueOnce(new Error('secret URL or filesystem path'))
    await service.check()
    expect(service.getState().phase).toBe('error')
    expect(service.getState().error).not.toContain('secret')
    await service.check()
    engine.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'))
    await service.download()
    expect(service.getState().phase).toBe('error')
    expect(() => service.requestInstall()).toThrow()
    engine.downloadUpdate.mockImplementationOnce(async () => {
      engine.emit('update-downloaded', { version: '0.3.5' })
      return ['downloaded.exe']
    })
    await service.download()
    expect(service.getState().phase).toBe('ready')
    service.stop()
  })

  it.each([true, false])(
    'only invokes the installer after shutdown reports safe=%s',
    async (safe) => {
      const { service, engine, requestQuit } = fixture('installer', false)
      expect(() => service.requestInstall()).toThrow()
      await service.check()
      engine.emit('update-downloaded', { version: '0.3.5' })
      service.requestInstall()
      expect(requestQuit).toHaveBeenCalledOnce()
      expect(engine.quitAndInstall).not.toHaveBeenCalled()
      service.stop()
      service.finishInstall(safe)
      expect(engine.quitAndInstall).toHaveBeenCalledTimes(safe ? 1 : 0)
      if (safe) expect(engine.quitAndInstall).toHaveBeenCalledWith(false, true)
      service.finishInstall(safe)
      expect(engine.quitAndInstall).toHaveBeenCalledTimes(safe ? 1 : 0)
    },
  )

  it('cancels download work and ignores late events after normal quit', async () => {
    const { service, engine } = fixture('installer', false)
    await service.check()
    const listener = vi.fn()
    service.subscribe(listener)
    service.stop()
    engine.emit('update-downloaded', { version: '0.3.5' })
    expect(listener).not.toHaveBeenCalled()
    expect(engine.cancellation.cancel).toHaveBeenCalledOnce()
    service.finishInstall(true)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })

  it('never checks or downloads from development and unpacked builds', async () => {
    const { service, engine } = fixture('development')
    service.start()
    await service.check()
    await service.download()
    expect(service.getState().phase).toBe('unsupported')
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
  })
})
