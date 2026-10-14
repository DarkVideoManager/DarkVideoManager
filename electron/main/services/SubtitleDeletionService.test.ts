import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ trash: vi.fn() }))
vi.mock('electron', () => ({ shell: { trashItem: state.trash } }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))

import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { VideoRepository } from '../db/repositories/VideoRepository'
import {
  executeSubtitleDeletion,
  prepareSubtitleDeletion,
  SubtitleDeletionPlanZ,
  trashExternalSubtitles,
} from './SubtitleDeletionService'

let root: string
let directory: string
let db: ReturnType<typeof openDatabase>
let repository: SubtitleRepository
const videoId = 'movie'
const libraryId = 'subtitle-deletion-test'

function addVideo(id: string, name = id + '.mp4'): string {
  const filePath = join(directory, name)
  writeFileSync(filePath, 'video fixture')
  new VideoRepository(db).insert({
    id,
    fileName: name,
    filePath,
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
  return filePath
}

function addSubtitle(
  id: string,
  name: string,
  options: { owner?: string; embedded?: boolean; missing?: boolean } = {},
): string {
  const filePath = resolve(directory, name)
  if (!options.missing && !options.embedded)
    writeFileSync(filePath, '1\n00:00:00,000 --> 00:00:01,000\nsubtitle fixture\n')
  repository.insert({
    id,
    videoId: options.owner ?? videoId,
    filePath,
    type: 'srt',
    isEmbedded: options.embedded ?? false,
  })
  return filePath
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-subtitle-deletion-test-'))
  directory = join(root, 'media')
  mkdirSync(directory)
  db = openDatabase(libraryId, ':memory:')
  runMigrations(db, ':memory:')
  repository = new SubtitleRepository(db)
  addVideo(videoId)
  state.trash.mockReset().mockImplementation(async (filePath: string) => {
    if (!resolve(filePath).startsWith(resolve(root) + sep)) throw new Error('Unsafe test fixture')
    unlinkSync(filePath)
  })
})

afterEach(() => {
  closeAllDatabases()
  const target = resolve(root)
  if (
    target.startsWith(resolve(tmpdir()) + sep) &&
    basename(target).startsWith('dvm-subtitle-deletion-test-')
  )
    rmSync(target, { recursive: true, force: true })
})

describe('external subtitle deletion for regeneration', () => {
  it('trashes selected regular and generated subtitles while preserving the video and embedded tracks', async () => {
    const original = addSubtitle('original', 'movie.srt')
    const generated = addSubtitle('generated', 'movie.ai.srt')
    const korean = addSubtitle('korean', 'movie.ai.2.ko.srt')
    const unselected = addSubtitle('keep', 'movie.vtt')
    addSubtitle('embedded', 'movie.mp4', { embedded: true })
    expect(
      await trashExternalSubtitles(libraryId, videoId, ['original', 'generated', 'korean']),
    ).toEqual([original, generated, korean])
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([original, generated, korean])
    expect(
      repository
        .findByVideoId(videoId)
        .map((sub) => sub.id)
        .sort(),
    ).toEqual(['embedded', 'keep'])
    expect(existsSync(unselected)).toBe(true)
    expect(existsSync(join(directory, 'movie.mp4'))).toBe(true)
  })

  it.each([[], ['valid', 'valid'], ['valid', ''], ['valid', 'unknown']].map((ids) => ({ ids })))(
    'validates all IDs before moving any file (%j)',
    async ({ ids }) => {
      const filePath = addSubtitle('valid', 'movie.srt')
      await expect(trashExternalSubtitles(libraryId, videoId, ids)).rejects.toThrow()
      expect(state.trash).not.toHaveBeenCalled()
      expect(existsSync(filePath)).toBe(true)
    },
  )

  it('rejects embedded and other-video IDs before deleting valid selections', async () => {
    addSubtitle('valid', 'movie.srt')
    addSubtitle('embedded', 'movie.mp4', { embedded: true })
    addVideo('other')
    addSubtitle('other-sub', 'other.srt', { owner: 'other' })
    await expect(trashExternalSubtitles(libraryId, videoId, ['valid', 'embedded'])).rejects.toThrow(
      '내장 자막',
    )
    await expect(
      trashExternalSubtitles(libraryId, videoId, ['valid', 'other-sub']),
    ).rejects.toThrow('이 영상')
    expect(state.trash).not.toHaveBeenCalled()
  })

  it('rejects a neighboring video exact sidecar even when stale metadata claims ownership', async () => {
    addSubtitle('valid', 'movie.srt')
    addVideo('neighbor', 'movie.ai.ko.mp4')
    const neighbor = addSubtitle('stale', 'movie.ai.ko.srt')
    await expect(trashExternalSubtitles(libraryId, videoId, ['valid', 'stale'])).rejects.toThrow(
      '다른 영상',
    )
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(neighbor)).toBe(true)
  })

  it('rejects paths outside the video directory, unsupported extensions, and shared subtitle paths', async () => {
    addSubtitle('valid', 'movie.srt')
    addSubtitle('outside', '../movie.ai.srt')
    addSubtitle('unsupported', 'movie.txt')
    addVideo('other')
    addSubtitle('shared', 'movie.srt', { owner: 'other', missing: true })
    for (const id of ['outside', 'unsupported', 'valid']) {
      await expect(trashExternalSubtitles(libraryId, videoId, [id])).rejects.toThrow()
    }
    expect(state.trash).not.toHaveBeenCalled()
  })

  it('rejects directories and symbolic links before any deletion', async () => {
    addSubtitle('valid', 'movie.srt')
    const badDirectory = addSubtitle('directory', 'movie.ai.srt', { missing: true })
    mkdirSync(badDirectory)
    const targetDirectory = join(root, 'outside')
    mkdirSync(targetDirectory)
    const link = addSubtitle('symlink', 'movie.ai.ko.srt', { missing: true })
    symlinkSync(targetDirectory, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      trashExternalSubtitles(libraryId, videoId, ['valid', 'directory']),
    ).rejects.toThrow('일반 자막')
    await expect(trashExternalSubtitles(libraryId, videoId, ['valid', 'symlink'])).rejects.toThrow(
      '일반 자막',
    )
    expect(state.trash).not.toHaveBeenCalled()
  })

  it('rejects query-only libraries and removed videos without moving files', async () => {
    addSubtitle('valid', 'movie.srt')
    db.pragma('query_only = ON')
    await expect(trashExternalSubtitles(libraryId, videoId, ['valid'])).rejects.toThrow('읽기 전용')
    db.pragma('query_only = OFF')
    new VideoRepository(db).markRemoved(videoId, 'remove')
    await expect(trashExternalSubtitles(libraryId, videoId, ['valid'])).rejects.toThrow(
      '영상을 찾을 수 없습니다',
    )
    expect(state.trash).not.toHaveBeenCalled()
  })

  it('cleans selected missing subtitle metadata without invoking the recycle bin', async () => {
    const missing = addSubtitle('missing', 'movie.ai.ko.srt', { missing: true })
    const kept = addSubtitle('keep', 'movie.srt')
    expect(await trashExternalSubtitles(libraryId, videoId, ['missing'])).toEqual([missing])
    expect(state.trash).not.toHaveBeenCalled()
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['keep'])
    expect(existsSync(kept)).toBe(true)
  })

  it('commits each successful removal before reporting a later recycle-bin failure', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    state.trash
      .mockImplementationOnce(async () => unlinkSync(first))
      .mockRejectedValueOnce(new Error('permission denied'))
    await expect(trashExternalSubtitles(libraryId, videoId, ['first', 'second'])).rejects.toThrow(
      '1개 파일은 휴지통',
    )
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['second'])
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(true)
  })

  it('rechecks file identity after awaiting another move and preserves replacement files', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    state.trash.mockImplementationOnce(async () => {
      unlinkSync(first)
      writeFileSync(second, 'different replacement file')
    })
    await expect(trashExternalSubtitles(libraryId, videoId, ['first', 'second'])).rejects.toThrow(
      '파일이 변경',
    )
    expect(state.trash).toHaveBeenCalledTimes(1)
    expect(existsSync(second)).toBe(true)
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['second'])
  })

  it('does not delete a file created in place of an initially missing selection', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt', { missing: true })
    state.trash.mockImplementationOnce(async () => {
      unlinkSync(first)
      writeFileSync(second, 'new unrelated file')
    })
    await expect(trashExternalSubtitles(libraryId, videoId, ['first', 'second'])).rejects.toThrow(
      '파일이 변경',
    )
    expect(state.trash).toHaveBeenCalledTimes(1)
    expect(existsSync(second)).toBe(true)
  })

  it('respects cancellation before deletion and after an in-flight successful move', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    const before = new AbortController()
    before.abort()
    await expect(
      trashExternalSubtitles(libraryId, videoId, ['first'], before.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.trash).not.toHaveBeenCalled()
    const during = new AbortController()
    state.trash.mockImplementationOnce(async () => {
      unlinkSync(first)
      during.abort()
    })
    await expect(
      trashExternalSubtitles(libraryId, videoId, ['first', 'second'], during.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('1개 파일은 휴지통'),
    })
    expect(state.trash).toHaveBeenCalledTimes(1)
    expect(existsSync(second)).toBe(true)
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['second'])
  })

  it('captures a serializable plan at admission without changing files or metadata', () => {
    const filePath = addSubtitle('existing', 'movie.ai.srt')
    addSubtitle('missing', 'movie.ai.ko.srt', { missing: true })
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['existing', 'missing'])
    expect(plan.targets[0]).toMatchObject({
      id: 'existing',
      filePath,
      fingerprint: { size: expect.any(Number) },
    })
    expect(plan.targets[1].fingerprint).toBeNull()
    expect(SubtitleDeletionPlanZ.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
    expect(plan.completedIds).toEqual([])
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(filePath)).toBe(true)
    expect(repository.findByVideoId(videoId)).toHaveLength(2)
  })

  it('rejects files changed while queued before deleting any selected file', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['first', 'second'])
    writeFileSync(second, 'edited while the job was queued')
    await expect(executeSubtitleDeletion(libraryId, videoId, plan)).rejects.toThrow('파일이 변경')
    expect(state.trash).not.toHaveBeenCalled()
    expect(plan.completedIds).toEqual([])
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
  })

  it('resumes partial deletion without repeating completed paths or deleting replacement files', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['first', 'second'])
    const progress = vi.fn(() => {
      expect(plan.completedIds).toEqual(['first'])
      expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['second'])
    })
    state.trash
      .mockImplementationOnce(async () => unlinkSync(first))
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
    await expect(
      executeSubtitleDeletion(libraryId, videoId, plan, undefined, progress),
    ).rejects.toThrow('temporarily unavailable')
    expect(progress).toHaveBeenCalledTimes(1)
    const restored = SubtitleDeletionPlanZ.parse(JSON.parse(JSON.stringify(plan)))
    addSubtitle('replacement', 'movie.srt')
    state.trash.mockClear()
    await executeSubtitleDeletion(libraryId, videoId, restored)
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([second])
    expect(restored.completedIds).toEqual(['first', 'second'])
    expect(existsSync(first)).toBe(true)
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['replacement'])
  })

  it('recovers a completed move and DB cleanup when progress was not saved before interruption', async () => {
    const first = addSubtitle('first', 'movie.srt')
    const second = addSubtitle('second', 'movie.ai.srt')
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['first', 'second'])
    const savedBeforeProgress = SubtitleDeletionPlanZ.parse(JSON.parse(JSON.stringify(plan)))
    await expect(
      executeSubtitleDeletion(libraryId, videoId, plan, undefined, () => {
        throw new Error('queue journal unavailable')
      }),
    ).rejects.toThrow('queue journal unavailable')
    expect(existsSync(first)).toBe(false)
    expect(repository.findByVideoId(videoId).map((sub) => sub.id)).toEqual(['second'])
    expect(savedBeforeProgress.completedIds).toEqual([])
    await executeSubtitleDeletion(libraryId, videoId, savedBeforeProgress)
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([first, second])
    expect(savedBeforeProgress.completedIds).toEqual(['first', 'second'])
    expect(repository.findByVideoId(videoId)).toEqual([])
  })

  it('refuses an existing queued file after its DB identity disappears', async () => {
    const filePath = addSubtitle('existing', 'movie.srt')
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['existing'])
    repository.delete('existing')
    await expect(executeSubtitleDeletion(libraryId, videoId, plan)).rejects.toThrow('정보가 변경')
    expect(state.trash).not.toHaveBeenCalled()
    expect(existsSync(filePath)).toBe(true)
  })

  it('groups duplicate file paths into one move and atomically completes their selected IDs', async () => {
    const filePath = addSubtitle('first', 'movie.srt')
    addSubtitle('second', 'movie.srt', { missing: true })
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['first', 'second'])
    const progress = vi.fn()
    await executeSubtitleDeletion(libraryId, videoId, plan, undefined, progress)
    expect(state.trash.mock.calls.map(([path]) => path)).toEqual([filePath])
    expect(plan.completedIds).toEqual(['first', 'second'])
    expect(progress).toHaveBeenCalledTimes(1)
    expect(SubtitleDeletionPlanZ.safeParse(plan).success).toBe(true)
  })

  it('rejects malformed persisted plans before moving any file', async () => {
    addSubtitle('first', 'movie.srt')
    const plan = prepareSubtitleDeletion(libraryId, videoId, ['first'])
    const invalidPlans = [
      { ...plan, targets: [] },
      { ...plan, completedIds: ['unknown'] },
      { ...plan, completedIds: ['first', 'first'] },
      { ...plan, targets: [plan.targets[0], plan.targets[0]] },
      { ...plan, targets: [{ ...plan.targets[0], filePath: 'relative.srt' }] },
      {
        ...plan,
        targets: [
          { ...plan.targets[0], fingerprint: { ...plan.targets[0].fingerprint, size: -1 } },
        ],
      },
      {
        ...plan,
        targets: [...plan.targets, { ...plan.targets[0], id: 'second' }],
        completedIds: ['first'],
      },
    ]
    for (const invalid of invalidPlans) {
      expect(SubtitleDeletionPlanZ.safeParse(invalid).success).toBe(false)
      await expect(
        executeSubtitleDeletion(libraryId, videoId, invalid as typeof plan),
      ).rejects.toThrow()
    }
    expect(state.trash).not.toHaveBeenCalled()
  })
})
