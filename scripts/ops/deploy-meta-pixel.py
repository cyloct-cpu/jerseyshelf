"""Apply a checksum-guarded, code-only Meta Pixel release on the existing host."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
from datetime import datetime, timezone
import urllib.request

SITE = Path('/www/wwwroot/jerseyshelf')
RELEASE = Path('/opt/jerseyshelf/meta-pixel-release')
NODE = '/opt/jerseyshelf/node-v24.22.0-linux-x64/bin/node'
FILES = ['apps/storefront/meta-pixel.mjs', 'apps/storefront/public/meta-pixel.css',
         'apps/storefront/views.mjs', 'apps/storefront/checkout.mjs', 'apps/api/server.mjs']
BACKUP = RELEASE / 'backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def verify():
    for attempt in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(.25)
    else:
        raise RuntimeError('Health check did not recover')
    run('systemctl', 'is-active', '--quiet', 'jerseyshelf')
    result = []
    for route in ['/', '/products/2026-27-bayern-munich-away-kit-fan-edition', '/pages/privacy-statement']:
        with urllib.request.urlopen('https://jerseyshelf.com' + route, timeout=20) as response:
            html = response.read().decode()
            policy = response.headers.get('Content-Security-Policy', '')
            assert response.status == 200
            assert html.count("fbq('init', '1697741321689628')") == 1
            assert html.count("fbq('track', 'PageView')") == 1
            assert html.count('id="meta-consent-panel"') == 1
            assert not re.search(r'<img[^>]+src="https://www.facebook.com/tr', html)
            script = re.search(r'<!-- Meta Pixel Code --><script>([\s\S]*?)</script>', html).group(1)
            import base64
            script_hash = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
            assert "'sha256-" + script_hash + "'" in policy
            assert "https://connect.facebook.net" in policy
            assert "https://www.facebook.com" in policy
            assert "'unsafe-inline'" not in policy
            result.append({'route': route, 'status': response.status, 'initStatements': 1,
                           'pageViewStatements': 1, 'unconsentedNoscript': False, 'cspHashMatches': True})
    request = urllib.request.Request('https://jerseyshelf.com/', headers={'Cookie': 'js_meta_consent=v1.accepted'})
    html = urllib.request.urlopen(request, timeout=20).read().decode()
    assert len(re.findall(r'<img[^>]+src="https://www.facebook.com/tr', html)) == 1
    request.add_header('Sec-GPC', '1')
    html = urllib.request.urlopen(request, timeout=20).read().decode()
    assert not re.search(r'<img[^>]+src="https://www.facebook.com/tr', html)
    assert urllib.request.urlopen('https://jerseyshelf.com/assets/meta-pixel.css', timeout=20).status == 200
    return result


if __name__ == '__main__':
    if not SITE.is_dir() or not RELEASE.is_dir():
        raise RuntimeError('Unexpected deployment location')
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    assert set(manifest['files']) == set(FILES)
    assert set(manifest['baseline']) == set(FILES[2:])
    contents = {}
    with tarfile.open(RELEASE / 'pixel-source.tar.gz') as archive:
        assert set(archive.getnames()) == set(FILES)
        for name in FILES:
            data = archive.extractfile(name).read()
            assert digest(data) == manifest['files'][name], name
            if name.endswith('.mjs'):
                run(NODE, '--input-type=module', '--check', input=data)
            contents[name] = data
    for name, expected in manifest['baseline'].items():
        assert digest((SITE / name).read_bytes()) == expected, 'Production changed: ' + name
    for name in FILES[:2]:
        assert not (SITE / name).exists(), 'Unexpected existing Pixel file: ' + name
    for folder in ['apps', 'packages']:
        for file in (SITE / folder).rglob('*'):
            if file.suffix in ['.mjs', '.js', '.html']:
                assert not re.search(r'fbq\s*\(|fbevents\.js|googletagmanager|gtag\s*\(', file.read_text(errors='replace'), re.I), 'Existing tracker: ' + str(file)
    BACKUP.mkdir(parents=True, mode=0o700)
    for name in FILES[2:]:
        target = BACKUP / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SITE / name, target)
        assert digest(target.read_bytes()) == manifest['baseline'][name]
    (BACKUP / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    installed = []
    try:
        for name in FILES:
            target = SITE / name
            metadata = target.stat() if target.exists() else None
            temporary = target.with_name(target.name + '.meta-pixel-next')
            temporary.write_bytes(contents[name])
            temporary.chmod(metadata.st_mode & 0o777 if metadata else 0o644)
            if metadata:
                os.chown(temporary, metadata.st_uid, metadata.st_gid)
            temporary.replace(target)
            installed.append(name)
            assert digest(target.read_bytes()) == manifest['files'][name]
        run('systemctl', 'restart', 'jerseyshelf')
        checked = verify()
    except Exception:
        for name in reversed(installed):
            target = SITE / name
            if name in manifest['baseline']:
                shutil.copy2(BACKUP / name, target)
            else:
                assert target.parent.resolve().is_relative_to(SITE.resolve())
                target.unlink()
        run('systemctl', 'restart', 'jerseyshelf')
        print(json.dumps({'deployed': False, 'rolledBack': True, 'backup': str(BACKUP)}), flush=True)
        raise
    result = {'deployed': True, 'restart': 'active', 'backup': str(BACKUP), 'files': manifest['files'],
              'checked': checked, 'databaseFilesDeployed': False, 'environmentChanged': False}
    (RELEASE / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
