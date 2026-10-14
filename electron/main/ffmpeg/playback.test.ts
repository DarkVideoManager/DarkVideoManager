import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Command extends EventEmitter {
  target: string
  kill: ReturnType<typeof vi.fn>
  videoCodec: ReturnType<typeof vi.fn>
}
interface Probe {
  kill: ReturnType<typeof vi.fn>
  complete: (error: Error | null, stdout: string, stderr: string) => void
}
const state = vi.hoisted(() => ({
  root: '',
  autoStart: true,
  commands: [] as Command[],
  probes: [] as Probe[],
}))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../infra/config', () => ({ loadConfig: () => ({ libraries: [] }) }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn() {}, info() {}, error() {} }) }))
vi.mock('./ffmpegPath', () => ({
  getFfmpegPath: () => 'synthetic-ffmpeg',
  getFfprobePath: () => 'synthetic-ffprobe',
}))
vi.mock('fluent-ffmpeg', async () => {
  const { EventEmitter } = await import('node:events')
  const fs = await import('node:fs')
  const factory = () => {
    const command = Object.assign(new EventEmitter(), {
      target: '',
      kill: vi.fn(),
      format() {
        return this
      },
      outputOptions() {
        return this
      },
      videoCodec: vi.fn(function (this: Command) {
        return this
      }),
      audioCodec() {
        return this
      },
      output(filePath: string) {
        this.target = filePath
        return this
      },
      run() {
        if (state.autoStart) {
          fs.writeFileSync(this.target, 'partial output')
          command.emit('start')
        }
        return this
      },
    })
    state.commands.push(command)
    return command
  }
  return { default: Object.assign(factory, { setFfmpegPath() {}, setFfprobePath() {} }) }
})
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_path, _args, _options, callback) => {
    const probe = { kill: vi.fn(), complete: callback }
    state.probes.push(probe)
    return probe
  }),
}))

let playback: typeof import('./playback.js')
let cache: typeof import('../services/CacheService')
let outputDir: string
let source: string
let output: string
let temporary: string

beforeEach(async () => {
  vi.resetModules()
  state.root = fs.mkdtempSync(path.join(tmpdir(), 'dvm-proxy-shutdown-'))
  state.autoStart = true
  state.commands = []
  state.probes = []
  outputDir = path.join(state.root, 'playback-proxies', 'library')
  fs.mkdirSync(outputDir, { recursive: true })
  source = path.join(state.root, 'original.avi')
  output = path.join(outputDir, 'video.v3.mp4')
  temporary = output + '.tmp'
  fs.writeFileSync(source, 'original media')
  playback = await import('./playback.js')
  cache = await import('../services/CacheService')
})

