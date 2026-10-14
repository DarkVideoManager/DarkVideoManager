"""Consolidate translation review and verify that all input files are intact."""
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path

base = Path(__file__).resolve().parents[1] / 'test-results/translation-quality-20261010'
corpus = json.loads((base/'corpus.json').read_text(encoding='utf-8'))['files']
supplement = json.loads((base/'supplemental-corpus.json').read_text(encoding='utf-8'))
by_id = {r['id']:r for r in corpus}
reviews = []
for shard in range(1,4):
    packet_ids = {r['id'] for r in json.loads((base/f'review-shard-{shard}.json').read_text(encoding='utf-8'))}
    shard_reviews = json.loads((base/f'review-results-{shard}.json').read_text(encoding='utf-8'))
    assert len(shard_reviews) == len(packet_ids)
    assert {r['id'] for r in shard_reviews} == packet_ids
    reviews.extend(shard_reviews)
reviews.extend(json.loads((base/'review-results-supplement.json').read_text(encoding='utf-8')))
assert len(reviews) == len({r['id'] for r in reviews}) == 390
review_by_id = {r['id']:r for r in reviews}
for r in supplement['files']:
    by_id[r['id']] = {**by_id[r['id']], **r}
for r in supplement['recovered']:
    if 'cues' in r and r['id'] not in review_by_id:
        by_id[r['id']]['method'] = 'source_only' if not r['korean_cues'] else 'no_comparable_source'
        by_id[r['id']]['cue_count'] = r['cues']

verification = {'unchanged':0,'missing':[],'changed':[],'new_subtitle_files':[]}
for row in corpus:
    p = Path(row['path'])
    if not p.exists():
        verification['missing'].append(row['path'])
    elif hashlib.sha256(p.read_bytes()).hexdigest() != row['sha256']:
        verification['changed'].append(row['path'])
    else:
        verification['unchanged'] += 1
known = {str(Path(r['path'])).casefold() for r in corpus}
extensions = {'.srt','.smi','.sami','.ass','.ssa','.vtt','.sub'}
for parent, directories, files in os.walk(r'E:\Users', followlinks=False):
    directories[:] = [d for d in directories if not (Path(parent)/d).is_symlink() and not (Path(parent)/d).is_junction()]
    for name in files:
        p = Path(parent)/name
        if p.suffix.lower() in extensions and str(p).casefold() not in known:
            verification['new_subtitle_files'].append(str(p))

def stamp(t):
    t = int(t)
    return f'{t//3600:02}:{t//60%60:02}:{t%60:02}'

def enrich(review):
    row = by_id[review['id']]
    pairs = {p['cue']:p for p in row.get('pairs',[])}
    p = Path(row['path'])
    source_peers = [s['path'] for s in corpus if Path(s['path']).parent == p.parent and Path(s['path']).stem == p.stem+'_japanese']
    evidence = [{'cue':c,'time':stamp(pairs[c]['start'])} for c in review['evidence_cues'] if c in pairs]
    return {**review,'path':row['path'],'sha256':row['sha256'],
            'cue_count':row.get('cue_count'), 'paired_cues':row.get('paired_cues'),
            'has_embedded_source':row['method']=='same_cue_bilingual',
            'separate_source_paths':source_peers,'evidence_locations':evidence}

