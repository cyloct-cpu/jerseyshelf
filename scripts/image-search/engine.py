"""Isolated, CPU-only image search. JSON lines on stdin/stdout; no upload files."""
from pathlib import Path
import os, sys
ROOT = Path(__file__).resolve().parents[2]
STATE = Path(os.environ.get('IMAGE_SEARCH_STATE', ROOT / 'storage/image-search'))
sys.path.insert(0, str(STATE / 'runtime'))
os.environ.setdefault('OMP_NUM_THREADS', '1')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
import argparse, base64, hashlib, io, json, sqlite3, time, warnings
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
MAX_BYTES = 8 * 1024 * 1024

def model_identity():
    manifest = json.loads((STATE / 'model/manifest.json').read_text())
    config = json.loads((STATE / 'model/preprocessor_config.json').read_text())
    version = hashlib.sha256(json.dumps([manifest, config], sort_keys=True).encode()).hexdigest()
    return manifest, config, version

def build_status(**values):
    temporary = STATE / ('build-status-' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps({'updatedAt':time.time(),**values}),encoding='utf-8')
    temporary.replace(STATE/'build-status.json')

def decode(data, trusted=False):
    if not data or len(data) > (80 * 1024 * 1024 if trusted else MAX_BYTES):
        raise ValueError('invalid_size')
    previous = Image.MAX_IMAGE_PIXELS
    try:
        Image.MAX_IMAGE_PIXELS = 100_000_000 if trusted else 20_000_000
        with Image.open(io.BytesIO(data)) as original:
            if original.format not in (('JPEG', 'MPO', 'PNG', 'WEBP', 'GIF') if trusted else ('JPEG', 'PNG', 'WEBP')) or (not trusted and getattr(original, 'n_frames', 1) != 1):
                raise ValueError('invalid_image')
            if original.width * original.height > Image.MAX_IMAGE_PIXELS or min(original.size) < 32:
                raise ValueError('invalid_dimensions')
            return ImageOps.exif_transpose(original).convert('RGB')
    finally:
        Image.MAX_IMAGE_PIXELS = previous

def dhash(image):
    gray = np.asarray(image.resize((9, 8)).convert('L'))
    return ''.join(f'{int(x):02x}' for x in np.packbits(gray[:, 1:] > gray[:, :-1]))

class Encoder:
    def __init__(self):
        manifest, self.config, self.version = model_identity()
        model = STATE / 'model/vision.onnx'
        if hashlib.sha256(model.read_bytes()).hexdigest() != manifest['sha256']:
            raise RuntimeError('model_checksum')
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get('IMAGE_SEARCH_THREADS', '1'))
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
        self.input = self.session.get_inputs()[0].name
        self.output = next((x.name for x in self.session.get_outputs() if x.name == 'pooler_output'), self.session.get_outputs()[0].name)

    def encode(self, image):
        c = self.config
        resized = image.resize((c['size']['width'], c['size']['height']), Image.Resampling(c['resample']))
        values = np.asarray(resized, dtype=np.float32) * c['rescale_factor']
        values = (values - np.array(c['image_mean'], np.float32)) / np.array(c['image_std'], np.float32)
        result = self.session.run([self.output], {self.input: values.transpose(2, 0, 1)[None].copy()})[0]
        if result.ndim != 2:
            raise RuntimeError('unexpected_model_output')
        result = result[0].astype(np.float32)
        return result / max(float(np.linalg.norm(result)), 1e-12)

def catalog(primary=False):
    database = Path(os.environ.get('DATABASE_PATH', ROOT / 'storage/store.sqlite')).resolve()
    media = Path(os.environ.get('MEDIA_PATH', ROOT / 'storage/media')).resolve()
    db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    records = {}
    for pid, images, roles in db.execute('select id,images,image_roles from products where active=1 order by id'):
        roles = json.loads(roles)
        for i, path in enumerate(json.loads(images)):
            if i < len(roles) and roles[i] == 'size':
                continue
            if not path.startswith('/media/') or '/' in path[7:] or '\\' in path[7:] or path[7:] in ('', '.', '..'):
                continue
            records.setdefault(path, {'path': path, 'file': str(media / path[7:]), 'products': []})['products'].append(pid)
            if primary:
                break
    db.close()
    return list(records.values())

