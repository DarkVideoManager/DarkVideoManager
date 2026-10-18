// Exercise library-card status with the real Electron queue and isolated copied media.
// Optional argument: unpacked executable. Override media with DVM_SUBTITLE_SMOKE_FIXTURE.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const { _electron: electron, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const fixture =
  process.env.DVM_SUBTITLE_SMOKE_FIXTURE ||
  path.join(os.tmpdir(), 'dvm-subtitle-smoke-20261009', 'smoke.mp4')
assert.ok(fs.existsSync(fixture), `Missing disposable spoken-audio fixture: ${fixture}`)
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'subtitle-queue.json'].every((part) =>
    appCode.includes(part),
  ),
  'Refusing to run without user-data isolation and subtitle queue support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-library-subtitle-progress-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const videoPaths = ['first.mp4', 'second.mp4'].map((name) => path.join(media, name))
for (const videoPath of videoPaths) fs.copyFileSync(fixture, videoPath)
// Keep the first job active long enough to inspect the real UI even with a warm model cache.
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  ['-y', '-stream_loop', '19', '-i', fixture, '-c', 'copy', videoPaths[0]],
  {
    windowsHide: true,
    stdio: 'ignore',
  },
)
const checksum = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originalChecksums = [fixture, ...videoPaths].map(checksum)
const errors = []
const passed = []
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DVM_USER_DATA_DIR: userData,
  DVM_SMOKE_TEST: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function until(description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(150)
  }
  throw new Error(`Timed out: ${description}`)
}

async function quit(app) {
  const closed = app.waitForEvent('close', { timeout: 60_000 })
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit())
  })
  await closed
}

async function main() {
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  try {
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualUserData).toLowerCase(), path.resolve(userData).toLowerCase())
    const page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(30_000)
    await page.setViewportSize({ width: 1440, height: 1000 })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await until('subtitle API ready', () => page.evaluate(() => !!window.api?.subtitles?.listQueue))
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    )
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const engine = await invoke('subtitles', 'getEngineInfo')
    assert.equal(engine.available, true, engine.message)
    assert.equal(await invoke('subtitles', 'setConcurrency', 1), 1)
    const library = await invoke('library', 'create', 'Library subtitle progress smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const videos = (await invoke('videos', 'search', library.id, {})).videos
    const first = videos.find((video) => video.filePath === videoPaths[0])
    const second = videos.find((video) => video.filePath === videoPaths[1])
    assert.ok(first && second)
    const options = { model: 'base', language: 'en', translateToKorean: false }
    const firstJob = await invoke('subtitles', 'generate', library.id, first.id, options)
    const secondJob = await invoke('subtitles', 'generate', library.id, second.id, options)
    assert.equal(secondJob.phase, 'queued')

    // Reload discovers the newly created isolated library; then enter through its real UI.
    await page.reload()
    await page.getByRole('button', { name: '열기', exact: true }).click()
    const firstTitle = first.title?.trim() || first.fileName
    const secondTitle = second.title?.trim() || second.fileName
    const firstStatus = page.getByRole('status', { name: `${firstTitle} 자막 작업`, exact: true })
    const secondStatus = page.getByRole('status', { name: `${secondTitle} 자막 작업`, exact: true })
    await expect(firstStatus).toContainText(
      /자막 생성 준비 중|음성 모델 로딩 중|자막 생성 중|자막 저장 중/,
      { timeout: 30_000 },
    )
    await expect(
      page.getByRole('progressbar', { name: `${firstTitle} 자막 생성 단계 진행률`, exact: true }),
    ).toBeVisible()
    await expect(secondStatus).toContainText('자막 생성 대기')
    await expect(page.getByRole('region', { name: 'AI 자막 생성', exact: true })).toHaveCount(0)
    await page.screenshot({
      path: path.join(output, 'library-subtitle-progress-packaged.png'),
      fullPage: true,
    })
    passed.push('real active and queued subtitle jobs appear on unselected library cards')

    assert.equal(await invoke('subtitles', 'pauseJob', secondJob.id), true)
    assert.equal(await invoke('subtitles', 'pauseJob', firstJob.id), true)
    await expect(firstStatus).toContainText('자막 일시정지', { timeout: 30_000 })
    await expect(secondStatus).toContainText('자막 일시정지', { timeout: 30_000 })
    passed.push('pausing active and waiting jobs updates both cards without opening details')

    assert.equal(await invoke('subtitles', 'removeJob', secondJob.id), true)
    await expect(secondStatus).toHaveCount(0, { timeout: 30_000 })
    await expect(firstStatus).toContainText('자막 일시정지')
    assert.deepEqual([fixture, ...videoPaths].map(checksum), originalChecksums)
    passed.push(
      'removing a waiting job removes only its card status; source videos remain byte-identical',
    )
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`)
    const report = { passed, temporary, packaged: !!executablePath, rendererErrors: errors }
    fs.writeFileSync(
      path.join(output, 'library-subtitle-progress-packaged.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await quit(app)
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
