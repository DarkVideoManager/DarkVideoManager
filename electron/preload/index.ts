import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../../src/shared/channels'
import type {
  Library,
  Video,
  Thumbnail,
  ThumbnailJob,
  Subtitle,
  SubtitleEngineInfo,
  SubtitleSetupStatus,
  CloudTranslationSettings,
  CloudTranslationSettingsPatch,
  SubtitleGenerationOptions,
  SubtitleGenerationJob,
  Highlight,
  HighlightCreate,
  SearchQuery,
  SearchResult,
  VideoMeta,
  VideoMetadataOptions,
  ImportResult,
  ImportProgress,
  LibraryStats,
  CsvImportOptions,
  CsvImportPreview,
  CsvImportResult,
  NativePlayerInfo,
  NativePlayerOptions,
  NativePlayerActionEvent,
  VideoEvent,
  AppSettings,
  AccelerationInfo,
  CacheInfo,
  CacheCleanupResult,
} from '../../src/shared/types'
import type { Result } from '../../src/shared/result'
import type {
  StashSettings,
  StashSettingsPatch,
  MetadataSearchResult,
  MetadataSearchMode,
  MetadataApply,
  MetadataApplyResult,
} from '../../src/shared/metadataImport'
import type { PlaybackConversionJob } from '../../src/shared/playbackConversion'
import type {
  CleanupRule,
  DuplicateResult,
  RenamePreview,
  RenameResult,
} from '../../src/shared/maintenance'

import type { PrivacySettings } from '../../src/shared/privacy'
import type {
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryPreferences,
} from '../../src/shared/discovery'

