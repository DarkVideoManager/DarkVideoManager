import { z } from 'zod'
import type { WindowApi } from '../../electron/preload'
import { err, ok, type Result } from '../../src/shared/result'
import {
  collectVideoMetadataOptions,
  hasVideoTag,
  normalizeVideoCategory,
  parseVideoSearch,
  serializeVideoTags,
} from '../../src/shared/videoMetadata'
import type {
  Highlight,
  LibraryStats,
  Thumbnail,
  Video,
  VideoMeta,
  SearchQuery,
  VideoEvent,
  SubtitleSetupStatus,
  SubtitleGenerationJob,
  SubtitleGenerationOptions,
} from '../../src/shared/types'
import {
  DEMO_LIBRARY_ID,
  DEMO_STORAGE_KEY,
  DEMO_SEED_PLAY_COUNTS,
  demoLibrary,
  demoMedia,
  demoSubtitles,
  demoVtt,
  makeDemoVideos,
  makeDemoThumbnails,
  makeDemoHighlights,
  makeDemoHistory,
  demoGeneratedVtt,
  correctDemoCaptionText,
} from './data'

const UNSUPPORTED = '브라우저 데모에서는 지원하지 않습니다. Windows 앱에서 사용할 수 있습니다.'
const STORAGE_LIMIT = 3 * 1024 * 1024
const colors = ['yellow', 'red', 'blue', 'green', 'purple'] as const
const mediaIds = new Set(demoMedia.map((media) => media.id))
const idSchema = z.string().refine((id) => mediaIds.has(id))
const timestamp = z.string().datetime()
const number = z.number().finite().nonnegative()
const metaSchema = z
  .object({
    title: z.string().max(160),
    rating: z.number().finite().min(0).max(5).multipleOf(0.5),
    memo: z.string().max(5000),
    tags: z.string().max(1000),
    category: z.string().max(160).optional(),
  })
  .strict()
const legacyStateSchema = z
  .object({
    version: z.literal(1),
    videos: z
      .array(
        metaSchema.extend({
          id: idSchema,
          removed: z.boolean(),
          updatedAt: timestamp,
          resumePosSec: number,
          playCount: number.int(),
          playTimeSec: number,
          lastPlayedAt: timestamp.optional(),
        }),
      )
      .min(3)
      .max(demoMedia.length),
    highlights: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            videoId: idSchema,
            timeStart: number,
            timeEnd: number.optional(),
            label: z.string().max(160).optional(),
            color: z.enum(colors),
            createdAt: timestamp,
          })
          .strict(),
      )
      .max(150),
    thumbnails: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            videoId: idSchema,
            filePath: z.string().max(600000),
            timeSec: number,
            isPrimary: z.boolean(),
            createdAt: timestamp,
          })
          .strict(),
      )
      .max(40),
    history: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            videoId: idSchema,
            startedAt: timestamp,
            watchedSec: number,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
const optionsSchema = z
  .object({
    model: z.enum(['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3']),
    language: z.enum(['auto', 'ja', 'en', 'ko', 'zh']),
    translateToKorean: z.boolean(),
  })
  .strict()
const trackSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    videoId: idSchema,
    lang: z.enum(['en', 'ko', 'ja', 'zh']),
    content: z.string().min(8).max(20000).startsWith('WEBVTT'),
    sampleGenerated: z.boolean(),
  })
  .strict()
const jobSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    videoId: idSchema,
    options: optionsSchema,
    createdAt: timestamp,
    phase: z.enum([
      'queued',
      'paused',
      'preparing',
      'loading',
      'transcribing',
      'translating',
      'saving',
      'completed',
      'cancelled',
      'failed',
    ]),
    percent: z.number().finite().min(0).max(100),
    message: z.string().min(1).max(500),
    elapsedMs: number.max(14000),
    outputTrackIds: z.array(z.string().max(100)).max(2),
    replaceTrackIds: z.array(z.string().max(100)).max(200),
  })
  .strict()
const previousStateSchema = legacyStateSchema
  .extend({
    version: z.literal(2),
    tracks: z.array(trackSchema).max(200),
    jobs: z.array(jobSchema).max(60),
  })
  .strict()
const thirdStateSchema = previousStateSchema.extend({ version: z.literal(3) }).strict()
const fourthStateSchema = thirdStateSchema.extend({ version: z.literal(4) }).strict()
const fifthStateSchema = fourthStateSchema.extend({ version: z.literal(5) }).strict()
const stateSchema = fifthStateSchema.extend({ version: z.literal(6) }).strict()
type DemoState = z.infer<typeof stateSchema>
type SavedVideo = DemoState['videos'][number]
type DemoJob = DemoState['jobs'][number]
type DemoTrack = DemoState['tracks'][number]
const terminalJobPhases = new Set<DemoJob['phase']>(['completed', 'cancelled', 'failed'])
const pendingJob = (job: DemoJob): boolean => !terminalJobPhases.has(job.phase)
const trackPath = (track: Pick<DemoTrack, 'videoId' | 'id' | 'lang'>): string => {
  const stem = demoMedia
    .find((media) => media.id === track.videoId)!
    .fileName.replace(/\.[^.]+$/, '')
  return `/demo-subtitles/${track.id}/${stem}.sample.${track.lang}.vtt`
}
const baseVideos = makeDemoVideos()
const copy = <T>(value: T): T => structuredClone(value)
const now = (): string => new Date().toISOString()
const duration = (videoId: string): number =>
  demoMedia.find((media) => media.id === videoId)?.durationSec ?? 0
const validTime = (videoId: string, time: number): boolean =>
  Number.isFinite(time) && time >= 0 && time <= duration(videoId)
const frameData = (path: string): boolean =>
  /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(path)

function initialState(): DemoState {
  const tracks: DemoTrack[] = demoMedia.flatMap((media) =>
    demoSubtitles(media.id).map((track) => ({
      id: track.id,
      videoId: media.id,
      lang: 'ko' as const,
      content: demoVtt(media.id)!,
      sampleGenerated: true,
    })),
  )
  return {
    version: 6,
    videos: baseVideos.map((video) => ({
      id: video.id,
      title: video.title ?? video.fileName,
      rating: video.rating,
      memo: video.memo,
      tags: video.tags,
      category: video.category ?? '',
      removed: false,
      updatedAt: video.updatedAt,
      resumePosSec: 0,
      playCount: video.playCount,
      playTimeSec: video.playTimeSec,
      lastPlayedAt: video.lastPlayedAt,
    })),
    highlights: makeDemoHighlights(),
    thumbnails: makeDemoThumbnails(),
    history: makeDemoHistory(),
    tracks,
    jobs: demoMedia
      .filter((media) => tracks.some((track) => track.videoId === media.id))
      .map((media) => ({
        id: `${media.id}-sample-completed`,
        videoId: media.id,
        options: { model: 'base', language: 'ko', translateToKorean: false },
        createdAt: demoLibrary.createdAt,
        phase: 'completed',
        percent: 100,
        message:
          '미리 준비한 체험 완료 예시입니다. 수작업 장면 설명 샘플이며 실제 AI 생성 결과가 아닙니다.',
        elapsedMs: 14000,
        outputTrackIds: tracks
          .filter((track) => track.videoId === media.id)
          .map((track) => track.id),
        replaceTrackIds: [],
      })),
  }
}

