[CmdletBinding()]
param(
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3')]
    [string]$Model = 'base',
    [switch]$SkipModelDownload
)

# No administrator rights, global packages, PATH edits, or Vulkan SDK installer.
# Build tools are cached per user; only the resulting runtime is packaged.
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$subtitles = Join-Path $repository 'resources/subtitles'
$cache = Join-Path $env:LOCALAPPDATA 'DarkVideoManager/subtitles'
$downloads = Join-Path $cache 'downloads'
$buildTools = Join-Path $cache 'build-tools'
$native = Join-Path $subtitles 'native'
# Public CA data is source-controlled so a fresh Windows Python can validate HTTPS
# before Windows has fetched additional roots. Do not modify the OS trust store.
$certificateManifest = Get-Content -LiteralPath (Join-Path $subtitles 'certificates/manifest.json') -Raw | ConvertFrom-Json
$certificateBundle = Join-Path $subtitles 'certificates/mozilla-ca.crt'
if (-not (Test-Path -LiteralPath $certificateBundle) -or (Get-FileHash -LiteralPath $certificateBundle -Algorithm SHA256).Hash -ne $certificateManifest.sha256) {
    throw 'The bundled public CA data is missing or damaged. Restore resources/subtitles/certificates from the source checkout.'
}
New-Item -ItemType Directory -Force $downloads, $buildTools, $native | Out-Null

function Get-CheckedDownload([string]$Url, [string]$Name, [string]$Sha256) {
    $target = Join-Path $downloads $Name
    if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $Sha256) {
        return $target
    }
    Write-Host "Downloading $Name..."
    $partial = "$target.partial"
    & curl.exe --location --fail --silent --show-error --retry 3 --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Name" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
        throw "SHA256 mismatch: $Name. The downloaded file was not used."
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    return $target
}

function Expand-CheckedArchive([string]$Archive, [string]$Name) {
    $destination = Join-Path $buildTools $Name
    $marker = Join-Path $destination '.dvm-extracted'
    $archiveHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $archiveHash) {
        New-Item -ItemType Directory -Force $destination | Out-Null
        Write-Host "Extracting $Name..."
        & tar.exe -xf $Archive -C $destination
        if ($LASTEXITCODE -ne 0) { throw "Extraction failed: $Name" }
        [IO.File]::WriteAllText($marker, $archiveHash)
    }
    return $destination
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Program" }
}

$pythonZip = Get-CheckedDownload 'https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip' 'python-3.13.12-embed-amd64.zip' '76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0'
$pythonDir = Join-Path $native 'python'
New-Item -ItemType Directory -Force $pythonDir | Out-Null
Invoke-Checked 'tar.exe' @('-xf', $pythonZip, '-C', $pythonDir)
# Embedded Python is intentionally isolated. The worker imports its sibling module.
[IO.File]::WriteAllText((Join-Path $pythonDir 'python313._pth'), "python313.zip`n.`n..\..`n", [Text.UTF8Encoding]::new($false))

$llvmZip = Get-CheckedDownload 'https://github.com/mstorsjo/llvm-mingw/releases/download/20261006/llvm-mingw-20261006-ucrt-x86_64.zip' 'llvm-mingw-20261006-ucrt-x86_64.zip' '317492c456aa27ee607a5919f1d2d38dcdc1112516a24d0bf4b00d078f52d17a'
$cmakeZip = Get-CheckedDownload 'https://github.com/Kitware/CMake/releases/download/v4.4.4/cmake-4.4.4-windows-x86_64.zip' 'cmake-4.4.4-windows-x86_64.zip' 'bace36e94b31c68ab6fa295f26dfa11219e0701cf7c94b0284a7d1cb13dac536'
$ninjaZip = Get-CheckedDownload 'https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip' 'ninja-win-1.13.2.zip' '07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65'
$shadercZip = Get-CheckedDownload 'https://storage.googleapis.com/shaderc/artifacts/prod/graphics_shader_compiler/shaderc/windows-vs2022-amd64-release/continuous/48/20261001-205140/install.zip' 'shaderc-20261001.zip' '62615a97a79a708b07c4034b8d1ddf0f369ce0b91778a1f380256f77b1301182'
$whisperZip = Get-CheckedDownload 'https://github.com/ggml-org/whisper.cpp/archive/d1be6fde11ac6e0407606b4e42fe72d34add8037.zip' 'whisper-b5454.zip' '6be93b881acb415c5a25d0ef85bb6a488099de0296e072e22a66d50f20ec40b9'
$headersZip = Get-CheckedDownload 'https://github.com/KhronosGroup/Vulkan-Headers/archive/c46850864f4661461b0f6cb9922c058ffea4915e.zip' 'vulkan-headers.zip' '45fd1cbfba537884f8a54d5dc2a69cb18de42fd94e84dc6a9bf66b5df829d79a'
$hppZip = Get-CheckedDownload 'https://github.com/KhronosGroup/Vulkan-Hpp/archive/b6df07f1e6a695625e72a0457eb2893ba22313fe.zip' 'vulkan-hpp.zip' '3a79a4209e086ea2ae7295007f835bfaa06f4f879c465257a905b3170c83c3a9'
$spirvZip = Get-CheckedDownload 'https://github.com/KhronosGroup/SPIRV-Headers/archive/86f980c731e62ae4eaf383d320449d71687936bf.zip' 'spirv-headers.zip' '5abe65f980fad5c3365a1060acf3f16c552dea41db40aae54a27dfbebb840995'
$ggmlLicense = Get-CheckedDownload 'https://raw.githubusercontent.com/ggml-org/ggml/v0.26.0/LICENSE' 'ggml-0.26.0-LICENSE.txt' '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'

