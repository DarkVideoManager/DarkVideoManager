import { expect, test, type Page } from '@playwright/test'

async function reopenDetails(page: Page) {
  await page.getByRole('link', { name: '통계', exact: true }).click()
  await expect(page.getByRole('region', { name: '대표 썸네일 선택' })).toHaveCount(0)
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await page.getByRole('button', { name: 'Sample video 영상 카드', exact: true }).click()
}

async function openCandidates(
  page: Page,
  mode: 'normal' | 'empty' | 'failed' | 'unreadable' = 'normal',
) {
  await page.setViewportSize({ width: 1440, height: 1100 })
  // Adapt Electron's URL protocol only; selection still uses the real renderer and IPC contract.
  await page.route('**/utils/media.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export function toLocalMediaUrl(path) { return path }',
    }),
  )
  await page.route('**/candidate-*.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#6366f1"/></svg>',
    }),
  )
  await page.goto('/')
  await expect(page.getByRole('button', { name: '열기', exact: true })).toBeVisible()
  await page.evaluate(async (fixtureMode) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing fixture')
    const video = result.value
    const candidates = [1, 2, 3].map((index) => ({
      id: `candidate-${index}`,
      videoId: video.id,
      filePath: `/candidate-${index}.svg`,
      timeSec: index * 10,
      isPrimary: index === 1,
      createdAt: video.createdAt,
    }))
    video.primaryThumbnailPath = candidates[0].filePath
    window.api.thumbnails.getForVideo = async () => ({
      ok: true,
      value: structuredClone(candidates),
    })
    if (fixtureMode === 'empty')
      window.api.thumbnails.getForVideo = async () => ({ ok: true, value: [] })
    if (fixtureMode === 'failed')
      window.api.thumbnails.getForVideo = async () => ({ ok: false, error: '조회 실패' })
    if (fixtureMode === 'unreadable') {
      candidates[0].filePath = '/missing.svg'
      window.api.thumbnails.getForVideo = async () => ({
        ok: true,
        value: structuredClone(candidates.slice(0, 1)),
      })
    }
    window.api.thumbnails.setPrimary = async (_library, thumbnailId) => {
      for (const item of candidates) item.isPrimary = item.id === thumbnailId
      video.primaryThumbnailPath = candidates.find((item) => item.isPrimary)?.filePath
      return { ok: true, value: null }
    }
  }, mode)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page.getByRole('button', { name: 'Sample video 영상 카드', exact: true }).click()
  return page.getByRole('region', { name: '대표 썸네일 선택' })
}

test('chooses a candidate, refreshes card and detail, and keeps the choice after reopening details', async ({
  page,
}) => {
  const selector = await openCandidates(page)
  await expect(selector.getByRole('button', { name: '후보 1 대표 썸네일로 선택' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await selector.getByRole('button', { name: '후보 3 대표 썸네일로 선택' }).click()
  await expect(selector.getByRole('button', { name: '후보 3 대표 썸네일로 선택' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByAltText('썸네일', { exact: true })).toHaveAttribute(
    'src',
    '/candidate-3.svg',
  )
  await expect(
    page.getByRole('button', { name: 'Sample video 영상 카드', exact: true }).locator('img'),
  ).toHaveAttribute('src', '/candidate-3.svg')
  await reopenDetails(page)
  await expect(selector.getByRole('button', { name: '후보 3 대표 썸네일로 선택' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: 'test-results/thumbnail-selection.png', fullPage: true })
})

test('keeps the existing selection on save failure and allows retry', async ({ page }) => {
  const selector = await openCandidates(page)
  await page.evaluate(() => {
    window.api.thumbnails.setPrimary = async () => ({
      ok: false,
      error: '라이브러리가 사용 중입니다.',
    })
  })
  await selector.getByRole('button', { name: '후보 2 대표 썸네일로 선택' }).click()
  await expect(selector.getByRole('alert')).toContainText('현재 선택은 유지')
  await expect(selector.getByRole('button', { name: '후보 1 대표 썸네일로 선택' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(selector.getByRole('button', { name: '후보 2 대표 썸네일로 선택' })).toBeEnabled()
})

test('explains how to generate missing candidates', async ({ page }) => {
  const selector = await openCandidates(page, 'empty')
  await expect(selector).toContainText('생성된 후보가 없습니다')
})

test('shows a loading failure separately and retries the candidate query', async ({ page }) => {
  await openCandidates(page, 'failed')
  await expect(page.getByRole('button', { name: '후보 다시 불러오기' })).toBeVisible()
  await page.evaluate(() => {
    window.api.thumbnails.getForVideo = async () => ({ ok: true, value: [] })
  })
  await page.getByRole('button', { name: '후보 다시 불러오기' }).click()
  await expect(page.getByRole('region', { name: '대표 썸네일 선택' })).toContainText(
    '생성된 후보가 없습니다',
  )
})

test('disables unreadable candidate images and explains regeneration', async ({ page }) => {
  const selector = await openCandidates(page, 'unreadable')
  await expect(selector.getByRole('button', { name: '후보 1 대표 썸네일로 선택' })).toBeDisabled()
  await expect(selector).toContainText('이미지 파일을 읽지 못했습니다')
})
