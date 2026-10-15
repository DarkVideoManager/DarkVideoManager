import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Library } from '@shared/types'

const state = vi.hoisted(() => ({
  libraries: [] as Library[],
  subtitleJobs: [] as { libraryId: string; videoId: string; phase: string }[],
  conversionJobs: [] as { libraryId: string; videoId: string; status: string }[],
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  beforeUnlink: undefined as ((path: string) => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    linkSync: (from: string, to: string) => {
      state.beforeRename?.(from, to)
      actual.linkSync(from, to)
    },
    unlinkSync: (path: string) => {
      state.beforeUnlink?.(path)
      actual.unlinkSync(path)
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      state.afterOpen?.()
      return handle
    },
  }
})
vi.mock('../infra/config', () => ({ loadConfig: () => ({ libraries: state.libraries }) }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('./SubtitleGenerationService', () => ({ listSubtitleQueue: () => state.subtitleJobs }))
vi.mock('./PlaybackConversionService', () => ({
  listPlaybackConversionJobs: () => state.conversionJobs,
}))
vi.mock('./CacheService', () => ({ releasePlaybackCache: () => false, trimPlaybackCache: vi.fn() }))

import {
  applyFilenameCleanup,
  cancelLibraryMaintenance,
  findExactDuplicates,
  previewFilenameCleanup,
} from './LibraryMaintenanceService'
import { openDatabase, closeDatabase, closeAllDatabases } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { startPlayback, endPlayback, finishPlaybackSessions } from './PlaybackService'
import { acquireSourceFile } from './SourceFileUsage'
import { withLibraryWork, isLibraryBusy } from './LibraryWorkService'

let directory: string
let db: Database
let repository: VideoRepository
const libraryId = 'maintenance-test'
let releases: (() => void)[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dvm-maintenance-test-'))
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  repository = new VideoRepository(db)
  state.libraries = [
    {
      id: libraryId,
      name: 'Test library',
      dbPath: ':memory:',
      folderPath: directory,
      createdAt: new Date().toISOString(),
    },
  ]
  state.subtitleJobs = []
  state.conversionJobs = []
  state.beforeRename = undefined
  state.beforeUnlink = undefined
  state.afterOpen = undefined
  releases = []
})
afterEach(() => {
  for (const release of releases) release()
  finishPlaybackSessions()
  closeAllDatabases()
  vi.restoreAllMocks()
  const target = resolve(directory)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-maintenance-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

function movie(id: string, name = `[ad] ${id}.mp4`, contents = 'video fixture') {
  const filePath = join(directory, name)
  writeFileSync(filePath, contents)
  repository.insert({
    id,
    filePath,
    fileName: name,
    title: 'My title',
    tags: 'tag',
    rating: 4,
    memo: 'my memo',
    resumePosSec: 12,
  })
  return filePath
}
function sidecar(videoId: string, path: string, id = 'subtitle') {
  writeFileSync(path, 'subtitle fixture')
  new SubtitleRepository(db).insert({
    id,
    videoId,
    filePath: path,
    type: 'srt',
    lang: 'ko',
    isEmbedded: false,
  })
}
const preview = () => previewFilenameCleanup(libraryId, { prefix: '[ad] ' })

describe('filename cleanup preview and confirmed changes', () => {
  it('previews without writes, then preserves metadata and updates original, sidecar and embedded paths together', async () => {
    const original = movie('one')
    const subtitle = join(directory, '[ad] one.ai.ko.srt')
    sidecar('one', subtitle)
    new SubtitleRepository(db).insert({
      id: 'embedded',
      videoId: 'one',
      filePath: original,
      type: 'srt',
      trackIndex: 0,
      isEmbedded: true,
    })
    db.prepare(
      "INSERT INTO highlights(id, video_id, time_start, color) VALUES ('favorite', 'one', 5, 'yellow')",
    ).run()
    const before = repository.findById('one')!
    const plan = await preview()
    expect(plan.rows[0]).toMatchObject({ fileName: '[ad] one.mp4', nextName: 'one.mp4' })
    expect(plan.rows[0].files).toHaveLength(2)
    expect(existsSync(original)).toBe(true)
    expect(existsSync(join(directory, 'one.mp4'))).toBe(false)
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0].status).toBe('renamed')
    expect(readFileSync(join(directory, 'one.mp4'), 'utf8')).toBe('video fixture')
    expect(readFileSync(join(directory, 'one.ai.ko.srt'), 'utf8')).toBe('subtitle fixture')
    expect(existsSync(original)).toBe(false)
    expect(existsSync(subtitle)).toBe(false)
    expect(repository.findById('one')).toMatchObject({
      ...before,
      filePath: join(directory, 'one.mp4'),
      fileName: 'one.mp4',
      updatedAt: expect.any(String),
    })
    expect(new SubtitleRepository(db).findByVideoId('one')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subtitle',
          filePath: join(directory, 'one.ai.ko.srt'),
          lang: 'ko',
        }),
        expect.objectContaining({
          id: 'embedded',
          filePath: join(directory, 'one.mp4'),
          trackIndex: 0,
        }),
      ]),
    )
    expect(db.prepare('SELECT time_start FROM highlights WHERE id = ?').get('favorite')).toEqual({
      time_start: 5,
    })
    await expect(applyFilenameCleanup(libraryId, plan.id, ['one'])).rejects.toThrow('미리보기')
  })

  it('rejects empty/reserved names and destination collisions without overwriting either file', async () => {
    movie('empty', '[ad] .mp4')
    movie('reserved', '[ad] CON.mp4')
    const original = movie('collision')
    writeFileSync(join(directory, 'collision.mp4'), 'keep destination')
    const plan = await preview()
    expect(plan.rows.every((row) => row.error)).toBe(true)
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(join(directory, 'collision.mp4'), 'utf8')).toBe('keep destination')
    await expect(applyFilenameCleanup(libraryId, plan.id, ['collision'])).rejects.toThrow(
      '변경 가능한',
    )
  })

  it('rechecks collision and source snapshots after preview', async () => {
    const original = movie('one')
    const plan = await preview()
    writeFileSync(join(directory, 'one.mp4'), 'arrived later')
    expect((await applyFilenameCleanup(libraryId, plan.id, ['one'])).items[0].status).toBe('failed')
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(join(directory, 'one.mp4'), 'utf8')).toBe('arrived later')
    unlinkSync(join(directory, 'one.mp4'))
    const next = await preview()
    writeFileSync(original, 'modified original contents')
    const result = await applyFilenameCleanup(libraryId, next.id, ['one'])
    expect(result.items[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('파일'),
    })
    expect(readFileSync(original, 'utf8')).toBe('modified original contents')
  })

  it('binds preview tokens to the library and selected IDs and expires them', async () => {
    movie('one')
    const plan = await preview()
    await expect(applyFilenameCleanup(libraryId, plan.id, ['unknown'])).rejects.toThrow('미리보기')
    await expect(applyFilenameCleanup(libraryId, plan.id, ['one', 'one'])).rejects.toThrow('선택')
    const other = openDatabase('other', ':memory:')
    runMigrations(other, ':memory:')
    await expect(applyFilenameCleanup('other', plan.id, ['one'])).rejects.toThrow('다른 라이브러리')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 601_000)
    await expect(applyFilenameCleanup(libraryId, plan.id, ['one'])).rejects.toThrow('만료')
  })

  it('rejects missing files and read-only database writes', async () => {
    const original = movie('one')
    const plan = await preview()
    db.pragma('query_only = ON')
    await expect(applyFilenameCleanup(libraryId, plan.id, ['one'])).rejects.toThrow('읽기 전용')
    db.pragma('query_only = OFF')
    unlinkSync(original)
    expect((await preview()).rows[0].error).toBeTruthy()
    expect((await applyFilenameCleanup(libraryId, plan.id, ['one'])).items[0].status).toBe('failed')
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('rolls all file names back when database writes fail', async () => {
    const original = movie('one')
    const subtitle = join(directory, '[ad] one.srt')
    sidecar('one', subtitle)
    const plan = await preview()
    db.exec(
      "CREATE TRIGGER reject_rename BEFORE UPDATE OF file_path ON videos BEGIN SELECT RAISE(FAIL, 'simulated DB failure'); END",
    )
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0]).toMatchObject({ status: 'failed', message: 'simulated DB failure' })
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(subtitle, 'utf8')).toBe('subtitle fixture')
    expect(existsSync(join(directory, 'one.mp4'))).toBe(false)
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('rolls a video rename back if a sidecar move fails', async () => {
    const original = movie('one')
    const subtitle = join(directory, '[ad] one.srt')
    sidecar('one', subtitle)
    const plan = await preview()
    state.beforeRename = (from) => {
      if (from === subtitle) throw new Error('file is in use')
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('file is in use'),
    })
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(subtitle, 'utf8')).toBe('subtitle fixture')
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('preserves both files and reports recovery locations if an external collision prevents rollback', async () => {
    const original = movie('one')
    const subtitle = join(directory, '[ad] one.srt')
    sidecar('one', subtitle)
    const plan = await preview()
    state.beforeRename = (from) => {
      if (from === subtitle) {
        writeFileSync(original, 'new external file')
        throw new Error('sidecar locked')
      }
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0].message).toContain(join(directory, 'one.mp4'))
    expect(result.items[0].message).toContain('복구')
    expect(readFileSync(original, 'utf8')).toBe('new external file')
    expect(readFileSync(join(directory, 'one.mp4'), 'utf8')).toBe('video fixture')
    expect(readFileSync(subtitle, 'utf8')).toBe('subtitle fixture')
  })

  it('never overwrites a destination created after the last preflight check', async () => {
    const original = movie('one')
    const target = join(directory, 'one.mp4')
    const plan = await preview()
    state.beforeRename = (_from, to) => writeFileSync(to, 'external destination')
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0].status).toBe('failed')
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(target, 'utf8')).toBe('external destination')
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('never overwrites a source created between rollback checks and the rollback move', async () => {
    const original = movie('one')
    const target = join(directory, 'one.mp4')
    const plan = await preview()
    db.exec(
      "CREATE TRIGGER reject_rename BEFORE UPDATE OF file_path ON videos BEGIN SELECT RAISE(FAIL, 'DB failure'); END",
    )
    state.beforeRename = (from, to) => {
      if (from === target) writeFileSync(to, 'external source')
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0].message).toContain('복구')
    expect(readFileSync(original, 'utf8')).toBe('external source')
    expect(readFileSync(target, 'utf8')).toBe('video fixture')
  })

  it('fails safely when exclusive hard links are unavailable, without falling back to rename', async () => {
    const original = movie('one')
    const plan = await preview()
    state.beforeRename = () => {
      throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' })
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0].message).toContain('하드 링크 지원')
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(existsSync(join(directory, 'one.mp4'))).toBe(false)
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('preserves and reports both paths when unlinking the old name fails after linking', async () => {
    const original = movie('one')
    const target = join(directory, 'one.mp4')
    const plan = await preview()
    state.beforeUnlink = (path) => {
      if (path === original) throw new Error('access denied')
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one'])
    expect(result.items[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining(target),
    })
    expect(result.items[0].message).toContain(original)
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(target, 'utf8')).toBe('video fixture')
    expect(repository.findById('one')?.filePath).toBe(original)
  })

  it('refuses unregistered nearby sidecars both before preview and just before applying', async () => {
    const original = movie('one')
    const subtitle = join(directory, '[ad] one.srt')
    const plan = await preview()
    writeFileSync(subtitle, 'unregistered subtitle')
    expect((await preview()).rows[0].error).toContain('새로고침')
    expect((await applyFilenameCleanup(libraryId, plan.id, ['one'])).items[0].message).toContain(
      '등록되지',
    )
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(readFileSync(subtitle, 'utf8')).toBe('unregistered subtitle')
  })

  it('does not rename files shared with another open or closed library', async () => {
    const original = movie('one')
    const otherPath = join(directory, 'other.db')
    const other = openDatabase('other', otherPath)
    runMigrations(other, otherPath)
    new VideoRepository(other).insert({
      id: 'also-one',
      filePath: original,
      fileName: basename(original),
      rating: 0,
      memo: '',
      resumePosSec: 0,
    })
    state.libraries.push({
      id: 'other',
      name: 'Other',
      dbPath: otherPath,
      folderPath: directory,
      createdAt: '',
    })
    expect((await preview()).rows[0].error).toContain('다른 라이브러리')
    closeDatabase('other')
    expect((await preview()).rows[0].error).toContain('다른 라이브러리')
  })

  it('rejects sidecars shared with another video in the same library', async () => {
    movie('one')
    movie('two', 'two.mp4')
    const file = join(directory, '[ad] one.srt')
    sidecar('one', file, 'first')
    sidecar('two', file, 'second')
    expect((await preview()).rows[0].error).toContain('다른 영상')
  })

  it('respects missing destination paths reserved by other libraries or subtitle owners', async () => {
    const original = movie('one')
    const target = join(directory, 'one.mp4')
    const other = openDatabase('other', ':memory:')
    runMigrations(other, ':memory:')
    new VideoRepository(other).insert({
      id: 'other',
      filePath: target,
      fileName: 'one.mp4',
      rating: 0,
      memo: '',
      resumePosSec: 0,
    })
    const plan = await preview()
    state.libraries.push({
      id: 'other',
      name: 'Other',
      dbPath: ':memory:',
      folderPath: directory,
      createdAt: '',
    })
    expect((await preview()).rows[0].error).toContain('다른 라이브러리')
    expect((await applyFilenameCleanup(libraryId, plan.id, ['one'])).items[0].status).toBe('failed')
    state.libraries.pop()
    movie('two', 'two.mp4')
    sidecar('one', join(directory, '[ad] one.srt'), 'first')
    new SubtitleRepository(db).insert({
      id: 'reserved',
      videoId: 'two',
      filePath: join(directory, 'one.srt'),
      type: 'srt',
      isEmbedded: false,
    })
    expect((await preview()).rows[0].error).toContain('다른 영상')
    expect(readFileSync(original, 'utf8')).toBe('video fixture')
    expect(existsSync(target)).toBe(false)
  })

  it('protects paused in-app playback, pending native use, and queued or paused source jobs', async () => {
    const original = movie('one')
    startPlayback(libraryId, 'one')
    expect((await preview()).rows[0].error).toContain('재생 중')
    endPlayback(libraryId, 'one', 12)
    const release = acquireSourceFile(original)
    releases.push(release)
    expect((await preview()).rows[0].error).toContain('재생 중')
    release()
    state.subtitleJobs = [{ libraryId, videoId: 'one', phase: 'paused' }]
    expect((await preview()).rows[0].error).toContain('자막 작업')
    state.subtitleJobs = []
    const plan = await preview()
    state.conversionJobs = [{ libraryId, videoId: 'one', status: 'queued' }]
    expect((await applyFilenameCleanup(libraryId, plan.id, ['one'])).items[0].message).toContain(
      '변환 작업',
    )
    expect(existsSync(original)).toBe(true)
  })

  it('rejects other library work and its cancellation cannot cancel unrelated work', async () => {
    await withLibraryWork(libraryId, async (signal) => {
      expect(cancelLibraryMaintenance(libraryId)).toBe(false)
      expect(signal.aborted).toBe(false)
      await expect(preview()).rejects.toThrow('다른 작업')
      await expect(findExactDuplicates(libraryId)).rejects.toThrow('다른 작업')
    })
  })

  it('cancels between video groups and preserves the completed group plus every untouched original', async () => {
    movie('one')
    const second = movie('two')
    const plan = await preview()
    state.beforeRename = (from) => {
      if (from.endsWith('[ad] one.mp4')) cancelLibraryMaintenance(libraryId)
    }
    const result = await applyFilenameCleanup(libraryId, plan.id, ['one', 'two'])
    expect(result).toMatchObject({
      cancelled: true,
      items: [
        { videoId: 'one', status: 'renamed' },
        { videoId: 'two', status: 'cancelled' },
      ],
    })
    expect(readFileSync(join(directory, 'one.mp4'), 'utf8')).toBe('video fixture')
    expect(readFileSync(second, 'utf8')).toBe('video fixture')
    expect(isLibraryBusy(libraryId)).toBe(false)
  })
})

