import { expect, test, type Page } from '@playwright/test'
import type { ImportProgress, ThumbnailJob, Video } from '../src/shared/types'

interface ThumbnailHarness {
  videos: Video[]
  jobs: ThumbnailJob[]
  cancelled: string[]
  queueCalls: number
  failCancel: boolean
  retryCount: number
  finishRetry?: (cancelled?: boolean) => void
  retryVideoId?: string
  progressListeners: Set<(progress: ImportProgress) => void>
}
type ThumbnailWindow = Window & { thumbnailHarness: ThumbnailHarness }

async function prepareLibrary(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.evaluate(async () => {
    const fixture = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!fixture.ok || !fixture.value) throw new Error('Missing fixture')
    const videos = ['First video', 'Second video', 'Third video'].map((title, index) => ({
      ...fixture.value!,
      id: `thumbnail-video-${index + 1}`,
      title,
      fileName: `sample-${index + 1}.mp4`,
      primaryThumbnailPath: undefined,
    }))
    const state: ThumbnailHarness = {
      videos,
      jobs: videos.map((video, index) => ({
        libraryId: 'mock-library',
        videoId: video.id,
        fileName: video.fileName,
        phase: index === 0 ? 'running' : 'queued',
        completed: index === 0 ? 1 : 0,
        total: 3,
      })),
      cancelled: [],
      queueCalls: 0,
      retryCount: 0,
      failCancel: false,
      progressListeners: new Set(),
    }
    ;(window as unknown as ThumbnailWindow).thumbnailHarness = state
    window.api.videos.search = async () => ({
      ok: true,
      value: {
        videos: structuredClone(state.videos),
        total: state.videos.length,
        page: 1,
        pageSize: 500,
      },
    })
    window.api.videos.get = async (_libraryId, videoId) => ({
      ok: true,
      value: structuredClone(state.videos.find((video) => video.id === videoId) ?? null),
    })
    window.api.thumbnails.listJobs = async () => {
      state.queueCalls += 1
      return { ok: true, value: structuredClone(state.jobs) }
    }
    window.api.thumbnails.cancelForVideo = async (libraryId, videoId) => {
      if (state.failCancel) return { ok: false, error: '취소 연결 오류' }
      state.cancelled.push(videoId)
      const job = state.jobs.find(
        (item) => item.libraryId === libraryId && item.videoId === videoId,
      )!
      job.phase = 'cancelled'
      job.error = '사용자가 작업을 취소했습니다.'
      if (state.retryVideoId === videoId) state.finishRetry?.(true)
      return { ok: true, value: true }
    }
    window.api.thumbnails.ensureForVideo = async (libraryId, videoId) => {
      const job = state.jobs.find(
        (item) => item.libraryId === libraryId && item.videoId === videoId,
      )!
      state.retryCount += 1
      state.retryVideoId = videoId
      Object.assign(job, { phase: 'running', completed: 0, error: undefined })
      return new Promise((resolve) => {
        state.finishRetry = (cancelled = false) => {
          const error = cancelled ? '작업이 취소되었습니다.' : '재시도 시간 초과'
          Object.assign(job, { phase: cancelled ? 'cancelled' : 'failed', error })
          resolve({ ok: false, error })
        }
      })
    }
    window.api.on.importProgress = (listener) => {
      state.progressListeners.add(listener)
      return () => {
        state.progressListeners.delete(listener)
      }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(card(page, 'First video')).toBeVisible()
}

function card(page: Page, title: string) {
  return page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
}
function jobStatus(page: Page, title: string) {
  return page.getByRole('status', { name: `${title} 썸네일 작업`, exact: true })
}

test('per-video progress survives selection changes and cancelling one job leaves other jobs running', async ({
  page,
}) => {
  await prepareLibrary(page)
  await expect(jobStatus(page, 'First video')).toContainText('1/3')
  await expect(jobStatus(page, 'Second video')).toContainText('썸네일 생성 대기')
  await card(page, 'First video').click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('1/3')
  await card(page, 'Second video').click()
  await card(page, 'First video').click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('썸네일 생성 중')
  await page.screenshot({ path: 'test-results/thumbnail-jobs-library.png', fullPage: true })
  await page.getByRole('button', { name: 'Third video 썸네일 작업 취소', exact: true }).click()
  await expect(jobStatus(page, 'Third video')).toContainText('썸네일 생성 취소됨')
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 중')
  await card(page, 'Second video').click()
  await page.getByRole('button', { name: 'First video 썸네일 작업 취소', exact: true }).click()
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 취소됨')
  await expect(jobStatus(page, '선택한 영상')).toContainText('썸네일 생성 대기')
  expect(
    await page.evaluate(() => (window as unknown as ThumbnailWindow).thumbnailHarness.cancelled),
  ).toEqual(['thumbnail-video-3', 'thumbnail-video-1'])
  const calls = await page.evaluate(
    () => (window as unknown as ThumbnailWindow).thumbnailHarness.queueCalls,
  )
  await page.waitForTimeout(1100)
  const subsequentCalls = await page.evaluate(
    () => (window as unknown as ThumbnailWindow).thumbnailHarness.queueCalls,
  )
  expect(subsequentCalls - calls).toBeLessThanOrEqual(4)
})

test('failed jobs show their reason and retry state remains visible after the detail panel remounts', async ({
  page,
}) => {
  await prepareLibrary(page)
  await page.evaluate(() => {
    const state = (window as unknown as ThumbnailWindow).thumbnailHarness
    Object.assign(state.jobs[0], { phase: 'failed', error: '프레임 추출 시간 초과' })
    // A job from another library cannot replace the card's status even with the same video id.
    state.jobs.push({ ...state.jobs[0], libraryId: 'another-library', phase: 'running' })
  })
  await expect(jobStatus(page, 'First video')).toContainText('프레임 추출 시간 초과')
  await card(page, 'First video').click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('프레임 추출 시간 초과')
  await page.getByRole('button', { name: '다시 생성', exact: true }).click()
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 중')
  await card(page, 'Second video').click()
  await card(page, 'First video').click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('썸네일 생성 중')
  await expect(page.getByRole('button', { name: '작업 중...', exact: true })).toBeDisabled()
  await page.evaluate(() => (window as unknown as ThumbnailWindow).thumbnailHarness.finishRetry?.())
  await expect(jobStatus(page, '선택한 영상')).toContainText('재시도 시간 초과')
  await expect(page.getByRole('button', { name: '다시 생성', exact: true })).toBeEnabled()
  expect(
    await page.evaluate(() => (window as unknown as ThumbnailWindow).thumbnailHarness.retryCount),
  ).toBe(1)
})

test('cancellation failures stay visible and can be retried without cancelling another video', async ({
  page,
}) => {
  await prepareLibrary(page)
  await page.evaluate(() => {
    ;(window as unknown as ThumbnailWindow).thumbnailHarness.failCancel = true
  })
  const cancel = page.getByRole('button', { name: 'First video 썸네일 작업 취소', exact: true })
  await cancel.click()
  await expect(page.getByRole('alert')).toContainText('취소 연결 오류')
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 중')
  await expect(cancel).toBeEnabled()
  await page.evaluate(() => {
    ;(window as unknown as ThumbnailWindow).thumbnailHarness.failCancel = false
  })
  await cancel.click()
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 취소됨')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('cancelling a manually started retry shows cancellation without a generation failure alert', async ({
  page,
}) => {
  await prepareLibrary(page)
  await page.evaluate(() => {
    const state = (window as unknown as ThumbnailWindow).thumbnailHarness
    Object.assign(state.jobs[0], { phase: 'failed', error: '프레임 추출 시간 초과' })
  })
  await expect(jobStatus(page, 'First video')).toContainText('썸네일 생성 실패')
  await card(page, 'First video').click()
  await page.getByRole('button', { name: '다시 생성', exact: true }).click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('썸네일 생성 중')
  await page.getByRole('button', { name: '선택한 영상 썸네일 작업 취소', exact: true }).click()
  await expect(jobStatus(page, '선택한 영상')).toContainText('썸네일 생성 취소됨')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '다시 생성', exact: true })).toBeEnabled()
})

