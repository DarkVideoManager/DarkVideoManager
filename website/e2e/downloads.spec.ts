import { expect, test } from '@playwright/test'

const releases = 'https://github.com/DarkVideoManager/DarkVideoManager/releases'
const summary = {
  version: '0.3.0',
  releaseUrl: `${releases}/tag/v0.3.0`,
  checkedAt: '2026-10-16T00:00:00.000Z',
  totals: { setup: 12, portable: 18, total: 30 },
  downloads: {
    setup: { count: 12, url: `${releases}/download/v0.3.0/DarkVideoManager-Setup-0.3.0-x64.exe` },
    portable: {
      count: 18,
      url: `${releases}/download/v0.3.0/DarkVideoManager-Portable-0.3.0-x64.exe`,
    },
  },
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`shows official downloads and distinct demo/source/verification routes at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.route('**/api/releases', (route) => route.fulfill({ json: summary }))
    await page.goto('/')
    const cta = page.getByRole('link', { name: 'Windows 다운로드', exact: true })
    await expect(cta).toBeInViewport()
    await expect(page.locator('#downloads')).toHaveAttribute('data-state', 'ready')
    await cta.click()
    await expect(
      page.getByRole('heading', { name: 'Windows 앱 다운로드', exact: true }),
    ).toBeInViewport()
    await expect(
      page.getByRole('link', { name: '설치 파일 다운로드', exact: true }),
    ).toHaveAttribute('href', summary.downloads.setup.url)
    await expect(page.getByRole('link', { name: '포터블 다운로드', exact: true })).toHaveAttribute(
      'href',
      summary.downloads.portable.url,
    )
    await expect(page.getByText(/설치형: Setup/)).toBeVisible()
    await expect(page.getByText(/포터블: Portable/)).toBeVisible()
    await expect(page.getByText(/Source code \(zip \/ tar.gz\)/)).toBeVisible()
    await expect(
      page.getByRole('link', { name: '다운로드 확인 안내', exact: true }),
    ).toHaveAttribute(
      'href',
      'https://github.com/DarkVideoManager/DarkVideoManager/blob/main/docs/download-verification.md',
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.screenshot({
      path: `../test-results/downloads-${viewport.width}.png`,
    })
    await page
      .getByRole('link', { name: '다운로드 없이 브라우저 데모 체험 ↓', exact: true })
      .click()
    await expect(page).toHaveURL(/#experience$/)
  })
}

test('retains usable official release links when the API fails', async ({ page }) => {
  await page.route('**/api/releases', (route) => route.fulfill({ status: 503 }))
  await page.goto('/')
  await expect(page.locator('#downloads')).toHaveAttribute('data-state', 'unavailable')
  for (const kind of ['setup', 'portable']) {
    await expect(page.locator(`[data-download="${kind}"]`)).toHaveAttribute(
      'href',
      `${releases}/latest`,
    )
    await expect(page.locator(`[data-download="${kind}"]`)).toBeVisible()
  }
})

test('retains download and verification paths without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('link', { name: 'Windows 다운로드', exact: true }).click()
  await expect(page.getByRole('link', { name: '설치 파일 찾기', exact: true })).toHaveAttribute(
    'href',
    `${releases}/latest`,
  )
  await expect(page.getByRole('link', { name: '포터블 찾기', exact: true })).toHaveAttribute(
    'href',
    `${releases}/latest`,
  )
  await expect(page.getByRole('link', { name: '다운로드 확인 안내', exact: true })).toBeVisible()
  await context.close()
})
