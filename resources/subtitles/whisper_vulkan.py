"""Pinned whisper.cpp Vulkan bridge; standard library only for embedded Python.

The native executable never publishes user sidecars. Completed chunks are passed
back to generate.py, which atomically commits the shared transcript checkpoint.
"""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from download_tls import create_download_context, download_error_message
import wave


ROOT = Path(__file__).resolve().parent
GPU_BACKEND = re.compile(r"whisper_backend_init_gpu:\s+using\s+(Vulkan\d*)\s+backend", re.I)
GPU_FAILURE = re.compile(r"(failed to initialize GPU|failed to init.*Vulkan)", re.I)
NATIVE_PROGRESS = re.compile(r"progress\s*=\s*(\d+)%")


class ChildProcesses:
    """Serialize spawn and cancellation so a stdin EOF cannot orphan a child."""
    def __init__(self):
        self.lock = threading.Lock()
        self.children = set()
        self.downloads = {}
        self.cancelled = False

    def start(self, command, **options):
        with self.lock:
            if self.cancelled:
                raise RuntimeError("자막 생성이 취소되었습니다.")
            child = subprocess.Popen(command, **options)
            self.children.add(child)
            return child

    def remove(self, child):
        with self.lock:
            self.children.discard(child)

    def new_download(self, cache, prefix):
        with self.lock:
            if self.cancelled:
                raise RuntimeError("자막 생성이 취소되었습니다.")
            output = tempfile.NamedTemporaryFile(dir=cache, prefix=prefix, suffix=".part", delete=False)
            self.downloads[output.name] = output
            return output

    def release_download(self, output):
        with self.lock:
            self.downloads.pop(output.name, None)
        output.close()
        Path(output.name).unlink(missing_ok=True)

    def cancel(self):
        with self.lock:
            self.cancelled = True
            children = list(self.children)
            for child in children:
                try:
                    if child.poll() is None:
                        child.kill()
                except OSError:
                    pass
            # Windows cannot unlink an open download. Close only handles owned
            # by this worker before deleting their unique partial files.
            for output in self.downloads.values():
                try:
                    output.close()
                    Path(output.name).unlink(missing_ok=True)
                except OSError:
                    pass
            self.downloads.clear()
        for child in children:
            try:
                child.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                pass


CHILDREN = ChildProcesses()


def cancel_all_children():
    CHILDREN.cancel()


def read_manifest():
    try:
        manifest = json.loads((ROOT / "gpu-models.json").read_text(encoding="utf-8"))
        if manifest.get("version") != 1 or manifest.get("whisperRevision") != "b5454":
            raise ValueError("version")
        for entry in [*manifest["models"].values(), manifest["vad"]]:
            if (not isinstance(entry["filename"], str) or
                    Path(entry["filename"]).name != entry["filename"] or
                    "/" in entry["filename"] or "\\" in entry["filename"] or
                    not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or
                    type(entry["size"]) is not int or entry["size"] <= 0 or
                    not entry["url"].startswith("https://huggingface.co/")):
                raise ValueError("entry")
        return manifest
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        raise RuntimeError("GPU 자막 모델 목록이 없거나 올바르지 않습니다. 실행파일을 다시 설치하세요.") from error


def check_available():
    executable = ROOT / "native" / "whisper" / "whisper-cli.exe"
    if not executable.is_file():
        raise RuntimeError("Windows Vulkan 자막 엔진이 없습니다. GPU 지원 실행파일을 사용하세요.")
    read_manifest()
    return executable


