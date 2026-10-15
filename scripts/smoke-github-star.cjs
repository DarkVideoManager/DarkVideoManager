// Real Electron first-run checks. Browser opening is intercepted inside this
// isolated test process; no GitHub account, browser session, or user profile is used.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { _electron: electron, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const output = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, 'test-results', 'github-star-first-run')
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(
  ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST', 'githubStarPromptShown'].every((part) =>
    appCode.includes(part),
  ),
  'Refusing to run without isolated profile support and the GitHub notice implementation',
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-star-smoke-'))
fs.mkdirSync(output, { recursive: true })
const rendererErrors = []
const passed = []
const expectedUrl = 'https://github.com/DarkVideoManager/DarkVideoManager'

async function launch(profile, failOpen = false) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: path.join(temporary, profile),
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  try {
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(),
      path.resolve(env.DVM_USER_DATA_DIR).toLowerCase(),
      'The app must honor the disposable profile before testing',
    )
    await app.evaluate(({ shell }, failOpen) => {
      globalThis.__dvmStarSmoke = { calls: [], failOpen }
      shell.openExternal = async (url) => {
        globalThis.__dvmStarSmoke.calls.push(url)
        if (globalThis.__dvmStarSmoke.failOpen) throw new Error('Smoke browser unavailable')
      }
    }, failOpen)
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await expect(page.getByRole('heading', { name: '라이브러리 선택', exact: true })).toBeVisible()
    return { app, page, profilePath: env.DVM_USER_DATA_DIR }
  } catch (error) {
    await app.close()
    throw error
  }
}

async function calls(app) {
  return app.evaluate(() => globalThis.__dvmStarSmoke.calls)
}

async function capture(app, name) {
  // Hidden Electron windows can commit their next compositor frame after the
  // DOM assertion resolves. Let that frame paint before collecting evidence.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
    return image.isEmpty() ? null : image.toPNG().toString('base64')
  })
  assert.ok(png, 'The actual Electron renderer screenshot must not be empty')
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'))
}

async function main() {
  const first = await launch('dismiss-profile')
  try {
    const notice = first.page.getByRole('region', { name: 'GitHub Star 안내' })
    await expect(notice).toBeVisible()
    assert.deepEqual(await calls(first.app), [])
    const config = JSON.parse(fs.readFileSync(path.join(first.profilePath, 'config.json'), 'utf8'))
    assert.equal(config.githubStarPromptShown, true)
    await capture(first.app, 'first-run.png')
    await first.page.getByRole('link', { name: '통계', exact: true }).click()
    await expect(notice).toBeVisible()
    await first.page.getByRole('link', { name: '라이브러리', exact: true }).click()
    await notice.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await first.page.getByRole('link', { name: '자막 생성', exact: true }).click()
    await first.page.getByRole('link', { name: '라이브러리', exact: true }).click()
    await expect(notice).toHaveCount(0)
    const saved = await first.page.evaluate(() =>
      window.api.app.updateSettings({ cacheLimitGb: 13 }),
    )
    assert.equal(saved.ok, true)
    assert.deepEqual(await calls(first.app), [])
    passed.push('first display persists locally; navigation and dismissal never open a browser')
  } finally {
    await first.app.close()
  }

  const restarted = await launch('dismiss-profile')
  try {
    const flag = await restarted.page.evaluate(() => window.api.app.githubStar.claimPrompt())
    assert.deepEqual(flag, { ok: true, value: false })
    await expect(restarted.page.getByRole('region', { name: 'GitHub Star 안내' })).toHaveCount(0)
    const settings = await restarted.page.evaluate(() => window.api.app.getSettings())
    assert.equal(settings.value.cacheLimitGb, 13)
    assert.deepEqual(await calls(restarted.app), [])
    await capture(restarted.app, 'second-run.png')
    passed.push('same profile relaunch keeps settings and never shows the notice again')
  } finally {
    await restarted.app.close()
  }

  const clicked = await launch('click-profile', true)
  try {
    const notice = clicked.page.getByRole('region', { name: 'GitHub Star 안내' })
    await expect(notice).toBeVisible()
    assert.deepEqual(await calls(clicked.app), [])
    await notice.getByRole('button', { name: 'GitHub에서 Star 누르기' }).click()
    await expect(notice.getByRole('alert')).toContainText('브라우저를 열지 못했습니다')
    await expect(notice.getByRole('button', { name: 'GitHub에서 Star 누르기' })).toBeEnabled()
    assert.deepEqual(await calls(clicked.app), [expectedUrl])
    await capture(clicked.app, 'browser-failure.png')
    await clicked.app.evaluate(() => {
      globalThis.__dvmStarSmoke.failOpen = false
    })
    await notice.getByRole('button', { name: 'GitHub에서 Star 누르기' }).click()
    await expect(notice).toHaveCount(0)
    assert.deepEqual(await calls(clicked.app), [expectedUrl, expectedUrl])
    passed.push('explicit button clicks invoke only the fixed repository URL; failure is retryable')
  } finally {
    await clicked.app.close()
  }
  assert.deepEqual(rendererErrors, [])
  const report = {
    passed,
    rendererErrors,
    packaged: !!executablePath,
    browserInterception: true,
    profilesIsolated: true,
    screenshotFiles: ['first-run.png', 'second-run.png', 'browser-failure.png'],
  }
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  fs.writeFileSync(
    path.join(output, 'failure.json'),
    `${JSON.stringify({ error: error.message, passed, rendererErrors }, null, 2)}\n`,
  )
  console.error(error)
  process.exitCode = 1
})
