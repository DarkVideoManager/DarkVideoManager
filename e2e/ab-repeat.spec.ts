import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { getFfmpegPath } from '../scripts/media-paths.cjs'

let fixture: Buffer

test.beforeAll(() => {
  fixture = execFileSync(
    getFfmpegPath(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=20',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  )
})

type RepeatWindow = Window & { repeatSeeks: number[] }
const repeatTools = (page: Page) => page.getByRole('group', { name: 'A-B 구간 반복', exact: true })

async function openPlayer(page: Page, native: 'mpv' | 'vlc' | 'ffplay' | null = null) {
  await page.route('**/ab-repeat-fixture.mp4', (route) => {
    const range = route
      .request()
      .headers()
      ['range']?.match(/^bytes=(\d+)-(\d*)$/)
    const start = Number(range?.[1] ?? 0)
    const end = range?.[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${fixture.length}` } : {}),
      },
      body: fixture.subarray(start, end + 1),
    })
  })
  await page.route('**/utils/media.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export function toLocalMediaUrl(path) { return path }',
    }),
  )
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api?.videos))
  await page.evaluate(async (native) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing A–B media fixture')
    const original = {
      ...result.value,
      filePath: '/mock/ab-repeat.mp4',
      durationSec: 6,
      resumePosSec: 0,
      codec: 'h264',
    }
    window.api.videos.get = async (_library, id) => ({
      ok: true,
      value: { ...original, id, filePath: `/mock/${id}.mp4` },
    })
    window.api.videos.getPlaybackSource = async () => ({
      ok: true,
      value: '/ab-repeat-fixture.mp4',
    })
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: native ? { name: native, path: 'C:/mock/player.exe' } : null,
    })
    window.api.videos.openInNativePlayer = async () => ({
      ok: true,
      value: { name: native!, path: 'C:/mock/player.exe' },
    })
    window.api.subtitles.getForVideo = async (_library, id) => ({
      ok: true,
      value: [
        {
          id: 'ab-subtitle',
          videoId: id,
          filePath: '/mock/ab-repeat.vtt',
          type: 'vtt',
          isEmbedded: false,
        },
      ],
    })
    window.api.subtitles.readText = async () => ({
      ok: true,
      value:
        'WEBVTT\n\n00:00:01.000 --> 00:00:01.800\n반복 자막\n\n00:00:02.000 --> 00:00:04.000\n다음 자막',
    })
    window.location.hash = '#/player/mock-library/mock-video-1'
  }, native)
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(2)
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause())
}

async function seekPaused(page: Page, time: number) {
  const media = page.locator('video')
  await media.evaluate((video: HTMLVideoElement) => video.pause())
  await page.getByRole('slider', { name: '재생 위치', exact: true }).fill(String(time))
  await page.getByRole('slider', { name: '재생 위치', exact: true }).blur()
  await expect
    .poll(() =>
      media.evaluate(
        (video: HTMLVideoElement, target) => Math.abs(video.currentTime - target),
        time,
      ),
    )
    .toBeLessThan(0.03)
}

async function setRange(page: Page, start: number, end: number) {
  await seekPaused(page, start)
  await repeatTools(page).getByRole('button', { name: 'A 시작점 설정' }).click()
  await seekPaused(page, end)
  await repeatTools(page).getByRole('button', { name: 'B 끝점 설정' }).click()
}

test('repeats real media at 0.25×, keeps subtitles and paused seeking, and stops when disabled', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openPlayer(page)
  await setRange(page, 1, 1.5)
  await page.getByRole('combobox', { name: '재생 배속 선택' }).selectOption('0.25')
  await repeatTools(page).getByRole('button', { name: '반복 켜기' }).click()
  const media = page.locator('video')
  expect(await media.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true)
  await media.evaluate((video: HTMLVideoElement) => {
    Object.assign(window, { repeatSeeks: [] })
    video.addEventListener('seeking', () => {
      if (!video.paused && video.currentTime < 1.1)
        (window as RepeatWindow).repeatSeeks.push(video.currentTime)
    })
    return video.play()
  })
  // Actual media decoding must complete multiple A–B passes, rather than receiving synthetic timeupdate events.
  await expect
    .poll(() => page.evaluate(() => (window as RepeatWindow).repeatSeeks.length), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(3)
  expect(await media.evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(0.25)
  expect(
    await page.evaluate(() =>
      (window as RepeatWindow).repeatSeeks.every((time) => Math.abs(time - 1) < 0.03),
    ),
  ).toBe(true)
  await expect(media.locator('..').getByText('반복 자막', { exact: true })).toBeVisible()
  await seekPaused(page, 3)
  const paused = await media.evaluate(async (video: HTMLVideoElement) => {
    const before = video.currentTime
    await new Promise((resolve) => setTimeout(resolve, 150))
    return { before, after: video.currentTime, paused: video.paused }
  })
  expect(paused).toEqual({ before: 3, after: 3, paused: true })
  await media.evaluate((video: HTMLVideoElement) => video.play())
  await expect
    .poll(() => media.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeLessThan(1.6)
  await page.screenshot({ path: 'test-results/ab-repeat-low-speed.png' })
  await repeatTools(page).getByRole('button', { name: '반복 끄기' }).click()
  await page.getByRole('combobox', { name: '재생 배속 선택' }).selectOption('1')
  await expect
    .poll(() => media.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(2)
  await media.evaluate((video: HTMLVideoElement) => video.pause())
  await repeatTools(page).getByRole('button', { name: '구간 초기화' }).click()
  await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toHaveText(
    'A --:--',
  )
  expect(errors).toEqual([])
})

test('explains missing/reversed ranges and resets when changing video or closing playback', async ({
  page,
}) => {
  await openPlayer(page)
  await repeatTools(page).getByRole('button', { name: '반복 켜기' }).click()
  await expect(repeatTools(page).getByRole('alert')).toContainText('A 시작점과 B 끝점')
  await setRange(page, 3, 2)
  await expect(repeatTools(page).getByRole('alert')).toContainText('최소 0.1초')
  await repeatTools(page).getByRole('button', { name: '반복 켜기' }).click()
  await expect(repeatTools(page).getByRole('button', { name: '반복 켜기' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await setRange(page, 1, 2)
  await repeatTools(page).getByRole('button', { name: '반복 켜기' }).click()
  await page.evaluate(() => {
    window.location.hash = '#/player/mock-library/mock-video-2'
  })
  await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toHaveText(
    'A --:--',
  )
  await expect(repeatTools(page).getByRole('button', { name: '반복 켜기' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await page.getByRole('button', { name: '닫기', exact: true }).first().click()
  await expect(page).toHaveURL(/mock-video-1$/)
  await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toHaveText(
    'A --:--',
  )
})

for (const native of ['mpv', 'vlc', 'ffplay'] as const) {
  test(`${native} clearly limits app A–B controls and resets the range when returning to in-app playback`, async ({
    page,
  }) => {
    await openPlayer(page, native)
    await setRange(page, 1, 2)
    await repeatTools(page).getByRole('button', { name: '반복 켜기' }).click()
    await page
      .getByRole('button', {
        name: native === 'mpv' ? 'mpv로 열기' : native === 'vlc' ? 'VLC로 열기' : 'FFplay로 열기',
      })
      .first()
      .click()
    await expect(
      repeatTools(page).getByText(
        'A-B 반복은 인앱 플레이어에서 지원합니다. 외부 플레이어에서는 자체 구간 반복 기능을 사용하세요.',
      ),
    ).toBeVisible()
    await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toBeDisabled()
    await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toHaveText(
      'A --:--',
    )
    await page.getByRole('button', { name: '인앱 플레이어로 시도' }).click()
    await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toBeEnabled()
    await expect(repeatTools(page).getByRole('button', { name: 'A 시작점 설정' })).toHaveText(
      'A --:--',
    )
    await expect(repeatTools(page).getByRole('button', { name: '반복 켜기' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
}
