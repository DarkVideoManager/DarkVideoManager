// Execute an explicitly reviewed subtitle-only plan with Electron's Recycle Bin API.
// Run with electron.exe; no app windows are opened and no user process is stopped.
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')

const planPath = path.resolve(process.argv[2])
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
if (plan.version !== 1 || !plan.reviewed || !Array.isArray(plan.targets))
  throw new Error('An explicitly reviewed version 1 plan is required')
const reportDir = path.dirname(planPath)
fs.mkdirSync(path.join(reportDir, 'recycle-runtime'), { recursive: true })
app.setPath('userData', path.join(reportDir, 'recycle-runtime'))
const allowed = new Set(['.srt', '.vtt', '.ass', '.ssa', '.smi', '.sami', '.sub'])
const root = fs.realpathSync.native(plan.root)
const key = (value) => path.resolve(value).toLowerCase()
if (key(root) !== key(plan.root)) throw new Error('Audit root redirects to another directory')
const journal = path.join(reportDir, 'recycled.jsonl')
const backupDir = path.join(reportDir, 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const record = (value) => {
  const descriptor = fs.openSync(journal, 'a')
  try {
    fs.writeSync(descriptor, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function active(file) {
  const queue = JSON.parse(fs.readFileSync(plan.queuePath, 'utf8'))
  return queue.entries.some((entry) => {
    if (!['preparing', 'loading', 'transcribing', 'translating', 'saving', 'pausing', 'removing'].includes(entry.job.phase)) return false
    const stem = entry.videoPath.slice(0, -path.extname(entry.videoPath).length)
    return key(file).startsWith(key(stem) + '.')
  })
}

function inspect(target) {
  const file = path.resolve(target.path)
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !allowed.has(path.extname(file).toLowerCase()))
    throw new Error('Target is not a permitted subtitle within the audited root')
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || key(fs.realpathSync.native(file)) !== key(file))
    throw new Error('Target is not an unchanged regular file')
  if (info.size !== target.size) throw new Error('File size changed after review')
  const data = fs.readFileSync(file)
  if (crypto.createHash('sha256').update(data).digest('hex') !== target.sha256)
    throw new Error('File content changed after review')
  if (active(file)) throw new Error('A subtitle task is active for this video')
  return { file, data, info }
}

app.whenReady().then(async () => {
  const db = new Database(plan.databasePath, { fileMustExist: true, timeout: 5000 })
  let recycled = 0, skipped = 0
  try {
    const rows = db.prepare('SELECT * FROM subtitles WHERE is_embedded = 0').all()
    const byPath = new Map()
    for (const row of rows) byPath.set(key(row.file_path), [...(byPath.get(key(row.file_path)) || []), row])
    const seen = new Set()
    for (const target of plan.targets) {
      let moved = false
      try {
        if (seen.has(key(target.path))) throw new Error('Duplicate plan target')
        seen.add(key(target.path))
        const { file, data, info } = inspect(target)
        const backup = path.join(backupDir, target.sha256 + path.extname(file).toLowerCase())
        if (!fs.existsSync(backup)) {
          const descriptor = fs.openSync(backup, 'wx')
          try {
            fs.writeFileSync(descriptor, data)
            fs.fsyncSync(descriptor)
          } finally {
            fs.closeSync(descriptor)
          }
        }
        if (crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex') !== target.sha256)
          throw new Error('Recovery backup did not verify')
        const savedRows = byPath.get(key(file)) || []
        record({ event: 'prepared', path: file, sha256: target.sha256, reason: target.reason, backup, subtitleRows: savedRows })
        const current = inspect(target)
        if (current.info.ino !== info.ino || current.info.mtimeMs !== info.mtimeMs)
          throw new Error('File changed immediately before recycling')
        await shell.trashItem(file)
        moved = true
        if (fs.existsSync(file)) throw new Error('File exists after recycling; metadata retained')
        db.transaction(() => {
          const remove = db.prepare('DELETE FROM subtitles WHERE id = ? AND file_path = ? AND is_embedded = 0')
          for (const row of savedRows) remove.run(row.id, row.file_path)
        })()
        record({ event: 'recycled', path: file, sha256: target.sha256, removedRows: savedRows.length, backup })
        recycled++
      } catch (error) {
        skipped++
        record({ event: moved ? 'recycled_metadata_error' : 'skipped', path: target.path, error: error.message })
      }
    }
    console.log(JSON.stringify({ recycled, skipped, journal }))
  } finally {
    db.close()
    app.quit()
  }
}).catch((error) => {
  console.error(error.message)
  app.exit(1)
})
