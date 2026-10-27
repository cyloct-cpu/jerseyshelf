"""Build local address suggestions from GeoNames CC BY 4.0 public extracts.
Inputs: storage/qa/geonames/{admin1CodesASCII.txt,cities5000.zip}.
Source: https://download.geonames.org/export/dump/
"""
import hashlib, json, pathlib, zipfile, datetime
root = pathlib.Path(__file__).resolve().parents[2]
source = root / 'storage/qa/geonames'
countries = {}
for line in (source / 'admin1CodesASCII.txt').read_text(encoding='utf-8').splitlines():
    key, name, ascii_name, gid = line.split('\t')
    country, code = key.split('.', 1)
    countries.setdefault(country, {'regions': [], 'cities': []})['regions'].append({'code': code, 'name': name, 'ascii': ascii_name})
with zipfile.ZipFile(source / 'cities5000.zip') as z:
    for line in z.read('cities5000.txt').decode('utf-8').splitlines():
        row = line.split('\t')
        country = row[8]
        if not country:
            continue
        countries.setdefault(country, {'regions': [], 'cities': []})['cities'].append({'name': row[1], 'ascii': row[2], 'region': row[10]})
for data in countries.values():
    data['regions'].sort(key=lambda r: r['name'].casefold())
    data['cities'].sort(key=lambda r: r['name'].casefold())
dest = root / 'data/address'
dest.mkdir(parents=True, exist_ok=True)
payload = {'source': 'GeoNames', 'license': 'CC BY 4.0', 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'countries': countries}
(dest / 'places.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps({'countries': len(countries), 'regions': sum(len(x['regions']) for x in countries.values()), 'cities': sum(len(x['cities']) for x in countries.values()), 'bytes': (dest / 'places.json').stat().st_size}))
