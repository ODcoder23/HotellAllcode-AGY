#!/bin/bash
# ============================================================
#  Kodni serverga yuborish
#
#  Ishlatish:
#    bash tools/sync.sh          — yuboradi (build/restart qilmaydi)
#    bash tools/sync.sh restart  — yuboradi, build qiladi, qayta ishga tushiradi
#
#  Serverda ESKI fayllar qolib ketmasin: src, scripts, prisma,
#  public/app, tools butunlay almashtiriladi (2026-09-26 gacha tar
#  faqat ustiga yozardi — o'chirilgan fayllar serverda qolib, build'ni
#  buzardi). TEGILMAYDI: .env, node_modules, public/uploads (rasmlar).
#
#  Yangi migratsiya bo'lsa: AVVAL zaxira, keyin `npx prisma migrate
#  deploy` (SERVER.md, "Yangilash").
# ============================================================
set -e

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$(cd "$SCRIPT_DIR/../zakas042/backend" && pwd)"
REMOTE="/opt/hotel-pms/backend"

echo "Kod yuborilmoqda: $LOCAL -> $SERVER:$REMOTE"

cd "$LOCAL"
tar --exclude='*.bak' --exclude='public/uploads' -czf /tmp/sync.tgz \
    src prisma public/app scripts tools \
    package.json package-lock.json tsconfig.json tsconfig.test.json \
    vitest.config.ts vitest.setup.ts .env.example

scp -q -i "$KEY" /tmp/sync.tgz "$SERVER:/tmp/"
ssh -i "$KEY" "$SERVER" "set -e; cd $REMOTE && rm -rf src scripts prisma public/app public/admin tools && tar xzf /tmp/sync.tgz && rm /tmp/sync.tgz && echo '  yuborildi'"
rm -f /tmp/sync.tgz

# Yangi bog'liqlik bormi — `npm install` mavjudlarini qayta yuklamaydi.
# Prisma klienti sxemadan qayta yasaladi (build undan keyin).
echo "Bog'liqliklar va Prisma klienti..."
ssh -i "$KEY" "$SERVER" "cd $REMOTE && npm install --no-audit --no-fund 2>&1 | tail -2 && npx prisma generate 2>&1 | grep -E 'Generated|Error'"

if [ "$1" = "restart" ]; then
  echo "Qayta ishga tushirilmoqda..."
  ssh -i "$KEY" "$SERVER" "bash /opt/hotel-pms/restart.sh"
fi
