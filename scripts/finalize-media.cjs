const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const directory = path.join(root, 'resources/media')
const manifestFile = path.join(root, 'resources/media-manifest.json')
const input = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const quiet = process.argv.includes('--quiet')
const verifyOnly = process.argv.includes('--verify')
const slash = (value) => value.replaceAll('\\', '/')
const relative = (value) => slash(path.relative(root, value))
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const hash = (file) => digest(fs.readFileSync(file))
const recipeHash = digest(Buffer.concat([fs.readFileSync(manifestFile), fs.readFileSync(path.join(root, 'scripts/build-media.sh'))])).slice(0, 20)
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const noticeNames = [
  'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3',
  'FFmpeg-LICENSE.md', 'LLVM-MinGW-LICENSE.txt', 'MinGW-COPYING',
  'MinGW-COPYING.MinGW-w64-runtime.txt', 'MinGW-COPYING.MinGW-w64.txt',
  'MinGW-COPYING.winpthreads.txt', 'MinGW-COPYING.winstorecompat.txt', 'x264-COPYING.txt',
]
// Resolve every component below the workspace before any reads/writes. Merely
// checking a lexical prefix would permit release/source junctions to escape it.
function safePath(file, allowMissing = false) {
  const full = path.resolve(file)
  if (!full.startsWith(root + path.sep)) throw new Error('Artifact path escapes the repository')
  let current = root
  for (const part of path.relative(root, full).split(path.sep)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) {
      // lstat also catches dangling symbolic links, which existsSync omits.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked artifact path is not allowed: ${relative(current)}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!allowMissing) throw new Error(`Missing artifact: ${relative(current)}`)
      continue
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`Linked artifact path is not allowed: ${relative(current)}`)
    const actual = fs.realpathSync(current)
    const actualRoot = fs.realpathSync(root)
    if (!actual.startsWith(actualRoot + path.sep)) throw new Error('Resolved artifact path escapes the repository')
  }
  return full
}
function regularFile(file) {
  const full = safePath(file)
  if (!fs.lstatSync(full).isFile()) throw new Error(`Expected regular artifact file: ${relative(full)}`)
  return full
}
const write = (file, data) => {
  safePath(file, true)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}
const writeJson = (file, data) => write(file, JSON.stringify(data, null, 2) + '\n')
const inside = (file) => {
  const full = path.resolve(root, file)
  return regularFile(full)
}

function verify() {
  const runtime = json(regularFile(path.join(directory, 'runtime-manifest.json')))
  if (runtime.recipeHash !== recipeHash) throw new Error('The media artifact does not match the current source/build recipe')
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = regularFile(path.join(directory, 'win32-x64', `${name}.exe`))
    if (hash(file) !== runtime.binaries[name]) throw new Error(`Media binary hash mismatch: ${name}`)
  }
  const receipts = json(regularFile(path.join(root, 'resources/legal/media-source-receipts.json')))
  for (const binaryHash of Object.values(runtime.binaries)) {
    const receipt = receipts.artifacts.find((entry) => entry.binarySha256 === binaryHash)
    if (!receipt) throw new Error('Missing matching corresponding-source receipt')
    for (const [key, hashKey] of [['archive', 'archiveSha256'], ['buildInstructions', 'buildInstructionsSha256'], ['dependencyInventory', 'dependencyInventorySha256']]) {
      if (hash(inside(receipt[key])) !== receipt[hashKey]) throw new Error(`Corresponding source hash mismatch: ${key}`)
    }
  }
  const expectedNotices = noticeNames.map((file) => relative(path.join(directory, 'licenses', file)))
  if (Object.keys(runtime.licenseFiles || {}).sort().join('\n') !== expectedNotices.sort().join('\n')) throw new Error('Media license inventory is incomplete or contains unexpected entries')
  for (const [file, checksum] of Object.entries(runtime.licenseFiles)) {
    if (hash(inside(file)) !== checksum) throw new Error(`Media notice hash mismatch: ${file}`)
  }
  if (!quiet) console.log('Media binaries, recipe, notices and corresponding-source archive match.')
}

