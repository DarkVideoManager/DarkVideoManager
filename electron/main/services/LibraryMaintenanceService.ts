import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, readdirSync, realpathSync, unlinkSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import SqliteDatabase, { type Database } from 'better-sqlite3'
import type {
  CleanupRule,
  DuplicateResult,
  RenamePreview,
  RenamePreviewRow,
  RenameResult,
} from '@shared/maintenance'
import { CleanupRuleZ, hasInvalidFilenameCharacters } from '@shared/maintenance'
import { getDatabase } from '../db/connection'
import { loadConfig } from '../infra/config'
import { isSourceFileInUse } from './SourceFileUsage'
import { listSubtitleQueue } from './SubtitleGenerationService'
import { listPlaybackConversionJobs } from './PlaybackConversionService'
import { withLibraryWork, throwIfWorkCancelled, yieldLibraryWork } from './LibraryWorkService'
import { isAbortError } from '../ffmpeg/queue'
import { subtitleExtensions } from './SubtitleService'

type VideoRow = { id: string; file_path: string; file_name: string }
type SubtitleRow = { id: string; file_path: string; is_embedded: number }
type Snapshot = { size: number; mtimeMs: number; ino: number; dev: number; canonical: string }
type PlannedRow = RenamePreviewRow & { snapshots: Snapshot[]; subtitles: SubtitleRow[] }
type Plan = { preview: RenamePreview; rows: PlannedRow[]; expires: number }
const previews = new Map<string, Plan>()
const activeMaintenance = new Map<string, AbortController>()
const MAX_ROWS = 500
const pathKey = (value: string) => resolve(value).toLowerCase()
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function withMaintenance<T>(
  libraryId: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withLibraryWork(libraryId, async (librarySignal) => {
    const controller = new AbortController()
    activeMaintenance.set(libraryId, controller)
    try {
      return await work(AbortSignal.any([librarySignal, controller.signal]))
    } finally {
      activeMaintenance.delete(libraryId)
    }
  })
}
export function cancelLibraryMaintenance(libraryId: string): boolean {
  const controller = activeMaintenance.get(libraryId)
  if (!controller) return false
  controller.abort()
  return true
}

