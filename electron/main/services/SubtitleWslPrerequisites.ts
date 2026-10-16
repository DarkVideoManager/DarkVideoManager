import type { WslCapture } from './SubtitleWslEnvironment'

export interface WslPrerequisites {
  platform: 'enabled' | 'disabled' | 'unknown'
  hypervisorPresent: boolean | null
  firmwareVirtualization: boolean | null
  slat: boolean | null
  hypervisorLaunch: 'auto' | 'off' | 'unknown'
}

const unknown = (): WslPrerequisites => ({
  platform: 'unknown',
  hypervisorPresent: null,
  firmwareVirtualization: null,
  slat: null,
  hypervisorLaunch: 'unknown',
})

// Read-only, unprivileged probes. Missing properties/access denial stay unknown.
// CPU flags can be hidden by an already running hypervisor, so that signal wins.
const probeScript = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$result=[ordered]@{platform='unknown';hypervisorPresent=$null;firmwareVirtualization=$null;slat=$null;hypervisorLaunch='unknown'}
try {
  $feature=Get-CimInstance Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform'" -ErrorAction Stop
  if ($feature.InstallState -eq 1) { $result.platform='enabled' }
  elseif ($feature.InstallState -eq 2 -or $feature.InstallState -eq 3) { $result.platform='disabled' }
} catch {}
try {
  $system=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  if ($null -ne $system.HypervisorPresent) { $result.hypervisorPresent=[bool]$system.HypervisorPresent }
} catch {}
try {
  $cpus=@(Get-CimInstance Win32_Processor -ErrorAction Stop)
  foreach ($pair in @(@('VirtualizationFirmwareEnabled','firmwareVirtualization'),@('SecondLevelAddressTranslationExtensions','slat'))) {
    $values=@($cpus | ForEach-Object { $_.($pair[0]) })
    if ($values.Count -gt 0 -and $values.Count -eq $cpus.Count -and @($values | Where-Object { $null -eq $_ }).Count -eq 0) {
      $result[$pair[1]]=(@($values | Where-Object { $_ -eq $false }).Count -eq 0)
    }
  }
} catch {}
try {
  $boot=(& "$env:WINDIR\\System32\\bcdedit.exe" /enum '{current}' 2>$null) -join "\n"
  if ($LASTEXITCODE -eq 0 -and $boot -match '(?im)^\\s*hypervisorlaunchtype\\s+(Auto|Off)\\s*$') {
    $result.hypervisorLaunch=$Matches[1].ToLowerInvariant()
  }
} catch {}
Write-Output ('DVM_WSL_PREREQUISITES='+($result | ConvertTo-Json -Compress))`

export async function probeWslPrerequisites(
  capture: WslCapture,
  signal?: AbortSignal,
): Promise<WslPrerequisites> {
  signal?.throwIfAborted()
  try {
    const result = await capture(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(probeScript, 'utf16le').toString('base64'),
      ],
      signal,
      15_000,
    )
    signal?.throwIfAborted()
    const payload = result.output.match(/^DVM_WSL_PREREQUISITES=(.{1,2048})$/m)?.[1]
    if (result.code !== 0 || !payload) return unknown()
    const value = JSON.parse(payload) as Record<string, unknown>
    const boolean = (key: string): boolean | null =>
      typeof value[key] === 'boolean' ? value[key] : null
    return {
      platform:
        value.platform === 'enabled' || value.platform === 'disabled' ? value.platform : 'unknown',
      hypervisorPresent: boolean('hypervisorPresent'),
      firmwareVirtualization: boolean('firmwareVirtualization'),
      slat: boolean('slat'),
      hypervisorLaunch:
        value.hypervisorLaunch === 'auto' || value.hypervisorLaunch === 'off'
          ? value.hypervisorLaunch
          : 'unknown',
    }
  } catch {
    signal?.throwIfAborted()
    return unknown()
  }
}

export function requireWslVirtualization(result: WslPrerequisites): void {
  if (result.hypervisorPresent === true) return
  if (result.hypervisorLaunch === 'off')
    throw new Error(
      'Windows 하이퍼바이저의 부팅 시작 설정이 꺼져 있습니다. PC 관리자에게 시작 설정을 확인하고 Windows를 다시 시작하도록 요청한 뒤 자동 설치를 다시 눌러 주세요. 앱은 부팅 설정을 자동으로 변경하지 않습니다.',
    )
  if (result.hypervisorPresent === false && result.slat === false)
    throw new Error(
      '현재 CPU 또는 가상 PC에서 WSL 2에 필요한 메모리 가상화(SLAT)를 사용할 수 없습니다. CPU 지원과 가상 PC의 중첩 가상화 설정을 확인해 주세요. 그래픽카드를 바꾸거나 모델을 다시 받는 것으로 해결되지 않습니다.',
    )
  if (result.hypervisorPresent === false && result.firmwareVirtualization === false)
    throw new Error(
      'CPU 가상화가 현재 환경에 제공되지 않습니다. BIOS/UEFI에서 Intel VT-x 또는 AMD SVM 설정을 확인해 주세요. 가상 PC에서는 호스트의 중첩 가상화 지원도 확인한 뒤 Windows를 다시 시작하고 자동 설치를 다시 눌러 주세요.',
    )
}

export async function preflightSubtitleWsl(
  capture: WslCapture,
  signal: AbortSignal,
): Promise<WslPrerequisites> {
  const result = await probeWslPrerequisites(capture, signal)
  requireWslVirtualization(result)
  return result
}
