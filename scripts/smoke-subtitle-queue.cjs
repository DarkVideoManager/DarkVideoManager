// Real Electron/WSL subtitle queue checks, using only disposable copied media and user data.
// Optional argument: unpacked DarkVideoManager.exe. Override the fixture with DVM_SUBTITLE_SMOKE_FIXTURE.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const fixture =
  process.env.DVM_SUBTITLE_SMOKE_FIXTURE ||
  path.join(os.tmpdir(), 'dvm-subtitle-smoke-20261009', 'smoke.mp4')
assert.ok(
  fs.existsSync(fixture),
  `Provide a spoken-audio MP4 through DVM_SUBTITLE_SMOKE_FIXTURE: ${fixture}`,
)
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'subtitle-queue.json', '완전히 종료'].every((part) =>
    appCode.includes(part),
  ),
  'Refusing to run a build without user-data isolation and subtitle queue support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-queue-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const videoPaths = ['first.mp4', 'second.mp4'].map((name) => path.join(media, name))
for (const videoPath of videoPaths) fs.copyFileSync(fixture, videoPath)
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
    const result = await predicate()
    if (result) return result
    await delay(150)
  }
  throw new Error(`Timed out: ${description}`)
}

async function launch() {
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
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await until('subtitle queue IPC ready', () =>
      page.evaluate(() => !!window.api?.subtitles?.listQueue),
    )
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    )
    return { app, page, invoke }
  } catch (error) {
    await app.close()
    throw error
  }
}

async function quitExplicitly(app) {
  const closed = app.waitForEvent('close', { timeout: 60_000 })
  // This is the same app.quit path used by the tray's explicit exit command.
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit())
  })
  await closed
}

async function waitForJob(invoke, jobId, accepted, timeout = 60_000) {
  let lastPhase
  return until(
    `job ${jobId} reaches ${accepted.join('/')}`,
    async () => {
      const job = (await invoke('subtitles', 'listQueue')).find((entry) => entry.id === jobId)
      assert.ok(job, `Missing queue job ${jobId}`)
      if (job.phase !== lastPhase) {
        console.log(`${job.title}: ${job.phase} (${job.message})`)
        lastPhase = job.phase
      }
      assert.ok(!['failed', 'cancelled'].includes(job.phase), JSON.stringify(job))
      return accepted.includes(job.phase) ? job : false
    },
    timeout,
  )
}

function assertSubtitleOutputs(job) {
  assert.equal(job.outputPaths?.length, 2, 'Expected original and Korean subtitles')
  for (const outputPath of job.outputPaths) {
    assert.equal(
      path.dirname(outputPath).toLowerCase(),
      media.toLowerCase(),
      'Output escaped isolated media',
    )
    const contents = fs.readFileSync(outputPath, 'utf8')
    assert.match(contents, /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
    if (outputPath.endsWith('.ko.srt'))
      assert.match(contents, /[가-힣]/, 'Korean output contains no Korean text')
  }
}

async function main() {
  let session
  let firstOutputs
  try {
    session = await launch()
    const { app, page, invoke } = session
    const engine = await invoke('subtitles', 'getEngineInfo')
    assert.equal(engine.available, true, engine.message)
    const library = await invoke('library', 'create', 'Subtitle queue smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const videos = (await invoke('videos', 'search', library.id, {})).videos
    const first = videos.find((video) => video.filePath === videoPaths[0])
    const second = videos.find((video) => video.filePath === videoPaths[1])
    assert.ok(first && second)
    const options = { model: 'base', language: 'en', translateToKorean: true }
    const firstJob = await invoke('subtitles', 'generate', library.id, first.id, options)
    const secondJob = await invoke('subtitles', 'generate', library.id, second.id, options)
    assert.equal(
      secondJob.phase,
      'queued',
      'Second video in the same library must queue behind the first',
    )
    assert.equal(await invoke('subtitles', 'pauseJob', secondJob.id), true)
    await waitForJob(invoke, firstJob.id, ['loading', 'transcribing'])
    assert.equal(await invoke('subtitles', 'pauseJob', firstJob.id), true)
    assert.deepEqual(
      (await invoke('subtitles', 'listQueue')).map((job) => job.phase),
      ['paused', 'paused'],
    )
    passed.push('same-library FIFO admission, queued pause and active WSL pause')

    await app.evaluate(({ BrowserWindow }) => {
      globalThis.subtitleSmokeCloses = 0
      BrowserWindow.getAllWindows()[0].on('close', () => globalThis.subtitleSmokeCloses++)
    })
    await page.evaluate(() => {
      window.location.hash = '/subtitles'
    })
    await until('queue page rendered', () =>
      page.evaluate(() => !!document.querySelector('section[aria-label="자막 생성 큐"]')),
    )
    // Use the real Escape handler even though DVM_SMOKE_TEST keeps the window invisible.
    await page.keyboard.press('Escape')
    await until('Escape requested window close', () =>
      app.evaluate(() => globalThis.subtitleSmokeCloses === 1),
    )
    const hidden = await app.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length,
      hidden: !BrowserWindow.getAllWindows()[0].isVisible(),
    }))
    assert.deepEqual(hidden, { count: 1, hidden: true })
    assert.equal(
      (await invoke('subtitles', 'listQueue')).length,
      2,
      'IPC remains alive after Escape',
    )
    passed.push('real Escape keeps paused jobs alive in a hidden Electron window')

    assert.equal(await invoke('subtitles', 'resumeJob', firstJob.id), true)
    const completed = await waitForJob(invoke, firstJob.id, ['completed'], 8 * 60_000)
    assertSubtitleOutputs(completed)
    firstOutputs = completed.outputPaths
    assert.equal(await invoke('subtitles', 'removeJob', firstJob.id), true)
    assert.ok(
      firstOutputs.every((outputPath) => fs.existsSync(outputPath)),
      'Removing history deleted output subtitles',
    )
    assert.equal((await invoke('subtitles', 'getForVideo', library.id, first.id)).length, 2)
    passed.push(
      'resume while hidden generates original and Korean SRT; history deletion preserves files and tracks',
    )

    assert.equal(await invoke('subtitles', 'resumeJob', secondJob.id), true)
    await waitForJob(invoke, secondJob.id, ['loading', 'transcribing'])
    await quitExplicitly(app)
    session = undefined
    const journal = JSON.parse(fs.readFileSync(path.join(userData, 'subtitle-queue.json'), 'utf8'))
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].job.id, secondJob.id)
    assert.equal(journal.entries[0].job.phase, 'paused')
    passed.push('explicit application exit stops the active worker and journals it as paused')

    session = await launch()
    const restored = await session.invoke('subtitles', 'listQueue')
    assert.equal(restored.length, 1)
    assert.equal(restored[0].id, secondJob.id)
    assert.equal(restored[0].phase, 'paused')
    assert.equal(await session.invoke('subtitles', 'resumeJob', secondJob.id), true)
    const restartedComplete = await waitForJob(
      session.invoke,
      secondJob.id,
      ['completed'],
      8 * 60_000,
    )
    assertSubtitleOutputs(restartedComplete)
    assert.ok(firstOutputs.every((outputPath) => fs.existsSync(outputPath)))
    passed.push(
      'restart restores paused queue; resume reopens its library and generates both subtitle outputs',
    )
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`)
    const report = { passed, temporary, packaged: !!executablePath, rendererErrors: errors }
    fs.writeFileSync(
      path.join(
        output,
        executablePath ? 'subtitle-queue-packaged.json' : 'subtitle-queue-electron.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (session) await quitExplicitly(session.app)
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
