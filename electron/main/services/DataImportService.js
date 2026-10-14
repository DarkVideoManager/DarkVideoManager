// Recovered from the shipped 0.1.0 implementation and maintained as a focused service.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { HighlightRepository } from '../db/repositories/HighlightRepository'
import { ThumbnailRepository } from '../db/repositories/ThumbnailRepository'
import { getThumbnailsDir } from '../infra/paths'
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
    const work = { libraryId, signal, onProgress, steps: 99, lastYield: 0, writes: [], files: [] }
    let committed = false
    try {
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
      committed = true
      onProgress?.({
        libraryId,
        phase: 'done',
        current: work.writes.length,
        total: work.writes.length,
        errors: [],
      })
      return result
    } finally {
      if (!committed) {
        for (const file of work.files) {
          try {
            await fs.promises.unlink(file)
          } catch {
            /* only this operation's new UUID files */
          }
        }
      }
    }
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
async function prepareDeepDark(libraryId, dbPath, work, keepOpen = false) {
  const sourceDb = openExternalDb(dbPath)
  let prepared = false
  try {
    sourceDb.exec('BEGIN')
    const filesRows = await readRows(
      sourceDb,
      'SELECT uid, filepath, dvdId, stars, fileDate, playDate, hashTag, count, CASE WHEN thumb IS NULL THEN NULL ELSE 1 END AS thumb FROM Files ORDER BY uid ASC',
      work,
    )
    const favoriteRows = await readRows(
      sourceDb,
      'SELECT uid, filepath, start, length, CASE WHEN thumb IS NULL THEN NULL ELSE 1 END AS thumb FROM Favorites ORDER BY uid ASC',
      work,
    )
    const dvdRows = await readRows(
      sourceDb,
      'SELECT dvdId, dvdTitle, actors, genres, releaseDate FROM Dvd ORDER BY dvdId ASC',
      work,
    )
    const videos = new VideoRepository(getDatabase(libraryId)).listAll()
    await prepareMatcher(videos, work)
    prepared = true
    return { filesRows, favoriteRows, dvdRows, videos, sourceDb }
  } finally {
    if (!keepOpen || !prepared) sourceDb.close()
  }
}

async function readRows(db, sql, work) {
  const rows = []
  for (const row of db.prepare(sql).iterate()) {
    rows.push(row)
    await checkpoint(work)
  }
  return rows
}

