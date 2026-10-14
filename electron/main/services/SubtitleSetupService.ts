import { app } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { SubtitleSetupComponent, SubtitleSetupStatus } from '@shared/types'
import { getSubtitleEngineInfo, runSubtitleCommand, toWslPath } from './SubtitleRuntime'
import { listSubtitleQueue } from './SubtitleGenerationService'
import { setSubtitleEnvironmentInstalling } from './SubtitleEnvironmentLock'
import {
  ensureSubtitleWslUser,
  hasSubtitleWslInstall,
  installSubtitleWsl,
  subtitleWslArgs,
} from './SubtitleWslEnvironment'

type ComponentId = SubtitleSetupComponent['id']
type EventHandler = (event: unknown) => void
interface SetupDependencies {
  native: (install: boolean, signal: AbortSignal, emit: EventHandler) => Promise<void>
  wslReady: (signal: AbortSignal) => Promise<boolean>
  installWsl: (progress: (message: string) => void, signal: AbortSignal) => Promise<boolean>
  preparePython: (signal: AbortSignal) => Promise<void>
  environment: (install: boolean, signal: AbortSignal, emit: EventHandler) => Promise<void>
  verify: () => Promise<{ available: boolean; message: string }>
  canInstall: () => void
  changed?: (status: SubtitleSetupStatus) => void
}

const components = (): SubtitleSetupComponent[] => [
  { id: 'whisper', label: 'Whisper 음성 인식 엔진', state: 'checking' },
  { id: 'speechModel', label: 'Whisper 기본 모델', state: 'checking' },
  { id: 'wsl', label: 'Windows 자막 실행 환경', state: 'checking' },
  { id: 'python', label: '자막 처리 도구', state: 'checking' },
  { id: 'ollama', label: 'Ollama 번역 엔진', state: 'checking' },
  { id: 'translationModel', label: '한국어 번역 모델 (qwen3:8b)', state: 'checking' },
]

/** One operation per app. Checks never download or change the machine. */
export class SubtitleSetupController {
  private status: SubtitleSetupStatus = {
    phase: 'idle',
    message: '자막 환경을 확인하거나 자동으로 설치할 수 있습니다.',
    components: components(),
    updatedAt: new Date().toISOString(),
    canCancel: false,
  }
  private active?: { controller: AbortController; done: Promise<void> }
  private stopping = false
  constructor(private readonly dependencies: SetupDependencies) {}

  snapshot(): SubtitleSetupStatus {
    return structuredClone(this.status)
  }
  busy(): boolean {
    return !!this.active
  }

  start(install: boolean): SubtitleSetupStatus {
    if (this.stopping) throw new Error('앱을 종료하고 있습니다.')
    if (this.active) return this.snapshot()
    if (install) this.dependencies.canInstall()
    const controller = new AbortController()
    this.status = {
      phase: install ? 'installing' : 'checking',
      message: install
        ? '필요한 자막 환경을 준비하고 있습니다.'
        : '설치된 자막 환경을 확인하고 있습니다.',
      components: components(),
      updatedAt: new Date().toISOString(),
      canCancel: true,
    }
    const operation = { controller, done: Promise.resolve() }
    this.active = operation
    this.publish()
    operation.done = this.run(install, controller.signal).finally(() => {
      this.active = undefined
      this.status.canCancel = false
      this.publish()
    })
    return this.snapshot()
  }

  cancel(): boolean {
    if (!this.active || !this.status.canCancel) return false
    this.active.controller.abort()
    this.status.canCancel = false
    this.status.message = '설치를 중단하고 있습니다. 준비가 끝난 항목은 보관합니다.'
    this.publish()
    return true
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    // Stop monitoring the independent Windows helper; never kill Windows servicing.
    this.active?.controller.abort()
    await this.active?.done
  }

  private publish(): void {
    this.status.updatedAt = new Date().toISOString()
    this.dependencies.changed?.(this.snapshot())
  }

  private component(
    id: ComponentId,
    state: SubtitleSetupComponent['state'],
    message?: string,
  ): void {
    Object.assign(this.status.components.find((item) => item.id === id)!, {
      state,
      message,
      percent: undefined,
    })
    if (message) this.status.message = message
    this.publish()
  }

