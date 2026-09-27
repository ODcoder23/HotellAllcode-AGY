#!/bin/bash
# ============================================================
#  SSH tunnel — serverdagi Hotel PMS'ga ulanish
#
#  Ishga tushirish:  bash tools/tunnel.sh
#  To'xtatish:       Ctrl+C
#
#  Tunnel ochilgach brauzerda:
#    http://localhost:3100              sayt
#    http://localhost:3100/shaxmatka    bandlik jadvali
#    http://localhost:3100/admin-panel  boshqaruv paneli
#
#  Baza (DBeaver / psql uchun):
#    postgresql://imron:<parol>@localhost:5433/imron_pms  (parol serverdagi .env da)
#
#  Server — v2 (2026-09-27): backend 9001, PostgreSQL 9501, Redis 9502.
#  Lokal portlar o'zgarmagan (3100/5433/6380) — lokal .env shu bilan ishlaydi.
#  Bu JONLI baza: testlarni bu yerda ishga tushirmang (zakas042/README.md).
#
#  DIQQAT: server portlari 127.0.0.1 ga bog'langan — internetdan
#  kirib bo'lmaydi. Shu tunnel yagona yo'l.
# ============================================================

source "$(dirname "${BASH_SOURCE[0]}")/_server.sh"
KEY="$HOME/.ssh/hotel_vps"

echo "Tunnel ochilmoqda: $SERVER"
echo
echo "  3100 -> server 9001: backend (sayt, shaxmatka, admin panel)"
echo "  5433 -> server 9501: PostgreSQL"
echo "  6380 -> server 9502: Redis"
echo
echo "To'xtatish uchun Ctrl+C"
echo

ssh -N -i "$KEY" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L 3100:127.0.0.1:9001 -L 5433:127.0.0.1:9501 -L 6380:127.0.0.1:9502 "$SERVER"
