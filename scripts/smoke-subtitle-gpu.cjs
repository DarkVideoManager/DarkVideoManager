// Real Vulkan inference + WSL translation, using copied media and isolated app data.
// Optional argument: unpacked executable. Requires a spoken fixture (default is synthetic speech).
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { _electron: electron } = require('playwright')
const execFileAsync = promisify(execFile)

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const fixture =
  process.env.DVM_SUBTITLE_SMOKE_FIXTURE ||
  path.join(os.tmpdir(), 'dvm-subtitle-smoke-20261009', 'smoke.mp4')
assert.ok(fs.existsSync(fixture), 'Set DVM_SUBTITLE_SMOKE_FIXTURE to a spoken-audio MP4')
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources', 'app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'subtitle-queue.json', 'vulkan'].every((marker) =>
    appCode.includes(marker),
  ),
  'Build lacks isolation or GPU subtitle support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-gpu-'))
const userData = path.join(temporary, 'user-data')
const media = path.join(temporary, 'media')
fs.mkdirSync(media)
const videos = ['first.mp4', 'second.mp4'].map((name) => path.join(media, name))
// A warmed GPU finishes the 14-second default clip before Windows process
// inspection returns. Extend only the disposable fixture so pause/exit tests
// can observe and stop a real in-flight native process reliably.
const longFixture = path.join(temporary, 'speech-loop.mp4')
require('node:child_process').execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-stream_loop',
    '7',
    '-i',
    fixture,
    '-t',
    '120',
    '-c',
    'copy',
    longFixture,
  ],
  { windowsHide: true, timeout: 60_000 },
)
for (const video of videos) fs.copyFileSync(longFixture, video)
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DVM_USER_DATA_DIR: userData,
  DVM_SMOKE_TEST: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const errors = []
const messages = new Set()
const checkpoints = new Map()
const passed = []
const stoppedGpuProcesses = []
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function until(description, predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(100)
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
    const actual = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(userData).toLowerCase())
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await until('subtitle IPC ready', () => page.evaluate(() => !!window.api?.subtitles?.listQueue))
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

function checkpoint(jobId) {
  const file = path.join(userData, 'subtitle-jobs', `queue-${jobId}`, 'checkpoint.json')
  if (!fs.existsSync(file)) return undefined
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.identity.backend, 'vulkan', 'New job silently used a CPU checkpoint')
  checkpoints.set(jobId, state)
  return state
}

async function waitForJob(invoke, id, accepted, timeout = 60_000) {
  let previous
  return until(
    `${id}: ${accepted.join('/')}`,
    async () => {
      const job = (await invoke('subtitles', 'listQueue')).find((entry) => entry.id === id)
      assert.ok(job, `Queue lost ${id}`)
      if (job.message) messages.add(job.message)
      checkpoint(id)
      if (job.phase !== previous) {
        console.log(`${job.title}: ${job.phase} (${job.message})`)
        previous = job.phase
      }
      assert.ok(!['failed', 'cancelled'].includes(job.phase), JSON.stringify(job))
      return accepted.includes(job.phase) && job
    },
    timeout,
  )
}

async function nativeGpuProcesses() {
  // Match only this test's copied job directory; never inspect or stop a user's workers.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'whisper-cli.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DVM_GPU_SMOKE_SCOPE) } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ],
    { env: { ...process.env, DVM_GPU_SMOKE_SCOPE: temporary }, windowsHide: true, timeout: 20_000 },
  )
  if (!stdout.trim()) return []
  const processes = JSON.parse(stdout)
  return Array.isArray(processes) ? processes : [processes]
}

async function waitForActiveGpu(invoke, id) {
  return until(
    'verified Vulkan initialization with a live native child',
    async () => {
      const job = (await invoke('subtitles', 'listQueue')).find((entry) => entry.id === id)
      assert.ok(job)
      if (job.message) messages.add(job.message)
      checkpoint(id)
      assert.ok(
        !['failed', 'cancelled', 'completed', 'translating'].includes(job.phase),
        JSON.stringify(job),
      )
      if (job.phase !== 'transcribing' || !/GPU\(Vulkan\d+\)/.test(job.message ?? '')) return false
      const processes = await nativeGpuProcesses()
      return processes.length > 0 && processes
    },
    5 * 60_000,
  )
}

async function assertNativeStopped(started) {
  await until(
    'native inference child stopped',
    async () => (await nativeGpuProcesses()).length === 0,
    20_000,
  )
  for (const process of started) stoppedGpuProcesses.push(process.ProcessId)
}

