import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  codec: undefined as string | undefined,
  ensureProxy: vi.fn(),
  pin: Object.assign(vi.fn(), { rollback: vi.fn() }),
}))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../infra/paths', () => ({ getPlaybackProxyDir: () => 'proxy-directory' }))
vi.mock('../db/connection', () => ({ getDatabase: () => ({}) }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById(id: string) {
      return { id, filePath: 'movie.mp4', codec: state.codec }
    }
  },
}))
vi.mock('../ffmpeg/playback.js', async () => {
  const { needsCompatiblePlayback } = await import('@shared/playback')
  return { needsPlaybackProxy: needsCompatiblePlayback, ensurePlaybackProxy: state.ensureProxy }
})
vi.mock('./PlaybackConversionService', () => ({ enqueuePlaybackConversion: state.ensureProxy }))
vi.mock('./NativePlayerService', () => ({ findNativePlayer: vi.fn(), openInNativePlayer: vi.fn() }))
vi.mock('./MpvSessionService.js', () => ({ openInMpv: vi.fn(), seekMpvSession: vi.fn() }))
vi.mock('./PlaybackService', () => ({ endPlayback: vi.fn() }))
vi.mock('./CacheService', () => ({
  beginPlaybackCacheLease: () => state.pin,
  purgeVideoPlaybackCache: vi.fn(),
  trimPlaybackCache: vi.fn().mockResolvedValue(undefined),
}))

import { getPlaybackSource } from './VideoService'

beforeEach(() => {
  vi.clearAllMocks()
  state.codec = undefined
  state.ensureProxy.mockResolvedValue('proxy-directory/video.v3.mp4')
})

describe('playback source selection', () => {
  it('uses a compatible proxy for an MP4 containing MPEG-4 Part 2 video', async () => {
    state.codec = 'mpeg4'
    expect(await getPlaybackSource('library', 'video')).toBe('proxy-directory/video.v3.mp4')
    expect(state.ensureProxy).toHaveBeenCalledWith('library', {
      id: 'video',
      filePath: 'movie.mp4',
      codec: 'mpeg4',
    })
    expect(state.pin).toHaveBeenCalledWith('proxy-directory/video.v3.mp4')
  })

  it.each(['h264', undefined, 'unknown'])(
    'keeps direct MP4 playback with codec %s',
    async (codec) => {
      state.codec = codec
      expect(await getPlaybackSource('library', 'video')).toBe('movie.mp4')
      expect(state.ensureProxy).not.toHaveBeenCalled()
      expect(state.pin).not.toHaveBeenCalled()
    },
  )
})
