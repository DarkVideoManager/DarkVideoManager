// Real MPEG-4 Part 2 / AAC-in-MP4 regression with disposable media and userData.
// node scripts/smoke-codec.cjs [--baseline] [path/to/DarkVideoManager.exe]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const baseline = process.argv.includes('--baseline')
const executable = process.argv.slice(2).find((arg) => arg !== '--baseline')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-codec-smoke-'))
const mediaDirectory = path.join(temporary, 'media')
fs.mkdirSync(mediaDirectory)
const media = path.join(mediaDirectory, '[SHANA] 한글 코덱 회귀 검사.mp4')
execFileSync(require('./media-paths.cjs').getFfmpegPath(), [
  '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=60:d=6',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
  '-t', '6', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media,
], { windowsHide: true, stdio: 'ignore' })

async function main() {
  const env = { ...process.env, NODE_ENV: 'production', DVM_SMOKE_TEST: '1',
    DVM_USER_DATA_DIR: path.join(temporary, 'user-data') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 60_000,
  })
  const report = { baseline, packaged: !!executable, temporary, passed: false }
  try {
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), env.DVM_USER_DATA_DIR)
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '새 라이브러리', exact: true }).waitFor()
    const invoke = async (group, method, ...args) => {
      const response = await page.evaluate(async ({ group, method, args }) =>
        window.api[group][method](...args), { group, method, args })
      assert.equal(response.ok, true, `${group}.${method}: ${response.error}`)
      return response.value
    }
    const library = await invoke('library', 'create', 'Codec smoke', mediaDirectory)
    await invoke('library', 'open', library.id)
    await invoke('library', 'importFolder', library.id, mediaDirectory)
    const video = (await invoke('videos', 'search', library.id, {})).videos[0]
    assert.equal(video.codec, 'mpeg4')
    const source = await invoke('videos', 'getPlaybackSource', library.id, video.id)
    report.proxyCreated = source !== media
    if (!baseline) assert.equal(report.proxyCreated, true)
    if (!baseline) {
      await page.evaluate(({ libraryId, videoId }) => {
        location.hash = `/player/${libraryId}/${videoId}`
      }, { libraryId: library.id, videoId: video.id })
      await page.locator('video').waitFor()
      const deadline = Date.now() + 30_000
      while (!(await page.locator('video').evaluate((media) => media.readyState >= 2))) {
        assert.ok(Date.now() < deadline, 'In-app compatible playback did not become ready')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    report.playback = await page.evaluate(async ({ source, baseline }) => {
      const media = baseline ? document.createElement('video') : document.querySelector('video')
      media.muted = true
      if (baseline) {
        document.body.append(media)
        media.src = 'local-media://file?path=' + encodeURIComponent(source)
      }
      let playError
      try { await media.play() } catch (error) { playError = error.message }
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const result = {
        time: media.currentTime, width: media.videoWidth, height: media.videoHeight,
        decodedFrames: media.getVideoPlaybackQuality().totalVideoFrames,
        error: media.error ? { code: media.error.code, message: media.error.message } : null,
        playError,
      }
      media.pause()
      if (baseline) {
        media.removeAttribute('src')
        media.load()
        media.remove()
      }
      return result
    }, { source, baseline })
    if (baseline) {
      assert.equal(report.playback.decodedFrames, 0, 'Baseline unexpectedly decoded MPEG-4 video')
    } else {
      assert.equal(report.playback.error, null)
      assert.equal(report.playback.width, 320)
      assert.ok(report.playback.time > 0.5)
      assert.ok(report.playback.decodedFrames > 0)
      assert.ok(fs.existsSync(media), 'Original media must remain intact')
    }
    await invoke('playback', 'end', library.id, video.id, 0)
    report.passed = true
  } finally {
    await app.close()
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true })
    fs.writeFileSync(path.join(root, 'test-results', `codec-${baseline ? 'baseline' : executable ? 'packaged' : 'fixed'}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
