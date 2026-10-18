// Real subtitle replacement smoke test. Only copied media and seeded test sidecars are trashed.
// Optional argument: unpacked DarkVideoManager.exe. DVM_SUBTITLE_SMOKE_FIXTURE overrides the MP4.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const fixture =
  process.env.DVM_SUBTITLE_SMOKE_FIXTURE ||
  path.join(os.tmpdir(), 'dvm-subtitle-smoke-20261009', 'smoke.mp4')
assert.ok(fs.existsSync(fixture), `Provide a spoken-audio MP4: ${fixture}`)
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'subtitles:regenerate'].every((part) =>
    appCode.includes(part),
  ),
  'Refusing to run a build without isolation and subtitle regeneration support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-regenerate-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const videoPath = path.join(media, 'sample.mp4')
const blockerPath = path.join(media, 'blocker.mp4')
fs.copyFileSync(fixture, videoPath)
// Give queue assertions time to run before the preceding job can finish recognition.
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  ['-v', 'error', '-stream_loop', '19', '-i', fixture, '-c', 'copy', blockerPath],
  { windowsHide: true, timeout: 60_000 },
)
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const videoHash = hash(videoPath)
const oldContents = '1\n00:00:00,000 --> 00:00:02,000\nSMOKE OLD SUBTITLE\n'
const oldPaths = ['sample.srt', 'sample.ai.srt', 'sample.ai.ko.srt'].map((name) =>
  path.join(media, name),
)
for (const subtitle of oldPaths) fs.writeFileSync(subtitle, oldContents, 'utf8')
const errors = []
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DVM_USER_DATA_DIR: userData,
  DVM_SMOKE_TEST: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(200)
  }
  throw new Error(`Timed out: ${description}`)
}

async function main() {
  let app
  try {
    app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
      cwd: root,
      env,
      timeout: 60_000,
    })
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(),
      path.resolve(userData).toLowerCase(),
    )
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await until('regeneration IPC', () => page.evaluate(() => !!window.api?.subtitles?.regenerate))
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const engine = await invoke('subtitles', 'getEngineInfo')
    assert.equal(engine.available, true, engine.message)
    assert.equal(await invoke('subtitles', 'setConcurrency', 1), 1)
    const library = await invoke('library', 'create', 'Subtitle regeneration smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const videos = (await invoke('videos', 'search', library.id, {})).videos
    const video = videos.find((entry) => entry.filePath === videoPath)
    const blocker = videos.find((entry) => entry.filePath === blockerPath)
    assert.ok(video && blocker)
    assert.equal(video.filePath, videoPath)
    const existing = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.equal(existing.length, 3, 'All seeded external sidecars must be discovered')
    const requested = { model: 'base', language: 'en', translateToKorean: true }
    const preceding = await invoke('subtitles', 'generate', library.id, blocker.id, {
      ...requested,
      translateToKorean: false,
    })
    const queued = await invoke(
      'subtitles',
      'regenerate',
      library.id,
      video.id,
      existing.map((subtitle) => subtitle.id),
      requested,
    )
    assert.deepEqual(queued.options, requested)
    assert.equal(queued.phase, 'queued', 'Regeneration must wait behind the same-library job')
    assert.ok(
      oldPaths.every((subtitle) => fs.readFileSync(subtitle, 'utf8') === oldContents),
      'Queued regeneration must preserve all old subtitle files until its turn',
    )
    assert.equal((await invoke('subtitles', 'getForVideo', library.id, video.id)).length, 3)
    const waitingQueue = await invoke('subtitles', 'listQueue')
    assert.equal(waitingQueue.find((entry) => entry.id === queued.id).phase, 'queued')
    assert.ok(
      !['completed', 'failed', 'cancelled'].includes(
        waitingQueue.find((entry) => entry.id === preceding.id).phase,
      ),
    )
    console.log('Regeneration queued behind active work; old subtitles and DB rows preserved')
    assert.equal(await invoke('subtitles', 'pauseJob', preceding.id), true)
    await until('queued regeneration deletes its confirmed subtitles', () =>
      oldPaths.every((subtitle) => !fs.existsSync(subtitle)),
    )
    assert.equal(hash(videoPath), videoHash, 'Regeneration changed the source video')
    let lastPhase
    const completed = await until(
      'regeneration completes',
      async () => {
        const job = (await invoke('subtitles', 'listQueue')).find((entry) => entry.id === queued.id)
        assert.ok(job)
        if (job.phase !== lastPhase) {
          console.log(`Regeneration: ${job.phase} (${job.message})`)
          lastPhase = job.phase
        }
        assert.ok(!['failed', 'cancelled'].includes(job.phase), JSON.stringify(job))
        return job.phase === 'completed' ? job : false
      },
      8 * 60_000,
    )
    assert.deepEqual(
      completed.outputPaths.sort(),
      oldPaths.slice(1).sort(),
      'Freed base names must be reused',
    )
    for (const subtitle of completed.outputPaths) {
      const text = fs.readFileSync(subtitle, 'utf8')
      assert.match(text, /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
      assert.ok(!text.includes('SMOKE OLD SUBTITLE'))
      if (subtitle.endsWith('.ko.srt')) assert.match(text, /[가-힣]/)
    }
    const fresh = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.equal(fresh.length, 2)
    assert.ok(fresh.every((subtitle) => !existing.some((old) => old.id === subtitle.id)))
    assert.equal(hash(videoPath), videoHash)
    assert.deepEqual(errors, [])
    const report = {
      passed: [
        'regeneration queues behind an active job from the same library',
        'old subtitles remain intact until preceding work is paused',
        'real recycle-bin removal of three seeded sidecars',
        'fresh original and Korean SRT generation',
        'unmodified source video',
        'new DB tracks and reusable output filenames',
      ],
      temporary,
      packaged: !!executablePath,
      rendererErrors: errors,
    }
    fs.writeFileSync(
      path.join(
        output,
        executablePath
          ? 'subtitle-queued-regenerate-packaged.json'
          : 'subtitle-queued-regenerate-electron.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (app) {
      const closed = app.waitForEvent('close', { timeout: 60_000 })
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit())
      })
      await closed
    }
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
