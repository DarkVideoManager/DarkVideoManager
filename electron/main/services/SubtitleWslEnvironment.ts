import { probeWslPrerequisites, requireWslVirtualization } from './SubtitleWslPrerequisites'
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface WslCommandResult {
  code: number
  output: string
}
export type WslCapture = (
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout?: number,
) => Promise<WslCommandResult>

const managedUser = 'dvm-subtitles'
const configName = 'subtitle-environment.json'
const installRecordName = 'subtitle-wsl-install.json'

interface InstallRecord {
  version: 1
  token: string
  operation: 'platform' | 'distribution'
  distribution: string
  createdAt: number
  state: 'starting' | 'running' | 'done'
  helperPid?: number
  helperStart?: string
  installerPid?: number
  installerStart?: string
  code?: number
  restartRequired?: boolean
  launchError?: number
  diagnostics?: string
}

const installStillRunning =
  'Windows 설치가 아직 진행 중입니다. 설치를 강제로 중단하지 않았습니다. 잠시 후 자동 설치를 다시 누르면 같은 설치의 진행 상태를 확인합니다.'
const installInterrupted =
  '이전 Windows 설치가 끝났는지 확인하지 못했습니다. Windows 설치가 끝났는지 확인한 뒤 PC를 다시 시작하고 자동 설치를 다시 눌러 주세요. 진행 중인 설치를 강제로 중단하지 마세요.'

const psString = (value: string): string => `'${value.replaceAll("'", "''")}'`
const psArgs = (script: string): string[] => [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
]

function installRecordPath(): string {
  return join(app.getPath('userData'), installRecordName)
}

function readInstallRecord(): InstallRecord | undefined {
  try {
    const source = readFileSync(installRecordPath(), 'utf8')
    if (source.length > 8192) throw new Error('oversized install record')
    const record = JSON.parse(source.replace(/^\uFEFF/, '')) as InstallRecord
    const identityValid = (pid: unknown, start: unknown): boolean =>
      pid === undefined
        ? start === undefined
        : Number.isSafeInteger(pid) &&
          Number(pid) > 0 &&
          (start === undefined || (typeof start === 'string' && /^\d{16,20}$/.test(start)))
    if (
      record.version !== 1 ||
      typeof record.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(record.token) ||
      !['platform', 'distribution'].includes(record.operation) ||
      typeof record.distribution !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(record.distribution) ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt <= 0 ||
      !['starting', 'running', 'done'].includes(record.state) ||
      !identityValid(record.helperPid, record.helperStart) ||
      !identityValid(record.installerPid, record.installerStart) ||
      (record.code !== undefined && !Number.isSafeInteger(record.code)) ||
      (record.restartRequired !== undefined && typeof record.restartRequired !== 'boolean') ||
      (record.launchError !== undefined && !Number.isSafeInteger(record.launchError)) ||
      (record.diagnostics !== undefined &&
        (typeof record.diagnostics !== 'string' || record.diagnostics.length > 2000)) ||
      (record.state === 'done' && record.code === undefined)
    )
      throw new Error('invalid install record')
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Windows 설치 진행 기록을 읽을 수 없습니다. 앱 데이터 폴더를 확인해 주세요.', {
      cause: error,
    })
  }
}

export function hasSubtitleWslInstall(): boolean {
  const record = readInstallRecord()
  // A helper can finish while the app is closed. Its successful receipt must not
  // hide an already working environment during a later read-only check.
  return (
    !!record && (record.state !== 'done' || record.code !== 0 || record.restartRequired === true)
  )
}

