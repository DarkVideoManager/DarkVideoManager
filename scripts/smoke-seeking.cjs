// Real Electron seeking measurements. Uses only a generated fixture and isolated userData.
// Baseline: node scripts/smoke-seeking.cjs --label baseline --executable dist-electron/win-unpacked/DarkVideoManager.exe
// Compare:  node scripts/smoke-seeking.cjs --label updated --fixture-report test-results/seeking-baseline.json
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  assert.ok(
    ['--label', '--executable', '--fixture-report'].includes(key),
    `Unknown argument ${key}`,
  )
  assert.ok(process.argv[index + 1], `Missing value for ${key}`)
  options[key.slice(2)] = process.argv[index + 1]
}
const label = options.label ?? 'current'
assert.match(label, /^[a-z0-9-]+$/)
const executablePath = options.executable ? path.resolve(options.executable) : undefined
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
let mainCode
let rendererCode
if (executablePath) {
  const asar = require('@electron/asar')
  const archive = path.join(path.dirname(executablePath), 'resources/app.asar')
  mainCode = asar.extractFile(archive, path.join('out', 'main', 'index.js'))
  const files = asar
    .listPackage(archive)
    .filter((name) => /out[\\/]renderer[\\/].*\.js$/.test(name))
    .sort()
  rendererCode = Buffer.concat(
    files.map((name) => asar.extractFile(archive, name.replace(/^[\\/]/, ''))),
  )
} else {
  mainCode = fs.readFileSync(path.join(root, 'out/main/index.js'))
  const directory = path.join(root, 'out/renderer/assets')
  rendererCode = Buffer.concat(
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => fs.readFileSync(path.join(directory, name))),
  )
}
assert.ok(
  mainCode.includes('DVM_USER_DATA_DIR') && mainCode.includes('DVM_SMOKE_TEST'),
  'Refusing an application without isolated userData support',
)
assert.ok(rendererCode.length > 0, 'Renderer bundle not found')

function assertOwnedTemporary(directory, prefix) {
  const absolute = path.resolve(directory)
  assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  assert.ok(path.basename(absolute).startsWith(prefix), 'Unexpected fixture directory')
  assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false, 'Fixture must not be a link')
  return absolute
}

