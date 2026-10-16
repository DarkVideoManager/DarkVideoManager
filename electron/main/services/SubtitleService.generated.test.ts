import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import * as iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../ffmpeg/ffprobe', () => ({ probeVideo: vi.fn(async () => ({ durationSec: 10 })) }))
vi.mock('../ffmpeg/thumbnail', () => ({
  generateThumbnails: vi.fn(async (_file: string, output: string, id: string) => {
    const filePath = join(output, id + '.jpg')
    writeFileSync(filePath, 'frame')
    return [{ filePath, timeSec: 1 }]
  }),
}))

import { createLibrary, importFiles, importFolder, refreshLibrary } from './LibraryService'
import { convertSrtToVtt, syncSidecarSubtitlesForVideo } from './SubtitleService'
import { closeAllDatabases, getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'

let root: string
const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() },
} as unknown as Electron.BrowserWindow

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-generated-subtitles-test-'))
  state.userData = join(root, 'data')
  mkdirSync(state.userData)
})
afterEach(() => {
  closeAllDatabases()
  const target = resolve(root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !target.includes('dvm-generated-subtitles-test-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

function file(directory: string, name: string): string {
  const filePath = join(directory, name)
  writeFileSync(
    filePath,
    name.endsWith('.mp4') ? 'video fixture' : '1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n',
  )
  return filePath
}

async function fixture(names: string[]) {
  const directory = join(root, 'videos')
  mkdirSync(directory)
  for (const name of names) file(directory, name)
  const library = createLibrary('Subtitles', directory)
  await importFolder(library.id, directory, win)
  const db = getDatabase(library.id)!
  const videos = new VideoRepository(db)
  const subtitles = new SubtitleRepository(db)
  return { library, db, videos, subtitles, directory }
}

describe('sidecar subtitle discovery', () => {
  it('imports ordinary language and track suffixes without matching unrelated titles or folders', async () => {
    const { library, videos, subtitles, directory } = await fixture([
      'movie.mp4',
      'movie2.mp4',
      'movie.srt',
      'movie.ja.srt',
      'movie.ko.srt',
      'movie.EN-us.Forced.SRT',
      'movie.eng.sdh.srt',
      'movie.jpn.srt',
      'movie.cc.srt',
      'movie.zh-Hans.srt',
      'movie2.ko.srt',
      'movie.trailer.en.srt',
      'movie.other.srt',
      'movie.en.ko.srt',
      'movie.ai.other.srt',
    ])
    const unrelated = join(directory, 'unrelated')
    mkdirSync(unrelated)
    file(unrelated, 'movie.fr.srt')
    expect(await refreshLibrary(library.id, win)).toMatchObject({ skipped: 2, errors: [] })
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    expect(
      Object.fromEntries(
        subtitles.findByVideoId(video.id).map((track) => [basename(track.filePath), track.lang]),
      ),
    ).toEqual({
      'movie.cc.srt': undefined,
      'movie.EN-us.Forced.SRT': 'en',
      'movie.eng.sdh.srt': 'en',
      'movie.ja.srt': 'ja',
      'movie.jpn.srt': 'ja',
      'movie.ko.srt': 'ko',
      'movie.srt': undefined,
      'movie.zh-Hans.srt': 'zh',
    })
    const other = videos.findByPath(join(directory, 'movie2.mp4'))!
    expect(subtitles.findByVideoId(other.id)).toMatchObject([
      { filePath: join(directory, 'movie2.ko.srt'), lang: 'ko' },
    ])
  })

  it('gives exact and nearer video stems precedence over language and track suffixes', async () => {
    const { videos, subtitles, directory } = await fixture([
      'movie.mp4',
      'movie.en.mp4',
      'movie.en.forced.mp4',
      'movie.ko.mp4',
      'movie.en.srt',
      'movie.en.forced.srt',
      'movie.en.sdh.srt',
      'movie.ko.srt',
    ])
    const tracks = (name: string) =>
      subtitles.findByVideoId(videos.findByPath(join(directory, name + '.mp4'))!.id)
    expect(tracks('movie')).toEqual([])
    expect(tracks('movie.en').map((track) => basename(track.filePath))).toEqual([
      'movie.en.sdh.srt',
      'movie.en.srt',
    ])
    expect(tracks('movie.en.forced')).toMatchObject([
      { filePath: join(directory, 'movie.en.forced.srt'), lang: undefined },
    ])
    expect(tracks('movie.ko')).toMatchObject([
      { filePath: join(directory, 'movie.ko.srt'), lang: undefined },
    ])
  })

  it('discovers named sidecars during selected-file imports while leaving unselected videos alone', async () => {
    const { library, db, videos, subtitles } = await fixture([])
    const outside = join(root, 'selected')
    mkdirSync(outside)
    file(outside, 'movie.mp4')
    file(outside, 'movie.en.mp4')
    file(outside, 'movie.ko.srt')
    file(outside, 'movie.en.srt')
    const result = await importFiles(library.id, [join(outside, 'movie.mp4')], win)
    expect(result).toMatchObject({ added: 1, errors: [] })
    const video = videos.findByPath(join(outside, 'movie.mp4'))!
    expect(subtitles.findByVideoId(video.id)).toMatchObject([
      { filePath: join(outside, 'movie.ko.srt'), lang: 'ko' },
    ])
    expect(videos.findByPath(join(outside, 'movie.en.mp4'))).toBeNull()
    expect(syncSidecarSubtitlesForVideo(db, video.id, video.filePath)).toEqual(
      subtitles.findByVideoId(video.id),
    )
  })

  it('adds and removes ordinary sidecars on refresh while retaining unchanged tracks and source bytes', async () => {
    const { library, videos, subtitles, directory } = await fixture(['movie.mp4', 'movie.srt'])
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    const original = subtitles.findByVideoId(video.id)[0]
    const bytes = readFileSync(original.filePath)
    file(directory, 'movie.ko.srt')
    expect(await refreshLibrary(library.id, win)).toMatchObject({ skipped: 1, errors: [] })
    expect(subtitles.findByVideoId(video.id)).toHaveLength(2)
    expect(subtitles.findByVideoId(video.id)).toContainEqual(original)
    expect(readFileSync(original.filePath)).toEqual(bytes)
    unlinkSync(join(directory, 'movie.ko.srt'))
    expect(await refreshLibrary(library.id, win)).toMatchObject({ skipped: 1, errors: [] })
    expect(subtitles.findByVideoId(video.id)).toEqual([original])
  })

  it.runIf(process.platform === 'win32')(
    'matches Windows sidecar stems without case sensitivity',
    async () => {
      const { videos, subtitles, directory } = await fixture(['Movie.MP4', 'MOVIE.JA.SRT'])
      const video = videos.findByPath(join(directory, 'Movie.MP4'))!
      expect(subtitles.findByVideoId(video.id)).toMatchObject([
        { filePath: join(directory, 'MOVIE.JA.SRT'), lang: 'ja' },
      ])
    },
  )

  it.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'cp949'])(
    'converts an existing %s SRT in cache without modifying it',
    async (encoding) => {
      const { db, videos, subtitles, directory } = await fixture(['movie.mp4'])
      const text =
        '1\r\n00:00:01,000 --> 00:00:03,000\r\n안녕하세요. 기존 자막을 다시 만들지 않고 그대로 불러옵니다. 한국어 자막의 인코딩을 확인합니다.\r\n'
      const filePath = join(directory, 'movie.ko.SRT')
      const bytes = iconv.encode(text, encoding === 'utf8-bom' ? 'utf8' : encoding, {
        addBOM: encoding.startsWith('utf16') || encoding === 'utf8-bom',
      })
      writeFileSync(filePath, bytes)
      const video = videos.findByPath(join(directory, 'movie.mp4'))!
      const tracks = syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
      expect(tracks).toMatchObject([{ filePath, type: 'srt', lang: 'ko' }])
      expect(subtitles.findByVideoId(video.id)).toEqual(tracks)
      const output = convertSrtToVtt(filePath, join(root, 'cache'))
      expect(readFileSync(output, 'utf8')).toBe('WEBVTT\n\n' + text.replaceAll(',000', '.000'))
      expect(readFileSync(filePath)).toEqual(bytes)
    },
  )

  it('discovers exact sidecars and numbered original/Korean pairs without neighboring files', async () => {
    const { db, videos, subtitles, directory } = await fixture([
      'movie.mp4',
      'movie2.mp4',
      'movie.srt',
      'movie.ai.srt',
      'movie.ai.ko.srt',
      'movie.ai.2.srt',
      'movie.ai.2.ko.srt',
      'movie2.ai.ko.srt',
      'movie.trailer.ai.ko.srt',
      'movie.ai.other.srt',
    ])
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    const imported = subtitles.findByVideoId(video.id)
    const result = syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
    expect(result).toHaveLength(imported.length)
    for (const saved of imported) expect(result).toContainEqual(saved)
    expect(result.map((subtitle) => basename(subtitle.filePath)).sort()).toEqual([
      'movie.ai.2.ko.srt',
      'movie.ai.2.srt',
      'movie.ai.ko.srt',
      'movie.ai.srt',
      'movie.srt',
    ])
    expect(result.filter((subtitle) => subtitle.lang === 'ko')).toHaveLength(2)
    expect(
      result.find((subtitle) => subtitle.filePath.endsWith('movie.ai.srt'))?.lang,
    ).toBeUndefined()
  })

  it('gives exact stems precedence for videos whose names contain generation/language suffixes', async () => {
    const { db, videos, directory } = await fixture([
      'movie.mp4',
      'movie.ai.mp4',
      'movie.ai.ko.mp4',
      'movie.ai.2.mp4',
      'movie.ai.2.ko.mp4',
      'movie.ai.srt',
      'movie.ai.ko.srt',
      'movie.ai.2.srt',
      'movie.ai.2.ko.srt',
      'movie.ai.ai.srt',
      'movie.ai.ai.ko.srt',
      'movie.ai.ko.ai.ko.srt',
    ])
    const discover = (name: string) => {
      const video = videos.findByPath(join(directory, name + '.mp4'))!
      return syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
    }
    expect(discover('movie')).toEqual([])
    expect(
      discover('movie.ai')
        .map((subtitle) => basename(subtitle.filePath))
        .sort(),
    ).toEqual(['movie.ai.ai.ko.srt', 'movie.ai.ai.srt', 'movie.ai.srt'])
    expect(
      discover('movie.ai.ko')
        .map((subtitle) => basename(subtitle.filePath))
        .sort(),
    ).toEqual(['movie.ai.ko.ai.ko.srt', 'movie.ai.ko.srt'])
    expect(discover('movie.ai.2')).toMatchObject([
      { filePath: join(directory, 'movie.ai.2.srt'), lang: undefined },
    ])
    expect(discover('movie.ai.2.ko')).toMatchObject([
      { filePath: join(directory, 'movie.ai.2.ko.srt'), lang: undefined },
    ])
  })

  it('preserves IDs, detected languages, encoding and embedded tracks across queries and refresh', async () => {
    const { library, db, videos, subtitles, directory } = await fixture([
      'movie.mp4',
      'movie.srt',
      'movie.ai.srt',
      'movie.ai.ko.srt',
    ])
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    const initial = subtitles.findByVideoId(video.id)
    const original = initial.find((subtitle) => subtitle.filePath.endsWith('movie.ai.srt'))!
    subtitles.insert({ ...original, lang: 'ja', encoding: 'utf-8' })
    subtitles.insert({
      id: 'embedded',
      videoId: video.id,
      filePath: video.filePath,
      type: 'srt',
      lang: 'en',
      trackIndex: 2,
      isEmbedded: true,
    })
    const before = subtitles.findByVideoId(video.id)
    syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
    expect(subtitles.findByVideoId(video.id)).toEqual(before)
    file(directory, 'movie.ai.2.srt')
    file(directory, 'movie.ai.2.ko.srt')
    expect(await refreshLibrary(library.id, win)).toMatchObject({ errors: [], skipped: 1 })
    const refreshed = subtitles.findByVideoId(video.id)
    expect(refreshed).toHaveLength(6)
    for (const saved of before) expect(refreshed).toContainEqual(saved)
    expect(
      refreshed.find((subtitle) => subtitle.filePath.endsWith('movie.ai.2.ko.srt'))?.lang,
    ).toBe('ko')
    syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
    expect(subtitles.findByVideoId(video.id)).toEqual(refreshed)
    unlinkSync(join(directory, 'movie.ai.2.srt'))
    syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
    expect(subtitles.findByVideoId(video.id)).toHaveLength(5)
    expect(subtitles.findByVideoId(video.id)).toContainEqual(
      before.find((subtitle) => subtitle.id === 'embedded'),
    )
  })

  it('keeps the existing snapshot when the directory is disconnected', async () => {
    const { db, videos, subtitles, directory } = await fixture(['movie.mp4', 'movie.ai.ko.srt'])
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    const before = subtitles.findByVideoId(video.id)
    renameSync(directory, join(root, 'offline-videos'))
    expect(() => syncSidecarSubtitlesForVideo(db, video.id, video.filePath)).toThrow()
    expect(subtitles.findByVideoId(video.id)).toEqual(before)
  })

  it('returns stored tracks without attempting mutation in a read-only database', async () => {
    const { library, videos, subtitles, directory } = await fixture([
      'movie.mp4',
      'movie.ai.ko.srt',
    ])
    const video = videos.findByPath(join(directory, 'movie.mp4'))!
    const before = subtitles.findByVideoId(video.id)
    const readOnly = new Database(library.dbPath, { readonly: true })
    try {
      file(directory, 'movie.ai.2.ko.srt')
      expect(syncSidecarSubtitlesForVideo(readOnly, video.id, video.filePath)).toEqual(before)
      expect(new SubtitleRepository(readOnly).findByVideoId(video.id)).toEqual(before)
    } finally {
      readOnly.close()
    }
  })
})
