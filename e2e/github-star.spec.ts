import { expect, test, type Page } from '@playwright/test'

async function enableDesktopCapability(page: Page, failOpen = false, failClaim = false) {
  await page.addInitScript(
    ({ failOpen, failClaim }) => {
      let api: Window['api']
      const state = { claimCalls: 0, openCalls: 0, quitCalls: 0, failOpen, failClaim }
      Object.defineProperty(window, '__starHarness', { value: state })
      Object.defineProperty(window, 'api', {
        configurable: true,
        get: () => api,
        set: (next: Window['api']) => {
          api = next
          api.app.githubStar = {
            claimPrompt: async () => {
              state.claimCalls += 1
              if (state.failClaim) return { ok: false, error: '설정 저장 실패' }
              const shown = localStorage.getItem('star-test-shown') === 'true'
              localStorage.setItem('star-test-shown', 'true')
              return { ok: true, value: !shown }
            },
            openRepository: async () => {
              state.openCalls += 1
              if (state.failOpen) throw new Error('브라우저 열기 실패')
              return { ok: true, value: null }
            },
          }
          api.app.quit = async () => {
            state.quitCalls += 1
            return { ok: true, value: null }
          }
        },
      })
    },
    { failOpen, failClaim },
  )
}

async function harness(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __starHarness: { claimCalls: number; openCalls: number; quitCalls: number }
        }
      ).__starHarness,
  )
}

test('shows once under StrictMode, stays dismissed across navigation and later launches', async ({
  page,
}) => {
  await enableDesktopCapability(page)
  await page.goto('/')
  const notice = page.getByRole('region', { name: 'GitHub Star 안내' })
  await expect(notice).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('first-run-star.png') })
  expect(await harness(page)).toMatchObject({ claimCalls: 1, openCalls: 0 })
  await notice.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await page.getByRole('link', { name: '통계', exact: true }).click()
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: '라이브러리 선택', exact: true })).toBeVisible()
  await expect(notice).toHaveCount(0)
  expect(await harness(page)).toMatchObject({ claimCalls: 1, openCalls: 0 })
})

test('only opens GitHub after an explicit click and then dismisses the notice', async ({
  page,
}) => {
  await enableDesktopCapability(page)
  await page.goto('/')
  const notice = page.getByRole('region', { name: 'GitHub Star 안내' })
  await expect(notice).toBeVisible()
  expect((await harness(page)).openCalls).toBe(0)
  await notice.getByRole('button', { name: 'GitHub에서 Star 누르기' }).click()
  await expect(notice).toHaveCount(0)
  expect((await harness(page)).openCalls).toBe(1)
  await page.reload()
  await expect(notice).toHaveCount(0)
})

test('keeps a failed browser link retryable and allows continuing without it', async ({ page }) => {
  await enableDesktopCapability(page, true)
  await page.goto('/')
  const notice = page.getByRole('region', { name: 'GitHub Star 안내' })
  await notice.getByRole('button', { name: 'GitHub에서 Star 누르기' }).click()
  await expect(notice.getByRole('alert')).toContainText('브라우저를 열지 못했습니다')
  await expect(notice.getByRole('button', { name: 'GitHub에서 Star 누르기' })).toBeEnabled()
  await notice.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(notice).toHaveCount(0)
})

test('does not intercept Escape while the notice is visible', async ({ page }) => {
  await enableDesktopCapability(page)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'GitHub Star 안내' })).toBeVisible()
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('라이브러리: Demo Library', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await harness(page)).quitCalls).toBe(1)
})

test('does not interrupt startup if the one-time state cannot be saved', async ({ page }) => {
  await enableDesktopCapability(page, false, true)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '라이브러리 선택', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'GitHub Star 안내' })).toHaveCount(0)
  expect((await harness(page)).openCalls).toBe(0)
})

test('does not display the desktop notice in a browser adapter without the capability', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '라이브러리 선택', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'GitHub Star 안내' })).toHaveCount(0)
})
