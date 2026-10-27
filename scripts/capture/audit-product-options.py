"""Read a bounded selection of public reference pages; never submit forms.

Keep this audit separate from the full catalog manifest. Downloaded JavaScript
is archived as page data and is never executed.
"""
import concurrent.futures, datetime, json, pathlib, sys
from shoplazza import BASE, Tree, get

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/source/reference-audit-2026-10-14'
SAMPLES = {
    'bayern': '/products/2026-27-bayern-munich-away-kit-fan-edition',
    'retro': '/products/2013-14-manchester-united-white-retro-jersey',
    'kids': '/products/2005-06-arsenal-home-retro-shirt-kids-sizes',
    'windbreaker': '/products/2025-26-adidas-casual-trench-coat-v9tw',
    'shorts': '/products/2026-27-ac-milan-home-shorts-fan-edition',
    'national-training': '/products/2024-25-argentina-training-vest',
    'cart': '/cart',
    'login': '/account/login',
    'register': '/account/register',
    'policy': '/pages/returns-refund-policy',
    'blog': '/blogs/before-after',
}

def inspect(item):
    name, path = item
    try:
        source = get(BASE + path, OUT / (name + '.html')).decode('utf-8')
        tree = Tree(source).root
        arrays, position = [], 0
        while True:
            start = source.find('[{"fid"', position)
            if start < 0:
                break
            try:
                value, length = json.JSONDecoder().raw_decode(source[start:])
                arrays.append(value)
                position = start + length
            except ValueError:
                position = start + 7
        headings = [n.text()[:250] for n in tree.all(lambda n: n.tag in {'h1', 'h2', 'h3'})]
        inputs = [{k: n.attrs[k] for k in ['type', 'name', 'placeholder', 'required', 'maxlength'] if k in n.attrs}
                  for n in tree.all(lambda n: n.tag == 'input')]
        forms = [n.attrs for n in tree.all(lambda n: n.tag in {'form', 'spz-form'})]
        options = [n.text()[:150] for n in tree.all(lambda n: n.tag == 'option')]
        buttons = [n.text()[:150] for n in tree.all(lambda n: n.tag == 'button')]
        result = {'name': name, 'url': BASE + path, 'bytes': len(source.encode('utf-8')),
                  'headings': headings, 'inputs': inputs, 'forms': forms, 'selectOptions': options,
                  'buttons': buttons, 'customization': arrays}
        return result
    except Exception as error:
        return {'name': name, 'url': BASE + path, 'error': str(error)}

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(inspect, SAMPLES.items()))
    report = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pages': records,
              'scope': 'Public HTML/config only. No form submissions, orders, or private API access.'}
    (OUT / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    for item in records:
        print(json.dumps({'name': item['name'], 'error': item.get('error'), 'bytes': item.get('bytes'),
                          'headings': item.get('headings', [])[-6:],
                          'customization': [[{'field': f.get('product'), 'type': f.get('type'), 'price': f.get('price'),
                                             'options': [{'label': o.get('label'), 'price': o.get('price')} for o in f.get('options', [])]}
                                            for f in group] for group in item.get('customization', [])]}, ensure_ascii=False), flush=True)
