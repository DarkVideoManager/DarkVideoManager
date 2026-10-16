import { expect, test, type Page } from '@playwright/test'
import type { SubtitleGenerationJob, SubtitleGenerationOptions } from '../src/shared/types'

interface SubtitleHarness {
  available: boolean
  jobs: Record<string, SubtitleGenerationJob | null>
  options?: SubtitleGenerationOptions
  failStart: boolean
  failCancel: boolean
  delayedStart: boolean
  releaseStart?: () => void
  statusCalls: number
  videoSearchCalls: number
}
type SubtitleWindow = Window & { subtitleHarness: SubtitleHarness }

function videoCard(page: Page, title = 'Sample video') {
  return page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
}

async function prepareControlledJobs(page: Page, available = true) {
  await page.goto('/')
  await page.evaluate((engineAvailable) => {
    const state: SubtitleHarness = {
      available: engineAvailable,
      jobs: {},
      failStart: false,
      failCancel: false,
      delayedStart: false,
      statusCalls: 0,
      videoSearchCalls: 0,
    }
    ;(window as unknown as SubtitleWindow).subtitleHarness = state
    const searchVideos = window.api.videos.search
    window.api.videos.search = async (libraryId, query) => {
      state.videoSearchCalls += 1
      return searchVideos(libraryId, query)
    }
    window.api.subtitles.getEngineInfo = async () => ({
      ok: true,
      value: { available: state.available, message: '테스트용 음성 인식 환경을 설치해 주세요.' },
    })
    window.api.subtitles.generate = async (libraryId, videoId, options) => {
      if (state.failStart) throw new Error('자막 시작 IPC 실패')
      state.options = options
      const job: SubtitleGenerationJob = {
        id: crypto.randomUUID(),
        title: videoId,
        options,
        createdAt: new Date().toISOString(),
        libraryId,
        videoId,
        phase: 'transcribing',
        percent: 35,
        message: `${videoId} 음성 인식 진행 중`,
      }
      if (state.delayedStart) {
        return new Promise((resolve) => {
          state.releaseStart = () => {
            state.jobs[videoId] = job
            resolve({ ok: true, value: job })
          }
        })
      }
      state.jobs[videoId] = job
      return { ok: true, value: { ...job } }
    }
    window.api.subtitles.getGenerationStatus = async (_libraryId, videoId) => {
      state.statusCalls += 1
      return { ok: true, value: state.jobs[videoId] ? { ...state.jobs[videoId] } : null }
    }
    window.api.subtitles.cancelGeneration = async (_libraryId, videoId) => {
      if (state.failCancel) return { ok: false, error: '취소 IPC 실패' }
      const job = state.jobs[videoId]
      if (job)
        state.jobs[videoId] = { ...job, phase: 'cancelled', message: '요청한 작업을 취소했습니다.' }
      return { ok: true, value: Boolean(job) }
    }
  }, available)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await videoCard(page).click()
  return page.getByRole('region', { name: 'AI 자막 생성', exact: true })
}

test('explains model selection at the selector and keeps recognition separate from translation', async ({
  page,
}) => {
  const panel = await prepareControlledJobs(page)
  await expect(panel.getByLabel('선택한 모델 안내')).toContainText('base')
  await panel.getByText('내 PC·영상에 맞는 모델 선택', { exact: true }).click()
  await expect(panel).toContainText('한국어 번역은 별도의 Ollama qwen3:8b')
  await expect(panel.getByRole('table')).toContainText('large-v2')
  await expect(panel.getByRole('table')).toContainText('large-v3')
  await expect(panel.getByRole('table').getByRole('row')).toHaveCount(7)
  await expect(panel).toContainText('GPU 메모리가 부족하거나')
  await expect(panel).toContainText('CPU로 자동 전환하지 않습니다.')
  await panel.getByLabel('음성 인식 모델', { exact: true }).selectOption('tiny')
  await expect(panel.getByLabel('선택한 모델 안내')).toContainText('자원 부담이 가장 작은')
  await panel.getByLabel('음성 인식 모델', { exact: true }).selectOption('large-v3')
  await expect(panel.getByLabel('선택한 모델 안내')).toContainText('항상 더 정확한 것은 아닙니다.')
  await panel.getByLabel('영상 언어', { exact: true }).selectOption('ja')
  await panel.getByRole('checkbox', { name: '한국어 번역 자막도 생성' }).uncheck()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as SubtitleWindow).subtitleHarness.options))
    .toEqual({ model: 'large-v3', language: 'ja', translateToKorean: false })
})

