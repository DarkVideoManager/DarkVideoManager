import type { AppUpdateState } from '@shared/appUpdate'

interface Cancellation {
  cancel(): void
}
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: any[]) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  checkForUpdates(): Promise<{ cancellationToken?: Cancellation } | null>
  downloadUpdate(cancellation?: Cancellation): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface UpdateOptions {
  mode: AppUpdateState['mode']
  version: string
  engine?: UpdateEngine
  automatic: boolean
  saveAutomatic(value: boolean): void
  requestQuit(): void
}

/** Owns update state; installers are only launched after the application's shutdown drain. */
export class AppUpdateService {
  private state: AppUpdateState
  private listeners = new Set<(state: AppUpdateState) => void>()
  private checking?: Promise<AppUpdateState>
  private downloading?: Promise<AppUpdateState>
  private cancellation?: Cancellation
  private stopped = false
  private installRequested = false
  private startupTimer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>

  constructor(private readonly options: UpdateOptions) {
    this.state = {
      revision: 0,
      mode: options.mode,
      currentVersion: options.version,
      phase: options.engine ? 'idle' : 'unsupported',
      automatic: options.automatic,
    }
    const engine = options.engine
    if (!engine) return
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.allowPrerelease = false
    engine.allowDowngrade = false
    engine.on('update-available', (info: { version: string }) => {
      if (!this.stopped)
        this.publish({
          phase: 'available',
          availableVersion: info.version,
          error: undefined,
          progress: undefined,
        })
    })
    engine.on('update-not-available', () => {
      if (!this.stopped)
        this.publish({
          phase: 'up-to-date',
          availableVersion: undefined,
          error: undefined,
          progress: undefined,
        })
    })
    engine.on(
      'download-progress',
      (progress: { percent: number; transferred: number; total: number }) => {
        if (this.stopped || this.state.phase !== 'downloading') return
        const finite = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)
        this.publish({
          progress: {
            percent: Math.min(100, finite(progress.percent)),
            transferred: finite(progress.transferred),
            total: finite(progress.total),
          },
        })
      },
    )
    engine.on('update-downloaded', (info: { version: string }) => {
      if (!this.stopped)
        this.publish({
          phase: 'ready',
          availableVersion: info.version,
          progress: undefined,
          error: undefined,
        })
    })
    // electron-updater emits errors as well as rejecting its operation promise.
    engine.on('error', () => {
      if (!this.stopped && this.state.phase !== 'installing') this.fail()
    })
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      ...(this.state.progress ? { progress: { ...this.state.progress } } : {}),
    }
  }

  subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    for (const listener of this.listeners) listener(this.getState())
  }

  private fail(): void {
    this.publish({
      phase: 'error',
      progress: undefined,
      error: '업데이트를 준비하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.',
    })
  }

  start(): void {
    if (this.stopped || !this.options.engine || this.interval) return
    const automaticCheck = () => {
      if (this.state.automatic) void this.check()
    }
    this.startupTimer = setTimeout(automaticCheck, 15_000)
    this.interval = setInterval(automaticCheck, 6 * 60 * 60 * 1000)
    this.startupTimer.unref?.()
    this.interval.unref?.()
  }

  setAutomatic(value: boolean): AppUpdateState {
    if (this.stopped) return this.getState()
    this.options.saveAutomatic(value)
    this.publish({ automatic: value })
    if (value) void this.check()
    return this.getState()
  }

  check(): Promise<AppUpdateState> {
    if (
      this.stopped ||
      !this.options.engine ||
      ['downloading', 'ready', 'installing'].includes(this.state.phase)
    )
      return Promise.resolve(this.getState())
    if (this.checking) return this.checking
    this.publish({ phase: 'checking', error: undefined })
    const operation = (async () => {
      try {
        const result = await this.options.engine!.checkForUpdates()
        this.cancellation = result?.cancellationToken
        if (this.stopped) return this.getState()
        this.publish({ checkedAt: new Date().toISOString() })
        if (this.state.phase === 'checking') this.publish({ phase: 'up-to-date' })
        if (
          this.state.automatic &&
          this.state.mode === 'installer' &&
          this.state.phase === 'available'
        )
          void this.download()
      } catch {
        if (!this.stopped) this.fail()
      }
      return this.getState()
    })()
    this.checking = operation
    void operation.finally(() => {
      if (this.checking === operation) this.checking = undefined
    })
    return operation
  }

  download(): Promise<AppUpdateState> {
    if (this.downloading) return this.downloading
    if (
      this.stopped ||
      this.state.mode !== 'installer' ||
      !this.options.engine ||
      !this.state.availableVersion ||
      !['available', 'error'].includes(this.state.phase)
    )
      return Promise.resolve(this.getState())
    this.publish({ phase: 'downloading', error: undefined, progress: undefined })
    const operation = (async () => {
      try {
        await this.options.engine!.downloadUpdate(this.cancellation)
      } catch {
        if (!this.stopped) this.fail()
      }
      return this.getState()
    })()
    this.downloading = operation
    void operation.finally(() => {
      if (this.downloading === operation) this.downloading = undefined
    })
    return operation
  }

  requestInstall(): AppUpdateState {
    if (this.stopped || this.state.mode !== 'installer' || this.state.phase !== 'ready')
      throw new Error('다운로드가 완료된 설치형 업데이트가 없습니다.')
    this.installRequested = true
    this.publish({ phase: 'installing', error: undefined })
    this.options.requestQuit()
    return this.getState()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.startupTimer)
    clearInterval(this.interval)
    this.cancellation?.cancel()
  }

  finishInstall(safeToInstall: boolean): void {
    if (!this.installRequested) return
    this.installRequested = false
    // A failed checkpoint must never be followed by replacing the application.
    if (safeToInstall) {
      try {
        this.options.engine?.quitAndInstall(false, true)
      } catch {
        /* normal quit remains available */
      }
    }
  }
}
