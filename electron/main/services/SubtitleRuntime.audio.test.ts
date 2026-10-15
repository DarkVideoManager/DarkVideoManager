import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { extractSubtitleAudio } from './SubtitleRuntime'
import { getFfmpegPath } from '../ffmpeg/ffmpegPath'

function syntheticWave(rate: number): Buffer {
  const samples = rate * 12
  const wave = Buffer.alloc(44 + samples * 2)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(rate, 24)
  wave.writeUInt32LE(rate * 2, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(samples * 2, 40)
  let noise = 123456789
  for (let sample = 0; sample < samples; sample++) {
    const time = sample / rate
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
    // A generated, quiet speech-band signal with no clipping or private media.
    const value =
      0.14 * Math.sin(2 * Math.PI * 233 * time) +
      0.07 * Math.sin(2 * Math.PI * 741 * time) +
      0.03 * Math.sin(2 * Math.PI * 1703 * time) +
      0.02 * (noise / 0x100000000 - 0.5)
    wave.writeInt16LE(Math.round(value * 32767), 44 + sample * 2)
  }
  return wave
}

function readPcm(wave: Buffer): { rate: number; samples: number[] } {
  expect(wave.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wave.toString('ascii', 8, 12)).toBe('WAVE')
  let rate = 0
  for (let offset = 12; offset + 8 <= wave.length;) {
    const chunk = wave.toString('ascii', offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4)
    if (chunk === 'fmt ') {
      expect(wave.readUInt16LE(offset + 8)).toBe(1)
      expect(wave.readUInt16LE(offset + 10)).toBe(1)
      expect(wave.readUInt16LE(offset + 22)).toBe(16)
      rate = wave.readUInt32LE(offset + 12)
    }
    if (chunk === 'data') {
      const samples = []
      for (let index = offset + 8; index < offset + 8 + size; index += 2)
        samples.push(wave.readInt16LE(index))
      return { rate, samples }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('No PCM audio samples found')
}

describe('real subtitle audio extraction', () => {
  let directory: string | undefined
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  it.each([16000, 48000])(
    'preserves quiet speech-band audio throughout a %i Hz source',
    async (rate) => {
      directory = mkdtempSync(join(tmpdir(), 'dvm-subtitle-signal-'))
      const wave = join(directory, 'synthetic.wav')
      const source = join(directory, 'synthetic.m4a')
      const output = join(directory, 'extracted.wav')
      writeFileSync(wave, syntheticWave(rate))
      // AAC decodes to floating-point samples, as ordinary MP4 audio does.
      // Integer PCM input alone cannot expose the unstable filter calculation.
      await promisify(execFile)(
        getFfmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', wave, '-c:a', 'aac', source],
        { windowsHide: true },
      )
      await extractSubtitleAudio(source, output, 12, new AbortController().signal, vi.fn())
      const extracted = readPcm(readFileSync(output))
      expect(extracted.rate).toBe(16000)
      expect(extracted.samples.length / extracted.rate).toBeCloseTo(12, 2)
      // Every second must retain the same quiet signal. A low-pass exactly at
      // the 16 kHz source's Nyquist frequency used to amplify and clip its tail.
      for (let second = 0; second < 12; second++) {
        const window = extracted.samples.slice(second * 16000, (second + 1) * 16000)
        const rms = Math.sqrt(window.reduce((sum, sample) => sum + sample ** 2, 0) / window.length)
        expect(rms, `RMS at second ${second}`).toBeGreaterThan(3000)
        expect(rms, `RMS at second ${second}`).toBeLessThan(4200)
        expect(
          window.every((sample) => Math.abs(sample) < 30000),
          `Quiet signal peak at second ${second}`,
        ).toBe(true)
      }
    },
    30_000,
  )
})
