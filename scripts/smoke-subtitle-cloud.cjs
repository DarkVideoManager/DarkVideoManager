// Isolated Electron smoke test: mocked official Cloud API, real GPU ASR and local Ollama.
// Optional argument: unpacked executable. Never contacts Google Translation or bills an account.
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
  'Set DVM_SUBTITLE_SMOKE_FIXTURE to a spoken MP4 with at least two subtitle cues',
)
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources', 'app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8')
assert.ok(
  [
    'DVM_USER_DATA_DIR',
    'DVM_SMOKE_TEST',
    'cloud-translation.json',
    'subtitles:getTranslationSettings',
    'vulkan',
  ].every((marker) => appCode.includes(marker)),
  'Refusing to run a build without isolation, GPU and Cloud Translation support',
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-cloud-'))
const userData = path.join(temporary, 'user-data')
const media = path.join(temporary, 'media')
fs.mkdirSync(media)
const videoPath = path.join(media, 'cloud-then-ollama.mp4')
fs.copyFileSync(fixture, videoPath)
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DVM_USER_DATA_DIR: userData,
  DVM_SMOKE_TEST: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const fakeKey = 'dvm-smoke-fake-key-no-google-access'
const cloudText = '클라우드 번역 확인'
const errors = []
const messages = new Set()
const passed = []
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
    // Install before the first settings IPC: the service captures global fetch at construction.
    await app.evaluate(() => {
      const originalFetch = globalThis.fetch
      globalThis.cloudSmokeRequests = []
      globalThis.cloudSmokeResolve = undefined
      globalThis.fetch = async (input, options = {}) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url !== 'https://translation.googleapis.com/language/translate/v2') {
          if (new URL(url).hostname === 'translation.googleapis.com')
            throw new Error('Unexpected Google endpoint blocked by smoke test')
          return originalFetch(input, options)
        }
        const body = JSON.parse(options.body)
        globalThis.cloudSmokeRequests.push({
          method: options.method,
          target: body.target,
          model: body.model,
          format: body.format,
          source: body.source,
          characters: Array.from(body.q).length,
        })
        // A second request is still intercepted, so a quota regression cannot reach the network.
        if (globalThis.cloudSmokeRequests.length > 1)
          return new Response('{}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        return new Promise((resolve, reject) => {
          const aborted = () => reject(new Error('Smoke Cloud request aborted'))
          options.signal?.addEventListener('abort', aborted, { once: true })
          if (options.signal?.aborted) return aborted()
          globalThis.cloudSmokeResolve = (response) => {
            options.signal?.removeEventListener('abort', aborted)
            globalThis.cloudSmokeResolve = undefined
            resolve(response)
          }
        })
      }
    })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await until('Cloud Translation IPC ready', () =>
      page.evaluate(() => !!window.api?.subtitles?.getTranslationSettings),
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

function assertRedacted(settings) {
  assert.equal(Object.hasOwn(settings, 'apiKey'), false)
  assert.equal(Object.hasOwn(settings, 'encryptedApiKey'), false)
  assert.equal(JSON.stringify(settings).includes(fakeKey), false)
}

function readStoredSettings() {
  const text = fs.readFileSync(path.join(userData, 'cloud-translation.json'), 'utf8')
  assert.equal(text.includes(fakeKey), false, 'API key persisted without encryption')
  return JSON.parse(text)
}

function readSrt(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      assert.match(lines[1], /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/)
      return { timing: lines[1], text: lines.slice(2).join('\n') }
    })
}

async function observeJob(invoke, jobId) {
  const job = (await invoke('subtitles', 'listQueue')).find((item) => item.id === jobId)
  assert.ok(job, 'Missing isolated subtitle job')
  if (job.message && !messages.has(job.message)) {
    messages.add(job.message)
    console.log(`Isolated subtitle progress: ${job.message}`)
  }
  assert.ok(
    !['failed', 'cancelled'].includes(job.phase),
    `Subtitle job ${job.phase}: ${job.message}`,
  )
  return job
}

