import { expect, test, type Page } from '@playwright/test'
import type { ImportProgress } from '../src/shared/types'

interface WorkHarness {
  emit: (progress: ImportProgress) => void
  finish: (cancelled?: boolean) => void
  finishMetadata: () => void
  rejectMetadata: () => void
  cancelCalls: string[]
}
type WorkWindow = Window & { workHarness: WorkHarness }

async function prepareWorkHarness(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const listeners = new Set<(progress: ImportProgress) => void>()
    const state = ((window as unknown as WorkWindow).workHarness = {
      emit: (progress) => listeners.forEach((listener) => listener(progress)),
      finish: () => undefined,
      finishMetadata: () => undefined,
      rejectMetadata: () => undefined,
      cancelCalls: [],
    })
    window.api.on.importProgress = (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const pending = () =>
      new Promise<Awaited<ReturnType<typeof window.api.library.importFolder>>>((resolve) => {
        state.finish = (cancelled = false) =>
          resolve({ ok: true, value: { added: 2, skipped: 0, removed: 0, errors: [], cancelled } })
      })
    window.api.library.importFolder = pending
    window.api.library.refresh = pending
    window.api.library.cancelWork = async (libraryId) => {
      state.cancelCalls.push(libraryId)
      return { ok: true, value: true }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
}

async function emit(page: Page, progress: Partial<ImportProgress>) {
  await page.evaluate(
    (next) =>
      (window as unknown as WorkWindow).workHarness.emit({
        libraryId: 'mock-library',
        phase: 'thumbnails',
        current: 2,
        total: 4,
        errors: [],
        ...next,
      }),
    progress,
  )
}

test('folder completion waits for its IPC result and ignores progress from other libraries', async ({
  page,
}) => {
  await prepareWorkHarness(page)
  await page.getByRole('button', { name: '폴더 가져오기', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '폴더 가져오기' })
  await dialog.getByRole('button', { name: '선택', exact: true }).click()
  await dialog.getByRole('button', { name: '가져오기', exact: true }).click()
  await emit(page, {})
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  await emit(page, { libraryId: 'another-library', phase: 'done', current: 999, total: 999 })
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  await emit(page, { phase: 'done', current: 4 })
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
  await expect(dialog.getByText(/가져오기 완료/)).toHaveCount(0)
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.finish())
  await expect(dialog.getByText(/가져오기 완료/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
})

test('folder and library refresh cancellation wait for acknowledgement without reporting success', async ({
  page,
}) => {
  await prepareWorkHarness(page)
  await page.getByRole('button', { name: '폴더 가져오기', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '폴더 가져오기' })
  await dialog.getByRole('button', { name: '선택', exact: true }).click()
  await dialog.getByRole('button', { name: '가져오기', exact: true }).click()
  await dialog.getByRole('button', { name: '작업 취소', exact: true }).click()
  await emit(page, { phase: 'cancelled' })
  await expect(dialog.getByRole('button', { name: '취소 요청 중...', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.finish(true))
  await expect(
    dialog.getByText('작업이 취소되었습니다. 처리된 항목은 목록에 반영되었습니다.'),
  ).toBeVisible()
  await expect(dialog.getByText(/가져오기 완료/)).toHaveCount(0)
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()

  await page.getByRole('button', { name: '목록 업데이트', exact: true }).click()
  await emit(page, { phase: 'probing', current: 1, total: 5 })
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
  await expect(page.getByRole('button', { name: '폴더 가져오기', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '작업 취소', exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.finish(true))
  await expect(
    page.getByText('목록 업데이트가 취소되었습니다. 처리된 항목은 반영되었습니다.'),
  ).toBeVisible()
  await expect(page.getByText('목록 업데이트가 완료되었습니다.')).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as WorkWindow).workHarness.cancelCalls),
  ).toEqual(['mock-library', 'mock-library'])
})

test('CSV preview and apply can be cancelled and rejected IPC calls release busy controls', async ({
  page,
}) => {
  await prepareWorkHarness(page)
  await page.evaluate(() => {
    const state = (window as unknown as WorkWindow).workHarness
    const api = window.api.dataImport
    const originalPreview = api.preview.bind(api)
    let previews = 0
    let imports = 0
    api.preview = (libraryId, filePath) => {
      if (previews++ > 0) return originalPreview(libraryId, filePath)
      return new Promise<Awaited<ReturnType<typeof api.preview>>>((resolve) => {
        state.finishMetadata = () => resolve({ ok: false, error: '작업이 취소되었습니다.' })
      })
    }
    api.importCsv = () =>
      new Promise<Awaited<ReturnType<typeof api.importCsv>>>((resolve, reject) => {
        if (imports++ === 0)
          state.finishMetadata = () => resolve({ ok: false, error: '작업이 취소되었습니다.' })
        else state.rejectMetadata = () => reject(new Error('IPC 연결 테스트 실패'))
      })
  })
  await page.getByRole('button', { name: 'CSV 가져오기', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'CSV 가져오기' })
  await dialog.getByRole('button', { name: 'CSV 선택', exact: true }).click()
  await dialog.getByRole('button', { name: '분석', exact: true }).click()
  await emit(page, { phase: 'preparing', current: 1, total: 4 })
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '작업 취소', exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.finishMetadata())
  await expect(dialog.getByRole('alert')).toHaveText('작업이 취소되었습니다.')
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '분석', exact: true }).click()
  await expect(dialog.getByText('미리보기', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '가져오기 적용', exact: true }).click()
  await emit(page, { phase: 'applying' })
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '작업 취소', exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.finishMetadata())
  await expect(dialog.getByRole('alert')).toHaveText('작업이 취소되었습니다.')
  await expect(dialog.getByText('가져오기 완료', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '가져오기 적용', exact: true }).click()
  await page.evaluate(() => (window as unknown as WorkWindow).workHarness.rejectMetadata())
  await expect(dialog.getByRole('alert')).toHaveText('IPC 연결 테스트 실패')
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '가져오기 적용', exact: true })).toBeEnabled()
})
