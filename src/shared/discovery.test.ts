import { describe, expect, it } from 'vitest'
import { discoverVideos, parseDiscoveryQuery, DiscoveryQueryZ } from './discovery'
import type { Video } from './types'

function video(id: string, patch: Partial<Video> = {}): Video {
  return {
    id,
    filePath: `C:/fixtures/${id}.mp4`,
    fileName: `${id}.mp4`,
    rating: 0,
    memo: '',
    tags: '',
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    resumePosSec: 0,
    playCount: 0,
    playTimeSec: 0,
    ...patch,
  }
}
const empty = { favoriteVideoIds: [], preferredTags: [] }
describe('local library discovery', () => {
  it('combines understood conditions and preserves all remaining literal terms', () => {
    const videos = [
      video('match', { title: '축구 결승', durationSec: 1200, rating: 4, hasSubtitles: true }),
      video('watched', { title: '축구 결승', durationSec: 100, playTimeSec: 1 }),
      video('unknown', { title: '축구 결승' }),
      video('other', { title: '축구 예선', durationSec: 100 }),
    ]
    const result = discoverVideos(videos, empty, {
      text: '아직 안 본 20분 이하 별점 4점 이상 자막 있는 축구 결승',
      page: 1,
    })
    expect(result.videos.map((row) => row.video.id)).toEqual(['match'])
    expect(result.conditions).toContain('검색어: 축구 · 결승')
  })
  it('does not ignore unfamiliar natural language or silently promise an AI interpretation', () => {
    expect(parseDiscoveryQuery('즐겨찾기 우주 여행 추천해줘').terms).toEqual([
      '우주',
      '여행',
      '추천해줘',
    ])
    expect(discoverVideos([video('a')], empty, { text: '추천해줘', page: 1 }).total).toBe(0)
  })
  it('uses favorites and explicit preferred people/tags without external data', () => {
    const videos = [
      video('a', { tags: '축구, 선수A' }),
      video('b', { tags: '야구' }),
      video('c', { tags: '축구', playCount: 2 }),
    ]
    const result = discoverVideos(
      videos,
      { favoriteVideoIds: ['c'], preferredTags: ['선수A'] },
      { text: '', page: 1 },
    )
    expect(result.videos[0].video.id).toBe('a')
    expect(result.videos[0].reasons.join(' ')).toContain('선수a')
    expect(
      discoverVideos(
        videos,
        { ...empty, favoriteVideoIds: ['c'] },
        { text: '즐겨찾기', page: 1 },
      ).videos.map((row) => row.video.id),
    ).toEqual(['c'])
  })
  it('removes deleted rows from both results and preference signals', () => {
    const result = discoverVideos(
      [
        video('hidden', { removalMode: 'trash', tags: '축구', rating: 5 }),
        video('a', { tags: '축구' }),
      ],
      empty,
      { text: '', page: 1 },
    )
    expect(result.total).toBe(1)
    expect(result.videos[0].reasons).toEqual(['선호 근거 없음 · 파일명 순으로 표시'])
  })
  it('applies strict duration limits and treats unknown duration as unknown', () => {
    const videos = [video('a', { durationSec: 60 }), video('b', { durationSec: 61 }), video('c')]
    expect(
      discoverVideos(videos, empty, { text: '1분 초과', page: 1 }).videos.map(
        (row) => row.video.id,
      ),
    ).toEqual(['b'])
    expect(discoverVideos(videos, empty, { text: '1분 미만', page: 1 }).total).toBe(0)
  })
  it('sorts recent viewing separately and searches beyond the initial library page', () => {
    const videos = Array.from({ length: 551 }, (_, index) => video(String(index).padStart(3, '0')))
    videos[550].title = '멀리 있는 영상'
    videos[550].lastPlayedAt = '2026-10-15'
    expect(discoverVideos(videos, empty, { text: '멀리', page: 1 }).videos[0].video.id).toBe('550')
    expect(discoverVideos(videos, empty, { text: '최근 본', page: 1 }).videos[0].video.id).toBe(
      '550',
    )
    expect(discoverVideos(videos, empty, { text: '', page: 12 }).videos).toHaveLength(1)
    expect(DiscoveryQueryZ.safeParse({ text: '', page: 0 }).success).toBe(false)
  })
})