test('generates original and Korean subtitles asynchronously and refreshes the video badge', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.evaluate(async () => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (result.ok && result.value) result.value.hasSubtitles = false
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await videoCard(page).click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await expect(panel.getByLabel('음성 인식 모델')).toHaveValue('base')
  await expect(panel.getByLabel('영상 언어')).toHaveValue('auto')
  await expect(panel.getByLabel('한국어 번역 자막도 생성')).toBeChecked()
  await expect(videoCard(page).getByText('자막 없음', { exact: true }).first()).toBeVisible()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('button', { name: '자막 생성 취소', exact: true })).toBeVisible()
  await expect(panel.getByRole('status')).toContainText('자막 생성 완료')
  await expect(panel.getByRole('list', { name: '생성된 자막 파일' })).toContainText('sample.ai.srt')
  await expect(panel.getByRole('list', { name: '생성된 자막 파일' })).toContainText(
    'sample.ai.ko.srt',
  )
  await expect(videoCard(page).getByText('자막 있음', { exact: true }).first()).toBeVisible()
  const subtitles = await page.evaluate(() =>
    window.api.subtitles.getForVideo('mock-library', 'mock-video-1'),
  )
  expect(subtitles.ok && subtitles.value.map((subtitle) => subtitle.lang)).toEqual(['ko', 'en'])
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('list', { name: '생성된 자막 파일' })).toContainText(
    'sample.ai.2.ko.srt',
  )
  await page.evaluate(() => {
    // Repository order must not decide which generation/language the player selects.
    const getSubtitles = window.api.subtitles.getForVideo
    window.api.subtitles.getForVideo = async (libraryId, videoId) => {
      const result = await getSubtitles(libraryId, videoId)
      return result.ok ? { ok: true, value: [...result.value].reverse() } : result
    }
  })
  await videoCard(page).dblclick()
  const subtitleSelection = page.getByRole('combobox', { name: '자막 선택', exact: true })
  await expect(subtitleSelection).toHaveValue('mock-subtitle-2-1')
  await subtitleSelection.selectOption('mock-subtitle-2-0')
  await expect(subtitleSelection).toHaveValue('mock-subtitle-2-0')
  expect(errors).toEqual([])
})

test('checks missing dependencies again and reports a rejected start without an unhandled promise', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const panel = await prepareControlledJobs(page, false)
  await expect(
    panel.getByRole('link', { name: '자막 환경 자동 설치 열기', exact: true }),
  ).toBeVisible()
  await expect(panel.locator('code')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '자막 생성 시작', exact: true })).toBeDisabled()
  await page.evaluate(() => {
    const state = (window as unknown as SubtitleWindow).subtitleHarness
    state.available = true
    state.failStart = true
  })
  await panel.getByRole('button', { name: '환경 다시 확인', exact: true }).click()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('자막 시작 IPC 실패')
  await page.evaluate(() => {
    ;(window as unknown as SubtitleWindow).subtitleHarness.failStart = false
  })
  await panel.getByLabel('음성 인식 모델').selectOption('small')
  await panel.getByLabel('영상 언어').selectOption('ja')
  await panel.getByLabel('한국어 번역 자막도 생성').uncheck()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '35')
  expect(
    await page.evaluate(() => (window as unknown as SubtitleWindow).subtitleHarness.options),
  ).toEqual({
    model: 'small',
    language: 'ja',
    translateToKorean: false,
  })
  expect(errors).toEqual([])
})

test('cancels an active job, reports cancellation errors, and displays a later translation failure', async ({
  page,
}) => {
  const panel = await prepareControlledJobs(page)
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as SubtitleWindow).subtitleHarness.failCancel = true
  })
  await panel.getByRole('button', { name: '자막 생성 취소', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('취소 IPC 실패')
  await page.evaluate(() => {
    ;(window as unknown as SubtitleWindow).subtitleHarness.failCancel = false
  })
  await panel.getByRole('button', { name: '자막 생성 취소', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('자막 생성 취소됨')
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('progressbar')).toBeVisible()
  const searchesBeforeFailure = await page.evaluate(
    () => (window as unknown as SubtitleWindow).subtitleHarness.videoSearchCalls,
  )
  await page.evaluate(() => {
    const state = (window as unknown as SubtitleWindow).subtitleHarness
    state.jobs['mock-video-1'] = {
      ...state.jobs['mock-video-1']!,
      phase: 'failed',
      message: '한국어 번역 연결 실패. 저장한 원어 자막은 보존되었습니다.',
      outputPaths: ['/mock/videos/sample.ai.srt'],
    }
  })
  await expect(panel.getByRole('alert')).toContainText('한국어 번역 연결 실패')
  await expect(panel.getByRole('list')).toContainText('sample.ai.srt')
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as SubtitleWindow).subtitleHarness.videoSearchCalls),
    )
    .toBeGreaterThan(searchesBeforeFailure)
  await expect(panel.getByRole('button', { name: '자막 생성 시작', exact: true })).toBeEnabled()
})

