# Third-party software

DarkVideoManager's original application code and icon are distributed under the MIT license in [LICENSE](LICENSE). Third-party components keep their own licenses. See [project provenance](docs/PROVENANCE.md).

Build preparation generates `resources/legal/generated/`, which the application packages as `resources/legal/`:

```powershell
node scripts/generate-third-party-notices.cjs --check-release
```

Its `INDEX.md` links to the original copyright and license texts. `inventory.json` records installed npm versions/integrity values, the lockfile hash, Electron version, FFmpeg/FFprobe binary hashes and version reports, and optional native subtitle runtime hashes. React and other dependencies bundled from development dependencies are included. The inventory is a conservative superset, not a claim that every package is linked into every entry point.

In an installed application, `DarkVideoManager-LICENSE.txt`, `INDEX.md` and `DISTRIBUTION.md` are in the same directory as this notice. The repository links in this document refer to the source checkout.

| Component | Notice location in a packaged application | Notes |
| --- | --- | --- |
| JavaScript dependencies | `resources/legal/npm/` | Original package licenses and notices; versions follow the lockfile. |
| Electron, Chromium, Node.js and bundled libraries | `LICENSE`, `LICENSES.chromium.html`, and `resources/legal/electron/` | Retain the notices from the exact Electron distribution. |
| FFmpeg and FFprobe executables | `resources/legal/media/` | GPLv3 builds from the pinned FFmpeg/x264 sources. Publish the paired corresponding-source archive with every public executable release. |
| whisper.cpp, ggml, Vulkan headers, LLVM/MinGW and winpthreads runtime | `resources/subtitles/native/licenses/`, `resources/legal/subtitles/` | Optional native subtitle engine. Pinned source/build recipe: `scripts/setup-subtitles-gpu.ps1`. Vulkan driver/loader is provided by the user's graphics driver. |
| Embedded Python and its bundled libraries | `resources/subtitles/native/python/LICENSE.txt`, `resources/legal/subtitles/Python-LICENSE.txt` | Original Python distribution license collection. |
| certifi Mozilla public CA bundle | `resources/subtitles/certificates/`, `resources/legal/subtitle-certificates/` | Unmodified certifi 2026.7.22 data, MPL-2.0. Source URL and SHA256 receipt accompany the bundle; used for process-local HTTPS validation on Windows. |

Model weights (Whisper and Silero VAD) are downloaded separately into the user's cache and are not bundled in the application. Their pinned URLs and checksums are in `resources/subtitles/gpu-models.json`. The optional WSL environment installs faster-whisper and its dependencies separately; do not copy that environment or model cache into a release without collecting their exact licenses and notices.

This notice does not relicense third-party software under MIT or determine that the entire application is GPL merely because it launches a separate FFmpeg process. Distribution conditions for the actual combination still apply. See [release obligations and verification](docs/third-party-licenses.md).
