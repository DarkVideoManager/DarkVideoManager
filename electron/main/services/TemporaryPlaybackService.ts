import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { isVideoFile } from '../infra/fs'

export interface TemporaryPlayback {
  token: string
  fileName: string
  sourceUrl: string
}

const sessions = new Map<number, { token: string; path: string }>()

function localPath(path: string): boolean {
  // Windows device paths, UNC shares, URLs and alternate data streams are not local media.
  return (
    isAbsolute(path) &&
    !/^[\\/]{2}/.test(path) &&
    !path.includes('\0') &&
    !path.slice(2).includes(':')
  )
}

export function openTemporaryPlayback(owner: number, filePath: string): TemporaryPlayback {
  if (!localPath(filePath) || !isVideoFile(filePath))
    throw new Error('로컬 영상 파일 하나를 놓아 주세요. 폴더와 URL은 열 수 없습니다.')
  let canonical: string
  try {
    canonical = realpathSync(filePath)
    if (!localPath(canonical) || !isVideoFile(canonical) || !statSync(canonical).isFile())
      throw new Error('invalid media')
  } catch {
    throw new Error('영상 파일을 찾거나 읽을 수 없습니다. 파일 위치를 확인해 주세요.')
  }
  const token = randomUUID()
  sessions.set(owner, { token, path: canonical })
  return {
    token,
    fileName: basename(canonical),
    sourceUrl: `local-media://file?path=${encodeURIComponent(canonical)}&temporary=${token}`,
  }
}

export function isTemporaryMediaAllowed(filePath: string, token: string): boolean {
  const session = [...sessions.values()].find((value) => value.token === token)
  if (!session || session.path !== filePath) return false
  // A renamed target or replaced symlink must not expand the grant.
  try {
    return realpathSync(filePath) === session.path && statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function closeTemporaryPlayback(owner: number, token?: string): void {
  if (!token || sessions.get(owner)?.token === token) sessions.delete(owner)
}
