import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import setup_models as setup


class SetupModelsTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'models': {'base': {'filename': 'base.bin'}}, 'vad': {'filename': 'vad.bin'}}
        self.output = io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.engine = self.stack.enter_context(patch.object(setup, 'check_available'))
        self.stack.enter_context(patch.object(setup, 'read_manifest', return_value=self.manifest))
        self.matches = self.stack.enter_context(patch.object(setup, 'file_matches', return_value=False))
        self.download = self.stack.enter_context(patch.object(setup, 'ensure_model'))

    def events(self):
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def test_check_missing_is_read_only(self):
        setup.prepare(False, Path('/unused'))
        self.download.assert_not_called()
        self.assertEqual(self.events()[-2]['state'], 'missing')
        self.assertFalse(self.events()[-1]['available'])

    def test_reuses_verified_models_without_downloading(self):
        self.matches.return_value = True
        setup.prepare(True, Path('/unused'))
        self.download.assert_not_called()
        self.assertTrue(self.events()[-1]['available'])

    def test_installs_base_and_vad_with_existing_verified_downloader(self):
        setup.prepare(True, Path('/unused'))
        self.assertEqual([call.args[1] for call in self.download.call_args_list],
                         [self.manifest['models']['base'], self.manifest['vad']])
        self.assertTrue(self.events()[-1]['available'])

    def test_damaged_bundled_engine_reports_reinstall_without_network(self):
        self.engine.side_effect = RuntimeError('missing')
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            setup.prepare(True, Path('/unused'))
        self.download.assert_not_called()
        self.assertEqual(self.events()[0]['state'], 'failed')

    def test_download_integrity_error_never_claims_ready(self):
        self.download.side_effect = RuntimeError('checksum')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            setup.prepare(True, Path('/unused'))
        self.assertFalse(any(event.get('available') for event in self.events()))


if __name__ == '__main__':
    unittest.main()
