import { expect, test, type Page } from '@playwright/test'

async function openLibrary(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api))
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
}

test('single-file entry imports only the selected file and reports completion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await openLibrary(page)
  await page.evaluate(() => {
    const calls: Array<{ libraryId: string; paths: string[] }> = []
    Object.assign(window, { selectedImports: calls })
    window.api.library.selectFiles = async () => ({ ok: true, value: ['C:/new/one.mp4'] })
    window.api.library.importFiles = async (libraryId, paths) => {
      calls.push({ libraryId, paths })
      return { ok: true, value: { added: 1, skipped: 0, removed: 0, errors: [] } }
    }
    window.api.library.importFolder = async () => {
      throw new Error('Unexpected folder scan')
    }
    window.api.library.refresh = async () => {
      throw new Error('Unexpected library refresh')
    }
  })
  const entry = page.getByRole('button', { name: '영상 파일 추가', exact: true })
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '영상 파일 추가' })
  await expect(dialog.getByRole('button', { name: '선택한 영상 추가' })).toBeDisabled()
  await dialog.getByRole('button', { name: '파일 선택', exact: true }).click()
  await expect(dialog.getByRole('list', { name: '선택한 영상 파일' })).toHaveText('C:/new/one.mp4')
  await dialog.getByRole('button', { name: '선택한 영상 추가', exact: true }).click()
  await expect(dialog.getByText('가져오기 완료 (추가 1개, 건너뜀 0개)')).toBeVisible()
  await expect(dialog.getByRole('progressbar')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, 'selectedImports'))).toEqual([
    { libraryId: 'mock-library', paths: ['C:/new/one.mp4'] },
  ])
  await page.screenshot({ path: test.info().outputPath('single-file-result-900x600.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(entry).toBeFocused()
})

test('file picker cancellation and errors remain recoverable and partial failures are visible', async ({
  page,
}) => {
  await openLibrary(page)
  await page.evaluate(() => {
    let selection = 0
    window.api.library.selectFiles = async () => {
      if (selection++ === 0) return { ok: true, value: null }
      if (selection === 2) throw new Error('파일 선택 창 테스트 오류')
      return { ok: true, value: ['C:/new/one.mp4', 'C:/new/two.mkv'] }
    }
    window.api.library.importFiles = async () => ({
      ok: true,
      value: {
        added: 1,
        skipped: 0,
        removed: 0,
        errors: ['two.mkv: 파일에 접근할 수 없습니다.'],
      },
    })
  })
  await page.getByRole('button', { name: '영상 파일 추가', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '영상 파일 추가' })
  const select = dialog.getByRole('button', { name: '파일 선택', exact: true })
  await select.click()
  await expect(dialog.getByRole('button', { name: '선택한 영상 추가' })).toBeDisabled()
  await select.click()
  await expect(dialog.getByRole('alert')).toHaveText('파일 선택 창 테스트 오류')
  await select.click()
  await dialog.getByRole('button', { name: '선택한 영상 추가', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('two.mkv: 파일에 접근할 수 없습니다.')
  await expect(dialog.getByText('가져오기 완료 (추가 1개, 건너뜀 0개)')).toBeVisible()
})

test('manual folder refresh explains its scope and exposes counts and failures', async ({
  page,
}) => {
  await openLibrary(page)
  await page.getByText('영상 추가·폴더 갱신 안내', { exact: true }).click()
  await expect(page.getByText(/폴더 자동 감시는 지원하지 않습니다/)).toBeVisible()
  await page.evaluate(() => {
    window.api.library.refresh = async () => ({
      ok: true,
      value: {
        added: 1,
        skipped: 20,
        removed: 2,
        errors: ['연결이 끊긴 폴더: 다시 연결해 주세요.'],
      },
    })
  })
  await page.getByRole('button', { name: '목록 업데이트', exact: true }).click()
  await expect(page.getByText('추가 1개 · 기존 20개 · 제거 2개 · 오류 1개')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('연결이 끊긴 폴더')
  await expect(page.getByText('목록 업데이트가 완료되었습니다.', { exact: true })).toHaveCount(0)
})

test('controls help fits a small window, keeps focus, and returns to settings on Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api))
  const entry = page.getByRole('button', { name: '조작 안내', exact: true })
  await entry.click()
  const help = page.getByRole('dialog', { name: '단축키·재생 조작 안내' })
  await expect(help.getByRole('button', { name: '닫기', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(help.getByRole('button', { name: '닫기', exact: true })).toBeFocused()
  const dimensions = await help.evaluate((dialog) => ({
    width: dialog.getBoundingClientRect().width,
    height: dialog.getBoundingClientRect().height,
    scrollHeight: dialog.scrollHeight,
    clientHeight: dialog.clientHeight,
  }))
  expect(dimensions.width).toBeLessThanOrEqual(900)
  expect(dimensions.height).toBeLessThanOrEqual(540)
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
  await expect(help.getByRole('cell', { name: '현재 화면을 대표 썸네일로 지정' })).toBeAttached()
  await expect(help.getByRole('row').filter({ hasText: 'A / D 또는' })).toContainText(
    '설정한 간격만큼',
  )
  await expect(help.getByRole('row').filter({ hasText: '0–9' })).toContainText('0–90%')
  await expect(help.getByRole('row').filter({ hasText: 'Alt + Enter' })).toContainText(
    '전체화면 전환',
  )
  await expect(help.getByRole('row').filter({ hasText: '+ / -' })).toContainText('100–400%')
  await expect(
    help.getByRole('row').filter({ has: page.getByRole('cell', { name: 'I', exact: true }) }),
  ).toContainText('재생 정보')
  await expect(help.getByRole('region', { name: '음량과 화면 크기' })).toContainText(
    'Tab은 버튼 사이의',
  )
  await expect(help.getByRole('region', { name: '관련 설정 위치' })).toContainText('1–600초')
  await expect(help.getByRole('region', { name: '관련 설정 위치' })).toContainText('VLC·ffplay')
  await expect(help).not.toContainText(
    '인앱 전체 화면 전환과 자유로운 키 재지정 설정은 현재 제공하지 않습니다',
  )
  await page.screenshot({ path: test.info().outputPath('controls-help-900x600-top.png') })
  await help.getByRole('region', { name: '음량과 화면 크기' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('controls-help-900x600-bottom.png') })
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(entry).toBeFocused()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  const settingsHelp = settings.getByRole('button', { name: '단축키·재생 조작 안내' })
  await settingsHelp.click()
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(settings).toBeVisible()
  await expect(settingsHelp).toBeFocused()
})

test('player help suppresses shortcuts and Escape closes only help before normal controls resume', async ({
  page,
}) => {
  await openLibrary(page)
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(page.locator('video')).toBeVisible()
  const before = await page.evaluate(async () => {
    const result = await window.api.highlights.list('mock-library', 'mock-video-1')
    return result.ok ? result.value.length : -1
  })
  const entry = page.getByRole('button', { name: '조작 안내', exact: true })
  await entry.click()
  const help = page.getByRole('dialog', { name: '단축키·재생 조작 안내' })
  const volume = await page.locator('video').evaluate((video: HTMLVideoElement) => video.volume)
  await page.keyboard.press('h')
  await page.keyboard.press('ArrowDown')
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.volume)).toBe(
    volume,
  )
  expect(
    await page.evaluate(async () => {
      const result = await window.api.highlights.list('mock-library', 'mock-video-1')
      return result.ok ? result.value.length : -1
    }),
  ).toBe(before)
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(page.locator('video')).toBeVisible()
  await expect(entry).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.volume))
    .toBeCloseTo(volume - 0.05)
  await page.getByRole('button', { name: '플레이어 최대화', exact: true }).click()
  await expect(page.locator('aside')).toHaveCount(0)
  await page.getByRole('button', { name: '상세 보기', exact: true }).click()
  await expect(page.locator('aside')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '영상 파일 추가', exact: true })).toBeVisible()
})
