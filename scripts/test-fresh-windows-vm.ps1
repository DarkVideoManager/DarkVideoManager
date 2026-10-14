[CmdletBinding()]
param(
    [ValidateSet('Initialize', 'Resume', 'Status', 'Start')]
    [string]$Action = 'Initialize',
    [string]$ISOPath,
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [string]$StorePath = 'E:\DarkVideoManager-TestVM-20261014',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{1,63}$')]
    [string]$VMName = 'DVM-Fresh-WSL-20261014',
    [ValidateRange(4294967296, 34359738368)]
    [long]$MemoryStartupBytes = 4GB,
    [ValidateRange(0, 99)]
    [int]$ImageIndex = 0
)

# This provisions only a NEW, separately named Hyper-V VM. It does not enable
# host features, change an existing VM, restart the host, or activate Windows.
# Supported ISO hashes were published by Microsoft:
# https://www.microsoft.com/en-us/software-download/windows11?msockid=2a97e15c38e168592361f7dc3922696b
# https://support.microsoft.com/en-us/servicing/os/windows/docs/2026/09/verify-the-authenticity-of-a-windows-11-enterprise-evaluation-iso-file
# Setup uses documented deployment/answer-file settings and PowerShell Direct:
# https://learn.microsoft.com/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-autologon
# https://learn.microsoft.com/windows-server/virtualization/hyper-v/enable-nested-virtualization

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Get-AbsolutePath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'All storage paths must be absolute.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-ChildPath([string]$Path, [string]$Root) {
    $resolved = Get-AbsolutePath $Path
    $parent = Get-AbsolutePath $Root
    if (-not $resolved.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a path outside the VM storage directory: $resolved"
    }
    # A lexical containment check is insufficient when an ancestor is a junction.
    $ancestor = $resolved
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are not allowed in VM storage paths: $ancestor"
            }
        }
        $next = Split-Path -Parent $ancestor
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
    return $resolved
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this test helper from an elevated Windows PowerShell window.'
}
if (-not [Environment]::Is64BitProcess) { throw '64-bit Windows PowerShell is required.' }
Import-Module Hyper-V -ErrorAction Stop
Import-Module Dism -ErrorAction Stop

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$StorePath = Get-AbsolutePath $StorePath
if ($StorePath -eq [IO.Path]::GetPathRoot($StorePath).TrimEnd('\')) {
    throw 'StorePath must be a dedicated directory, never a drive root.'
}
$vmRoot = Assert-ChildPath (Join-Path $StorePath $VMName) $StorePath
$vhdPath = Assert-ChildPath (Join-Path $vmRoot 'disk.vhdx') $StorePath
$manifestPath = Assert-ChildPath (Join-Path $vmRoot 'vm.json') $StorePath
$credentialPath = Assert-ChildPath (Join-Path $vmRoot 'credential.clixml') $StorePath
$reportDirectory = Join-Path $Workspace 'test-results\fresh-windows'
$reportPath = Join-Path $reportDirectory 'hyperv-vm.json'

function Get-OwnedVM {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'VM ownership manifest is missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.vmName -ne $VMName -or $manifest.vhdPath -ne $vhdPath -or -not $manifest.vmId) {
        throw 'The VM identity does not match this test helper storage directory.'
    }
    $owned = Get-VM -Id ([Guid]$manifest.vmId) -ErrorAction Stop
    $disks = @(Get-VMHardDiskDrive -VM $owned)
    if ($owned.Name -ne $VMName -or $disks.Count -ne 1 -or $disks[0].Path -ne $vhdPath) {
        throw 'VM name or attached disk differs from the recorded test VM.'
    }
    return $owned
}

if ($Action -notin @('Initialize', 'Resume')) {
    $ownedVM = Get-OwnedVM
    if ($Action -eq 'Start') {
        if ($ownedVM.State -ne 'Off') { throw 'Start is allowed only for the recorded VM in the Off state.' }
        Start-VM -VM $ownedVM | Out-Null
        $ownedVM = Get-OwnedVM
    }
    [ordered]@{
        vmName = $ownedVM.Name; vmId = $ownedVM.Id.ToString(); state = $ownedVM.State.ToString()
        status = $ownedVM.Status; uptimeSeconds = $ownedVM.Uptime.TotalSeconds
        memoryAssigned = $ownedVM.MemoryAssigned; vhdPath = $vhdPath
        credentialPath = $credentialPath
    } | ConvertTo-Json -Depth 4
    exit 0
}

