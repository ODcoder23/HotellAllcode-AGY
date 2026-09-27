#!/bin/bash
# ============================================================
#  Kunlik zaxira — /srv/projects/hotel/deploy/backup.sh
#
#  cron (root):  0 3 * * *  /srv/projects/hotel/deploy/backup.sh
#  Natija:       /srv/projects/hotel/backups/db-YYYY-MM-DD.dump (pg_dump -Fc)
#  Saqlanadi:    30 kun
#
#  Tiklash (SERVER.md):
#    cat backups/<fayl>.dump | docker compose exec -T postgres \
#      pg_restore -U imron -d imron_pms --clean --if-exists
# ============================================================
set -euo pipefail
cd /srv/projects/hotel
mkdir -p backups

F="backups/db-$(date +%F).dump"
docker compose exec -T postgres pg_dump -U imron -d imron_pms -Fc > "$F.tmp"

# Bo'sh yoki o'qilmaydigan nusxa eskisini almashtirmasin
[ -s "$F.tmp" ] || { echo "$(date -Is) zaxira bo'sh" >&2; rm -f "$F.tmp"; exit 1; }
cat "$F.tmp" | docker compose exec -T postgres pg_restore -l > /dev/null \
  || { echo "$(date -Is) zaxira o'qilmadi" >&2; rm -f "$F.tmp"; exit 1; }
mv "$F.tmp" "$F"

find backups -name 'db-*.dump' -mtime +30 -delete
echo "$(date -Is) zaxira: $F ($(stat -c%s "$F") bayt)"
