import { shell } from 'electron'
import { DEFAULT_PRIVACY_SETTINGS, PrivacySettingsZ, type PrivacySettings } from '@shared/privacy'
import { loadConfig, updateConfig } from '../infra/config'
import { closeAllMpvSessions } from './MpvSessionService.js'
import { closeManagedNativePlayers } from './NativePlayerService'

export function getPrivacySettings(): PrivacySettings {
  return PrivacySettingsZ.parse(loadConfig().privacySettings ?? DEFAULT_PRIVACY_SETTINGS)
}
export function savePrivacySettings(settings: PrivacySettings): PrivacySettings {
  const validated = PrivacySettingsZ.parse(settings)
  updateConfig((config) => ({ ...config, privacySettings: validated }))
  return getPrivacySettings()
}
export async function exitPrivateView(): Promise<PrivacySettings['exitAction']> {
  // The renderer covers the screen and pauses its video before invoking this operation.
  let cleanupError: unknown
  for (const close of [closeManagedNativePlayers, closeAllMpvSessions]) {
    try {
      close()
    } catch (cause) {
      cleanupError ??= cause
    }
  }
  if (cleanupError) throw cleanupError
  const settings = getPrivacySettings()
  if (settings.exitAction === 'website') {
    try {
      await shell.openExternal(settings.exitUrl)
    } catch {
      throw new Error(
        '웹 화면을 열지 못했습니다. 가림 화면은 유지됩니다. 설정의 주소를 확인하세요.',
      )
    }
  }
  return settings.exitAction
}
