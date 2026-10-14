[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Info', 'TaskStatus', 'Baseline', 'Install', 'Verify', 'Reboot', 'Collect', 'UpdatePayload')]
    [string]$Action,
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [string]$StorePath = 'E:\DarkVideoManager-TestVM-20261014',
    [ValidatePattern('^DVM-Fresh-WSL-[A-Za-z0-9-]+$')]
    [string]$VMName = 'DVM-Fresh-WSL-20261014',
    [ValidateSet('Direct', 'Interactive')]
    [string]$ExecutionMode = 'Direct'
)

# Controls only the VM recorded by test-fresh-windows-vm.ps1. It never launches
# the installer or requests a reboot on the host. Credentials stay in memory;
# neither their plaintext nor the encrypted credential file is collected.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Get-SafeChild([string]$Path, [string]$Root) {
    if (-not [IO.Path]::IsPathRooted($Path) -or -not [IO.Path]::IsPathRooted($Root)) {
        throw 'Only absolute paths are accepted.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path escapes the dedicated test directory.'
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Links and junctions are not allowed in test storage paths.'
            }
        }
        $next = Split-Path -Parent $ancestor
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
    return $full
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Use an elevated Windows PowerShell window for the isolated VM test.'
}
Import-Module Hyper-V -ErrorAction Stop
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$StorePath = [IO.Path]::GetFullPath($StorePath).TrimEnd('\')
$vmRoot = Get-SafeChild (Join-Path $StorePath $VMName) $StorePath
$manifestPath = Get-SafeChild (Join-Path $vmRoot 'vm.json') $StorePath
$credentialPath = Get-SafeChild (Join-Path $vmRoot 'credential.clixml') $StorePath
$vhdPath = Get-SafeChild (Join-Path $vmRoot 'disk.vhdx') $StorePath
$reportRoot = Get-SafeChild (Join-Path $Workspace 'test-results\fresh-windows') $Workspace
$payloadRoot = Get-SafeChild (Join-Path $reportRoot 'payload') $reportRoot

function Get-OwnedVM {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.vmName -ne $VMName -or $manifest.vhdPath -ne $vhdPath -or $manifest.vmRoot -ne $vmRoot -or -not $manifest.vmId) {
        throw 'VM ownership manifest does not match the requested name and storage.'
    }
    $owned = Get-VM -Id ([Guid]$manifest.vmId) -ErrorAction Stop
    $disks = @(Get-VMHardDiskDrive -VM $owned)
    if ($owned.Name -ne $VMName -or $disks.Count -ne 1 -or $disks[0].Path -ne $vhdPath) {
        throw 'VM identity or attached disk has changed. Refusing the action.'
    }
    return $owned
}

$vm = Get-OwnedVM
$runId = '{0}-{1}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), $Action.ToLowerInvariant()
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$reportPath = Get-SafeChild (Join-Path $reportRoot ($runId + '.json')) $reportRoot
$logPath = Get-SafeChild (Join-Path $reportRoot ($runId + '.log')) $reportRoot
$report = [ordered]@{
    action = $Action; vmName = $VMName; vmId = $vm.Id.ToString(); vmState = $vm.State.ToString()
    startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null; status = 'starting'
    guestExitCode = $null; logPath = $logPath; error = $null
}
function Write-Report {
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 7), (New-Object Text.UTF8Encoding($false)))
}
Write-Report

