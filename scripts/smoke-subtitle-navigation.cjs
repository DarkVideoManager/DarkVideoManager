/* eslint-disable @typescript-eslint/no-var-requires -- Standalone Node smoke script. */
// Real packaged playback and subtitle IPC; all fixtures live in a fresh isolated directory.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
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
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST'].every((part) => appCode.includes(part)),
  'Refusing to launch without isolated user-data and hidden-window support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-navigation-smoke-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const videoPath = path.join(media, 'subtitle-navigation.mp4')
const subtitlePath = path.join(media, 'subtitle-navigation.srt')
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=12',
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
fs.writeFileSync(
  subtitlePath,
  [
    '1\n00:00:01,250 --> 00:00:03,000\n첫 번째 인사',
    '2\n00:00:04,375 --> 00:00:07,000\n찾아갈 장면\n두 번째 줄',
    '3\n00:00:08,500 --> 00:00:11,000\n마지막 설명',
  ].join('\n\n') + '\n',
  'utf8',
)
const checksum = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originalHashes = [checksum(videoPath), checksum(subtitlePath)]

function assertTemporary(filePath) {
  const relative = path.relative(temporary, path.resolve(filePath))
  assert.ok(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative),
    `Unexpected path outside isolated fixtures: ${filePath}`,
  )
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: userData,
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  const rendererErrors = []
  try {
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualUserData).toLowerCase(), path.resolve(userData).toLowerCase())
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    // Poll with evaluate: production CSP intentionally rejects waitForFunction's eval.
    const waitUntil = async (predicate, description) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out: ${description}; UI: ${await page.locator('body').innerText()}`)
    }
    await waitUntil(() => !!window.api?.library?.create, 'library API')
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
      'Isolated smoke window must remain hidden',
    )
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    })
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    const library = await invoke('library', 'create', 'Subtitle navigation smoke', media)
    assertTemporary(library.dbPath)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 1)
    const video = (await invoke('videos', 'search', library.id, {})).videos[0]
    assert.equal(video.filePath, videoPath)
    const subtitles = await invoke('subtitles', 'getForVideo', library.id, video.id)
    assert.equal(subtitles.length, 1)
    assert.equal(subtitles[0].type, 'srt')
    const vtt = await invoke('subtitles', 'convertToVtt', library.id, subtitlePath, 'srt')
    assertTemporary(vtt)
    const text = await invoke('subtitles', 'readText', library.id, vtt)
    assert.match(text, /^WEBVTT/)
    assert.match(text, /00:00:04\.375/)

    await page.reload()
    await page.getByText('Subtitle navigation smoke', { exact: true }).waitFor()
    await page.getByRole('button', { name: '열기', exact: true }).click()
    await page.getByText('subtitle-navigation.mp4', { exact: true }).first().dblclick()
    await waitUntil(() => {
      const video = document.querySelector('video')
      return !!video && video.readyState >= 2 && video.videoWidth === 640 && video.duration > 11
    }, 'real decoded video frame')
    await page.evaluate(() => {
      const video = document.querySelector('video')
      video.muted = true
      video.pause()
      window.subtitleNavigationSmoke = { seeks: [] }
      video.addEventListener('seeked', () => {
        window.subtitleNavigationSmoke.seeks.push(video.currentTime)
        video.pause()
      })
    })
    await page.getByRole('tab', { name: '자막 탐색', exact: true }).click()
    const navigator = page.getByRole('region', { name: '자막 탐색', exact: true })
    const destination = navigator.getByRole('button', { name: /찾아갈 장면/ })
    await destination.waitFor()
    assert.match(await destination.innerText(), /0:04\.375/)
    await destination.click()
    await waitUntil(
      () => window.subtitleNavigationSmoke.seeks.some((time) => Math.abs(time - 4.375) < 0.08),
      'subtitle click seeks real media to 4.375 seconds',
    )
    assert.equal(await destination.getAttribute('aria-current'), 'true')
    const search = navigator.getByRole('searchbox', { name: '자막 검색', exact: true })
    await search.fill('마지막')
    const last = navigator.getByRole('button', { name: /마지막 설명/ })
    await last.waitFor()
    assert.equal(
      await navigator.getByRole('list', { name: '자막 목록' }).getByRole('button').count(),
      1,
    )
    await last.click()
    await waitUntil(
      () => window.subtitleNavigationSmoke.seeks.some((time) => Math.abs(time - 8.5) < 0.08),
      'filtered subtitle click seeks real media to 8.5 seconds',
    )
    await search.fill('')
    await destination.waitFor()
    await waitUntil(() => {
      const navigator = document.querySelector('section[aria-label="자막 탐색"]')
      return (
        navigator?.querySelector('input')?.value === '' &&
        navigator.querySelectorAll('li button').length === 3 &&
        navigator.querySelector('[aria-current="true"]')?.textContent.includes('마지막 설명')
      )
    }, 'final subtitle list and active cue render')
    const mediaState = await page.evaluate(() => {
      const video = document.querySelector('video')
      return {
        seeks: window.subtitleNavigationSmoke.seeks,
        currentTime: video.currentTime,
        decodedWidth: video.videoWidth,
        decodedHeight: video.videoHeight,
        mediaError: video.error?.message ?? null,
      }
    })
    assert.equal(mediaState.mediaError, null)
    assert.ok(Math.abs(mediaState.currentTime - 8.5) < 0.08)
    assert.deepEqual(rendererErrors, [])
    assert.deepEqual([checksum(videoPath), checksum(subtitlePath)], originalHashes)
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    })
    assert.ok(screenshot, 'Hidden window must provide a rendered screenshot')
    const screenshotPath = path.join(output, 'subtitle-navigation-packaged.png')
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
    const report = {
      passed: [
        'real library import discovers SRT; real IPC converts and reads VTT',
        'subtitle click seeks decoded H.264 video to its fractional timestamp',
        'text search filters the list and a filtered cue seeks correctly',
        'source files unchanged; isolated user data and hidden window verified',
      ],
      packaged: !!executablePath,
      temporary,
      screenshotPath,
      mediaState,
      rendererErrors,
    }
    fs.writeFileSync(
      path.join(output, 'subtitle-navigation-packaged.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
