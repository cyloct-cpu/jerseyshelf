"""Repeatable preliminary retrieval benchmark, never a substitute for real photos."""
import argparse, io, json, time
from pathlib import Path
from engine import Search, STATE, decode, catalog
from PIL import Image, ImageOps
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--samples', type=int, default=60)
args = parser.parse_args()
engine = Search()
paths = {r['path']: r['file'] for r in catalog()}
records = engine.info['records']
# One independently selected query per product, instead of letting large galleries dominate.
chosen, seen = [], set()
for record in records:
    if not seen.intersection(record['products']):
        chosen.append(record)
        seen.update(record['products'])
if len(chosen) > args.samples:
    chosen = [chosen[int(i)] for i in np.linspace(0, len(chosen)-1, args.samples)]
metrics = {name: [] for name in ['jpeg_screenshot', 'crop', 'held_out_view']}
latencies = []
details = []
for n, record in enumerate(chosen):
    original = decode(Path(paths[record['path']]).read_bytes(), trusted=True)
    original.thumbnail((1600,1600))
    variants = {}
    small = original.copy()
    small.thumbnail((450, 450))
    variants['jpeg_screenshot'] = ImageOps.expand(small, border=25, fill='white')
    w, h = original.size
    variants['crop'] = original.crop((int(w*.08), int(h*.06), int(w*.94), int(h*.95)))
    variants['held_out_view'] = original
    for kind, image in variants.items():
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=65)
        before = time.monotonic()
        rows = engine.query(output.getvalue(), exclude_path=record['path'] if kind == 'held_out_view' else None)
        ms = (time.monotonic()-before)*1000
        latencies.append(ms)
        rank = next((i+1 for i,r in enumerate(rows) if r['id'] in record['products']), None)
        metrics[kind].append(rank)
        visible = [r for r in rows if r['score'] >= 0.90]
        visible_rank = next((i+1 for i,r in enumerate(visible) if r['id'] in record['products']), None)
        details.append({'path':record['path'],'kind':kind,'rank':rank,'visibleRankAt090':visible_rank,'topScore':rows[0]['score'] if rows else None})
    if (n+1) % 10 == 0:
        print(json.dumps({'evaluated_products': n+1}), flush=True)
negative_scores = []
for color in ['white','black','red','blue','green','gray']:
    output=io.BytesIO()
    Image.new('RGB',(300,300),color).save(output,format='PNG')
    rows=engine.query(output.getvalue())
    negative_scores.append({'sample':color,'topScore':rows[0]['score'] if rows else None})
report = {'accepted': False, 'kind':'preliminary_synthetic_only', 'generation':engine.info['generation'],
          'indexImages':len(records), 'productsTested':len(chosen),'queryCount':len(latencies),
          'warning':'Synthetic gallery transforms and held-out gallery views only. No independent customer photos or labelled absent styles. Do not enable public search based on this report.',
          'p95Ms':round(float(np.percentile(latencies,95))),
          'metrics':{k:{'n':len(v),'top1':sum(r==1 for r in v)/len(v),'top5':sum(r is not None and r<=5 for r in v)/len(v),'top10':sum(r is not None and r<=10 for r in v)/len(v)} for k,v in metrics.items() if v},
          'visibleMetricsAt090':{k:{'n':len([d for d in details if d['kind']==k]),'top5':sum(d['visibleRankAt090'] is not None and d['visibleRankAt090']<=5 for d in details if d['kind']==k)/len([d for d in details if d['kind']==k]),'top10':sum(d['visibleRankAt090'] is not None and d['visibleRankAt090']<=10 for d in details if d['kind']==k)/len([d for d in details if d['kind']==k])} for k in metrics if metrics[k]},
          'blankImageScores':negative_scores,'details':details}
(STATE/'trial-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ('details',)},indent=2),flush=True)
