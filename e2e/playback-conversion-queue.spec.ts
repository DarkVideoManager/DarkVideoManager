import { expect, test, type Page } from '@playwright/test'
import type { PlaybackConversionJob } from '../src/shared/playbackConversion'
import type { Result } from '../src/shared/result'

interface ConversionHarness {
  jobs: PlaybackConversionJob[]
  requests: string[]
  failList: boolean
  failAction: boolean
  waiting: Record<string, Array<(value: Result<string, string>) => void>>
  finish: (id: string, error?: string) => void
}
type ConversionWindow = Window & { conversionHarness: ConversionHarness }

async function prepare(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const state: ConversionHarness = {
      jobs: [],
      requests: [],
      failList: false,
      failAction: false,
      waiting: {},
      finish: () => undefined,
    }
    ;(window as unknown as ConversionWindow).conversionHarness = state
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    const videos = [
      { ...result.value, codec: 'mpeg4' },
      {
        ...result.value,
        codec: 'mpeg4',
        id: 'mock-video-2',
        title: 'Second video',
        fileName: 'second.mp4',
        filePath: '/mock/second.mp4',
      },
    ]
    window.api.videos.get = async (_libraryId, id) => ({
      ok: true,
      value: videos.find((video) => video.id === id) ?? null,
    })
    window.api.videos.search = async () => ({
      ok: true,
      value: { videos, total: videos.length, page: 1, pageSize: 50 },
    })
    const schedule = () => {
      if (!state.jobs.some((job) => job.status === 'running')) {
        const next = state.jobs.find((job) => job.status === 'queued')
        if (next) {
          next.status = 'running'
          next.phase = 'transcoding'
          next.updatedAt = new Date().toISOString()
        }
      }
      let position = 1
      for (const job of state.jobs)
        job.queuePosition = job.status === 'queued' ? position++ : undefined
    }
    window.api.playback.listConversionQueue = async () => {
      if (state.failList) throw new Error('변환 대기열 조회 실패')
      return { ok: true, value: structuredClone(state.jobs) }
    }
    window.api.videos.getPlaybackSource = async (libraryId, videoId) => {
      state.requests.push(videoId)
      let job = state.jobs.find((item) => item.libraryId === libraryId && item.videoId === videoId)
      if (!job) {
        const video = videos.find((item) => item.id === videoId)!
        job = {
          id: videoId,
          libraryId,
          videoId,
          title: video.title ?? video.fileName,
          fileName: video.fileName,
          status: 'queued',
          phase: 'waiting',
          progress: 0,
          processedSec: 0,
          durationSec: 125,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        state.jobs.push(job)
        schedule()
      }
      if (job.status === 'completed') return { ok: true, value: `/cache/${videoId}.mp4` }
      if (job.status === 'paused' || job.status === 'failed')
        return { ok: false, error: '변환 중지' }
      return new Promise<Result<string, string>>((resolve) => {
        ;(state.waiting[videoId] ??= []).push(resolve)
      })
    }
    const settle = (id: string, result: Result<string, string>) => {
      for (const resolve of state.waiting[id] ?? []) resolve(result)
      delete state.waiting[id]
    }
    window.api.playback.pauseConversion = async (id) => {
      if (state.failAction) throw new Error('일시정지 연결 실패')
      const job = state.jobs.find((item) => item.id === id)!
      job.status = 'paused'
      settle(id, { ok: false, error: '변환을 일시정지했습니다.' })
      schedule()
      return { ok: true, value: structuredClone(job) }
    }
    window.api.playback.resumeConversion = async (id) => {
      const job = state.jobs.find((item) => item.id === id)!
      job.status = 'queued'
      job.phase = 'waiting'
      job.progress = 0
      job.processedSec = 0
      job.error = undefined
      schedule()
      return { ok: true, value: structuredClone(job) }
    }
    window.api.playback.removeConversion = async (id) => {
      state.jobs = state.jobs.filter((job) => job.id !== id)
      settle(id, { ok: false, error: '변환 작업을 삭제했습니다.' })
      schedule()
      return { ok: true, value: null }
    }
    state.finish = (id, error) => {
      const job = state.jobs.find((item) => item.id === id)!
      job.status = error ? 'failed' : 'completed'
      job.phase = error ? 'transcoding' : 'completed'
      job.progress = error ? job.progress : 100
      job.error = error
      job.updatedAt = new Date().toISOString()
      settle(id, error ? { ok: false, error } : { ok: true, value: `/cache/${id}.mp4` })
      schedule()
    }
  })
}

const card = (page: Page, title: string) =>
  page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
const row = (page: Page, title = 'Sample video') =>
  page.getByRole('article', { name: title, exact: true })

