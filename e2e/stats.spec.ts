import { expect, test, type Page } from '@playwright/test'
import type { LibraryStats } from '../src/shared/types'

interface StatsHarness {
  byPeriod: Record<number, LibraryStats>
  calls: Array<{ libraryId: string; days: number }>
  videoRequests: string[]
  error: string | null
}

type StatsWindow = Window & { statsHarness: StatsHarness }

function fixture(days = 30): LibraryStats {
  const short = days === 7
  const watchedSec = short ? 7_200 : 21_600
  const sessions = short ? 6 : 20
  const activeDays = short ? 2 : 5
  const end = new Date('2026-10-10T12:00:00Z')
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date(end)
    date.setUTCDate(end.getUTCDate() - days + index + 1)
    return date.toISOString().slice(0, 10)
  })
  const dailyStats = dates.map((date, index) => ({
    date,
    watchedSec: index >= days - activeDays ? watchedSec / activeDays : 0,
    videoCount: index >= days - activeDays ? 2 : 0,
    sessionCount: index >= days - activeDays ? sessions / activeDays : 0,
  }))
  return {
    totalVideos: 12,
    totalWatchedSec: 180_000,
    avgRating: 25 / 6,
    library: {
      totalDurationSec: 57_600,
      totalSizeBytes: 48 * 1024 ** 3,
      durationUnknownVideos: 1,
      sizeUnknownVideos: 1,
      watchedVideos: 8,
      unwatchedVideos: 4,
      ratedVideos: 6,
      subtitleVideos: 9,
      koreanSubtitleVideos: 8,
      generatedSubtitleVideos: 7,
      highlightedVideos: 3,
      highlightCount: 12,
      taggedVideos: 9,
    },
    period: {
      days,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      watchedSec,
      previousWatchedSec: short ? 0 : 10_800,
      sessionCount: sessions,
      previousSessionCount: 0,
      uniqueVideos: short ? 2 : 4,
      activeDays,
      averageSessionSec: watchedSec / sessions,
      longestStreak: activeDays,
      addedVideos: short ? 1 : 3,
    },
    dailyStats,
    weekdayStats: Array.from({ length: 7 }, (_, weekday) => {
      const matching = dailyStats.filter(
        (day) => new Date(`${day.date}T12:00:00Z`).getUTCDay() === weekday,
      )
      return {
        weekday,
        watchedSec: matching.reduce((sum, day) => sum + day.watchedSec, 0),
        sessionCount: matching.reduce((sum, day) => sum + day.sessionCount, 0),
      }
    }),
    hourlyStats: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      watchedSec: hour === 20 || hour === 21 ? watchedSec / 2 : 0,
      sessionCount: hour === 20 || hour === 21 ? sessions / 2 : 0,
    })),
    topVideos: short
      ? [
          {
            id: 'mock-video-2',
            fileName: 'mountain.mp4',
            title: '산길 여행',
            watchedSec,
            sessionCount: sessions,
          },
        ]
      : [
          {
            id: 'mock-video-1',
            fileName: 'coast.mp4',
            title: '저녁 바닷가 산책',
            watchedSec: 12_600,
            sessionCount: 12,
          },
          {
            id: 'mock-video-2',
            fileName: 'mountain.mp4',
            title: '산길 여행',
            watchedSec: 9_000,
            sessionCount: 8,
          },
        ],
    distributions: {
      ratings: [
        { key: 'unrated', label: '미평가', count: 6 },
        { key: '3', label: '3점', count: 1 },
        { key: '4', label: '4점', count: 3 },
        { key: '5', label: '5점', count: 2 },
      ],
      resolutions: [
        { key: '4k', label: '4K 이상', count: 2 },
        { key: '1080p', label: 'FHD', count: 5 },
        { key: '720p', label: 'HD', count: 3 },
        { key: 'sd', label: 'SD', count: 1 },
        { key: 'unknown', label: '알 수 없음', count: 1 },
      ],
      formats: [
        { key: 'mp4', label: 'MP4', count: 7 },
        { key: 'mkv', label: 'MKV', count: 3 },
        { key: 'avi', label: 'AVI', count: 2 },
      ],
      durations: [
        { key: 'short', label: '10분 미만', count: 2 },
        { key: 'medium', label: '10~30분', count: 3 },
        { key: 'long', label: '30~60분', count: 2 },
        { key: 'feature', label: '60분 이상', count: 4 },
        { key: 'unknown', label: '알 수 없음', count: 1 },
      ],
      tags: [
        { key: '여행', label: '여행', count: 7 },
        { key: '자연', label: '자연', count: 5 },
        { key: '풍경', label: '풍경', count: 3 },
      ],
    },
  }
}

