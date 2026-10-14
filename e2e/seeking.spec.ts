import { expect, test, type Page } from '@playwright/test'

interface SeekWrite {
  target: number
  at: number
}
interface SeekingHarness {
  actual: number
  seeking: boolean
  ready: boolean
  paused: boolean
  uiTarget: number
  writes: SeekWrite[]
  completed: number[]
  cancellations: number
  playCalls: number
  pauseCalls: number
  samples: number[]
  sampleTimer?: number
  releaseSource: () => void
  setReady: () => void
  startSampling: () => void
  stopSampling: () => void
  nativeStart?: number
  finalPosition?: number
}
type SeekingWindow = Window & { seekingHarness: SeekingHarness }

async function prepareSlowDecoder(page: Page, ready = true): Promise<void> {
  await page.goto('/')
  await page.evaluate(async () => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    result.value.resumePosSec = 100
    result.value.durationSec = 300
    result.value.filePath = '/mock/slow-decoder.mp4'
    const state: SeekingHarness = {
      actual: 100,
      seeking: false,
      ready: false,
      paused: true,
      uiTarget: 0,
      writes: [],
      completed: [],
      cancellations: 0,
      playCalls: 0,
      pauseCalls: 0,
      samples: [],
      releaseSource: () => undefined,
      setReady: () => undefined,
      startSampling: () => undefined,
      stopSampling: () => undefined,
    }
    ;(window as unknown as SeekingWindow).seekingHarness = state
    window.api.videos.getPlaybackSource = () =>
      new Promise((resolve) => {
        state.releaseSource = () => resolve({ ok: true, value: '/mock/slow-decoder.mp4' })
      })
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: { name: 'mpv', path: 'C:\\mock\\mpv.exe' },
    })
    window.api.videos.openInNativePlayer = async (_libraryId, _videoId, options) => {
      state.nativeStart = options?.startTimeSec
      return { ok: true, value: { name: 'mpv', path: 'C:\\mock\\mpv.exe' } }
    }
    window.api.playback.end = async (_libraryId, _videoId, position) => {
      state.finalPosition = position
      return { ok: true, value: null }
    }
    // Chrome cannot load Electron's local-media protocol; decoding is controlled below instead.
    window.addEventListener(
      'error',
      (event) => {
        if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation()
      },
      true,
    )
  })
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(page.locator('video')).toBeVisible()
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    const state = (window as unknown as SeekingWindow).seekingHarness
    let decodeTimer: number | undefined
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => state.actual,
        set: (value: number) => {
          if (!state.ready) throw new Error('Seek was sent before metadata')
          if (decodeTimer !== undefined) {
            clearTimeout(decodeTimer)
            state.cancellations += 1
          }
          const target = Math.max(0, Math.min(300, value))
          state.writes.push({ target, at: performance.now() })
          state.seeking = true
          video.dispatchEvent(new Event('seeking'))
          decodeTimer = window.setTimeout(() => {
            decodeTimer = undefined
            state.actual = target
            state.completed.push(target)
            state.seeking = false
            video.dispatchEvent(new Event('timeupdate'))
            video.dispatchEvent(new Event('seeked'))
          }, 180)
        },
      },
      duration: { configurable: true, get: () => (state.ready ? 300 : NaN) },
      readyState: { configurable: true, get: () => (state.ready ? 4 : 0) },
      seeking: { configurable: true, get: () => state.seeking },
      paused: { configurable: true, get: () => state.paused },
      play: {
        configurable: true,
        value: async () => {
          state.playCalls += 1
          state.paused = false
          video.dispatchEvent(new Event('play'))
        },
      },
      pause: {
        configurable: true,
        value: () => {
          state.pauseCalls += 1
          state.paused = true
          video.dispatchEvent(new Event('pause'))
        },
      },
      load: {
        configurable: true,
        value: () => {
          if (decodeTimer !== undefined) clearTimeout(decodeTimer)
          decodeTimer = undefined
          state.seeking = false
        },
      },
    })
    state.setReady = () => {
      state.ready = true
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('durationchange'))
    }
    state.startSampling = () => {
      state.samples = []
      state.sampleTimer = window.setInterval(() => {
        const range = document.querySelector<HTMLInputElement>('input[aria-label="재생 위치"]')
        if (range) state.samples.push(Number(range.value))
      }, 15)
    }
    state.stopSampling = () => clearInterval(state.sampleTimer)
    // A range with step=0.1 rounds its public value; retain the precise controlled value
    // written by React so the final decoder target can be checked without rounding tolerance.
    const range = document.querySelector<HTMLInputElement>('input[aria-label="재생 위치"]')!
    const valueProperty = Object.getOwnPropertyDescriptor(range, 'value')!
    state.uiTarget = Number(range.value)
    Object.defineProperty(range, 'value', {
      configurable: true,
      get() {
        return valueProperty.get!.call(this)
      },
      set(value: string) {
        state.uiTarget = Number(value)
        valueProperty.set!.call(this, value)
      },
    })
    state.releaseSource()
  })
  await expect(page.locator('video')).toHaveAttribute('src', /slow-decoder/)
  if (ready) {
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.setReady())
    await expect(page.getByRole('slider', { name: '재생 위치', exact: true })).toHaveValue('100')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.seeking))
      .toBe(false)
    await page.evaluate(() => {
      const state = (window as unknown as SeekingWindow).seekingHarness
      state.writes = []
      state.completed = []
      state.cancellations = 0
    })
  }
}

