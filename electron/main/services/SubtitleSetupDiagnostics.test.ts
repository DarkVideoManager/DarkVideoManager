import { describe, expect, it } from 'vitest'
import { subtitleSetupDiagnostic } from './SubtitleSetupDiagnostics'

describe('subtitle setup diagnostic privacy and error classification', () => {
  it('keeps actionable codes after a path on the same line without keeping the path or token', () => {
    const message = subtitleSetupDiagnostic(
      'D:/private/video.mp4 실패 HCS_E_HYPERV_NOT_INSTALLED (0x80370102) token=private-token',
    )
    expect(message).toContain('HCS_E_HYPERV_NOT_INSTALLED')
    expect(message).toContain('0x80370102')
    expect(message).not.toMatch(/private|video\.mp4/)
  })

  it('does not restore a credential merely because its value resembles an error code', () => {
    const message = subtitleSetupDiagnostic('token=0x80370102\n인증 정보를 확인해 주세요.')
    expect(message).not.toContain('0x80370102')
    expect(message).toContain('인증 정보를 확인해 주세요.')
  })
})
