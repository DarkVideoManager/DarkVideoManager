import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  quit: vi.fn(),
  drain: vi.fn(),
  shutdownSubtitles: vi.fn(),
  shutdownConversions: vi.fn(),
  pendingSubtitles: false,
  pendingConversions: false,
  backgroundOptions: undefined as undefined | { hasPendingJobs: () => boolean },
  drainProxy: vi.fn(),
  beginShutdown: vi.fn(),
  disposeBackground: vi.fn(),
  closeMpv: vi.fn(),
  finishPlayback: vi.fn(),
  closeDatabases: vi.fn(),
  logError: vi.fn(),
  stopUpdates: vi.fn(),
  finishUpdate: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    isPackaged: true,
    quit: state.quit,
    setPath: vi.fn(),
    on: (event: string, callback: (...args: unknown[]) => void) =>
      state.handlers.set(event, callback),
    whenReady: () => new Promise(() => {}),
  },
  BrowserWindow: {},
  dialog: {},
  shell: {},
}))
vi.mock('./infra/localMedia', () => ({ registerMediaScheme() {}, registerLocalMediaProtocol() {} }))
vi.mock('./services/PlaybackService', () => ({ finishPlaybackSessions: state.finishPlayback }))
vi.mock('./services/MpvSessionService.js', () => ({ closeAllMpvSessions: state.closeMpv }))
vi.mock('./services/LibraryWorkService', () => ({ drainLibraryWork: state.drain }))
vi.mock('./services/SubtitleGenerationService', () => ({
  hasPendingSubtitleJobs: () => state.pendingSubtitles,
  initializeSubtitleQueue: vi.fn(),
  onSubtitleQueueChanged: vi.fn(),
  shutdownSubtitleQueue: state.shutdownSubtitles,
}))
vi.mock('./services/PlaybackConversionService', () => ({
  hasPendingPlaybackConversionJobs: () => state.pendingConversions,
  initializePlaybackConversionQueue: vi.fn(),
  onPlaybackConversionQueueChanged: vi.fn(),
  shutdownPlaybackConversionQueue: state.shutdownConversions,
}))
vi.mock('./services/BackgroundService', () => ({
  BackgroundService: class {
    constructor(options: { hasPendingJobs: () => boolean }) {
      state.backgroundOptions = options
    }
    beginShutdown = state.beginShutdown
    dispose = state.disposeBackground
  },
}))
vi.mock('./ffmpeg/playback.js', () => ({ drainPlaybackProxyWork: state.drainProxy }))
vi.mock('./services/CacheService', () => ({ trimPlaybackCache: vi.fn() }))
vi.mock('./services/AppUpdateRuntime', () => ({
  initializeAppUpdates: vi.fn(),
  stopAppUpdateChecks: state.stopUpdates,
  finishAppUpdateInstall: state.finishUpdate,
}))
vi.mock('./ipc/index', () => ({ registerAllHandlers() {} }))
vi.mock('./db/connection', () => ({ closeAllDatabases: state.closeDatabases }))
vi.mock('./infra/paths', () => ({ ensureDirectories() {} }))
vi.mock('./infra/config', () => ({ loadConfig() {}, takeConfigRecoveryNotice() {} }))
vi.mock('./infra/logger', () => ({ createLogger: () => ({ error: state.logError, warn() {} }) }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  state.handlers.clear()
  state.pendingSubtitles = false
  state.pendingConversions = false
  state.backgroundOptions = undefined
})

