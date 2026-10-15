import { describe, expect, it } from 'vitest'
import {
  collectVideoMetadataOptions,
  hasVideoTag,
  normalizeVideoCategory,
  parseVideoSearch,
  parseVideoTags,
  serializeVideoTags,
} from './videoMetadata'

describe('video metadata normalization', () => {
  it('preserves comma-separated tags and accepts hashtags without case duplicates', () => {
    expect(parseVideoTags(' #선수명, 선수명, #PLAYER, player, New York, #홈런 #결승 ')).toEqual([
      '선수명',
      'PLAYER',
      'New York',
      '홈런',
      '결승',
    ])
    expect(serializeVideoTags(' #PLAYER, player, , #선수명 ')).toBe('PLAYER, 선수명')
    expect(normalizeVideoCategory(' 야구 ')).toBe('야구')
  })

  it('matches complete tags literally, including SQL wildcard characters', () => {
    expect(hasVideoTag(' #PLAYER, 선수명, 100%, tag_name ', '#player')).toBe(true)
    expect(hasVideoTag('선수명2, 타선수명', '선수명')).toBe(false)
    expect(hasVideoTag('100퍼센트, tagXname', '100%')).toBe(false)
    expect(hasVideoTag('100%, tag_name', 'tag_name')).toBe(true)
    expect(hasVideoTag('100%, tag_name', 'tag%')).toBe(false)
    expect(hasVideoTag('', '#')).toBe(false)
  })

  it('extracts exact hashtag terms while retaining ordinary text and wildcards', () => {
    expect(parseVideoSearch('결승 #선수명 #PLAYER #player')).toEqual({
      text: '결승',
      tags: ['선수명', 'PLAYER'],
    })
    expect(parseVideoSearch('tag_4%')).toEqual({ text: 'tag_4%', tags: [] })
    expect(parseVideoSearch('film#part')).toEqual({ text: 'film#part', tags: [] })
  })

  it('joins text around removed hashtags and preserves literal hashes inside a tag', () => {
    expect(parseVideoSearch('결승 #선수명 경기')).toEqual({
      text: '결승 경기',
      tags: ['선수명'],
    })
    expect(parseVideoSearch('#C#')).toEqual({ text: '', tags: ['C#'] })
    expect(parseVideoSearch('강좌 #C# 입문')).toEqual({ text: '강좌 입문', tags: ['C#'] })
    expect(hasVideoTag('C#, C++', parseVideoSearch('#c#').tags[0])).toBe(true)
    expect(parseVideoSearch('filename#12  match')).toEqual({ text: 'filename#12  match', tags: [] })
  })

  it('deduplicates nonempty options across every supplied video', () => {
    expect(
      collectVideoMetadataOptions([
        { category: '', tags: ' #PLAYER, player ' },
        { category: ' 야구 ', tags: '선수명' },
        { category: '야구', tags: '#player' },
      ]),
    ).toEqual({ categories: ['야구'], tags: ['선수명', 'PLAYER'] })
  })
})
