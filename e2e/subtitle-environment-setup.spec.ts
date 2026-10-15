import { expect, test, type Page } from '@playwright/test'
import type { SubtitleSetupStatus } from '../src/shared/types'

interface SetupHarness {
  status: SubtitleSetupStatus
  starts: number
  checks: number
  cancels: number
  statusReads: number
  engineReads: number
  failStatus: boolean
  failStart: boolean
  failCancel: boolean
}
type SetupWindow = Window & { setupHarness: SetupHarness }

async function prepareSetup(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const state: SetupHarness = {
      status: {
        phase: 'idle',
        message: '필요한 자막 환경을 준비해 주세요.',
        updatedAt: new Date().toISOString(),
        canCancel: true,
        components: [
          { id: 'whisper', label: 'Whisper 음성 인식', state: 'ready' },
          { id: 'speechModel', label: '기본 음성 모델', state: 'missing' },
          { id: 'wsl', label: 'Windows 자막 실행 환경', state: 'missing' },
          { id: 'python', label: '자막 처리 도구', state: 'missing' },
          { id: 'ollama', label: 'Ollama PC 번역', state: 'missing' },
          { id: 'translationModel', label: 'qwen3:8b 번역 모델', state: 'missing' },
        ],
      },
      starts: 0,
      checks: 0,
      cancels: 0,
      statusReads: 0,
      engineReads: 0,
      failStatus: false,
      failStart: false,
      failCancel: false,
    }
    ;(window as unknown as SetupWindow).setupHarness = state
    window.api.subtitles.getSetupStatus = async () => {
      state.statusReads += 1
      if (state.failStatus) throw new Error('설치 상태를 읽지 못했습니다.')
      return { ok: true, value: structuredClone(state.status) }
    }
    window.api.subtitles.checkSetup = async () => {
      state.checks += 1
      state.status = {
        ...state.status,
        phase: 'checking',
        message: '설치된 환경을 확인하고 있습니다.',
        updatedAt: new Date().toISOString(),
      }
      return { ok: true, value: structuredClone(state.status) }
    }
    window.api.subtitles.startSetup = async () => {
      state.starts += 1
      if (state.failStart) return { ok: false, error: '다운로드를 시작하지 못했습니다.' }
      state.status = {
        ...state.status,
        phase: 'installing',
        message: '필요한 프로그램과 모델을 준비합니다.',
        updatedAt: new Date().toISOString(),
        components: state.status.components.map((component) =>
          component.id === 'speechModel'
            ? { ...component, state: 'installing', percent: 35 }
            : component,
        ),
      }
      return { ok: true, value: structuredClone(state.status) }
    }
    window.api.subtitles.cancelSetup = async () => {
      state.cancels += 1
      if (state.failCancel) throw new Error('취소 요청을 전달하지 못했습니다.')
      state.status = {
        ...state.status,
        phase: 'cancelled',
        message: '설치를 취소했습니다. 완료된 항목은 유지합니다.',
        updatedAt: new Date().toISOString(),
      }
      return { ok: true, value: true }
    }
    window.api.subtitles.getEngineInfo = async () => {
      state.engineReads += 1
      return {
        ok: true,
        value: {
          available: state.status.phase === 'ready',
          message:
            state.status.phase === 'ready'
              ? '자막을 생성할 수 있습니다.'
              : '자막 환경을 준비해 주세요.',
        },
      }
    }
  })
}

const setupPanel = (page: Page) =>
  page.getByRole('region', { name: '자막 환경 자동 설치', exact: true })
const generationPanel = (page: Page) =>
  page.getByRole('region', { name: 'AI 자막 생성', exact: true })
const sampleCard = (page: Page) =>
  page.getByRole('button').filter({ has: page.getByText('Sample video', { exact: true }) })

async function completeSetup(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.status = {
      ...state.status,
      phase: 'ready',
      message: '자막 생성과 한국어 번역을 사용할 수 있습니다.',
      updatedAt: new Date().toISOString(),
      components: state.status.components.map((component) => ({
        ...component,
        state: 'ready',
        percent: undefined,
      })),
    }
  })
}

test('offers global setup without a library, polls progress and preserves the job when changing tabs', async ({
  page,
}) => {
  await prepareSetup(page)
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = setupPanel(page)
  await expect(
    panel.getByRole('list', { name: '자막 환경 준비 상태' }).getByRole('listitem'),
  ).toHaveCount(6)
  await expect(panel).toContainText('15GB')
  await expect(panel).toContainText('관리자 승인')
  await expect(panel).toContainText('Ubuntu 계정은 보통 앱이 준비합니다.')
  expect(await page.evaluate(() => (window as unknown as SetupWindow).setupHarness.starts)).toBe(0)
  await panel.getByRole('button', { name: '자막 환경 자동 설치', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '자막 환경 설치 중...', exact: true }),
  ).toBeDisabled()
  await expect(panel.getByRole('button', { name: '환경 다시 확인', exact: true })).toBeDisabled()
  await expect(
    panel.getByRole('progressbar', { name: '기본 음성 모델 설치 진행률' }),
  ).toHaveAttribute('value', '35')
  await page.evaluate(() => {
    const model = (window as unknown as SetupWindow).setupHarness.status.components.find(
      (item) => item.id === 'speechModel',
    )!
    model.percent = 70
  })
  await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '70')
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '70')
  expect(await page.evaluate(() => (window as unknown as SetupWindow).setupHarness.starts)).toBe(1)
  await completeSetup(page)
  await expect(panel.getByRole('status')).toContainText(
    '자막 생성과 한국어 번역을 사용할 수 있습니다.',
  )
  await expect(panel.getByRole('progressbar')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '설치 취소', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '환경 다시 확인', exact: true })).toBeEnabled()
})