enriched = [enrich(r) for r in reviews]
candidates = [r for r in enriched if r['decision']=='candidate']
assert {r['id'] for r in candidates} == {'F0535','F0563'}
priority_ids = ['F0060','F0077','F0113','F0122','F0126','F0130']
priority = [next(r for r in enriched if r['id']==id) for id in priority_ids]
assert all(r['decision']=='repair' for r in priority)
summary = {
    'checked_at':datetime.now().astimezone().isoformat(), 'root':r'E:\Users',
    'inventory_files':len(corpus), 'reviewed_files':len(reviews),
    'reliable_source_comparison_files':len(reviews)-1,
    'reviewed_pairs':sum(r['reviewed_pairs'] for r in reviews),
    'reliable_reviewed_pairs':sum(r['reviewed_pairs'] for r in reviews if r['decision']!='unverified'),
    'aligned_pairs':sum(r.get('paired_cues',0) for r in by_id.values()),
    'methods':dict(Counter(r['method'] for r in by_id.values())),
    'screening_decisions':dict(Counter(r['decision'] for r in reviews)),
    'deletion_candidates':len(candidates), 'priority_repairs':priority_ids,
    'audio_verified':False, 'deletion_executed':False, 'verification':verification,
    'limitations_ko':[
        '음성·영상과 대조하지 않았으므로 원문 인식 정확도는 검증하지 않았습니다.',
        '389개 파일은 대표 표본과 의심 구간을 검토했습니다. 후보 2개는 대응 가능한 번역 구간 전체를 검토했습니다.',
        '단일 자막 줄의 불일치 수는 오역률이 아닙니다. 인접 구간으로 이어진 번역도 포함될 수 있어 전체 삭제 근거로 단독 사용하지 않았습니다.',
        'keep은 표본에서 뚜렷한 문제가 없다는 뜻이며 전체 번역의 정확성을 보증하지 않습니다.',
        'F0428은 외부 원문과 시간 대응률 17.2%로 낮아 번역 정확도 판단에서 제외했습니다.',
        '복구한 자막의 기존 손상 문자는 메모리에서만 표시를 바꿔 읽었고 디스크의 원본은 수정하지 않았습니다.'
    ]
}
(base/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2),encoding='utf-8')
(base/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
(base/'candidates.json').write_text(json.dumps({'deletion_executed':False,'candidates':candidates,'priority_repairs':priority},ensure_ascii=False,indent=2),encoding='utf-8')
(base/'all-reviews.json').write_text(json.dumps({'summary':summary,'reviews':enriched},ensure_ascii=False,indent=2),encoding='utf-8')
lines = [
    'Users 자막 번역 품질 추가 검사',
    f"검사 완료: {summary['checked_at']}",
    '결론: 추가 삭제 후보 2개. 실제 삭제·원본 수정 없음.',
    '',
    '검사 범위',
    '남아 있던 608개 자막 파일을 목록과 해시로 확인했습니다.',
    f"원문·번역 비교 가능한 389개 파일에서 {summary['reliable_reviewed_pairs']:,}개 구간을 표본·심화 검토했습니다.",
    '추가 1개는 원문과 시간 대응이 불확실해 판단을 보류했습니다.',
    '원문만 있는 189개, 비교 원문 없는 한국어 28개, 형식 문제 1개는 번역 정확도를 판단하지 않았습니다.',
    '음성 대조는 하지 않았습니다. 보존 분류는 번역 전체가 정확하다는 뜻이 아닙니다.',
    '',
    '추가 삭제 후보',
]
for r in candidates:
    lines.extend([
        f"{r['id']} | {Path(r['path']).name}",r['path'],
        f"검토: 원문과 대응되는 {r['reviewed_pairs']}개 구간 전체. 명확한 불일치 {r['clear_mismatches']}개 확인.",
        r['reason_ko'],
        '근거 위치: '+', '.join(f"#{e['cue']} ({e['time']})" for e in r['evidence_locations'][:10]),
        '공통 예: 원문의 80만이 한국어에서 8천만으로 바뀜. 중국어 단어를 무관한 단어나 일본어식 이름으로 옮긴 사례 반복.',
        '파일 자체가 원문+한국어 자막입니다. 전체 파일을 삭제하면 안에 든 중국어 광고 원문도 함께 사라집니다.',
        '권고: 필요 없는 광고 자막이라면 삭제 후보. 영상 파일은 대상이 아닙니다.',''
    ])
lines += ['전체 삭제보다 시간 배치 복구·재번역을 우선할 6개','정상 번역과 원문이 남아 있어 전체 삭제 후보에서 제외했습니다.','']
for r in priority:
    lines += [f"{r['id']} | {Path(r['path']).name}",r['path'],r['reason_ko'],
              '별도 원문 파일: '+('있음' if r['separate_source_paths'] else '확인 안 됨'),
              '확인 위치: '+', '.join(f"#{e['cue']} ({e['time']})" for e in r['evidence_locations'][:6]),'']
lines += [
    '판정 보정',
    'F0113·F0122는 처음에 같은 시점의 원문·한국어만 비교했을 때 오류가 많아 보였습니다.',
    '앞뒤 자막을 이어 읽으니 뜻이 보존된 사례가 많아 전체 삭제 후보에서 제외했습니다.',
    '특히 F0122의 초기 23개 불일치는 전체 의미 상실을 과대평가한 집계였습니다.',
    '인접 문맥 재검토 후 확실한 잔여 문제는 7개이며 시간 배치·부분 번역을 수정하는 편이 맞습니다.',
    '',
    '검사 결과 분류 — 파일 전체의 정확도 점수가 아닌 표본 선별 결과',
    '삭제 후보 2 / 부분 수정·시간 배치 검토 240 / 원문 인식 문제 검토 82 / 표본에서 뚜렷한 문제 없음 65 / 시간 대응 불확실 1',
    '',
    '원본 보존 확인',
    f"기존 자막 {verification['unchanged']}개 SHA-256 일치. 변경 {len(verification['changed'])}개, 누락 {len(verification['missing'])}개.",
    f"검사 도중 새로 생긴 자막: {len(verification['new_subtitle_files'])}개.",
    '이번 작업은 파일을 읽고 검사 보고서만 작성했습니다. 자막·영상·라이브러리 DB를 수정하지 않았습니다.',
    '',
    '상세 근거: candidates.json / all-reviews.json / verification.json',
]
(base/'summary.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8-sig')
print(json.dumps(summary,ensure_ascii=False))
