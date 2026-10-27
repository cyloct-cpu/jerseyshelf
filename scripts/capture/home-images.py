import concurrent.futures as futures
import json
from shoplazza import *

tree,names,home=parse_home()
for slide in tree.all(lambda n:'slideshow-carousel-item' in n.attrs.get('class','').split()):
    pictures=images_of(slide);headings=slide.all(lambda n:n.tag in {'h1','h2','h3'});links=slide.all(lambda n:n.tag=='a')
    if pictures:home['slides'].append({'title':headings[0].text() if headings else '', 'image':pictures[0], 'href':next((n.attrs.get('href') for n in links if n.attrs.get('href','').startswith('/collections/')), '/collections/2026-27-season')})
atomic_json(OUT/'home-source.json',home)
with futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(download_asset,list(STATE['assets'])))
atomic_json(OUT/'home-assets.json',{'assets':list(STATE['assets'].values()),'failures':STATE['failures']})
print('Homepage images downloaded:',sum(bool(a.get('file')) for a in STATE['assets'].values()),flush=True)
