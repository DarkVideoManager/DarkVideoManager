// Existing SRT discovery through the real preload, IPC, SQLite and built renderer.
// Run after npm run build; fixtures and the hidden app profile are isolated in a new temp folder.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const iconv = require('iconv-lite')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const appCode = fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST'].every((part) => appCode.includes(part)))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-existing-srt-smoke-'))
const media = path.join(temporary, 'media')
const offline = path.join(temporary, 'offline-media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
fs.mkdirSync(media)
fs.mkdirSync(output, { recursive: true })
function assertTemporary(file) {
  const relative = path.relative(temporary, path.resolve(file))
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
  )
}
const videoPath = path.join(media, 'sample.mp4')
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=12:d=6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    videoPath,
  ],
  { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
)
fs.copyFileSync(videoPath, path.join(media, 'sample.en.mp4'))
const cue = (text) => `1\r\n00:00:01,250 --> 00:00:04,000\r\n${text}\r\n`
const exactPath = path.join(media, 'sample.srt')
const japanesePath = path.join(media, 'sample.JA.SRT')
fs.writeFileSync(exactPath, cue('Existing exact SRT'))
fs.writeFileSync(japanesePath, cue('既存の日本語字幕'))
fs.writeFileSync(path.join(media, 'sample.en.srt'), cue('Neighboring video owns this exact stem'))
fs.writeFileSync(path.join(media, 'sample.trailer.ko.srt'), cue('Unrelated title'))
const checksum = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originals = new Map(
  [videoPath, exactPath, japanesePath].map((file) => [file, checksum(file)]),
)
const passed = []
const rendererErrors = []

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: userData,
    DVM_SMOKE_TEST: '1',
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'VITE_MOCK_IPC'])
    delete env[name]
  const app = await electron.launch({ args: ['.'], cwd: root, env, timeout: 60_000 })
  try {
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(),
      path.resolve(userData).toLowerCase(),
    )
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win.isVisible()) throw new Error('Smoke window must remain hidden')
      win.webContents.setBackgroundThrottling(false)
      win.webContents.setAudioMuted(true)
    })
    const poll = async (read, label) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await read()) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out: ${label}`)
    }
    await poll(() => page.evaluate(() => !!window.api?.library?.create), 'real preload')
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${result.error}`)
      return result.value
    }
    const library = await invoke('library', 'create', 'Existing SRT smoke', media)
    assertTemporary(library.dbPath)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 2)
    const videos = (await invoke('videos', 'search', library.id, {})).videos
    const video = videos.find((item) => item.filePath === videoPath)
    const neighbor = videos.find((item) => item.filePath === path.join(media, 'sample.en.mp4'))
    assert.ok(video && neighbor)
    const tracks = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.deepEqual(tracks.map((item) => path.basename(item.filePath)).sort(), [
      'sample.JA.SRT',
      'sample.srt',
    ])
    assert.equal((await invoke('subtitles', 'getForVideo', library.id, neighbor.id)).length, 1)
    passed.push('real import discovers exact/language SRT and respects neighboring exact stems')

    const koreanPath = path.join(media, 'sample.ko.srt')
    const koreanText =
      '안녕하세요. 기존 자막을 다시 만들지 않고 그대로 불러옵니다. 한국어 자막의 인코딩을 확인합니다.'
    const koreanBytes = iconv.encode(cue(koreanText), 'cp949')
    fs.writeFileSync(koreanPath, koreanBytes)
    const added = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.equal(added.length, 3)
    for (const old of tracks)
      assert.deepEqual(
        added.find((item) => item.id === old.id),
        old,
      )
    const converted = await invoke('subtitles', 'convertToVtt', library.id, koreanPath, 'srt')
    assertTemporary(converted)
    const convertedText = await invoke('subtitles', 'readText', library.id, converted)
    assert.ok(convertedText.startsWith('WEBVTT\n\n'))
    assert.ok(convertedText.includes('00:00:01.250'))
    assert.ok(convertedText.includes(koreanText))
    assert.deepEqual(fs.readFileSync(koreanPath), koreanBytes)
    assertTemporary(koreanPath)
    fs.unlinkSync(koreanPath)
    const afterDelete = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.deepEqual(afterDelete, tracks)
    passed.push(
      'indexed video rediscovers added/deleted SRT; CP949 VTT conversion preserves originals and existing IDs',
    )

    assertTemporary(media)
    assertTemporary(offline)
    fs.renameSync(media, offline)
    try {
      const stored = await invoke('subtitles', 'getForVideo', library.id, video.id)
      assert.equal(stored.length, tracks.length)
      for (const track of tracks)
        assert.deepEqual(
          stored.find((item) => item.id === track.id),
          track,
        )
    } finally {
      fs.renameSync(offline, media)
    }
    passed.push('offline directory retains its previously indexed track snapshot')

    await page.reload()
    const main = page.getByRole('main')
    await main.getByText('Existing SRT smoke', { exact: true }).waitFor()
    await main.getByRole('button', { name: '열기', exact: true }).click()
    const videoCard = page.getByRole('button', { name: 'sample.mp4 영상 카드', exact: true })
    await videoCard.click()
    await page.getByRole('region', { name: '대표 썸네일 선택', exact: true }).waitFor()
    await videoCard.dblclick()
    await poll(
      () => page.evaluate(() => document.querySelector('video')?.readyState >= 2),
      'decoded video',
    )
    await page
      .getByLabel('자막 선택', { exact: true })
      .selectOption(tracks.find((item) => item.lang === 'ja').id)
    await page.getByRole('button', { name: '자막 탐색', exact: true }).click()
    const navigator = page.getByRole('region', { name: '자막 탐색', exact: true })
    const destination = navigator.getByRole('button', { name: /既存の日本語字幕/ })
    await destination.waitFor()
    await page.evaluate(() => document.querySelector('video').pause())
    await destination.click()
    await poll(
      () => page.evaluate(() => Math.abs(document.querySelector('video').currentTime - 1.25) < 0.2),
      'existing SRT cue seek',
    )
    for (const [file, before] of originals) assert.equal(checksum(file), before)
    assert.deepEqual(rendererErrors, [])
    passed.push(
      'real player selects Japanese sidecar, renders its cue and seeks decoded video; source hashes unchanged',
    )
    await page.screenshot({ path: path.join(output, 'existing-srt-smoke.png') })
    const report = { ok: true, passed, rendererErrors }
    fs.writeFileSync(
      path.join(output, 'existing-srt-smoke.json'),
      JSON.stringify(report, null, 2) + '\n',
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
