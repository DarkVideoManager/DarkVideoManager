"""Verified HTTPS downloads on Windows, including a fresh OS certificate store.

The unmodified certifi Mozilla public CA bundle supplements Windows roots only
inside this process. It never changes system trust or disables TLS validation.
"""
import hashlib
import os
import ssl
from pathlib import Path
import urllib.error


WINDOWS = os.name == 'nt'
BUNDLE = Path(__file__).resolve().parent / 'certificates/mozilla-ca.crt'
BUNDLE_SHA256 = '9cc2a774b5198dcff14d9be1e66091f538975d867ce029a96bce15a55dfd730f'


class DownloadTrustError(RuntimeError):
    pass


def create_download_context():
    context = ssl.create_default_context()
    if WINDOWS:
        try:
            data = BUNDLE.read_bytes()
            if hashlib.sha256(data).hexdigest() != BUNDLE_SHA256:
                raise ValueError('certificate bundle checksum mismatch')
            # Load the exact bytes that were verified; keep the system roots.
            context.load_verify_locations(cadata=data.decode('ascii'))
        except (OSError, ValueError, ssl.SSLError) as error:
            raise DownloadTrustError(
                '앱의 다운로드 인증서 파일이 없거나 손상되었습니다. 최신 실행파일을 다시 설치해 주세요. (TLS_BUNDLE)'
            ) from error
    return context


def download_error_message(error):
    """Only fixed diagnostics/status codes: never expose URLs, tokens or paths."""
    if isinstance(error, DownloadTrustError):
        return str(error)
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        return '모델 다운로드 서버의 인증서를 확인하지 못했습니다. Windows 날짜·시간과 네트워크 보안 설정을 확인해 주세요. (TLS_CERTIFICATE)'
    if isinstance(error, urllib.error.HTTPError):
        code = error.code if isinstance(error.code, int) and 100 <= error.code <= 599 else '오류'
        return f'모델 다운로드 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요. (HTTP {code})'
    if isinstance(reason, TimeoutError):
        return '모델 다운로드 연결 시간이 초과되었습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요. (NETWORK_TIMEOUT)'
    if isinstance(error, ValueError):
        return '다운로드한 모델의 크기 또는 무결성 검사에 실패했습니다. 다시 시도해 주세요. (MODEL_INTEGRITY)'
    return 'GPU 모델 다운로드에 실패했습니다. 인터넷 연결과 저장 공간을 확인한 뒤 다시 시도하세요.'
