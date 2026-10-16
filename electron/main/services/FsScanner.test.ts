import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { FsScanner, isDriveMetadataDirectory } from './FsScanner'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-scanner-test-'))
})
afterEach(() => {
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-scanner-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

it('allows the event loop to run during traversal and gathers sidecars in the same pass', async () => {
  for (let index = 0; index < 300; index++) writeFileSync(join(root, index + '.mp4'), '')
  writeFileSync(join(root, '0.srt'), 'subtitle')
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, '.hidden', 'hidden.mp4'), '')
  const sidecars: string[] = []
  let completed = false
  const work = new FsScanner()
    .scan(root, {
      onFile: (file) => {
        if (file.endsWith('.srt')) sidecars.push(file)
      },
    })
    .then((files) => {
      completed = true
      return files
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(completed).toBe(false)
  expect(await work).toHaveLength(300)
  expect(sidecars).toEqual([join(root, '0.srt')])
})

it('stops a requested scan promptly rather than returning a partial success snapshot', async () => {
  for (let index = 0; index < 150; index++) writeFileSync(join(root, index + '.mp4'), '')
  const controller = new AbortController()
  let visited = 0
  const work = new FsScanner().scan(root, {
    signal: controller.signal,
    onFile: () => {
      if (++visited === 10) controller.abort()
    },
  })
  await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  expect(visited).toBe(10)
})

it('propagates missing directory errors instead of treating the directory as empty', async () => {
  await expect(new FsScanner().scan(join(root, 'offline'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('only excludes Windows metadata directories at a selected drive root', () => {
  const drive = parse(resolve(root)).root
  expect(isDriveMetadataDirectory(drive, drive, '$RECYCLE.BIN')).toBe(process.platform === 'win32')
  expect(isDriveMetadataDirectory(drive, drive, 'System Volume Information')).toBe(
    process.platform === 'win32',
  )
  expect(isDriveMetadataDirectory(root, root, '$RECYCLE.BIN')).toBe(false)
  expect(isDriveMetadataDirectory(drive, root, 'System Volume Information')).toBe(false)
  expect(isDriveMetadataDirectory(drive, drive, 'Videos')).toBe(false)
  expect(
    isDriveMetadataDirectory('\\\\server\\share\\', '\\\\server\\share\\', '$RECYCLE.BIN'),
  ).toBe(false)
})
