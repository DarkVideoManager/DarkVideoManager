import type { WindowApi } from '../../../electron/preload'
import { DEFAULT_SEEK_STEP_SEC, SeekStepSecZ } from '../../shared/playerSettings'

import { DEFAULT_PRIVACY_SETTINGS, PrivacySettingsZ } from '../../shared/privacy'
import { discoverVideos, type DiscoveryPreferences } from '../../shared/discovery'
import {
  importedMetadata,
  MetadataApplyZ,
  MetadataSearchZ,
  StashSettingsPatchZ,
  type StashSettings,
} from '../../shared/metadataImport'
import { err, ok } from '../../shared/result'
import type { Result } from '../../shared/result'
import type { PlaybackConversionJob } from '../../shared/playbackConversion'
import {
  collectVideoMetadataOptions,
  hasVideoTag,
  normalizeVideoCategory,
  normalizeVideoTag,
  parseVideoSearch,
  serializeVideoTags,
} from '../../shared/videoMetadata'
import type {
  Highlight,
  HighlightCreate,
  ImportProgress,
  ImportResult,
  Library,
  LibraryStats,
  SearchQuery,
  Video,
  Thumbnail,
  ThumbnailJob,
  CsvImportPreview,
  Subtitle,
  SubtitleGenerationJob,
  SubtitleGenerationOptions,
  SubtitleSetupStatus,
} from '../../shared/types'

const MOCK_LIBRARY_ID = 'mock-library'
const MOCK_NOW = '2026-01-01T00:00:00.000Z'
let mockStashSettings: StashSettings = { enabled: false, serverUrl: '', hasApiKey: false }

const mockSubtitleSetup = (): SubtitleSetupStatus => ({
  phase: 'ready',
  message: '자막 환경 준비 완료',
  updatedAt: new Date().toISOString(),
  canCancel: false,
  components: [
    { id: 'whisper', label: 'Whisper 음성 인식 엔진', state: 'ready' },
    { id: 'speechModel', label: 'Whisper 기본 모델', state: 'ready' },
    { id: 'wsl', label: 'Windows 자막 실행 환경', state: 'ready' },
    { id: 'python', label: '자막 처리 도구', state: 'ready' },
    { id: 'ollama', label: 'Ollama 번역 엔진', state: 'ready' },
    { id: 'translationModel', label: '한국어 번역 모델 (qwen3:8b)', state: 'ready' },
  ],
})

const libraries: Library[] = [
  {
    id: MOCK_LIBRARY_ID,
    name: 'Demo Library',
    dbPath: '/mock/demo.db',
    folderPath: '/mock/videos',
    createdAt: MOCK_NOW,
    lastOpenedAt: MOCK_NOW,
  },
]

const videosByLibrary = new Map<string, Video[]>([
  [
    MOCK_LIBRARY_ID,
    [
      {
        id: 'mock-video-1',
        filePath: '/mock/videos/sample.mp4',
        fileName: 'sample.mp4',
        durationSec: 125,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fps: 30,
        bitrate: 4500,
        container: 'mp4',
        sizeBytes: 1024 * 1024 * 12,
        title: 'Sample video',
        rating: 4,
        tags: 'demo, sample',
        playCount: 2,
        playTimeSec: 60,
        hasSubtitles: false,
        memo: 'Browser mock IPC sample',
        createdAt: MOCK_NOW,
        updatedAt: MOCK_NOW,
        resumePosSec: 0,
      },
    ],
  ],
])

const highlightsByVideo = new Map<string, Highlight[]>()
const thumbnailsByVideo = new Map<string, Thumbnail[]>()
interface MockThumbnailState {
  job: ThumbnailJob
  timer?: ReturnType<typeof setTimeout>
  result: Promise<Result<boolean, string>>
  finish: (result: Result<boolean, string>) => void
}
const thumbnailJobs = new Map<string, MockThumbnailState>()

