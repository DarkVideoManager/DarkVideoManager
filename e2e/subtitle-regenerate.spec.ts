import { expect, test, type Page } from '@playwright/test'
import type { SubtitleGenerationOptions, SubtitleGenerationJob } from '../src/shared/types'

interface RegenerationHarness {
  calls: Array<{ subtitleIds: string[]; options: SubtitleGenerationOptions }>
  originalIds: string[]
  subtitleReads: number
  videoSearches: number
  quitCalls: number
  failAfterDeletion: boolean
  delayed: boolean
  release?: () => void
  phase?: SubtitleGenerationJob['phase']
  failingJob?: SubtitleGenerationJob
}
type RegenerationWindow = Window & { regenerationHarness: RegenerationHarness }

async function prepareExistingSubtitles(page: Page) {
  await page.goto('/')
  await page.evaluate(() =>
    window.api.subtitles.generate('mock-library', 'mock-video-1', {
      model: 'base',
      language: 'en',
      translateToKorean: true,
    }),
  )
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await window.api.subtitles.getGenerationStatus(
          'mock-library',
          'mock-video-1',
        )
        return result.ok && result.value?.phase
      }),
    )
    .toBe('completed')
  await page.evaluate(async () => {
    const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
    if (!result.ok) throw new Error(result.error)
    const state: RegenerationHarness = {
      calls: [],
      originalIds: result.value.map((track) => track.id),
      subtitleReads: 0,
      videoSearches: 0,
      quitCalls: 0,
      failAfterDeletion: false,
      delayed: false,
    }
    ;(window as unknown as RegenerationWindow).regenerationHarness = state
    result.value.push({
      id: 'embedded-track',
      videoId: 'mock-video-1',
      filePath: '/mock/videos/sample.mp4',
      lang: 'ja',
      type: 'srt',
      trackIndex: 2,
      isEmbedded: true,
    })
    const getForVideo = window.api.subtitles.getForVideo
    window.api.subtitles.getForVideo = async (libraryId, videoId) => {
      state.subtitleReads += 1
      return getForVideo(libraryId, videoId)
    }
    const search = window.api.videos.search
    window.api.videos.search = async (libraryId, query) => {
      state.videoSearches += 1
      return search(libraryId, query)
    }
    const getStatus = window.api.subtitles.getGenerationStatus
    window.api.subtitles.getGenerationStatus = async (libraryId, videoId) => {
      if (state.failingJob) {
        if (state.failingJob.phase === 'queued') {
          const tracks = await getForVideo(libraryId, videoId)
          if (tracks.ok)
            tracks.value.splice(
              0,
              tracks.value.length,
              ...tracks.value.filter((track) => track.isEmbedded),
            )
          state.failingJob = {
            ...state.failingJob,
            phase: 'failed',
            message: '기존 자막은 휴지통으로 이동했지만 재생성 시작에 실패했습니다.',
          }
        }
        return { ok: true, value: { ...state.failingJob } }
      }
      const status = await getStatus(libraryId, videoId)
      return state.phase && status.ok && status.value
        ? { ok: true, value: { ...status.value, phase: state.phase } }
        : status
    }
    const regenerate = window.api.subtitles.regenerate
    window.api.subtitles.regenerate = async (libraryId, videoId, subtitleIds, options) => {
      state.calls.push({ subtitleIds: [...subtitleIds], options: { ...options } })
      if (state.delayed)
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
      if (state.failAfterDeletion) {
        state.failingJob = {
          id: crypto.randomUUID(),
          libraryId,
          videoId,
          title: 'Sample video',
          options,
          createdAt: new Date().toISOString(),
          phase: 'queued',
          percent: 0,
          message: '차례를 기다리고 있습니다.',
        }
        return { ok: true, value: { ...state.failingJob } }
      }
      return regenerate(libraryId, videoId, subtitleIds, options)
    }
    window.api.app.quit = async () => {
      state.quitCalls += 1
      return { ok: true, value: null }
    }
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  return page.getByRole('region', { name: 'AI 자막 생성', exact: true })
}

test('confirms exact external files and cancellation preserves subtitles without closing the app', async ({
  page,
}) => {
  const panel = await prepareExistingSubtitles(page)
  const open = panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true })
  await open.click()
  const dialog = panel.getByRole('dialog')
  await expect(dialog.getByRole('list', { name: '삭제할 자막 파일' })).toHaveText(
    'sample.ai.ko.srtsample.ai.srt',
  )
  await expect(dialog).not.toContainText('sample.mp4')
  await expect(dialog).toContainText('휴지통')
  await expect(dialog).toContainText('원본 영상과 내장 자막은 유지합니다.')
  await expect(dialog).toContainText('재생성 작업을 큐에 추가합니다.')
  await expect(dialog).toContainText('대기 중에는 기존 자막을 유지합니다.')
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await open.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as RegenerationWindow).regenerationHarness
      return { calls: state.calls.length, quitCalls: state.quitCalls }
    }),
  ).toEqual({ calls: 0, quitCalls: 0 })
  const tracks = await page.evaluate(() =>
    window.api.subtitles.getForVideo('mock-library', 'mock-video-1'),
  )
  expect(tracks.ok && tracks.value.length).toBe(3)
})

