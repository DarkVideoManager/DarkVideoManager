import { execFileSync } from 'node:child_process'
import { getFfmpegPath } from '../scripts/media-paths.cjs'
import { expect, test, type Page } from '@playwright/test'

async function drop(page: Page, names: string[]) {
  await page.evaluate((names) => {
    const transfer = new DataTransfer()
    names.forEach((name) => transfer.items.add(new File(['fixture'], name)))
    window.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  }, names)
}

test('opens from an empty library, replaces playback, closes and never mutates the library', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let api: typeof window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      get: () => api,
      set: (value) => {
        api = value
        api.library.list = async () => ({ ok: true, value: [] })
      },
    })
  })
  const fixture = execFileSync(getFfmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=10',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  await page.route('**/drop-fixture.mp4', (route) =>
    route.fulfill({ contentType: 'video/mp4', body: fixture }),
  )
  await page.goto('/')
  await page.evaluate(() => {
    // Browser File objects cannot reveal OS paths. Mock only the desktop boundary.
    window.api.temporaryPlayback.openDroppedFiles = async (files) => ({
      ok: true,
      value: {
        token: crypto.randomUUID(),
        fileName: files[0].name,
        sourceUrl: '/drop-fixture.mp4',
      },
    })
    const calls: string[] = []
    Object.assign(window, { temporaryMutationCalls: calls })
    const rejectMutation = async () => {
      calls.push('mutation')
      throw new Error('Temporary playback must not persist')
    }
    window.api.library.importFiles = rejectMutation
    window.api.videos.updateMeta = rejectMutation
    window.api.playback.start = rejectMutation
    window.api.playback.heartbeat = rejectMutation
    window.api.playback.end = rejectMutation
    window.api.highlights.create = rejectMutation
    window.api.thumbnails.captureAtTime = rejectMutation
  })
  await drop(page, ['한글 영상 1.mp4'])
  await expect(page.getByRole('main', { name: '임시 영상 재생' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '한글 영상 1.mp4' })).toBeVisible()
  await expect(
    page.getByText('바로 재생 · 라이브러리와 재생 기록에 저장하지 않습니다.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '현재 화면을 대표 썸네일로 저장' })).toHaveCount(0)
  await drop(page, ['두 번째 영상.webm'])
  await expect(page.getByRole('heading', { name: '두 번째 영상.webm' })).toBeVisible()
  await expect(page.locator('video')).toHaveCount(1)
  await expect
    .poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.videoWidth))
    .toBe(320)
  expect(
    await page.evaluate(
      () => (window as unknown as { temporaryMutationCalls: string[] }).temporaryMutationCalls,
    ),
  ).toEqual([])
  await page.screenshot({ path: 'test-results/drop-playback.png' })
  await page.getByRole('button', { name: '재생 닫기' }).click()
  await expect(page.getByRole('main', { name: '임시 영상 재생' })).toHaveCount(0)
})

test('rejects multiple files, text/URL drops and reports desktop open failures', async ({
  page,
}) => {
  await page.goto('/')
  await drop(page, ['one.mp4', 'two.mp4'])
  await expect(page.getByRole('alert')).toContainText('한 번에 하나씩')
  await drop(page, [])
  await expect(page.getByRole('alert')).toContainText('URL과 폴더는 열 수 없습니다')
  await page.evaluate(() => {
    window.api.temporaryPlayback.openDroppedFiles = async () => ({
      ok: false,
      error: '영상 파일을 찾거나 읽을 수 없습니다.',
    })
  })
  await drop(page, ['missing.mp4'])
  await expect(page.getByRole('alert')).toContainText('파일을 찾거나 읽을 수 없습니다')
  await expect(page.locator('video')).toHaveCount(0)
})

test('rejected cleanup requests remain contained when closing and hiding temporary playback', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.evaluate(() => {
    window.api.temporaryPlayback.openDroppedFiles = async (files) => ({
      ok: true,
      value: { token: crypto.randomUUID(), fileName: files[0].name, sourceUrl: '/unavailable.mp4' },
    })
    window.api.temporaryPlayback.close = async () => {
      throw new Error('IPC detached')
    }
    window.api.privacy.exit = async () => ({ ok: true, value: 'blank' })
  })
  await drop(page, ['first.mp4'])
  await expect(page.getByRole('main', { name: '임시 영상 재생' })).toBeVisible()
  await page.getByRole('button', { name: '재생 닫기' }).click()
  await expect(page.getByRole('main', { name: '임시 영상 재생' })).toHaveCount(0)
  await drop(page, ['second.mp4'])
  await expect(page.getByRole('main', { name: '임시 영상 재생' })).toBeVisible()
  await page.keyboard.press('Control+Shift+h')
  await expect(page.getByRole('region', { name: '가림 화면' })).toBeVisible()
  expect(errors).toEqual([])
})
