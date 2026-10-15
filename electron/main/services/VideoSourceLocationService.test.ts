import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  libraries: [] as { id: string; dbPath: string }[],
  getDatabase: vi.fn(),
  openDatabase: vi.fn(),
  runMigrations: vi.fn(),
  findById: vi.fn(),
  showItemInFolder: vi.fn(),
  repositoryDatabases: [] as unknown[],
  inaccessiblePath: undefined as string | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (path: string) => {
      if (path === state.inaccessiblePath)
        throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
      return actual.stat(path)
    },
  }
})
vi.mock('electron', () => ({ shell: { showItemInFolder: state.showItemInFolder } }))
vi.mock('../infra/config', () => ({ loadConfig: () => ({ libraries: state.libraries }) }))
vi.mock('../db/connection', () => ({
  getDatabase: state.getDatabase,
  openDatabase: state.openDatabase,
}))
vi.mock('../db/migrator', () => ({ runMigrations: state.runMigrations }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    constructor(db: unknown) {
      state.repositoryDatabases.push(db)
    }
    findById = state.findById
  },
}))

import { revealVideoSource } from './VideoSourceLocationService'

let directory: string
let filePath: string
let dbPath: string
const db = { name: 'selected-library-db' }

beforeEach(async () => {
  vi.resetAllMocks()
  state.repositoryDatabases = []
  state.inaccessiblePath = undefined
  directory = await mkdtemp(join(tmpdir(), 'dvm-source-location-test-'))
  filePath = join(directory, 'original video.mkv')
  dbPath = join(directory, 'library.db')
  await writeFile(filePath, 'test video fixture')
  await writeFile(dbPath, 'registered database fixture')
  state.libraries = [{ id: 'selected-library', dbPath }]
  state.getDatabase.mockReturnValue(db)
  state.openDatabase.mockReturnValue(db)
  state.findById.mockReturnValue({ id: 'selected-video', filePath })
})

afterEach(async () => {
  const target = resolve(directory)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('dvm-source-location-test-')
  )
    throw new Error('Unsafe cleanup path')
  await rm(target, { recursive: true, force: true })
})

describe('original video location', () => {
  it('validates the canonical original file and reveals its registered location', async () => {
    await mkdir(join(directory, 'subtitles'))
    const registeredPath = `${directory}${sep}subtitles${sep}..${sep}original video.mkv`
    state.findById.mockReturnValue({
      id: 'selected-video',
      filePath: registeredPath,
    })
    await revealVideoSource('selected-library', 'selected-video')
    expect(state.getDatabase).toHaveBeenCalledWith('selected-library')
    expect(state.repositoryDatabases).toEqual([db])
    expect(state.findById).toHaveBeenCalledWith('selected-video')
    expect(state.showItemInFolder).toHaveBeenCalledExactlyOnceWith(registeredPath)
    expect(state.openDatabase).not.toHaveBeenCalled()
  })

  it('preserves a registered junction location instead of switching to its target folder', async () => {
    const sourceFolder = join(directory, 'source')
    const linkedFolder = join(directory, 'imported-location')
    await mkdir(sourceFolder)
    await writeFile(join(sourceFolder, 'original.mp4'), 'test video fixture')
    await symlink(sourceFolder, linkedFolder, 'junction')
    const registeredPath = join(linkedFolder, 'original.mp4')
    state.findById.mockReturnValue({ filePath: registeredPath })
    await revealVideoSource('selected-library', 'selected-video')
    expect(state.showItemInFolder).toHaveBeenCalledExactlyOnceWith(registeredPath)
  })

  it('reopens a restored job library from its registered database without choosing an active library', async () => {
    state.getDatabase.mockReturnValue(null)
    await revealVideoSource('selected-library', 'selected-video')
    expect(state.openDatabase).toHaveBeenCalledWith('selected-library', dbPath, {
      fileMustExist: true,
    })
    expect(state.runMigrations).toHaveBeenCalledWith(db, dbPath)
    expect(state.showItemInFolder).toHaveBeenCalledExactlyOnceWith(filePath)
  })

  it('rejects a deleted or unknown library before opening any database or folder', async () => {
    await expect(revealVideoSource('unknown-library', 'selected-video')).rejects.toThrow(
      '라이브러리를 찾을 수 없습니다',
    )
    expect(state.getDatabase).not.toHaveBeenCalled()
    expect(state.openDatabase).not.toHaveBeenCalled()
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })

  it('does not create a replacement database when a restored library database is missing', async () => {
    state.getDatabase.mockReturnValue(null)
    await rm(dbPath)
    await expect(revealVideoSource('selected-library', 'selected-video')).rejects.toThrow(
      '라이브러리 파일에 접근할 수 없습니다',
    )
    expect(state.openDatabase).not.toHaveBeenCalled()
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })

  it('rejects a missing video record without exposing a different video location', async () => {
    state.findById.mockReturnValue(null)
    await expect(revealVideoSource('selected-library', 'missing-video')).rejects.toThrow(
      '원본 영상을 찾을 수 없습니다',
    )
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(['missing', 'directory', 'relative'])(
    'rejects a %s original path instead of opening its parent folder',
    async (kind) => {
      const invalidPath =
        kind === 'missing'
          ? join(directory, 'deleted.mp4')
          : kind === 'directory'
            ? directory
            : 'relative-video.mp4'
      state.findById.mockReturnValue({ filePath: invalidPath })
      await expect(revealVideoSource('selected-library', 'selected-video')).rejects.toThrow(
        /원본 영상/,
      )
      expect(state.showItemInFolder).not.toHaveBeenCalled()
    },
  )

  it('reports a trashed original as missing and does not open another file location', async () => {
    state.findById.mockReturnValue({ filePath, removalMode: 'trash' })
    await rm(filePath)
    await expect(revealVideoSource('selected-library', 'selected-video')).rejects.toThrow(
      '파일 이동·삭제 또는 드라이브 연결 상태',
    )
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })

  it('can locate an existing original that was only removed from the library list', async () => {
    state.findById.mockReturnValue({ filePath, removalMode: 'remove' })
    await revealVideoSource('selected-library', 'selected-video')
    expect(state.showItemInFolder).toHaveBeenCalledExactlyOnceWith(filePath)
  })

  it('reports an inaccessible original without asking the shell to open its folder', async () => {
    state.inaccessiblePath = await realpath(filePath)
    await expect(revealVideoSource('selected-library', 'selected-video')).rejects.toThrow(
      '원본 영상 파일을 찾거나 읽을 수 없습니다',
    )
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })

  it('propagates an operating system shell failure for the row to show', async () => {
    state.showItemInFolder.mockImplementation(() => {
      throw new Error('파일 탐색기를 시작할 수 없습니다.')
    })
    await expect(revealVideoSource('selected-library', 'selected-video')).rejects.toThrow(
      '파일 탐색기를 시작할 수 없습니다.',
    )
  })
})
