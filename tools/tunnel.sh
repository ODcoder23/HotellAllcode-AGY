#!/bin/bash
# ============================================================
#  SSH tunnel — serverdagi Hotel PMS'ga ulanish (2026-09-28)
#
#  Ishga tushirish:  bash tools/tunnel.sh
#  To'xtatish:       Ctrl+C
#
#  Tunnel ochilgach brauzerda:
#    http://localhost:3100              sayt
#    http://localhost:3100/shaxmatka    bandlik jadvali
#    http://localhost:3100/admin-panel  boshqaruv paneli
#
#  Baza va Redis tashqariga umuman chiqmaydi (Docker ichki tarmog'ida).
#  Bazaga: ssh ... 'cd /srv/projects/hotel && docker compose exec postgres
#  psql -U imron imron_pms' — SERVER.md. Bu JONLI baza: testlar faqat
#  alohida test bazasida (README.md, "Testlar").
# ============================================================

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"

PORT=$(ssh -i "$KEY" "$SERVER" "grep -E '^API_PORT=' /srv/projects/hotel/.env | cut -d= -f2")
[ -n "$PORT" ] || { echo "Serverda API_PORT topilmadi"; exit 1; }

echo "Tunnel ochilmoqda: localhost:3100 -> server $PORT (backend)"
echo "To'xtatish uchun Ctrl+C"
echo

ssh -N -i "$KEY" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L "3100:127.0.0.1:$PORT" "$SERVER"
