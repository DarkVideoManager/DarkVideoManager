import { randomUUID } from 'crypto'
import { basename, extname, resolve, relative, isAbsolute } from 'path'
import { stat, lstat } from 'node:fs/promises'
import type { Database } from 'better-sqlite3'
import { BrowserWindow } from 'electron'
import { Library, ImportProgress, ImportResult, ProbeData } from '@shared/types'
import { loadConfig, saveConfig, updateConfig } from '../infra/config'
import { getLibDbPath, getThumbnailsDir } from '../infra/paths'
import { openDatabase, closeDatabase, getDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { finishPlaybackSessions } from './PlaybackService'
import { FsScanner } from './FsScanner'
import {
  matchSidecarSubtitle,
  subtitleExtensions,
  subtitleVideoKey,
  syncSidecarSubtitleSnapshot,
  type SidecarSubtitle,
} from './SubtitleService'
import {
  withLibraryWork,
  isLibraryBusy,
  throwIfWorkCancelled,
  yieldLibraryWork,
} from './LibraryWorkService'
import { probeVideo } from '../ffmpeg/ffprobe'
import { generateThumbnails } from '../ffmpeg/thumbnail'
import { thumbnailQueue, isAbortError } from '../ffmpeg/queue'
import { IPC } from '@shared/ipc'
import { createLogger } from '../infra/logger'

const log = createLogger('LibraryService')

export function listLibraries(): Library[] {
  return loadConfig().libraries
}

export function openLibrary(libraryId: string): Library {
  const config = loadConfig()
  const lib = config.libraries.find((l) => l.id === libraryId)
  if (!lib) throw new Error(`라이브러리를 찾을 수 없습니다: ${libraryId}`)

  const db = openDatabase(libraryId, lib.dbPath)
  runMigrations(db, lib.dbPath)

  updateConfig((c) => ({
    ...c,
    libraries: c.libraries.map((l) =>
      l.id === libraryId ? { ...l, lastOpenedAt: new Date().toISOString() } : l,
    ),
    lastActiveLibraryId: libraryId,
  }))

  return lib
}

export function createLibrary(name: string, folderPath: string): Library {
  // Establish a recoverable registry before creating the first database.
  saveConfig(loadConfig())
  const id = randomUUID()
  const dbPath = getLibDbPath(id)

  const lib: Library = {
    id,
    name,
    dbPath,
    folderPath,
    folderPaths: [folderPath],
    createdAt: new Date().toISOString(),
  }

  try {
    const db = openDatabase(id, dbPath)
    runMigrations(db, dbPath)
    updateConfig((c) => ({
      ...c,
      libraries: [...c.libraries, lib],
      lastActiveLibraryId: id,
    }))
  } catch (error) {
    closeDatabase(id)
    throw error
  }

  log.info({ id, name, folderPath }, '라이브러리 생성')
  return lib
}

export function closeLibrary(libraryId: string): void {
  assertLibraryIdle(libraryId)
  finishPlaybackSessions(libraryId)
  closeDatabase(libraryId)
}

export function deleteLibrary(libraryId: string): void {
  assertLibraryIdle(libraryId)
  finishPlaybackSessions(libraryId)
  closeDatabase(libraryId)
  updateConfig((c) => ({
    ...c,
    libraries: c.libraries.filter((l) => l.id !== libraryId),
    lastActiveLibraryId: c.lastActiveLibraryId === libraryId ? undefined : c.lastActiveLibraryId,
  }))
}

function assertLibraryIdle(libraryId: string): void {
  if (isLibraryBusy(libraryId))
    throw new Error('라이브러리 작업이 진행 중입니다. 작업을 취소하고 완료될 때까지 기다려 주세요.')
}

type Sidecars = Map<string, SidecarSubtitle[]>
type ProgressEmitter = (progress: Omit<ImportProgress, 'libraryId'>) => void

function pathKey(filePath: string): string {
  const normalized = resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
function insideFolder(filePath: string, folderPath: string): boolean {
  const child = relative(resolve(folderPath), resolve(filePath))
  return (
    child !== '..' && !child.startsWith('..\\') && !child.startsWith('../') && !isAbsolute(child)
  )
}
function uniqueRoots(roots: string[]): string[] {
  const unique = [...new Map(roots.map((root) => [pathKey(root), resolve(root)])).values()]
  return unique.filter(
    (root, index) =>
      !unique.some((other, otherIndex) => otherIndex !== index && insideFolder(root, other)),
  )
}
function createEmitter(libraryId: string, win: BrowserWindow): ProgressEmitter {
  let lastSentAt = 0
  let lastPhase: ImportProgress['phase'] | undefined
  return (progress) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const now = Date.now()
    if (
      progress.phase === lastPhase &&
      progress.current !== progress.total &&
      now - lastSentAt < 100
    )
      return
    lastPhase = progress.phase
    lastSentAt = now
    win.webContents.send(IPC.EVENTS.IMPORT_PROGRESS, {
      ...progress,
      errors: [...progress.errors],
      libraryId,
    })
  }
}
function createYieldBudget(signal: AbortSignal): () => Promise<void> | undefined {
  let count = 0,
    lastYield = Date.now()
  return () => {
    throwIfWorkCancelled(signal)
    if (++count < 64 && Date.now() - lastYield < 8) return undefined
    count = 0
    lastYield = Date.now()
    return yieldLibraryWork(signal)
  }
}

async function scanFolders(
  roots: string[],
  signal: AbortSignal,
  emit: ProgressEmitter,
): Promise<{ files: string[]; sidecars: Sidecars }> {
  const scanner = new FsScanner()
  const files = new Map<string, string>()
  const sidecars: Sidecars = new Map()
  const subtitleFiles = new Map<string, string>()
  let previousFiles = 0
  for (const root of roots) {
    let rootFileCount = 0
    const scanned = await scanner.scan(root, {
      signal,
      onFile: (filePath) => {
        const extension = extname(filePath).toLowerCase()
        if (!subtitleExtensions.has(extension)) return
        subtitleFiles.set(pathKey(filePath), filePath)
      },
      onProgress: (progress) => {
        rootFileCount = progress.files
        emit({
          phase: 'scanning',
          total: 0,
          current: previousFiles + progress.files,
          currentFile: progress.currentPath,
          errors: [],
        })
      },
    })
    for (const file of scanned) files.set(pathKey(file), file)
    previousFiles += rootFileCount
  }
  throwIfWorkCancelled(signal)
  // Match after scanning so exact video stems always win, regardless of traversal order.
  const videoKeys = new Set([...files.values()].map(subtitleVideoKey))
  for (const filePath of subtitleFiles.values()) {
    const match = matchSidecarSubtitle(filePath, videoKeys)
    if (!match) continue
    const related = sidecars.get(match.videoKey) ?? []
    related.push(match.subtitle)
    sidecars.set(match.videoKey, related)
  }
  return { files: [...files.values()], sidecars }
}

async function importScannedFiles(
  db: Database,
  files: string[],
  sidecars: Sidecars,
  signal: AbortSignal,
  result: ImportResult,
  emit: ProgressEmitter,
): Promise<void> {
  const repository = new VideoRepository(db)
  const cooperate = createYieldBudget(signal)
  for (const [index, filePath] of files.entries()) {
    await cooperate()
    emit({
      phase: 'probing',
      total: files.length,
      current: index + 1,
      currentFile: basename(filePath),
      errors: result.errors,
    })
    try {
      throwIfWorkCancelled(signal)
      const existing = repository.findByPath(filePath)
      if (existing) {
        // A refresh must not restore a deliberately removed video or mutate its subtitles.
        if (!existing.removalMode)
          db.transaction(() =>
            syncSidecarSubtitleSnapshot(
              db,
              existing.id,
              sidecars.get(subtitleVideoKey(filePath)) ?? [],
            ),
          )()
        result.skipped++
        continue
      }
      const info = await stat(filePath)
      throwIfWorkCancelled(signal)
      let probeData: ProbeData = {}
      try {
        probeData = await probeVideo(filePath, signal)
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error
        log.warn({ filePath, err: error }, 'ffprobe 실패, 메타 없이 저장')
      }
      throwIfWorkCancelled(signal)
      const videoId = randomUUID()
      db.transaction(() => {
        repository.insert({
          id: videoId,
          filePath,
          fileName: basename(filePath),
          sizeBytes: info.size,
          rating: 0,
          memo: '',
          resumePosSec: 0,
          ...probeData,
        })
        syncSidecarSubtitleSnapshot(db, videoId, sidecars.get(subtitleVideoKey(filePath)) ?? [])
      })()
      result.added++
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error
      result.errors.push(basename(filePath) + ': ' + (error as Error).message)
      log.warn({ filePath, err: error }, '가져오기 오류')
    }
  }
}

async function generateLibraryThumbnails(
  libraryId: string,
  files: string[],
  db: Database,
  win: BrowserWindow,
  signal: AbortSignal,
  result: ImportResult,
  emit: ProgressEmitter,
): Promise<void> {
  const repository = new VideoRepository(db)
  const thumbnails = new ThumbnailRepository(db)
  const directory = getThumbnailsDir(libraryId)
  let next = 0,
    completed = 0
  emit({ phase: 'thumbnails', total: files.length, current: 0, errors: result.errors })
  const worker = async () => {
    const cooperate = createYieldBudget(signal)
    while (next < files.length) {
      await cooperate()
      if (next >= files.length) return
      const filePath = files[next++]
      try {
        await thumbnailQueue.add(async () => {
          throwIfWorkCancelled(signal)
          const video = repository.findByPath(filePath)
          if (!video || video.removalMode || thumbnails.findByVideoId(video.id).length) return
          const captures = await generateThumbnails(
            filePath,
            directory,
            video.id,
            video.durationSec,
            signal,
          )
          throwIfWorkCancelled(signal)
          if (repository.findById(video.id)?.removalMode) return
          db.transaction(() => {
            for (const [index, capture] of captures.entries())
              thumbnails.insert({
                id: randomUUID(),
                videoId: video.id,
                filePath: capture.filePath,
                timeSec: capture.timeSec,
                isPrimary: index === Math.floor(captures.length / 2),
              })
          })()
          if (!win.isDestroyed() && !win.webContents.isDestroyed())
            win.webContents.send(IPC.EVENTS.THUMBNAIL_READY, { videoId: video.id })
        }, signal)
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error
        result.errors.push(basename(filePath) + ': ' + (error as Error).message)
        log.warn({ filePath, err: error }, '썸네일 생성 실패')
      }
      completed++
      emit({
        phase: 'thumbnails',
        total: files.length,
        current: completed,
        currentFile: basename(filePath),
        errors: result.errors,
      })
    }
  }
  // Only two tasks per library are queued at once. Wait for both workers to settle
  // so no thumbnail process can mutate the library after cancellation completes.
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(2, files.length) }, worker),
  )
  throwIfWorkCancelled(signal)
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
}