def build(limit=None, force=False, primary=False):
    STATE.mkdir(parents=True, exist_ok=True)
    version = model_identity()[2]
    cache = sqlite3.connect(STATE / 'features.sqlite')
    cache.execute('create table if not exists features (version text, hash text, vector blob, dhash text, primary key(version,hash))')
    records, vectors, failures = [], [], []
    started = time.time()
    sources = catalog(primary=primary)
    if limit:
        sources = sources[:limit]
    build_status(running=True,done=0,total=len(sources),coverageMode='primary' if primary else 'all')
    fingerprint = []
    for item in sources:
        try:
            stat = Path(item['file']).stat()
            fingerprint.append([item['path'], item['products'], stat.st_size, stat.st_mtime_ns])
        except OSError:
            fingerprint.append([item['path'], item['products'], None])
    source_hash = hashlib.sha256(json.dumps([version, fingerprint]).encode()).hexdigest()
    current = STATE / 'index.json'
    if not force and current.exists() and json.loads(current.read_text(encoding='utf-8')).get('sourceFingerprint') == source_hash:
        cache.close()
        build_status(running=False,unchanged=True)
        print(json.dumps({'unchanged': True}), flush=True)
        return
    encoder = Encoder()
    for i, item in enumerate(sources):
        try:
            data = Path(item['file']).read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            found = cache.execute('select vector,dhash from features where version=? and hash=?', (encoder.version, digest)).fetchone()
            if found:
                vector, imagehash = np.frombuffer(found[0], np.float32), found[1]
            else:
                image = decode(data, trusted=True)
                vector, imagehash = encoder.encode(image), dhash(image)
                cache.execute('insert or replace into features values(?,?,?,?)', (encoder.version, digest, vector.tobytes(), imagehash))
            records.append({'path': item['path'], 'products': item['products'], 'hash': imagehash, 'sha256': digest})
            vectors.append(vector)
        except Exception as err:
            failures.append({'path': item['path'], 'error': type(err).__name__})
        if (i + 1) % 100 == 0:
            cache.commit()
            build_status(running=True,done=i+1,total=len(sources),coverageMode='primary' if primary else 'all')
            print(json.dumps({'progress': i + 1, 'total': len(sources), 'seconds': round(time.time() - started)}), flush=True)
    cache.commit()
    cache.close()
    if not vectors:
        raise RuntimeError('empty_index')
    generation = str(time.time_ns())
    vector_name = 'vectors-' + generation + '.npy'
    np.save(STATE / vector_name, np.stack(vectors))
    info = {'version': encoder.version, 'generation': generation, 'vectors': vector_name, 'createdAt': time.time(), 'records': records, 'sourceFingerprint': source_hash, 'coverageMode':'primary' if primary else 'all',
            'failures': failures, 'total': len(sources), 'seconds': round(time.time() - started, 2), 'partial': bool(limit)}
    (STATE / 'index.next.json').write_text(json.dumps(info), encoding='utf-8')
    (STATE / 'index.next.json').replace(STATE / 'index.json')
    # Retain the previous index vector file for operators; avoid unbounded timer rebuild storage.
    old_vectors = sorted(STATE.glob('vectors-*.npy'), key=lambda p: p.stat().st_mtime, reverse=True)
    for obsolete in old_vectors[2:]:
        try:
            obsolete.unlink()
        except OSError:
            pass  # A Windows worker may still hold the previous mmap.
    print(json.dumps({'complete': True, 'images': len(records), 'failed': len(failures), 'seconds': info['seconds'], 'partial': bool(limit)}), flush=True)
    build_status(running=False,done=len(sources),total=len(sources),failed=len(failures),generation=generation,coverageMode=info['coverageMode'])

class Search:
    def __init__(self):
        self.encoder = Encoder()
        self.stamp = None
        self.reload()

    def reload(self):
        index = STATE / 'index.json'
        stamp = index.stat().st_mtime_ns
        if stamp != self.stamp:
            info = json.loads(index.read_text(encoding='utf-8'))
            if info['version'] != self.encoder.version:
                raise RuntimeError('index_version_mismatch')
            vectors = np.load(STATE / info['vectors'], mmap_mode='r', allow_pickle=False)
            self.info, self.vectors, self.stamp = info, vectors, stamp

    def query(self, data, exclude_path=None):
        self.reload()
        image = decode(data)
        # Uniform photos have no style information even if the encoder gives a high cosine score.
        if float(np.asarray(image.resize((64,64)), dtype=np.float32).std(axis=(0,1)).max()) < 8:
            return []
        vector, imagehash = self.encoder.encode(image), int(dhash(image), 16)
        scores = self.vectors @ vector
        order = np.argsort(scores)[::-1]
        products = {}
        for ix in order:
            rec = self.info['records'][int(ix)]
            if rec['path'] == exclude_path:
                continue
            score = float(scores[ix])
            # Hash only assists a visually close match; it is not an identity probability.
            distance = (int(rec['hash'], 16) ^ imagehash).bit_count()
            rank = score + (0.025 if distance <= 4 and score >= 0.85 else 0)
            for pid in rec['products']:
                if pid not in products or rank > products[pid]['rank']:
                    products[pid] = {'id': pid, 'score': score, 'rank': rank, 'path': rec['path']}
            if len(products) >= 250 and score < 0.6:
                break
        return sorted(products.values(), key=lambda x: x['rank'], reverse=True)[:250]

