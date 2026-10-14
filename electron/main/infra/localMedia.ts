import { protocol } from 'electron'
import { statSync, createReadStream, realpathSync } from 'fs'
import { relative, isAbsolute, extname } from 'path'
import { Readable } from 'stream'
import { getUserDataPath } from './paths'
import { loadConfig } from './config'
import { getDatabase } from '../db/connection'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-media',
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size <= 0 || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
      return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

const contentTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
}

function isInside(filePath: string, rootPath: string): boolean {
  const child = relative(rootPath, filePath)
  return (
    child !== '..' && !child.startsWith('..\\') && !child.startsWith('../') && !isAbsolute(child)
  )
}

function allowedMediaPath(filePath: string): boolean {
  const target = realpathSync(filePath)
  for (const root of [getUserDataPath('thumbnails'), getUserDataPath('playback-proxies')]) {
    try {
      if (isInside(target, realpathSync(root))) return true
    } catch {
      /* cache not yet created */
    }
  }
  for (const library of loadConfig().libraries) {
    const db = getDatabase(library.id)
    if (!db) continue
    if (
      db
        .prepare(
          'SELECT 1 FROM videos WHERE file_path = ? COLLATE NOCASE UNION SELECT 1 FROM subtitles WHERE file_path = ? COLLATE NOCASE LIMIT 1',
        )
        .get(filePath, filePath)
    )
      return true
  }
  return false
}

export function createMediaResponse(
  request: Request,
  authorize: (filePath: string) => boolean = allowedMediaPath,
): Response {
  try {
    const filePath = new URL(request.url).searchParams.get('path')
    if (!filePath) return new Response('Missing path', { status: 400 })
    if (!authorize(filePath)) return new Response('Forbidden', { status: 403 })
    const stat = statSync(filePath)
    if (!stat.isFile()) return new Response('Not a file', { status: 404 })
    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      'content-type': contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
    }
    const rangeHeader = request.headers.get('range')
    let range: { start: number; end: number } | undefined
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, stat.size)
      if (!parsed)
        return new Response(null, {
          status: 416,
          headers: { 'content-range': 'bytes */' + stat.size },
        })
      range = parsed
      headers['content-range'] = 'bytes ' + range.start + '-' + range.end + '/' + stat.size
      headers['content-length'] = String(range.end - range.start + 1)
    }
    if (request.method === 'HEAD' || stat.size === 0)
      return new Response(null, { status: range ? 206 : 200, headers })
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const body = Readable.toWeb(createReadStream(filePath, range)) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(code === 'ENOENT' ? 'Not found' : 'Unable to read media', {
      status: code === 'ENOENT' ? 404 : 500,
    })
  }
}

export function registerLocalMediaProtocol(): void {
  protocol.handle('local-media', (request) => createMediaResponse(request))
}
