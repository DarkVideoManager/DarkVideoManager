// Real main/preload/renderer checks. Every profile, database and source is disposable.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const appCode = fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'library:importFolders'].every((value) =>
    appCode.includes(value),
  ),
  'Build the isolated application with multi-folder support first',
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-library-usability-smoke-'))
const userData = path.join(temporary, 'user-data')
const folders = [path.join(temporary, 'first'), path.join(temporary, 'second')]
const nested = path.join(folders[0], 'nested')
const disconnected = path.join(temporary, 'second-disconnected')
const output = path.join(root, 'test-results')
const reportPath = path.join(output, 'library-usability-electron.json')
const screenshotPath = path.join(output, 'library-usability-electron.png')
const files = folders.map((folder, index) => path.join(folder, `synthetic-${index + 1}.mp4`))
const expectedVersion = require(path.join(root, 'package.json')).version
const passed = []
const rendererErrors = []
let application
let page
let failure
let runtime
let sourcesUnchanged = false
let cleaned = false

const identity = (value) =>
  process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function insideFixture(file) {
  const relative = path.relative(temporary, path.resolve(file))
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Fixture operation escaped its temporary directory',
  )
}
function sanitized(value) {
  let result = String(value)
  for (const [source, replacement] of [
    [temporary, '<synthetic-fixtures>'],
    [root, '<workspace>'],
    [os.homedir(), '<profile>'],
  ]) {
    result = result.split(source).join(replacement)
    result = result.split(source.replace(/\\/g, '/')).join(replacement)
  }
  return result
}
async function poll(read, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
async function invoke(group, method, ...args) {
  const result = await page.evaluate(
    async ({ group, method, args }) => window.api[group][method](...args),
    { group, method, args },
  )
  assert.equal(result.ok, true, `${group}.${method}: ${sanitized(result.error)}`)
  return result.value
}
async function expectSelected(id) {
  await poll(
    async () =>
      (await page.getByRole('combobox', { name: '라이브러리 전환' }).inputValue()) === id &&
      (await page.getByRole('textbox', { name: '영상 검색' }).isVisible()),
    'library switch settles',
  )
}

async function main() {
  for (const folder of [...folders, nested, output]) fs.mkdirSync(folder, { recursive: true })
  for (const [index, file] of files.entries()) {
    insideFixture(file)
    execFileSync(
      require('./media-paths.cjs').getFfmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=320x180:r=${index ? 24 : 12}:d=2`,
        '-t',
        '2',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        file,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 30000 },
    )
  }
  const originalHashes = files.map(hash)
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_SMOKE_TEST: '1',
    DVM_USER_DATA_DIR: userData,
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'VITE_MOCK_IPC'])
    delete env[name]
  application = await electron.launch({ args: ['.'], cwd: root, env, timeout: 60000 })
  const actual = await application.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1440, 960)
    win.webContents.setAudioMuted(true)
    win.webContents.setBackgroundThrottling(false)
    const preferences = win.webContents.getLastWebPreferences()
    return {
      pid: process.pid,
      version: app.getVersion(),
      userData: app.getPath('userData'),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    }
  })
  assert.equal(
    identity(actual.userData),
    identity(userData),
    'The application must honor the disposable profile',
  )
  insideFixture(actual.userData)
  assert.equal(actual.version, expectedVersion)
  assert.equal(actual.sandbox, true)
  assert.equal(actual.contextIsolation, true)
  assert.equal(actual.nodeIntegration, false)
  runtime = {
    version: actual.version,
    sandbox: actual.sandbox,
    contextIsolation: actual.contextIsolation,
    nodeIntegration: actual.nodeIntegration,
  }
  page = await application.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(sanitized(error.message)))
  await poll(
    () => page.evaluate(() => !!window.api?.library?.importFolders && !!document.body.innerText),
    'production preload',
  )
  assert.match(page.url(), /^file:/)
  assert.deepEqual(await invoke('library', 'list'), [])

  const combined = await invoke('library', 'create', 'Combined synthetic library', [
    nested,
    folders[0],
    folders[0],
    folders[1],
  ])
  assert.deepEqual(combined.folderPaths.map(identity), folders.map(identity))
  assert.equal(identity(combined.folderPath), identity(folders[0]))
  assert.deepEqual(
    await invoke('library', 'importFolders', combined.id, [folders[0], folders[0]]),
    { added: 1, skipped: 0, removed: 0, errors: [] },
  )
  assert.deepEqual(await invoke('library', 'refresh', combined.id), {
    added: 1,
    skipped: 1,
    removed: 0,
    errors: [],
  })
  assert.deepEqual(await invoke('library', 'importFolders', combined.id, folders), {
    added: 0,
    skipped: 2,
    removed: 0,
    errors: [],
  })
  let combinedVideos = await invoke('videos', 'search', combined.id, { page: 1, pageSize: 50 })
  assert.equal(combinedVideos.total, 2)
  const first = combinedVideos.videos.find(
    (video) => identity(video.filePath) === identity(files[0]),
  )
  assert.equal(first.fps, 12)
  assert.equal(first.codec, 'h264')
  const secondCombined = combinedVideos.videos.find(
    (video) => identity(video.filePath) === identity(files[1]),
  )
  assert.equal(secondCombined.fps, 24)
  await invoke('videos', 'updateMeta', combined.id, first.id, {
    title: 'Synthetic first video',
    memo: 'Keep this metadata',
  })
  passed.push(
    'real IPC creates a multi-root library, collapses duplicate/contained roots, imports once and refreshes all registered roots',
  )

  const single = await invoke('library', 'create', 'Separate synthetic library', folders[1])
  assert.deepEqual(single.folderPaths.map(identity), [identity(folders[1])])
  assert.equal((await invoke('library', 'importFolder', single.id, folders[1])).added, 1)
  const separateVideos = await invoke('videos', 'search', single.id, {})
  assert.equal(separateVideos.total, 1)
  await invoke('videos', 'updateMeta', single.id, separateVideos.videos[0].id, {
    title: 'Separate library video',
  })
  assert.notEqual(
    (await invoke('videos', 'get', combined.id, secondCombined.id)).title,
    'Separate library video',
  )
  passed.push(
    'single-folder compatibility and separate SQLite metadata for two saved libraries sharing one synthetic source folder',
  )

  await page.reload()
  await poll(
    () =>
      page.evaluate(
        () =>
          !!window.api?.library &&
          document.querySelectorAll('select[aria-label="라이브러리 전환"] option').length === 3,
      ),
    'two saved libraries in production UI',
  )
  const libraryCard = page
    .locator('p')
    .filter({ hasText: /^Combined synthetic library$/ })
    .locator('..')
  await libraryCard.getByRole('button', { name: '열기', exact: true }).click()
  await expectSelected(combined.id)
  const firstCard = page.getByRole('button', {
    name: 'Synthetic first video 영상 카드',
    exact: true,
  })
  await firstCard.waitFor({ state: 'visible' })
  await firstCard.click()
  const infoTab = page.getByRole('tab', { name: '정보', exact: true })
  await infoTab.waitFor({ state: 'visible' })
  assert.equal(await infoTab.getAttribute('aria-selected'), 'true')
  const technicalInfo = page.getByRole('region', { name: '영상 메타데이터', exact: true })
  await technicalInfo.waitFor({ state: 'visible' })
  assert.match(await technicalInfo.innerText(), /12 FPS/)
  assert.match(await technicalInfo.innerText(), /320 × 180/)
  assert.match(await technicalInfo.innerText(), /h264/)
  assert.equal(
    await page.locator('video').count(),
    0,
    'FPS must be visible before opening a player',
  )
  await page.getByRole('tab', { name: '하이라이트', exact: true }).click()
  assert.equal(await technicalInfo.isVisible(), false)
  await page.getByRole('tab', { name: '자막 생성', exact: true }).click()
  assert.equal(
    await page.getByRole('tab', { name: '자막 생성', exact: true }).getAttribute('aria-selected'),
    'true',
  )
  await page.getByRole('tab', { name: '하이라이트', exact: true }).click()
  // Capture only synthetic titles and the empty highlights view; file locations are not visible.
  await page.screenshot({ path: screenshotPath })
  passed.push(
    'actual renderer shows probed FPS/resolution/codec before playback and separates information, highlights and generation tabs',
  )

  const picker = page.getByRole('combobox', { name: '라이브러리 전환', exact: true })
  await picker.selectOption(single.id)
  await expectSelected(single.id)
  await page
    .getByRole('button', { name: 'Separate library video 영상 카드', exact: true })
    .waitFor({ state: 'visible' })
  assert.equal(
    await page.getByRole('tab', { name: '정보', exact: true }).count(),
    0,
    'Switching must clear the previous video selection',
  )
  assert.equal(await firstCard.count(), 0)
  await picker.selectOption(combined.id)
  await expectSelected(combined.id)
  await firstCard.waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('tab', { name: '정보', exact: true }).count(), 0)
  assert.equal(
    await application.evaluate(() => process.pid),
    actual.pid,
    'Library switching must not restart the process',
  )
  passed.push(
    'real saved-library dropdown switches both ways without restart, clears selection and isolates each video list',
  )

  const beforeFailure = (await invoke('videos', 'search', combined.id, {})).videos
    .map((video) => ({ id: video.id, memo: video.memo, title: video.title }))
    .sort((a, b) => a.id.localeCompare(b.id))
  insideFixture(folders[1])
  insideFixture(disconnected)
  fs.renameSync(folders[1], disconnected)
  try {
    await page.getByRole('button', { name: '목록 업데이트', exact: true }).click()
    await page
      .getByText('목록 업데이트 결과를 확인해 주세요. 일부 항목을 처리하지 못했습니다.', {
        exact: true,
      })
      .waitFor({ state: 'visible' })
    combinedVideos = await invoke('videos', 'search', combined.id, {})
    assert.equal(combinedVideos.total, 2)
    assert.deepEqual(
      combinedVideos.videos
        .map((video) => ({ id: video.id, memo: video.memo, title: video.title }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      beforeFailure,
    )
    assert.equal((await invoke('videos', 'search', combined.id, { removed: true })).total, 0)
    assert.equal((await invoke('videos', 'get', combined.id, first.id)).memo, 'Keep this metadata')
  } finally {
    if (fs.existsSync(disconnected)) fs.renameSync(disconnected, folders[1])
  }
  assert.equal((await invoke('library', 'refresh', combined.id)).errors.length, 0)
  passed.push(
    'a real disconnected root reports refresh failure without deleting rows, moving videos to removed items or losing metadata; reconnect recovers',
  )

  sourcesUnchanged = files.every((file, index) => hash(file) === originalHashes[index])
  assert.equal(sourcesUnchanged, true)
  assert.deepEqual(rendererErrors, [])
}

main()
  .catch((error) => {
    failure = error
    process.exitCode = 1
  })
  .finally(async () => {
    if (application) {
      try {
        await application.close()
      } catch (error) {
        failure ??= error
        process.exitCode = 1
      }
    }
    try {
      const resolved = path.resolve(temporary)
      assert.ok(
        resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
          path.basename(resolved).startsWith('dvm-library-usability-smoke-'),
        'Unsafe cleanup target',
      )
      fs.rmSync(resolved, { recursive: true, force: true })
      cleaned = !fs.existsSync(resolved)
    } catch (error) {
      failure ??= error
      process.exitCode = 1
    }
    const report = {
      completedAt: new Date().toISOString(),
      ok: !failure,
      passed,
      runtime,
      sourcesUnchanged,
      cleaned,
      rendererErrors,
      screenshot: fs.existsSync(screenshotPath) ? path.basename(screenshotPath) : null,
      limits: [
        'Native folder selection gestures, real removable drives, external players, AI generation and packaged installers are not exercised',
      ],
      error: failure ? sanitized(failure.stack ?? failure.message) : null,
    }
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ...report, report: path.basename(reportPath) }, null, 2))
  })
