import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleSetupStatus } from '@shared/types'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('./SubtitleRuntime', () => ({
  getSubtitleEngineInfo: vi.fn(),
  runSubtitleCommand: vi.fn(),
  toWslPath: vi.fn(),
}))
vi.mock('./SubtitleGenerationService', () => ({ listSubtitleQueue: () => [] }))
vi.mock('./SubtitleEnvironmentLock', () => ({ setSubtitleEnvironmentInstalling: vi.fn() }))

import { SubtitleSetupController } from './SubtitleSetupService'

afterEach(() => vi.useRealTimers())

type Dependencies = ConstructorParameters<typeof SubtitleSetupController>[0]
type Emit = Parameters<Dependencies['native']>[2]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function readyNative(_install: boolean, _signal: AbortSignal, emit: Emit): Promise<void> {
  emit({ component: 'whisper', state: 'ready' })
  emit({ component: 'speechModel', state: 'ready' })
  return Promise.resolve()
}

function readyEnvironment(_install: boolean, _signal: AbortSignal, emit: Emit): Promise<void> {
  for (const component of ['python', 'ollama', 'translationModel'])
    emit({ component, state: 'ready' })
  return Promise.resolve()
}

function create(overrides: Partial<Dependencies> = {}) {
  const dependencies = {
    native: vi.fn<Dependencies['native']>(readyNative),
    wslReady: vi.fn<Dependencies['wslReady']>().mockResolvedValue(true),
    installWsl: vi.fn<Dependencies['installWsl']>().mockResolvedValue(false),
    preparePython: vi.fn<Dependencies['preparePython']>().mockResolvedValue(undefined),
    environment: vi.fn<Dependencies['environment']>(readyEnvironment),
    verify: vi
      .fn<Dependencies['verify']>()
      .mockResolvedValue({ available: true, message: 'ready' }),
    canInstall: vi.fn<Dependencies['canInstall']>(),
    changed: vi.fn<NonNullable<Dependencies['changed']>>(),
  }
  Object.assign(dependencies, overrides)
  return { controller: new SubtitleSetupController(dependencies), dependencies }
}

async function finished(controller: SubtitleSetupController): Promise<SubtitleSetupStatus> {
  await vi.waitFor(() => expect(controller.busy()).toBe(false))
  return controller.snapshot()
}

