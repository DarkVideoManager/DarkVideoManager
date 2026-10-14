import { shell } from 'electron'
import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { getDatabase } from '../db/connection'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { isVideoFile } from '../infra/fs'
import { throwIfWorkCancelled } from './LibraryWorkService'
import { matchSidecarSubtitle, subtitleExtensions, subtitleVideoKey } from './SubtitleService'

function pathKey(filePath: string): string {
  const normalized = resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function fileInfo(filePath: string): Stats | undefined {
  try {
    const info = lstatSync(filePath)
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error('일반 자막 파일만 삭제할 수 있습니다: ' + filePath)
    return info
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const FingerprintZ = z
  .object({
    dev: z.number().finite().nonnegative(),
    ino: z.number().finite().nonnegative(),
    size: z.number().finite().nonnegative(),
    mtimeMs: z.number().finite(),
    ctimeMs: z.number().finite(),
  })
  .strict()

export const SubtitleDeletionPlanZ = z
  .object({
    targets: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            filePath: z.string().min(1).refine(isAbsolute),
            fingerprint: FingerprintZ.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    completedIds: z.array(z.string().trim().min(1)).max(1000),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = new Set(plan.targets.map((target) => target.id))
    const completed = new Set(plan.completedIds)
    if (
      ids.size !== plan.targets.length ||
      completed.size !== plan.completedIds.length ||
      plan.completedIds.some((id) => !ids.has(id))
    )
      context.addIssue({ code: 'custom', message: '삭제 계획의 자막 ID가 올바르지 않습니다.' })
    const paths = new Map<string, { fingerprint: string; complete: boolean }>()
    for (const target of plan.targets) {
      const key = pathKey(target.filePath)
      const previous = paths.get(key)
      const fingerprint = JSON.stringify(target.fingerprint)
      const complete = completed.has(target.id)
      if (previous && (previous.fingerprint !== fingerprint || previous.complete !== complete))
        context.addIssue({ code: 'custom', message: '같은 파일의 삭제 계획 상태가 서로 다릅니다.' })
      paths.set(key, { fingerprint, complete })
    }
  })

export type SubtitleDeletionPlan = z.infer<typeof SubtitleDeletionPlanZ>
type Fingerprint = z.infer<typeof FingerprintZ>

function fingerprint(info: Stats): Fingerprint {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

function sameFile(first: Fingerprint, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  )
}

function deletionContext(libraryId: string, videoId: string) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다.')
  const assertWritable = () => {
    if (db.readonly || db.pragma('query_only', { simple: true }))
      throw new Error('읽기 전용 라이브러리의 자막은 삭제할 수 없습니다.')
  }
  assertWritable()
  const video = new VideoRepository(db).findById(videoId)
  if (!video || video.removalMode) throw new Error('자막을 삭제할 영상을 찾을 수 없습니다.')
  const directory = dirname(resolve(video.filePath))
  const realDirectory = pathKey(realpathSync(directory))
  const repository = new SubtitleRepository(db)
  const inspect = (filePath: string): Stats | undefined => {
    assertWritable()
    const currentVideo = new VideoRepository(db).findById(videoId)
    if (
      !currentVideo ||
      currentVideo.removalMode ||
      pathKey(currentVideo.filePath) !== pathKey(video.filePath)
    )
      throw new Error('삭제 중 영상 정보가 변경되었습니다. 목록을 새로 확인해 주세요.')
    if (
      pathKey(dirname(filePath)) !== pathKey(directory) ||
      !subtitleExtensions.has(extname(filePath).toLowerCase()) ||
      pathKey(realpathSync(directory)) !== realDirectory
    )
      throw new Error('영상 폴더 안의 외부 자막만 삭제할 수 있습니다: ' + filePath)
    const videoKeys = new Set(
      readdirSync(directory, { withFileTypes: true })
        .filter((item) => item.isFile() || item.isSymbolicLink())
        .map((item) => join(directory, item.name))
        .filter(isVideoFile)
        .map(subtitleVideoKey),
    )
    const videoKey = subtitleVideoKey(video.filePath)
    videoKeys.add(videoKey)
    if (matchSidecarSubtitle(filePath, videoKeys)?.videoKey !== videoKey)
      throw new Error('다른 영상의 자막이거나 소유 영상을 확인할 수 없습니다: ' + filePath)
    const shared = db
      .prepare('SELECT file_path FROM subtitles WHERE video_id <> ?')
      .all(videoId) as Array<{ file_path: string }>
    if (shared.some((item) => pathKey(item.file_path) === pathKey(filePath)))
      throw new Error('다른 영상에서도 사용하는 자막은 삭제할 수 없습니다: ' + filePath)
    const info = fileInfo(filePath)
    if (info && pathKey(dirname(realpathSync(filePath))) !== realDirectory)
      throw new Error('자막의 실제 경로가 영상 폴더 밖에 있습니다: ' + filePath)
    return info
  }
  return { db, repository, inspect }
}

/** Capture the confirmed files when adding a job; no file or metadata is deleted here. */
export function prepareSubtitleDeletion(
  libraryId: string,
  videoId: string,
  subtitleIds: string[],
): SubtitleDeletionPlan {
  if (
    !Array.isArray(subtitleIds) ||
    !subtitleIds.length ||
    subtitleIds.length > 1000 ||
    subtitleIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(subtitleIds).size !== subtitleIds.length
  )
    throw new Error('삭제할 자막을 중복 없이 선택해 주세요.')
  const { repository, inspect } = deletionContext(libraryId, videoId)
  const subtitles = repository.findByVideoId(videoId)
  const targets = subtitleIds.map((id) => {
    const subtitle = subtitles.find((item) => item.id === id)
    if (!subtitle) throw new Error('이 영상에 속한 자막만 삭제할 수 있습니다.')
    if (subtitle.isEmbedded) throw new Error('영상에 포함된 내장 자막은 삭제할 수 없습니다.')
    const filePath = resolve(subtitle.filePath)
    const info = inspect(filePath)
    return { id, filePath, fingerprint: info ? fingerprint(info) : null }
  })
  return SubtitleDeletionPlanZ.parse({ targets, completedIds: [] })
}

/** The caller holds the library work lock and persists the plan in onProgress. */
export async function executeSubtitleDeletion(
  libraryId: string,
  videoId: string,
  plan: SubtitleDeletionPlan,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<void> {
  throwIfWorkCancelled(signal)
  const validated = SubtitleDeletionPlanZ.parse(plan)
  const { db, repository, inspect } = deletionContext(libraryId, videoId)
  const completed = new Set(validated.completedIds)
  const groups = new Map<string, typeof validated.targets>()
  for (const target of validated.targets) {
    if (completed.has(target.id)) continue
    const key = pathKey(target.filePath)
    const group = groups.get(key) ?? []
    group.push(target)
    groups.set(key, group)
  }
  const check = (targets: typeof validated.targets) => {
    const target = targets[0]
    const info = inspect(target.filePath)
    for (const selected of targets) {
      const row = db
        .prepare('SELECT video_id, file_path, is_embedded FROM subtitles WHERE id = ?')
        .get(selected.id) as
        | { video_id: string; file_path: string; is_embedded: number }
        | undefined
      if (
        row &&
        (row.video_id !== videoId ||
          row.is_embedded ||
          pathKey(row.file_path) !== pathKey(selected.filePath))
      )
        throw new Error('삭제 중 자막 정보가 변경되었습니다. 목록을 새로 확인해 주세요.')
      // Missing rows are safe only if the file is already gone (an interrupted move).
      if (info && !row)
        throw new Error('삭제 중 자막 정보가 변경되었습니다. 목록을 새로 확인해 주세요.')
    }
    if (info && (!target.fingerprint || !sameFile(target.fingerprint, info)))
      throw new Error('삭제 중 자막 파일이 변경되었습니다. 목록을 새로 확인해 주세요.')
    return info
  }
  // A queued plan may be old. Validate all remaining targets before moving the first one.
  for (const targets of groups.values()) check(targets)

  let processed = 0
  let trashed = 0
  try {
    for (const targets of groups.values()) {
      throwIfWorkCancelled(signal)
      const current = check(targets)
      if (current) {
        await shell.trashItem(targets[0].filePath)
        trashed++
      }
      processed++
      // Record each completed move even if a later move or cancellation fails.
      db.transaction(() => {
        for (const target of targets) repository.delete(target.id)
      })()
      for (const target of targets) completed.add(target.id)
      plan.completedIds = [...completed]
      onProgress?.()
    }
    throwIfWorkCancelled(signal)
  } catch (error) {
    const progress = processed
      ? `${processed}개 자막을 처리했으며, ${trashed}개 파일은 휴지통으로 이동했습니다. `
      : '아직 삭제한 자막이 없습니다. '
    const failure = new Error(
      '자막 삭제를 완료하지 못했습니다. ' +
        progress +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    )
    if (error instanceof Error && error.name === 'AbortError') failure.name = 'AbortError'
    throw failure
  }
}

/** Compatibility wrapper for immediate deletion; queued callers retain the durable plan. */
export async function trashExternalSubtitles(
  libraryId: string,
  videoId: string,
  subtitleIds: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfWorkCancelled(signal)
  const plan = prepareSubtitleDeletion(libraryId, videoId, subtitleIds)
  await executeSubtitleDeletion(libraryId, videoId, plan, signal)
  return [...new Set(plan.targets.map((target) => target.filePath))]
}
