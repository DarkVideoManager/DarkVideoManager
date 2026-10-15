import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: state.spawn }))
vi.mock('./ffmpegPath', () => ({ getFfmpegPath: () => 'ffmpeg.exe' }))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn() {} }) }))

import { extractThumbnailAtTime, generateThumbnails, THUMBNAIL_TIMEOUT_MS } from './thumbnail'

class Process extends EventEmitter {
  stderr = new EventEmitter()
  kill = vi.fn()
  constructor(readonly outputPath: string) {
    super()
  }
}

let directory: string
let children: Process[]
beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'dvm-thumbnail-cancel-test-'))
  children = []
  state.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
    const child = new Process(args.at(-1)!)
    children.push(child)
    return child
  })
})
afterEach(() => {
  vi.useRealTimers()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-thumbnail-cancel-test-'))
    throw new Error('Unsafe test cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('thumbnail process lifecycle', () => {
  it('releases cancellation immediately and kills a late-starting process', async () => {
    const controller = new AbortController()
    const capture = extractThumbnailAtTime(
      'synthetic.mp4',
      directory,
      'test',
      1,
      controller.signal,
    ).catch((error: Error) => error.name)
    const child = children[0]
    writeFileSync(child.outputPath, 'partial image')
    controller.abort()
    expect(await capture).toBe('AbortError')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(existsSync(child.outputPath)).toBe(false)

    child.emit('spawn')
    expect(child.kill).toHaveBeenCalledTimes(2)
    // Some OS handles close after the promise settles: clean only this attempt.
    writeFileSync(child.outputPath, 'late image')
    const nextFrame = join(directory, 'next.jpg')
    writeFileSync(nextFrame, 'keep')
    child.emit('close', 0)
    expect(existsSync(child.outputPath)).toBe(false)
    expect(existsSync(nextFrame)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out even when the child never emits a terminal event and stops remaining frames', async () => {
    const capture = generateThumbnails('synthetic.mp4', directory, 'test', 10).catch(
      (error: Error) => error.name,
    )
    writeFileSync(children[0].outputPath, 'partial image')
    await vi.advanceTimersByTimeAsync(THUMBNAIL_TIMEOUT_MS)
    expect(await capture).toBe('ThumbnailTimeoutError')
    expect(state.spawn).toHaveBeenCalledTimes(1)
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(readdirSync(directory)).toEqual([])
  })

  it('does not start a process for an already canceled request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractThumbnailAtTime('video.mp4', directory, 'test', 1, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.spawn).not.toHaveBeenCalled()
  })

  it('publishes a nonempty image only after successful process exit', async () => {
    const capture = extractThumbnailAtTime('video.mp4', directory, 'test', 1)
    writeFileSync(children[0].outputPath, 'complete image')
    children[0].emit('close', 0)
    const output = await capture
    expect(existsSync(output)).toBe(true)
    expect(existsSync(children[0].outputPath)).toBe(false)
    expect(readdirSync(directory)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects empty images and cleans files after decoder failures', async () => {
    const empty = extractThumbnailAtTime('video.mp4', directory, 'empty', 1)
    writeFileSync(children[0].outputPath, '')
    children[0].emit('close', 0)
    await expect(empty).rejects.toThrow('Empty thumbnail')
    const failed = extractThumbnailAtTime('video.mp4', directory, 'failed', 1)
    writeFileSync(children[1].outputPath, 'incomplete')
    children[1].stderr.emit('data', Buffer.from('decoder unavailable'))
    children[1].emit('close', 1)
    await expect(failed).rejects.toThrow('decoder unavailable')
    expect(readdirSync(directory)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes earlier generated frames when the next extraction is canceled', async () => {
    const controller = new AbortController()
    const capture = generateThumbnails('video.mp4', directory, 'test', 10, controller.signal).catch(
      (error: Error) => error.name,
    )
    writeFileSync(children[0].outputPath, 'complete')
    children[0].emit('close', 0)
    await Promise.resolve()
    expect(children).toHaveLength(2)
    controller.abort()
    expect(await capture).toBe('AbortError')
    expect(readdirSync(directory)).toEqual([])
  })
})
