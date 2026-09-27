#!/bin/bash
# ============================================================
#  Server holatini tekshirish
# ============================================================
source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"

ssh -i "$KEY" "$SERVER" 'bash -s' << 'REMOTE'
echo "=== Xizmatlar (systemd) ==="
for s in hotel-v2-backend; do
  state=$(systemctl is-active "$s" 2>/dev/null)
  since=$(systemctl show -p ActiveEnterTimestamp --value "$s" 2>/dev/null | cut -d' ' -f2 | cut -d'.' -f1)
  echo "  $s: $state (${since:-—} dan)"
done

echo
echo "=== Konteynerlar ==="
docker ps --filter "name=hotel-v2-" --format '  {{.Names}}: {{.Status}}'

echo
echo "=== Javoblar ==="
curl -s -o /dev/null -m 5 -w "  backend (9001): %{http_code}\n" http://127.0.0.1:9001/health

echo
echo "=== Baza ==="
docker exec hotel-v2-postgres psql -U imron -d imron_pms -t -c \
  "SELECT '  xona: ' || COUNT(*) FROM \"Room\"
   UNION ALL SELECT '  tarif: ' || COUNT(*) FROM \"RoomType\"
   UNION ALL SELECT '  bron: ' || COUNT(*) FROM \"Reservation\"
   UNION ALL SELECT '  Beds24 ulangan: ' || COUNT(*) FROM \"ChannelConnection\" WHERE \"isActive\"
   UNION ALL SELECT '  Beds24ga yetmagan bron: ' || COUNT(*) FROM \"Reservation\" WHERE \"syncStatus\" IN ('FAILED', 'REJECTED');" 2>/dev/null

echo "=== Zaxira ==="
COUNT=$(find /opt/hotel-pms-v2/backups -name 'db-*.sql.gz' 2>/dev/null | wc -l)
LAST=$(ls -t /opt/hotel-pms-v2/backups/db-*.sql.gz 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  echo "  $COUNT ta nusxa, oxirgisi: $(basename "$LAST") ($(stat -c%s "$LAST" | numfmt --to=iec))"
else
  echo "  ZAXIRA YO'Q"
fi

echo
echo "=== RAM ==="
free -h | awk 'NR==2{print "  bosh: " $7 " / " $2}'
REMOTE
