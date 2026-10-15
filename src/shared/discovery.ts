import { z } from 'zod'
import type { Video } from './types'

export const DiscoveryPreferencesZ = z
  .object({
    favoriteVideoIds: z.array(z.string().min(1).max(200)).max(10000),
    preferredTags: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .strict()
export type DiscoveryPreferences = z.infer<typeof DiscoveryPreferencesZ>
export interface DiscoveryResult {
  videos: Array<{ video: Video; reasons: string[]; favorite: boolean }>
  total: number
  page: number
  conditions: string[]
  preferences: DiscoveryPreferences
}
export const DiscoveryQueryZ = z
  .object({
    text: z.string().max(300),
    page: z.number().int().min(1).max(100000).default(1),
  })
  .strict()
export type DiscoveryQuery = z.infer<typeof DiscoveryQueryZ>

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
export function splitDiscoveryTags(value: string): string[] {
  return [...new Set(value.split(',').map(normalize).filter(Boolean))]
}

/** A deliberately bounded local query language. Unrecognized words remain literal search terms. */
export function parseDiscoveryQuery(text: string) {
  let rest = normalize(text)
  const conditions: string[] = []
  const take = (pattern: RegExp, label: string) => {
    const found = pattern.test(rest)
    if (found) {
      rest = rest.replace(pattern, ' ')
      conditions.push(label)
    }
    return found
  }
  const unwatched = take(/아직\s*안\s*본|보지\s*않은|미시청/g, '미시청')
  const favorites = take(/즐겨찾기/g, '즐겨찾기')
  const subtitles = take(/자막\s*있는|자막\s*있음/g, '자막 있음')
  const recent = take(/최근\s*본/g, '최근 재생 순')
  let duration = rest.match(/(\d+(?:\.\d+)?)\s*분\s*(이하|미만|이상|초과)/)
  if (duration && !Number.isFinite(Number(duration[1]) * 60)) duration = null
  if (duration) {
    rest = rest.replace(duration[0], ' ')
    conditions.push(duration[0])
  }
  let rating = rest.match(/별점\s*([0-5](?:\.\d)?)\s*점?\s*이상/)
  if (rating && Number(rating[1]) > 5) rating = null
  if (rating) {
    rest = rest.replace(rating[0], ' ')
    conditions.push(rating[0])
  }
  const terms = rest.trim().split(/\s+/).filter(Boolean)
  if (terms.length) conditions.push(`검색어: ${terms.join(' · ')}`)
  return { conditions, unwatched, favorites, subtitles, recent, duration, rating, terms }
}

export function discoverVideos(
  videos: Video[],
  preferences: DiscoveryPreferences,
  query: DiscoveryQuery,
): DiscoveryResult {
  const parsed = parseDiscoveryQuery(query.text)
  const active = videos.filter((video) => !video.removalMode)
  const favorites = new Set(preferences.favoriteVideoIds)
  const preferred = new Set(preferences.preferredTags.map(normalize))
  const affinity = new Map<string, number>()
  for (const video of active) {
    const weight =
      (favorites.has(video.id) ? 4 : 0) +
      (video.rating >= 4 ? 2 : 0) +
      (video.playCount > 0 ? 1 : 0)
    if (weight)
      for (const tag of splitDiscoveryTags(video.tags))
        affinity.set(tag, (affinity.get(tag) ?? 0) + weight)
  }
  const matches = active
    .filter((video) => {
      if (parsed.unwatched && (video.playCount > 0 || video.playTimeSec > 0 || video.lastPlayedAt))
        return false
      if (parsed.favorites && !favorites.has(video.id)) return false
      if (parsed.subtitles && !video.hasSubtitles) return false
      if (parsed.rating && video.rating < Number(parsed.rating[1])) return false
      if (parsed.duration) {
        const seconds = Number(parsed.duration[1]) * 60
        const actual = video.durationSec
        if (actual === undefined || !Number.isFinite(actual)) return false
        if (parsed.duration[2] === '이하' && actual > seconds) return false
        if (parsed.duration[2] === '미만' && actual >= seconds) return false
        if (parsed.duration[2] === '이상' && actual < seconds) return false
        if (parsed.duration[2] === '초과' && actual <= seconds) return false
      }
      const searchable = normalize(
        [video.title, video.fileName, video.tags, video.memo].filter(Boolean).join(' '),
      )
      return parsed.terms.every((term) => searchable.includes(term))
    })
    .map((video) => {
      const reasons: string[] = []
      let score = 0
      const tags = splitDiscoveryTags(video.tags)
      const explicit = tags.filter((tag) => preferred.has(tag))
      const ownWeight =
        (favorites.has(video.id) ? 4 : 0) +
        (video.rating >= 4 ? 2 : 0) +
        (video.playCount > 0 ? 1 : 0)
      const related = tags.filter((tag) => (affinity.get(tag) ?? 0) > ownWeight)
      if (explicit.length) {
        score += explicit.length * 10
        reasons.push(`선호 태그·인물: ${explicit.join(', ')}`)
      }
      if (related.length) {
        score += related.reduce(
          (sum, tag) => sum + Math.min((affinity.get(tag) ?? 0) - ownWeight, 8),
          0,
        )
        reasons.push(`즐겨찾기·별점·시청 이력과 공통 태그: ${related.join(', ')}`)
      }
      if (favorites.has(video.id)) {
        score += 3
        reasons.push('즐겨찾기에 등록한 영상')
      }
      if (video.rating >= 4) {
        score += video.rating
        reasons.push(`내 별점 ${video.rating}점`)
      }
      if (!reasons.length) reasons.push('선호 근거 없음 · 파일명 순으로 표시')
      return { video, reasons, favorite: favorites.has(video.id), score }
    })
    .sort((a, b) => {
      if (parsed.recent) {
        const recent = (b.video.lastPlayedAt ?? '').localeCompare(a.video.lastPlayedAt ?? '')
        if (recent) return recent
      }
      return (
        b.score - a.score ||
        a.video.fileName.localeCompare(b.video.fileName) ||
        a.video.id.localeCompare(b.video.id)
      )
    })
  return {
    videos: matches
      .slice((query.page - 1) * 50, query.page * 50)
      .map(({ video, reasons, favorite }) => ({ video, reasons, favorite })),
    total: matches.length,
    page: query.page,
    conditions: parsed.conditions,
    preferences,
  }
}
