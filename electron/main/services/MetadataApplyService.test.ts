import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { applyImportedMetadata } from './MetadataApplyService'

let db: Database.Database
const initial = { title: null, memo: '기존 메모', tags: '기존' }
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, ':memory:')
  new VideoRepository(db).insert({
    id: 'v',
    fileName: 'original.mp4',
    filePath: '/original.mp4',
    memo: initial.memo,
    tags: initial.tags,
    rating: 4,
    resumePosSec: 42,
  })
})
afterEach(() => db.close())
const row = () =>
  db
    .prepare('SELECT title, memo, tags, rating, resume_pos_sec, file_path FROM videos WHERE id = ?')
    .get('v')

describe('atomic selected metadata import', () => {
  it('updates selected fields only and reverses them without losing unrelated edits or null title', () => {
    const result = applyImportedMetadata(db, 'v', {
      expected: initial,
      patch: { title: 'Imported', tags: '기존, 신규' },
    })
    expect(row()).toMatchObject({
      title: 'Imported',
      memo: initial.memo,
      tags: '기존, 신규',
      rating: 4,
      resume_pos_sec: 42,
      file_path: '/original.mp4',
    })
    new VideoRepository(db).updateMeta('v', { memo: '다른 편집' })
    applyImportedMetadata(db, 'v', {
      expected: result.after,
      patch: { title: result.before.title, tags: result.before.tags },
    })
    expect(row()).toMatchObject({ title: null, memo: '다른 편집', tags: '기존' })
  })
  it('rejects conflicting selected fields before changing any field', () => {
    new VideoRepository(db).updateMeta('v', { memo: '방금 작성' })
    expect(() =>
      applyImportedMetadata(db, 'v', {
        expected: initial,
        patch: { title: 'Imported', memo: 'External' },
      }),
    ).toThrow('변경되었습니다')
    expect(row()).toMatchObject({ title: null, memo: '방금 작성', tags: '기존' })
  })
  it('retains legacy long metadata and can restore it after replacement', () => {
    const legacy = { ...initial, memo: '기'.repeat(50_001), tags: '태'.repeat(20_001) }
    new VideoRepository(db).updateMeta('v', { memo: legacy.memo, tags: legacy.tags })
    const titleResult = applyImportedMetadata(db, 'v', {
      expected: legacy,
      patch: { title: 'Imported' },
    })
    expect(titleResult.after.memo).toBe(legacy.memo)
    const memoResult = applyImportedMetadata(db, 'v', {
      expected: titleResult.after,
      patch: { memo: 'External' },
    })
    applyImportedMetadata(db, 'v', {
      expected: memoResult.after,
      patch: { memo: memoResult.before.memo },
    })
    expect(row()).toMatchObject({ title: 'Imported', memo: legacy.memo, tags: legacy.tags })
  })
  it('rejects undo after imported values were edited', () => {
    const result = applyImportedMetadata(db, 'v', { expected: initial, patch: { tags: '신규' } })
    new VideoRepository(db).updateMeta('v', { tags: '사용자 편집' })
    expect(() =>
      applyImportedMetadata(db, 'v', {
        expected: result.after,
        patch: { tags: result.before.tags },
      }),
    ).toThrow('변경되었습니다')
    expect(row()).toMatchObject({ tags: '사용자 편집' })
  })
  it('preserves all fields on SQL failure and rejects removed or missing videos', () => {
    db.exec(
      "CREATE TRIGGER reject_import BEFORE UPDATE ON videos BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    )
    expect(() =>
      applyImportedMetadata(db, 'v', {
        expected: initial,
        patch: { title: 'Imported', memo: 'External' },
      }),
    ).toThrow('test failure')
    expect(row()).toMatchObject(initial)
    db.exec('DROP TRIGGER reject_import')
    new VideoRepository(db).markRemoved('v', 'remove')
    expect(() =>
      applyImportedMetadata(db, 'v', { expected: initial, patch: { title: 'Imported' } }),
    ).toThrow('제거')
    expect(() =>
      applyImportedMetadata(db, 'missing', { expected: initial, patch: { title: 'Imported' } }),
    ).toThrow('찾을 수')
  })
})
