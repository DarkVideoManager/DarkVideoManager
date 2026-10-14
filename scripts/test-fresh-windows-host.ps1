param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $report = [ordered]@{
    capturedAt = [DateTime]::UtcNow.ToString('o')
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    host = Get-VMHost | Select-Object VirtualHardDiskPath,VirtualMachinePath,LogicalProcessorCount
    virtualMachines = @(Get-VM | Select-Object Name,State,Path,ProcessorCount,MemoryAssigned)
    switches = @(Get-VMSwitch | Select-Object Name,SwitchType)
    features = @(Get-WindowsOptionalFeature -Online | Where-Object { $_.FeatureName -match 'Hyper-V|VirtualMachinePlatform|Subsystem-Linux|DisposableClientVM' } | Select-Object FeatureName,State)
    error = $null
  }
} catch {
  $report = [ordered]@{capturedAt=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message}
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
