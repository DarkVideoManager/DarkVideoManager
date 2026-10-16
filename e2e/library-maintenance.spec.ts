import { expect, test, type Page } from '@playwright/test'
import type { DuplicateResult, RenamePreview, RenameResult } from '../src/shared/maintenance'

interface Harness {
  previewCalls: { libraryId: string; prefix: string }[]
  applyCalls: { libraryId: string; previewId: string; videoIds: string[] }[]
  failApply: boolean
  delayScan: boolean
  releaseScan?: () => void
  cancelCalls: number
}
type MaintenanceWindow = Window & { maintenanceHarness: Harness }

async function prepare(page: Page, open = true) {
  await page.goto('/')
  await page.evaluate(() => {
    const state: Harness = {
      previewCalls: [],
      applyCalls: [],
      failApply: false,
      delayScan: false,
      cancelCalls: 0,
    }
    ;(window as unknown as MaintenanceWindow).maintenanceHarness = state
    window.api.maintenance.previewNames = async (libraryId, rule) => {
      state.previewCalls.push({ libraryId, prefix: rule.prefix })
      const preview: RenamePreview = {
        id: 'dd270470-14f8-45ed-af6e-f3b2da7c86d3',
        libraryId,
        expiresAt: '2099-01-01T00:00:00Z',
        truncated: false,
        rows: [
          {
            videoId: 'mock-video-1',
            fileName: '[ad] Sample video.mp4',
            nextName: 'Sample video.mp4',
            files: [
              {
                from: 'C:/Videos/[ad] Sample video.mp4',
                to: 'C:/Videos/Sample video.mp4',
                kind: 'video',
              },
              {
                from: 'C:/Videos/[ad] Sample video.ai.ko.srt',
                to: 'C:/Videos/Sample video.ai.ko.srt',
                kind: 'subtitle',
              },
            ],
          },
          {
            videoId: 'second',
            fileName: '[ad] Second.mp4',
            nextName: 'Second.mp4',
            files: [
              { from: 'C:/Videos/[ad] Second.mp4', to: 'C:/Videos/Second.mp4', kind: 'video' },
            ],
          },
          {
            videoId: 'locked',
            fileName: '[ad] Locked.mp4',
            nextName: 'Locked.mp4',
            files: [],
            error: '재생 중인 영상입니다.',
          },
        ],
      }
      return { ok: true, value: preview }
    }
    window.api.maintenance.applyNames = async (libraryId, previewId, videoIds) => {
      state.applyCalls.push({ libraryId, previewId, videoIds })
      if (state.failApply)
        return { ok: false, error: '미리보기가 만료되었습니다. 다시 미리보기해 주세요.' }
      const result: RenameResult = {
        cancelled: false,
        items: videoIds.map((videoId) => ({
          videoId,
          fileName: '[ad] Sample video.mp4',
          status: 'renamed',
          message: '파일명을 변경했습니다.',
        })),
      }
      return { ok: true, value: result }
    }
    window.api.maintenance.findDuplicates = async () => {
      if (state.delayScan)
        await new Promise<void>((resolve) => {
          state.releaseScan = resolve
        })
      const result: DuplicateResult = {
        checkedFiles: 3,
        cancelled: state.cancelCalls > 0,
        skipped: [
          { videoId: 'offline', fileName: 'offline.mp4', reason: '원본 파일을 찾을 수 없습니다.' },
        ],
        groups: [
          {
            sha256: 'a'.repeat(64),
            sizeBytes: 1024 * 1024,
            files: [
              {
                videoId: 'mock-video-1',
                fileName: 'Sample video.mp4',
                filePath: 'C:/Videos/Sample video.mp4',
                sizeBytes: 1024 * 1024,
              },
              {
                videoId: 'copy',
                fileName: 'Different name.mp4',
                filePath: 'D:/Archive/Different name.mp4',
                sizeBytes: 1024 * 1024,
              },
            ],
          },
        ],
      }
      return { ok: true, value: result }
    }
    window.api.maintenance.cancel = async () => {
      state.cancelCalls++
      state.releaseScan?.()
      return { ok: true, value: true }
    }
  })
  if (open) await page.getByRole('button', { name: '열기', exact: true }).click()
  await page.getByRole('link', { name: '파일 정리', exact: true }).click()
}
async function showPreview(page: Page) {
  await page.getByLabel('제거할 접두어').fill('[ad] ')
  await page.getByRole('button', { name: '미리보기', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(3)
}

test('requires an opened library before offering file changes', async ({ page }) => {
  await prepare(page, false)
  await expect(page.getByText('정리할 라이브러리를 먼저 열어 주세요.')).toBeVisible()
  await expect(page.getByRole('button', { name: '미리보기' })).toHaveCount(0)
})

test('previews original and subtitle names and applies only selected IDs after explicit confirmation', async ({
  page,
}) => {
  await prepare(page)
  await expect(page.getByRole('button', { name: '미리보기' })).toBeDisabled()
  await showPreview(page)
  const first = page.getByRole('article', {
    name: '[ad] Sample video.mp4 파일명 변경',
    exact: true,
  })
  await expect(first).toContainText('C:/Videos/Sample video.ai.ko.srt')
  await expect(
    page
      .getByRole('article', { name: '[ad] Locked.mp4 파일명 변경', exact: true })
      .getByRole('checkbox'),
  ).toBeDisabled()
  await page
    .getByRole('article', { name: '[ad] Second.mp4 파일명 변경', exact: true })
    .getByRole('checkbox')
    .uncheck()
  await page.getByRole('button', { name: '선택한 이름 변경' }).click()
  const dialog = page.getByRole('dialog', { name: '파일명 변경 확인' })
  await expect(dialog).toContainText('선택한 영상 1개에 연결된 파일 2개')
  expect(
    await page.evaluate(
      () => (window as unknown as MaintenanceWindow).maintenanceHarness.applyCalls,
    ),
  ).toEqual([])
  await dialog.getByRole('button', { name: '돌아가기' }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as MaintenanceWindow).maintenanceHarness.applyCalls,
    ),
  ).toEqual([])
  await page.getByRole('button', { name: '선택한 이름 변경' }).click()
  await dialog.getByRole('button', { name: '확인 후 변경' }).click()
  await expect(page.getByRole('status')).toContainText('변경 완료 1개')
  expect(
    await page.evaluate(
      () => (window as unknown as MaintenanceWindow).maintenanceHarness.applyCalls,
    ),
  ).toEqual([
    {
      libraryId: 'mock-library',
      previewId: 'dd270470-14f8-45ed-af6e-f3b2da7c86d3',
      videoIds: ['mock-video-1'],
    },
  ])
  await expect(page.getByRole('button', { name: '선택한 이름 변경' })).toHaveCount(0)
})

