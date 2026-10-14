[CmdletBinding()]
param([string]$Distribution = 'Ubuntu-24.04', [switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$finalizer = Join-Path $PSScriptRoot 'finalize-media.cjs'
if (-not $Rebuild) {
    & node $finalizer --verify --quiet
    if ($LASTEXITCODE -eq 0) { Write-Host 'Verified media runtime and corresponding sources are already installed.'; exit 0 }
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
Write-Host 'Pinned media runtime and corresponding-source archive are ready.'
