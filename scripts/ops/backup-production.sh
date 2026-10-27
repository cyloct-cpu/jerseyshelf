#!/bin/sh
set -eu
umask 077
SITE=/www/wwwroot/jerseyshelf
DEST=/var/backups/jerseyshelf/$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p "$DEST"
python3 - "$SITE/storage/store.sqlite" "$DEST/store.sqlite" <<'PY'
import sqlite3,sys
source=sqlite3.connect(sys.argv[1]); dest=sqlite3.connect(sys.argv[2])
source.backup(dest); dest.close(); source.close()
PY
for name in translation-credentials.key fx-credentials.key whatsapp-credentials.key; do
  if [ -f "$SITE/storage/$name" ]; then cp -p "$SITE/storage/$name" "$DEST/$name"; fi
done
# Hard links preserve a point-in-time set without repeatedly copying immutable media.
cp -al "$SITE/storage/media" "$DEST/media"
cp /etc/jerseyshelf.env "$DEST/production.env"
echo "$DEST"
