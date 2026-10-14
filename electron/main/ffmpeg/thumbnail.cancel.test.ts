import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  callbacks: new Map<string, (...args: unknown[]) => void>(),
  outputPath: '',
  kill: vi.fn(),
  run: vi.fn(),
}))
vi.mock('fluent-ffmpeg', () => {
  const command = {
    seekInput() {
      return command
    },
    frames() {
      return command
    },
    output(path: string) {
      state.outputPath = path
      return command
    },
    outputOptions() {
      return command
    },
    on(event: string, callback: (...args: unknown[]) => void) {
      state.callbacks.set(event, callback)
      return command
    },
    kill: state.kill,
    run: state.run,
  }
  return { default: Object.assign(() => command, { setFfmpegPath() {}, setFfprobePath() {} }) }
})
vi.mock('./ffmpegPath', () => ({ getFfmpegPath: () => '', getFfprobePath: () => '' }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn() {} }) }))

import { extractThumbnailAtTime } from './thumbnail'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dvm-thumbnail-cancel-test-'))
  state.callbacks.clear()
  state.kill.mockClear()
  state.run.mockClear()
})
afterEach(() => {
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-thumbnail-cancel-test-'))
    throw new Error('Unsafe test cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('thumbnail process cancellation', () => {
  it('kills a process that starts after cancellation and waits for its exit before cleanup', async () => {
    const controller = new AbortController()
    let settled = false
    const capture = extractThumbnailAtTime(
      'synthetic.mp4',
      directory,
      'test',
      1,
      controller.signal,
    ).catch((error: Error) => {
      settled = true
      return error.name
    })
    writeFileSync(state.outputPath, 'partial image')
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(existsSync(state.outputPath)).toBe(true)
    state.callbacks.get('start')!()
    expect(state.kill).toHaveBeenCalledTimes(2)
    state.callbacks.get('error')!(new Error('process killed'))
    expect(await capture).toBe('AbortError')
    expect(existsSync(state.outputPath)).toBe(false)
  })
})
