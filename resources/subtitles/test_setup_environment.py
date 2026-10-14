"""Installer contract/safety tests: no packages, daemons, or models installed."""

from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import Mock, patch

import setup_environment as setup
import generate


class FakeActivity(setup.Activity):
    def __init__(self, data=b""):
        super().__init__()
        self.data = data
        self.requests = []

    @contextmanager
    def request(self, request, **options):
        self.check()
        self.requests.append((request, options))
        yield io.BytesIO(self.data)


class InstallerTests(unittest.TestCase):
    def test_tags_and_exact_model(self):
        activity = FakeActivity(json.dumps({"models": [{"name": "qwen3:8b"}]}).encode())
        self.assertTrue(setup.has_model(setup.tags(activity)))
        self.assertEqual(activity.requests[0][0], "http://127.0.0.1:11434/api/tags")
        self.assertTrue(activity.requests[0][1]["local"])
        self.assertFalse(setup.has_model([{"name": "qwen3:latest"}, {"name": "qwen3:32b"}]))
        self.assertFalse(setup.has_model([None, "qwen3:8b"]))

    def test_tags_rejects_invalid_or_oversized_server_responses(self):
        for payload in (b"not json", b"[]", b'{"models":"invalid"}', b" " * (setup.MAX_JSON + 1)):
            self.assertIsNone(setup.tags(FakeActivity(payload)))

    @patch.object(setup, "emit")
    def test_readonly_check_uses_api_model_and_does_not_start_server(self, emit):
        activity = setup.Activity()
        with patch.object(setup, "python_ready", return_value=True), \
             patch.object(setup, "tags", return_value=[{"name": "qwen3:8b"}]), \
             patch.object(setup, "ensure_server", side_effect=AssertionError("started")):
            setup.check_environment(activity)
        self.assertEqual(emit.call_args.kwargs, {"completed": True, "available": True})

    @patch.object(setup, "emit")
    def test_check_reports_missing_model_even_when_python_and_server_are_ready(self, emit):
        with patch.object(setup, "python_ready", return_value=True), patch.object(setup, "tags", return_value=[]):
            setup.check_environment(setup.Activity())
        self.assertEqual(emit.call_args.kwargs, {"completed": True, "available": False})
        self.assertEqual(emit.call_args_list[-2].args[:2], ("translationModel", "missing"))

    @patch.object(setup, "emit")
    def test_ready_python_skips_any_install(self, emit):
        activity = Mock(spec=setup.Activity)
        with patch.object(setup, "python_ready", return_value=True):
            setup.install_python(activity)
        activity.command.assert_not_called()

    @patch.object(setup, "emit")
    def test_python_install_repairs_interrupted_venv_and_installs_only_managed_environment(self, emit):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activity = Mock(spec=setup.Activity)
            with patch.object(setup, "ROOT", root), patch.object(setup, "VENV", root / "venv"), \
                 patch.object(setup, "python_ready", side_effect=[False, True]):
                setup.install_python(activity)
            calls = activity.command.call_args_list
            self.assertEqual(calls[0].args[0], [setup.sys.executable, "-m", "venv", str(root / "venv")])
            self.assertEqual(calls[1].args[0][0], str(root / "venv/bin/python"))
            self.assertIn("faster-whisper==1.2.1", calls[1].args[0])

    @patch.object(setup, "emit")
    def test_running_existing_ollama_is_reused_without_spawning(self, emit):
        activity = Mock(spec=setup.Activity)
        with patch.object(setup, "tags", return_value=[]), \
             patch.object(setup, "install_ollama", side_effect=AssertionError("download")):
            self.assertIsNone(setup.ensure_server(activity, install=True))
        activity.start.assert_not_called()

    @patch.object(setup, "emit")
    def test_ensure_server_does_not_download_missing_runtime(self, emit):
        with patch.object(setup, "tags", return_value=None), patch.object(setup, "ollama_binary", return_value=None), \
             patch.object(setup, "install_ollama", side_effect=AssertionError("download")):
            with self.assertRaisesRegex(RuntimeError, "설치가 필요"):
                setup.ensure_server(setup.Activity())

    @patch.object(setup, "emit")
    def test_managed_server_uses_loopback_and_private_model_location(self, emit):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "ollama/0.40.3"
            activity = Mock(spec=setup.Activity)
            child = Mock()
            child.poll.return_value = None
            activity.start.return_value = child
            with patch.object(setup, "ROOT", root), patch.object(setup, "OLLAMA_HOME", runtime), \
                 patch.object(setup, "ollama_binary", return_value=runtime / "bin/ollama"), \
                 patch.object(setup, "tags", side_effect=[None, []]):
                self.assertIs(setup.ensure_server(activity), child)
            args, kwargs = activity.start.call_args
            self.assertEqual(args[0], [str(runtime / "bin/ollama"), "serve"])
            self.assertEqual(kwargs["env"]["OLLAMA_HOST"], "127.0.0.1:11434")
            self.assertEqual(kwargs["env"]["OLLAMA_MODELS"], str(root / "ollama-models"))
            activity.release.assert_not_called()  # Only release after the full setup succeeds.

    @patch.object(setup, "emit")
    def test_existing_model_is_not_pulled_again(self, emit):
        activity = FakeActivity()
        with patch.object(setup, "tags", return_value=[{"name": "qwen3:8b"}]):
            setup.install_model(activity)
        self.assertEqual(activity.requests, [])

    @patch.object(setup, "emit")
    def test_model_stream_requires_success_and_verifies_installed_tag(self, emit):
        payload = b'{"digest":"a","total":10,"completed":5}\n{"status":"success"}\n'
        activity = FakeActivity(payload)
        with patch.object(setup, "tags", side_effect=[[], [{"name": "qwen3:8b"}]]):
            setup.install_model(activity)
        request, options = activity.requests[0]
        self.assertEqual(json.loads(request.data), {"model": "qwen3:8b", "stream": True})
        self.assertEqual(request.full_url, setup.API + "/api/pull")
        self.assertTrue(options["local"])
        self.assertEqual(emit.call_args.kwargs, {"percent": 100})

    @patch.object(setup, "emit")
    def test_model_stream_eof_and_error_do_not_report_success(self, emit):
        for payload in (b'{"status":"pulling manifest"}\n', b'{"error":"network failed"}\n', b'[]\n'):
            with self.subTest(payload=payload), patch.object(setup, "tags", return_value=[]):
                with self.assertRaises(RuntimeError):
                    setup.install_model(FakeActivity(payload))
        self.assertNotIn(("translationModel", "ready"), [call.args[:2] for call in emit.call_args_list])

    @patch.object(setup, "emit")
    def test_model_success_without_installed_tag_is_failure(self, emit):
        with patch.object(setup, "tags", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "완료를 확인"):
                setup.install_model(FakeActivity(b'{"status":"success"}\n'))

    @patch.object(setup, "emit")
    def test_pinned_archive_size_and_hash_are_verified(self, emit):
        data = b"trusted release"
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, "OLLAMA_SIZE", len(data)), \
             patch.object(setup, "OLLAMA_SHA256", hashlib.sha256(data).hexdigest()):
            archive = Path(directory) / "runtime"
            setup.download_ollama(FakeActivity(data), archive)
            self.assertEqual(archive.read_bytes(), data)
            with self.assertRaisesRegex(RuntimeError, "무결성"):
                setup.download_ollama(FakeActivity(b"wrong release!"), archive)
            with self.assertRaisesRegex(RuntimeError, "크기"):
                setup.download_ollama(FakeActivity(data + b"extra"), archive)

    def tar_payload(self, name, link=None):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            member = tarfile.TarInfo(name)
            if link is not None:
                member.type = tarfile.SYMTYPE
                member.linkname = link
                archive.addfile(member)
            else:
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
        return output.getvalue()

    def extraction(self, data, destination):
        activity = Mock(spec=setup.Activity)
        child = Mock()
        child.stdout = io.BytesIO(data)
        child.poll.return_value = 0
        child.returncode = 0
        activity.start.return_value = child
        setup.extract_ollama(activity, Path("archive.zst"), destination)

    def test_archive_traversal_absolute_and_symlink_escape_are_rejected(self):
        for name, link in (("../outside", None), ("/etc/evil", None), ("bin/ollama", "../../outside")):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises((RuntimeError, tarfile.FilterError)):
                    self.extraction(self.tar_payload(name, link), Path(directory))

    def test_archive_accepts_expected_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            self.extraction(self.tar_payload("bin/ollama"), Path(directory))
            self.assertEqual((Path(directory) / "bin/ollama").read_bytes(), b"x")

    def test_archive_accepts_official_multiplatform_root_directory(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            root = tarfile.TarInfo("./")
            root.type = tarfile.DIRTYPE
            archive.addfile(root)
            executable = tarfile.TarInfo("./bin/ollama")
            executable.size = 1
            archive.addfile(executable, io.BytesIO(b"x"))
        with tempfile.TemporaryDirectory() as directory:
            self.extraction(output.getvalue(), Path(directory))
            self.assertEqual((Path(directory) / "bin/ollama").read_bytes(), b"x")

    def test_cancel_stops_only_owned_children_and_forbids_new_spawn(self):
        activity = setup.Activity()
        owned = Mock()
        released = Mock()
        activity.children.update([owned, released])
        activity.release(released)
        with patch.object(setup, "stop_process") as stop, patch.object(setup.subprocess, "Popen") as spawn:
            activity.cancel()
            stop.assert_called_once_with(owned)
            with self.assertRaises(setup.SetupCancelled):
                activity.start(["anything"])
            spawn.assert_not_called()

    def test_cancel_prevents_detaching_a_daemon(self):
        activity = setup.Activity()
        child = Mock()
        activity.children.add(child)
        activity.cancelled.set()
        with self.assertRaises(setup.SetupCancelled):
            activity.release(child)
        self.assertIn(child, activity.children)

    def test_stdin_eof_requests_cancellation(self):
        activity = setup.Activity()
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        self.addCleanup(os.close, read_fd)
        fake_stdin = Mock()
        fake_stdin.fileno.return_value = read_fd
        with patch.object(setup.sys, "stdin", fake_stdin):
            setup.watch_stdin(activity)
        self.assertTrue(activity.cancelled.is_set())

    def run_setup_exit_fixture(self, fail=False):
        # The parent intentionally keeps stdin OPEN until wait() completes.
        # communicate(input=...) would close it and hide the buffered daemon
        # lock that made the real WSL installer abort after reporting success.
        script = textwrap.dedent("""
            import os, sys, threading, time
            import setup_environment as setup
            if os.name != "nt":
                import resource
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            started = threading.Event()
            original_watch = setup.watch_stdin
            def watch(activity):
                started.set()
                original_watch(activity)
            setup.watch_stdin = watch
            def prepare(activity):
                assert started.wait(3)
                time.sleep(.2)  # Let the real pipe reader block before exit.
                if FAIL:
                    raise RuntimeError("fixture failure")
            setup.install_python = prepare
            setup.ensure_server = lambda *args, **kwargs: None
            setup.install_model = lambda activity: None
            sys.argv = ["setup_environment.py", "--install"]
            sys.exit(setup.main())
        """).replace("if FAIL:", "if " + repr(fail) + ":")
        child = subprocess.Popen([setup.sys.executable, "-X", "utf8", "-B", "-u", "-c", script],
                                 cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            code = child.wait(timeout=8)
            self.assertFalse(child.stdin.closed)
            output, error = child.stdout.read(), child.stderr.read()
            self.assertNotIn(b"_enter_buffered_busy", error)
            self.assertNotIn(b"Fatal Python error", error)
            self.assertEqual(error, b"")
            self.assertEqual(code, 1 if fail else 0)
            return [json.loads(line) for line in output.splitlines()]
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()

    def test_successful_setup_exits_while_parent_stdin_remains_open(self):
        self.assertEqual(self.run_setup_exit_fixture(), [{"completed": True, "available": True}])

    def test_failed_setup_exits_while_parent_stdin_remains_open(self):
        events = self.run_setup_exit_fixture(fail=True)
        self.assertEqual(events[-1]["state"], "failed")
        self.assertEqual(events[-1]["message"], "fixture failure")
        self.assertFalse(any(event.get("completed") for event in events))

    def test_setup_stdin_eof_stops_owned_child_and_returns_cancelled(self):
        # Real pipe and real harmless child exercise cancellation independently
        # of package installation, external networks and an Ollama daemon.
        script = textwrap.dedent("""
            import json, subprocess, sys, time
            import setup_environment as setup
            owned = None
            def prepare(activity):
                global owned
                owned = activity.start([sys.executable, "-c", "import time; time.sleep(30)"],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
                print(json.dumps({"ownedPid": owned.pid}), flush=True)
                while not activity.cancelled.wait(.05):
                    pass
                activity.check()
            setup.install_python = prepare
            setup.ensure_server = lambda *args, **kwargs: None
            setup.install_model = lambda activity: None
            sys.argv = ["setup_environment.py", "--install"]
            try:
                code = setup.main()
                print(json.dumps({"ownedStopped": owned.poll() is not None}), flush=True)
            finally:
                if owned is not None:
                    setup.stop_process(owned)
            sys.exit(code)
        """)
        child = subprocess.Popen([setup.sys.executable, "-X", "utf8", "-B", "-u", "-c", script],
                                 cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertGreater(json.loads(child.stdout.readline())["ownedPid"], 0)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=10), 2)
            events = [json.loads(line) for line in child.stdout.read().splitlines()]
            self.assertTrue(any(event.get("cancelled") is True for event in events))
            self.assertEqual(events[-1], {"ownedStopped": True})
            self.assertEqual(child.stderr.read(), b"")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            if not child.stdin.closed:
                child.stdin.close()
            child.stdout.close()
            child.stderr.close()

    def test_cancel_is_not_reported_as_missing_python(self):
        activity = setup.Activity()
        activity.cancelled.set()
        with patch.object(Path, "is_file", return_value=True):
            with self.assertRaises(setup.SetupCancelled):
                setup.python_ready(activity)

    def test_generation_restart_never_downloads_or_starts_missing_managed_runtime(self):
        with patch.object(Path, "is_file", return_value=False), \
             patch.object(setup, "ensure_server", side_effect=AssertionError("started")):
            self.assertFalse(generate.start_managed_ollama())

    def test_generation_restart_releases_only_successfully_started_managed_daemon(self):
        activity, child = Mock(spec=setup.Activity), Mock()
        with patch.object(Path, "is_file", return_value=True), patch.object(setup, "Activity", return_value=activity), \
             patch.object(setup, "ensure_server", return_value=child) as start, \
             patch.object(generate, "OLLAMA_START_CANCELLED", False):
            self.assertTrue(generate.start_managed_ollama())
        start.assert_called_once_with(activity, managed_only=True)
        activity.release.assert_called_once_with(child)
        activity.cancel.assert_called_once()
        self.assertIsNone(generate.OLLAMA_START_ACTIVITY)

    def test_generation_eof_cancels_pending_start_and_prevents_late_start(self):
        activity = Mock(spec=setup.Activity)
        with patch.object(generate, "OLLAMA_START_ACTIVITY", activity), \
             patch.object(generate, "OLLAMA_START_CANCELLED", False), patch.object(Path, "is_file", return_value=True):
            generate.cancel_ollama_start()
            activity.cancel.assert_called_once()
            with self.assertRaisesRegex(RuntimeError, "취소"):
                generate.start_managed_ollama()

    @unittest.skipIf(os.name == "nt", "WSL requests and process groups")
    def test_translator_retries_tags_after_managed_server_restart(self):
        import requests
        response = Mock()
        response.json.return_value = {"models": [{"name": "qwen3:8b"}]}
        with patch.object(requests, "get", side_effect=[requests.exceptions.ConnectionError(), response]) as get, \
             patch.object(generate, "start_managed_ollama", return_value=True) as restart:
            generate.OllamaTranslator("ja")
        restart.assert_called_once()
        self.assertEqual(get.call_count, 2)
        response.close.assert_called_once()

    @unittest.skipIf(os.name == "nt", "WSL requests and process groups")
    def test_translator_preserves_missing_manual_server_error(self):
        import requests
        with patch.object(requests, "get", side_effect=requests.exceptions.ConnectionError()) as get, \
             patch.object(generate, "start_managed_ollama", return_value=False):
            with self.assertRaisesRegex(generate.LocalTranslationError, "연결할 수 없"):
                generate.OllamaTranslator("ja")
        self.assertEqual(get.call_count, 1)

    @unittest.skipIf(os.name == "nt", "WSL requests and process groups")
    def test_generation_stdin_eof_terminates_owned_startup_process(self):
        # Exercises the real generation watchdog and Linux process group cleanup,
        # using a sleeping Python child instead of an actual Ollama server.
        script = (
            "import generate,setup_environment,subprocess,sys,time;"
            "activity=setup_environment.Activity();generate.OLLAMA_START_ACTIVITY=activity;"
            "child=activity.start([sys.executable,'-c','import time;time.sleep(30)']);"
            "print(child.pid,flush=True);"
            "\nwith generate.cancel_on_stdin_close(): time.sleep(30)"
        )
        process = subprocess.Popen([setup.sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            pid = int(process.stdout.readline())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 130)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