test('resumes polling after the details panel remounts', async ({ page }) => {
  const panel = await prepareControlledJobs(page)
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByRole('progressbar')).toBeVisible()
  await page.getByRole('button', { name: '하이라이트', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await page.evaluate(() => {
    const state = (window as unknown as SubtitleWindow).subtitleHarness
    state.jobs['mock-video-1'] = {
      ...state.jobs['mock-video-1']!,
      phase: 'translating',
      percent: 80,
    }
  })
  await page.getByRole('button', { name: '정보', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('한국어 번역 중 · 80%')
  await page.evaluate(() => {
    const state = (window as unknown as SubtitleWindow).subtitleHarness
    state.jobs['mock-video-1'] = {
      ...state.jobs['mock-video-1']!,
      phase: 'completed',
      percent: 100,
      message: '복귀 후 생성 완료',
      outputPaths: ['/mock/videos/sample.ai.ko.srt'],
    }
  })
  await expect(panel.getByRole('status')).toContainText('복귀 후 생성 완료')
  const calls = await page.evaluate(
    () => (window as unknown as SubtitleWindow).subtitleHarness.statusCalls,
  )
  // A terminal job must stop the interval instead of invalidating the library each second.
  await page.waitForTimeout(1200)
  expect(
    await page.evaluate(() => (window as unknown as SubtitleWindow).subtitleHarness.statusCalls),
  ).toBe(calls)
})

test('a delayed start response stays attached to its original video after selection changes', async ({
  page,
}) => {
  const panel = await prepareControlledJobs(page)
  await page.evaluate(async () => {
    const state = (window as unknown as SubtitleWindow).subtitleHarness
    state.delayedStart = true
    const response = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!response.ok || !response.value) throw new Error('Missing video fixture')
    const second = {
      ...response.value,
      id: 'mock-video-2',
      title: 'Second video',
      fileName: 'second.mp4',
    }
    const originalGet = window.api.videos.get
    window.api.videos.get = async (libraryId, videoId) =>
      videoId === second.id ? { ok: true, value: second } : originalGet(libraryId, videoId)
    const originalSearch = window.api.videos.search
    window.api.videos.search = async (libraryId, query) => {
      const result = await originalSearch(libraryId, query)
      if (!result.ok) return result
      return {
        ok: true,
        value: { ...result.value, videos: [...result.value.videos, second], total: 2 },
      }
    }
  })
  // Updating the sort runs a fresh library query and exposes the second video fixture.
  await page
    .locator('select')
    .filter({ has: page.locator('option[value="rating"]') })
    .selectOption('rating')
  await expect(videoCard(page, 'Second video')).toBeVisible()
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '자막 생성 시작 중...', exact: true }),
  ).toBeDisabled()
  await videoCard(page, 'Second video').click()
  await expect(panel.getByRole('button', { name: '자막 생성 시작', exact: true })).toBeEnabled()
  await page.evaluate(() => (window as unknown as SubtitleWindow).subtitleHarness.releaseStart?.())
  await expect(panel.getByRole('progressbar')).toHaveCount(0)
  await expect(panel.getByRole('status')).toHaveCount(0)
  await videoCard(page).click()
  await expect(panel.getByRole('status')).toContainText('mock-video-1 음성 인식 진행 중')
})

test('removed videos cannot start subtitle generation', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => window.api.videos.delete('mock-library', 'mock-video-1', 'remove'))
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await videoCard(page).click()
  const panel = page.getByRole('region', { name: 'AI 자막 생성', exact: true })
  await expect(panel.getByRole('button', { name: '자막 생성 시작', exact: true })).toBeDisabled()
  await expect(
    panel.getByText('제거한 항목은 목록 복구 후 자막을 생성할 수 있습니다.', { exact: true }),
  ).toBeVisible()
})

test('shows unconfirmed device until engine evidence arrives and labels checkpoint evidence as a previous record', async ({
  page,
}) => {
  const panel = await prepareControlledJobs(page)
  await panel.getByRole('button', { name: '자막 생성 시작', exact: true }).click()
  await expect(panel.getByLabel('자막 처리 장치')).toContainText('실제 처리 장치 확인 전')
  await expect(panel.getByLabel('자막 처리 장치')).not.toContainText('Vulkan GPU')
  await page.evaluate(() => {
    const job = (window as unknown as SubtitleWindow).subtitleHarness.jobs['mock-video-1']!
    job.processing = { asr: 'vulkan', device: 'Vulkan0', evidence: 'checkpoint' }
  })
  await expect(panel.getByLabel('자막 처리 장치')).toContainText(
    'Vulkan GPU · Vulkan0 (이전 인식 기록)',
  )
  await expect(panel.getByLabel('자막 처리 장치')).toContainText(
    '음성 추출·음성 구간 감지는 CPU를 사용할 수 있습니다.',
  )
})

test('renders escaped subtitle text and numeric entities as plain text', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    window.api.subtitles.getForVideo = async (_libraryId, videoId) => ({
      ok: true,
      value: [
        {
          id: 'escaped-subtitle',
          videoId,
          filePath: '/mock/videos/sample.ai.ko.srt',
          lang: 'ko',
          type: 'srt',
          encoding: 'utf-8',
          isEmbedded: false,
        },
      ],
    })
    window.api.subtitles.readText = async () => ({
      ok: true,
      value: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA &amp; B &lt;tag&gt; &#x1F600; &#128512;\n',
    })
    window.addEventListener(
      'error',
      (event) => {
        if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation()
      },
      true,
    )
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await videoCard(page).dblclick()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByRole('button', { name: '자막 끄기', exact: true })).toBeEnabled()
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 2 })
    video.dispatchEvent(new Event('timeupdate'))
  })
  await expect(page.getByText('A & B <tag> 😀 😀', { exact: true })).toBeVisible()
  await expect(page.locator('tag')).toHaveCount(0)
})
