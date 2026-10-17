import { expect, test, type Page } from '@playwright/test'

async function expectPageToFit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
}

for (const width of [390, 768]) {
  test(`touch demo entry opens the inline player at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.route('**/api/releases', (route) => route.fulfill({ status: 503 }))
    await page.goto('/')
    await expect(page.locator('.touch-demo-label')).toBeVisible()
    await expect(page.locator('.desktop-demo-label')).toBeHidden()
    await expectPageToFit(page)
    await page.getByRole('button', { name: '샘플 영상 재생', exact: true }).click()
    const demo = page.frameLocator('#program-demo')
    await expect(demo.locator('body')).toHaveAttribute('data-page', 'player')
    await expect(demo.locator('video')).toHaveAttribute('playsinline', '')
    await expect(demo.locator('.demo-keycap-label').first()).toBeVisible()
  })
}

test('phone controls expand, open details, play and return to the video list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/demo/')
  await expect(page.getByRole('button', { name: '사용 안내', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '더보기', exact: true }).click()
  await expect(page.getByRole('button', { name: '사용 안내', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '접기', exact: true }).click()

  const cards = page.getByRole('group', { name: /영상 카드$/ })
  await expect(cards.first()).toBeVisible()
  await expect(page.getByRole('button', { name: '제거한 항목', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '목록 관리', exact: true }).click()
  await expect(page.getByRole('button', { name: '제거한 항목', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '관리 메뉴 접기', exact: true }).click()
  await expectPageToFit(page)

  await cards.first().getByRole('button').first().click()
  await page.getByRole('button', { name: '← 영상 목록', exact: true }).click()
  await expect(cards.first()).toBeVisible()
  await cards.first().getByRole('button').first().click()
  await page.getByRole('button', { name: '이 영상 재생 ▶', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-page', 'player')
  await expect(page.locator('video')).toBeVisible()
  await expect(page.locator('video')).toHaveAttribute('playsinline', '')
  const playKey = page.locator('.demo-keycap-w')
  await playKey.click()
  await expect(playKey).toHaveAttribute('data-used', 'true')
  await expectPageToFit(page)
  await page.screenshot({ path: '../test-results/mobile-demo-player.png' })
  await page.getByRole('button', { name: '영상 목록', exact: true }).click()
  await expect(cards.first()).toBeVisible()
})

test('desktop keeps its toolbar and keyboard layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/demo/')
  await expect(page.getByRole('button', { name: '사용 안내', exact: true })).toBeVisible()
  await expect(page.locator('#demo-more')).toBeHidden()
  await expect(page.getByRole('group', { name: /영상 카드$/ }).first()).toBeVisible()
  await expect(page.locator('.demo-mobile-library-tools')).toBeHidden()
  await expectPageToFit(page)
})