def serve():
    engine = Search()
    print(json.dumps({'ready': True, 'images': len(engine.info['records']), 'partial': engine.info['partial']}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if len(request.get('image', '')) > MAX_BYTES * 4 // 3 + 4:
                raise ValueError('invalid_size')
            data = base64.b64decode(request['image'], validate=True)
            started = time.monotonic()
            candidates = engine.query(data)
            print(json.dumps({'id': request['id'], 'candidates': candidates, 'ms': round((time.monotonic() - started) * 1000)}), flush=True)
        except Exception as err:
            code = str(err) if isinstance(err, ValueError) else 'invalid_image'
            print(json.dumps({'id': request.get('id') if 'request' in locals() else None, 'error': code}), flush=True)

def unix_server(socket_path):
    """Private Unix socket; filesystem permissions restrict access to the site account."""
    import socketserver
    from http.server import BaseHTTPRequestHandler
    engine = Search()
    target = Path(socket_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    class Handler(BaseHTTPRequestHandler):
        def respond(self, code, value):
            body = json.dumps(value).encode()
            self.send_response(code)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if self.path != '/health':
                self.respond(404, {'error':'not_found'})
                return
            engine.reload()
            self.respond(200, {'ready':True,'images':len(engine.info['records']),'partial':engine.info['partial'],'generation':engine.info['generation']})
        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length','0'))
                if self.path != '/search' or size < 1 or size > MAX_BYTES*4//3+1024:
                    self.respond(400,{'error':'invalid_size'})
                    return
                self.connection.settimeout(20)
                request = json.loads(self.rfile.read(size))
                data = base64.b64decode(request['image'], validate=True)
                began = time.monotonic()
                rows = engine.query(data)
                self.respond(200,{'candidates':rows,'ms':round((time.monotonic()-began)*1000)})
            except (ValueError, KeyError, OSError):
                self.respond(400,{'error':'invalid_image'})
            except Exception:
                self.respond(503,{'error':'unavailable'})
        def log_message(self, format, *args):
            pass  # Do not put uploaded contents, candidate tokens or user metadata in logs.
    class Server(socketserver.UnixStreamServer):
        request_queue_size = 2
    try:
        with Server(str(target), Handler) as server:
            os.chmod(target,0o600)
            print(json.dumps({'ready':True,'socket':str(target),'images':len(engine.info['records'])}),flush=True)
            server.serve_forever(poll_interval=.5)
    finally:
        target.unlink(missing_ok=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['build', 'maintain', 'serve', 'probe', 'unix'])
    parser.add_argument('--socket')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--primary', action='store_true')
    args = parser.parse_args()
    if args.mode in ('build', 'maintain'):
        STATE.mkdir(parents=True, exist_ok=True)
        requested = STATE/'rebuild-request.json'
        request_data = requested.read_bytes() if requested.exists() else None
        try:
            with sqlite3.connect(STATE / 'build-lock.sqlite', timeout=1) as lock:
                lock.execute('BEGIN EXCLUSIVE')
                build(args.limit, args.force or (args.mode=='maintain' and request_data is not None), args.primary)
            if args.mode=='maintain' and request_data is not None and requested.exists() and requested.read_bytes()==request_data:
                requested.unlink()
        except sqlite3.OperationalError as error:
            if args.mode=='maintain' and 'locked' in str(error):
                print(json.dumps({'busy':True}),flush=True)
            else:
                build_status(running=False,error=type(error).__name__)
                raise
        except Exception as error:
            build_status(running=False,error=type(error).__name__)
            raise
    elif args.mode == 'serve':
        serve()
    elif args.mode == 'unix':
        unix_server(args.socket or str(STATE/'search.sock'))
    else:
        e = Encoder()
        item = catalog()[0]
        data = Path(item['file']).read_bytes()
        began = time.monotonic()
        v = e.encode(decode(data))
        print(json.dumps({'dimensions': len(v), 'ms': round((time.monotonic()-began)*1000), 'input': e.input, 'output': e.output}))
