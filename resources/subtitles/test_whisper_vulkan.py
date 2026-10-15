"""Native bridge contract tests; no models, GPU, or network required."""
import hashlib
import io
import json
import os
from contextlib import nullcontext, redirect_stderr
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import Mock, patch

import generate
import whisper_vulkan as vulkan


class VulkanTests(unittest.TestCase):
    def test_large_v2_cli_and_pinned_model_manifest(self):
        model = vulkan.read_manifest()["models"]["large-v2"]
        self.assertEqual(model["filename"], "ggml-large-v2.bin")
        self.assertEqual(model["size"], 3094623691)
        self.assertEqual(model["sha256"], "9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487")
        self.assertIn("/5359861c739e955e79d9a303bcbc70fb988958b1/", model["url"])
        with patch.object(sys, "argv", ["generate.py", "--model", "large-v2", "--backend", "vulkan"]), \
             patch.object(generate, "cancel_on_stdin_close", return_value=nullcontext(None)), \
             patch.object(generate, "run") as run:
            self.assertEqual(generate.main(), 0)
            self.assertEqual(run.call_args.args[0].model, "large-v2")
            self.assertEqual(run.call_args.args[0].backend, "vulkan")

    def audio(self, path, seconds=2):
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(b"\x12\x00" * round(seconds * 16000))
        return path

    def args(self, output, **options):
        values = dict(audio=str(output / "audio.wav"), output=str(output), model="base",
                      language="auto", translate_ko=True, resume=False,
                      backend="vulkan", transcribe_only=True,
                      checkpoint_audio="/mnt/c/jobs/audio.wav", model_cache=str(output / "models"))
        values.update(options)
        return SimpleNamespace(**values)

    def test_cpu_identity_stays_unchanged_and_gpu_identity_crosses_os_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            audio = self.audio(output / "audio.wav")
            cpu = self.args(output, backend="cpu")
            identity = generate.checkpoint_identity(audio, cpu, 2)
            self.assertEqual(identity, {
                "audio": str(audio.resolve()), "size": audio.stat().st_size,
                "sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "duration": 2,
                "model": "base", "language": "auto", "translate_ko": True,
                "transcription_options": generate.TRANSCRIPTION_OPTIONS,
            })
            gpu = generate.checkpoint_identity(audio, self.args(output), 2)
            self.assertEqual(gpu["audio"], "/mnt/c/jobs/audio.wav")
            self.assertEqual(gpu["backend"], "vulkan")
            self.assertEqual(gpu["transcription_options"], generate.VULKAN_TRANSCRIPTION_OPTIONS)
            self.assertEqual(gpu["sha256"], identity["sha256"])

    @patch.object(generate, "emit")
    def test_native_transcript_then_wsl_translation_resume_without_native_or_cpu_engine(self, emit):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.audio(output / "audio.wav")
            args = self.args(output)
            def fake_transcribe(audio, output, args, duration, offset, language, on_chunk, emit, options):
                on_chunk([{"start": .5, "end": 1.5, "text": "こんにちは"}], 2, "ja", "Vulkan0")
            with patch.object(vulkan, "transcribe", side_effect=fake_transcribe), \
                 patch.object(generate, "load_dependencies", side_effect=AssertionError("CPU loaded")), \
                 patch.object(generate, "translate_cues", side_effect=AssertionError("native must not translate")):
                generate.run(args)
            state = json.loads((output / "checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual(state["gpu_backend"], "Vulkan0")
            self.assertTrue(state["transcription_complete"])
            self.assertNotIn("translated", emit.call_args.kwargs)
            original = (output / "original.srt").read_bytes()
            args.resume, args.transcribe_only = True, False
            def translate(cues, language, completed, on_cue, translator_factory):
                result = [generate.Cue(.5, 1.5, "안녕하세요")]
                on_cue(result[0])
                return result
            with patch.object(vulkan, "transcribe", side_effect=AssertionError("native loaded")), \
                 patch.object(generate, "load_dependencies", side_effect=AssertionError("CPU loaded")), \
                 patch.object(generate, "translate_cues", side_effect=translate):
                generate.run(args)
            self.assertEqual((output / "original.srt").read_bytes(), original)
            self.assertEqual(emit.call_args.kwargs["translated"], "ko.srt")

    @patch.object(generate, "emit")
    def test_failed_chunk_retains_committed_prefix_and_silent_cursor_then_resumes(self, emit):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.audio(output / "audio.wav", 4)
            args = self.args(output)
            def first(audio, output, args, duration, offset, language, on_chunk, emit, options):
                on_chunk([], 1, None, "Vulkan0")
                on_chunk([{"start": 1, "end": 2, "text": "hello"}], 2.5, "en", "Vulkan0")
                raise RuntimeError("interrupted chunk")
            with patch.object(vulkan, "transcribe", side_effect=first):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    generate.run(args)
            args.resume = True
            def resumed(audio, output, args, duration, offset, language, on_chunk, emit, options):
                self.assertEqual((offset, language), (2.5, "en"))
                on_chunk([{"start": 3, "end": 4, "text": "bye"}], 4, "en", "Vulkan0")
            with patch.object(vulkan, "transcribe", side_effect=resumed):
                generate.run(args)
            saved = json.loads((output / "checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual([cue["text"] for cue in saved["cues"]], ["hello", "bye"])

    def test_silent_gpu_prefix_with_unset_auto_language_is_resumable(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            audio = self.audio(output / "audio.wav")
            identity = generate.checkpoint_identity(audio, self.args(output), 2)
            state = generate.load_checkpoint(output, identity, False)
            state["transcribed_until"] = 1
            generate.save_checkpoint(output, state)
            self.assertEqual(generate.load_checkpoint(output, identity, True)["transcribed_until"], 1)

    def test_boundary_utterance_is_committed_whole_and_not_repeated_in_next_window(self):
        segments = [{"start": 2, "end": 4, "text": "first"},
                    {"start": 298, "end": 310, "text": "crosses nominal boundary"},
                    {"start": 315, "end": 320, "text": "next window"}]
        committed, cursor = vulkan.commit_window(segments, 100, 400, 430, 900)
        self.assertEqual(cursor, 410)
        self.assertEqual([cue["text"] for cue in committed], ["first", "crosses nominal boundary"])
        self.assertEqual((committed[-1]["start"], committed[-1]["end"]), (398, 410))

    def test_truncated_boundary_segment_is_reprocessed_from_its_start(self):
        committed, cursor = vulkan.commit_window([
            {"start": 2, "end": 4, "text": "first"},
            {"start": 290, "end": 330, "text": "possibly truncated"},
        ], 0, 300, 330, 900)
        self.assertEqual(cursor, 290)
        self.assertEqual([cue["text"] for cue in committed], ["first"])
        self.assertEqual(vulkan.commit_window([], 300, 600, 630, 900), ([], 600))
        self.assertEqual(vulkan.commit_window([], 600, 900, 900, 900), ([], 900))

    def test_overlapping_boundary_cues_are_committed_together_or_deferred_together(self):
        segments = [{"start": 2, "end": 4, "text": "first"},
                    {"start": 298, "end": 310, "text": "crossing"},
                    {"start": 305, "end": 320, "text": "overlapping"}]
        committed, cursor = vulkan.commit_window(segments, 0, 300, 330, 900)
        self.assertEqual(committed, segments)
        self.assertEqual(cursor, 320)
        segments[-1]["end"] = 330
        committed, cursor = vulkan.commit_window(segments, 0, 300, 330, 900)
        self.assertEqual(committed, segments[:1])
        self.assertEqual(cursor, 298)
        nested = [{"start": 290, "end": 315, "text": "outer"},
                  {"start": 300, "end": 305, "text": "nested"},
                  {"start": 310, "end": 330, "text": "truncated"}]
        self.assertEqual(vulkan.commit_window(nested, 0, 300, 330, 900), ([], 290))

    def test_wave_slice_has_exact_frames_and_original_sample_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            audio = self.audio(output / "source.wav")
            vulkan.extract_wave(audio, output / "chunk.wav", .25, 1.25)
            with wave.open(str(output / "chunk.wav"), "rb") as chunk:
                self.assertEqual(chunk.getnframes(), 16000)
                self.assertEqual(chunk.readframes(16000), b"\x12\x00" * 16000)

    def test_multi_chunk_transcription_keeps_auto_language_until_speech_and_advances_silence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            audio = self.audio(output / "audio.wav", 12)
            options = {**generate.VULKAN_TRANSCRIPTION_OPTIONS, "chunk_seconds": 4, "right_context_seconds": 1}
            requests, saved = [], []
            def fake_cli(executable, model, vad, chunk, destination, language, options, report):
                requests.append(language)
                report(50, "Vulkan0")
                segments = [] if len(requests) == 1 else [
                    {"offsets": {"from": 1000, "to": 2000}, "text": "hello"},
                ]
                destination.with_suffix(".json").write_text(json.dumps({
                    "result": {"language": "nn" if not segments else "en"}, "transcription": segments,
                }), encoding="utf-8")
                return "Vulkan0"
            manifest = {"models": {"base": {}}, "vad": {}}
            with patch.object(vulkan, "check_available", return_value=Path("whisper-cli.exe")), \
                 patch.object(vulkan, "read_manifest", return_value=manifest), \
                 patch.object(vulkan, "ensure_model", return_value=Path("model")), \
                 patch.object(vulkan, "run_cli", side_effect=fake_cli):
                vulkan.transcribe(audio, output, self.args(output), 12, 0, None,
                                  lambda *values: saved.append(values), Mock(), options)
            self.assertEqual(requests, [None, None, "en"])
            self.assertEqual([item[1] for item in saved], [4, 8, 12])
            self.assertEqual([item[2] for item in saved], [None, "en", "en"])
            self.assertEqual(saved[1][0], [{"start": 5, "end": 6, "text": "hello"}])
            self.assertEqual(saved[2][0], [{"start": 9, "end": 10, "text": "hello"}])
            self.assertEqual(list(output.glob("vulkan-*")), [])

    def test_cli_json_uses_millisecond_offsets_and_validates_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            path.write_text(json.dumps({"result": {"language": "ja"}, "transcription": [
                {"offsets": {"from": 1250, "to": 1750}, "text": "  hello\nworld  "},
            ]}), encoding="utf-8")
            self.assertEqual(vulkan.parse_result(path, 2), ([{"start": 1.25, "end": 1.75, "text": "hello world"}], "ja"))
            path.write_text(json.dumps({"result": {"language": "ja"}, "transcription": [
                {"offsets": {"from": -1, "to": 10}, "text": "bad"},
            ]}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "올바르지"):
                vulkan.parse_result(path, 2)

    def native_result(self, cues=None, **extra):
        return {
            "result": {"language": "ja"},
            "transcription": cues if cues is not None else [
                {"offsets": {"from": 1250, "to": 1750}, "text": "private_placeholder_dialogue"},
            ],
            **extra,
        }

    def parse_native_bytes(self, content, duration=2):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private_placeholder_filename.json"
            path.write_bytes(content)
            return vulkan.parse_result(path, duration)

    def assert_native_result_rejected(self, content, duration=2):
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaisesRegex(RuntimeError, "올바르지") as caught:
            self.parse_native_bytes(content, duration)
        diagnostic = str(caught.exception) + stderr.getvalue()
        self.assertNotIn("private_placeholder_dialogue", diagnostic)
        self.assertNotIn("private_placeholder_filename", diagnostic)

    def test_cli_json_recovers_isolated_invalid_utf8_only_inside_cue_text(self):
        before = ("This ordinary placeholder sentence is complete and retains every surrounding word "
                  "before the unreadable character ")
        after = " and this remaining placeholder sentence must also stay available for a later translation."
        result = self.native_result([
            {"offsets": {"from": 125, "to": 875}, "text": before + "BAD_BYTES" + after},
            {"offsets": {"from": 1000, "to": 1750}, "text": "こんにちは。ありがとう。"},
        ])
        payload = json.dumps(result, ensure_ascii=False).encode("utf-8").replace(b"BAD_BYTES", b"\xff\xfe\x80\xc0")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            segments, language = self.parse_native_bytes(payload)
        self.assertEqual(language, "ja")
        self.assertEqual(segments, [
            {"start": .125, "end": .875, "text": before + "\ufffd" * 4 + after},
            {"start": 1, "end": 1.75, "text": "こんにちは。ありがとう。"},
        ])
        self.assertTrue(stderr.getvalue(), "An encoding recovery must be diagnosed without disclosing speech")
        self.assertNotIn(before.strip(), stderr.getvalue())
        self.assertNotIn(after.strip(), stderr.getvalue())
        self.assertNotIn("こんにちは", stderr.getvalue())
        self.assertNotIn("private_placeholder_filename", stderr.getvalue())

    def test_cli_json_accepts_native_raw_text_whitespace_and_keeps_utf8(self):
        result = self.native_result([
            {"offsets": {"from": 125, "to": 875}, "text": 'first "quoted" RAW_CONTROLS last'},
            {"offsets": {"from": 1000, "to": 1750}, "text": "こんにちは。"},
        ])
        payload = json.dumps(result, ensure_ascii=False).encode("utf-8").replace(b"RAW_CONTROLS", b"\n\r\t")
        with redirect_stderr(io.StringIO()):
            self.assertEqual(self.parse_native_bytes(payload), ([
                {"start": .125, "end": .875, "text": 'first "quoted" last'},
                {"start": 1, "end": 1.75, "text": "こんにちは。"},
            ], "ja"))

    def test_cli_json_keeps_valid_unicode_including_paired_json_surrogates(self):
        text = "こんにちは。 Thank you! \U0001f642 \ufffd"
        result = self.native_result([{"offsets": {"from": 125, "to": 875}, "text": text}])
        for escaped in (False, True):
            with self.subTest(escaped=escaped):
                stderr = io.StringIO()
                payload = json.dumps(result, ensure_ascii=escaped).encode("utf-8")
                with redirect_stderr(stderr):
                    self.assertEqual(self.parse_native_bytes(payload), ([
                        {"start": .125, "end": .875, "text": text},
                    ], "ja"))
                self.assertEqual(stderr.getvalue(), "")

    def test_cli_json_does_not_repair_corrupt_metadata_keys_or_structure(self):
        clean = json.dumps(self.native_result()).encode("utf-8")
        corruptions = {
            "language": clean.replace(b'"ja"', b'"j\xff"'),
            "key": clean.replace(b'"text"', b'"te\xffxt"'),
            "structure": clean.replace(b'"transcription":', b'"transcription"\xff:'),
            "time": clean.replace(b'1250', b'12\xff50'),
            "unused_metadata": json.dumps(self.native_result(model={"path": "BAD_BYTES"})).encode("utf-8")
                .replace(b"BAD_BYTES", b"\xff"),
            "unused_segment_metadata": json.dumps(self.native_result([
                {"offsets": {"from": 1250, "to": 1750}, "text": "private_placeholder_dialogue",
                 "tokens": [{"text": "BAD_BYTES"}]},
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff"),
            "raw_key_tab": clean.replace(b'"text"', b'"te\txt"'),
            "truncated_json": clean[:-1],
            "duplicate_key": clean.replace(b'"text":', b'"text": "discarded", "text":'),
        }
        for name, payload in corruptions.items():
            with self.subTest(corruption=name):
                self.assert_native_result_rejected(payload)

    def test_cli_json_rejects_severe_text_corruption_and_lone_surrogates(self):
        long_text = "private_placeholder_dialogue " * 20 + "BAD_BYTES"
        cases = {
            "cue_byte_budget": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": long_text},
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff" * 9),
            "cue_damage_ratio": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": "a BAD_BYTES b"},
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff"),
            "whitespace_cannot_pad_ratio": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": "a " + " \t\r\n" * 50 + "BAD_BYTES b"},
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff"),
            "discarded_controls_cannot_pad_ratio": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": "a " + "\x00\x01" * 50 + "BAD_BYTES b"},
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff"),
            "result_byte_budget": json.dumps(self.native_result([
                {"offsets": {"from": index * 200, "to": index * 200 + 100}, "text": long_text}
                for index in range(9)
            ])).encode("utf-8").replace(b"BAD_BYTES", b"\xff" * 4),
            "lone_high_surrogate": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": "private_placeholder_dialogue \ud800"},
            ])).encode("utf-8"),
            "lone_low_surrogate": json.dumps(self.native_result([
                {"offsets": {"from": 0, "to": 1000}, "text": "private_placeholder_dialogue \udc80"},
            ])).encode("utf-8"),
        }
        for name, payload in cases.items():
            with self.subTest(corruption=name):
                self.assert_native_result_rejected(payload)

    def test_cli_json_repairs_do_not_relax_shape_time_or_order_validation(self):
        cue = {"offsets": {"from": 1250, "to": 1750}, "text": "private_placeholder_dialogue"}
        invalid_results = {
            "missing_result": {"transcription": [cue]},
            "wrong_root": [],
            "wrong_transcription": self.native_result("private_placeholder_dialogue"),
            "wrong_item": self.native_result([None]),
            "wrong_text": self.native_result([{**cue, "text": 42}]),
            "invalid_language": self.native_result(result={"language": "private_placeholder_dialogue"}),
            "unordered": self.native_result([cue, {"offsets": {"from": 500, "to": 750}, "text": "earlier"}]),
        }
        for name, start, end in [
            ("negative", -1, 1750), ("reversed", 1750, 1250), ("zero_length", 1250, 1250),
            ("outside_window", 2000, 2500), ("boolean", True, 1750), ("string", "1250", 1750),
            ("nan_start", float("nan"), 1750), ("nan_end", 1250, float("nan")),
            ("infinite_start", float("inf"), 1750), ("infinite_end", 1250, float("inf")),
            ("overflow", 10 ** 400, 10 ** 401),
        ]:
            invalid_results[name] = self.native_result([{**cue, "offsets": {"from": start, "to": end}}])
        for name, result in invalid_results.items():
            with self.subTest(invalid=name):
                self.assert_native_result_rejected(json.dumps(result).encode("utf-8"))
        for duration in (float("nan"), float("inf"), 0, -1):
            with self.subTest(duration=duration):
                self.assert_native_result_rejected(json.dumps(self.native_result()).encode("utf-8"), duration)

    def test_model_download_verifies_digest_before_replacing_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            target = cache / "model.bin"
            target.write_bytes(b"old")
            entry = {"filename": "model.bin", "url": "https://huggingface.co/example",
                     "size": 4, "sha256": hashlib.sha256(b"good").hexdigest()}
            with patch.object(vulkan.urllib.request, "urlopen", return_value=io.BytesIO(b"evil")):
                with self.assertRaisesRegex(RuntimeError, "무결성"):
                    vulkan.ensure_model(cache, entry, Mock())
            self.assertEqual(target.read_bytes(), b"old")
            self.assertEqual(list(cache.glob("*.part")), [])
            with patch.object(vulkan.urllib.request, "urlopen", return_value=io.BytesIO(b"good")):
                self.assertEqual(vulkan.ensure_model(cache, entry, Mock()), target)
            self.assertEqual(target.read_bytes(), b"good")
            with patch.object(vulkan.urllib.request, "urlopen", side_effect=AssertionError("cached download")):
                vulkan.ensure_model(cache, entry, Mock())

    def test_registry_kills_real_child_and_rejects_spawn_after_cancellation(self):
        registry = vulkan.ChildProcesses()
        child = registry.start([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL)
        registry.cancel()
        self.assertIsNotNone(child.poll())
        registry.remove(child)
        with self.assertRaisesRegex(RuntimeError, "취소"):
            registry.start([sys.executable, "-c", "pass"])

    def test_cancellation_removes_only_its_owned_partial_model_download(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            untouched = cache / "other-worker.part"
            untouched.write_bytes(b"another worker")
            registry = vulkan.ChildProcesses()
            output = registry.new_download(cache, ".model.bin.")
            output.write(b"partial")
            registry.cancel()
            self.assertTrue(output.closed)
            self.assertFalse(Path(output.name).exists())
            self.assertEqual(untouched.read_bytes(), b"another worker")
            registry.release_download(output)
            with self.assertRaisesRegex(RuntimeError, "취소"):
                registry.new_download(cache, ".model.bin.")

    def test_native_cli_requires_gpu_proof_and_reports_verified_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            result = Path(directory) / "transcript"
            result.with_suffix(".json").write_text("{}")
            for logs, accepted in [
                ("ggml_vulkan: Found 1 Vulkan devices\n", False),
                ("whisper_backend_init_gpu: using Vulkan0 backend\nwhisper_print_progress_callback: progress = 50%\n", True),
                ("whisper_backend_init_gpu: using Vulkan0 backend\nwhisper_backend_init_gpu: no GPU found\nwhisper_print_progress_callback: progress = 50%\n", True),
                ("whisper_backend_init_gpu: no GPU found\n", False),
            ]:
                with self.subTest(logs=logs):
                    child = Mock(stderr=io.StringIO(logs))
                    child.wait.return_value, child.poll.return_value = 0, 0
                    progress = Mock()
                    with patch.object(vulkan.CHILDREN, "start", return_value=child), \
                         patch.object(vulkan.CHILDREN, "remove"):
                        if accepted:
                            backend = vulkan.run_cli("whisper-cli.exe", "model", "vad", "audio", result,
                                                     "ja", generate.VULKAN_TRANSCRIPTION_OPTIONS, progress)
                            self.assertEqual(backend, "Vulkan0")
                            self.assertEqual([call.args for call in progress.call_args_list], [(0, "Vulkan0"), (50, "Vulkan0")])
                        else:
                            with self.assertRaisesRegex(RuntimeError, "GPU"):
                                vulkan.run_cli("whisper-cli.exe", "model", "vad", "audio", result,
                                               "ja", generate.VULKAN_TRANSCRIPTION_OPTIONS, progress)
                            progress.assert_not_called()

    def test_failed_vulkan_initialization_is_rejected_even_after_backend_selection(self):
        child = Mock(stderr=io.StringIO(
            "whisper_backend_init_gpu: using Vulkan0 backend\n"
            "whisper_backend_init_gpu: failed to initialize Vulkan0 backend\n"))
        child.wait.return_value, child.poll.return_value = 0, 0
        with patch.object(vulkan.CHILDREN, "start", return_value=child), \
             patch.object(vulkan.CHILDREN, "remove"):
            with self.assertRaisesRegex(RuntimeError, "초기화"):
                vulkan.run_cli("whisper-cli.exe", "model", "vad", "audio", Path("unused"),
                               "ja", generate.VULKAN_TRANSCRIPTION_OPTIONS, Mock())

    def test_stdin_eof_terminates_registered_child_before_worker_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            script = (
                f"import sys;sys.path.insert(0,{str(Path(__file__).parent)!r});"
                "import generate,whisper_vulkan,subprocess,sys,time,pathlib;"
                "child=whisper_vulkan.CHILDREN.start([sys.executable,'-c','import time; time.sleep(30)']);"
                "print(child.pid,flush=True);"
                "\nwith generate.cancel_on_stdin_close(): time.sleep(30)"
            )
            child = subprocess.Popen([sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                native_pid = int(child.stdout.readline())
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5), 130)
                if os.name == "nt":
                    import ctypes
                    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, native_pid)
                    if handle:
                        try:
                            exit_code = ctypes.c_ulong()
                            self.assertTrue(ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)))
                            self.assertNotEqual(exit_code.value, 259)
                        finally:
                            ctypes.windll.kernel32.CloseHandle(handle)
                else:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(native_pid, 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)
                if not child.stdin.closed:
                    child.stdin.close()
                child.stdout.close()
                child.stderr.close()

    def test_stdin_eof_during_native_import_or_cleanup_failure_always_exits(self):
        for cleanup in ("", "module.cancel_all_children=lambda: (_ for _ in ()).throw(RuntimeError('cleanup'));"):
            with self.subTest(cleanup=cleanup):
                script = (
                    f"import sys;sys.path.insert(0,{str(Path(__file__).parent)!r});"
                    "import generate,types,time;"
                    "module=types.ModuleType('whisper_vulkan');sys.modules['whisper_vulkan']=module;"
                    + cleanup +
                    "print('ready',flush=True);\nwith generate.cancel_on_stdin_close(): time.sleep(30)"
                )
                child = subprocess.Popen([sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertEqual(child.stdout.readline().strip(), b"ready")
                    child.stdin.close()
                    self.assertEqual(child.wait(timeout=5), 130)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=3)
                    if not child.stdin.closed:
                        child.stdin.close()
                    child.stdout.close()
                    child.stderr.close()


if __name__ == "__main__":
    unittest.main()
