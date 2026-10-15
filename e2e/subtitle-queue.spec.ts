import { expect, test, type Page } from '@playwright/test'
import type { SubtitleGenerationJob } from '../src/shared/types'

type Action = 'pause' | 'resume' | 'remove'
interface QueueHarness {
  jobs: SubtitleGenerationJob[]
  failList: boolean
  failAction?: Action
  delayAction?: Action
  releaseAction?: () => void
  quitCalls: number
  failQuit: boolean
}
type QueueWindow = Window & { queueHarness: QueueHarness }

async function prepareQueue(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const state: QueueHarness = { jobs: [], failList: false, quitCalls: 0, failQuit: false }
    ;(window as unknown as QueueWindow).queueHarness = state
    const first = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!first.ok || !first.value) throw new Error('Missing sample fixture')
    const videos = [
      first.value,
      {
        ...first.value,
        id: 'mock-video-2',
        title: 'Second video',
        fileName: 'second.mp4',
        filePath: '/mock/videos/second.mp4',
      },
    ]
    window.api.videos.search = async () => ({
      ok: true,
      value: { videos, total: 2, page: 1, pageSize: 50 },
    })
    window.api.videos.get = async (_libraryId, videoId) => ({
      ok: true,
      value: videos.find((video) => video.id === videoId) ?? null,
    })
    window.api.subtitles.listQueue = async () => {
      if (state.failList) throw new Error('큐 조회 IPC 실패')
      return { ok: true, value: structuredClone(state.jobs) }
    }
    window.api.subtitles.generate = async (libraryId, videoId, options) => {
      if (
        state.jobs.some(
          (job) =>
            job.libraryId === libraryId &&
            job.videoId === videoId &&
            !['completed', 'failed', 'cancelled'].includes(job.phase),
        )
      ) {
        return { ok: false, error: '이미 큐에 있는 영상입니다.' }
      }
      const job: SubtitleGenerationJob = {
        id: crypto.randomUUID(),
        libraryId,
        videoId,
        title: videos.find((video) => video.id === videoId)?.title || videoId,
        options,
        createdAt: new Date().toISOString(),
        phase: state.jobs.some((item) => item.phase === 'transcribing') ? 'queued' : 'transcribing',
        percent: state.jobs.length ? 0 : 35,
        message: '큐에 추가했습니다.',
      }
      state.jobs.push(job)
      return { ok: true, value: structuredClone(job) }
    }
    window.api.subtitles.getGenerationStatus = async (libraryId, videoId) => ({
      ok: true,
      value: structuredClone(
        [...state.jobs]
          .reverse()
          .find((job) => job.libraryId === libraryId && job.videoId === videoId) ?? null,
      ),
    })
    const action = async (operation: Action, id: string) => {
      if (state.failAction === operation) {
        if (operation === 'pause') throw new Error('일시정지 IPC 실패')
        return { ok: false as const, error: `${operation === 'resume' ? '재개' : '삭제'} IPC 실패` }
      }
      if (state.delayAction === operation)
        await new Promise<void>((resolve) => {
          state.releaseAction = resolve
        })
      const job = state.jobs.find((item) => item.id === id)
      if (!job) return { ok: true as const, value: false }
      if (operation === 'remove') state.jobs = state.jobs.filter((item) => item.id !== id)
      else if (operation === 'pause') job.phase = 'paused'
      else
        job.phase = state.jobs.some((item) => item.phase === 'transcribing')
          ? 'queued'
          : 'transcribing'
      return { ok: true as const, value: true }
    }
    window.api.subtitles.pauseJob = (id) => action('pause', id)
    window.api.subtitles.resumeJob = (id) => action('resume', id)
    window.api.subtitles.removeJob = (id) => action('remove', id)
    window.api.app.quit = async () => {
      state.quitCalls += 1
      if (state.failQuit) throw new Error('창 닫기 IPC 실패')
      return { ok: true, value: null }
    }
  })
}

const card = (page: Page, title: string) =>
  page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
const queueItem = (page: Page, title = 'Sample video') =>
  page.getByRole('article', { name: title, exact: true })