describe('exact duplicate candidates', () => {
  it('groups differently named exact bytes by full SHA-256 and excludes same-sized different content', async () => {
    movie('one', 'one.mp4', 'same bytes')
    movie('two', 'different-name.mkv', 'same bytes')
    movie('three', 'similar-name.mp4', 'other data')
    movie('unique', 'unique.mp4', 'unique size')
    const missing = movie('missing', 'missing.mp4')
    unlinkSync(missing)
    const result = await findExactDuplicates(libraryId)
    expect(result.groups).toEqual([
      {
        sha256: createHash('sha256').update('same bytes').digest('hex'),
        sizeBytes: 10,
        files: expect.arrayContaining([
          expect.objectContaining({ videoId: 'one' }),
          expect.objectContaining({ videoId: 'two' }),
        ]),
      },
    ])
    expect(result.groups[0].files).toHaveLength(2)
    expect(result.checkedFiles).toBe(3)
    expect(result.skipped).toEqual([expect.objectContaining({ videoId: 'missing' })])
    expect(repository.count()).toBe(5)
  })

  it('reads the middle of large files rather than reusing the existing sampled hash', async () => {
    const first = movie('first', 'first.mp4', '')
    const second = movie('second', 'second.mp4', '')
    for (const file of [first, second]) {
      const fd = openSync(file, 'r+')
      ftruncateSync(fd, 132 * 1024 * 1024)
      closeSync(fd)
    }
    const fd = openSync(second, 'r+')
    writeSync(fd, Buffer.from('X'), 0, 1, 66 * 1024 * 1024)
    closeSync(fd)
    const result = await findExactDuplicates(libraryId)
    expect(result.checkedFiles).toBe(2)
    expect(result.groups).toEqual([])
  }, 20_000)

  it('cancels a hash without changing files or retaining the library work lock', async () => {
    const first = movie('first', 'first.mp4', 'same bytes')
    movie('second', 'second.mp4', 'same bytes')
    state.afterOpen = () => {
      cancelLibraryMaintenance(libraryId)
    }
    const result = await findExactDuplicates(libraryId)
    expect(result.cancelled).toBe(true)
    expect(result.groups).toEqual([])
    expect(readFileSync(first, 'utf8')).toBe('same bytes')
    expect(isLibraryBusy(libraryId)).toBe(false)
  })

  it('does not report a source that changes while hashing', async () => {
    const first = movie('first', 'first.mp4', 'same bytes')
    movie('second', 'second.mp4', 'same bytes')
    state.afterOpen = () => {
      writeFileSync(first, 'changed bytes')
      state.afterOpen = undefined
    }
    const result = await findExactDuplicates(libraryId)
    expect(result.groups).toEqual([])
    expect(result.skipped).toEqual([expect.objectContaining({ videoId: 'first' })])
  })
})
