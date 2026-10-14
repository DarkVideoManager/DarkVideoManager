import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { randomUUID, createHash } from 'crypto'
import type { Database } from 'better-sqlite3'
import type { Subtitle } from '@shared/types'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { join, dirname, basename, extname, resolve } from 'path'
import { mkdirSync } from 'fs'
import * as chardet from 'chardet'
import * as iconv from 'iconv-lite'
import { createLogger } from '../infra/logger'
import { isVideoFile } from '../infra/fs'

const log = createLogger('SubtitleService')

/** SMI → VTT 변환 */
export function convertSmiToVtt(smiPath: string, outputDir?: string): string {
  const raw = readFileSmart(smiPath)
  const vtt = parseSmiToVtt(raw)
  const outPath = outputDir
    ? join(outputDir, subtitleCacheName(smiPath))
    : smiPath.replace(/\.smi$/i, '.vtt')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, vtt, 'utf-8')
  log.info({ smiPath, outPath }, 'SMI → VTT 변환 완료')
  return outPath
}

/** SRT → VTT 변환 */
export function convertSrtToVtt(srtPath: string, outputDir?: string): string {
  const raw = readFileSmart(srtPath)
  const vtt = 'WEBVTT\n\n' + raw.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  const outPath = outputDir
    ? join(outputDir, subtitleCacheName(srtPath))
    : srtPath.replace(/\.srt$/i, '.vtt')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, vtt, 'utf-8')
  return outPath
}

/** 파일 인코딩 자동 감지 후 UTF-8 문자열 반환 */
export function readFileSmart(filePath: string): string {
  const buf = readFileSync(filePath)
  const detected = chardet.detect(buf) ?? 'UTF-8'
  // 한국어 파일의 경우 EUC-KR / CP949가 자주 오탐되므로 iconv-lite로 디코딩
  const encoding = normalizeEncoding(detected)
  try {
    return iconv.decode(buf, encoding)
  } catch {
    return buf.toString('utf-8')
  }
}

function normalizeEncoding(detected: string): string {
  const upper = detected.toUpperCase()
  if (upper.includes('EUC-KR') || upper.includes('KSC') || upper === 'CP949') return 'CP949'
  if (upper.includes('UTF-8') || upper.includes('UTF8')) return 'UTF-8'
  if (upper.includes('UTF-16')) return 'UTF-16'
  return detected
}

/** SMI 파서 */
function parseSmiToVtt(smi: string): string {
  const lines: string[] = ['WEBVTT', '']

  // SAMI 태그 제거 (스타일, SAMI 태그 등)
  const bodyMatch = smi.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const body = bodyMatch ? bodyMatch[1] : smi

  const syncPattern = /<sync\s+start\s*=\s*['""]?(\d+)['""]?[^>]*>([\s\S]*?)(?=<sync|$)/gi
  let match: RegExpExecArray | null
  const entries: Array<{ start: number; text: string }> = []

  while ((match = syncPattern.exec(body)) !== null) {
    const start = parseInt(match[1], 10)
    const rawText = match[2]
      .replace(/<P[^>]*>/gi, '')
      .replace(/<\/P>/gi, '')
      .replace(/<BR\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim()
    entries.push({ start, text: rawText })
  }

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i]
    const next = entries[i + 1]
    if (!cur.text) continue
    const startVtt = msToVttTime(cur.start)
    const endVtt = msToVttTime(next ? next.start : cur.start + 3000)
    lines.push(`${startVtt} --> ${endVtt}`)
    lines.push(cur.text)
    lines.push('')
  }

  return lines.join('\n')
}

function msToVttTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const msRem = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msRem).padStart(3, '0')}`
}

function subtitleCacheName(filePath: string): string {
  const hash = createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 16)
  return basename(filePath, extname(filePath)) + '-' + hash + '.vtt'
}

export const subtitleExtensions = new Set(['.srt', '.vtt', '.ass', '.smi'])
export type SidecarSubtitle = Pick<Subtitle, 'filePath' | 'type' | 'lang'>

function subtitlePathKey(filePath: string): string {
  const normalized = resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The full directory and stem prevent subtitles from matching neighboring videos. */
export function subtitleVideoKey(filePath: string): string {
  return subtitlePathKey(filePath.slice(0, -extname(filePath).length))
}

export function matchSidecarSubtitle(
  filePath: string,
  videoKeys: ReadonlySet<string>,
): { videoKey: string; subtitle: SidecarSubtitle } | undefined {
  const extension = extname(filePath).toLowerCase()
  if (!subtitleExtensions.has(extension)) return undefined
  const key = subtitleVideoKey(filePath)
  const subtitle: SidecarSubtitle = { filePath, type: extension.slice(1) as Subtitle['type'] }
  // A video named movie.ai.ko.mp4 owns movie.ai.ko.srt, even if movie.mp4 exists.
  if (videoKeys.has(key)) return { videoKey: key, subtitle }
  const generated = key.match(/^(.+)\.ai(?:\.([1-9]\d*))?(\.ko)?$/i)
  if (!generated || !videoKeys.has(generated[1])) return undefined
  if (generated[3]) subtitle.lang = 'ko'
  return { videoKey: generated[1], subtitle }
}

/** Retain detected language, identity and embedded tracks when a directory is rescanned. */
export function syncSidecarSubtitleSnapshot(
  db: Database,
  videoId: string,
  desired: SidecarSubtitle[],
): Subtitle[] {
  const repository = new SubtitleRepository(db)
  const existing = repository.findByVideoId(videoId)
  const byPath = new Map(
    existing
      .filter((subtitle) => !subtitle.isEmbedded)
      .map((subtitle) => [subtitlePathKey(subtitle.filePath), subtitle]),
  )
  const subtitles = desired.map((subtitle): Subtitle => {
    const saved = byPath.get(subtitlePathKey(subtitle.filePath))
    return {
      ...saved,
      ...subtitle,
      lang: subtitle.lang ?? saved?.lang,
      id: saved?.id ?? randomUUID(),
      videoId,
      isEmbedded: false,
    }
  })
  if (db.readonly) return existing
  const desiredPaths = new Set(subtitles.map((subtitle) => subtitlePathKey(subtitle.filePath)))
  db.transaction(() => {
    for (const subtitle of existing) {
      if (!subtitle.isEmbedded && !desiredPaths.has(subtitlePathKey(subtitle.filePath)))
        repository.delete(subtitle.id)
    }
    for (const subtitle of subtitles) {
      const saved = byPath.get(subtitlePathKey(subtitle.filePath))
      if (
        !saved ||
        saved.lang !== subtitle.lang ||
        saved.filePath !== subtitle.filePath ||
        saved.type !== subtitle.type
      )
        repository.insert(subtitle)
    }
  })()
  return [...subtitles, ...existing.filter((subtitle) => subtitle.isEmbedded)].sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  )
}

export function syncSidecarSubtitlesForVideo(
  db: Database,
  videoId: string,
  videoPath: string,
): Subtitle[] {
  const directory = dirname(videoPath)
  // Read first: a disconnected directory must not erase existing subtitle metadata.
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
  const videoKeys = new Set(files.filter(isVideoFile).map(subtitleVideoKey))
  const videoKey = subtitleVideoKey(videoPath)
  videoKeys.add(videoKey)
  const subtitles = files.flatMap((filePath) => {
    const match = matchSidecarSubtitle(filePath, videoKeys)
    return match?.videoKey === videoKey ? [match.subtitle] : []
  })
  return syncSidecarSubtitleSnapshot(db, videoId, subtitles)
}