async function addJobs(page: Page) {
  await prepareQueue(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await card(page, 'Sample video').click()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('원어 자막 생성 중')
  await panel.getByRole('link', { name: '자막 생성 큐 관리', exact: false }).click()
  await expect(queueItem(page)).toBeVisible()
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await card(page, 'Second video').click()
  await panel.getByLabel('음성 인식 모델').selectOption('small')
  await panel.getByLabel('영상 언어').selectOption('ja')
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('대기 중')
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(2)
}

test('queues multiple videos in one library and manages pause, resume and deletion from the tab', async ({
  page,
}) => {
  await addJobs(page)
  const first = queueItem(page)
  const second = queueItem(page, 'Second video')
  await expect(page.getByText('미완료 2개 / 전체 2개', { exact: false })).toBeVisible()
  await expect(first).toContainText('base · 언어 자동 감지 · 원어 + 한국어 번역')
  await expect(second).toContainText('small · 일본어 · 원어 + 한국어 번역')
  await expect(second.getByRole('status')).toContainText('대기 중')
  await first.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(first.getByRole('status')).toContainText('일시정지됨 · 35%')
  await second.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(second.getByRole('button', { name: '재개', exact: true })).toBeVisible()
  await first.getByRole('button', { name: '재개', exact: true }).click()
  await expect(first.getByRole('status')).toContainText('원어 자막 생성 중 · 35%')
  await second.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(second).toHaveCount(0)
  await expect(first).toBeVisible()
  await expect(
    page.getByText('작업을 삭제해도 이미 저장된 자막 파일은 보존합니다.', { exact: false }),
  ).toBeVisible()
})

test('locks pending queue actions and reports rejected pause, resume and delete without unhandled errors', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await addJobs(page)
  const first = queueItem(page)
  await page.evaluate(() => {
    ;(window as unknown as QueueWindow).queueHarness.failAction = 'pause'
  })
  await first.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(first.getByRole('alert')).toHaveText('일시정지 IPC 실패')
  await page.evaluate(() => {
    const state = (window as unknown as QueueWindow).queueHarness
    state.failAction = undefined
    state.delayAction = 'pause'
  })
  await first.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(first.getByRole('button', { name: '일시정지 중...', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: '삭제', exact: true })).toBeDisabled()
  await page.evaluate(() => {
    const state = (window as unknown as QueueWindow).queueHarness
    state.delayAction = undefined
    state.releaseAction?.()
  })
  await expect(first.getByRole('button', { name: '재개', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    ;(window as unknown as QueueWindow).queueHarness.failAction = 'resume'
  })
  await first.getByRole('button', { name: '재개', exact: true }).click()
  await expect(first.getByRole('alert')).toHaveText('재개 IPC 실패')
  await page.evaluate(() => {
    ;(window as unknown as QueueWindow).queueHarness.failAction = 'remove'
  })
  await first.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(first.getByRole('alert')).toHaveText('삭제 IPC 실패')
  expect(errors).toEqual([])
})

test('loads global jobs, retries failed jobs, preserves saved paths and recovers from queue load errors', async ({
  page,
}) => {
  await prepareQueue(page)
  await page.evaluate(() => {
    const state = (window as unknown as QueueWindow).queueHarness
    state.failList = true
    state.jobs = [
      {
        id: crypto.randomUUID(),
        libraryId: 'other-library',
        videoId: 'other-video',
        title: 'Other library video',
        options: { model: 'base', language: 'en', translateToKorean: true },
        createdAt: new Date().toISOString(),
        phase: 'failed',
        percent: 65,
        message: '번역 연결 실패',
        outputPaths: ['/other/video.ai.srt'],
      },
    ]
  })
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('큐 조회 IPC 실패')
  await page.evaluate(() => {
    ;(window as unknown as QueueWindow).queueHarness.failList = false
  })
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  const job = queueItem(page, 'Other library video')
  await expect(job).toContainText('video.ai.srt')
  await job.getByRole('button', { name: '재개 · 다시 시도', exact: true }).click()
  await expect(job.getByRole('status')).toContainText('원어 자막 생성 중')
  await expect(job).toContainText('video.ai.srt')
})

test('ESC closes through the background-aware app API and respects settings dialogs', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareQueue(page)
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await expect(page.getByText('자막 생성 큐가 비어 있습니다.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as QueueWindow).queueHarness.quitCalls))
    .toBe(1)
  await page.getByRole('button', { name: '화면 다시 열기', exact: true }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as unknown as QueueWindow).queueHarness.quitCalls)).toBe(
    1,
  )
  if (await page.getByRole('dialog').isVisible())
    await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as QueueWindow).queueHarness.failQuit = true
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alert')).toContainText('창 닫기 IPC 실패')
  expect(errors).toEqual([])
})
