"""Read-only subtitle inventory and file-level quality audit. Never deletes files."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
from subtitle_quality_parse import decode_subtitle, parse_subtitle

EXTENSIONS = {'.srt', '.vtt', '.ass', '.ssa', '.smi', '.sami', '.sub', '.idx'}
MEANINGFUL_SHORT = {'네', '예', '응', '아니', '아니요', '싫어', '그만', '좋아', 'はい', 'いいえ', 'いや', 'だめ', 'やめて', 'yes', 'no', 'stop', 'ok', 'okay'}
NON_SPEECH = {'music', 'silence', 'applause', 'laughter', 'laughing', 'inaudible', '음악', '침묵', '무음', '박수', '웃음', '신음', '신음소리', '音楽', '無音', '拍手', '笑い', '笑', '呻吟', 'b​gm'.replace('\u200b', '')}
BOILERPLATE = {'ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'チャンネル登録お願いします', '시청해주셔서감사합니다', '시청해주셔서고맙습니다', 'thankyouforwatching', 'thanksforwatching'}


def key(text):
    return ''.join(character for character in unicodedata.normalize('NFKC', text).lower() if character.isalnum())


def cue_reason(text, counts):
    token = key(text)
    if not token:
        return 'empty_or_symbols'
    if token in NON_SPEECH:
        return 'non_speech_label'
    if token in MEANINGFUL_SHORT:
        return None
    lines = [line for line in text.splitlines() if key(line)]
    if len(lines) > 1 and all(cue_reason(line, counts) for line in lines):
        return 'multiline_junk'
    if token in BOILERPLATE and counts[token] >= 4:
        return 'repeated_outro'
    if len(token) >= 12:
        repetition = re.search(r'(.{1,12}?)\1{4,}', token)
        if repetition and len(repetition.group(0)) / len(token) >= .85:
            return 'numeric_loop' if repetition.group(1).isdecimal() else 'text_loop'
        if len(token) >= 16 and max(Counter(token).values()) / len(token) >= .90:
            return 'character_loop'
    if re.fullmatch(r'[あぁアァおぉオォうぅウゥえぇエェんンっッはハふフひヒほホへヘー]+', token):
        return 'interjection'
    if re.fullmatch(r'[아어으음오우휴흐하허헉앗앜악흠헐ㅋㅎㅠㅜᄏ휴ᅮ]+', token):
        return 'interjection'
    if re.fullmatch(r'(?:(?:a+h+|o+h+|u+h+|u+m+|h+m+|m{2,}|h+a+|h+e+h+|h+u+h+))+', token):
        return 'interjection'
    return None


def statistics(cues):
    counts = Counter(key(cue['text']) for cue in cues)
    total_weight = junk_weight = total_time = junk_time = junk_count = 0
    reasons = Counter()
    samples = []
    classified = []
    for index, cue in enumerate(cues):
        normalized = key(cue['text'])
        weight = min(120, max(1, len(normalized)))
        duration = max(0, min(10, (cue['end'] or cue['start']) - cue['start']))
        reason = cue_reason(cue['text'], counts)
        total_weight += weight
        total_time += duration
        if reason:
            junk_count += 1
            junk_weight += weight
            junk_time += duration
            reasons[reason] += 1
        classified.append({'index': index + 1, 'reason': reason, **cue})
    positions = set(round(index * (len(cues) - 1) / 11) for index in range(12)) if cues else set()
    for index in sorted(positions):
        cue = classified[index]
        samples.append({**cue, 'text': cue['text'][:220]})
    nonjunk = [cue for cue in classified if not cue['reason']]
    stream = ''.join(key(cue['text']) for cue in cues)
    across_ratio = 0.0
    if 24 <= len(stream) <= 250_000:
        across_ratio = sum(len(match.group(0)) for match in re.finditer(r'(.{1,40}?)\1{4,}', stream)) / len(stream)
    return {
        'cue_count': len(cues), 'junk_cues': junk_count,
        'junk_cue_ratio': round(junk_count / max(1, len(cues)), 4),
        'junk_text_ratio': round(junk_weight / max(1, total_weight), 4),
        'junk_time_ratio': round(junk_time / max(1, total_time), 4),
        'reasons': dict(reasons),
        'unique_ratio': round(len(counts) / max(1, len(cues)), 4),
        'dominant_ratio': round(max(counts.values(), default=0) / max(1, len(cues)), 4),
        'cross_cue_repetition_ratio': round(across_ratio, 4),
        'top_texts': [{'text': token[:180], 'count': count} for token, count in counts.most_common(6)],
        'samples': samples,
        'nonjunk_samples': [{'index': cue['index'], 'text': cue['text'][:220]} for cue in nonjunk[:8]],
    }


def active_video_stems(queue_path):
    if not queue_path or not queue_path.exists():
        return []
    queue = json.loads(queue_path.read_text(encoding='utf-8-sig'))
    return [str(Path(entry['videoPath']).with_suffix('')).casefold()
            for entry in queue.get('entries', [])
            if entry.get('job', {}).get('phase') in {'preparing', 'loading', 'transcribing', 'translating', 'saving', 'pausing', 'removing'}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--queue', type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    active = active_video_stems(args.queue)
    entries, errors, skipped = [], [], []
    directories = 0
    files_seen = 0
    for directory, folders, files in os.walk(root, followlinks=False, onerror=lambda error: errors.append(str(error))):
        directories += 1
        for name in list(folders):
            folder = Path(directory) / name
            if folder.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                folders.remove(name)
                skipped.append(str(folder))
        for name in files:
            files_seen += 1
            path = Path(directory) / name
            if path.suffix.lower() not in EXTENSIONS:
                continue
            entry = {'path': str(path), 'extension': path.suffix.lower(), 'decision': 'review'}
            try:
                initial = path.lstat()
                if not stat.S_ISREG(initial.st_mode) or initial.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ValueError('Not a regular file or is a reparse point')
                if not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError('File resolves outside the audit root')
                if initial.st_size > 20 * 1024 * 1024:
                    raise ValueError('Subtitle exceeds the 20 MiB inspection bound')
                data = path.read_bytes()
                final = path.stat()
                if (initial.st_size, initial.st_mtime_ns) != (final.st_size, final.st_mtime_ns):
                    raise ValueError('File changed while being inspected')
                entry.update(size=len(data), mtime_ns=initial.st_mtime_ns, sha256=hashlib.sha256(data).hexdigest())
                text, encoding = decode_subtitle(data)
                entry['encoding'] = encoding
                cues = parse_subtitle(text, path.suffix.lower())
                entry.update(statistics(cues))
                tracks = {}
                for track in set(cue['track'] for cue in cues):
                    part = statistics([cue for cue in cues if cue['track'] == track])
                    tracks[track] = {field: part[field] for field in ('cue_count', 'junk_cue_ratio', 'junk_text_ratio')}
                entry['tracks'] = tracks
                qualifies = not cues or (entry['junk_cue_ratio'] >= .60 and entry['junk_text_ratio'] >= .60)
                if qualifies and any(part['junk_cue_ratio'] < .60 or part['junk_text_ratio'] < .60 for part in tracks.values()):
                    qualifies = False
                    entry['review_reason'] = 'A language track contains meaningful dialogue'
                entry['decision'] = 'candidate' if qualifies else 'keep'
                if not qualifies and (max(entry['junk_cue_ratio'], entry['junk_text_ratio']) >= .45 or entry['dominant_ratio'] >= .45 or entry['unique_ratio'] < .18):
                    entry['decision'] = 'review'
                if entry['cross_cue_repetition_ratio'] >= .60 and entry['decision'] == 'keep':
                    entry['decision'] = 'review'
                if any(str(path).casefold().startswith(stem + '.') for stem in active):
                    entry['active_job'] = True
                    entry['decision'] = 'active_hold'
            except Exception as error:
                entry['error'] = str(error)
                entry['decision'] = 'review'
            entries.append(entry)
    report = {
        'root': str(root), 'created_at': datetime.now().astimezone().isoformat(),
        'policy': 'User approved deletion of files mostly comprising repetition or interjections. Read-only audit; candidates require review before recycling.',
        'directories': directories, 'files_seen': files_seen,
        'subtitle_files': len(entries), 'counts': dict(Counter(entry['decision'] for entry in entries)),
        'traversal_errors': errors, 'skipped_reparse_directories': skipped, 'entries': entries,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({field: report[field] for field in ('root', 'directories', 'files_seen', 'subtitle_files', 'counts', 'traversal_errors', 'skipped_reparse_directories')}, ensure_ascii=True))


if __name__ == '__main__':
    main()
