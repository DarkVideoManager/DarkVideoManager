// Generate notices from the exact installed packages and shipped executables.
// No network access: downloading a dependency is the setup script's job.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'resources', 'legal', 'generated')
const strict = process.argv.includes('--check-release')
const issues = []
const slash = (value) => value.replaceAll('\\', '/')
const relative = (value) => slash(path.relative(root, value))
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const readIf = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
function assertGeneratedDestination(file) {
  const full = path.resolve(file)
  if (full !== output && !full.startsWith(output + path.sep)) throw new Error('Notice output path escapes the generated directory')
  let current = root
  const actualRoot = fs.realpathSync(root)
  for (const part of path.relative(root, full).split(path.sep)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked notice output paths are not allowed')
    if (!fs.realpathSync(current).startsWith(actualRoot + path.sep)) throw new Error('Resolved notice output path escapes the repository')
  }
}
const write = (file, content) => {
  assertGeneratedDestination(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const packageRoot = readJson(path.join(root, 'package.json'))
const lock = readJson(path.join(root, 'package-lock.json'))

function walk(directory, callback) {
  if (!fs.existsSync(directory)) return
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) walk(file, callback)
    else if (item.isFile()) callback(file)
  }
}

function copy(source, destination) {
  const target = path.join(output, destination)
  write(target, fs.readFileSync(source))
  return slash(destination)
}

function packageDirectory(name, from = root) {
  let directory = from
  while (directory === root || directory.startsWith(root + path.sep)) {
    const candidate = path.join(directory, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return null
}

const packages = new Map()
function addPackage(directory) {
  if (!directory || packages.has(directory)) return
  const metadata = readJson(path.join(directory, 'package.json'))
  packages.set(directory, metadata)
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies })) {
    const found = packageDirectory(name, directory)
    if (found) addPackage(found)
    else if (metadata.dependencies?.[name] && !metadata.optionalDependencies?.[name]) {
      issues.push(`Missing installed dependency: ${metadata.name} -> ${name}`)
    }
  }
}

// Includes all installed production packages, even where build-time tree shaking
// eliminates some code. Also include source-imported devDependencies (React, etc.).
for (const [location, entry] of Object.entries(lock.packages || {})) {
  if (!location || entry.dev || !fs.existsSync(path.join(root, location, 'package.json'))) continue
  addPackage(path.join(root, location))
}
for (const name of Object.keys(packageRoot.dependencies || {})) {
  const found = packageDirectory(name)
  if (!found) issues.push(`Missing production package: ${name}`)
  else addPackage(found)
}
for (const source of ['electron', 'src']) walk(path.join(root, source), (file) => {
  if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(?:test|spec)\./.test(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^.'"][^'"]*)['"]/g)) {
    const name = match[1].startsWith('@') ? match[1].split('/').slice(0, 2).join('/') : match[1].split('/')[0]
    if (name !== 'electron' && (packageRoot.dependencies?.[name] || packageRoot.devDependencies?.[name])) addPackage(packageDirectory(name))
  }
})

function licenseFiles(directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i.test(entry.name)) {
      found.push(path.join(directory, entry.name))
    } else if (entry.isDirectory() && /^(?:licen[cs]es?|notices?)$/i.test(entry.name)) {
      walk(path.join(directory, entry.name), (file) => found.push(file))
    } else if (entry.isDirectory() && entry.name === 'lib-vendor') {
      walk(path.join(directory, entry.name), (file) => {
        if (/^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i.test(path.basename(file))) found.push(file)
      })
    }
  }
  if (!found.length) {
    const readme = path.join(directory, 'README.md')
    // Some npm packages place the complete license grant in their README.
    if (/Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED/.test(readIf(readme))) found.push(readme)
  }
  return found.sort()
}

