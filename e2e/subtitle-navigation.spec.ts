import { expect, test, type Page } from '@playwright/test'
import type { Subtitle } from '../src/shared/types'

interface SubtitleNavigationHarness {
  actual: number
  ready: boolean
  paused: boolean
  writes: number[]
  nativeSeeks: number[]
  failNativeSeek: boolean
  releaseSource: () => void
  setReady: () => void
}

type NavigationWindow = Window & { subtitleNavigationHarness: SubtitleNavigationHarness }
type FixtureMode = 'normal' | 'empty' | 'read-error' | 'long'

async function openSubtitleNavigator(page: Page, mode: FixtureMode = 'normal') {
  await page.goto('/')
  await page.evaluate(async (fixtureMode) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    Object.assign(result.value, {
      resumePosSec: 0,
      durationSec: 600,
      filePath: '/mock/subtitle-navigation.mp4',
      hasSubtitles: fixtureMode !== 'empty',
    })
    const tracks: Subtitle[] = [
      {
        id: 'navigation-ko',
        videoId: 'mock-video-1',
        filePath: '/mock/subtitle-navigation.ko.vtt',
        lang: 'ko',
        type: 'vtt',
        isEmbedded: false,
      },
      {
        id: 'navigation-en',
        videoId: 'mock-video-1',
        filePath: '/mock/subtitle-navigation.en.vtt',
        lang: 'en',
        type: 'vtt',
        isEmbedded: false,
      },
    ]
    const state: SubtitleNavigationHarness = {
      actual: 0,
      ready: false,
      paused: true,
      writes: [],
      nativeSeeks: [],
      failNativeSeek: false,
      releaseSource: () => undefined,
      setReady: () => undefined,
    }
    ;(window as unknown as NavigationWindow).subtitleNavigationHarness = state
    window.api.subtitles.getForVideo = async () => ({
      ok: true,
      value: fixtureMode === 'empty' ? [] : tracks,
    })
    window.api.subtitles.readText = async (_libraryId, filePath) => {
      if (fixtureMode === 'read-error') return { ok: false, error: '탐색용 자막 읽기 실패' }
      if (fixtureMode === 'long') {
        const timestamp = (seconds: number) =>
          `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.250`
        return {
          ok: true,
          value: `WEBVTT\n\n${Array.from({ length: 240 }, (_, index) =>
            `${timestamp(index * 2)} --> ${timestamp(index * 2 + 1)}\n긴 자막 ${index + 1}`,
          ).join('\n\n')}`,
        }
      }
      return {
        ok: true,
        value: filePath.endsWith('.ko.vtt')
          ? 'WEBVTT\n\n00:00:01.250 --> 00:00:04.000\n첫 번째 인사\n\n00:00:12.375 --> 00:00:15.000\n찾아갈 장면\n두 번째 줄\n\n00:00:30.500 --> 00:00:35.000\n마지막 설명\n'
          : 'WEBVTT\n\n00:00:02.125 --> 00:00:05.000\nFirst greeting\n\n00:00:21.625 --> 00:00:25.000\nEnglish destination\n',
      }
    }
    window.api.videos.getPlaybackSource = () => new Promise((resolve) => {
      state.releaseSource = () => resolve({ ok: true, value: '/mock/subtitle-navigation.mp4' })
    })
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: { name: 'mpv', path: 'C:\\mock\\mpv.exe' },
    })
    window.api.videos.openInNativePlayer = async () => ({
      ok: true,
      value: { name: 'mpv', path: 'C:\\mock\\mpv.exe' },
    })
    window.api.videos.seekActivePlayback = async (_libraryId, _videoId, timeSec) => {
      state.nativeSeeks.push(timeSec)
      return state.failNativeSeek
        ? { ok: false, error: '외부 플레이어 자막 이동 실패' }
        : { ok: true, value: true }
    }
    // Browser tests cannot decode Electron's local-media protocol. Control media events below.
    window.addEventListener('error', (event) => {
      if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation()
    }, true)
  }, mode)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page.getByRole('button').filter({
    has: page.getByText('Sample video', { exact: true }),
  }).dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    const state = (window as unknown as NavigationWindow).subtitleNavigationHarness
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => state.actual,
        set: (value: number) => {
          if (!state.ready) throw new Error('Seek was sent before metadata')
          state.actual = value
          state.writes.push(value)
          queueMicrotask(() => {
            video.dispatchEvent(new Event('timeupdate'))
            video.dispatchEvent(new Event('seeked'))
          })
        },
      },
      duration: { configurable: true, get: () => state.ready ? 600 : NaN },
      readyState: { configurable: true, get: () => state.ready ? 4 : 0 },
      seeking: { configurable: true, get: () => false },
      paused: { configurable: true, get: () => state.paused },
      play: {
        configurable: true,
        value: async () => {
          state.paused = false
          video.dispatchEvent(new Event('play'))
        },
      },
      pause: {
        configurable: true,
        value: () => {
          state.paused = true
          video.dispatchEvent(new Event('pause'))
        },
      },
      load: { configurable: true, value: () => undefined },
    })
    state.setReady = () => {
      state.ready = true
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('durationchange'))
    }
    state.releaseSource()
  })
  await expect(page.locator('video')).toHaveAttribute('src', /subtitle-navigation/)
  await page.evaluate(() => (window as unknown as NavigationWindow).subtitleNavigationHarness.setReady())
  await page.getByRole('tab', { name: '자막 탐색', exact: true }).click()
  const navigator = page.getByRole('region', { name: '자막 탐색', exact: true })
  if (mode !== 'empty') {
    // Track ordering is separate from navigation; make the fixture language explicit.
    await navigator.getByRole('combobox', { name: '탐색할 자막', exact: true }).selectOption('navigation-ko')
  }
  return navigator
}

