"""Verify or prepare the bundled Windows Whisper engine and default models."""
import argparse
import json
import os
from pathlib import Path
import sys

from generate import cancel_on_stdin_close
from whisper_vulkan import check_available, read_manifest, file_matches, ensure_model


def emit(component, state, message, **values):
    print(json.dumps(dict(component=component, state=state, message=message, **values),
                     ensure_ascii=False), flush=True)


def prepare(install, cache=None):
    try:
        check_available()
    except Exception:
        emit('whisper', 'failed', '앱에 포함된 Whisper 엔진을 찾을 수 없습니다. 최신 GPU 지원 실행파일을 다시 설치해 주세요.')
        raise
    emit('whisper', 'ready', '앱에 포함된 Whisper 음성 인식 엔진이 준비되었습니다.')
    if cache is None:
        cache = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) / 'DarkVideoManager/subtitles/models'
    manifest = read_manifest()
    entries = [manifest['models']['base'], manifest['vad']]
    ready = all(file_matches(cache / entry['filename'], entry) for entry in entries)
    if not ready and install:
        for entry in entries:
            ensure_model(cache, entry, lambda **progress: emit(
                'speechModel', 'installing', progress.get('message', 'Whisper 기본 모델을 다운로드하고 있습니다.'),
                percent=progress.get('percent', 0)))
        ready = True
    emit('speechModel', 'ready' if ready else 'missing',
         'Whisper 기본 모델과 음성 감지 모델이 준비되었습니다.' if ready else 'Whisper 기본 모델 약 149 MB를 다운로드해야 합니다.')
    print(json.dumps(dict(completed=True, available=ready)), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--install', action='store_true')
    args = parser.parse_args()
    try:
        if args.install:
            with cancel_on_stdin_close():
                prepare(True)
        else:
            prepare(False)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
