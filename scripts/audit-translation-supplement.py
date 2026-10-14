"""Read-only recovery for translation review; never rewrite subtitle files."""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from subtitle_quality_parse import decode_subtitle, parse_subtitle
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('alignment', Path(__file__).with_name('audit-translation-alignment.py'))
alignment = module_from_spec(spec)
spec.loader.exec_module(alignment)
folder = Path(__file__).resolve().parents[1] / 'test-results/translation-quality-20261010'
rows = json.loads((folder/'corpus.json').read_text(encoding='utf-8'))['files']
recovered = []
for row in rows:
    if row['method'] != 'parse_warning':
        continue
    file = Path(row['path'])
    warning = row.get('error', '')
    try:
        try:
            text, encoding = decode_subtitle(file.read_bytes())
        except ValueError:
            text = file.read_bytes().decode('utf-8-sig', errors='strict')
            if '\ufffd' not in text:
                raise
            # Mark pre-existing damaged characters without inventing text.
            count = text.count('\ufffd')
            text = text.replace('\ufffd', '□')
            encoding = f'utf-8; {count} existing replacement characters marked □ in memory'
        extension = '.srt' if file.suffix.lower() == '.smi' and '-->' in text else file.suffix
        cues = parse_subtitle(text, extension)
        row.update(cues=cues, cue_count=len(cues), encoding=encoding,
                   recovered_warning=warning, korean_cues=sum(bool(alignment.KO.search(c['text'])) for c in cues))
        recovered.append({'id':row['id'], 'cues':len(cues), 'korean_cues':row['korean_cues'], 'warning':warning})
    except Exception as error:
        recovered.append({'id':row['id'], 'still_unverified':str(error)})

by_stem = {}
for row in rows:
    file = Path(row['path'])
    by_stem.setdefault((str(file.parent).casefold(), file.stem.casefold()), []).append(row)
supplemental = []
for row in rows:
    if row['method'] not in {'parse_warning','no_comparable_source'} or not row['cues']:
        continue
    file = Path(row['path'])
    internal = [{'cue':i+1,**p} for i,c in enumerate(row['cues']) if (p:=alignment.split_bilingual(c))]
    pairs, method, source = [], '', None
    if internal and len(internal)/max(1,row['korean_cues']) >= .4:
        pairs, method = internal, 'same_cue_bilingual'
    elif row['korean_cues']:
        source_stems = [file.stem+'_japanese']
        if file.stem.endswith('.ko'):
            source_stems.append(file.stem[:-3])
        for stem in source_stems:
            for candidate in by_stem.get((str(file.parent).casefold(),stem.casefold()), []):
                if candidate['cues'] and candidate.get('korean_cues',0) < max(1,len(candidate['cues']))*.1:
                    possible = alignment.align_external(candidate['cues'],row['cues'])
                    if len(possible)>len(pairs):
                        pairs, source = possible, candidate
        if pairs:
            method = 'paired_file_timestamps'
    if pairs:
        selected = sorted(set(round(i*(len(pairs)-1)/19) for i in range(20)))
        supplemental.append({'id':row['id'], 'path':row['path'], 'method':method,
            'cue_count':len(row['cues']), 'paired_cues':len(pairs),
            'pair_coverage':round(len(pairs)/len(row['cues']),4),
            'source_path': source['path'] if source else row['path'],
            'source_id': source['id'] if source else row['id'],
            'recovered_warning':row.get('recovered_warning'),
            'pairs':pairs, 'samples':[pairs[i] for i in selected]})
(folder/'supplemental-corpus.json').write_text(json.dumps({'recovered':recovered,'files':supplemental},ensure_ascii=False),encoding='utf-8')
print(json.dumps({'recovered':recovered,'additional_pairs':[{k:r[k] for k in ('id','method','source_id','cue_count','paired_cues','pair_coverage')} for r in supplemental]},ensure_ascii=False))
