// Real renderer/preload/IPC checks against synthetic files and a new isolated app profile.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const expectedVersion = require(path.join(root, 'package.json')).version
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
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST'].every((value) => appCode.includes(value)),
  'Refusing to launch an application without isolated smoke support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-release-031-smoke-'))
const mediaDirectory = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
fs.mkdirSync(mediaDirectory)
fs.mkdirSync(output, { recursive: true })
const files = [
  path.join(mediaDirectory, '한글 영상 1.mp4'),
  path.join(mediaDirectory, '다음 영상 2.mp4'),
]
const identity = (value) =>
  process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function assertInside(file, parent = temporary) {
  const relative = path.relative(parent, path.resolve(file))
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Refusing a fixture or application path outside the isolated directory',
  )
}
for (const [index, file] of files.entries()) {
  assertInside(file)
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
      index === 0 ? 'testsrc2=s=320x180:r=12:d=8' : 'color=c=red:s=480x270:r=12:d=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=8',
      '-t',
      '8',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      file,
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
  )
}
const originalHashes = files.map(hash)
const passed = []
const rendererErrors = []
const revoked = []
const reportPath = path.join(
  output,
  `release-031-${executablePath ? 'packaged' : 'electron'}-smoke.json`,
)
const screenshotPath = reportPath.replace(/\.json$/, '.png')
let application
let failure
let playbackClock
let chosenThumbnail
let currentPage
let failureUi
let launchState
const runtimeLogs = { stdout: '', stderr: '' }

async function poll(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}

async function launch() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_SMOKE_TEST: '1',
    DVM_USER_DATA_DIR: userData,
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'VITE_MOCK_IPC'])
    delete env[name]
  application = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  for (const channel of ['stdout', 'stderr']) {
    application.process()[channel]?.on('data', (chunk) => {
      runtimeLogs[channel] = (runtimeLogs[channel] + chunk.toString('utf8')).slice(-16_384)
    })
  }
  launchState = await application.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    nodeEnv: process.env.NODE_ENV,
    smoke: process.env.DVM_SMOKE_TEST,
    version: app.getVersion(),
  }))
  assert.equal(
    identity(launchState.userData),
    identity(userData),
    'App did not honor its isolated profile before creating its first window',
  )
  assertInside(launchState.userData)
  assert.equal(launchState.nodeEnv, 'production')
  assert.equal(launchState.smoke, '1')
  assert.equal(launchState.version, expectedVersion, 'App must match the version being released')
  const page = await application.firstWindow({ timeout: 30_000 })
  currentPage = page
  const actual = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const preferences = window.webContents.getLastWebPreferences()
    window.webContents.setBackgroundThrottling(false)
    // The fixtures contain a tone; exercise real decoding without playing audio on the host.
    window.webContents.setAudioMuted(true)
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      nodeEnv: process.env.NODE_ENV,
      smoke: process.env.DVM_SMOKE_TEST,
      hidden: !window.isVisible(),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    }
  })
  assert.equal(
    identity(actual.userData),
    identity(userData),
    'App did not honor its isolated profile',
  )
  assertInside(actual.userData)
  assert.equal(actual.nodeEnv, 'production')
  assert.equal(actual.version, expectedVersion, 'App must match the version being released')
  assert.equal(actual.smoke, '1')
  assert.equal(actual.hidden, true)
  assert.equal(actual.sandbox, true)
  assert.equal(actual.contextIsolation, true)
  assert.equal(actual.nodeIntegration, false)
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  // Production CSP rejects waitForFunction's eval; evaluate polling preserves that CSP.
  await poll(
    () => page.evaluate(() => !!window.api?.temporaryPlayback && !!window.api?.library),
    'real preload API',
  )
  assert.match(page.url(), /^file:/, 'Smoke must load the built production renderer')
  const watchRejections = () => {
    window.release031Unhandled = []
    window.addEventListener('unhandledrejection', (event) =>
      window.release031Unhandled.push(String(event.reason)),
    )
  }
  await page.addInitScript(watchRejections)
  await page.evaluate(watchRejections)
  return page
}

