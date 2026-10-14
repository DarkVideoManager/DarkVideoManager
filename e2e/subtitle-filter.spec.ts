import { expect, test, type Page } from '@playwright/test'

function videoCard(page: Page) {
  return page.getByRole('button').filter({ has: page.getByText('Sample video', { exact: true }) })
}

function subtitleFilter(page: Page) {
  return page.getByRole('checkbox', { name: '자막 없는 영상만', exact: true })
}

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(subtitleFilter(page)).toBeVisible()
}

async function generateSubtitles(page: Page) {
  const result = await page.evaluate(() =>
    window.api.subtitles.generate('mock-library', 'mock-video-1', {
      model: 'base',
      language: 'auto',
      translateToKorean: false,
    }),
  )
  expect(result.ok).toBe(true)
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
        return result.ok ? result.value.length : 0
      }),
    )
    .toBe(1)
}

test('missing-subtitle filter preserves search and sort across playback, navigation and reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await openLibrary(page)
  await expect(subtitleFilter(page)).not.toBeChecked()
  await page.getByPlaceholder('영상 검색...').fill('Sample')
  await page.getByRole('combobox').nth(0).selectOption('title')
  await page.getByRole('combobox').nth(1).selectOption('asc')
  await videoCard(page).click()
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toBeVisible()

  await subtitleFilter(page).check()
  await expect(videoCard(page)).toBeVisible()
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toHaveCount(0)
  await expect(page.getByText('1개 영상', { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('subtitle-filter.png'), fullPage: true })

  await videoCard(page).dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(subtitleFilter(page)).toBeChecked()
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample')
  await expect(page.getByRole('combobox').nth(0)).toHaveValue('title')
  await expect(page.getByRole('combobox').nth(1)).toHaveValue('asc')

  await page.getByRole('link', { name: '통계', exact: true }).click()
  await expect(page.getByRole('heading', { name: '통계', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await expect(subtitleFilter(page)).toBeChecked()
  await expect(videoCard(page)).toBeVisible()

  await page.reload()
  await openLibrary(page)
  await expect(subtitleFilter(page)).toBeChecked()
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample')
  await expect(page.getByRole('combobox').nth(0)).toHaveValue('title')
  await expect(page.getByRole('combobox').nth(1)).toHaveValue('asc')
  await expect(videoCard(page)).toBeVisible()
})

test('existing subtitle tracks are excluded and unchecking restores the current search', async ({
  page,
}) => {
  await page.goto('/')
  await generateSubtitles(page)
  await openLibrary(page)
  await page.getByPlaceholder('영상 검색...').fill('Sample')
  await page.getByRole('combobox').nth(0).selectOption('title')
  await page.getByRole('combobox').nth(1).selectOption('asc')
  await videoCard(page).click()
  await expect(videoCard(page).getByText('자막 있음', { exact: true })).toBeVisible()
  await subtitleFilter(page).check()
  await expect(videoCard(page)).toHaveCount(0)
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toHaveCount(0)
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample')
  await expect(page.getByRole('combobox').nth(0)).toHaveValue('title')
  await expect(page.getByRole('combobox').nth(1)).toHaveValue('asc')

  await subtitleFilter(page).uncheck()
  await expect(videoCard(page)).toBeVisible()
  await expect(page.getByText('1개 영상', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample')
})

test('background subtitle completion removes a video from the active filter without opening details', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await openLibrary(page)
  await subtitleFilter(page).check()
  await expect(videoCard(page)).toBeVisible()
  await generateSubtitles(page)
  await expect(videoCard(page)).toHaveCount(0, { timeout: 10_000 })
  // An idle queue polls every five seconds, so allow the shared completion refresh to run.
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('region', { name: 'AI 자막 생성', exact: true })).toHaveCount(0)
  await expect(subtitleFilter(page)).toBeChecked()

  await subtitleFilter(page).uncheck()
  await expect(videoCard(page).getByText('자막 있음', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('missing-subtitle filtering also applies to removed videos', async ({ page }) => {
  await page.goto('/')
  await generateSubtitles(page)
  const removed = await page.evaluate(() =>
    window.api.videos.delete('mock-library', 'mock-video-1', 'remove'),
  )
  expect(removed.ok).toBe(true)
  await openLibrary(page)
  await expect(videoCard(page)).toHaveCount(0)
  await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await expect(videoCard(page)).toBeVisible()
  await subtitleFilter(page).check()
  await expect(videoCard(page)).toHaveCount(0)
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '제거한 항목', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await subtitleFilter(page).uncheck()
  await expect(videoCard(page)).toBeVisible()
  await expect(page.getByText('1개 영상', { exact: true })).toBeVisible()
})
