"""Read-only source/translation alignment and representative review packets."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from subtitle_quality_parse import decode_subtitle, parse_subtitle

JA = re.compile(r'[\u3040-\u30ff\u3400-\u9fff]')
KO = re.compile(r'[\uac00-\ud7a3]')


def compact(text):
    return ''.join(c.lower() for c in text if c.isalnum())


def split_bilingual(cue):
    lines = [line.strip() for line in cue['text'].splitlines() if line.strip()]
    korean = [line for line in lines if KO.search(line)]
    source = [line for line in lines if not KO.search(line)]
    if not korean or not source or not any(c.isalpha() for c in ''.join(source)):
        return None
    return {'start': cue['start'], 'end': cue['end'], 'source': ' '.join(source), 'target': ' '.join(korean)}


def align_external(source, target):
    pairs = []
    cursor = 0
    for index, cue in enumerate(target):
        end = cue['end'] if cue['end'] is not None else cue['start']
        while cursor < len(source) and (source[cursor]['end'] or source[cursor]['start']) < cue['start'] - .15:
            cursor += 1
        matches = []
        for original in source[cursor:]:
            if original['start'] > end + .15:
                break
            original_end = original['end'] if original['end'] is not None else original['start']
            overlap = max(0, min(end, original_end) - max(cue['start'], original['start']))
            shortest = max(.001, min(end - cue['start'], original_end - original['start']))
            if overlap / shortest >= .6 or (abs(cue['start'] - original['start']) < .08 and abs(end - original_end) < .08):
                matches.append(original)
        if matches:
            pairs.append({'cue': index + 1, 'start': cue['start'], 'end': cue['end'], 'source': ' '.join(item['text'] for item in matches), 'target': cue['text']})
    return pairs


def indicators(pair):
    source, target = compact(pair['source']), compact(pair['target'])
    flags = []
    if len(source) >= 15 and len(target) < len(source) * .20:
        flags.append('very_short_target')
    if len(target) > max(60, len(source) * 4):
        flags.append('expanded_target')
    if len(source) >= 5 and source == target:
        flags.append('unchanged_source')
    if JA.search(pair['target']) and not KO.search(pair['target']):
        flags.append('no_korean')
    if re.search(r'(?:번역할|번역문은|번역해|제공할 수 없|도와드릴 수 없|한국어 번역|as an ai|cannot translate|<think>)', pair['target'], re.I):
        flags.append('possible_meta_response')
    numbers_source, numbers_target = re.findall(r'\d+', pair['source']), re.findall(r'\d+', pair['target'])
    if numbers_source and numbers_target and numbers_source != numbers_target:
        flags.append('changed_numeric_digits')
    return flags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    old = json.loads(args.inventory.read_text(encoding='utf-8'))
    records = []
    by_path = {}
    for index, entry in enumerate(old['entries']):
        file = Path(entry['path'])
        if not file.exists():
            continue
        row = {'id': f'F{index:04d}', 'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
        try:
            text, encoding = decode_subtitle(file.read_bytes())
            cues = parse_subtitle(text, file.suffix.lower())
            row.update(cues=cues, encoding=encoding, cue_count=len(cues))
        except Exception as error:
            row.update(cues=[], error=str(error))
        records.append(row)
        by_path[str(file).casefold()] = row
    packets = []
    for row in records:
        file = Path(row['path'])
        internal = [{'cue': index + 1, **pair} for index, cue in enumerate(row['cues']) if (pair := split_bilingual(cue))]
        korean_count = sum(bool(KO.search(cue['text'])) for cue in row['cues'])
        row['korean_cues'] = korean_count
        source_file = None
        if internal and len(internal) / max(1, korean_count) >= .4:
            pairs = internal
            method = 'same_cue_bilingual'
        elif korean_count:
            candidates = []
            if file.stem.endswith('.ko'):
                candidates.append(file.with_name(file.stem[:-3] + file.suffix))
            candidates.append(file.with_name(file.stem + '_japanese' + file.suffix))
            for candidate in candidates:
                source_file = by_path.get(str(candidate).casefold())
                if source_file and source_file['cues']:
                    break
            if source_file and source_file['cues']:
                pairs = align_external(source_file['cues'], row['cues'])
                method = 'paired_file_timestamps'
            else:
                pairs, method = [], 'no_comparable_source'
        else:
            pairs, method = [], 'source_only' if row['cues'] else 'parse_warning'
        row['method'] = method
        row['paired_cues'] = len(pairs)
        row['pair_coverage'] = round(len(pairs) / max(1, row.get('cue_count', 0)), 4)
        row['source_path'] = source_file['path'] if source_file else row['path'] if internal else None
        if not pairs:
            continue
        totals = Counter()
        target_sources = defaultdict(set)
        for pair in pairs:
            pair['flags'] = indicators(pair)
            totals.update(pair['flags'])
            target_sources[compact(pair['target'])].add(compact(pair['source']))
        for pair in pairs:
            if len(compact(pair['source'])) >= 6 and len(target_sources[compact(pair['target'])]) >= 5:
                pair['flags'].append('same_target_many_sources')
                totals['same_target_many_sources'] += 1
        # Fixed, evenly-spaced coverage plus highest-anomaly examples. Every
        # paired cue receives mechanical checks; semantics are sampled below.
        selected = set(round(i * (len(pairs) - 1) / 9) for i in range(10))
        extras = sorted(range(len(pairs)), key=lambda i: (-len(pairs[i]['flags']), -min(500, len(pairs[i]['source'])), i))
        for index in extras:
            if pairs[index]['flags'] and len(selected) < 14:
                selected.add(index)
        samples = []
        for index in sorted(selected):
            pair = pairs[index]
            samples.append({**pair, 'source': pair['source'][:280], 'target': pair['target'][:280],
                            'truncated': len(pair['source']) > 280 or len(pair['target']) > 280})
        row['anomaly_counts'] = dict(totals)
        row['pairs'] = pairs
        packet = {field: row.get(field) for field in ('id', 'method', 'cue_count', 'korean_cues', 'paired_cues', 'pair_coverage', 'anomaly_counts')}
        packet.update(samples=samples, has_separate_source=bool(source_file))
        packets.append(packet)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'corpus.json').write_text(json.dumps({'files': records, 'source_inventory': str(args.inventory)}, ensure_ascii=False), encoding='utf-8')
    for shard in range(3):
        (args.output/f'review-shard-{shard+1}.json').write_text(json.dumps(packets[shard::3], ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {'files': len(records), 'methods': dict(Counter(row['method'] for row in records)),
               'paired_cues': sum(row['paired_cues'] for row in records), 'review_packets': len(packets),
               'semantic_sample_count': sum(len(packet['samples']) for packet in packets)}
    (args.output/'coverage.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
