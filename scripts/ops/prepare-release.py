"""Create a consistent deployment snapshot and web-sized media copies.

Local originals are never changed. Reruns reuse completed image copies.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageOps, ImageFile
import sqlite3, shutil, json, tarfile, re

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'storage/deploy-ssh/release'
PACKS = OUT.parent / 'packs'
OUT.mkdir(parents=True, exist_ok=True)
PACKS.mkdir(parents=True, exist_ok=True)
for name in ('apps', 'packages', 'database', 'scripts'):
    shutil.copytree(ROOT/name, OUT/name, dirs_exist_ok=True)
shutil.copy2(ROOT/'package.json', OUT/'package.json')
shutil.copytree(ROOT/'data/currency', OUT/'data/currency', dirs_exist_ok=True)
for name in ('translation-credentials.key', 'fx-credentials.key', 'whatsapp-credentials.key'):
    if (ROOT/'storage'/name).exists():
        shutil.copy2(ROOT/'storage'/name, OUT/'storage'/name)
db = sqlite3.connect(str(OUT/'storage/store.sqlite'))
# Browser sessions from the local workstation are not production sessions.
db.execute('DELETE FROM sessions')
db.execute('DELETE FROM guest_order_access')
db.commit()
priority = set()
for (raw,) in db.execute('SELECT images FROM products'):
    values = json.loads(raw)
    if values: priority.add(Path(values[0]).name)
for (raw,) in db.execute('SELECT value FROM settings'):
    priority.update(re.findall(r'/media/([a-f0-9]{64}\.(?:jpg|png|webp|gif))', raw))
for (raw,) in db.execute('SELECT image FROM collections'):
    if raw.startswith('/media/'): priority.add(Path(raw).name)
names = [Path(r[0]).name for r in db.execute('SELECT path FROM media ORDER BY id')]
db.close()
ImageFile.LOAD_TRUNCATED_IMAGES = True
def optimize(name):
    src, dst = ROOT/'storage/media'/name, OUT/'storage/media'/name
    if dst.exists():
        try:
            with Image.open(dst) as check: check.verify()
            return name
        except Exception: dst.unlink()
    if not src.exists(): raise FileNotFoundError(str(src))
    with Image.open(src) as image:
        if image.format == 'JPEG': image.draft('RGB', (1600,1600))
        image = ImageOps.exif_transpose(image)
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        ext = src.suffix.lower()
        if ext in ('.jpg', '.jpeg'):
            image.convert('RGB').save(dst, 'JPEG', quality=84, optimize=True)
        elif ext == '.webp': image.save(dst, 'WEBP', quality=84, method=4)
        elif ext == '.png': image.save(dst, 'PNG', optimize=True)
        else: shutil.copy2(src, dst)
    if dst.stat().st_size > src.stat().st_size: shutil.copy2(src, dst)
    return name
def pack(index, batch, core=False):
    target = PACKS/f'{index:03d}.tar.gz'
    temp = target.with_suffix('.partial')
    with tarfile.open(temp, 'w:gz', compresslevel=1) as archive:
        if core:
            for folder in ('apps', 'packages', 'database', 'scripts'):
                archive.add(OUT/folder, arcname=folder)
            archive.add(OUT/'package.json', arcname='package.json')
            archive.add(OUT/'data/currency', arcname='data/currency')
            for item in (OUT/'storage').iterdir():
                if item.is_file(): archive.add(item, arcname='storage/'+item.name)
        for name in batch: archive.add(OUT/'storage/media'/name, arcname='storage/media/'+name)
    temp.replace(target)
    print(json.dumps({'pack':index,'images':len(batch),'bytes':target.stat().st_size}),flush=True)
first = [n for n in names if n in priority]
rest = [n for n in names if n not in priority]
with ThreadPoolExecutor(max_workers=4) as pool:
    for i, _ in enumerate(pool.map(optimize, first), 1):
        if i % 500 == 0: print(f'Priority images {i}/{len(first)}', flush=True)
    pack(0, first, core=True)
    for start in range(0, len(rest), 1000):
        batch = rest[start:start+1000]
        list(pool.map(optimize, batch))
        pack(start//1000+1, batch)
(PACKS/'COMPLETE').write_text(str(len(names)))
print('COMPLETE',len(names),flush=True)
