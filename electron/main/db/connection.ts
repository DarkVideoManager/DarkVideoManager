import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { execFileSync } from 'node:child_process'
import type { Database } from 'better-sqlite3'
import { createLogger } from '../infra/logger'

interface BetterSqlite3Options {
  readonly?: boolean
  fileMustExist?: boolean
}

interface BetterSqlite3Constructor {
  new (filename?: string, options?: BetterSqlite3Options): Database
}

const log = createLogger('db:connection')

export type { Database }

let BetterSqlite3: BetterSqlite3Constructor | null = null

try {
  // Load lazily so an unavailable native module produces a useful startup error.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3') as BetterSqlite3Constructor
  log.info('better-sqlite3 로드 성공')
} catch (error) {
  log.error({ err: error }, 'better-sqlite3 사용 불가 — DB 기능 비활성화됨')
}

interface LockHandle {
  fd: number
  path: string
}

interface PoolEntry {
  db: Database
  lock: LockHandle | null
  readOnly: boolean
}

const pool = new Map<string, PoolEntry>()
const readOnlyDatabases = new WeakSet<Database>()

function isLockOwnerAlive(lock: { pid?: unknown; acquiredAt?: unknown }): boolean {
  const pid = lock.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
  } catch (error) {
    // Access denied does not prove that another writer has exited.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  if (process.platform !== 'win32') return true

  const acquiredAt = typeof lock.acquiredAt === 'string' ? Date.parse(lock.acquiredAt) : NaN
  if (!Number.isFinite(acquiredAt)) return true
  try {
    // Windows reuses PIDs. A newer process with the same PID cannot own an old lock.
    // Query only on contention; failure to inspect a process must preserve its lock.
    const startedAt = Date.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      ).trim(),
    )
    return !Number.isFinite(startedAt) || startedAt <= acquiredAt
  } catch {
    return true
  }
}

function acquireLock(dbPath: string): LockHandle | null {
  if (dbPath === ':memory:') return null

  const lockPath = `${dbPath}.lock`
  mkdirSync(dirname(dbPath), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }))
      return { fd, path: lockPath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      try {
        const contents = readFileSync(lockPath, 'utf8')
        const lock = JSON.parse(contents) as { pid?: unknown; acquiredAt?: unknown }
        if (!isLockOwnerAlive(lock)) {
          // The process query can take time; never delete a replacement writer's lock.
          if (readFileSync(lockPath, 'utf8') !== contents) return null
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // A concurrently replaced or incomplete lock is treated as active.
      }
      return null
    }
  }

  return null
}

function releaseLock(lock: LockHandle | null): void {
  if (!lock) return
  closeSync(lock.fd)
  try {
    unlinkSync(lock.path)
  } catch {
    // Another process may have already removed a stale lock.
  }
}

function configureDatabase(db: Database, readOnly: boolean): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  if (readOnly) {
    db.pragma('query_only = ON')
    return
  }

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
  db.pragma('temp_store = MEMORY')
}

export function openDatabase(
  libraryId: string,
  dbPath: string,
  options: { fileMustExist?: boolean } = {},
): Database {
  const existing = pool.get(libraryId)
  if (existing) return existing.db
  if (!BetterSqlite3) {
    throw new Error('better-sqlite3가 설치되지 않았습니다. npm run rebuild를 실행하세요.')
  }

  const lock = acquireLock(dbPath)
  const readOnly = lock === null && dbPath !== ':memory:'
  if (readOnly && !existsSync(dbPath)) {
    throw new Error(`잠긴 라이브러리 파일을 찾을 수 없습니다: ${dbPath}`)
  }

  let db: Database
  try {
    db = readOnly
      ? new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
      : new BetterSqlite3(dbPath, { fileMustExist: options.fileMustExist ?? false })
    configureDatabase(db, readOnly)
  } catch (error) {
    releaseLock(lock)
    throw error
  }

  pool.set(libraryId, { db, lock, readOnly })
  if (readOnly) readOnlyDatabases.add(db)
  log.info({ libraryId, dbPath, readOnly }, 'DB 오픈')
  return db
}

export function getDatabase(libraryId: string): Database | null {
  return pool.get(libraryId)?.db ?? null
}

export function isDatabaseReadOnly(db: Database): boolean {
  return readOnlyDatabases.has(db)
}

export function isLibraryReadOnly(libraryId: string): boolean {
  return pool.get(libraryId)?.readOnly ?? false
}

export function closeDatabase(libraryId: string): void {
  const entry = pool.get(libraryId)
  if (!entry) return

  try {
    entry.db.close()
  } finally {
    releaseLock(entry.lock)
    pool.delete(libraryId)
    log.info({ libraryId }, 'DB 닫힘')
  }
}

export function closeAllDatabases(): void {
  for (const libraryId of pool.keys()) closeDatabase(libraryId)
  log.info('모든 DB 닫힘')
}

export function isDatabaseAvailable(): boolean {
  return BetterSqlite3 !== null
}
