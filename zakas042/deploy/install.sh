#!/bin/bash
# ============================================================
#  Birinchi o'rnatish — serverda, root (2026-09-28)
#
#  Ishlatish:  bash /srv/projects/hotel/deploy/install.sh <domen>
#
#  Bajaradi (serverdagi /srv/projects/README.md qoidalari bo'yicha):
#    1. Registrdan bo'sh port (9000–9499), 127.0.0.1 ga
#    2. /srv/projects/hotel/.env — sirlar SHU YERDA yaratiladi
#       (JWT_SECRET, ENCRYPTION_KEY, WEBHOOK_URL_TOKEN, baza paroli)
#    3. nginx: /etc/nginx/sites-available/proj-hotel (HTTP; SSL — certbot)
#    4. Registr: ports.yml, projects.yml
#    5. cron: kunlik zaxira 03:00
#
#  Keyin: tools/deploy.sh (kod, build, ishga tushirish) va
#  bootstrap (SERVER.md "Birinchi o'rnatish").
#  Takror ishga tushirilsa — hech narsani almashtirmaydi, to'xtaydi.
# ============================================================
set -euo pipefail

DOMAIN="${1:?Ishlatish: install.sh <domen>}"
ROOT=/srv/projects/hotel
REG=/srv/projects/_registry
NAME=hotel

[ -f "$ROOT/.env" ] && { echo "Allaqachon o'rnatilgan: $ROOT/.env bor"; exit 1; }
[ -f "$ROOT/deploy/nginx.conf" ] || { echo "XATO: $ROOT/deploy/nginx.conf yo'q"; exit 1; }
grep -qE "^[[:space:]]*-[[:space:]]*name:[[:space:]]*$NAME[[:space:]]*$" "$REG/projects.yml" \
  && { echo "XATO: '$NAME' registrda allaqachon bor"; exit 1; }

# --- 1. Port — new-project.sh bilan bir xil qoida --------------------
find_free_port() {
  local start end p
  start=$(grep -oP 'app_range:\s*\[\K[0-9]+' "$REG/ports.yml")
  end=$(grep -oP 'app_range:\s*\[[0-9]+,\s*\K[0-9]+' "$REG/ports.yml")
  for (( p=start; p<=end; p++ )); do
    grep -qE "^[[:space:]]*-[[:space:]]*port:[[:space:]]*$p[[:space:]]*$" "$REG/ports.yml" && continue
    ss -tln 2>/dev/null | grep -qE "[:.]$p[[:space:]]" && continue
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "[:.]$p->" && continue
    echo "$p"; return 0
  done
  return 1
}
PORT=$(find_free_port) || { echo "XATO: bo'sh port yo'q"; exit 1; }

# --- 2. .env ---------------------------------------------------------
mkdir -p "$ROOT/backups" && chmod 700 "$ROOT/backups"
umask 077
{
  echo "# Imron Hotel PMS — server sozlamalari ($(date +%F)). Git'ga KIRMAYDI."
  echo "API_PORT=$PORT"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "JWT_EXPIRES_IN=12h"
  echo "CORS_ORIGINS="
  echo "# Beds24 (BEDS24.md): token shu kalit bilan shifrlanadi — o'zgarsa qayta ulash kerak"
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "WEBHOOK_URL_TOKEN=$(openssl rand -hex 24)"
  echo "POLL_INTERVAL_MINUTES=5"
  echo "CATCH_UP_INTERVAL_MINUTES=15"
  echo "# Telegram botlari — bo'sh bo'lsa bot ishga tushmaydi (.env.example)"
  echo "TELEGRAM_BOT_TOKEN="
  echo "TELEGRAM_FOUNDER_IDS="
  echo "TELEGRAM_NOTIFY_BOOKINGS=true"
  echo "TELEGRAM_CLEANING_BOT_TOKEN="
  echo "TELEGRAM_CLEANING_GROUP_ID="
  echo "TELEGRAM_KITCHEN_BOT_TOKEN="
  echo "TELEGRAM_KITCHEN_CHAT_ID="
} > "$ROOT/.env"
chmod 600 "$ROOT/.env"
umask 022

# --- 3. nginx --------------------------------------------------------
sed -e "s|{{DOMAIN}}|$DOMAIN|g" -e "s|{{PORT}}|$PORT|g" "$ROOT/deploy/nginx.conf" \
  > /etc/nginx/sites-available/proj-$NAME
ln -sfn /etc/nginx/sites-available/proj-$NAME /etc/nginx/sites-enabled/proj-$NAME
if ! nginx -t 2>/dev/null; then
  rm -f /etc/nginx/sites-enabled/proj-$NAME
  nginx -t
  echo "XATO: nginx konfiguratsiyasi buzildi — bekor qilindi"; exit 1
fi
systemctl reload nginx

# --- 4. Registr ------------------------------------------------------
cp "$REG/ports.yml" "$REG/ports.yml.bak-$(date +%F)"
cp "$REG/projects.yml" "$REG/projects.yml.bak-$(date +%F)"
python3 - "$NAME" "$PORT" "$DOMAIN" <<'PY'
import sys
name, port, domain = sys.argv[1:4]
p = '/srv/projects/_registry/ports.yml'
s = open(p).read().rstrip('\n')
s += ("\n\n  - port: %s\n    project: %s\n    service: app\n    bind: 127.0.0.1\n"
      "    note: \"Imron Hotel PMS — api (Docker). Postgres/Redis tashqariga chiqmaydi\"\n") % (port, name)
open(p, 'w').write(s)
p = '/srv/projects/_registry/projects.yml'
s = open(p).read().rstrip('\n')
s += ("\n\n  - name: %s\n    status: active\n    path: /srv/projects/%s\n    runtime: docker-compose\n"
      "    network: proj_%s_net\n    entry_port: %s\n    domains: [%s]\n    ssl: letsencrypt\n"
      "    note: \"Imron Hotel PMS (sayt, Shaxmatka, admin panel, Beds24). Qayta o'rnatildi 2026-09-28\"\n") % (name, name, name, port, domain)
open(p, 'w').write(s)
PY

# --- 5. Kunlik zaxira ------------------------------------------------
( crontab -l 2>/dev/null | grep -v "$ROOT/deploy/backup.sh" || true
  echo "0 3 * * * $ROOT/deploy/backup.sh >> $ROOT/backups/backup.log 2>&1" ) | crontab -

echo "O'rnatildi: $ROOT (port $PORT, domen $DOMAIN)"
echo "Keyin: SSL — certbot --nginx -d $DOMAIN --redirect; kod — tools/deploy.sh"
