const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { verifyUpdateMetadata } = require('./verify-update-metadata.cjs')
const { stageUpdateAssets } = require('./stage-update-assets.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-update-metadata-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('dvm-update-metadata-'))
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false)
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'win-unpacked', 'resources'), { recursive: true })
  const version = '0.3.4'
  const name = `DarkVideoManager-Setup-${version}-x64.exe`
  const data = Buffer.from('disposable installer fixture; never executed')
  const metadata = {
    version,
    files: [
      {
        url: name,
        size: data.length,
        sha512: crypto.createHash('sha512').update(data).digest('base64'),
      },
    ],
  }
  const feed = { provider: 'github', owner: 'DarkVideoManager', repo: 'DarkVideoManager' }
  fs.writeFileSync(path.join(root, name), data)
  fs.writeFileSync(path.join(root, name + '.blockmap'), 'fixture')
  const write = () => {
    fs.writeFileSync(path.join(root, 'latest.yml'), JSON.stringify(metadata))
    fs.writeFileSync(
      path.join(root, 'win-unpacked', 'resources', 'app-update.yml'),
      JSON.stringify(feed),
    )
  }
  write()
  return { root, version, name, metadata, feed, write }
}
test('verifies the exact public feed and installer bytes', (t) => {
  const f = fixture(t)
  assert.equal(verifyUpdateMetadata(f.root, f.version).publicGitHubFeed, true)
})

test('stages verified update files for the existing candidate collector', (t) => {
  const f = fixture(t)
  const result = stageUpdateAssets(f.root, f.root, f.version)
  assert.deepEqual(result.stagedUpdateAssets, ['latest.yml', f.name + '.blockmap'])
  for (const name of result.stagedUpdateAssets) {
    assert.deepEqual(
      fs.readFileSync(path.join(f.root, 'release', 'candidate', name)),
      fs.readFileSync(path.join(f.root, name)),
    )
  }
  stageUpdateAssets(f.root, f.root, f.version)
})

test('refuses stale candidate assets and linked output paths without changing outside bytes', (t) => {
  const f = fixture(t)
  const candidate = path.join(f.root, 'release', 'candidate')
  fs.mkdirSync(candidate, { recursive: true })
  const stale = path.join(candidate, 'old-installer.exe.blockmap')
  fs.writeFileSync(stale, 'previous version')
  assert.throws(() => stageUpdateAssets(f.root, f.root, f.version), /stale/)
  fs.unlinkSync(stale)
  const outside = path.join(f.root, 'protected-source.txt')
  fs.writeFileSync(outside, 'preserved')
  fs.linkSync(outside, path.join(candidate, 'latest.yml'))
  assert.throws(() => stageUpdateAssets(f.root, f.root, f.version), /Linked/)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved')
})
test('rejects a corrupted installer or mismatched version', (t) => {
  const f = fixture(t)
  assert.throws(() => verifyUpdateMetadata(f.root, '0.3.5'), /version/)
  fs.appendFileSync(path.join(f.root, f.name), 'corrupt')
  assert.throws(() => verifyUpdateMetadata(f.root, f.version), /size/)
})
test('rejects portable executables, arbitrary URLs, or an extra update payload', (t) => {
  const f = fixture(t)
  for (const url of [
    f.name.replace('Setup', 'Portable'),
    'https://example.com/update.exe',
    '../' + f.name,
  ]) {
    f.metadata.files[0].url = url
    f.write()
    assert.throws(() => verifyUpdateMetadata(f.root, f.version), /installer/)
  }
  f.metadata.files.push({ ...f.metadata.files[0] })
  f.write()
  assert.throws(() => verifyUpdateMetadata(f.root, f.version), /one Windows/)
})
test('requires SHA-512, the blockmap, and matching legacy checksum fields', (t) => {
  const f = fixture(t)
  const good = f.metadata.files[0].sha512
  f.metadata.files[0].sha512 = 'invalid'
  f.write()
  assert.throws(() => verifyUpdateMetadata(f.root, f.version), /SHA-512/)
  f.metadata.files[0].sha512 = good
  f.metadata.sha512 = 'invalid'
  f.write()
  assert.throws(() => verifyUpdateMetadata(f.root, f.version))
  delete f.metadata.sha512
  f.write()
  fs.unlinkSync(path.join(f.root, f.name + '.blockmap'))
  assert.throws(() => verifyUpdateMetadata(f.root, f.version))
})
test('rejects another repository or embedded credentials', (t) => {
  const f = fixture(t)
  for (const patch of [
    { owner: 'another-owner' },
    { repo: 'other' },
    { private: true },
    { token: 'test-not-a-real-token' },
  ]) {
    const original = { ...f.feed }
    Object.assign(f.feed, patch)
    f.write()
    assert.throws(() => verifyUpdateMetadata(f.root, f.version))
    for (const key of Object.keys(f.feed)) delete f.feed[key]
    Object.assign(f.feed, original)
  }
})
