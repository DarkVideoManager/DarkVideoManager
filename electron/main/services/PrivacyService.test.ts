import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRIVACY_SETTINGS, PrivacySettingsZ } from '@shared/privacy'
import type { Config } from '@shared/types'
const state = vi.hoisted(() => ({
  config: { libraries: [] } as Config,
  save: vi.fn(),
  open: vi.fn(),
  mpv: vi.fn(),
  native: vi.fn(),
}))
vi.mock('../infra/config', () => ({
  loadConfig: () => state.config,
  updateConfig: (updater: (config: Config) => Config) => {
    state.save()
    state.config = updater(state.config)
  },
}))
vi.mock('electron', () => ({ shell: { openExternal: state.open } }))
vi.mock('./MpvSessionService.js', () => ({ closeAllMpvSessions: state.mpv }))
vi.mock('./NativePlayerService', () => ({ closeManagedNativePlayers: state.native }))
import { exitPrivateView, getPrivacySettings, savePrivacySettings } from './PrivacyService'

beforeEach(() => {
  vi.resetAllMocks()
  state.config = { libraries: [], cacheLimitGb: 7 }
})
// Synthetic URL tests rejection of embedded credentials, without real credentials.
const credentialUrl = new URL('https://example.com')
credentialUrl.username = 'user'
credentialUrl.password = 'YOUR_PASSWORD'

describe('screen privacy preferences and exit', () => {
  it('attempts every playback cleanup even if one player refuses to close', async () => {
    state.native.mockImplementation(() => {
      throw new Error('player still running')
    })
    await expect(exitPrivateView()).rejects.toThrow('player still running')
    expect(state.mpv).toHaveBeenCalledOnce()
    expect(state.open).not.toHaveBeenCalled()
  })
  it('keeps the legacy close default and saves independently without touching other preferences', () => {
    expect(getPrivacySettings()).toEqual(DEFAULT_PRIVACY_SETTINGS)
    savePrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, maskThumbnails: true })
    expect(state.config.cacheLimitGb).toBe(7)
    expect(getPrivacySettings().maskThumbnails).toBe(true)
  })
  it.each([
    'javascript:alert(1)',
    'file:///C:/secret',
    'http://example.com',
    credentialUrl.href,
    '',
  ])('rejects unsafe exit URL %s before saving or opening', async (exitUrl) => {
    expect(() =>
      savePrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, exitAction: 'website', exitUrl }),
    ).toThrow()
    expect(state.save).not.toHaveBeenCalled()
    expect(state.open).not.toHaveBeenCalled()
  })
  it('preserves the previous setting when persistence fails', () => {
    state.save.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => savePrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, exitAction: 'blank' })).toThrow(
      'disk full',
    )
    expect(getPrivacySettings().exitAction).toBe('close')
  })
  it('stops app-owned players before opening only the saved HTTPS page', async () => {
    state.config.privacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      exitAction: 'website',
      exitUrl: 'https://example.com/',
    }
    expect(await exitPrivateView()).toBe('website')
    expect(state.mpv.mock.invocationCallOrder[0]).toBeLessThan(
      state.open.mock.invocationCallOrder[0],
    )
    expect(state.native).toHaveBeenCalledOnce()
    expect(state.open).toHaveBeenCalledWith('https://example.com/')
  })
  it('does not open anything for blank mode and reports browser launch failure', async () => {
    state.config.privacySettings = { ...DEFAULT_PRIVACY_SETTINGS, exitAction: 'blank' }
    expect(await exitPrivateView()).toBe('blank')
    expect(state.open).not.toHaveBeenCalled()
    state.config.privacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      exitAction: 'website',
      exitUrl: 'https://example.com/',
    }
    state.open.mockRejectedValue(new Error('launch failed'))
    await expect(exitPrivateView()).rejects.toThrow('가림 화면은 유지')
  })
  it('requires complete validated settings rather than arbitrary renderer fields', () => {
    expect(
      PrivacySettingsZ.safeParse({ ...DEFAULT_PRIVACY_SETTINGS, arbitraryCommand: 'anything' })
        .success,
    ).toBe(false)
  })
})