function verifyOutputs(job) {
  assert.equal(job.outputPaths.length, 2)
  const timings = []
  for (const file of job.outputPaths) {
    assert.equal(path.dirname(file).toLowerCase(), media.toLowerCase())
    const text = fs.readFileSync(file, 'utf8')
    const matches = text.match(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g)
    assert.ok(matches?.length, 'No subtitle cues generated')
    timings.push(matches)
    if (file.endsWith('.ko.srt')) assert.match(text, /[가-힣]/)
  }
  assert.deepEqual(timings[0], timings[1], 'Korean translation changed source cue timing')
  const state = checkpoints.get(job.id)
  assert.ok(state?.transcription_complete, 'Never observed a completed Vulkan checkpoint')
  assert.ok(state.cues.length > 0)
  assert.match(
    state.gpu_backend ?? '',
    /^Vulkan/,
    'Checkpoint lacks verified Vulkan backend evidence',
  )
}

async function main() {
  let session
  try {
    session = await launch()
    const { app, page, invoke } = session
    const engine = await invoke('subtitles', 'getEngineInfo')
    assert.equal(engine.available, true, engine.message)
    assert.match(engine.message, /GPU.*Vulkan/)
    const library = await invoke('library', 'create', 'GPU subtitle smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const imported = (await invoke('videos', 'search', library.id, {})).videos
    const options = { model: 'base', language: 'en', translateToKorean: true }
    const jobs = []
    for (const videoPath of videos) {
      const video = imported.find((item) => item.filePath === videoPath)
      assert.ok(video)
      jobs.push(await invoke('subtitles', 'generate', library.id, video.id, options))
    }
    assert.equal(jobs[1].phase, 'queued')
    assert.equal(await invoke('subtitles', 'pauseJob', jobs[1].id), true)
    const pausedProcesses = await waitForActiveGpu(invoke, jobs[0].id)
    assert.equal(await invoke('subtitles', 'pauseJob', jobs[0].id), true)
    await assertNativeStopped(pausedProcesses)
    assert.ok(checkpoint(jobs[0].id), 'GPU pause did not persist its checkpoint')
    assert.deepEqual(
      (await invoke('subtitles', 'listQueue')).map((job) => job.phase),
      ['paused', 'paused'],
    )
    passed.push('new Vulkan job, same-library FIFO, queued pause and active GPU pause')

    await app.evaluate(({ BrowserWindow }) => {
      globalThis.gpuSmokeCloses = 0
      BrowserWindow.getAllWindows()[0].on('close', () => globalThis.gpuSmokeCloses++)
    })
    await page.evaluate(() => {
      window.location.hash = '/subtitles'
    })
    await until('queue page', () =>
      page.evaluate(() => !!document.querySelector('section[aria-label="자막 생성 큐"]')),
    )
    await page.keyboard.press('Escape')
    await until('Escape requests close', () => app.evaluate(() => globalThis.gpuSmokeCloses === 1))
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    )
    assert.equal((await invoke('subtitles', 'listQueue')).length, 2)
    assert.equal(await invoke('subtitles', 'resumeJob', jobs[0].id), true)
    const completed = await waitForJob(invoke, jobs[0].id, ['completed'], 8 * 60_000)
    verifyOutputs(completed)
    assert.equal(await invoke('subtitles', 'removeJob', jobs[0].id), true)
    assert.ok(completed.outputPaths.every((file) => fs.existsSync(file)))
    passed.push(
      'ESC background resume produces synchronized original/Korean SRT; history deletion keeps outputs',
    )

    assert.equal(await invoke('subtitles', 'resumeJob', jobs[1].id), true)
    const exitedProcesses = await waitForActiveGpu(invoke, jobs[1].id)
    await quit(app)
    session = undefined
    await assertNativeStopped(exitedProcesses)
    const journal = JSON.parse(fs.readFileSync(path.join(userData, 'subtitle-queue.json'), 'utf8'))
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].job.phase, 'paused')
    assert.equal(journal.entries[0].job.id, jobs[1].id)
    assert.equal(checkpoint(jobs[1].id).identity.backend, 'vulkan')
    session = await launch()
    const restored = await session.invoke('subtitles', 'listQueue')
    assert.equal(restored[0].phase, 'paused')
    assert.equal(await session.invoke('subtitles', 'resumeJob', jobs[1].id), true)
    verifyOutputs(await waitForJob(session.invoke, jobs[1].id, ['completed'], 8 * 60_000))
    passed.push(
      'explicit exit stops native GPU worker; restart resumes Vulkan checkpoint and WSL translation',
    )
    assert.deepEqual(errors, [])
    assert.ok(
      [...messages].some((message) => /GPU.*Vulkan|Vulkan.*GPU/.test(message)),
      'GPU inference never reported Vulkan execution',
    )
    const report = {
      passed,
      temporary,
      packaged: !!executablePath,
      engine,
      rendererErrors: errors,
      stoppedGpuProcesses,
      inferenceMessages: [...messages].filter((message) => /GPU|Vulkan/.test(message)),
      checkpoints: [...checkpoints].map(([id, state]) => ({
        id,
        backend: state.identity.backend,
        gpuBackend: state.gpu_backend,
        complete: state.transcription_complete,
        cueCount: state.cues.length,
      })),
    }
    const output = path.join(root, 'test-results')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(
      path.join(output, `subtitle-gpu-${executablePath ? 'packaged' : 'electron'}.json`),
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
