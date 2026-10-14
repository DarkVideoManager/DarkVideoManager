/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS smoke script. */
// Read-only subtitle readiness through real packaged IPC. Never starts installation.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
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

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-subtitle-environment-smoke-'))
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
fs.mkdirSync(output, { recursive: true })
const componentIds = ['whisper', 'speechModel', 'wsl', 'python', 'ollama', 'translationModel']
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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
  const processHandle = app.process()
  const rendererErrors = []
  try {
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualUserData).toLowerCase(), path.resolve(userData).toLowerCase())
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    // Poll evaluate: the production CSP intentionally rejects waitForFunction's eval.
    const waitUntil = async (predicate, description, timeout = 30_000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate)) return
        await pause(100)
      }
      throw new Error(`Timed out: ${description}; UI: ${await page.locator('body').innerText()}`)
    }
    await waitUntil(() => !!window.api?.subtitles?.checkSetup, 'subtitle setup preload API')
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
      'Isolated smoke window must remain hidden',
    )
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    })

    // These are the only service operations this smoke test is permitted to invoke.
    const invoke = async (method) => {
      assert.ok(['getSetupStatus', 'checkSetup'].includes(method), 'Read-only operation required')
      const result = await page.evaluate(async (method) => window.api.subtitles[method](), method)
      assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    await page.getByRole('link', { name: '자막 생성', exact: true }).click()
    const panel = page.getByRole('region', { name: '자막 환경 자동 설치', exact: true })
    await panel.waitFor()
    await panel.getByRole('listitem').first().waitFor()
    assert.equal(await panel.getByRole('listitem').count(), componentIds.length)
    assert.match(await panel.innerText(), /15GB/)
    assert.match(await panel.innerText(), /관리자 승인/)
    const initial = await invoke('getSetupStatus')
    assert.equal(initial.phase, 'idle', 'Fresh app data must start without a running installer')
    const started = await invoke('checkSetup')
    assert.ok(['checking', 'ready'].includes(started.phase), JSON.stringify(started))

    let status = started
    const deadline = Date.now() + 120_000
    while (['checking', 'installing'].includes(status.phase) && Date.now() < deadline) {
      await pause(250)
      status = await invoke('getSetupStatus')
    }
    const reportPath = path.join(output, 'subtitle-environment-packaged.json')
    const report = {
      packaged: !!executablePath,
      temporary,
      checkedThroughPreload: true,
      installationStarted: false,
      status,
      rendererErrors,
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    assert.equal(status.phase, 'ready', `Current machine must be ready: ${JSON.stringify(status)}`)
    assert.deepEqual(
      status.components.map((component) => component.id).sort(),
      [...componentIds].sort(),
    )
    assert.ok(
      status.components.every((component) => component.state === 'ready'),
      JSON.stringify(status),
    )
    // Reopen to load the final service snapshot even if the read-only check finished
    // between the queue page's initial snapshot and its next poll.
    await page.getByRole('link', { name: '라이브러리', exact: true }).click()
    await page.getByRole('link', { name: '자막 생성', exact: true }).click()
    await waitUntil(() => {
      const panel = document.querySelector('section[aria-label="자막 환경 자동 설치"]')
      return (
        panel?.textContent.includes('사용 준비 완료') &&
        panel.querySelectorAll('li').length === 6 &&
        [...panel.querySelectorAll('li')].every((row) => row.textContent.includes('준비됨'))
      )
    }, 'all six ready components render')
    assert.equal(
      await panel.getByRole('button', { name: '환경 다시 확인', exact: true }).isEnabled(),
      true,
    )
    assert.equal(await panel.getByRole('button', { name: '설치 취소', exact: true }).count(), 0)
    assert.deepEqual(rendererErrors, [])
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
    const screenshotPath = path.join(output, 'subtitle-environment-packaged.png')
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
    Object.assign(report, {
      passed: [
        'fresh isolated user data and hidden window verified',
        'global subtitle environment UI renders without opening a library',
        'real preload read-only check confirms all six installed components',
        'final ready state renders without renderer errors or installation',
      ],
      screenshotPath,
    })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    let closeTimeout
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          closeTimeout = setTimeout(
            () => reject(new Error('Isolated smoke app did not close')),
            30_000,
          )
        }),
      ])
    } finally {
      clearTimeout(closeTimeout)
      // Only terminate the exact child this script launched; never touch another app instance.
      if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill()
    }
  }
}

main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
