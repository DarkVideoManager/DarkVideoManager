"""Replace private subtitle staging files without discarding the previous version."""

import errno
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import threading


class ChildProcesses:
    """Keep helper creation and worker cancellation in the same critical section."""
    def __init__(self):
        self.lock = threading.Lock()
        self.children = set()
        self.cancelled = False

    def start(self, command):
        with self.lock:
            if self.cancelled:
                raise RuntimeError("자막 생성이 취소되었습니다.")
            child = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="strict",
            )
            self.children.add(child)
            return child

    def remove(self, child):
        with self.lock:
            self.children.discard(child)

    def cancel(self):
        with self.lock:
            self.cancelled = True
            children = list(self.children)
            for child in children:
                try:
                    child.kill()
                except OSError:
                    pass
        for child in children:
            try:
                child.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                pass


CHILDREN = ChildProcesses()


def cancel_all_children():
    CHILDREN.cancel()


def _run_command(command, timeout):
    child = CHILDREN.start(command)
    try:
        try:
            stdout, stderr = child.communicate(timeout=timeout)
        except BaseException:
            child.kill()
            child.wait(timeout=3)
            raise
        if child.returncode:
            raise subprocess.CalledProcessError(child.returncode, command, stdout, stderr)
        return stdout
    finally:
        CHILDREN.remove(child)


def _regular_file(path, missing_ok=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing_ok:
            return False
        raise
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(
            f"자막 저장 경로가 일반 파일이 아닙니다: {path.name}. "
            "해당 폴더 또는 링크를 확인해 주세요. 기존 내용은 변경하지 않았습니다."
        )
    return True


def _validate_paths(source, target, target_required=False):
    if (not source.is_absolute() or not target.is_absolute()
            or source.parent.resolve() != target.parent.resolve() or source == target):
        raise ValueError("자막 임시 파일과 저장 파일은 같은 폴더의 서로 다른 절대 경로여야 합니다.")
    _regular_file(source)
    return _regular_file(target, missing_ok=not target_required)


def _is_wsl():
    return sys.platform == "linux" and "microsoft" in platform.release().lower()


def _windows_path(path):
    result = _run_command(["wslpath", "-w", str(path)], timeout=10).rstrip("\r\n")
    if not result or "\n" in result or "\r" in result:
        raise ValueError("자막 저장 파일의 Windows 경로를 확인할 수 없습니다.")
    return result


def _native_python():
    return Path(__file__).resolve().parent / "native" / "python" / "python.exe"


def _replace_in_windows(source, target):
    executable = _native_python()
    _regular_file(executable)
    _run_command(
        [str(executable), "-X", "utf8", str(_windows_path(Path(__file__).resolve())),
         _windows_path(source), _windows_path(target)],
        timeout=20,
    )


def atomic_replace(source, target):
    source, target = Path(source), Path(target)
    _validate_paths(source, target)
    try:
        os.replace(source, target)
    except OSError as error:
        if error.errno != errno.EISDIR or not _is_wsl():
            raise
        # A real directory must never be removed to make the rename succeed.
        # Recheck both files before bypassing the failed WSL filesystem operation.
        _validate_paths(source, target, target_required=True)
        try:
            _replace_in_windows(source, target)
        except (OSError, ValueError, subprocess.SubprocessError) as failure:
            raise OSError(
                "자막 진행 내용을 Windows에서 저장하지 못했습니다. "
                "저장 폴더의 접근 권한과 자막 실행 환경을 확인한 뒤 다시 시도해 주세요."
            ) from failure


def native_replace(source, target):
    """Entry point for the bundled Windows Python, never a recursive fallback."""
    if sys.platform != "win32":
        raise ValueError("Windows 자막 저장 도우미는 Windows에서만 실행할 수 있습니다.")
    source, target = Path(source), Path(target)
    _validate_paths(source, target, target_required=True)
    os.replace(source, target)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("자막 저장 도우미에는 임시 파일과 저장 파일 경로가 필요합니다.")
    native_replace(sys.argv[1], sys.argv[2])
