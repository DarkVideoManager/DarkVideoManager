// Recovered from the shipped 0.1.0 implementation and maintained as a focused service.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { withLibraryWork } from './LibraryWorkService'
import { createAbortError } from '../ffmpeg/queue'

async function checkpoint(work) {
  if (work.signal.aborted) throw createAbortError()
  work.steps++
  if (work.steps % 100 !== 0 && performance.now() - work.lastYield < 8) return
  work.onProgress?.({
    libraryId: work.libraryId,
    phase: 'preparing',
    current: work.steps,
    total: 0,
    errors: [],
  })
  await new Promise((resolve) => setImmediate(resolve))
  work.lastYield = performance.now()
  if (work.signal.aborted) throw createAbortError()
}

async function runWork(libraryId, onProgress, mutating, prepare) {
  return withLibraryWork(libraryId, async (signal) => {
    const db = getDatabase(libraryId)
    if (!db) throw new Error('Library is not open')
    if (mutating && (db.readonly || db.pragma('query_only', { simple: true })))
      throw new Error('라이브러리가 읽기 전용입니다')
    const work = { libraryId, signal, onProgress, steps: 99, lastYield: 0, writes: [] }
    await checkpoint(work)
    const result = await prepare(work)
    if (signal.aborted) throw createAbortError()
    if (mutating) {
      onProgress?.({
        libraryId,
        phase: 'applying',
        current: 0,
        total: work.writes.length,
        errors: [],
      })
      // Preparation yields freely; the final database transaction never awaits.
      db.transaction(() => {
        for (const write of work.writes) write()
      }).immediate()
    }
    onProgress?.({
      libraryId,
      phase: 'done',
      current: work.writes.length,
      total: work.writes.length,
      errors: [],
    })
    return result
  })
}

