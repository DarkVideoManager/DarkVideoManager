import { expect, test } from '@playwright/test'

test('restored library, metadata, imports, shortcuts and statistics work through mock IPC', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '라이브러리 선택' })).toBeVisible()
  await page.getByRole('button', { name: '열기', exact: true }).click()
  const card = page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
  await expect(card).toBeVisible()
  await expect(page.getByRole('button', { name: /가져오기$/ })).toHaveText([
    '폴더 가져오기',
    'CSV 가져오기',
  ])
  expect(await page.evaluate(() => Object.keys(window.api.dataImport).sort())).toEqual([
    'importCsv',
    'preview',
    'selectCsv',
  ])
  await page.screenshot({ path: test.info().outputPath('restored-library.png') })
  await card.click()
  await page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...').fill('복원된 메모 저장')
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.api.videos.get('mock-library', 'mock-video-1')
        return result.ok ? result.value?.memo : null
      }),
    )
    .toBe('복원된 메모 저장')

  await page.getByRole('button', { name: '폴더 가져오기', exact: true }).click()
  await page.getByRole('button', { name: '선택', exact: true }).click()
  await page.getByRole('button', { name: '가져오기', exact: true }).click()
  await expect(page.getByText(/가져오기 완료/)).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()

  await page.getByRole('button', { name: 'CSV 가져오기', exact: true }).click()
  await page.getByRole('button', { name: 'CSV 선택', exact: true }).click()
  await page.getByRole('button', { name: '분석', exact: true }).click()
  await expect(page.getByText('미리보기', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '가져오기 적용', exact: true }).click()
  await expect(page.getByText('가져오기 완료', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()

  await card.dblclick()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByRole('button', { name: 'mpv로 열기', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('restored-player.png') })
  await page.keyboard.press('h')
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.api.highlights.list('mock-library', 'mock-video-1')
        return result.ok ? result.value.length : 0
      }),
    )
    .toBe(1)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('link', { name: '통계', exact: true }).click()
  await expect(page.getByRole('heading', { name: '통계' })).toBeVisible()
  await expect(page.getByRole('button', { name: '90일' })).toBeVisible()
  expect(errors).toEqual([])
})

test('library pages continue past the former 5,000-video limit', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const response = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!response.ok || !response.value) throw new Error('Missing fixture')
    const template = response.value
    window.api.videos.search = async (_libraryId, query) => {
      const pageNumber = query.page ?? 1
      const pageSize = query.pageSize ?? 500
      const start = (pageNumber - 1) * pageSize
      return {
        ok: true,
        value: {
          total: 5001,
          page: pageNumber,
          pageSize,
          videos: Array.from(
            { length: Math.max(0, Math.min(pageSize, 5001 - start)) },
            (_, index) => ({
              ...template,
              id: `video-${start + index}`,
              title: `영상 ${start + index}`,
            }),
          ),
        },
      }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  for (let count = 500; count <= 5000; count += 500) {
    await page.getByRole('button', { name: `더 불러오기 (${count} / 5001)`, exact: true }).click()
  }
  await expect(page.getByRole('button', { name: /더 불러오기/ })).toHaveCount(0)
  await expect(page.getByText('5001개 영상', { exact: true })).toBeVisible()
})

test('delayed playback source preserves the video element, resumes after metadata, and saves final position', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const response = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!response.ok || !response.value) throw new Error('Missing fixture')
    response.value.resumePosSec = 45
    const state = window as typeof window & { releasePlayback?: () => void; finalPosition?: number }
    window.api.videos.getPlaybackSource = () =>
      new Promise((resolve) => {
        state.releasePlayback = () => resolve({ ok: true, value: '/mock/delayed.mp4' })
      })
    window.api.playback.end = async (_libraryId, _videoId, position) => {
      state.finalPosition = position
      return { ok: true, value: null }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  const original = await page.locator('video').elementHandle()
  await page.evaluate(() =>
    (window as typeof window & { releasePlayback: () => void }).releasePlayback(),
  )
  await expect(page.locator('video')).toHaveAttribute('src', /delayed.mp4/)
  expect(await original!.evaluate((video) => video === document.querySelector('video'))).toBe(true)
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'duration', { configurable: true, value: 125 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('loadedmetadata'))
  })
  await expect
    .poll(async () =>
      page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBe(45)
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.currentTime = 88
    video.dispatchEvent(new Event('timeupdate'))
  })
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect
    .poll(async () =>
      page.evaluate(() => (window as typeof window & { finalPosition?: number }).finalPosition),
    )
    .toBe(88)
})
