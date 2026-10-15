import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))

import { closeAllDatabases, closeDatabase, isLibraryReadOnly, openDatabase } from './connection'

const ownerPid = process.pid + 100000
const acquiredAt = '2026-10-13T12:39:26.076Z'
const earlierStart = '2026-10-13T12:00:00.000Z\r\n'
const reusedStart = '2026-10-13T13:30:30.000Z\r\n'
let directory: string
let dbPath: string
let lockPath: string

beforeEach(() => {
  mocks.execFileSync.mockReset()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  directory = mkdtempSync(join(tmpdir(), 'dvm-database-lock-test-'))
  dbPath = join(directory, 'library.db')
  lockPath = `${dbPath}.lock`
  const seed = new Database(dbPath)
  try {
    seed.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('preserved')")
  } finally {
    seed.close()
  }
})

afterEach(() => {
  closeAllDatabases()
  vi.restoreAllMocks()
  const target = resolve(directory)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-database-lock-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

function writeLock(value: unknown = { pid: ownerPid, acquiredAt }): string {
  const content = JSON.stringify(value)
  writeFileSync(lockPath, content)
  return content
}

function expectReaderPreservesLock(content: string): void {
  const reader = openDatabase('reader', dbPath)
  expect(reader.readonly).toBe(true)
  expect(isLibraryReadOnly('reader')).toBe(true)
  expect(reader.pragma('query_only', { simple: true })).toBe(1)
  expect(reader.prepare('SELECT body FROM notes').get()).toEqual({ body: 'preserved' })
  expect(() => reader.prepare('INSERT INTO notes VALUES (?)').run('blocked')).toThrow()
  expect(readFileSync(lockPath, 'utf8')).toBe(content)
  closeDatabase('reader')
  expect(readFileSync(lockPath, 'utf8')).toBe(content)
}

describe('database lock ownership', () => {
  it('does not create a missing database when reopening an existing library', () => {
    const missingPath = join(directory, 'missing.db')
    expect(() => openDatabase('missing', missingPath, { fileMustExist: true })).toThrow()
    expect(existsSync(missingPath)).toBe(false)
    expect(existsSync(`${missingPath}.lock`)).toBe(false)
    const reopened = openDatabase('existing', dbPath, { fileMustExist: true })
    expect(reopened.prepare('SELECT body FROM notes').get()).toEqual({ body: 'preserved' })
  })

  it('recovers a dead owner and preserves existing database contents', () => {
    writeLock()
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('Process does not exist'), { code: 'ESRCH' })
    })

    const writer = openDatabase('writer', dbPath)
    expect(writer.readonly).toBe(false)
    expect(isLibraryReadOnly('writer')).toBe(false)
    expect(writer.prepare('SELECT body FROM notes').get()).toEqual({ body: 'preserved' })
    writer.prepare('INSERT INTO notes VALUES (?)').run('new note')
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    closeDatabase('writer')
    expect(existsSync(lockPath)).toBe(false)
  })

  it.each(['EPERM', 'EACCES', undefined])(
    'keeps the owner protected when process probing fails with %s',
    (code) => {
      const content = writeLock()
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('Cannot inspect owner'), { code })
      })
      expectReaderPreservesLock(content)
      expect(mocks.execFileSync).not.toHaveBeenCalled()
    },
  )

  it.each([0, -1, 12.5, '1234', null, undefined, Number.MAX_SAFE_INTEGER + 1])(
    'keeps an invalid owner PID %s protected without invoking process commands',
    (pid) => {
      expectReaderPreservesLock(writeLock({ pid, acquiredAt }))
      expect(process.kill).not.toHaveBeenCalled()
      expect(mocks.execFileSync).not.toHaveBeenCalled()
    },
  )

  it('does not remove an incomplete lock file', () => {
    writeFileSync(lockPath, '{"pid":')
    expectReaderPreservesLock('{"pid":')
    expect(process.kill).not.toHaveBeenCalled()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows process ID reuse', () => {
  it('recovers a stale lock when its PID now belongs to a newer process', () => {
    writeLock()
    mocks.execFileSync.mockReturnValue(reusedStart)

    const writer = openDatabase('writer', dbPath)
    expect(writer.readonly).toBe(false)
    expect(isLibraryReadOnly('writer')).toBe(false)
    writer.prepare('INSERT INTO notes VALUES (?)').run('subtitle metadata')
    expect(writer.prepare('SELECT body FROM notes ORDER BY rowid').all()).toEqual([
      { body: 'preserved' },
      { body: 'subtitle metadata' },
    ])
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ windowsHide: true, timeout: 3000, encoding: 'utf8' }),
    )
    closeDatabase('writer')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('recovers a stale lock when the relaunched app itself reuses the former owner PID', () => {
    writeLock({ pid: process.pid, acquiredAt })
    mocks.execFileSync.mockReturnValue(reusedStart)

    const writer = openDatabase('writer', dbPath)
    expect(writer.readonly).toBe(false)
    expect(isLibraryReadOnly('writer')).toBe(false)
    writer.prepare('INSERT INTO notes VALUES (?)').run('saved after restart')
    expect(writer.prepare('SELECT COUNT(*) AS count FROM notes').get()).toEqual({ count: 2 })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    expect(mocks.execFileSync).toHaveBeenCalledOnce()
    closeDatabase('writer')
    expect(existsSync(lockPath)).toBe(false)
  })

  it.each([earlierStart, acquiredAt])(
    'keeps a genuine owner protected when it started at %s',
    (startedAt) => {
      mocks.execFileSync.mockReturnValue(startedAt)
      expectReaderPreservesLock(writeLock())
    },
  )

  it.each(['', 'not a date'])('keeps ownership when process time output is %j', (output) => {
    mocks.execFileSync.mockReturnValue(output)
    expectReaderPreservesLock(writeLock())
  })

  it.each(['EPERM', 'ETIMEDOUT', 'ENOENT'])(
    'keeps ownership when the creation-time command fails with %s',
    (code) => {
      mocks.execFileSync.mockImplementation(() => {
        throw Object.assign(new Error('Process creation time unavailable'), { code })
      })
      expectReaderPreservesLock(writeLock())
    },
  )

  it.each([undefined, null, '', 'invalid date'])(
    'keeps ownership when the recorded acquisition date is %j',
    (value) => {
      mocks.execFileSync.mockReturnValue(reusedStart)
      expectReaderPreservesLock(writeLock({ pid: ownerPid, acquiredAt: value }))
      expect(mocks.execFileSync).not.toHaveBeenCalled()
    },
  )

  it('preserves a lock replaced while its former owner is being inspected', () => {
    writeLock()
    const replacement = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })
    mocks.execFileSync.mockImplementation(() => {
      writeFileSync(lockPath, replacement)
      return reusedStart
    })

    expectReaderPreservesLock(replacement)
  })
})
