[CmdletBinding()]
param(
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [string]$StorePath = 'F:\DarkVideoManager-TestVM-20261014',
    [ValidatePattern('^DVM-Fresh-WSL-[A-Za-z0-9-]+$')]
    [string]$VMName = 'DVM-Fresh-WSL-20261014',
    [ValidateRange(64, 4096)][int]$Width = 1024,
    [ValidateRange(64, 4096)][int]$Height = 768
)

# Read-only Hyper-V console capture for the recorded disposable VM. No host-screen
# capture, keyboard/mouse input, guest commands, VM state changes, or disk mounts.
# The only writes are the PNG and its identity metadata under test-results.
# Official API and RGB565 output format:
# https://learn.microsoft.com/windows/win32/hyperv_v2/getvirtualsystemthumbnailimage-msvm-virtualsystemmanagementservice
# Current settings are selected through Msvm_SettingsDefineState, not snapshots:
# https://learn.microsoft.com/windows/win32/hyperv_v2/msvm-virtualsystemsettingdata
# Use the same -StorePath and -VMName as test-fresh-windows-run.ps1, for example:
# powershell -NoProfile -File scripts/capture-fresh-windows-console.ps1 -StorePath $testStore -VMName $testVM
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [IO.Path]::IsPathRooted($StorePath)) { throw 'Test storage must be an absolute path.' }
$StorePath = [IO.Path]::GetFullPath($StorePath).TrimEnd('\')
$expectedName = $VMName
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $StorePath $VMName))
if (-not $expectedRoot.StartsWith($StorePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'VM directory escapes the dedicated test storage.'
}
$expectedDisk = Join-Path $expectedRoot 'disk.vhdx'
$manifestPath = Join-Path $expectedRoot 'vm.json'

function Assert-NoLinks([string]$Path) {
    $ancestor = [IO.Path]::GetFullPath($Path)
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and
            ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Links and junctions are refused for console capture paths.'
        }
        $parent = Split-Path -Parent $ancestor
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'An elevated Windows PowerShell session is required for Hyper-V thumbnail access.'
}
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 for this WMI helper.' }
Import-Module Hyper-V -ErrorAction Stop
foreach ($item in @($expectedRoot, $expectedDisk, $manifestPath)) { Assert-NoLinks $item }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.vmName -ne $expectedName -or
    $manifest.vmRoot -ne $expectedRoot -or $manifest.vhdPath -ne $expectedDisk) {
    throw 'The ownership manifest does not match the requested test VM and storage.'
}
$expectedId = [Guid]::Empty
if (-not [Guid]::TryParse([string]$manifest.vmId, [ref]$expectedId) -or $expectedId -eq [Guid]::Empty) {
    throw 'The ownership manifest must identify a valid test VM ID.'
}
$vm = Get-VM -Id $expectedId -ErrorAction Stop
$disks = @(Get-VMHardDiskDrive -VM $vm)
if ($vm.Name -ne $expectedName -or $disks.Count -ne 1 -or $disks[0].Path -ne $expectedDisk) {
    throw 'VM name or attached disk differs from the exact allowed test VM.'
}
if ($vm.State -ne 'Running') { throw 'The test VM must already be running; this helper never starts it.' }

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$outputRoot = [IO.Path]::GetFullPath((Join-Path $Workspace 'test-results\fresh-windows'))
if (-not $outputRoot.StartsWith($Workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output directory escapes the workspace.'
}
$outputPath = Join-Path $outputRoot 'vm-console.png'
$metadataPath = Join-Path $outputRoot 'vm-console.json'
$diagnosticPath = Join-Path $outputRoot 'vm-console-diagnostic.json'
$temporaryPath = Join-Path $outputRoot ('vm-console-' + [Guid]::NewGuid().ToString('N') + '.tmp')
foreach ($item in @($outputRoot, $outputPath, $metadataPath, $diagnosticPath, $temporaryPath)) { Assert-NoLinks $item }

$namespace = 'root\virtualization\v2'
$computers = @(Get-WmiObject -Namespace $namespace -Class Msvm_ComputerSystem -Filter ("Name='" + $expectedId.ToString() + "'"))
if ($computers.Count -ne 1 -or $computers[0].ElementName -ne $expectedName) {
    throw 'The WMI computer identity differs from the allowed test VM.'
}
$computer = $computers[0]
$settings = @($computer.GetRelated('Msvm_VirtualSystemSettingData', 'Msvm_SettingsDefineState', $null, $null, 'SettingData', 'ManagedElement', $false, $null))
if ($settings.Count -ne 1 -or $settings[0].VirtualSystemIdentifier -ne $expectedId.ToString() -or
    $settings[0].VirtualSystemType -ne 'Microsoft:Hyper-V:System:Realized') {
    throw 'Expected exactly the live settings of the allowed VM, not a snapshot.'
}
$services = @(Get-WmiObject -Namespace $namespace -Class Msvm_VirtualSystemManagementService)
if ($services.Count -ne 1) { throw 'Hyper-V did not expose one local management service.' }
$service = $services[0]
$parameters = $null
$result = $null
try {
    $parameters = $service.GetMethodParameters('GetVirtualSystemThumbnailImage')
    $parameters['TargetSystem'] = $settings[0].Path.Path
    $parameters['WidthPixels'] = [uint16]$Width
    $parameters['HeightPixels'] = [uint16]$Height
    $result = $service.InvokeMethod('GetVirtualSystemThumbnailImage', $parameters, $null)
    $rawImage = $result['ImageData']
    $diagnostic = [ordered]@{
        capturedAt = [DateTime]::UtcNow.ToString('o'); vmId = $expectedId.ToString(); vmName = $expectedName
        requestedWidth = $Width; requestedHeight = $Height; expectedBytes = $Width * $Height * 2
        actualElementCount = $(if ($null -eq $rawImage) { 0 } elseif ($rawImage -is [Array]) { $rawImage.Length } else { 1 })
        imageDataType = $(if ($null -eq $rawImage) { 'null' } else { $rawImage.GetType().FullName })
        firstEightBytes = $(if ($rawImage -is [byte[]] -and $rawImage.Length) { @($rawImage | Select-Object -First 8) } else { @() })
        headerWidthUInt16LE = $(if ($rawImage -is [byte[]] -and $rawImage.Length -ge 4) { [BitConverter]::ToUInt16($rawImage, 0) } else { $null })
        headerHeightUInt16LE = $(if ($rawImage -is [byte[]] -and $rawImage.Length -ge 4) { [BitConverter]::ToUInt16($rawImage, 2) } else { $null })
        headerUInt32LE = $(if ($rawImage -is [byte[]] -and $rawImage.Length -ge 4) { [BitConverter]::ToUInt32($rawImage, 0) } else { $null })
        headerUInt32BE = $(if ($rawImage -is [byte[]] -and $rawImage.Length -ge 4) {
            [uint32]([uint32]$rawImage[0] * 16777216 + [uint32]$rawImage[1] * 65536 + [uint32]$rawImage[2] * 256 + [uint32]$rawImage[3])
        } else { $null })
        returnCode = $result['ReturnValue']; targetSystem = $parameters['TargetSystem']
        actualInputWidth = $parameters['WidthPixels']; actualInputHeight = $parameters['HeightPixels']
        resultProperties = @($result.Properties | ForEach-Object {
            [ordered]@{ name = $_.Name; type = $_.Type.ToString(); isArray = $_.IsArray; isNull = $null -eq $_.Value }
        })
    }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    [IO.File]::WriteAllText($diagnosticPath, ($diagnostic | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    if ([uint32]$result['ReturnValue'] -ne 0) {
        throw ('Hyper-V thumbnail was not returned synchronously. Return code: ' + $result['ReturnValue'])
    }
    [byte[]]$pixels = $rawImage
    $pixelOffset = 0
    $pixelHeader = 'none'
    if ($null -ne $pixels -and $pixels.Length -eq ($Width * $Height * 2 + 4) -and
        $diagnostic.headerUInt32BE -eq $pixels.Length) {
        # This host returns an OctetString with a big-endian total-length prefix,
        # including the four prefix bytes (verified in the real VM diagnostic).
        # Accept it only when BOTH total length and remaining RGB565 size match.
        $pixelOffset = 4
        $pixelHeader = 'validated-total-length-uint32-be'
        $pixels = New-Object byte[] ($Width * $Height * 2)
        [Array]::Copy($rawImage, 4, $pixels, 0, $pixels.Length)
    }
    if ($null -eq $pixels -or $pixels.Length -ne ($Width * $Height * 2)) {
        throw ("Unexpected RGB565 byte count: actual=$($diagnostic.actualElementCount), expected=$($diagnostic.expectedBytes), type=$($diagnostic.imageDataType), returnCode=$($diagnostic.returnCode). See $diagnosticPath")
    }
} finally {
    if ($result) { $result.Dispose() }
    if ($parameters) { $parameters.Dispose() }
    foreach ($setting in $settings) { $setting.Dispose() }
    $computer.Dispose()
    $service.Dispose()
}

# Decode the documented raw little-endian RGB565 pixels without reading any
# desktop or using screen-capture APIs. Pixel conversion only; no image editing.
Add-Type -AssemblyName System.Drawing
if (-not ('DarkVideoManager.TestHarness.ConsolePng' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
namespace DarkVideoManager.TestHarness {
    public static class ConsolePng {
        public static void Save(byte[] source, int width, int height, string path) {
            if (source.Length != checked(width * height * 2)) throw new ArgumentException("Invalid RGB565 length");
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                try {
                    var row = new byte[Math.Abs(data.Stride)];
                    for (int y = 0; y < height; y++) {
                        for (int x = 0; x < width; x++) {
                            int index = (y * width + x) * 2;
                            int value = source[index] | (source[index + 1] << 8);
                            int red = (value >> 11) & 31, green = (value >> 5) & 63, blue = value & 31;
                            row[x * 3] = (byte)((blue << 3) | (blue >> 2));
                            row[x * 3 + 1] = (byte)((green << 2) | (green >> 4));
                            row[x * 3 + 2] = (byte)((red << 3) | (red >> 2));
                        }
                        Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
                    }
                } finally { bitmap.UnlockBits(data); }
                bitmap.Save(path, ImageFormat.Png);
            }
        }
    }
}
'@
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
[DarkVideoManager.TestHarness.ConsolePng]::Save($pixels, $Width, $Height, $temporaryPath)
Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force
$metadata = [ordered]@{
    capturedAt = [DateTime]::UtcNow.ToString('o'); vmName = $expectedName; vmId = $expectedId.ToString()
    attachedDisk = $expectedDisk; vmState = $vm.State.ToString(); width = $Width; height = $Height
    source = 'Hyper-V GetVirtualSystemThumbnailImage'; sourceFormat = 'RGB565'; returnCode = 0
    sourceByteCount = $rawImage.Length; pixelOffset = $pixelOffset; pixelHeader = $pixelHeader
    png = $outputPath; pngSha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    hostScreenCaptured = $false; vmInputOrStateChanged = $false
}
[IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
$metadata | ConvertTo-Json -Depth 4