// This directory belongs exclusively to this generator. Resolve and verify it
// before replacing old-version notices so stale files cannot enter a release.
assertGeneratedDestination(output)
if (fs.existsSync(output)) {
  const resolvedOutput = fs.realpathSync(output)
  const resolvedRoot = fs.realpathSync(root)
  if (resolvedOutput !== path.join(resolvedRoot, 'resources', 'legal', 'generated')) throw new Error('Unexpected generated-notice directory target')
  fs.rmSync(resolvedOutput, { recursive: true, force: true })
}
fs.mkdirSync(output, { recursive: true })
const npm = [...packages.entries()].sort(([a], [b]) => relative(a).localeCompare(relative(b))).map(([directory, metadata]) => {
  const location = relative(directory)
  const license = typeof metadata.license === 'string' ? metadata.license
    : metadata.license?.type || metadata.licenses?.map((entry) => entry.type).join(' OR ') || 'UNDECLARED'
  const destination = `npm/${location.replaceAll('node_modules/', '').replaceAll('/', '__')}@${metadata.version}`
  const licenses = licenseFiles(directory).map((file) => copy(file, `${destination}/${slash(path.relative(directory, file))}`))
  const supplementDirectory = path.join(root, 'resources/legal/upstream', `${metadata.name.replaceAll('/', '__')}-${metadata.version}`)
  if (fs.existsSync(supplementDirectory)) {
    for (const file of licenseFiles(supplementDirectory)) licenses.push(copy(file, `${destination}/upstream-${path.basename(file)}`))
  }
  if (!licenses.length) issues.push(`Missing license text: ${metadata.name}@${metadata.version}`)
  return {
    name: metadata.name, version: metadata.version, license, location,
    repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || null,
    integrity: lock.packages?.[location]?.integrity || null, licenseFiles: licenses,
  }
})

const electronPackage = readJson(path.join(root, 'node_modules/electron/package.json'))
const electron = { version: electronPackage.version, licenseFiles: [] }
for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
  const source = path.join(root, 'node_modules/electron/dist', file)
  if (fs.existsSync(source)) electron.licenseFiles.push(copy(source, `electron/${file}`))
  else issues.push(`Missing Electron distribution notice: ${file}`)
}

