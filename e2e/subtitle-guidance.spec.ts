import { expect, test } from '@playwright/test'
import type { SubtitleGenerationOptions } from '../src/shared/types'

test('explains the generation workflow and submits the selected large-v2 model', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(() => {
    window.api.subtitles.generate = async (_libraryId, _videoId, options) => {
      ;(
        window as Window & { submittedSubtitleOptions?: SubtitleGenerationOptions }
      ).submittedSubtitleOptions = options
      return { ok: false, error: '테스트: 다운로드 없이 요청 확인' }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await panel.getByText('처음 자막 만들기 · 모델·언어·비용', { exact: true }).click()
  await expect(
    panel.getByText('영상을 재생하는 것만으로 시작하지 않습니다.', { exact: false }),
  ).toBeVisible()
  await expect(panel.getByText('영상 옆의 .ai.srt', { exact: false })).toBeVisible()
  await panel.getByLabel('음성 인식 모델').selectOption({ label: 'large-v2 · 대형' })
  await expect(panel.getByText('대형 모델이 없으면 약 3.1GB', { exact: false })).toBeVisible()
  await panel.getByLabel('영상 언어').selectOption('ja')
  await panel.getByLabel('한국어 번역 자막도 생성').uncheck()
  await page.screenshot({
    path: test.info().outputPath('subtitle-model-guidance.png'),
    fullPage: true,
  })
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByText('테스트: 다운로드 없이 요청 확인', { exact: false })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as Window & { submittedSubtitleOptions?: SubtitleGenerationOptions })
          .submittedSubtitleOptions,
    ),
  ).toEqual({ model: 'large-v2', language: 'ja', translateToKorean: false })
})

test('shows conditional installation help without starting an installation', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    ;(window as Window & { installationStarts?: number }).installationStarts = 0
    window.api.subtitles.startSetup = async () => {
      ;(window as Window & { installationStarts?: number }).installationStarts! += 1
      throw new Error('도움말을 열 때 설치가 시작되면 안 됩니다.')
    }
  })
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = page.getByRole('region', { name: '자막 환경 자동 설치', exact: true })
  await panel.getByText('설치 전 확인 · 권한 승인 · Ubuntu 초기 설정', { exact: true }).click()
  await expect(
    panel.getByText('최초 사용자 설정 메시지가 계속 표시되는 경우에만', { exact: false }),
  ).toBeVisible()
  await expect(panel.getByLabel('Ubuntu 최초 설정 화면 예시')).toContainText('New password:')
  await expect(
    panel.getByText('음성 인식 엔진·base 모델은 Windows에', { exact: false }),
  ).toBeVisible()
  await expect(
    panel.getByText('준비 중·재시작 필요는 실패와 구분됩니다.', { exact: false }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as Window & { installationStarts?: number }).installationStarts,
    ),
  ).toBe(0)
  await page.screenshot({
    path: test.info().outputPath('subtitle-installation-guidance.png'),
    fullPage: true,
  })
})

test('opens privacy help by keyboard in settings and exposes only fixed official links', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  const summary = dialog.getByText('개인정보 처리 · 공식 배포 확인', { exact: true })
  await dialog.getByRole('button', { name: '닫기', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(summary).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    dialog.getByText('영상·음성·파일 경로는 이 번역 요청에 포함하지 않습니다.', { exact: false }),
  ).toBeVisible()
  await expect(dialog.getByText('사용은 기본으로 꺼져 있습니다.', { exact: false })).toBeVisible()
  const privacy = dialog.getByRole('link', { name: '개인정보 처리 전문', exact: true })
  await expect(privacy).toHaveAttribute(
    'href',
    'https://github.com/DarkVideoManager/DarkVideoManager/blob/main/docs/PRIVACY.md',
  )
  await expect(privacy).toHaveAttribute('target', '_blank')
  await expect(
    dialog.getByRole('link', { name: '공식 다운로드·검증 파일', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/DarkVideoManager/DarkVideoManager/releases/latest')
  await page.keyboard.press('Tab')
  await expect(privacy).toBeFocused()
  await page.screenshot({ path: test.info().outputPath('settings-privacy-guidance.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})