function ensureMockThumbnails(libraryId: string, videoId: string, force = false) {
  const key = `${libraryId}:${videoId}`
  const existing = thumbnailJobs.get(key)
  if (existing && ['queued', 'running', 'cancelling'].includes(existing.job.phase))
    return existing.result
  const video = findVideo(libraryId, videoId)
  if (!video || video.removalMode) return Promise.resolve(err('영상을 찾을 수 없습니다.'))
  if (!force && thumbnailsByVideo.get(videoId)?.length) return Promise.resolve(ok(true))
  let finish!: MockThumbnailState['finish']
  const result = new Promise<Result<boolean, string>>((resolve) => {
    finish = resolve
  })
  const state: MockThumbnailState = {
    job: { libraryId, videoId, fileName: video.fileName, phase: 'queued', completed: 0, total: 3 },
    result,
    finish,
  }
  thumbnailJobs.set(key, state)
  const advance = () => {
    if (state.job.phase === 'queued') state.job.phase = 'running'
    else state.job.completed += 1
    if (state.job.completed === state.job.total) {
      state.job.phase = 'completed'
      state.timer = undefined
      void captureMock(libraryId, videoId, 10).then(() => finish(ok(true)))
      return
    }
    state.timer = setTimeout(advance, 400)
  }
  state.timer = setTimeout(advance, 100)
  return result
}
const subtitlesByVideo = new Map<string, Subtitle[]>()
interface MockSubtitleState {
  job: SubtitleGenerationJob
  timer?: ReturnType<typeof setTimeout>
  stage: number
  generation: number
  video: Video
  subtitleIdsToDelete?: string[]
}
const subtitleJobs = new Map<string, MockSubtitleState>()
const conversionJobs = new Map<string, PlaybackConversionJob>()
const subtitleTerminalPhases = new Set(['completed', 'cancelled', 'failed'])
let subtitleGenerationNumber = 0
const mockTranslationSettings = {
  enabled: false,
  hasApiKey: false,
  monthlyLimit: 500_000,
  month: '2026-10',
  usedCharacters: 0,
  externalCharacters: 0,
  remainingCharacters: 500_000,
}
const progressListeners = new Set<(progress: ImportProgress) => void>()
const thumbnailListeners = new Set<(data: { videoId: string }) => void>()
const mockSettings = {
  cacheLimitGb: 10,
  seekStepSec: DEFAULT_SEEK_STEP_SEC,
  nativePlayer: null as import('../../shared/types').NativePlayerInfo | null,
}
let mockCacheBytes = 512 * 1024 * 1024
const mockCacheInfo = () => ({
  usedBytes: mockCacheBytes,
  limitBytes: mockSettings.cacheLimitGb * 1024 ** 3,
  fileCount: mockCacheBytes ? 2 : 0,
  protectedBytes: 0,
})

function findLibrary(libraryId: string): Library | undefined {
  return libraries.find((library) => library.id === libraryId)
}

function findVideo(libraryId: string, videoId: string): Video | undefined {
  return videosByLibrary.get(libraryId)?.find((video) => video.id === videoId)
}

function latestSubtitleJob(libraryId: string, videoId: string): MockSubtitleState | undefined {
  return [...subtitleJobs.values()]
    .reverse()
    .find((state) => state.job.libraryId === libraryId && state.job.videoId === videoId)
}

function scheduleMockSubtitles(): void {
  if ([...subtitleJobs.values()].some((state) => state.timer !== undefined)) return
  const state = [...subtitleJobs.values()].find((item) => item.job.phase === 'queued')
  if (!state) return
  if (state.subtitleIdsToDelete) {
    const tracks = subtitlesByVideo.get(state.video.id) ?? []
    const selected = new Set(state.subtitleIdsToDelete)
    const external = tracks.filter((track) => !track.isEmbedded)
    if (external.length !== selected.size || external.some((track) => !selected.has(track.id))) {
      state.job = {
        ...state.job,
        phase: 'failed',
        message: '기존 자막 목록이 변경되었습니다. 다시 확인해 주세요.',
      }
      scheduleMockSubtitles()
      return
    }
    const remaining = tracks.filter((track) => !selected.has(track.id))
    subtitlesByVideo.set(state.video.id, remaining)
    state.video.hasSubtitles = remaining.length > 0
    state.subtitleIdsToDelete = undefined
    state.job.message = '차례가 되어 기존 자막을 휴지통으로 옮겼습니다. 새 자막을 준비합니다.'
  }
  const stages: Array<Partial<SubtitleGenerationJob> & { delay: number }> = [
    { phase: 'loading', percent: 10, message: '음성 인식 모델을 불러오고 있습니다.', delay: 250 },
    { phase: 'transcribing', percent: 40, message: '원어 자막을 생성하고 있습니다.', delay: 350 },
    ...(state.job.options.translateToKorean
      ? [
          {
            phase: 'translating' as const,
            percent: 75,
            message: '한국어로 번역하고 있습니다.',
            delay: 400,
          },
        ]
      : []),
    { phase: 'completed', percent: 100, message: '자막 파일을 저장했습니다.', delay: 500 },
  ]
  state.job = { ...state.job, phase: state.stage ? stages[state.stage - 1].phase! : 'preparing' }
  const advance = (): void => {
    const { delay, ...update } = stages[state.stage]
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.stage += 1
      state.job = { ...state.job, ...update }
      if (state.job.phase === 'completed') {
        const { video, generation } = state
        const options = state.job.options
        const stem = video.filePath.replace(/\.[^.]+$/, '')
        const existingPaths = new Set(
          (subtitlesByVideo.get(video.id) ?? []).map((track) => track.filePath),
        )
        let outputNumber = 1
        let suffix = ''
        while (
          existingPaths.has(`${stem}.ai${suffix}.srt`) ||
          existingPaths.has(`${stem}.ai${suffix}.ko.srt`)
        ) {
          outputNumber += 1
          suffix = `.${outputNumber}`
        }
        state.job.outputPaths = [`${stem}.ai${suffix}.srt`]
        if (options.translateToKorean) state.job.outputPaths.push(`${stem}.ai${suffix}.ko.srt`)
        const generated: Subtitle[] = state.job.outputPaths.map((filePath, index) => ({
          id: `mock-subtitle-${generation}-${index}`,
          videoId: video.id,
          filePath,
          lang: index === 1 ? 'ko' : options.language === 'auto' ? 'en' : options.language,
          type: 'srt',
          encoding: 'utf-8',
          isEmbedded: false,
        }))
        subtitlesByVideo.set(video.id, [
          ...generated.reverse(),
          ...(subtitlesByVideo.get(video.id) ?? []),
        ])
        video.hasSubtitles = true
        scheduleMockSubtitles()
      } else {
        advance()
      }
    }, delay)
  }
  advance()
}

