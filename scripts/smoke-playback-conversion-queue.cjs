// Real Electron + FFmpeg; every mutation uses generated media and isolated user data.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const code = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
for (const marker of ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'playback-conversion-queue.json'])
  assert.ok(code.includes(marker), `Build lacks required isolation/queue marker: ${marker}`)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-conversion-queue-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const originals = ['first.mp4', 'second.mp4'].map((name) => path.join(media, name))
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=30:d=50',
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    '-an',
    originals[0],
  ],
  { windowsHide: true, stdio: 'ignore' },
)
fs.copyFileSync(originals[0], originals[1])
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originalHashes = originals.map(hash)
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DVM_USER_DATA_DIR: userData,
  DVM_SMOKE_TEST: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const passed = []
const pageErrors = []
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function launch() {
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  try {
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(),
      path.resolve(userData).toLowerCase(),
    )
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await until('conversion API ready', () =>
      page.evaluate(() => !!window.api?.playback?.listConversionQueue),
    )
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${result.error}`)
      return result.value
    }
    return { app, page, invoke }
  } catch (error) {
    await app.close()
    throw error
  }
}
async function quit(app) {
  const closed = app.waitForEvent('close', { timeout: 60_000 })
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit())
  })
  await closed
}
async function main() {
  let session
  try {
    session = await launch()
    let { app, page, invoke } = session
    const library = await invoke('library', 'create', 'Conversion queue smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const videos = (await invoke('videos', 'search', library.id, { page: 1, pageSize: 20 })).videos
    const first = videos.find((v) => v.filePath === originals[0])
    const second = videos.find((v) => v.filePath === originals[1])
    assert.ok(first && second)
    assert.equal(first.codec, 'mpeg4')
    await page.evaluate(
      ({ libraryId, ids }) => {
        window.conversionSmokeRequests = []
        for (const id of ids)
          void window.api.videos
            .getPlaybackSource(libraryId, id)
            .then((value) => window.conversionSmokeRequests.push(value))
      },
      { libraryId: library.id, ids: [first.id, second.id, first.id] },
    )
    const queued = await until(
      'one active conversion and one queued; duplicate joined',
      async () => {
        const list = await invoke('playback', 'listConversionQueue')
        return list.length === 2 &&
          list.filter((j) => j.status === 'running').length === 1 &&
          list.filter((j) => j.status === 'queued').length === 1
          ? list
          : false
      },
    )
    const firstJob = queued.find((j) => j.videoId === first.id)
    const secondJob = queued.find((j) => j.videoId === second.id)
    assert.equal(firstJob.status, 'running')
    passed.push('two incompatible videos join a serial FIFO; duplicate requests share one job')
    await invoke('playback', 'pauseConversion', secondJob.id)
    await until('real FFmpeg media-time progress', async () => {
      const job = (await invoke('playback', 'listConversionQueue')).find(
        (j) => j.id === firstJob.id,
      )
      return job.status === 'running' &&
        job.progress > 0 &&
        job.progress < 100 &&
        job.processedSec > 0
        ? job
        : false
    })
    assert.equal((await invoke('playback', 'pauseConversion', firstJob.id)).status, 'paused')
    // Stop immediately after a real progress event. Waiting for the UI poll or a
    // screenshot before pausing can let this short synthetic clip finish first.
    await page
      .getByTestId('playback-conversion-queue')
      .waitFor({ state: 'visible', timeout: 15_000 })
    // A hidden packaged Electron window can stop producing compositor frames
    // after conversion pauses. UI layout is covered separately by browser tests.
    if (!executablePath)
      await page.screenshot({ path: path.join(output, 'playback-conversion-queue.png') })
    passed.push('home panel displays the queue and measured FFmpeg progress')
    await until('pending playback requests settle after pause', () =>
      page.evaluate(() => window.conversionSmokeRequests.length === 3),
    )
    assert.ok((await invoke('playback', 'listConversionQueue')).every((j) => j.status === 'paused'))
    assert.ok(
      !fs
        .readdirSync(path.join(userData, 'playback-proxies', library.id))
        .some((name) => name.endsWith('.tmp')),
    )
    passed.push('pausing waits for FFmpeg exit and removes incomplete cache output')
    await invoke('app', 'quit')
    await delay(150)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    )
    await invoke('playback', 'resumeConversion', firstJob.id)
    const progress = []
    await until(
      'resumed conversion completes in background',
      async () => {
        const list = await invoke('playback', 'listConversionQueue')
        const job = list.find((j) => j.id === firstJob.id)
        assert.notEqual(job.status, 'failed', job.error)
        assert.equal(list.find((j) => j.id === secondJob.id).status, 'paused')
        if (job.progress !== null) progress.push(job.progress)
        return job.status === 'completed'
      },
      120_000,
    )
    assert.ok(progress.some((value) => value > 0 && value < 100))
    const source = await invoke('videos', 'getPlaybackSource', library.id, first.id)
    assert.ok(fs.existsSync(source))
    const probe = JSON.parse(
      execFileSync(
        require('./media-paths.cjs').getFfprobePath(),
        ['-v', 'error', '-show_streams', '-of', 'json', source],
        { windowsHide: true, encoding: 'utf8' },
      ),
    )
    assert.ok(
      probe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'),
    )
    await invoke('playback', 'removeConversion', firstJob.id)
    assert.ok(fs.existsSync(source), 'Removing queue history deleted the completed cache')
    passed.push(
      'window close preserves queue; resume finishes H.264 conversion and removing history keeps cache',
    )
    await invoke('playback', 'resumeConversion', secondJob.id)
    await until('second video running', async () =>
      (await invoke('playback', 'listConversionQueue')).some(
        (j) => j.id === secondJob.id && j.status === 'running',
      ),
    )
    await quit(app)
    session = undefined
    session = await launch()
    ;({ app, page, invoke } = session)
    const restored = await invoke('playback', 'listConversionQueue')
    assert.equal(restored.length, 1)
    assert.equal(restored[0].id, secondJob.id)
    assert.equal(restored[0].status, 'paused')
    await invoke('playback', 'resumeConversion', secondJob.id)
    await until(
      'restored conversion completes',
      async () => {
        const job = (await invoke('playback', 'listConversionQueue')).find(
          (j) => j.id === secondJob.id,
        )
        assert.notEqual(job.status, 'failed', job.error)
        return job.status === 'completed'
      },
      120_000,
    )
    passed.push(
      'explicit quit safely persists active job; next launch restores paused job and resume completes',
    )
    assert.deepEqual(originals.map(hash), originalHashes)
    assert.deepEqual(pageErrors, [])
    passed.push('all source video hashes unchanged; no renderer exceptions')
    const report = { passed, temporary, packaged: !!executablePath, pageErrors }
    fs.writeFileSync(
      path.join(
        output,
        executablePath
          ? 'playback-conversion-queue-packaged.json'
          : 'playback-conversion-queue-electron.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (session) await quit(session.app)
  }
}
main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
