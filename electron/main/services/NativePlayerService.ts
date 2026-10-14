import fs from 'node:fs'
import path from 'node:path'
import childProcess, { type ChildProcess } from 'node:child_process'
import type { NativePlayerInfo, NativePlayerOptions } from '@shared/types'
import { loadConfig } from '../infra/config'
import { createLogger } from '../infra/logger'

const log = createLogger('native-player')
// Whitelisted hardware decoding with mpv's normal software fallback. auto-safe
// also supports older mpv builds; leave the renderer/context at their defaults.
// https://mpv.io/manual/stable/#options-hwdec
export const MPV_HARDWARE_DECODING_ARGS = ['--hwdec=auto-safe'] as const
const CANDIDATES: Array<{ name: NativePlayerInfo['name']; paths: string[] }> = [
  {
    name: 'mpv',
    paths: [
      'C:\\Program Files\\MPV Player\\mpv.exe',
      'C:\\Program Files\\mpv\\mpv.exe',
      'C:\\mpv\\mpv.exe',
    ],
  },
  {
    name: 'ffplay',
    paths: [
      'C:\\Program Files\\TheDeepDarkVideoManager_Falcon\\ffmpeg-lgpl-builds-x64\\ffplay.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffplay.exe',
      'C:\\ffmpeg\\bin\\ffplay.exe',
    ],
  },
  {
    name: 'vlc',
    paths: [
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    ],
  },
]

export async function validateNativePlayer(info: NativePlayerInfo): Promise<NativePlayerInfo> {
  if (
    !info ||
    !['mpv', 'ffplay', 'vlc'].includes(info.name) ||
    typeof info.path !== 'string' ||
    !path.isAbsolute(info.path)
  ) {
    throw new Error('외부 플레이어 이름과 실행 파일의 절대 경로를 확인해 주세요.')
  }
  if (process.platform === 'win32' && path.extname(info.path).toLowerCase() !== '.exe') {
    throw new Error('외부 플레이어는 .exe 실행 파일을 선택해 주세요.')
  }
  try {
    const stat = await fs.promises.stat(info.path)
    if (!stat.isFile()) throw new Error('일반 실행 파일이 아닙니다.')
    await fs.promises.access(
      info.path,
      process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK,
    )
    return { name: info.name, path: await fs.promises.realpath(info.path) }
  } catch (error) {
    throw new Error(
      '외부 플레이어 실행 파일을 사용할 수 없습니다: ' +
        info.path +
        '. 설정에서 경로를 다시 선택해 주세요.',
      { cause: error },
    )
  }
}

/** Check fixed locations and all PATH entries for each player before the next kind. */
export async function discoverNativePlayers(): Promise<NativePlayerInfo[]> {
  const pathDirectories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const discovered: NativePlayerInfo[] = []
  const seen = new Set<string>()
  for (const candidate of CANDIDATES) {
    const fileName = candidate.name + (process.platform === 'win32' ? '.exe' : '')
    const candidates = [
      ...(process.platform === 'win32' ? candidate.paths : []),
      ...pathDirectories.map((directory) => path.join(directory, fileName)),
    ]
    for (const candidatePath of candidates) {
      try {
        const player = await validateNativePlayer({ name: candidate.name, path: candidatePath })
        const key = process.platform === 'win32' ? player.path.toLowerCase() : player.path
        if (!seen.has(key)) {
          discovered.push(player)
          seen.add(key)
        }
      } catch {
        // Missing/non-executable search candidates are expected. A saved manual
        // selection is validated separately and must never silently fall back.
      }
    }
  }
  return discovered
}

export async function findNativePlayer(): Promise<NativePlayerInfo | null> {
  const selected = loadConfig().nativePlayer
  if (selected) return validateNativePlayer(selected)
  return (await discoverNativePlayers())[0] ?? null
}

/** Shared by mpv's tracked session and ordinary ffplay/VLC launches. */
export function spawnNativePlayerProcess(
  playerPath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): { child: ChildProcess; ready: Promise<void> } {
  const child = childProcess.spawn(playerPath, args, {
    cwd: path.dirname(playerPath),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
    ...options,
  })
  let stderr = ''
  let settled = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(new Error('플레이어 프로세스 시작 응답 시간이 초과되었습니다.'))
      if (!child.killed) child.kill()
    }, 5000)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (graceTimer) clearTimeout(graceTimer)
      if (error) reject(error)
      else resolve()
    }
    const fail = (error: Error): void => {
      const details = stderr.trim()
      finish(
        new Error(
          '외부 플레이어를 실행하지 못했습니다: ' +
            playerPath +
            '\n' +
            error.message +
            (details ? '\n' + details : ''),
          { cause: error },
        ),
      )
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (!settled) stderr = (stderr + chunk.toString()).slice(-8192)
    })
    child.once('spawn', () => {
      graceTimer = setTimeout(() => finish(), 500)
    })
    child.on('error', (error) => {
      if (settled) log.error({ error, playerPath }, 'Native player process error')
      else fail(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      if (code === 0 && !signal) finish()
      else
        fail(
          new Error(
            signal ? '프로세스가 신호로 종료되었습니다: ' + signal : '프로세스 종료 코드: ' + code,
          ),
        )
    })
  })
  return { child, ready }
}

export async function openInNativePlayer(
  filePath: string,
  options: NativePlayerOptions = {},
  selectedPlayer?: NativePlayerInfo,
): Promise<NativePlayerInfo> {
  const player = selectedPlayer
    ? await validateNativePlayer(selectedPlayer)
    : await findNativePlayer()
  if (!player)
    throw new Error(
      '외부 플레이어를 찾을 수 없습니다. 설정에서 mpv, ffplay 또는 VLC 경로를 선택해 주세요.',
    )
  const { child, ready } = spawnNativePlayerProcess(
    player.path,
    buildArgs(player.name, filePath, options),
  )
  await ready
  child.unref()
  log.info({ player, filePath, options }, 'Opened video in native player')
  return player
}

function finiteNumber(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function buildArgs(
  playerName: NativePlayerInfo['name'],
  filePath: string,
  options: NativePlayerOptions,
): string[] {
  const start = Math.max(0, Math.floor(finiteNumber(options.startTimeSec)))
  const width = Math.max(320, Math.floor(finiteNumber(options.width, 960)))
  const height = Math.max(240, Math.floor(finiteNumber(options.height, 540)))
  const x = options.x !== undefined ? Math.floor(finiteNumber(options.x)) : undefined
  const y = options.y !== undefined ? Math.floor(finiteNumber(options.y)) : undefined
  switch (playerName) {
    case 'ffplay':
      return [
        '-window_title',
        'DarkVideoManager FFplay',
        ...(start > 0 ? ['-ss', String(start)] : []),
        filePath,
      ]
    case 'mpv':
      return [
        ...MPV_HARDWARE_DECODING_ARGS,
        '--force-window=yes',
        '--autofit-larger=100%x100%',
        `--autofit=${width}x${height}`,
        ...(x !== undefined && y !== undefined
          ? [`--geometry=${width}x${height}${x >= 0 ? '+' : ''}${x}${y >= 0 ? '+' : ''}${y}`]
          : []),
        ...(start > 0 ? [`--start=${start}`] : []),
        '--',
        filePath,
      ]
    case 'vlc':
      return [...(start > 0 ? [`--start-time=${start}`] : []), '--', filePath]
  }
}