test('regenerates with captured options exactly once and preserves embedded subtitles', async ({
  page,
}) => {
  const panel = await prepareExistingSubtitles(page)
  await panel.getByLabel('음성 인식 모델').selectOption('small')
  await panel.getByLabel('영상 언어').selectOption('ja')
  await panel.getByLabel('한국어 번역 자막도 생성').uncheck()
  await page.evaluate(() => {
    ;(window as unknown as RegenerationWindow).regenerationHarness.delayed = true
  })
  await panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }).click()
  const dialog = panel.getByRole('dialog')
  await expect(dialog).toContainText('small · ja · 원어 자막만')
  await expect(panel.getByLabel('음성 인식 모델')).toBeDisabled()
  await dialog
    .getByRole('button', { name: '삭제 후 재생성', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await expect(
    panel.getByRole('button', { name: '재생성 큐에 추가 중...', exact: true }),
  ).toBeDisabled()
  await expect(panel.getByRole('button', { name: '자막 생성 시작', exact: true })).toBeDisabled()
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as RegenerationWindow).regenerationHarness
      return { calls: state.calls, originalIds: state.originalIds }
    }),
  ).toMatchObject({
    calls: [{ options: { model: 'small', language: 'ja', translateToKorean: false } }],
  })
  await page.evaluate(() => {
    ;(window as unknown as RegenerationWindow).regenerationHarness.release?.()
  })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
        return result.ok && result.value.map((track) => track.id)
      }),
    )
    .toEqual(['mock-subtitle-2-0', 'embedded-track'])
  await expect(panel.getByRole('status')).toContainText('자막 생성 완료')
  await expect(panel.getByRole('list', { name: '생성된 자막 파일' })).toHaveText('sample.ai.srt')
  const state = await page.evaluate(async () => ({
    harness: (window as unknown as RegenerationWindow).regenerationHarness,
    tracks: await window.api.subtitles.getForVideo('mock-library', 'mock-video-1'),
    queue: await window.api.subtitles.listQueue(),
  }))
  expect(state.harness.calls).toHaveLength(1)
  expect(state.harness.calls[0].subtitleIds).toEqual(state.harness.originalIds)
  expect(state.tracks.ok && state.tracks.value.map((track) => track.id)).toEqual([
    'mock-subtitle-2-0',
    'embedded-track',
  ])
  expect(state.queue.ok && state.queue.value).toHaveLength(1)
})

