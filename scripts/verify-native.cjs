// Exercise the packaged SQLite prebuild in Electron without opening user data.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getFfmpegPath, getFfprobePath } = require('./media-paths.cjs')

const root = path.resolve(__dirname, '..')

function run(executable, args, label, env = process.env) {
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`${label} is missing. Run npm run setup to acquire the locked runtimes.`)
  }
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || result.signal || `exit ${result.status}`).trim()
    throw new Error(`${label} failed: ${reason}`)
  }
  return result.stdout
}

try {
  // Reading the executable path directly keeps this check free of implicit downloads.
  const electronDirectory = path.dirname(require.resolve('electron/package.json'))
  const expectedVersion = require(path.join(electronDirectory, 'package.json')).version
  const pathFile = path.join(electronDirectory, 'path.txt')
  if (!fs.existsSync(pathFile)) {
    throw new Error('Electron has not been downloaded. Run npm run setup first.')
  }
  const electron = path.join(electronDirectory, 'dist', fs.readFileSync(pathFile, 'utf8').trim())
  const marker = 'DVM_NATIVE_CHECK='
  const sqliteCheck = `
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE native_check USING fts5(text)');
      db.prepare('INSERT INTO native_check(text) VALUES (?)').run('subtitle runtime check');
      const row = db.prepare('SELECT text FROM native_check WHERE native_check MATCH ?').get('subtitle');
      if (!row || row.text !== 'subtitle runtime check') throw new Error('SQLite FTS5 check failed');
      console.log('${marker}' + JSON.stringify({
        electron: process.versions.electron,
        napi: Number(process.versions.napi),
        sqlite: db.prepare('SELECT sqlite_version() AS version').get().version
      }));
    } finally { db.close(); }
  `
  const output = run(electron, ['--eval', sqliteCheck], 'Electron SQLite', {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  })
  const line = output.split(/\r?\n/).find((value) => value.startsWith(marker))
  if (!line) throw new Error('Electron did not return a native runtime check result.')
  const result = JSON.parse(line.slice(marker.length))
  if (result.electron !== expectedVersion) {
    throw new Error(`Electron binary version ${result.electron} does not match installed package ${expectedVersion}. Run npm run setup again.`)
  }
  if (!Number.isInteger(result.napi) || result.napi < 10) {
    throw new Error(`SQLite requires N-API 10 or newer; Electron provides ${result.napi}.`)
  }
  console.log(`Electron ${result.electron}: SQLite ${result.sqlite}, N-API ${result.napi}, FTS5 OK`)

  for (const [label, executable] of [
    ['FFmpeg', getFfmpegPath()],
    ['FFprobe', getFfprobePath()],
  ]) {
    const version = run(executable, ['-version'], label).split(/\r?\n/)[0]
    if (!version.toLowerCase().startsWith(`${label.toLowerCase()} version `)) {
      throw new Error(`${label} did not return a recognized version response.`)
    }
    console.log(version)
  }
} catch (error) {
  console.error(`Native runtime verification failed: ${error.message}`)
  process.exitCode = 1
}