function enqueueMockSubtitleJob(
  libraryId: string,
  video: Video,
  options: SubtitleGenerationOptions,
  subtitleIdsToDelete?: string[],
): SubtitleGenerationJob {
  const state: MockSubtitleState = {
    job: {
      id: crypto.randomUUID(),
      libraryId,
      videoId: video.id,
      title: video.title || video.fileName,
      options: { ...options },
      createdAt: new Date().toISOString(),
      phase: 'queued',
      percent: 0,
      message: subtitleIdsToDelete
        ? '재생성 차례를 기다리고 있습니다. 기존 자막은 차례가 되면 휴지통으로 옮깁니다.'
        : '차례를 기다리고 있습니다.',
    },
    stage: 0,
    generation: ++subtitleGenerationNumber,
    video,
    subtitleIdsToDelete: subtitleIdsToDelete ? [...subtitleIdsToDelete] : undefined,
  }
  subtitleJobs.set(state.job.id, state)
  scheduleMockSubtitles()
  return { ...state.job }
}

function emitProgress(progress: ImportProgress): void {
  progressListeners.forEach((listener) => listener(progress))
}

function sortVideos(videos: Video[], query: SearchQuery): Video[] {
  const { text, tags } = parseVideoSearch(query.q)
  if (query.tag !== undefined && normalizeVideoTag(query.tag)) tags.push(query.tag)
  const filtered = videos.filter(
    (video) =>
      (query.category === undefined ||
        normalizeVideoCategory(video.category) === normalizeVideoCategory(query.category)) &&
      tags.every((tag) => hasVideoTag(video.tags, tag)) &&
      (!text ||
        `${video.fileName} ${video.title ?? ''} ${video.tags ?? ''}`
          .toLowerCase()
          .includes(text.toLowerCase())),
  )
  const sorted = [...filtered].sort((left, right) => {
    const leftValue = query.sortBy === 'rating' ? left.rating : left.fileName
    const rightValue = query.sortBy === 'rating' ? right.rating : right.fileName
    return String(leftValue).localeCompare(String(rightValue))
  })
  return query.sortDir === 'desc' ? sorted.reverse() : sorted
}

async function mockImport(libraryId: string): Promise<Result<ImportResult, string>> {
  const total = 1
  emitProgress({ phase: 'scanning', total: 0, current: 0, errors: [] })
  await Promise.resolve()
  emitProgress({ phase: 'probing', total, current: 1, currentFile: 'sample.mp4', errors: [] })
  await Promise.resolve()
  emitProgress({ phase: 'thumbnails', total, current: 0, currentFile: 'sample.mp4', errors: [] })
  await Promise.resolve()
  emitProgress({ phase: 'done', total, current: total, currentFile: 'sample.mp4', errors: [] })
  thumbnailListeners.forEach((listener) =>
    listener({ videoId: findVideo(libraryId, 'mock-video-1')?.id ?? 'mock-video-1' }),
  )
  return ok({ added: 0, skipped: 1, removed: 0, errors: [] })
}

const csvPreview: CsvImportPreview = {
  csvPath: '/mock/metadata.csv',
  totalRows: 2,
  filesRows: 1,
  favoritesRows: 1,
  ratedFileRows: 1,
  favoriteRowsWithStart: 1,
  matchedRatingRows: 1,
  ambiguousRatingRows: 0,
  unmatchedRatingRows: 0,
  matchedFavoriteRows: 1,
  ambiguousFavoriteRows: 0,
  unmatchedFavoriteRows: 0,
}

async function captureMock(
  _libraryId: string,
  videoId: string,
  timeSec: number,
  makePrimary = true,
): Promise<Result<Thumbnail, string>> {
  const thumbnail: Thumbnail = {
    id: `mock-thumbnail-${Date.now()}`,
    videoId,
    timeSec,
    isPrimary: makePrimary,
    filePath: '/mock/thumbnail.jpg',
    createdAt: MOCK_NOW,
  }
  const thumbnails = thumbnailsByVideo.get(videoId) ?? []
  if (makePrimary)
    thumbnails.forEach((item) => {
      item.isPrimary = false
    })
  thumbnails.push(thumbnail)
  thumbnailsByVideo.set(videoId, thumbnails)
  thumbnailListeners.forEach((listener) => listener({ videoId }))
  return ok(thumbnail)
}

