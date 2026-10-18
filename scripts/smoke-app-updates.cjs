// Exercise the real updater over a disposable local feed. No installer is executed.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const mainCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources', 'app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'appUpdate:get'].every((value) =>
    mainCode.includes(value),
  ),
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-update-smoke-'))
const userData = path.join(temporary, 'profile')
const payload = Buffer.from(
  'DISPOSABLE UPDATE DOWNLOAD FIXTURE. THIS FILE IS NEVER EXECUTED.\n'.repeat(4096),
)
const corrupt = Buffer.from(payload)
corrupt[30] ^= 1
const sha512 = crypto.createHash('sha512').update(payload).digest('base64')
const requests = []
const installerName = 'DarkVideoManager-Setup-99.0.0-x64.exe'
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  requests.push(pathname)
  if (/^\/(good|bad|older)\/latest\.yml$/.test(pathname)) {
    const version = pathname.startsWith('/older/') ? '0.0.1' : '99.0.0'
    res.writeHead(200, { 'Content-Type': 'text/yaml' })
    res.end(
      JSON.stringify({
        version,
        files: [{ url: installerName, sha512, size: payload.length }],
        path: installerName,
        sha512,
        releaseDate: '2026-10-18T00:00:00.000Z',
      }),
    )
  } else if (pathname === '/good/' + installerName || pathname === '/bad/' + installerName) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
    })
    res.end(pathname.startsWith('/bad/') ? corrupt : payload)
  } else {
    res.writeHead(404)
    res.end()
  }
})

async function main() {
  let app
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DVM_USER_DATA_DIR: userData,
      DVM_SMOKE_TEST: '1',
    }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
      cwd: root,
      env,
      timeout: 90000,
    })
    const report = await app.evaluate(
      async ({ app }, { baseUrl, userData, payloadSha512 }) => {
        const path = process.getBuiltinModule('node:path')
        const { createRequire } = process.getBuiltinModule('node:module')
        const appRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
        const fs = appRequire('node:fs')
        const crypto = appRequire('node:crypto')
        const assert = appRequire('node:assert/strict')
        const { NsisUpdater } = appRequire('electron-updater')
        const { ElectronHttpExecutor } = appRequire('electron-updater/out/electronHttpExecutor')
        assert.equal(
          path.resolve(app.getPath('userData')).toLowerCase(),
          path.resolve(userData).toLowerCase(),
        )
        const passed = []
        for (const name of ['good', 'bad', 'older']) {
          const directory = path.join(userData, 'update-verification', name)
          fs.mkdirSync(directory, { recursive: true })
          const configPath = path.join(directory, 'app-update.yml')
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              provider: 'generic',
              url: `${baseUrl}/${name}/`,
              updaterCacheDirName: 'isolated-updater',
            }),
          )
          let quitHooks = 0
          const adapter = {
            version: app.getVersion(),
            name: 'DVM disposable updater verification',
            isPackaged: true,
            appUpdateConfigPath: configPath,
            userDataPath: directory,
            baseCachePath: directory,
            whenReady: () => Promise.resolve(),
            quit: () => {
              throw new Error('Test must never quit for installation')
            },
            relaunch: () => {
              throw new Error('Test must never restart')
            },
            onQuit: () => {
              quitHooks++
            },
          }
          // A custom adapter isolates every cache path; inject the real Electron transport too.
          const updater = new NsisUpdater(null, adapter)
          updater.httpExecutor = new ElectronHttpExecutor()
          updater.setFeedURL({ provider: 'generic', url: `${baseUrl}/${name}/` })
          updater.autoDownload = false
          updater.autoInstallOnAppQuit = false
          updater.allowPrerelease = false
          updater.allowDowngrade = false
          updater.disableDifferentialDownload = true
          updater.logger = null
          let ready = 0
          let available = 0
          updater.on('error', () => {})
          updater.on('update-available', () => available++)
          updater.on('update-downloaded', () => ready++)
          const checked = await updater.checkForUpdates()
          if (name === 'older') {
            assert.equal(available, 0)
            assert.equal(ready, 0)
            passed.push('real updater rejects a downgrade without downloading an installer')
            continue
          }
          assert.equal(available, 1)
          if (name === 'good') {
            const files = await updater.downloadUpdate(checked.cancellationToken)
            assert.equal(files.length, 1)
            assert.equal(
              crypto.createHash('sha512').update(fs.readFileSync(files[0])).digest('base64'),
              payloadSha512,
            )
            assert.equal(ready, 1)
            assert.equal(quitHooks, 0)
            passed.push(
              'real updater checks metadata, downloads bytes and emits ready after SHA-512 verification',
            )
          } else {
            let failure
            try {
              await updater.downloadUpdate(checked.cancellationToken)
            } catch (error) {
              failure = error
            }
            assert.ok(failure && /sha512|checksum/i.test(failure.message))
            assert.equal(ready, 0)
            assert.equal(quitHooks, 0)
            passed.push(
              'a corrupted download fails integrity verification and never becomes installable',
            )
          }
        }
        return { passed, installerExecuted: false }
      },
      { baseUrl, userData, payloadSha512: sha512 },
    )
    assert.ok(requests.some((value) => value.startsWith('/good/') && value.endsWith('.exe')))
    assert.ok(!requests.some((value) => value.startsWith('/older/') && value.endsWith('.exe')))
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'test-results', 'app-updates-electron.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report))
  } finally {
    if (app) await app.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
