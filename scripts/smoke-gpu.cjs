// GPU support is not proof of the decoder selected for a video. Capture both.
// node scripts/smoke-gpu.cjs --executable dist-electron/win-unpacked/DarkVideoManager.exe --fixture-report test-results/seeking-baseline.json
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { _electron: electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const args = {}
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--executable', '--fixture-report', '--label'].includes(process.argv[index]))
  assert.ok(process.argv[index + 1])
  args[process.argv[index].slice(2)] = process.argv[index + 1]
}
const label = args.label ?? 'baseline'
assert.match(label, /^[a-z0-9-]+$/)
const executablePath = args.executable ? path.resolve(args.executable) : undefined
const fixtureReport = path.resolve(
  args['fixture-report'] ?? path.join(root, 'test-results/seeking-baseline.json'),
)
const fixture = JSON.parse(fs.readFileSync(fixtureReport, 'utf8')).fixture
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
assert.equal(
  path.dirname(path.resolve(fixture.directory)).toLowerCase(),
  path.resolve(os.tmpdir()).toLowerCase(),
)
assert.ok(path.basename(fixture.directory).startsWith('dvm-seeking-fixture-'))
assert.equal(path.resolve(fixture.video), path.join(fixture.directory, 'media', 'long-gop.mp4'))
for (const entry of [fixture.directory, path.dirname(fixture.video), fixture.video])
  assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, 'Refuse linked fixture paths')
assert.equal(hash(fs.readFileSync(fixture.video)), fixture.sha256)
const mainCode = executablePath
  ? require('@electron/asar').extractFile(
      path.join(path.dirname(executablePath), 'resources/app.asar'),
      path.join('out', 'main', 'index.js'),
    )
  : fs.readFileSync(path.join(root, 'out/main/index.js'))