test('newly indexed videos and individual cancel controls are available during an unfinished import', async ({
  page,
}) => {
  await prepareLibrary(page)
  await page.evaluate(() => {
    const state = (window as unknown as ThumbnailWindow).thumbnailHarness
    state.jobs = []
    window.api.library.importFolders = async () => {
      const video = {
        ...state.videos[0],
        id: 'imported-video',
        title: 'Imported video',
        fileName: 'imported.mp4',
      }
      state.videos.push(video)
      state.jobs.push({
        libraryId: 'mock-library',
        videoId: video.id,
        fileName: video.fileName,
        phase: 'running',
        completed: 0,
        total: 3,
      })
      state.progressListeners.forEach((listener) =>
        listener({
          libraryId: 'mock-library',
          phase: 'thumbnails',
          current: 0,
          total: 1,
          currentFile: video.fileName,
          errors: [],
        }),
      )
      return new Promise(() => {})
    }
  })
  await page.getByRole('button', { name: '폴더 가져오기', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '폴더 가져오기', exact: true })
  await dialog.getByRole('button', { name: '선택', exact: true }).click()
  await dialog.getByRole('button', { name: '가져오기', exact: true }).click()
  await expect(card(page, 'Imported video')).toBeAttached()
  const status = dialog.getByRole('status', {
    name: 'imported.mp4 가져오기 썸네일 작업',
    exact: true,
  })
  await expect(status).toContainText('썸네일 생성 중')
  await page.screenshot({ path: 'test-results/thumbnail-jobs-import.png', fullPage: true })
  await dialog
    .getByRole('button', { name: 'imported.mp4 가져오기 썸네일 작업 취소', exact: true })
    .click()
  await expect(status).toContainText('썸네일 생성 취소됨')
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
})
