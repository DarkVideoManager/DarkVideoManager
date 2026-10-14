// REAL installation test. Run only inside the disposable Hyper-V guest provisioned for this test.
// The host must never set DVM_FRESH_VM_TEST or run this script to test an installed workstation.
// Guest: set DVM_FRESH_VM_TEST=1 and ELECTRON_RUN_AS_NODE=1, then use the packaged app as Node.
// Modes: baseline (read-only, no Electron/IPC), install (may return 10 for reboot), verify (read-only).
// The host orchestrator, not this script, handles elevation and guest restarts.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const guestRoot = 'C:\\DVMTest'
const executablePath = path.join(guestRoot, 'app', 'DarkVideoManager.exe')
const expectedHostname = 'DVM-WSL-TEST'
const mode = process.argv[2] || 'baseline'
const output = path.join(guestRoot, 'results')
const baselinePath = path.join(output, 'baseline.json')
const components = ['whisper', 'speechModel', 'wsl', 'python', 'ollama', 'translationModel']
const runningPhases = new Set(['checking', 'installing'])
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

function writeJson(file, value) {
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

async function command(file, args, timeout = 60_000) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(file, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WSL_UTF8: '1' },
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    const finish = (exitCode, errorCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, errorCode, timedOut, stdout, stderr })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2 * 1024 * 1024)
    })
    child.on('error', (error) => finish(null, error.code || 'SPAWN_ERROR'))
    child.on('close', (code) => finish(code))
    child.stdin.on('error', () => {})
    child.stdin.end()
  })
}

async function powershell(script) {
  const result = await command(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = "Stop"; ' +
        script,
    ],
  )
  assert.equal(
    result.exitCode,
    0,
    `Read-only guest inspection failed (exit ${result.exitCode}, ${result.errorCode || 'no spawn error'}, timeout ${result.timedOut})`,
  )
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}

async function guardGuest() {
  // Refuse before creating directories, loading Playwright, or starting the application.
  assert.equal(process.platform, 'win32', 'Only the isolated Windows guest is supported')
  assert.equal(process.env.DVM_FRESH_VM_TEST, '1', 'Missing explicit fresh-guest test flag')
  assert.equal(
    os.hostname().toUpperCase(),
    expectedHostname,
    'Refusing to run outside the dedicated guest computer',
  )
  assert.ok(
    ['baseline', 'install', 'verify'].includes(mode),
    'Expected baseline, install, or verify mode',
  )
  const marker = readJson(path.join(guestRoot, 'fresh-vm.json'))
  const vmName = marker.vmName || marker.VMName
  assert.equal(typeof vmName, 'string', 'Missing VM name in test marker')
  assert.match(vmName, /^DVM-Fresh-WSL-/i, 'Marker does not identify a disposable fresh-WSL VM')
  const identity = await powershell(`
    $computer = Get-CimInstance Win32_ComputerSystem;
    $osInfo = Get-CimInstance Win32_OperatingSystem;
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent();
    $principal = New-Object Security.Principal.WindowsPrincipal($identity);
    $version = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
    [pscustomobject]@{
      computerName = $env:COMPUTERNAME;
      model = $computer.Model;
      manufacturer = $computer.Manufacturer;
      osCaption = $osInfo.Caption;
      osVersion = $osInfo.Version;
      osBuild = $osInfo.BuildNumber;
      revision = $version.UBR;
      displayVersion = $version.DisplayVersion;
      userSid = $identity.User.Value;
      elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } | ConvertTo-Json -Compress
  `)
  assert.equal(identity.computerName.toUpperCase(), expectedHostname, 'CIM guest hostname mismatch')
  assert.equal(identity.model, 'Virtual Machine', 'Computer is not a Hyper-V virtual machine')
  assert.equal(
    identity.manufacturer,
    'Microsoft Corporation',
    'Unexpected virtual-machine manufacturer',
  )
  assert.equal(
    identity.elevated,
    true,
    'The guest orchestrator must launch this test with an elevated token',
  )
  return { vmName, ...identity }
}