async function expectPlaybackPosition(page: Page, seconds: number) {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as NavigationWindow).subtitleNavigationHarness.actual,
  )).toBe(seconds)
}

test('clicking a subtitle seeks its fractional timestamp, marks it current, and supports searching', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const navigator = await openSubtitleNavigator(page)
  const list = navigator.getByRole('list', { name: '자막 목록' })
  const destination = list.getByRole('button', { name: /찾아갈 장면/ })
  await expect(destination).toContainText('0:12.375')
  await destination.click()
  await expectPlaybackPosition(page, 12.375)
  await expect(destination).toHaveAttribute('aria-current', 'true')
  await expect(list.getByRole('button', { name: /첫 번째 인사/ })).not.toHaveAttribute('aria-current', 'true')
  const search = navigator.getByRole('searchbox', { name: '자막 검색' })
  await search.fill('마지막')
  await expect(list.getByRole('button')).toHaveCount(1)
  await list.getByRole('button', { name: /마지막 설명/ }).click()
  await expectPlaybackPosition(page, 30.5)
  await search.fill('일치하지 않는 문장')
  await expect(list.getByRole('button')).toHaveCount(0)
  await search.fill('')
  await expect(list.getByRole('button')).toHaveCount(3)
  await page.screenshot({ path: 'test-results/subtitle-navigation.png' })
  await page.setViewportSize({ width: 900, height: 600 })
  await expect(navigator.getByRole('searchbox', { name: '자막 검색' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('slider', { name: '재생 위치', exact: true })).toBeInViewport({ ratio: 1 })
  const bounds = await page.locator('video').evaluate((video: HTMLVideoElement) => {
    const media = video.getBoundingClientRect()
    const sidebar = document.querySelector('aside')!.getBoundingClientRect()
    return { mediaRight: media.right, mediaBottom: media.bottom, sidebarLeft: sidebar.left, sidebarRight: sidebar.right, width: innerWidth, height: innerHeight }
  })
  expect(bounds.mediaRight).toBeLessThanOrEqual(bounds.sidebarLeft + 1)
  expect(bounds.mediaBottom).toBeLessThanOrEqual(bounds.height + 1)
  expect(bounds.sidebarRight).toBeLessThanOrEqual(bounds.width + 1)
})

test('subtitle track selections stay synchronized and browsing works with the overlay disabled', async ({ page }) => {
  const navigator = await openSubtitleNavigator(page)
  const browseSelection = navigator.getByRole('combobox', { name: '탐색할 자막', exact: true })
  const playbackSelection = page.getByRole('combobox', { name: '자막 선택', exact: true })
  await browseSelection.selectOption('navigation-en')
  await expect(playbackSelection).toHaveValue('navigation-en')
  await navigator.getByRole('button', { name: /English destination/ }).click()
  await expectPlaybackPosition(page, 21.625)
  await playbackSelection.selectOption('navigation-ko')
  await expect(browseSelection).toHaveValue('navigation-ko')
  await page.getByRole('button', { name: '자막 끄기', exact: true }).click()
  await navigator.getByRole('button', { name: /첫 번째 인사/ }).click()
  await expectPlaybackPosition(page, 1.25)
  await expect(page.getByRole('button', { name: '자막 켜기', exact: true })).toBeVisible()
  await expect(navigator.getByRole('button', { name: /첫 번째 인사/ })).toHaveAttribute('aria-current', 'true')
})

test('videos without subtitles show an empty navigator', async ({ page }) => {
  const navigator = await openSubtitleNavigator(page, 'empty')
  await expect(navigator).toContainText(/자막.*없/)
  await expect(navigator.getByRole('list', { name: '자막 목록' }).getByRole('button')).toHaveCount(0)
  await expect(navigator.getByRole('alert')).toHaveCount(0)
})

test('subtitle reading failures are shown in the navigator', async ({ page }) => {
  const navigator = await openSubtitleNavigator(page, 'read-error')
  await expect(navigator.getByRole('alert')).toContainText('탐색용 자막 읽기 실패')
  await expect(navigator.getByRole('list', { name: '자막 목록' }).getByRole('button')).toHaveCount(0)
})

test('clicking subtitles seeks the active native player and reports a failed move', async ({ page }) => {
  const navigator = await openSubtitleNavigator(page)
  await page.getByRole('button', { name: 'mpv로 열기', exact: true }).click()
  await expect(page.getByText('mpv로 전환했습니다', { exact: true })).toBeVisible()
  await expect(navigator.getByRole('button', { name: '현재 자막', exact: true })).toBeDisabled()
  await navigator.getByRole('button', { name: /찾아갈 장면/ }).click()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as NavigationWindow).subtitleNavigationHarness.nativeSeeks,
  )).toEqual([12.375])
  await page.evaluate(() => {
    ;(window as unknown as NavigationWindow).subtitleNavigationHarness.failNativeSeek = true
  })
  await navigator.getByRole('button', { name: /첫 번째 인사/ }).click()
  await expect(page.getByRole('alert')).toContainText('외부 플레이어 자막 이동 실패')
})

test('long subtitles keep the list bounded and let users find a distant cue', async ({ page }) => {
  const navigator = await openSubtitleNavigator(page, 'long')
  const list = navigator.getByRole('list', { name: '자막 목록' })
  await expect(list.getByRole('button').first()).toBeVisible()
  expect(await list.getByRole('button').count()).toBeLessThan(100)
  await navigator.getByRole('searchbox', { name: '자막 검색' }).fill('긴 자막 240')
  await list.getByRole('button', { name: /긴 자막 240/ }).click()
  await expectPlaybackPosition(page, 478.25)
  await expect(list.getByRole('button', { name: /긴 자막 240/ })).toHaveAttribute('aria-current', 'true')
  await navigator.getByRole('button', { name: '검색 지우기', exact: true }).click()
  await expect(list.getByRole('button', { name: /긴 자막 1$/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /긴 자막 240/ })).toHaveCount(0)
  await navigator.getByRole('button', { name: '현재 자막', exact: true }).click()
  await expect(list.getByRole('button', { name: /긴 자막 240/ })).toBeInViewport()
  expect(await list.getByRole('button').count()).toBeLessThan(100)
})
