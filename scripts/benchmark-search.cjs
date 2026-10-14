// Benchmark the real repository with disposable in-memory databases under Electron's Node ABI.
// Optional: npm run benchmark:search -- --label baseline
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const outputDir = path.join(root, 'test-results')
const reportPath = path.join(outputDir, 'search-benchmark.json')
const sourcePath = path.join(root, 'electron/main/db/repositories/VideoRepository.ts')
const worker = process.argv[2] === '--worker'

function percentile(values, fraction) {
  return Number(
    [...values]
      .sort((a, b) => a - b)
      [Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)].toFixed(2),
  )
}

async function runWorker(bundle, label) {
  const Database = require('better-sqlite3')
  const { VideoRepository, runMigrations } = require(bundle)
  const datasets = []
  for (const size of [10_000, 100_000]) {
    const db = new Database(':memory:')
    try {
      runMigrations(db, ':memory:')
      const insertVideo = db.prepare(`INSERT INTO videos
        (id,file_path,file_name,title,rating,memo,tags,created_at,play_count,removal_mode)
        VALUES (@id,@filePath,@fileName,@title,@rating,'',@tags,@createdAt,@playCount,@removalMode)`)
      const insertThumbnail = db.prepare(
        'INSERT INTO thumbnails(id,video_id,file_path,time_sec,is_primary) VALUES(?,?,?,1,1)',
      )
      const insertSubtitle = db.prepare(
        "INSERT INTO subtitles(id,video_id,file_path,type) VALUES(?,?,?,'srt')",
      )
      const seedStart = performance.now()
      db.transaction(() => {
        for (let i = 0; i < size; i++) {
          const id = String(i).padStart(8, '0')
          insertVideo.run({
            id,
            filePath: `C:/synthetic/${id}.mp4`,
            fileName: `clip-${i % 100}.mp4`,
            title: `Clip ${i % 100}`,
            rating: i % 6,
            tags: i % 997 === 0 ? 'needle-sample' : `tag-${i % 100}`,
            createdAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
            playCount: i % 20,
            removalMode: i % 10 === 0 ? 'remove' : null,
          })
          if (i % 4 === 0) insertThumbnail.run('t-' + id, id, `C:/synthetic/${id}.jpg`)
          if (i % 5 === 0) insertSubtitle.run('s-' + id, id, `C:/synthetic/${id}.srt`)
        }
      })()
      const seedMs = Number((performance.now() - seedStart).toFixed(2))
      const repository = new VideoRepository(db)
      const active = repository.count()
      const lastPage = Math.ceil(active / 500)
      const cases = [
        ['created-first', { sortBy: 'createdAt', sortDir: 'desc', pageSize: 500, page: 1 }],
        ['created-last', { sortBy: 'createdAt', sortDir: 'desc', pageSize: 500, page: lastPage }],
        ['filename-last', { sortBy: 'fileName', sortDir: 'asc', pageSize: 500, page: lastPage }],
        ['rating-last', { sortBy: 'rating', sortDir: 'desc', pageSize: 500, page: lastPage }],
        ['playcount-last', { sortBy: 'playCount', sortDir: 'desc', pageSize: 500, page: lastPage }],
        ['substring-common', { q: 'clip', pageSize: 500, page: lastPage }],
        ['substring-rare', { q: 'needle-sample', pageSize: 500, page: 1 }],
      ]
      const measurements = []
      for (const [name, query] of cases) {
        repository.search(query)
        const elapsed = [],
          blocked = []
        let result
        for (let repeat = 0; repeat < 5; repeat++) {
          const tickStart = performance.now()
          const tick = new Promise((resolve) =>
            setImmediate(() => resolve(performance.now() - tickStart)),
          )
          const started = performance.now()
          result = repository.search(query)
          elapsed.push(performance.now() - started)
          blocked.push(await tick)
        }
        assert.equal(new Set(result.videos.map((video) => video.id)).size, result.videos.length)
        assert.ok(result.videos.every((video) => !video.removalMode))
        measurements.push({
          name,
          query,
          total: result.total,
          returned: result.videos.length,
          p50Ms: percentile(elapsed, 0.5),
          p95Ms: percentile(elapsed, 0.95),
          eventLoopDelayP95Ms: percentile(blocked, 0.95),
          resultIdsSha256: crypto
            .createHash('sha256')
            .update(result.videos.map((video) => video.id).join(','))
            .digest('hex'),
        })
      }
      const first = repository.search({ sortBy: 'rating', sortDir: 'desc', pageSize: 500, page: 1 })
      const next = repository.search({ sortBy: 'rating', sortDir: 'desc', pageSize: 500, page: 2 })
      const ids = [...first.videos, ...next.videos].map((video) => video.id)
      assert.equal(
        new Set(ids).size,
        ids.length,
        'Tied values must not duplicate rows across pages',
      )
      assert.deepEqual(
        first.videos.map((video) => video.id),
        repository
          .search({ sortBy: 'rating', sortDir: 'desc', pageSize: 500, page: 1 })
          .videos.map((video) => video.id),
      )
      datasets.push({
        size,
        active,
        seedMs,
        schemaVersion: db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
        indexes: db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_videos_%'",
          )
          .all()
          .map((row) => row.name),
        createdOrderPlan: db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT id FROM videos WHERE removal_mode IS NULL ORDER BY created_at DESC NULLS LAST, id ASC LIMIT 500 OFFSET ?',
          )
          .all((lastPage - 1) * 500),
        measurements,
      })
    } finally {
      db.close()
    }
  }
  let report = {
    notes:
      'Synthetic in-memory data; warm queries, 5 repetitions. Timings include count, SQL, hydration and JS mapping. Event-loop delay measures synchronous blocking, not UI rendering.',
    runs: {},
  }
  if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  if (label !== 'baseline' && report.runs.baseline) {
    for (const dataset of datasets) {
      const baseline = report.runs.baseline.datasets.find((entry) => entry.size === dataset.size)
      if (!baseline) continue
      for (const measurement of dataset.measurements) {
        const previous = baseline.measurements.find((entry) => entry.name === measurement.name)
        if (!previous) continue
        assert.equal(
          measurement.total,
          previous.total,
          measurement.name + ': matching row count changed',
        )
        assert.equal(
          measurement.resultIdsSha256,
          previous.resultIdsSha256,
          measurement.name + ': returned IDs changed',
        )
        measurement.outputMatchesBaseline = true
        measurement.p95Speedup = Number((previous.p95Ms / measurement.p95Ms).toFixed(2))
      }
    }
  }
  report.runs[label] = {
    measuredAt: new Date().toISOString(),
    repositorySha256: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    datasets,
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      {
        reportPath,
        label,
        datasets: datasets.map(({ size, measurements }) => ({ size, measurements })),
      },
      null,
      2,
    ),
  )
}

