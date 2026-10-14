'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const slash = (value) => value.replaceAll('\\', '/')
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar'
const licenseNames = [
  'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3',
  'FFmpeg-LICENSE.md', 'LLVM-MinGW-LICENSE.txt', 'MinGW-COPYING',
  'MinGW-COPYING.MinGW-w64-runtime.txt', 'MinGW-COPYING.MinGW-w64.txt',
  'MinGW-COPYING.winpthreads.txt', 'MinGW-COPYING.winstorecompat.txt', 'x264-COPYING.txt',
]
const archivePath = 'release/sources/dvm-media-corresponding-source.tar.gz'
const materialPath = 'resources/media/source-materials'

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
}

function fixture(t) {
  const tempParent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempParent, 'dvm-media-test-'))
  t.after(() => {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), tempParent)
    assert.ok(path.basename(resolved).startsWith('dvm-media-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const root = path.join(directory, 'repo')
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  const file = (name) => path.join(root, name)
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), value)
  }
  const recipe = '#!/usr/bin/env bash\n# Synthetic recipe; compilation is not part of this test.\n'
  write('scripts/build-media.sh', recipe)
  write('scripts/finalize-media.cjs', fs.readFileSync(path.join(__dirname, 'finalize-media.cjs')))
  write('docs/media-build.md', '# Fixture build instructions\nRun the pinned build recipe.\n')

  // Use a real tiny source archive so the fixture also exercises tar packaging.
  write('fixture-source/README', 'Synthetic upstream source used only in tests.\n')
  const sourceArchive = file('fixture-source.tar.gz')
  const packed = run(tarCommand, ['-czf', sourceArchive, '-C', file('fixture-source'), '.'], root)
  assert.equal(packed.status, 0, `Fixture tar creation failed: ${packed.stderr}`)
  const sourceBytes = fs.readFileSync(sourceArchive)
  const assets = ['ffmpeg', 'x264', 'nasm'].map((id) => ({
    id, filename: `${id}-fixture.tar.gz`, directory: `${id}-fixture`,
    url: `https://example.invalid/${id}-fixture.tar.gz`, sha256: hash(sourceBytes),
  }))
  const manifest = {
    schemaVersion: 1, ffmpegVersion: 'fixture', x264Revision: 'fixture',
    assets: [...assets, {
      id: 'toolchain', filename: 'toolchain-fixture.tar.gz', directory: 'toolchain-fixture',
      url: 'https://example.invalid/toolchain-fixture.tar.gz', sha256: hash('toolchain fixture'),
    }],
  }
  write('resources/media-manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  const recipeHash = hash(Buffer.concat([
    fs.readFileSync(file('resources/media-manifest.json')), Buffer.from(recipe),
  ])).slice(0, 20)
  write('resources/media/recipe-hash.txt', recipeHash + '\n')
  for (const name of ['ffmpeg', 'ffprobe']) {
    write(`resources/media/win32-x64/${name}.exe`, `MZ synthetic ${name} fixture, never executed\n`)
    write(`resources/media/${name}-imports.txt`, 'KERNEL32.dll\nucrtbase.dll\n')
  }
  const staged = {
    'BUILD.md': 'docs/media-build.md',
    'scripts/build-media.sh': 'scripts/build-media.sh',
    'scripts/finalize-media.cjs': 'scripts/finalize-media.cjs',
    'resources/media-manifest.json': 'resources/media-manifest.json',
  }
  for (const [target, source] of Object.entries(staged)) {
    write(`${materialPath}/${target}`, fs.readFileSync(file(source)))
  }
  for (const asset of assets) write(`${materialPath}/sources/${asset.filename}`, sourceBytes)
  for (const name of licenseNames) {
    const text = `Synthetic original notice fixture: ${name}\n`
    write(`resources/media/licenses/${name}`, text)
    write(`${materialPath}/licenses/${name}`, text)
  }
  const finalize = (...args) => run(process.execPath, [file('scripts/finalize-media.cjs'), ...args], root)
  const readJson = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
  const assertPass = (result) => assert.equal(result.status, 0, `Finalizer failed: ${result.stderr}`)
  const assertFails = (result) => assert.notEqual(result.status, 0, 'Unsafe or incomplete media artifact was accepted')
  return { root, outside, file, write, finalize, readJson, assertPass, assertFails, assets }
}

