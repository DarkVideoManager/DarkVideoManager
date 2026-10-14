import { expect, test, type Page } from '@playwright/test'
import type { AppSettings, CacheInfo, NativePlayerInfo } from '../src/shared/types'

interface SettingsHarness {
  settings: AppSettings
  info: CacheInfo
  patches: Partial<AppSettings>[]
  cleanCalls: number
  quitCalls: number
  failLoad: boolean
  failSave: boolean
  failCleanup: boolean
  deferCleanup: boolean
  finishCleanup: () => void
  detectedPlayers: NativePlayerInfo[]
  selectedFile: NativePlayerInfo | null
  pickerCalls: NativePlayerInfo['name'][]
  failPicker: boolean
  failDetection: boolean
  finishAcceleration: () => void
}
type SettingsWindow = Window & { settingsHarness: SettingsHarness }

async function prepareSettings(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(() => {
    const gb = 1024 ** 3
    const state: SettingsHarness = {
      settings: { cacheLimitGb: 10, nativePlayer: { name: 'mpv', path: 'C:\\Apps\\mpv.exe' } },
      info: { usedBytes: 2 * gb, limitBytes: 10 * gb, fileCount: 4, protectedBytes: gb / 2 },
      patches: [],
      cleanCalls: 0,
      quitCalls: 0,
      failLoad: false,
      failSave: false,
      failCleanup: false,
      deferCleanup: false,
      finishCleanup: () => undefined,
      detectedPlayers: [
        { name: 'mpv', path: 'C:\\Apps\\mpv.exe' },
        { name: 'vlc', path: 'C:\\Apps\\vlc.exe' },
      ],
      selectedFile: { name: 'ffplay', path: 'D:\\Players\\ffplay.exe' },
      pickerCalls: [],
      failPicker: false,
      failDetection: false,
      finishAcceleration: () => undefined,
    }
    ;(window as unknown as SettingsWindow).settingsHarness = state
    window.api.app.getSettings = async () => {
      if (state.failLoad) return { ok: false, error: '설정을 불러올 수 없습니다.' }
      return { ok: true, value: { ...state.settings } }
    }
    window.api.app.getCacheInfo = async () => ({ ok: true, value: { ...state.info } })
    window.api.app.getAccelerationInfo = async () => ({
      ok: true,
      value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'enabled' },
    })
    window.api.app.getNativePlayers = async () =>
      state.failDetection
        ? { ok: false, error: '플레이어 검색 테스트 실패' }
        : { ok: true, value: state.detectedPlayers }
    window.api.app.selectNativePlayer = async (name) => {
      state.pickerCalls.push(name)
      if (state.failPicker) throw new Error('실행 파일 선택 테스트 실패')
      return { ok: true, value: state.selectedFile }
    }
    window.api.videos.getNativePlayerInfo = async () => ({
      ok: true,
      value: state.settings.nativePlayer ?? state.detectedPlayers[0] ?? null,
    })
    window.api.app.updateSettings = async (patch) => {
      state.patches.push(patch)
      if (state.failSave) throw new Error('설정 저장 테스트 실패')
      state.settings = { ...state.settings, ...patch }
      state.info.limitBytes = state.settings.cacheLimitGb * gb
      return { ok: true, value: { ...state.settings } }
    }
    window.api.app.cleanCache = async () => {
      state.cleanCalls += 1
      if (state.failCleanup) return { ok: false, error: '캐시 정리 테스트 실패' }
      if (state.deferCleanup)
        await new Promise<void>((resolve) => {
          state.finishCleanup = resolve
        })
      state.info = { ...state.info, usedBytes: gb / 2, fileCount: 1 }
      return {
        ok: true,
        value: { removedBytes: 1.5 * gb, removedFiles: 3, info: { ...state.info } },
      }
    }
    window.api.app.quit = async () => {
      state.quitCalls += 1
      return { ok: true, value: true }
    }
  })
}