function mockStats(libraryId: string, requestedDays = 30): LibraryStats {
  const days = Math.min(365, Math.max(1, Math.floor(requestedDays)))
  const allVideos = videosByLibrary.get(libraryId) ?? []
  const videos = allVideos.filter((video) => !video.removalMode)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const localDate = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const dailyStats = Array.from({ length: days }, (_, index) => {
    const date = new Date(today)
    date.setDate(date.getDate() - days + index + 1)
    return { date: localDate(date), watchedSec: 0, sessionCount: 0, videoCount: 0 }
  })
  // Browser demo history places the sample video's existing watch counters today.
  const watched = allVideos.filter((video) => video.playTimeSec > 0)
  const watchedSec = watched.reduce((sum, video) => sum + video.playTimeSec, 0)
  const sessions = watched.reduce((sum, video) => sum + Math.max(1, video.playCount), 0)
  Object.assign(dailyStats[days - 1], {
    watchedSec,
    sessionCount: sessions,
    videoCount: watched.length,
  })
  const weekdayStats = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    watchedSec: weekday === today.getDay() ? watchedSec : 0,
    sessionCount: weekday === today.getDay() ? sessions : 0,
  }))
  const hourlyStats = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    watchedSec: hour === 20 ? watchedSec : 0,
    sessionCount: hour === 20 ? sessions : 0,
  }))
  const count = (predicate: (video: Video) => boolean): number => videos.filter(predicate).length
  const tracks = (video: Video): Subtitle[] => subtitlesByVideo.get(video.id) ?? []
  const ratedVideos = videos.filter((video) => video.rating > 0)
  const resolution = (video: Video): string => {
    const side = Math.min(video.width ?? 0, video.height ?? 0)
    return side <= 0
      ? 'unknown'
      : side < 720
        ? 'sd'
        : side < 1080
          ? '720p'
          : side < 1440
            ? '1080p'
            : side < 2160
              ? '1440p'
              : '4k'
  }
  const duration = (video: Video): string => {
    const seconds = video.durationSec ?? 0
    return seconds <= 0
      ? 'unknown'
      : seconds < 300
        ? 'under5'
        : seconds < 1200
          ? '5to20'
          : seconds < 3600
            ? '20to60'
            : '60plus'
  }
  const formats = new Map<string, number>()
  const tags = new Map<string, number>()
  for (const video of videos) {
    const format = video.fileName.match(/\.([^.]+)$/)?.[1].toUpperCase() ?? '미확인'
    formats.set(format, (formats.get(format) ?? 0) + 1)
    for (const tag of new Set(
      video.tags
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1)
    }
  }
  const entries = (items: Map<string, number>): LibraryStats['distributions']['tags'] =>
    [...items.entries()]
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  return {
    totalVideos: videos.length,
    totalWatchedSec: watchedSec,
    avgRating: ratedVideos.length
      ? ratedVideos.reduce((sum, video) => sum + video.rating, 0) / ratedVideos.length
      : 0,
    library: {
      totalDurationSec: videos.reduce((sum, video) => sum + (video.durationSec ?? 0), 0),
      totalSizeBytes: videos.reduce((sum, video) => sum + (video.sizeBytes ?? 0), 0),
      durationUnknownVideos: count((video) => !video.durationSec),
      sizeUnknownVideos: count((video) => video.sizeBytes === undefined),
      watchedVideos: count((video) => video.playCount > 0 || video.playTimeSec > 0),
      unwatchedVideos: count((video) => video.playCount <= 0 && video.playTimeSec <= 0),
      ratedVideos: ratedVideos.length,
      subtitleVideos: count((video) => !!video.hasSubtitles || tracks(video).length > 0),
      koreanSubtitleVideos: count((video) => tracks(video).some((track) => track.lang === 'ko')),
      generatedSubtitleVideos: count((video) =>
        tracks(video).some((track) => /\.ai(?:\.\d+)?(?:\.ko)?\./i.test(track.filePath)),
      ),
      highlightedVideos: count((video) => (highlightsByVideo.get(video.id)?.length ?? 0) > 0),
      highlightCount: videos.reduce(
        (sum, video) => sum + (highlightsByVideo.get(video.id)?.length ?? 0),
        0,
      ),
      taggedVideos: count((video) => video.tags.split(',').some((tag) => tag.trim())),
    },
    period: {
      days,
      startDate: dailyStats[0].date,
      endDate: localDate(today),
      watchedSec,
      previousWatchedSec: 0,
      sessionCount: sessions,
      previousSessionCount: 0,
      uniqueVideos: watched.length,
      activeDays: sessions ? 1 : 0,
      averageSessionSec: sessions ? watchedSec / sessions : 0,
      longestStreak: sessions ? 1 : 0,
      addedVideos: count((video) => {
        const date = localDate(new Date(video.createdAt))
        return date >= dailyStats[0].date && date <= localDate(today)
      }),
    },
    dailyStats,
    weekdayStats,
    hourlyStats,
    topVideos: videos
      .filter((video) => video.playTimeSec > 0)
      .sort((a, b) => b.playTimeSec - a.playTimeSec)
      .slice(0, 10)
      .map((video) => ({
        id: video.id,
        title: video.title,
        fileName: video.fileName,
        watchedSec: video.playTimeSec,
        sessionCount: Math.max(1, video.playCount),
      })),
    distributions: {
      ratings: Array.from({ length: 6 }, (_, rating) => ({
        key: String(rating),
        label: rating ? `${rating}점` : '미평가',
        count: count((video) => video.rating === rating),
      })),
      resolutions: [
        ['sd', 'SD'],
        ['720p', 'HD · 720p'],
        ['1080p', 'FHD · 1080p'],
        ['1440p', 'QHD · 1440p'],
        ['4k', '4K 이상'],
        ['unknown', '미확인'],
      ].map(([key, label]) => ({ key, label, count: count((video) => resolution(video) === key) })),
      durations: [
        ['under5', '5분 미만'],
        ['5to20', '5분 – 20분'],
        ['20to60', '20분 – 1시간'],
        ['60plus', '1시간 이상'],
        ['unknown', '미확인'],
      ].map(([key, label]) => ({ key, label, count: count((video) => duration(video) === key) })),
      formats: entries(formats),
      tags: entries(tags).slice(0, 10),
    },
  }
}