async function invoke(page, group, method, ...args) {
  const result = await page.evaluate(
    async ({ group, method, args }) => window.api[group][method](...args),
    { group, method, args },
  )
  assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
  return result.value
}

async function probe(url, range = false) {
  assert.equal(new URL(url).protocol, 'local-media:')
  assertInside(new URL(url).searchParams.get('path'))
  return application.evaluate(
    async ({ net }, { url, range }) => {
      const response = await net.fetch(
        url,
        range ? { headers: { range: 'bytes=0-15' } } : { method: 'HEAD' },
      )
      return { status: response.status, length: (await response.arrayBuffer()).byteLength }
    },
    { url, range },
  )
}

async function dropDiskFile(page, file, width) {
  assertInside(file)
  // setInputFiles gives this File its real disk provenance. Do not synthesize its path or replace an IPC handler.
  await page.evaluate(() => {
    document.getElementById('release031-file')?.remove()
    const input = document.createElement('input')
    input.id = 'release031-file'
    input.type = 'file'
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#release031-file').setInputFiles(file)
  const provenance = await page.evaluate(() => {
    const input = document.getElementById('release031-file')
    const file = input.files[0]
    const transfer = new DataTransfer()
    transfer.items.add(file)
    window.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
    input.remove()
    return { name: file.name, size: file.size }
  })
  assert.equal(provenance.name, path.basename(file))
  assert.equal(provenance.size, fs.statSync(file).size)
  await page
    .getByRole('main', { name: '임시 영상 재생', exact: true })
    .waitFor({ state: 'visible' })
  await page
    .getByRole('heading', { name: path.basename(file), exact: true })
    .waitFor({ state: 'visible' })
  await poll(
    () =>
      page.evaluate((width) => {
        const video = document.querySelector('video[aria-label="드롭한 영상"]')
        return !!video && video.readyState >= 2 && video.videoWidth === width && video.duration > 7
      }, width),
    'real temporary video decoding',
  )
  const source = await page.evaluate(() => {
    const video = document.querySelector('video[aria-label="드롭한 영상"]')
    video.pause()
    video.muted = true
    return video.src
  })
  assert.equal(identity(new URL(source).searchParams.get('path')), identity(fs.realpathSync(file)))
  assert.ok(
    new URL(source).searchParams.get('temporary'),
    'Temporary playback needs a scoped grant',
  )
  assert.deepEqual(await probe(source, true), { status: 206, length: 16 })
  return source
}

async function revoke(source, description) {
  await poll(async () => (await probe(source)).status === 403, description)
  revoked.push(description)
}

async function openLibraryUi(page, name, file) {
  await page.reload()
  await page.getByText(name, { exact: true }).waitFor({ state: 'visible' })
  const open = page.getByRole('button', { name: '열기', exact: true })
  if (await open.count()) await open.first().click()
  const card = page.getByRole('button', { name: `${path.basename(file)} 영상 카드`, exact: true })
  await card.waitFor({ state: 'visible' })
  return card
}

async function main() {
  let page = await launch()
  assert.deepEqual(await invoke(page, 'library', 'list'), [])
  const fake = await page.evaluate(() =>
    window.api.temporaryPlayback.openDroppedFiles([
      new File(['synthetic, without a backing disk file'], 'fake.mp4', { type: 'video/mp4' }),
    ]),
  )
  assert.equal(fake.ok, false, 'Synthetic File objects must not obtain filesystem authority')
  const bareSource = `local-media://file?path=${encodeURIComponent(fs.realpathSync(files[0]))}`
  assert.equal(
    (await probe(bareSource)).status,
    403,
    'An unregistered file must not be readable without a grant',
  )
  const first = await dropDiskFile(page, files[0], 320)
  const second = await dropDiskFile(page, files[1], 480)
  assert.notEqual(
    new URL(first).searchParams.get('temporary'),
    new URL(second).searchParams.get('temporary'),
  )
  await revoke(first, 'replacement revokes the prior temporary grant')
  assert.deepEqual(
    await invoke(page, 'library', 'list'),
    [],
    'Drop playback must not create a library',
  )
  await page.getByRole('button', { name: '재생 닫기', exact: true }).click()
  await page
    .getByRole('main', { name: '임시 영상 재생', exact: true })
    .waitFor({ state: 'detached' })
  await revoke(second, 'closing playback revokes its grant')
  const navigating = await dropDiskFile(page, files[0], 320)
  await page.reload()
  await poll(() => page.evaluate(() => !!window.api?.library), 'preload after navigation')
  await revoke(navigating, 'top-level navigation revokes its temporary grant')
  assert.deepEqual(await invoke(page, 'library', 'list'), [])
  passed.push(
    'disk-backed File crosses the real drop/preload/IPC path; H.264 and scoped range streaming work',
    'synthetic File rejected; replacement, close and navigation revoke grants; temporary playback creates no library',
  )

  const libraryName = 'Release 0.3.1 smoke'
  const library = await invoke(page, 'library', 'create', libraryName, mediaDirectory)
  assertInside(library.dbPath)
  await invoke(page, 'library', 'open', library.id)
  assert.equal((await invoke(page, 'library', 'importFolder', library.id, mediaDirectory)).added, 2)
  const videos = (await invoke(page, 'videos', 'search', library.id, { page: 1, pageSize: 20 }))
    .videos
  const item = videos.find((video) => identity(video.filePath) === identity(files[0]))
  assert.ok(item)
  await invoke(page, 'thumbnails', 'ensureForVideo', library.id, item.id, false)
  const thumbnails = await invoke(page, 'thumbnails', 'getForVideo', library.id, item.id)
  assert.ok(thumbnails.length >= 2, 'Real FFmpeg must generate alternative candidates')
  const selectedIndex = thumbnails.findIndex((thumbnail) => !thumbnail.isPrimary)
  assert.ok(selectedIndex >= 0)
  chosenThumbnail = thumbnails[selectedIndex]
  assertInside(chosenThumbnail.filePath)
  let card = await openLibraryUi(page, libraryName, files[0])
  await card.click()
  const candidate = page.getByRole('button', {
    name: `후보 ${selectedIndex + 1} 대표 썸네일로 선택`,
    exact: true,
  })
  await candidate.waitFor({ state: 'visible' })
  await poll(() => candidate.isEnabled(), 'candidate image available and thumbnail job settled')
  await candidate.click()
  await poll(
    async () => (await candidate.getAttribute('aria-pressed')) === 'true',
    'representative selection saved',
  )
  assert.equal(
    identity((await invoke(page, 'videos', 'get', library.id, item.id)).primaryThumbnailPath),
    identity(chosenThumbnail.filePath),
  )
  for (const image of [card.locator('img'), page.getByAltText('썸네일', { exact: true })]) {
    await poll(
      async () =>
        identity(new URL(await image.getAttribute('src')).searchParams.get('path')) ===
        identity(chosenThumbnail.filePath),
      'card and detail display the chosen representative',
    )
  }
  passed.push(
    'real generated candidates selected through the UI and reflected in library IPC, card and detail',
  )

  await card.dblclick()
  await poll(
    () =>
      page.evaluate(() => {
        const video = document.querySelector('video')
        return !!video && video.readyState >= 3 && video.videoWidth === 320 && video.duration > 7
      }),
    'real library video ready for playback',
  )
  await page.getByRole('combobox', { name: '재생 배속 선택', exact: true }).selectOption('1.5')
  await poll(
    () => page.evaluate(() => document.querySelector('video')?.playbackRate === 1.5),
    '1.5x media rate',
  )
  playbackClock = await page.evaluate(async () => {
    const video = document.querySelector('video')
    video.pause()
    video.muted = true
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic media seek timed out')), 5000)
      video.addEventListener(
        'seeked',
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
      video.currentTime = 1.25
    })
    await video.play()
    const start = { time: video.currentTime, wall: performance.now() }
    await new Promise((resolve) => setTimeout(resolve, 650))
    video.pause()
    return {
      mediaSeconds: video.currentTime - start.time,
      wallSeconds: (performance.now() - start.wall) / 1000,
      rate: video.playbackRate,
      preservesPitch: video.preservesPitch,
      paused: video.paused,
    }
  })
  assert.equal(playbackClock.rate, 1.5)
  assert.equal(playbackClock.preservesPitch, true)
  assert.ok(
    playbackClock.mediaSeconds / playbackClock.wallSeconds > 1.05 &&
      playbackClock.mediaSeconds / playbackClock.wallSeconds < 1.95,
    'Decoded media clock must advance at approximately 1.5x',
  )
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 3
  })
  await poll(
    () =>
      page.evaluate(() => {
        const video = document.querySelector('video')
        return video.paused && Math.abs(video.currentTime - 3) < 0.1 && video.playbackRate === 1.5
      }),
    'pause and seeking retain the selected rate',
  )
  await page.getByRole('button', { name: '1배속으로 복귀', exact: true }).click()
  await poll(
    () => page.evaluate(() => document.querySelector('video')?.playbackRate === 1),
    'normal speed restored',
  )
  passed.push(
    'real decoded media clock advances at 1.5x; pause/seek retain rate; UI restores 1x with pitch preservation enabled',
  )
  assert.deepEqual(await page.evaluate(() => window.release031Unhandled), [])
  await application.close()
  application = undefined

  page = await launch()
  await invoke(page, 'library', 'open', library.id)
  assert.equal(
    identity((await invoke(page, 'videos', 'get', library.id, item.id)).primaryThumbnailPath),
    identity(chosenThumbnail.filePath),
  )
  card = await openLibraryUi(page, libraryName, files[0])
  await card.click()
  assert.equal(
    await page
      .getByRole('button', { name: `후보 ${selectedIndex + 1} 대표 썸네일로 선택`, exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await revoke(navigating, 'restarting the app does not restore temporary grants')
  assert.deepEqual(files.map(hash), originalHashes, 'The synthetic originals must stay unchanged')
  assert.deepEqual(rendererErrors, [])
  assert.deepEqual(await page.evaluate(() => window.release031Unhandled), [])
  await page
    .getByRole('region', { name: '대표 썸네일 선택', exact: true })
    .waitFor({ state: 'visible' })
  // CDP screenshots wait for painting; capturePage on a hidden window can retain an earlier frame.
  await page.screenshot({ path: screenshotPath })
  assert.ok(fs.statSync(screenshotPath).size > 0)
  passed.push(
    'representative choice survives an actual app restart; source hashes unchanged; renderer has no uncaught errors',
  )
}

main()
  .catch((error) => {
    failure = error
    process.exitCode = 1
  })
  .finally(async () => {
    if (failure && application) {
      failureUi = await currentPage
        ?.locator('body')
        .innerText()
        .catch(() => undefined)
      await application
        .evaluate(async ({ BrowserWindow }) => {
          const image = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage()
          return image && !image.isEmpty() ? image.toPNG().toString('base64') : null
        })
        .then((image) => {
          if (image) fs.writeFileSync(screenshotPath, Buffer.from(image, 'base64'))
        })
        .catch(() => undefined)
    }
    if (application)
      await application.close().catch((error) => {
        failure ??= error
        process.exitCode = 1
      })
    const report = {
      completedAt: new Date().toISOString(),
      ok: !failure,
      packaged: !!executablePath,
      version: expectedVersion,
      executablePath: executablePath ?? null,
      temporary,
      userData,
      passed,
      revoked,
      playbackClock,
      chosenThumbnail,
      rendererErrors,
      launchState,
      runtimeLogs,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      limits: [
        'OS Explorer drag gestures, external players and audible pitch quality are not exercised',
      ],
      error: failure?.stack ?? null,
      failureUi,
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  })