function withoutHistory(emptyLibrary = false): LibraryStats {
  const stats = fixture()
  stats.totalWatchedSec = 0
  stats.library.watchedVideos = 0
  stats.library.unwatchedVideos = stats.totalVideos
  stats.period = {
    ...stats.period,
    watchedSec: 0,
    previousWatchedSec: 0,
    sessionCount: 0,
    previousSessionCount: 0,
    uniqueVideos: 0,
    activeDays: 0,
    averageSessionSec: 0,
    longestStreak: 0,
    addedVideos: 0,
  }
  stats.dailyStats = stats.dailyStats.map((day) => ({
    ...day,
    watchedSec: 0,
    sessionCount: 0,
    videoCount: 0,
  }))
  stats.weekdayStats = stats.weekdayStats.map((day) => ({ ...day, watchedSec: 0, sessionCount: 0 }))
  stats.hourlyStats = stats.hourlyStats.map((hour) => ({ ...hour, watchedSec: 0, sessionCount: 0 }))
  stats.topVideos = []
  if (emptyLibrary) {
    stats.totalVideos = 0
    stats.avgRating = 0
    stats.library = Object.fromEntries(
      Object.keys(stats.library).map((key) => [key, 0]),
    ) as LibraryStats['library']
    stats.distributions = { ratings: [], resolutions: [], formats: [], durations: [], tags: [] }
  }
  return stats
}

async function prepare(page: Page, stats = fixture(), error: string | null = null) {
  await page.goto('/')
  await page.evaluate(
    ({ byPeriod, initialError }) => {
      const state: StatsHarness = { byPeriod, calls: [], videoRequests: [], error: initialError }
      ;(window as unknown as StatsWindow).statsHarness = state
      window.api.stats.get = async (libraryId, days = 30) => {
        state.calls.push({ libraryId, days })
        return state.error
          ? { ok: false, error: state.error }
          : { ok: true, value: structuredClone(state.byPeriod[days]) }
      }
      const getVideo = window.api.videos.get
      window.api.videos.get = async (libraryId, videoId) => {
        state.videoRequests.push(videoId)
        const result = await getVideo(libraryId, 'mock-video-1')
        if (!result.ok || !result.value) return result
        const top = Object.values(state.byPeriod)
          .flatMap((item) => item.topVideos)
          .find((item) => item.id === videoId)
        return {
          ok: true,
          value: { ...result.value, id: videoId, title: top?.title ?? result.value.title },
        }
      }
    },
    {
      byPeriod: { 7: fixture(7), 30: stats, 90: fixture(90), 365: fixture(365) },
      initialError: error,
    },
  )
}

async function openStats(page: Page) {
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page.getByRole('link', { name: '통계', exact: true }).click()
}

async function assertNoOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const width = window.innerWidth
        const overflowing = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid^="stats-"]'),
        )
          .filter((element) => {
            const bounds = element.getBoundingClientRect()
            return (
              bounds.left < -1 ||
              bounds.right > width + 1 ||
              element.scrollWidth > element.clientWidth + 1
            )
          })
          .map((element) => element.dataset.testid)
        return { document: document.documentElement.scrollWidth > width, overflowing }
      }),
    )
    .toEqual({ document: false, overflowing: [] })
}

