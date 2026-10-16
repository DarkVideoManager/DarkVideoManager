import { expect, test, type Page } from '@playwright/test'

const LIBRARY = 'mock-library'
const VIDEO = 'mock-video-1'

async function openVideo(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const state = window as typeof window & { removalCalls: string[]; quitCalls: number }
    state.removalCalls = []
    state.quitCalls = 0
    const remove = window.api.videos.delete
    window.api.videos.delete = async (libraryId, videoId, mode) => {
      state.removalCalls.push(mode ?? 'trash')
      return remove(libraryId, videoId, mode)
    }
    window.api.app.quit = async () => {
      state.quitCalls += 1
      return { ok: true, value: null }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  const card = page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
  await card.click()
  return card
}

test('cancel is harmless and list-only removal preserves metadata, prevents playback, and can be restored', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  const card = await openVideo(page)
  await page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...').fill('제거 후에도 보관할 메모')
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.api.videos.get('mock-library', 'mock-video-1')
        return result.ok ? result.value?.memo : undefined
      }),
    )
    .toBe('제거 후에도 보관할 메모')
  await page.evaluate(async () => {
    await window.api.highlights.create('mock-library', {
      videoId: 'mock-video-1',
      timeStart: 17,
      label: '보관할 장면',
    })
  })
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '휴지통으로 이동할까요?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as typeof window & { removalCalls: string[] }).removalCalls),
  ).toEqual([])
  expect(
    await page.evaluate(() => (window as typeof window & { quitCalls: number }).quitCalls),
  ).toBe(0)

  await page.getByRole('button', { name: '목록에서만 제거', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '목록에서만 제거할까요?' })
  await expect(confirmation).toContainText('원본 파일은 그대로')
  await confirmation.getByRole('button', { name: '목록에서만 제거', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as typeof window & { removalCalls: string[] }).removalCalls),
  ).toEqual(['remove'])
  await page.getByPlaceholder('영상 검색...').fill('이전 검색 조건')
  await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await expect(page.getByPlaceholder('영상 검색...')).toHaveValue('')
  await expect(page.getByRole('button', { name: '제거한 항목', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await card.dblclick()
  await expect(page).not.toHaveURL(/\/player\//)
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toHaveValue(
    '제거 후에도 보관할 메모',
  )
  await expect(
    page.getByText('원본 파일은 그대로 있습니다. 목록 복구를 누르면 다시 표시됩니다.'),
  ).toBeVisible()
  await page.getByRole('button', { name: '목록 복구', exact: true }).click()
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await expect(card).toBeVisible()
  const stored = await page.evaluate(
    async ({ libraryId, videoId }) => {
      const video = await window.api.videos.get(libraryId, videoId)
      const highlights = await window.api.highlights.list(libraryId, videoId)
      return { video, highlights }
    },
    { libraryId: LIBRARY, videoId: VIDEO },
  )
  expect(stored.video.ok && stored.video.value?.memo).toBe('제거 후에도 보관할 메모')
  expect(stored.video.ok && stored.video.value?.rating).toBe(4)
  expect(stored.highlights.ok && stored.highlights.value[0]?.label).toBe('보관할 장면')
})

test('trash removal explains the recovery requirement and a missing original leaves the removed item intact', async ({
  page,
}) => {
  const card = await openVideo(page)
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '휴지통으로 이동할까요?' })
  await expect(confirmation).toContainText('Windows 휴지통')
  await expect(confirmation).toContainText('별점, 메모, 하이라이트는 보관됩니다.')
  await confirmation.getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as typeof window & { removalCalls: string[] }).removalCalls),
  ).toEqual(['trash'])
  await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await card.click()
  await expect(
    page.getByText('Windows 휴지통에서 원본 파일을 먼저 복원한 다음 목록 복구를 눌러주세요.'),
  ).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: '영상 메타데이터' })
      .getByText('/mock/videos/sample.mp4', { exact: true }),
  ).toBeVisible()
  await page.evaluate(() => {
    window.api.videos.restore = async () => ({
      ok: false,
      error: '원본 파일이 없습니다. Windows 휴지통에서 먼저 복원하세요.',
    })
  })
  await page.getByRole('button', { name: '목록 복구', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('원본 파일이 없습니다.')
  await expect(card).toBeVisible()
  const stored = await page.evaluate(async () =>
    window.api.videos.get('mock-library', 'mock-video-1'),
  )
  expect(stored.ok && stored.value?.removalMode).toBe('trash')
  expect(stored.ok && stored.value?.memo).toBe('Browser mock IPC sample')
})
