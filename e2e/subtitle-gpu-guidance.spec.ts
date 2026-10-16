import { expect, test } from '@playwright/test'

test('explains GPU support beside model selection without starting setup', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    ;(window as Window & { gpuHelpSetupStarts?: number }).gpuHelpSetupStarts = 0
    window.api.subtitles.startSetup = async () => {
      ;(window as Window & { gpuHelpSetupStarts?: number }).gpuHelpSetupStarts! += 1
      return { ok: false, error: '도움말을 열 때 설치를 시작하면 안 됩니다.' }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await expect(panel.getByLabel('음성 인식 모델')).toBeVisible()
  await panel.getByText('AMD·NVIDIA 지원 · 실제 처리 장치 확인', { exact: true }).click()
  await expect(
    panel.getByText('음성 인식을 위해 CUDA나 ROCm을 따로 설치할 필요는 없습니다.', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(panel.getByText('CPU로 자동 전환하지', { exact: false })).toBeVisible()
  await expect(panel.getByText('HCS_E_HYPERV_NOT_INSTALLED', { exact: false })).toBeVisible()
  await expect(
    panel.getByText('그래픽카드 제품명과 다를 수 있습니다.', { exact: false }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as Window & { gpuHelpSetupStarts?: number }).gpuHelpSetupStarts,
    ),
  ).toBe(0)
  await page.screenshot({ path: test.info().outputPath('gpu-model-guidance.png'), fullPage: true })
})

test('distinguishes translation device conditions on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = page.getByRole('region', { name: '한국어 번역 설정', exact: true })
  await panel.getByText('AMD·NVIDIA 지원 · 실제 처리 장치 확인', { exact: true }).click()
  await expect(
    panel.getByText('번역 장치는 Ollama 로그에서 별도로 확인하세요.', { exact: false }),
  ).toBeVisible()
  await expect(panel.getByText('음성 인식 · Windows / Vulkan', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '번역 설정 저장', exact: true })).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('gpu-translation-guidance-mobile.png'),
    fullPage: true,
  })
})
