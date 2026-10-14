"""TLS trust regression tests; no network or system certificate changes."""
import hashlib
import json
from pathlib import Path
import ssl
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import download_tls as tls


class DownloadTlsTests(unittest.TestCase):
    def test_empty_windows_trust_store_loads_verified_roots_with_validation_enabled(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(context.cert_store_stats()['x509_ca'], 0)
        with patch.object(tls, 'WINDOWS', True), patch.object(tls.ssl, 'create_default_context', return_value=context):
            prepared = tls.create_download_context()
        self.assertIs(prepared, context)
        self.assertGreater(prepared.cert_store_stats()['x509_ca'], 100)
        self.assertEqual(prepared.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(prepared.check_hostname)

    def test_existing_system_trust_is_kept_in_the_same_context(self):
        context = ssl.create_default_context()
        original = set(context.get_ca_certs(binary_form=True))
        with patch.object(tls, 'WINDOWS', True), patch.object(tls.ssl, 'create_default_context', return_value=context):
            prepared = tls.create_download_context()
        self.assertTrue(original.issubset(set(prepared.get_ca_certs(binary_form=True))))
        self.assertEqual(prepared.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(prepared.check_hostname)

    def test_missing_or_modified_bundle_fails_closed_even_with_existing_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'ca.crt'
            with patch.object(tls, 'WINDOWS', True), patch.object(tls, 'BUNDLE', bundle):
                with self.assertRaisesRegex(tls.DownloadTrustError, 'TLS_BUNDLE'):
                    tls.create_download_context()
                bundle.write_text('modified certificate data', encoding='ascii')
                with self.assertRaisesRegex(tls.DownloadTrustError, 'TLS_BUNDLE'):
                    tls.create_download_context()

    def test_linux_uses_system_trust_without_requiring_windows_bundle(self):
        with patch.object(tls, 'WINDOWS', False), patch.object(tls, 'BUNDLE', Path('/absent/public-ca.crt')):
            context = tls.create_download_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_packaged_receipt_and_runtime_pin_match_unmodified_bundle(self):
        receipt = json.loads((tls.BUNDLE.parent / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['source']['version'], '2026.7.22')
        self.assertEqual(receipt['sha256'], tls.BUNDLE_SHA256)
        self.assertEqual(hashlib.sha256(tls.BUNDLE.read_bytes()).hexdigest(), tls.BUNDLE_SHA256)
        self.assertEqual(receipt['license'], 'MPL-2.0')
        for name in receipt['licenseFiles']:
            self.assertTrue((tls.BUNDLE.parent / name).is_file())

    def test_network_diagnostics_do_not_disclose_urls_tokens_or_paths(self):
        sensitive_url = 'https://example.invalid/private?token=do-not-publish'
        certificate = urllib.error.URLError(ssl.SSLCertVerificationError(1, sensitive_url))
        http = urllib.error.HTTPError(sensitive_url, 403, sensitive_url, {}, None)
        for error, code in [(certificate, 'TLS_CERTIFICATE'), (http, 'HTTP 403'),
                            (TimeoutError(sensitive_url), 'NETWORK_TIMEOUT'), (ValueError(sensitive_url), 'MODEL_INTEGRITY')]:
            message = tls.download_error_message(error)
            self.assertIn(code, message)
            self.assertNotIn(sensitive_url, message)
        self.assertNotIn(sensitive_url, tls.download_error_message(OSError(sensitive_url)))


if __name__ == '__main__':
    unittest.main()
