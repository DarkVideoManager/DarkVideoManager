import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { getFfmpegPath } from './ffmpegPath'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => temporaryDirectory },
}))

import { probeVideo } from './ffprobe'
import { generateThumbnails } from './thumbnail'
import { ensurePlaybackProxy } from './playback.js'

const execFileAsync = promisify(execFile)
let temporaryDirectory: string
let fixturePath: string
let ffmpegPath: string

beforeAll(async () => {
  ffmpegPath = getFfmpegPath()
  temporaryDirectory = mkdtempSync(`${tmpdir()}/dark-video-manager-ffmpeg-`)
  fixturePath = `${temporaryDirectory}/sample.mp4`
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=10:d=2',
    '-pix_fmt',
    'yuv420p',
    fixturePath,
  ])
}, 30_000)

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe('FFmpeg pipeline', () => {
  it('normalizes ffprobe metadata', async () => {
    const metadata = await probeVideo(fixturePath)

    expect(metadata).toMatchObject({ width: 320, height: 180, codec: 'h264', container: 'mov' })
    expect(metadata.durationSec).toBeCloseTo(2, 1)
    expect(metadata.fps).toBeCloseTo(10, 1)
  }, 30_000)

  it('transcodes browser-incompatible AVI video and shares simultaneous proxy requests', async () => {
    const aviPath = temporaryDirectory + '/legacy.avi'
    const outputDirectory = temporaryDirectory + '/playback-proxies/library'
    mkdirSync(outputDirectory, { recursive: true })
    await execFileAsync(ffmpegPath!, ['-y', '-i', fixturePath, '-c:v', 'mpeg4', '-an', aviPath])
    const first = ensurePlaybackProxy(aviPath, outputDirectory, 'legacy')
    const second = ensurePlaybackProxy(aviPath, outputDirectory, 'legacy')
    expect(first).toBe(second)
    const [firstPath, secondPath] = await Promise.all([first, second])
    expect(firstPath).toBe(secondPath)
    expect((await probeVideo(firstPath)).codec).toBe('h264')
    expect(await ensurePlaybackProxy(aviPath, outputDirectory, 'legacy')).toBe(firstPath)
  }, 30_000)

  it('generates five percentage thumbnails and reports progress', async () => {
    const outputDirectory = `${temporaryDirectory}/thumbs`
    const progress: Array<[number, number]> = []
    const results = await generateThumbnails(
      fixturePath,
      outputDirectory,
      'video-1',
      2,
      undefined,
      (completed, total) => {
        progress.push([completed, total])
      },
    )

    expect(results).toHaveLength(5)
    expect(readdirSync(outputDirectory).sort()).toEqual([
      'video-1_0.jpg',
      'video-1_1.jpg',
      'video-1_2.jpg',
      'video-1_3.jpg',
      'video-1_4.jpg',
    ])
    expect(progress).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ])
  }, 30_000)

  it('decodes AV1 in software and generates five thumbnails with the shipped runtime', async () => {
    // Original synthetic 64x64 blue clip: libaom-av1, 5 fps, 2 seconds, IVF.
    // Embedded so CI does not need an AV1 encoder or a downloaded video fixture.
    const av1 = Buffer.from(
      'REtJRgAAIABBVjAxQABAAAUAAAABAAAACgAAAAAAAAAjAAAAAAAAAAAAAAASAAoKAAAAAq//m18gCDITEADaAAACgAAACgV4m4M6ijI1gE0AAAABAAAAAAAAABIAMhEgCeBAAAADbQAAAUAAEACZEDIRKATggAAgA20AAAFAADgAnMAyECgCgQAAQINtAAABQAA4AJwyETADxAAA0QbaAAACgABwAJzABQAAAAIAAAAAAAAAEgAaAbgUAAAAAwAAAAAAAAASADIQMAZIDgCBBtoAAAKAAHAAnAUAAAAEAAAAAAAAABIAGgGoJgAAAAUAAAAAAAAAEgAyECgGSAVYgINtAAABQAA4AJgyEDAKYAqxoQbaAAACgABwAJgFAAAABgAAAAAAAAASABoB6BQAAAAHAAAAAAAAABIAMhAwDkQboVkG2gAAAoAAcACYFAAAAAgAAAAAAAAAEgAyEDAQAhNwqQbaAAACgABwAJAVAAAACQAAAAAAAAASADIRMBIADmHRBtoAAAKAACAAq3A=',
      'base64',
    )
    const av1Path = `${temporaryDirectory}/synthetic-av1.ivf`
    writeFileSync(av1Path, av1)
    const results = await generateThumbnails(av1Path, `${temporaryDirectory}/av1`, 'av1', 2)
    expect(results).toHaveLength(5)
    expect(await probeVideo(results[0].filePath)).toMatchObject({
      codec: 'mjpeg',
      width: 480,
      height: 480,
    })
  }, 30_000)
})