def file_matches(path, entry):
    if not path.is_file() or path.stat().st_size != entry["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == entry["sha256"]


def ensure_model(cache, entry, emit):
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / entry["filename"]
    emit(phase="loading", percent=0, message=f"GPU 모델 확인 중: {entry['filename']}")
    if file_matches(target, entry):
        return target
    temporary, destination = None, None
    try:
        destination = CHILDREN.new_download(cache, f".{target.name}.")
        with destination as output:
            temporary = Path(output.name)
            digest, size, last_time = hashlib.sha256(), 0, 0.0
            request = urllib.request.Request(entry["url"], headers={"User-Agent": "DarkVideoManager-subtitles/1"})
            with urllib.request.urlopen(request, timeout=30, context=create_download_context()) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > entry["size"]:
                        raise ValueError("size")
                    output.write(chunk)
                    digest.update(chunk)
                    now = time.monotonic()
                    if now - last_time >= .4:
                        emit(phase="loading", percent=min(99, int(size * 100 / entry["size"])),
                             message=f"GPU 모델 다운로드: {entry['filename']} ({size // 1048576} MB)")
                        last_time = now
            output.flush()
            os.fsync(output.fileno())
        if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError("checksum")
        os.replace(temporary, target)
        emit(phase="loading", percent=100, message=f"GPU 모델 준비 완료: {entry['filename']}")
        return target
    except Exception as error:
        raise RuntimeError(download_error_message(error)) from error
    finally:
        if destination is not None:
            CHILDREN.release_download(destination)


def extract_wave(audio, destination, start, end):
    with wave.open(str(audio), "rb") as source, wave.open(str(destination), "wb") as output:
        rate = source.getframerate()
        source.setpos(round(start * rate))
        output.setparams(source.getparams())
        remaining = round(end * rate) - round(start * rate)
        while remaining:
            count = min(remaining, rate * 10)
            block = source.readframes(count)
            if len(block) != count * source.getsampwidth() * source.getnchannels():
                raise ValueError("오디오 파일이 작업 도중 변경되었거나 잘렸습니다.")
            output.writeframesraw(block)
            remaining -= count


class _NativeResultError(ValueError):
    """Only fixed, transcript-free diagnostics may be used here."""


def _native_json_object(pairs):
    result = {}
    for key, value in pairs:
        if any("\ud800" <= char <= "\udfff" for char in key):
            raise _NativeResultError("JSON 필드 이름의 문자 인코딩 오류")
        if key in result:
            raise _NativeResultError("JSON 필드 중복")
        result[key] = value
    return result


def _is_native_cue_text(location):
    return (len(location) == 3 and location[0] == "transcription" and
            type(location[1]) is int and location[2] == "text")


def _load_native_result(path):
    # Keep every undecodable byte identifiable until its JSON field is known.
    # Replacing bytes while reading the whole file would also hide corruption
    # in language, timestamps, or other metadata.
    raw = path.read_bytes().decode("utf-8", errors="surrogateescape")
    damaged_bytes = sum("\udc80" <= char <= "\udcff" for char in raw)
    if damaged_bytes > 32:
        raise _NativeResultError("결과 파일의 문자 인코딩 손상이 허용 범위를 초과했습니다")

    # Native b5454 escapes quotes/backslashes, but not literal newlines or tabs
    # inside strings. strict=False admits those characters without relaxing
    # the JSON grammar or any shape/timestamp validation below.
    def parse(text):
        return json.loads(text, strict=False, object_pairs_hook=_native_json_object)

    # Reject explicit, unpaired JSON \u escapes separately. They must not be
    # mistaken for the surrogateescape markers representing actual bad bytes.
    preview = parse("".join("\ufffd" if "\udc80" <= char <= "\udcff" else char for char in raw))
    pending = [(preview, ())]
    while pending:
        value, location = pending.pop()
        if isinstance(value, dict):
            pending.extend((item, (*location, key)) for key, item in value.items())
        elif isinstance(value, list):
            pending.extend((item, (*location, index)) for index, item in enumerate(value))
        elif isinstance(value, str):
            if any("\ud800" <= char <= "\udfff" for char in value):
                raise _NativeResultError("JSON 문자열의 잘못된 유니코드 이스케이프")
    if not damaged_bytes:
        return preview, []

    result = parse(raw)
    repairs = []
    pending = [(result, ())]
    while pending:
        value, location = pending.pop()
        if isinstance(value, dict):
            pending.extend((item, (*location, key)) for key, item in value.items())
        elif isinstance(value, list):
            pending.extend((item, (*location, index)) for index, item in enumerate(value))
        elif isinstance(value, str):
            count = sum("\udc80" <= char <= "\udcff" for char in value)
            if not count:
                continue
            if not _is_native_cue_text(location):
                raise _NativeResultError("자막 본문 이외 필드의 문자 인코딩 오류")
            index = location[1]
            visible_length = sum(char >= " " and not char.isspace() for char in value)
            # Preserve sparse damage without treating a mostly unreadable cue
            # as speech. Both limits apply, and whitespace cannot pad the ratio.
            if count > 8 or count * 20 > visible_length:
                raise _NativeResultError(f"자막 {index + 1}번의 문자 인코딩 손상이 허용 범위를 초과했습니다")
            result["transcription"][index]["text"] = "".join(
                "\ufffd" if "\udc80" <= char <= "\udcff" else char for char in value)
            repairs.append((index + 1, count))
    if sum(count for _, count in repairs) != damaged_bytes:
        raise _NativeResultError("결과 파일의 문자 인코딩 손상 위치를 확인하지 못했습니다")
    return result, sorted(repairs)


def parse_result(path, chunk_duration):
    detail = "결과 파일을 읽지 못했습니다"
    try:
        if (type(chunk_duration) not in (int, float) or
                not math.isfinite(chunk_duration) or chunk_duration <= 0):
            raise _NativeResultError("오디오 구간 길이가 올바르지 않습니다")
        result, repairs = _load_native_result(path)
        detail = "결과 파일의 언어 또는 자막 목록 형식 오류"
        language = result["result"]["language"]
        if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("language")
        if not isinstance(result["transcription"], list):
            raise ValueError("segments")
        segments = []
        for index, item in enumerate(result["transcription"], 1):
            detail = f"자막 {index}번의 시간 정보 오류"
            start, end = item["offsets"]["from"], item["offsets"]["to"]
            if type(start) not in (int, float) or type(end) not in (int, float):
                raise ValueError("time")
            start, end = start / 1000, end / 1000
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                raise ValueError("time")
            detail = f"자막 {index}번의 본문 형식 오류"
            text = item["text"]
            if not isinstance(text, str):
                raise ValueError("text")
            text = " ".join("".join(c for c in text if c >= " " or c in "\n\r\t").split())
            if not text:
                continue
            detail = f"자막 {index}번의 시간 정보 오류"
            if start >= chunk_duration or end <= start:
                raise ValueError("time")
            end = min(end, chunk_duration)
            if segments and start < segments[-1]["start"]:
                detail = f"자막 {index}번의 시간 순서 오류"
                raise ValueError("order")
            segments.append({"start": start, "end": end, "text": text})
        if repairs:
            # Keep stdout reserved for the worker JSONL protocol; do not log
            # source paths, native JSON, or any dialogue, including on failure.
            repaired_cues = ", ".join(f"{index} ({count} bytes)" for index, count in repairs)
            print(f"GPU ASR warning: invalid UTF-8 bytes replaced with U+FFFD in cues: {repaired_cues}",
                  file=sys.stderr, flush=True)
        return segments, language
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        if isinstance(error, _NativeResultError):
            detail = str(error)
        elif isinstance(error, json.JSONDecodeError):
            detail = f"JSON 형식 오류 (행 {error.lineno}, 열 {error.colno})"
        raise RuntimeError(f"GPU 음성 인식 결과가 올바르지 않습니다. {detail}. "
                           "완료한 구간은 보존되어 있으므로 다시 시도할 수 있습니다.") from error


def run_cli(executable, model, vad_model, audio, destination, language, options, on_progress):
    command = [str(executable), "-m", str(model), "-f", str(audio),
               "-l", language or "auto", "-oj", "-of", str(destination), "-pp",
               "-t", str(min(8, os.cpu_count() or 4)),
               "-bs", str(options["beam_size"]), "-mc", str(options["max_context"]),
               "-tp", str(options["temperature"]), "-tpi", str(options["temperature_inc"]),
               "-sns", "--vad", "-vm", str(vad_model),
               "-vsd", str(options["vad_min_silence_duration_ms"]),
               "-vp", str(options["vad_speech_pad_ms"])]
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
              "stderr": subprocess.PIPE, "encoding": "utf-8", "errors": "replace"}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    child = CHILDREN.start(command, **kwargs)
    backend = None
    try:
        for line in child.stderr:
            match = GPU_BACKEND.search(line)
            if match:
                backend = match.group(1)
                on_progress(0, backend)
            elif GPU_FAILURE.search(line) or (backend is None and "no GPU found" in line):
                raise RuntimeError("Vulkan GPU를 초기화하지 못했습니다. 그래픽 드라이버를 확인하세요. CPU로 자동 전환하지 않았습니다.")
            # The pinned CLI creates the main Whisper GPU context first. Its
            # subsequent Silero VAD context deliberately uses CPU and logs
            # "no GPU found"; that does not mean ASR fell back to CPU.
            progress = NATIVE_PROGRESS.search(line)
            if progress and backend:
                on_progress(min(99, int(progress.group(1))), backend)
        code = child.wait()
        if not backend:
            raise RuntimeError("Vulkan GPU 사용을 확인하지 못했습니다. 그래픽 드라이버와 GPU 지원 실행파일을 확인하세요.")
        if code != 0:
            raise RuntimeError(f"GPU 음성 인식 엔진이 종료되었습니다 (코드 {code}). GPU 메모리가 부족하면 더 작은 모델로 새 작업을 시작하세요.")
        if not destination.with_suffix(".json").is_file():
            raise RuntimeError("GPU 음성 인식 엔진이 결과 파일을 생성하지 않았습니다.")
        return backend
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        child.stderr.close()
        CHILDREN.remove(child)