  private receive = (event: unknown): void => {
    if (!event || typeof event !== 'object')
      throw new Error('설치 도구의 응답을 확인하지 못했습니다.')
    const data = event as Record<string, unknown>
    if (!data.component) return
    const item = this.status.components.find((entry) => entry.id === data.component)
    if (
      !item ||
      !['checking', 'missing', 'installing', 'ready', 'failed'].includes(String(data.state))
    )
      throw new Error('설치 도구의 상태 정보가 올바르지 않습니다.')
    item.state = data.state as SubtitleSetupComponent['state']
    item.message = typeof data.message === 'string' ? data.message.slice(0, 1200) : undefined
    item.percent =
      typeof data.percent === 'number' && Number.isFinite(data.percent)
        ? Math.max(0, Math.min(100, data.percent))
        : undefined
    if (item.message) this.status.message = item.message
    this.publish()
  }

  private async run(install: boolean, signal: AbortSignal): Promise<void> {
    try {
      await this.dependencies.native(install, signal, this.receive)
      signal.throwIfAborted()
      let wslReady = await this.dependencies.wslReady(signal)
      signal.throwIfAborted()
      if (!wslReady && install) {
        this.status.canCancel = false
        this.component(
          'wsl',
          'installing',
          'Windows 권한 승인 창을 확인해 주세요. Windows 환경 설치가 끝날 때까지 중단할 수 없습니다.',
        )
        const needsRestart = await this.dependencies.installWsl(
          (message) => this.component('wsl', 'installing', message),
          signal,
        )
        this.status.canCancel = true
        signal.throwIfAborted()
        wslReady = !needsRestart && (await this.dependencies.wslReady(signal))
        signal.throwIfAborted()
        if (!wslReady) {
          this.component(
            'wsl',
            'missing',
            'Windows를 다시 시작한 뒤 자동 설치를 다시 눌러 주세요. 계속 준비되지 않으면 시작 메뉴의 Ubuntu에서 최초 사용자 설정을 마쳐 주세요.',
          )
          this.status.phase = 'restart-required'
          return
        }
      }
      signal.throwIfAborted()
      this.component(
        'wsl',
        wslReady ? 'ready' : 'missing',
        wslReady
          ? 'Windows 자막 실행 환경이 준비되었습니다.'
          : 'Windows 자막 실행 환경을 설치하거나 초기 설정을 완료해야 합니다.',
      )
      if (wslReady) {
        if (install) {
          this.status.canCancel = false
          this.component('python', 'installing', '자막 처리 도구를 준비하고 있습니다.')
          await this.dependencies.preparePython(signal)
          this.status.canCancel = true
          signal.throwIfAborted()
        }
        await this.dependencies.environment(install, signal, this.receive)
      } else {
        for (const id of ['python', 'ollama', 'translationModel'] as const)
          this.component(id, 'missing', 'Windows 자막 실행 환경을 준비한 뒤 확인합니다.')
      }
      signal.throwIfAborted()
      const ready = this.status.components.every((item) => item.state === 'ready')
      if (ready) {
        const result = await this.dependencies.verify()
        if (!result.available) throw new Error(result.message)
      }
      signal.throwIfAborted()
      this.status.phase = ready ? 'ready' : install ? 'failed' : 'idle'
      this.status.message = ready
        ? '자막 환경 준비 완료. 이제 AI 자막 생성과 한국어 번역을 사용할 수 있습니다.'
        : install
          ? '일부 항목을 준비하지 못했습니다. 항목별 안내를 확인하고 다시 시도해 주세요.'
          : '준비가 필요한 항목이 있습니다. 자동 설치를 눌러 주세요.'
    } catch (error) {
      this.status.phase = signal.aborted ? 'cancelled' : 'failed'
      this.status.message = signal.aborted
        ? '설치를 중단했습니다. 다시 설치하면 준비된 항목을 재사용합니다.'
        : error instanceof Error
          ? error.message
          : String(error)
      for (const item of this.status.components) {
        if (item.state === 'checking' || item.state === 'installing') {
          item.state = signal.aborted ? 'missing' : 'failed'
          item.percent = undefined
        }
      }
    }
  }
}