test('acceleration support is read-only and distinguishes hardware, software, off, and unknown', async ({
  page,
}) => {
  await prepareSettings(page)
  const cases = [
    {
      videoDecodeStatus: 'enabled',
      gpuCompositingStatus: 'enabled_force',
      decodeLabel: '하드웨어 가속 사용 가능',
      compositingLabel: '하드웨어 가속 사용 가능',
    },
    {
      videoDecodeStatus: 'unavailable_software',
      gpuCompositingStatus: 'disabled_off',
      decodeLabel: '소프트웨어 처리',
      compositingLabel: '사용 불가',
    },
    {
      videoDecodeStatus: 'unknown',
      gpuCompositingStatus: 'enabled_readback',
      decodeLabel: '상태 미확인',
      compositingLabel: '하드웨어 가속 사용 가능',
    },
  ]
  for (const info of cases) {
    await page.evaluate(({ videoDecodeStatus, gpuCompositingStatus }) => {
      window.api.app.getAccelerationInfo = async () => ({
        ok: true,
        value: { videoDecodeStatus, gpuCompositingStatus },
      })
    }, info)
    await page.getByRole('button', { name: '설정', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '설정', exact: true })
    const acceleration = dialog.getByRole('region', { name: '인앱 재생 가속', exact: true })
    await expect(acceleration.getByTestId('video-decode-status')).toHaveText(info.decodeLabel)
    await expect(acceleration.getByTestId('gpu-compositing-status')).toHaveText(
      info.compositingLabel,
    )
    await expect(
      acceleration.getByText('실제 GPU 사용 여부는 영상 형식에 따라 달라집니다.'),
    ).toBeVisible()
    await expect(acceleration.locator('input, select')).toHaveCount(0)
    await expect(acceleration.getByRole('button', { name: '다시 확인', exact: true })).toBeEnabled()
    if (info.videoDecodeStatus === 'unknown') {
      await page.evaluate(() => {
        window.api.app.getAccelerationInfo = async () => ({
          ok: true,
          value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'enabled' },
        })
      })
      await acceleration.getByRole('button', { name: '다시 확인', exact: true }).click()
      await expect(acceleration.getByTestId('video-decode-status')).toHaveText(
        '하드웨어 가속 사용 가능',
      )
      await expect(acceleration.getByTestId('gpu-compositing-status')).toHaveText(
        '하드웨어 가속 사용 가능',
      )
    }
    await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  }
  expect(
    await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.patches),
  ).toEqual([])
})