function installFailure(
  context: string,
  result: { code?: number; diagnostics?: string; launchError?: number },
): Error {
  const diagnostics = (result.diagnostics ?? '').replaceAll('\0', '').trim().slice(-1600)
  let message = `${context} 인터넷 연결과 Windows 업데이트 상태를 확인한 뒤 다시 시도해 주세요.`
  if (result.launchError === 1223 || result.code === 1223 || /0x800704c7/i.test(diagnostics))
    message =
      'Windows 권한 승인이 취소되었습니다. 자동 설치를 다시 누르고 권한 승인 창에서 허용해 주세요.'
  else if (/HCS_E_HYPERV_NOT_INSTALLED|0x80370102/i.test(diagnostics))
    message =
      'Windows 가상 머신을 시작하지 못했습니다. Windows의 가상 머신 플랫폼 기능, BIOS/UEFI의 CPU 가상화와 하이퍼바이저 부팅 시작 설정을 확인해 주세요. 가상 PC에서는 중첩 가상화도 필요합니다.'
  else if (
    /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|WSL_E_VIRTUAL_MACHINE_PLATFORM_REQUIRED|0x8007019e/i.test(
      diagnostics,
    )
  )
    message =
      'Windows의 WSL 또는 가상 머신 플랫폼 기능이 준비되지 않았습니다. Windows 기능과 업데이트 상태를 확인한 뒤 다시 시도해 주세요.'
  else if (result.launchError === 5 || /E_ACCESSDENIED|0x80070005/i.test(diagnostics))
    message =
      'Windows 설치 권한이 거부되었습니다. 권한 승인과 PC의 관리자 정책을 확인한 뒤 다시 시도해 주세요.'
  const code = result.launchError ?? result.code
  return new Error(
    `${message}${code === undefined ? '' : ` (오류 코드 ${code})`}${diagnostics ? `\n${diagnostics}` : ''}`,
  )
}

function writeInstallRecord(record: InstallRecord): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const temporary = `${installRecordPath()}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' })
  renameSync(temporary, installRecordPath())
}

function clearInstallRecord(record: InstallRecord): void {
  unlinkSync(installRecordPath())
  try {
    unlinkSync(join(app.getPath('userData'), `subtitle-wsl-install-${record.token}.ps1`))
  } catch {
    /* A completed helper may still be exiting. */
  }
}

/** The helper survives app shutdown; only it owns the uninterruptible installer. */
function installHelper(record: InstallRecord): string {
  const argumentsList =
    record.operation === 'platform'
      ? "@('--install','--no-distribution','--web-download')"
      : `@('--install','--distribution',${psString(record.distribution)},'--no-launch','--web-download')`
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$recordPath=${psString(installRecordPath())}
$token=${psString(record.token)}
function Save-Record {
  $current=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if ($current.token -ne $token) { throw 'Install record changed' }
  $temporary=$recordPath+'.'+[guid]::NewGuid().ToString()+'.tmp'
  [IO.File]::WriteAllText($temporary,($record | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($temporary,$recordPath,[NullString]::Value)
}
# Do not launch an installer until the launcher has durably recorded this helper.
$deadline=[DateTime]::UtcNow.AddSeconds(60)
do {
  $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if ($record.token -ne $token) { exit 1 }
  if ($record.helperPid -eq $PID) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($record.helperPid -ne $PID) { exit 1 }
$record | Add-Member -Force NoteProperty helperStart ((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString())
$record.state='running'
Save-Record
$finished=$false
$installer=$null
try {
  $outputPath=$recordPath+'.'+$token+'.out'
  $errorPath=$recordPath+'.'+$token+'.err'
  $installer=Start-Process -FilePath "$env:WINDIR\\System32\\wsl.exe" -ArgumentList ${argumentsList} -WindowStyle Hidden -PassThru ${record.operation === 'platform' ? '-Verb RunAs' : '-RedirectStandardOutput $outputPath -RedirectStandardError $errorPath'}
  # PowerShell 5.1 redirected processes can lose ExitCode unless their handle is
  # cached before exit. Access denial must still leave the child supervised.
  try { $null=$installer.Handle } catch {}
  $record | Add-Member -Force NoteProperty installerPid $installer.Id
  # Alternate admin credentials can deny StartTime access. The same-user helper
  # remains the primary identity; metadata failures must not stop its wait.
  try { $record | Add-Member -Force NoteProperty installerStart ($installer.StartTime.ToUniversalTime().Ticks.ToString()) } catch {}
  try { Save-Record } catch {}
  $installer.WaitForExit()
  if ($null -eq $installer.ExitCode) { throw 'Installer exit status unavailable' }
  $record | Add-Member -Force NoteProperty code ([int]$installer.ExitCode)
  $finished=$true
  $requiresRestart=($installer.ExitCode -eq 3010 -or $installer.ExitCode -eq 1641)
  $diagnostics=''
  foreach ($file in @($outputPath,$errorPath)) {
    if (Test-Path -LiteralPath $file) {
      $diagnostics+=((Get-Content -LiteralPath $file -Tail 12 -ErrorAction SilentlyContinue) -join "\n")+"\n"
    }
  }
  if ($diagnostics.Length -gt 2000) { $diagnostics=$diagnostics.Substring($diagnostics.Length-2000) }
  $record | Add-Member -Force NoteProperty diagnostics $diagnostics
  # Virtualization/feature error text alone does not prove a reboot is needed.
  if (($installer.ExitCode -eq 0) -and (Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')) { $requiresRestart=$true }
  $record | Add-Member -Force NoteProperty restartRequired $requiresRestart
} catch {
  # Only a launch failure is known to leave no installer. After launch, preserve
  # the reservation if tracking fails: servicing may still be changing Windows.
  if ($null -eq $installer) {
    $record | Add-Member -Force NoteProperty code 1
    $record | Add-Member -Force NoteProperty restartRequired $false
    $exception=$_.Exception
    $diagnostics=$exception.Message
    while ($null -ne $exception) {
      if ($exception -is [ComponentModel.Win32Exception]) { $record | Add-Member -Force NoteProperty launchError $exception.NativeErrorCode; break }
      $exception=$exception.InnerException
    }
    if ($diagnostics.Length -gt 2000) { $diagnostics=$diagnostics.Substring($diagnostics.Length-2000) }
    $record | Add-Member -Force NoteProperty diagnostics $diagnostics
    $finished=$true
  }
} finally {
  if ($finished) {
    foreach ($file in @($outputPath,$errorPath)) {
      if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    }
    $record.state='done'
    Save-Record
  }
}`
}

