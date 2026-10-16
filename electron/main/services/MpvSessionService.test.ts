import { EventEmitter } from 'node:events'
import net from 'node:net'
import childProcess, { type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Video } from '@shared/types'

const state = vi.hoisted(() => ({ runtime: '', seekStepSec: undefined as number | undefined }))
vi.mock('node:net', () => ({ default: { createConnection: vi.fn() } }))
vi.mock('node:child_process', () => ({ default: { spawn: vi.fn() } }))
vi.mock('../infra/paths', () => ({ getNativePlayerDir: () => state.runtime }))
vi.mock('../infra/config', () => ({
  loadConfig: () => ({ libraries: [], seekStepSec: state.seekStepSec }),
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
vi.mock('./PlaybackService', () => ({
  startPlayback: vi.fn(),
  heartbeat: vi.fn(),
  endPlayback: vi.fn(),
  resetPlaybackPosition: vi.fn(),
}))
vi.mock('./HighlightService', () => ({ createHighlight: vi.fn() }))
vi.mock('./ThumbnailService', () => ({ captureThumbnailAtTime: vi.fn() }))

import { openInMpv, closeAllMpvSessions, setMpvPlaybackRate } from './MpvSessionService.js'
import { heartbeat, endPlayback, startPlayback } from './PlaybackService'

// Fengari has no bundled TypeScript definitions; keep the tiny C-API surface typed here.
const fengari = createRequire(__filename)('fengari') as {
  lua: {
    LUA_OK: number
    lua_pcall(state: unknown, args: number, results: number, handler: number): number
    lua_tojsstring(state: unknown, index: number): string
    lua_close(state: unknown): void
  }
  lauxlib: { luaL_newstate(): unknown; luaL_loadstring(state: unknown, source: Uint8Array): number }
  lualib: { luaL_openlibs(state: unknown): void }
  to_luastring(source: string): Uint8Array
}

async function runSeekScript(assertions: string): Promise<void> {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  child.emit('spawn')
  await vi.advanceTimersByTimeAsync(500)
  await pending
  const launchEnvironment = vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[2]?.env
  const seekStepValue = launchEnvironment?.DARK_VIDEO_MANAGER_SEEK_STEP_SEC
  const script = readFileSync(join(state.runtime, 'darkvideomanager-mpv.lua'), 'utf8')
  const { lua, lauxlib, lualib, to_luastring } = fengari
  const vm = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(vm)
  // Execute the exact generated Lua, with an intentionally slow decoder: time-pos
  // does not change when a seek is requested. Tests control its acknowledgment.
  const harness = `
    local clock, position, duration = 0, 100, 1000
    local seeks, timers, keys, events, messages, property_writes = {}, {}, {}, {}, {}, {}
    local mp = {}
    function mp.get_time() return clock end
    function mp.get_property_number(name, default)
      if name == 'time-pos' then return position end
      if name == 'duration' then return duration end
      return default
    end
    function mp.get_property_native() return false end
    function mp.set_property_number(name, value) property_writes[name] = value end
    function mp.set_property_native(name, value) property_writes[name] = value end
    function mp.osd_message() end
    function mp.commandv(command, target, flags)
      if command == 'seek' then table.insert(seeks, { target = tonumber(target), flags = flags, at = clock }) end
    end
    function mp.add_timeout(delay, callback)
      local timer = { at = clock + delay, callback = callback, active = true }
      function timer:kill() self.active = false end
      table.insert(timers, timer)
      return timer
    end
    function mp.add_periodic_timer() return { kill = function() end } end
    function mp.add_key_binding(key, name, callback, flags) keys[key] = { callback = callback, flags = flags } end
    mp.add_forced_key_binding = mp.add_key_binding
    function mp.register_event(name, callback)
      events[name] = events[name] or {}; table.insert(events[name], callback)
    end
    function mp.observe_property() end
    function mp.register_script_message(name, callback) messages[name] = callback end
    local function fire(name)
      for _, callback in ipairs(events[name] or {}) do callback() end
    end
    local function key(name, event, canceled)
      keys[name].callback({ event = event or 'press', canceled = canceled or false })
    end
    local function advance(seconds)
      clock = clock + seconds
      for _, timer in ipairs(timers) do
        if timer.active and timer.at <= clock then timer.active = false; timer.callback() end
      end
    end
    local function check_seek(index, target, flags)
      assert(seeks[index], 'missing seek ' .. index)
      assert(math.abs(seeks[index].target - target) < 0.000001, 'seek target ' .. seeks[index].target .. ' != ' .. target)
      assert(seeks[index].flags == flags, 'seek flags ' .. seeks[index].flags .. ' != ' .. flags)
    end
    package.loaded['mp'] = mp
    package.loaded['mp.utils'] = {}
    os.getenv = function(name)
      if name == 'DARK_VIDEO_MANAGER_SEEK_STEP_SEC' then return '${seekStepValue}' end
      return nil
    end
    os.clock = function() return 0 end
  `
  try {
    const status = lauxlib.luaL_loadstring(
      vm,
      to_luastring(harness + '\n' + script + '\n' + assertions),
    )
    if (status !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(vm, -1))
    const result = lua.lua_pcall(vm, 0, 0, 0)
    if (result !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(vm, -1))
  } finally {
    lua.lua_close(vm)
  }
}

let child: EventEmitter & {
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  killed: boolean
  stderr: EventEmitter
  exitCode: number | null
}
const video = { id: 'video', filePath: 'C:\\synthetic.mp4', resumePosSec: 0 } as Video
const webContents = { isDestroyed: () => false, send: vi.fn() } as unknown as Electron.WebContents
beforeEach(() => {
  state.seekStepSec = undefined
  state.runtime = mkdtempSync(join(tmpdir(), 'dvm-mpv-test-'))
  child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    unref: vi.fn(),
    killed: false,
    stderr: new EventEmitter(),
    exitCode: null,
  })
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as ChildProcess)
  vi.mocked(heartbeat).mockClear()
  vi.mocked(endPlayback).mockClear()
  vi.mocked(startPlayback).mockClear()
  vi.useFakeTimers()
})
afterEach(() => {
  closeAllMpvSessions()
  vi.useRealTimers()
  const target = resolve(state.runtime)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('dvm-mpv-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

it('retains incomplete event lines and processes native heartbeats exactly once', async () => {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)![1] as string[]
  expect(args.filter((argument) => argument.startsWith('--hwdec='))).toEqual(['--hwdec=auto-safe'])
  expect(args.slice(-2)).toEqual(['--', video.filePath])
  expect(args.some((argument) => argument.startsWith('--script='))).toBe(true)
  child.emit('spawn')
  await vi.advanceTimersByTimeAsync(500)
  await pending
  const eventFile = join(
    state.runtime,
    readdirSync(state.runtime).find((name) => name.endsWith('.events.log'))!,
  )
  appendFileSync(eventFile, '{"type":"heartbeat",')
  await vi.advanceTimersByTimeAsync(500)
  expect(heartbeat).not.toHaveBeenCalled()
  appendFileSync(eventFile, '"timeSec":12}\n')
  await vi.advanceTimersByTimeAsync(500)
  expect(heartbeat).toHaveBeenCalledWith('library', 'video', 12)
  await vi.advanceTimersByTimeAsync(500)
  expect(heartbeat).toHaveBeenCalledTimes(1)
})

it('flushes an escape event before native process exit cleanup', async () => {
  vi.mocked(webContents.send).mockClear()
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  child.emit('spawn')
  await vi.advanceTimersByTimeAsync(500)
  await pending
  const eventFile = join(
    state.runtime,
    readdirSync(state.runtime).find((name) => name.endsWith('.events.log'))!,
  )
  appendFileSync(eventFile, '{"type":"escape","timeSec":17}\n')
  child.emit('exit')
  await Promise.resolve()
  await Promise.resolve()
  expect(webContents.send).toHaveBeenCalledWith('event:nativePlayerEscape', { videoId: 'video' })
  expect(endPlayback).toHaveBeenLastCalledWith('library', 'video', 17)
})

it('reports native spawn errors without ending the in-app session or starting history', async () => {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  const rejected = expect(pending).rejects.toThrow('spawn denied')
  expect(() => child.emit('error', new Error('spawn denied'))).not.toThrow()
  await rejected
  expect(endPlayback).not.toHaveBeenCalled()
  expect(startPlayback).not.toHaveBeenCalled()
  expect(readdirSync(state.runtime).filter((name) => name.endsWith('.events.log'))).toEqual([])
})

it('reports early mpv stderr and cleans runtime files before recording playback', async () => {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  const rejected = expect(pending).rejects.toThrow('Unsupported file format')
  child.emit('spawn')
  child.stderr.emit('data', Buffer.from('Unsupported file format'))
  child.emit('exit', 2, null)
  await rejected
  expect(startPlayback).not.toHaveBeenCalled()
  expect(endPlayback).not.toHaveBeenCalled()
  expect(readdirSync(state.runtime).filter((name) => name.endsWith('.events.log'))).toEqual([])
})

it('cancels a pending startup during shutdown instead of creating a late session', async () => {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
  )
  const rejected = expect(pending).rejects.toThrow('취소')
  child.emit('spawn')
  closeAllMpvSessions()
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(child.kill).toHaveBeenCalled()
  expect(startPlayback).not.toHaveBeenCalled()
})

it('uses the saved seek interval for taps while keeping modifier intervals and hold acceleration', async () => {
  state.seekStepSec = 10
  await runSeekScript(`
    key('RIGHT', 'down'); key('RIGHT', 'up'); key('d', 'press'); key('a', 'press')
    check_seek(1, 110, 'absolute+exact'); check_seek(2, 120, 'absolute+exact')
    check_seek(3, 110, 'absolute+exact')
    key('Shift+RIGHT'); key('Ctrl+LEFT')
    check_seek(4, 115, 'absolute+exact'); check_seek(5, 85, 'absolute+exact')
    key('d', 'down'); advance(2); key('d', 'repeat'); key('d', 'up')
    check_seek(6, 95, 'absolute+exact'); check_seek(7, 100, 'absolute+exact')
    assert(next(property_writes) == nil, 'seeking must preserve pause and volume')
  `)
})

it('seeks by percentage on digits and keypad digits without changing pause or modifier bindings', async () => {
  await runSeekScript(`
    for digit = 0, 9 do
      key(tostring(digit))
      check_seek(digit + 1, digit * 100, 'absolute+exact')
      assert(not keys['Ctrl+' .. digit] and not keys['Shift+' .. digit])
    end
    for digit = 0, 9 do
      key('KP' .. digit)
      check_seek(digit + 11, digit * 100, 'absolute+exact')
    end
    assert(next(property_writes) == nil, 'percentage seeking must preserve pause and volume')
    assert(keys['UP'] and keys['DOWN'], 'volume arrows remain available')
    duration = 0; key('5')
    duration = nil; key('KP5')
    duration = -10; key('2')
    duration = math.huge; key('8')
    duration = 0/0; key('3')
    assert(#seeks == 20, 'unknown duration must not seek')
    duration = 1000
    key('d', 'down'); advance(2); key('d', 'repeat')
    local stale = timers[#timers]
    key('5'); check_seek(22, 500, 'absolute+exact')
    stale.callback(); key('d', 'up'); advance(1)
    assert(#seeks == 22, 'held preview must not overwrite a percentage seek')
  `)
})

it('executes exact single taps and fixed modifier steps without losing rapid taps to a slow decoder', async () => {
  await runSeekScript(`
    key('RIGHT', 'down'); key('RIGHT', 'up')
    key('d', 'down'); key('d', 'up')
    key('LEFT', 'down'); key('LEFT', 'up')
    key('a', 'press')
    check_seek(1, 101, 'absolute+exact')
    check_seek(2, 102, 'absolute+exact')
    check_seek(3, 101, 'absolute+exact')
    check_seek(4, 100, 'absolute+exact')
    key('Shift+RIGHT'); key('Shift+a'); key('Ctrl+d'); key('Ctrl+LEFT')
    check_seek(5, 105, 'absolute+exact'); check_seek(6, 100, 'absolute+exact')
    check_seek(7, 130, 'absolute+exact'); check_seek(8, 100, 'absolute+exact')
    advance(1); assert(#seeks == 8, 'a tap must not schedule a preview')
    assert(keys['RIGHT'].flags.complex and keys['d'].flags.complex)
  `)
})

it('coalesces accelerated repeats into keyframe previews and sends exactly one final precise target', async () => {
  await runSeekScript(`
    key('d', 'down')
    advance(2)
    key('d', 'repeat'); advance(0.02); key('d', 'repeat'); advance(0.02); key('d', 'repeat')
    assert(#seeks == 1, 'repeat burst should be coalesced')
    advance(0.061)
    check_seek(2, 116, 'absolute+keyframes')
    key('d', 'repeat')
    key('d', 'up')
    check_seek(3, 121, 'absolute+exact')
    key('d', 'up'); advance(1)
    assert(#seeks == 3, 'duplicate up / canceled timers must not emit seeks')
    assert(seeks[2].at - seeks[1].at >= 0.1)
  `)
})

it('uses real elapsed time for the acceleration ramp and caps each repeat at five seconds', async () => {
  await runSeekScript(`
    key('RIGHT', 'down')
    advance(0.25); key('RIGHT', 'repeat'); advance(0.11)
    check_seek(2, 101.1, 'absolute+keyframes')
    advance(0.765); key('RIGHT', 'repeat'); advance(0.11)
    check_seek(3, 103.65, 'absolute+keyframes')
    advance(10); key('RIGHT', 'repeat'); key('RIGHT', 'up')
    check_seek(4, 108.65, 'absolute+exact')
  `)
})

it('cancels stale timers on direction changes, modifier seeks, and logical key cancellation', async () => {
  await runSeekScript(`
    key('d', 'down'); advance(2); key('d', 'repeat')
    local stale = timers[#timers]
    key('a', 'down')
    check_seek(2, 105, 'absolute+exact')
    key('d', 'up') -- late release from the previous direction
    stale.callback() -- even an already queued obsolete callback is harmless
    advance(2); key('a', 'repeat')
    key('Shift+RIGHT')
    check_seek(3, 105, 'absolute+exact')
    key('a', 'up'); advance(1)
    assert(#seeks == 3, 'old hold must not overwrite the modifier seek')
    key('LEFT', 'down'); advance(2); key('LEFT', 'repeat')
    key('LEFT', 'up', true)
    check_seek(5, 99, 'absolute+exact')
    key('LEFT', 'up'); advance(1); assert(#seeks == 5)
  `)
})

it('discards holds on file changes and clamps targets while accepting acknowledged playback positions', async () => {
  await runSeekScript(`
    key('d', 'down'); advance(2); key('d', 'repeat')
    fire('end-file'); advance(1); key('d', 'up')
    assert(#seeks == 1, 'old file must not receive a delayed seek')
    position = 0; fire('file-loaded')
    key('a', 'down'); advance(2); key('a', 'repeat'); key('a', 'up')
    check_seek(2, 0, 'absolute+exact'); check_seek(3, 0, 'absolute+exact')
    position = 998; fire('playback-restart')
    key('d', 'down'); advance(2); key('d', 'repeat'); key('d', 'up')
    check_seek(4, 999, 'absolute+exact'); check_seek(5, 1000, 'absolute+exact')
  `)
})

it('lets an app-requested highlight seek cancel held-key previews without being overwritten', async () => {
  await runSeekScript(`
    key('d', 'down'); advance(2); key('d', 'repeat')
    local stale = timers[#timers]
    messages['darkvideomanager-seek-to']('400')
    check_seek(2, 400, 'absolute+exact')
    stale.callback(); key('d', 'up'); advance(1)
    assert(#seeks == 2, 'held preview must not overwrite an app-requested seek')
    position = 401; fire('playback-restart')
    key('RIGHT', 'down'); key('RIGHT', 'up')
    check_seek(3, 402, 'absolute+exact')
  `)
})

it('ignores repeats from an inactive key without stealing the current direction or restarting a released hold', async () => {
  await runSeekScript(`
    key('d', 'down')
    key('a', 'down')
    check_seek(1, 101, 'absolute+exact')
    check_seek(2, 100, 'absolute+exact')
    advance(2)
    key('d', 'repeat')
    assert(#seeks == 2, 'inactive repeat must not steal the active key')
    key('a', 'repeat'); advance(0.11)
    check_seek(3, 95, 'absolute+keyframes')
    key('a', 'up')
    check_seek(4, 95, 'absolute+exact')
    key('a', 'repeat'); key('d', 'repeat'); advance(1)
    assert(#seeks == 4, 'repeat without an active key must not restart seeking')
  `)
})

async function launchAtRate(rate: number) {
  const pending = openInMpv(
    'fake-mpv.exe',
    'library',
    video,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    webContents,
    rate,
  )
  child.emit('spawn')
  await vi.advanceTimersByTimeAsync(500)
  await pending
}
it('passes validated launch rate to mpv and reflects native speed events without altering playback position', async () => {
  await launchAtRate(1.5)
  expect(vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[1]).toContain('--speed=1.5')
  const eventFile = readdirSync(state.runtime).find((name) => name.endsWith('.events.log'))!
  appendFileSync(
    join(state.runtime, eventFile),
    JSON.stringify({ type: 'speed', rate: 2.5, timeSec: 7 }) + '\n',
  )
  await vi.advanceTimersByTimeAsync(500)
  expect(webContents.send).toHaveBeenCalledWith('event:nativePlayerSpeed', {
    videoId: 'video',
    rate: 2.5,
  })
  expect(heartbeat).not.toHaveBeenCalled()
})
it('validates rates and requires mpv success acknowledgement instead of reporting an unconfirmed speed', async () => {
  for (const rate of [0, -1, 0.24, 4.01, NaN, Infinity]) {
    await expect(setMpvPlaybackRate('library', 'video', rate)).rejects.toThrow()
  }
  expect(await setMpvPlaybackRate('library', 'video', 1)).toBe(false)
  await launchAtRate(1)
  const socket = Object.assign(new EventEmitter(), {
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  })
  vi.mocked(net.createConnection).mockReturnValue(
    socket as unknown as ReturnType<typeof net.createConnection>,
  )
  const pending = setMpvPlaybackRate('library', 'video', 2)
  socket.emit('connect')
  expect(JSON.parse(socket.write.mock.calls[0][0]).command).toEqual(['set_property', 'speed', 2])
  socket.emit('data', Buffer.from('{"error":"success"}\n'))
  await expect(pending).resolves.toBe(true)
  const failed = setMpvPlaybackRate('library', 'video', 3)
  socket.emit('close')
  await expect(failed).rejects.toThrow('응답이 없습니다')
})
