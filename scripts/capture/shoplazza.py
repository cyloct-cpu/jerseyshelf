"""Archive public Shoplazza collection APIs observed in downloaded HTML.
Uses an explicitly supplied local proxy, no browser automation or private API.
"""
import concurrent.futures as futures
import datetime, gzip, hashlib, html, http.client, json, os, pathlib, re, ssl, sys, threading, time
import urllib.request, urllib.parse, xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
BASE = 'https://www.chenyikan.shop'
OUT = ROOT / 'data' / 'source' / 'shoplazza-2026-10-14'
OUT.mkdir(parents=True, exist_ok=True)
PROXY = os.environ.get('CAPTURE_PROXY', 'http://127.0.0.1:7897')
WORKERS = int(os.environ.get('CAPTURE_WORKERS', '6'))
LOCK = threading.Lock()
LOCAL = threading.local()
STATE = {'source':BASE,'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'collections':{},'products':{},'assets':{},'failures':[]}

class Node:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag=tag; self.attrs=dict(attrs); self.parent=parent; self.children=[]; self.parts=[]
    def all(self, predicate):
        result=[]; pending=[self]
        while pending:
            n=pending.pop()
            if predicate(n): result.append(n)
            pending.extend(reversed(n.children))
        return result
    def text(self): return ' '.join(' '.join(self.parts + [c.text() for c in self.children]).split())
class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True); self.root=Node();self.stack=[self.root];self.feed(source)
    def handle_starttag(self, tag, attrs):
        n=Node(tag,attrs,self.stack[-1]);self.stack[-1].children.append(n)
        if tag not in {'img','link','meta','input','br','hr','source','area','base','wbr','embed','param','col'}:self.stack.append(n)
    def handle_startendtag(self,tag,attrs):self.handle_starttag(tag,attrs);self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:self.stack=self.stack[:i];break
    def handle_data(self,data):self.stack[-1].parts.append(data)

def atomic_json(file,data):
    temp=file.with_suffix(file.suffix+'.tmp');temp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');temp.replace(file)