function database(libraryId: string, writable = false): Database {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리를 먼저 열어 주세요.')
  if (writable && (db.readonly || db.pragma('query_only', { simple: true })))
    throw new Error('읽기 전용 라이브러리에서는 파일명을 변경할 수 없습니다.')
  return db
}
function videos(db: Database): VideoRow[] {
  return db
    .prepare(
      'SELECT id, file_path, file_name FROM videos WHERE removal_mode IS NULL ORDER BY file_name, id',
    )
    .all() as VideoRow[]
}
function subtitles(db: Database, videoId: string): SubtitleRow[] {
  return db
    .prepare('SELECT id, file_path, is_embedded FROM subtitles WHERE video_id = ? ORDER BY id')
    .all(videoId) as SubtitleRow[]
}
function snapshot(filePath: string): Snapshot {
  if (!isAbsolute(filePath)) throw new Error('파일의 절대 경로를 확인할 수 없습니다.')
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('일반 파일만 정리할 수 있습니다. 링크·폴더는 제외됩니다.')
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    dev: stat.dev,
    canonical: realpathSync(filePath),
  }
}
function sameFile(a: Snapshot, b: Snapshot): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ino === b.ino &&
    a.dev === b.dev &&
    pathKey(a.canonical) === pathKey(b.canonical)
  )
}
function assertUnused(libraryId: string, video: VideoRow): void {
  if (isSourceFileInUse(video.file_path))
    throw new Error('재생 중이거나 외부 플레이어에서 사용 중인 영상입니다. 플레이어를 닫아 주세요.')
  if (
    listSubtitleQueue().some(
      (job) =>
        job.libraryId === libraryId &&
        job.videoId === video.id &&
        !['completed', 'cancelled'].includes(job.phase),
    )
  )
    throw new Error(
      '대기·일시정지·실패 상태를 포함한 자막 작업이 있습니다. 재개해 완료하거나 큐에서 삭제해 주세요.',
    )
  if (
    listPlaybackConversionJobs().some(
      (job) =>
        job.libraryId === libraryId &&
        job.videoId === video.id &&
        !['completed', 'failed'].includes(job.status),
    )
  )
    throw new Error(
      '대기·일시정지 상태를 포함한 재생 변환 작업이 있습니다. 완료하거나 큐에서 삭제해 주세요.',
    )
}
function assertTargetAbsent(filePath: string): void {
  try {
    lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('변경할 이름의 파일이 이미 있습니다: ' + basename(filePath))
}
function validName(name: string): boolean {
  const stem = basename(name, extname(name))
  return (
    Boolean(stem.trim()) &&
    name.length <= 255 &&
    !hasInvalidFilenameCharacters(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
}

/** link() creates the destination exclusively; rename() can silently overwrite it. */
function moveWithoutOverwrite(from: string, to: string): void {
  const before = lstatSync(from)
  try {
    linkSync(from, to)
  } catch (error) {
    throw new Error(
      '대상 파일을 덮어쓰지 않는 이름 변경을 할 수 없습니다. 파일시스템의 하드 링크 지원과 권한·이름 충돌을 확인해 주세요. 원본 경로: ' +
        from +
        ' / ' +
        message(error),
    )
  }
  try {
    const source = lstatSync(from)
    const target = lstatSync(to)
    if (
      !source.isFile() ||
      !target.isFile() ||
      source.isSymbolicLink() ||
      target.isSymbolicLink() ||
      before.dev !== source.dev ||
      before.ino !== source.ino ||
      before.dev !== target.dev ||
      before.ino !== target.ino ||
      before.size !== source.size ||
      before.mtimeMs !== source.mtimeMs
    )
      throw new Error('이름 변경 도중 파일이 달라졌습니다.')
    unlinkSync(from)
  } catch (error) {
    // Never remove the new path on failure: another process may have replaced it.
    throw new Error(
      '원래 경로를 제거하지 못해 이름 변경을 중단했습니다. 두 경로의 파일을 확인해 주세요: ' +
        from +
        ' | ' +
        to +
        ' / ' +
        message(error),
    )
  }
}

function assertSidecarsRegistered(video: VideoRow, registered: SubtitleRow[]): void {
  const folder = dirname(video.file_path)
  const stem = basename(video.file_name, extname(video.file_name)).toLowerCase()
  const paths = new Set(
    registered.filter((row) => !row.is_embedded).map((row) => pathKey(row.file_path)),
  )
  for (const name of readdirSync(folder)) {
    if (
      subtitleExtensions.has(extname(name).toLowerCase()) &&
      name.toLowerCase().startsWith(stem + '.') &&
      !paths.has(pathKey(join(folder, name)))
    )
      throw new Error(
        '등록되지 않았거나 연결이 불분명한 자막이 있습니다. 라이브러리를 새로고침하고 자막 연결을 확인해 주세요: ' +
          name,
      )
  }
}

/** Refuse a rename that would leave another registered library pointing at its old location. */
async function otherLibraryPaths(libraryId: string, signal: AbortSignal): Promise<Set<string>> {
  const paths = new Set<string>()
  for (const library of loadConfig().libraries) {
    if (library.id === libraryId) continue
    const existing = getDatabase(library.id)
    let db: Database | undefined
    try {
      db = existing ?? new SqliteDatabase(library.dbPath, { readonly: true, fileMustExist: true })
      let visited = 0
      for (const row of db
        .prepare('SELECT file_path FROM videos UNION SELECT file_path FROM subtitles')
        .all() as { file_path: string }[]) {
        if (visited++ % 64 === 0) await yieldLibraryWork(signal)
        paths.add(pathKey(row.file_path))
        try {
          paths.add(pathKey(realpathSync(row.file_path)))
        } catch {
          /* missing files are still compared by their saved paths */
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new Error(
        '다른 라이브러리의 공유 파일을 확인할 수 없습니다. 해당 라이브러리 연결 상태를 확인해 주세요: ' +
          library.name,
      )
    } finally {
      if (db && !existing) db.close()
    }
  }
  return paths
}

async function libraryPathOwners(
  db: Database,
  signal: AbortSignal,
): Promise<Map<string, Set<string>>> {
  const owners = new Map<string, Set<string>>()
  const rows = db
    .prepare(
      'SELECT id AS video_id, file_path FROM videos UNION SELECT video_id, file_path FROM subtitles',
    )
    .all() as { video_id: string; file_path: string }[]
  let visited = 0
  for (const row of rows) {
    if (visited++ % 64 === 0) await yieldLibraryWork(signal)
    const keys = [pathKey(row.file_path)]
    try {
      keys.push(pathKey(realpathSync(row.file_path)))
    } catch {
      /* compare the registered path for missing files */
    }
    for (const key of keys) {
      const ids = owners.get(key) ?? new Set<string>()
      ids.add(row.video_id)
      owners.set(key, ids)
    }
  }
  return owners
}
function assertNotShared(owners: Map<string, Set<string>>, path: string, videoId: string): void {
  if ([...(owners.get(pathKey(path)) ?? [])].some((id) => id !== videoId))
    throw new Error(
      '같은 라이브러리의 다른 영상에도 연결된 파일입니다. 공유 파일은 변경하지 않습니다.',
    )
}

export async function previewFilenameCleanup(
  libraryId: string,
  input: CleanupRule,
): Promise<RenamePreview> {
  const { prefix } = CleanupRuleZ.parse(input)
  return withMaintenance(libraryId, async (signal) => {
    const db = database(libraryId)
    const shared = await otherLibraryPaths(libraryId, signal)
    const owners = await libraryPathOwners(db, signal)
    const candidates = videos(db).filter((video) =>
      basename(video.file_name, extname(video.file_name)).startsWith(prefix),
    )
    const rows: PlannedRow[] = []
    for (const video of candidates.slice(0, MAX_ROWS)) {
      await yieldLibraryWork(signal)
      const extension = extname(video.file_name)
      const oldStem = basename(video.file_name, extension)
      const newStem = oldStem.slice(prefix.length).trim()
      const nextName = newStem + extension
      const row: PlannedRow = {
        videoId: video.id,
        fileName: video.file_name,
        nextName,
        files: [],
        snapshots: [],
        subtitles: subtitles(db, video.id),
      }
      try {
        if (!newStem || !validName(nextName))
          throw new Error(
            '접두어를 제거한 파일명이 비어 있거나 Windows에서 사용할 수 없는 이름입니다.',
          )
        if (basename(video.file_path) !== video.file_name)
          throw new Error('저장된 파일명과 경로가 다릅니다. 라이브러리를 새로고침해 주세요.')
        assertUnused(libraryId, video)
        assertSidecarsRegistered(video, row.subtitles)
        row.files.push({
          from: video.file_path,
          to: join(dirname(video.file_path), nextName),
          kind: 'video',
        })
        for (const subtitle of row.subtitles) {
          if (subtitle.is_embedded) continue
          const name = basename(subtitle.file_path)
          if (
            pathKey(dirname(subtitle.file_path)) !== pathKey(dirname(video.file_path)) ||
            !name.toLowerCase().startsWith(oldStem.toLowerCase() + '.')
          )
            throw new Error(
              '영상과 이름이 연결되지 않은 외부 자막이 있습니다. 자막 연결을 확인한 뒤 정리해 주세요.',
            )
          const target = join(dirname(subtitle.file_path), newStem + name.slice(oldStem.length))
          row.files.push({ from: subtitle.file_path, to: target, kind: 'subtitle' })
        }
        for (const file of row.files) {
          const before = snapshot(file.from)
          const canonicalTarget = join(realpathSync(dirname(file.to)), basename(file.to))
          assertNotShared(owners, file.from, video.id)
          assertNotShared(owners, before.canonical, video.id)
          assertNotShared(owners, file.to, video.id)
          assertNotShared(owners, canonicalTarget, video.id)
          if (
            shared.has(pathKey(file.from)) ||
            shared.has(pathKey(before.canonical)) ||
            shared.has(pathKey(file.to)) ||
            shared.has(pathKey(canonicalTarget))
          )
            throw new Error('다른 라이브러리에도 등록된 파일입니다. 공유 경로는 변경하지 않습니다.')
          if (!validName(basename(file.to)))
            throw new Error('변경할 자막 파일명이 올바르지 않습니다.')
          assertTargetAbsent(file.to)
          row.snapshots.push(before)
        }
        if (
          db
            .prepare('SELECT 1 FROM videos WHERE file_path = ? COLLATE NOCASE AND id <> ?')
            .get(row.files[0].to, video.id)
        )
          throw new Error('변경할 경로가 이미 라이브러리에 등록되어 있습니다.')
      } catch (error) {
        row.error = message(error)
      }
      rows.push(row)
    }
    const destinations = new Map<string, PlannedRow>()
    for (const row of rows) {
      for (const file of row.files) {
        const previous = destinations.get(pathKey(file.to))
        if (previous && previous !== row)
          previous.error = row.error =
            '여러 항목의 변경 후 파일명이 같습니다. 한 항목씩 다른 규칙으로 정리해 주세요.'
        destinations.set(pathKey(file.to), row)
      }
    }
    const expires = Date.now() + 10 * 60_000
    const preview: RenamePreview = {
      id: randomUUID(),
      libraryId,
      expiresAt: new Date(expires).toISOString(),
      rows: rows.map(({ snapshots: _snapshots, subtitles: _subtitles, ...row }) => row),
      truncated: candidates.length > MAX_ROWS,
    }
    for (const [id, plan] of previews) if (plan.expires <= Date.now()) previews.delete(id)
    while (previews.size >= 8) previews.delete(previews.keys().next().value!)
    previews.set(preview.id, { preview, rows, expires })
    return preview
  })
}

function renameOne(
  db: Database,
  libraryId: string,
  row: PlannedRow,
  shared: Set<string>,
  owners: Map<string, Set<string>>,
): void {
  const video = db
    .prepare('SELECT id, file_path, file_name FROM videos WHERE id = ? AND removal_mode IS NULL')
    .get(row.videoId) as VideoRow | undefined
  if (!video || video.file_path !== row.files[0]?.from || video.file_name !== row.fileName)
    throw new Error('미리보기 이후 영상 정보가 변경되었습니다. 다시 미리보기해 주세요.')
  assertUnused(libraryId, video)
  if (JSON.stringify(subtitles(db, video.id)) !== JSON.stringify(row.subtitles))
    throw new Error('미리보기 이후 자막 연결이 변경되었습니다. 다시 미리보기해 주세요.')
  assertSidecarsRegistered(video, row.subtitles)
  for (const [index, file] of row.files.entries()) {
    const now = snapshot(file.from)
    const canonicalTarget = join(realpathSync(dirname(file.to)), basename(file.to))
    assertNotShared(owners, file.from, video.id)
    assertNotShared(owners, now.canonical, video.id)
    assertNotShared(owners, file.to, video.id)
    assertNotShared(owners, canonicalTarget, video.id)
    if (!sameFile(now, row.snapshots[index]))
      throw new Error('미리보기 이후 파일이 변경되었습니다. 다시 미리보기해 주세요.')
    if (
      shared.has(pathKey(file.from)) ||
      shared.has(pathKey(now.canonical)) ||
      shared.has(pathKey(file.to)) ||
      shared.has(pathKey(canonicalTarget))
    )
      throw new Error('다른 라이브러리에서도 사용 중인 파일입니다.')
    assertTargetAbsent(file.to)
  }
  const moved: PlannedRow['files'] = []
  try {
    db.transaction(() => {
      if (
        !db
          .prepare(
            'SELECT 1 FROM videos WHERE id = ? AND file_path = ? AND file_name = ? AND removal_mode IS NULL',
          )
          .get(video.id, video.file_path, video.file_name) ||
        JSON.stringify(subtitles(db, video.id)) !== JSON.stringify(row.subtitles)
      )
        throw new Error(
          '미리보기 이후 영상 또는 자막 정보가 변경되었습니다. 다시 미리보기해 주세요.',
        )
      for (const file of row.files) {
        // All path checks and moves for one video are synchronous: cancellation cannot split the group.
        assertTargetAbsent(file.to)
        moveWithoutOverwrite(file.from, file.to)
        moved.push(file)
      }
      db.prepare('UPDATE videos SET file_path = ?, file_name = ? WHERE id = ?').run(
        row.files[0].to,
        row.nextName,
        row.videoId,
      )
      db.prepare('UPDATE subtitles SET file_path = ? WHERE video_id = ? AND is_embedded = 1').run(
        row.files[0].to,
        row.videoId,
      )
      for (const file of row.files.filter((entry) => entry.kind === 'subtitle'))
        db.prepare(
          'UPDATE subtitles SET file_path = ? WHERE video_id = ? AND file_path = ? AND is_embedded = 0',
        ).run(file.to, row.videoId, file.from)
    }).immediate()
  } catch (error) {
    const recovery: string[] = []
    for (const file of [...moved].reverse()) {
      try {
        assertTargetAbsent(file.from)
        moveWithoutOverwrite(file.to, file.from)
      } catch {
        recovery.push(file.to)
      }
    }
    if (recovery.length)
      throw new Error(
        '변경을 저장하지 못했고 일부 이름을 되돌리지 못했습니다. 파일은 보존되어 있습니다. 복구할 현재 경로: ' +
          recovery.join(' | ') +
          ' / ' +
          message(error),
      )
    throw error
  }
}

export async function applyFilenameCleanup(
  libraryId: string,
  previewId: string,
  videoIds: string[],
): Promise<RenameResult> {
  return withMaintenance(libraryId, async (signal) => {
    const db = database(libraryId, true)
    const plan = previews.get(previewId)
    if (!plan || plan.preview.libraryId !== libraryId || plan.expires <= Date.now())
      throw new Error(
        '미리보기가 만료되었거나 다른 라이브러리의 요청입니다. 다시 미리보기해 주세요.',
      )
    if (!videoIds.length || new Set(videoIds).size !== videoIds.length)
      throw new Error('변경할 영상을 선택해 주세요.')
    const rows = videoIds.map((id) => plan.rows.find((row) => row.videoId === id))
    if (rows.some((row) => !row || row.error))
      throw new Error('미리보기에서 변경 가능한 항목만 선택해 주세요.')
    const shared = await otherLibraryPaths(libraryId, signal)
    const owners = await libraryPathOwners(db, signal)
    previews.delete(previewId)
    const result: RenameResult = { items: [], cancelled: false }
    for (const row of rows as PlannedRow[]) {
      await new Promise<void>((done) => setImmediate(done))
      if (signal.aborted) {
        result.cancelled = true
        result.items.push({
          videoId: row.videoId,
          fileName: row.fileName,
          status: 'cancelled',
          message: '변경하지 않았습니다.',
        })
        continue
      }
      try {
        renameOne(db, libraryId, row, shared, owners)
        result.items.push({
          videoId: row.videoId,
          fileName: row.fileName,
          status: 'renamed',
          message: '파일명과 라이브러리 경로를 변경했습니다.',
        })
      } catch (error) {
        result.items.push({
          videoId: row.videoId,
          fileName: row.fileName,
          status: 'failed',
          message: message(error),
        })
      }
    }
    return result
  })
}

function sameStat(before: Snapshot, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
  )
}
async function fullFileHash(
  filePath: string,
  before: Snapshot,
  signal: AbortSignal,
): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    if (!sameStat(before, await handle.stat()))
      throw new Error('검사 시작 전에 파일이 변경되었습니다.')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (offset < before.size) {
      throwIfWorkCancelled(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (!sameStat(before, await handle.stat()) || !sameFile(before, snapshot(filePath)))
      throw new Error('검사 도중 파일이 변경되어 후보에서 제외했습니다.')
    throwIfWorkCancelled(signal)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export async function findExactDuplicates(libraryId: string): Promise<DuplicateResult> {
  return withMaintenance(libraryId, async (signal) => {
    const db = database(libraryId)
    const result: DuplicateResult = { groups: [], checkedFiles: 0, skipped: [], cancelled: false }
    const bySize = new Map<number, { video: VideoRow; source: Snapshot }[]>()
    const hashes = new Map<string, DuplicateResult['groups'][number]>()
    try {
      for (const video of videos(db)) {
        await yieldLibraryWork(signal)
        try {
          assertUnused(libraryId, video)
          const source = snapshot(video.file_path)
          const group = bySize.get(source.size) ?? []
          group.push({ video, source })
          bySize.set(source.size, group)
        } catch (error) {
          result.skipped.push({
            videoId: video.id,
            fileName: video.file_name,
            reason: message(error),
          })
        }
      }
      for (const group of bySize.values()) {
        if (group.length < 2) continue
        for (const { video, source } of group) {
          throwIfWorkCancelled(signal)
          try {
            assertUnused(libraryId, video)
            const sha256 = await fullFileHash(video.file_path, source, signal)
            assertUnused(libraryId, video)
            result.checkedFiles++
            const key = source.size + ':' + sha256
            const matches = hashes.get(key) ?? { sha256, sizeBytes: source.size, files: [] }
            matches.files.push({
              videoId: video.id,
              fileName: video.file_name,
              filePath: video.file_path,
              sizeBytes: source.size,
            })
            hashes.set(key, matches)
          } catch (error) {
            if (isAbortError(error)) throw error
            result.skipped.push({
              videoId: video.id,
              fileName: video.file_name,
              reason: message(error),
            })
          }
        }
      }
    } catch (error) {
      if (!isAbortError(error)) throw error
      result.cancelled = true
    }
    result.groups = [...hashes.values()].filter((group) => group.files.length > 1)
    return result
  })
}
