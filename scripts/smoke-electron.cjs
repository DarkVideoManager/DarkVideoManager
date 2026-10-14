// Real Electron/SQLite/FFmpeg integration checks; all mutations stay in a new temp directory.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
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
  appCode.includes('DVM_USER_DATA_DIR') && appCode.includes('DVM_SMOKE_TEST'),
  'Refusing to run an application without the restored isolation support',
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-restoration-smoke-'))
const media = path.join(temporary, 'media')
const additional = path.join(temporary, 'additional')
const output = path.join(root, 'test-results')
for (const dir of [media, additional, output]) fs.mkdirSync(dir, { recursive: true })
const video = path.join(media, 'sample.mp4')
const extraVideo = path.join(additional, 'extra.avi')
const csv = path.join(temporary, 'import.csv')
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='

execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=6', '-pix_fmt', 'yuv420p', video],
  { windowsHide: true, stdio: 'ignore' },
)
execFileSync(require('./media-paths.cjs').getFfmpegPath(), ['-y', '-i', video, '-c:v', 'mpeg4', '-an', extraVideo], {
  windowsHide: true,
  stdio: 'ignore',
})
fs.writeFileSync(
  path.join(media, 'sample.srt'),
  '1\n00:00:00,500 --> 00:00:02,000\nRestored subtitle\n',
  'utf8',
)
fs.writeFileSync(
  csv,
  `_table,filepath,stars,start\nfiles,"${video}",4,\nfavorites,"${video}",,1500\n`,
  'utf8',
)

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
  const errors = []
  const passed = []
  try {
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(
      path.resolve(actualUserData).toLowerCase(),
      path.resolve(env.DVM_USER_DATA_DIR).toLowerCase(),
      'Application did not honor the isolated test directory',
    )
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => errors.push(error.message))
    // Playwright's waitForFunction uses eval internally, which the production CSP rejects.
    const waitUntil = async (predicate) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const state = await page.evaluate(() => ({
        text: document.body.innerText,
        api: Object.keys(window.api || {}),
        url: location.href,
      }))
      throw new Error(`Timed out waiting for restored UI: ${JSON.stringify({ state, errors })}`)
    }
    await waitUntil(() => !!window.api?.dataImport && document.body.innerText.length > 0)
    assert.deepEqual(
      await page.evaluate(() => Object.keys(window.api.dataImport).sort()),
      ['importCsv', 'preview', 'selectCsv'],
      'Only CSV metadata import should be exposed to the renderer',
    )
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const library = await invoke('library', 'create', 'Restoration test', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 1)
    assert.equal((await invoke('library', 'importFolder', library.id, additional)).added, 1)
    await invoke('library', 'refresh', library.id)
    let results = await invoke('videos', 'search', library.id, { page: 1, pageSize: 50 })
    assert.equal(results.total, 2, 'Refresh must retain additional imported folders')
    const item = results.videos.find((entry) => entry.filePath === video)
    assert.ok(item)
    passed.push('folder import, probing, additional-folder refresh, search')

    await invoke('videos', 'updateMeta', library.id, item.id, {
      title: 'Restored title',
      rating: 3,
      memo: 'Restored memo',
      tags: 'test-tag',
    })
    assert.equal((await invoke('videos', 'search', library.id, { q: 'test-tag' })).total, 1)
    const preview = await invoke('dataImport', 'preview', library.id, csv)
    assert.equal(preview.matchedRatingRows, 1)
    const imported = await invoke('dataImport', 'importCsv', library.id, csv, {
      importRatings: true,
      importFavoritesAsHighlights: true,
    })
    assert.equal(imported.ratingsUpdated, 1)
    assert.equal(imported.highlightsAdded, 1)
    assert.equal((await invoke('videos', 'get', library.id, item.id)).rating, 4)
    passed.push('metadata, tag search, CSV preview/import')

    const highlight = await invoke('highlights', 'create', library.id, {
      videoId: item.id,
      timeStart: 3,
      color: 'yellow',
    })
    await invoke('highlights', 'update', library.id, highlight.id, {
      label: 'Smoke highlight',
      color: 'blue',
    })
    assert.ok(
      (await invoke('highlights', 'list', library.id, item.id)).some(
        (entry) => entry.label === 'Smoke highlight',
      ),
    )
    await invoke('highlights', 'delete', library.id, highlight.id)
    await invoke('thumbnails', 'ensureForVideo', library.id, item.id, false)
    await invoke('thumbnails', 'captureAtTime', library.id, item.id, 1, true)
    await invoke(
      'thumbnails',
      'saveImageCapture',
      library.id,
      item.id,
      2,
      `data:image/png;base64,${png}`,
      false,
    )
    const thumbnails = await invoke('thumbnails', 'getForVideo', library.id, item.id)
    assert.ok(thumbnails.length >= 2)
    await invoke('thumbnails', 'setPrimary', library.id, thumbnails[0].id, item.id)
    passed.push(
      'highlight CRUD, generated thumbnails, frame capture, image capture, primary selection',
    )

    const subtitles = await invoke('subtitles', 'getForVideo', library.id, item.id)
    assert.ok(subtitles.some((entry) => entry.type === 'srt'))
    const vtt = await invoke('subtitles', 'convertToVtt', library.id, subtitles[0].filePath, 'srt')
    assert.match(await invoke('subtitles', 'readText', library.id, vtt), /^WEBVTT/)
    const source = await invoke('videos', 'getPlaybackSource', library.id, item.id)
    const url = `local-media://file?path=${encodeURIComponent(source)}`
    const response = await app.evaluate(async ({ net }, url) => {
      const result = await net.fetch(url, { headers: { range: 'bytes=0-15' } })
      return { status: result.status, length: (await result.arrayBuffer()).byteLength }
    }, url)
    assert.deepEqual(response, { status: 206, length: 16 })
    const native = await invoke('videos', 'getNativePlayerInfo')
    assert.ok(native === null || ['mpv', 'ffplay', 'vlc'].includes(native.name))
    const availablePlayers = await invoke('app', 'getNativePlayers')
    if (availablePlayers.length) {
      await invoke('app', 'updateSettings', { nativePlayer: availablePlayers[0] })
      assert.deepEqual(await invoke('videos', 'getNativePlayerInfo'), availablePlayers[0])
      assert.deepEqual((await invoke('app', 'getSettings')).nativePlayer, availablePlayers[0])
    }
    const acceleration = await invoke('app', 'getAccelerationInfo')
    assert.equal(typeof acceleration.videoDecodeStatus, 'string')
    assert.equal(typeof acceleration.gpuCompositingStatus, 'string')
    const beforeInvalid = await invoke('app', 'getSettings')
    const rejectedSettings = await page.evaluate(
      async (missing) =>
        window.api.app.updateSettings({
          nativePlayer: { name: 'vlc', path: missing },
        }),
      path.join(temporary, 'missing-player.exe'),
    )
    assert.equal(rejectedSettings.ok, false, 'Missing player path must fail validation')
    assert.deepEqual(
      await invoke('app', 'getSettings'),
      beforeInvalid,
      'Invalid settings must not overwrite saved preferences',
    )
    // A regular file passes path validation but CreateProcess must reject its executable format.
    const invalidExecutable = path.join(temporary, 'invalid-player.exe')
    fs.writeFileSync(invalidExecutable, 'This disposable smoke fixture is not an executable.')
    await invoke('app', 'updateSettings', {
      nativePlayer: { name: 'vlc', path: invalidExecutable },
    })
    const rejectedLaunch = await page.evaluate(
      async ({ libraryId, videoId }) =>
        window.api.videos.openInNativePlayer(libraryId, videoId, {}),
      { libraryId: library.id, videoId: item.id },
    )
    assert.equal(rejectedLaunch.ok, false, 'Invalid executable must not report a successful launch')
    await invoke('app', 'updateSettings', { nativePlayer: null })
    passed.push(
      'native player discovery, settings validation/persistence and real launch failure reporting',
    )
    assert.equal(await invoke('videos', 'seekActivePlayback', library.id, item.id, 1), false)
    passed.push(
      'SRT conversion/read, playback source, local-media range streaming, native-player discovery',
    )

    await invoke('playback', 'start', library.id, item.id)
    await invoke('playback', 'heartbeat', library.id, item.id, 3)
    await invoke('playback', 'end', library.id, item.id, 3600)
    const stats = await invoke('stats', 'get', library.id, 30)
    assert.equal(stats.totalVideos, 2)
    assert.ok(stats.totalWatchedSec < 30, 'Seek position must not inflate watched time')
    passed.push('playback lifecycle and seek-safe statistics')

    await page.reload()
    await waitUntil(() => document.body.innerText.includes('Restoration test'))
    const libraryButton = page.getByRole('button', { name: '열기', exact: true }).first()
    if (await libraryButton.isVisible()) await libraryButton.click()
    await waitUntil(
      () =>
        document.body.innerText.includes('sample.mp4') ||
        document.body.innerText.includes('Restored title'),
    )
    await page.getByText('Restored title', { exact: true }).first().dblclick()
    await waitUntil(() => {
      const video = document.querySelector('video')
      return !!video && video.readyState >= 1 && video.duration > 5
    })
    await page.evaluate(async () => {
      const video = document.querySelector('video')
      video.muted = true
      video.currentTime = 0.25
      await video.play()
    })
    await waitUntil(() => document.querySelector('video')?.currentTime > 0.5)
    await page.evaluate(() => document.querySelector('video').pause())
    passed.push('real H.264 playback in the restored Electron video element')
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    })
    if (screenshot)
      fs.writeFileSync(
        path.join(output, 'restoration-electron.png'),
        Buffer.from(screenshot, 'base64'),
      )

    const extra = results.videos.find((entry) => entry.filePath === extraVideo)
    await invoke('app', 'updateSettings', { cacheLimitGb: 2 })
    assert.equal((await invoke('app', 'getSettings')).cacheLimitGb, 2)
    const proxy = await invoke('videos', 'getPlaybackSource', library.id, extra.id)
    assert.notEqual(proxy, extraVideo)
    assert.ok((await invoke('app', 'getCacheInfo')).protectedBytes > 0)
    await invoke('app', 'cleanCache')
    assert.ok(fs.existsSync(proxy), 'Cleanup must preserve the active playback proxy')
    await invoke('playback', 'end', library.id, extra.id, 0)
    await invoke('app', 'cleanCache')
    assert.equal(fs.existsSync(proxy), false, 'Idle proxy should be removed')
    assert.ok(fs.existsSync(extraVideo), 'Cache cleanup must preserve the original video')
    assert.ok(
      thumbnails.every((thumbnail) => fs.existsSync(thumbnail.filePath)),
      'Cache cleanup must preserve captures',
    )
    passed.push('settings persistence, real AVI proxy, active cache protection and safe cleanup')
    await invoke('videos', 'updateMeta', library.id, extra.id, { memo: 'Keep removed metadata' })
    await invoke('videos', 'delete', library.id, extra.id, 'remove')
    assert.equal(fs.existsSync(extraVideo), true, 'List-only removal must preserve the source')
    await invoke('library', 'refresh', library.id)
    assert.equal((await invoke('videos', 'search', library.id, {})).total, 1)
    const removed = await invoke('videos', 'search', library.id, { removed: true })
    assert.equal(removed.videos[0].memo, 'Keep removed metadata')
    await invoke('videos', 'restore', library.id, extra.id)
    await invoke('videos', 'delete', library.id, extra.id)
    assert.equal(fs.existsSync(extraVideo), false, 'Trash should move the disposable source file')
    assert.equal(
      (await invoke('videos', 'get', library.id, extra.id)).memo,
      'Keep removed metadata',
    )
    assert.equal((await invoke('videos', 'search', library.id, { page: 1, pageSize: 50 })).total, 1)
    passed.push(
      'list-only removal, refresh exclusion, metadata-preserving restore and real Windows trash',
    )
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`)
    const report = {
      passed,
      temporary,
      packaged: !!executablePath,
      rendererErrors: errors,
      acceleration,
    }
    fs.writeFileSync(
      path.join(output, executablePath ? 'restoration-packaged.json' : 'restoration-electron.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
