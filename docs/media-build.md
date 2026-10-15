# Building and distributing the media executables

DarkVideoManager builds FFmpeg and FFprobe together from the hash-pinned sources in `resources/media-manifest.json`. The enabled external codec libraries are x264 and dav1d 1.5.4. dav1d provides AV1 software decoding without requiring a supported GPU; FFmpeg's native `av1` decoder alone does not provide this. FFmpeg's other built-in decoders, demuxers, filters, native AAC encoder and JPEG encoder remain available. FFplay, network protocols and autodetection of host libraries are disabled. No source patches are applied. This is a reproducible build recipe; byte-for-byte reproducibility across different host systems has not been asserted.

## Windows / WSL

Use Ubuntu 24.04 with `gcc`, `g++`, `make`, `perl`, `python3`, `pkg-config`, `curl`, `tar`, `xz` and `sha256sum` already available. The script checks prerequisites and does not install system packages, request administrator access, or modify system PATH. It downloads a pinned portable Linux LLVM-MinGW cross compiler, builds the pinned NASM and Ninja tools in the user's cache, and runs Meson from its pinned source archive. Models and AI subtitle setup are not required.

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-media.ps1
```

A release/CI media artifact can instead be extracted at the repository root. The setup script verifies that artifact's hashes, matching source files and `libdav1d` decoder availability and skips compilation. `-Distribution` selects another WSL distribution. `-Rebuild` runs the build recipe, which can reuse cached build outputs for identical inputs. Media artifacts from recipe version 1 lack AV1 software decoding: run setup again to rebuild them, or replace them with the complete version 2 artifact and its matching sources.

## Linux CI or rebuilding from the source archive

Install the listed host prerequisites before invoking the script (Ubuntu CI images normally provide most of them). Use Node.js 24 for the finalizer.

```sh
bash scripts/build-media.sh "$PWD"
node scripts/finalize-media.cjs
```

By default downloads and build outputs are kept in `$HOME/.cache/dark-video-manager/media`; `DVM_MEDIA_CACHE` overrides that directory. `DVM_MEDIA_JOBS` selects parallelism, capped at 8. Sources bundled under `sources/` can be copied to the cache's `downloads/` directory before building; each archive is checked against the manifest. Only the pinned compiler archive may still need to be downloaded. Its exact URL/hash and original license are retained in the bundle.

Source archive layout contains this document as `BUILD.md`, original FFmpeg/x264/dav1d/NASM/Meson/Ninja archives under `sources/`, the exact build/finalize scripts under `scripts/`, `resources/media-manifest.json`, dependency licenses, and the resulting `dependencies.json`. Rebuild from that archive by extracting it, copying `BUILD.md` to `docs/media-build.md`, seeding the download cache, and using the two Linux commands above. Output files are regenerated in `resources/media/` and `release/sources/`.

## Release outputs

- `resources/media/win32-x64/ffmpeg.exe` and `ffprobe.exe`: package both from the same build.
- `resources/media/runtime-manifest.json`: binary hashes and input recipe hash.
- `resources/media/licenses/`: original upstream license texts; retain in the installed app.
- `release/sources/dvm-media-corresponding-source.tar.gz`: FFmpeg/x264/dav1d/NASM/Meson/Ninja sources, build scripts, configuration manifest and notices from this build.
- `release/sources/BUILD.md` and `dependencies.json`: source/build access instructions and inventory.
- `resources/legal/media-source-receipts.json`: ties each executable SHA256 to the source archive and inventory.

Run `node scripts/finalize-media.cjs --verify` after copying artifacts or before packaging. Run `node scripts/generate-third-party-notices.cjs --check-release` after all dependencies and optional subtitle runtimes are ready.

Publish the matching source archive, BUILD.md and dependencies.json on the same release page as the application executable, with equivalent free download access and a clear source link. Packaging a binary locally does not publish its source. Do not reuse receipts or source archives from another binary version. The LLVM toolchain archive is a build dependency; its URL and checksum are pinned. Windows system DLLs and compiler runtime imports are listed in the source inventory; proprietary video drivers are not bundled.
