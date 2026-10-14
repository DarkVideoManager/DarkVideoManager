import { expect, test, type Page } from '@playwright/test'

interface TranslationHarness {
  settings: {
    enabled: boolean
    hasApiKey: boolean
    monthlyLimit: number
    month: string
    usedCharacters: number
    externalCharacters: number
    remainingCharacters: number
    storageError?: string
  }
  updates: Record<string, unknown>[]
  failLoad: boolean
  failSave: boolean
  quitCalls: number
}
type TranslationWindow = Window & { translationHarness: TranslationHarness }

async function prepare(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    const state: TranslationHarness = {
      settings: {
        enabled: true,
        hasApiKey: false,
        monthlyLimit: 500_000,
        month: '2026-10',
        usedCharacters: 125_000,
        externalCharacters: 20_000,
        remainingCharacters: 355_000,
      },
      updates: [],
      failLoad: false,
      failSave: false,
      quitCalls: 0,
    }
    ;(window as unknown as TranslationWindow).translationHarness = state
    window.api.subtitles.getTranslationSettings = async () =>
      state.failLoad
        ? { ok: false, error: '설정 조회 실패' }
        : { ok: true, value: structuredClone(state.settings) }
    window.api.subtitles.updateTranslationSettings = async (patch) => {
      state.updates.push({ ...patch })
      if (state.failSave) return { ok: false, error: '설정 저장 실패' }
      if (patch.enabled !== undefined) state.settings.enabled = patch.enabled
      if (patch.removeApiKey) state.settings.hasApiKey = false
      else if (patch.apiKey?.trim()) state.settings.hasApiKey = true
      if (patch.monthlyLimit !== undefined) state.settings.monthlyLimit = patch.monthlyLimit
      if (patch.externalCharacters !== undefined)
        state.settings.externalCharacters = patch.externalCharacters
      state.settings.remainingCharacters = Math.max(
        0,
        state.settings.monthlyLimit -
          state.settings.usedCharacters -
          state.settings.externalCharacters,
      )
      return { ok: true, value: structuredClone(state.settings) }
    }
    window.api.app.quit = async () => {
      state.quitCalls += 1
      return { ok: true, value: null }
    }
  })
}

const panel = (page: Page) => page.getByRole('region', { name: '한국어 번역 설정', exact: true })
const open = (page: Page) => page.getByRole('link', { name: '자막 생성', exact: true }).click()

test('registers a write-only key, preserves it when blank, and deletes it to use Ollama', async ({
  page,
}) => {
  await prepare(page)
  await open(page)
  const settings = panel(page)
  const key = settings.getByLabel('Google Cloud API 키', { exact: true })
  await expect(settings.getByLabel('저장된 번역 경로')).toHaveText(
    'API 키가 없어 Ollama를 사용합니다.',
  )
  await expect(key).toHaveAttribute('type', 'password')
  await expect(key).toHaveValue('')
  await key.fill('mock-key-for-ui-test')
  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(
      () => (window as unknown as TranslationWindow).translationHarness.quitCalls,
    ),
  ).toBe(0)
  await settings.getByRole('button', { name: '번역 설정 저장', exact: true }).click()
  await expect(settings.getByRole('status')).toHaveText('번역 설정을 저장했습니다.')
  await expect(key).toHaveValue('')
  await expect(settings.getByLabel('저장된 번역 경로')).toContainText(
    'Google Cloud Translation 우선',
  )
  await expect(settings).not.toContainText('mock-key-for-ui-test')
  const saved = await page.evaluate(() => window.api.subtitles.getTranslationSettings())
  expect(saved).toMatchObject({ ok: true, value: { hasApiKey: true } })
  expect(JSON.stringify(saved)).not.toContain('mock-key-for-ui-test')
  await settings.getByLabel('월 사용 한도 (자)', { exact: true }).fill('300000')
  await settings.getByRole('button', { name: '번역 설정 저장', exact: true }).click()
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('155,000자')
  const patches = await page.evaluate(
    () => (window as unknown as TranslationWindow).translationHarness.updates,
  )
  expect(patches[1]).not.toHaveProperty('apiKey')
  await page.getByRole('link', { name: '라이브러리', exact: true }).click()
  await open(page)
  await expect(key).toHaveValue('')
  await expect(settings.getByText('API 키 저장됨', { exact: false })).toBeVisible()
  await settings.getByRole('button', { name: '저장된 API 키 삭제', exact: true }).click()
  await expect(settings.getByLabel('저장된 번역 경로')).toHaveText(
    'API 키가 없어 Ollama를 사용합니다.',
  )
  await expect(
    settings.getByRole('button', { name: '저장된 API 키 삭제', exact: true }),
  ).toHaveCount(0)
})

test('shows shared usage, switches at the limit or when disabled, and preserves unsaved edits while refreshing', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as TranslationWindow).translationHarness.settings.hasApiKey = true
  })
  await open(page)
  const settings = panel(page)
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('125,000자')
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('20,000자')
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('355,000자')
  await settings.getByLabel('이번 달 다른 앱·프로젝트 사용량 (자)', { exact: true }).fill('400000')
  await page.evaluate(() => {
    const state = (window as unknown as TranslationWindow).translationHarness
    state.settings.usedCharacters = 130_000
    state.settings.remainingCharacters = 350_000
  })
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('130,000자', {
    timeout: 8000,
  })
  await expect(
    settings.getByLabel('이번 달 다른 앱·프로젝트 사용량 (자)', { exact: true }),
  ).toHaveValue('400000')
  await settings.getByRole('button', { name: '번역 설정 저장', exact: true }).click()
  await expect(settings.getByLabel('저장된 번역 경로')).toHaveText(
    '이번 달 사용 한도에 도달해 Ollama를 사용합니다.',
  )
  await expect(settings.getByLabel('이번 달 번역 사용량')).toContainText('0자')
  await settings.getByLabel('Google Cloud Translation 사용', { exact: true }).uncheck()
  await settings.getByRole('button', { name: '번역 설정 저장', exact: true }).click()
  await expect(settings.getByLabel('저장된 번역 경로')).toHaveText(
    'Cloud Translation이 꺼져 있어 Ollama를 사용합니다.',
  )
  await expect(settings.getByLabel('월 사용 한도 (자)', { exact: true })).toHaveAttribute(
    'max',
    '500000',
  )
  await expect(
    settings.getByText('이 앱의 한도 설정은 Google 계정 전체의 과금을 차단하지 않습니다.', {
      exact: false,
    }),
  ).toBeVisible()
})

test('reports settings read and write failures without claiming a save or changing the active provider', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as TranslationWindow).translationHarness.failLoad = true
  })
  await open(page)
  const settings = panel(page)
  await expect(settings.getByRole('alert')).toContainText('설정 조회 실패')
  await page.evaluate(() => {
    const state = (window as unknown as TranslationWindow).translationHarness
    state.failLoad = false
    state.failSave = true
  })
  await settings.getByRole('button', { name: '번역 설정 다시 확인', exact: true }).click()
  await settings.getByLabel('Google Cloud API 키', { exact: true }).fill('mock-rejected-key')
  await settings.getByRole('button', { name: '번역 설정 저장', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('설정 저장 실패')
  await expect(settings.getByLabel('저장된 번역 경로')).toHaveText(
    'API 키가 없어 Ollama를 사용합니다.',
  )
  await expect(settings.getByRole('status')).toHaveCount(0)
  expect(errors).toEqual([])
})
