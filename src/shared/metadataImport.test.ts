import { describe, expect, it } from 'vitest'
import { MetadataApplyZ, MetadataSearchZ, mergeImportedTags } from './metadataImport'

describe('metadata import contract', () => {
  it('retains existing tags first and deduplicates selected names without partial matches', () => {
    expect(mergeImportedTags('기존, Alice, A_1', ['ALICE', 'A', 'A_1', '100%', '인물, 장르'])).toBe(
      '기존, Alice, A_1, A, 100%, 인물, 장르',
    )
  })
  it('requires a selected field and excludes unsupported metadata', () => {
    const expected = { title: null, memo: '', tags: '' }
    expect(MetadataApplyZ.safeParse({ expected, patch: {} }).success).toBe(false)
    expect(MetadataApplyZ.safeParse({ expected, patch: { rating: 5 } }).success).toBe(false)
    expect(MetadataApplyZ.safeParse({ expected, patch: { title: null } }).success).toBe(true)
    expect(MetadataSearchZ.safeParse(' ').success).toBe(false)
    expect(MetadataSearchZ.safeParse('x'.repeat(201)).success).toBe(false)
  })
})
