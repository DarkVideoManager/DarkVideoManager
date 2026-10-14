import { copyFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Database } from 'better-sqlite3'
import { createLogger } from '../infra/logger'
import { isDatabaseReadOnly } from './connection'

const log = createLogger('db:migrator')

interface Migration {
  version: number
  filePath: string
  sql: string
}

interface SchemaVersionRow {
  version: number | null
}

function migrationDirectories(): string[] {
  const directories = [
    join(__dirname, 'migrations'),
    join(process.cwd(), 'electron/main/db/migrations'),
  ]
  if (process.resourcesPath) directories.unshift(join(process.resourcesPath, 'migrations'))
  return directories
}

function readMigrations(): Migration[] {
  const directory = migrationDirectories().find((candidate) => existsSync(candidate))
  if (!directory) throw new Error('DB migration 디렉터리를 찾을 수 없습니다.')

  const migrations = readdirSync(directory)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .map((fileName) => {
      const match = /^(\d+)_/.exec(fileName)
      if (!match) throw new Error(`잘못된 migration 파일명: ${fileName}`)
      const version = Number(match[1])
      const filePath = join(directory, fileName)
      return { version, filePath, sql: readFileSync(filePath, 'utf8') }
    })
    .sort((left, right) => left.version - right.version)

  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]
    const expectedVersion = index + 1
    if (migration.version !== expectedVersion) {
      throw new Error(`DB migration 버전이 연속적이지 않습니다: ${migration.version}`)
    }
  }
  return migrations
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present?: number } | undefined
  return row?.present === 1
}

function currentVersion(db: Database): number {
  if (!tableExists(db, 'schema_version')) return 0
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as SchemaVersionRow
  return row.version ?? 0
}

function ensureSubtitleColumns(db: Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(subtitles)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  )
  if (!columns.has('track_index')) db.exec('ALTER TABLE subtitles ADD COLUMN track_index INTEGER')
  if (!columns.has('is_embedded')) {
    db.exec('ALTER TABLE subtitles ADD COLUMN is_embedded INTEGER NOT NULL DEFAULT 0')
  }
}

function createBackup(db: Database, dbPath: string): string | null {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
  if (checkpoint.some((row) => row.busy !== 0))
    throw new Error('DB checkpoint가 잠겨 있어 안전한 백업을 만들 수 없습니다.')
  const backupPath = `${dbPath}.bak.${Date.now()}`
  copyFileSync(dbPath, backupPath)
  log.info({ backupPath }, '마이그레이션 전 백업 생성')
  return backupPath
}

export function getSchemaVersion(db: Database): number {
  return currentVersion(db)
}

export function runMigrations(db: Database, dbPath: string): void {
  const migrations = readMigrations()
  const version = currentVersion(db)
  const pending = migrations.filter((migration) => migration.version > version)
  if (pending.length === 0) {
    log.debug({ currentVersion: version }, 'DB 최신 상태')
    return
  }

  if (isDatabaseReadOnly(db)) {
    throw new Error(
      `읽기 전용 DB에 migration이 필요합니다: ${version} → ${migrations.at(-1)?.version}`,
    )
  }

  createBackup(db, dbPath)
  const applyMigrations = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `)

    for (const migration of pending) {
      log.info({ version: migration.version, filePath: migration.filePath }, 'migration 적용 중')
      if (migration.version === 3) {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        )
        for (const [column, definition] of [
          ['tags', "TEXT NOT NULL DEFAULT ''"],
          ['play_count', 'INTEGER NOT NULL DEFAULT 0'],
          ['play_time_sec', 'REAL NOT NULL DEFAULT 0'],
        ]) {
          if (!columns.has(column))
            db.exec('ALTER TABLE videos ADD COLUMN ' + column + ' ' + definition)
        }
      }
      db.exec(migration.sql)
      if (migration.version === 2) ensureSubtitleColumns(db)
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(migration.version)
      log.info({ version: migration.version }, 'migration 완료')
    }
  })

  applyMigrations.immediate()
}