async function inspectFreshBaseline(identity) {
  const inspection = await powershell(`
    $names = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform');
    $features = @($names | ForEach-Object {
      $feature = Get-WindowsOptionalFeature -Online -FeatureName $_;
      [pscustomobject]@{ name = $feature.FeatureName; state = $feature.State.ToString() }
    });
    $registered = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue |
      Where-Object { $_.PSChildName -match '^\\{' });
    [pscustomobject]@{ features = $features; registeredDistributions = $registered.Count } | ConvertTo-Json -Depth 5 -Compress
  `)
  const wsl = await command('wsl.exe', ['--list', '--quiet'], 30_000)
  const distroOutput = wsl.stdout.replaceAll('\0', '').trim()
  const baseline = {
    recordedAt: new Date().toISOString(),
    identity,
    ...inspection,
    wslList: {
      exitCode: wsl.exitCode,
      errorCode: wsl.errorCode,
      timedOut: wsl.timedOut,
      successfulEmptyList: wsl.exitCode === 0 && distroOutput.length === 0,
      // A disabled Windows WSL launcher can fail instead of producing an empty list.
      // In that case, the two disabled features and empty registration key establish the baseline.
      outputPresent: distroOutput.length > 0,
    },
    noApplicationLaunched: true,
  }
  for (const feature of inspection.features) {
    assert.ok(
      ['Disabled', 'DisabledWithPayloadRemoved'].includes(feature.state),
      `${feature.name} is already ${feature.state}; guest is not fresh`,
    )
  }
  assert.equal(inspection.features.length, 2, 'Both Windows optional features must be inspected')
  assert.equal(
    inspection.registeredDistributions,
    0,
    'A WSL distribution is already registered for this test user',
  )
  assert.ok(!wsl.timedOut, 'WSL list command did not finish; cannot establish fresh baseline')
  assert.ok(
    wsl.exitCode !== 0 || distroOutput.length === 0,
    'WSL list reported an existing distribution',
  )
  writeJson(baselinePath, baseline)
  return baseline
}

async function ensureBaseline(identity) {
  if (!fs.existsSync(baselinePath)) return inspectFreshBaseline(identity)
  const baseline = readJson(baselinePath)
  assert.equal(baseline.identity.vmName, identity.vmName, 'Baseline belongs to a different VM')
  assert.equal(
    baseline.identity.userSid,
    identity.userSid,
    'Use the same guest Windows account before and after reboot',
  )
  assert.equal(baseline.noApplicationLaunched, true, 'Missing pre-installation baseline evidence')
  assert.equal(
    baseline.registeredDistributions,
    0,
    'Baseline was not collected without WSL distributions',
  )
  assert.equal(baseline.features.length, 2, 'Baseline is incomplete')
  for (const feature of baseline.features) {
    assert.ok(
      ['Disabled', 'DisabledWithPayloadRemoved'].includes(feature.state),
      'Baseline optional features were enabled',
    )
  }
  return baseline
}