async function launchInstall(
  capture: WslCapture,
  operation: InstallRecord['operation'],
): Promise<void> {
  const record: InstallRecord = {
    version: 1,
    token: randomUUID(),
    operation,
    distribution: subtitleDistribution(),
    createdAt: Date.now(),
    state: 'starting',
  }
  writeInstallRecord(record)
  // A nested EncodedCommand can exceed Windows' 32,767-character command limit.
  // This helper runs as the app user; only its fixed wsl.exe platform call elevates.
  const helperPath = join(app.getPath('userData'), `subtitle-wsl-install-${record.token}.ps1`)
  writeFileSync(helperPath, '\uFEFF' + installHelper(record), { flag: 'wx' })
  const launcher = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$recordPath=${psString(installRecordPath())}
$helper=Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psString('"' + helperPath + '"')}) -WindowStyle Hidden -PassThru
$record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
if ($record.token -ne ${psString(record.token)}) { throw 'Install record changed' }
$record | Add-Member -Force NoteProperty helperPid $helper.Id
$record | Add-Member -Force NoteProperty helperStart ($helper.StartTime.ToUniversalTime().Ticks.ToString())
$temporary=$recordPath+'.'+[guid]::NewGuid().ToString()+'.tmp'
[IO.File]::WriteAllText($temporary,($record | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
[IO.File]::Replace($temporary,$recordPath,[NullString]::Value)
Write-Output 'DVM_INSTALL_STARTED'`
  const launched = await capture('powershell.exe', psArgs(launcher)).catch(() => {
    throw new Error(installInterrupted)
  })
  if (launched.code !== 0 || !launched.output.includes('DVM_INSTALL_STARTED'))
    throw new Error(installInterrupted)
}

async function waitForInstall(
  capture: WslCapture,
  progress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<InstallRecord | undefined> {
  let lastProgress = 0
  for (;;) {
    signal?.throwIfAborted()
    const record = readInstallRecord()
    if (!record) return undefined
    if (Date.now() - lastProgress >= 30_000) {
      lastProgress = Date.now()
      const minutes = Math.max(0, Math.floor((Date.now() - record.createdAt) / 60_000))
      const stage = record.installerPid
        ? 'Windows 설치 도구가 실행 중입니다.'
        : 'Windows 설치 도구를 시작하고 있습니다. 권한 승인 창이 있으면 확인해 주세요.'
      progress?.(
        `${stage} 경과 ${minutes}분. 앱을 종료해도 Windows 설치는 계속되며 다시 실행한 뒤 자동 설치를 누르면 진행 상태를 확인합니다.`,
      )
    }
    // PID alone is never sufficient: reject PID reuse, and allow recovery after reboot.
    const identity = await capture(
      'powershell.exe',
      psArgs(`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
if (([DateTimeOffset]$boot).ToUnixTimeMilliseconds() -gt ${record.createdAt}) { Write-Output 'DVM_INSTALL_REBOOTED'; exit 0 }
function Is-Running([int]$processId,[string]$started) {
  $process=Get-Process -Id $processId -ErrorAction SilentlyContinue
  return ($null -ne $process -and $started -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $started)
}
if (${record.state === 'done' ? '$true' : '$false'}) { Write-Output 'DVM_INSTALL_FINISHED'; exit 0 }
if (${record.helperPid ? `(Is-Running ${record.helperPid} ${psString(record.helperStart ?? '')})` : '$false'} -or ${record.installerPid ? `(Is-Running ${record.installerPid} ${psString(record.installerStart ?? '')})` : '$false'}) { Write-Output 'DVM_INSTALL_RUNNING' }
else { Write-Output 'DVM_INSTALL_STOPPED' }`),
      signal,
    ).catch(() => {
      signal?.throwIfAborted()
      return { code: 1, output: '' }
    })
    if (identity.code === 0 && identity.output.includes('DVM_INSTALL_REBOOTED')) {
      clearInstallRecord(record)
      return undefined
    }
    // The helper may have written completion while its identity was being probed.
    const completed = readInstallRecord()
    if (completed?.state === 'done') {
      // A restart-required receipt remains the gate for later checks/retries.
      // Only the verified later-boot branch above may discard it.
      if (!completed.restartRequired && ![3010, 1641].includes(completed.code ?? -1))
        clearInstallRecord(completed)
      return completed
    }
    if (identity.code !== 0) throw new Error(installInterrupted)
    if (!identity.output.includes('DVM_INSTALL_RUNNING')) throw new Error(installInterrupted)
    // Retrying attaches to the same installer; it must not reset the wait budget.
    if (Date.now() - record.createdAt >= 45 * 60_000) throw new Error(installStillRunning)
    await new Promise<void>((resolve) => {
      const finished = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finished)
        resolve()
      }
      const timer = setTimeout(finished, 10_000)
      signal?.addEventListener('abort', finished, { once: true })
      if (signal?.aborted) finished()
    })
  }
}

export function subtitleDistribution(): string {
  const value = process.env.DVM_WSL_DISTRO || 'Ubuntu-24.04'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value))
    throw new Error('자막 실행 환경의 배포판 이름이 올바르지 않습니다.')
  return value
}

function bindings(): string[] {
  try {
    const value = JSON.parse(readFileSync(join(app.getPath('userData'), configName), 'utf8'))
    if (
      value?.version !== 1 ||
      !Array.isArray(value.managedDistributions) ||
      value.managedDistributions.length > 128 ||
      !value.managedDistributions.every(
        (name: unknown) =>
          typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name),
      )
    )
      throw new Error('invalid subtitle environment settings')
    return value.managedDistributions
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('저장된 자막 실행 환경 설정을 읽을 수 없습니다.', { cause: error })
  }
}

function saveBinding(distribution: string): void {
  const directory = app.getPath('userData')
  const managedDistributions = [...new Set([...bindings(), distribution])]
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `${configName}.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify({ version: 1, managedDistributions }), { flag: 'wx' })
  renameSync(temporary, join(directory, configName))
}

