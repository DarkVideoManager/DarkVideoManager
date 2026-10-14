'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { exportSource, validateSourcePath } = require('./export-source.cjs')

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const archiveName = 'DarkVideoManager-1.2.3-source.tar.gz'
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} fixture operation failed`)
  return result.stdout
}

function fixture(t) {
  const tempParent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempParent, 'dvm-export-test-'))
  t.after(() => {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), tempParent)
    assert.ok(path.basename(resolved).startsWith('dvm-export-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const root = path.join(directory, 'repo')
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  run('git', ['init', '--quiet'], root)
  fs.mkdirSync(path.join(root, 'scripts'))
  const pkg = { name: 'publication-fixture', version: '1.2.3', dependencies: { example: '1.0.0' } }
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  fs.writeFileSync(path.join(root, 'README.md'), 'Reviewed fixture\n')
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Fixture license\n')
  fs.writeFileSync(path.join(root, 'scripts', 'setup.cjs'), '// fixture setup\n')
  // Ignore the output path whether Git sees a directory, junction or POSIX symlink.
  fs.writeFileSync(path.join(root, '.gitignore'), '/release\n.env*\nnode_modules/\nout/\n')
  return { root, outside }
}

function editJson(root, file, edit) {
  const target = path.join(root, file)
  const data = JSON.parse(fs.readFileSync(target, 'utf8'))
  edit(data)
  fs.writeFileSync(target, JSON.stringify(data))
}

test('exports current tracked and untracked bytes with verified per-file and archive hashes', (t) => {
  const { root } = fixture(t)
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'old content')
  run('git', ['add', '.'], root)
  fs.unlinkSync(path.join(root, 'deleted.txt'))
  fs.writeFileSync(path.join(root, 'new file.txt'), 'untracked content\n')
  fs.writeFileSync(path.join(root, '.env.private'), 'ignored private fixture')
  fs.mkdirSync(path.join(root, 'out'))
  fs.writeFileSync(path.join(root, 'out', 'bundle.js'), 'ignored build output')
  fs.mkdirSync(path.join(root, 'resources', 'media', 'source-materials'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources', 'legal'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'resources', 'media', 'source-materials', 'download.tar.gz'),
    Buffer.from([0, 1, 2]),
  )
  fs.writeFileSync(path.join(root, 'resources', 'legal', 'media-source-receipts.json'), '{}')
  const status = run('git', ['status', '--porcelain'], root)
  const result = exportSource(root, { quiet: true })
  assert.equal(result.digest, digest(fs.readFileSync(result.archive)))
  assert.equal(fs.readFileSync(result.checksum, 'utf8'), `${result.digest}  ${archiveName}\n`)
  const prefix = 'DarkVideoManager-1.2.3-source/'
  const listing = run('tar', ['-tzf', result.archive], root).trim().split(/\r?\n/)
  assert.ok(listing.every((entry) => entry.startsWith(prefix) && !entry.includes('/../')))
  assert.ok(listing.includes(prefix + 'new file.txt'))
  assert.ok(
    !listing.some(
      (entry) =>
        entry.includes('/resources/media/') || entry.endsWith('/media-source-receipts.json'),
    ),
  )
  assert.ok(!listing.some((entry) => /(?:\.git\/|\.env|deleted\.txt|out\/|release\/)/.test(entry)))
  const manifest = run('tar', ['-xOf', result.archive, prefix + 'SOURCE-MANIFEST.sha256'], root)
    .trim()
    .split(/\r?\n/)
  assert.equal(manifest.length, result.files.length)
  for (const entry of manifest) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(entry)
    assert.ok(match)
    const content = spawnSync('tar', ['-xOf', result.archive, prefix + match[2]], { cwd: root })
    assert.equal(content.status, 0)
    assert.equal(digest(content.stdout), match[1])
    assert.deepEqual(content.stdout, fs.readFileSync(path.join(root, match[2])))
  }
  assert.equal(run('git', ['status', '--porcelain'], root), status)
  assert.ok(
    !fs.readdirSync(path.join(root, 'release')).some((name) => name.startsWith('.source-stage-')),
  )
})

test('rejects traversal, control characters, absolute and nonportable paths', () => {
  for (const file of [
    '../outside.txt',
    '/absolute.txt',
    'dir/../outside.txt',
    'dir//file',
    'dir\\file',
    'C:relative.txt',
    'newline\nfile',
    'tab\tfile',
    'SOURCE-MANIFEST.sha256',
  ]) {
    assert.throws(() => validateSourcePath(file))
  }
  assert.doesNotThrow(() => validateSourcePath('.github/workflows/ci.yml'))
  assert.doesNotThrow(() => validateSourcePath('docs/new file.md'))
})

test('refuses mismatched package and lockfile versions before creating output', (t) => {
  const { root } = fixture(t)
  editJson(root, 'package-lock.json', (lock) => {
    lock.version = '9.0.0'
  })
  assert.throws(() => exportSource(root, { quiet: true }), /identity\/version/)
  assert.ok(!fs.existsSync(path.join(root, 'release')))
})

test('refuses a package dependency change absent from the lockfile', (t) => {
  const { root } = fixture(t)
  editJson(root, 'package.json', (pkg) => {
    pkg.dependencies.example = '2.0.0'
  })
  assert.throws(() => exportSource(root, { quiet: true }), /dependencies do not match/)
})

test('refuses missing setup files and unsafe release versions', (t) => {
  const { root } = fixture(t)
  fs.unlinkSync(path.join(root, 'scripts', 'setup.cjs'))
  assert.throws(() => exportSource(root, { quiet: true }), /Required source file missing/)
  fs.writeFileSync(path.join(root, 'scripts', 'setup.cjs'), '// setup')
  editJson(root, 'package.json', (pkg) => {
    pkg.version = '../outside'
  })
  assert.throws(() => exportSource(root, { quiet: true }), /Invalid release version/)
})

test('refuses a tracked source file reached through a directory junction', (t) => {
  const { root, outside } = fixture(t)
  fs.mkdirSync(path.join(root, 'source'))
  fs.writeFileSync(path.join(root, 'source', 'entry.js'), 'safe fixture')
  run('git', ['add', 'source/entry.js'], root)
  fs.renameSync(path.join(root, 'source'), path.join(root, 'source-original'))
  fs.writeFileSync(path.join(outside, 'entry.js'), 'external content must not be exported')
  fs.symlinkSync(
    outside,
    path.join(root, 'source'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.throws(() => exportSource(root, { quiet: true }), /linked publication entry/)
  assert.ok(!fs.existsSync(path.join(root, 'release')))
})

test('refuses a linked release directory without writing or deleting external files', (t) => {
  const { root, outside } = fixture(t)
  const sentinel = path.join(outside, 'keep.txt')
  fs.writeFileSync(sentinel, 'preserve me')
  fs.symlinkSync(
    outside,
    path.join(root, 'release'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.equal(run('git', ['check-ignore', 'release'], root).trim(), 'release')
  assert.throws(() => exportSource(root, { quiet: true }), /release directory/)
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt'])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve me')
})

test('refuses a hard-linked archive and cleans only its new stage', (t) => {
  const { root, outside } = fixture(t)
  const sentinel = path.join(outside, 'keep.txt')
  fs.writeFileSync(sentinel, 'preserve linked output')
  fs.mkdirSync(path.join(root, 'release'))
  fs.linkSync(sentinel, path.join(root, 'release', archiveName))
  assert.throws(() => exportSource(root, { quiet: true }), /linked or non-file archive/)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve linked output')
  assert.deepEqual(fs.readdirSync(path.join(root, 'release')), [archiveName])
})

test('blocks publication credentials without creating an archive or exposing values', (t) => {
  const { root } = fixture(t)
  const token = ['gh', 'p_', 'X'.repeat(36)].join('')
  fs.writeFileSync(path.join(root, 'source.js'), token)
  assert.throws(
    () => exportSource(root, { quiet: true }),
    (error) => /Publication audit failed/.test(error.message) && !error.message.includes(token),
  )
  assert.ok(!fs.existsSync(path.join(root, 'release')))
})

test('replaces an earlier ordinary export only after constructing the next archive', (t) => {
  const { root } = fixture(t)
  const first = exportSource(root, { quiet: true })
  fs.writeFileSync(path.join(root, 'README.md'), 'New source contents\n')
  const second = exportSource(root, { quiet: true })
  assert.equal(first.archive, second.archive)
  assert.notEqual(first.digest, second.digest)
  assert.equal(
    run('tar', ['-xOf', second.archive, 'DarkVideoManager-1.2.3-source/README.md'], root),
    'New source contents\n',
  )
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'release')).sort(),
    [archiveName, archiveName + '.sha256'].sort(),
  )
})
