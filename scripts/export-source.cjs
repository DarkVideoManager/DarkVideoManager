// Export the reviewed working source, including new files, without Git history or local data.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { auditRepository, inspectText } = require('./audit-publication.cjs')

const excluded =
  /^(?:\.git|node_modules|out|dist|dist-electron|release|test-results|playwright-report|coverage|resources\/native|resources\/subtitles\/native|resources\/media|resources\/legal\/generated|resources\/legal\/media-source-receipts\.json)(?:\/|$)/
const required = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'scripts/setup.cjs']
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function validateSourcePath(file) {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    /[\\:\x00-\x1f\x7f]/.test(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid source path')
  }
  if (file === 'SOURCE-MANIFEST.sha256')
    throw new Error('SOURCE-MANIFEST.sha256 is reserved for this export')
}

// The final file can appear regular while a parent junction points outside the checkout.
function regularSourceFile(root, file) {
  validateSourcePath(file)
  const parts = file.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Review linked publication entry: ${file}`)
    const relative = path.relative(root, fs.realpathSync(current))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Source file escaped repository root')
    }
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Review non-file publication entry: ${file}`)
    }
  }
  return current
}

function regularOutputDirectory(root) {
  const output = path.join(root, 'release')
  try {
    fs.mkdirSync(output)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(output)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    path.dirname(fs.realpathSync(output)) !== root
  ) {
    throw new Error('Refusing linked or external release directory')
  }
  return output
}

function assertReplaceableOutput(output, target) {
  if (path.dirname(path.resolve(target)) !== output) throw new Error('Invalid archive output path')
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new Error('Refusing linked or non-file archive output')
  }
}

function validateConfiguration(contents) {
  for (const file of required)
    if (!contents.has(file)) throw new Error(`Required source file missing: ${file}`)
  const pkg = JSON.parse(contents.get('package.json').toString('utf8'))
  const lock = JSON.parse(contents.get('package-lock.json').toString('utf8'))
  if (
    typeof pkg.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/.test(pkg.version)
  ) {
    throw new Error('Invalid release version')
  }
  if (
    typeof pkg.name !== 'string' ||
    !pkg.name ||
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    !lock.packages?.[''] ||
    lock.packages[''].name !== pkg.name ||
    lock.packages[''].version !== pkg.version
  ) {
    throw new Error('Package and lockfile identity/version do not match')
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const entries = (object) => Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b))
    if (JSON.stringify(entries(pkg[field])) !== JSON.stringify(entries(lock.packages[''][field]))) {
      throw new Error(`Package and lockfile ${field} do not match`)
    }
  }
  return pkg.version
}

function exportSource(repositoryRoot, { quiet = false } = {}) {
  const root = fs.realpathSync(repositoryRoot)
  const inventory = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  if (inventory.error || inventory.status !== 0) throw new Error('Unable to enumerate source files')
  const files = [...new Set(inventory.stdout.split('\0').filter(Boolean))].sort()
  // Refuse linked source trees before the audit can read their contents.
  for (const file of files) if (!excluded.test(file)) regularSourceFile(root, file)
  const report = auditRepository(root)
  if (report.errors)
    throw new Error(
      'Publication audit failed. Run npm run audit:publication and resolve the findings.',
    )
  const contents = new Map()
  for (const file of files) {
    if (excluded.test(file)) continue
    const source = regularSourceFile(root, file)
    if (!source) continue
    const bytes = fs.readFileSync(source)
    // Inspect the exact exported bytes, even if a file changed since the initial scan.
    if (
      !bytes.includes(0) &&
      inspectText(bytes.toString('utf8'), file).some((f) => f.severity === 'error')
    ) {
      throw new Error(`Publication audit failed for export content: ${file}`)
    }
    contents.set(file, bytes)
  }
  const version = validateConfiguration(contents)
  const output = regularOutputDirectory(root)
  const stage = fs.mkdtempSync(path.join(output, '.source-stage-'))
  const stageIdentity = fs.lstatSync(stage)
  const name = `DarkVideoManager-${version}-source`
  const tree = path.join(stage, name)
  const manifest = []
  try {
    for (const [file, bytes] of contents) {
      const destination = path.join(tree, file)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, bytes, { flag: 'wx' })
      manifest.push(`${hash(bytes)}  ${file}`)
    }
    fs.writeFileSync(path.join(tree, 'SOURCE-MANIFEST.sha256'), manifest.join('\n') + '\n', {
      flag: 'wx',
    })
    const stagedArchive = path.join(stage, `${name}.tar.gz`)
    const archive = path.join(output, path.basename(stagedArchive))
    const checksum = `${archive}.sha256`
    assertReplaceableOutput(output, archive)
    assertReplaceableOutput(output, checksum)
    const result = spawnSync('tar', ['-czf', stagedArchive, '-C', stage, name], {
      stdio: quiet ? 'pipe' : 'inherit',
      windowsHide: true,
    })
    if (result.error || result.status !== 0)
      throw new Error('Source archive creation failed; tar is required')
    const digest = hash(fs.readFileSync(stagedArchive))
    const stagedChecksum = `${stagedArchive}.sha256`
    fs.writeFileSync(stagedChecksum, `${digest}  ${path.basename(archive)}\n`, { flag: 'wx' })
    // A failed tar invocation leaves an earlier valid export untouched.
    regularOutputDirectory(root)
    assertReplaceableOutput(output, archive)
    assertReplaceableOutput(output, checksum)
    fs.renameSync(stagedArchive, archive)
    fs.renameSync(stagedChecksum, checksum)
    if (!quiet) {
      console.log(`Exported ${contents.size} reviewed source files: ${archive}`)
      console.log(`SHA-256: ${digest}`)
      if (report.warnings)
        console.log(
          `${report.warnings} source audit warnings require review; Git history is not included.`,
        )
    }
    return { archive, checksum, digest, files: [...contents.keys()], warnings: report.warnings }
  } finally {
    // Remove only this call's unchanged, real staging directory, never a link.
    regularOutputDirectory(root)
    const absoluteStage = fs.realpathSync(stage)
    const current = fs.lstatSync(stage)
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== stageIdentity.dev ||
      current.ino !== stageIdentity.ino ||
      path.dirname(absoluteStage) !== output ||
      !path.basename(absoluteStage).startsWith('.source-stage-')
    ) {
      throw new Error('Refusing cleanup outside the source export staging directory')
    }
    fs.rmSync(absoluteStage, { recursive: true, force: true })
  }
}

module.exports = { exportSource, validateSourcePath, validateConfiguration }
if (require.main === module) {
  try {
    exportSource(path.resolve(__dirname, '..'))
  } catch (error) {
    console.error(`Source export failed: ${error.message}`)
    process.exitCode = 1
  }
}
