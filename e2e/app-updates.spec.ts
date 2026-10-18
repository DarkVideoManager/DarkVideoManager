import { test, expect, type Page } from '@playwright/test'
import type { AppUpdateState } from '../src/shared/appUpdate'

interface UpdateHarness {
  installs: number
  opens: number
  failDownload: boolean
  emit(patch: Partial<AppUpdateState>): void
  finishGet(): void
}
type UpdateWindow = Window & { updateHarness: UpdateHarness }

async function prepare(
  page: Page,
  options: {
    mode?: 'installer' | 'portable'
    phase?: AppUpdateState['phase']
    delayed?: boolean
  } = {},
) {
  await page.addInitScript((options) => {
    let api: Window['api']
    const listeners = new Set<(state: AppUpdateState) => void>()
    const delayed: (() => void)[] = []
    let state: AppUpdateState = {
      revision: 0,
      mode: options.mode ?? 'installer',
      currentVersion: '0.3.4',
      availableVersion: '0.3.5',
      phase: options.phase ?? 'ready',
      automatic: true,
    }
    const harness = {
      installs: 0,
      opens: 0,
      failDownload: false,
      emit(patch: Partial<AppUpdateState>) {
        state = { ...state, ...patch, revision: state.revision + 1 }
        for (const listener of listeners) listener({ ...state })
      },
      finishGet() {
        for (const finish of delayed) finish()
      },
    }
    Object.assign(window, { updateHarness: harness })
    Object.defineProperty(window, 'api', {
      configurable: true,
      get: () => api,
      set(value: Window['api']) {
        api = value
        api.updates = {
          get: async () => {
            const snapshot = { ...state }
            if (options.delayed) await new Promise<void>((resolve) => delayed.push(resolve))
            return { ok: true, value: snapshot }
          },
          check: async () => {
            harness.emit({ phase: 'up-to-date' })
            return { ok: true, value: { ...state } }
          },
          download: async () => {
            if (harness.failDownload) return { ok: false, error: '다운로드 실패 테스트' }
            harness.emit({ phase: 'ready' })
            return { ok: true, value: { ...state } }
          },
          install: async () => {
            harness.installs++
            harness.emit({ phase: 'installing' })
            return { ok: true, value: { ...state } }
          },
          setAutomatic: async (automatic) => {
            harness.emit({ automatic })
            return { ok: true, value: { ...state } }
          },
          openRelease: async () => {
            harness.opens++
            return { ok: true, value: null }
          },
        }
        api.on.appUpdateChanged = (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }
      },
    })
  }, options)
  await page.goto('/')
}

test('a downloaded update waits for explicit restart and can be deferred to settings', async ({
  page,
}) => {
  await prepare(page)
  const notice = page.getByRole('complementary', { name: '새 버전 알림' })
  await expect(notice).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as UpdateWindow).updateHarness.installs),
  ).toBe(0)
  await notice.getByRole('button', { name: '나중에' }).click()
  await expect(notice).not.toBeVisible()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const section = page.getByRole('region', { name: '앱 업데이트' })
  await expect(section.getByText('0.3.5 버전 설치 준비가 끝났습니다.')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('update-settings-ready.png') })
  await section.getByRole('button', { name: '재시작하여 업데이트' }).click()
  await expect(section.getByText('작업을 저장하고 업데이트를 적용합니다...')).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as UpdateWindow).updateHarness.installs),
  ).toBe(1)
})

test('renders progress and ignores an older asynchronous snapshot', async ({ page }) => {
  await prepare(page, { phase: 'idle', delayed: true })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.evaluate(() => {
    const harness = (window as unknown as UpdateWindow).updateHarness
    harness.emit({ phase: 'downloading', progress: { percent: 42, transferred: 42, total: 100 } })
    harness.finishGet()
  })
  await expect(page.getByRole('progressbar', { name: '업데이트 다운로드' })).toHaveAttribute(
    'value',
    '42',
  )
  await expect(page.getByRole('button', { name: '새 버전 확인', exact: true })).toBeDisabled()
})

test('persists the automatic update choice when settings is reopened', async ({ page }) => {
  await prepare(page, { phase: 'idle' })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const checkbox = page.getByRole('checkbox', { name: '자동 확인 및 다운로드' })
  await checkbox.uncheck()
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(checkbox).not.toBeChecked()
  await page.getByRole('button', { name: '새 버전 확인', exact: true }).click()
  await expect(page.getByText('최신 버전입니다.', { exact: true })).toBeVisible()
})

test('portable updates offer a download link and never an installation action', async ({
  page,
}) => {
  await prepare(page, { mode: 'portable', phase: 'available' })
  await page.getByRole('button', { name: '포터블 다운로드', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as UpdateWindow).updateHarness.opens)).toBe(1)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '새 버전 자동 확인' })).toBeVisible()
  await expect(page.getByRole('button', { name: '재시작하여 업데이트' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '업데이트 다운로드', exact: true })).toHaveCount(0)
})

test('a failed download can be retried without exposing an install action', async ({ page }) => {
  await prepare(page, { phase: 'available' })
  await page.evaluate(() => {
    ;(window as unknown as UpdateWindow).updateHarness.failDownload = true
  })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const section = page.getByRole('region', { name: '앱 업데이트' })
  await section.getByRole('button', { name: '업데이트 다운로드', exact: true }).click()
  await expect(section.getByRole('alert')).toHaveText('다운로드 실패 테스트')
  await expect(section.getByRole('button', { name: '재시작하여 업데이트' })).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as unknown as UpdateWindow).updateHarness.failDownload = false
  })
  await section.getByRole('button', { name: '업데이트 다운로드', exact: true }).click()
  await expect(section.getByRole('button', { name: '재시작하여 업데이트' })).toBeVisible()
})
