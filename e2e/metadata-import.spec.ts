import { expect, test, type Page } from '@playwright/test'

async function openImport(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  await page.getByRole('button', { name: 'Stash에서 정보 가져오기', exact: true }).click()
  return page.getByRole('dialog', { name: 'Stash에서 정보 가져오기' })
}
async function enableStash(page: Page) {
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Stash 연결 사용').check()
  await dialog.getByLabel('Stash 서버 주소', { exact: true }).fill('http://localhost:9999')
  await dialog.getByRole('button', { name: '연결 설정 저장' }).click()
  await expect(dialog.getByRole('button', { name: 'Stash에서 후보 조회' })).toBeEnabled()
}
async function chooseCandidate(page: Page) {
  await page.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await page.getByRole('button', { name: /예시 영상 제목/ }).click()
}
async function currentVideo(page: Page) {
  return page.evaluate(async () => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing fixture')
    return result.value
  })
}

test('requires explicit enabled settings and lookup; key is cleared from the form after save', async ({
  page,
}) => {
  const dialog = await openImport(page)
  await page.evaluate(() => {
    const original = window.api.metadataImport.search
    ;(window as unknown as { searches: string[] }).searches = []
    window.api.metadataImport.search = async (query) => {
      ;(window as unknown as { searches: string[] }).searches.push(query)
      return original(query)
    }
  })
  await expect(dialog.getByRole('button', { name: 'Stash에서 후보 조회' })).toBeDisabled()
  await dialog.getByLabel('Stash API 키', { exact: true }).fill('test-placeholder-key')
  await enableStash(page)
  await expect(dialog.getByLabel('Stash API 키', { exact: true })).toHaveValue('')
  expect(await page.evaluate(() => (window as unknown as { searches: string[] }).searches)).toEqual(
    [],
  )
  await chooseCandidate(page)
  expect(await page.evaluate(() => (window as unknown as { searches: string[] }).searches)).toEqual(
    ['sample'],
  )
  await expect(dialog.getByRole('button', { name: '선택한 항목 적용' })).toBeDisabled()
  await expect(dialog.getByLabel('가져올 태그')).toHaveValue('demo, sample, 예시, 인터뷰')
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  expect(await currentVideo(page)).toMatchObject({
    title: 'Sample video',
    memo: 'Browser mock IPC sample',
    tags: 'demo, sample',
  })
})

test('edits selected metadata, explicitly adds people to tags, preserves unselected values and can undo', async ({
  page,
}) => {
  const dialog = await openImport(page)
  await enableStash(page)
  await chooseCandidate(page)
  await dialog.getByLabel('가져올 제목').fill('수정한 제목')
  await dialog.getByLabel('제목 적용', { exact: true }).check()
  await dialog.getByRole('button', { name: '인물 이름을 태그에 추가' }).click()
  await dialog.getByLabel('태그 적용', { exact: true }).check()
  await dialog.getByRole('button', { name: '선택한 항목 적용' }).click()
  await expect(dialog.getByRole('button', { name: '방금 적용 되돌리기' })).toBeVisible()
  expect(await currentVideo(page)).toMatchObject({
    title: '수정한 제목',
    memo: 'Browser mock IPC sample',
    tags: 'demo, sample, 예시, 인터뷰, 예시 인물',
    rating: 4,
  })
  await dialog.getByRole('button', { name: '방금 적용 되돌리기' }).click()
  await expect(dialog.getByText('방금 적용한 항목을 이전 값으로 되돌렸습니다.')).toBeVisible()
  expect(await currentVideo(page)).toMatchObject({
    title: 'Sample video',
    memo: 'Browser mock IPC sample',
    tags: 'demo, sample',
    rating: 4,
  })
})

test('provides explicit exact-code lookup separately from filename text search', async ({
  page,
}) => {
  const dialog = await openImport(page)
  await enableStash(page)
  await dialog.getByLabel('조회 방식').selectOption('code')
  await dialog.getByLabel('조회할 파일명 또는 식별자').fill('UNKNOWN')
  await dialog.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await expect(dialog.getByText(/일치하는 후보가 없습니다/)).toBeVisible()
  await dialog.getByLabel('조회할 파일명 또는 식별자').fill('DEMO-001')
  await dialog.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await expect(dialog.getByRole('button', { name: /예시 영상 제목/ })).toBeVisible()
})

