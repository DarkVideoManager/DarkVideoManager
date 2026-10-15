export interface Library {
  id: string
  name: string
  dbPath: string
  folderPath: string
  folderPaths?: string[]
  createdAt: string
  lastOpenedAt?: string
}

export interface Video {
  removalMode?: 'trash' | 'remove'
  id: string
  filePath: string
  fileName: string
  fileHash?: string
  durationSec?: number
  width?: number
  height?: number
  codec?: string
  fps?: number
  bitrate?: number
  container?: string
  sizeBytes?: number
  title?: string
  rating: number
  memo: string
  tags: string
  category?: string
  createdAt: string
  updatedAt: string
  lastPlayedAt?: string
  resumePosSec: number
  playCount: number
  playTimeSec: number
  primaryThumbnailPath?: string
  hasSubtitles?: boolean
}

export interface Thumbnail {
  id: string
  videoId: string
  filePath: string
  timeSec: number
  isPrimary: boolean
  createdAt: string
}

export interface ThumbnailJob {
  libraryId: string
  videoId: string
  fileName: string
  phase: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  completed: number
  total: number
  error?: string
}

export interface Subtitle {
  id: string
  videoId: string
  filePath: string
  lang?: string
  encoding?: string
  type: 'srt' | 'vtt' | 'ass' | 'smi'
  trackIndex?: number
  isEmbedded: boolean
}

export interface SubtitleGenerationOptions {
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  language: 'auto' | 'ja' | 'en' | 'ko' | 'zh'
  translateToKorean: boolean
}

export interface SubtitleEngineInfo {
  available: boolean
  message: string
}

export interface SubtitleSetupComponent {
  id: 'whisper' | 'speechModel' | 'wsl' | 'python' | 'ollama' | 'translationModel'
  label: string
  state: 'checking' | 'missing' | 'installing' | 'ready' | 'failed'
  message?: string
  percent?: number
}

export interface SubtitleSetupStatus {
  phase: 'idle' | 'checking' | 'installing' | 'ready' | 'cancelled' | 'failed' | 'restart-required'
  message: string
  components: SubtitleSetupComponent[]
  updatedAt: string
  canCancel: boolean
  currentComponent?: SubtitleSetupComponent['id']
  stepStartedAt?: string
}

export interface CloudTranslationSettings {
  enabled: boolean
  hasApiKey: boolean
  monthlyLimit: number
  month: string
  usedCharacters: number
  externalCharacters: number
  remainingCharacters: number
  storageError?: string
}

export interface CloudTranslationSettingsPatch {
  enabled?: boolean
  apiKey?: string
  removeApiKey?: boolean
  monthlyLimit?: number
  externalCharacters?: number
}

export interface SubtitleGenerationJob {
  id: string
  title: string
  options: SubtitleGenerationOptions
  createdAt: string
  libraryId: string
  videoId: string
  phase:
    | 'queued'
    | 'pausing'
    | 'paused'
    | 'removing'
    | 'preparing'
    | 'loading'
    | 'transcribing'
    | 'translating'
    | 'saving'
    | 'completed'
    | 'cancelled'
    | 'failed'
  percent: number
  message: string
  outputPaths?: string[]
  storageError?: string
  processing?: {
    asr: 'unconfirmed' | 'vulkan' | 'cpu-legacy'
    device?: string
    evidence?: 'engine' | 'checkpoint'
    translation?: 'cloud' | 'ollama' | 'original-ko'
  }
}

export interface Highlight {
  id: string
  videoId: string
  timeStart: number
  timeEnd?: number
  label?: string
  color: 'yellow' | 'red' | 'blue' | 'green' | 'purple'
  createdAt: string
}

export interface HighlightCreate {
  videoId: string
  timeStart: number
  timeEnd?: number
  label?: string
  color?: Highlight['color']
}

export interface DailyStats {
  date: string // YYYY-MM-DD
  watchedSec: number
  videoCount: number
  sessionCount: number
}

export interface StatsDistribution {
  key: string
  label: string
  count: number
}

