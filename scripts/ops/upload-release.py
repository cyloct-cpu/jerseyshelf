"""Upload prepared batches over pinned SSH; resume only completed batches."""
from pathlib import Path
import subprocess,time,hashlib
ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'storage/deploy-ssh'
PACKS=STATE/'packs'
KEY=STATE/'id_ed25519'
HOSTS=ROOT/'storage/deploy-known-hosts'
OPTIONS=['-i',str(KEY),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',f'UserKnownHostsFile={HOSTS}','-o','ServerAliveInterval=15']
SSH='C:/Windows/System32/OpenSSH/ssh.exe'
SCP='C:/Windows/System32/OpenSSH/scp.exe'
HOST='root@189.24.79.73'
def remote(cmd):
    subprocess.run([SSH,*OPTIONS,HOST,cmd],check=True)
remote('mkdir -p /opt/jerseyshelf/uploads /www/wwwroot/jerseyshelf')
index=0
while True:
    name=f'{index:03d}.tar.gz';pack=PACKS/name;marker=PACKS/(name+'.uploaded')
    if not pack.exists():
        if (PACKS/'COMPLETE').exists():break
        time.sleep(5);continue
    if not marker.exists():
        digest=hashlib.sha256(pack.read_bytes()).hexdigest()
        print(f'Uploading {name} {pack.stat().st_size/1024/1024:.1f} MiB',flush=True)
        subprocess.run([SCP,*OPTIONS,str(pack),HOST+':/opt/jerseyshelf/uploads/'+name],check=True)
        remote(f"cd /opt/jerseyshelf/uploads && echo '{digest}  {name}' | sha256sum -c - && tar -xzf {name} -C /www/wwwroot/jerseyshelf && if id jerseyshelf >/dev/null 2>&1; then chown -R jerseyshelf:jerseyshelf /www/wwwroot/jerseyshelf/storage; fi")
        marker.write_text(digest)
        print(f'Uploaded and verified {name}',flush=True)
    index+=1
print('ALL_UPLOADS_COMPLETE',flush=True)