try {
  if (verifyOnly) {
    verify()
  } else {
    const buildHash = fs.readFileSync(regularFile(path.join(directory, 'recipe-hash.txt')), 'utf8').trim()
    if (buildHash !== recipeHash) throw new Error('Build receipt differs from the current recipe; rebuild the media runtime first')
    const materials = path.join(directory, 'source-materials')
    safePath(materials)
    const sourceAssets = input.assets.filter((entry) => entry.id !== 'toolchain')
    for (const asset of sourceAssets) {
      if (!asset.filename || path.basename(asset.filename) !== asset.filename || asset.filename.includes('\\')) throw new Error('Invalid source archive filename')
    }
    const requiredMaterials = [
      'BUILD.md', 'resources/media-manifest.json', 'scripts/build-media.sh', 'scripts/finalize-media.cjs',
      ...sourceAssets.map((asset) => `sources/${asset.filename}`),
      ...noticeNames.map((file) => `licenses/${file}`),
    ]
    const allowedMaterials = new Set([...requiredMaterials, 'dependencies.json'])
    function checkMaterials(folder) {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = safePath(path.join(folder, item.name))
        const name = slash(path.relative(materials, file))
        if (item.isDirectory()) {
          if (![...allowedMaterials].some((entry) => entry.startsWith(name + '/'))) throw new Error(`Unexpected source material directory: ${name}`)
          checkMaterials(file)
        } else if (!item.isFile() || !allowedMaterials.has(name)) throw new Error(`Unexpected source material file: ${name}`)
      }
    }
    checkMaterials(materials)
    for (const file of requiredMaterials) regularFile(path.join(materials, file))
    const buildDocument = fs.existsSync(path.join(root, 'docs/media-build.md')) ? path.join(root, 'docs/media-build.md') : path.join(root, 'BUILD.md')
    for (const [staged, authoritative] of [
      ['scripts/build-media.sh', path.join(root, 'scripts/build-media.sh')],
      ['resources/media-manifest.json', manifestFile],
      ['BUILD.md', buildDocument],
      ...noticeNames.map((file) => [`licenses/${file}`, path.join(directory, 'licenses', file)]),
    ]) {
      if (hash(regularFile(path.join(materials, staged))) !== hash(regularFile(authoritative))) throw new Error(`Stale or mismatched source material: ${staged}`)
    }
    for (const asset of input.assets.filter((entry) => entry.id !== 'toolchain')) {
      if (hash(path.join(materials, 'sources', asset.filename)) !== asset.sha256) throw new Error(`Source archive mismatch: ${asset.filename}`)
    }
    const binaries = Object.fromEntries(['ffmpeg', 'ffprobe'].map((name) => [name, hash(regularFile(path.join(directory, 'win32-x64', `${name}.exe`)))]))
    const imports = Object.fromEntries(['ffmpeg', 'ffprobe'].map((name) => [name, fs.readFileSync(regularFile(path.join(directory, `${name}-imports.txt`)), 'utf8').trim().split(/\r?\n/)]))
    if (Object.values(imports).flat().some((line) => /(?:libgcc|libstdc\+\+|libwinpthread|libc\+\+|x264).*\.dll/i.test(line))) {
      throw new Error('A non-system dynamic runtime was unexpectedly linked; review the build and bundle before distribution')
    }
    const inventory = {
      schemaVersion: 1, recipeHash,
      ffmpegVersion: input.ffmpegVersion, x264Revision: input.x264Revision,
      sourcePatches: [],
      configuredExternalLibraries: ['libx264'],
      license: 'GPL-3.0-or-later',
      assets: input.assets,
      binaries, importedDlls: imports,
      recipe: 'scripts/build-media.sh',
      buildEnvironment: 'Ubuntu 24.04 x86_64 host; portable LLVM-MinGW and locally built NASM pinned by the manifest; standard host build tools.',
    }
    const destination = path.join(root, 'release/sources')
    safePath(destination, true)
    fs.mkdirSync(destination, { recursive: true })
    const staging = fs.mkdtempSync(path.join(destination, '.media-source-stage-'))
    // Only an explicit file set enters the archive. Even a previously generated
    // materials tree cannot add private notes, links, logs or unrelated files.
    for (const file of requiredMaterials) {
      const source = file === 'scripts/finalize-media.cjs' ? __filename : path.join(materials, file)
      write(path.join(staging, file), fs.readFileSync(regularFile(source)))
    }
    writeJson(path.join(staging, 'dependencies.json'), inventory)
    const archive = path.join(destination, 'dvm-media-corresponding-source.tar.gz')
    safePath(archive, true)
    const tar = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', archive, '-C', staging, '.'], { windowsHide: true, stdio: 'inherit' })
    if (tar.error || tar.status !== 0) throw new Error(`Cannot package corresponding source: ${tar.error?.message || tar.status}`)
    const buildInstructions = path.join(destination, 'BUILD.md')
    const dependencyInventory = path.join(destination, 'dependencies.json')
    write(buildInstructions, fs.readFileSync(regularFile(buildDocument)))
    writeJson(dependencyInventory, inventory)
    const common = {
      sourceRevision: `FFmpeg ${input.ffmpegVersion}; x264 ${input.x264Revision}`,
      archive: relative(archive), archiveSha256: hash(archive),
      buildInstructions: relative(buildInstructions), buildInstructionsSha256: hash(buildInstructions),
      dependencyInventory: relative(dependencyInventory), dependencyInventorySha256: hash(dependencyInventory),
      reviewedSourceCompleteness: 'Controlled build from the included FFmpeg and x264 sources; autodetection disabled, libx264 is the only enabled external codec library; no source patches. Original build recipe, pinned toolchain receipt and license texts included.',
      releaseAssetName: path.basename(archive),
    }
    writeJson(path.join(root, 'resources/legal/media-source-receipts.json'), {
      artifacts: Object.entries(binaries).map(([name, binarySha256]) => ({ name, binarySha256, ...common })),
    })
    const licenseFiles = {}
    for (const file of noticeNames) {
      const full = path.join(directory, 'licenses', file)
      licenseFiles[relative(full)] = hash(regularFile(full))
    }
    writeJson(path.join(directory, 'runtime-manifest.json'), { schemaVersion: 1, recipeHash, binaries, licenseFiles })
    verify()
    // The freshly created staging directory is resolved and checked before
    // cleanup; it cannot be a caller-supplied path or an external junction.
    safePath(staging)
    fs.rmSync(staging, { recursive: true, force: true })
    console.log(`Source distribution: ${relative(archive)}`)
  }
} catch (error) {
  if (!quiet) console.error(error.message)
  process.exitCode = 1
}