function parseState(raw: unknown): DemoState {
  let input = raw
  if (typeof raw === 'object' && raw !== null && 'version' in raw && raw.version === 1) {
    const old = legacyStateSchema.parse(raw)
    const seeded = initialState()
    const oldIds = new Set(old.videos.map((video) => video.id))
    const newHistory = seeded.history
      .filter(
        (entry) => oldIds.has(entry.videoId) && !old.history.some((item) => item.id === entry.id),
      )
      .slice(0, Math.max(0, 1000 - old.history.length))
    input = {
      ...old,
      version: 2,
      tracks: seeded.tracks.filter((track) => oldIds.has(track.videoId)),
      jobs: seeded.jobs.filter((job) => oldIds.has(job.videoId)),
      history: [...newHistory, ...old.history],
      videos: old.videos.map((video) => {
        const additions = newHistory.filter((entry) => entry.videoId === video.id)
        const lastPlayedAt = [video.lastPlayedAt, ...additions.map((entry) => entry.startedAt)]
          .filter((value): value is string => !!value)
          .sort()
          .at(-1)
        return {
          ...video,
          playCount: video.playCount + additions.length,
          playTimeSec:
            video.playTimeSec + additions.reduce((sum, entry) => sum + entry.watchedSec, 0),
          lastPlayedAt,
        }
      }),
    }
  }
  if (typeof input === 'object' && input !== null && 'version' in input && input.version === 2) {
    const old = previousStateSchema.parse(input)
    // Only add newly introduced inventory. Missing original IDs are corruption,
    // while removed=true and deleted child records are intentional user edits.
    if (
      !['baseball-1', 'baseball-2', 'baseball-3'].every((id) =>
        old.videos.some((video) => video.id === id),
      )
    )
      throw new Error('기존 영상 저장 항목 누락')
    const seeded = initialState()
    const newIds = new Set(
      seeded.videos
        .filter((video) => !old.videos.some((existing) => existing.id === video.id))
        .map((video) => video.id),
    )
    const history = seeded.history
      .filter((entry) => newIds.has(entry.videoId))
      .slice(0, Math.max(0, 1000 - old.history.length))
    const addedTracks = seeded.tracks
      .filter((item) => newIds.has(item.videoId))
      .slice(0, Math.max(0, 200 - old.tracks.length))
    input = {
      ...old,
      version: 3,
      videos: [
        ...old.videos,
        ...seeded.videos
          .filter((video) => newIds.has(video.id))
          .map((video) => {
            const entries = history.filter((entry) => entry.videoId === video.id)
            return {
              ...video,
              playCount: entries.length,
              playTimeSec: entries.reduce((sum, entry) => sum + entry.watchedSec, 0),
              lastPlayedAt: entries
                .map((entry) => entry.startedAt)
                .sort()
                .at(-1),
            }
          }),
      ],
      highlights: [
        ...old.highlights,
        ...seeded.highlights
          .filter((item) => newIds.has(item.videoId))
          .slice(0, Math.max(0, 150 - old.highlights.length)),
      ],
      thumbnails: [
        ...old.thumbnails,
        ...seeded.thumbnails
          .filter((item) => newIds.has(item.videoId))
          .slice(0, Math.max(0, 40 - old.thumbnails.length)),
      ],
      history: [...old.history, ...history],
      tracks: [...old.tracks, ...addedTracks],
      jobs: [
        ...old.jobs,
        ...seeded.jobs
          .filter(
            (item) =>
              newIds.has(item.videoId) &&
              item.outputTrackIds.every((id) => addedTracks.some((track) => track.id === id)),
          )
          .slice(0, Math.max(0, 60 - old.jobs.length)),
      ],
    }
  }
  if (typeof input === 'object' && input !== null && 'version' in input && input.version === 3) {
    const old = thirdStateSchema.parse(input)
    const isAdjustedSeed = (entry: DemoState['history'][number]): boolean =>
      entry.videoId in DEMO_SEED_PLAY_COUNTS &&
      new RegExp(`^demo-history-(?:\\d+-\\d+|curated-\\d+)-${entry.videoId}$`).test(entry.id)
    // Adjust only example watch records. Keep real sessions and all user-created
    // captions, captures, highlights and metadata, including removed videos.
    const history = old.history.filter((entry) => !isAdjustedSeed(entry))
    const templates = makeDemoHistory()
    const videos = old.videos.map((video) => {
      const target = DEMO_SEED_PLAY_COUNTS[video.id]
      if (target === undefined) return video
      const oldSeeds = old.history.filter(
        (entry) => entry.videoId === video.id && isAdjustedSeed(entry),
      )
      const actualEntries = history.filter((entry) => entry.videoId === video.id)
      const actualCount = Math.max(actualEntries.length, video.playCount - oldSeeds.length, 0)
      const count = Math.min(Math.max(0, target - actualCount), 1000 - history.length)
      const samples = templates.filter((entry) => entry.videoId === video.id)
      const additions = samples
        .slice(samples.length - count)
        .map((entry) => oldSeeds.find((existing) => existing.id === entry.id) ?? entry)
      history.push(...additions)
      const sum = (entries: typeof history): number =>
        entries.reduce((total, entry) => total + entry.watchedSec, 0)
      return {
        ...video,
        rating: video.id === 'baseball-2' && video.rating === 4 ? 2.5 : video.rating,
        playCount: actualCount + additions.length,
        playTimeSec: Math.max(0, video.playTimeSec - sum(oldSeeds)) + sum(additions),
        lastPlayedAt: [
          ...actualEntries.map((entry) => entry.startedAt),
          ...additions.map((entry) => entry.startedAt),
          ...(actualCount > 0 && video.lastPlayedAt ? [video.lastPlayedAt] : []),
        ]
          .sort()
          .at(-1),
      }
    })
    input = { ...old, version: 4, videos, history }
  }
  if (typeof input === 'object' && input !== null && 'version' in input && input.version === 4) {
    const old = fourthStateSchema.parse(input)
    const originalMemo =
      '브라우저 체험용 CC0 영상입니다. 촬영: D. Benjamin Miller. 원본에 소리가 없는 영상입니다. 샘플 자막은 AI 생성 결과가 아닌 수작업 장면 설명입니다.'
    const john = baseVideos.find((video) => video.id === 'baseball-2')!
    input = {
      ...old,
      version: 5,
      videos: old.videos.map((video) =>
        video.id === john.id &&
        video.rating === 0 &&
        video.memo === originalMemo &&
        video.title === john.title
          ? { ...video, rating: john.rating }
          : video,
      ),
    }
  }
  if (typeof input === 'object' && input !== null && 'version' in input && input.version === 5) {
    const old = fifthStateSchema.parse(input)
    // Add only the new field. Existing tags, edits, removals and saved media state stay intact.
    input = {
      ...old,
      version: 6,
      videos: old.videos.map((video) => ({ ...video, category: video.category ?? '' })),
    }
  }
  const parsed = stateSchema.parse(input)
  const unique = (ids: string[]): boolean => new Set(ids).size === ids.length
  if (
    parsed.videos.length !== demoMedia.length ||
    !unique(parsed.videos.map((v) => v.id)) ||
    !unique(parsed.highlights.map((h) => h.id)) ||
    !unique(parsed.thumbnails.map((t) => t.id)) ||
    !unique(parsed.history.map((h) => h.id)) ||
    !unique(parsed.tracks.map((track) => track.id)) ||
    !unique(parsed.jobs.map((job) => job.id))
  )
    throw new Error('중복 저장 항목')
  for (const video of parsed.videos)
    if (!validTime(video.id, video.resumePosSec)) throw new Error('잘못된 재생 위치')
  for (const item of parsed.highlights) {
    if (
      !validTime(item.videoId, item.timeStart) ||
      (item.timeEnd !== undefined &&
        (!validTime(item.videoId, item.timeEnd) || item.timeEnd < item.timeStart))
    )
      throw new Error('잘못된 하이라이트 시간')
  }
  for (const item of parsed.thumbnails) {
    const media = demoMedia.find((m) => m.id === item.videoId)!
    if (
      !validTime(item.videoId, item.timeSec) ||
      (item.filePath !== `/demo-media/${media.poster}` && !frameData(item.filePath))
    )
      throw new Error('허용되지 않는 썸네일')
  }
  for (const id of mediaIds)
    if (parsed.thumbnails.filter((t) => t.videoId === id && t.isPrimary).length > 1)
      throw new Error('대표 썸네일 중복')
  for (const id of mediaIds)
    if (parsed.jobs.filter((job) => job.videoId === id && pendingJob(job)).length > 1)
      throw new Error('진행 중 체험 작업 중복')
  for (const job of parsed.jobs) {
    if (job.phase === 'completed' && job.percent !== 100) throw new Error('미완료 체험 작업')
    if (
      job.outputTrackIds.some((id) =>
        parsed.tracks.some((track) => track.id === id && track.videoId !== job.videoId),
      )
    )
      throw new Error('다른 영상의 체험 자막')
  }
  return parsed
}