$resumeManifest = $null
if ($Action -eq 'Resume') {
    $resumeManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($resumeManifest.schemaVersion -ne 1 -or $resumeManifest.vmName -ne $VMName -or $resumeManifest.vmRoot -ne $vmRoot -or $resumeManifest.vhdPath -ne $vhdPath -or $resumeManifest.credentialPath -ne $credentialPath -or $resumeManifest.vmId -or $resumeManifest.stage -notin @('failed', 'image-applied-awaiting-guest-preparation')) {
        throw 'Resume is allowed only for this helper failed, unregistered VM disk.'
    }
    if (-not (Test-Path -LiteralPath $vhdPath -PathType Leaf) -or (Test-Path -LiteralPath $credentialPath)) {
        throw 'Resume requires the recorded disk before any guest credential was created.'
    }
    if ($ISOPath -and (Resolve-Path -LiteralPath $ISOPath).Path -ne $resumeManifest.isoPath) { throw 'Resume ISO path differs from the original verified image.' }
    $ISOPath = $resumeManifest.isoPath
    $ImageIndex = [int]$resumeManifest.imageIndex
    $MemoryStartupBytes = [long]$resumeManifest.memoryStartupBytes
    if ($ImageIndex -lt 1 -or $MemoryStartupBytes -lt 4GB -or $MemoryStartupBytes -gt 32GB) { throw 'Invalid image or memory metadata in the resume manifest.' }
} else {
    if (-not $ISOPath) { throw 'ISOPath is required when initializing a new VM.' }
    $ISOPath = (Resolve-Path -LiteralPath $ISOPath).Path
    if ([IO.Path]::GetExtension($ISOPath) -ne '.iso') { throw 'ISOPath must point to an ISO file.' }
}
if (@(Get-VM | Where-Object Name -eq $VMName).Count) { throw 'A VM with this name already exists. No changes were made.' }
if ($Action -eq 'Initialize' -and (Test-Path -LiteralPath $vmRoot)) { throw 'This VM storage directory already exists. No existing contents will be reused or deleted.' }
if ((Get-Service vmms).Status -ne 'Running') { throw 'Hyper-V Virtual Machine Management must already be running.' }
$switch = @(Get-VMSwitch | Where-Object Name -eq 'Default Switch')
if ($switch.Count -ne 1) { throw 'The existing Hyper-V Default Switch is required.' }
$payload = Join-Path $reportDirectory 'payload'
if (-not (Test-Path -LiteralPath $payload -PathType Container) -or @(Get-ChildItem -LiteralPath $payload -Force).Count -eq 0) {
    throw 'Prepare the guest test payload in test-results\fresh-windows\payload first.'
}
if (@(Get-ChildItem -LiteralPath $payload -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
    throw 'The guest payload must contain real files, not links or junctions.'
}
$driveInfo = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($StorePath))
if ($driveInfo.AvailableFreeSpace -lt 40GB) { throw 'At least 40 GB of free space is required for this isolated test.' }

$knownImages = @{
    '8E951FEEB9DA75CA0028F1AEF0655851136F5392981FC09DF3C22EADB7FD3C8A' = @{ edition = 'Professional'; locale = 'ko-KR'; release = 'Windows 11 25H2 Korean retail' }
    'BC3F24086EBADC94489066B5AD78089E2CF5C3491E90E790BB81A2B199C10E38' = @{ edition = 'EnterpriseEval'; locale = 'en-US'; release = 'Windows 11 26H2 Enterprise Evaluation' }
    'B7EC51F0D332AC2AA4F7FAEFFBEFAC961CE6EB7204B5876B48FA8D9F1CF0A9A6' = @{ edition = 'EnterpriseEval'; locale = 'ko-KR'; release = 'Windows 11 26H2 Enterprise Evaluation' }
}
$isoHash = if ($resumeManifest) { $resumeManifest.isoSha256 } else { (Get-FileHash -LiteralPath $ISOPath -Algorithm SHA256).Hash }
if (-not $knownImages.ContainsKey($isoHash)) { throw 'ISO hash is not one of the verified official images supported by this helper.' }
$imageSpec = $knownImages[$isoHash]

