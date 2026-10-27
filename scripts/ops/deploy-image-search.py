"""Guarded code-only production deployment. Run on the authorized site host."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tarfile, time
from datetime import datetime, timezone

SITE=Path('/www/wwwroot/jerseyshelf')
RELEASE=Path('/opt/jerseyshelf/image-search-release')
NODE='/opt/jerseyshelf/node-v24.22.0-linux-x64/bin/node'
ENV=Path('/etc/jerseyshelf.env')
STAMP=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
BACKUP=RELEASE/'baseline'/STAMP

def run(*args,**kwargs):
    return subprocess.run(args,check=True,**kwargs)

def service_environment():
    env=dict(os.environ)
    for line in ENV.read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key,value=line.split('=',1)
            if len(value)>1 and value[0] in ('"',"'") and value[-1]==value[0]:
                value=value[1:-1]
            env[key]=value
    return env

if __name__=='__main__':
    if not SITE.is_dir() or not RELEASE.is_dir():
        raise RuntimeError('Unexpected site path')
    BACKUP.mkdir(parents=True)
    with tarfile.open(RELEASE/'source-release.tar.gz') as archive:
        manifest=json.load(archive.extractfile('release-manifest.json'))
        contents={name:archive.extractfile(name).read() for name in manifest['files']}
    for name,data in contents.items():
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise RuntimeError('Invalid release path')
        if hashlib.sha256(data).hexdigest()!=manifest['files'][name]:
            raise RuntimeError('Release checksum mismatch: '+name)
        if name.endswith(('.mjs','.js')):
            run(NODE,'--input-type=module','--check',input=data)
        if name.endswith('.py'):
            compile(data,name,'exec')
    for name,digest in manifest['baseline'].items():
        if hashlib.sha256((SITE/name).read_bytes()).hexdigest()!=digest:
            raise RuntimeError('Production file changed; merge before deployment: '+name)
    for name in contents:
        target=SITE/name
        if target.exists():
            backup=BACKUP/name
            backup.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(target,backup)
    shutil.copy2(ENV,BACKUP/'production.env')
    os.chmod(BACKUP/'production.env',0o600)
    for name,data in contents.items():
        target=SITE/name
        target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name(target.name+'.image-search-next')
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        temporary.replace(target)
    updates={'IMAGE_SEARCH_PYTHON':'/opt/jerseyshelf/image-search-venv/bin/python','IMAGE_SEARCH_STATE':str(SITE/'storage/image-search'),'IMAGE_SEARCH_SOCKET':str(SITE/'storage/image-search/search.sock'),'IMAGE_SEARCH_AUTO_UPDATE':'false'}
    lines=[line for line in ENV.read_text().splitlines() if line.split('=',1)[0] not in updates]
    ENV.write_text('\n'.join(lines+[k+'='+v for k,v in updates.items()])+'\n')
    ENV.chmod(0o600)
    for name in ['jerseyshelf-image-search.service','jerseyshelf-image-index.service','jerseyshelf-image-index.timer']:
        shutil.copy2(SITE/'scripts/ops'/name,Path('/etc/systemd/system')/name)
    # Refresh primary coverage using cached vectors; initial construction has completed.
    env=service_environment()
    run('runuser','-u','jerseyshelf','--','env',*[k+'='+env[k] for k in ['IMAGE_SEARCH_STATE','IMAGE_SEARCH_THREADS','OPENBLAS_NUM_THREADS'] if k in env],
        'DATABASE_PATH='+str(SITE/'storage/store.sqlite'),'MEDIA_PATH='+str(SITE/'storage/media'),
        'IMAGE_SEARCH_THREADS=1','OPENBLAS_NUM_THREADS=1',updates['IMAGE_SEARCH_PYTHON'],str(SITE/'scripts/image-search/engine.py'),'build','--primary',cwd=SITE)
    info=json.loads((SITE/'storage/image-search/index.json').read_text())
    if info.get('partial') or info.get('coverageMode')!='primary' or info['failures']:
        raise RuntimeError('Primary index needs inspection before release')
    approval={'ownerApproved':True,'mode':'similar_styles','generation':info['generation'],'modelVersion':info['version'],
              'catalogUpdatesApproved':True,'approvedAt':datetime.now(timezone.utc).isoformat(),
              'authorization':'User requested production launch, then explicitly selected all product primary images first and gallery images in background.',
              'independentPhotoAcceptancePassed':False,'knownLimitations':'Cross-view recall at preview threshold 0.90 was 58.3% in a limited synthetic/gallery test. No claim of exact identity or independent real-photo acceptance.',
              'initialCoverageMode':'primary','threshold':0.90}
    approval_file=SITE/'storage/image-search/release-approval.json'
    approval_file.write_text(json.dumps(approval,indent=2))
    shutil.chown(approval_file,user='jerseyshelf',group='jerseyshelf')
    approval_file.chmod(0o600)
    run('systemctl','daemon-reload')
    run('systemctl','enable','--now','jerseyshelf-image-search.service')
    socket=updates['IMAGE_SEARCH_SOCKET']
    for attempt in range(40):
        check=subprocess.run(['runuser','-u','jerseyshelf','--','curl','--silent','--fail','--unix-socket',socket,'http://localhost/health'],capture_output=True)
        if check.returncode==0:
            health=json.loads(check.stdout)
            if health.get('ready') and health['images']==len(info['records']):
                break
        time.sleep(.5)
    else:
        raise RuntimeError('Private image service failed readiness check; public entry stays disabled')
    run('systemctl','restart','jerseyshelf')
    print(json.dumps({'installed':True,'backup':str(BACKUP),'images':len(info['records']),'products':len({i for r in info['records'] for i in r['products']}),'publicEnabled':False}),flush=True)