function listen<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit<T>(listeners: Set<(event: T) => void>, event: T): void {
  for (const listener of listeners) {
    try {
      listener(copy(event))
    } catch {
      /* One view must not prevent other view updates. */
    }
  }
}

function imageFromData(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('이미지 처리는 브라우저에서만 가능합니다.'))
      return
    }
    const image = new Image()
    const timer = setTimeout(() => {
      image.src = ''
      reject(new Error('썸네일 이미지를 읽는 시간이 초과되었습니다.'))
    }, 10000)
    image.onload = () => {
      clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      clearTimeout(timer)
      reject(new Error('유효한 썸네일 이미지가 아닙니다.'))
    }
    image.src = dataUrl
  })
}

function canvasFrame(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('영상 프레임이 아직 준비되지 않았습니다.')
  const scale = Math.min(1, 640 / width, 480 / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('이 브라우저에서 화면을 캡처할 수 없습니다.')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.8)
}

async function captureFrame(
  src: string,
  requestedTime: number,
): Promise<{ dataUrl: string; timeSec: number }> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const wait = (events: string[], ready: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        events.forEach((event) => video.removeEventListener(event, check))
        video.removeEventListener('error', failed)
      }
      const check = (): void => {
        if (ready()) {
          cleanup()
          resolve()
        }
      }
      const failed = (): void => {
        cleanup()
        reject(new Error('샘플 영상을 읽지 못해 썸네일을 캡처하지 못했습니다.'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('영상 프레임을 기다리는 시간이 초과되었습니다. 다시 시도해 주세요.'))
      }, 15000)
      events.forEach((event) => video.addEventListener(event, check))
      video.addEventListener('error', failed)
      check()
    })
  try {
    video.src = src
    video.load()
    await wait(['loadedmetadata', 'loadeddata'], () => video.readyState >= 1)
    if (!Number.isFinite(video.duration) || video.duration <= 0)
      throw new Error('영상 길이를 확인하지 못했습니다.')
    const timeSec = Math.max(0, Math.min(requestedTime, video.duration - 0.02))
    video.currentTime = timeSec
    await wait(
      ['seeked', 'loadeddata', 'canplay'],
      () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - timeSec) < 0.05,
    )
    return {
      dataUrl: canvasFrame(video, video.videoWidth, video.videoHeight),
      timeSec: video.currentTime,
    }
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