const api = {
  temporaryPlayback: {
    openDroppedFiles: async (
      files: File[],
    ): Promise<Result<{ token: string; fileName: string; sourceUrl: string }, string>> => {
      if (!Array.isArray(files) || files.length !== 1)
        return { ok: false, error: '영상 파일을 한 번에 하나씩 놓아 주세요.' }
      try {
        const path = webUtils.getPathForFile(files[0])
        if (!path) return { ok: false, error: '탐색기의 로컬 영상 파일을 놓아 주세요.' }
        return ipcRenderer.invoke(IPC.TEMPORARY_PLAYBACK.OPEN, path)
      } catch {
        return { ok: false, error: '탐색기의 로컬 영상 파일을 놓아 주세요.' }
      }
    },
    close: (token: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.TEMPORARY_PLAYBACK.CLOSE, token),
  },
  privacy: {
    get: (): Promise<Result<PrivacySettings, string>> => ipcRenderer.invoke(IPC.PRIVACY.GET),
    save: (settings: PrivacySettings): Promise<Result<PrivacySettings, string>> =>
      ipcRenderer.invoke(IPC.PRIVACY.SAVE, settings),
    exit: (): Promise<Result<PrivacySettings['exitAction'], string>> =>
      ipcRenderer.invoke(IPC.PRIVACY.EXIT),
  },
  discovery: {
    query: (libraryId: string, query: DiscoveryQuery): Promise<Result<DiscoveryResult, string>> =>
      ipcRenderer.invoke(IPC.DISCOVERY.QUERY, libraryId, query),
    favorite: (
      libraryId: string,
      videoId: string,
      favorite: boolean,
    ): Promise<Result<DiscoveryPreferences, string>> =>
      ipcRenderer.invoke(IPC.DISCOVERY.FAVORITE, libraryId, videoId, favorite),
    tags: (libraryId: string, tags: string[]): Promise<Result<DiscoveryPreferences, string>> =>
      ipcRenderer.invoke(IPC.DISCOVERY.TAGS, libraryId, tags),
  },
  metadataImport: {
    getSettings: (): Promise<Result<StashSettings, string>> =>
      ipcRenderer.invoke(IPC.METADATA_IMPORT.GET_SETTINGS),
    updateSettings: (patch: StashSettingsPatch): Promise<Result<StashSettings, string>> =>
      ipcRenderer.invoke(IPC.METADATA_IMPORT.UPDATE_SETTINGS, patch),
    search: (
      query: string,
      mode: MetadataSearchMode = 'text',
    ): Promise<Result<MetadataSearchResult, string>> =>
      ipcRenderer.invoke(IPC.METADATA_IMPORT.SEARCH, query, mode),
    apply: (
      libraryId: string,
      videoId: string,
      input: MetadataApply,
    ): Promise<Result<MetadataApplyResult, string>> =>
      ipcRenderer.invoke(IPC.METADATA_IMPORT.APPLY, libraryId, videoId, input),
  },
  maintenance: {
    previewNames: (libraryId: string, rule: CleanupRule): Promise<Result<RenamePreview, string>> =>
      ipcRenderer.invoke(IPC.MAINTENANCE.PREVIEW_NAMES, libraryId, rule),
    applyNames: (
      libraryId: string,
      previewId: string,
      videoIds: string[],
    ): Promise<Result<RenameResult, string>> =>
      ipcRenderer.invoke(IPC.MAINTENANCE.APPLY_NAMES, libraryId, previewId, videoIds),
    findDuplicates: (libraryId: string): Promise<Result<DuplicateResult, string>> =>
      ipcRenderer.invoke(IPC.MAINTENANCE.FIND_DUPLICATES, libraryId),
    cancel: (libraryId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.MAINTENANCE.CANCEL, libraryId),
  },
  app: {
    githubStar: {
      claimPrompt: (): Promise<Result<boolean, string>> =>
        ipcRenderer.invoke(IPC.APP.CLAIM_GITHUB_STAR_PROMPT),
      openRepository: (): Promise<Result<null, string>> =>
        ipcRenderer.invoke(IPC.APP.OPEN_GITHUB_REPOSITORY),
    },
    getAccelerationInfo: (): Promise<Result<AccelerationInfo, string>> =>
      ipcRenderer.invoke(IPC.APP.GET_ACCELERATION_INFO),
    getNativePlayers: (): Promise<Result<NativePlayerInfo[], string>> =>
      ipcRenderer.invoke(IPC.APP.GET_NATIVE_PLAYERS),
    selectNativePlayer: (
      name: NativePlayerInfo['name'],
    ): Promise<Result<NativePlayerInfo | null, string>> =>
      ipcRenderer.invoke(IPC.APP.SELECT_NATIVE_PLAYER, name),
    getSettings: (): Promise<Result<AppSettings, string>> =>
      ipcRenderer.invoke(IPC.APP.GET_SETTINGS),
    updateSettings: (patch: Partial<AppSettings>): Promise<Result<AppSettings, string>> =>
      ipcRenderer.invoke(IPC.APP.UPDATE_SETTINGS, patch),
    getCacheInfo: (): Promise<Result<CacheInfo, string>> =>
      ipcRenderer.invoke(IPC.APP.GET_CACHE_INFO),
    cleanCache: (): Promise<Result<CacheCleanupResult, string>> =>
      ipcRenderer.invoke(IPC.APP.CLEAN_CACHE),
    quit: (): Promise<Result<null, string>> => ipcRenderer.invoke(IPC.APP.QUIT),
  },
  dataImport: {
    selectCsv: (): Promise<Result<string | null, string>> =>
      ipcRenderer.invoke(IPC.DATA_IMPORT.SELECT_CSV),
    preview: (libraryId: string, csvPath: string): Promise<Result<CsvImportPreview, string>> =>
      ipcRenderer.invoke(IPC.DATA_IMPORT.PREVIEW, libraryId, csvPath),
    importCsv: (
      libraryId: string,
      csvPath: string,
      options: CsvImportOptions,
    ): Promise<Result<CsvImportResult, string>> =>
      ipcRenderer.invoke(IPC.DATA_IMPORT.IMPORT, libraryId, csvPath, options),
  },
  library: {
    list: (): Promise<Result<Library[], string>> => ipcRenderer.invoke(IPC.LIBRARY.LIST),
    open: (libraryId: string): Promise<Result<Library, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.OPEN, libraryId),
    create: (name: string, folderPath: string | string[]): Promise<Result<Library, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.CREATE, name, folderPath),
    close: (libraryId: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.CLOSE, libraryId),
    delete: (libraryId: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.DELETE, libraryId),
    selectFolder: (): Promise<Result<string | null, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.SELECT_FOLDER),
    selectFolders: (): Promise<Result<string[] | null, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.SELECT_FOLDERS),
    importFolder: (libraryId: string, folderPath: string): Promise<Result<ImportResult, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.IMPORT_FOLDER, libraryId, folderPath),
    importFolders: (
      libraryId: string,
      folderPaths: string[],
    ): Promise<Result<ImportResult, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.IMPORT_FOLDERS, libraryId, folderPaths),
    selectFiles: (): Promise<Result<string[] | null, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.SELECT_FILES),
    importFiles: (libraryId: string, filePaths: string[]): Promise<Result<ImportResult, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.IMPORT_FILES, libraryId, filePaths),
    refresh: (libraryId: string): Promise<Result<ImportResult, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.REFRESH, libraryId),
    cancelWork: (libraryId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.LIBRARY.CANCEL_WORK, libraryId),
  },
  videos: {
    metadataOptions: (
      libraryId: string,
      removed = false,
    ): Promise<Result<VideoMetadataOptions, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.METADATA_OPTIONS, libraryId, removed),
    search: (libraryId: string, query: SearchQuery): Promise<Result<SearchResult, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.SEARCH, libraryId, query),
    get: (libraryId: string, videoId: string): Promise<Result<Video | null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.GET, libraryId, videoId),
    revealSource: (libraryId: string, videoId: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.REVEAL_SOURCE, libraryId, videoId),
    getPlaybackSource: (libraryId: string, videoId: string): Promise<Result<string, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.GET_PLAYBACK_SOURCE, libraryId, videoId),
    getNativePlayerInfo: (): Promise<Result<NativePlayerInfo | null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.GET_NATIVE_PLAYER_INFO),
    openInNativePlayer: (
      libraryId: string,
      videoId: string,
      options?: NativePlayerOptions,
    ): Promise<Result<NativePlayerInfo, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.OPEN_IN_NATIVE_PLAYER, libraryId, videoId, options),
    setActivePlaybackRate: (
      libraryId: string,
      videoId: string,
      rate: number,
    ): Promise<Result<number, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.SET_ACTIVE_PLAYBACK_RATE, libraryId, videoId, rate),
    seekActivePlayback: (
      libraryId: string,
      videoId: string,
      timeSec: number,
    ): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.SEEK_ACTIVE_PLAYBACK, libraryId, videoId, timeSec),
    updateMeta: (
      libraryId: string,
      videoId: string,
      meta: VideoMeta,
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.UPDATE_META, libraryId, videoId, meta),
    delete: (
      libraryId: string,
      videoId: string,
      mode?: 'trash' | 'remove',
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.DELETE, libraryId, videoId, mode),
    restore: (libraryId: string, videoId: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.VIDEOS.RESTORE, libraryId, videoId),
  },
  playback: {
    listConversionQueue: (): Promise<Result<PlaybackConversionJob[], string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.LIST_CONVERSION_QUEUE),
    pauseConversion: (jobId: string): Promise<Result<PlaybackConversionJob, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.PAUSE_CONVERSION, jobId),
    resumeConversion: (jobId: string): Promise<Result<PlaybackConversionJob, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.RESUME_CONVERSION, jobId),
    removeConversion: (jobId: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.REMOVE_CONVERSION, jobId),
    start: (libraryId: string, videoId: string): Promise<Result<string, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.START, libraryId, videoId),
    heartbeat: (
      libraryId: string,
      videoId: string,
      positionSec: number,
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.HEARTBEAT, libraryId, videoId, positionSec),
    seek: (
      libraryId: string,
      videoId: string,
      positionSec: number,
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.SEEK, libraryId, videoId, positionSec),
    end: (libraryId: string, videoId: string, positionSec: number): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.PLAYBACK.END, libraryId, videoId, positionSec),
  },
  thumbnails: {
    listJobs: (libraryId: string): Promise<Result<ThumbnailJob[], string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.LIST_JOBS, libraryId),
    cancelForVideo: (libraryId: string, videoId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.CANCEL_FOR_VIDEO, libraryId, videoId),
    getForVideo: (libraryId: string, videoId: string): Promise<Result<Thumbnail[], string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.GET_FOR_VIDEO, libraryId, videoId),
    setPrimary: (
      libraryId: string,
      thumbnailId: string,
      videoId: string,
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.SET_PRIMARY, libraryId, thumbnailId, videoId),
    ensureForVideo: (
      libraryId: string,
      videoId: string,
      force?: boolean,
    ): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.ENSURE_FOR_VIDEO, libraryId, videoId, force ?? false),
    captureAtTime: (
      libraryId: string,
      videoId: string,
      timeSec: number,
      makePrimary = true,
    ): Promise<Result<Thumbnail, string>> =>
      ipcRenderer.invoke(IPC.THUMBNAILS.CAPTURE_AT_TIME, libraryId, videoId, timeSec, makePrimary),
    saveImageCapture: (
      libraryId: string,
      videoId: string,
      timeSec: number,
      dataUrl: string,
      makePrimary = true,
    ): Promise<Result<Thumbnail, string>> =>
      ipcRenderer.invoke(
        IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE,
        libraryId,
        videoId,
        timeSec,
        dataUrl,
        makePrimary,
      ),
  },
  highlights: {
    list: (libraryId: string, videoId: string): Promise<Result<Highlight[], string>> =>
      ipcRenderer.invoke(IPC.HIGHLIGHTS.LIST, libraryId, videoId),
    create: (libraryId: string, data: HighlightCreate): Promise<Result<Highlight, string>> =>
      ipcRenderer.invoke(IPC.HIGHLIGHTS.CREATE, libraryId, data),
    update: (
      libraryId: string,
      id: string,
      patch: Partial<HighlightCreate>,
    ): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.HIGHLIGHTS.UPDATE, libraryId, id, patch),
    delete: (libraryId: string, id: string): Promise<Result<null, string>> =>
      ipcRenderer.invoke(IPC.HIGHLIGHTS.DELETE, libraryId, id),
  },
  subtitles: {
    getSetupStatus: (): Promise<Result<SubtitleSetupStatus, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_SETUP_STATUS),
    checkSetup: (): Promise<Result<SubtitleSetupStatus, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.CHECK_SETUP),
    startSetup: (): Promise<Result<SubtitleSetupStatus, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.START_SETUP),
    cancelSetup: (): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.CANCEL_SETUP),
    getTranslationSettings: (): Promise<Result<CloudTranslationSettings, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_TRANSLATION_SETTINGS),
    updateTranslationSettings: (
      patch: CloudTranslationSettingsPatch,
    ): Promise<Result<CloudTranslationSettings, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.UPDATE_TRANSLATION_SETTINGS, patch),
    listQueue: (): Promise<Result<SubtitleGenerationJob[], string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.LIST_QUEUE),
    getConcurrency: (): Promise<Result<number, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_CONCURRENCY),
    setConcurrency: (limit: number): Promise<Result<number, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.SET_CONCURRENCY, limit),
    pauseJob: (jobId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.PAUSE_JOB, jobId),
    resumeJob: (jobId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.RESUME_JOB, jobId),
    removeJob: (jobId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.REMOVE_JOB, jobId),
    getEngineInfo: (): Promise<Result<SubtitleEngineInfo, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_ENGINE_INFO),
    generate: (
      libraryId: string,
      videoId: string,
      options: SubtitleGenerationOptions,
    ): Promise<Result<SubtitleGenerationJob, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GENERATE, libraryId, videoId, options),
    regenerate: (
      libraryId: string,
      videoId: string,
      subtitleIds: string[],
      options: SubtitleGenerationOptions,
    ): Promise<Result<SubtitleGenerationJob, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.REGENERATE, libraryId, videoId, subtitleIds, options),
    getGenerationStatus: (
      libraryId: string,
      videoId: string,
    ): Promise<Result<SubtitleGenerationJob | null, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_GENERATION_STATUS, libraryId, videoId),
    cancelGeneration: (libraryId: string, videoId: string): Promise<Result<boolean, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.CANCEL_GENERATION, libraryId, videoId),
    getForVideo: (libraryId: string, videoId: string): Promise<Result<Subtitle[], string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.GET_FOR_VIDEO, libraryId, videoId),
    convertToVtt: (
      libraryId: string,
      subtitlePath: string,
      type: 'smi' | 'srt',
    ): Promise<Result<string, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.CONVERT_TO_VTT, libraryId, subtitlePath, type),
    readText: (libraryId: string, subtitlePath: string): Promise<Result<string, string>> =>
      ipcRenderer.invoke(IPC.SUBTITLES.READ_TEXT, libraryId, subtitlePath),
  },
  stats: {
    get: (libraryId: string, days?: number): Promise<Result<LibraryStats, string>> =>
      ipcRenderer.invoke(IPC.STATS.GET, libraryId, days),
  },
  on: {
    importProgress: (cb: (progress: ImportProgress) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, p: ImportProgress) => cb(p)
      ipcRenderer.on(IPC.EVENTS.IMPORT_PROGRESS, listener)
      return () => {
        ipcRenderer.removeListener(IPC.EVENTS.IMPORT_PROGRESS, listener)
      }
    },
    thumbnailReady: (cb: (data: { videoId: string }) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, d: { videoId: string }) => cb(d)
      ipcRenderer.on(IPC.EVENTS.THUMBNAIL_READY, listener)
      return () => {
        ipcRenderer.removeListener(IPC.EVENTS.THUMBNAIL_READY, listener)
      }
    },
    highlightChanged: (cb: (data: VideoEvent) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: VideoEvent) => cb(data)
      ipcRenderer.on(IPC.EVENTS.HIGHLIGHT_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.EVENTS.HIGHLIGHT_CHANGED, listener)
    },
    nativePlayerEscape: (cb: (data: VideoEvent) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: VideoEvent) => cb(data)
      ipcRenderer.on(IPC.EVENTS.NATIVE_PLAYER_ESCAPE, listener)
      return () => ipcRenderer.removeListener(IPC.EVENTS.NATIVE_PLAYER_ESCAPE, listener)
    },
    nativePlayerSpeed: (cb: (data: { videoId: string; rate: number }) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: { videoId: string; rate: number }) =>
        cb(data)
      ipcRenderer.on(IPC.EVENTS.NATIVE_PLAYER_SPEED, listener)
      return () => ipcRenderer.removeListener(IPC.EVENTS.NATIVE_PLAYER_SPEED, listener)
    },
    nativePlayerAction: (cb: (data: NativePlayerActionEvent) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: NativePlayerActionEvent) => cb(data)
      ipcRenderer.on(IPC.EVENTS.NATIVE_PLAYER_ACTION, listener)
      return () => ipcRenderer.removeListener(IPC.EVENTS.NATIVE_PLAYER_ACTION, listener)
    },
  },
}

// Desktop-only capabilities may be omitted by browser demos and preview adapters.
export type WindowApi = Omit<typeof api, 'app'> & {
  app: Omit<typeof api.app, 'githubStar'> & { githubStar?: typeof api.app.githubStar }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (err) {
    console.error('[preload] contextBridge 등록 실패:', err)
  }
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
}
