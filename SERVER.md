# Server (Contabo VPS)

Butun infratuzilma serverda: `<SERVER_IP>`. Kompyuterda faqat kod.

> Haqiqiy IP va domen repoda saqlanmaydi. Skriptlar uchun `tools/.server`
> fayliga `root@<SERVER_IP>` yozing (git'ga kirmaydi).

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
Beds24: [BEDS24.md](BEDS24.md) · Qolgan ishlar: [ISH_REJASI.md](ISH_REJASI.md)

**2026-09-27 dan production — v2** (`/opt/hotel-pms-v2`). Eski v1
(`/opt/hotel-pms`) izolyatsiya qilingan, ishlamaydi; serverda
`/opt/hotel-pms/ISOLATED.md`. v2 haqida qisqa ma'lumot serverda:
`/opt/hotel-pms-v2/README.md`, joylashgan commit — `DEPLOYED_COMMIT`.

---

## Production manzillari (<DOMAIN>)

Loyiha `<DOMAIN>` domeniga ulangan (nginx `sites-available/hotel-pms-v2`,
SSL / HTTPS + WSS):

| Manzil | Nima |
|---|---|
| `https://<DOMAIN>/` | Sayt — mehmonlar uchun xonalar va bron |
| `https://<DOMAIN>/shaxmatka` | Bandlik jadvali |
| `https://<DOMAIN>/admin-panel` | Xodimlar paneli (Channel manager shu yerda) |
| `https://<DOMAIN>/admin/connection.html`, `mapping.html`, `sync-log.html` | Channel manager alohida sahifalari (token bilan) |
| `https://<DOMAIN>/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>` | Beds24 webhook (token noto'g'ri — 404) |
| `wss://<DOMAIN>/ws` | Real-time (Shaxmatka va admin panel jonli yangilanishi) |
| `https://<DOMAIN>/health` | Holat: DB, Redis, realtime, xavfsizlik |

Kirish ma'lumotlari repoda saqlanmaydi. Seed paroli (`admin12345`)
repoda — serverdagi har foydalanuvchi parolini admin panel → avatar →
"Parolni o'zgartirish" orqali almashtiring.

---

## Lokal dasturchi rejimi (SSH tunnel)

```bash
bash tools/tunnel.sh        # terminal ochiq qoladi
```

Tunnel ochilgach: `http://localhost:3100`, `/shaxmatka`, `/admin-panel`.
Baza `localhost:5433`, Redis `localhost:6380` — bu JONLI server (v2 da
9001 / 9501 / 9502 ga yo'naltiriladi, lokal portlar o'zgarmagan).

---

## Kod yuborish

```bash
bash tools/sync.sh            # yuborish (+ npm install, prisma generate)
bash tools/sync.sh restart    # yuborish + build + qayta ishga tushirish
```

Yuboriladi va serverda **butunlay almashtiriladi**: `backend/src`,
`scripts`, `prisma`, `public/app`, `public/admin`, `tools`, `package*.json`,
`tsconfig*`. Tegilmaydi: `.env`, `node_modules`, `public/uploads` (xona
rasmlari, tozalash fotolari). Server kompilyatsiya qilingan `dist/` ni
ishlatadi — `restart.sh` avval `npm run build` qiladi.

**Yangi migratsiya bo'lsa** — pastdagi "Yangilash" tartibi (avval zaxira).

---

## Nima qayerda

```
KOMPYUTER                          SERVER (<SERVER_IP>)
─────────                          ────────────────────
zakas042/backend/    ──sync.sh──>  /opt/hotel-pms-v2/backend/
  src/ prisma/ public/               src/ prisma/ public/ dist/
                                     .env (chmod 600)

                                   Docker (project hotel-v2):
                                     hotel-v2-postgres  127.0.0.1:9501  (baza imron_pms, user imron)
                                     hotel-v2-redis     127.0.0.1:9502
                                   systemd:
                                     hotel-v2-backend   127.0.0.1:9001  (NODE_ENV=production)
                                   nginx: 443 -> 127.0.0.1:9001
```

---

## Portlar

| Port | Nima | Bog'lanish |
|---|---|---|
| 9001 | backend | `127.0.0.1` (`.env` `HOST=127.0.0.1`) — faqat nginx va tunnel |
| 9501 | PostgreSQL | `127.0.0.1` |
| 9502 | Redis | `127.0.0.1` |

Qo'shimcha himoya: ufw (kiruvchi — standart rad).

---

## Xizmat

```bash
systemctl status hotel-v2-backend
systemctl restart hotel-v2-backend          # yoki: bash /opt/hotel-pms-v2/restart.sh (build + health)
journalctl -u hotel-v2-backend -n 50 --no-pager
```

`Restart=always` — qulasa o'zi ko'tariladi. Unit'da
`Environment=NODE_ENV=production`: bu rejimda server xavfsiz bo'lmagan
sozlama bilan ISHGA TUSHMAYDI (`AUTH_REQUIRED=false`,
`RATE_LIMIT_DISABLED=true` yoki 32 belgidan qisqa `JWT_SECRET`).

Davriy vazifalar (BullMQ `pms-maintenance`, Toshkent vaqti):
to'lanmagan bronlar (soatlik), tozalash (10 daq), xona holati (har soat
:01), audit tozalash (yakshanba 03:30), oshxona hisoboti (07:30, 20:00),
dollar kursi (3 soat), Beds24 polling va catch-up
(`POLL_INTERVAL_MINUTES`, 5; catch-up 15), Beds24 narxi (soatlik), bo'sh joy farqi
(04:00). Beds24 navbatlari — [BEDS24.md](BEDS24.md) 5-bo'lim.

