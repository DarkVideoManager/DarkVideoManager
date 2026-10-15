// Recovered from the shipped 0.1.0 implementation and maintained as a focused service.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MPV_HARDWARE_DECODING_ARGS, spawnNativePlayerProcess } from './NativePlayerService'
import net from 'node:net'
import { getNativePlayerDir } from '../infra/paths'
import { loadConfig } from '../infra/config'
import { createLogger } from '../infra/logger'
import { createHighlight } from './HighlightService'
import { captureThumbnailAtTime } from './ThumbnailService'
import { startPlayback, heartbeat, endPlayback, resetPlaybackPosition } from './PlaybackService'
import { IPC } from '../../../src/shared/ipc'
import { DEFAULT_SEEK_STEP_SEC } from '../../../src/shared/playerSettings'
const log = createLogger('mpv-session')
const sessions = /* @__PURE__ */ new Map()
const pendingSessions = new Map()
export async function openInMpv(
  mpvPath,
  libraryId,
  video,
  startTimeSec,
  width,
  height,
  x,
  y,
  webContents,
) {
  const sessionId = `${libraryId}-${video.id}`
  const previousPending = pendingSessions.get(sessionId)
  if (previousPending) {
    previousPending.cancelled = true
    previousPending.child?.kill()
  }
  const pending = { child: undefined, cancelled: false }
  const runtimeDir = getNativePlayerDir()
  const attemptId = `${sessionId}-${randomUUID()}`
  const eventFilePath = path.join(runtimeDir, `${attemptId}.events.log`)
  const ipcPipePath = `\\\\.\\pipe\\darkvideomanager-mpv-${attemptId}`
  pendingSessions.set(sessionId, pending)
  try {
    const scriptPath = ensureMpvScript(runtimeDir)
    fs.writeFileSync(eventFilePath, '', 'utf8')
    const args = [
      ...MPV_HARDWARE_DECODING_ARGS,
      '--force-window=yes',
      '--autofit-larger=100%x100%',
      ...(width && height
        ? [`--autofit=${Math.max(320, Math.floor(width))}x${Math.max(240, Math.floor(height))}`]
        : []),
      ...(width && height && x !== void 0 && y !== void 0
        ? [
            `--geometry=${Math.max(320, Math.floor(width))}x${Math.max(240, Math.floor(height))}${x >= 0 ? '+' : ''}${Math.floor(x)}${y >= 0 ? '+' : ''}${Math.floor(y)}`,
          ]
        : []),
      '--title=DarkVideoManager mpv',
      `--input-ipc-server=${ipcPipePath}`,
      `--script=${scriptPath}`,
      ...(startTimeSec > 0 ? [`--start=${Math.max(0, startTimeSec)}`] : []),
      '--',
      video.filePath,
    ]
    const { child, ready } = spawnNativePlayerProcess(mpvPath, args, {
      env: {
        ...process.env,
        DARK_VIDEO_MANAGER_MPV_EVENT_FILE: eventFilePath,
        DARK_VIDEO_MANAGER_SEEK_STEP_SEC: String(loadConfig().seekStepSec ?? DEFAULT_SEEK_STEP_SEC),
      },
    })
    pending.child = child
    await ready
    if (pending.cancelled || pendingSessions.get(sessionId) !== pending) {
      throw new Error('외부 플레이어 실행이 취소되었습니다.')
    }
    closeSession(sessionId)
    endPlayback(libraryId, video.id, startTimeSec)
    // A short successful playback may already have ended during startup checks.
    if (child.exitCode !== null && child.exitCode !== undefined) {
      safeRemove(eventFilePath)
      return
    }
    startPlayback(libraryId, video.id, startTimeSec)
    const timer = setInterval(() => {
      void flushSessionEvents(sessionId, libraryId, video, webContents).catch((error) =>
        log.warn({ error }, 'mpv event polling failed'),
      )
    }, 500)
    child.on('error', (error) => {
      log.error({ error }, 'mpv failed to start')
      if (sessions.get(sessionId)?.child === child) closeSession(sessionId, false)
    })
    child.on('exit', () => {
      if (sessions.get(sessionId)?.child !== child) return
      void flushSessionEvents(sessionId, libraryId, video, webContents)
        .catch((error) => log.warn({ error }, 'Final mpv event failed'))
        .finally(() => {
          if (sessions.get(sessionId)?.child === child) closeSession(sessionId, false)
        })
    })
    child.unref()
    sessions.set(sessionId, {
      child,
      eventFilePath,
      ipcPipePath,
      offset: 0,
      libraryId,
      videoId: video.id,
      lastPosition: startTimeSec,
      timer,
    })
    log.info({ mpvPath, libraryId, videoId: video.id, startTimeSec }, 'Opened video in mpv')
  } catch (error) {
    if (pending.child && !pending.child.killed) pending.child.kill()
    safeRemove(eventFilePath)
    throw error
  } finally {
    if (pendingSessions.get(sessionId) === pending) pendingSessions.delete(sessionId)
  }
}
export async function seekMpvSession(libraryId, videoId, timeSec) {
  const sessionId = `${libraryId}-${videoId}`
  const session = sessions.get(sessionId)
  if (!session) return false
  await sendMpvCommand(session.ipcPipePath, {
    command: ['script-message', 'darkvideomanager-seek-to', String(Math.max(0, timeSec))],
  })
  return true
}
function closeSession(sessionId, stopPlayer = true) {
  const session = sessions.get(sessionId)
  if (!session) return
  clearInterval(session.timer)
  endPlayback(session.libraryId, session.videoId, session.lastPosition)
  if (stopPlayer && !session.child.killed) session.child.kill()
  safeRemove(session.eventFilePath)
  sessions.delete(sessionId)
}
async function flushSessionEvents(sessionId, libraryId, video, webContents) {
  const session = sessions.get(sessionId)
  if (!session || !fs.existsSync(session.eventFilePath)) return
  const content = fs.readFileSync(session.eventFilePath, 'utf8')
  if (content.length <= session.offset) return
  const completeEnd = content.lastIndexOf('\n') + 1
  if (completeEnd <= session.offset) return
  const pending = content.slice(session.offset, completeEnd)
  session.offset = completeEnd
  const lines = pending
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      const timeSec = typeof event.timeSec === 'number' ? event.timeSec : 0
      session.lastPosition = timeSec
      if (event.type === 'heartbeat') {
        heartbeat(libraryId, video.id, timeSec)
        continue
      }
      if (event.type === 'seek') {
        resetPlaybackPosition(libraryId, video.id, timeSec)
        continue
      }
      if (event.type === 'thumbnail') {
        await captureThumbnailAtTime(libraryId, video.id, timeSec, webContents)
        continue
      }
      if (event.type === 'highlight') {
        createHighlight(libraryId, {
          videoId: video.id,
          timeStart: timeSec,
          color: 'yellow',
        })
        notifyHighlightChanged(webContents, video.id)
        continue
      }
      if (event.type === 'escape') {
        notifyNativePlayerEscape(webContents, video.id)
        continue
      }
      if (
        event.type === 'previous-highlight' ||
        event.type === 'next-highlight' ||
        event.type === 'save-highlight' ||
        event.type === 'set-thumbnail'
      ) {
        notifyNativePlayerAction(webContents, video.id, event.type, timeSec)
      }
    } catch (err2) {
      log.warn({ err: err2, line, sessionId }, 'Failed to handle mpv event')
    }
  }
}
function ensureMpvScript(runtimeDir) {
  const scriptPath = path.join(runtimeDir, 'darkvideomanager-mpv.lua')
  fs.writeFileSync(
    scriptPath,
    `
local mp = require 'mp'
local utils = require 'mp.utils'
local event_file = os.getenv('DARK_VIDEO_MANAGER_MPV_EVENT_FILE')
local seek_step = tonumber(os.getenv('DARK_VIDEO_MANAGER_SEEK_STEP_SEC')) or ${DEFAULT_SEEK_STEP_SEC}
local seek_acceleration = { direction = 0, started_at = 0, target = nil, key = nil, repeated = false, timer = nil, generation = 0 }
local seek_interval = 0.1
local seek_anchor = nil

local function emit(event_type)
  if not event_file then
    return
  end

  local time_pos = mp.get_property_number('time-pos', 0)
  local file = io.open(event_file, 'a')
  if not file then
    return
  end

  file:write(utils.format_json({ type = event_type, timeSec = time_pos }), "\\n")
  file:close()

  if event_type == "heartbeat" or event_type == "seek" then return end

  local message = ({
    ['thumbnail'] = 'Updated thumbnail',
    ['highlight'] = 'Added highlight',
    ['previous-highlight'] = 'Previous highlight',
    ['next-highlight'] = 'Next highlight',
    ['save-highlight'] = 'Saved highlight',
    ['set-thumbnail'] = 'Set thumbnail',
    ['escape'] = 'Back to library',
  })[event_type] or event_type
  mp.osd_message(message, 1)
end

local function clamp_seek_target(target)
  local duration = mp.get_property_number('duration')
  if duration and duration > 0 then target = math.min(duration, target) end
  return math.max(0, target)
end

local function seek_absolute(target, flags)
  seek_anchor = clamp_seek_target(target)
  mp.commandv('seek', tostring(seek_anchor), flags)
end

local function finish_held_seek(commit)
  local target = seek_acceleration.target
  local repeated = seek_acceleration.repeated
  if seek_acceleration.timer then seek_acceleration.timer:kill() end
  seek_acceleration.timer = nil
  seek_acceleration.target = nil
  seek_acceleration.key = nil
  seek_acceleration.direction = 0
  seek_acceleration.repeated = false
  seek_acceleration.generation = seek_acceleration.generation + 1
  if commit and repeated and target then
    seek_absolute(target, 'absolute+exact')
  end
end

local function seek_relative(seconds)
  local target = seek_acceleration.target or seek_anchor or mp.get_property_number('time-pos', 0)
  finish_held_seek(false)
  seek_absolute(target + seconds, 'absolute+exact')
end

local function seek_percentage(fraction)
  local duration = mp.get_property_number('duration')
  if not duration or duration <= 0 or duration ~= duration or duration == math.huge then return end
  finish_held_seek(false)
  seek_absolute(duration * fraction, 'absolute+exact')
end

local function accelerated_seek_relative(direction, key, event)
  local kind = event and event.event or 'press'
  if kind == 'up' or (event and event.canceled) then
    if seek_acceleration.key == key then finish_held_seek(true) end
    return
  end
  if kind == 'press' then seek_relative(direction * seek_step); return end
  if kind == 'repeat' and seek_acceleration.key ~= key then return end
  local now = mp.get_time()
  if kind == 'down' then
    local origin = seek_acceleration.target or seek_anchor or mp.get_property_number('time-pos', 0)
    finish_held_seek(false)
    seek_acceleration.direction = direction
    seek_acceleration.key = key
    seek_acceleration.started_at = now
    seek_acceleration.target = clamp_seek_target(origin + direction * seek_step)
    -- A single tap uses the configured interval and remains immediate and precise.
    seek_absolute(seek_acceleration.target, 'absolute+exact')
    return
  end
  if kind ~= 'repeat' then return end
  local elapsed = math.max(0, now - seek_acceleration.started_at)
  local ratio = math.min(1, math.max(0, elapsed - 0.25) / 1.75)
  local step = 0.1 + (5 - 0.1) * ratio
  seek_acceleration.target = clamp_seek_target(seek_acceleration.target + direction * step)
  seek_acceleration.repeated = true
  if not seek_acceleration.timer then
    local generation = seek_acceleration.generation
    -- Coalesce repeats against the intended target, not a stale decoded frame.
    -- Fast keyframe previews avoid decoding a whole GOP for every key repeat.
    seek_acceleration.timer = mp.add_timeout(seek_interval, function()
      if seek_acceleration.generation ~= generation then return end
      seek_acceleration.timer = nil
      if seek_acceleration.target then
        seek_absolute(seek_acceleration.target, 'absolute+keyframes')
      end
    end)
  end
end

local function adjust_volume(delta)
  local current = mp.get_property_number('volume', 100)
  local next = math.max(0, math.min(100, current + delta))
  mp.set_property_number('volume', next)
  mp.osd_message(string.format('Volume %d%%', math.floor(next + 0.5)), 1)
end

local function toggle_pause()
  local paused = mp.get_property_native('pause')
  mp.set_property_native('pause', not paused)
  if paused then
    mp.osd_message('Playback resumed', 1)
  else
    mp.osd_message('Playback paused', 1)
  end
end

local function emit_named(event_type)
  emit(event_type)
end

mp.add_periodic_timer(1, function() emit('heartbeat') end)
mp.register_event('seek', function() emit('seek') end)
mp.register_event('playback-restart', function()
  if not mp.get_property_native('seeking') then seek_anchor = nil end
  emit('seek')
end)
mp.register_event('shutdown', function() emit('heartbeat') end)
mp.register_event('file-loaded', function() finish_held_seek(false); seek_anchor = nil end)
mp.register_event('end-file', function() finish_held_seek(false); seek_anchor = nil end)
mp.register_event('shutdown', function() finish_held_seek(false); seek_anchor = nil end)
mp.observe_property('pause', 'bool', function() emit('heartbeat') end)
mp.register_script_message('darkvideomanager-seek-to', function(value)
  local target = tonumber(value)
  if not target then return end
  finish_held_seek(false)
  seek_absolute(target, 'absolute+exact')
end)

mp.add_key_binding('t', 'darkvideomanager-thumbnail', function() emit('thumbnail') end)
mp.add_key_binding('h', 'darkvideomanager-highlight', function() emit('highlight') end)
mp.add_forced_key_binding('q', 'darkvideomanager-previous-highlight', function() emit_named('previous-highlight') end, { repeatable = false })
mp.add_forced_key_binding('Q', 'darkvideomanager-previous-highlight-shift', function() emit_named('previous-highlight') end, { repeatable = false })
mp.add_forced_key_binding('e', 'darkvideomanager-next-highlight', function() emit_named('next-highlight') end, { repeatable = false })
mp.add_forced_key_binding('E', 'darkvideomanager-next-highlight-shift', function() emit_named('next-highlight') end, { repeatable = false })
mp.add_forced_key_binding('s', 'darkvideomanager-save-highlight', function() emit_named('save-highlight') end, { repeatable = false })
mp.add_forced_key_binding('f', 'darkvideomanager-set-thumbnail', function() emit_named('set-thumbnail') end, { repeatable = false })
mp.add_forced_key_binding('SPACE', 'darkvideomanager-toggle-pause', toggle_pause, { repeatable = false })
mp.add_forced_key_binding('p', 'darkvideomanager-toggle-pause-p', toggle_pause, { repeatable = false })
for digit = 0, 9 do
  local fraction = digit / 10
  mp.add_forced_key_binding(tostring(digit), 'darkvideomanager-seek-percent-' .. digit, function() seek_percentage(fraction) end, { repeatable = false })
  mp.add_forced_key_binding('KP' .. digit, 'darkvideomanager-seek-percent-keypad-' .. digit, function() seek_percentage(fraction) end, { repeatable = false })
end
mp.add_forced_key_binding('RIGHT', 'darkvideomanager-seek-forward-1', function(event) accelerated_seek_relative(1, 'RIGHT', event) end, { complex = true })
mp.add_forced_key_binding('d', 'darkvideomanager-seek-forward-1-d', function(event) accelerated_seek_relative(1, 'd', event) end, { complex = true })
mp.add_forced_key_binding('LEFT', 'darkvideomanager-seek-backward-1', function(event) accelerated_seek_relative(-1, 'LEFT', event) end, { complex = true })
mp.add_forced_key_binding('a', 'darkvideomanager-seek-backward-1-a', function(event) accelerated_seek_relative(-1, 'a', event) end, { complex = true })
mp.add_forced_key_binding('Shift+RIGHT', 'darkvideomanager-seek-forward-5', function() seek_relative(5) end, { repeatable = true })
mp.add_forced_key_binding('Shift+d', 'darkvideomanager-seek-forward-5-d', function() seek_relative(5) end, { repeatable = true })
mp.add_forced_key_binding('Shift+LEFT', 'darkvideomanager-seek-backward-5', function() seek_relative(-5) end, { repeatable = true })
mp.add_forced_key_binding('Shift+a', 'darkvideomanager-seek-backward-5-a', function() seek_relative(-5) end, { repeatable = true })
mp.add_forced_key_binding('Ctrl+RIGHT', 'darkvideomanager-seek-forward-30', function() seek_relative(30) end, { repeatable = true })
mp.add_forced_key_binding('Ctrl+d', 'darkvideomanager-seek-forward-30-d', function() seek_relative(30) end, { repeatable = true })
mp.add_forced_key_binding('Ctrl+LEFT', 'darkvideomanager-seek-backward-30', function() seek_relative(-30) end, { repeatable = true })
mp.add_forced_key_binding('Ctrl+a', 'darkvideomanager-seek-backward-30-a', function() seek_relative(-30) end, { repeatable = true })
mp.add_forced_key_binding('UP', 'darkvideomanager-volume-up', function() adjust_volume(5) end, { repeatable = true })
mp.add_forced_key_binding('DOWN', 'darkvideomanager-volume-down', function() adjust_volume(-5) end, { repeatable = true })
mp.add_key_binding('ESC', 'darkvideomanager-escape', function()
  emit('escape')
  mp.commandv('quit')
end)
    `.trim(),
    'utf8',
  )
  return scriptPath
}
function notifyHighlightChanged(webContents, videoId) {
  if (!webContents.isDestroyed()) {
    webContents.send(IPC.EVENTS.HIGHLIGHT_CHANGED, { videoId })
  }
}
function notifyNativePlayerEscape(webContents, videoId) {
  if (!webContents.isDestroyed()) {
    webContents.send(IPC.EVENTS.NATIVE_PLAYER_ESCAPE, { videoId })
  }
}
function notifyNativePlayerAction(webContents, videoId, eventType, timeSec) {
  if (webContents.isDestroyed()) return
  const actionMap = {
    'previous-highlight': 'previousHighlight',
    'next-highlight': 'nextHighlight',
    'save-highlight': 'saveHighlight',
    'set-thumbnail': 'setThumbnail',
  }
  webContents.send(IPC.EVENTS.NATIVE_PLAYER_ACTION, {
    videoId,
    action: actionMap[eventType],
    timeSec,
  })
}
function safeRemove(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true })
    }
  } catch (err2) {
    log.warn({ err: err2, filePath }, 'Failed to remove mpv runtime file')
  }
}
function sendMpvCommand(ipcPipePath, command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(ipcPipePath)
    client.setTimeout(5000, () => client.destroy(new Error('mpv IPC timed out')))
    client.on('connect', () => {
      client.write(`${JSON.stringify(command)}
`)
      client.end()
    })
    client.on('error', (error) => reject(error))
    client.on('close', () => resolve())
  })
}

export function closeAllMpvSessions() {
  for (const pending of pendingSessions.values()) {
    pending.cancelled = true
    pending.child?.kill()
  }
  pendingSessions.clear()
  for (const id of [...sessions.keys()]) closeSession(id)
}
