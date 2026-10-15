"""Atomic subtitle persistence regressions; no models or network required."""

import errno
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import atomic_output


class AtomicOutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / ".checkpoint.json.saved.tmp"
        self.target = self.root / "checkpoint.json"
        self.source.write_text("new checkpoint", encoding="utf-8")
        self.target.write_text("saved checkpoint", encoding="utf-8")
        registry = patch.object(atomic_output, "CHILDREN", atomic_output.ChildProcesses())
        registry.start()
        self.addCleanup(registry.stop)

    def directory_error(self):
        return IsADirectoryError(errno.EISDIR, "Is a directory")

    def assert_unchanged(self):
        self.assertEqual(self.target.read_text(encoding="utf-8"), "saved checkpoint")
        self.assertEqual(self.source.read_text(encoding="utf-8"), "new checkpoint")

    def test_normal_replace_does_not_launch_a_helper(self):
        with patch.object(atomic_output, "_replace_in_windows") as helper:
            atomic_output.atomic_replace(self.source, self.target)
        helper.assert_not_called()
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new checkpoint")
        self.assertFalse(self.source.exists())

    def test_new_destination_uses_normal_replace(self):
        self.target.unlink()
        atomic_output.atomic_replace(self.source, self.target)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new checkpoint")

    def test_wsl_directory_error_on_regular_files_uses_native_replace(self):
        replace = atomic_output.os.replace
        with patch.object(atomic_output.os, "replace", side_effect=self.directory_error()), \
             patch.object(atomic_output, "_is_wsl", return_value=True), \
             patch.object(atomic_output, "_replace_in_windows", side_effect=replace) as helper:
            atomic_output.atomic_replace(self.source, self.target)
        helper.assert_called_once_with(self.source, self.target)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new checkpoint")
        self.assertFalse(self.source.exists())

    def test_non_wsl_directory_error_has_no_fallback(self):
        with patch.object(atomic_output.os, "replace", side_effect=self.directory_error()), \
             patch.object(atomic_output, "_is_wsl", return_value=False), \
             patch.object(atomic_output, "_replace_in_windows") as helper, \
             self.assertRaises(IsADirectoryError):
            atomic_output.atomic_replace(self.source, self.target)
        helper.assert_not_called()
        self.assert_unchanged()

    def test_unrelated_errors_have_no_fallback(self):
        for error_number in (errno.EACCES, errno.ENOSPC, errno.EIO):
            with self.subTest(errno=error_number), \
                 patch.object(atomic_output.os, "replace", side_effect=OSError(error_number, "failed")), \
                 patch.object(atomic_output, "_replace_in_windows") as helper, \
                 self.assertRaises(OSError):
                atomic_output.atomic_replace(self.source, self.target)
            helper.assert_not_called()
            self.assert_unchanged()

    def test_native_failure_or_timeout_keeps_previous_data(self):
        for failure in (FileNotFoundError("python.exe"),
                        subprocess.CalledProcessError(1, ["python.exe"]),
                        subprocess.TimeoutExpired(["python.exe"], 20)):
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(atomic_output.os, "replace", side_effect=self.directory_error()), \
                 patch.object(atomic_output, "_is_wsl", return_value=True), \
                 patch.object(atomic_output, "_replace_in_windows", side_effect=failure), \
                 self.assertRaisesRegex(OSError, "Windows에서 저장하지 못했습니다"):
                atomic_output.atomic_replace(self.source, self.target)
            self.assert_unchanged()

    def test_real_directory_is_untouched_even_when_nonempty(self):
        self.target.unlink()
        self.target.mkdir()
        marker = self.target / "keep.txt"
        marker.write_text("preserve", encoding="utf-8")
        with patch.object(atomic_output.os, "replace") as replace, \
             patch.object(atomic_output, "_replace_in_windows") as helper, \
             self.assertRaisesRegex(ValueError, "폴더 또는 링크"):
            atomic_output.atomic_replace(self.source, self.target)
        replace.assert_not_called()
        helper.assert_not_called()
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")
        self.assertTrue(self.source.is_file())

    def test_destination_symlink_and_its_contents_are_untouched(self):
        actual = self.root / "actual.json"
        self.target.rename(actual)
        try:
            self.target.symlink_to(actual)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Symlinks unavailable: {error}")
        with patch.object(atomic_output.os, "replace") as replace, \
             self.assertRaisesRegex(ValueError, "폴더 또는 링크"):
            atomic_output.atomic_replace(self.source, self.target)
        replace.assert_not_called()
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(actual.read_text(encoding="utf-8"), "saved checkpoint")

    def test_destination_changed_to_directory_is_rechecked_before_fallback(self):
        def changed_destination(*args):
            self.target.unlink()
            self.target.mkdir()
            raise self.directory_error()
        with patch.object(atomic_output.os, "replace", side_effect=changed_destination), \
             patch.object(atomic_output, "_is_wsl", return_value=True), \
             patch.object(atomic_output, "_replace_in_windows") as helper, \
             self.assertRaisesRegex(ValueError, "폴더 또는 링크"):
            atomic_output.atomic_replace(self.source, self.target)
        helper.assert_not_called()
        self.assertTrue(self.target.is_dir())
        self.assertTrue(self.source.is_file())

    def test_native_helper_requires_windows_and_same_parent(self):
        with patch.object(atomic_output.sys, "platform", "linux"), \
             self.assertRaisesRegex(ValueError, "Windows에서만"):
            atomic_output.native_replace(self.source, self.target)
        other = self.root / "other"
        other.mkdir()
        moved = other / self.source.name
        self.source.rename(moved)
        with patch.object(atomic_output.sys, "platform", "win32"), \
             self.assertRaisesRegex(ValueError, "같은 폴더"):
            atomic_output.native_replace(moved, self.target)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "saved checkpoint")
        self.assertTrue(moved.exists())

    def test_native_helper_revalidates_files_before_replacing(self):
        with patch.object(atomic_output.sys, "platform", "win32"):
            atomic_output.native_replace(self.source, self.target)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new checkpoint")
        self.assertFalse(self.source.exists())

    def test_helper_passes_spaces_and_shell_characters_as_individual_arguments(self):
        helper = self.root / "native python.exe"
        helper.write_bytes(b"test executable")
        source = self.root / "saved ' & $(); 임시.tmp"
        target = self.root / "checkpoint.json"
        windows_script = "C:\\자막 도구\\atomic_output.py"
        windows_source = "C:\\작업 폴더\\saved ' & $(); 임시.tmp"
        windows_target = "C:\\작업 폴더\\checkpoint.json"
        results = [value + "\n" for value in (windows_script, windows_source, windows_target)]
        results.append("")
        with patch.object(atomic_output, "_native_python", return_value=helper), \
             patch.object(atomic_output, "_run_command", side_effect=results) as run:
            atomic_output._replace_in_windows(source, target)
        calls = run.call_args_list
        self.assertEqual(calls[1].args[0], ["wslpath", "-w", str(source)])
        self.assertEqual(calls[-1].args[0],
                         [str(helper), "-X", "utf8", windows_script, windows_source, windows_target])
        for call in calls:
            self.assertGreater(call.kwargs["timeout"], 0)

    def test_cancelled_worker_cannot_spawn_more_helpers(self):
        atomic_output.cancel_all_children()
        with patch.object(atomic_output.subprocess, "Popen") as spawn, \
             self.assertRaisesRegex(RuntimeError, "취소"):
            atomic_output._run_command(["unused"], timeout=1)
        spawn.assert_not_called()

    def test_timeout_kills_and_reaps_helper(self):
        child = Mock()
        child.communicate.side_effect = subprocess.TimeoutExpired(["helper"], 1)
        with patch.object(atomic_output.subprocess, "Popen", return_value=child) as spawn, \
             self.assertRaises(subprocess.TimeoutExpired):
            atomic_output._run_command(["helper", "literal & argument"], timeout=1)
        self.assertFalse(spawn.call_args.kwargs.get("shell", False))
        child.kill.assert_called_once()
        child.wait.assert_called_once_with(timeout=3)
        self.assertEqual(atomic_output.CHILDREN.children, set())

    def test_cancellation_waits_for_inflight_spawn_and_kills_its_child(self):
        entered, release, killed = threading.Event(), threading.Event(), threading.Event()
        child = Mock(returncode=1)
        child.kill.side_effect = killed.set
        child.communicate.side_effect = lambda **kwargs: (killed.wait(3) and "", "")
        def spawn(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return child
        errors = []
        def run():
            try:
                atomic_output._run_command(["helper"], timeout=3)
            except Exception as error:
                errors.append(error)
        with patch.object(atomic_output.subprocess, "Popen", side_effect=spawn):
            running = threading.Thread(target=run)
            running.start()
            self.assertTrue(entered.wait(3))
            cancelling = threading.Thread(target=atomic_output.cancel_all_children)
            cancelling.start()
            release.set()
            running.join(3)
            cancelling.join(3)
        self.assertFalse(running.is_alive())
        self.assertFalse(cancelling.is_alive())
        self.assertTrue(killed.is_set())
        self.assertTrue(atomic_output.CHILDREN.cancelled)
        self.assertEqual(len(errors), 1)

    def test_cancelling_a_real_helper_prevents_delayed_file_writes(self):
        ready = self.root / "ready"
        late = self.root / "late-write"
        command = [sys.executable, "-c", (
            "from pathlib import Path; import sys,time; "
            "Path(sys.argv[1]).write_text('ready'); time.sleep(10); "
            "Path(sys.argv[2]).write_text('unexpected')"
        ), str(ready), str(late)]
        errors = []
        def run():
            try:
                atomic_output._run_command(command, timeout=20)
            except Exception as error:
                errors.append(error)
        running = threading.Thread(target=run)
        running.start()
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
        finally:
            atomic_output.cancel_all_children()
            running.join(5)
        self.assertFalse(running.is_alive())
        self.assertFalse(late.exists())
        self.assertEqual(len(errors), 1)

    def test_wsl_detection_requires_linux_and_microsoft_kernel(self):
        for system, kernel, expected in (("linux", "6.6.0-microsoft-standard-WSL2", True),
                                          ("linux", "4.4.0-Microsoft", True),
                                          ("linux", "6.6.0-generic", False),
                                          ("win32", "10", False)):
            with self.subTest(system=system, kernel=kernel), \
                 patch.object(atomic_output.sys, "platform", system), \
                 patch.object(atomic_output.platform, "release", return_value=kernel):
                self.assertEqual(atomic_output._is_wsl(), expected)


if __name__ == "__main__":
    unittest.main()