async function withTimeout(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runApplication(identity, baseline) {
  const { _electron: electron } = require('playwright')
  assert.ok(fs.existsSync(executablePath), 'Packaged guest application is missing')
  const rendererErrors = []
  const rendererConsoleErrors = []
  const report = {
    runId,
    mode,
    startedAt: new Date().toISOString(),
    identity,
    baselineAt: baseline.recordedAt,
    rendererErrors,
    rendererConsoleErrors,
    executionMode: process.env.DVM_FRESH_VM_INTERACTIVE === '1' ? 'interactive' : 'direct',
    completed: false,
  }
  const reportPath = path.join(output, `${runId}.json`)
  const progressPath = path.join(output, `${runId}.jsonl`)
  let app
  let page
  let lastStatus
  let lastSummary
  let exitCode = 1
  function record(event, value = {}) {
    const entry = { at: new Date().toISOString(), runId, mode, event, ...value }
    fs.appendFileSync(progressPath, `${JSON.stringify(entry)}\n`, 'utf8')
    writeJson(path.join(output, 'latest.json'), entry)
  }
  async function invoke(method) {
    const result = await withTimeout(
      page.evaluate(async (operation) => window.api.subtitles[operation](), method),
      30_000,
      `${method} did not respond`,
    )
    assert.equal(result.ok, true, `${method} failed: ${String(result.error)}`)
    return result.value
  }
  async function screenshot(label) {
    if (!page || page.isClosed()) return
    try {
      await page.screenshot({
        path: path.join(output, `${runId}-${label}.png`),
        fullPage: true,
        timeout: 15_000,
      })
    } catch (error) {
      record('screenshot-error', { message: error.message })
    }
  }
  try {
    record('starting', { identity })
    writeJson(reportPath, report)
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DVM_USER_DATA_DIR: path.join(guestRoot, 'appdata'),
      DVM_SMOKE_TEST: '1',
    }
    delete env.ELECTRON_RUN_AS_NODE
    // A fresh-machine check must use the program's normal distribution and runtime defaults.
    delete env.DVM_WSL_DISTRO
    delete env.DVM_WSL_USER
    app = await electron.launch({ executablePath, args: [], cwd: guestRoot, env, timeout: 90_000 })
    const appIdentity = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      version: app.getVersion(),
      packaged: app.isPackaged,
    }))
    assert.equal(
      path.resolve(appIdentity.userData).toLowerCase(),
      path.resolve(env.DVM_USER_DATA_DIR).toLowerCase(),
      'App did not honor the isolated guest data directory',
    )
    assert.equal(appIdentity.packaged, true, 'A real packaged app is required')
    report.application = appIdentity
    report.applicationProcessId = app.process().pid
    page = await app.firstWindow({ timeout: 60_000 })
    page.on('pageerror', (error) => {
      rendererErrors.push(error.message)
      record('renderer-error', { message: error.message })
    })
    page.on('crash', () => record('renderer-crashed'))
    app.on('close', () => record('application-closed'))
    page.on('console', (message) => {
      if (message.type() === 'error') rendererConsoleErrors.push(message.text())
    })
    if (process.env.DVM_FRESH_VM_INTERACTIVE === '1') {
      // Give Chromium a real guest desktop surface for screenshots. The host
      // desktop is never read or changed; this is the owned guest app window.
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.showInactive()
      })
    }
    writeJson(reportPath, report)
    await page.getByRole('link', { name: '자막 생성', exact: true }).click({ timeout: 60_000 })
    const panel = page.getByRole('region', { name: '자막 환경 자동 설치', exact: true })
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    await screenshot('before')
    // Use the real UI and preload. No route interception, injected mocks, or replaced API methods.
    const buttonName = mode === 'install' ? '자막 환경 자동 설치' : '환경 다시 확인'
    await panel.getByRole('button', { name: buttonName, exact: true }).click({ timeout: 30_000 })
    record('clicked', { buttonName, application: appIdentity })
    const deadline = Date.now() + (mode === 'install' ? 6 * 60 * 60_000 : 10 * 60_000)
    let observedStarted = false
    while (Date.now() < deadline) {
      lastStatus = await invoke('getSetupStatus')
      assert.ok(
        lastStatus && typeof lastStatus.phase === 'string' && Array.isArray(lastStatus.components),
        'Malformed real setup status',
      )
      record('progress', { status: lastStatus })
      const summary = JSON.stringify({
        phase: lastStatus.phase,
        components: lastStatus.components.map(({ id, state }) => ({ id, state })),
        message: lastStatus.message,
      })
      if (summary !== lastSummary) {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            phase: lastStatus.phase,
            message: lastStatus.message,
          }),
        )
        lastSummary = summary
      }
      observedStarted ||= runningPhases.has(lastStatus.phase) || lastStatus.phase !== 'idle'
      // A check can complete before the first read, leaving idle with missing components.
      const completedCheck =
        mode === 'verify' &&
        lastStatus.phase === 'idle' &&
        lastStatus.components.some((item) => item.state === 'missing')
      if (
        (observedStarted || completedCheck) &&
        !runningPhases.has(lastStatus.phase) &&
        lastStatus.canCancel === false
      )
        break
      await delay(1000)
    }
    assert.ok(
      lastStatus && !runningPhases.has(lastStatus.phase),
      'Timed out waiting for subtitle environment setup',
    )
    report.status = lastStatus
    writeJson(reportPath, report)
    if (lastStatus.phase === 'restart-required' && mode === 'install') {
      exitCode = 10
      report.outcome = 'restart-required'
    } else {
      assert.equal(
        lastStatus.phase,
        'ready',
        `Environment did not become ready: ${lastStatus.message}`,
      )
      assert.deepEqual(
        lastStatus.components.map((item) => item.id).sort(),
        [...components].sort(),
        'Expected all six environment components',
      )
      for (const component of lastStatus.components)
        assert.equal(component.state, 'ready', `${component.id} is not ready`)
      report.engine = await invoke('getEngineInfo')
      assert.equal(report.engine.available, true, report.engine.message)
      assert.deepEqual(rendererErrors, [], 'Renderer raised errors during the real installation')
      exitCode = 0
      report.outcome = 'ready'
    }
    report.exitCode = exitCode
    writeJson(reportPath, report)
    await screenshot('finished')
  } catch (error) {
    report.outcome = 'failed'
    report.error = { name: error.name, message: error.message, stack: error.stack }
    report.status = lastStatus
    report.exitCode = 1
    writeJson(reportPath, report)
    record('error', { error: report.error, status: lastStatus })
    await screenshot('error')
    console.error(error.message)
  } finally {
    if (app) {
      try {
        await withTimeout(app.close(), 60_000, 'Owned app did not close within 60 seconds')
      } catch (error) {
        report.closeError = error.message
        // Never enumerate or kill other app instances, WSL, or an optional-feature installer.
        const ownedProcess = app.process()
        if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) ownedProcess.kill()
      }
    }
    report.finishedAt = new Date().toISOString()
    report.exitCode = exitCode
    report.completed = true
    writeJson(reportPath, report)
    record('finished', {
      exitCode,
      outcome: report.outcome,
      report: reportPath,
      status: lastStatus,
    })
  }
  return exitCode
}

async function main() {
  const identity = await guardGuest()
  fs.mkdirSync(output, { recursive: true })
  if (mode === 'baseline') {
    assert.ok(
      !fs.existsSync(baselinePath),
      'Baseline already exists; do not replace pre-installation evidence',
    )
    const baseline = await inspectFreshBaseline(identity)
    console.log(JSON.stringify(baseline, null, 2))
    return 0
  }
  const baseline = await ensureBaseline(identity)
  return runApplication(identity, baseline)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    // No writes here: guard failure must leave the host untouched.
    console.error(`Fresh-Windows test refused or could not start: ${error.message}`)
    process.exitCode = 1
  })
