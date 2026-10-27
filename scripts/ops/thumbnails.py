"""Create display derivatives; originals are never modified."""
import concurrent.futures, pathlib, sqlite3
from PIL import Image, ImageOps, ImageFile
# Some source JPEGs have a short trailing block, which browsers still display.
# Permit Pillow to create display copies without rewriting the captured original.
ImageFile.LOAD_TRUNCATED_IMAGES=True
ROOT=pathlib.Path(__file__).resolve().parents[2]
db=sqlite3.connect('file:'+str(ROOT/'storage/store.sqlite').replace('\\','/')+'?mode=ro',uri=True)
paths=set()
import json
for (images,) in db.execute("SELECT images FROM products WHERE images!='[]'"):
    gallery=json.loads(images)
    if gallery:paths.add(gallery[0])
db.close()
dest=ROOT/'storage/media/derived';dest.mkdir(parents=True,exist_ok=True)
def derive(media):
    source=ROOT/'storage/media'/pathlib.Path(media).name
    if not source.exists():return
    key=source.stem
    if all((dest/f'{key}-{w}.webp').exists() for w in (480,960)):return
    try:
        with Image.open(source) as im:
            im=ImageOps.exif_transpose(im)
            for width in (480,960):
                image=im.copy();image.thumbnail((width,width),Image.Resampling.LANCZOS)
                if image.mode not in ('RGB','RGBA'):image=image.convert('RGBA' if 'transparency' in image.info else 'RGB')
                image.save(dest/f'{key}-{width}.webp','WEBP',quality=90,method=4)
    except Exception as exc:print(source.name+': '+str(exc),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for number,_ in enumerate(pool.map(derive,paths),1):
        if number%500==0:print(f'Thumbnails: {number}/{len(paths)}',flush=True)
print('Done:',len(paths),flush=True)