describe('subtitle environment setup lifecycle', () => {
  it('stops a known virtualization blocker before downloading native models', async () => {
    const { controller, dependencies } = create({
      preflightWsl: vi.fn().mockRejectedValue(new Error('BIOS/UEFI 가상화 확인 필요')),
    })
    controller.start(true)
    expect((await finished(controller)).message).toContain('BIOS/UEFI')
    expect(dependencies.native).not.toHaveBeenCalled()
    expect(dependencies.installWsl).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
  })

  it('does not run installation preflight on a read-only setup check', async () => {
    const preflightWsl = vi.fn().mockResolvedValue(undefined)
    const { controller } = create({ preflightWsl })
    controller.start(false)
    expect((await finished(controller)).phase).toBe('ready')
    expect(preflightWsl).not.toHaveBeenCalled()
  })

  it('checks an existing environment without invoking installation steps', async () => {
    const { controller, dependencies } = create()
    expect(controller.start(false).phase).toBe('checking')
    expect((await finished(controller)).phase).toBe('ready')
    expect(dependencies.native).toHaveBeenCalledWith(
      false,
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(dependencies.environment).toHaveBeenCalledWith(
      false,
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(dependencies.canInstall).not.toHaveBeenCalled()
    expect(dependencies.installWsl).not.toHaveBeenCalled()
    expect(dependencies.preparePython).not.toHaveBeenCalled()
    expect(dependencies.verify).toHaveBeenCalledOnce()
  })

  it('prepares prerequisites and verifies readiness before announcing installation success', async () => {
    const verification = deferred<{ available: boolean; message: string }>()
    const { controller, dependencies } = create({ verify: vi.fn(() => verification.promise) })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.verify).toHaveBeenCalledOnce())
    expect(controller.snapshot().phase).toBe('installing')
    expect(controller.busy()).toBe(true)
    verification.resolve({ available: true, message: 'ready' })
    const status = await finished(controller)
    expect(status.phase).toBe('ready')
    expect(status.canCancel).toBe(false)
    expect(status.components.every((item) => item.state === 'ready')).toBe(true)
    expect(dependencies.preparePython).toHaveBeenCalledOnce()
    expect(dependencies.installWsl).not.toHaveBeenCalled()
  })

  it('reports missing WSL without modifying it during a check', async () => {
    const { controller, dependencies } = create({ wslReady: vi.fn().mockResolvedValue(false) })
    controller.start(false)
    const status = await finished(controller)
    expect(status.phase).toBe('idle')
    for (const id of ['wsl', 'python', 'ollama', 'translationModel'])
      expect(status.components.find((item) => item.id === id)?.state).toBe('missing')
    expect(dependencies.installWsl).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
    expect(dependencies.verify).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'does not claim success when the translation model is missing (install=%s)',
    async (install) => {
      const { controller, dependencies } = create({
        environment: vi.fn(async (_install, _signal, emit) => {
          await readyEnvironment(_install, _signal, emit)
          emit({
            component: 'translationModel',
            state: 'missing',
            message: '번역 모델을 준비해 주세요.',
          })
        }),
      })
      controller.start(install)
      expect((await finished(controller)).phase).toBe(install ? 'failed' : 'idle')
      expect(dependencies.verify).not.toHaveBeenCalled()
    },
  )

  it('surfaces a failed final runtime verification even when component checks passed', async () => {
    const { controller } = create({
      verify: vi
        .fn()
        .mockResolvedValue({ available: false, message: '실행 환경을 확인하지 못했습니다.' }),
    })
    controller.start(true)
    expect(await finished(controller)).toMatchObject({
      phase: 'failed',
      message: '실행 환경을 확인하지 못했습니다.',
      canCancel: false,
    })
  })

  it('waits for a restart without installing downstream tools or models', async () => {
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValue(false),
      installWsl: vi.fn().mockResolvedValue(true),
    })
    controller.start(true)
    expect(await finished(controller)).toMatchObject({
      phase: 'restart-required',
      canCancel: false,
    })
    expect(dependencies.wslReady).toHaveBeenCalledOnce()
    expect(dependencies.preparePython).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
    expect(dependencies.verify).not.toHaveBeenCalled()
  })

  it('probes WSL after installation before preparing tools', async () => {
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    })
    controller.start(true)
    expect((await finished(controller)).phase).toBe('ready')
    expect(dependencies.installWsl).toHaveBeenCalledOnce()
    expect(dependencies.wslReady).toHaveBeenCalledTimes(2)
    expect(dependencies.preparePython).toHaveBeenCalledOnce()
  })

  it('reports failed startup without repeatedly asking for reboot after a successful installer', async () => {
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValue(false),
      installWsl: vi.fn().mockResolvedValue(false),
    })
    controller.start(true)
    const status = await finished(controller)
    expect(status.phase).toBe('failed')
    expect(status.message).toContain('시작하지 못했습니다')
    expect(status.components.find((item) => item.id === 'wsl')?.state).toBe('failed')
    expect(status.components.find((item) => item.id === 'python')?.state).toBe('checking')
    expect(dependencies.preparePython).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
  })

  it('preserves an existing distro startup failure without starting another installer', async () => {
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockRejectedValue(new Error('BIOS/UEFI 가상화 확인 (0x80370102)')),
    })
    controller.start(true)
    const status = await finished(controller)
    expect(status).toMatchObject({ phase: 'failed', message: 'BIOS/UEFI 가상화 확인 (0x80370102)' })
    expect(status.components.find((item) => item.id === 'wsl')).toMatchObject({
      state: 'failed',
      message: status.message,
    })
    expect(status.components.filter((item) => item.state === 'failed')).toHaveLength(1)
    expect(dependencies.installWsl).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
  })

  it('keeps the step start time across progress updates and clears it when finished', async () => {
    vi.useFakeTimers()
    const windows = deferred<boolean>()
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      installWsl: vi.fn(() => windows.promise),
    })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.installWsl).toHaveBeenCalledOnce())
    const started = controller.snapshot().stepStartedAt
    expect(controller.snapshot().currentComponent).toBe('wsl')
    expect(started).toBeDefined()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    dependencies.installWsl.mock.calls[0][0]('Windows 설치 도구가 실행 중입니다.')
    expect(controller.snapshot().stepStartedAt).toBe(started)
    windows.resolve(false)
    const status = await finished(controller)
    expect(status.phase).toBe('ready')
    expect(status.currentComponent).toBeUndefined()
    expect(status.stepStartedAt).toBeUndefined()
  })

  it('reports declined or failed Windows installation without starting the environment worker', async () => {
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValue(false),
      installWsl: vi.fn().mockRejectedValue(new Error('Windows 권한 승인이 필요합니다.')),
    })
    controller.start(true)
    expect(await finished(controller)).toMatchObject({
      phase: 'failed',
      message: 'Windows 권한 승인이 필요합니다.',
      canCancel: false,
    })
    expect(dependencies.environment).not.toHaveBeenCalled()
  })

  it('does not start an operation when subtitle work prevents installation', () => {
    const { controller, dependencies } = create({
      canInstall: vi.fn(() => {
        throw new Error('자막 작업을 일시정지해 주세요.')
      }),
    })
    expect(() => controller.start(true)).toThrow('일시정지')
    expect(controller.busy()).toBe(false)
    expect(controller.snapshot().phase).toBe('idle')
    expect(dependencies.native).not.toHaveBeenCalled()
    expect(dependencies.changed).not.toHaveBeenCalled()
  })

  it('coalesces repeated start requests while an operation is running', async () => {
    const download = deferred<void>()
    const { controller, dependencies } = create({
      native: vi.fn(async (install, signal, emit) => {
        await download.promise
        await readyNative(install, signal, emit)
      }),
    })
    controller.start(true)
    expect(controller.start(true).phase).toBe('installing')
    expect(controller.start(false).phase).toBe('installing')
    expect(dependencies.canInstall).toHaveBeenCalledOnce()
    expect(dependencies.native).toHaveBeenCalledOnce()
    download.resolve()
    await finished(controller)
  })

  it('retains finished components and waits for cancelled work to finish before permitting retry', async () => {
    const download = deferred<void>()
    const { controller, dependencies } = create({
      native: vi.fn(async (_install, _signal, emit) => {
        emit({ component: 'whisper', state: 'ready' })
        emit({ component: 'speechModel', state: 'installing', percent: 20 })
        await download.promise
      }),
    })
    controller.start(true)
    expect(controller.cancel()).toBe(true)
    expect(controller.cancel()).toBe(false)
    expect(controller.busy()).toBe(true)
    expect(dependencies.native.mock.calls[0][1].aborted).toBe(true)
    download.resolve()
    const status = await finished(controller)
    expect(status.phase).toBe('cancelled')
    expect(status.components.find((item) => item.id === 'whisper')?.state).toBe('ready')
    expect(status.components.find((item) => item.id === 'speechModel')?.state).toBe('missing')
    expect(dependencies.wslReady).not.toHaveBeenCalled()
  })

  it('never opens Windows installation after cancellation during a readiness probe', async () => {
    const probe = deferred<boolean>()
    const { controller, dependencies } = create({ wslReady: vi.fn(() => probe.promise) })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.wslReady).toHaveBeenCalledOnce())
    expect(controller.cancel()).toBe(true)
    probe.resolve(false)
    const status = await finished(controller)
    expect(dependencies.installWsl).not.toHaveBeenCalled()
    expect(status.phase).toBe('cancelled')
  })

  it('rejects normal cancellation while Windows is changing system components', async () => {
    const windows = deferred<boolean>()
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValue(false),
      installWsl: vi.fn(() => windows.promise),
    })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.installWsl).toHaveBeenCalledOnce())
    expect(controller.snapshot().canCancel).toBe(false)
    expect(controller.cancel()).toBe(false)
    expect(controller.busy()).toBe(true)
    windows.resolve(true)
    expect((await finished(controller)).phase).toBe('restart-required')
  })

  it('defers shutdown until Windows installation finishes and then skips further installation', async () => {
    const windows = deferred<boolean>()
    const { controller, dependencies } = create({
      wslReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      installWsl: vi.fn(() => windows.promise),
    })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.installWsl).toHaveBeenCalledOnce())
    let stopped = false
    const shutdown = controller.shutdown().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(controller.busy()).toBe(true)
    windows.resolve(false)
    await shutdown
    expect(controller.snapshot().phase).toBe('cancelled')
    expect(dependencies.preparePython).not.toHaveBeenCalled()
    expect(dependencies.environment).not.toHaveBeenCalled()
    expect(dependencies.wslReady).toHaveBeenCalledOnce()
  })

  it('can retry after a failure and does not expose mutable internal status', async () => {
    const { controller, dependencies } = create()
    dependencies.native.mockRejectedValueOnce(new Error('다운로드 연결 실패'))
    controller.start(true)
    expect((await finished(controller)).phase).toBe('failed')
    const snapshot = controller.snapshot()
    snapshot.components[0].state = 'ready'
    snapshot.message = 'changed by caller'
    expect(controller.snapshot().components[0].state).toBe('failed')
    expect(controller.snapshot().message).toBe('다운로드 연결 실패')
    const emitted = dependencies.changed.mock.calls.at(-1)![0]
    emitted.components.length = 0
    expect(controller.snapshot().components).toHaveLength(6)
    controller.start(true)
    expect((await finished(controller)).phase).toBe('ready')
  })

  it('waits for prerequisite package installation during shutdown without starting downloads', async () => {
    const prerequisites = deferred<void>()
    const { controller, dependencies } = create({
      preparePython: vi.fn(() => prerequisites.promise),
    })
    controller.start(true)
    await vi.waitFor(() => expect(dependencies.preparePython).toHaveBeenCalledOnce())
    expect(controller.snapshot().canCancel).toBe(false)
    expect(controller.cancel()).toBe(false)
    const shutdown = controller.shutdown()
    expect(controller.busy()).toBe(true)
    prerequisites.resolve()
    await shutdown
    expect(controller.snapshot().phase).toBe('cancelled')
    expect(dependencies.environment).not.toHaveBeenCalled()
    expect(dependencies.verify).not.toHaveBeenCalled()
  })

  it('clamps worker progress and rejects malformed component messages', async () => {
    const download = deferred<void>()
    let report!: Emit
    const { controller } = create({
      native: vi.fn(async (_install, _signal, emit) => {
        report = emit
        emit({
          component: 'speechModel',
          state: 'installing',
          percent: 130,
          message: 'a'.repeat(1500),
        })
        await download.promise
        emit({ component: 'unrecognized', state: 'ready' })
      }),
    })
    controller.start(true)
    expect(
      controller.snapshot().components.find((item) => item.id === 'speechModel'),
    ).toMatchObject({ percent: 100, message: 'a'.repeat(1200) })
    report({ component: 'speechModel', state: 'installing', percent: Number.NaN })
    expect(
      controller.snapshot().components.find((item) => item.id === 'speechModel')?.percent,
    ).toBeUndefined()
    download.resolve()
    expect((await finished(controller)).phase).toBe('failed')
  })
})
