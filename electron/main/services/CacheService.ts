import fs from 'node:fs'
import path from 'node:path'
import type { CacheCleanupResult, CacheInfo } from '@shared/types'
import { loadConfig } from '../infra/config'
import { createLogger } from '../infra/logger'
import { getUserDataPath } from '../infra/paths'

const log = createLogger('CacheService')
const DEFAULT_LIMIT_GB = 10
type CacheFile = { filePath: string; group: string; size: number; lastUsed: number }
type CacheRoot = { directory: string; realDirectory: string }
type Pin = {
  token: symbol
  groups: Set<string>
  pendingPrefix?: string
  previous?: Pin
  abandoned?: boolean
}
const pins = new Map<string, Pin>()
let cleanupQueue: Promise<unknown> = Promise.resolve()

function pathKey(filePath: string): string {
  const absolute = path.resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isWithin(directory: string, filePath: string): boolean {
  const relative = path.relative(directory, filePath)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  )
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

// Only this directory is a cache. Never use library paths or a caller-supplied root.
function getRoot(): CacheRoot | undefined {
  const directory = path.resolve(getUserDataPath('playback-proxies'))
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('재생 캐시 경로가 일반 폴더가 아닙니다.')
    const realDirectory = fs.realpathSync(directory)
    const realUserData = fs.realpathSync(getUserDataPath())
    if (!isWithin(realUserData, realDirectory))
      throw new Error('재생 캐시 경로가 사용자 데이터 폴더 밖에 있습니다.')
    return { directory, realDirectory }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Check every existing ancestor: a junction inside the cache must not escape it. */
function safeFile(root: CacheRoot, filePath: string, allowMissing: boolean): fs.Stats | undefined {
  if (!isWithin(root.directory, filePath))
    throw new Error('재생 캐시 밖의 파일에는 접근할 수 없습니다.')
  // Detect a cache-root replacement while an asynchronous scan was in progress.
  const currentRoot = getRoot()
  if (!currentRoot || pathKey(currentRoot.realDirectory) !== pathKey(root.realDirectory)) {
    throw new Error('재생 캐시 경로가 작업 중 변경되었습니다.')
  }
  const parts = path.relative(root.directory, filePath).split(path.sep)
  let current = root.directory
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (allowMissing && isMissing(error)) return undefined
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('재생 캐시의 심볼릭 링크에는 접근할 수 없습니다.')
    if (!isWithin(root.realDirectory, fs.realpathSync(current))) {
      throw new Error('재생 캐시 파일의 실제 경로가 캐시 폴더 밖에 있습니다.')
    }
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error('재생 캐시의 상위 경로가 폴더가 아닙니다.')
    if (index === parts.length - 1) return stat
  }
  return undefined
}

function groupKey(filePath: string): string {
  // A proxy, its source fingerprint, and interrupted conversion form one item.
  return pathKey(filePath.replace(/(?:\.source\.json|\.tmp)+$/i, ''))
}

function pinKey(libraryId: string, videoId: string): string {
  return JSON.stringify([libraryId, videoId])
}

function validatePinPath(libraryId: string, filePath: string): string {
  const root = getRoot()
  if (!root) throw new Error('재생 캐시 폴더가 없습니다.')
  const absolute = path.resolve(filePath)
  if (pathKey(path.dirname(absolute)) !== pathKey(path.join(root.directory, libraryId))) {
    throw new Error('라이브러리의 재생 캐시 경로가 아닙니다.')
  }
  const stat = safeFile(root, absolute, true)
  if (stat && !stat.isFile()) throw new Error('재생 캐시 파일이 일반 파일이 아닙니다.')
  return groupKey(absolute)
}

function protectedGroup(group: string): boolean {
  for (const pin of pins.values()) {
    if (pin.groups.has(group) || (pin.pendingPrefix && group.startsWith(pin.pendingPrefix)))
      return true
  }
  return false
}

export type PlaybackCacheLease = ((filePath: string) => boolean) & {
  release(): boolean
  rollback(): boolean
}

/** Reserve before awaiting conversion so closing the player also cancels a future pin. */
export function beginPlaybackCacheLease(libraryId: string, videoId: string): PlaybackCacheLease {
  const key = pinKey(libraryId, videoId)
  const oldPin = pins.get(key)
  const pin: Pin = {
    token: Symbol(key),
    groups: new Set(oldPin?.groups),
    previous: oldPin,
    // Bridge promise resolution: a pending player request already owns this
    // video's proxies before the converter releases its generation pin.
    pendingPrefix:
      pathKey(path.join(getUserDataPath('playback-proxies'), libraryId, videoId)) + '.',
  }
  pins.set(key, pin)
  const lease = ((filePath: string): boolean => {
    if (pin.abandoned || pins.get(key)?.token !== pin.token) return false
    pin.groups.add(validatePinPath(libraryId, filePath))
    pin.pendingPrefix = undefined
    // A completed request owns the inherited groups. Keep history only while
    // a replacement can still fail, rather than retaining every past request.
    pin.previous = undefined
    return true
  }) as PlaybackCacheLease
  lease.release = (): boolean => {
    pin.abandoned = true
    if (pins.get(key)?.token !== pin.token) return false
    return pins.delete(key)
  }
  lease.rollback = (): boolean => {
    pin.abandoned = true
    // An ended player or a newer request must never be overwritten by failure
    // from an older request. Mark it abandoned even when it is no longer current.
    if (pins.get(key)?.token !== pin.token) return false
    let previous = pin.previous
    while (previous?.abandoned) previous = previous.previous
    if (previous) pins.set(key, previous)
    else pins.delete(key)
    return true
  }
  return lease
}

export function protectPlaybackCache(libraryId: string, videoId: string, filePath: string): void {
  const group = validatePinPath(libraryId, filePath)
  const key = pinKey(libraryId, videoId)
  let pin = pins.get(key)
  if (!pin) {
    pin = { token: Symbol(key), groups: new Set() }
    pins.set(key, pin)
  }
  pin.groups.add(group)
}

export function releasePlaybackCache(libraryId: string, videoId: string): boolean {
  return pins.delete(pinKey(libraryId, videoId))
}

async function scanCache(): Promise<{ root?: CacheRoot; files: CacheFile[] }> {
  const root = getRoot()
  const files: CacheFile[] = []
  if (!root) return { files }
  const directories = [root.directory]
  let checked = 0
  while (directories.length) {
    const directory = directories.pop()!
    if (directory !== root.directory) {
      try {
        if (!safeFile(root, directory, false)?.isDirectory()) continue
      } catch (error) {
        log.warn({ directory, err: error }, 'Skipped unsafe cache directory')
        continue
      }
    }
    let handle: fs.Dir
    try {
      handle = await fs.promises.opendir(directory)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for await (const entry of handle) {
      const filePath = path.join(directory, entry.name)
      // Do not follow links, including Windows junctions, even if they point inside.
      if (entry.isSymbolicLink()) continue
      try {
        const stat = safeFile(root, filePath, false)
        if (stat?.isDirectory()) directories.push(filePath)
        else if (stat?.isFile()) {
          files.push({
            filePath,
            group: groupKey(filePath),
            size: stat.size,
            lastUsed: stat.mtimeMs,
          })
        }
      } catch (error) {
        if (!isMissing(error)) log.warn({ filePath, err: error }, 'Skipped unsafe cache entry')
      }
      if (++checked % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return { root, files }
}

function cacheLimit(): number {
  return (loadConfig().cacheLimitGb ?? DEFAULT_LIMIT_GB) * 1024 ** 3
}

function describeCache(files: CacheFile[], limitBytes: number): CacheInfo {
  return {
    usedBytes: files.reduce((sum, file) => sum + file.size, 0),
    limitBytes,
    fileCount: files.length,
    protectedBytes: files.reduce(
      (sum, file) => sum + (protectedGroup(file.group) ? file.size : 0),
      0,
    ),
  }
}

export async function getCacheInfo(): Promise<CacheInfo> {
  return describeCache((await scanCache()).files, cacheLimit())
}

function serializeCleanup<T>(operation: () => Promise<T>): Promise<T> {
  const next = cleanupQueue.then(operation, operation)
  cleanupQueue = next.catch(() => undefined)
  return next
}

async function cleanup(
  mode: 'all' | 'trim' | 'video',
  libraryId?: string,
  videoId?: string,
): Promise<CacheCleanupResult> {
  const limitBytes = cacheLimit()
  const { root, files } = await scanCache()
  let usedBytes = files.reduce((sum, file) => sum + file.size, 0)
  let removedBytes = 0
  let removedFiles = 0
  if (root) {
    const groups = new Map<string, { files: CacheFile[]; lastUsed: number }>()
    for (const file of files) {
      if (
        mode === 'video' &&
        (pathKey(path.dirname(file.filePath)) !== pathKey(path.join(root.directory, libraryId!)) ||
          !path.basename(file.filePath).startsWith(videoId! + '.'))
      )
        continue
      const group = groups.get(file.group) ?? { files: [], lastUsed: 0 }
      group.files.push(file)
      group.lastUsed = Math.max(group.lastUsed, file.lastUsed)
      groups.set(file.group, group)
    }
    for (const [groupKey, group] of [...groups].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (mode === 'trim' && usedBytes <= limitBytes) break
      if (protectedGroup(groupKey)) continue
      // One small, synchronous group deletion prevents a new pin from racing an
      // awaited unlink. Recheck each physical path immediately before unlinking.
      for (const file of group.files) {
        try {
          const stat = safeFile(root, file.filePath, false)
          if (!stat?.isFile() || protectedGroup(groupKey)) continue
          fs.unlinkSync(file.filePath)
          removedFiles++
          removedBytes += stat.size
          usedBytes -= stat.size
        } catch (error) {
          if (!isMissing(error))
            log.warn(
              { filePath: file.filePath, err: error },
              'Could not remove playback cache file',
            )
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return { removedBytes, removedFiles, info: await getCacheInfo() }
}

export function cleanPlaybackCache(): Promise<CacheCleanupResult> {
  return serializeCleanup(() => cleanup('all'))
}

export function trimPlaybackCache(): Promise<CacheCleanupResult> {
  return serializeCleanup(() => cleanup('trim'))
}

export async function purgeVideoPlaybackCache(libraryId: string, videoId: string): Promise<void> {
  if (
    ![libraryId, videoId].every(
      (value) => value && value !== '.' && value !== '..' && !/[\\/]/.test(value),
    )
  ) {
    throw new Error('캐시를 정리할 라이브러리 또는 영상 ID가 올바르지 않습니다.')
  }
  await serializeCleanup(() => cleanup('video', libraryId, videoId))
}
