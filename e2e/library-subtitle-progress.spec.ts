import { expect, test, type Page } from '@playwright/test'
import type { SubtitleGenerationJob, Video } from '../src/shared/types'

interface LibrarySubtitleHarness {
  videos: Video[]
  jobs: SubtitleGenerationJob[]
  queueCalls: number
  statusCalls: number
  searchCalls: number
}
type LibrarySubtitleWindow = Window & { librarySubtitleHarness: LibrarySubtitleHarness }

async function prepareLibrary(page: Page, withJobs = true) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.evaluate(async (populateJobs) => {
    const fixture = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!fixture.ok || !fixture.value) throw new Error('Missing video fixture')
    const titles = ['Sample video', 'Second video', 'Third video']
    const videos = titles.map((title, index) => ({
      ...fixture.value!,
      id: `mock-video-${index + 1}`,
      title,
      fileName: `sample-${index + 1}.mp4`,
      filePath: `/mock/videos/sample-${index + 1}.mp4`,
      primaryThumbnailPath: undefined,
      hasSubtitles: false,
    }))
    const jobs: SubtitleGenerationJob[] = populateJobs
      ? videos.map((video, index) => ({
          id: crypto.randomUUID(),
          libraryId: 'mock-library',
          videoId: video.id,
          title: video.title!,
          options: { model: 'base', language: 'auto', translateToKorean: true },
          createdAt: new Date(2026, 9, 10, 10, index).toISOString(),
          phase: index === 0 ? 'transcribing' : index === 1 ? 'queued' : 'paused',
          percent: index === 0 ? 35 : index === 1 ? 0 : 52,
          message:
            index === 0 ? '음성 인식 진행 중' : index === 1 ? '순서를 기다리는 중' : '일시정지됨',
        }))
      : []
    const state: LibrarySubtitleHarness = {
      videos,
      jobs,
      queueCalls: 0,
      statusCalls: 0,
      searchCalls: 0,
    }
    ;(window as unknown as LibrarySubtitleWindow).librarySubtitleHarness = state
    window.api.videos.search = async () => {
      state.searchCalls += 1
      return {
        ok: true,
        value: {
          videos: structuredClone(state.videos),
          total: state.videos.length,
          page: 1,
          pageSize: 500,
        },
      }
    }
    window.api.videos.get = async (_libraryId, videoId) => ({
      ok: true,
      value: structuredClone(state.videos.find((video) => video.id === videoId) ?? null),
    })
    window.api.subtitles.listQueue = async () => {
      state.queueCalls += 1
      return { ok: true, value: structuredClone(state.jobs) }
    }
    window.api.subtitles.getGenerationStatus = async (libraryId, videoId) => {
      state.statusCalls += 1
      return {
        ok: true,
        value: structuredClone(
          state.jobs.find((job) => job.libraryId === libraryId && job.videoId === videoId) ?? null,
        ),
      }
    }
    window.api.subtitles.generate = async (libraryId, videoId, options) => {
      const job: SubtitleGenerationJob = {
        id: crypto.randomUUID(),
        libraryId,
        videoId,
        title: state.videos.find((video) => video.id === videoId)?.title || videoId,
        options,
        createdAt: new Date().toISOString(),
        phase: 'transcribing',
        percent: 12,
        message: '음성 인식을 시작했습니다.',
      }
      state.jobs.push(job)
      return { ok: true, value: structuredClone(job) }
    }
  }, withJobs)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(card(page, 'Sample video')).toBeVisible()
}

function card(page: Page, title: string) {
  return page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
}

function status(page: Page, title = 'Sample video') {
  return page.getByRole('status', { name: `${title} 자막 작업`, exact: true })
}

function progress(page: Page, title = 'Sample video') {
  return page.getByRole('progressbar', { name: `${title} 자막 생성 단계 진행률`, exact: true })
}

test('unselected library cards show live subtitle progress and distinguish waiting, paused and failed jobs', async ({
  page,
}) => {
  await prepareLibrary(page)
  await expect(page.getByRole('region', { name: 'AI 자막 생성', exact: true })).toHaveCount(0)
  await expect(status(page)).toContainText('자막 생성 중')
  await expect(status(page)).toContainText('35%')
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '35')
  await expect(status(page, 'Second video')).toContainText('자막 생성 대기')
  await expect(status(page, 'Third video')).toContainText('자막 일시정지')
  await page.screenshot({ path: 'test-results/library-subtitle-progress.png', fullPage: true })

  const before = await page.evaluate(
    () => (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness.queueCalls,
  )
  await page.evaluate(() => {
    const state = (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness
    Object.assign(state.jobs[0], { phase: 'translating', percent: 80 })
    Object.assign(state.jobs[2], { phase: 'failed', message: '번역 연결 실패' })
  })
  await expect(status(page)).toContainText('한국어 번역 중')
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '80')
  await expect(status(page, 'Third video')).toContainText('자막 생성 실패')
  // All visible cards share the queue request, and none request individual video status.
  await page.waitForTimeout(1200)
  const after = await page.evaluate(() => {
    const state = (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness
    return { queueCalls: state.queueCalls, statusCalls: state.statusCalls }
  })
  expect(after.queueCalls - before).toBeGreaterThanOrEqual(1)
  expect(after.queueCalls - before).toBeLessThanOrEqual(4)
  expect(after.statusCalls).toBe(0)
})

test('completion refreshes subtitle badges without opening details and another library cannot supply a card status', async ({
  page,
}) => {
  await prepareLibrary(page)
  await expect(status(page)).toContainText('자막 생성 중')
  await expect(
    card(page, 'Sample video').getByText('자막 없음', { exact: true }).first(),
  ).toBeVisible()
  const searchesBefore = await page.evaluate(
    () => (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness.searchCalls,
  )
  await page.evaluate(() => {
    const state = (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness
    state.videos[0].hasSubtitles = true
    Object.assign(state.jobs[0], {
      phase: 'completed',
      percent: 100,
      outputPaths: ['/mock/videos/sample-1.ai.srt', '/mock/videos/sample-1.ai.ko.srt'],
    })
    // A job from a different library may use the same video id, even when newer.
    state.jobs.push({
      ...state.jobs[0],
      id: crypto.randomUUID(),
      libraryId: 'other-library',
      createdAt: new Date(2026, 9, 11).toISOString(),
      phase: 'transcribing',
      percent: 99,
    })
    state.jobs[1].phase = 'cancelled'
  })
  await expect(status(page)).toHaveCount(0)
  await expect(status(page, 'Second video')).toHaveCount(0)
  await expect(card(page, 'Sample video').getByText('자막 있음', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness.searchCalls,
      ),
    )
    .toBeGreaterThan(searchesBefore)
  await expect(page.getByRole('region', { name: 'AI 자막 생성', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(
      () => (window as unknown as LibrarySubtitleWindow).librarySubtitleHarness.statusCalls,
    ),
  ).toBe(0)
})

test('starting from an empty queue updates the card and keeps normal selection and playback working', async ({
  page,
}) => {
  await prepareLibrary(page, false)
  await expect(status(page)).toHaveCount(0)
  await card(page, 'Sample video').click()
  await page.getByRole('tab', { name: '자막 생성', exact: true }).click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(status(page)).toContainText('자막 생성 중')
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '12')
  await card(page, 'Sample video').dblclick()
  await expect(page.locator('video')).toBeVisible()
})