test('refuses conflicting metadata without partial writes', async ({ page }) => {
  const dialog = await openImport(page)
  await enableStash(page)
  await chooseCandidate(page)
  await dialog.getByLabel('제목 적용', { exact: true }).check()
  await dialog.getByLabel('설명을 메모에 적용', { exact: true }).check()
  await page.evaluate(() =>
    window.api.videos.updateMeta('mock-library', 'mock-video-1', { memo: '별도로 수정한 메모' }),
  )
  await dialog.getByRole('button', { name: '선택한 항목 적용' }).click()
  await expect(dialog.getByRole('alert')).toContainText('미리보기 이후 변경')
  expect(await currentVideo(page)).toMatchObject({
    title: 'Sample video',
    memo: '별도로 수정한 메모',
    tags: 'demo, sample',
  })
})

test('shows empty and failed lookups without applying data', async ({ page }) => {
  const dialog = await openImport(page)
  await enableStash(page)
  await page.evaluate(() => {
    window.api.metadataImport.search = async () => ({
      ok: true,
      value: { candidates: [], total: 0 },
    })
  })
  await dialog.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await expect(dialog.getByText(/일치하는 후보가 없습니다/)).toBeVisible()
  await page.evaluate(() => {
    window.api.metadataImport.search = async () => ({
      ok: false,
      error: 'Stash 조회 제한 시간 초과',
    })
  })
  await dialog.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await expect(dialog.getByRole('alert')).toContainText('제한 시간')
  await expect(dialog.getByRole('button', { name: '선택한 항목 적용' })).toHaveCount(0)
  expect((await currentVideo(page)).title).toBe('Sample video')
})

test('flushes a pending local memo before preview and preserves it on a title-only import', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .click()
  await page
    .getByPlaceholder('이 영상에 대한 메모를 적어보세요...')
    .fill('아직 저장 대기 중인 메모')
  await page.getByRole('button', { name: 'Stash에서 정보 가져오기' }).click()
  await enableStash(page)
  await chooseCandidate(page)
  await page.getByLabel('제목 적용', { exact: true }).check()
  await page.getByRole('button', { name: '선택한 항목 적용' }).click()
  await expect(page.getByRole('button', { name: '방금 적용 되돌리기' })).toBeVisible()
  expect(await currentVideo(page)).toMatchObject({
    title: '예시 영상 제목',
    memo: '아직 저장 대기 중인 메모',
  })
})

test('renders provider strings as text and Escape closes only the dialog in the player', async ({
  page,
}) => {
  await page.goto('/#/player/mock-library/mock-video-1')
  await page.getByRole('button', { name: '정보', exact: true }).click()
  await page.getByRole('button', { name: 'Stash에서 정보 가져오기' }).click()
  await enableStash(page)
  await page.evaluate(() => {
    window.api.metadataImport.search = async () => ({
      ok: true,
      value: {
        total: 1,
        candidates: [
          {
            id: 'html',
            title: '<img src=x onerror=alert(1)>',
            description: '<script>alert(1)</script>',
            tags: [],
            people: [],
            studio: '',
            code: '',
            date: '',
          },
        ],
      },
    })
  })
  await page.getByRole('button', { name: 'Stash에서 후보 조회' }).click()
  await page.getByRole('button', { name: /<img src=x/ }).click()
  await expect(page.getByLabel('가져올 메모')).toHaveValue('<script>alert(1)</script>')
  await expect(page.getByRole('dialog').locator('img, script')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).focus()
  await page.keyboard.press('h')
  expect(
    await page.evaluate(async () => {
      const response = await window.api.highlights.list('mock-library', 'mock-video-1')
      return response.ok ? response.value.length : -1
    }),
  ).toBe(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/player\/mock-library\/mock-video-1/)
})