async function previewDeepDarkDbImportInternal(libraryId, dbPath, work, prepared) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const { filesRows, favoriteRows, dvdRows, videos } =
    prepared ?? (await prepareDeepDark(libraryId, dbPath, work))
  const dvdMap = new Map(dvdRows.map((row) => [row.dvdId, row]))
  const fileCounts = await countDeepDarkFileMatches(filesRows, videos, dvdMap, work)
  const favoriteCounts = await countMatches(
    favoriteRows.filter((row) => row.start !== null).map((row) => row.filepath),
    videos,
    work,
  )
  return {
    dbPath,
    filesRows: filesRows.length,
    favoritesRows: favoriteRows.length,
    dvdRows: dvdRows.length,
    filesWithThumb: filesRows.filter((row) => row.thumb !== null).length,
    favoritesWithThumb: favoriteRows.filter((row) => row.thumb !== null).length,
    matchedFilesRows: fileCounts.matched,
    ambiguousFilesRows: fileCounts.ambiguous,
    unmatchedFilesRows: fileCounts.unmatched,
    matchedFavoriteRows: favoriteCounts.matched,
    ambiguousFavoriteRows: favoriteCounts.ambiguous,
    unmatchedFavoriteRows: favoriteCounts.unmatched,
    ambiguousFilesSample: fileCounts.ambiguousSample,
    unmatchedFilesSample: fileCounts.unmatchedSample,
    ambiguousFavoriteSample: favoriteCounts.ambiguousSample,
    unmatchedFavoriteSample: favoriteCounts.unmatchedSample,
    matchingRules: [
      'Exact full path match',
      'Suffix path match for relative paths',
      'Exact basename match',
      'Canonical basename match that ignores punctuation and spacing',
      'deepdark dvdId match against current file name/title',
      'deepdark dvdTitle fuzzy match against current file title/name',
    ],
  }
}
async function importDeepDarkDbDataInternal(libraryId, dbPath, options, work) {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('Library is not open')
  const prepared = await prepareDeepDark(libraryId, dbPath, work, true)
  try {
    const preview = await previewDeepDarkDbImportInternal(libraryId, dbPath, work, prepared)
    const videoRepo = new VideoRepository(db)
    const highlightRepo = new HighlightRepository(db)
    const thumbnailRepo = new ThumbnailRepository(db)
    const videos = prepared.videos
    let ratingsUpdated = 0
    let highlightsAdded = 0
    let thumbnailsImported = 0
    let metadataUpdated = 0
    const { filesRows, favoriteRows, dvdRows } = prepared
    const dvdMap = new Map(dvdRows.map((row) => [row.dvdId, row]))
    const existingHighlightsByVideoId = /* @__PURE__ */ new Map()
    const existingThumbnailsByVideoId = /* @__PURE__ */ new Map()
    for (const file of filesRows) {
      await checkpoint(work)
      const outcome = matchDeepDarkFile(file, videos, dvdMap)
      if (outcome.kind !== 'matched') continue
      if (options.importRatings && file.stars !== null) {
        work.writes.push(() => videoRepo.updateMeta(outcome.video.id, { rating: file.stars }))
        ratingsUpdated++
      }
      if (options.importMetadata) {
        const dvd = file.dvdId ? dvdMap.get(file.dvdId) : null
        const patch = buildMetaPatch(outcome.video, file, dvd)
        if (Object.keys(patch).length > 0) {
          work.writes.push(() => videoRepo.updateMeta(outcome.video.id, patch))
          metadataUpdated++
        }
      }
      if (options.importThumbnails && file.thumb) {
        const imported = await importThumbnailBlob(
          libraryId,
          outcome.video.id,
          thumbnailRepo,
          existingThumbnailsByVideoId,
          prepared.sourceDb.prepare('SELECT thumb FROM Files WHERE uid = ?').get(file.uid).thumb,
          0,
          !hasPrimaryThumbnail(existingThumbnailsByVideoId, thumbnailRepo, outcome.video.id),
          work,
        )
        if (imported) thumbnailsImported++
      }
    }
    for (const favorite of favoriteRows) {
      await checkpoint(work)
      const outcome = matchVideo(favorite.filepath, videos)
      if (outcome.kind !== 'matched') continue
      if (options.importFavoritesAsHighlights && favorite.start !== null) {
        let existing = existingHighlightsByVideoId.get(outcome.video.id)
        if (!existing) {
          existing = new Set(
            highlightRepo
              .findByVideoId(outcome.video.id)
              .map((highlight) => normalizeHighlightTime(highlight.timeStart)),
          )
          existingHighlightsByVideoId.set(outcome.video.id, existing)
        }
        const timeStartSec = favorite.start / 1e3
        const normalized = normalizeHighlightTime(timeStartSec)
        if (!existing.has(normalized)) {
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
      }
      if (options.importThumbnails && favorite.thumb && favorite.start !== null) {
        const imported = await importThumbnailBlob(
          libraryId,
          outcome.video.id,
          thumbnailRepo,
          existingThumbnailsByVideoId,
          prepared.sourceDb.prepare('SELECT thumb FROM Favorites WHERE uid = ?').get(favorite.uid)
            .thumb,
          favorite.start / 1e3,
          !hasPrimaryThumbnail(existingThumbnailsByVideoId, thumbnailRepo, outcome.video.id),
          work,
        )
        if (imported) thumbnailsImported++
      }
    }
    return {
      preview,
      ratingsUpdated,
      highlightsAdded,
      thumbnailsImported,
      metadataUpdated,
    }
  } finally {
    prepared.sourceDb.close()
  }
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
function buildMetaPatch(video, file, dvd) {
  const title = dvd?.dvdTitle?.trim() || void 0
  const tags = buildTags(file, dvd)
  const memo = buildMemo(dvd)
  const lastPlayedAt = normalizeImportedDate(file.playDate)
  const playCount = normalizePlayCount(file.count)
  const patch = {}
  if (title && title !== video.title) patch.title = title
  if (tags && tags !== video.tags) patch.tags = tags
  if (memo && memo !== video.memo) patch.memo = memo
  if (lastPlayedAt && lastPlayedAt !== video.lastPlayedAt) patch.lastPlayedAt = lastPlayedAt
  if (playCount !== video.playCount) patch.playCount = playCount
  return patch
}
function buildTags(file, dvd) {
  const tags = /* @__PURE__ */ new Map()
  for (const value of [file.hashTag, dvd?.genres, dvd?.actors]) {
    for (const tag of splitTags(value)) {
      const key = canonicalKey(tag)
      if (!key || tags.has(key)) continue
      tags.set(key, tag)
    }
  }
  return Array.from(tags.values()).join(', ')
}
function buildMemo(dvd) {
  const memoParts = []
  if (dvd?.actors?.trim()) memoParts.push(`Actors: ${dvd.actors.trim()}`)
  if (dvd?.genres?.trim()) memoParts.push(`Genres: ${dvd.genres.trim()}`)
  if (dvd?.releaseDate?.trim()) memoParts.push(`Release date: ${dvd.releaseDate.trim()}`)
  return memoParts.join('\n')
}
async function importThumbnailBlob(
  libraryId,
  videoId,
  thumbnailRepo,
  existingByVideoId,
  blob,
  timeSec,
  makePrimary,
  work,
) {
  let existing = existingByVideoId.get(videoId)
  if (!existing) {
    existing = thumbnailRepo.findByVideoId(videoId)
    existingByVideoId.set(videoId, existing)
  }
  if (existing.some((thumbnail) => Math.abs(thumbnail.timeSec - timeSec) < 0.05)) {
    return false
  }
  const extension = detectImageExtension(blob)
  const filePath = path.join(
    getThumbnailsDir(libraryId),
    `${videoId}-${Date.now()}-${crypto.randomUUID()}.${extension}`,
  )
  work.files.push(filePath)
  await fs.promises.writeFile(filePath, blob, { flag: 'wx' })
  await checkpoint(work)
  const id = crypto.randomUUID()
  if (makePrimary || existing.length === 0) {
    // insert/setPrimary atomically maintain the primary thumbnail
  }
  work.writes.push(() =>
    thumbnailRepo.insert({
      id,
      videoId,
      filePath,
      timeSec,
      isPrimary: makePrimary || existing.length === 0,
    }),
  )
  if (makePrimary || existing.length === 0) {
    work.writes.push(() => thumbnailRepo.setPrimary(id, videoId))
  }
  existing.push({
    id,
    videoId,
    filePath,
    timeSec,
    isPrimary: makePrimary || existing.length === 0,
    createdAt: /* @__PURE__ */ new Date().toISOString(),
  })
  return true
}
function hasPrimaryThumbnail(existingByVideoId, thumbnailRepo, videoId) {
  let existing = existingByVideoId.get(videoId)
  if (!existing) {
    existing = thumbnailRepo.findByVideoId(videoId)
    existingByVideoId.set(videoId, existing)
  }
  return existing.some((thumbnail) => thumbnail.isPrimary)
}
function detectImageExtension(blob) {
  if (blob.length >= 4 && blob[0] === 137 && blob[1] === 80 && blob[2] === 78 && blob[3] === 71) {
    return 'png'
  }
  if (blob.length >= 3 && blob[0] === 255 && blob[1] === 216 && blob[2] === 255) {
    return 'jpg'
  }
  if (blob.length >= 4 && blob[0] === 71 && blob[1] === 73 && blob[2] === 70 && blob[3] === 56) {
    return 'gif'
  }
  if (
    blob.length >= 12 &&
    blob[0] === 82 &&
    blob[1] === 73 &&
    blob[2] === 70 &&
    blob[3] === 70 &&
    blob[8] === 87 &&
    blob[9] === 69 &&
    blob[10] === 66 &&
    blob[11] === 80
  ) {
    return 'webp'
  }
  return 'bin'
}
function openExternalDb(dbPath) {
  const BetterSqlite32 = loadBetterSqlite3()
  return new BetterSqlite32(dbPath, { readonly: true, fileMustExist: true })
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
  const ambiguousSample = []
  const unmatchedSample = []
  for (const importPath of importPaths) {
    await checkpoint(work)
    const outcome = matchVideo(importPath, videos)
    if (outcome.kind === 'matched') matched++
    if (outcome.kind === 'ambiguous') {
      ambiguous++
      if (ambiguousSample.length < 10) {
        ambiguousSample.push({
          importPath,
          candidates: outcome.candidates.slice(0, 5).map((video) => video.fileName),
        })
      }
    }
    if (outcome.kind === 'unmatched') {
      unmatched++
      if (unmatchedSample.length < 10) {
        unmatchedSample.push({ importPath })
      }
    }
  }
  return { matched, ambiguous, unmatched, ambiguousSample, unmatchedSample }
}
const matcherIndexes = new WeakMap()
async function prepareMatcher(videos, work) {
  if (matcherIndexes.has(videos)) return
  const index = {
    exact: new Map(),
    suffix: new Map(),
    base: new Map(),
    canonical: new Map(),
    normalized: [],
    deep: new Map(),
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
    index.normalized.push({ video, fileNameKey, titleKey: canonicalKey(video.title ?? '') })
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
async function countDeepDarkFileMatches(files, videos, dvdMap, work) {
  let matched = 0
  let ambiguous = 0
  let unmatched = 0
  const ambiguousSample = []
  const unmatchedSample = []
  for (const file of files) {
    await checkpoint(work)
    const outcome = matchDeepDarkFile(file, videos, dvdMap)
    if (outcome.kind === 'matched') matched++
    if (outcome.kind === 'ambiguous') {
      ambiguous++
      if (ambiguousSample.length < 10) {
        ambiguousSample.push({
          importPath: file.filepath,
          candidates: outcome.candidates.slice(0, 5).map((video) => video.fileName),
        })
      }
    }
    if (outcome.kind === 'unmatched') {
      unmatched++
      if (unmatchedSample.length < 10) {
        unmatchedSample.push({ importPath: file.filepath })
      }
    }
  }
  return { matched, ambiguous, unmatched, ambiguousSample, unmatchedSample }
}
function matchDeepDarkFile(file, videos, dvdMap) {
  const index = matcherIndexes.get(videos)
  const key = JSON.stringify([file.filepath, file.dvdId])
  if (index.deep.has(key)) return index.deep.get(key)
  const outcome = matchDeepDarkFileUncached(file, videos, dvdMap)
  index.deep.set(key, outcome)
  return outcome
}
function matchDeepDarkFileUncached(file, videos, dvdMap) {
  const baseOutcome = matchVideo(file.filepath, videos)
  if (baseOutcome.kind !== 'unmatched') return baseOutcome
  const dvdId = (file.dvdId ?? '').trim()
  if (dvdId) {
    const canonicalDvdId = canonicalKey(dvdId)
    const dvdIdMatches = matcherIndexes
      .get(videos)
      .normalized.filter(({ fileNameKey, titleKey }) => {
        return fileNameKey.includes(canonicalDvdId) || titleKey.includes(canonicalDvdId)
      })
      .map(({ video }) => video)
    if (dvdIdMatches.length === 1) return { kind: 'matched', video: dvdIdMatches[0] }
    if (dvdIdMatches.length > 1) return { kind: 'ambiguous', candidates: dvdIdMatches }
  }
  const dvdTitle = dvdId ? (dvdMap.get(dvdId)?.dvdTitle ?? '') : ''
  const canonicalTitle = canonicalKey(dvdTitle)
  if (canonicalTitle) {
    const titleMatches = matcherIndexes
      .get(videos)
      .normalized.filter(({ titleKey, fileNameKey }) => {
        const titleComparable = titleKey.length >= 6
        return (
          titleKey === canonicalTitle ||
          fileNameKey === canonicalTitle ||
          titleKey.includes(canonicalTitle) ||
          (titleComparable && canonicalTitle.includes(titleKey)) ||
          fileNameKey.includes(canonicalTitle)
        )
      })
      .map(({ video }) => video)
    if (titleMatches.length === 1) return { kind: 'matched', video: titleMatches[0] }
    if (titleMatches.length > 1) return { kind: 'ambiguous', candidates: titleMatches }
  }
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
function splitTags(value) {
  return (value ?? '')
    .split(/[,\n\r;/|]+/g)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}
function normalizeImportedDate(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return void 0
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return void 0
  }
  return parsed.toISOString()
}
function normalizePlayCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.round(value))
}
function canonicalKey(value) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[[\]()\-_.\s]+/g, '')
    .replace(/[^0-9a-z\uac00-\ud7a3]/g, '')
}
function loadBetterSqlite3() {
  return BetterSqlite3
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
export function previewDeepDarkDbImport(libraryId, dbPath, onProgress) {
  return runWork(libraryId, onProgress, false, (work) =>
    previewDeepDarkDbImportInternal(libraryId, dbPath, work),
  )
}
export function importDeepDarkDbData(libraryId, dbPath, options, onProgress) {
  return runWork(libraryId, onProgress, true, (work) =>
    importDeepDarkDbDataInternal(libraryId, dbPath, options, work),
  )
}
