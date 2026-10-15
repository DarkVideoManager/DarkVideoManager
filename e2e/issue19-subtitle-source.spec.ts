import { expect, test, type Page } from '@playwright/test'
import type { SubtitleGenerationJob } from '../src/shared/types'

interface SourceHarness {
  calls: string[][]
  queueActions: string[]
  failure?: 'missing' | 'ipc'
  delay: boolean
  release?: () => void
}
type SourceWindow = Window & { sourceHarness: SourceHarness }

async function prepareQueue(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const state: SourceHarness = { calls: [], queueActions: [], delay: false }
    ;(window as unknown as SourceWindow).sourceHarness = state
    const jobs: SubtitleGenerationJob[] = [
      {
        id: 'd3595954-49b9-49e8-89d0-bbe661927323',
        libraryId: 'mock-library',
        videoId: 'same-video-id',
        title: '진행 중인 원본',
        options: { model: 'base', language: 'ja', translateToKorean: true },
        createdAt: '2026-10-15T10:00:00.000Z',
        phase: 'transcribing',
        percent: 35,
      },
      {
        id: '7ed629b4-5fb3-446d-89f9-bf1ab30817fb',
        libraryId: 'other-library',
        videoId: 'same-video-id',
        title: '다른 라이브러리의 완료 원본',
        options: { model: 'base', language: 'en', translateToKorean: true },
        createdAt: '2026-10-15T09:00:00.000Z',
        phase: 'completed',
        percent: 100,
        outputPaths: ['C:/generated-subtitles/output.ai.srt'],
      },
    ]
    window.api.subtitles.listQueue = async () => ({ ok: true, value: structuredClone(jobs) })
    window.api.videos.revealSource = async (...args) => {
      state.calls.push(args)
      if (state.delay)
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
      if (state.failure === 'ipc') throw new Error('파일 탐색기 IPC 연결 실패')
      if (state.failure === 'missing')
        return {
          ok: false,
          error:
            '원본 영상 파일을 찾거나 읽을 수 없습니다. 파일 이동·삭제 또는 드라이브 연결 상태를 확인해 주세요.',
        }
      return { ok: true, value: null }
    }
    for (const operation of ['pauseJob', 'resumeJob', 'removeJob'] as const) {
      window.api.subtitles[operation] = async () => {
        state.queueActions.push(operation)
        return { ok: true, value: true }
      }
    }
  })
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(2)
}

const firstRow = (page: Page) => page.getByRole('article', { name: '진행 중인 원본', exact: true })
const secondRow = (page: Page) =>
  page.getByRole('article', { name: '다른 라이브러리의 완료 원본', exact: true })

test('each subtitle job reveals its own original using library and video IDs, including completed jobs', async ({
  page,
}) => {
  await prepareQueue(page)
  await expect(secondRow(page).getByRole('list', { name: '생성된 자막 파일' })).toContainText(
    'output.ai.srt',
  )
  await firstRow(page).getByRole('button', { name: '원본 위치 열기', exact: true }).click()
  await secondRow(page).getByRole('button', { name: '원본 위치 열기', exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.calls),
  ).toEqual([
    ['mock-library', 'same-video-id'],
    ['other-library', 'same-video-id'],
  ])
  expect(
    await page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.queueActions),
  ).toEqual([])
  await expect(firstRow(page).getByRole('status')).toHaveText('원어 자막 생성 중 · 35%')
  await expect(secondRow(page).getByRole('status')).toHaveText('완료')
})

test('a pending location request disables only that row location button', async ({ page }) => {
  await prepareQueue(page)
  await page.evaluate(() => {
    ;(window as unknown as SourceWindow).sourceHarness.delay = true
  })
  await firstRow(page).getByRole('button', { name: '원본 위치 열기', exact: true }).click()
  await expect(firstRow(page).getByRole('button', { name: '원본 위치 여는 중...' })).toBeDisabled()
  await expect(firstRow(page).getByRole('button', { name: '일시정지', exact: true })).toBeEnabled()
  await expect(secondRow(page).getByRole('button', { name: '원본 위치 열기' })).toBeEnabled()
  expect(
    await page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.calls),
  ).toHaveLength(1)
  await page.evaluate(() => {
    const state = (window as unknown as SourceWindow).sourceHarness
    state.delay = false
    state.release?.()
  })
  await expect(firstRow(page).getByRole('button', { name: '원본 위치 열기' })).toBeEnabled()
  await expect(firstRow(page).getByRole('status')).toHaveText('원어 자막 생성 중 · 35%')
})

for (const failure of ['missing', 'ipc'] as const) {
  test(`shows a ${failure} failure on the selected row and permits retry without changing the queue`, async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await prepareQueue(page)
    await page.evaluate((value) => {
      ;(window as unknown as SourceWindow).sourceHarness.failure = value
    }, failure)
    await secondRow(page).getByRole('button', { name: '원본 위치 열기' }).click()
    await expect(secondRow(page).getByRole('alert')).toContainText(
      failure === 'missing'
        ? '파일 이동·삭제 또는 드라이브 연결 상태'
        : '파일 탐색기 IPC 연결 실패',
    )
    await expect(firstRow(page).getByRole('alert')).toHaveCount(0)
    await expect(secondRow(page).getByRole('button', { name: '원본 위치 열기' })).toBeEnabled()
    await page.evaluate(() => {
      ;(window as unknown as SourceWindow).sourceHarness.failure = undefined
    })
    await secondRow(page).getByRole('button', { name: '원본 위치 열기' }).click()
    await expect(secondRow(page).getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('article')).toHaveCount(2)
    expect(
      await page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.queueActions),
    ).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