if ($Action -eq 'Initialize') {
New-Item -ItemType Directory -Path $vmRoot -ErrorAction Stop | Out-Null
# Protect the new VM directory before writing its DPAPI-encrypted guest credential.
$acl = Get-Acl -LiteralPath $vmRoot
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $vmRoot -AclObject $acl
}
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$state = [ordered]@{
    schemaVersion = 1; vmName = $VMName; vmId = $null; stage = 'created-directory'
    createdAt = [DateTime]::UtcNow.ToString('o'); updatedAt = $null
    isoPath = $ISOPath; isoSha256 = $isoHash; imageRelease = $imageSpec.release
    imageIndex = $null; imageName = $null; imageVersion = $null
    vmRoot = $vmRoot; vhdPath = $vhdPath; credentialPath = $credentialPath
    memoryStartupBytes = $MemoryStartupBytes; processorCount = 4
    initialWslFeatures = @(); error = $null
}
if ($resumeManifest) {
    foreach ($property in $resumeManifest.PSObject.Properties) { $state[$property.Name] = $property.Value }
    $state['resumedAt'] = [DateTime]::UtcNow.ToString('o')
    $state['previousError'] = $state.error
    $state.error = $null
}
$state['baselineVerification'] = 'required-online-before-install'
function Write-TestState([string]$Stage) {
    $state.stage = $Stage
    $state.updatedAt = [DateTime]::UtcNow.ToString('o')
    $json = $state | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($reportPath, $json, (New-Object Text.UTF8Encoding($false)))
    [ordered]@{ stage = $Stage; vmName = $VMName; vmId = $state.vmId; updatedAt = $state.updatedAt } | ConvertTo-Json -Compress
}

