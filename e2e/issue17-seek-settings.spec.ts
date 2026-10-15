import { expect, test, type Page } from '@playwright/test'
import type { AppSettings } from '../src/shared/types'

type SeekSettingsWindow = Window & {
  seekSettingsHarness: { failSave: boolean; patches: Partial<AppSettings>[] }
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await expect(dialog.getByLabel('기본 탐색 간격 (초)', { exact: true })).toBeVisible()
  return dialog
}

async function prepare(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const update = window.api.app.updateSettings
    const state = { failSave: false, patches: [] as Partial<AppSettings>[] }
    ;(window as unknown as SeekSettingsWindow).seekSettingsHarness = state
    window.api.app.updateSettings = async (patch) => {
      state.patches.push(structuredClone(patch))
      if (state.failSave) return { ok: false, error: '탐색 설정 저장 테스트 실패' }
      return update(patch)
    }
  })
  return openSettings(page)
}

test('seek interval defaults to one second and only the saved value is applied', async ({
  page,
}) => {
  const dialog = await prepare(page)
  const input = dialog.getByLabel('기본 탐색 간격 (초)', { exact: true })
  const applied = dialog.getByLabel('현재 적용된 탐색 간격', { exact: true })
  await expect(input).toHaveValue('1')
  await expect(applied).toHaveText('현재 적용: 1초')
  await input.fill('10')
  await expect(applied).toHaveText('현재 적용: 1초')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('탐색 간격을 저장했습니다.')
  await expect(applied).toHaveText('현재 적용: 10초')
  expect(
    await page.evaluate(
      () => (window as unknown as SeekSettingsWindow).seekSettingsHarness.patches,
    ),
  ).toEqual([{ seekStepSec: 10 }])
  await dialog
    .getByRole('region', { name: '재생 탐색', exact: true })
    .screenshot({ path: test.info().outputPath('seek-interval-settings.png') })
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  const reopened = await openSettings(page)
  await expect(reopened.getByLabel('기본 탐색 간격 (초)', { exact: true })).toHaveValue('10')
  await expect(reopened.getByLabel('현재 적용된 탐색 간격', { exact: true })).toHaveText(
    '현재 적용: 10초',
  )
})

test('seek settings reject empty, fractional and out-of-range input before saving', async ({
  page,
}) => {
  const dialog = await prepare(page)
  const input = dialog.getByLabel('기본 탐색 간격 (초)', { exact: true })
  const save = dialog.getByRole('button', { name: '저장', exact: true })
  for (const value of ['', '0', '-1', '1.5', '601']) {
    await input.fill(value)
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(save).toBeDisabled()
    await input.press('Enter')
  }
  expect(
    await page.evaluate(
      () => (window as unknown as SeekSettingsWindow).seekSettingsHarness.patches,
    ),
  ).toEqual([])
  await input.fill('600')
  await expect(input).toHaveAttribute('aria-invalid', 'false')
  await save.click()
  await expect(dialog.getByLabel('현재 적용된 탐색 간격', { exact: true })).toHaveText(
    '현재 적용: 600초',
  )
})

test('a failed seek setting save keeps the draft for retry and leaves the applied value unchanged', async ({
  page,
}) => {
  const dialog = await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as SeekSettingsWindow).seekSettingsHarness.failSave = true
  })
  const input = dialog.getByLabel('기본 탐색 간격 (초)', { exact: true })
  await input.fill('15')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('탐색 설정 저장 테스트 실패')
  await expect(input).toHaveValue('15')
  await expect(dialog.getByLabel('현재 적용된 탐색 간격', { exact: true })).toHaveText(
    '현재 적용: 1초',
  )
  await expect(dialog.getByRole('status')).toHaveCount(0)
  const savedBefore = await page.evaluate(() => window.api.app.getSettings())
  expect(savedBefore.ok && savedBefore.value.seekStepSec).toBe(1)
  await page.evaluate(() => {
    ;(window as unknown as SeekSettingsWindow).seekSettingsHarness.failSave = false
  })
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('탐색 간격을 저장했습니다.')
  await expect(dialog.getByLabel('현재 적용된 탐색 간격', { exact: true })).toHaveText(
    '현재 적용: 15초',
  )
})
