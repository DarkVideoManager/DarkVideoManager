import { resolve, normalize, join } from 'path'
import { stat, access } from 'fs/promises'
import { constants } from 'fs'

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.mts',
  '.m2ts', '.vob', '.ogv', '.3gp', '.3g2', '.rmvb',
  '.rm', '.divx', '.xvid', '.asf',
])

export function safePath(basePath: string, ...parts: string[]): string {
  const base = resolve(normalize(basePath))
  const target = resolve(normalize(join(basePath, ...parts)))
  if (!target.startsWith(base + '\\') && target !== base) {
    throw new Error(`경로 이탈 감지: ${target}`)
  }
  return target
}

export function isVideoFile(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf('.')
  if (dotIdx === -1) return false
  return VIDEO_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase())
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size
}