$isoMountedByThisScript = $false
$vhdMountedByThisScript = $false
try {
    if ($Action -eq 'Initialize') {
    Write-TestState 'mounting-verified-iso'
    $iso = Get-DiskImage -ImagePath $ISOPath
    if (-not $iso.Attached) {
        $iso = Mount-DiskImage -ImagePath $ISOPath -StorageType ISO -PassThru
        $isoMountedByThisScript = $true
    }
    $isoVolumes = @($iso | Get-Volume | Where-Object DriveLetter)
    if ($isoVolumes.Count -ne 1) { throw 'The ISO did not expose exactly one readable volume.' }
    $isoRoot = '{0}:\' -f $isoVolumes[0].DriveLetter
    $wimPath = Join-Path $isoRoot 'sources\install.wim'
    if (-not (Test-Path -LiteralPath $wimPath)) { $wimPath = Join-Path $isoRoot 'sources\install.esd' }
    if (-not (Test-Path -LiteralPath $wimPath)) { throw 'No Windows installation image was found in the ISO.' }
    $images = @(Get-WindowsImage -ImagePath $wimPath)
    if ($ImageIndex -eq 0) {
        if ($imageSpec.edition -eq 'Professional') {
            $selected = @($images | Where-Object ImageName -eq 'Windows 11 Pro')
        } else {
            $selected = @($images | Where-Object { $_.ImageName -match 'Enterprise.*Eval' -and $_.ImageName -notmatch 'Enterprise N' })
        }
        if ($selected.Count -ne 1) { throw 'Cannot unambiguously select the expected Windows edition; provide ImageIndex after inspecting the ISO.' }
        $ImageIndex = $selected[0].ImageIndex
    }
    $selectedInfo = Get-WindowsImage -ImagePath $wimPath -Index $ImageIndex
    if ($selectedInfo.EditionId -ne $imageSpec.edition -or [int]$selectedInfo.Architecture -ne 9) {
        throw 'The selected image is not the expected x64 Windows edition.'
    }
    $state.imageIndex = $ImageIndex
    $state.imageName = $selectedInfo.ImageName
    $state.imageVersion = $selectedInfo.Version.ToString()

    Write-TestState 'creating-empty-test-disk'
    Assert-ChildPath $vhdPath $StorePath | Out-Null
    if (Test-Path -LiteralPath $vhdPath) { throw 'Refusing to overwrite any existing virtual disk.' }
    New-VHD -Path $vhdPath -SizeBytes 80GB -Dynamic | Out-Null
    $mountedVhd = Mount-VHD -Path $vhdPath -PassThru
    $vhdMountedByThisScript = $true
    $disk = Get-Disk -Number $mountedVhd.DiskNumber
    # Initialization/formatting is reachable only for the just-created VHD,
    # whose mounted disk identity is checked before every partition operation.
    if ($disk.IsBoot -or $disk.IsSystem -or $disk.PartitionStyle -ne 'RAW' -or $disk.Number -ne (Get-VHD -Path $vhdPath).DiskNumber) {
        throw 'The new VHD did not resolve to an unused, non-system RAW disk.'
    }
    $disk = Initialize-Disk -Number $disk.Number -PartitionStyle GPT -PassThru
    $usedLetters = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter }) + @(Get-PSDrive -PSProvider FileSystem | ForEach-Object Name)
    $letters = @([char[]]'ZYXWVUTSRQPONMLKJIHGF' | Where-Object { $usedLetters -notcontains [string]$_ })
    if ($letters.Count -lt 2) { throw 'Two unused temporary drive letters are required.' }
    $efiLetter = [char]$letters[0]
    $osLetter = [char]$letters[1]
    $efiPartition = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -DriveLetter $efiLetter
    $efiPartition | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'DVM_EFI' -Confirm:$false | Out-Null
    # Storage cmdlets may create the GPT Microsoft Reserved partition during
    # initialization. Reuse it instead of adding a second MSR partition.
    $reservedPartitions = @(Get-Partition -DiskNumber $disk.Number | Where-Object GptType -eq '{e3c9e316-0b5c-4db8-817d-f92df00215ae}')
    if ($reservedPartitions.Count -eq 0) {
        New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
    }
    $osPartition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $osLetter
    $osPartition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'DVM_TEST_WINDOWS' -Confirm:$false | Out-Null
    $osRoot = '{0}:\' -f $osLetter

    Write-TestState 'applying-windows-image'
    Expand-WindowsImage -ImagePath $wimPath -Index $ImageIndex -ApplyPath $osRoot -CheckIntegrity -Verify | Out-Null
    $state['imageAppliedAt'] = [DateTime]::UtcNow.ToString('o')
    Write-TestState 'image-applied-awaiting-guest-preparation'
    } else {
        # This branch NEVER creates, initializes, formats, or reapplies a disk.
        # It resumes only the recorded, unbooted test VHD after image application.
        $existingVhd = Get-VHD -Path $vhdPath
        if ($existingVhd.Attached -or $existingVhd.Size -ne 80GB -or $existingVhd.VhdType.ToString() -ne 'Dynamic' -or $existingVhd.ParentPath) {
            throw 'Resume requires the unmounted, standalone 80 GB dynamic test disk.'
        }
        $attachedElsewhere = @(Get-VM | Get-VMHardDiskDrive | Where-Object Path -eq $vhdPath)
        if ($attachedElsewhere.Count) { throw 'The test disk is already attached to another VM.' }
        Write-TestState 'validating-applied-image-for-resume'
        $mountedVhd = Mount-VHD -Path $vhdPath -NoDriveLetter -PassThru
        $vhdMountedByThisScript = $true
        $disk = Get-Disk -Number $mountedVhd.DiskNumber
        if ($disk.IsBoot -or $disk.IsSystem -or $disk.PartitionStyle -ne 'GPT' -or $disk.Number -ne (Get-VHD -Path $vhdPath).DiskNumber) {
            throw 'Resume disk identity is not the recorded non-system GPT VHD.'
        }
        $partitions = @(Get-Partition -DiskNumber $disk.Number)
        $efi = @($partitions | Where-Object { $_.GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -and $_.Size -eq 260MB })
        $msr = @($partitions | Where-Object { $_.GptType -eq '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' -and $_.Size -in @(16MB, 16759808) })
        $osPartition = @($partitions | Where-Object { $_.GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' -and $_.Size -gt 79GB })
        # The first helper revision added a second MSR after Windows had already
        # created one. Accept only that exact, inspected four-partition layout;
        # it is safe to boot and is never reformatted by Resume.
        $legacyLayout = $partitions.Count -eq 4 -and $efi.Count -eq 1 -and $msr.Count -eq 2 -and $osPartition.Count -eq 1
        if ($legacyLayout) {
            $legacyLayout = @($msr | Where-Object { $_.PartitionNumber -eq 1 -and $_.Size -eq 16759808 }).Count -eq 1 -and
                $efi[0].PartitionNumber -eq 2 -and
                @($msr | Where-Object { $_.PartitionNumber -eq 3 -and $_.Size -eq 16MB }).Count -eq 1 -and
                $osPartition[0].PartitionNumber -eq 4 -and $osPartition[0].Size -eq 85592113152
        }
        $standardLayout = $partitions.Count -eq 3 -and $efi.Count -eq 1 -and $msr.Count -eq 1 -and $osPartition.Count -eq 1
        if (-not $standardLayout -and -not $legacyLayout) {
            throw 'Resume disk partition geometry differs from the new test disk.'
        }
        $efiVolume = $efi[0] | Get-Volume
        $osVolume = $osPartition[0] | Get-Volume
        # FAT labels allow at most 11 characters. The original long label was
        # omitted by Format-Volume; tolerate blank only for the exact old layout.
        $validEfiLabel = $efiVolume.FileSystemLabel -eq 'DVM_EFI' -or ($legacyLayout -and [string]::IsNullOrEmpty($efiVolume.FileSystemLabel))
        if (-not $validEfiLabel -or $efiVolume.FileSystem -ne 'FAT32' -or $osVolume.FileSystemLabel -ne 'DVM_TEST_WINDOWS' -or $osVolume.FileSystem -ne 'NTFS') {
            throw 'Resume disk volume labels or filesystems differ from the recorded test disk.'
        }
        $usedLetters = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter }) + @(Get-PSDrive -PSProvider FileSystem | ForEach-Object Name)
        $letters = @([char[]]'ZYXWVUTSRQPONMLKJIHGF' | Where-Object { $usedLetters -notcontains [string]$_ })
        if ($letters.Count -lt 2) { throw 'Two unused temporary drive letters are required.' }
        $efiLetter = [char]$letters[0]
        $osLetter = [char]$letters[1]
        Set-Partition -DiskNumber $disk.Number -PartitionNumber $efi[0].PartitionNumber -NewDriveLetter $efiLetter
        Set-Partition -DiskNumber $disk.Number -PartitionNumber $osPartition[0].PartitionNumber -NewDriveLetter $osLetter
        $osRoot = '{0}:\' -f $osLetter
        foreach ($relative in @('Windows\System32\ntoskrnl.exe', 'Windows\System32\winload.efi', 'Windows\System32\config\SYSTEM', 'Windows\System32\config\SOFTWARE', 'Windows\System32\oobe\msoobe.exe')) {
            $imageFile = Join-Path $osRoot $relative
            if (-not (Test-Path -LiteralPath $imageFile -PathType Leaf) -or (Get-Item -LiteralPath $imageFile).Length -eq 0) { throw "Applied image is incomplete: $relative" }
        }
        if ((Test-Path -LiteralPath (Join-Path $osRoot 'DVMTest')) -or (Test-Path -LiteralPath (Join-Path $osRoot 'Windows\Panther\unattend.xml')) -or (Test-Path -LiteralPath (Join-Path $osRoot 'Users\dvmtest'))) {
            throw 'Resume refuses a disk that has already entered guest test preparation.'
        }
        $kernel = Get-Item -LiteralPath (Join-Path $osRoot 'Windows\System32\ntoskrnl.exe')
        $expectedVersion = [version]$state.imageVersion
        $kernelVersion = $kernel.VersionInfo
        $compatibleBuilds = @($expectedVersion.Build)
        # Windows 11 25H2 uses 24H2 servicing binaries plus its enablement package.
        if ($expectedVersion.Build -eq 26200) { $compatibleBuilds += 26100 }
        if ($kernelVersion.FileMajorPart -ne 10 -or $kernelVersion.FileMinorPart -ne 0 -or $kernelVersion.FileBuildPart -notin $compatibleBuilds -or $kernelVersion.FilePrivatePart -ne $expectedVersion.Revision) {
            throw 'Applied Windows kernel version does not match the recorded ISO image.'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $kernel.FullName
        if ($signature.Status.ToString() -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
            throw 'Applied Windows kernel does not have a valid Microsoft signature.'
        }
        $state['resumedImageKernelVersion'] = $kernelVersion.FileVersion
        Write-TestState 'applied-image-validated'
    }
    # Host DISM can fail to inspect a freshly applied Windows image before its
    # first boot. The guest harness MUST record an online, disabled-feature and
    # empty-distribution Baseline before it can call the application installer.

    Write-TestState 'preparing-isolated-guest'
    $passwordBytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($passwordBytes) } finally { $rng.Dispose() }
    $guestPassword = 'Dvm!' + [Convert]::ToBase64String($passwordBytes) + '9a'
    $guestCredential = New-Object Management.Automation.PSCredential('dvmtest', (ConvertTo-SecureString $guestPassword -AsPlainText -Force))
    $guestCredential | Export-Clixml -LiteralPath $credentialPath
    $escapedPassword = [Security.SecurityElement]::Escape($guestPassword)
    $locale = $imageSpec.locale
    $answerFile = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>DVM-WSL-TEST</ComputerName><TimeZone>Korea Standard Time</TimeZone>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>en-US</InputLocale><SystemLocale>$locale</SystemLocale><UILanguage>$locale</UILanguage><UserLocale>$locale</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><LocalAccounts><LocalAccount xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" wcm:action="add"><Password><Value>$escapedPassword</Value><PlainText>true</PlainText></Password><Description>Disposable DarkVideoManager setup test account</Description><DisplayName>DVM Test</DisplayName><Group>Administrators</Group><Name>dvmtest</Name></LocalAccount></LocalAccounts></UserAccounts>
      <AutoLogon><Password><Value>$escapedPassword</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>5</LogonCount><Username>dvmtest</Username></AutoLogon>
    </component>
  </settings>