test('conversion stays queued across player navigation and home manages multiple jobs with real progress', async ({
  page,
}) => {
  await prepare(page)
  await expect(page.getByTestId('playback-conversion-queue')).toHaveCount(0)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await card(page, 'Sample video').dblclick()
  await expect(row(page).getByRole('status')).toContainText('영상 변환 중')
  await page.getByRole('button', { name: '홈에서 진행상황 보기' }).click()
  await expect(page.getByTestId('playback-conversion-queue')).toBeVisible()
  await page.evaluate(() => {
    const job = (window as unknown as ConversionWindow).conversionHarness.jobs[0]
    job.progress = 43
    job.processedSec = 54
  })
  await expect(row(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
  await card(page, 'Second video').dblclick()
  await expect(row(page, 'Second video').getByRole('status')).toContainText('대기 1번째')
  await page.getByRole('button', { name: '홈에서 진행상황 보기' }).click()
  await expect(page.getByRole('article')).toHaveCount(2)
  await row(page).getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(row(page)).toContainText('재개하면 이 영상의 변환을 처음부터 시작합니다.')
  await expect(row(page, 'Second video').getByRole('status')).toContainText('영상 변환 중')
  await row(page).getByRole('button', { name: '재개', exact: true }).click()
  await expect(row(page).getByRole('status')).toContainText('대기 1번째')
  await row(page, 'Second video').getByRole('button', { name: '삭제', exact: true }).click()
  await expect(row(page, 'Second video')).toHaveCount(0)
  await expect(row(page).getByRole('status')).toContainText('영상 변환 중')
  await page.evaluate(() =>
    (window as unknown as ConversionWindow).conversionHarness.finish('mock-video-1'),
  )
  await expect(row(page).getByRole('button', { name: '재생', exact: true })).toBeVisible()
  await row(page).getByRole('button', { name: '재생', exact: true }).click()
  await expect(page.locator('video')).toHaveAttribute('src', /mock-video-1.mp4/)
})

test('player pause and retry reacquire a source once and surface action failures', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await card(page, 'Sample video').dblclick()
  await expect(row(page).getByRole('button', { name: '일시정지', exact: true })).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as ConversionWindow).conversionHarness.failAction = true
  })
  await row(page).getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(row(page).getByRole('alert')).toContainText('일시정지 연결 실패')
  await page.evaluate(() => {
    ;(window as unknown as ConversionWindow).conversionHarness.failAction = false
  })
  await row(page).getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(row(page).getByRole('status')).toContainText('일시정지됨')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ConversionWindow).conversionHarness.requests.length,
      ),
    )
    .toBe(1)
  await row(page).getByRole('button', { name: '재개', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ConversionWindow).conversionHarness.requests.length,
      ),
    )
    .toBe(2)
  await page.evaluate(() =>
    (window as unknown as ConversionWindow).conversionHarness.finish(
      'mock-video-1',
      '영상 변환 테스트 실패',
    ),
  )
  await expect(row(page)).toContainText('영상 변환 테스트 실패')
  await row(page).getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ConversionWindow).conversionHarness.requests.length,
      ),
    )
    .toBe(3)
  await page.evaluate(() =>
    (window as unknown as ConversionWindow).conversionHarness.finish('mock-video-1'),
  )
  await expect(page.locator('video')).toHaveAttribute('src', /mock-video-1.mp4/)
  expect(errors).toEqual([])
})

test('global home queue works without a selected library and recovers from polling errors on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 })
  await prepare(page)
  await page.evaluate(() => {
    const state = (window as unknown as ConversionWindow).conversionHarness
    state.failList = true
    state.jobs = [
      {
        id: 'other',
        libraryId: 'other-library',
        videoId: 'other-video',
        title: '다른 라이브러리의 변환 영상',
        fileName: 'other.mp4',
        status: 'failed',
        phase: 'transcoding',
        progress: 20,
        processedSec: 25,
        durationSec: 125,
        error: '변환 연결 실패',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
  })
  await expect(page.getByTestId('playback-conversion-queue').getByRole('alert')).toContainText(
    '변환 대기열 조회 실패',
  )
  await page.evaluate(() => {
    ;(window as unknown as ConversionWindow).conversionHarness.failList = false
  })
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click()
  const other = row(page, '다른 라이브러리의 변환 영상')
  await expect(other).toContainText('변환 연결 실패')
  await other.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(other.getByRole('status')).toContainText('영상 변환 중')
  const panel = page.getByTestId('playback-conversion-queue')
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: '접기', exact: true }).click()
  await expect(other).toHaveCount(0)
  await page.getByRole('button', { name: '펼치기', exact: true }).click()
  await other.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(panel).toHaveCount(0)
})

test('completed playback opens its library first and reports opening failures inline', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    const state = (window as unknown as ConversionWindow).conversionHarness
    state.jobs = [
      {
        id: 'mock-video-1',
        libraryId: 'other-library',
        videoId: 'mock-video-1',
        title: '완료된 다른 라이브러리 영상',
        fileName: 'sample.mp4',
        status: 'completed',
        phase: 'completed',
        progress: 100,
        processedSec: 125,
        durationSec: 125,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    let attempts = 0
    window.api.library.open = async (id) => {
      if (id !== 'other-library') throw new Error('Wrong library opened')
      if (!attempts++) throw new Error('라이브러리 연결 실패')
      return {
        ok: true,
        value: {
          id,
          name: 'Other library',
          dbPath: '/mock/other.db',
          folderPath: '/mock/other',
          createdAt: new Date().toISOString(),
        },
      }
    }
  })
  const job = row(page, '완료된 다른 라이브러리 영상')
  await expect(job).toBeVisible()
  await job.getByRole('button', { name: '재생', exact: true }).click()
  await expect(job.getByRole('alert')).toHaveText('라이브러리 연결 실패')
  await expect(page).toHaveURL(/\/$/)
  await job.getByRole('button', { name: '재생', exact: true }).click()
  await expect(page).toHaveURL(/\/player\/other-library\/mock-video-1$/)
  await expect(page.locator('video')).toHaveAttribute('src', /mock-video-1.mp4/)
})
