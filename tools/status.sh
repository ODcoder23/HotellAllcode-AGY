#!/bin/bash
# ============================================================
#  Server holatini tekshirish (2026-09-28: /srv/projects/hotel, Docker)
# ============================================================
source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"

ssh -i "$KEY" "$SERVER" 'bash -s' << 'REMOTE'
cd /srv/projects/hotel || exit 1
echo "=== Konteynerlar ==="
docker compose ps --format '  {{.Service}}: {{.Status}}'

echo
echo "=== Javob ==="
PORT=$(grep -E '^API_PORT=' .env | cut -d= -f2)
curl -s -m 5 "http://127.0.0.1:$PORT/health"; echo

echo
echo "=== Baza ==="
docker compose exec -T postgres psql -U imron -d imron_pms -t -c \
  "SELECT '  xona: ' || COUNT(*) FROM \"Room\"
   UNION ALL SELECT '  bron: ' || COUNT(*) FROM \"Reservation\"
   UNION ALL SELECT '  foydalanuvchi: ' || COUNT(*) FROM \"User\"
   UNION ALL SELECT '  Beds24 ulangan: ' || COUNT(*) FROM \"ChannelConnection\" WHERE \"isActive\"
   UNION ALL SELECT '  Beds24ga yetmagan bron: ' || COUNT(*) FROM \"Reservation\" WHERE \"syncStatus\" IN ('FAILED', 'REJECTED');" 2>/dev/null

echo "=== Zaxira ==="
LAST=$(ls -t backups/db-*.dump 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  echo "  $(ls backups/db-*.dump | wc -l) ta nusxa, oxirgisi: $(basename "$LAST") ($(stat -c%s "$LAST" | numfmt --to=iec))"
else
  echo "  KUNLIK ZAXIRA YO'Q"
fi

echo
echo "=== RAM ==="
free -h | awk 'NR==2{print "  bo'\''sh: " $7 " / " $2}'
REMOTE
