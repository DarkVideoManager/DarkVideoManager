[CmdletBinding()]
param([string]$Distribution = 'Ubuntu-24.04', [switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$finalizer = Join-Path $PSScriptRoot 'finalize-media.cjs'
function Test-Av1Decoder {
    $ffmpeg = Join-Path $repository 'resources/media/win32-x64/ffmpeg.exe'
    $decoders = & $ffmpeg -hide_banner -decoders 2>&1
    return $LASTEXITCODE -eq 0 -and (($decoders -join "`n") -match '(?m)^\s*V\S*\s+libdav1d\s')
}
if (-not $Rebuild) {
    & node $finalizer --verify --quiet
    if ($LASTEXITCODE -eq 0 -and (Test-Av1Decoder)) { Write-Host 'Verified media runtime with AV1 software decoding and corresponding sources is already installed.'; exit 0 }
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'A verified media artifact or WSL Ubuntu 24.04 is required. See docs/media-build.md.'
}
$linuxRepository = (& wsl.exe --distribution $Distribution --exec wslpath -a $repository).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRepository) { throw "Cannot access the repository from WSL distribution $Distribution." }
& wsl.exe --distribution $Distribution --exec bash "$linuxRepository/scripts/build-media.sh" $linuxRepository
if ($LASTEXITCODE -ne 0) { throw 'Media source build failed. See the reported log and docs/media-build.md.' }
& node $finalizer
if ($LASTEXITCODE -ne 0) { throw 'Media source/binary verification failed.' }
if (-not (Test-Av1Decoder)) { throw 'The media runtime is missing the required libdav1d AV1 software decoder.' }
Write-Host 'Pinned media runtime and corresponding-source archive are ready.'