def commit_window(segments, offset, core_end, read_end, duration):
    """Commit whole segments; the next window starts after the last whole cue.

    A crossing utterance is included only when the right context contains its
    end. A segment reaching the read boundary is deferred and read again in full.
    No midpoint filter drops a phrase that straddles the nominal chunk boundary.
    """
    absolute = [{**cue, "start": cue["start"] + offset, "end": cue["end"] + offset}
                for cue in segments]
    if read_end >= duration:
        return absolute, duration
    committed, cursor = [], core_end
    for cue in absolute:
        # A decoder can return overlapping adjacent cues. Keep their entire
        # connected overlap before advancing the cursor beyond any of them.
        if cue["start"] >= cursor:
            break
        if cue["end"] >= read_end - .02:
            cursor = cue["start"]
            for index in range(len(committed) - 1, -1, -1):
                if committed[index]["end"] > cursor:
                    cursor = min(cursor, committed[index]["start"])
                    del committed[index:]
            break
        committed.append(cue)
        cursor = max(cursor, cue["end"])
    if cursor <= offset:
        raise RuntimeError("긴 발화의 자막 경계를 확정하지 못했습니다. 다른 모델로 새 작업을 시작하세요. 이전 완료 구간은 보존했습니다.")
    return committed, min(cursor, duration)


