const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { verifyUpdateMetadata } = require('./verify-update-metadata.cjs')

function regularPath(root, file) {
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Update asset path escapes the workspace')
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) continue
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error('Linked update asset paths are not allowed')
  }
}

function stageUpdateAssets(root, directory, version) {
  root = fs.realpathSync(root)
  directory = path.resolve(directory)
  const metadata = verifyUpdateMetadata(directory, version)
  const destination = path.join(root, 'release', 'candidate')
  regularPath(root, destination)
  const names = ['latest.yml', metadata.installer + '.blockmap']
  const allowed = new Set([
    ...names,
    metadata.installer,
    `DarkVideoManager-Portable-${version}-x64.exe`,
    `DarkVideoManager-${version}-source.tar.gz`,
    'dvm-media-corresponding-source.tar.gz',
    'BUILD.md',
    'dependencies.json',
    'SHA256SUMS.txt',
    'VERIFICATION.md',
  ])
  if (fs.existsSync(destination)) {
    for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
      if (!entry.isFile() || !allowed.has(entry.name))
        throw new Error(
          'Candidate folder contains stale or unexpected assets; use a clean candidate folder',
        )
    }
  }
  for (const name of names) {
    regularPath(root, path.join(directory, name))
    regularPath(root, path.join(destination, name))
  }
  fs.mkdirSync(destination, { recursive: true })
  for (const name of names) {
    const target = path.join(destination, name)
    const temporary = path.join(destination, '.update-' + randomUUID() + '.tmp')
    try {
      fs.copyFileSync(path.join(directory, name), temporary, fs.constants.COPYFILE_EXCL)
      fs.renameSync(temporary, target)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
  return { ...metadata, stagedUpdateAssets: names }
}

module.exports = { stageUpdateAssets }
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..')
    const version = require(path.join(root, 'package.json')).version
    console.log(
      JSON.stringify(
        stageUpdateAssets(root, path.resolve(process.argv[2] || 'dist-electron'), version),
      ),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
