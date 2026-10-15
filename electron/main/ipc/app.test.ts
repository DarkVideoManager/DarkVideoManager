import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { Config } from '@shared/types'

const mocks = vi.hoisted(() => ({
  once: vi.fn(),
  getGPUFeatureStatus: vi.fn(),
  registerIpcHandler: vi.fn(),
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  trimPlaybackCache: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { once: mocks.once, getGPUFeatureStatus: mocks.getGPUFeatureStatus },
  dialog: {},
  BrowserWindow: {},
}))
vi.mock('./index', () => ({ registerIpcHandler: mocks.registerIpcHandler }))
vi.mock('../infra/config', () => ({
  loadConfig: mocks.loadConfig,
  updateConfig: mocks.updateConfig,
}))
vi.mock('../services/CacheService', () => ({
  getCacheInfo: vi.fn(),
  cleanPlaybackCache: vi.fn(),
  trimPlaybackCache: mocks.trimPlaybackCache,
}))
vi.mock('../services/NativePlayerService', () => ({
  discoverNativePlayers: vi.fn(),
  validateNativePlayer: vi.fn(),
}))

function gpuInfoUpdated(): void {
  const subscription = mocks.once.mock.calls.find(([event]) => event === 'gpu-info-update')
  if (!subscription) throw new Error('GPU readiness listener was not installed at import time')
  subscription[1]()
}

function queryAcceleration(): unknown {
  const entry = mocks.registerIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC.APP.GET_ACCELERATION_INFO,
  )
  if (!entry) throw new Error('Acceleration handler was not registered')
  return entry[1]()
}

function settingsHandler(channel: string) {
  const entry = mocks.registerIpcHandler.mock.calls.find(([registered]) => registered === channel)
  if (!entry) throw new Error('Settings handler was not registered')
  return entry[1]
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.loadConfig.mockReturnValue({ libraries: [] })
})

describe('persisted playback settings', () => {
  it('returns the one-second default for configurations created before the setting', async () => {
    const { registerAppHandlers } = await import('./app')
    registerAppHandlers()
    expect(settingsHandler(IPC.APP.GET_SETTINGS)()).toEqual({
      ok: true,
      value: { cacheLimitGb: 10, seekStepSec: 1, nativePlayer: null },
    })
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })

  it('updates only the seek interval and preserves the previous value when saving fails', async () => {
    let config: Config = { libraries: [], cacheLimitGb: 25, seekStepSec: 5 }
    mocks.loadConfig.mockImplementation(() => config)
    mocks.updateConfig.mockImplementation((update: (current: Config) => Config) => {
      config = update(config)
      return config
    })
    const { registerAppHandlers } = await import('./app')
    registerAppHandlers()
    const update = settingsHandler(IPC.APP.UPDATE_SETTINGS)
    await expect(update({}, { seekStepSec: 15 })).resolves.toEqual({
      ok: true,
      value: { cacheLimitGb: 25, seekStepSec: 15, nativePlayer: null },
    })
    expect(config).toEqual({ libraries: [], cacheLimitGb: 25, seekStepSec: 15 })
    expect(mocks.trimPlaybackCache).not.toHaveBeenCalled()
    mocks.updateConfig.mockImplementationOnce(() => {
      throw new Error('Synthetic save failure')
    })
    await expect(update({}, { seekStepSec: 30 })).rejects.toThrow('Synthetic save failure')
    expect(settingsHandler(IPC.APP.GET_SETTINGS)().value.seekStepSec).toBe(15)
  })
})

describe('GPU feature readiness', () => {
  it('returns unknown without reading premature status, then refreshes after the update', async () => {
    const { registerAppHandlers } = await import('./app')
    registerAppHandlers()
    mocks.getGPUFeatureStatus.mockReturnValue({
      video_decode: 'enabled',
      gpu_compositing: 'enabled',
    })

    expect(queryAcceleration()).toEqual({
      ok: true,
      value: { videoDecodeStatus: 'unknown', gpuCompositingStatus: 'unknown' },
    })
    expect(mocks.getGPUFeatureStatus).not.toHaveBeenCalled()

    gpuInfoUpdated()
    expect(queryAcceleration()).toEqual({
      ok: true,
      value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'enabled' },
    })
    mocks.getGPUFeatureStatus.mockReturnValue({
      video_decode: 'disabled_software',
      gpu_compositing: 'enabled',
    })
    expect(queryAcceleration()).toEqual({
      ok: true,
      value: { videoDecodeStatus: 'disabled_software', gpuCompositingStatus: 'enabled' },
    })
  })

  it('remembers an update emitted before IPC handlers are registered', async () => {
    const { registerAppHandlers } = await import('./app')
    gpuInfoUpdated()
    registerAppHandlers()
    mocks.getGPUFeatureStatus.mockReturnValue({ video_decode: 'enabled' })

    expect(queryAcceleration()).toEqual({
      ok: true,
      value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'unknown' },
    })
    expect(mocks.once).toHaveBeenCalledTimes(1)
  })
})
