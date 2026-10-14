'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

function fixture(t) {
  const tempParent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempParent, 'dvm-notice-test-'))
  t.after(() => {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), tempParent)
    assert.ok(path.basename(resolved).startsWith('dvm-notice-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const root = path.join(directory, 'repo')
  const outside = path.join(directory, 'outside')
  for (const folder of [root, outside, path.join(root, 'scripts'), path.join(root, 'resources'), path.join(root, 'node_modules/electron/dist')]) {
    fs.mkdirSync(folder, { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'notice-fixture', version: '1.0.0' }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }))
  fs.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: 'fixture' }))
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    fs.writeFileSync(path.join(root, 'node_modules/electron/dist', name), 'Synthetic original notice fixture\n')
  }
  const script = path.join(root, 'scripts/generate-third-party-notices.cjs')
  fs.copyFileSync(path.join(__dirname, 'generate-third-party-notices.cjs'), script)
  const generate = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true })
  return { root, outside, generate }
}

test('notice generation records missing runtime failures without accepting an incomplete build', (t) => {
  const f = fixture(t)
  const result = f.generate()
  assert.notEqual(result.status, 0)
  const inventory = JSON.parse(fs.readFileSync(path.join(f.root, 'resources/legal/generated/inventory.json'), 'utf8'))
  assert.ok(inventory.issues.some((issue) => issue.includes('Missing media executable')))
  assert.deepEqual(fs.readdirSync(f.outside), [])
})

test('notice generation rejects a linked parent before creating a new output directory', (t) => {
  const f = fixture(t)
  fs.symlinkSync(f.outside, path.join(f.root, 'resources/legal'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = f.generate()
  assert.notEqual(result.status, 0)
  assert.deepEqual(fs.readdirSync(f.outside), [], 'The generator wrote through an external parent link')
})

test('notice generation records bundled public CA provenance and rejects damaged data', (t) => {
  const f = fixture(t)
  const source = path.resolve(__dirname, '../resources/subtitles/certificates')
  const destination = path.join(f.root, 'resources/subtitles/certificates')
  fs.cpSync(source, destination, { recursive: true })
  f.generate()
  const inventoryFile = path.join(f.root, 'resources/legal/generated/inventory.json')
  const initial = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
  assert.equal(initial.certificates.receipt.source.version, '2026.7.22')
  assert.equal(initial.certificates.sha256, initial.certificates.receipt.sha256)
  assert.equal(initial.certificates.licenseFiles.length, 3)
  assert.ok(!initial.issues.some((issue) => issue.includes('public CA')))
  fs.appendFileSync(path.join(destination, 'mozilla-ca.crt'), 'modified')
  const result = f.generate()
  assert.notEqual(result.status, 0)
  const damaged = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
  assert.ok(damaged.issues.includes('Subtitle public CA bundle hash mismatch'))
})

test('notice generation rejects a linked existing output without deleting external content', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'resources/legal'))
  const sentinel = path.join(f.outside, 'preserve.txt')
  fs.writeFileSync(sentinel, 'External fixture content\n')
  fs.symlinkSync(f.outside, path.join(f.root, 'resources/legal/generated'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = f.generate()
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'External fixture content\n')
  assert.deepEqual(fs.readdirSync(f.outside), ['preserve.txt'])
})
