import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const state = vi.hoisted(() => ({
  packaged: true,
  installed: true,
  engines: 0,
  config: {} as { autoUpdateEnabled?: boolean },
  open: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getVersion: () => '0.3.4',
    getPath: () => 'C:/DVM/DarkVideoManager.exe',
    quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: state.open },
}))
vi.mock('node:fs', () => ({
  existsSync: (file: string) => state.installed && file.endsWith('Uninstall DarkVideoManager.exe'),
}))
vi.mock('electron-updater', () => ({
  NsisUpdater: class extends EventEmitter {
    constructor() {
      super()
      state.engines++
    }
  },
}))
vi.mock('../infra/config', () => ({
  loadConfig: () => state.config,
  updateConfig: (change: (value: typeof state.config) => typeof state.config) => {
    state.config = change(state.config)
  },
}))
beforeEach(() => {
  vi.resetModules()
  state.packaged = true
  state.installed = true
  state.engines = 0
  state.config = {}
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '')
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('update deployment modes', () => {
  it('enables the public updater for an installed app and persists its choice', async () => {
    const { getAppUpdates } = await import('./AppUpdateRuntime')
    const service = getAppUpdates()
    expect(service.getState()).toMatchObject({ mode: 'installer', automatic: true })
    service.setAutomatic(false)
    expect(state.config.autoUpdateEnabled).toBe(false)
    expect(state.engines).toBe(1)
  })
  it('recognizes the portable wrapper even if an installer happens to exist nearby', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'C:/DVM/portable.exe')
    const { getAppUpdates } = await import('./AppUpdateRuntime')
    expect(getAppUpdates().getState().mode).toBe('portable')
    expect(() => getAppUpdates().requestInstall()).toThrow()
  })
  it.each([true, false])(
    'creates no updater for a loose folder with packaged=%s',
    async (packaged) => {
      state.packaged = packaged
      state.installed = false
      const { getAppUpdates } = await import('./AppUpdateRuntime')
      expect(getAppUpdates().getState().phase).toBe('unsupported')
      expect(state.engines).toBe(0)
    },
  )
  it('only opens the fixed official release page', async () => {
    const { openAppRelease } = await import('./AppUpdateRuntime')
    await openAppRelease()
    expect(state.open).toHaveBeenLastCalledWith(
      'https://github.com/DarkVideoManager/DarkVideoManager/releases/latest',
    )
  })
})
