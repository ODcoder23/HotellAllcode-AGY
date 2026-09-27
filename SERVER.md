# Server (Contabo VPS)

**Holat:** 2026-09-28 da qayta o'rnatildi (eski `/opt/hotel-pms-v2`
2026-09-27 da egasining buyrug'i bilan butunlay o'chirilgan edi — eski
ma'lumot yo'q). Endi serverdagi boshqa loyihalar kabi
`/srv/projects/hotel/` da, Docker Compose bilan.

> Haqiqiy IP va domen repoda saqlanmaydi. Skriptlar uchun `tools/.server`
> fayliga `root@<SERVER_IP>` yozing (git'ga kirmaydi). SSH kalit:
> `~/.ssh/hotel_vps`.

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) · Beds24:
[BEDS24.md](BEDS24.md) · Ishga tushirish ro'yxati:
[ISHGA_TUSHIRISH.md](ISHGA_TUSHIRISH.md) · Qolgan ishlar:
[ISH_REJASI.md](ISH_REJASI.md)

---

## Manzillar (`<DOMAIN>`)

Hozircha vaqtinchalik `hotel.<server-ip>.sslip.io` (DNS sozlamasiz
ishlaydi, Let's Encrypt sertifikati bor). Haqiqiy domenga o'tish —
pastda.

| Manzil | Nima |
|---|---|
| `https://<DOMAIN>/` | Sayt — xonalar va bron |
| `https://<DOMAIN>/shaxmatka` | Bandlik jadvali |
| `https://<DOMAIN>/admin-panel` | Xodimlar paneli (Channel manager shu yerda) |
| `https://<DOMAIN>/admin/connection.html`, `mapping.html`, `sync-log.html` | Channel manager alohida sahifalari |
| `https://<DOMAIN>/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>` | Beds24 webhook (token noto'g'ri — 404) |
| `wss://<DOMAIN>/ws` | Real-time |
| `https://<DOMAIN>/health` | Holat: DB, Redis, realtime, xavfsizlik |

Kirish: bitta FOUNDER hisobi (`bootstrap` yaratgan, parol egasida).
Qolgan xodimlarni egasi admin panel → Foydalanuvchilar'da qo'shadi.
Seed paroli (`admin12345`) serverda **yo'q**.

---

## Tuzilma

```
KOMPYUTER                              SERVER
─────────                              ──────
zakas042/docker-compose.yml  ─deploy─> /srv/projects/hotel/docker-compose.yml
zakas042/deploy/             ─deploy─> /srv/projects/hotel/deploy/  (install, backup, nginx)
zakas042/backend/            ─deploy─> /srv/projects/hotel/backend/
                                       /srv/projects/hotel/.env      (sirlar, chmod 600)
                                       /srv/projects/hotel/backups/  (zaxira)

Docker Compose (loyiha "hotel", tarmoq proj_hotel_net):
  api       127.0.0.1:<API_PORT> -> 3000   (NODE_ENV=production)
  postgres  faqat ichki tarmoqda           (baza imron_pms, user imron)
  redis     faqat ichki tarmoqda           (appendonly — navbatlar saqlanadi)
Volume'lar: pgdata, redisdata, uploads (tozalash rasmlari)
nginx: /etc/nginx/sites-available/proj-hotel (443 -> 127.0.0.1:<API_PORT>)
```

`API_PORT` — serverdagi registrdan (`/srv/projects/_registry/ports.yml`),
`.env` da yozilgan. Postgres va Redis internetga ham, hostga ham
chiqmaydi.

---

## Kod yuborish

```bash
bash tools/deploy.sh
```

Tartib: bazada ma'lumot bo'lsa **avval zaxira**
(`backups/pre-deploy-*.dump`, bo'sh yoki o'qilmasa deploy to'xtaydi) →
kod butunlay almashtiriladi → `docker compose up -d --build` →
migratsiyalar konteyner ishga tushishida o'zi qo'llanadi → `/health`.
Tegilmaydi: `.env`, `backups/`, volume'lar.

Holat: `bash tools/status.sh`. Brauzerda serverga to'g'ridan-to'g'ri:
`bash tools/tunnel.sh` → `http://localhost:3100`.

---

## Birinchi o'rnatish (bo'sh serverga)

```bash
# 1. Papka va o'rnatish fayllari
ssh root@<SERVER_IP> 'mkdir -p /srv/projects/hotel'
scp -r zakas042/deploy root@<SERVER_IP>:/srv/projects/hotel/

# 2. Port, .env (sirlar serverda yaratiladi), nginx, registr, cron
ssh root@<SERVER_IP> 'bash /srv/projects/hotel/deploy/install.sh <DOMAIN>'

# 3. Telegram tokenlari (bo'lsa) — /srv/projects/hotel/.env ga qo'lda

# 4. SSL
ssh root@<SERVER_IP> 'certbot --nginx -d <DOMAIN> --redirect --non-interactive'

# 5. Kod, build, ishga tushirish
bash tools/deploy.sh

# 6. Boshlang'ich ma'lumot: 18 xona, 9 tarif, bitta FOUNDER (parol bir marta chiqadi)
ssh root@<SERVER_IP> 'cd /srv/projects/hotel && docker compose exec api node dist/cli/bootstrap.js'
```

Bootstrap namuna bron, soxta xodim, narx YOZMAYDI (seed'dan farqi).
Takror ishga tushirish xavfsiz.

---

## Xizmat

```bash
cd /srv/projects/hotel
docker compose ps
docker compose logs api --tail 50
docker compose restart api
docker compose exec postgres psql -U imron imron_pms     # baza (JONLI!)
```

`restart: unless-stopped` — qulasa yoki server qayta yoqilsa o'zi
ko'tariladi. `NODE_ENV=production` da server xavfsiz bo'lmagan
sozlama bilan ISHGA TUSHMAYDI (`AUTH_REQUIRED=false`,
`RATE_LIMIT_DISABLED=true`, 32 belgidan qisqa `JWT_SECRET`) —
compose ularni majburan to'g'ri qo'yadi.

Davriy vazifalar (BullMQ `pms-maintenance`, Toshkent vaqti):
to'lanmagan bronlar (soatlik), tozalash (10 daq), xona holati (har soat
:01), audit tozalash (yakshanba 03:30), oshxona hisoboti (07:30, 20:00),
dollar kursi (3 soat), Beds24 polling (5 daq) va catch-up (15), Beds24
narxi (soatlik), bo'sh joy farqi (04:00). Beds24 navbatlari —
[BEDS24.md](BEDS24.md) 5-bo'lim.

---

## Zaxira

Kunlik 03:00 (root cron): `deploy/backup.sh` →
`backups/db-YYYY-MM-DD.dump` (`pg_dump -Fc`, 30 kun). Bo'sh yoki
o'qilmaydigan nusxa saqlanmaydi. Jurnal: `backups/backup.log`.
Deploy'dan oldingi nusxalar: `backups/pre-deploy-*.dump`.

**Tiklash:**

```bash
cd /srv/projects/hotel
docker compose stop api
cat backups/<fayl>.dump | docker compose exec -T postgres \
  pg_restore -U imron -d imron_pms --clean --if-exists
docker compose start api
```

`ssh host 'bash -s' < skript` ichida `docker compose exec` (stdin bilan)
skriptning qolgan qismini yutib yuboradi — `-T` va `cat fayl |`
ishlating.

---

## Haqiqiy domenga o'tish

1. DNS: domen A yozuvi → server IP.
2. `/etc/nginx/sites-available/proj-hotel` da `server_name` → yangi
   domen; `nginx -t && systemctl reload nginx`.
3. `certbot --nginx -d <yangi-domen> --redirect`.
4. Registr (`/srv/projects/_registry/projects.yml`) — `domains`.
5. Beds24 panelida webhook URL'ni yangi domenga almashtiring.

---

## Xavfsizlik eslatmasi

- Sirlar faqat serverdagi `.env` da (o'rnatishda serverning o'zida
  yaratilgan). `ENCRYPTION_KEY` o'zgarsa Beds24'ni qayta ulash kerak.
- nginx `/ws` so'rovlarini log qilmaydi — JWT URL'da (`?token=`) keladi.
- `npm audit`: `prisma` CLI ichidagi `deepmerge-ts` (high) — faqat
  prisma 8.1+ da tuzatilgan; CLI faqat o'zimizning sozlamani o'qiydi,
  tashqi kirishi yo'q. Prisma 8 ga o'tish — alohida ish.
- Git tarixida (commit 2fa1330) eski server IP va domen bor — eski
  ochiq `origin` repo haqida qaror egasida ([ISH_REJASI.md](ISH_REJASI.md)).
