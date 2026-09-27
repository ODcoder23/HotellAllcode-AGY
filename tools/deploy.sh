#!/bin/bash
# ============================================================
#  Kodni serverga yuborish va ishga tushirish (2026-09-28)
#
#  Ishlatish:  bash tools/deploy.sh
#
#  Serverda: /srv/projects/hotel/ — docker compose (api + postgres +
#  redis), SERVER.md. Tartib:
#    1. Bazada ma'lumot bo'lsa — ZAXIRA (pg_dump, backups/pre-deploy-*)
#    2. Kod: docker-compose.yml, deploy/, backend/ (src, prisma, public,
#       scripts...) butunlay almashtiriladi. TEGILMAYDI: .env, backups/,
#       volume'lar (baza, Redis, tozalash rasmlari)
#    3. `docker compose up -d --build` — migratsiyalar konteyner
#       ishga tushishida o'zi qo'llanadi
#    4. /health kutiladi
# ============================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../zakas042" && pwd)"
REMOTE=/srv/projects/hotel
TGZ="$(mktemp -u)-hotel.tgz"

echo "Kod yig'ilmoqda: $ROOT"
cd "$ROOT"
tar --exclude='*.bak' --exclude='backend/public/uploads' -czf "$TGZ" \
    docker-compose.yml deploy \
    backend/src backend/prisma backend/public/app backend/public/admin \
    backend/scripts backend/package.json backend/package-lock.json \
    backend/tsconfig.json backend/Dockerfile backend/.dockerignore \
    backend/.env.example

scp -q -i "$KEY" "$TGZ" "$SERVER:/tmp/hotel-deploy.tgz"
rm -f "$TGZ"

ssh -i "$KEY" "$SERVER" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
cd /srv/projects/hotel
[ -f .env ] || { echo "XATO: /srv/projects/hotel/.env yo'q (SERVER.md, birinchi o'rnatish)"; exit 1; }

# 1. Zaxira — baza ishlayotgan va unda bron/foydalanuvchi bo'lsa
mkdir -p backups
if docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then
  F="backups/pre-deploy-$(date +%F-%H%M).dump"
  docker compose exec -T postgres pg_dump -U imron -d imron_pms -Fc > "$F"
  SIZE=$(stat -c%s "$F")
  [ "$SIZE" -gt 0 ] || { echo "XATO: zaxira bo'sh — deploy to'xtatildi"; exit 1; }
  cat "$F" | docker compose exec -T postgres pg_restore -l > /dev/null \
    || { echo "XATO: zaxira o'qilmadi — deploy to'xtatildi"; exit 1; }
  echo "  zaxira: $F ($(numfmt --to=iec "$SIZE"))"
fi

# 2. Kod — eski fayllar qolib ketmasin
rm -rf backend/src backend/prisma backend/public/app backend/public/admin backend/scripts deploy
tar xzf /tmp/hotel-deploy.tgz
rm -f /tmp/hotel-deploy.tgz
chmod +x deploy/*.sh

# 3. Yig'ish va ishga tushirish
docker compose up -d --build 2>&1 | grep -vE '^\s*$' | tail -8

# 4. Tekshiruv
PORT=$(grep -E '^API_PORT=' .env | cut -d= -f2)
for i in $(seq 1 60); do
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/health" > /tmp/hotel-health.json 2>/dev/null; then
    echo "  health: $(cat /tmp/hotel-health.json)"; rm -f /tmp/hotel-health.json
    exit 0
  fi
  sleep 2
done
echo "XATO: /health javob bermadi — docker compose logs api --tail 50"
exit 1
REMOTE_SCRIPT