async function main() {
  if (worker) return runWorker(process.argv[3], process.argv[4])
  const labelIndex = process.argv.indexOf('--label')
  const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : 'optimized'
  if (!label || !/^[a-z0-9_-]+$/i.test(label)) throw new Error('Invalid benchmark label')
  fs.mkdirSync(outputDir, { recursive: true })
  const bundle = path.join(outputDir, `.search-benchmark-${process.pid}-${crypto.randomUUID()}.cjs`)
  // Resolve esbuild as Vite's dependency rather than depending on npm's hoisting layout.
  const esbuild = require(
    require.resolve('esbuild', { paths: [path.dirname(require.resolve('vite/package.json'))] }),
  )
  try {
    await esbuild.build({
      stdin: {
        contents:
          "export { VideoRepository } from './electron/main/db/repositories/VideoRepository'; export { runMigrations } from './electron/main/db/migrator'",
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      packages: 'external',
      outfile: bundle,
      plugins: [
        {
          name: 'quiet-benchmark-logger',
          setup(build) {
            build.onResolve({ filter: /infra\/logger$/ }, () => ({
              path: 'logger',
              namespace: 'benchmark',
            }))
            build.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({
              contents:
                'export const createLogger = () => ({info(){},warn(){},error(){},debug(){}})',
            }))
          },
        },
      ],
    })
    const result = spawnSync(require('electron'), [__filename, '--worker', bundle, label], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Search benchmark failed: ' + result.status)
  } finally {
    try {
      fs.unlinkSync(bundle)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