</unattend>
"@
    $panther = Join-Path $osRoot 'Windows\Panther'
    New-Item -ItemType Directory -Path $panther -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $panther 'unattend.xml'), $answerFile, (New-Object Text.UTF8Encoding($false)))
    $answerFile = $null
    $guestPassword = $null
    $escapedPassword = $null
    $guestPayload = Join-Path $osRoot 'DVMTest'
    New-Item -ItemType Directory -Path $guestPayload | Out-Null
    Get-ChildItem -LiteralPath $payload -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $guestPayload -Recurse }
    [ordered]@{ vmName = $VMName; computerName = 'DVM-WSL-TEST'; createdAt = $state.createdAt; isoSha256 = $isoHash } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $guestPayload 'fresh-vm.json') -Encoding UTF8
    & (Join-Path $env:SystemRoot 'System32\bcdboot.exe') (Join-Path $osRoot 'Windows') /s ('{0}:' -f $efiLetter) /f UEFI | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'BCDBoot could not prepare the new VM EFI partition.' }
    Dismount-VHD -Path $vhdPath
    $vhdMountedByThisScript = $false

    Write-TestState 'creating-test-vm'
    if (@(Get-VM | Where-Object Name -eq $VMName).Count) { throw 'VM name became occupied during preparation; refusing to reuse it.' }
    $vm = New-VM -Name $VMName -Generation 2 -MemoryStartupBytes $MemoryStartupBytes -VHDPath $vhdPath -Path $vmRoot -SwitchName $switch[0].Name
    $state.vmId = $vm.Id.ToString()
    Write-TestState 'configuring-test-vm'
    Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Standard -AutomaticCheckpointsEnabled $false
    Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
    Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true
    Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
    Enable-VMTPM -VM $vm
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice (Get-VMHardDiskDrive -VM $vm)
    # PowerShell Direct and Copy-Item -ToSession do not need the separately
    # disabled Guest Service Interface (whose display name is localized).
    Write-TestState 'starting-test-vm'
    Start-VM -VM $vm | Out-Null
    Write-TestState 'running-awaiting-windows-setup'
} catch {
    $state.error = $_.Exception.Message
    Write-TestState 'failed'
    throw
} finally {
    if ($vhdMountedByThisScript) {
        Assert-ChildPath $vhdPath $StorePath | Out-Null
        Dismount-VHD -Path $vhdPath -ErrorAction Continue
    }
    if ($isoMountedByThisScript) { Dismount-DiskImage -ImagePath $ISOPath -ErrorAction Continue | Out-Null }
}