function subtitleResource(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'subtitles', name)
    : join(app.getAppPath(), 'resources', 'subtitles', name)
}

function capture(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 30_000,
): Promise<{ code: number; output: string }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout,
        signal,
        env: { ...process.env, WSL_UTF8: '1' },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        if (error && (typeof error.code !== 'number' || error.killed)) {
          reject(error)
          return
        }
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          output: (stdout + stderr).replaceAll('\0', '').trim(),
        })
      },
    )
    child.stdin?.end()
  })
}

const listeners = new Set<() => void>()
const setup = new SubtitleSetupController({
  async native(install, signal, emit) {
    if (process.platform !== 'win32')
      throw new Error('자막 환경 자동 설치는 Windows에서 사용할 수 있습니다.')
    await runSubtitleCommand(
      subtitleResource('native/python/python.exe'),
      ['-X', 'utf8', '-u', subtitleResource('setup_models.py'), install ? '--install' : '--check'],
      { signal, cooperative: true, onLine: (line) => emit(JSON.parse(line)) },
    )
  },
  async wslReady(signal) {
    try {
      // An installer may still own Windows servicing even if Linux starts already.
      if (hasSubtitleWslInstall()) return false
      const result = await capture(
        'wsl.exe',
        [...subtitleWslArgs('default'), 'python3', '-c', 'print("DVM_WSL_READY")'],
        signal,
      )
      return result.code === 0 && result.output.includes('DVM_WSL_READY')
    } catch (error) {
      if (signal.aborted) throw error
      return false
    }
  },
  async installWsl(progress, signal) {
    return installSubtitleWsl(capture, progress, signal)
  },
  async preparePython(signal) {
    await ensureSubtitleWslUser(capture, signal)
    // Existing distributions keep their default account; only Ubuntu prerequisite packages are added.
    const probe = await capture(
      'wsl.exe',
      [
        ...subtitleWslArgs(),
        'sh',
        '-c',
        'python3 -c "import ensurepip" >/dev/null 2>&1 && command -v zstd >/dev/null 2>&1',
      ],
      signal,
    )
    if (probe.code === 0) return
    signal.throwIfAborted()
    const result = await capture(
      'wsl.exe',
      [
        ...subtitleWslArgs('root'),
        'timeout',
        '--kill-after=10s',
        '14m',
        'sh',
        '-c',
        'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq python3-venv zstd',
      ],
      undefined,
      15 * 60_000,
    )
    signal.throwIfAborted()
    if (result.code !== 0)
      throw new Error(
        '자막 처리 도구를 설치하지 못했습니다. 인터넷 연결과 Ubuntu 패키지 상태를 확인한 뒤 다시 시도해 주세요.',
      )
  },
  async environment(install, signal, emit) {
    const script = await toWslPath(subtitleResource('setup_environment.py'))
    await runSubtitleCommand(
      'wsl.exe',
      [...subtitleWslArgs(), 'python3', '-u', script, install ? '--install' : '--check'],
      {
        signal,
        cooperative: true,
        timeoutMs: install ? 6 * 60 * 60_000 : 90_000,
        onLine: (line) => emit(JSON.parse(line)),
      },
    )
  },
  verify: getSubtitleEngineInfo,
  canInstall() {
    const waiting = new Set(['paused', 'failed', 'completed', 'cancelled'])
    if (listSubtitleQueue().some((job) => !waiting.has(job.phase)))
      throw new Error('자막 생성 대기열의 작업을 모두 일시정지한 뒤 환경을 설치해 주세요.')
  },
  changed(status) {
    setSubtitleEnvironmentInstalling(status.phase === 'installing')
    for (const listener of listeners) listener()
  },
})

export const getSubtitleSetupStatus = (): SubtitleSetupStatus => setup.snapshot()
export const checkSubtitleSetup = (): SubtitleSetupStatus => setup.start(false)
export const startSubtitleSetup = (): SubtitleSetupStatus => setup.start(true)
export const cancelSubtitleSetup = (): boolean => setup.cancel()
export const hasPendingSubtitleSetup = (): boolean => setup.busy()
export const shutdownSubtitleSetup = (): Promise<void> => setup.shutdown()
export function onSubtitleSetupChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