async function main() {
  let session
  try {
    session = await launch()
    const { app, invoke } = session
    const settings = await invoke('subtitles', 'updateTranslationSettings', {
      enabled: true,
      apiKey: fakeKey,
      monthlyLimit: 500_000,
      externalCharacters: 0,
    })
    assertRedacted(settings)
    assert.equal(settings.hasApiKey, true)
    assert.equal(settings.usedCharacters, 0)
    assert.ok(readStoredSettings().encryptedApiKey, 'API key was not encrypted on disk')
    assertRedacted(await invoke('subtitles', 'getTranslationSettings'))
    passed.push('isolated settings IPC redacts the API key and Windows storage encrypts it')

    const library = await invoke('library', 'create', 'Cloud Translation smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal((await invoke('library', 'importFolder', library.id, media)).added, 1)
    const video = (await invoke('videos', 'search', library.id, {})).videos.find(
      (item) => item.filePath === videoPath,
    )
    assert.ok(video)
    const job = await invoke('subtitles', 'generate', library.id, video.id, {
      model: 'base',
      language: 'en',
      translateToKorean: true,
    })
    await until(
      'first Cloud request reserved and held',
      async () => {
        await observeJob(invoke, job.id)
        return app.evaluate(
          () => globalThis.cloudSmokeRequests.length > 0 && !!globalThis.cloudSmokeResolve,
        )
      },
      8 * 60_000,
    )
    const firstRequest = await app.evaluate(() => globalThis.cloudSmokeRequests[0])
    assert.deepEqual(
      { ...firstRequest, characters: undefined },
      {
        method: 'POST',
        target: 'ko',
        model: 'nmt',
        format: 'text',
        source: 'en',
        characters: undefined,
      },
    )
    assert.ok(firstRequest.characters > 0)
    const reserved = await invoke('subtitles', 'getTranslationSettings')
    assert.equal(
      reserved.usedCharacters,
      firstRequest.characters,
      'Usage was not reserved before the Cloud response',
    )
    const checkpoint = JSON.parse(
      fs.readFileSync(
        path.join(userData, 'subtitle-jobs', `queue-${job.id}`, 'checkpoint.json'),
        'utf8',
      ),
    )
    assert.equal(checkpoint.identity.backend, 'vulkan')
    assert.ok(
      checkpoint.cues.length > 1,
      'Fixture must produce at least two cues to test Cloud-to-Ollama switching',
    )
    assert.equal(Array.from(checkpoint.cues[0].text).length, firstRequest.characters)
    const limited = await invoke('subtitles', 'updateTranslationSettings', {
      monthlyLimit: reserved.usedCharacters,
    })
    assert.equal(limited.remainingCharacters, 0)
    await app.evaluate((_, translation) => {
      if (!globalThis.cloudSmokeResolve) throw new Error('First Cloud request is no longer pending')
      globalThis.cloudSmokeResolve(
        new Response(
          JSON.stringify({ data: { translations: [{ translatedText: translation }] } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }, cloudText)

    let previousPhase
    const completed = await until(
      'local Ollama completes the remaining cues',
      async () => {
        const current = await observeJob(invoke, job.id)
        if (current.phase !== previousPhase) {
          console.log(`Isolated subtitle job: ${current.phase}`)
          previousPhase = current.phase
        }
        return current.phase === 'completed' && current
      },
      8 * 60_000,
    )
    assert.equal(completed.outputPaths?.length, 2)
    for (const file of completed.outputPaths)
      assert.equal(path.dirname(file).toLowerCase(), media.toLowerCase())
    const original = readSrt(completed.outputPaths.find((file) => !file.endsWith('.ko.srt')))
    const translated = readSrt(completed.outputPaths.find((file) => file.endsWith('.ko.srt')))
    assert.deepEqual(
      original.map((cue) => cue.timing),
      translated.map((cue) => cue.timing),
    )
    assert.equal(translated[0].text, cloudText)
    assert.ok(
      translated.slice(1).every((cue) => /[가-힣]/.test(cue.text)),
      'Local translations are missing Korean text',
    )
    const requests = await app.evaluate(() => globalThis.cloudSmokeRequests)
    assert.equal(requests.length, 1, 'A second Cloud request escaped the monthly gate')
    const finalSettings = await invoke('subtitles', 'getTranslationSettings')
    assert.equal(finalSettings.usedCharacters, firstRequest.characters)
    assert.equal(finalSettings.remainingCharacters, 0)
    assertRedacted(finalSettings)
    passed.push(
      'real Vulkan ASR, one reserved Cloud request, quota-triggered local Ollama and synchronized SRT output',
    )

    await quit(app)
    session = undefined
    session = await launch()
    const restored = await session.invoke('subtitles', 'getTranslationSettings')
    assertRedacted(restored)
    assert.equal(restored.hasApiKey, true)
    assert.equal(restored.usedCharacters, firstRequest.characters)
    assert.equal(restored.monthlyLimit, firstRequest.characters)
    assert.equal(restored.remainingCharacters, 0)
    assert.ok(readStoredSettings().encryptedApiKey)
    const rejected = await session.page.evaluate(() =>
      window.api.subtitles.updateTranslationSettings({ monthlyLimit: 500_001 }),
    )
    assert.equal(rejected.ok, false, 'The free-tier maximum was not enforced through IPC')
    const removed = await session.invoke('subtitles', 'updateTranslationSettings', {
      removeApiKey: true,
    })
    assertRedacted(removed)
    assert.equal(removed.hasApiKey, false)
    assert.equal(removed.usedCharacters, firstRequest.characters)
    assert.equal(removed.monthlyLimit, firstRequest.characters)
    assert.equal(readStoredSettings().encryptedApiKey, undefined)
    assert.deepEqual(errors, [])
    passed.push(
      'restart keeps encrypted credentials and usage; key deletion preserves usage; limits above 500,000 are rejected',
    )

    const report = {
      passed,
      temporary,
      packaged: !!executablePath,
      rendererErrors: errors,
      cloudRequestCount: requests.length,
      firstRequest,
      cueCount: original.length,
      usedCharacters: finalSettings.usedCharacters,
      observedQuotaFallbackMessage: [...messages].some(
        (message) => /한도/.test(message) && /Ollama/.test(message),
      ),
      realCloudNetworkCalls: 0,
    }
    const output = path.join(root, 'test-results')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(
      path.join(output, `subtitle-cloud-${executablePath ? 'packaged' : 'electron'}.json`),
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