test('opens setup from unavailable video controls and refreshes engine readiness on completion', async ({
  page,
}) => {
  await prepareSetup(page)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await sampleCard(page).click()
  await expect(
    generationPanel(page).getByRole('button', { name: '자막 생성 시작', exact: true }),
  ).toBeDisabled()
  const reads = await page.evaluate(
    () => (window as unknown as SetupWindow).setupHarness.engineReads,
  )
  await generationPanel(page)
    .getByRole('link', { name: '자막 환경 자동 설치 열기', exact: true })
    .click()
  await expect(setupPanel(page)).toBeVisible()
  await setupPanel(page).getByRole('button', { name: '자막 환경 자동 설치', exact: true }).click()
  await completeSetup(page)
  await expect(setupPanel(page).getByRole('status')).toContainText(
    '자막 생성과 한국어 번역을 사용할 수 있습니다.',
  )
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await sampleCard(page).click()
  await expect(
    generationPanel(page).getByRole('button', { name: '자막 생성 시작', exact: true }),
  ).toBeEnabled()
  expect(
    await page.evaluate(() => (window as unknown as SetupWindow).setupHarness.engineReads),
  ).toBeGreaterThan(reads)
})

test('shows cancel errors, cancels safely and allows continuing the installation', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareSetup(page)
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = setupPanel(page)
  await panel.getByRole('button', { name: '자막 환경 자동 설치', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as SetupWindow).setupHarness.failCancel = true
  })
  await panel.getByRole('button', { name: '설치 취소', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('취소 요청을 전달하지 못했습니다.')
  await page.evaluate(() => {
    ;(window as unknown as SetupWindow).setupHarness.failCancel = false
  })
  await panel.getByRole('button', { name: '설치 취소', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('완료된 항목은 유지합니다.')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByRole('button', { name: '설치 이어서 진행', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '자막 환경 설치 중...', exact: true }),
  ).toBeDisabled()
  expect(await page.evaluate(() => (window as unknown as SetupWindow).setupHarness.starts)).toBe(2)
  expect(errors).toEqual([])
})

test('handles status and download failures and asynchronous environment rechecks', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareSetup(page)
  await page.evaluate(() => {
    ;(window as unknown as SetupWindow).setupHarness.failStatus = true
  })
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = setupPanel(page)
  await expect(panel.getByRole('alert')).toHaveText('설치 상태를 읽지 못했습니다.')
  await page.evaluate(() => {
    ;(window as unknown as SetupWindow).setupHarness.failStatus = false
  })
  await panel.getByRole('button', { name: '환경 다시 확인', exact: true }).click()
  await expect(panel.getByRole('button', { name: '환경 확인 중...', exact: true })).toBeDisabled()
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.failStart = true
    state.status.phase = 'idle'
    state.status.message = '번역 모델 설치가 필요합니다.'
  })
  await expect(
    panel.getByRole('button', { name: '자막 환경 자동 설치', exact: true }),
  ).toBeEnabled()
  await panel.getByRole('button', { name: '자막 환경 자동 설치', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('다운로드를 시작하지 못했습니다.')
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.failStart = false
    state.status.phase = 'failed'
    state.status.message = '네트워크 연결을 확인한 뒤 다시 시도해 주세요.'
  })
  await panel.getByRole('button', { name: '환경 다시 확인', exact: true }).click()
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.status.phase = 'failed'
    state.status.message = '네트워크 연결을 확인한 뒤 다시 시도해 주세요.'
  })
  await expect(panel.getByRole('alert')).toHaveText('네트워크 연결을 확인한 뒤 다시 시도해 주세요.')
  await panel.getByRole('button', { name: '설치 다시 시도', exact: true }).click()
  await expect(panel.getByRole('button', { name: '설치 취소', exact: true })).toBeEnabled()
  expect(errors).toEqual([])
})

test('disables cancellation during Windows preparation and explains restart continuation', async ({
  page,
}) => {
  await prepareSetup(page)
  await page.getByRole('link', { name: '자막 생성', exact: true }).click()
  const panel = setupPanel(page)
  await panel.getByRole('button', { name: '자막 환경 자동 설치', exact: true }).click()
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.status.canCancel = false
    state.status.message = 'Windows에서 자막 실행 환경을 준비하고 있습니다.'
  })
  await expect(panel.getByRole('button', { name: '설치 취소', exact: true })).toBeDisabled()
  await expect(panel).toContainText('진행 중인 단계가 끝날 때까지 기다려 주세요.')
  await page.evaluate(() => {
    const state = (window as unknown as SetupWindow).setupHarness
    state.status.phase = 'restart-required'
    state.status.message = 'Windows를 재시작해야 합니다.'
    state.status.canCancel = true
  })
  await expect(panel).toContainText('열어 둔 작업을 저장하고 Windows를 재시작한 뒤')
  await expect(panel.getByRole('button', { name: '설치 취소', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '설치 이어서 진행', exact: true }).click()
  await expect(panel.getByRole('button', { name: '설치 취소', exact: true })).toBeEnabled()
})