$session = $null
$operationLock = $null
$scriptExitCode = 0
try {
    if ($vm.State -ne 'Running') {
        if ($Action -eq 'Info') {
            $report.status = 'vm-not-running'
            $report.finishedAt = [DateTime]::UtcNow.ToString('o')
            Write-Report
            $report | ConvertTo-Json -Depth 5
            exit 0
        }
        throw 'The recorded test VM must already be running.'
    }
    if ($Action -notin @('Info', 'TaskStatus', 'Collect')) {
        $lockPath = Get-SafeChild (Join-Path $vmRoot 'operation.lock') $StorePath
        try { $operationLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Another test operation is active. Do not update or reboot the guest during installation.' }
    }
    $credential = Import-Clixml -LiteralPath $credentialPath
    if ($credential -isnot [Management.Automation.PSCredential] -or $credential.UserName -ne 'dvmtest') {
        throw 'The stored credential does not identify the isolated test account.'
    }
    $vm = Get-OwnedVM
    $session = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
    $credential = $null
    # All subsequent commands use this exact VM session. The second guard also
    # prevents a copied credential/manifest from accidentally targeting a host.
    $guestIdentity = Invoke-Command -Session $session -ArgumentList $VMName -ScriptBlock {
        param($ExpectedVMName)
        $ErrorActionPreference = 'Stop'
        $computer = Get-CimInstance Win32_ComputerSystem
        $marker = Get-Content -LiteralPath 'C:\DVMTest\fresh-vm.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($env:COMPUTERNAME -ne 'DVM-WSL-TEST' -or $computer.Model -ne 'Virtual Machine' -or $computer.Manufacturer -ne 'Microsoft Corporation' -or $marker.vmName -ne $ExpectedVMName) {
            throw 'Guest identity guard failed; no test action was performed.'
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Guest session is not elevated.' }
        [pscustomobject]@{ computerName = $env:COMPUTERNAME; userSid = $identity.User.Value; userName = $identity.Name; model = $computer.Model }
    }
    $report.status = 'running'
    Write-Report

    # Remember only observed installer identities (PID + creation time + path)
    # from this VM's own status reports. This catches an orphaned servicing
    # child after the old app's timed-out supervisor has already exited.
    $platformInstallers = @()
    if ($Action -notin @('Info', 'Collect')) {
        $knownPlatformProcesses = @()
        foreach ($previousFile in @(Get-ChildItem -LiteralPath $reportRoot -Filter '*-taskstatus.json' -File | Where-Object Name -match '^\d{8}T\d{9}Z-taskstatus\.json$' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 20)) {
            $previous = Get-Content -LiteralPath $previousFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $previous -and $previous.PSObject.Properties['vmId'] -and $previous.vmId -eq $vm.Id.ToString() -and
                $previous.PSObject.Properties['taskStatus'] -and $null -ne $previous.taskStatus -and $previous.taskStatus.PSObject.Properties['platformInstallers']) {
                $knownPlatformProcesses += @($previous.taskStatus.platformInstallers)
            }
        }
        $platformInstallers = @(Invoke-Command -Session $session -ArgumentList $guestIdentity.userSid, $knownPlatformProcesses -ScriptBlock {
            param($ExpectedSid, $KnownProcesses)
            $ErrorActionPreference = 'Stop'
            $all = @(Get-CimInstance Win32_Process)
            $wslPaths = @('C:\Windows\System32\wsl.exe', 'C:\Program Files\WSL\wsl.exe')
            $servicingPaths = @('C:\Windows\System32\msiexec.exe', 'C:\Windows\SysWOW64\msiexec.exe', 'C:\Windows\System32\Dism.exe', 'C:\Windows\System32\DismHost.exe')
            $allowedPaths = $wslPaths + $servicingPaths
            $found = @{}
            foreach ($process in $all) {
                if ($process.ExecutablePath -in $wslPaths -and $process.CommandLine -match '^"?(?:[^"\r\n]*\\)?wsl\.exe"?\s+--install(?:\s|$)' -and
                    (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -eq $ExpectedSid) {
                    $found[[int]$process.ProcessId] = $process
                }
            }
            foreach ($known in @($KnownProcesses)) {
                if ($null -eq $known -or $known.executablePath -notin $allowedPaths) { continue }
                foreach ($process in @($all | Where-Object ProcessId -eq $known.processId)) {
                    if ($process.ExecutablePath -eq $known.executablePath -and $process.CreationDate.ToUniversalTime().ToString('o') -eq $known.createdAt) {
                        $found[[int]$process.ProcessId] = $process
                    }
                }
            }
            do {
                $added = $false
                foreach ($process in $all) {
                    if ($found.ContainsKey([int]$process.ProcessId) -or $process.ExecutablePath -notin $servicingPaths) { continue }
                    if ($found.ContainsKey([int]$process.ParentProcessId) -and $process.CreationDate -ge $found[[int]$process.ParentProcessId].CreationDate) {
                        $found[[int]$process.ProcessId] = $process
                        $added = $true
                    }
                }
            } while ($added)
            foreach ($process in $found.Values) {
                [pscustomobject]@{ processId = $process.ProcessId; parentProcessId = $process.ParentProcessId; executablePath = $process.ExecutablePath; createdAt = $process.CreationDate.ToUniversalTime().ToString('o') }
            }
        })
    }

    # Interactive tasks outlive a PowerShell Direct connection. Refuse a second
    # installer, payload update, or restart while a previous owned task runs.
    if ($Action -notin @('Info', 'TaskStatus', 'Collect')) {
        if ($platformInstallers.Count) { throw 'An owned WSL installer or observed servicing child is still active; collect status before restarting or changing the guest.' }
        Invoke-Command -Session $session -ScriptBlock {
            $activeTasks = @(Get-ScheduledTask -TaskPath '\' | Where-Object {
                $_.TaskName -like 'DVM-Fresh-Windows-Test-*' -and $_.State -in @('Running', 'Queued')
            })
            $activeApps = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe')
            if ($activeTasks.Count -or $activeApps.Count) { throw 'An existing guest test is still running; inspect TaskStatus before another operation.' }
        }
    }

    switch ($Action) {
        'TaskStatus' {
            $taskStatus = Invoke-Command -Session $session -ScriptBlock {
                $ErrorActionPreference = 'Stop'
                $tasks = @(Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -like 'DVM-Fresh-Windows-Test-*' | ForEach-Object {
                    $details = $_ | Get-ScheduledTaskInfo
                    [pscustomobject]@{ name = $_.TaskName; state = $_.State.ToString(); lastResult = $details.LastTaskResult; lastRunTime = $details.LastRunTime.ToUniversalTime().ToString('o') }
                })
                $latest = $null
                if (Test-Path -LiteralPath 'C:\DVMTest\results\latest.json') {
                    try { $latest = Get-Content -LiteralPath 'C:\DVMTest\results\latest.json' -Raw -Encoding UTF8 | ConvertFrom-Json }
                    catch { $latest = @{ message = 'Progress file is being replaced; inspect again.' } }
                }
                $launchers = @(Get-ChildItem -LiteralPath 'C:\DVMTest\results' -Filter '*-launcher.json' -ErrorAction SilentlyContinue | ForEach-Object {
                    try { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
                    catch { [pscustomobject]@{ state = 'unreadable'; message = 'Launcher status is being replaced; inspect again.' } }
                })
                [pscustomobject]@{
                    tasks = $tasks; launchers = $launchers; latest = $latest
                    testProcesses = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe' | Select-Object ProcessId, ParentProcessId, SessionId, Name)
                }
            }
            $report['taskStatus'] = $taskStatus | Select-Object tasks, launchers, latest, testProcesses
            $report.taskStatus | Add-Member -NotePropertyName platformInstallers -NotePropertyValue @($platformInstallers)
        }
        'Info' {
            $info = Invoke-Command -Session $session -ScriptBlock {
                $ErrorActionPreference = 'Stop'
                $osInfo = Get-CimInstance Win32_OperatingSystem
                $setup = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\Setup'
                $setupState = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction SilentlyContinue
                $features = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') | ForEach-Object {
                    $feature = Get-WindowsOptionalFeature -Online -FeatureName $_
                    [pscustomobject]@{ name = $feature.FeatureName; state = $feature.State.ToString() }
                }
                $latest = $null
                if (Test-Path -LiteralPath 'C:\DVMTest\results\latest.json') {
                    try { $latest = Get-Content -LiteralPath 'C:\DVMTest\results\latest.json' -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $latest = @{ message = 'Status file is being replaced; inspect again.' } }
                }
                [pscustomobject]@{
                    computerName = $env:COMPUTERNAME; bootTime = $osInfo.LastBootUpTime.ToUniversalTime().ToString('o')
                    uptimeSeconds = ([DateTime]::Now - $osInfo.LastBootUpTime).TotalSeconds
                    caption = $osInfo.Caption; version = $osInfo.Version; buildNumber = $osInfo.BuildNumber
                    freePhysicalMemoryKB = $osInfo.FreePhysicalMemory
                    systemSetupInProgress = $setup.SystemSetupInProgress; oobeInProgress = $setup.OOBEInProgress
                    imageState = $setupState.ImageState; features = @($features); latest = $latest
                    testProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe' } | Select-Object ProcessId, ParentProcessId, Name)
                }
            }
            $report['guestIdentity'] = @{ computerName = $guestIdentity.computerName; userSid = $guestIdentity.userSid; userName = $guestIdentity.userName; model = $guestIdentity.model }
            # JSON round-trip excludes PowerShell remoting wrapper metadata.
            $report['guestInfo'] = $info | Select-Object computerName, bootTime, uptimeSeconds, caption, version, buildNumber, freePhysicalMemoryKB, systemSetupInProgress, oobeInProgress, imageState, features, latest, testProcesses
        }
        { $_ -in @('Baseline', 'Install', 'Verify') } {
            $mode = $Action.ToLowerInvariant()
            if ($ExecutionMode -eq 'Interactive') {
                if ($Action -eq 'Baseline') { throw 'Collect Baseline directly before scheduling an interactive application run.' }
                $task = Invoke-Command -Session $session -ArgumentList $mode, $runId, $VMName, $guestIdentity.userSid -ScriptBlock {
                    param($Mode, $RunId, $ExpectedVMName, $ExpectedSid)
                    $ErrorActionPreference = 'Stop'
                    if ($Mode -notin @('install', 'verify') -or $RunId -notmatch '^\d{8}T\d{9}Z-(install|verify)$') { throw 'Invalid scheduled test identity.' }
                    $baseline = Get-Content -LiteralPath 'C:\DVMTest\results\baseline.json' -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($baseline.identity.userSid -ne $ExpectedSid -or $baseline.identity.vmName -ne $ExpectedVMName) { throw 'Interactive test must use the original baseline VM and user SID.' }
                    $desktop = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object {
                        $_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $ExpectedSid
                    })
                    if (-not $desktop.Count) { throw 'The original test account must already be logged into the guest desktop.' }
                    foreach ($required in @('C:\DVMTest\app\DarkVideoManager.exe', 'C:\DVMTest\test-fresh-windows-guest.cjs')) {
                        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'The packaged executable or harness is missing.' }
                    }
                    foreach ($directory in @('C:\DVMTest', 'C:\DVMTest\runs', 'C:\DVMTest\results')) {
                        if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Guest test directories may not be links.' }
                    }
                    $taskName = 'DVM-Fresh-Windows-Test-' + $RunId
                    if (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'This scheduled run already exists.' }
                    $runRoot = 'C:\DVMTest\runs'
                    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
                    $launcher = Join-Path $runRoot ($RunId + '.ps1')
                    $configuration = Join-Path $runRoot ($RunId + '.json')
                    if ((Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath $configuration)) { throw 'This guest run path already exists.' }
                    [ordered]@{ runId = $RunId; mode = $Mode; vmName = $ExpectedVMName; userSid = $ExpectedSid } |
                        ConvertTo-Json | Set-Content -LiteralPath $configuration -Encoding UTF8
                    $source = @'
param([Parameter(Mandatory = $true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Configuration -notmatch '^C:\\DVMTest\\runs\\\d{8}T\d{9}Z-(install|verify)\.json$') { throw 'Unexpected guest run configuration.' }
$config = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$computer = Get-CimInstance Win32_ComputerSystem
$marker = Get-Content -LiteralPath 'C:\DVMTest\fresh-vm.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$baseline = Get-Content -LiteralPath 'C:\DVMTest\results\baseline.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($env:COMPUTERNAME -ne 'DVM-WSL-TEST' -or $computer.Model -ne 'Virtual Machine' -or $computer.Manufacturer -ne 'Microsoft Corporation' -or
    $marker.vmName -ne $config.vmName -or $config.vmName -notmatch '^DVM-Fresh-WSL-[A-Za-z0-9-]+$' -or
    $identity.User.Value -ne $config.userSid -or $baseline.identity.userSid -ne $config.userSid -or $baseline.identity.vmName -ne $config.vmName -or
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $sessionId -le 0 -or
    $config.mode -notin @('install', 'verify') -or $config.runId -notmatch '^\d{8}T\d{9}Z-(install|verify)$') { throw 'Interactive guest guard failed.' }
$resultPath = 'C:\DVMTest\results\' + $config.runId + '-launcher.json'
$state = [ordered]@{ runId = $config.runId; mode = $config.mode; userSid = $identity.User.Value; sessionId = $sessionId; launcherPid = $PID; processId = $null; startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null; exitCode = $null; state = 'starting'; error = $null }
function Save-LauncherState {
    $temporary = $resultPath + '.tmp'
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $resultPath -Force
}
Save-LauncherState
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:DVM_FRESH_VM_TEST = '1'
    $env:DVM_FRESH_VM_INTERACTIVE = '1'
    $env:WSL_UTF8 = '1'
    $stdout = 'C:\DVMTest\results\' + $config.runId + '-stdout.log'
    $stderr = 'C:\DVMTest\results\' + $config.runId + '-stderr.log'
    $child = Start-Process -FilePath 'C:\DVMTest\app\DarkVideoManager.exe' -ArgumentList @('C:\DVMTest\test-fresh-windows-guest.cjs', $config.mode) -WorkingDirectory 'C:\DVMTest' -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $child.Handle
    $state.processId = $child.Id
    $state.state = 'running'
    Save-LauncherState
    $child.WaitForExit()
    $child.Refresh()
    if ($null -eq $child.ExitCode) { throw 'The guest harness did not return an exit code.' }
    $state.exitCode = $child.ExitCode
    $state.state = 'finished'
} catch {
    $state.exitCode = 1
    $state.state = 'failed'
    $state.error = $_.Exception.Message
} finally {
    $state.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-LauncherState
}
exit $state.exitCode
'@
                    [IO.File]::WriteAllText($launcher, $source, (New-Object Text.UTF8Encoding($false)))
                    $principal = New-ScheduledTaskPrincipal -UserId $ExpectedSid -LogonType Interactive -RunLevel Highest
                    $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -Configuration "' + $configuration + '"') -WorkingDirectory 'C:\DVMTest'
                    # Harness owns its timeout and orderly app shutdown. A task
                    # deadline must never kill Windows feature installation.
                    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
                    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Principal $principal -Settings $settings -Description ('DarkVideoManager isolated fresh Windows test: ' + $ExpectedVMName) | Out-Null
                    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
                    [pscustomobject]@{ name = $taskName; runId = $RunId; userSid = $ExpectedSid; mode = $Mode; resultPath = ('C:\DVMTest\results\' + $RunId + '-launcher.json') }
                }
                $report['interactiveTask'] = $task | Select-Object name, runId, userSid, mode, resultPath
                $report.status = 'interactive-task-started'
                break
            }
            $exitSeen = $false
            Invoke-Command -Session $session -ArgumentList $mode -ScriptBlock {
                param($Mode)
                if (-not (Test-Path -LiteralPath 'C:\DVMTest\app\DarkVideoManager.exe' -PathType Leaf) -or -not (Test-Path -LiteralPath 'C:\DVMTest\test-fresh-windows-guest.cjs' -PathType Leaf)) {
                    throw 'The packaged test executable or guest harness is missing.'
                }
                $ErrorActionPreference = 'Continue'
                $env:ELECTRON_RUN_AS_NODE = '1'
                $env:DVM_FRESH_VM_TEST = '1'
                $env:WSL_UTF8 = '1'
                Set-Location -LiteralPath 'C:\DVMTest'
                $LASTEXITCODE = $null
                & 'C:\DVMTest\app\DarkVideoManager.exe' 'C:\DVMTest\test-fresh-windows-guest.cjs' $Mode 2>&1 | ForEach-Object { $_.ToString() }
                $result = $LASTEXITCODE
                if ($null -eq $result) { throw 'The guest test process did not start.' }
                [pscustomobject]@{ dvmGuestExit = $true; exitCode = $result }
            } | ForEach-Object {
                if ($_.PSObject.Properties.Name -contains 'dvmGuestExit' -and $_.dvmGuestExit -eq $true) {
                    $report.guestExitCode = [int]$_.exitCode
                    $exitSeen = $true
                } else {
                    $line = $_.ToString()
                    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
                    Write-Output $line
                }
            }
            if (-not $exitSeen) { throw 'Guest test did not return its process exit code.' }
            if ($report.guestExitCode -eq 10) { $report.status = 'guest-reboot-required'; $scriptExitCode = 10 }
            elseif ($report.guestExitCode -ne 0) { $report.status = 'guest-test-failed'; $scriptExitCode = $report.guestExitCode }
        }
        'Reboot' {
            # Host Restart-Computer is deliberately never called by this script.
            Invoke-Command -Session $session -ScriptBlock {
                $ErrorActionPreference = 'Stop'
                $active = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe')
                if ($active.Count) { throw 'The guest test application is still running; collect its result before rebooting.' }
                & "$env:SystemRoot\System32\shutdown.exe" /r /t 5 /d p:4:1 /c 'DarkVideoManager disposable VM installation test'
                if ($LASTEXITCODE -ne 0) { throw 'Guest restart request failed.' }
            }
            $report.status = 'guest-reboot-requested'
        }
        'Collect' {
            $collectionPlan = Invoke-Command -Session $session -ScriptBlock {
                $ErrorActionPreference = 'Stop'
                function Test-ActiveGuestTest {
                    $tasks = @(Get-ScheduledTask -TaskPath '\' | Where-Object {
                        $_.TaskName -like 'DVM-Fresh-Windows-Test-*' -and $_.State -in @('Running', 'Queued')
                    })
                    $apps = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe')
                    return $tasks.Count -gt 0 -or $apps.Count -gt 0
                }
                $activeAtCollection = Test-ActiveGuestTest
                if (-not (Test-Path -LiteralPath 'C:\DVMTest\results')) {
                    return [pscustomobject]@{ files = @(); skippedLockedFiles = @(); activeAtCollection = $activeAtCollection }
                }
                $links = @(Get-ChildItem -LiteralPath 'C:\DVMTest\results' -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
                if ($links.Count) { throw 'Refusing to collect results containing links.' }
                $files = @()
                $skipped = @()
                foreach ($entry in @(Get-ChildItem -LiteralPath 'C:\DVMTest\results' -Force)) {
                    if (-not $entry.PSIsContainer) {
                        $stream = $null
                        try {
                            # Permit live writers/atomic replacements during the
                            # probe. Only a source that refuses even shared reads
                            # is skipped, before touching its destination file.
                            $stream = [IO.File]::Open($entry.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                        } catch {
                            $exception = $_.Exception
                            while ($exception.InnerException) { $exception = $exception.InnerException }
                            $nativeError = $exception.HResult -band 0xffff
                            if ($nativeError -in @(32, 33) -and (Test-ActiveGuestTest)) {
                                $skipped += [pscustomobject]@{ name = $entry.Name; reason = 'locked-by-active-test'; win32Error = $nativeError }
                                continue
                            }
                            throw
                        } finally {
                            if ($stream) { $stream.Dispose() }
                        }
                    }
                    $files += $entry.Name
                }
                [pscustomobject]@{ files = $files; skippedLockedFiles = $skipped; activeAtCollection = $activeAtCollection }
            }
            $guestFiles = @($collectionPlan.files)
            $collection = Get-SafeChild (Join-Path $reportRoot 'guest-results') $reportRoot
            New-Item -ItemType Directory -Path $collection -Force | Out-Null
            if (@(Get-ChildItem -LiteralPath $collection -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
                throw 'Refusing to overwrite a result directory containing links.'
            }
            foreach ($name in $guestFiles) {
                if ($name -match '[\\/]' -or $name -in @('.', '..')) { throw 'Unexpected guest result filename.' }
                Copy-Item -FromSession $session -LiteralPath (Join-Path 'C:\DVMTest\results' $name) -Destination $collection -Recurse -Force
            }
            $report['collectedEntries'] = $guestFiles.Count
            $report['collectedPath'] = $collection
            $report['skippedLockedFiles'] = @($collectionPlan.skippedLockedFiles)
            $report['activeAtCollection'] = [bool]$collectionPlan.activeAtCollection
            $report['collectionComplete'] = -not $collectionPlan.activeAtCollection -and @($collectionPlan.skippedLockedFiles).Count -eq 0
            if (-not $report.collectionComplete) { $report.status = 'collected-partial-snapshot' }
        }
        'UpdatePayload' {
            Invoke-Command -Session $session -ScriptBlock {
                $active = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq 'C:\DVMTest\app\DarkVideoManager.exe')
                if ($active.Count) { throw 'The guest test application is running; payload update refused.' }
            }
            $files = @(
                @{ relative = 'app\DarkVideoManager.exe'; destination = 'C:\DVMTest\app\DarkVideoManager.exe' },
                @{ relative = 'app\resources\app.asar'; destination = 'C:\DVMTest\app\resources\app.asar' },
                @{ relative = 'test-fresh-windows-guest.cjs'; destination = 'C:\DVMTest\test-fresh-windows-guest.cjs' }
            )
            # Keep updates limited to the known runtime sources and pinned CA
            # evidence. Never copy credentials, app data, or a replacement baseline.
            foreach ($runtime in @(
                'setup_models.py', 'whisper_vulkan.py', 'generate.py', 'setup_environment.py',
                'gpu-models.json', 'download_tls.py', 'certificates\mozilla-ca.crt',
                'certificates\manifest.json', 'certificates\LICENSE.txt', 'certificates\MPL-2.0.txt'
            )) {
                $files += @{ relative = ('app\resources\subtitles\' + $runtime); destination = ('C:\DVMTest\app\resources\subtitles\' + $runtime) }
            }
            foreach ($notice in @(
                'inventory.json', 'INDEX.md', 'DISTRIBUTION.md', 'THIRD_PARTY_NOTICES.md',
                'subtitle-certificates\LICENSE.txt', 'subtitle-certificates\MPL-2.0.txt', 'subtitle-certificates\manifest.json'
            )) {
                $files += @{ relative = ('app\resources\legal\' + $notice); destination = ('C:\DVMTest\app\resources\legal\' + $notice) }
            }
            # Validate every source before writing any guest file.
            foreach ($file in $files) {
                $source = Get-SafeChild (Join-Path $payloadRoot $file.relative) $payloadRoot
                if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Prepared payload file is missing: $($file.relative)" }
            }
            $updated = @()
            foreach ($file in $files) {
                $source = Get-SafeChild (Join-Path $payloadRoot $file.relative) $payloadRoot
                Invoke-Command -Session $session -ArgumentList $file.destination -ScriptBlock {
                    param($Destination)
                    if (-not $Destination.StartsWith('C:\DVMTest\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload destination escaped the guest test root.' }
                    $ancestor = $Destination
                    while ($ancestor) {
                        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Guest payload destination contains a link.' }
                        $ancestor = Split-Path -Parent $ancestor
                    }
                    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
                }
                Copy-Item -ToSession $session -LiteralPath $source -Destination $file.destination -Force
                $updated += @{ file = $file.relative; sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash }
            }
            $report['updatedFiles'] = $updated
        }
    }
    if ($report.status -eq 'running') { $report.status = 'completed' }
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    $scriptExitCode = 1
} finally {
    if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
    if ($operationLock) { $operationLock.Dispose() }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Report
}
$report | ConvertTo-Json -Depth 7
exit $scriptExitCode
