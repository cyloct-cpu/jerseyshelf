"""Download the pinned vision-only model and verify its published LFS digest."""
from pathlib import Path
import hashlib, json, urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'storage/image-search/model'
REPO = 'onnx-community/siglip2-base-patch16-224-ONNX'
REVISION = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4'
DIGEST = '5f2b401c1a4fc095702a5d45348e17ad46c4f87064085365b43c6e8eaa5c0070'

def download(remote, name, digest=None):
    target = DEST / name
    if target.exists() and (not digest or hashlib.sha256(target.read_bytes()).hexdigest() == digest):
        return
    with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{remote}', timeout=120) as source:
        temporary = target.with_suffix(target.suffix + '.partial')
        with temporary.open('wb') as out:
            while chunk := source.read(1024 * 1024):
                out.write(chunk)
    if digest and hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Model checksum mismatch')
    temporary.replace(target)
    print('Downloaded', name, flush=True)

if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    download('onnx/vision_model_quantized.onnx', 'vision.onnx', DIGEST)
    download('preprocessor_config.json', 'preprocessor_config.json')
    download('README.md', 'MODEL_CARD.md')
    (DEST / 'manifest.json').write_text(json.dumps({'repository': REPO, 'revision': REVISION, 'sha256': DIGEST, 'preprocessVersion': 1}, indent=2))
    print('Model ready', flush=True)