export interface LibraryStats {
  // Collection metrics and rankings cover active videos; viewing history also
  // includes retained records for videos removed from the library listing.
  totalVideos: number
  totalWatchedSec: number
  avgRating: number
  library: {
    totalDurationSec: number
    totalSizeBytes: number
    durationUnknownVideos: number
    sizeUnknownVideos: number
    watchedVideos: number
    unwatchedVideos: number
    ratedVideos: number
    subtitleVideos: number
    koreanSubtitleVideos: number
    generatedSubtitleVideos: number
    highlightedVideos: number
    highlightCount: number
    taggedVideos: number
  }
  period: {
    days: number
    startDate: string
    endDate: string
    watchedSec: number
    previousWatchedSec: number
    sessionCount: number
    previousSessionCount: number
    uniqueVideos: number
    activeDays: number
    averageSessionSec: number
    longestStreak: number
    addedVideos: number
  }
  dailyStats: DailyStats[]
  weekdayStats: Array<{ weekday: number; watchedSec: number; sessionCount: number }> // 0 = Sunday
  hourlyStats: Array<{ hour: number; watchedSec: number; sessionCount: number }>
  topVideos: Array<{
    id: string
    fileName: string
    title?: string
    watchedSec: number
    sessionCount: number
  }>
  distributions: {
    ratings: StatsDistribution[]
    resolutions: StatsDistribution[]
    formats: StatsDistribution[]
    durations: StatsDistribution[]
    tags: StatsDistribution[]
  }
}

export interface PlayHistoryEntry {
  id: string
  videoId: string
  startedAt: string
  endedAt?: string
  posStartSec: number
  posEndSec?: number
  durationWatchedSec?: number
}

export interface ImportProgress {
  libraryId?: string
  phase: 'scanning' | 'probing' | 'thumbnails' | 'done' | 'cancelled' | 'preparing' | 'applying'
  total: number
  current: number
  currentFile?: string
  errors: string[]
}

export interface ImportResult {
  cancelled?: boolean
  added: number
  skipped: number
  removed: number
  errors: string[]
}

export interface SearchQuery {
  removed?: boolean
  q?: string
  category?: string
  tag?: string
  rating?: number
  hasSubtitles?: boolean
  sortBy?:
    | 'title'
    | 'rating'
    | 'createdAt'
    | 'lastPlayedAt'
    | 'durationSec'
    | 'fileName'
    | 'playCount'
    | 'playTimeSec'
  sortDir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface SearchResult {
  videos: Video[]
  total: number
  page: number
  pageSize: number
}

export interface VideoMeta {
  title?: string
  rating?: number
  memo?: string
  tags?: string
  category?: string
  lastPlayedAt?: string
  playCount?: number
  playTimeSec?: number
}

export interface VideoMetadataOptions {
  categories: string[]
  tags: string[]
}

export interface CsvImportOptions {
  importRatings: boolean
  importFavoritesAsHighlights: boolean
}

export interface CsvImportPreview {
  csvPath: string
  totalRows: number
  filesRows: number
  favoritesRows: number
  ratedFileRows: number
  favoriteRowsWithStart: number
  matchedRatingRows: number
  ambiguousRatingRows: number
  unmatchedRatingRows: number
  matchedFavoriteRows: number
  ambiguousFavoriteRows: number
  unmatchedFavoriteRows: number
}

export interface CsvImportResult {
  preview: CsvImportPreview
  ratingsUpdated: number
  highlightsAdded: number
}

export interface NativePlayerInfo {
  name: 'mpv' | 'ffplay' | 'vlc'
  path: string
}

export interface NativePlayerOptions {
  startTimeSec?: number
  width?: number
  height?: number
  x?: number
  y?: number
}

export interface VideoEvent {
  videoId: string
}

export interface NativePlayerActionEvent extends VideoEvent {
  action: 'previousHighlight' | 'nextHighlight' | 'saveHighlight' | 'setThumbnail'
  timeSec: number
}

export interface Config {
  libraries: Library[]
  lastActiveLibraryId?: string
  cacheLimitGb?: number
  nativePlayer?: NativePlayerInfo | null
  githubStarPromptShown?: boolean
}

export interface AppSettings {
  cacheLimitGb: number
  nativePlayer?: NativePlayerInfo | null
}
/** Chromium capabilities, not the decoder selected for an individual video. */
export interface AccelerationInfo {
  videoDecodeStatus: string
  gpuCompositingStatus: string
}
export interface CacheInfo {
  usedBytes: number
  limitBytes: number
  fileCount: number
  protectedBytes: number
}
export interface CacheCleanupResult {
  removedBytes: number
  removedFiles: number
  info: CacheInfo
}

export interface ProbeData {
  durationSec?: number
  width?: number
  height?: number
  codec?: string
  fps?: number
  bitrate?: number
  container?: string
}