/** All subtitle processes must use the same Linux HOME, even after Ubuntu OOBE. */
export function subtitleWslArgs(user: 'configured' | 'default' | 'root' = 'configured'): string[] {
  const distribution = subtitleDistribution()
  const account =
    user === 'root'
      ? 'root'
      : user === 'configured' && bindings().includes(distribution)
        ? managedUser
        : undefined
  return ['--distribution', distribution, ...(account ? ['--user', account] : []), '--exec']
}

// A system account is independent of Ubuntu's future interactive/default user.
// The root-owned marker allows safe retry if Windows exits before saving its binding.
const createManagedUser = `set -eu
name=dvm-subtitles
base=/var/lib/dark-video-manager
home=$base/user
marker=$base/subtitle-user
if id -u "$name" >/dev/null 2>&1; then
  [ -f "$marker" ] && [ "$(cat "$marker")" = "$name" ] || { echo 'DVM_USER_CONFLICT'; exit 1; }
else
  mkdir -p "$base"
  chmod 755 "$base"
  printf '%s\\n' "$name" > "$marker"
  chmod 644 "$marker"
  useradd --system --user-group --create-home --home-dir "$home" --shell /usr/sbin/nologin "$name"
fi
[ "$(getent passwd "$name" | cut -d: -f6)" = "$home" ] || { echo 'DVM_HOME_CONFLICT'; exit 1; }
uid=$(id -u "$name")
[ "$uid" -gt 0 ] && [ "$uid" -lt 1000 ] || { echo 'DVM_UID_CONFLICT'; exit 1; }
passwd -l "$name" >/dev/null
printf 'DVM_SUBTITLE_USER_READY\\n'`