def report():
    with LOCK:
        atomic_json(ROOT/'data/manifests/source-download.json',{'collections':len(STATE['collections']),'products':len(STATE['products']),'downloadedImages':sum(1 for a in STATE['assets'].values() if a.get('file')),'queuedImages':len(STATE['assets']),'failures':len(STATE['failures']),'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
def get(url,cache=None):
    if cache and cache.exists(): return cache.read_bytes()
    host=urllib.parse.urlsplit(url).hostname
    if host not in {'www.chenyikan.shop','img.staticdj.com'} or not url.startswith('https://'):raise ValueError('Unapproved source URL: '+url)
    last=None
    for attempt in range(3):
        try:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':PROXY,'https':PROXY}))
            request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; StoreMigration/1.0)','Accept-Encoding':'identity'})
            with opener.open(request,timeout=35) as response:
                if urllib.parse.urlsplit(response.url).hostname not in {'www.chenyikan.shop','img.staticdj.com'}:raise ValueError('Unexpected redirect')
                data=response.read(64*1024*1024+1)
                if len(data)>64*1024*1024:raise ValueError('Response exceeds 64 MB')
            if cache:cache.parent.mkdir(parents=True,exist_ok=True);cache.write_bytes(data)
            return data
        except Exception as exc:last=exc;time.sleep(.5*(attempt+1))
    raise last
def get_json(url,file):return json.loads(get(url,file).decode('utf-8'))
def absolute(url):return urllib.parse.urljoin(BASE,html.unescape(url))
def image_url(raw):
    url=absolute(raw)
    if urllib.parse.urlsplit(url).hostname!='img.staticdj.com':return None
    return url
def add_image(raw):
    url=image_url(raw)
    if url:STATE['assets'].setdefault(url,{'url':url})
    return url
def images_of(node):
    return list(dict.fromkeys(absolute(n.attrs['src']) for n in node.all(lambda n:n.tag in {'spz-img','img','ljs-img'} and n.attrs.get('src','').startswith(('//img.staticdj.com','https://img.staticdj.com')))))
def sitemap(url):
    raw=get(url,OUT/'maps'/pathlib.Path(urllib.parse.urlsplit(url).path).name)
    if raw[:2]==b'\x1f\x8b':raw=gzip.decompress(raw)
    tree=ET.fromstring(raw)
    if tree.tag.endswith('sitemapindex'):
        items=[]
        for loc in tree.findall('.//{*}loc'):items.extend(sitemap(loc.text))
        return items
    return [loc.text for loc in tree.findall('.//{*}url/{*}loc')]
def parse_home():
    file=OUT/'home.html'
    if not file.exists():file.write_bytes((ROOT/'data/source/retry-home.html').read_bytes())
    tree=Tree(file.read_text(encoding='utf-8')).root
    names={}
    for a in tree.all(lambda n:n.tag=='a' and n.attrs.get('href','').startswith('/collections/')):
        slug=urllib.parse.urlsplit(a.attrs['href']).path.split('/')[-1]
        if a.text() and '${' not in a.text():names.setdefault(slug,a.text())
    home={'collectionImages':{},'slides':[],'miscImages':[]}
    for n in tree.all(lambda n:n.tag=='a' and n.attrs.get('href','').startswith('/collections/')):
        imgs=images_of(n)
        if imgs:
            slug=urllib.parse.urlsplit(n.attrs['href']).path.split('/')[-1]
            home['collectionImages'].setdefault(slug,imgs[0])
    # Associate observed hero slides using their section and link, never arbitrary image order.
    for section in tree.all(lambda n:n.attrs.get('data-section-type')=='slideshow' or 'slideshow' in n.attrs.get('class','').split()):
        for img in images_of(section):home['miscImages'].append(img)
    for raw in images_of(tree):add_image(raw)
    for node in tree.all(lambda n:n.attrs.get('product-id') and 'shoplazza-product-snippet' in n.attrs.get('class','')):
        links=node.all(lambda n:n.tag=='a' and n.attrs.get('href','').startswith('/products/'))
        if links:
            pid=node.attrs['product-id'];slug=urllib.parse.urlsplit(links[0].attrs['href']).path.split('/')[-1]
            STATE['products'].setdefault(pid,{'id':pid,'handle':slug,'images':[{'src':u} for u in images_of(node)],'_collections':[]})
    return tree,names,home
def collect_collection(url,names):
    slug=urllib.parse.urlsplit(url).path.split('/')[-1]
    source=get(url,OUT/'collections'/(slug+'.html')).decode('utf-8')
    tree=Tree(source).root
    lists=tree.all(lambda n:n.tag=='spz-list' and n.attrs.get('src','').startswith('/api/collections/') and n.attrs['src'].endswith('/cps'))
    if not lists:return {'slug':slug,'name':names.get(slug,slug),'products':[],'noProductList':True}
    endpoint=BASE+lists[0].attrs['src'];size=int(lists[0].attrs.get('page-size','40'))
    first=get_json(endpoint+f'?limit={size}&page=0&sort_by=published-descending',OUT/'pages-fixed'/f'{slug}-0.json')['data']
    count=first.get('count',first.get('products_count',0));pages=max(1,(count+size-1)//size)
    records=list(first.get('products',[]))
    for page in range(1,pages):
        data=get_json(endpoint+f'?limit={size}&page={page}&sort_by=published-descending',OUT/'pages-fixed'/f'{slug}-{page}.json')['data']
        records.extend(data.get('products',[]))
        time.sleep(.05)
    unique={p['id']:p for p in records}
    h1=tree.all(lambda n:n.tag=='h1')
    info={'slug':slug,'name':names.get(slug,h1[0].text() if h1 else slug),'sourceId':lists[0].attrs['src'].split('/')[3],'reportedCount':count,'pages':pages,'uniqueCount':len(unique),'products':list(unique),'complete':len(unique)==count}
    with LOCK:
        STATE['collections'][slug]=info
        for pid,p in unique.items():
            old=STATE['products'].get(pid,{});cats=set(old.get('_collections',[]));cats.add(slug);p['_collections']=sorted(cats)
            STATE['products'][pid]=p
            for img in p.get('images',[]):
                if img.get('src'):add_image(img['src'])
            if p.get('image',{}).get('src'):add_image(p['image']['src'])
        if not info['complete']:STATE['failures'].append({'collection':slug,'error':f"Expected {count}, got {len(unique)} unique products"})
        atomic_json(OUT/'catalog-source.json',{'collections':list(STATE['collections'].values()),'products':list(STATE['products'].values())})
    print(f"分类 {slug}: {len(unique)}/{count}，累计商品 {len(STATE['products'])}",flush=True);report()
    return info
def download_asset(url):
    entry=STATE['assets'][url];ext=pathlib.Path(urllib.parse.urlsplit(url).path).suffix.lower() or '.bin'
    url_key=hashlib.sha256(url.encode()).hexdigest();marker=OUT/'asset-index'/(url_key+'.json')
    if marker.exists():
        cached=json.loads(marker.read_text(encoding='utf-8'))
        if (OUT/cached['file']).exists():entry.update(cached);return
    try:
        data=get_asset_pooled(url);sha=hashlib.sha256(data).hexdigest();file='assets/'+sha+ext
        target=OUT/file;target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():target.write_bytes(data)
        entry.update({'file':file,'sha256':sha,'bytes':len(data)})
        marker.parent.mkdir(parents=True,exist_ok=True);atomic_json(marker,entry)
    except Exception as exc:
        with LOCK:STATE['failures'].append({'url':url,'error':str(exc)})
def get_asset_pooled(url):
    parsed=urllib.parse.urlsplit(url)
    if parsed.hostname!='img.staticdj.com' or parsed.scheme!='https':raise ValueError('Unapproved image URL')
    proxy=urllib.parse.urlsplit(PROXY)
    for attempt in range(3):
        try:
            conn=getattr(LOCAL,'connection',None)
            if conn is None:
                conn=http.client.HTTPSConnection(proxy.hostname,proxy.port,timeout=35,context=ssl.create_default_context())
                conn.set_tunnel(parsed.hostname,443);LOCAL.connection=conn
            conn.request('GET',parsed.path+('?' + parsed.query if parsed.query else ''),headers={'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity','Connection':'keep-alive'})
            response=conn.getresponse();data=response.read(64*1024*1024+1)
            if response.status!=200:raise ValueError('Image HTTP '+str(response.status))
            if len(data)>64*1024*1024:raise ValueError('Image exceeds 64 MB')
            return data
        except Exception:
            if getattr(LOCAL,'connection',None):LOCAL.connection.close()
            LOCAL.connection=None
            if attempt==2:raise
            time.sleep(.3*(attempt+1))
def assets_only():
    catalog=json.loads((OUT/'catalog-source.json').read_text(encoding='utf-8'))
    STATE['collections']={c['slug']:c for c in catalog['collections']}
    STATE['products']={p['id']:p for p in catalog['products']}
    urls=json.loads((OUT/'sitemap-urls.json').read_text(encoding='utf-8'))
    seen={p.get('handle') for p in STATE['products'].values()}
    for url in [u for u in urls if '/products/' in u and u.rsplit('/',1)[-1] not in seen]:
        try:
            slug=url.rsplit('/',1)[-1];raw=get(url,OUT/'products'/(slug+'.html')).decode('utf-8')
            ids=re.findall(r'/api/products/([a-f0-9-]{36})',raw)+re.findall(r'"product_id"\s*:\s*"([a-f0-9-]{36})"',raw)
            matched=False
            for pid in dict.fromkeys(ids):
                p=get_json(BASE+'/api/products/'+pid,OUT/'products'/(pid+'.json'))['data']['product']
                if p.get('handle')==slug:p['_collections']=[];STATE['products'][pid]=p;matched=True;break
            if not matched:raise ValueError('Matching source product not found')
        except Exception as exc:STATE['failures'].append({'url':url,'error':str(exc)})
    _,_,home=parse_home()
    if (OUT/'home-source.json').exists():home=json.loads((OUT/'home-source.json').read_text(encoding='utf-8'))
    for p in STATE['products'].values():
        for img in p.get('images',[]):
            if img.get('src'):add_image(img['src'])
    atomic_json(OUT/'catalog-source.json',{'collections':list(STATE['collections'].values()),'products':list(STATE['products'].values()),'home':home})
    print(f"全部商品 {len(STATE['products'])}，图片网址 {len(STATE['assets'])}，使用持久连接下载",flush=True)
    with futures.ThreadPoolExecutor(max_workers=int(os.environ.get('IMAGE_WORKERS','16'))) as pool:
        for number,_ in enumerate(pool.map(download_asset,list(STATE['assets'])),1):
            if number%100==0:print(f"图片处理 {number}/{len(STATE['assets'])}",flush=True);report()
    STATE['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat();atomic_json(OUT/'manifest.json',STATE);report()
    print(f"完成：{len(STATE['products'])} 商品，{sum(bool(a.get('file')) for a in STATE['assets'].values())} 图片网址，失败 {len(STATE['failures'])}",flush=True)
def main():
    tree,names,home=parse_home()
    urls=sitemap(BASE+'/sitemap.xml');collections=sorted(set(u for u in urls if '/collections/' in u))
    # Prioritize homepage then season, retro and coats; expand to all sitemap collections.
    priority=['2026-27-season','retro','trench-coat']
    collections.sort(key=lambda u:(priority.index(u.rsplit('/',1)[-1]) if u.rsplit('/',1)[-1] in priority else 10,u))
    atomic_json(OUT/'sitemap-urls.json',urls)
    print(f"站点地图：{len(collections)} 个分类，{sum('/products/' in u for u in urls)} 个商品网址",flush=True)
    with futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        tasks={pool.submit(collect_collection,u,names):u for u in collections}
        for future in futures.as_completed(tasks):
            try:future.result()
            except Exception as exc:STATE['failures'].append({'url':tasks[future],'error':str(exc)});print('分类失败 '+tasks[future]+': '+str(exc),flush=True)
    # Fetch details only for homepage records absent from all collection responses.
    for pid,p in list(STATE['products'].items()):
        if 'title' not in p:
            try:full=get_json(BASE+'/api/products/'+pid,OUT/'products'/(pid+'.json'))['data']['product'];full['_collections']=p.get('_collections',[]);STATE['products'][pid]=full
            except Exception as exc:STATE['failures'].append({'product':pid,'error':str(exc)})
    for p in STATE['products'].values():
        for i in p.get('images',[]):
            if i.get('src'):add_image(i['src'])
    seen_slugs={p.get('handle') for p in STATE['products'].values()}
    missing=[u for u in urls if '/products/' in u and u.rsplit('/',1)[-1] not in seen_slugs]
    STATE['sitemapProductsWithoutCollection']=missing
    # Unlisted-by-collection products still expose their public ID in the product page.
    def missing_product(url):
        slug=url.rsplit('/',1)[-1];raw=get(url,OUT/'products'/(slug+'.html')).decode('utf-8')
        ids=re.findall(r'/api/products/([a-f0-9-]{36})',raw)
        if not ids:raise ValueError('Public product API ID not found')
        for pid in dict.fromkeys(ids):
            full=get_json(BASE+'/api/products/'+pid,OUT/'products'/(pid+'.json'))['data']['product']
            if full.get('handle')==slug:
                full['_collections']=[]
                with LOCK:
                    STATE['products'][pid]=full
                    for i in full.get('images',[]):
                        if i.get('src'):add_image(i['src'])
                return
        raise ValueError('Matching product record not found')
    with futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        tasks={pool.submit(missing_product,u):u for u in missing}
        for future in futures.as_completed(tasks):
            try:future.result()
            except Exception as exc:STATE['failures'].append({'url':tasks[future],'error':str(exc)})
    atomic_json(OUT/'catalog-source.json',{'collections':list(STATE['collections'].values()),'products':list(STATE['products'].values()),'home':home})
    print(f"商品资料去重后 {len(STATE['products'])} 件，待下载原图 {len(STATE['assets'])} 个网址",flush=True);report()
    # Emit image progress periodically so the task can be monitored without polling every request.
    with futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for number,_ in enumerate(pool.map(download_asset,list(STATE['assets'])),1):
            if number%100==0:print(f"图片处理 {number}/{len(STATE['assets'])}",flush=True);report()
    STATE['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    atomic_json(OUT/'manifest.json',STATE);report()
    print(f"完成：{len(STATE['products'])} 商品，{sum(bool(a.get('file')) for a in STATE['assets'].values())} 图片网址，失败 {len(STATE['failures'])}",flush=True)
if __name__=='__main__':assets_only() if '--assets-only' in sys.argv else main()
