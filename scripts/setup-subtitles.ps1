[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Distribution = 'Ubuntu-24.04',
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3')]
    [string]$Model = 'base',
    [switch]$SkipModelDownload
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is required. Install Ubuntu-24.04 in WSL first.'
}

# Feed fixed Python source on stdin instead of embedding shell commands or paths.
# A dedicated user environment avoids changing system Python or the reference app.
$bootstrap = @'
import pathlib
import subprocess
import sys
import tempfile
import urllib.request
import venv

environment = pathlib.Path.home() / '.local/share/dark-video-manager/venv'
python = environment / 'bin/python'
environment.parent.mkdir(parents=True, exist_ok=True)
if not python.exists():
    try:
        venv.EnvBuilder(with_pip=True).create(environment)
    except Exception:
        # Some Ubuntu installations omit python3-venv. virtualenv's official
        # zipapp provides a user-only fallback without sudo or apt changes.
        with tempfile.TemporaryDirectory(prefix='dvm-setup-') as directory:
            archive = pathlib.Path(directory) / 'virtualenv.pyz'
            urllib.request.urlretrieve('https://bootstrap.pypa.io/virtualenv.pyz', archive)
            subprocess.run([sys.executable, str(archive), str(environment)], check=True)
else:
    # A prior interrupted venv creation may have left Python without pip.
    probe = subprocess.run([str(python), '-m', 'pip', '--version'], capture_output=True)
    if probe.returncode:
        with tempfile.TemporaryDirectory(prefix='dvm-setup-') as directory:
            archive = pathlib.Path(directory) / 'virtualenv.pyz'
            urllib.request.urlretrieve('https://bootstrap.pypa.io/virtualenv.pyz', archive)
            subprocess.run([sys.executable, str(archive), str(environment)], check=True)
# PyAV 19 removed av.open(metadata_errors=...), used by faster-whisper 1.2.
subprocess.run([str(python), '-m', 'pip', 'install', 'faster-whisper==1.2.1', 'av>=11,<16', 'requests>=2.32,<3'], check=True)
subprocess.run([str(python), '-c', 'import faster_whisper; import requests; print("Subtitle dependencies are ready")'], check=True)
print('Python: ' + str(python), flush=True)
'@

Write-Host "Installing the subtitle engine in WSL ($Distribution)..."
$bootstrap | & wsl.exe --distribution $Distribution --exec python3 -
if ($LASTEXITCODE -ne 0) {
    throw 'Subtitle setup failed. Check that this WSL distribution has Python 3 and internet access.'
}

if (-not $SkipModelDownload) {
    # Model is a ValidateSet value passed as an argv item, never shell source.
    $download = @'
import pathlib
import subprocess
import sys
python = pathlib.Path.home() / '.local/share/dark-video-manager/venv/bin/python'
subprocess.run([str(python), '-c', 'from faster_whisper import WhisperModel; import sys; WhisperModel(sys.argv[1], device="cpu", compute_type="int8"); print("Subtitle model is ready")', sys.argv[1]], check=True)
'@
    Write-Host "Downloading and checking the $Model speech model..."
    $download | & wsl.exe --distribution $Distribution --exec python3 - $Model
    if ($LASTEXITCODE -ne 0) {
        throw 'Dependencies are installed, but the model download failed. Run this setup again when the network is available.'
    }
}
Write-Host 'Subtitle setup completed.'