for (const failure of ['result', 'rejection']) {
  test(`acceleration ${failure} failure and loading do not block settings edits`, async ({
    page,
  }) => {
    await prepareSettings(page)
    await page.evaluate((kind) => {
      window.api.app.getAccelerationInfo = () =>
        new Promise((resolve, reject) => {
          ;(window as unknown as SettingsWindow).settingsHarness.finishAcceleration = () => {
            if (kind === 'rejection') reject(new Error('GPU 조회 테스트 실패'))
            else resolve({ ok: false, error: 'GPU 조회 테스트 실패' })
          }
        })
    }, failure)
    await page.getByRole('button', { name: '설정', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '설정', exact: true })
    const acceleration = dialog.getByRole('region', { name: '인앱 재생 가속', exact: true })
    await expect(acceleration.getByText('가속 상태 확인 중...')).toBeVisible()
    await expect(
      acceleration.getByRole('button', { name: '다시 확인', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('spinbutton').fill('20')
    await dialog.getByRole('button', { name: '저장', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('캐시 용량 상한을 저장했습니다.')
    await expect(acceleration.getByText('가속 상태 확인 중...')).toBeVisible()
    await page.evaluate(() =>
      (window as unknown as SettingsWindow).settingsHarness.finishAcceleration(),
    )
    await expect(
      acceleration.getByText('가속 상태를 확인하지 못했습니다. GPU 조회 테스트 실패'),
    ).toBeVisible()
    await expect(acceleration.getByText('가속 상태 확인 중...')).toHaveCount(0)
    await expect(acceleration.getByRole('button', { name: '다시 확인', exact: true })).toBeEnabled()
    await dialog.getByRole('spinbutton').fill('30')
    await dialog
      .getByRole('combobox', { name: '재생에 사용할 외부 플레이어', exact: true })
      .selectOption('auto')
    await dialog.getByRole('button', { name: '저장', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('캐시와 외부 플레이어 설정을 저장했습니다.')
    expect(
      await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.patches),
    ).toEqual([{ cacheLimitGb: 20 }, { cacheLimitGb: 30, nativePlayer: null }])
    await page.evaluate(() => {
      window.api.app.getAccelerationInfo = async () => ({
        ok: true,
        value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'enabled' },
      })
    })
    await acceleration.getByRole('button', { name: '다시 확인', exact: true }).click()
    await expect(acceleration.getByTestId('video-decode-status')).toHaveText(
      '하드웨어 가속 사용 가능',
    )
    await expect(acceleration.getByText(/가속 상태를 확인하지 못했습니다/)).toHaveCount(0)
  })
}

test('cache settings validate the range and save only the edited setting', async ({ page }) => {
  await prepareSettings(page)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await expect(dialog.getByTestId('cache-usage')).toHaveText('2 GB / 10 GB')
  await expect(dialog.getByText(/보호 캐시 512 MB/)).toBeVisible()
  const input = dialog.getByRole('spinbutton', { name: '캐시 용량 상한 (GB)' })
  const save = dialog.getByRole('button', { name: '저장', exact: true })
  await expect(save).toBeDisabled()
  for (const invalid of ['0', '1001', '']) {
    await input.fill(invalid)
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(save).toBeDisabled()
  }
  await input.fill('1.5')
  await save.click()
  await expect(dialog.getByRole('status')).toHaveText('캐시 용량 상한을 저장했습니다.')
  await expect(dialog.getByTestId('cache-usage')).toHaveText('2 GB / 1.5 GB')
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as SettingsWindow).settingsHarness
      return { patches: state.patches, nativePlayer: state.settings.nativePlayer }
    }),
  ).toEqual({
    patches: [{ cacheLimitGb: 1.5 }],
    nativePlayer: { name: 'mpv', path: 'C:\\Apps\\mpv.exe' },
  })
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(input).toHaveValue('1.5')
})

test('native settings select detected and manual players, apply only on save, and allow automatic selection', async ({
  page,
}) => {
  await prepareSettings(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  const card = page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
  await card.dblclick()
  await expect(page.getByRole('button', { name: 'mpv로 열기', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  const choice = dialog.getByRole('combobox', { name: '재생에 사용할 외부 플레이어', exact: true })
  await expect(dialog.getByTestId('saved-native-player')).toHaveText('mpv · C:\\Apps\\mpv.exe')
  await choice.selectOption('vlc:C:\\Apps\\vlc.exe')
  await expect(dialog.getByTestId('saved-native-player')).toHaveText('mpv · C:\\Apps\\mpv.exe')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('외부 플레이어 설정을 저장했습니다.')
  expect(
    await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.patches),
  ).toEqual([{ nativePlayer: { name: 'vlc', path: 'C:\\Apps\\vlc.exe' } }])
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  await card.dblclick()
  await expect(page.getByRole('button', { name: 'VLC로 열기', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await dialog
    .getByRole('combobox', { name: '직접 지정할 플레이어', exact: true })
    .selectOption('ffplay')
  await dialog.getByRole('button', { name: '실행 파일 선택', exact: true }).click()
  await expect(choice).toHaveValue('ffplay:D:\\Players\\ffplay.exe')
  await expect(dialog.getByTestId('saved-native-player')).toHaveText('vlc · C:\\Apps\\vlc.exe')
  await dialog.getByRole('spinbutton').fill('30')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('캐시와 외부 플레이어 설정을 저장했습니다.')
  await page.evaluate(() => {
    ;(window as unknown as SettingsWindow).settingsHarness.selectedFile = null
  })
  await dialog.getByRole('button', { name: '실행 파일 선택', exact: true }).click()
  await expect(choice).toHaveValue('ffplay:D:\\Players\\ffplay.exe')
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  await choice.selectOption('auto')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByTestId('saved-native-player')).toHaveText('자동 선택')
  expect(
    await page.evaluate(() => {
      const state = (window as unknown as SettingsWindow).settingsHarness
      return { patches: state.patches, pickerCalls: state.pickerCalls }
    }),
  ).toEqual({
    patches: [
      { nativePlayer: { name: 'vlc', path: 'C:\\Apps\\vlc.exe' } },
      { cacheLimitGb: 30, nativePlayer: { name: 'ffplay', path: 'D:\\Players\\ffplay.exe' } },
      { nativePlayer: null },
    ],
    pickerCalls: ['ffplay', 'ffplay'],
  })
})

test('native discovery and file picker failures remain recoverable', async ({ page }) => {
  await prepareSettings(page)
  await page.evaluate(() => {
    const state = (window as unknown as SettingsWindow).settingsHarness
    state.failDetection = true
    state.failPicker = true
  })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await expect(dialog.getByRole('alert')).toHaveText('플레이어 검색 테스트 실패')
  await page.evaluate(() => {
    ;(window as unknown as SettingsWindow).settingsHarness.failDetection = false
  })
  await dialog.getByRole('button', { name: '플레이어 다시 검색', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: '실행 파일 선택', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('실행 파일 선택 테스트 실패')
  await expect(dialog.getByRole('button', { name: '실행 파일 선택', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
})

interface NativeHarness {
  starts: number
  ends: number
  heartbeats: number
  launchCalls: number
  finishLaunch: (success: boolean) => void
}
type NativeWindow = Window & { nativeHarness: NativeHarness }

for (const extension of ['mp4', 'avi']) {
  test(`failed native launch preserves ${extension} in-app playback and tracking`, async ({
    page,
  }) => {
    await prepareSettings(page)
    await page.evaluate(async (ext) => {
      const result = await window.api.videos.get('mock-library', 'mock-video-1')
      if (!result.ok || !result.value) throw new Error('Missing video')
      result.value.filePath = `/mock/sample.${ext}`
      const state: NativeHarness = {
        starts: 0,
        ends: 0,
        heartbeats: 0,
        launchCalls: 0,
        finishLaunch: () => undefined,
      }
      ;(window as unknown as NativeWindow).nativeHarness = state
      window.api.playback.start = async () => {
        state.starts += 1
        return { ok: true, value: 'test-session' }
      }
      window.api.playback.end = async () => {
        state.ends += 1
        return { ok: true, value: null }
      }
      window.api.playback.heartbeat = async () => {
        state.heartbeats += 1
        return { ok: true, value: null }
      }
      window.api.videos.openInNativePlayer = async () => {
        state.launchCalls += 1
        return new Promise((resolve) => {
          state.finishLaunch = (success) =>
            resolve(
              success
                ? { ok: true, value: { name: 'mpv', path: 'C:\\Apps\\mpv.exe' } }
                : { ok: false, error: '플레이어 실행 테스트 실패' },
            )
        })
      }
    }, extension)
    await page.getByRole('button', { name: '열기', exact: true }).click()
    await page
      .getByRole('button')
      .filter({ has: page.getByText('Sample video', { exact: true }) })
      .dblclick()
    await expect(
      page.getByRole('button', { name: 'mpv로 열기', exact: true }).first(),
    ).toBeVisible()
    const beforeLaunch = await page.evaluate(() => {
      const state = (window as unknown as NativeWindow).nativeHarness
      return { starts: state.starts, ends: state.ends }
    })
    await page.getByRole('button', { name: 'mpv로 열기', exact: true }).first().click()
    await expect(page.getByRole('status')).toHaveText(
      '외부 플레이어 실행 결과를 기다리고 있습니다...',
    )
    await expect(page.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
    if (extension === 'mp4')
      await expect(page.locator('video')).toHaveAttribute('src', /sample.mp4/)
    await page.keyboard.press('Escape')
    await expect(page.locator('video')).toBeVisible()
    await page.evaluate(() => (window as unknown as NativeWindow).nativeHarness.finishLaunch(false))
    await expect(page.getByRole('alert')).toContainText('플레이어 실행 테스트 실패')
    await expect(page.getByRole('slider', { name: '재생 위치', exact: true })).toBeVisible()
    await expect(page.locator('video')).toHaveAttribute('src', /sample/)
    await page.locator('video').evaluate((video) => video.dispatchEvent(new Event('pause')))
    const afterFailure = await page.evaluate(() => {
      const state = (window as unknown as NativeWindow).nativeHarness
      return { starts: state.starts, ends: state.ends, heartbeats: state.heartbeats }
    })
    expect(afterFailure.starts).toBe(beforeLaunch.starts + (extension === 'avi' ? 1 : 0))
    expect(afterFailure.ends).toBe(beforeLaunch.ends)
    expect(afterFailure.heartbeats).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'mpv로 열기', exact: true }).first().click()
    await page.evaluate(() => (window as unknown as NativeWindow).nativeHarness.finishLaunch(true))
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('video')).not.toHaveAttribute('src')
    await expect(page.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as NativeWindow).nativeHarness.ends)).toBe(
      beforeLaunch.ends,
    )
  })
}

test('cleanup requires confirmation, protects pending work, and reports the result', async ({
  page,
}) => {
  await prepareSettings(page)
  await page.evaluate(() => {
    ;(window as unknown as SettingsWindow).settingsHarness.deferCleanup = true
  })
  const settingsButton = page.getByRole('button', { name: '설정', exact: true })
  await settingsButton.click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  const clean = dialog.getByRole('button', { name: '사용하지 않는 캐시 정리', exact: true })
  await expect(dialog.getByText(/원본 동영상과 캡처 이미지는 보존/)).toBeVisible()
  await expect(dialog.getByText(/용량 상한을 일시적으로 초과/)).toBeVisible()
  await clean.click()
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(clean).toBeFocused()
  expect(
    await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.cleanCalls),
  ).toBe(0)
  await clean.click()
  await dialog.getByRole('button', { name: '캐시 정리 확인', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '정리 중...', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.finishCleanup())
  await expect(dialog.getByRole('status')).toHaveText('캐시 파일 3개, 1.5 GB를 정리했습니다.')
  await expect(dialog.getByTestId('cache-usage')).toHaveText('512 MB / 10 GB')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(settingsButton).toBeFocused()
  expect(
    await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.quitCalls),
  ).toBe(0)
})

test('load, save, and cleanup failures are visible and permit retry', async ({ page }) => {
  await prepareSettings(page)
  await page.evaluate(() => {
    ;(window as unknown as SettingsWindow).settingsHarness.failLoad = true
  })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await expect(dialog.getByRole('alert')).toHaveText('설정을 불러올 수 없습니다.')
  await page.evaluate(() => {
    const state = (window as unknown as SettingsWindow).settingsHarness
    state.failLoad = false
    state.failSave = true
    state.failCleanup = true
  })
  await dialog.getByRole('button', { name: '다시 시도', exact: true }).click()
  await dialog.getByRole('spinbutton').fill('20')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('설정 저장 테스트 실패')
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '사용하지 않는 캐시 정리', exact: true }).click()
  await dialog.getByRole('button', { name: '캐시 정리 확인', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('캐시 정리 테스트 실패')
  await expect(dialog.getByRole('button', { name: '캐시 정리 확인', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeEnabled()
})

test('settings fit a 900 by 600 window and retain keyboard focus inside the modal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await prepareSettings(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByText('Sample video', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await dialog.getByRole('button', { name: '사용하지 않는 캐시 정리', exact: true }).click()
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      fitsWidth: element.scrollWidth <= element.clientWidth,
      scrollable: element.scrollHeight > element.clientHeight,
    }
  })
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(600)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(900)
  expect(geometry.fitsWidth).toBe(true)
  expect(geometry.scrollable).toBe(true)
  await dialog.getByRole('button', { name: '캐시 정리 확인', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: '캐시 정리 확인', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as SettingsWindow).settingsHarness.quitCalls),
  ).toBe(0)
})

interface SourceHarness {
  calls: number
  resolvers: Array<(path: string) => void>
}
type SourceWindow = Window & { sourceHarness: SourceHarness }

for (const firstSourceReady of [true, false]) {
  test(`a new playback view reacquires its source after leaving a ${firstSourceReady ? 'ready' : 'pending'} conversion`, async ({
    page,
  }) => {
    await prepareSettings(page)
    await page.evaluate(async () => {
      const result = await window.api.videos.get('mock-library', 'mock-video-1')
      if (!result.ok || !result.value) throw new Error('Missing video')
      result.value.filePath = '/mock/sample.avi'
      const state: SourceHarness = { calls: 0, resolvers: [] }
      ;(window as unknown as SourceWindow).sourceHarness = state
      window.api.videos.getPlaybackSource = async () => {
        state.calls += 1
        return new Promise((resolve) =>
          state.resolvers.push((path) => resolve({ ok: true, value: path })),
        )
      }
    })
    await page.getByRole('button', { name: '열기', exact: true }).click()
    const card = page
      .getByRole('button')
      .filter({ has: page.getByText('Sample video', { exact: true }) })
    await card.dblclick()
    await page.getByRole('button', { name: '인앱 플레이어로 시도', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.calls))
      .toBe(1)
    if (firstSourceReady) {
      await page.evaluate(() =>
        (window as unknown as SourceWindow).sourceHarness.resolvers[0](
          '/cache/previous-session.mp4',
        ),
      )
      await expect(page.locator('video')).toHaveAttribute('src', /previous-session.mp4/)
    }
    await page.getByRole('button', { name: '닫기', exact: true }).click()
    await card.dblclick()
    await page.getByRole('button', { name: '인앱 플레이어로 시도', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.calls))
      .toBe(2)
    await expect(page.locator('video')).not.toHaveAttribute('src')
    const currentVideo = await page.locator('video').elementHandle()
    if (!firstSourceReady) {
      await page.evaluate(() =>
        (window as unknown as SourceWindow).sourceHarness.resolvers[0](
          '/cache/previous-session.mp4',
        ),
      )
      await expect(page.locator('video')).not.toHaveAttribute('src')
    }
    await page.evaluate(() =>
      (window as unknown as SourceWindow).sourceHarness.resolvers[1]('/cache/new-session.mp4'),
    )
    await expect(page.locator('video')).toHaveAttribute('src', /new-session.mp4/)
    expect(await currentVideo!.evaluate((video) => video === document.querySelector('video'))).toBe(
      true,
    )
    await page.getByRole('button', { name: 'mpv로 열기', exact: true }).click()
    await page.getByRole('button', { name: '인앱 플레이어로 시도', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SourceWindow).sourceHarness.calls))
      .toBe(3)
    await expect(page.locator('video')).not.toHaveAttribute('src')
    await page.evaluate(() =>
      (window as unknown as SourceWindow).sourceHarness.resolvers[2](
        '/cache/return-from-native.mp4',
      ),
    )
    await expect(page.locator('video')).toHaveAttribute('src', /return-from-native.mp4/)
  })
}