$llvm = Join-Path (Expand-CheckedArchive $llvmZip 'llvm-mingw-20261006-ucrt-x86_64') 'llvm-mingw-20261006-ucrt-x86_64'
$cmakeRoot = Join-Path (Expand-CheckedArchive $cmakeZip 'cmake-4.4.4-windows-x86_64') 'cmake-4.4.4-windows-x86_64'
$ninja = Expand-CheckedArchive $ninjaZip 'ninja-win-1.13.2'
$shaderc = Expand-CheckedArchive $shadercZip 'shaderc-20261001'
$source = Join-Path (Expand-CheckedArchive $whisperZip 'whisper-b5454') 'whisper.cpp-d1be6fde11ac6e0407606b4e42fe72d34add8037'
# b5454 common.cpp uses std::partial_sort without directly including algorithm.
# libc++ 23 no longer exposes it through unrelated transitive headers.
$commonSource = Join-Path $source 'examples/common.cpp'
$commonText = [IO.File]::ReadAllText($commonSource)
if (-not $commonText.Contains('#include <algorithm>')) {
    [IO.File]::WriteAllText($commonSource, "#include <algorithm>`n" + $commonText, [Text.UTF8Encoding]::new($false))
}
$headers = Join-Path (Expand-CheckedArchive $headersZip 'vulkan-headers') 'Vulkan-Headers-c46850864f4661461b0f6cb9922c058ffea4915e'
$hpp = Join-Path (Expand-CheckedArchive $hppZip 'vulkan-hpp') 'Vulkan-Hpp-b6df07f1e6a695625e72a0457eb2893ba22313fe'
$spirv = Join-Path (Expand-CheckedArchive $spirvZip 'spirv-headers') 'SPIRV-Headers-86f980c731e62ae4eaf383d320449d71687936bf'
$cmake = Join-Path $cmakeRoot 'bin/cmake.exe'
$glslc = (Get-ChildItem -LiteralPath $shaderc -Filter 'glslc.exe' -File -Recurse | Select-Object -First 1).FullName
if (-not $glslc) { throw 'The pinned shaderc archive does not contain glslc.exe.' }

$sdk = Join-Path $buildTools 'vulkan-sdk'
$sdkInclude = Join-Path $sdk 'include'
$sdkLib = Join-Path $sdk 'lib'
New-Item -ItemType Directory -Force $sdkInclude, $sdkLib | Out-Null
Copy-Item -Path (Join-Path $headers 'include/*') -Destination $sdkInclude -Recurse -Force
Copy-Item -Path (Join-Path $hpp 'vulkan/*') -Destination (Join-Path $sdkInclude 'vulkan') -Recurse -Force
Copy-Item -Path (Join-Path $spirv 'include/*') -Destination $sdkInclude -Recurse -Force
# Link the four Vulkan loader exports referenced by this pinned ggml build.
# The Vulkan loader itself comes from the user's graphics driver and is not bundled.
$vulkanDef = Join-Path $sdkLib 'vulkan-1.def'
[IO.File]::WriteAllText($vulkanDef, "LIBRARY vulkan-1.dll`nEXPORTS`nvkGetInstanceProcAddr`nvkGetDeviceProcAddr`nvkGetPhysicalDeviceFeatures2`nvkCmdCopyBuffer`n")
$vulkanLibrary = Join-Path $sdkLib 'libvulkan-1.a'
Invoke-Checked (Join-Path $llvm 'bin/llvm-dlltool.exe') @('-m', 'i386:x86-64', '-d', $vulkanDef, '-l', $vulkanLibrary)

