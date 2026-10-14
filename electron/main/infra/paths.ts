import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

export function getUserDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

export function getLibsDir(): string {
  const dir = getUserDataPath('libs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getThumbnailsDir(libraryId: string): string {
  const dir = getUserDataPath('thumbnails', libraryId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getLogsDir(): string {
  const dir = getUserDataPath('logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getConfigPath(): string {
  return getUserDataPath('config.json')
}

export function getLibDbPath(libraryId: string): string {
  return join(getLibsDir(), `${libraryId}.db`)
}

export function ensureDirectories(): void {
  getLibsDir()
  getLogsDir()
  getUserDataPath() // userData root
}

export function getPlaybackProxyDir(libraryId: string): string {
  const dir = getUserDataPath('playback-proxies', libraryId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getNativePlayerDir(): string {
  const dir = getUserDataPath('native-player')
  mkdirSync(dir, { recursive: true })
  return dir
}
