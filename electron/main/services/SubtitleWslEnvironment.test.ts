import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
import {
  ensureSubtitleWslUser,
  installSubtitleWsl,
  hasSubtitleWslInstall,
  subtitleDistribution,
  subtitleWslArgs,
  type WslCapture,
} from './SubtitleWslEnvironment'

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'dvm-wsl-bindings-'))
  vi.stubEnv('DVM_WSL_DISTRO', 'Ubuntu-24.04')
})
afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const result = (output = '', code = 0) => ({ output, code })
const signal = () => new AbortController().signal

const installFile = () => join(state.userData, 'subtitle-wsl-install.json')
const decode = (args: string[]) => Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
function pendingRecord(overrides: Record<string, unknown> = {}) {
  const record = {
    version: 1,
    token: '09a0e254-dc51-4bdd-acd3-173902c48b3f',
    operation: 'platform',
    distribution: 'Ubuntu-24.04',
    createdAt: Date.now(),
    state: 'running',
    helperPid: 444,
    helperStart: '639010000000000001',
    ...overrides,
  }
  writeFileSync(installFile(), JSON.stringify(record))
  return record
}
function completeRecord(code = 0, restartRequired = false) {
  const record = JSON.parse(readFileSync(installFile(), 'utf8'))
  writeFileSync(installFile(), JSON.stringify({ ...record, state: 'done', code, restartRequired }))
}
function installerCapture(options: { platform?: boolean; code?: number; restart?: boolean } = {}) {
  const helpers: string[] = []
  const launchers: string[] = []
  let ready = options.platform ?? false
  const capture = vi.fn<WslCapture>(async (command, args) => {
    if (command === 'wsl.exe') {
      if (args[0] === '--list') return result('')
      if (args[0] === '--status') return result('', ready ? 0 : 1)
    }
    if (command === 'powershell.exe' && decode(args).includes('DVM_INSTALL_STARTED')) {
      const record = JSON.parse(readFileSync(installFile(), 'utf8'))
      helpers.push(
        readFileSync(join(state.userData, `subtitle-wsl-install-${record.token}.ps1`), 'utf8'),
      )
      launchers.push(decode(args))
      completeRecord(options.code, options.restart)
      ready = true
      return result('DVM_INSTALL_STARTED')
    }
    if (command === 'powershell.exe') return result('DVM_INSTALL_FINISHED')
    throw new Error('Unexpected capture call')
  })
  return { capture, helpers, launchers }
}