let mockPrivacy = { ...DEFAULT_PRIVACY_SETTINGS }
const mockDiscovery = new Map<string, DiscoveryPreferences>()
export const mockApi: WindowApi = {
  privacy: {
    get: async () => ok({ ...mockPrivacy }),
    save: async (settings) => {
      mockPrivacy = PrivacySettingsZ.parse(settings)
      return ok({ ...mockPrivacy })
    },
    exit: async () => ok(mockPrivacy.exitAction),
  },
  discovery: {
    query: async (libraryId, query) =>
      ok(
        discoverVideos(
          videosByLibrary.get(libraryId) ?? [],
          mockDiscovery.get(libraryId) ?? { favoriteVideoIds: [], preferredTags: [] },
          query,
        ),
      ),
    favorite: async (libraryId, videoId, favorite) => {
      const previous = mockDiscovery.get(libraryId) ?? { favoriteVideoIds: [], preferredTags: [] }
      const ids = new Set(previous.favoriteVideoIds)
      if (favorite) ids.add(videoId)
      else ids.delete(videoId)
      const value = { ...previous, favoriteVideoIds: [...ids] }
      mockDiscovery.set(libraryId, value)
      return ok(value)
    },
    tags: async (libraryId, preferredTags) => {
      const value = {
        favoriteVideoIds: mockDiscovery.get(libraryId)?.favoriteVideoIds ?? [],
        preferredTags,
      }
      mockDiscovery.set(libraryId, value)
      return ok(value)
    },
  },
  metadataImport: {
    getSettings: async () => ok({ ...mockStashSettings }),
    updateSettings: async (input) => {
      const parsed = StashSettingsPatchZ.safeParse(input)
      if (!parsed.success) return err('Stash 설정을 확인하세요.')
      const patch = parsed.data
      mockStashSettings = {
        enabled: patch.enabled,
        serverUrl: patch.serverUrl,
        hasApiKey:
          Boolean(patch.apiKey?.trim()) ||
          (mockStashSettings.serverUrl === patch.serverUrl &&
            !patch.removeApiKey &&
            mockStashSettings.hasApiKey),
      }
      return ok({ ...mockStashSettings })
    },
    search: async (query, mode = 'text') => {
      if (!MetadataSearchZ.safeParse(query).success) return err('검색어를 확인하세요.')
      if (!mockStashSettings.enabled || !mockStashSettings.serverUrl)
        return err('Stash 연결을 설정하고 사용을 켜주세요.')
      if (mode === 'code' && query.trim() !== 'DEMO-001') return ok({ total: 0, candidates: [] })
      return ok({
        total: 1,
        candidates: [
          {
            id: 'demo-scene',
            title: '예시 영상 제목',
            description: 'Stash 메타데이터 미리보기 예시입니다.',
            tags: ['예시', '인터뷰'],
            people: ['예시 인물'],
            studio: '예시 스튜디오',
            date: '2026-01-01',
            code: 'DEMO-001',
          },
        ],
      })
    },
    apply: async (libraryId, videoId, input) => {
      const parsed = MetadataApplyZ.safeParse(input)
      if (!parsed.success) return err('적용할 항목을 확인하세요.')
      const video = findVideo(libraryId, videoId)
      if (!video || video.removalMode) return err('영상을 찾을 수 없습니다.')
      const before = importedMetadata(video)
      const { patch, expected } = parsed.data
      if (
        (['title', 'memo', 'tags'] as const).some(
          (key) => patch[key] !== undefined && before[key] !== expected[key],
        )
      )
        return err(
          '선택한 항목이 미리보기 이후 변경되었습니다. 닫고 다시 열어 현재 값을 확인하세요.',
        )
      const after = {
        ...before,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      }
      Object.assign(video, after, {
        title: after.title ?? undefined,
        updatedAt: new Date().toISOString(),
      })
      return ok({ before, after })
    },
  },
  maintenance: {
    previewNames: async (libraryId) =>
      ok({
        id: crypto.randomUUID(),
        libraryId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        rows: [],
        truncated: false,
      }),
    applyNames: async () => err('브라우저 데모에서는 실제 파일명을 변경하지 않습니다.'),
    findDuplicates: async () => ok({ groups: [], checkedFiles: 0, skipped: [], cancelled: false }),
    cancel: async () => ok(false),
  },
  app: {
    getAccelerationInfo: async () =>
      ok({ videoDecodeStatus: 'enabled', gpuCompositingStatus: 'enabled' }),
    getNativePlayers: async () =>
      ok([
        { name: 'mpv', path: '/mock/mpv.exe' },
        { name: 'vlc', path: '/mock/vlc.exe' },
      ]),
    selectNativePlayer: async (name) => ok({ name, path: `/mock/custom/${name}.exe` }),
    quit: async () => ok(null),
    getSettings: async () => ok({ ...mockSettings }),
    updateSettings: async (patch) => {
      if (patch.seekStepSec !== undefined && !SeekStepSecZ.safeParse(patch.seekStepSec).success)
        return err('탐색 간격은 1~600초의 정수로 입력하세요.')
      Object.assign(mockSettings, patch)
      return ok({ ...mockSettings })
    },
    getCacheInfo: async () => ok(mockCacheInfo()),
    cleanCache: async () => {
      const removedBytes = mockCacheBytes
      mockCacheBytes = 0
      return ok({ removedBytes, removedFiles: removedBytes ? 2 : 0, info: mockCacheInfo() })
    },
  },
  dataImport: {
    selectCsv: async () => ok(csvPreview.csvPath),
    preview: async () => ok(csvPreview),
    importCsv: async () => ok({ preview: csvPreview, ratingsUpdated: 1, highlightsAdded: 1 }),
  },
  library: {
    list: async () => ok(libraries),
    open: async (libraryId) => {
      const library = findLibrary(libraryId)
      return library ? ok(library) : err('라이브러리를 찾을 수 없습니다')
    },
    create: async (name, folderPath) => {
      const library: Library = {
        id: `mock-${libraries.length + 1}`,
        name,
        dbPath: `/mock/${libraries.length + 1}.db`,
        folderPath,
        createdAt: MOCK_NOW,
      }
      libraries.push(library)
      videosByLibrary.set(library.id, [])
      return ok(library)
    },
    close: async () => ok(null),
    delete: async (libraryId) => {
      const index = libraries.findIndex((library) => library.id === libraryId)
      if (index < 0) return err('라이브러리를 찾을 수 없습니다')
      libraries.splice(index, 1)
      videosByLibrary.delete(libraryId)
      return ok(null)
    },
    selectFolder: async () => ok('/mock/videos'),
    importFolder: mockImport,
    selectFiles: async () => ok(['/mock/videos/sample.mp4']),
    importFiles: mockImport,
    refresh: async () => ok({ added: 0, skipped: 1, removed: 0, errors: [] }),
    cancelWork: async () => ok(true),
  },
  videos: {
    metadataOptions: async (libraryId, removed = false) =>
      ok(
        collectVideoMetadataOptions(
          (videosByLibrary.get(libraryId) ?? []).filter(
            (video) => Boolean(video.removalMode) === removed,
          ),
        ),
      ),
    search: async (libraryId, query) => {
      const videos = sortVideos(
        (videosByLibrary.get(libraryId) ?? []).filter(
          (video) =>
            Boolean(video.removalMode) === Boolean(query.removed) &&
            (query.rating === undefined || video.rating >= query.rating) &&
            (query.hasSubtitles === undefined ||
              (subtitlesByVideo.get(video.id)?.length ?? 0) > 0 === query.hasSubtitles),
        ),
        query,
      )
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 50
      return ok({
        videos: videos.slice((page - 1) * pageSize, page * pageSize),
        total: videos.length,
        page,
        pageSize,
      })
    },
    get: async (libraryId, videoId) => ok(findVideo(libraryId, videoId) ?? null),
    revealSource: async (libraryId, videoId) =>
      findVideo(libraryId, videoId) ? ok(null) : err('원본 영상을 찾을 수 없습니다.'),
    getPlaybackSource: async (libraryId, videoId) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return ok(findVideo(libraryId, videoId)?.filePath ?? '/mock/videos/sample.mp4')
    },
    getNativePlayerInfo: async () =>
      ok(mockSettings.nativePlayer ?? { name: 'mpv', path: '/mock/mpv.exe' }),
    openInNativePlayer: async () =>
      ok(mockSettings.nativePlayer ?? { name: 'mpv', path: '/mock/mpv.exe' }),
    setActivePlaybackRate: async (_libraryId, _videoId, rate) => ok(rate),
    seekActivePlayback: async () => ok(true),
    updateMeta: async (libraryId, videoId, meta) => {
      const video = findVideo(libraryId, videoId)
      if (!video) return err('영상을 찾을 수 없습니다')
      Object.assign(video, meta, { updatedAt: new Date().toISOString() })
      if (meta.tags !== undefined) video.tags = serializeVideoTags(meta.tags)
      if (meta.category !== undefined) video.category = normalizeVideoCategory(meta.category)
      return ok(null)
    },
    delete: async (libraryId, videoId, mode = 'trash') => {
      const video = findVideo(libraryId, videoId)
      if (!video) return err('영상을 찾을 수 없습니다')
      video.removalMode = mode
      return ok(null)
    },
    restore: async (libraryId, videoId) => {
      const video = findVideo(libraryId, videoId)
      if (!video) return err('영상을 찾을 수 없습니다')
      video.removalMode = undefined
      return ok(null)
    },
  },
  playback: {
    listConversionQueue: async () => ok([...conversionJobs.values()].map((job) => ({ ...job }))),
    pauseConversion: async (id) => {
      const job = conversionJobs.get(id)
      if (!job) return err('변환 작업을 찾을 수 없습니다.')
      job.status = 'paused'
      job.updatedAt = new Date().toISOString()
      return ok({ ...job })
    },
    resumeConversion: async (id) => {
      const job = conversionJobs.get(id)
      if (!job) return err('변환 작업을 찾을 수 없습니다.')
      job.status = 'queued'
      job.phase = 'waiting'
      job.progress = 0
      job.updatedAt = new Date().toISOString()
      return ok({ ...job })
    },
    removeConversion: async (id) => {
      conversionJobs.delete(id)
      return ok(null)
    },
    start: async (_libraryId, videoId) => ok(`mock-session-${videoId}`),
    heartbeat: async () => ok(null),
    seek: async () => ok(null),
    end: async () => ok(null),
  },
  thumbnails: {
    getForVideo: async (_libraryId, videoId) => ok(thumbnailsByVideo.get(videoId) ?? []),
    setPrimary: async () => ok(null),
    ensureForVideo: ensureMockThumbnails,
    listJobs: async (libraryId) =>
      ok(
        [...thumbnailJobs.values()]
          .filter(({ job }) => job.libraryId === libraryId)
          .map(({ job }) => ({ ...job })),
      ),
    cancelForVideo: async (libraryId, videoId) => {
      const state = thumbnailJobs.get(`${libraryId}:${videoId}`)
      if (!state || !['queued', 'running', 'cancelling'].includes(state.job.phase)) return ok(false)
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
      state.job = { ...state.job, phase: 'cancelled', error: '요청에 따라 작업을 취소했습니다.' }
      state.finish(ok(false))
      return ok(true)
    },
    captureAtTime: captureMock,
    saveImageCapture: async (libraryId, videoId, timeSec, _dataUrl, makePrimary) =>
      captureMock(libraryId, videoId, timeSec, makePrimary),
  },
  highlights: {
    list: async (_libraryId, videoId) => ok(highlightsByVideo.get(videoId) ?? []),
    create: async (_libraryId, data: HighlightCreate) => {
      const highlight: Highlight = {
        id: `mock-highlight-${Date.now()}`,
        videoId: data.videoId,
        timeStart: data.timeStart,
        timeEnd: data.timeEnd,
        label: data.label,
        color: data.color ?? 'yellow',
        createdAt: new Date().toISOString(),
      }
      const highlights = highlightsByVideo.get(data.videoId) ?? []
      highlights.push(highlight)
      highlightsByVideo.set(data.videoId, highlights)
      return ok(highlight)
    },
    update: async (_libraryId, id, patch) => {
      for (const highlights of highlightsByVideo.values()) {
        const highlight = highlights.find((item) => item.id === id)
        if (highlight) Object.assign(highlight, patch)
      }
      return ok(null)
    },
    delete: async (_libraryId, id) => {
      for (const highlights of highlightsByVideo.values()) {
        const index = highlights.findIndex((item) => item.id === id)
        if (index >= 0) highlights.splice(index, 1)
      }
      return ok(null)
    },
  },
  subtitles: {
    getSetupStatus: async () => ok(mockSubtitleSetup()),
    checkSetup: async () => ok(mockSubtitleSetup()),
    startSetup: async () => ok(mockSubtitleSetup()),
    cancelSetup: async () => ok(false),
    getTranslationSettings: async () => ok({ ...mockTranslationSettings }),
    updateTranslationSettings: async (patch) => {
      for (const field of ['monthlyLimit', 'externalCharacters'] as const) {
        const value = patch[field]
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 500_000))
          return err('사용량은 0부터 500,000 사이의 정수로 입력하세요.')
      }
      if (patch.enabled !== undefined) mockTranslationSettings.enabled = patch.enabled
      if (patch.removeApiKey) mockTranslationSettings.hasApiKey = false
      else if (patch.apiKey?.trim()) mockTranslationSettings.hasApiKey = true
      if (patch.monthlyLimit !== undefined)
        mockTranslationSettings.monthlyLimit = patch.monthlyLimit
      if (patch.externalCharacters !== undefined)
        mockTranslationSettings.externalCharacters = patch.externalCharacters
      mockTranslationSettings.remainingCharacters = Math.max(
        0,
        mockTranslationSettings.monthlyLimit -
          mockTranslationSettings.usedCharacters -
          mockTranslationSettings.externalCharacters,
      )
      return ok({ ...mockTranslationSettings })
    },
    getForVideo: async (_libraryId, videoId) => ok(subtitlesByVideo.get(videoId) ?? []),
    convertToVtt: async () => ok('/mock/subtitles/converted.vtt'),
    readText: async () => ok('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n테스트 자막\n'),
    getEngineInfo: async () => ok({ available: true, message: '브라우저 테스트용 자막 엔진' }),
    generate: async (libraryId, videoId, options) => {
      const video = findVideo(libraryId, videoId)
      if (!video || video.removalMode) return err('자막을 생성할 영상을 찾을 수 없습니다.')
      if (
        [...subtitleJobs.values()].some(
          (state) =>
            state.job.libraryId === libraryId &&
            state.job.videoId === videoId &&
            !subtitleTerminalPhases.has(state.job.phase),
        )
      )
        return err('이미 자막을 생성하고 있습니다.')
      return ok(enqueueMockSubtitleJob(libraryId, video, options))
    },
    regenerate: async (libraryId, videoId, subtitleIds, options) => {
      const video = findVideo(libraryId, videoId)
      if (!video || video.removalMode) return err('자막을 생성할 영상을 찾을 수 없습니다.')
      if (
        [...subtitleJobs.values()].some(
          (state) =>
            state.job.libraryId === libraryId &&
            state.job.videoId === videoId &&
            !subtitleTerminalPhases.has(state.job.phase),
        )
      )
        return err('이미 자막을 생성하고 있습니다.')
      const tracks = subtitlesByVideo.get(videoId) ?? []
      const external = tracks.filter((track) => !track.isEmbedded)
      const selected = new Set(subtitleIds)
      if (
        !external.length ||
        selected.size !== subtitleIds.length ||
        selected.size !== external.length ||
        external.some((track) => !selected.has(track.id))
      )
        return err('기존 자막 목록이 변경되었습니다. 다시 확인해 주세요.')
      for (const [jobId, state] of subtitleJobs) {
        if (state.job.libraryId === libraryId && state.job.videoId === videoId) {
          subtitleJobs.delete(jobId)
        }
      }
      return ok(enqueueMockSubtitleJob(libraryId, video, options, subtitleIds))
    },
    listQueue: async () => ok([...subtitleJobs.values()].map((state) => ({ ...state.job }))),
    pauseJob: async (jobId) => {
      const state = subtitleJobs.get(jobId)
      if (!state || subtitleTerminalPhases.has(state.job.phase)) return ok(false)
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
      state.job = { ...state.job, phase: 'paused', message: '작업을 일시정지했습니다.' }
      scheduleMockSubtitles()
      return ok(true)
    },
    resumeJob: async (jobId) => {
      const state = subtitleJobs.get(jobId)
      if (!state || !['paused', 'failed'].includes(state.job.phase)) return ok(false)
      state.job = { ...state.job, phase: 'queued', message: '차례를 기다리고 있습니다.' }
      scheduleMockSubtitles()
      return ok(true)
    },
    removeJob: async (jobId) => {
      const state = subtitleJobs.get(jobId)
      if (!state) return ok(false)
      if (state.timer !== undefined) clearTimeout(state.timer)
      subtitleJobs.delete(jobId)
      scheduleMockSubtitles()
      return ok(true)
    },
    getGenerationStatus: async (libraryId, videoId) => {
      const state = latestSubtitleJob(libraryId, videoId)
      return ok(state ? { ...state.job } : null)
    },
    cancelGeneration: async (libraryId, videoId) => {
      const state = latestSubtitleJob(libraryId, videoId)
      if (!state || subtitleTerminalPhases.has(state.job.phase)) return ok(false)
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
      state.job = { ...state.job, phase: 'cancelled', message: '자막 생성이 취소되었습니다.' }
      scheduleMockSubtitles()
      return ok(true)
    },
  },
  stats: {
    get: async (libraryId, days) => ok(mockStats(libraryId, days)),
  },
  on: {
    importProgress: (listener) => {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    },
    thumbnailReady: (listener) => {
      thumbnailListeners.add(listener)
      return () => {
        thumbnailListeners.delete(listener)
      }
    },
    highlightChanged: () => () => undefined,
    nativePlayerEscape: () => () => undefined,
    nativePlayerSpeed: () => () => undefined,
    nativePlayerAction: () => () => undefined,
  },
}
