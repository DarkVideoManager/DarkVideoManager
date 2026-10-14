"""App-owned WSL subtitle environment; stdout is a JSONL progress protocol.

Run with system Python 3.12 in Ubuntu 24.04. Installation is opt-in and stdin
must remain open; EOF cancels only processes/downloads owned by this worker.
Ollama manual layout: https://docs.ollama.com/linux#manual-install
Pinned archive metadata: https://api.github.com/repos/ollama/ollama/releases/tags/v0.40.3
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import select
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request


ROOT = Path.home() / ".local/share/dark-video-manager"
VENV = ROOT / "venv"
OLLAMA_VERSION = "0.40.3"
OLLAMA_URL = "https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-linux-amd64.tar.zst"
OLLAMA_SHA256 = "ce6f8b671a699bf1ebafb28d60dbbabf4f37b30b499145fa308a8ba72de021d6"
OLLAMA_SIZE = 1437349190
OLLAMA_HOME = ROOT / "ollama" / OLLAMA_VERSION
MODEL = "qwen3:8b"
API = "http://127.0.0.1:11434"
DEPENDENCY_CHECK = "import faster_whisper,av,requests; print('ready')"
MAX_JSON = 1024 * 1024


class SetupCancelled(Exception):
    pass


def emit(component=None, state=None, message=None, **values):
    event = dict(values)
    if component is not None:
        event.update(component=component, state=state, message=message)
    print(json.dumps(event, ensure_ascii=False), flush=True)


def stop_process(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, AttributeError):
        child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, AttributeError):
            child.kill()
        child.wait(timeout=3)


class Activity:
    """Register resources before returning them, so cancellation cannot miss one."""

    def __init__(self):
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.children = set()
        self.responses = set()

    def check(self):
        if self.cancelled.is_set():
            raise SetupCancelled("설치가 중지되었습니다. 다시 설치하면 이어서 준비합니다.")

    def start(self, command, **options):
        with self.lock:
            self.check()
            child = subprocess.Popen(command, start_new_session=True, **options)
            self.children.add(child)
            return child

    def release(self, child):
        with self.lock:
            self.check()
            self.children.discard(child)

    def forget(self, child):
        with self.lock:
            self.children.discard(child)

    @contextmanager
    def request(self, request, timeout=30, local=False):
        self.check()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if local else urllib.request.build_opener()
        response = opener.open(request, timeout=timeout)
        with self.lock:
            if self.cancelled.is_set():
                response.close()
                self.check()
            self.responses.add(response)
        try:
            yield response
        finally:
            with self.lock:
                self.responses.discard(response)
            response.close()

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            children = list(self.children)
            responses = list(self.responses)
        for response in responses:
            # Wake a blocked HTTP read before closing its buffered stream.
            try:
                response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
            except (AttributeError, OSError):
                pass
            try:
                response.close()
            except OSError:
                pass
        for child in children:
            try:
                stop_process(child)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def command(self, command, timeout=1800):
        self.check()
        with tempfile.TemporaryFile() as output:
            child = self.start(command, stdin=subprocess.DEVNULL, stdout=output, stderr=output)
            deadline = time.monotonic() + timeout
            try:
                while child.poll() is None:
                    self.check()
                    if time.monotonic() > deadline:
                        raise RuntimeError("설치 응답 시간이 초과되었습니다. 네트워크를 확인하고 다시 시도해 주세요.")
                    self.cancelled.wait(.1)
                self.check()
                output.seek(max(0, output.tell() - 6000))
                details = output.read().decode("utf-8", errors="replace").strip()
                if child.returncode:
                    raise RuntimeError(details or "자막 환경 명령을 완료하지 못했습니다.")
                return details
            finally:
                if child.poll() is None:
                    stop_process(child)
                self.forget(child)


def watch_stdin(activity):
    try:
        descriptor = sys.stdin.fileno()
        while not activity.cancelled.is_set():
            # A buffered read holds stdin's lock while waiting for EOF. Python
            # aborts at shutdown if a daemon still holds that lock after setup.
            # Raw reads also support Windows pipes, which select cannot poll.
            if os.name != "nt" and not select.select([descriptor], [], [], .2)[0]:
                continue
            if not os.read(descriptor, 4096):
                break
    except (OSError, ValueError):
        pass
    finally:
        if not activity.cancelled.is_set():
            activity.cancel()


def python_ready(activity):
    executable = VENV / "bin/python"
    if not executable.is_file():
        return False
    try:
        return activity.command([str(executable), "-c", DEPENDENCY_CHECK], timeout=45).endswith("ready")
    except SetupCancelled:
        raise
    except (OSError, RuntimeError):
        return False


def install_python(activity):
    emit("python", "checking", "자막 처리 환경을 확인하고 있습니다.")
    if python_ready(activity):
        emit("python", "ready", "자막 처리 환경이 준비되어 있습니다.")
        return
    emit("python", "installing", "앱 전용 자막 처리 환경을 설치하고 있습니다.")
    ROOT.mkdir(parents=True, exist_ok=True)
    try:
        # Also repairs an interrupted creation whose Python exists but pip does
        # not. venv preserves installed packages in the existing app environment.
        activity.command([sys.executable, "-m", "venv", str(VENV)], timeout=120)
    except RuntimeError as error:
        raise RuntimeError("Python 환경을 만들지 못했습니다. Ubuntu의 python3-venv 준비 후 다시 시도해 주세요. " + str(error)) from error
    # This environment belongs only to DVM; never install into system Python.
    activity.command([str(VENV / "bin/python"), "-m", "pip", "install", "--disable-pip-version-check",
                      "--no-input", "--timeout", "30", "--retries", "3", "faster-whisper==1.2.1",
                      "av>=11,<16", "requests>=2.32,<3"])
    if not python_ready(activity):
        raise RuntimeError("자막 처리 환경 설치 후 확인에 실패했습니다. 다시 시도해 주세요.")
    emit("python", "ready", "자막 처리 환경 설치가 완료되었습니다.")


def tags(activity):
    try:
        with activity.request(API + "/api/tags", timeout=3, local=True) as response:
            raw = response.read(MAX_JSON + 1)
            if len(raw) > MAX_JSON:
                return None
            value = json.loads(raw)
            models = value.get("models") if isinstance(value, dict) else None
            return models if isinstance(models, list) else None
    except SetupCancelled:
        raise
    except (OSError, ValueError):
        return None


def has_model(models):
    return any(isinstance(model, dict) and (model.get("name") == MODEL or model.get("model") == MODEL)
               for model in (models or []))


def ollama_binary():
    # Respect an existing user installation before the app-owned copy.
    external = shutil.which("ollama")
    if external:
        return Path(external)
    managed = OLLAMA_HOME / "bin/ollama"
    return managed if managed.is_file() else None


def download_ollama(activity, archive):
    request = urllib.request.Request(OLLAMA_URL, headers={"User-Agent": "DarkVideoManager-SubtitleSetup"})
    digest = hashlib.sha256()
    size = 0
    last_percent = -1
    deadline = time.monotonic() + 2 * 60 * 60
    with activity.request(request, timeout=30) as response, archive.open("wb") as output:
        while True:
            activity.check()
            if time.monotonic() > deadline:
                raise RuntimeError("Ollama 다운로드 시간이 초과되었습니다. 네트워크를 확인하고 다시 시도해 주세요.")
            data = response.read(1024 * 1024)
            if not data:
                break
            size += len(data)
            if size > OLLAMA_SIZE:
                raise RuntimeError("Ollama 다운로드 크기가 예상과 다릅니다.")
            digest.update(data)
            output.write(data)
            percent = int(size * 90 / OLLAMA_SIZE)
            if percent != last_percent:
                emit("ollama", "installing", "Ollama를 다운로드하고 있습니다. 약 1.4 GB입니다.", percent=percent)
                last_percent = percent
    activity.check()
    if size != OLLAMA_SIZE or digest.hexdigest() != OLLAMA_SHA256:
        raise RuntimeError("Ollama 다운로드 무결성 확인에 실패했습니다. 다시 시도해 주세요.")


def extract_ollama(activity, archive, destination):
    """Data-only extraction rejects path/link escapes and special devices."""
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("Ubuntu의 Python 보안 업데이트가 필요합니다.")
    child = activity.start(["zstd", "-dc", str(archive)], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    total = 0
    count = 0
    try:
        with tarfile.open(fileobj=child.stdout, mode="r|") as contents:
            for member in contents:
                activity.check()
                count += 1
                total += max(0, member.size)
                parts = PurePosixPath(member.name).parts
                if count > 100000 or total > 6 * 1024 ** 3:
                    raise RuntimeError("Ollama 설치 압축 크기가 예상 범위를 초과했습니다.")
                # Official multi-platform builds include a harmless './' root
                # directory before './bin' and './lib'; do not extract its mode.
                if not parts and member.isdir() and member.name in (".", "./"):
                    continue
                if not parts or parts[0] not in ("bin", "lib") or ".." in parts:
                    raise RuntimeError("Ollama 설치 파일 경로가 올바르지 않습니다.")
                contents.extract(member, path=destination, filter="data")
        child.wait(timeout=30)
        if child.returncode:
            raise RuntimeError("Ollama 설치 파일 압축 해제에 실패했습니다.")
    finally:
        if child.stdout:
            child.stdout.close()
        if child.poll() is None:
            stop_process(child)
        activity.forget(child)
    executable = destination / "bin/ollama"
    if not executable.is_file() or executable.is_symlink():
        raise RuntimeError("Ollama 실행 파일이 설치 파일에 없습니다.")
    executable.chmod(executable.stat().st_mode | 0o100)


def install_ollama(activity):
    binary = ollama_binary()
    if binary:
        return binary
    if platform.machine().lower() not in ("x86_64", "amd64"):
        raise RuntimeError("Ollama 자동 설치는 현재 Windows x64의 Ubuntu 환경을 지원합니다.")
    if not shutil.which("zstd"):
        raise RuntimeError("Ubuntu의 zstd 준비가 필요합니다. 다시 설치를 눌러 주세요.")
    parent = OLLAMA_HOME.parent
    parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(parent).free < 5 * 1024 ** 3:
        raise RuntimeError("Ollama 설치에 Ubuntu 저장 공간이 최소 5 GB 필요합니다.")
    with tempfile.TemporaryDirectory(prefix="setup-", dir=parent) as temporary:
        stage = Path(temporary)
        archive = stage / "ollama.tar.zst"
        download_ollama(activity, archive)
        emit("ollama", "installing", "Ollama 설치 파일을 확인하고 준비하고 있습니다.", percent=92)
        extracted = stage / "runtime"
        extracted.mkdir()
        extract_ollama(activity, archive, extracted)
        activity.check()
        # Never replace a runtime that may be in use. A previous incomplete
        # staging directory is removed by TemporaryDirectory on failure.
        if OLLAMA_HOME.exists():
            raise RuntimeError("앱 전용 Ollama 폴더를 확인할 수 없습니다. 해당 폴더의 권한을 확인해 주세요.")
        extracted.rename(OLLAMA_HOME)
    return OLLAMA_HOME / "bin/ollama"


def ensure_server(activity, install=False, managed_only=False):
    existing = tags(activity)
    if existing is not None:
        emit("ollama", "ready", "Ollama가 실행 중입니다.")
        return None
    managed = OLLAMA_HOME / "bin/ollama"
    binary = (managed if managed.is_file() else None) if managed_only else ollama_binary()
    if binary is None and install:
        emit("ollama", "installing", "한국어 번역에 사용할 Ollama를 준비하고 있습니다.")
        binary = install_ollama(activity)
    if binary is None:
        raise RuntimeError("Ollama 설치가 필요합니다. 자막 환경 자동 설치를 실행해 주세요.")
    emit("ollama", "installing", "한국어 번역 서비스를 시작하고 있습니다.")
    ROOT.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434")
    if binary == OLLAMA_HOME / "bin/ollama":
        environment.update(OLLAMA_MODELS=str(ROOT / "ollama-models"), OLLAMA_NO_CLOUD="1")
    log_path = ROOT / "ollama.log"
    if log_path.is_file() and log_path.stat().st_size > 2 * 1024 ** 2:
        log_path.write_text("", encoding="utf-8")
    with log_path.open("ab") as output:
        child = activity.start([str(binary), "serve"], stdin=subprocess.DEVNULL,
                               stdout=output, stderr=output, env=environment)
    deadline = time.monotonic() + 45
    try:
        while time.monotonic() < deadline:
            activity.check()
            if tags(activity) is not None:
                if child.poll() is not None:
                    activity.forget(child)
                    child = None  # Another already-running server won the port.
                emit("ollama", "ready", "한국어 번역 서비스가 준비되었습니다.")
                return child
            if child.poll() is not None:
                raise RuntimeError("Ollama를 시작하지 못했습니다. 자막 환경 설치를 다시 실행해 주세요.")
            activity.cancelled.wait(.25)
        raise RuntimeError("Ollama 시작 응답 시간이 초과되었습니다.")
    except BaseException:
        if child is not None:
            stop_process(child)
            activity.forget(child)
        raise


def install_model(activity):
    if has_model(tags(activity)):
        emit("translationModel", "ready", "한국어 번역 모델이 준비되어 있습니다.")
        return
    emit("translationModel", "installing", "한국어 번역 모델을 다운로드하고 있습니다. 약 5.2 GB입니다.")
    request = urllib.request.Request(API + "/api/pull", data=json.dumps({"model": MODEL, "stream": True}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    deadline = time.monotonic() + 4 * 60 * 60
    layers = {}
    completed = False
    last_percent = -1
    with activity.request(request, timeout=60, local=True) as response:
        while True:
            activity.check()
            if time.monotonic() > deadline:
                raise RuntimeError("번역 모델 다운로드 시간이 초과되었습니다. 다시 설치하면 다운로드를 이어서 시도합니다.")
            line = response.readline(MAX_JSON + 1)
            if not line:
                break
            if len(line) > MAX_JSON:
                raise RuntimeError("번역 모델 다운로드 응답이 올바르지 않습니다.")
            event = json.loads(line)
            if not isinstance(event, dict):
                raise RuntimeError("번역 모델 다운로드 응답이 올바르지 않습니다.")
            if event.get("error"):
                raise RuntimeError("번역 모델을 다운로드하지 못했습니다: " + str(event["error"])[:500])
            if event.get("status") == "success":
                completed = True
            if isinstance(event.get("digest"), str) and isinstance(event.get("total"), int) and event["total"] > 0:
                received = event.get("completed", 0)
                if isinstance(received, int) and 0 <= received <= event["total"]:
                    layers[event["digest"]] = (received, event["total"])
                    percent = min(99, int(sum(part[0] for part in layers.values()) * 100 / sum(part[1] for part in layers.values())))
                    if percent > last_percent:
                        emit("translationModel", "installing", "한국어 번역 모델을 다운로드하고 있습니다.", percent=percent)
                        last_percent = percent
    activity.check()
    if not completed or not has_model(tags(activity)):
        raise RuntimeError("번역 모델 다운로드 완료를 확인하지 못했습니다. 다시 설치하면 이어서 시도합니다.")
    emit("translationModel", "ready", "한국어 번역 모델 설치가 완료되었습니다.", percent=100)


def check_environment(activity):
    ready = python_ready(activity)
    emit("python", "ready" if ready else "missing", "자막 처리 환경이 준비되어 있습니다." if ready else "자막 처리 환경 설치가 필요합니다.")
    models = tags(activity)
    server = models is not None
    emit("ollama", "ready" if server else "missing", "Ollama가 실행 중입니다." if server else
         ("Ollama 시작이 필요합니다." if ollama_binary() else "Ollama 설치가 필요합니다."))
    model = has_model(models)
    emit("translationModel", "ready" if model else "missing", "한국어 번역 모델이 준비되어 있습니다." if model else "한국어 번역 모델 확인 또는 설치가 필요합니다.")
    emit(completed=True, available=ready and server and model)


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--install", action="store_true")
    modes.add_argument("--ensure-server", action="store_true")
    args = parser.parse_args()
    activity = Activity()
    watcher = None
    component = "python"
    try:
        if args.check:
            check_environment(activity)
            return 0
        if args.install:
            watcher = threading.Thread(target=watch_stdin, args=(activity,),
                                       name="setup-stdin-cancellation", daemon=True)
            watcher.start()
            install_python(activity)
        component = "ollama"
        server = ensure_server(activity, install=args.install)
        if args.install:
            component = "translationModel"
            install_model(activity)
        activity.check()
        if server is not None:
            activity.release(server)  # Keep only a successfully prepared daemon.
        emit(completed=True, available=True)
        return 0
    except SetupCancelled as error:
        emit(component, "missing", str(error), cancelled=True)
        return 2
    except Exception as error:
        if activity.cancelled.is_set():
            emit(component, "missing", "설치가 중지되었습니다. 다시 설치하면 이어서 준비합니다.", cancelled=True)
            return 2
        emit(component, "failed", str(error)[:1500])
        return 1
    finally:
        activity.cancel()
        if watcher is not None:
            watcher.join(timeout=1)


if __name__ == "__main__":
    sys.exit(main())