afterEach(async () => {
  vi.useRealTimers()
  // Failed assertions must not leave a synthetic command pending forever.
  const drain = playback.drainPlaybackProxyWork()
  for (const command of state.commands) command.emit('end')
  for (const probe of state.probes) probe.complete(new Error('test cleanup'), '', '')
  await drain
  const fixture = path.resolve(state.root)
  if (
    path.dirname(fixture) !== path.resolve(tmpdir()) ||
    !path.basename(fixture).startsWith('dvm-proxy-shutdown-')
  ) {
    throw new Error('Unsafe test cleanup')
  }
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('codec-aware playback proxies', () => {
  it('derives progress from FFmpeg media timestamps and reports validation separately', async () => {
    const onProgress = vi.fn()
    const work = playback.ensurePlaybackProxy(source, outputDir, 'video', 'mpeg4', {
      durationSec: 200,
      onProgress,
    })
    state.commands[0].emit('progress', { timemark: '00:01:10.500', percent: 99 })
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'transcoding',
      durationSec: 200,
      processedSec: 70.5,
      progress: 35.25,
    })
    state.commands[0].emit('end')
    await vi.waitFor(() => expect(state.probes).toHaveLength(1))
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'validating', progress: 35.25 }),
    )
    state.probes[0].complete(
      null,
      JSON.stringify({
        format: { duration: 200 },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
      '',
    )
    await work
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'completed', progress: 100 }),
    )
  })

  it('uses an unknown percentage until FFmpeg reports a duration and cancels via the caller signal', async () => {
    const controller = new AbortController()
    const onProgress = vi.fn()
    const outcome = playback
      .ensurePlaybackProxy(source, outputDir, 'video', 'mpeg4', {
        signal: controller.signal,
        onProgress,
      })
      .catch((error: Error) => error)
    state.commands[0].emit('progress', { timemark: '00:00:20.000' })
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: null, processedSec: 20 }),
    )
    state.commands[0].emit('codecData', { duration: '00:01:40.000' })
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 20, durationSec: 100 }),
    )
    controller.abort()
    expect(state.commands[0].kill).toHaveBeenCalledWith('SIGTERM')
    state.commands[0].emit('error', new Error('terminated'))
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(fs.existsSync(temporary)).toBe(false)
  })

  it('inspects a ready cache without starting FFmpeg and drains its probe on shutdown', async () => {
    fs.writeFileSync(output, 'completed')
    const info = fs.statSync(source)
    fs.writeFileSync(
      output + '.source.json',
      JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs }),
    )
    const ready = playback.getCachedPlaybackProxy(source, outputDir, 'video')
    expect(state.commands).toHaveLength(0)
    state.probes[0].complete(
      null,
      JSON.stringify({
        format: { duration: 10 },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
      '',
    )
    expect(await ready).toBe(output)
    const checking = playback
      .getCachedPlaybackProxy(source, outputDir, 'video')
      .catch((error: Error) => error)
    const drain = playback.drainPlaybackProxyWork()
    expect(state.probes[1].kill).toHaveBeenCalledWith('SIGTERM')
    state.probes[1].complete(new Error('terminated'), '', '')
    await drain
    expect(await checking).toMatchObject({ name: 'AbortError' })
  })

  it.each([
    ['movie.mp4', 'mpeg4', true],
    ['movie.mp4', ' MPEG4 ', true],
    ['movie.mkv', 'wmv3', true],
    ['movie.AVI', 'h264', true],
    ['movie.mp4', 'h264', false],
    ['movie.mp4', 'hevc', false],
    ['movie.mp4', undefined, false],
    ['movie.mp4', 'unknown', false],
  ])('selects compatibility playback for %s with codec %s: %s', (filePath, codec, expected) => {
    expect(playback.needsPlaybackProxy(filePath, codec)).toBe(expected)
  })

  it('transcodes MPEG-4 Part 2 directly to H.264 without copying its incompatible video stream', async () => {
    const work = playback.ensurePlaybackProxy(source, outputDir, 'video', 'mpeg4')
    expect(state.commands).toHaveLength(1)
    expect(state.commands[0].videoCodec).toHaveBeenCalledWith('libx264')
    state.commands[0].emit('end')
    await vi.waitFor(() => expect(state.probes).toHaveLength(1))
    state.probes[0].complete(
      null,
      JSON.stringify({
        format: { duration: 10 },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
      '',
    )
    expect(await work).toBe(output)
    expect(state.commands).toHaveLength(1)
  })
})