describe('application shutdown', () => {
  it('keeps the background alive while either queue has unfinished jobs', async () => {
    await import('./index')
    expect(state.backgroundOptions!.hasPendingJobs()).toBe(false)
    state.pendingConversions = true
    expect(state.backgroundOptions!.hasPendingJobs()).toBe(true)
    state.pendingConversions = false
    state.pendingSubtitles = true
    expect(state.backgroundOptions!.hasPendingJobs()).toBe(true)
    state.pendingSubtitles = false
    expect(state.backgroundOptions!.hasPendingJobs()).toBe(false)
  })

  it('checkpoints both queues before draining workers and closes databases only once afterwards', async () => {
    let finishSubtitles!: () => void
    state.shutdownSubtitles.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSubtitles = resolve
        }),
    )
    let finishConversions!: () => void
    state.shutdownConversions.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishConversions = resolve
        }),
    )
    let finishDrain!: () => void
    state.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve
        }),
    )
    await import('./index')
    const event = { preventDefault: vi.fn() }
    state.handlers.get('before-quit')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(state.beginShutdown).toHaveBeenCalledOnce()
    expect(state.shutdownSubtitles).toHaveBeenCalledOnce()
    expect(state.shutdownConversions).not.toHaveBeenCalled()
    expect(state.drain).not.toHaveBeenCalled()
    expect(state.closeDatabases).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    state.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    expect(state.shutdownSubtitles).toHaveBeenCalledOnce()
    finishSubtitles()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.shutdownConversions).toHaveBeenCalledOnce()
    expect(state.drain).not.toHaveBeenCalled()
    expect(state.drainProxy).not.toHaveBeenCalled()
    expect(state.closeDatabases).not.toHaveBeenCalled()
    finishConversions()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.drain).toHaveBeenCalledOnce()
    expect(state.drain).toHaveBeenCalledWith({ shutdown: true })
    expect(state.drainProxy).toHaveBeenCalledOnce()
    expect(state.closeDatabases).not.toHaveBeenCalled()
    finishDrain()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.closeMpv).toHaveBeenCalledOnce()
    expect(state.finishPlayback).toHaveBeenCalledOnce()
    expect(state.closeDatabases).toHaveBeenCalledOnce()
    expect(state.quit).toHaveBeenCalledOnce()
    expect(state.disposeBackground).toHaveBeenCalledOnce()
    expect(state.finishUpdate).toHaveBeenCalledWith(true)
    expect(state.finishUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
      state.closeDatabases.mock.invocationCallOrder[0],
    )
    const finalQuit = { preventDefault: vi.fn() }
    state.handlers.get('before-quit')!(finalQuit)
    expect(finalQuit.preventDefault).not.toHaveBeenCalled()
  })

  it('still drains work and closes resources after a rejected subtitle checkpoint', async () => {
    const error = new Error('checkpoint write failed')
    state.shutdownSubtitles.mockRejectedValue(error)
    let finishDrain!: () => void
    state.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve
        }),
    )
    await import('./index')
    state.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.logError).toHaveBeenCalledWith({ err: error }, '종료 중 자막 대기열 저장 실패')
    expect(state.shutdownConversions).toHaveBeenCalledOnce()
    expect(state.drain).toHaveBeenCalledWith({ shutdown: true })
    expect(state.drainProxy).toHaveBeenCalledOnce()
    expect(state.closeDatabases).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    finishDrain()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.finishUpdate).toHaveBeenCalledWith(false)
    expect(state.closeMpv).toHaveBeenCalledOnce()
    expect(state.finishPlayback).toHaveBeenCalledOnce()
    expect(state.closeDatabases).toHaveBeenCalledOnce()
    expect(state.disposeBackground).toHaveBeenCalledOnce()
    expect(state.quit).toHaveBeenCalledOnce()
  })

  it('still drains both workers after a rejected conversion checkpoint', async () => {
    const error = new Error('conversion queue write failed')
    state.shutdownConversions.mockRejectedValue(error)
    await import('./index')
    state.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.logError).toHaveBeenCalledWith(
      { err: error },
      '종료 중 영상 변환 대기열 저장 실패',
    )
    expect(state.drain).toHaveBeenCalledWith({ shutdown: true })
    expect(state.drainProxy).toHaveBeenCalledOnce()
    expect(state.closeMpv).toHaveBeenCalledOnce()
    expect(state.finishPlayback).toHaveBeenCalledOnce()
    expect(state.closeDatabases).toHaveBeenCalledOnce()
    expect(state.disposeBackground).toHaveBeenCalledOnce()
    expect(state.quit).toHaveBeenCalledOnce()
  })

  it('waits for the other worker after one drain rejects and still closes all resources', async () => {
    const drainError = new Error('proxy drain failed')
    state.drainProxy.mockRejectedValue(drainError)
    let finishDrain!: () => void
    state.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve
        }),
    )
    const playerError = new Error('player close failed')
    state.closeMpv.mockImplementation(() => {
      throw playerError
    })
    await import('./index')
    state.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.closeDatabases).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    finishDrain()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.logError).toHaveBeenCalledWith({ err: drainError }, '종료 중 작업 정리 실패')
    expect(state.logError).toHaveBeenCalledWith({ err: playerError }, '종료 중 리소스 정리 실패')
    expect(state.closeMpv).toHaveBeenCalledOnce()
    expect(state.finishPlayback).toHaveBeenCalledOnce()
    expect(state.closeDatabases).toHaveBeenCalledOnce()
    expect(state.disposeBackground).toHaveBeenCalledOnce()
    expect(state.quit).toHaveBeenCalledOnce()
  })
})