export async function ensureSubtitleWslUser(
  capture: WslCapture,
  signal: AbortSignal,
): Promise<void> {
  const distribution = subtitleDistribution()
  if (!bindings().includes(distribution)) {
    const identity = await capture(
      'wsl.exe',
      [...subtitleWslArgs('default'), 'sh', '-c', 'printf "DVM_UID="; id -u'],
      signal,
    )
    const uid = identity.output.match(/^DVM_UID=(\d+)\s*$/m)?.[1]
    if (identity.code !== 0 || uid === undefined)
      throw new Error('Windows 자막 환경의 사용자 정보를 확인하지 못했습니다.')
    // An existing, initialized user environment continues using its original HOME.
    if (Number(uid) !== 0) return
  }
  const result = await capture(
    'wsl.exe',
    [...subtitleWslArgs('root'), 'sh', '-c', createManagedUser],
    signal,
  )
  signal.throwIfAborted()
  if (result.code !== 0 || !result.output.includes('DVM_SUBTITLE_USER_READY'))
    throw new Error(
      '앱 전용 자막 사용자를 준비하지 못했습니다. Ubuntu 사용자와 저장 공간을 확인해 주세요.',
    )
  if (!bindings().includes(distribution)) saveBinding(distribution)
}

async function wslStartup(capture: WslCapture, signal?: AbortSignal): Promise<WslCommandResult> {
  return capture(
    'wsl.exe',
    [...subtitleWslArgs('default'), 'sh', '-c', 'printf "DVM_WSL_READY\\n"'],
    signal,
  ).catch((error: unknown) => {
    signal?.throwIfAborted()
    return { code: 1, output: error instanceof Error ? error.message : String(error) }
  })
}

function distributionListed(result: WslCommandResult | undefined): boolean {
  return (
    result?.code === 0 &&
    result.output
      .replaceAll('\0', '')
      .split(/\r?\n/)
      .some((name) => name.trim() === subtitleDistribution())
  )
}