$previousPath = $env:PATH
$previousCC = $env:CC
$previousCXX = $env:CXX
try {
    $env:PATH = "$(Join-Path $llvm 'bin');$(Join-Path $cmakeRoot 'bin');$ninja;$env:PATH"
    $env:CC = Join-Path $llvm 'bin/clang.exe'
    $env:CXX = Join-Path $llvm 'bin/clang++.exe'
    $spirvBuild = Join-Path $buildTools 'spirv-build'
    Invoke-Checked $cmake @('-S', $spirv, '-B', $spirvBuild, '-G', 'Ninja', "-DCMAKE_INSTALL_PREFIX=$sdk", '-DSPIRV_HEADERS_ENABLE_TESTS=OFF')
    Invoke-Checked $cmake @('--install', $spirvBuild)
    $build = Join-Path $buildTools 'whisper-vulkan-build'
    Write-Host 'Building pinned whisper.cpp with the Vulkan GPU backend...'
    # Keep local usernames and checkout paths out of assertion strings and debug data.
    $pathMaps = @(
        "$(($buildTools -replace '\\', '/'))=/dvm-build",
        "$(($repository -replace '\\', '/'))=/dvm-source"
    )
    $portableCompilerFlags = ($pathMaps | ForEach-Object {
        '-ffile-prefix-map="' + $_ + '" -fdebug-prefix-map="' + $_ + '"'
    }) -join ' '
    Invoke-Checked $cmake @('-S', $source, '-B', $build, '-G', 'Ninja', "-DCMAKE_C_FLAGS=$portableCompilerFlags", "-DCMAKE_CXX_FLAGS=$portableCompilerFlags", '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_C_COMPILER=$env:CC", "-DCMAKE_CXX_COMPILER=$env:CXX", '-DCMAKE_EXE_LINKER_FLAGS=-static', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_VULKAN=ON', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', "-DVulkan_INCLUDE_DIR=$sdkInclude", "-DVulkan_LIBRARY=$vulkanLibrary", "-DVulkan_GLSLC_EXECUTABLE=$glslc", "-DCMAKE_PREFIX_PATH=$sdk")
    Invoke-Checked $cmake @('--build', $build, '--target', 'whisper-cli', '--parallel', '4')
    $whisperDir = Join-Path $native 'whisper'
    New-Item -ItemType Directory -Force $whisperDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $build 'bin/whisper-cli.exe') -Destination (Join-Path $whisperDir 'whisper-cli.exe') -Force
    $licenses = Join-Path $native 'licenses'
    New-Item -ItemType Directory -Force $licenses | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $licenses 'whisper.cpp-LICENSE.txt') -Force
    Copy-Item -LiteralPath $ggmlLicense -Destination (Join-Path $licenses 'ggml-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $hpp 'LICENSE.txt') -Destination (Join-Path $licenses 'Vulkan-Hpp-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $llvm 'LICENSE.TXT') -Destination (Join-Path $licenses 'LLVM-MinGW-LICENSE.txt') -Force
    Get-ChildItem -LiteralPath (Join-Path $llvm 'x86_64-w64-mingw32/share/mingw32') -Filter 'COPYING*' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenses "MinGW-$($_.Name)") -Force
    }
    Copy-Item -LiteralPath (Join-Path $spirv 'LICENSE') -Destination (Join-Path $licenses 'SPIRV-Headers-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $headers 'LICENSE.md') -Destination (Join-Path $licenses 'Vulkan-Headers-LICENSE.md') -Force
    foreach ($licenseGroup in @(@('Vulkan-Headers', $headers), @('Vulkan-Hpp', $hpp), @('SPIRV-Headers', $spirv))) {
        $licenseDirectory = Join-Path $licenses $licenseGroup[0]
        New-Item -ItemType Directory -Force $licenseDirectory | Out-Null
        Copy-Item -Path (Join-Path $licenseGroup[1] 'LICENSES/*') -Destination $licenseDirectory -Force
    }
    [IO.File]::WriteAllText((Join-Path $native 'runtime-version.json'), "{`"whisperRevision`":`"b5454`",`"whisperCommit`":`"d1be6fde11ac6e0407606b4e42fe72d34add8037`",`"pythonVersion`":`"3.13.12`",`"backend`":`"vulkan`"}`n")
} finally {
    $env:PATH = $previousPath
    $env:CC = $previousCC
    $env:CXX = $previousCXX
}

if (-not $SkipModelDownload) {
    $manifest = Get-Content -LiteralPath (Join-Path $subtitles 'gpu-models.json') -Raw | ConvertFrom-Json
    $modelsDir = Join-Path $cache 'models'
    New-Item -ItemType Directory -Force $modelsDir | Out-Null
    foreach ($asset in @($manifest.models.$Model, $manifest.vad)) {
        $target = Join-Path $modelsDir $asset.filename
        if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target).Hash -eq $asset.sha256) { continue }
        $download = Get-CheckedDownload $asset.url $asset.filename $asset.sha256
        Copy-Item -LiteralPath $download -Destination $target -Force
    }
}
Invoke-Checked (Join-Path $pythonDir 'python.exe') @('-X', 'utf8', '-c', 'import sys, wave, generate, whisper_vulkan, download_tls; download_tls.create_download_context(); print(sys.version.split()[0])')
Write-Host "GPU subtitle runtime ready: $native"