test('period metrics, all-library inventory and charts retain their scope across period changes and refresh', async ({
  page,
}) => {
  await prepare(page)
  await openStats(page)
  const period = page.getByTestId('stats-period-summary')
  const library = page.getByTestId('stats-library-summary')
  const topVideos = page.getByTestId('stats-top-videos')
  await expect(period).toContainText('6시간')
  await expect(library).toContainText('12개')
  await expect(library).toContainText('50시간')
  await expect(
    topVideos.getByRole('button', { name: '저녁 바닷가 산책 재생', exact: true }),
  ).toBeVisible()
  for (const chart of ['daily', 'weekday', 'hourly']) {
    await expect(page.getByTestId(`stats-${chart}-chart`).locator('svg').first()).toBeVisible()
  }
  for (const distribution of ['resolutions', 'durations', 'formats', 'ratings', 'tags']) {
    await expect(page.getByTestId(`stats-distribution-${distribution}`)).toBeVisible()
  }
  await expect(page.getByTestId('stats-distribution-resolutions')).toContainText('알 수 없음')
  await expect(page.getByTestId('stats-library-coverage')).toContainText('한국어')
  await expect(page.getByRole('meter', { name: '자막이 있는 영상', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '9',
  )
  await expect(page.getByRole('meter', { name: '자막이 있는 영상', exact: true })).toHaveAttribute(
    'aria-valuemax',
    '12',
  )
  await expect(page.getByTestId('stats-library-coverage')).toContainText(
    '한 영상에 함께 있을 수 있습니다.',
  )
  const dailyMetric = page.getByRole('group', { name: '일별 차트 항목', exact: true })
  await dailyMetric.getByRole('button', { name: '재생 횟수', exact: true }).click()
  await expect(dailyMetric.getByRole('button', { name: '재생 횟수', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page
    .getByTestId('stats-daily-chart')
    .screenshot({ path: 'test-results/stats-dashboard-chart-sessions.png' })
  await expect(page.getByTestId('stats-daily-chart').locator('svg')).toContainText('회')

  await page.getByRole('button', { name: '7일', exact: true }).click()
  await expect(page.getByRole('button', { name: '7일', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(period).toContainText('2시간')
  await expect(library).toContainText('12개')
  await expect(library).toContainText('50시간')
  await expect(
    topVideos.getByRole('button', { name: '저녁 바닷가 산책 재생', exact: true }),
  ).toHaveCount(0)
  await expect(topVideos.getByRole('button', { name: '산길 여행 재생', exact: true })).toBeVisible()
  await expect(page.getByTestId('stats-page')).not.toContainText(/NaN|Infinity/)
  expect(await page.evaluate(() => (window as unknown as StatsWindow).statsHarness.calls)).toEqual([
    { libraryId: 'mock-library', days: 30 },
    { libraryId: 'mock-library', days: 7 },
  ])

  await page.evaluate(() => {
    const state = (window as unknown as StatsWindow).statsHarness
    state.byPeriod[7].totalVideos = 15
  })
  await page.getByRole('button', { name: '통계 새로고침', exact: true }).click()
  await expect(library).toContainText('15개')
  expect(
    await page.evaluate(() => (window as unknown as StatsWindow).statsHarness.calls.at(-1)),
  ).toEqual({ libraryId: 'mock-library', days: 7 })
})

test('failures show an actionable error instead of empty or zero metrics and retry recovers', async ({
  page,
}) => {
  await prepare(page, fixture(), '테스트 통계 데이터베이스 연결 실패')
  await openStats(page)
  await expect(page.getByRole('alert')).toContainText('테스트 통계 데이터베이스 연결 실패')
  await expect(page.getByTestId('stats-period-summary')).toHaveCount(0)
  await expect(page.getByText('아직 등록된 영상이 없습니다.', { exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as unknown as StatsWindow).statsHarness.error = null
  })
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.getByTestId('stats-period-summary')).toContainText('6시간')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.evaluate(() => {
    ;(window as unknown as StatsWindow).statsHarness.error = '통계 새로고침 연결 실패'
  })
  await page.getByRole('button', { name: '통계 새로고침', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('통계 새로고침 연결 실패')
  await expect(page.getByText('아직 등록된 영상이 없습니다.', { exact: true })).toHaveCount(0)
})

test('no selected library, empty inventory and inventory without watch history are distinct states', async ({
  page,
}) => {
  await prepare(page, withoutHistory(true))
  await page.getByRole('link', { name: '통계', exact: true }).click()
  await expect(page.getByText('라이브러리를 먼저 선택해주세요.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as StatsWindow).statsHarness.calls)).toEqual(
    [],
  )
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await openStats(page)
  await expect(page.getByText('아직 등록된 영상이 없습니다.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('stats-page')).not.toContainText(/NaN|Infinity/)
  await page.evaluate((stats) => {
    ;(window as unknown as StatsWindow).statsHarness.byPeriod[30] = stats
  }, withoutHistory())
  await page.getByRole('button', { name: '통계 새로고침', exact: true }).click()
  await expect(page.getByTestId('stats-library-summary')).toContainText('12개')
  await expect(page.getByText('이 기간에는 시청 기록이 없습니다.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('stats-top-videos').getByRole('button')).toHaveCount(0)
  await expect(page.getByText('아직 등록된 영상이 없습니다.', { exact: true })).toHaveCount(0)
})

test('top videos can be opened with the keyboard', async ({ page }) => {
  await prepare(page)
  await openStats(page)
  const topVideo = page.getByRole('button', { name: '저녁 바닷가 산책 재생', exact: true })
  await topVideo.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('video')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StatsWindow).statsHarness.videoRequests))
    .toContain('mock-video-1')
})

test('dashboard remains readable at wide, 900 px and 640 px widths', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1800 })
  await prepare(page)
  await openStats(page)
  await expect(page.getByTestId('stats-distribution-tags')).toBeVisible()
  await assertNoOverflow(page)
  await page.screenshot({ path: 'test-results/stats-dashboard-wide.png' })
  await page.getByTestId('stats-top-videos').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/stats-dashboard-wide-lower.png' })
  await page.getByTestId('stats-page').evaluate((element) => {
    element.scrollTop = 0
  })
  await page.setViewportSize({ width: 900, height: 1600 })
  await assertNoOverflow(page)
  await page.screenshot({ path: 'test-results/stats-dashboard-900.png' })
  const chartGeometry = await page.getByTestId('stats-weekday-chart').evaluate((card) => {
    const svg = card.querySelector('svg')!.getBoundingClientRect()
    const labels = Array.from(card.querySelectorAll('text'))
      .filter((item) => /^[월화수목금토일]$/.test(item.textContent ?? ''))
      .map((item) => item.getBoundingClientRect())
    const bars = Array.from(card.querySelectorAll('.recharts-bar-rectangle path')).map((item) =>
      item.getBoundingClientRect(),
    )
    return {
      labelCount: labels.length,
      clippedLabels: labels.filter((label) => label.top < svg.top || label.bottom > svg.bottom)
        .length,
      labelBarGap:
        Math.min(...labels.map((label) => label.top)) - Math.max(...bars.map((bar) => bar.bottom)),
    }
  })
  expect(chartGeometry.labelCount).toBe(7)
  expect(chartGeometry.clippedLabels).toBe(0)
  expect(chartGeometry.labelBarGap).toBeGreaterThan(2)
  await page
    .getByTestId('stats-weekday-chart')
    .screenshot({ path: 'test-results/stats-dashboard-weekday-900.png' })
  await page.getByTestId('stats-top-videos').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/stats-dashboard-900-lower.png' })
  await page.getByTestId('stats-page').evaluate((element) => {
    element.scrollTop = 0
  })
  await page.setViewportSize({ width: 640, height: 960 })
  await page.getByRole('button', { name: '365일', exact: true }).click()
  await expect(page.getByRole('button', { name: '365일', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as StatsWindow).statsHarness.calls.at(-1)?.days),
    )
    .toBe(365)
  await assertNoOverflow(page)
  await page.screenshot({ path: 'test-results/stats-dashboard-640.png' })
  expect(errors).toEqual([])
})
