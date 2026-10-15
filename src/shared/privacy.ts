import { z } from 'zod'

export function isSafeExitUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

export const PrivacySettingsZ = z
  .object({
    maskThumbnails: z.boolean(),
    revealOnHover: z.boolean(),
    exitAction: z.enum(['close', 'blank', 'website']),
    exitUrl: z.string().max(2048),
  })
  .strict()
  .refine((settings) => settings.exitAction !== 'website' || isSafeExitUrl(settings.exitUrl), {
    message: '웹 화면은 사용자 이름·암호가 없는 HTTPS 주소를 입력하세요.',
    path: ['exitUrl'],
  })

export type PrivacySettings = z.infer<typeof PrivacySettingsZ>
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  maskThumbnails: false,
  revealOnHover: true,
  exitAction: 'close',
  exitUrl: '',
}