export interface DemoSimulationClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export function createDemoAdapter(
  providedStorage?: Storage,
  simulationClock?: DemoSimulationClock,
) {
  let storage: Storage | undefined
  let storageError: string | null = null
  let state = initialState()
  let generation = 0
  try {
    storage = providedStorage ?? window.localStorage
    const saved = storage.getItem(DEMO_STORAGE_KEY)
    if (saved !== null) {
      if (saved.length * 2 > STORAGE_LIMIT) throw new Error('큰 저장 데이터')
      const loaded = parseState(JSON.parse(saved))
      for (const job of loaded.jobs) {
        if (pendingJob(job) && job.phase !== 'paused') {
          job.phase = 'paused'
          job.message =
            '다시 연 체험 작업을 일시정지했습니다. 재개하면 남은 샘플 단계를 이어갑니다.'
        }
      }
      state = loaded
      const normalized = JSON.stringify(loaded)
      if (normalized.length * 2 > STORAGE_LIMIT) throw new Error('큰 저장 데이터')
      if (normalized !== saved) storage.setItem(DEMO_STORAGE_KEY, normalized)
    }
  } catch {
    storageError =
      '데모 저장 데이터를 읽을 수 없습니다. 브라우저 저장 권한을 확인하거나 데모를 초기화해 주세요.'
  }
  const thumbnails = new Set<(event: VideoEvent) => void>()
  const highlights = new Set<(event: VideoEvent) => void>()
  const sessions = new Map<
    string,
    { id: string; position: number; sampledAt: number; startedAt: string }
  >()
  const captureJobs = new Map<string, Promise<Result<Thumbnail, string>>>()
  const clock: DemoSimulationClock = simulationClock ?? {
    now: () => performance.now(),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer),
  }
  let queueTimer: ReturnType<typeof setTimeout> | undefined
  let queueSampledAt = clock.now()
  let runningJobId: string | undefined
  let disposed = false
  const ownedJobs = new Set<string>()
  const queueFailures = new Map<string, string>()
  const unsupported = async () => err(UNSUPPORTED)
  const knownLibrary = (id: string): boolean => id === DEMO_LIBRARY_ID
  const savedVideo = (libraryId: string, videoId: string): SavedVideo | undefined =>
    knownLibrary(libraryId) ? state.videos.find((v) => v.id === videoId) : undefined
  const snapshot = (item: SavedVideo): Video => ({
    ...baseVideos.find((video) => video.id === item.id)!,
    ...item,
    removalMode: item.removed ? 'remove' : undefined,
    primaryThumbnailPath: state.thumbnails.find((t) => t.videoId === item.id && t.isPrimary)
      ?.filePath,
    hasSubtitles: state.tracks.some((track) => track.videoId === item.id),
  })
  const notifyThumbnail = (videoId: string): void => emit(thumbnails, { videoId })
  const notifyHighlight = (videoId: string): void => emit(highlights, { videoId })

  function commit<T>(mutate: (draft: DemoState) => T): Result<T, string> {
    if (!storage || storageError)
      return err(storageError ?? '브라우저 저장소를 사용할 수 없습니다.')
    try {
      const draft = copy(state)
      const value = mutate(draft)
      const checked = parseState(draft)
      const serialized = JSON.stringify(checked)
      if (serialized.length * 2 > STORAGE_LIMIT)
        return err(
          '데모 저장 공간이 가득 찼습니다. 캡처한 썸네일을 삭제하거나 데모를 초기화한 뒤 다시 저장해 주세요.',
        )
      storage.setItem(DEMO_STORAGE_KEY, serialized)
      state = checked
      return ok(copy(value))
    } catch (error) {
      return err(
        error instanceof z.ZodError
          ? '저장할 데이터의 형식이나 개수가 허용 범위를 벗어났습니다.'
          : '브라우저에 저장하지 못했습니다. 저장 권한·남은 용량을 확인해 주세요. 변경 사항은 적용되지 않았습니다.',
      )
    }
  }

  const reset = (): Result<null, string> => {
    try {
      if (!storage) storage = providedStorage ?? window.localStorage
      storage.removeItem(DEMO_STORAGE_KEY)
      generation += 1
      stopQueue()
      ownedJobs.clear()
      queueFailures.clear()
      state = initialState()
      storageError = null
      sessions.clear()
      for (const media of demoMedia) {
        notifyThumbnail(media.id)
        notifyHighlight(media.id)
      }
      return ok(null)
    } catch {
      return err('데모 데이터를 초기화하지 못했습니다. 브라우저 저장 권한을 확인해 주세요.')
    }
  }

  function stopQueue(): void {
    if (queueTimer !== undefined) clock.clearTimeout(queueTimer)
    queueTimer = undefined
    runningJobId = undefined
  }

  function publicJob(job: DemoJob): SubtitleGenerationJob {
    const failure = queueFailures.get(job.id)
    return {
      id: job.id,
      libraryId: DEMO_LIBRARY_ID,
      videoId: job.videoId,
      title: `체험 · ${state.videos.find((video) => video.id === job.videoId)?.title ?? job.videoId}`,
      options: copy(job.options),
      createdAt: job.createdAt,
      phase: failure ? 'failed' : job.phase,
      percent: job.percent,
      message: failure ?? job.message,
      outputPaths: state.tracks
        .filter((track) => job.outputTrackIds.includes(track.id))
        .map(trackPath),
    }
  }

  function simulationPhase(job: DemoJob): void {
    const elapsed = job.elapsedMs
    const translating = job.options.translateToKorean && job.options.language !== 'ko'
    const stages: Array<[number, DemoJob['phase'], string]> = [
      [
        2000,
        'preparing',
        '체험: 무음 샘플 영상의 장면 설명을 준비하고 있습니다. 실제 음성을 분석하지 않습니다.',
      ],
      [
        4000,
        'loading',
        `체험: ${job.options.model} 모델 선택 화면을 재현하고 있습니다. 모델을 내려받거나 실행하지 않습니다.`,
      ],
      [
        8500,
        'transcribing',
        '체험: 미리 작성한 수작업 샘플 자막을 단계별로 표시하고 있습니다. 실제 AI 음성 인식이 아닙니다.',
      ],
      [
        11500,
        translating ? 'translating' : 'saving',
        translating
          ? '체험: 미리 준비한 한국어 샘플 자막을 연결하고 있습니다. 번역 서버로 전송하지 않습니다.'
          : '체험: 선택한 언어의 수작업 샘플 자막을 브라우저 저장소에 저장할 준비를 합니다.',
      ],
      [14000, 'saving', '체험: 샘플 자막과 작업 기록을 이 브라우저에 저장하고 있습니다.'],
    ]
    const stage = stages.find(([until]) => elapsed < until) ?? stages.at(-1)!
    job.phase = stage[1]
    job.message = stage[2]
    job.percent = Math.min(99, Math.floor(elapsed / 140))
  }

  function scheduleQueue(): void {
    if (queueTimer !== undefined || disposed || storageError) return
    const job = state.jobs.find(
      (item) =>
        ownedJobs.has(item.id) &&
        pendingJob(item) &&
        item.phase !== 'paused' &&
        !queueFailures.has(item.id),
    )
    if (!job) {
      runningJobId = undefined
      return
    }
    if (runningJobId !== job.id) {
      runningJobId = job.id
      queueSampledAt = clock.now()
    }
    queueTimer = clock.setTimeout(() => {
      queueTimer = undefined
      const current = state.jobs.find((item) => item.id === runningJobId)
      if (
        !current ||
        !pendingJob(current) ||
        current.phase === 'paused' ||
        !ownedJobs.has(current.id)
      ) {
        runningJobId = undefined
        scheduleQueue()
        return
      }
      const elapsed = Math.max(0, Math.min(1000, clock.now() - queueSampledAt))
      queueSampledAt = clock.now()
      const completed = current.elapsedMs + elapsed >= 14000
      const result = commit((draft) => {
        const updating = draft.jobs.find((item) => item.id === current.id)!
        updating.elapsedMs = Math.min(14000, updating.elapsedMs + elapsed)
        if (completed) {
          const language = updating.options.language === 'auto' ? 'en' : updating.options.language
          const languages =
            updating.options.translateToKorean && language !== 'ko' ? [language, 'ko'] : [language]
          const tracks: DemoTrack[] = languages.map((lang) => ({
            id: `${updating.id}-${lang}`,
            videoId: updating.videoId,
            lang: lang as DemoTrack['lang'],
            content: demoGeneratedVtt(updating.videoId, lang) ?? '',
            sampleGenerated: true,
          }))
          draft.tracks = draft.tracks.filter(
            (track) => !updating.replaceTrackIds.includes(track.id),
          )
          draft.tracks.push(...tracks)
          updating.outputTrackIds = tracks.map((track) => track.id)
          updating.phase = 'completed'
          updating.percent = 100
          updating.message =
            '체험 완료: 수작업 샘플 자막을 이 브라우저에 저장했습니다. 실제 AI 생성·번역 결과가 아닙니다.'
        } else simulationPhase(updating)
        return null
      })
      if (!result.ok) {
        queueFailures.set(
          current.id,
          `체험 작업 저장 실패: ${result.error} 저장 공간을 확보한 뒤 재개해 주세요.`,
        )
        ownedJobs.delete(current.id)
        runningJobId = undefined
      } else if (completed) {
        ownedJobs.delete(current.id)
        runningJobId = undefined
        notifyThumbnail(current.videoId)
      }
      scheduleQueue()
    }, 500)
  }

  function enqueue(
    libraryId: string,
    videoId: string,
    options: SubtitleGenerationOptions,
    replaceTrackIds: string[] = [],
  ): Result<SubtitleGenerationJob, string> {
    const video = savedVideo(libraryId, videoId)
    if (!video || video.removed) return err('체험할 샘플 영상을 찾을 수 없습니다.')
    const checkedOptions = optionsSchema.safeParse(options)
    if (!checkedOptions.success) return err('체험 모델과 언어 선택이 올바르지 않습니다.')
    if (state.jobs.some((job) => job.videoId === videoId && pendingJob(job)))
      return err(
        '이 영상의 체험 작업이 진행 중입니다. 먼저 취소하거나 일시정지한 작업을 재개해 주세요.',
      )
    if (
      !Array.isArray(replaceTrackIds) ||
      new Set(replaceTrackIds).size !== replaceTrackIds.length ||
      replaceTrackIds.some(
        (id) => !state.tracks.some((track) => track.id === id && track.videoId === videoId),
      )
    )
      return err('교체할 체험 자막을 다시 선택해 주세요.')
    const job: DemoJob = {
      id: crypto.randomUUID(),
      videoId,
      options: checkedOptions.data,
      createdAt: now(),
      phase: 'queued',
      percent: 0,
      message: replaceTrackIds.length
        ? '재생성 체험 대기 중입니다. 완료될 때 선택한 자막을 새 수작업 샘플로 교체합니다.'
        : '자막 생성 체험 대기 중입니다. 약 14초 동안 샘플 단계를 재현하며 실제 AI는 실행하지 않습니다.',
      elapsedMs: 0,
      outputTrackIds: [],
      replaceTrackIds: [...replaceTrackIds],
    }
    const result = commit((draft) => {
      draft.jobs.push(job)
      return null
    })
    if (!result.ok) return result
    ownedJobs.add(job.id)
    scheduleQueue()
    return ok(publicJob(job))
  }

  function jobAction(
    jobId: string,
    action: 'pause' | 'resume' | 'remove' | 'cancel',
  ): Result<boolean, string> {
    const job = state.jobs.find((item) => item.id === jobId)
    if (!job) return ok(false)
    if (action === 'pause' && (!pendingJob(job) || job.phase === 'paused')) return ok(false)
    if (action === 'cancel' && !pendingJob(job)) return ok(false)
    if (
      action === 'resume' &&
      job.phase !== 'paused' &&
      job.phase !== 'failed' &&
      !queueFailures.has(job.id)
    )
      return ok(false)
    const result = commit((draft) => {
      if (action === 'remove') draft.jobs = draft.jobs.filter((item) => item.id !== jobId)
      else {
        const updating = draft.jobs.find((item) => item.id === jobId)!
        updating.phase =
          action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'queued'
        updating.message =
          action === 'pause'
            ? '체험을 일시정지했습니다. 재개하면 같은 샘플 단계부터 이어집니다.'
            : action === 'cancel'
              ? '체험을 취소했습니다. 기존에 저장한 자막은 보존됩니다.'
              : '체험을 다시 대기열에 넣었습니다. 남은 샘플 단계를 이어갑니다.'
      }
      return true
    })
    if (result.ok) {
      queueFailures.delete(jobId)
      if (action === 'resume') ownedJobs.add(jobId)
      else ownedJobs.delete(jobId)
      if (runningJobId === jobId) stopQueue()
      scheduleQueue()
    }
    return result
  }

  const deleteThumbnail = (
    libraryId: string,
    thumbnailId: string,
    videoId: string,
  ): Result<null, string> => {
    if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
    if (!state.thumbnails.some((t) => t.id === thumbnailId && t.videoId === videoId))
      return err('썸네일을 찾을 수 없습니다.')
    const result = commit((draft) => {
      draft.thumbnails = draft.thumbnails.filter((t) => t.id !== thumbnailId)
      const remaining = draft.thumbnails.filter((t) => t.videoId === videoId)
      if (remaining.length && !remaining.some((t) => t.isPrimary)) remaining[0].isPrimary = true
      return null
    })
    if (result.ok) notifyThumbnail(videoId)
    return result
  }

  function saveFrame(
    libraryId: string,
    videoId: string,
    timeSec: number,
    dataUrl: string,
    makePrimary: boolean,
  ): Result<Thumbnail, string> {
    if (!savedVideo(libraryId, videoId) || !validTime(videoId, timeSec))
      return err('샘플 영상 또는 캡처 시간이 올바르지 않습니다.')
    if (!frameData(dataUrl) || dataUrl.length > 600000)
      return err('지원하는 크기의 캡처 이미지가 아닙니다.')
    const result = commit((draft) => {
      const thumbnail: Thumbnail = {
        id: crypto.randomUUID(),
        videoId,
        filePath: dataUrl,
        timeSec,
        isPrimary: makePrimary || !draft.thumbnails.some((t) => t.videoId === videoId),
        createdAt: now(),
      }
      if (thumbnail.isPrimary)
        draft.thumbnails
          .filter((t) => t.videoId === videoId)
          .forEach((t) => {
            t.isPrimary = false
          })
      draft.thumbnails.push(thumbnail)
      return thumbnail
    })
    if (result.ok) notifyThumbnail(videoId)
    return result
  }

  const capture = async (
    libraryId: string,
    videoId: string,
    timeSec: number,
    makePrimary = true,
  ): Promise<Result<Thumbnail, string>> => {
    const item = savedVideo(libraryId, videoId)
    if (!item || item.removed || !validTime(videoId, timeSec))
      return err('샘플 영상 또는 캡처 시간이 올바르지 않습니다.')
    const captureGeneration = generation
    const key = `${captureGeneration}:${videoId}:${timeSec}:${makePrimary}`
    const pending = captureJobs.get(key)
    if (pending) return pending
    const job = (async (): Promise<Result<Thumbnail, string>> => {
      try {
        const frame = await captureFrame(
          baseVideos.find((v) => v.id === videoId)!.filePath,
          timeSec,
        )
        if (captureGeneration !== generation)
          return err('캡처 중 데모 데이터가 변경되었습니다. 다시 캡처해 주세요.')
        return saveFrame(
          libraryId,
          videoId,
          Math.min(duration(videoId), frame.timeSec),
          frame.dataUrl,
          makePrimary,
        )
      } catch (error) {
        return err(error instanceof Error ? error.message : '썸네일 캡처에 실패했습니다.')
      } finally {
        captureJobs.delete(key)
      }
    })()
    captureJobs.set(key, job)
    return job
  }

  function recordPosition(
    libraryId: string,
    videoId: string,
    position: number,
    seeking: boolean,
    ending = false,
  ): Result<null, string> {
    const item = savedVideo(libraryId, videoId)
    if (!item || !validTime(videoId, position)) return err('재생 위치가 올바르지 않습니다.')
    const session = sessions.get(videoId)
    const sampledAt = performance.now()
    const watched =
      session && !seeking
        ? Math.min(
            Math.max(0, position - session.position),
            Math.max(0, (sampledAt - session.sampledAt) / 1000),
          )
        : 0
    const result = commit((draft) => {
      const video = draft.videos.find((v) => v.id === videoId)!
      video.resumePosSec = position
      if (watched > 0 && session) {
        let history = draft.history.find((h) => h.id === session.id)
        if (!history) {
          history = { id: session.id, videoId, startedAt: session.startedAt, watchedSec: 0 }
          draft.history.push(history)
          video.playCount += 1
        }
        history.watchedSec += watched
        video.playTimeSec += watched
        video.lastPlayedAt = now()
      }
      return null
    })
    if (result.ok && session) {
      session.position = position
      session.sampledAt = sampledAt
    }
    if (ending) sessions.delete(videoId)
    return result
  }

  function stats(requestedDays = 30): LibraryStats {
    const days = Math.max(1, Math.min(365, Math.floor(requestedDays)))
    const dateKey = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayAt = (offset: number): Date => {
      const date = new Date(today)
      date.setDate(date.getDate() + offset)
      return date
    }
    const start = dateKey(dayAt(1 - days)),
      previousStart = dateKey(dayAt(1 - 2 * days))
    const history = state.history.filter((h) => dateKey(new Date(h.startedAt)) >= start)
    const previous = state.history.filter((h) => {
      const key = dateKey(new Date(h.startedAt))
      return key >= previousStart && key < start
    })
    const sum = (items: typeof history): number =>
      items.reduce((total, h) => total + h.watchedSec, 0)
    const videos = state.videos.filter((v) => !v.removed).map(snapshot)
    const count = (predicate: (v: Video) => boolean): number => videos.filter(predicate).length
    const rated = videos.filter((v) => v.rating > 0)
    const distribution = (keys: Array<[string, string]>, classify: (v: Video) => string) =>
      keys.map(([key, label]) => ({ key, label, count: count((v) => classify(v) === key) }))
    const dailyStats = Array.from({ length: days }, (_, index) => {
      const date = dateKey(dayAt(index + 1 - days)),
        items = history.filter((h) => dateKey(new Date(h.startedAt)) === date)
      return {
        date,
        watchedSec: sum(items),
        sessionCount: items.length,
        videoCount: new Set(items.map((h) => h.videoId)).size,
      }
    })
    let streak = 0,
      longestStreak = 0
    for (const day of dailyStats) {
      streak = day.sessionCount ? streak + 1 : 0
      longestStreak = Math.max(streak, longestStreak)
    }
    const tags = new Map<string, number>()
    videos.forEach((v) =>
      new Set(
        v.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ).forEach((tag) => tags.set(tag, (tags.get(tag) ?? 0) + 1)),
    )
    return {
      totalVideos: videos.length,
      totalWatchedSec: state.videos.reduce((total, v) => total + v.playTimeSec, 0),
      avgRating: rated.length ? rated.reduce((total, v) => total + v.rating, 0) / rated.length : 0,
      library: {
        totalDurationSec: videos.reduce((total, v) => total + (v.durationSec ?? 0), 0),
        totalSizeBytes: videos.reduce((total, v) => total + (v.sizeBytes ?? 0), 0),
        durationUnknownVideos: count((v) => !v.durationSec),
        sizeUnknownVideos: count((v) => v.sizeBytes === undefined),
        watchedVideos: count((v) => v.playTimeSec > 0),
        unwatchedVideos: count((v) => v.playTimeSec === 0),
        ratedVideos: rated.length,
        subtitleVideos: count((v) => !!v.hasSubtitles),
        koreanSubtitleVideos: count((v) =>
          state.tracks.some((track) => track.videoId === v.id && track.lang === 'ko'),
        ),
        generatedSubtitleVideos: count((v) =>
          state.tracks.some((track) => track.videoId === v.id && track.sampleGenerated),
        ),
        highlightedVideos: count((v) => state.highlights.some((h) => h.videoId === v.id)),
        highlightCount: state.highlights.filter((h) => videos.some((v) => v.id === h.videoId))
          .length,
        taggedVideos: count((v) => !!v.tags.trim()),
      },
      period: {
        days,
        startDate: start,
        endDate: dateKey(today),
        watchedSec: sum(history),
        previousWatchedSec: sum(previous),
        sessionCount: history.length,
        previousSessionCount: previous.length,
        uniqueVideos: new Set(history.map((h) => h.videoId)).size,
        activeDays: dailyStats.filter((d) => d.sessionCount > 0).length,
        averageSessionSec: history.length ? sum(history) / history.length : 0,
        longestStreak,
        addedVideos: count((v) => dateKey(new Date(v.createdAt)) >= start),
      },
      dailyStats,
      weekdayStats: Array.from({ length: 7 }, (_, weekday) => {
        const items = history.filter((h) => new Date(h.startedAt).getDay() === weekday)
        return { weekday, watchedSec: sum(items), sessionCount: items.length }
      }),
      hourlyStats: Array.from({ length: 24 }, (_, hour) => {
        const items = history.filter((h) => new Date(h.startedAt).getHours() === hour)
        return { hour, watchedSec: sum(items), sessionCount: items.length }
      }),
      topVideos: videos
        .filter((v) => v.playTimeSec > 0)
        .sort((a, b) => b.playTimeSec - a.playTimeSec)
        .slice(0, 10)
        .map((v) => ({
          id: v.id,
          fileName: v.fileName,
          title: v.title,
          watchedSec: v.playTimeSec,
          sessionCount: v.playCount,
        })),
      distributions: {
        ratings: distribution(
          Array.from({ length: 11 }, (_, step) => {
            const rating = step / 2
            return [String(rating), rating ? `${rating}점` : '미평가']
          }),
          (v) => String(v.rating),
        ),
        resolutions: distribution(
          [
            ['sd', 'SD'],
            ['720p', 'HD · 720p'],
            ['1080p', 'FHD · 1080p'],
            ['1440p', 'QHD · 1440p'],
            ['4k', '4K 이상'],
            ['unknown', '미확인'],
          ],
          (v) => {
            const side = Math.min(v.width ?? 0, v.height ?? 0)
            return !side
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
          },
        ),
        durations: distribution(
          [
            ['under5', '5분 미만'],
            ['5to20', '5분 – 20분'],
            ['20to60', '20분 – 1시간'],
            ['60plus', '1시간 이상'],
            ['unknown', '미확인'],
          ],
          (v) =>
            !v.durationSec
              ? 'unknown'
              : v.durationSec < 300
                ? 'under5'
                : v.durationSec < 1200
                  ? '5to20'
                  : v.durationSec < 3600
                    ? '20to60'
                    : '60plus',
        ),
        formats: [{ key: 'MP4', label: 'MP4', count: videos.length }],
        tags: [...tags]
          .map(([label, count]) => ({ key: label, label, count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
          .slice(0, 10),
      },
    }
  }

  const setup = (): SubtitleSetupStatus => ({
    phase: 'ready',
    message:
      '브라우저 자막 생성 체험이 준비되었습니다. 설치·다운로드·실제 AI 실행 없이 수작업 샘플로 진행 단계를 재현합니다.',
    canCancel: false,
    updatedAt: demoLibrary.createdAt,
    components: [
      ['whisper', 'Whisper 음성 인식 엔진'],
      ['speechModel', 'Whisper 기본 모델'],
      ['wsl', 'Windows 자막 실행 환경'],
      ['python', '자막 처리 도구'],
      ['ollama', 'Ollama 번역 엔진'],
      ['translationModel', '한국어 번역 모델 (qwen3:8b)'],
    ].map(([id, label]) => ({
      id: id as SubtitleSetupStatus['components'][number]['id'],
      label: `${label} · 체험`,
      state: 'ready',
      message: '체험용 화면만 준비됨. 실제 프로그램이나 모델을 설치·실행한 상태가 아닙니다.',
    })),
  })

  const api = {
    temporaryPlayback: { openDroppedFiles: unsupported, close: unsupported },
    privacy: {
      get: async () =>
        ok({
          maskThumbnails: false,
          revealOnHover: true,
          exitAction: 'blank' as const,
          exitUrl: '',
        }),
      save: unsupported,
      // PrivacyBoundary pauses browser media and displays its blank screen itself.
      exit: async () => ok('blank' as const),
    },
    discovery: {
      query: unsupported,
      favorite: unsupported,
      tags: unsupported,
    },
    metadataImport: {
      getSettings: unsupported,
      updateSettings: unsupported,
      search: unsupported,
      apply: unsupported,
    },
    maintenance: {
      previewNames: unsupported,
      applyNames: unsupported,
      findDuplicates: unsupported,
      cancel: unsupported,
    },
    app: {
      getAccelerationInfo: async () =>
        ok({ videoDecodeStatus: 'unknown', gpuCompositingStatus: 'unknown' }),
      getNativePlayers: async () => ok([]),
      selectNativePlayer: unsupported,
      quit: async () => {
        if (typeof window === 'undefined')
          return err('브라우저 체험에서만 라이브러리로 돌아갈 수 있습니다.')
        window.location.hash = '#/'
        return ok(null)
      },
      getSettings: async () => ok({ cacheLimitGb: 0, seekStepSec: 1, nativePlayer: null }),
      updateSettings: unsupported,
      getCacheInfo: unsupported,
      cleanCache: unsupported,
    },
    dataImport: {
      selectCsv: unsupported,
      preview: unsupported,
      importCsv: unsupported,
    },
    library: {
      list: async () => ok([copy(demoLibrary)]),
      open: async (id: string) =>
        knownLibrary(id) ? ok(copy(demoLibrary)) : err('샘플 라이브러리를 찾을 수 없습니다.'),
      close: async (id: string) =>
        knownLibrary(id) ? ok(null) : err('샘플 라이브러리를 찾을 수 없습니다.'),
      create: unsupported,
      delete: unsupported,
      selectFolder: unsupported,
      selectFolders: unsupported,
      importFolder: unsupported,
      importFolders: unsupported,
      selectFiles: unsupported,
      importFiles: unsupported,
      refresh: unsupported,
      cancelWork: unsupported,
    },
    videos: {
      metadataOptions: async (libraryId: string, removed = false) =>
        knownLibrary(libraryId)
          ? ok(
              collectVideoMetadataOptions(
                state.videos.filter((video) => video.removed === removed),
              ),
            )
          : err('샘플 라이브러리를 찾을 수 없습니다.'),
      revealSource: unsupported,
      search: async (libraryId: string, query: SearchQuery) => {
        if (!knownLibrary(libraryId)) return err('샘플 라이브러리를 찾을 수 없습니다.')
        const page = query.page ?? 1,
          pageSize = query.pageSize ?? 50
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 1000 ||
          (query.rating !== undefined &&
            (!Number.isFinite(query.rating) || query.rating < 0 || query.rating > 5))
        )
          return err('검색 조건이 올바르지 않습니다.')
        const search = parseVideoSearch(query.q)
        const words = search.text.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean)
        const videos = state.videos
          .filter((v) => v.removed === !!query.removed)
          .map(snapshot)
          .filter(
            (v) =>
              (query.rating === undefined || v.rating >= query.rating) &&
              (query.hasSubtitles === undefined || !!v.hasSubtitles === query.hasSubtitles) &&
              (query.category === undefined ||
                v.category === normalizeVideoCategory(query.category)) &&
              (!query.tag || hasVideoTag(v.tags, query.tag)) &&
              search.tags.every((tag) => hasVideoTag(v.tags, tag)) &&
              words.every((word) =>
                `${v.title} ${v.fileName} ${v.memo} ${v.tags}`
                  .normalize('NFKC')
                  .toLocaleLowerCase()
                  .includes(word),
              ),
          )
        const sortBy = query.sortBy ?? 'createdAt',
          direction = query.sortDir === 'desc' ? -1 : 1
        videos.sort((a, b) => {
          const left = a[sortBy] ?? '',
            right = b[sortBy] ?? ''
          const result =
            typeof left === 'number' && typeof right === 'number'
              ? left - right
              : String(left).localeCompare(String(right), 'ko', { numeric: true })
          return direction * result || a.id.localeCompare(b.id)
        })
        return ok(
          copy({
            videos: videos.slice((page - 1) * pageSize, page * pageSize),
            total: videos.length,
            page,
            pageSize,
          }),
        )
      },
      get: async (libraryId: string, videoId: string) => {
        const v = savedVideo(libraryId, videoId)
        return knownLibrary(libraryId)
          ? ok(v ? copy(snapshot(v)) : null)
          : err('샘플 라이브러리를 찾을 수 없습니다.')
      },
      getPlaybackSource: async (libraryId: string, videoId: string) => {
        const v = savedVideo(libraryId, videoId)
        return v && !v.removed
          ? ok(baseVideos.find((item) => item.id === videoId)!.filePath)
          : err('재생할 샘플 영상을 찾을 수 없습니다.')
      },
      getNativePlayerInfo: async () => ok(null),
      openInNativePlayer: unsupported,
      setActivePlaybackRate: unsupported,
      seekActivePlayback: unsupported,
      updateMeta: async (libraryId: string, videoId: string, meta: VideoMeta) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        const patch = metaSchema.partial().safeParse(meta)
        if (!patch.success) return err('제목·메모·카테고리·태그·0~5점 별점만 수정할 수 있습니다.')
        if (patch.data.category !== undefined)
          patch.data.category = normalizeVideoCategory(patch.data.category)
        if (patch.data.tags !== undefined) patch.data.tags = serializeVideoTags(patch.data.tags)
        return commit((draft) => {
          Object.assign(
            draft.videos.find((v) => v.id === videoId)!,
            patch.data,
            {
              updatedAt: now(),
            },
          )
          return null
        })
      },
      delete: async (libraryId: string, videoId: string, mode: 'trash' | 'remove' = 'trash') => {
        if (mode !== 'remove')
          return err(
            '데모에서는 실제 영상 파일을 휴지통으로 옮길 수 없습니다. 목록에서 제외 기능을 사용해 주세요.',
          )
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        return commit((draft) => {
          draft.videos.find((v) => v.id === videoId)!.removed = true
          return null
        })
      },
      restore: async (libraryId: string, videoId: string) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        return commit((draft) => {
          draft.videos.find((v) => v.id === videoId)!.removed = false
          return null
        })
      },
    },
    playback: {
      listConversionQueue: async () => ok([]),
      pauseConversion: unsupported,
      resumeConversion: unsupported,
      removeConversion: unsupported,
      start: async (libraryId: string, videoId: string) => {
        const video = savedVideo(libraryId, videoId)
        if (!video || video.removed) return err('재생할 샘플 영상을 찾을 수 없습니다.')
        if (!sessions.has(videoId))
          sessions.set(videoId, {
            id: crypto.randomUUID(),
            position: video.resumePosSec,
            sampledAt: performance.now(),
            startedAt: now(),
          })
        return ok(sessions.get(videoId)!.id)
      },
      heartbeat: async (libraryId: string, videoId: string, position: number) =>
        recordPosition(libraryId, videoId, position, false),
      seek: async (libraryId: string, videoId: string, position: number) =>
        recordPosition(libraryId, videoId, position, true),
      end: async (libraryId: string, videoId: string, position: number) =>
        recordPosition(libraryId, videoId, position, false, true),
    },
    thumbnails: {
      listJobs: async (libraryId: string) =>
        knownLibrary(libraryId) ? ok([]) : err('샘플 라이브러리를 찾을 수 없습니다.'),
      cancelForVideo: unsupported,
      getForVideo: async (libraryId: string, videoId: string) =>
        savedVideo(libraryId, videoId)
          ? ok(copy(state.thumbnails.filter((t) => t.videoId === videoId)))
          : err('샘플 영상을 찾을 수 없습니다.'),
      setPrimary: async (libraryId: string, thumbnailId: string, videoId: string) => {
        if (
          !savedVideo(libraryId, videoId) ||
          !state.thumbnails.some((t) => t.id === thumbnailId && t.videoId === videoId)
        )
          return err('썸네일을 찾을 수 없습니다.')
        const result = commit((draft) => {
          draft.thumbnails
            .filter((t) => t.videoId === videoId)
            .forEach((t) => {
              t.isPrimary = t.id === thumbnailId
            })
          return null
        })
        if (result.ok) notifyThumbnail(videoId)
        return result
      },
      ensureForVideo: async (libraryId: string, videoId: string, force = false) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        if (!force && state.thumbnails.some((t) => t.videoId === videoId)) return ok(false)
        const result = await capture(libraryId, videoId, 0, true)
        return result.ok ? ok(true) : result
      },
      captureAtTime: capture,
      saveImageCapture: async (
        libraryId: string,
        videoId: string,
        timeSec: number,
        dataUrl: string,
        makePrimary = true,
      ) => {
        if (
          !savedVideo(libraryId, videoId) ||
          !validTime(videoId, timeSec) ||
          typeof dataUrl !== 'string' ||
          dataUrl.length > 8000000 ||
          !frameData(dataUrl)
        )
          return err('유효한 샘플 영상 캡처 이미지가 아닙니다.')
        try {
          const captureGeneration = generation
          const image = await imageFromData(dataUrl)
          if (captureGeneration !== generation)
            return err('이미지를 읽는 동안 데모 데이터가 변경되었습니다. 다시 저장해 주세요.')
          return saveFrame(
            libraryId,
            videoId,
            timeSec,
            canvasFrame(image, image.naturalWidth, image.naturalHeight),
            makePrimary,
          )
        } catch (error) {
          return err(
            error instanceof Error ? error.message : '썸네일 이미지를 저장하지 못했습니다.',
          )
        }
      },
    },
    highlights: {
      list: async (libraryId: string, videoId: string) =>
        savedVideo(libraryId, videoId)
          ? ok(
              copy(
                state.highlights
                  .filter((h) => h.videoId === videoId)
                  .sort((a, b) => a.timeStart - b.timeStart),
              ),
            )
          : err('샘플 영상을 찾을 수 없습니다.'),
      create: async (libraryId: string, data: import('../../src/shared/types').HighlightCreate) => {
        if (
          !savedVideo(libraryId, data.videoId) ||
          !validTime(data.videoId, data.timeStart) ||
          (data.timeEnd !== undefined &&
            (!validTime(data.videoId, data.timeEnd) || data.timeEnd < data.timeStart))
        )
          return err('하이라이트 시간이 올바르지 않습니다.')
        const result = commit((draft) => {
          const highlight: Highlight = {
            ...data,
            id: crypto.randomUUID(),
            color: data.color ?? 'yellow',
            createdAt: now(),
          }
          draft.highlights.push(highlight)
          return highlight
        })
        if (result.ok) notifyHighlight(data.videoId)
        return result
      },
      update: async (
        libraryId: string,
        id: string,
        patch: Partial<import('../../src/shared/types').HighlightCreate>,
      ) => {
        const item = knownLibrary(libraryId) ? state.highlights.find((h) => h.id === id) : undefined
        if (!item) return err('하이라이트를 찾을 수 없습니다.')
        if (patch.videoId !== undefined && patch.videoId !== item.videoId)
          return err('다른 영상으로 하이라이트를 이동할 수 없습니다.')
        const updated = { ...item, ...patch }
        if (
          !validTime(item.videoId, updated.timeStart) ||
          (updated.timeEnd !== undefined &&
            (!validTime(item.videoId, updated.timeEnd) || updated.timeEnd < updated.timeStart))
        )
          return err('하이라이트 시간이 올바르지 않습니다.')
        const result = commit((draft) => {
          Object.assign(
            draft.highlights.find((h) => h.id === id)!,
            patch,
          )
          return null
        })
        if (result.ok) notifyHighlight(item.videoId)
        return result
      },
      delete: async (libraryId: string, id: string) => {
        const item = knownLibrary(libraryId) ? state.highlights.find((h) => h.id === id) : undefined
        if (!item) return err('하이라이트를 찾을 수 없습니다.')
        const result = commit((draft) => {
          draft.highlights = draft.highlights.filter((h) => h.id !== id)
          return null
        })
        if (result.ok) notifyHighlight(item.videoId)
        return result
      },
    },
    subtitles: {
      getSetupStatus: async () => ok(setup()),
      checkSetup: async () => ok(setup()),
      startSetup: async () => ok(setup()),
      cancelSetup: async () => ok(false),
      getTranslationSettings: async () =>
        ok({
          enabled: false,
          hasApiKey: false,
          monthlyLimit: 0,
          month: now().slice(0, 7),
          usedCharacters: 0,
          externalCharacters: 0,
          remainingCharacters: 0,
          storageError:
            '체험에서는 미리 작성한 한국어 샘플을 사용합니다. 클라우드 번역과 API 키 저장은 Windows 앱에서 설정해 주세요.',
        }),
      updateTranslationSettings: async () =>
        err(
          '브라우저 체험에는 API 키가 필요하지 않으며 입력한 키를 저장·전송하지 않습니다. 실제 클라우드 번역은 Windows 앱에서 설정해 주세요.',
        ),
      listQueue: async () => (storageError ? err(storageError) : ok(state.jobs.map(publicJob))),
      pauseJob: async (jobId: string) => jobAction(jobId, 'pause'),
      resumeJob: async (jobId: string) => jobAction(jobId, 'resume'),
      removeJob: async (jobId: string) => jobAction(jobId, 'remove'),
      getEngineInfo: async () =>
        ok({
          available: true,
          message:
            '자막 생성 체험을 사용할 수 있습니다. 약 14초간 화면 흐름을 재현하고 수작업 샘플을 저장합니다. 실제 AI·GPU·번역 서버는 실행하지 않습니다.',
        }),
      generate: async (libraryId: string, videoId: string, options: SubtitleGenerationOptions) =>
        enqueue(libraryId, videoId, options),
      regenerate: async (
        libraryId: string,
        videoId: string,
        subtitleIds: string[],
        options: SubtitleGenerationOptions,
      ) => {
        if (!Array.isArray(subtitleIds) || !subtitleIds.length)
          return err('재생성 체험으로 교체할 자막을 선택해 주세요.')
        return enqueue(libraryId, videoId, options, subtitleIds)
      },
      cancelGeneration: async (libraryId: string, videoId: string) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        const job = state.jobs.find((item) => item.videoId === videoId && pendingJob(item))
        return job ? jobAction(job.id, 'cancel') : ok(false)
      },
      getGenerationStatus: async (libraryId: string, videoId: string) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        if (storageError) return err(storageError)
        const jobs = state.jobs.filter((job) => job.videoId === videoId)
        const job = jobs.find(pendingJob) ?? jobs.at(-1)
        return ok(job ? publicJob(job) : null)
      },
      getForVideo: async (libraryId: string, videoId: string) => {
        if (!savedVideo(libraryId, videoId)) return err('샘플 영상을 찾을 수 없습니다.')
        const tracks = state.tracks.filter((track) => track.videoId === videoId)
        return ok(
          tracks.map((track) => {
            return {
              id: track.id,
              videoId: track.videoId,
              filePath: trackPath(track),
              lang: track.lang,
              encoding: 'UTF-8',
              type: 'vtt' as const,
              isEmbedded: false,
            }
          }),
        )
      },
      convertToVtt: unsupported,
      readText: async (libraryId: string, subtitlePath: string) => {
        if (!knownLibrary(libraryId)) return err('샘플 라이브러리를 찾을 수 없습니다.')
        const track = state.tracks.find(
          (item) =>
            trackPath(item) === subtitlePath ||
            demoSubtitles(item.videoId).some(
              (original) => original.id === item.id && original.filePath === subtitlePath,
            ),
        )
        return track
          ? ok(correctDemoCaptionText(track.videoId, track.content))
          : err('데모에 포함된 수작업 장면 설명 자막만 읽을 수 있습니다.')
      },
    },
    stats: {
      get: async (libraryId: string, days?: number) =>
        knownLibrary(libraryId) && (days === undefined || Number.isFinite(days))
          ? ok(stats(days))
          : err('통계 조회 조건이 올바르지 않습니다.'),
    },
    on: {
      importProgress: (_listener: Parameters<WindowApi['on']['importProgress']>[0]) => () =>
        undefined,
      thumbnailReady: (listener: (event: VideoEvent) => void) => listen(thumbnails, listener),
      highlightChanged: (listener: (event: VideoEvent) => void) => listen(highlights, listener),
      nativePlayerEscape: (_listener: Parameters<WindowApi['on']['nativePlayerEscape']>[0]) => () =>
        undefined,
      nativePlayerSpeed: (_listener: Parameters<WindowApi['on']['nativePlayerSpeed']>[0]) => () =>
        undefined,
      nativePlayerAction: (_listener: Parameters<WindowApi['on']['nativePlayerAction']>[0]) => () =>
        undefined,
    },
  } satisfies WindowApi

  const synchronize = (event: StorageEvent): void => {
    if (event.key !== DEMO_STORAGE_KEY) return
    generation += 1
    try {
      if (event.newValue && event.newValue.length * 2 > STORAGE_LIMIT)
        throw new Error('큰 저장 데이터')
      state = event.newValue === null ? initialState() : parseState(JSON.parse(event.newValue))
      storageError = null
      sessions.clear()
      stopQueue()
      for (const id of ownedJobs)
        if (!state.jobs.some((job) => job.id === id && pendingJob(job) && job.phase !== 'paused'))
          ownedJobs.delete(id)
      scheduleQueue()
      for (const media of demoMedia) {
        notifyThumbnail(media.id)
        notifyHighlight(media.id)
      }
    } catch {
      storageError = '다른 탭에서 저장한 데모 데이터가 올바르지 않습니다. 데모를 초기화해 주세요.'
      stopQueue()
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', synchronize)
  return {
    api,
    reset,
    deleteThumbnail,
    getStorageError: () => storageError,
    dispose: () => {
      generation += 1
      disposed = true
      stopQueue()
      ownedJobs.clear()
      queueFailures.clear()
      if (typeof window !== 'undefined') window.removeEventListener('storage', synchronize)
      sessions.clear()
      thumbnails.clear()
      highlights.clear()
    },
  }
}

const adapter = createDemoAdapter()
export const demoApi: WindowApi = adapter.api
export const resetDemoState = adapter.reset
export const deleteDemoThumbnail = adapter.deleteThumbnail
export const getDemoStorageError = adapter.getStorageError