describe('playback proxy shutdown', () => {
  it.each([undefined, 'mpeg4'])(
    'waits for FFmpeg termination and preserves source/prior output with codec %s',
    async (codec) => {
      fs.writeFileSync(output, 'previous committed proxy')
      fs.writeFileSync(output + '.source.json', 'old source fingerprint')
      const work = playback.ensurePlaybackProxy(source, outputDir, 'video', codec)
      expect(playback.ensurePlaybackProxy(source, outputDir, 'video')).toBe(work)
      const outcome = work.catch((error: Error) => error)
      expect(fs.existsSync(temporary)).toBe(true)
      expect((await cache.getCacheInfo()).protectedBytes).toBeGreaterThan(0)
      let drained = false
      const drain = playback.drainPlaybackProxyWork().then(() => {
        drained = true
      })
      expect(state.commands[0].kill).toHaveBeenCalledWith('SIGTERM')
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(fs.existsSync(temporary)).toBe(true)
      state.commands[0].emit('error', new Error('terminated'))
      await drain
      expect(await outcome).toMatchObject({ name: 'AbortError' })
      expect(state.commands).toHaveLength(1)
      expect(fs.existsSync(temporary)).toBe(false)
      expect(fs.readFileSync(output, 'utf8')).toBe('previous committed proxy')
      expect(fs.readFileSync(output + '.source.json', 'utf8')).toBe('old source fingerprint')
      expect(fs.readFileSync(source, 'utf8')).toBe('original media')
      expect((await cache.getCacheInfo()).protectedBytes).toBe(0)
      await expect(playback.ensurePlaybackProxy(source, outputDir, 'late')).rejects.toMatchObject({
        name: 'AbortError',
      })
    },
  )

  it('kills a command that starts after cancellation and still waits for its terminal event', async () => {
    vi.useFakeTimers()
    state.autoStart = false
    const outcome = playback
      .ensurePlaybackProxy(source, outputDir, 'video')
      .catch((error: Error) => error)
    let drained = false
    const drain = playback.drainPlaybackProxyWork().then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.commands[0].kill).toHaveBeenCalledWith('SIGKILL')
    fs.writeFileSync(temporary, 'late partial output')
    state.commands[0].emit('start')
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      state.commands[0].kill.mock.calls.filter(([signal]) => signal === 'SIGKILL'),
    ).toHaveLength(2)
    expect(drained).toBe(false)
    state.commands[0].emit('end')
    await drain
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(fs.existsSync(temporary)).toBe(false)
    expect(fs.existsSync(output)).toBe(false)
  })

  it('waits for a running ffprobe callback and avoids starting a transcode after cancellation', async () => {
    const outcome = playback
      .ensurePlaybackProxy(source, outputDir, 'video')
      .catch((error: Error) => error)
    state.commands[0].emit('end')
    await vi.waitFor(() => expect(state.probes).toHaveLength(1))
    let drained = false
    const drain = playback.drainPlaybackProxyWork().then(() => {
      drained = true
    })
    expect(state.probes[0].kill).toHaveBeenCalledWith('SIGTERM')
    await Promise.resolve()
    expect(drained).toBe(false)
    state.probes[0].complete(new Error('terminated'), '', '')
    await drain
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(state.commands).toHaveLength(1)
    expect(fs.existsSync(temporary)).toBe(false)
    expect((await cache.getCacheInfo()).protectedBytes).toBe(0)
  })

  it('cancels the fallback transcode without retrying or losing the original media', async () => {
    const outcome = playback
      .ensurePlaybackProxy(source, outputDir, 'video')
      .catch((error: Error) => error)
    state.commands[0].emit('error', new Error('unsupported copy codec'))
    await vi.waitFor(() => expect(state.commands).toHaveLength(2))
    const drain = playback.drainPlaybackProxyWork()
    expect(state.commands[1].kill).toHaveBeenCalledWith('SIGTERM')
    state.commands[1].emit('error', new Error('terminated'))
    await drain
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(state.commands).toHaveLength(2)
    expect(fs.existsSync(temporary)).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('original media')
  })

  it('leaves completed proxies intact when draining after a successful conversion', async () => {
    const work = playback.ensurePlaybackProxy(source, outputDir, 'video')
    state.commands[0].emit('end')
    await vi.waitFor(() => expect(state.probes).toHaveLength(1))
    state.probes[0].complete(
      null,
      JSON.stringify({
        format: { duration: 10 },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
      '',
    )
    expect(await work).toBe(output)
    await playback.drainPlaybackProxyWork()
    expect(fs.readFileSync(output, 'utf8')).toBe('partial output')
    expect(fs.existsSync(output + '.source.json')).toBe(true)
    expect(fs.existsSync(temporary)).toBe(false)
    expect((await cache.getCacheInfo()).protectedBytes).toBe(0)
  })
})