/** Test Linux itself, independently of Python prerequisite installation. */
export async function checkSubtitleWslReady(
  capture: WslCapture,
  signal: AbortSignal,
): Promise<boolean> {
  const record = readInstallRecord()
  if (
    record?.state === 'done' &&
    (record.restartRequired || [3010, 1641].includes(record.code ?? -1))
  ) {
    // Read-only checks can also resume after reboot; they never launch an installer.
    const boot = await capture(
      'powershell.exe',
      psArgs(`$ErrorActionPreference='Stop'
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
if (([DateTimeOffset]$boot).ToUnixTimeMilliseconds() -gt ${record.createdAt}) { Write-Output 'DVM_INSTALL_REBOOTED' }`),
      signal,
    )
    if (boot.code !== 0) throw new Error(installInterrupted)
    if (!boot.output.includes('DVM_INSTALL_REBOOTED')) return false
    clearInstallRecord(record)
  } else if (hasSubtitleWslInstall()) return false
  const startup = await wslStartup(capture, signal)
  if (startup.code === 0 && startup.output.includes('DVM_WSL_READY')) return true
  const listed = await capture('wsl.exe', ['--list', '--quiet'], signal).catch(() => {
    signal.throwIfAborted()
    return undefined
  })
  requireWslVirtualization(await probeWslPrerequisites(capture, signal))
  // An existing distro that cannot boot needs its actual diagnostic, not another
  // installation attempt or a reboot prompt inferred from failed readiness.
  if (distributionListed(listed))
    throw installFailure('설치된 Windows 자막 실행 환경을 시작하지 못했습니다.', {
      code: startup.code,
      diagnostics: startup.output,
    })
  return false
}

async function requireWslStartup(capture: WslCapture, signal?: AbortSignal): Promise<void> {
  const startup = await wslStartup(capture, signal)
  if (startup.code !== 0 || !startup.output.includes('DVM_WSL_READY'))
    throw installFailure('Windows 설치 후 자막 실행 환경을 시작하지 못했습니다.', {
      code: startup.code,
      diagnostics: startup.output,
    })
}

/** Elevate only machine-wide WSL features; distros belong to the original user. */
export async function installSubtitleWsl(
  capture: WslCapture,
  progress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const resumed = await waitForInstall(capture, progress, signal)
  if (resumed?.restartRequired || [3010, 1641].includes(resumed?.code ?? -1)) return true
  if (resumed && resumed.code !== 0)
    throw installFailure('이전 Windows 설치를 완료하지 못했습니다.', resumed)
  signal?.throwIfAborted()
  const prerequisites = await probeWslPrerequisites(capture, signal)
  requireWslVirtualization(prerequisites)
  if (prerequisites.platform === 'unknown')
    progress?.(
      '가상 머신 플랫폼의 활성 상태를 확인하지 못했습니다. WSL 실행 결과로 다시 확인하며, 문제가 있으면 Windows 기능과 가상화 설정을 점검해 주세요.',
    )
  const listed = await capture('wsl.exe', ['--list', '--quiet'], signal).catch(() => {
    signal?.throwIfAborted()
    return undefined
  })
  const alreadyInstalled = distributionListed(listed)
  if (alreadyInstalled && prerequisites.platform !== 'disabled') {
    await requireWslStartup(capture, signal)
    return false
  }
  const platform = await capture('wsl.exe', ['--status'], signal).catch(() => {
    signal?.throwIfAborted()
    return undefined
  })
  // `wsl --status` may print a virtualization warning and still exit zero.
  if (prerequisites.platform === 'disabled' || !platform || platform.code !== 0) {
    signal?.throwIfAborted()
    await launchInstall(capture, 'platform')
    const result = await waitForInstall(capture, progress, signal)
    if (result?.restartRequired || result?.code === 3010 || result?.code === 1641) return true
    if (result && result.code !== 0)
      throw installFailure('Windows 자막 환경을 설치하지 못했습니다.', result)
    const ready = await capture('wsl.exe', ['--status'], signal).catch(() => {
      signal?.throwIfAborted()
      return undefined
    })
    if (!ready || ready.code !== 0)
      throw installFailure('Windows 설치 후 WSL 상태를 확인하지 못했습니다.', {
        code: ready?.code,
        diagnostics: ready?.output,
      })
  }
  signal?.throwIfAborted()
  if (alreadyInstalled) {
    await requireWslStartup(capture, signal)
    return false
  }
  await launchInstall(capture, 'distribution')
  const installed = await waitForInstall(capture, progress, signal)
  if (installed?.restartRequired || [3010, 1641].includes(installed?.code ?? -1)) return true
  if (installed && installed.code !== 0)
    throw installFailure('현재 Windows 사용자에 Ubuntu를 설치하지 못했습니다.', installed)
  await requireWslStartup(capture, signal)
  return false
}