describe('subtitle WSL installation on a fresh Windows account', () => {
  it('uses official web downloads, elevating only the platform and preserving the distro Windows user', async () => {
    const { capture, helpers, launchers } = installerCapture()
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(helpers).toHaveLength(2)
    expect(helpers[0]).toContain("@('--install','--no-distribution','--web-download')")
    expect(helpers[0]).toContain('-Verb RunAs')
    expect(helpers[0]).not.toContain("'--distribution'")
    expect(helpers[1]).toContain(
      "@('--install','--distribution','Ubuntu-24.04','--no-launch','--web-download')",
    )
    expect(helpers[1]).not.toContain('-Verb RunAs')
    expect(launchers.every((script) => !script.includes('-Verb RunAs'))).toBe(true)
    expect(capture.mock.calls.every((call) => call[3] === undefined)).toBe(true)
    expect(hasSubtitleWslInstall()).toBe(false)
  })

  it.each([3010, 1641])(
    'waits for restart (%i) before attempting distro installation',
    async (code) => {
      const { capture, helpers } = installerCapture({ code })
      expect(await installSubtitleWsl(capture)).toBe(true)
      expect(helpers).toHaveLength(1)
    },
  )

  it('treats pending Windows feature restart as restart-required even after exit zero', async () => {
    const { capture, helpers } = installerCapture({ restart: true })
    expect(await installSubtitleWsl(capture)).toBe(true)
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).toContain('Component Based Servicing')
  })

  it('continues after reboot without elevation when the platform is ready', async () => {
    const { capture, helpers } = installerCapture({ platform: true })
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).not.toContain('-Verb RunAs')
  })

  it('does not repeat installation of a registered distro without a pending operation', async () => {
    const capture = vi.fn<WslCapture>().mockResolvedValue(result('Debian\r\nUbuntu-24.04\r\n'))
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('removes a confirmed failed launch so declined elevation can be retried', async () => {
    const failed = installerCapture({ code: 1 })
    await expect(installSubtitleWsl(failed.capture)).rejects.toThrow('권한')
    expect(failed.helpers).toHaveLength(1)
    expect(hasSubtitleWslInstall()).toBe(false)
    const retry = installerCapture()
    expect(await installSubtitleWsl(retry.capture)).toBe(false)
  })

  it('reports distro download failures instead of requesting repeated restarts', async () => {
    const { capture } = installerCapture({ platform: true, code: 1 })
    await expect(installSubtitleWsl(capture)).rejects.toThrow('인터넷')
  })

  it('keeps a still-running installer after a bounded wait and reconnects on retry before checking distros', async () => {
    vi.useFakeTimers()
    pendingRecord()
    const progress = vi.fn()
    const capture = vi.fn<WslCapture>().mockResolvedValue(result('DVM_INSTALL_RUNNING'))
    const first = expect(installSubtitleWsl(capture, progress)).rejects.toThrow('아직 진행 중')
    await vi.advanceTimersByTimeAsync(45 * 60_000)
    await first
    expect(hasSubtitleWslInstall()).toBe(true)
    expect(progress.mock.calls.length).toBeGreaterThan(2)
    expect(
      capture.mock.calls.every(
        ([command, args]) =>
          command === 'powershell.exe' && !decode(args).includes('Start-Process'),
      ),
    ).toBe(true)
    capture.mockImplementation(async (command) => {
      if (command === 'powershell.exe') {
        completeRecord()
        return result('DVM_INSTALL_STOPPED')
      }
      return result('Ubuntu-24.04')
    })
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(hasSubtitleWslInstall()).toBe(false)
  })

  it('blocks unknown or reused process identity in the same boot before any distro probe', async () => {
    pendingRecord()
    const capture = vi.fn<WslCapture>().mockResolvedValue(result('DVM_INSTALL_STOPPED'))
    await expect(installSubtitleWsl(capture)).rejects.toThrow('설치가 끝났는지 확인')
    expect(capture).toHaveBeenCalledOnce()
    expect(decode(capture.mock.calls[0][1])).toContain("Is-Running 444 '639010000000000001'")
    expect(decode(capture.mock.calls[0][1])).toContain(
      'StartTime.ToUniversalTime().Ticks.ToString() -eq $started',
    )
    expect(hasSubtitleWslInstall()).toBe(true)
  })

  it('fails closed for a launcher/report crash and recovers only after a verified later boot', async () => {
    pendingRecord({ state: 'starting', helperPid: undefined, helperStart: undefined })
    const capture = vi.fn<WslCapture>().mockResolvedValueOnce(result('DVM_INSTALL_STOPPED'))
    await expect(installSubtitleWsl(capture)).rejects.toThrow('중단하지 마세요')
    capture
      .mockResolvedValueOnce(result('DVM_INSTALL_REBOOTED'))
      .mockResolvedValueOnce(result('Ubuntu-24.04'))
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(hasSubtitleWslInstall()).toBe(false)
  })

  it('does not request another reboot for a completed receipt from before the last reboot', async () => {
    pendingRecord({ state: 'done', code: 3010, restartRequired: true })
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValueOnce(result('DVM_INSTALL_REBOOTED'))
      .mockResolvedValueOnce(result('Ubuntu-24.04'))
    expect(await installSubtitleWsl(capture)).toBe(false)
    expect(hasSubtitleWslInstall()).toBe(false)
  })

  it('accepts confirmed completion even if the helper exits during its identity probe', async () => {
    pendingRecord()
    const capture = vi.fn<WslCapture>().mockImplementation(async (command) => {
      if (command === 'powershell.exe') {
        completeRecord()
        return result('query raced with exit', 1)
      }
      return result('Ubuntu-24.04')
    })
    expect(await installSubtitleWsl(capture)).toBe(false)
  })

  it('lets app shutdown stop only monitoring while preserving the installer reservation', async () => {
    pendingRecord()
    const controller = new AbortController()
    const capture = vi.fn<WslCapture>().mockResolvedValue(result('DVM_INSTALL_RUNNING'))
    const progress = vi.fn(() => controller.abort(new Error('app shutdown')))
    await expect(installSubtitleWsl(capture, progress, controller.signal)).rejects.toThrow(
      'app shutdown',
    )
    expect(hasSubtitleWslInstall()).toBe(true)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('rejects invalid process identities without interpolating them into a command', async () => {
    pendingRecord({ helperStart: "1'; Start-Process anything" })
    const capture = vi.fn<WslCapture>()
    await expect(installSubtitleWsl(capture)).rejects.toThrow('기록')
    expect(capture).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32').each([
    { operation: 'platform', code: 3010, denyHandle: true },
    { operation: 'distribution', code: 3010, denyHandle: false },
    { operation: 'distribution', code: 0, denyHandle: false },
    { operation: 'distribution', code: 0, denyHandle: true },
  ])(
    'runs the generated $operation helper with a harmless child exiting $code (handle denied: $denyHandle)',
    async ({ operation, code, denyHandle }) => {
      let actualLauncher = ''
      let actualHelper = ''
      const capture = vi.fn<WslCapture>(async (command, args) => {
        // Never execute host WSL. A ready platform selects the redirected distro branch.
        if (command === 'wsl.exe')
          return result('', operation === 'distribution' && args[0] === '--status' ? 0 : 1)
        const script = decode(args)
        if (script.includes('DVM_INSTALL_STARTED')) {
          actualLauncher = script
          const record = JSON.parse(readFileSync(installFile(), 'utf8'))
          const file = join(state.userData, `subtitle-wsl-install-${record.token}.ps1`)
          actualHelper = readFileSync(file, 'utf8')
          const start = actualHelper
            .split('\n')
            .filter((line) => line.includes('$installer=Start-Process'))
          expect(start).toHaveLength(1)
          expect(record.operation).toBe(operation)
          if (operation === 'platform') {
            expect(start[0]).toContain("@('--install','--no-distribution','--web-download')")
            expect(start[0]).toContain('-Verb RunAs')
          } else {
            expect(start[0]).toContain(
              "@('--install','--distribution','Ubuntu-24.04','--no-launch','--web-download')",
            )
            expect(start[0]).toContain(
              '-RedirectStandardOutput $outputPath -RedirectStandardError $errorPath',
            )
            expect(start[0]).not.toContain('-Verb RunAs')
          }
          let safe = actualHelper.replace(
            start[0],
            `  $installer=Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Milliseconds 300; exit ${code}') -WindowStyle Hidden -PassThru ${operation === 'distribution' ? '-RedirectStandardOutput $outputPath -RedirectStandardError $errorPath' : ''}`,
          )
          if (denyHandle) {
            const handle = 'try { $null=$installer.Handle } catch {}'
            expect(safe).toContain(handle)
            safe = safe.replace(handle, "try { throw 'simulated handle access denial' } catch {}")
          }
          const metadata =
            'try { $record | Add-Member -Force NoteProperty installerStart ($installer.StartTime.ToUniversalTime().Ticks.ToString()) } catch {}'
          expect(safe).toContain(metadata)
          safe = safe.replace(
            metadata,
            "try { throw 'simulated elevated metadata access denial' } catch {}",
          )
          expect(safe).toContain('try { Save-Record } catch {}')
          safe = safe.replace(
            'try { Save-Record } catch {}',
            // Let the redirected child exit before WaitForExit; PS5.1 must retain its exit code.
            "Start-Sleep -Seconds 2; try { throw 'simulated intermediate record write failure' } catch {}",
          )
          expect(safe).toContain('$installer.WaitForExit()')
          safe = safe.replace(
            '$installer.WaitForExit()',
            "$installer.WaitForExit(); [IO.File]::WriteAllText($recordPath+'.waited','done')",
          )
          const rebootCheck =
            "Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'"
          expect(safe).toContain(rebootCheck)
          safe = safe.replace(rebootCheck, '$false') // Isolate the dummy exit from host servicing.
          expect(safe).not.toContain('wsl.exe')
          expect(safe).not.toContain('-Verb RunAs')
          expect(script).not.toContain('-Verb RunAs')
          expect(args.join(' ').length).toBeLessThan(30_000)
          writeFileSync(file, safe)
        }
        const output = execFileSync(command, args, {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15_000,
        })
        return result(output)
      })
      if (denyHandle && operation === 'distribution') {
        await expect(installSubtitleWsl(capture)).rejects.toThrow('설치가 끝났는지 확인')
        expect(hasSubtitleWslInstall()).toBe(true)
        const receipt = JSON.parse(readFileSync(installFile(), 'utf8'))
        expect(receipt.state).toBe('running')
        expect(receipt.code).toBeUndefined()
        const launchCount = () =>
          capture.mock.calls.filter(
            ([command, args]) =>
              command === 'powershell.exe' && decode(args).includes('DVM_INSTALL_STARTED'),
          ).length
        expect(launchCount()).toBe(1)
        await expect(installSubtitleWsl(capture)).rejects.toThrow('설치가 끝났는지 확인')
        expect(launchCount()).toBe(1)
      } else {
        expect(await installSubtitleWsl(capture)).toBe(code === 3010)
        expect(hasSubtitleWslInstall()).toBe(false)
      }
      expect(readFileSync(installFile() + '.waited', 'utf8')).toBe('done')
      for (const [index, source] of [actualHelper, actualLauncher].entries()) {
        const file = join(state.userData, `parse-${index}.ps1`)
        writeFileSync(file, source)
        const parse = `$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }`
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')],
          { windowsHide: true, timeout: 15_000 },
        )
      }
    },
    40_000,
  )
})

describe('stable Linux account for subtitle workers', () => {
  it('uses an existing nonroot default user without creating accounts or settings', async () => {
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValue(result('DVM_UID=1000\nWSL startup warning'))
    await ensureSubtitleWslUser(capture, signal())
    expect(capture).toHaveBeenCalledOnce()
    expect(subtitleWslArgs()).toEqual(['--distribution', 'Ubuntu-24.04', '--exec'])
    expect(existsSync(join(state.userData, 'subtitle-environment.json'))).toBe(false)
  })

  it('creates and persists a dedicated locked system account before installing into a first-run root HOME', async () => {
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValueOnce(result('DVM_UID=0'))
      .mockResolvedValueOnce(result('DVM_SUBTITLE_USER_READY'))
    await ensureSubtitleWslUser(capture, signal())
    expect(capture.mock.calls[1][1].slice(0, 7)).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--user',
      'root',
      '--exec',
      'sh',
      '-c',
    ])
    const script = capture.mock.calls[1][1].at(-1)!
    expect(script).toContain('useradd --system --user-group --create-home')
    expect(script).toContain('passwd -l')
    expect(script).not.toContain('/etc/wsl.conf')
    expect(
      JSON.parse(readFileSync(join(state.userData, 'subtitle-environment.json'), 'utf8')),
    ).toEqual({ version: 1, managedDistributions: ['Ubuntu-24.04'] })
    expect(subtitleWslArgs()).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--user',
      'dvm-subtitles',
      '--exec',
    ])
  })

  it('keeps the managed account after Ubuntu OOBE changes its default user and repairs a reinstalled distro', async () => {
    writeFileSync(
      join(state.userData, 'subtitle-environment.json'),
      JSON.stringify({ version: 1, managedDistributions: ['Ubuntu-24.04'] }),
    )
    const capture = vi.fn<WslCapture>().mockResolvedValue(result('DVM_SUBTITLE_USER_READY'))
    await ensureSubtitleWslUser(capture, signal())
    expect(capture).toHaveBeenCalledOnce()
    expect(capture.mock.calls[0][1]).toContain('root')
    expect(subtitleWslArgs()).toContain('dvm-subtitles')
    expect(subtitleWslArgs('default')).not.toContain('--user')
  })

  it('does not bind workers to an uncreated or conflicting account', async () => {
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValueOnce(result('DVM_UID=0'))
      .mockResolvedValueOnce(result('DVM_USER_CONFLICT', 1))
    await expect(ensureSubtitleWslUser(capture, signal())).rejects.toThrow('준비하지 못했습니다')
    expect(subtitleWslArgs()).not.toContain('--user')
  })

  it('does not apply one distro binding to an unrelated existing distro', () => {
    writeFileSync(
      join(state.userData, 'subtitle-environment.json'),
      JSON.stringify({ version: 1, managedDistributions: ['Ubuntu-24.04'] }),
    )
    vi.stubEnv('DVM_WSL_DISTRO', 'Ubuntu-Test')
    expect(subtitleWslArgs()).toEqual(['--distribution', 'Ubuntu-Test', '--exec'])
  })

  it('rejects malformed persisted settings rather than silently using a different HOME', () => {
    writeFileSync(join(state.userData, 'subtitle-environment.json'), '{broken')
    expect(() => subtitleWslArgs()).toThrow('설정')
    vi.stubEnv('DVM_WSL_DISTRO', "Ubuntu';whoami")
    expect(() => subtitleDistribution()).toThrow('이름')
  })
})