test('complete media fixtures produce a verifiable, allowlisted source archive and matching receipts', (t) => {
  const f = fixture(t)
  f.assertPass(f.finalize())
  f.assertPass(f.finalize('--verify'))
  const listing = run(tarCommand, ['-tzf', f.file(archivePath)], f.root)
  assert.equal(listing.status, 0, listing.stderr)
  const entries = listing.stdout.trim().split(/\r?\n/).map((name) => slash(name).replace(/^\.\//, '')).filter((name) => name && !name.endsWith('/'))
  const expected = [
    'BUILD.md', 'dependencies.json', 'resources/media-manifest.json',
    'scripts/build-media.sh', 'scripts/finalize-media.cjs',
    ...f.assets.map((asset) => `sources/${asset.filename}`),
    ...licenseNames.map((name) => `licenses/${name}`),
  ]
  assert.deepEqual(entries.sort(), expected.sort())
  const extracted = f.file('inspected-archive')
  fs.mkdirSync(extracted)
  const extraction = run(tarCommand, ['-xzf', f.file(archivePath), '-C', extracted], f.root)
  assert.equal(extraction.status, 0, extraction.stderr)
  for (const [archived, source] of [
    ['BUILD.md', 'docs/media-build.md'],
    ['scripts/build-media.sh', 'scripts/build-media.sh'],
    ['scripts/finalize-media.cjs', 'scripts/finalize-media.cjs'],
    ['resources/media-manifest.json', 'resources/media-manifest.json'],
  ]) assert.deepEqual(fs.readFileSync(path.join(extracted, archived)), fs.readFileSync(f.file(source)))
  const receipts = f.readJson('resources/legal/media-source-receipts.json')
  assert.equal(receipts.artifacts.length, 2)
  for (const receipt of receipts.artifacts) {
    assert.equal(receipt.archiveSha256, hash(fs.readFileSync(f.file(receipt.archive))))
    assert.equal(receipt.buildInstructionsSha256, hash(fs.readFileSync(f.file(receipt.buildInstructions))))
    assert.equal(receipt.dependencyInventorySha256, hash(fs.readFileSync(f.file(receipt.dependencyInventory))))
  }
  const inventoryText = fs.readFileSync(path.join(extracted, 'dependencies.json'), 'utf8')
  assert.equal(inventoryText.includes(f.root), false)
  assert.equal(inventoryText.includes(slash(f.root)), false)
  assert.deepEqual(fs.readdirSync(f.file('release/sources')).sort(), ['BUILD.md', 'dependencies.json', 'dvm-media-corresponding-source.tar.gz'].sort())
})

test('rejects local notes and unknown directories in generated source materials', (t) => {
  const f = fixture(t)
  f.write(`${materialPath}/personal-note.txt`, 'Local content must not enter a public source archive.\n')
  f.assertFails(f.finalize())
  assert.equal(fs.existsSync(f.file(archivePath)), false)
  fs.unlinkSync(f.file(`${materialPath}/personal-note.txt`))
  fs.mkdirSync(f.file(`${materialPath}/private-cache`))
  f.assertFails(f.finalize())
})

test('rejects missing or stale build recipes, configuration, and instructions', (t) => {
  const f = fixture(t)
  for (const name of ['scripts/build-media.sh', 'resources/media-manifest.json', 'BUILD.md']) {
    const target = `${materialPath}/${name}`
    const original = fs.readFileSync(f.file(target))
    fs.unlinkSync(f.file(target))
    f.assertFails(f.finalize())
    f.write(target, 'Stale fixture content\n')
    f.assertFails(f.finalize())
    f.write(target, original)
  }
  f.assertPass(f.finalize())
})

test('rejects a source archive whose bytes differ from the pinned manifest', (t) => {
  const f = fixture(t)
  fs.appendFileSync(f.file(`${materialPath}/sources/${f.assets[0].filename}`), 'corruption')
  f.assertFails(f.finalize())
  assert.equal(fs.existsSync(f.file(archivePath)), false)
})

test('rejects missing or mismatched original license material', (t) => {
  const f = fixture(t)
  const target = `${materialPath}/licenses/COPYING.GPLv3`
  const original = fs.readFileSync(f.file(target))
  fs.unlinkSync(f.file(target))
  f.assertFails(f.finalize())
  f.write(target, 'Changed notice\n')
  f.assertFails(f.finalize())
  f.write(target, original)
  f.assertPass(f.finalize())
})

test('rejects a changed recipe receipt or unexpected dynamic runtime dependency', (t) => {
  const f = fixture(t)
  const original = fs.readFileSync(f.file('resources/media/recipe-hash.txt'))
  f.write('resources/media/recipe-hash.txt', 'outdated-recipe\n')
  f.assertFails(f.finalize())
  f.write('resources/media/recipe-hash.txt', original)
  f.write('resources/media/ffmpeg-imports.txt', 'KERNEL32.dll\nlibwinpthread-1.dll\n')
  f.assertFails(f.finalize())
})

test('verification rejects changed binaries, source archives, notices, and incomplete license inventories', (t) => {
  const f = fixture(t)
  f.assertPass(f.finalize())
  for (const name of ['resources/media/win32-x64/ffmpeg.exe', archivePath, 'resources/media/licenses/COPYING.GPLv3']) {
    const original = fs.readFileSync(f.file(name))
    fs.appendFileSync(f.file(name), 'tampered')
    f.assertFails(f.finalize('--verify'))
    f.write(name, original)
  }
  const manifest = f.readJson('resources/media/runtime-manifest.json')
  manifest.licenseFiles = {}
  f.write('resources/media/runtime-manifest.json', JSON.stringify(manifest))
  f.assertFails(f.finalize('--verify'))
})

test('rejects release and source-material directory links without writing outside the repository', (t) => {
  const f = fixture(t)
  fs.symlinkSync(f.outside, f.file('release'), process.platform === 'win32' ? 'junction' : 'dir')
  f.assertFails(f.finalize())
  assert.deepEqual(fs.readdirSync(f.outside), [])
  fs.unlinkSync(f.file('release'))
  fs.renameSync(f.file(materialPath), f.file('resources/media/original-source-materials'))
  fs.symlinkSync(f.outside, f.file(materialPath), process.platform === 'win32' ? 'junction' : 'dir')
  f.assertFails(f.finalize())
  assert.deepEqual(fs.readdirSync(f.outside), [])
})

test('rejects hardlinked artifact destinations without overwriting outside bytes', (t) => {
  const f = fixture(t)
  const outside = path.join(f.outside, 'keep.txt')
  fs.writeFileSync(outside, 'Preserve external fixture bytes\n')
  fs.mkdirSync(f.file('release/sources'), { recursive: true })
  fs.linkSync(outside, f.file(archivePath))
  f.assertFails(f.finalize())
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Preserve external fixture bytes\n')
})

test('source-material links cannot import external content under an allowed filename', (t) => {
  const f = fixture(t)
  const target = f.file(`${materialPath}/licenses/COPYING.GPLv3`)
  const outside = path.join(f.outside, 'external-notice.txt')
  fs.writeFileSync(outside, fs.readFileSync(target))
  fs.unlinkSync(target)
  fs.linkSync(outside, target)
  f.assertFails(f.finalize())
  assert.equal(fs.existsSync(f.file(archivePath)), false)
})
