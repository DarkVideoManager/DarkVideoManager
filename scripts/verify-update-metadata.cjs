const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
// Parse with the same YAML dependency as the pinned updater.
const { createRequire } = require('node:module')
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const { load } = updaterRequire('js-yaml')

function verifyUpdateMetadata(directory, version) {
  const metadata = load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
  const installerName = `DarkVideoManager-Setup-${version}-x64.exe`
  assert.equal(metadata.version, version, 'Update metadata version differs from the application')
  assert.equal(metadata.files?.length, 1, 'Expected one Windows x64 installer')
  const entry = metadata.files[0]
  assert.equal(
    entry.url,
    installerName,
    'Update metadata must refer to the installer, using a local file name',
  )
  const installer = fs.readFileSync(path.join(directory, installerName))
  assert.equal(entry.size, installer.length, 'Installer size differs from update metadata')
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
  assert.equal(entry.sha512, sha512, 'Installer SHA-512 differs from update metadata')
  if (metadata.path !== undefined) assert.equal(metadata.path, installerName)
  if (metadata.sha512 !== undefined) assert.equal(metadata.sha512, sha512)
  assert.ok(
    fs.statSync(path.join(directory, installerName + '.blockmap')).size > 0,
    'Missing differential update blockmap',
  )
  const config = load(
    fs.readFileSync(path.join(directory, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8'),
  )
  assert.equal(config.provider, 'github')
  assert.equal(config.owner, 'DarkVideoManager')
  assert.equal(config.repo, 'DarkVideoManager')
  assert.ok(!config.private && !config.token, 'An update feed must not contain account credentials')
  return {
    version,
    installer: installerName,
    bytes: installer.length,
    sha512,
    publicGitHubFeed: true,
  }
}

module.exports = { verifyUpdateMetadata }
if (require.main === module) {
  try {
    const version = require(path.join(__dirname, '..', 'package.json')).version
    console.log(
      JSON.stringify(
        verifyUpdateMetadata(path.resolve(process.argv[2] || 'dist-electron'), version),
      ),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
