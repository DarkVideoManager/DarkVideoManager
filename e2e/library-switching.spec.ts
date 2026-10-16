import { expect, test, type Page } from '@playwright/test'

interface LibraryHarness {
  secondId: string
  openCalls: string[]
  closeCalls: string[]
  failOpen: boolean
  delayOpen: boolean
  releaseOpen?: () => void
  refreshCalls: string[]
  releaseRefresh?: () => void
  importCalls: { libraryId: string; folders: string[] }[]
}
type LibraryWindow = Window & { libraryHarness: LibraryHarness }

async function prepare(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api?.library))
  await page.evaluate(async () => {
    const created = await window.api.library.create('Second Library', ['E:/Movies'])
    if (!created.ok) throw new Error(created.error)
    const state: LibraryHarness = {
      secondId: created.value.id,
      openCalls: [],
      closeCalls: [],
      failOpen: false,
      delayOpen: false,
      refreshCalls: [],
      importCalls: [],
    }
    ;(window as unknown as LibraryWindow).libraryHarness = state
    const originalOpen = window.api.library.open
    window.api.library.open = async (libraryId) => {
      state.openCalls.push(libraryId)
      if (state.delayOpen)
        await new Promise<void>((resolve) => {
          state.releaseOpen = resolve
        })
      if (state.failOpen) return { ok: false, error: '테스트: 드라이브에 접근할 수 없습니다.' }
      return originalOpen(libraryId)
    }
    window.api.library.close = async (libraryId) => {
      state.closeCalls.push(libraryId)
      return { ok: true, value: null }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).first().click()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
}

test('switches libraries without restarting and restores each library search and sort', async ({
  page,
}) => {
  await prepare(page)
  const picker = page.getByRole('combobox', { name: '라이브러리 전환' })
  const sort = page.locator('select:has(option[value="rating"])')
  const direction = page.locator('select:has(option[value="asc"])')
  await page.getByRole('textbox', { name: '영상 검색' }).fill('sample')
  await sort.selectOption('title')
  await direction.selectOption('asc')
  const secondId = await page.evaluate(
    () => (window as unknown as LibraryWindow).libraryHarness.secondId,
  )
  await picker.selectOption(secondId)
  await expect(picker).toHaveValue(secondId)
  await expect(page.getByRole('textbox', { name: '영상 검색' })).toHaveValue('')
  await sort.selectOption('rating')
  await direction.selectOption('desc')
  await picker.selectOption('mock-library')
  await expect(page.getByRole('textbox', { name: '영상 검색' })).toHaveValue('sample')
  await expect(sort).toHaveValue('title')
  await expect(direction).toHaveValue('asc')
  await picker.selectOption(secondId)
  await expect(sort).toHaveValue('rating')
  await expect(direction).toHaveValue('desc')
  expect(
    await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.closeCalls),
  ).toEqual([])
})

test('keeps the current library visible on open failure and prevents overlapping transitions', async ({
  page,
}) => {
  await prepare(page)
  const picker = page.getByRole('combobox', { name: '라이브러리 전환' })
  await page.evaluate(() => {
    ;(window as unknown as LibraryWindow).libraryHarness.failOpen = true
  })
  await picker.selectOption({ label: 'Second Library' })
  await expect(page.getByRole('alert')).toContainText('테스트: 드라이브에 접근할 수 없습니다.')
  await expect(picker).toHaveValue('mock-library')
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const state = (window as unknown as LibraryWindow).libraryHarness
    state.failOpen = false
    state.delayOpen = true
    state.openCalls = []
  })
  await picker.selectOption({ label: 'Second Library' })
  await expect(picker).toBeDisabled()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const picker = document.querySelector<HTMLSelectElement>(
      'select[aria-label="라이브러리 전환"]',
    )!
    picker.value = (window as unknown as LibraryWindow).libraryHarness.secondId
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    ;(window as unknown as LibraryWindow).libraryHarness.releaseOpen!()
  })
  await expect(picker).toBeEnabled()
  const state = await page.evaluate(() => {
    const state = (window as unknown as LibraryWindow).libraryHarness
    return { secondId: state.secondId, calls: state.openCalls, closed: state.closeCalls }
  })
  expect(state.calls).toEqual([state.secondId])
  expect(state.closed).toEqual([])
  await expect(picker).toHaveValue(state.secondId)
})