def transcribe(audio, output, args, duration, offset, language, on_chunk, emit, options):
    executable = check_available()
    manifest = read_manifest()
    cache = Path(getattr(args, "model_cache", None) or
                 (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "DarkVideoManager" / "subtitles" / "models"))
    if not cache.is_absolute():
        raise ValueError("GPU 모델 저장 폴더는 절대 경로여야 합니다.")
    model = ensure_model(cache, manifest["models"][args.model], emit)
    vad_model = ensure_model(cache, manifest["vad"], emit)
    language = language or (None if args.language == "auto" else args.language)
    last_percent, last_time = -1, 0.0
    reported_backend = None
    while offset < duration:
        core_end = min(duration, offset + options["chunk_seconds"])
        read_end = min(duration, core_end + options["right_context_seconds"])
        emit(phase="transcribing", percent=int(offset * 100 / duration), message="GPU 음성 인식 엔진을 준비하고 있습니다.")
        with tempfile.TemporaryDirectory(prefix="vulkan-", dir=output) as directory:
            temporary = Path(directory)
            chunk, result = temporary / "audio.wav", temporary / "transcript"
            extract_wave(audio, chunk, offset, read_end)

            def report(percent, backend):
                nonlocal last_percent, last_time, reported_backend
                if backend != reported_backend:
                    # This callback only runs after whisper.cpp confirms its ASR backend.
                    emit(type="processing_device", asr_backend="vulkan", asr_device=backend)
                    reported_backend = backend
                overall = min(99, int((offset + (core_end - offset) * percent / 100) * 100 / duration))
                now = time.monotonic()
                if overall > last_percent and now - last_time >= .4:
                    emit(phase="transcribing", percent=overall, message=f"GPU({backend})로 음성을 인식하고 있습니다.")
                    last_percent, last_time = overall, now

            backend = run_cli(executable, model, vad_model, chunk, result, language, options, report)
            segments, detected_language = parse_result(result.with_suffix(".json"), read_end - offset)
        committed, cursor = commit_window(segments, offset, core_end, read_end, duration)
        # A silent intro must not lock an auto-language job to a random language.
        if segments and language is None:
            language = detected_language
        on_chunk(committed, cursor, language, backend)
        offset = cursor
        emit(phase="transcribing", percent=int(offset * 100 / duration), message=f"GPU({backend}) 음성 인식 진행 구간을 저장했습니다.")