async function sliderTarget(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.uiTarget)
}

async function expectFinalTarget(page: Page, target: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as SeekingWindow).seekingHarness
        return state.seeking ? -1 : state.actual
      }),
    )
    .toBeCloseTo(target, 5)
  const state = await page.evaluate(() => {
    const current = (window as unknown as SeekingWindow).seekingHarness
    return {
      cancellations: current.cancellations,
      paused: current.paused,
      playCalls: current.playCalls,
    }
  })
  expect(state).toEqual({ cancellations: 0, paused: true, playCalls: 0 })
}

for (const { key, direction } of [
  { key: 'ArrowRight', direction: 1 },
  { key: 'd', direction: 1 },
  { key: 'ArrowLeft', direction: -1 },
  { key: 'a', direction: -1 },
]) {
  test(`held ${key} coalesces slow seeks without reversing the target and commits on keyup`, async ({
    page,
  }) => {
    await prepareSlowDecoder(page)
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.startSampling())
    await page.keyboard.down(key)
    // Simulate OS key repeat while the initial continuous-seek delay is still pending.
    await page.waitForTimeout(65)
    await page.keyboard.down(key)
    await page.waitForTimeout(65)
    await page.keyboard.down(key)
    await expect.poll(async () => ((await sliderTarget(page)) - 100) * direction).toBeGreaterThan(8)
    await page.keyboard.up(key)
    const target = await sliderTarget(page)
    await expectFinalTarget(page, target)
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.stopSampling())
    const state = await page.evaluate(() => {
      const current = (window as unknown as SeekingWindow).seekingHarness
      return { samples: current.samples, writes: current.writes }
    })
    expect(state.writes.length).toBeGreaterThan(1)
    for (let index = 1; index < state.samples.length; index += 1) {
      expect((state.samples[index] - state.samples[index - 1]) * direction).toBeGreaterThanOrEqual(
        -0.001,
      )
    }
    for (let index = 1; index < state.writes.length; index += 1) {
      expect(state.writes[index].at - state.writes[index - 1].at).toBeGreaterThanOrEqual(150)
    }
  })
}

test('blur commits the latest target and stops the held-key producer', async ({ page }) => {
  await prepareSlowDecoder(page)
  await page.keyboard.down('d')
  await expect.poll(async () => (await sliderTarget(page)) - 100).toBeGreaterThan(6)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const target = await sliderTarget(page)
  await expectFinalTarget(page, target)
  const writes = await page.evaluate(
    () => (window as unknown as SeekingWindow).seekingHarness.writes.length,
  )
  // Wait beyond both the decoder delay and repeat delay to catch a surviving producer timer.
  await page.waitForTimeout(400)
  expect(
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.writes.length),
  ).toBe(writes)
  await page.keyboard.up('d')
})

test('dragging commits the last value without decoder restarts and navigation clears pending work', async ({
  page,
}) => {
  await prepareSlowDecoder(page)
  const range = page.getByRole('slider', { name: '재생 위치', exact: true })
  await range.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', bubbles: true })
  for (const target of [110, 125, 145, 170, 192.3]) {
    await range.evaluate((input: HTMLInputElement, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, target)
    await page.waitForTimeout(20)
  }
  await range.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', bubbles: true })
  await expectFinalTarget(page, 192.3)
  await page.keyboard.down('d')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.seeking))
    .toBe(true)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(page.locator('video')).toHaveCount(0)
  const writes = await page.evaluate(
    () => (window as unknown as SeekingWindow).seekingHarness.writes.length,
  )
  await page.waitForTimeout(450)
  expect(
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.writes.length),
  ).toBe(writes)
  await page.keyboard.up('d')
})

test('native handoff uses the pending desired position and leaves no old-source seek timer', async ({
  page,
}) => {
  await prepareSlowDecoder(page)
  await page.keyboard.down('d')
  await expect.poll(async () => (await sliderTarget(page)) - 100).toBeGreaterThan(6)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const target = await sliderTarget(page)
  await page.getByRole('button', { name: 'mpv로 열기', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.nativeStart),
    )
    .toBeCloseTo(target, 5)
  await expect(page.locator('video')).not.toHaveAttribute('src')
  const writes = await page.evaluate(
    () => (window as unknown as SeekingWindow).seekingHarness.writes.length,
  )
  await page.waitForTimeout(450)
  expect(
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.writes.length),
  ).toBe(writes)
  await page.keyboard.up('d')
})

test('seek requested before metadata is queued and survives resume initialization', async ({
  page,
}) => {
  await prepareSlowDecoder(page, false)
  await page.keyboard.press('ArrowRight')
  expect(
    await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.writes.length),
  ).toBe(0)
  const target = await sliderTarget(page)
  expect(target).toBeGreaterThan(100)
  await page.evaluate(() => (window as unknown as SeekingWindow).seekingHarness.setReady())
  await expectFinalTarget(page, target)
})
