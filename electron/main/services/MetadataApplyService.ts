import type { Database } from 'better-sqlite3'
import {
  MetadataApplyZ,
  type ImportedMetadata,
  type MetadataApply,
  type MetadataApplyResult,
} from '@shared/metadataImport'

/** Compare the selected fields and commit them as one transaction. The returned
 * snapshot can be applied in reverse, with the same conflict protection. */
export function applyImportedMetadata(
  db: Database,
  videoId: string,
  input: MetadataApply,
): MetadataApplyResult {
  const { expected, patch } = MetadataApplyZ.parse(input)
  return db.transaction(() => {
    const row = db
      .prepare('SELECT title, memo, tags, removal_mode FROM videos WHERE id = ?')
      .get(videoId) as (ImportedMetadata & { removal_mode: string | null }) | undefined
    if (!row || row.removal_mode) throw new Error('영상을 찾을 수 없거나 목록에서 제거되었습니다.')
    const before: ImportedMetadata = { title: row.title, memo: row.memo, tags: row.tags }
    const keys = (['title', 'memo', 'tags'] as const).filter((key) => patch[key] !== undefined)
    if (keys.some((key) => before[key] !== expected[key]))
      throw new Error(
        '선택한 항목이 미리보기 이후 변경되었습니다. 닫고 다시 열어 현재 값을 확인하세요.',
      )
    const after = { ...before, ...Object.fromEntries(keys.map((key) => [key, patch[key]])) }
    db.prepare(
      `UPDATE videos SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...Object.fromEntries(keys.map((key) => [key, after[key]])), id: videoId })
    return { before, after }
  })()
}
