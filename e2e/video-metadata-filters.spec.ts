import { expect, test, type Page } from '@playwright/test'

const categoryFilter = (page: Page) =>
  page.getByRole('combobox', { name: '카테고리 필터', exact: true })
const tagFilter = (page: Page) => page.getByRole('combobox', { name: '태그 필터', exact: true })
const card = (page: Page) =>
  page.getByRole('button', { name: 'Sample video 영상 카드', exact: true })

async function classifyVideo(page: Page) {
  const result = await page.evaluate(() =>
    window.api.videos.updateMeta('mock-library', 'mock-video-1', {
      category: '스포츠',
      tags: '#선수명 #리그',
    }),
  )
  expect(result.ok).toBe(true)
}

test('category and exact hashtag filters combine and survive navigation and reload', async ({
  page,
}) => {
  await page.goto('/')
  await classifyVideo(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await categoryFilter(page).selectOption({ label: '스포츠' })
  await tagFilter(page).selectOption({ label: '#선수명' })
  await expect(card(page)).toBeVisible()
  await page.getByPlaceholder('영상 검색...').fill('#선수')
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible()
  await page.getByPlaceholder('영상 검색...').fill('Sample #선수명')
  await expect(page.getByText('1개 영상', { exact: true })).toBeVisible()
  await card(page).dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(categoryFilter(page)).toHaveValue('category:스포츠')
  await expect(tagFilter(page)).toHaveValue('선수명')
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample #선수명')
  await page.reload()
  await classifyVideo(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(categoryFilter(page)).toHaveValue('category:스포츠')
  await expect(tagFilter(page)).toHaveValue('선수명')
  await expect(card(page)).toBeVisible()
  await categoryFilter(page).selectOption({ label: '미분류' })
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '분류 필터 해제' }).click()
  await expect(categoryFilter(page)).toHaveValue('')
  await expect(tagFilter(page)).toHaveValue('')
  await expect(card(page)).toBeVisible()
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('Sample #선수명')
})

test('filter choices come from the whole library, including categories outside the first page', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const response = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!response.ok || !response.value) throw new Error('Missing fixture')
    const template = response.value
    window.api.videos.metadataOptions = async () => ({
      ok: true,
      value: { categories: ['첫 페이지', '다음 페이지'], tags: ['대회'] },
    })
    window.api.videos.search = async (_library, query) => {
      const isNextCategory = query.category === '다음 페이지'
      return {
        ok: true,
        value: {
          videos: [
            {
              ...template,
              id: isNextCategory ? 'next-page' : template.id,
              category: isNextCategory ? '다음 페이지' : '첫 페이지',
            },
          ],
          total: isNextCategory ? 1 : 501,
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 500,
        },
      }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('501개 영상', { exact: true })).toBeVisible()
  await categoryFilter(page).selectOption({ label: '다음 페이지' })
  await expect(page.getByText('1개 영상', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /더 불러오기/ })).toHaveCount(0)
})

test('a failed classification-options request can be retried without hiding the library', async ({
  page,
}) => {
  await page.goto('/')
  await classifyVideo(page)
  await page.evaluate(() => {
    const original = window.api.videos.metadataOptions
    let fail = true
    window.api.videos.metadataOptions = async (...args) =>
      fail ? { ok: false, error: '분류 조회 실패' } : original(...args)
    ;(window as typeof window & { retryMetadataOptions: () => void }).retryMetadataOptions = () => {
      fail = false
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(card(page)).toBeVisible()
  await expect(page.getByText('분류 목록을 불러오지 못했습니다.', { exact: false })).toBeVisible({
    timeout: 15_000,
  })
  await page.evaluate(() =>
    (window as typeof window & { retryMetadataOptions: () => void }).retryMetadataOptions(),
  )
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await categoryFilter(page).selectOption({ label: '스포츠' })
  await expect(card(page)).toBeVisible()
})

test('a pending filter request hides stale cards until the matching results arrive', async ({
  page,
}) => {
  await page.goto('/')
  await classifyVideo(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(card(page)).toBeVisible()
  await page.evaluate(() => {
    const search = window.api.videos.search
    window.api.videos.search = async (...args) => {
      await new Promise<void>((resolve) => {
        ;(window as typeof window & { releaseFilter: () => void }).releaseFilter = resolve
      })
      return search(...args)
    }
  })
  await categoryFilter(page).selectOption({ label: '미분류' })
  await expect(page.getByText('조건에 맞는 영상을 찾고 있습니다...', { exact: true })).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByText('1개 영상', { exact: true })).toHaveCount(0)
  await page.evaluate(() =>
    (window as typeof window & { releaseFilter: () => void }).releaseFilter(),
  )
  await expect(page.getByText('0개 영상', { exact: true })).toBeVisible()
  await expect(page.getByText('조건에 맞는 영상을 찾고 있습니다...', { exact: true })).toHaveCount(
    0,
  )
})