const media = []
for (const [name, location] of [
  ['ffmpeg', 'resources/media/win32-x64/ffmpeg.exe'],
  ['ffprobe', 'resources/media/win32-x64/ffprobe.exe'],
]) {
  const executable = path.join(root, location)
  if (!fs.existsSync(executable)) { issues.push(`Missing media executable: ${location}`); continue }
  const invoke = (args) => {
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect ${name}: ${result.error?.message || result.stderr}`)
    return `${result.stdout || ''}${result.stderr || ''}`.replaceAll('\r\n', '\n')
  }
  const version = invoke(['-version'])
  const license = invoke(['-L'])
  write(path.join(output, 'media', `${name}-version.txt`), version)
  write(path.join(output, 'media', `${name}-license-report.txt`), license)
  const detectedLicense = /GNU General Public License[\s\S]*either version 3[\s\S]*any later version/.test(license) ? 'GPL-3.0-or-later' : 'REVIEW_REQUIRED'
  if (detectedLicense === 'REVIEW_REQUIRED') issues.push(`Unrecognized media license report: ${name}`)
  const entry = { name, executable: location, sha256: hash(executable), version: version.split('\n')[0], license: detectedLicense }
  media.push(entry)
  const readme = `${executable}.README`
  if (fs.existsSync(readme)) copy(readme, `media/${name}-upstream-README.txt`)
  const licenseText = `${executable}.LICENSE`
  if (fs.existsSync(licenseText)) copy(licenseText, `media/${name}-LICENSE.txt`)
}
// The ffprobe npm wrapper's MIT license does not cover its GPL executable.
walk(path.join(root, 'resources/media/licenses'), (file) => copy(file, `media/${path.basename(file)}`))
if (media.length && !fs.existsSync(path.join(root, 'resources/media/licenses/COPYING.GPLv3'))) issues.push('Missing complete media GPLv3 license text')
if (strict) {
  const checked = spawnSync(process.execPath, [path.join(root, 'scripts/finalize-media.cjs'), '--verify', '--quiet'], { windowsHide: true, stdio: 'ignore' })
  if (checked.error || checked.status !== 0) issues.push('Media runtime, source receipts or current build recipe do not match; run setup-media and finalize-media')
}
for (const [source, target] of [
  ['docs/third-party-licenses.md', 'DISTRIBUTION.md'],
  ['resources/media/runtime-manifest.json', 'media/runtime-manifest.json'],
  ['resources/legal/media-source-receipts.json', 'media/media-source-receipts.json'],
  ['release/sources/BUILD.md', 'media/BUILD.md'],
  ['release/sources/dependencies.json', 'media/dependencies.json'],
]) {
  if (fs.existsSync(path.join(root, source))) copy(path.join(root, source), target)
}

const nativeDirectory = path.join(root, 'resources/subtitles/native')
const certificateDirectory = path.join(root, 'resources/subtitles/certificates')
const certificateReceipt = path.join(certificateDirectory, 'manifest.json')
const certificates = { included: false, receipt: null, sha256: null, licenseFiles: [] }
if (fs.existsSync(certificateReceipt)) {
  certificates.receipt = readJson(certificateReceipt)
  const bundle = path.join(certificateDirectory, 'mozilla-ca.crt')
  if (fs.existsSync(bundle)) {
    certificates.sha256 = hash(bundle)
    certificates.included = true
    if (certificates.sha256 !== certificates.receipt.sha256) issues.push('Subtitle public CA bundle hash mismatch')
  } else issues.push('Missing subtitle public CA bundle')
  for (const name of ['LICENSE.txt', 'MPL-2.0.txt', 'manifest.json']) {
    const file = path.join(certificateDirectory, name)
    if (fs.existsSync(file)) certificates.licenseFiles.push(copy(file, `subtitle-certificates/${name}`))
    else issues.push(`Missing subtitle public CA notice: ${name}`)
  }
} else issues.push('Missing subtitle public CA receipt')
const native = { included: false, version: null, licenseFiles: [], binaries: [] }
walk(nativeDirectory, (file) => {
  if (/\.(?:exe|dll|pyd)$/i.test(file)) native.binaries.push({ file: relative(file), sha256: hash(file) })
})
native.included = native.binaries.length > 0
if (native.included) {
  for (const file of ['whisper/whisper-cli.exe', 'python/python.exe']) {
    if (!fs.existsSync(path.join(nativeDirectory, file))) issues.push(`Partial native subtitle runtime: missing ${file}`)
  }
  const versionFile = path.join(nativeDirectory, 'runtime-version.json')
  if (fs.existsSync(versionFile)) native.version = readJson(versionFile)
  else issues.push('Missing native subtitle runtime-version.json')
  const required = ['whisper.cpp-LICENSE.txt', 'ggml-LICENSE.txt', 'LLVM-MinGW-LICENSE.txt', 'MinGW-COPYING', 'MinGW-COPYING.MinGW-w64-runtime.txt', 'MinGW-COPYING.winpthreads.txt', 'SPIRV-Headers-LICENSE.txt', 'Vulkan-Headers-LICENSE.md', 'Vulkan-Hpp-LICENSE.txt']
  for (const file of required) if (!fs.existsSync(path.join(nativeDirectory, 'licenses', file))) issues.push(`Missing native license: ${file}`)
  walk(path.join(nativeDirectory, 'licenses'), (file) => native.licenseFiles.push(copy(file, `subtitles/${slash(path.relative(path.join(nativeDirectory, 'licenses'), file))}`)))
  const pythonLicense = path.join(nativeDirectory, 'python/LICENSE.txt')
  if (fs.existsSync(pythonLicense)) native.licenseFiles.push(copy(pythonLicense, 'subtitles/Python-LICENSE.txt'))
  else issues.push('Missing embedded Python LICENSE.txt')
}

function safeSourceFile(value) {
  if (typeof value !== 'string' || path.isAbsolute(value)) return null
  const file = path.resolve(root, value)
  return file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null
}

const receiptPath = path.join(root, 'resources/legal/media-source-receipts.json')
const sourceReceipts = fs.existsSync(receiptPath) ? readJson(receiptPath).artifacts || [] : []
const sourceIssues = []
for (const binary of media) {
  const receipt = sourceReceipts.find((entry) => entry.binarySha256 === binary.sha256)
  if (!receipt) { sourceIssues.push(`${binary.name}: no corresponding-source receipt for SHA256 ${binary.sha256}`); continue }
  for (const [field, hashField] of [['archive', 'archiveSha256'], ['buildInstructions', 'buildInstructionsSha256'], ['dependencyInventory', 'dependencyInventorySha256']]) {
    const file = safeSourceFile(receipt[field])
    if (!file || !/^[a-f0-9]{64}$/i.test(receipt[hashField] || '') || hash(file) !== receipt[hashField]) sourceIssues.push(`${binary.name}: missing or mismatched ${field}`)
  }
  if (!receipt.reviewedSourceCompleteness || !receipt.sourceRevision || !receipt.releaseAssetName) sourceIssues.push(`${binary.name}: source completeness review, revision, or release asset name missing`)
}

const inventory = {
  schemaVersion: 1, application: { name: packageRoot.name, version: packageRoot.version },
  scope: 'Installed production dependency closure plus runtime imports; conservative superset of packaged JavaScript. Exact installed Electron, media and optional native subtitle runtimes.',
  packageLockSha256: hash(path.join(root, 'package-lock.json')),
  npm, electron, media, native, certificates, issues, correspondingSourceIssues: sourceIssues,
}
write(path.join(output, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
const rows = npm.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.licenseFiles.map((file) => `[text](${file})`).join(', ') || 'MISSING'} |`)
write(path.join(output, 'INDEX.md'), [
  '# Third-party notices for this build', '',
  'Generated by `scripts/generate-third-party-notices.cjs`. Exact versions and SHA256 values are in [inventory.json](inventory.json). License texts are copied without modification from installed packages and runtime distributions. Unused production packages may be listed conservatively.', '',
  `Electron ${electron.version}: [MIT](electron/LICENSE), [Chromium and bundled component notices](electron/LICENSES.chromium.html).`, '',
  'Media executables are separate GPL programs. See [distribution requirements](DISTRIBUTION.md).', '',
  ...media.map((entry) => `- ${entry.version}: ${entry.license}; SHA256 \`${entry.sha256}\`.`), '',
  '## JavaScript packages', '', '| Package | Version | Declared license | Original notices |', '| --- | --- | --- | --- |', ...rows, '',
  '## Native subtitle runtime', '',
  native.included ? `Version receipt: \`${JSON.stringify(native.version)}\`.` : 'Optional native subtitle runtime is not present in this build.', '',
  ...native.licenseFiles.map((file) => `- [${file}](${file})`), '',
  '## Subtitle HTTPS certificate bundle', '',
  certificates.included ? `Unmodified certifi ${certificates.receipt.source.version} Mozilla public CA data, MPL-2.0; SHA256 \`${certificates.sha256}\`.` : 'Public CA bundle is missing.', '',
  ...certificates.licenseFiles.map((file) => `- [${file}](${file})`), '',
  '## Release checks', '',
  ...[...issues, ...sourceIssues].map((issue) => `- ${issue}`), '',
].join('\n'))
console.log(`Generated notices for ${npm.length} npm packages, Electron ${electron.version}, ${media.length} media executables${native.included ? ', and the native subtitle runtime' : ''}.`)
for (const issue of issues) console.error(`NOTICE: ${issue}`)
for (const issue of sourceIssues) console.error(`SOURCE: ${issue}`)
if (issues.length || (strict && sourceIssues.length)) process.exitCode = 1