---

## Yangilash (migratsiya bilan)

```bash
# 1. Zaxira (hajmi 0 emasligini va pg_restore -l ishlashini tekshiring)
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> '
  F=/opt/hotel-pms-v2/backups/pre-deploy-$(date +%F-%H%M).dump &&
  docker exec hotel-v2-postgres pg_dump -U imron -d imron_pms -Fc > $F &&
  ls -lh $F && cat $F | docker exec -i hotel-v2-postgres pg_restore -l | head -5'

# 2. Kod
bash tools/sync.sh

# 3. Migratsiya + build + qayta ishga tushirish
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'cd /opt/hotel-pms-v2/backend && set -a && . ./.env && set +a && npx prisma migrate deploy'
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> 'bash /opt/hotel-pms-v2/restart.sh'
```

Xavfli migratsiyadan oldin **mashq** qiling: zaxirani vaqtinchalik
bazaga (`createdb imron_pms_rehearsal` + `pg_restore`) tiklab, migratsiyani
o'sha bazada sinang (`prisma migrate deploy` + `prisma migrate diff
--exit-code`), keyin o'chiring. Mashq ham umumiy Redis'ni ishlatadi —
mashq bazasi bilan server ishga tushirilmaydi.

`ssh host 'bash -s' < skript` ichida `docker exec -i` skriptning qolgan
qismini yutib yuboradi — `cat fayl | docker exec -i ...` ishlating.

**Tekshiruv:** `/health` 200; sayt, Shaxmatka, admin panel ochiladi;
`journalctl` da xato yo'q.

### Beds24 qaytishi (2026-09-27, Q19) — deploy tartibi

Migratsiya `20260927120000_beds24_restore`: bron/to'lov/narxga Beds24
ustunlari qo'shiladi, kuzatuv jadvallari (`ChannelBooking`,
`ChannelCalendar`) o'chadi, `SALES_STOP` sozlamasi o'chadi va kelgusi
STOP kunlari ochiladi, tugagan bronlar `NOT_APPLICABLE` bo'ladi. Mavjud
narxlar Beds24'ga avtomatik ketmaydi. Egasining roziligi bilan:

1. Zaxira → mashq bazasida migratsiya (`migrate diff --exit-code` 0).
2. `.env`: `ENCRYPTION_KEY` va `WEBHOOK_URL_TOKEN` v2 da bor (2026-09-27
   tekshirildi). Eskirgan `CHANNEL_MONITOR_MINUTES` qatori o'rniga
   (ixtiyoriy) `POLL_INTERVAL_MINUTES=5`, `CATCH_UP_INTERVAL_MINUTES=15`.
3. `bash tools/sync.sh` → `migrate deploy` → `restart.sh` → tekshiruv.
4. 101-xonadagi qo'lda yopiq (30.09–03.10, Booking.com broni uchun)
   bog'lashdan **oldin** ochiladi.
5. Egasi invite code beradi → admin panel → Channel manager → Ulash →
   "Unit'larni avtomatik bog'lash" → Bronlar bo'limida import natijasi.
6. Beds24'da webhook URL (`/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>`).

**Orqaga qaytarish** (faqat zarur bo'lsa):

```bash
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> '
  systemctl stop hotel-v2-backend &&
  cat /opt/hotel-pms-v2/backups/<ZAXIRA>.dump |
    docker exec -i hotel-v2-postgres pg_restore -U imron -d imron_pms --clean --if-exists'
```

keyin oldingi kodni yuboring (`git checkout <eski-commit> && bash
tools/sync.sh restart`).

`npm run data:reset` faqat TEST BRONLARINI o'chiradi (narx, maosh,
sozlama qoladi) — ishga tushirish egasining alohida qarori.

---

## Zaxira

Kunlik, soat 03:00 da (cron): `/opt/hotel-pms-v2/backup.sh` →
`/opt/hotel-pms-v2/backups/db-*.sql.gz` (30 kun saqlanadi). v1 dan
ko'chirilgan ma'lumotning yakuniy nusxasi: `backups/imported-from-v1-*.dump`.

---

## Muammo bo'lsa

```bash
bash tools/status.sh          # umumiy holat

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'journalctl -u hotel-v2-backend -n 40 --no-pager'

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'systemctl restart hotel-v2-backend'
```

**Bazaga to'g'ridan-to'g'ri ulanish** (tunnel ochiq bo'lsa):
`postgresql://imron:<parol>@localhost:5433/imron_pms` — parol serverdagi
`backend/.env` da (bu yerda yozilmaydi).

> Lokal `.env` tunnel orqali SHU bazaga ulanadi. Testlarni faqat alohida
> test bazasida ishga tushiring (`zakas042/README.md`, "Testlar").
> Serverda test ishga tushirilmaydi.

---

## Xavfsizlik eslatmasi

- Server SSH paroli va seed parollari egasi tomonidan almashtirilishi kerak.
- Git tarixida (commit 2fa1330) server IP va domen bor;
  `backend/public/uploads/cleaning/` dagi 2 ta foto tarixda qolgan —
  tarixni tozalash egasining qarori.