test('keeps background refresh scoped to its original library during a switch', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    const state = (window as unknown as LibraryWindow).libraryHarness
    window.api.library.refresh = (libraryId) => {
      state.refreshCalls.push(libraryId)
      return new Promise((resolve) => {
        state.releaseRefresh = () =>
          resolve({ ok: true, value: { added: 2, skipped: 0, removed: 0, errors: [] } })
      })
    }
  })
  await page.getByRole('button', { name: '목록 업데이트', exact: true }).click()
  await expect(page.getByRole('progressbar')).toBeVisible()
  await page
    .getByRole('combobox', { name: '라이브러리 전환' })
    .selectOption({ label: 'Second Library' })
  await expect(page.getByRole('textbox', { name: '영상 검색' })).toHaveValue('')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.releaseRefresh!())
  await expect(page.getByRole('button', { name: '목록 업데이트', exact: true })).toBeEnabled()
  await expect(page.getByText('목록 업데이트가 완료되었습니다.', { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.refreshCalls),
  ).toEqual(['mock-library'])
})

test('creates a multi-folder library from management and displays all saved roots', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    window.api.library.selectFolders = async () => ({ ok: true, value: ['D:/', 'E:/Movies'] })
  })
  await page.getByRole('link', { name: '라이브러리 관리', exact: true }).click()
  await expect(page.getByRole('heading', { name: '라이브러리 선택' })).toBeVisible()
  await page.getByRole('button', { name: '현재 라이브러리로 돌아가기' }).click()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '라이브러리 관리', exact: true }).click()
  await page.getByRole('button', { name: '새 라이브러리', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '라이브러리 전환' })).toHaveValue('mock-3')
  await page.getByRole('link', { name: '라이브러리 관리', exact: true }).click()
  const roots = page.getByRole('list', { name: 'D: 드라이브 외 1개 폴더 등록 폴더' })
  await expect(roots.getByRole('listitem')).toHaveText(['D:/', 'E:/Movies'])
  await page.evaluate(() => {
    window.api.library.selectFolders = async () => ({ ok: true, value: null })
  })
  await page.getByRole('button', { name: '새 라이브러리', exact: true }).click()
  await expect(page.getByRole('heading', { name: '라이브러리 선택' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '라이브러리 전환' })).toHaveValue('mock-3')
})

test('restores progress and cancellation when returning to a library with unfinished work', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    const state = (window as unknown as LibraryWindow).libraryHarness
    window.api.library.refresh = () =>
      new Promise((resolve) => {
        state.releaseRefresh = () =>
          resolve({
            ok: true,
            value: { added: 0, skipped: 0, removed: 0, errors: [], cancelled: true },
          })
      })
    window.api.library.cancelWork = async (libraryId) => {
      state.refreshCalls.push(libraryId)
      return { ok: true, value: true }
    }
  })
  await page.getByRole('button', { name: '목록 업데이트', exact: true }).click()
  const picker = page.getByRole('combobox', { name: '라이브러리 전환' })
  await picker.selectOption({ label: 'Second Library' })
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await picker.selectOption('mock-library')
  await expect(page.getByRole('progressbar')).toBeVisible()
  await page.getByRole('button', { name: '작업 취소', exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.refreshCalls),
  ).toEqual(['mock-library'])
  await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.releaseRefresh!())
  await expect(
    page.getByText('목록 업데이트가 취소되었습니다. 처리된 항목은 반영되었습니다.'),
  ).toBeVisible()
})

test('imports selected folders together and picker cancellation preserves the existing selection', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    let selections = 0
    window.api.library.selectFolders = async () => ({
      ok: true,
      value: selections++ === 0 ? ['D:/', 'E:/Movies'] : null,
    })
    window.api.library.importFolders = async (libraryId, folders) => {
      ;(window as unknown as LibraryWindow).libraryHarness.importCalls.push({ libraryId, folders })
      return { ok: true, value: { added: 2, skipped: 0, removed: 0, errors: [] } }
    }
  })
  await page.getByRole('button', { name: '폴더 가져오기', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '폴더 가져오기' })
  await dialog.getByRole('button', { name: '선택', exact: true }).click()
  await expect(dialog.getByRole('list', { name: '선택한 폴더' }).getByRole('listitem')).toHaveText([
    'D:/',
    'E:/Movies',
  ])
  await dialog.getByRole('button', { name: '선택', exact: true }).click()
  await expect(dialog.getByRole('list', { name: '선택한 폴더' }).getByRole('listitem')).toHaveText([
    'D:/',
    'E:/Movies',
  ])
  await dialog.getByRole('button', { name: '가져오기', exact: true }).click()
  await expect(dialog.getByText('가져오기 완료 (추가 2개, 건너뜀 0개)')).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as LibraryWindow).libraryHarness.importCalls),
  ).toEqual([{ libraryId: 'mock-library', folders: ['D:/', 'E:/Movies'] }])
})
