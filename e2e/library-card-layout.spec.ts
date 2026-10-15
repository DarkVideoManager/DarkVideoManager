import { expect, test, type Page } from '@playwright/test'
import type { Video } from '../src/shared/types'

async function openLibrary(page: Page, count = 7) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(async (videoCount) => {
    const fixture = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!fixture.ok || !fixture.value) throw new Error('Missing video fixture')
    const titles = ['짧은 제목', 'LongUnbrokenTitle'.repeat(24), '긴 한글 제목 '.repeat(40)]
    const videos: Video[] = Array.from({ length: videoCount }, (_, index) => ({
      ...fixture.value!,
      id: `layout-video-${index}`,
      title: index < titles.length ? titles[index] : `영상 ${index + 1}`,
      fileName: index === 1 ? `${'UnbrokenFileName'.repeat(20)}.mp4` : `sample-${index + 1}.mp4`,
      filePath: `/mock/videos/layout-${index + 1}.mp4`,
      memo: index === 2 ? '긴메모'.repeat(100) : '카드에서 확인할 메모',
      tags: index === 1 ? 'LongUnbrokenTag'.repeat(15) : '테스트',
      primaryThumbnailPath: undefined,
    }))
    window.api.videos.search = async () => ({
      ok: true,
      value: { videos: structuredClone(videos), total: videos.length, page: 1, pageSize: 500 },
    })
    window.api.videos.get = async (_libraryId, videoId) => ({
      ok: true,
      value: structuredClone(videos.find((video) => video.id === videoId) ?? null),
    })
  }, count)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '짧은 제목 영상 카드', exact: true })).toBeVisible()
}

function videoList(page: Page) {
  return page.getByRole('region', { name: '영상 목록', exact: true })
}

async function expectCardsToFit(page: Page) {
  await expect
    .poll(async () =>
      videoList(page).evaluate((list) => {
        const bounds = list.getBoundingClientRect()
        const cards = Array.from(
          list.querySelectorAll<HTMLButtonElement>('button[aria-label$=" 영상 카드"]'),
        )
        const issues: string[] = []
        if (!cards.length) return ['No cards rendered']
        if (list.scrollWidth > list.clientWidth + 1) issues.push('List overflows horizontally')
        const expectedWidth = cards[0].getBoundingClientRect().width
        const rectangles = cards.map((card, index) => {
          const cardBounds = card.getBoundingClientRect()
          if (Math.abs(cardBounds.width - expectedWidth) > 1)
            issues.push(`Card ${index} differs in width`)
          if (cardBounds.left < bounds.left || cardBounds.right > bounds.right + 1) {
            issues.push(`Card ${index} extends outside the list`)
          }
          const button = card
          if (button.scrollWidth > button.clientWidth + 1)
            issues.push(`Card ${index} content is too wide`)
          if (button.scrollHeight > button.clientHeight + 1)
            issues.push(`Card ${index} content is clipped`)
          const body = button.lastElementChild!
          const titleSection = body.firstElementChild!
          const fileName = titleSection.lastElementChild!
          if (
            fileName.getBoundingClientRect().bottom >
            titleSection.getBoundingClientRect().bottom + 1
          ) {
            issues.push(`Card ${index} hides its file name`)
          }
          const footer = body.lastElementChild!.getBoundingClientRect()
          if (footer.bottom > button.getBoundingClientRect().bottom + 1) {
            issues.push(`Card ${index} hides its resume/subtitle information`)
          }
          for (const field of Array.from(body.children[1].children)) {
            const fieldBounds = field.getBoundingClientRect()
            for (const text of Array.from(field.children)) {
              const textBounds = text.getBoundingClientRect()
              if (
                textBounds.left < fieldBounds.left ||
                textBounds.right > fieldBounds.right + 1 ||
                textBounds.top < fieldBounds.top ||
                textBounds.bottom > fieldBounds.bottom + 1
              ) {
                issues.push(`Card ${index} clips a metadata field`)
              }
            }
          }
          return cardBounds
        })
        for (let index = 1; index < rectangles.length; index += 1) {
          const previous = rectangles[index - 1]
          const current = rectangles[index]
          if (Math.abs(previous.top - current.top) < 1 && previous.right > current.left) {
            issues.push(`Cards ${index - 1} and ${index} overlap`)
          }
        }
        return issues
      }),
    )
    .toEqual([])
}

test('long titles, file names and the partial last row retain equal card widths and visible metadata', async ({
  page,
}) => {
  await openLibrary(page)
  const cards = videoList(page).getByRole('button', { name: /영상 카드$/ })
  await expect(cards).toHaveCount(7)
  await expectCardsToFit(page)
  const first = await cards.first().boundingBox()
  const last = await cards.last().boundingBox()
  expect(last!.y).toBeGreaterThan(first!.y)
  expect(last!.width).toBeCloseTo(first!.width, 0)
  await expect(cards.nth(1).locator('p[title]').first()).toHaveAttribute(
    'title',
    'LongUnbrokenTitle'.repeat(24),
  )
  await page.screenshot({ path: test.info().outputPath('library-card-layout.png') })

  for (const width of [1440, 900, 760, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expectCardsToFit(page)
  }
})

test('bounded cards keep virtual scrolling, last-row access and selection working', async ({
  page,
}) => {
  await openLibrary(page, 72)
  const list = videoList(page)
  await expectCardsToFit(page)
  expect(await list.getByRole('button', { name: /영상 카드$/ }).count()).toBeLessThan(72)
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const last = list.getByRole('button', { name: '영상 72 영상 카드', exact: true })
  await expect(last).toBeInViewport({ ratio: 1 })
  await expectCardsToFit(page)
  await last.click()
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toHaveValue(
    '카드에서 확인할 메모',
  )
  await expect(last).toBeInViewport({ ratio: 1 })
  await list.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(
    list.getByRole('button', { name: '짧은 제목 영상 카드', exact: true }),
  ).toBeInViewport({ ratio: 1 })
  await expectCardsToFit(page)
})