async function previewCsvImportInternal(libraryId, csvPath, work, prepared) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const rows = prepared?.rows ?? (await parseCsv(csvPath, work))
  const videos = prepared?.videos ?? new VideoRepository(db).listAll()
  await prepareMatcher(videos, work)
  const filesRows = rows.filter((row) => normalizeTable(row._table) === 'files')
  const favoriteRows = rows.filter((row) => normalizeTable(row._table) === 'favorites')
  const ratedFileRows = filesRows.filter((row) => parseStars(row.stars) !== null)
  const favoriteRowsWithStart = favoriteRows.filter((row) => parseStartMs(row.start) !== null)
  const ratingCounts = await countMatches(
    ratedFileRows.map((row) => row.filepath ?? ''),
    videos,
    work,
  )
  const favoriteCounts = await countMatches(
    favoriteRowsWithStart.map((row) => row.filepath ?? ''),
    videos,
    work,
  )
  return {
    csvPath,
    totalRows: rows.length,
    filesRows: filesRows.length,
    favoritesRows: favoriteRows.length,
    ratedFileRows: ratedFileRows.length,
    favoriteRowsWithStart: favoriteRowsWithStart.length,
    matchedRatingRows: ratingCounts.matched,
    ambiguousRatingRows: ratingCounts.ambiguous,
    unmatchedRatingRows: ratingCounts.unmatched,
    matchedFavoriteRows: favoriteCounts.matched,
    ambiguousFavoriteRows: favoriteCounts.ambiguous,
    unmatchedFavoriteRows: favoriteCounts.unmatched,
  }
}
async function importCsvDataInternal(libraryId, csvPath, options, work) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const rows = await parseCsv(csvPath, work)
  const videoRepo = new VideoRepository(db)
  const highlightRepo = new HighlightRepository(db)
  const videos = videoRepo.listAll()
  const preview = await previewCsvImportInternal(libraryId, csvPath, work, { rows, videos })
  let ratingsUpdated = 0
  let highlightsAdded = 0
  if (options.importRatings) {
    for (const row of rows) {
      await checkpoint(work)
      if (normalizeTable(row._table) !== 'files') continue
      const stars = parseStars(row.stars)
      if (stars === null) continue
      const outcome = matchVideo(row.filepath ?? '', videos)
      if (outcome.kind !== 'matched') continue
      work.writes.push(() => videoRepo.updateMeta(outcome.video.id, { rating: stars }))
      ratingsUpdated++
    }
  }
  if (options.importFavoritesAsHighlights) {
    highlightsAdded = await importFavoritesAsHighlights(rows, videos, highlightRepo, work)
  }
  return { preview, ratingsUpdated, highlightsAdded }
}
async function importFavoritesAsHighlights(rows, videos, highlightRepo, work) {
  let highlightsAdded = 0
  const existingByVideoId = /* @__PURE__ */ new Map()
  for (const row of rows) {
    await checkpoint(work)
    if (normalizeTable(row._table) !== 'favorites') continue
    const startMs = parseStartMs(row.start)
    if (startMs === null) continue
    const outcome = matchVideo(row.filepath ?? '', videos)
    if (outcome.kind !== 'matched') continue
    let existing = existingByVideoId.get(outcome.video.id)
    if (!existing) {
      existing = new Set(
        highlightRepo
          .findByVideoId(outcome.video.id)
          .map((highlight) => normalizeHighlightTime(highlight.timeStart)),
      )
      existingByVideoId.set(outcome.video.id, existing)
    }
    const timeStartSec = startMs / 1e3
    const normalized = normalizeHighlightTime(timeStartSec)
    if (existing.has(normalized)) continue
    work.writes.push(() =>
      highlightRepo.insert({
        id: crypto.randomUUID(),
        videoId: outcome.video.id,
        timeStart: timeStartSec,
        label: 'Imported favorite',
        color: 'yellow',
        createdAt: /* @__PURE__ */ new Date().toISOString(),
      }),
    )
    existing.add(normalized)
    highlightsAdded++
  }
  return highlightsAdded
}
async function parseCsv(csvPath, work) {
  const content = (await fs.promises.readFile(csvPath, 'utf8')).replace(/^\uFEFF/, '')
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return []
  const headers = parseCsvLine(lines[0])
  const rows = []
  for (const line of lines.slice(1)) {
    await checkpoint(work)
    const cells = parseCsvLine(line)
    const row = {}
    for (let index = 0; index < headers.length; index++) {
      row[headers[index]] = cells[index] ?? ''
    }
    rows.push(row)
  }
  return rows
}
function parseCsvLine(line) {
  const values = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      const next = line[index + 1]
      if (inQuotes && next === '"') {
        current += '"'
        index++
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }
    current += char
  }
  values.push(current)
  return values
}
async function countMatches(importPaths, videos, work) {
  let matched = 0
  let ambiguous = 0
  let unmatched = 0
  for (const importPath of importPaths) {
    await checkpoint(work)
    const outcome = matchVideo(importPath, videos)
    if (outcome.kind === 'matched') matched++
    if (outcome.kind === 'ambiguous') ambiguous++
    if (outcome.kind === 'unmatched') unmatched++
  }
  return { matched, ambiguous, unmatched }
}
const matcherIndexes = new WeakMap()
async function prepareMatcher(videos, work) {
  if (matcherIndexes.has(videos)) return
  const index = {
    exact: new Map(),
    suffix: new Map(),
    base: new Map(),
    canonical: new Map(),
  }
  const add = (map, key, video) => {
    const values = map.get(key) ?? []
    values.push(video)
    map.set(key, values)
  }
  for (const video of videos) {
    await checkpoint(work)
    const normalized = normalizePath(video.filePath)
    add(index.exact, normalized, video)
    const segments = normalized.split('/')
    for (let i = 1; i < segments.length; i++) add(index.suffix, segments.slice(i).join('/'), video)
    add(index.base, normalizeBaseName(video.fileName), video)
    const fileNameKey = canonicalKey(video.fileName)
    add(index.canonical, fileNameKey, video)
  }
  matcherIndexes.set(videos, index)
}
function matchVideo(importPath, videos) {
  const normalizedImportPath = normalizePath(importPath)
  if (!normalizedImportPath) return { kind: 'unmatched' }
  const index = matcherIndexes.get(videos)
  const exactMatches = index.exact.get(normalizedImportPath) ?? []
  if (exactMatches.length === 1) return { kind: 'matched', video: exactMatches[0] }
  if (exactMatches.length > 1) return { kind: 'ambiguous', candidates: exactMatches }
  const suffixMatches = index.suffix.get(normalizedImportPath) ?? []
  if (suffixMatches.length === 1) return { kind: 'matched', video: suffixMatches[0] }
  if (suffixMatches.length > 1) return { kind: 'ambiguous', candidates: suffixMatches }
  const importBaseName = normalizeBaseName(importPath)
  if (!importBaseName) return { kind: 'unmatched' }
  const baseNameMatches = index.base.get(importBaseName) ?? []
  if (baseNameMatches.length === 1) return { kind: 'matched', video: baseNameMatches[0] }
  if (baseNameMatches.length > 1) return { kind: 'ambiguous', candidates: baseNameMatches }
  const canonicalName = canonicalKey(importBaseName)
  const canonicalMatches = index.canonical.get(canonicalName) ?? []
  if (canonicalMatches.length === 1) return { kind: 'matched', video: canonicalMatches[0] }
  if (canonicalMatches.length > 1) return { kind: 'ambiguous', candidates: canonicalMatches }
  return { kind: 'unmatched' }
}
function normalizeTable(value) {
  return (value ?? '').trim().toLowerCase()
}
function parseStars(value) {
  const parsed = Number.parseFloat((value ?? '').trim())
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? Math.round(parsed) : null
}
function parseStartMs(value) {
  const parsed = Number.parseFloat((value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : null
}
function normalizePath(filePath) {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase()
}
function normalizeBaseName(filePath) {
  return path.basename(filePath).trim().toLowerCase()
}
function normalizeHighlightTime(timeStartSec) {
  return Math.round(timeStartSec * 10)
}
function canonicalKey(value) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[[\]()\-_.\s]+/g, '')
    .replace(/[^0-9a-z\uac00-\ud7a3]/g, '')
}

export function previewCsvImport(libraryId, csvPath, onProgress) {
  return runWork(libraryId, onProgress, false, (work) =>
    previewCsvImportInternal(libraryId, csvPath, work),
  )
}
export function importCsvData(libraryId, csvPath, options, onProgress) {
  return runWork(libraryId, onProgress, true, (work) =>
    importCsvDataInternal(libraryId, csvPath, options, work),
  )
}
