import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { getFfmpegPath } from '../scripts/media-paths.cjs'

let fixture: Buffer
let portraitFixture: Buffer

function createFixture(size: string): Buffer {
  return execFileSync(
    getFfmpegPath(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=1`,
      '-frames:v',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  )
}

test.beforeAll(() => {
  // Real decoding checks displayed dimensions without reading any user media.
  fixture = createFixture('320x180')
  portraitFixture = createFixture('180x320')
})

const tools = (page: Page) => page.getByRole('group', { name: '영상 보기 도구', exact: true })
const infoButton = (page: Page) => page.getByRole('button', { name: '재생 정보', exact: true })
const infoRegion = (page: Page) => page.getByRole('region', { name: '재생 정보', exact: true })

async function openPlayer(
  page: Page,
  options: {
    native?: boolean
    missingMetadata?: boolean
    portrait?: boolean
    nativeAvailable?: boolean
  } = {},
) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.route('**/view-controls-fixture.mp4', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: options.portrait ? portraitFixture : fixture,
    }),
  )
  // Adapt only Electron's local-media URL; the browser's media and fullscreen APIs remain real.
  await page.route('**/utils/media.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export function toLocalMediaUrl(path) { return path }',
    }),
  )
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.api?.videos))
  await page.evaluate(async ({ native, missingMetadata, portrait, nativeAvailable }) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    Object.assign(result.value, {
      filePath: native ? '/mock/native.avi' : '/mock/converted-source.mp4',
      fileName: native ? 'native.avi' : 'converted-source.mp4',
      width: missingMetadata ? undefined : portrait ? 1080 : 1920,
      height: missingMetadata ? undefined : portrait ? 1920 : 1080,
      // The application stores format bitrate in kbps, not bits per second.
      bitrate: missingMetadata ? undefined : 4500,
      fps: missingMetadata ? undefined : 30,
      codec: missingMetadata ? undefined : 'h264',
      durationSec: 2,
      resumePosSec: 0,
    })
    window.api.videos.getPlaybackSource = async () => ({
      ok: true,
      value: '/view-controls-fixture.mp4',
    })
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: native || nativeAvailable ? { name: 'mpv', path: 'C:\\mock\\mpv.exe' } : null,
    })
    window.api.videos.openInNativePlayer = async () => ({
      ok: true,
      value: { name: 'mpv', path: 'C:\\mock\\mpv.exe' },
    })
    window.api.highlights.list = async () => ({ ok: true, value: [] })
  }, options)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(tools(page)).toBeVisible()
  if (!options.native) {
    await expect
      .poll(() =>
        page.locator('video').evaluate((video: HTMLVideoElement) => ({
          width: video.videoWidth,
          height: video.videoHeight,
          decoded: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        })),
      )
      .toEqual({
        width: options.portrait ? 180 : 320,
        height: options.portrait ? 320 : 180,
        decoded: true,
      })
    await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause())
  }
}

async function transform(page: Page) {
  return page.locator('video').evaluate((video) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(video).transform)
    return { scale: matrix.a, x: matrix.e, y: matrix.f }
  })
}

test('fullscreen keeps player controls and first Escape exits fullscreen without leaving the video', async ({
  page,
}) => {
  await openPlayer(page)
  await page.getByRole('button', { name: '전체화면', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await expect(page.getByRole('button', { name: '전체화면 해제', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fullscreen = document.fullscreenElement
        return Boolean(
          fullscreen?.contains(document.querySelector('video')) &&
          fullscreen.contains(document.querySelector('[aria-label="재생 위치"]')),
        )
      }),
    )
    .toBe(true)

  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('video')).toBeVisible()
  await page.keyboard.press('Alt+Enter')
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await page.getByRole('button', { name: '전체화면 해제', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/\/player\//)
})

test('a denied fullscreen request shows an error and leaves playback usable', async ({ page }) => {
  await openPlayer(page)
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = async () => {
      throw new Error('전체화면 권한 테스트 거부')
    }
  })
  await page.getByRole('button', { name: '전체화면', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: '전체화면 권한 테스트 거부' }),
  ).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.getByRole('button', { name: '전체화면', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '재생', exact: true })).toBeVisible()
})

test('zoom is bounded, enlarged video can be panned, and fit resets the transform without resuming playback', async ({
  page,
}) => {
  await openPlayer(page)
  const zoomIn = page.getByRole('button', { name: '영상 확대', exact: true })
  const zoomOut = page.getByRole('button', { name: '영상 축소', exact: true })
  await expect.poll(() => transform(page)).toEqual({ scale: 1, x: 0, y: 0 })
  await expect(zoomOut).toBeDisabled()
  await zoomIn.click()
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1)
  for (let attempt = 0; attempt < 32 && (await zoomIn.isEnabled()); attempt += 1) {
    await zoomIn.click()
  }
  await expect.poll(async () => (await transform(page)).scale).toBe(4)
  await expect(zoomIn).toBeDisabled()
  const stage = await page.locator('video').evaluate((video) => {
    const rect = video.parentElement!.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(stage.x, stage.y)
  await page.mouse.down()
  await page.mouse.move(stage.x + 120, stage.y + 60, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => {
      const current = await transform(page)
      return Math.abs(current.x) + Math.abs(current.y)
    })
    .toBeGreaterThan(1)
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true)
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await expect.poll(() => transform(page)).toEqual({ scale: 1, x: 0, y: 0 })
  await expect(zoomOut).toBeDisabled()
  await expect(page.getByRole('slider', { name: '재생 위치' })).toBeInViewport({ ratio: 1 })
})

test('playback information distinguishes original and decoded resolution and converts stored kbps correctly', async ({
  page,
}) => {
  await openPlayer(page)
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'false')
  await infoButton(page).click()
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(infoRegion(page)).toContainText(/1920\s*[×xX]\s*1080/)
  await expect(infoRegion(page)).toContainText(/320\s*[×xX]\s*180/)
  await expect(infoRegion(page)).toContainText(/4[.,]5(?:0)?\s*Mbps/i)
  await expect(infoRegion(page)).not.toContainText(/NaN|Infinity|undefined/)
  await page.keyboard.press('i')
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(infoRegion(page)).toHaveCount(0)
  await page.keyboard.press('i')
  await expect(infoRegion(page)).toBeVisible()
})

test('missing source metadata is shown as unknown while real decoded resolution stays available', async ({
  page,
}) => {
  await openPlayer(page, { missingMetadata: true })
  await infoButton(page).click()
  await expect(infoRegion(page)).toContainText(/정보 없음|알 수 없음/)
  await expect(infoRegion(page)).toContainText(/320\s*[×xX]\s*180/)
  await expect(infoRegion(page)).not.toContainText(/NaN|Infinity|undefined|0\s*[×xX]\s*0/)
})

test('view shortcuts preserve Tab navigation and do not intercept text entry or modified zoom keys', async ({
  page,
}) => {
  await openPlayer(page)
  await infoButton(page).focus()
  await page.keyboard.press('Tab')
  await expect(infoButton(page)).not.toBeFocused()
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('tab', { name: '정보', exact: true }).click()
  const memo = page.locator('textarea').first()
  await memo.fill('')
  await memo.press('i')
  await memo.press('+')
  await memo.press('-')
  await expect(memo).toHaveValue('i+-')
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => transform(page)).toEqual({ scale: 1, x: 0, y: 0 })
  await infoButton(page).focus()
  await page.keyboard.press('+')
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1)
  const enlargedScale = (await transform(page)).scale
  await page.keyboard.press('Control+-')
  await expect.poll(async () => (await transform(page)).scale).toBe(enlargedScale)
  await page.keyboard.press('-')
  await expect.poll(() => transform(page)).toEqual({ scale: 1, x: 0, y: 0 })
})

test('external-player mode explains disabled view controls while retaining source information', async ({
  page,
}) => {
  await openPlayer(page, { native: true })
  await expect(page.getByRole('button', { name: '전체화면', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '영상 확대', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '영상 축소', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '화면 맞춤', exact: true })).toBeDisabled()
  await expect(tools(page)).toContainText('외부 플레이어')
  await infoButton(page).click()
  await expect(infoRegion(page)).toContainText(/1920\s*[×xX]\s*1080/)
  await expect(infoRegion(page)).toContainText(/4[.,]5(?:0)?\s*Mbps/i)
  await expect(infoRegion(page)).not.toContainText(/NaN|Infinity|undefined/)
})

test('portrait panning cannot reveal extra empty space and remains bounded after a window resize', async ({
  page,
}) => {
  await openPlayer(page, { portrait: true })
  const zoomIn = page.getByRole('button', { name: '영상 확대', exact: true })
  for (let attempt = 0; attempt < 32 && (await zoomIn.isEnabled()); attempt += 1) {
    await zoomIn.click()
  }
  await expect.poll(async () => (await transform(page)).scale).toBe(4)
  const stage = await page.locator('video').evaluate((video) => {
    const rect = video.parentElement!.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
  await page.mouse.move(stage.left + stage.width * 0.2, stage.top + stage.height * 0.45)
  await page.mouse.down()
  await page.mouse.move(stage.left + stage.width - 12, stage.top + stage.height * 0.7, { steps: 8 })
  await page.mouse.up()
  // Check actual displayed image edges, including object-contain letterboxing.
  const coverage = () =>
    page.locator('video').evaluate((video: HTMLVideoElement) => {
      const viewport = video.parentElement!.getBoundingClientRect()
      const matrix = new DOMMatrixReadOnly(getComputedStyle(video).transform)
      const fit = Math.min(
        video.clientWidth / video.videoWidth,
        video.clientHeight / video.videoHeight,
      )
      const width = video.videoWidth * fit * matrix.a
      const height = video.videoHeight * fit * matrix.d
      const left = viewport.left + viewport.width / 2 + matrix.e - width / 2
      const top = viewport.top + viewport.height / 2 + matrix.f - height / 2
      return {
        horizontal:
          width >= viewport.width
            ? left <= viewport.left + 1 && left + width >= viewport.right - 1
            : Math.abs(matrix.e) <= 1,
        vertical:
          height >= viewport.height
            ? top <= viewport.top + 1 && top + height >= viewport.bottom - 1
            : Math.abs(matrix.f) <= 1,
      }
    })
  await expect.poll(coverage).toEqual({ horizontal: true, vertical: true })
  await expect.poll(async () => Math.abs((await transform(page)).x)).toBeGreaterThan(1)
  await page.setViewportSize({ width: 800, height: 480 })
  await expect.poll(coverage).toEqual({ horizontal: true, vertical: true })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true)
})

test('handing fullscreen playback to a native player exits fullscreen and leaves source information available', async ({
  page,
}) => {
  await openPlayer(page, { nativeAvailable: true })
  await page.getByRole('button', { name: '전체화면', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await page.getByRole('button', { name: 'mpv로 열기', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.getByRole('button', { name: '전체화면', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '영상 확대', exact: true })).toBeDisabled()
  await expect(page).toHaveURL(/\/player\//)
  await infoButton(page).click()
  await expect(infoRegion(page)).toContainText(/1920\s*[×xX]\s*1080/)
  await expect(infoRegion(page)).toContainText('외부 플레이어에서 확인')
})

test('player view and percentage shortcuts do not act through a removal confirmation dialog', async ({
  page,
}) => {
  await openPlayer(page)
  await page.getByRole('tab', { name: '정보', exact: true }).click()
  await page.getByRole('button', { name: '목록에서만 제거', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '취소', exact: true }).focus()
  const position = await page
    .locator('video')
    .evaluate((video: HTMLVideoElement) => video.currentTime)
  await page.keyboard.press('i')
  await page.keyboard.press('+')
  await page.keyboard.press('5')
  await expect(dialog).toBeVisible()
  await expect(infoButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => transform(page)).toEqual({ scale: 1, x: 0, y: 0 })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(position, 2)
  await page.keyboard.press('Alt+Enter')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page).toHaveURL(/\/player\//)
})

test('refreshing metadata for the same loaded video preserves the current decoded resolution', async ({
  page,
}) => {
  await openPlayer(page)
  await infoButton(page).click()
  await expect(infoRegion(page)).toContainText(/320\s*[×xX]\s*180/)
  await page.evaluate(() => {
    const originalGet = window.api.videos.get
    window.api.videos.get = async (libraryId, videoId) => {
      const result = await originalGet(libraryId, videoId)
      if (!result.ok || !result.value) return result
      return {
        ok: true,
        value: {
          ...result.value,
          fileName: 'metadata-refreshed.mp4',
          durationSec: 3,
          bitrate: 9000,
        },
      }
    }
    const video = document.querySelector('video')!
    video.dataset.additionalMetadataEvents = '0'
    video.addEventListener('loadedmetadata', () => {
      video.dataset.additionalMetadataEvents = String(
        Number(video.dataset.additionalMetadataEvents) + 1,
      )
    })
  })
  // This existing UI action invalidates video metadata without replacing its playback source.
  await page.getByRole('tab', { name: '정보', exact: true }).click()
  await page.getByRole('button', { name: '다시 생성', exact: true }).click()
  await expect(infoRegion(page)).toContainText('metadata-refreshed.mp4')
  await expect(infoRegion(page)).toContainText(/9\s*Mbps/i)
  await expect(infoRegion(page)).toContainText(/320\s*[×xX]\s*180/)
  await expect(page.locator('video')).toHaveAttribute('data-additional-metadata-events', '0')
})
