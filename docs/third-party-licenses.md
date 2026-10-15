# Third-party license and source distribution procedure

## Application and dependencies

The original DarkVideoManager application and icon use the repository's MIT license. Ownership confirmation is recorded in [PROVENANCE.md](PROVENANCE.md). Dependencies retain their own licenses. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is the entry point to the exact-version notices included in each executable distribution.

After dependency installation and after rebuilding any native runtime, run:

```powershell
node scripts/generate-third-party-notices.cjs --check-release
```

The generator reads the installed production dependency closure and runtime imports, including React and other packages bundled from development dependencies. It copies original LICENSE/COPYING/NOTICE files, the exact Electron/Chromium notices, actual media executable version/license reports, and optional subtitle runtime notices. It records lockfile integrity values and SHA256 hashes in `resources/legal/generated/inventory.json`. No license text is invented from an SPDX identifier. Supplemental upstream notices for npm packages that omit their license file are versioned under `resources/legal/upstream/`.

Missing notices, unrecognized media license reports, incomplete optional native runtimes, or absent/mismatched corresponding-source receipts fail the release check. A build with no optional native subtitle runtime is valid. A partial native runtime is rejected. The inventory is a conservative superset of code included after tree shaking.

## Media executables and their corresponding source

The release build uses the controlled source recipe in [media-build.md](media-build.md) and `resources/media-manifest.json`. It builds **FFmpeg and FFprobe 9.0.2 together**, with the pinned x264 encoder and dav1d 1.5.4 AV1 software decoder. Autodetection of host libraries is disabled; x264 and dav1d are the enabled external codec libraries. The configuration enables GPL and version 3; the resulting media executables are GPL-3.0-or-later. dav1d's BSD 2-Clause notice is retained in `dav1d-COPYING.txt`. Codec and build-tool sources, exact build scripts, dependency inventory, source hashes and original notices are preserved together.

`scripts/finalize-media.cjs` creates these paired release artifacts:

- `release/sources/dvm-media-corresponding-source.tar.gz`
- `release/sources/BUILD.md`
- `release/sources/dependencies.json`
- `resources/legal/media-source-receipts.json`

The source archive includes the actual unmodified FFmpeg, x264 and dav1d archives used by the build, NASM/Meson/Ninja build-tool sources, the build and finalization scripts, the pinned compiler download receipt, all media license texts and the dependency inventory. The cross compiler is a generally available build tool. The exact downloadable compiler archive and hash are specified; its LLVM and MinGW runtime notices are retained. No recovered native media executable is used in this recipe.

Receipts bind **each executable SHA256** to the SHA256 of its matching source archive, build instructions and dependency inventory. `node scripts/finalize-media.cjs --verify` verifies the current binaries, source files, recipe and notices after an artifact is copied or before packaging. `--check-release` independently compares receipts against the actual executables being packaged. A checksum does not itself establish legal completeness; the controlled recipe and its dependency inventory provide the reviewable source/build evidence.

Publish the source archive, BUILD.md and dependencies.json **on the same release page as the application download**, with equivalent access at no additional charge and a clear source link. GPLv3 section 6(d) provides a route for network distribution on that basis. Packaging locally does not publish those files. Preserve access for the binary version being distributed. Do not point users to a latest/unrelated source tree, reuse another build's source receipts, or replace source availability with a generic promise.

Older local `dist-electron/` builds containing recovered Gyan FFmpeg 6.1.1 and FFprobe 4.0.2 are not the source-controlled release build. Their mixed static dependency source sets were not established; do not publish those old packages under the new release's receipts. Their top-level GPL text or the old ffprobe npm wrapper's MIT license does not replace the executable's source obligations.

Launching a separate GPL media program does not, by itself, establish that every line of the application's original code must be relicensed. Keep the original MIT license and each component's applicable conditions; review the actual distribution arrangement if changing how these programs are combined.

## Native subtitles and separately installed components

`scripts/setup-subtitles-gpu.ps1` pins and hashes whisper.cpp, Vulkan and SPIR-V headers, compiler/tool archives and embedded Python. It documents the `common.cpp` include patch and CMake flags. Original whisper.cpp, ggml, LLVM, MinGW, winpthreads, Vulkan and SPIR-V notices are retained with the runtime. Embedded Python's original LICENSE.txt includes its third-party notices. The generator copies these files and records the built executables/DLL hashes. Graphics drivers and the Vulkan loader are supplied by the user's system and are not bundled.

`resources/subtitles/certificates/mozilla-ca.crt` is the unmodified Mozilla public CA bundle from the pinned certifi wheel recorded in the adjacent `manifest.json`. The `.crt` file contains the original `certifi/cacert.pem` bytes. Its certifi notice and complete MPL-2.0 license are included in source and executable distributions. The notice generator verifies the bundle hash and copies its provenance and notices into `subtitle-certificates/`. The Windows download worker verifies its own pinned hash before supplementing process-local TLS trust; it does not modify the Windows trust store.

When updating this bundle, verify the new official PyPI wheel hash, extract the unmodified bundle and original license, and update the source receipt and `download_tls.py` hash together. Preserve the bundle's exact bytes and run `test_download_tls.py` and the release notice check. No certifi Python package is installed by the application.

Whisper and Silero VAD model files are downloaded separately into the user's cache. Their pinned locations and checksums are in `resources/subtitles/gpu-models.json`; this release does not bundle those model files. The optional WSL environment installs faster-whisper and its dependencies separately. Review exact licenses and notices before deciding to redistribute that environment, model weights or an external player. They must not be silently copied into an application release.

## Primary references

- [FFmpeg legal guidance](https://ffmpeg.org/legal.html): license depends on build configuration; exact matching sources and build instructions matter.
- [GNU GPLv3, including sections 1 and 6](https://www.gnu.org/licenses/gpl-3.0.html): corresponding source and object-code distribution conditions.
- [FFmpeg source releases](https://ffmpeg.org/releases/): original FFmpeg release archives.
- [x264 source repository](https://code.videolan.org/videolan/x264): encoder source and license.
- [LLVM-MinGW](https://github.com/mstorsjo/llvm-mingw): pinned portable cross compiler and its component notices.
- [Electron](https://github.com/electron/electron): retain the exact distribution's license and Chromium notices.
