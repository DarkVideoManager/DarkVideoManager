#!/usr/bin/env bash
# Build both Windows media executables from preserved, hash-pinned sources.
# Runs under Ubuntu 24.04/WSL or a Linux CI runner, without apt/sudo/system changes.
set -euo pipefail
repository=$(cd "${1:-$(dirname "$0")/..}" && pwd)
manifest="$repository/resources/media-manifest.json"
for tool in gcc g++ make perl python3 pkg-config curl tar xz sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }
done

cache="${DVM_MEDIA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/dark-video-manager/media}"
downloads="$cache/downloads"
recipe_hash=$(cat "$manifest" "$repository/scripts/build-media.sh" | sha256sum | cut -c1-20)
build="$cache/build-$recipe_hash"
mkdir -p "$downloads" "$build"
log="$build/build.log"
trap 'echo "Media build failed; last build log lines:" >&2; tail -n 40 "$log" >&2 2>/dev/null || true' ERR

mapfile -t assets < <(python3 - "$manifest" <<'PY'
import json, sys
for item in json.load(open(sys.argv[1], encoding='utf8'))['assets']:
    print('|'.join(item[key] for key in ('id','filename','directory','url','sha256')))
PY
)
declare -A directories
for asset in "${assets[@]}"; do
  IFS='|' read -r id filename directory url sha <<< "$asset"
  [[ "$sha" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid checksum in manifest: $filename" >&2; exit 1; }
  archive="$downloads/$filename"
  if [[ ! -f "$archive" ]] || [[ $(sha256sum "$archive" | cut -d' ' -f1) != "$sha" ]]; then
    echo "Downloading pinned $filename"
    curl --fail --location --retry 3 --connect-timeout 30 --max-time 1800 --output "$archive.partial" "$url"
    echo "$sha  $archive.partial" | sha256sum --check --status || { echo "Download checksum mismatch: $filename" >&2; exit 1; }
    mv "$archive.partial" "$archive"
  fi
  extraction_root="$build"
  if [[ "$id" == toolchain ]]; then extraction_root="$cache/toolchains/$sha"; fi
  mkdir -p "$extraction_root"
  if [[ ! -f "$extraction_root/.$id-extracted" ]]; then
    tar -xf "$archive" -C "$extraction_root" --no-same-owner
    touch "$extraction_root/.$id-extracted"
  fi
  directories[$id]="$extraction_root/$directory"
done

nasm_prefix="$cache/tools/nasm-2.16.03"
export PATH="${directories[toolchain]}/bin:$nasm_prefix/bin:$PATH"
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sourceDateEpoch"])' "$manifest")
jobs="${DVM_MEDIA_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
if ((jobs > 8)); then jobs=8; fi
prefix="$build/prefix"
mkdir -p "$prefix"

if [[ ! -x "$nasm_prefix/bin/nasm" ]]; then
  echo 'Building the pinned assembler in the user cache...'
  (cd "${directories[nasm]}"; ./configure --prefix="$nasm_prefix"; make -j"$jobs"; make install) >"$log" 2>&1
fi
if [[ ! -f "$prefix/lib/libx264.a" ]]; then
  echo 'Building the pinned x264 encoder...'
  (cd "${directories[x264]}"
    CC=x86_64-w64-mingw32-clang AR=x86_64-w64-mingw32-ar RANLIB=x86_64-w64-mingw32-ranlib \
      ./configure --prefix="$prefix" --host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32- \
      --enable-static --disable-cli --disable-opencl --disable-lavf --disable-swscale --disable-ffms
    make -j"$jobs"
    make install
  ) >>"$log" 2>&1
fi
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=''
if [[ ! -f "$build/.ffmpeg-built" ]]; then
  echo 'Building FFmpeg and FFprobe with the same sources and encoder...'
  (cd "${directories[ffmpeg]}"
    ./configure --prefix=/dvm/media --arch=x86_64 --target-os=mingw32 --enable-cross-compile \
      --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-clang --cxx=x86_64-w64-mingw32-clang++ \
      --pkg-config=pkg-config --pkg-config-flags=--static \
      --enable-static --disable-shared --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
      --enable-gpl --enable-version3 --enable-libx264 --disable-network \
      --extra-cflags=-I../prefix/include --extra-ldflags='-L../prefix/lib -static -Wl,--no-insert-timestamp' \
      --extra-version=DarkVideoManager
    make -j"$jobs" ffmpeg.exe ffprobe.exe
  ) >>"$log" 2>&1
  touch "$build/.ffmpeg-built"
fi

output="$repository/resources/media"
mkdir -p "$output/win32-x64" "$output/licenses" "$output/source-materials/sources" "$output/source-materials/scripts" "$output/source-materials/resources"
for program in ffmpeg ffprobe; do
  cp "${directories[ffmpeg]}/$program.exe" "$output/win32-x64/$program.exe"
  x86_64-w64-mingw32-objdump -p "$output/win32-x64/$program.exe" | sed -n 's/.*DLL Name: /DLL: /p' > "$output/$program-imports.txt"
done
cp "${directories[ffmpeg]}"/COPYING.* "$output/licenses/"
cp "${directories[ffmpeg]}/LICENSE.md" "$output/licenses/FFmpeg-LICENSE.md"
cp "${directories[x264]}/COPYING" "$output/licenses/x264-COPYING.txt"
cp "${directories[toolchain]}/LICENSE.TXT" "$output/licenses/LLVM-MinGW-LICENSE.txt"
for notice in "${directories[toolchain]}/x86_64-w64-mingw32/share/mingw32/"COPYING*; do
  cp "$notice" "$output/licenses/MinGW-$(basename "$notice")"
done
for asset in "${assets[@]}"; do
  IFS='|' read -r id filename directory url sha <<< "$asset"
  # A compiler is a build tool; preserve its pinned download receipt and license.
  # Archive the actual FFmpeg/x264 sources and assembler source used in this build.
  if [[ "$id" != toolchain ]]; then cp "$downloads/$filename" "$output/source-materials/sources/"; fi
done
cp "$manifest" "$output/source-materials/resources/media-manifest.json"
cp "$repository/scripts/build-media.sh" "$output/source-materials/scripts/build-media.sh"
cp "$repository/scripts/finalize-media.cjs" "$output/source-materials/scripts/finalize-media.cjs"
if [[ -f "$repository/docs/media-build.md" ]]; then
  cp "$repository/docs/media-build.md" "$output/source-materials/BUILD.md"
else
  cp "$repository/BUILD.md" "$output/source-materials/BUILD.md"
fi
cp -R "$output/licenses" "$output/source-materials/"
echo "$recipe_hash" > "$output/recipe-hash.txt"
echo "Media executables ready. Run node scripts/finalize-media.cjs to seal hashes and source artifacts."