test('refreshes subtitle and video data after partial deletion fails', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const panel = await prepareExistingSubtitles(page)
  await page.evaluate(() => {
    const state = (window as unknown as RegenerationWindow).regenerationHarness
    state.failAfterDeletion = true
    state.subtitleReads = 0
    state.videoSearches = 0
  })
  await panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }).click()
  await panel
    .getByRole('dialog')
    .getByRole('button', { name: '삭제 후 재생성', exact: true })
    .click()
  await expect(panel.getByRole('alert')).toContainText(
    '기존 자막은 휴지통으로 이동했지만 재생성 시작에 실패했습니다.',
  )
  await expect(
    panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }),
  ).toHaveCount(0)
  await expect(
    panel.getByText('영상에 내장된 자막은 삭제하지 않습니다.', { exact: false }),
  ).toBeVisible()
  const calls = await page.evaluate(() => {
    const state = (window as unknown as RegenerationWindow).regenerationHarness
    return { subtitleReads: state.subtitleReads, videoSearches: state.videoSearches }
  })
  expect(calls.subtitleReads).toBeGreaterThan(0)
  expect(calls.videoSearches).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('queues regeneration behind another video and preserves files when waiting jobs are paused or removed', async ({
  page,
}) => {
  const panel = await prepareExistingSubtitles(page)
  const blockingJobId = await page.evaluate(async () => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    const video = result.value
    const original = { id: video.id, title: video.title }
    // Borrow the mutable fixture to register a separate blocker, which is removed before completion.
    video.id = 'mock-blocking-video'
    video.title = 'Blocking video'
    // Hold only this worker's first timer, leaving React Query and rendering timers running.
    const schedule = window.setTimeout
    window.setTimeout = ((handler, _delay, ...args) =>
      schedule(handler, 60_000, ...args)) as typeof window.setTimeout
    try {
      const job = await window.api.subtitles.generate('mock-library', video.id, {
        model: 'base',
        language: 'en',
        translateToKorean: false,
      })
      if (!job.ok) throw new Error(job.error)
      return job.value.id
    } finally {
      window.setTimeout = schedule
      Object.assign(video, original)
    }
  })
  const originalFiles = await page.evaluate(async () => {
    const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
    return result.ok && result.value.map((track) => track.id)
  })
  await panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }).click()
  await panel
    .getByRole('dialog')
    .getByRole('button', { name: '삭제 후 재생성', exact: true })
    .click()
  await expect(panel.getByRole('status')).toContainText('대기 중')
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const item = page.getByRole('article', { name: 'Sample video', exact: true })
  await expect(item.getByRole('status')).toContainText('대기 중')
  await item.getByRole('button', { name: '일시정지', exact: true }).click()
  await expect(item.getByRole('status')).toContainText('일시정지됨')
  expect(
    await page.evaluate(async () => {
      const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
      return result.ok && result.value.map((track) => track.id)
    }),
  ).toEqual(originalFiles)
  await item.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(item).toHaveCount(0)
  expect(
    await page.evaluate(async () => {
      const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
      return result.ok && result.value.map((track) => track.id)
    }),
  ).toEqual(originalFiles)
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  await panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }).click()
  await panel
    .getByRole('dialog')
    .getByRole('button', { name: '삭제 후 재생성', exact: true })
    .click()
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await item.getByRole('button', { name: '일시정지', exact: true }).click()
  await page.evaluate((id) => window.api.subtitles.removeJob(id), blockingJobId)
  expect(
    await page.evaluate(async () => {
      const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
      return result.ok && result.value.map((track) => track.id)
    }),
  ).toEqual(originalFiles)
  await item.getByRole('button', { name: '재개', exact: true }).click()
  expect(
    await page.evaluate(async () => {
      const result = await window.api.subtitles.getForVideo('mock-library', 'mock-video-1')
      return result.ok && result.value.map((track) => track.id)
    }),
  ).toEqual(['embedded-track'])
  await expect(item.getByRole('status')).toHaveText('완료')
  const tracks = await page.evaluate(() =>
    window.api.subtitles.getForVideo('mock-library', 'mock-video-1'),
  )
  expect(tracks.ok && tracks.value.filter((track) => !track.isEmbedded)).toHaveLength(2)
  expect(tracks.ok && tracks.value.some((track) => track.id === 'embedded-track')).toBe(true)
})

test('blocks destructive regeneration while the existing job is paused or active', async ({
  page,
}) => {
  await page.goto('/')
  const panel = await prepareExistingSubtitles(page)
  await page.evaluate(() => {
    ;(window as unknown as RegenerationWindow).regenerationHarness.phase = 'paused'
  })
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  await expect(panel.getByRole('status')).toContainText('일시정지됨')
  await expect(
    panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }),
  ).toBeDisabled()
  await page.evaluate(() => {
    ;(window as unknown as RegenerationWindow).regenerationHarness.phase = 'transcribing'
  })
  await expect(panel.getByRole('status')).toContainText('원어 자막 생성 중')
  await expect(
    panel.getByRole('button', { name: '기존 자막 삭제 후 재생성', exact: true }),
  ).toBeDisabled()
})
