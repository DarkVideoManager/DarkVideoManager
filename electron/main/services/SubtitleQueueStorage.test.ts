import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ locks: 0, attempts: 0, code: 'EPERM', cleanupLocked: false }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (source: string, target: string) => {
      fault.attempts++
      if (fault.locks !== 0) {
        if (fault.locks > 0) fault.locks--
        throw Object.assign(new Error('Injected file lock'), { code: fault.code })
      }
      fs.renameSync(source, target)
    },
    unlinkSync: (file: string) => {
      if (fault.cleanupLocked)
        throw Object.assign(new Error('Injected cleanup lock'), { code: 'EBUSY' })
      fs.unlinkSync(file)
    },
  }
})
import { SubtitleQueueStorageError, writeSubtitleQueueSnapshot } from './SubtitleQueueStorage'

describe('durable subtitle queue replacement', () => {
  let directory: string
  let file: string
  const prior = '{"version":1,"entries":["prior durable queue"]}'
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dvm-queue-storage-'))
    file = join(directory, 'subtitle-queue.json')
    writeFileSync(file, prior)
    Object.assign(fault, { locks: 0, attempts: 0, code: 'EPERM', cleanupLocked: false })
  })
  afterEach(() => rmSync(directory, { force: true, recursive: true }))

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'recovers a transient %s lock without deleting the previous queue',
    (code) => {
      fault.locks = 2
      fault.code = code
      writeSubtitleQueueSnapshot(file, { version: 1, entries: ['next'] })
      expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual(['next'])
      expect(fault.attempts).toBe(3)
      expect(readdirSync(directory)).toEqual(['subtitle-queue.json'])
    },
  )

  it('bounds a persistent lock, preserves the exact durable bytes, and reports a cleanup lock as storage failure', () => {
    fault.locks = -1
    fault.cleanupLocked = true
    expect(() => writeSubtitleQueueSnapshot(file, { entries: ['unsaved'] })).toThrow(
      SubtitleQueueStorageError,
    )
    expect(readFileSync(file, 'utf8')).toBe(prior)
    expect(fault.attempts).toBe(4)
    expect(readdirSync(directory)).toHaveLength(2)
    fault.cleanupLocked = false
    fault.locks = 0
    writeSubtitleQueueSnapshot(file, { entries: ['recovered'] })
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual(['recovered'])
  })

  it('does not repeatedly retry a non-transient filesystem error', () => {
    fault.locks = -1
    fault.code = 'EISDIR'
    expect(() => writeSubtitleQueueSnapshot(file, {})).toThrow('EISDIR')
    expect(readFileSync(file, 'utf8')).toBe(prior)
    expect(fault.attempts).toBe(1)
    expect(readdirSync(directory)).toEqual(['subtitle-queue.json'])
  })
})
