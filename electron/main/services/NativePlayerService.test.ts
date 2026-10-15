import fs from 'node:fs'
import path from 'node:path'
import childProcess, { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativePlayerInfo } from '@shared/types'

const state = vi.hoisted(() => ({ selected: null as NativePlayerInfo | null }))
vi.mock('../infra/config', () => ({
  loadConfig: () => ({ libraries: [], nativePlayer: state.selected }),
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))

import {
  discoverNativePlayers,
  findNativePlayer,
  openInNativePlayer,
  spawnNativePlayerProcess,
  validateNativePlayer,
} from './NativePlayerService'
import { isSourceFileInUse } from './SourceFileUsage'

const bin = path.resolve('synthetic-native-bin')
const executable = (name: string) =>
  path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
const available = new Set<string>()

beforeEach(() => {
  state.selected = null
  available.clear()
  vi.stubEnv('PATH', bin)
  vi.spyOn(fs.promises, 'stat').mockImplementation(async (file) => {
    if (!available.has(String(file))) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { isFile: () => true } as fs.Stats
  })
  vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)
  vi.spyOn(fs.promises, 'realpath').mockImplementation(async (file) => path.resolve(String(file)))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null,
    killed: false,
    kill: vi.fn(),
    unref: vi.fn(),
  })
  vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ChildProcess)
  return child
}

describe('native player discovery and launch', () => {
  it('protects a source through a live native process and releases it only on exit', async () => {
    vi.useFakeTimers()
    const child = Object.assign(fakeChild(), { pid: 123 })
    const sourcePath = path.resolve('native-usage-fixture.mp4')
    const launched = spawnNativePlayerProcess(executable('mpv'), [sourcePath], { sourcePath })
    expect(isSourceFileInUse(sourcePath)).toBe(true)
    expect(vi.mocked(childProcess.spawn).mock.calls[0][2]).not.toHaveProperty('sourcePath')
    child.emit('spawn')
    await vi.advanceTimersByTimeAsync(500)
    await launched.ready
    child.emit('error', new Error('kill request failed'))
    expect(isSourceFileInUse(sourcePath)).toBe(true)
    child.emit('exit', 0, null)
    expect(isSourceFileInUse(sourcePath)).toBe(false)
  })

  it('releases a source when the native process could not start', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const sourcePath = path.resolve('failed-native-usage-fixture.mp4')
    const launched = spawnNativePlayerProcess(executable('mpv'), [sourcePath], { sourcePath })
    const rejected = expect(launched.ready).rejects.toThrow('EACCES')
    child.emit('error', new Error('EACCES'))
    await rejected
    expect(isSourceFileInUse(sourcePath)).toBe(false)
  })

  it('prioritizes PATH mpv before fixed ffplay/VLC and deduplicates repeated PATH entries', async () => {
    available.add(executable('mpv'))
    available.add(executable('ffplay'))
    available.add(executable('vlc'))
    if (process.platform === 'win32') available.add('C:\\Program Files\\ffmpeg\\bin\\ffplay.exe')
    vi.stubEnv('PATH', [bin, bin].join(path.delimiter))
    const players = await discoverNativePlayers()
    expect(players[0]).toEqual({ name: 'mpv', path: executable('mpv') })
    expect(players.filter((player) => player.name === 'mpv')).toHaveLength(1)
    expect(await findNativePlayer()).toEqual(players[0])
  })

  it('honors the manual player and reports a missing selection instead of silent fallback', async () => {
    available.add(executable('mpv'))
    available.add(executable('vlc'))
    state.selected = { name: 'vlc', path: executable('vlc') }
    expect(await findNativePlayer()).toEqual(state.selected)
    available.delete(executable('vlc'))
    await expect(findNativePlayer()).rejects.toThrow('경로를 다시 선택')
  })

  it('rejects relative paths, unsupported executables, and directories', async () => {
    await expect(validateNativePlayer({ name: 'mpv', path: 'mpv.exe' })).rejects.toThrow(
      '절대 경로',
    )
    await expect(
      validateNativePlayer({ name: 'other' as 'mpv', path: executable('mpv') }),
    ).rejects.toThrow('이름')
    available.add(executable('mpv'))
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({ isFile: () => false } as fs.Stats)
    await expect(validateNativePlayer({ name: 'mpv', path: executable('mpv') })).rejects.toThrow(
      '사용할 수 없습니다',
    )
  })

  it('does not return success before spawn and the early-failure grace period', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const launched = spawnNativePlayerProcess(executable('mpv'), ['movie.mp4'])
    let ready = false
    void launched.ready.then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(ready).toBe(false)
    child.emit('spawn')
    await vi.advanceTimersByTimeAsync(499)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await launched.ready
    expect(ready).toBe(true)
  })

  it('returns spawn failures and bounded stderr for an early nonzero exit', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const denied = spawnNativePlayerProcess(executable('mpv'), [])
    const deniedExpectation = expect(denied.ready).rejects.toThrow('EACCES')
    child.emit('error', new Error('EACCES'))
    await deniedExpectation
    const failed = spawnNativePlayerProcess(executable('mpv'), [])
    const errorResult = failed.ready.catch((error: Error) => error)
    child.emit('spawn')
    child.stderr.emit('data', 'a'.repeat(9000) + 'Unsupported codec')
    child.emit('exit', 2, null)
    const error = (await errorResult) as Error
    expect(error.message).toContain('Unsupported codec')
    expect(error.message.length).toBeLessThan(8600)
    expect(error.message).toContain('종료 코드: 2')
  })

  it('uses the selected player once and preserves a media path as one argument', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    available.add(executable('vlc'))
    const selection: NativePlayerInfo = { name: 'vlc', path: executable('vlc') }
    const pending = openInNativePlayer(
      'C:\\media files\\movie & name.mp4',
      { startTimeSec: 23.7 },
      selection,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(childProcess.spawn).toHaveBeenCalledWith(
      executable('vlc'),
      ['--no-one-instance', '--start-time=23', '--', 'C:\\media files\\movie & name.mp4'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    )
    child.emit('spawn')
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual(selection)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('enables safe automatic mpv hardware decoding while retaining renderer and fallback defaults', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    available.add(executable('mpv'))
    const selection: NativePlayerInfo = { name: 'mpv', path: executable('mpv') }
    const pending = openInNativePlayer(
      'C:\\media files\\movie.mp4',
      { startTimeSec: 23 },
      selection,
    )
    await vi.advanceTimersByTimeAsync(0)
    const args = vi.mocked(childProcess.spawn).mock.calls[0][1] as string[]
    expect(args.filter((argument) => argument.startsWith('--hwdec='))).toEqual([
      '--hwdec=auto-safe',
    ])
    expect(args).toContain('--start=23')
    expect(args.slice(-2)).toEqual(['--', 'C:\\media files\\movie.mp4'])
    expect(
      args.some((argument) =>
        /^--(?:vo|gpu-context|gpu-api|hwdec-software-fallback|vd-lavc-software-fallback)=/.test(
          argument,
        ),
      ),
    ).toBe(false)
    child.emit('spawn')
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual(selection)
  })
})