async function markMissingVideos(
  db: Database,
  roots: string[],
  scannedFiles: string[],
  signal: AbortSignal,
  result: ImportResult,
): Promise<void> {
  if (result.errors.length) return
  const scanned = new Set(scannedFiles.map(pathKey))
  const videos = db
    .prepare('SELECT id, file_path FROM videos WHERE removal_mode IS NULL')
    .all() as Array<{ id: string; file_path: string }>
  const missing: string[] = []
  const cooperate = createYieldBudget(signal)
  for (const video of videos) {
    await cooperate()
    if (
      scanned.has(pathKey(video.file_path)) ||
      !roots.some((root) => insideFolder(video.file_path, root))
    )
      continue
    try {
      await lstat(video.file_path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(video.id)
      else result.errors.push((error as Error).message)
    }
  }
  // Recheck the roots immediately before committing absence information. A disk
  // disconnected during a long thumbnail job must not hide all of its entries.
  for (const root of roots) {
    await stat(root)
    throwIfWorkCancelled(signal)
  }
  if (result.errors.length) return
  throwIfWorkCancelled(signal)
  const repository = new VideoRepository(db)
  db.transaction(() => {
    for (const id of missing) repository.delete(id)
    result.removed = missing.length
  })()
}

async function runFolderWork(
  libraryId: string,
  requestedFolder: string | undefined,
  win: BrowserWindow,
  signal: AbortSignal,
): Promise<ImportResult> {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  const library = loadConfig().libraries.find((entry) => entry.id === libraryId)
  if (!library) throw new Error('라이브러리를 찾을 수 없습니다')
  const roots = uniqueRoots(
    requestedFolder ? [requestedFolder] : [library.folderPath, ...(library.folderPaths ?? [])],
  )
  const emit = createEmitter(libraryId, win)
  const result: ImportResult = { added: 0, skipped: 0, removed: 0, errors: [] }
  let files: string[] = []
  emit({ phase: 'scanning', total: 0, current: 0, errors: [] })
  try {
    const snapshot = await scanFolders(roots, signal, emit)
    files = snapshot.files
    throwIfWorkCancelled(signal)
    if (requestedFolder)
      updateConfig((config) => ({
        ...config,
        libraries: config.libraries.map((entry) =>
          entry.id === libraryId
            ? {
                ...entry,
                folderPaths: uniqueRoots([
                  entry.folderPath,
                  ...(entry.folderPaths ?? []),
                  requestedFolder,
                ]),
              }
            : entry,
        ),
      }))
    await importScannedFiles(db, files, snapshot.sidecars, signal, result, emit)
    await generateLibraryThumbnails(libraryId, files, db, win, signal, result, emit)
    throwIfWorkCancelled(signal)
    if (!requestedFolder) await markMissingVideos(db, roots, files, signal, result)
    emit({ phase: 'done', total: files.length, current: files.length, errors: result.errors })
    return result
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      result.cancelled = true
      emit({
        phase: 'cancelled',
        total: files.length,
        current: result.added + result.skipped,
        errors: result.errors,
      })
      return result
    }
    if (requestedFolder) throw error
    result.errors.push('폴더에 접근할 수 없어 새로고침을 중단했습니다: ' + (error as Error).message)
    emit({
      phase: 'done',
      total: files.length,
      current: result.added + result.skipped,
      errors: result.errors,
    })
    return result
  }
}

export function importFolder(
  libraryId: string,
  folderPath: string,
  win: BrowserWindow,
): Promise<ImportResult> {
  return withLibraryWork(libraryId, (signal) => runFolderWork(libraryId, folderPath, win, signal))
}
export function refreshLibrary(libraryId: string, win: BrowserWindow): Promise<ImportResult> {
  return withLibraryWork(libraryId, (signal) => runFolderWork(libraryId, undefined, win, signal))
}
