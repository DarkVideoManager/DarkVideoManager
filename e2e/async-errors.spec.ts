import { expect, test, type Page } from '@playwright/test'

interface ErrorHarness {
  captures: number
  updates: number
  unhandled: string[]
}
type ErrorWindow = Window & { errorHarness: ErrorHarness }

async function prepareErrors(page: Page, captureRejects: boolean): Promise<void> {
  await page.goto('/')
  await page.evaluate(async (rejectCapture) => {
    const state: ErrorHarness = { captures: 0, updates: 0, unhandled: [] }
    ;(window as unknown as ErrorWindow).errorHarness = state
    window.addEventListener('unhandledrejection', (event) =>
      state.unhandled.push(String(event.reason)),
    )
    await window.api.highlights.create('mock-library', {
      videoId: 'mock-video-1',
      timeStart: 5,
      color: 'yellow',
    })
    window.api.thumbnails.getForVideo = async () => ({ ok: true, value: [] })
    window.api.thumbnails.captureAtTime = async (_libraryId, videoId, timeSec) => {
      state.captures += 1
      if (rejectCapture) throw new Error('자동 복구 IPC 테스트 실패')
      return {
        ok: true,
        value: {
          id: 'recovery-thumbnail',
          videoId,
          timeSec: timeSec + 0.2,
          filePath: '/mock/capture.jpg',
          isPrimary: false,
          createdAt: '2026-10-01',
        },
      }
    }
    window.api.highlights.update = async () => {
      state.updates += 1
      return { ok: false, error: '다른 작업이 진행 중입니다.' }
    }
    window.api.thumbnails.ensureForVideo = async () => {
      throw new Error('수동 썸네일 IPC 테스트 실패')
    }
    window.api.videos.updateMeta = async () => ({ ok: false, error: '메타데이터 작업 중입니다.' })
    window.api.highlights.delete = async () => ({ ok: false, error: '하이라이트 작업 중입니다.' })
  }, captureRejects)
  await page.getByRole('button', { name: '열기', exact: true }).click()
}

for (const captureRejects of [true, false]) {
  test(`automatic thumbnail ${captureRejects ? 'IPC rejection' : 'busy result'} is contained and manual failures are shown`, async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await prepareErrors(page, captureRejects)
    await page
      .getByRole('button')
      .filter({ has: page.getByText('Sample video', { exact: true }) })
      .click()
    await page.getByRole('button', { name: '하이라이트', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ErrorWindow).errorHarness.captures))
      .toBeGreaterThan(0)
    if (!captureRejects) {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as ErrorWindow).errorHarness.updates))
        .toBeGreaterThan(0)
    }
    await page.getByRole('button', { name: '정보', exact: true }).click()
    await page.getByRole('button', { name: '다시 생성', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('수동 썸네일 IPC 테스트 실패')
    await page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...').fill('저장 실패 테스트')
    await expect(page.getByRole('alert')).toContainText('메타데이터 작업 중입니다.')
    await page.getByRole('button', { name: '하이라이트', exact: true }).click()
    await page.getByRole('button', { name: '삭제', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('하이라이트 작업 중입니다.')
    expect(
      await page.evaluate(() => (window as unknown as ErrorWindow).errorHarness.unhandled),
    ).toEqual([])
    expect(pageErrors).toEqual([])
  })
}

test('player shortcuts and playback telemetry rejections are handled without unhandled promises', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await prepareErrors(page, true)
  await page.evaluate(() => {
    window.api.highlights.create = async () => {
      throw new Error('하이라이트 생성 IPC 테스트 실패')
    }
    window.api.playback.heartbeat = async () => {
      throw new Error('재생 기록 IPC 테스트 실패')
    }
  })
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.keyboard.press('h')
  await expect(
    page.getByRole('alert').filter({ hasText: '하이라이트 생성 IPC 테스트 실패' }),
  ).toBeVisible()
  await page.keyboard.press('f')
  await expect(
    page.getByRole('alert').filter({ hasText: '자동 복구 IPC 테스트 실패' }),
  ).toBeVisible()
  await page.keyboard.press('q')
  await page.locator('video').evaluate((video) => video.dispatchEvent(new Event('pause')))
  await expect(
    page.getByRole('alert').filter({ hasText: '재생 기록 IPC 테스트 실패' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as ErrorWindow).errorHarness.unhandled),
  ).toEqual([])
  expect(pageErrors).toEqual([])
})
