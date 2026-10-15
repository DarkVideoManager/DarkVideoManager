import { expect, test, type Page } from '@playwright/test'

interface DelayedNativeSeekWindow extends Window {
  delayedNativeSeek: {
    writes: number
    nativeLaunches: number
    finishWrites: Array<() => void>
  }
}

async function prepare(page: Page, mask = false) {
  await page.goto('/')
  await page.evaluate(async (maskThumbnails) => {
    await window.api.privacy.save({
      maskThumbnails,
      revealOnHover: true,
      exitAction: 'blank',
      exitUrl: '',
    })
    const video = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!video.ok || !video.value) throw new Error('missing fixture')
    video.value.primaryThumbnailPath = '/mock/thumbnail.jpg'
  }, mask)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('Sample video', { exact: true }).first()).toBeVisible()
}

test('private thumbnails reveal only on hover or keyboard focus and hide again on leave', async ({
  page,
}) => {
  await prepare(page, true)
  const card = page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
  await expect(card.getByText('썸네일 가림', { exact: true })).toBeVisible()
  await expect(card.locator('img')).toHaveCount(0)
  await card.getByLabel('대체 썸네일', { exact: true }).hover({ position: { x: 100, y: 85 } })
  await expect(card.locator('img')).toHaveCount(1)
  await page.getByRole('link', { name: '추천 탐색', exact: true }).hover()
  await expect(card.locator('img')).toHaveCount(0)
  await card.focus()
  await expect(card.locator('img')).toHaveCount(1)
  await page.keyboard.press('Tab')
  await expect(card.locator('img')).toHaveCount(0)
})

test('privacy settings validate HTTPS and retain the prior setting after a failed save', async ({
  page,
}) => {
  await prepare(page)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const panel = page.getByRole('region', { name: '화면 보호', exact: true })
  await panel.getByLabel('긴급 탈출 후 화면', { exact: true }).selectOption('website')
  await panel.getByLabel('탈출 후 웹 주소').fill('javascript:alert(1)')
  await panel.getByRole('button', { name: '화면 보호 설정 저장', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('HTTPS')
  await panel.getByLabel('탈출 후 웹 주소').fill('https://example.com/')
  await page.evaluate(() => {
    window.api.privacy.save = async () => ({ ok: false, error: '설정 저장 실패' })
  })
  await panel.getByRole('button', { name: '화면 보호 설정 저장', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('설정 저장 실패')
  expect(
    await page.evaluate(async () => {
      const value = await window.api.privacy.get()
      return value.ok && value.value.exitAction
    }),
  ).toBe('blank')
  await expect(panel.getByLabel('탈출 후 웹 주소')).toHaveValue('https://example.com/')
})

test('emergency shortcut covers dialogs and playback, and keeps the cover on external launch failure', async ({
  page,
}) => {
  await prepare(page)
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.evaluate(() => {
    window.api.privacy.exit = async () => ({ ok: false, error: '웹 화면을 열지 못했습니다.' })
  })
  await page.keyboard.press('Control+Shift+h')
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('웹 화면을 열지 못했습니다.')
  await page.getByRole('button', { name: '화면 다시 열기', exact: true }).click()
  await expect(page.locator('video')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.keyboard.press('Control+Shift+h')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
})

test('library Escape uses the selected cover action without quitting', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    window.api.app.quit = async () => {
      throw new Error('must not quit')
    }
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('emergency exit cancels native launch while the final seek write is still pending', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    const state = { writes: 0, nativeLaunches: 0, finishWrites: [] as Array<() => void> }
    ;(window as unknown as DelayedNativeSeekWindow).delayedNativeSeek = state
    const player = { name: 'vlc' as const, path: 'C:\\synthetic-players\\vlc.exe' }
    window.api.videos.getNativePlayerInfo = async () => ({ ok: true, value: player })
    window.api.videos.openInNativePlayer = async () => {
      state.nativeLaunches += 1
      return { ok: true, value: player }
    }
    window.api.playback.seek = async () => {
      state.writes += 1
      await new Promise<void>((resolve) => state.finishWrites.push(resolve))
      return { ok: true, value: null }
    }
  })
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  const nativeButton = page.getByRole('button', { name: 'VLC로 열기', exact: true })
  await expect(nativeButton).toBeVisible()
  await expect(page.locator('video')).toHaveAttribute('src', /.+/)
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperties(video, {
      duration: { configurable: true, value: 120 },
      readyState: { configurable: true, value: 1 },
      currentTime: { configurable: true, writable: true, value: 10 },
      // A decoder still seeking leaves a final position write for native handoff.
      seeking: { configurable: true, value: true },
    })
    video.dispatchEvent(new Event('loadedmetadata'))
  })
  await page.keyboard.press('ArrowRight')
  await nativeButton.click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as DelayedNativeSeekWindow).delayedNativeSeek.writes),
    )
    .toBe(1)
  await page.keyboard.press('Control+Shift+h')
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
  await page.evaluate(async () => {
    const state = (window as unknown as DelayedNativeSeekWindow).delayedNativeSeek
    state.finishWrites.forEach((finish) => finish())
    // Let the resumed mutation and its settled callback finish.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  expect(
    await page.evaluate(
      () => (window as unknown as DelayedNativeSeekWindow).delayedNativeSeek.nativeLaunches,
    ),
  ).toBe(0)
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
})

