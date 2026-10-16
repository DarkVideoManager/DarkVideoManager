import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { getFfmpegPath } from '../scripts/media-paths.cjs'

let fixture: Buffer
test.beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'dvm-playback-rate-'))
  const path = join(directory, 'fixture.mp4')
  try {
    execFileSync(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      path,
    ])
    fixture = readFileSync(path)
  } finally {
    rmSync(path, { force: true })
    rmdirSync(directory)
  }
})
async function openPlayer(page: Page, native: 'mpv' | 'vlc' | 'ffplay' | null = null) {
  await page.route('**/rate-fixture.mp4', (route) => {
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
        ...(range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + fixture.length } : {}),
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
  await page.evaluate(async (native) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('missing fixture')
    Object.assign(result.value, {
      filePath: '/mock/rate.mp4',
      durationSec: 12,
      resumePosSec: 0,
      codec: 'h264',
    })
    window.api.videos.getPlaybackSource = async () => ({ ok: true, value: '/rate-fixture.mp4' })
    window.api.subtitles.getForVideo = async () => ({
      ok: true,
      value: [
        {
          id: 'rate-subtitle',
          videoId: 'mock-video-1',
          filePath: '/mock/rate.vtt',
          type: 'vtt',
          isEmbedded: false,
        },
      ],
    })
    window.api.subtitles.readText = async () => ({
      ok: true,
      value:
        'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n배속 자막\n\n00:00:03.000 --> 00:00:06.000\n다음 자막',
    })
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: native ? { name: native, path: 'C:/mock/player.exe' } : null,
    })
    window.api.videos.openInNativePlayer = async (_libraryId, _videoId, options) => {
      Object.assign(window, { launchedRate: options?.playbackRate })
      return { ok: true, value: { name: native!, path: 'C:/mock/player.exe' } }
    }
    window.location.hash = '#/player/mock-library/mock-video-1'
  }, native)
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(2)
}

test('applies real media speed, keeps pause/seek and subtitles in sync, and resets to 1x', async ({
  page,
}) => {
  await openPlayer(page)
  const media = page.locator('video')
  await media.evaluate((video: HTMLVideoElement) => video.pause())
  await page.getByRole('combobox', { name: '재생 배속 선택' }).selectOption('1.5')
  expect(
    await media.evaluate((video: HTMLVideoElement) => ({
      rate: video.playbackRate,
      paused: video.paused,
      pitch: video.preservesPitch,
    })),
  ).toEqual({ rate: 1.5, paused: true, pitch: true })
  await page.getByRole('slider', { name: '재생 위치', exact: true }).fill('2')
  await page.getByRole('slider', { name: '재생 위치', exact: true }).blur()
  await expect(media.locator('..').getByText('배속 자막', { exact: true })).toBeVisible()
  expect(await media.evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5)
  await media.evaluate((video: HTMLVideoElement) => video.play())
  await expect
    .poll(() => media.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(3)
  await expect(media.locator('..').getByText('다음 자막', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/playback-rate.png' })
  await page.getByRole('button', { name: '1배속으로 복귀' }).click()
  await expect(page.getByText('현재 1×', { exact: true })).toBeVisible()
  expect(await media.evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1)
})

test('passes speed to mpv, waits for acknowledged changes, and displays failures', async ({
  page,
}) => {
  await openPlayer(page, 'mpv')
  await page.getByRole('combobox', { name: '재생 배속 선택' }).selectOption('1.5')
  await page.getByRole('button', { name: 'mpv로 열기' }).first().click()
  await expect(page.getByText('mpv 앱 조절 0.25–4× · mpv에서 변경한 값도 표시')).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { launchedRate: number }).launchedRate),
  ).toBe(1.5)
  await page.evaluate(() => {
    window.api.videos.setActivePlaybackRate = async () => ({ ok: false, error: 'mpv 연결 종료' })
  })
  await page.getByRole('combobox', { name: '재생 배속 선택' }).selectOption('2')
  await expect(page.getByRole('alert')).toContainText('mpv 연결 종료')
  await expect(page.getByText('현재 1.5×', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.api.videos.setActivePlaybackRate = async (_l, _v, rate) => ({ ok: true, value: rate })
  })
  await page.getByRole('button', { name: '1배속으로 복귀' }).click()
  await expect(page.getByText('현재 1×', { exact: true })).toBeVisible()
})

for (const native of ['vlc', 'ffplay'] as const) {
  test(`${native} explains external speed limits instead of displaying an unapplied value`, async ({
    page,
  }) => {
    await openPlayer(page, native)
    await page
      .getByRole('button', { name: native === 'vlc' ? 'VLC로 열기' : 'FFplay로 열기' })
      .first()
      .click()
    await expect(page.getByRole('combobox', { name: '재생 배속 선택' })).toBeDisabled()
    await expect(page.getByText('앱에서 현재 배속 확인 불가')).toBeVisible()
    await expect(
      page.getByText(
        native === 'vlc'
          ? 'VLC의 재생 → 속도 메뉴에서 조절하세요. 앱에서는 변경·조회할 수 없습니다.'
          : 'FFplay 배속 변경은 앱에서 지원하지 않습니다. 인앱 또는 mpv를 사용하세요.',
      ),
    ).toBeVisible()
  })
}