let fixture
if (options['fixture-report']) {
  fixture = JSON.parse(fs.readFileSync(path.resolve(options['fixture-report']), 'utf8')).fixture
  assertOwnedTemporary(fixture.directory, 'dvm-seeking-fixture-')
  assert.equal(path.resolve(fixture.video), path.join(fixture.directory, 'media', 'long-gop.mp4'))
  assert.equal(fs.lstatSync(path.dirname(fixture.video)).isSymbolicLink(), false)
  assert.equal(fs.lstatSync(fixture.video).isSymbolicLink(), false)
  assert.equal(
    hash(fs.readFileSync(fixture.video)),
    fixture.sha256,
    'Fixture changed since baseline',
  )
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-seeking-fixture-'))
  const media = path.join(directory, 'media')
  fs.mkdirSync(media)
  const video = path.join(media, 'long-gop.mp4')
  execFileSync(
    require('./media-paths.cjs').getFfmpegPath(),
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=90',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-g',
      '240',
      '-keyint_min',
      '240',
      '-sc_threshold',
      '0',
      '-bf',
      '3',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      video,
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 120_000 },
  )
  fixture = {
    directory,
    video,
    durationSec: 90,
    width: 640,
    height: 360,
    fps: 24,
    gop: 240,
    sha256: hash(fs.readFileSync(video)),
    sizeBytes: fs.statSync(video).size,
  }
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-seeking-run-'))
const output = path.join(root, 'test-results', `seeking-${label}.json`)
fs.mkdirSync(path.dirname(output), { recursive: true })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = {
  label,
  fixture,
  temporary,
  executablePath: executablePath ?? null,
  mainSha256: hash(mainCode),
  rendererSha256: hash(rendererCode),
  environment: {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
  },
  methodology:
    'Same generated 90s 640x360 24fps H.264, fixed 240-frame GOP; real Electron video and keyboard input. currentTime setter instrumentation counts writes while already seeking. Presented-frame callbacks are measured only if supported. Hardware/workload-dependent smoke measurements, not a universal playback benchmark.',
  scenarios: [],
  rendererErrors: [],
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: path.join(temporary, 'user-data'),
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  try {
    const actual = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window) {
        window.webContents.setBackgroundThrottling(false)
        window.showInactive()
      }
      return { userData: app.getPath('userData'), versions: process.versions }
    })
    assert.equal(
      path.resolve(actual.userData).toLowerCase(),
      path.resolve(env.DVM_USER_DATA_DIR).toLowerCase(),
      'Application ignored test isolation',
    )
    report.environment.versions = actual.versions
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => report.rendererErrors.push(error.message))
    async function waitUntil(predicate, timeout = 30_000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate)) return
        await delay(30)
      }
      throw new Error(
        `Timed out: ${predicate.toString()} ${await page.evaluate(() => document.body.innerText.slice(0, 1000))}`,
      )
    }
    await waitUntil(() => !!window.api?.videos && document.body.innerText.length > 0)
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${result.error}`)
      return result.value
    }
    const library = await invoke(
      'library',
      'create',
      'Seeking fixture',
      path.dirname(fixture.video),
    )
    await invoke('library', 'open', library.id)
    await invoke('library', 'importFolder', library.id, path.dirname(fixture.video))
    const result = await invoke('videos', 'search', library.id, { page: 1, pageSize: 50 })
    assert.equal(result.total, 1)
    assert.equal(path.resolve(result.videos[0].filePath), fixture.video)
    await page.reload()
    await waitUntil(() => document.body.innerText.includes('Seeking fixture'))
    const open = page.getByRole('button', { name: '열기', exact: true }).first()
    if (await open.isVisible()) await open.click()
    await waitUntil(() => document.body.innerText.includes('long-gop.mp4'))
    await page.getByText('long-gop.mp4', { exact: true }).first().dblclick()
    await waitUntil(() => {
      const video = document.querySelector('video')
      return !!video && video.readyState >= 2 && video.duration > 89
    })
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
      window.showInactive()
    })
    await page.evaluate(() => {
      const video = document.querySelector('video')
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
      const state = (window.__seekingSmoke = {
        writes: [],
        seeking: [],
        seeked: [],
        frames: [],
        marks: [],
        errors: [],
      })
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() {
          return descriptor.get.call(this)
        },
        set(value) {
          state.writes.push({ at: performance.now(), target: value, seekingBefore: this.seeking })
          descriptor.set.call(this, value)
        },
      })
      video.addEventListener('seeking', () =>
        state.seeking.push({ at: performance.now(), time: video.currentTime }),
      )
      video.addEventListener('seeked', () =>
        state.seeked.push({ at: performance.now(), time: video.currentTime }),
      )
      video.addEventListener('error', () =>
        state.errors.push(video.error?.message ?? 'video error'),
      )
      if (video.requestVideoFrameCallback) {
        const frame = (at, metadata) => {
          state.frames.push({
            at,
            time: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
          })
          video.requestVideoFrameCallback(frame)
        }
        video.requestVideoFrameCallback(frame)
      }
    })
    const scenarios = [
      {
        name: 'paused-tap-d',
        start: 20,
        playing: false,
        actions: [
          ['down', 'd', 70],
          ['up', 'd', 0],
        ],
        exactTarget: 21,
      },
      {
        name: 'paused-held-d',
        start: 20,
        playing: false,
        actions: [
          ['down', 'd', 1250],
          ['up', 'd', 0],
        ],
        direction: 1,
      },
      {
        name: 'paused-held-a',
        start: 65,
        playing: false,
        actions: [
          ['down', 'a', 1250],
          ['up', 'a', 0],
        ],
        direction: -1,
      },
      {
        name: 'paused-direction-change',
        start: 40,
        playing: false,
        actions: [
          ['down', 'd', 700],
          ['down', 'a', 250],
          ['up', 'd', 650],
          ['up', 'a', 0],
        ],
        reversal: true,
      },
      {
        name: 'playing-held-d',
        start: 20,
        playing: true,
        actions: [
          ['down', 'd', 1250],
          ['up', 'd', 0],
        ],
        direction: 1,
      },
      {
        name: 'playing-held-a',
        start: 65,
        playing: true,
        actions: [
          ['down', 'a', 1250],
          ['up', 'a', 0],
        ],
        direction: -1,
      },
    ]
    for (const scenario of scenarios) {
      await page.evaluate((start) => {
        const video = document.querySelector('video')
        video.pause()
        video.muted = true
        video.currentTime = start
      }, scenario.start)
      await waitUntil(() => {
        const video = document.querySelector('video')
        return !video.seeking && video.readyState >= 2
      }, 10_000)
      await delay(100)
      if (scenario.playing) {
        await page.evaluate(() => document.querySelector('video').play())
        await delay(150)
      }
      await page.evaluate(() => {
        const s = window.__seekingSmoke
        for (const key of Object.keys(s)) s[key] = []
        s.startedAt = performance.now()
      })
      for (const [action, key, milliseconds] of scenario.actions) {
        await page.evaluate(
          ({ action, key }) =>
            window.__seekingSmoke.marks.push({
              action,
              key,
              at: performance.now(),
              time: document.querySelector('video').currentTime,
            }),
          { action, key },
        )
        await page.keyboard[action](key)
        if (milliseconds) await delay(milliseconds)
      }
      await delay(250)
      await waitUntil(() => !document.querySelector('video').seeking, 10_000)
      const settled = await page.evaluate(() => ({
        at: performance.now(),
        time: document.querySelector('video').currentTime,
        writes: window.__seekingSmoke.writes.length,
      }))
      await delay(300)
      const data = await page.evaluate(() => {
        const video = document.querySelector('video')
        const result = {
          ...window.__seekingSmoke,
          finalAt: performance.now(),
          finalTime: video.currentTime,
          seeking: video.seeking,
          paused: video.paused,
          readyState: video.readyState,
          quality: video.getVideoPlaybackQuality?.(),
          frameCallbackSupported: !!video.requestVideoFrameCallback,
        }
        video.pause()
        return result
      })
      const lastWrite = data.writes.at(-1)
      const up = data.marks.at(-1)
      const firstDown = data.marks[0]
      const framesDuringHold = data.frames.filter(
        (frame) => frame.at >= firstDown.at && frame.at <= up.at,
      )
      const frameTimes = [firstDown.at, ...framesDuringHold.map((frame) => frame.at), up.at]
      const maxFrameGapMs = Math.max(
        ...frameTimes.slice(1).map((at, index) => at - frameTimes[index]),
      )
      const lastCompleted = data.seeked.at(-1)
      const directionMarker = data.marks.find((mark) => mark.action === 'down' && mark.key === 'a')
      const beforeOppositeRelease = data.marks.find(
        (mark) => mark.action === 'up' && mark.key === 'd',
      )
      const checks = {
        seekCompleted: !!lastCompleted && !data.seeking,
        noLateKeyupWrites: data.writes.length === settled.writes,
        noMediaError: data.errors.length === 0,
        hasDecodedFrame: !data.frameCallbackSupported || data.frames.length > 0,
        ...(scenario.playing
          ? { playbackContinuesAfterKeyup: data.finalTime > settled.time + 0.08 }
          : {
              pausedPositionStable: Math.abs(data.finalTime - settled.time) < 0.02,
              finalTargetAccurate:
                !!lastWrite && Math.abs(data.finalTime - lastWrite.target) <= 0.08,
            }),
        ...(scenario.exactTarget
          ? { tapAccurate: Math.abs(data.finalTime - scenario.exactTarget) <= 0.08 }
          : {}),
        ...(scenario.direction
          ? {
              movedInRequestedDirection: (data.finalTime - scenario.start) * scenario.direction > 1,
            }
          : {}),
        ...(scenario.reversal
          ? {
              changedDirection: !!directionMarker && data.finalTime < directionMarker.time,
              oppositeKeyupKeepsActiveDirection:
                !!beforeOppositeRelease &&
                data.writes.some(
                  (write) => write.at > beforeOppositeRelease.at + 150 && write.at < up.at,
                ),
            }
          : {}),
      }
      report.scenarios.push({
        name: scenario.name,
        actions: scenario.actions,
        checks,
        metrics: {
          currentTimeWrites: data.writes.length,
          writesWhileSeeking: data.writes.filter((write) => write.seekingBefore).length,
          seekedEvents: data.seeked.length,
          decodedFramesDuringHold: framesDuringHold.length,
          maxPresentedFrameGapDuringHoldMs: Number(maxFrameGapMs.toFixed(2)),
          keyupToLastSeekedMs: lastCompleted ? Number((lastCompleted.at - up.at).toFixed(2)) : null,
          startSec: scenario.start,
          finalSec: Number(data.finalTime.toFixed(3)),
          lastTargetSec: lastWrite?.target,
        },
        trace: data,
      })
      console.log(
        `${label}: ${scenario.name} ${JSON.stringify(report.scenarios.at(-1).metrics)} checks=${JSON.stringify(checks)}`,
      )
    }
    report.passed =
      report.rendererErrors.length === 0 &&
      report.scenarios.every((scenario) => Object.values(scenario.checks).every(Boolean))
  } catch (error) {
    report.failure = error.stack ?? String(error)
    report.passed = false
    throw error
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
    await app.close()
    console.log(`Saved ${output}`)
    if (!report.passed) process.exitCode = 1
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