test('local discovery saves favorites and people tags and explains parsed conditions', async ({
  page,
}, info) => {
  await prepare(page)
  await page.getByRole('link', { name: '추천 탐색', exact: true }).click()
  await expect(page.getByRole('heading', { name: '내 라이브러리 추천 탐색' })).toBeVisible()
  await page.getByRole('button', { name: '즐겨찾기 등록', exact: true }).click()
  await expect(page.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByLabel('선호 태그·인물 (쉼표로 구분)').fill('demo')
  await page.getByRole('button', { name: '선호 태그 저장', exact: true }).click()
  await expect(page.getByText(/선호 태그·인물: demo/)).toBeVisible()
  await page.getByLabel('영상 조건', { exact: true }).fill('즐겨찾기 3분 이하 별점 4점 이상 sample')
  await page.getByRole('button', { name: '조건으로 찾기', exact: true }).click()
  await expect(page.getByText(/적용 조건:.*즐겨찾기.*3분 이하.*검색어: sample.*1개/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('local-discovery.png'), fullPage: true })
  await page.getByLabel('영상 조건', { exact: true }).fill('미시청')
  await page.getByRole('button', { name: '조건으로 찾기', exact: true }).click()
  await expect(
    page.getByText('조건에 맞는 영상이 없습니다. 조건이나 검색어를 줄여 보세요.'),
  ).toBeVisible()
})

test('discovery errors can be retried and preferences do not cross libraries', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    await window.api.discovery.favorite('mock-library', 'mock-video-1', true)
    const other = await window.api.library.create('Other', '/mock/other')
    if (!other.ok) throw new Error(other.error)
    const result = await window.api.discovery.query(other.value.id, { text: '', page: 1 })
    if (!result.ok || result.value.preferences.favoriteVideoIds.length)
      throw new Error('preferences leaked')
    const query = window.api.discovery.query
    let failed = false
    window.api.discovery.query = async (...args) => {
      if (!failed) {
        failed = true
        return { ok: false, error: '추천 조회 실패' }
      }
      return query(...args)
    }
  })
  await page.getByRole('link', { name: '추천 탐색', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('추천 조회 실패')
  await page.getByRole('button', { name: '추천 다시 불러오기' }).click()
  await expect(page.getByRole('button', { name: '즐겨찾기 해제' })).toBeVisible()
})

test('returning to discovery immediately refreshes metadata edited on another screen', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    const query = window.api.discovery.query
    // Match real IPC: cached replies must not share references with mock DB rows.
    window.api.discovery.query = async (...args) => structuredClone(await query(...args))
  })
  await page.getByRole('link', { name: '추천 탐색', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Sample video', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await page.evaluate(async () => {
    const result = await window.api.videos.updateMeta('mock-library', 'mock-video-1', {
      title: 'Updated metadata title',
      tags: 'updated-tag',
    })
    if (!result.ok) throw new Error(result.error)
  })
  await page.getByRole('link', { name: '추천 탐색', exact: true }).click()
  await expect(
    page.getByRole('link', { name: 'Updated metadata title', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sample video', exact: true })).toHaveCount(0)
})
