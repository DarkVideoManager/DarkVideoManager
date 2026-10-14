import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  once: vi.fn(),
  getGPUFeatureStatus: vi.fn(),
  registerIpcHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { once: mocks.once, getGPUFeatureStatus: mocks.getGPUFeatureStatus },
  dialog: {},
  BrowserWindow: {},
}))
vi.mock('./index', () => ({ registerIpcHandler: mocks.registerIpcHandler }))
vi.mock('../infra/config', () => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }))
vi.mock('../services/CacheService', () => ({
  getCacheInfo: vi.fn(),
  cleanPlaybackCache: vi.fn(),
  trimPlaybackCache: vi.fn(),
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

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
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