test('changing a rule invalidates the old preview and IPC failure is visible without reporting success', async ({
  page,
}) => {
  await prepare(page)
  await showPreview(page)
  await page.evaluate(() => {
    ;(window as unknown as MaintenanceWindow).maintenanceHarness.failApply = true
  })
  await page.getByRole('button', { name: '선택한 이름 변경' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '확인 후 변경' }).click()
  await expect(page.getByRole('alert')).toContainText('미리보기가 만료')
  await expect(page.getByRole('article')).toHaveCount(3)
  await page.getByLabel('제거할 접두어').fill('[new] ')
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '선택한 이름 변경' })).toHaveCount(0)
})

test('exact-duplicate candidates show paths and hashes and lead to existing library review without deleting', async ({
  page,
}) => {
  await prepare(page)
  await page.getByRole('button', { name: '정확한 중복 후보 찾기' }).click()
  await expect(page.getByRole('status')).toContainText('중복 후보 그룹 1개')
  const group = page.getByRole('article', { name: '동일 파일 후보 그룹 1' })
  await expect(group).toContainText('Different name.mp4')
  await expect(group).toContainText('D:/Archive/Different name.mp4')
  await group.getByText('SHA-256 확인', { exact: true }).click()
  await expect(group).toContainText('a'.repeat(64))
  await expect(page.getByRole('button', { name: /삭제/ })).toHaveCount(0)
  await page.getByText('제외한 파일과 이유', { exact: true }).click()
  await expect(page.getByText('offline.mp4: 원본 파일을 찾을 수 없습니다.')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('library-maintenance.png'), fullPage: true })
  await group.getByRole('button', { name: '라이브러리에서 확인' }).first().click()
  await expect(page.getByRole('tab', { name: '정보', exact: true })).toBeVisible()
  await expect(page.getByText('Sample video', { exact: true })).not.toHaveCount(0)
})

test('cancels a pending scan and explains that results are partial', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as MaintenanceWindow).maintenanceHarness.delayScan = true
  })
  await page.getByRole('button', { name: '정확한 중복 후보 찾기' }).click()
  await expect(page.getByRole('button', { name: '정확한 중복 후보 찾기' })).toBeDisabled()
  await page.getByRole('button', { name: '작업 취소', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(
    '검사를 취소했습니다. 완료한 비교 결과만 표시합니다.',
  )
  expect(
    await page.evaluate(
      () => (window as unknown as MaintenanceWindow).maintenanceHarness.cancelCalls,
    ),
  ).toBe(1)
  await expect(page.getByRole('button', { name: '정확한 중복 후보 찾기' })).toBeEnabled()
})
