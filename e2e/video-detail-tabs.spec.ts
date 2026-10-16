import { expect, test, type Page } from '@playwright/test'

async function selectVideo(page: Page, unknown = false) {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api?.videos))
  await page.evaluate(async (missing) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    Object.assign(result.value, {
      fps: missing ? 0 : 30000 / 1001,
      width: missing ? undefined : 1920,
      height: missing ? undefined : 1080,
      durationSec: missing ? 0 : 125,
      codec: missing ? '' : 'hevc',
      container: missing ? undefined : 'matroska',
      bitrate: missing ? Number.NaN : 1234.5,
      sizeBytes: missing ? 0 : 16 * 1024 * 1024,
    })
    const state = { engineReads: 0, playbackReads: 0 }
    ;(window as Window & { detailReads?: typeof state }).detailReads = state
    const engine = window.api.subtitles.getEngineInfo
    window.api.subtitles.getEngineInfo = async () => {
      state.engineReads++
      return engine()
    }
    const playback = window.api.videos.getPlaybackSource
    window.api.videos.getPlaybackSource = async (...args) => {
      state.playbackReads++
      return playback(...args)
    }
  }, unknown)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
}

test('shows FPS before playback and keeps AI generation separate from information and highlights', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await selectVideo(page)
  const tabs = page.getByRole('tablist', { name: '영상 상세 탭' })
  await expect(tabs.getByRole('tab')).toHaveText(['정보', '하이라이트', '자막 생성'])
  const metadata = page.getByRole('region', { name: '영상 메타데이터' })
  await expect(metadata).toContainText('29.97 FPS')
  await expect(metadata).toContainText('1920 × 1080')
  await expect(metadata).toContainText('2분 5초')
  await expect(metadata).toContainText('hevc')
  await expect(metadata).toContainText('matroska')
  await expect(metadata).toContainText('1234.5 kbps')
  await expect(metadata).toContainText('16.0 MB')
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'AI 자막 생성', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as Window & { detailReads?: unknown }).detailReads),
  ).toEqual({ engineReads: 0, playbackReads: 0 })
  await page.screenshot({ path: test.info().outputPath('video-information-before-playback.png') })
  await tabs.getByRole('tab', { name: '자막 생성', exact: true }).click()
  const generation = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await expect(generation).toBeVisible()
  await generation.getByLabel('음성 인식 모델', { exact: true }).selectOption('small')
  await generation.getByLabel('영상 언어', { exact: true }).selectOption('ja')
  await tabs.getByRole('tab', { name: '하이라이트', exact: true }).click()
  await expect(metadata).toHaveCount(0)
  await expect(generation).toHaveCount(0)
  await tabs.getByRole('tab', { name: '자막 생성', exact: true }).click()
  await expect(generation.getByLabel('음성 인식 모델', { exact: true })).toHaveValue('small')
  await expect(generation.getByLabel('영상 언어', { exact: true })).toHaveValue('ja')
  await tabs.getByRole('tab', { name: '자막 생성', exact: true }).press('Home')
  await expect(tabs.getByRole('tab', { name: '정보', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(metadata).toContainText('29.97 FPS')
  expect(errors).toEqual([])
})

test('does not invent unknown FPS and preserves real zero duration and file size', async ({
  page,
}) => {
  await selectVideo(page, true)
  const metadata = page.getByRole('region', { name: '영상 메타데이터' })
  await expect(metadata).toContainText('정보 없음')
  await expect(metadata).not.toContainText('0 FPS')
  await expect(metadata).not.toContainText('NaN')
  await expect(metadata).toContainText('0분 0초')
  await expect(metadata).toContainText('0.0 MB')
  await expect(metadata).toContainText('프레임레이트를 확인하지 못했습니다')
})

test('leaving generation cancels an unsubmitted deletion confirmation and releases Escape', async ({
  page,
}) => {
  await selectVideo(page)
  await page.evaluate(() => {
    const state = { deletions: 0, exits: 0 }
    ;(window as Window & { detailActions?: typeof state }).detailActions = state
    window.api.subtitles.getForVideo = async () => ({
      ok: true,
      value: [
        {
          id: 'existing-track',
          videoId: 'mock-video-1',
          filePath: '/mock/videos/sample.srt',
          type: 'srt',
          isEmbedded: false,
        },
      ],
    })
    window.api.subtitles.regenerate = async () => {
      state.deletions++
      return { ok: false, error: 'This action must not be submitted' }
    }
    window.api.app.quit = async () => {
      state.exits++
      return { ok: true, value: null }
    }
  })
  await page.getByRole('tab', { name: '자막 생성', exact: true }).click()
  await page.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('tab', { name: '정보', exact: true }).click()
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)
  await page.getByRole('tab', { name: '자막 생성', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('tab', { name: '정보', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => (window as Window & { detailActions?: unknown }).detailActions))
    .toEqual({ deletions: 0, exits: 1 })
})
