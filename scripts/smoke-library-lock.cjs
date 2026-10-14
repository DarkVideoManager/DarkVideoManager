/* eslint-disable @typescript-eslint/no-var-requires -- This standalone Node smoke script uses CommonJS. */
// Verify PID-reuse recovery through the real app; all fixtures stay in a fresh temp directory.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

assert.equal(process.platform, 'win32', 'This smoke test verifies Windows PID reuse')
const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST'].every((part) => appCode.includes(part)),
  'Refusing to launch without isolated user-data and hidden-window support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-library-lock-smoke-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const videoPath = path.join(media, 'sample.mp4')
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-pix_fmt', 'yuv420p', videoPath],
  { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
)
const checksum = () => crypto.createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex')
const sourceHash = checksum()

function assertTemporary(filePath) {
  const relative = path.relative(temporary, path.resolve(filePath))
  assert.ok(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative),
    `Refusing to modify a path outside the isolated fixture: ${filePath}`,
  )
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: userData,
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  const rendererErrors = []
  try {
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualUserData).toLowerCase(), path.resolve(userData).toLowerCase())
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    const deadline = Date.now() + 30_000
    while (!(await page.evaluate(() => !!window.api?.library?.create))) {
      assert.ok(Date.now() < deadline, 'Timed out waiting for the library API')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
      'The isolated smoke window must remain hidden',
    )
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }

    const library = await invoke('library', 'create', 'PID reuse recovery smoke', media)
    assertTemporary(library.dbPath)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 1)
    const original = (await invoke('videos', 'search', library.id, {})).videos[0]
    assert.equal(original.filePath, videoPath)
    await invoke('videos', 'updateMeta', library.id, original.id, {
      memo: 'Preserve before recovery',
    })
    await invoke('library', 'close', library.id)

    const lockPath = `${library.dbPath}.lock`
    assertTemporary(lockPath)
    assert.equal(fs.existsSync(lockPath), false)
    process.kill(process.pid, 0)
    const staleLock = { pid: process.pid, acquiredAt: '2000-01-01T00:00:00.000Z' }
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), { flag: 'wx' })
    await invoke('library', 'open', library.id)
    const recoveredLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    const appPid = await app.evaluate(() => process.pid)
    assert.equal(recoveredLock.pid, appPid, 'The app must acquire the stale writer lock')
    assert.ok(Date.parse(recoveredLock.acquiredAt) > Date.parse(staleLock.acquiredAt))

    const highlight = await invoke('highlights', 'create', library.id, {
      videoId: original.id,
      timeStart: 0.5,
      label: 'Saved after stale lock recovery',
      color: 'yellow',
    })
    const thumbnail = await invoke(
      'thumbnails',
      'captureAtTime',
      library.id,
      original.id,
      0.5,
      true,
    )
    assertTemporary(thumbnail.filePath)
    assert.ok(fs.existsSync(thumbnail.filePath))
    await invoke('library', 'close', library.id)
    assert.equal(fs.existsSync(lockPath), false)
    await invoke('library', 'open', library.id)
    assert.ok(
      (await invoke('highlights', 'list', library.id, original.id)).some(
        (item) => item.id === highlight.id,
      ),
    )
    assert.ok(
      (await invoke('thumbnails', 'getForVideo', library.id, original.id)).some(
        (item) => item.id === thumbnail.id,
      ),
    )
    assert.equal(
      (await invoke('videos', 'get', library.id, original.id)).memo,
      'Preserve before recovery',
    )
    assert.equal(checksum(), sourceHash, 'The original media must remain byte-identical')
    assert.deepEqual(rendererErrors, [])
    await invoke('library', 'close', library.id)
    const report = {
      passed: [
        'real PowerShell detects a living process with a reused stale-lock PID',
        'recovered library persists new highlight and captured thumbnail across reopen',
        'existing metadata and source video remain intact; isolated window stays hidden',
      ],
      packaged: !!executablePath,
      temporary,
      staleLock,
      recoveredLock,
      rendererErrors,
    }
    fs.writeFileSync(
      path.join(
        output,
        executablePath ? 'library-lock-packaged.json' : 'library-lock-electron.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