assert.ok(
  mainCode.includes('DVM_USER_DATA_DIR') && mainCode.includes('DVM_SMOKE_TEST'),
  'Application must support isolated userData',
)
const output = path.join(root, 'test-results', `gpu-${label}.json`)
fs.mkdirSync(path.dirname(output), { recursive: true })
const report = {
  label,
  fixture,
  executablePath: executablePath ?? null,
  mainSha256: hash(mainCode),
  environment: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model },
  methodology:
    'Default launch compared with --disable-accelerated-video-decode. Same generated H.264 fixture, fresh isolated userData for each launch, real application video element. Feature status and GPU profile support are capabilities; CDP Media decoder properties describe actual playback. Single-run timing samples depend on hardware, background load and cache warmup; this is not a broad codec benchmark.',
  runs: [],
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function run(mode, launchFlags) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-gpu-smoke-'))
  const result = {
    mode,
    launchFlags,
    temporary,
    rendererErrors: [],
    mediaEvents: [],
    mediaProperties: {},
    mediaErrors: [],
    mediaMessages: [],
    seekSamples: [],
  }
  report.runs.push(result)
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: path.join(temporary, 'user-data'),
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: launchFlags } : { args: ['.', ...launchFlags] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  try {
    const actual = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      versions: process.versions,
      argv: process.argv,
    }))
    assert.equal(
      path.resolve(actual.userData).toLowerCase(),
      path.resolve(env.DVM_USER_DATA_DIR).toLowerCase(),
      'Application did not isolate userData',
    )
    result.versions = actual.versions
    result.argv = actual.argv
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => result.rendererErrors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    cdp.on('Media.playerPropertiesChanged', ({ playerId, properties }) => {
      const target = (result.mediaProperties[playerId] ??= {})
      for (const property of properties) target[property.name] = property.value
    })
    cdp.on('Media.playerEventsAdded', (event) => result.mediaEvents.push(event))
    cdp.on('Media.playerErrorsRaised', (event) => result.mediaErrors.push(event))
    cdp.on('Media.playerMessagesLogged', (event) => result.mediaMessages.push(event))
    await cdp.send('Media.enable')
    async function waitUntil(predicate, timeout = 30_000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate)) return
        await delay(30)
      }
      throw new Error(`Timeout waiting for ${predicate.toString()}`)
    }
    await waitUntil(() => !!window.api?.videos && document.body.innerText.length > 0)
    const invoke = async (group, method, ...values) => {
      const response = await page.evaluate(
        async ({ group, method, values }) => window.api[group][method](...values),
        { group, method, values },
      )
      assert.equal(response.ok, true, `${group}.${method}: ${response.error}`)
      return response.value
    }
    const library = await invoke('library', 'create', 'GPU fixture', path.dirname(fixture.video))
    await invoke('library', 'open', library.id)
    await invoke('library', 'importFolder', library.id, path.dirname(fixture.video))
    const videos = await invoke('videos', 'search', library.id, {})
    assert.equal(videos.total, 1)
    assert.equal(path.resolve(videos.videos[0].filePath), fixture.video)
    await page.reload()
    await waitUntil(() => document.body.innerText.includes('GPU fixture'))
    const open = page.getByRole('button', { name: '열기', exact: true }).first()
    if (await open.isVisible()) await open.click()
    await waitUntil(() => document.body.innerText.includes('long-gop.mp4'))
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
      window.showInactive()
    })
    await page.getByText('long-gop.mp4', { exact: true }).first().dblclick()
    await waitUntil(() => {
      const video = document.querySelector('video')
      return !!video && video.readyState >= 2 && video.duration > 89
    })
    await page.evaluate(async () => {
      const video = document.querySelector('video')
      video.muted = true
      window.__gpuFrames = []
      if (video.requestVideoFrameCallback) {
        const frame = (at, metadata) => {
          window.__gpuFrames.push({
            at,
            time: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
          })
          video.requestVideoFrameCallback(frame)
        }
        video.requestVideoFrameCallback(frame)
      }
      const quality = video.getVideoPlaybackQuality?.()
      window.__gpuStartQuality = quality
        ? { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }
        : null
      window.__gpuStartTime = performance.now()
      await video.play()
    })
    await delay(3200)
    result.playback = await page.evaluate(() => {
      const video = document.querySelector('video')
      const quality = video.getVideoPlaybackQuality?.()
      video.pause()
      return {
        durationMs: performance.now() - window.__gpuStartTime,
        position: video.currentTime,
        frameCallbackSupported: !!video.requestVideoFrameCallback,
        frames: window.__gpuFrames,
        decodedFrameDelta: quality
          ? quality.totalVideoFrames - window.__gpuStartQuality.total
          : null,
        droppedFrameDelta: quality
          ? quality.droppedVideoFrames - window.__gpuStartQuality.dropped
          : null,
        mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
      }
    })
    result.gpu = await app.evaluate(async ({ app }) => ({
      featureStatus: app.getGPUFeatureStatus(),
      completeInfo: await app.getGPUInfo('complete'),
      hardwareAccelerationEnabled:
        typeof app.isHardwareAccelerationEnabled === 'function'
          ? app.isHardwareAccelerationEnabled()
          : null,
    }))
    result.accelerationInfo = await invoke('app', 'getAccelerationInfo')
    assert.equal(result.accelerationInfo.videoDecodeStatus, result.gpu.featureStatus.video_decode)
    assert.equal(
      result.accelerationInfo.gpuCompositingStatus,
      result.gpu.featureStatus.gpu_compositing,
    )
    for (const target of [
      6.5, 29.75, 11.25, 54.5, 37.75, 78.25, 6.5, 29.75, 11.25, 54.5, 37.75, 78.25,
    ]) {
      const sample = await page.evaluate(
        (target) =>
          new Promise((resolve, reject) => {
            const video = document.querySelector('video')
            const start = performance.now()
            const timeout = setTimeout(() => {
              video.removeEventListener('seeked', completed)
              reject(new Error('Seek timed out'))
            }, 10_000)
            function completed() {
              clearTimeout(timeout)
              video.removeEventListener('seeked', completed)
              resolve({
                target,
                actual: video.currentTime,
                seekedMs: performance.now() - start,
                readyState: video.readyState,
                mediaError: video.error?.message ?? null,
              })
            }
            video.addEventListener('seeked', completed)
            video.currentTime = target
          }),
        target,
      )
      assert.ok(
        Math.abs(sample.actual - target) < 0.08,
        'Seek failed to reach the requested position',
      )
      result.seekSamples.push(sample)
      await delay(70)
    }
    await delay(300)
    result.actualDecoderEvidence = Object.entries(result.mediaProperties).map(
      ([playerId, properties]) => ({
        playerId,
        properties: Object.fromEntries(
          Object.entries(properties).filter(([name]) =>
            /decoder|platform|hardware|pipeline|resolution|video.?tracks/i.test(name),
          ),
        ),
      }),
    )
    const seekTimes = result.seekSamples.map((sample) => sample.seekedMs)
    const frames = result.playback.frames
    const gaps = frames.slice(1).map((frame, index) => frame.at - frames[index].at)
    result.summary = {
      advertisedVideoDecode: result.gpu.featureStatus.video_decode,
      actualDecoderEvidence: result.actualDecoderEvidence,
      medianSeekedMs: median(seekTimes),
      maxSeekedMs: Math.max(...seekTimes),
      presentedFrames: frames.length,
      maxPlaybackFrameGapMs: gaps.length ? Math.max(...gaps) : null,
      droppedFrameDelta: result.playback.droppedFrameDelta,
    }
    result.passed =
      result.rendererErrors.length === 0 &&
      result.playback.mediaError === null &&
      result.playback.position > 2 &&
      result.seekSamples.length === 12 &&
      result.actualDecoderEvidence.some((entry) =>
        Object.keys(entry.properties).some((name) => /decoder/i.test(name)),
      )
    console.log(JSON.stringify({ mode, passed: result.passed, summary: result.summary }, null, 2))
  } catch (error) {
    result.failure = error.stack ?? String(error)
    result.passed = false
    throw error
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
    await app.close()
  }
}
async function main() {
  await run('default', [])
  await run('software-video-decode', ['--disable-accelerated-video-decode'])
  report.passed = report.runs.every((run) => run.passed)
  fs.writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(`Saved ${output}`)
  if (!report.passed) process.exitCode = 1
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
