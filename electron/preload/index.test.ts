import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, IPC_SCHEMAS, INVOKE_CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc'
import type { WindowApi } from './index'

const bridge = vi.hoisted(() => ({
  getPathForFile: vi.fn().mockReturnValue('C:/한글 영상.mp4'),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  webUtils: { getPathForFile: bridge.getPathForFile },
  contextBridge: { exposeInMainWorld: bridge.exposeInMainWorld },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.removeListener },
}))

let api: WindowApi
const originalIsolation = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

beforeEach(async () => {
  vi.resetModules()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('./index')
  api = bridge.exposeInMainWorld.mock.calls[0][1] as WindowApi
})

afterAll(() => {
  if (originalIsolation) Object.defineProperty(process, 'contextIsolated', originalIsolation)
  else Reflect.deleteProperty(process, 'contextIsolated')
})

describe('preload bridge', () => {
  it('accepts one native File path only and never accepts a supplied path or URL', async () => {
    bridge.invoke.mockClear()
    expect((await api.temporaryPlayback.openDroppedFiles([])).ok).toBe(false)
    expect((await api.temporaryPlayback.openDroppedFiles([{} as File, {} as File])).ok).toBe(false)
    bridge.getPathForFile.mockReturnValueOnce('')
    expect((await api.temporaryPlayback.openDroppedFiles([{} as File])).ok).toBe(false)
    bridge.getPathForFile.mockImplementationOnce(() => {
      throw new Error('not a File')
    })
    expect(
      (await api.temporaryPlayback.openDroppedFiles(['C:/video.mp4' as unknown as File])).ok,
    ).toBe(false)
    expect(bridge.invoke).not.toHaveBeenCalled()
  })
  it('exposes all deployed operations with arguments accepted by the main process contracts', async () => {
    bridge.invoke.mockClear()
    await Promise.all([
      api.temporaryPlayback.openDroppedFiles([{} as File]),
      api.temporaryPlayback.close('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.privacy.get(),
      api.privacy.save({
        maskThumbnails: false,
        revealOnHover: true,
        exitAction: 'close',
        exitUrl: '',
      }),
      api.privacy.exit(),
      api.discovery.query('lib', { text: '미시청', page: 1 }),
      api.discovery.favorite('lib', 'video', true),
      api.discovery.tags('lib', ['축구']),
      api.metadataImport.getSettings(),
      api.metadataImport.updateSettings({ enabled: false, serverUrl: '' }),
      api.metadataImport.search('example'),
      api.metadataImport.apply('lib', 'video', {
        expected: { title: null, memo: '', tags: '' },
        patch: { title: 'Example' },
      }),
      api.maintenance.previewNames('lib', { prefix: '[sample] ' }),
      api.maintenance.applyNames('lib', 'dd270470-14f8-45ed-af6e-f3b2da7c86d3', ['video']),
      api.maintenance.findDuplicates('lib'),
      api.maintenance.cancel('lib'),
      api.app.quit(),
      api.app.githubStar!.claimPrompt(),
      api.app.githubStar!.openRepository(),
      api.dataImport.selectCsv(),
      api.dataImport.preview('lib', 'history.csv'),
      api.app.getSettings(),
      api.app.updateSettings({ cacheLimitGb: 10 }),
      api.app.getCacheInfo(),
      api.app.getAccelerationInfo(),
      api.app.cleanCache(),
      api.app.getNativePlayers(),
      api.app.selectNativePlayer('mpv'),
      api.dataImport.importCsv('lib', 'history.csv', {
        importRatings: true,
        importFavoritesAsHighlights: true,
      }),
      api.library.list(),
      api.library.open('lib'),
      api.library.create('Videos', 'C:/videos'),
      api.library.close('lib'),
      api.library.delete('lib'),
      api.library.selectFolder(),
      api.library.importFolder('lib', 'C:/videos'),
      api.library.selectFiles(),
      api.library.importFiles('lib', ['C:/videos/one.mp4']),
      api.library.refresh('lib'),
      api.library.cancelWork('lib'),
      api.videos.search('lib', { sortBy: 'playCount' }),
      api.videos.metadataOptions('lib'),
      api.videos.get('lib', 'video'),
      api.videos.revealSource('lib', 'video'),
      api.videos.getPlaybackSource('lib', 'video'),
      api.videos.getNativePlayerInfo(),
      api.videos.openInNativePlayer('lib', 'video'),
      api.videos.seekActivePlayback('lib', 'video', 8),
      api.videos.updateMeta('lib', 'video', { tags: 'tag' }),
      api.videos.delete('lib', 'video'),
      api.videos.restore('lib', 'video'),
      api.playback.start('lib', 'video'),
      api.playback.listConversionQueue(),
      api.playback.pauseConversion('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.playback.resumeConversion('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.playback.removeConversion('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.playback.heartbeat('lib', 'video', 1),
      api.playback.seek('lib', 'video', 1.5),
      api.playback.end('lib', 'video', 2),
      api.thumbnails.getForVideo('lib', 'video'),
      api.thumbnails.listJobs('lib'),
      api.thumbnails.cancelForVideo('lib', 'video'),
      api.thumbnails.setPrimary('lib', 'thumb', 'video'),
      api.thumbnails.ensureForVideo('lib', 'video'),
      api.thumbnails.captureAtTime('lib', 'video', 8),
      api.thumbnails.saveImageCapture('lib', 'video', 8, 'data:image/png;base64,AAAA'),
      api.highlights.list('lib', 'video'),
      api.highlights.create('lib', { videoId: 'video', timeStart: 2 }),
      api.highlights.update('lib', 'highlight', { label: 'Favorite' }),
      api.highlights.delete('lib', 'highlight'),
      api.subtitles.getForVideo('lib', 'video'),
      api.subtitles.getEngineInfo(),
      api.subtitles.getSetupStatus(),
      api.subtitles.checkSetup(),
      api.subtitles.startSetup(),
      api.subtitles.cancelSetup(),
      api.subtitles.getTranslationSettings(),
      api.subtitles.updateTranslationSettings({
        enabled: true,
        apiKey: 'test-key',
        monthlyLimit: 500_000,
      }),
      api.subtitles.regenerate('lib', 'video', ['subtitle'], {
        model: 'base',
        language: 'auto',
        translateToKorean: true,
      }),
      api.subtitles.listQueue(),
      api.subtitles.pauseJob('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.subtitles.resumeJob('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.subtitles.removeJob('dd270470-14f8-45ed-af6e-f3b2da7c86d3'),
      api.subtitles.generate('lib', 'video', {
        model: 'base',
        language: 'auto',
        translateToKorean: true,
      }),
      api.subtitles.getGenerationStatus('lib', 'video'),
      api.subtitles.cancelGeneration('lib', 'video'),
      api.subtitles.convertToVtt('lib', 'captions.srt', 'srt'),
      api.subtitles.readText('lib', 'captions.vtt'),
      api.stats.get('lib'),
    ])
    expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('api', api)
    expect(bridge.invoke.mock.calls).toHaveLength(INVOKE_CHANNELS.length)
    expect(new Set(bridge.invoke.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(INVOKE_CHANNELS),
    )
    for (const [channel, ...args] of bridge.invoke.mock.calls) {
      expect(
        IPC_SCHEMAS[channel as keyof typeof IPC_SCHEMAS].safeParse(args).success,
        channel,
      ).toBe(true)
    }
    expect(bridge.invoke).toHaveBeenCalledWith(IPC.VIDEOS.REVEAL_SOURCE, 'lib', 'video')
    expect(bridge.invoke).toHaveBeenCalledWith(
      IPC.THUMBNAILS.ENSURE_FOR_VIDEO,
      'lib',
      'video',
      false,
    )
    expect(bridge.invoke).toHaveBeenCalledWith(
      IPC.THUMBNAILS.CAPTURE_AT_TIME,
      'lib',
      'video',
      8,
      true,
    )
  })

  it('forwards event payloads without exposing Electron events and unsubscribes the exact listeners', () => {
    const callback = vi.fn()
    const unsubscribers = [
      api.on.importProgress(callback),
      api.on.thumbnailReady(callback),
      api.on.highlightChanged(callback),
      api.on.nativePlayerEscape(callback),
      api.on.nativePlayerAction(callback),
    ]
    expect(new Set(bridge.on.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(EVENT_CHANNELS),
    )
    for (const [index, [channel, listener]] of bridge.on.mock.calls.entries()) {
      const payload = { videoId: 'video', action: 'setThumbnail', timeSec: 10 }
      listener({ sender: 'must stay private' }, payload)
      expect(callback).toHaveBeenLastCalledWith(payload)
      unsubscribers[index]()
      expect(bridge.removeListener).toHaveBeenCalledWith(channel, listener)
    }
  })
})
