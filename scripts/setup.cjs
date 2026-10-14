// Install only the dependencies in the lockfile, then explicitly acquire the runtimes.
// No files from an existing DarkVideoManager installation are needed.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

function runNode(label, script, args = []) {
  runProgram(label, process.execPath, [script, ...args])
}

function runProgram(label, executable, args) {
  console.log(`\n${label}`)
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.signal || `exit ${result.status}`}). Fix the error above and run npm run setup again.`)
  }
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean)
  const cli = candidates.find((candidate) => fs.existsSync(candidate))
  if (!cli) throw new Error('npm could not be located. Install Node.js 24 LTS with npm, then run npm run setup.')
  return cli
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 24 || minor < 18) {
    throw new Error(`Node.js 24.18.0 or newer in the 24.x LTS series is required; found ${process.versions.node}.`)
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The supported application and media runtimes target Windows x64. Run setup with Windows x64 Node.js.')
  }
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    throw new Error('package-lock.json is missing. Use a complete source checkout; setup never generates a replacement lockfile.')
  }

  // SQLite 13 ships an N-API prebuild for Windows x64 directly in its npm package.
  // Suppressing lifecycle scripts avoids compiling it against the host Node ABI.
  runNode('Installing locked dependencies...', findNpmCli(), ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  // Electron 42+ downloads on first use, so acquire it explicitly for an offline app launch.
  runNode('Acquiring the pinned Electron runtime...', path.join(root, 'node_modules/electron/install.js'))
  runProgram('Building the pinned FFmpeg and FFprobe runtimes...', 'powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/setup-media.ps1'),
  ])
  runNode('Checking native runtimes...', path.join(root, 'scripts/verify-native.cjs'))
  console.log('\nSetup complete. Run npm run build, npm test, or npm run dev.')
  console.log('AI subtitles are optional: see npm run setup:subtitles:gpu and npm run setup:subtitles in README.md.')
} catch (error) {
  console.error(`\nSetup failed: ${error.message}`)
  process.exitCode = 1
}
