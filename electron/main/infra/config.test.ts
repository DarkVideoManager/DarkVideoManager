import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Config } from '@shared/types'

const state = vi.hoisted(() => ({ path: '' }))
vi.mock('./paths', () => ({ getConfigPath: () => state.path }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  }
})
import { loadConfig, saveConfig, updateConfig, takeConfigRecoveryNotice } from './config'

let directory: string
let realFs: typeof import('node:fs')
const example = (): Config => ({
  libraries: [
    {
      id: 'library-1',
      name: 'Movies',
      dbPath: 'D:\\library.db',
      folderPath: 'D:\\Movies',
      folderPaths: ['D:\\Movies', 'E:\\Other'],
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  lastActiveLibraryId: 'library-1',
})
const raw = (path = state.path) => readFileSync(path, 'utf8')
const parsed = (path = state.path) => JSON.parse(raw(path)) as Config
const backupPath = () => state.path + '.bak'

beforeEach(async () => {
  realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(writeFileSync).mockReset().mockImplementation(realFs.writeFileSync)
  vi.mocked(fsyncSync).mockReset().mockImplementation(realFs.fsyncSync)
  vi.mocked(renameSync).mockReset().mockImplementation(realFs.renameSync)
  directory = mkdtempSync(join(tmpdir(), 'dvm-config-test-'))
  state.path = join(directory, 'config.json')
  takeConfigRecoveryNotice()
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(directory)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-config-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('safe configuration persistence', () => {
  it('does not rotate or reformat an unchanged valid registry', () => {
    const original = '\uFEFF' + JSON.stringify(example())
    writeFileSync(state.path, original)
    vi.mocked(renameSync).mockClear()
    vi.mocked(fsyncSync).mockClear()
    saveConfig(loadConfig())
    expect(raw()).toBe(original)
    expect(existsSync(backupPath())).toBe(false)
    expect(renameSync).not.toHaveBeenCalled()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('can save when an equivalent valid backup cannot be replaced', () => {
    saveConfig(example())
    const backup = JSON.stringify(example())
    writeFileSync(backupPath(), backup)
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === backupPath()) {
        throw Object.assign(new Error('locked backup'), { code: 'EPERM' })
      }
      realFs.renameSync(from, to)
    })
    const changed = example()
    changed.libraries[0].name = 'Changed'
    saveConfig(changed)
    expect(parsed()).toEqual(changed)
    expect(raw(backupPath())).toBe(backup)
    expect(readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries a temporary %s on backup and primary replacement without deleting either target',
    (code) => {
      saveConfig(example())
      const current = example()
      current.libraries[0].name = 'Current'
      saveConfig(current)
      const attempts = new Map<string, number>()
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
      vi.mocked(renameSync).mockImplementation((from, to) => {
        const target = String(to)
        const attempt = (attempts.get(target) ?? 0) + 1
        attempts.set(target, attempt)
        expect(parsed()).toEqual(current)
        if (attempt <= 2) throw Object.assign(new Error('temporary sharing violation'), { code })
        realFs.renameSync(from, to)
      })
      const changed = example()
      changed.libraries[0].name = 'Changed'
      saveConfig(changed)
      expect(attempts.get(backupPath())).toBe(3)
      expect(attempts.get(state.path)).toBe(3)
      expect(wait).toHaveBeenCalledTimes(4)
      expect(parsed()).toEqual(changed)
      expect(parsed(backupPath())).toEqual(current)
      expect(readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
    },
  )

  it.each(['backup', 'primary'])(
    'reports a persistent %s lock and preserves the saved configuration',
    (target) => {
      saveConfig(example())
      const current = example()
      current.libraries[0].name = 'Current'
      saveConfig(current)
      const before = raw(),
        backup = raw(backupPath())
      const lockedPath = target === 'backup' ? backupPath() : state.path
      const failure = Object.assign(new Error('persistent sharing violation'), { code: 'EPERM' })
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
      vi.mocked(renameSync).mockImplementation((from, to) => {
        if (to === lockedPath) throw failure
        realFs.renameSync(from, to)
      })
      let caught: Error | undefined
      try {
        saveConfig({ libraries: [] })
      } catch (error) {
        caught = error as Error
      }
      expect(caught?.message).toContain(lockedPath)
      expect(caught?.message).toContain('읽기 전용')
      expect(caught?.message).toContain('EPERM')
      expect(caught?.cause).toBe(failure)
      expect(wait).toHaveBeenCalledTimes(5)
      expect(raw()).toBe(before)
      expect(raw(backupPath())).toBe(target === 'backup' ? backup : before)
      expect(readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
      vi.mocked(renameSync).mockImplementation(realFs.renameSync)
      saveConfig({ libraries: [] })
      expect(parsed()).toEqual({ libraries: [] })
      expect(parsed(backupPath())).toEqual(current)
    },
  )

  it.skipIf(process.platform !== 'win32').each(['backup', 'primary'])(
    'preserves both valid files when the Windows %s file is read-only',
    (target) => {
      saveConfig(example())
      const current = example()
      current.libraries[0].name = 'Current'
      saveConfig(current)
      const before = raw(),
        backup = raw(backupPath())
      const lockedPath = target === 'backup' ? backupPath() : state.path
      chmodSync(lockedPath, 0o444)
      try {
        expect(() => saveConfig({ libraries: [] })).toThrow('읽기 전용')
        expect(raw()).toBe(before)
        expect(raw(backupPath())).toBe(target === 'backup' ? backup : before)
        expect(readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
      } finally {
        chmodSync(lockedPath, 0o600)
      }
      saveConfig({ libraries: [] })
      expect(parsed()).toEqual({ libraries: [] })
      expect(parsed(backupPath())).toEqual(current)
    },
  )

  it('keeps the seek interval across reloads while accepting older configurations', () => {
    saveConfig(example())
    expect(loadConfig().seekStepSec).toBeUndefined()
    updateConfig((current) => ({ ...current, seekStepSec: 15 }))
    expect(loadConfig()).toMatchObject({ ...example(), seekStepSec: 15 })
    updateConfig((current) => ({ ...current, cacheLimitGb: 20 }))
    expect(loadConfig().seekStepSec).toBe(15)
  })

  it.each([0, -1, 1.5, 601, Number.NaN, Infinity])(
    'rejects invalid seek interval %s without changing the saved configuration',
    (seekStepSec) => {
      saveConfig({ ...example(), seekStepSec: 10 })
      const before = raw()
      expect(() => updateConfig((current) => ({ ...current, seekStepSec }))).toThrow('설정 구조')
      expect(raw()).toBe(before)
      expect(loadConfig().seekStepSec).toBe(10)
    },
  )

  it('allows only a fresh installation to start with an independent empty registry', () => {
    const first = loadConfig()
    first.libraries.push(example().libraries[0])
    expect(loadConfig()).toEqual({ libraries: [] })
    expect(existsSync(state.path)).toBe(false)
    saveConfig({ libraries: [] })
    expect(parsed()).toEqual({ libraries: [] })
  })

  it('preserves unknown optional settings and retains the previous valid version', () => {
    const config = { ...example(), player: { preferred: 'mpv', unknownFutureOption: [1, 2] } }
    Object.assign(config.libraries[0], { futureLibrarySetting: { enabled: true } })
    saveConfig(config)
    updateConfig((current) => ({ ...current, lastActiveLibraryId: undefined }))
    expect(loadConfig()).toMatchObject({
      player: config.player,
      libraries: [{ futureLibrarySetting: { enabled: true } }],
    })
    expect(parsed(backupPath())).toEqual(config)
    expect(loadConfig().lastActiveLibraryId).toBeUndefined()
  })

  it('rejects structurally invalid updates without changing either good file', () => {
    saveConfig(example())
    saveConfig({ ...example(), lastActiveLibraryId: undefined })
    const before = raw(),
      backup = raw(backupPath())
    expect(() => saveConfig({ libraries: [{ id: 'broken' }] } as Config)).toThrow('설정 구조')
    expect(raw()).toBe(before)
    expect(raw(backupPath())).toBe(backup)
  })

  it('recovers a corrupt primary and preserves its exact original contents', () => {
    saveConfig(example())
    saveConfig({ ...example(), lastActiveLibraryId: undefined })
    const damaged = '{"libraries":['
    writeFileSync(state.path, damaged)
    expect(loadConfig()).toEqual(example())
    expect(parsed()).toEqual(example())
    expect(parsed(backupPath())).toEqual(example())
    const preserved = readdirSync(directory).find((name) =>
      name.startsWith('config.json.corrupt.'),
    )!
    expect(raw(join(directory, preserved))).toBe(damaged)
    expect(takeConfigRecoveryNotice()).toContain(preserved)
    expect(takeConfigRecoveryNotice()).toBeUndefined()
  })

  it('treats valid JSON with invalid structure as corrupt and recovers the backup', () => {
    writeFileSync(backupPath(), JSON.stringify(example()))
    writeFileSync(state.path, JSON.stringify({ libraries: 'not-an-array' }))
    expect(loadConfig()).toEqual(example())
    expect(readdirSync(directory).some((name) => name.startsWith('config.json.corrupt.'))).toBe(
      true,
    )
  })

  it('recovers a missing primary from the backup', () => {
    writeFileSync(backupPath(), JSON.stringify(example()))
    expect(loadConfig()).toEqual(example())
    expect(parsed()).toEqual(example())
    expect(takeConfigRecoveryNotice()).toContain('백업으로 복원')
  })

  it('does not overwrite two corrupt copies with a new empty configuration', () => {
    writeFileSync(state.path, 'truncated-main')
    writeFileSync(backupPath(), '{"libraries":[{}]}')
    const update = vi.fn(() => ({ libraries: [] }))
    expect(() => updateConfig(update)).toThrow('안전하게 복원')
    expect(update).not.toHaveBeenCalled()
    expect(() => saveConfig({ libraries: [] })).toThrow('안전하게 복원')
    expect(raw()).toBe('truncated-main')
    expect(raw(backupPath())).toBe('{"libraries":[{}]}')
  })

  it.each(['database', 'temporary-file', 'corrupt-copy'])(
    'refuses a missing registry when previous %s evidence exists',
    (kind) => {
      if (kind === 'database') {
        mkdirSync(join(directory, 'libs'))
        writeFileSync(join(directory, 'libs', 'old-library.db'), 'synthetic database marker')
      } else
        writeFileSync(
          state.path + (kind === 'temporary-file' ? '.tmp.crashed' : '.corrupt.saved'),
          'old data',
        )
      expect(() => loadConfig()).toThrow('안전하게 복원')
      expect(existsSync(state.path)).toBe(false)
    },
  )

  it('ignores an interrupted temporary write when the committed primary is valid', () => {
    saveConfig(example())
    writeFileSync(state.path + '.tmp.crashed', '{"libraries":[')
    expect(loadConfig()).toEqual(example())
    expect(raw(state.path + '.tmp.crashed')).toBe('{"libraries":[')
  })

  it('leaves the old primary and a valid backup after a partial replacement write', () => {
    saveConfig(example())
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === 'number' && String(data).includes('Changed')) {
        realFs.writeFileSync(file, '{"libraries":', options)
        throw new Error('injected disk full')
      }
      realFs.writeFileSync(file, data, options)
    })
    const changed = example()
    changed.libraries[0].name = 'Changed'
    expect(() => saveConfig(changed)).toThrow('injected disk full')
    expect(parsed()).toEqual(example())
    expect(parsed(backupPath())).toEqual(example())
    expect(readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
  })

  it('never renames a replacement whose fsync failed', () => {
    saveConfig(example())
    vi.mocked(renameSync).mockClear()
    vi.mocked(fsyncSync)
      .mockImplementationOnce(realFs.fsyncSync)
      .mockImplementationOnce(() => {
        throw new Error('injected flush failure')
      })
    expect(() => saveConfig({ ...example(), lastActiveLibraryId: undefined })).toThrow(
      'injected flush failure',
    )
    expect(parsed()).toEqual(example())
    expect(parsed(backupPath())).toEqual(example())
    expect(vi.mocked(renameSync).mock.calls.some(([, target]) => target === state.path)).toBe(false)
  })

  it('flushes temporary files in the same directory and survives a final rename failure', () => {
    saveConfig(example())
    vi.mocked(renameSync).mockClear()
    vi.mocked(fsyncSync).mockClear()
    vi.mocked(renameSync).mockImplementation((from, to) => {
      expect(dirname(String(from))).toBe(directory)
      expect(String(from)).toContain('.tmp.')
      if (to === state.path) throw new Error('injected rename failure')
      realFs.renameSync(from, to)
    })
    expect(() => saveConfig({ ...example(), lastActiveLibraryId: undefined })).toThrow(
      'injected rename failure',
    )
    expect(parsed()).toEqual(example())
    expect(parsed(backupPath())).toEqual(example())
    const flushOrder = vi.mocked(fsyncSync).mock.invocationCallOrder
    const renameOrder = vi.mocked(renameSync).mock.invocationCallOrder
    expect(flushOrder).toHaveLength(2)
    expect(flushOrder[0]).toBeLessThan(renameOrder[0])
    expect(flushOrder[1]).toBeLessThan(renameOrder[1])
  })

  it('aborts a save when updating the backup fails, preserving both existing copies', () => {
    saveConfig(example())
    const current = example()
    current.libraries[0].name = 'Current'
    saveConfig(current)
    const before = raw(),
      backup = raw(backupPath())
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === backupPath()) throw new Error('injected backup failure')
      realFs.renameSync(from, to)
    })
    expect(() => saveConfig({ libraries: [] })).toThrow('injected backup failure')
    expect(raw()).toBe(before)
    expect(raw(backupPath())).toBe(backup)
  })

  it('rebuilds a corrupt backup from the good primary while keeping damaged bytes', () => {
    saveConfig(example())
    writeFileSync(backupPath(), 'broken-backup')
    saveConfig({ ...example(), lastActiveLibraryId: undefined })
    expect(parsed(backupPath())).toEqual(example())
    const preserved = readdirSync(directory).find((name) =>
      name.startsWith('config.json.bak.corrupt.'),
    )!
    expect(raw(join(directory, preserved))).toBe('broken-backup')
  })

  it('can retry recovery after a failed restoration without losing the backup or corrupt copy', () => {
    writeFileSync(state.path, 'corrupt-main')
    writeFileSync(backupPath(), JSON.stringify(example()))
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === state.path) throw new Error('injected recovery failure')
      realFs.renameSync(from, to)
    })
    expect(() => loadConfig()).toThrow('injected recovery failure')
    expect(parsed(backupPath())).toEqual(example())
    expect(readdirSync(directory).some((name) => name.startsWith('config.json.corrupt.'))).toBe(
      true,
    )
    vi.mocked(renameSync).mockImplementation(realFs.renameSync)
    expect(loadConfig()).toEqual(example())
  })

  it('reports a missing primary with a corrupt backup instead of treating it as a new install', () => {
    saveConfig(example())
    unlinkSync(state.path)
    writeFileSync(backupPath(), '{}')
    expect(() => loadConfig()).toThrow('안전하게 복원')
    expect(raw(backupPath())).toBe('{}')
  })
})
