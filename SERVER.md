# Server (Contabo VPS)

Butun infratuzilma serverda: `<SERVER_IP>`. Kompyuterda faqat kod.

> Haqiqiy IP va domen repoda saqlanmaydi. Skriptlar uchun `tools/.server`
> fayliga `root@<SERVER_IP>` yozing (git'ga kirmaydi).

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
Qolgan ishlar: [ISH_REJASI.md](ISH_REJASI.md)

---

## Production manzillari (<DOMAIN>)

Loyiha `<DOMAIN>` domeniga ulangan (nginx, SSL / HTTPS + WSS):

| Manzil | Nima |
|---|---|
| `https://<DOMAIN>/` | Sayt — mehmonlar uchun xonalar va bron |
| `https://<DOMAIN>/shaxmatka` | Bandlik jadvali |
| `https://<DOMAIN>/admin-panel` | Xodimlar paneli |
| `wss://<DOMAIN>/ws` | Real-time (Shaxmatka va admin panel jonli yangilanishi) |
| `https://<DOMAIN>/health` | Holat: DB, Redis, realtime, xavfsizlik |

`/admin/*.html` (Beds24 mapping, ulanish, sync jurnali) va
`/api/webhooks/beds24/*` 2026-09-26 dan yo'q — 404 qaytaradi.

Kirish ma'lumotlari repoda saqlanmaydi (repo ochiq). Seed paroli
(`admin12345`) ochiq repoda — serverdagi har foydalanuvchi parolini
admin panel → avatar → "Parolni o'zgartirish" orqali almashtiring.

---

## Lokal dasturchi rejimi (SSH tunnel)

```bash
bash tools/tunnel.sh        # terminal ochiq qoladi
```

Tunnel ochilgach: `http://localhost:3100`, `/shaxmatka`, `/admin-panel`.
Baza `localhost:5433`, Redis `localhost:6380` — bu JONLI server.

---

## Kod yuborish

```bash
bash tools/sync.sh            # yuborish (+ npm install, prisma generate)
bash tools/sync.sh restart    # yuborish + build + qayta ishga tushirish
```

Yuboriladi va serverda **butunlay almashtiriladi**: `backend/src`,
`scripts`, `prisma`, `public/app`, `tools`, `package*.json`, `tsconfig*`.
Tegilmaydi: `.env`, `node_modules`, `public/uploads` (xona rasmlari,
tozalash fotolari). Server kompilyatsiya qilingan `dist/` ni ishlatadi —
`restart.sh` avval `npm run build` qiladi.

**Yangi migratsiya bo'lsa** — pastdagi "Yangilash" tartibi (avval zaxira).

---

## Nima qayerda

```
KOMPYUTER                          SERVER (<SERVER_IP>)
─────────                          ────────────────────
zakas042/backend/    ──sync.sh──>  /opt/hotel-pms/backend/
  src/ prisma/ public/app/           src/ prisma/ public/ dist/
                                     .env (chmod 600)

                                   Docker:
                                     hotel-postgres  127.0.0.1:5433
                                     hotel-redis     127.0.0.1:6380
                                   systemd:
                                     hotel-backend   127.0.0.1:3100  (NODE_ENV=production)
                                   nginx: 443 -> 127.0.0.1:3100
```

`hotel-mock` (Beds24 imitatori, :4100) 2026-09-26 da o'chirildi va
olib tashlandi.

---

## Portlar

| Port | Nima | Bog'lanish |
|---|---|---|
| 3100 | backend | `127.0.0.1` (`.env` `HOST=127.0.0.1`) — faqat nginx va tunnel |
| 5433 | PostgreSQL | `127.0.0.1` |
| 6380 | Redis | `127.0.0.1` |

Qo'shimcha himoya: ufw (kiruvchi — standart rad).

---

## Xizmat

```bash
systemctl status hotel-backend
systemctl restart hotel-backend
journalctl -u hotel-backend -n 50 --no-pager
```

`Restart=always` — qulasa o'zi ko'tariladi. Production rejimi systemd
drop-in bilan: `/etc/systemd/system/hotel-backend.service.d/10-production.conf`
(`Environment=NODE_ENV=production`). Bu rejimda server xavfsiz bo'lmagan
sozlama bilan ISHGA TUSHMAYDI (`AUTH_REQUIRED=false`,
`RATE_LIMIT_DISABLED=true` yoki 32 belgidan qisqa `JWT_SECRET`).

Davriy vazifalar (BullMQ `pms-maintenance`, Toshkent vaqti):
to'lanmagan bronlar (soatlik), STOP ufqi (15 daq), tozalash (10 daq),
xona holati (har soat :01), audit tozalash (yakshanba 03:30),
oshxona hisoboti (07:30, 20:00).

---

## Yangilash (migratsiya bilan)

```bash
# 1. Zaxira (hajmi 0 emasligini va pg_restore -l ishlashini tekshiring)
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> '
  F=/opt/hotel-pms/backups/pre-deploy-$(date +%F-%H%M).dump &&
  docker exec hotel-postgres pg_dump -U imron -d imron_pms -Fc > $F &&
  ls -lh $F && cat $F | docker exec -i hotel-postgres pg_restore -l | head -5'

# 2. Kod
bash tools/sync.sh

# 3. Migratsiya + build + qayta ishga tushirish
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'cd /opt/hotel-pms/backend && set -a && . ./.env && set +a && npx prisma migrate deploy'
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> 'bash /opt/hotel-pms/restart.sh'
```

Xavfli migratsiyadan oldin **mashq** qiling: zaxirani vaqtinchalik
bazaga (`createdb imron_pms_rehearsal` + `pg_restore`) tiklab, migratsiyani
o'sha bazada sinang, keyin o'chiring. 2026-09-26 dagi Beds24 olib
tashlash shu tartibda qilingan ([BEDS24.md](BEDS24.md), 5-bo'lim).

**Tekshiruv:** `/health` 200; sayt, Shaxmatka, admin panel ochiladi;
`journalctl` da xato yo'q.

### 2026-09-27 yangilanishi: Channel manager (kuzatuv) va to'lov qaytarish

Ikki migratsiya — faqat yangi jadval va bo'sh ustun qo'shadi, mavjud
ma'lumotga tegmaydi: `20260927050200_channel_monitor`,
`20260927070000_payment_reversal_link`. Tartib yuqoridagidek (zaxira →
kod → `npm ci` → `migrate deploy` → build → restart), qo'shimcha:

```bash
# .env ga (bir marta) — Beds24 tokenini shifrlash kaliti
echo "ENCRYPTION_KEY=\"$(openssl rand -hex 32)\"" >> /opt/hotel-pms/backend/.env
# ixtiyoriy: webhook qabul qilish uchun
# echo "WEBHOOK_URL_TOKEN=\"$(openssl rand -hex 24)\"" >> /opt/hotel-pms/backend/.env
```

Kalit bo'lmasa server baribir ishlaydi — faqat Beds24'ga ulanib
bo'lmaydi. Keyin egasi: admin panel → Channel manager → Ulash
(invite code). Tekshiruv: egasi hisobida Channel manager tugmasi bor,
admin/menejer/qabulxona hisobida yo'q.

`npm run data:reset` faqat TEST BRONLARINI o'chiradi (narx, maosh,
sozlama qoladi) — ishga tushirish egasining alohida qarori.

**Orqaga qaytarish** (faqat zarur bo'lsa):

```bash
ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> '
  systemctl stop hotel-backend &&
  cat /opt/hotel-pms/backups/<ZAXIRA>.dump |
    docker exec -i hotel-postgres pg_restore -U imron -d imron_pms --clean --if-exists'
```

keyin oldingi kodni yuboring (`git checkout <eski-commit> && bash tools/sync.sh restart`)
yoki `backups/code-*.tgz` dan tiklang.

---

## Zaxira

Kunlik, soat 03:00 da (cron): `0 3 * * * /opt/hotel-pms/backup.sh`.
Zaxiralar `/opt/hotel-pms/backups/` da.

Beds24 olib tashlashdan oldingi to'liq nusxalar (2026-09-26):
`pre-remove-beds24-2026-09-26-2049.dump` (+ `-final.dump` — backend
to'xtatilgandan keyin), `env-pre-remove-beds24-*.bak`,
`code-pre-remove-beds24-*.tgz` (eski kod + mock), `env-pre-prod-*.bak`,
`hotel-mock.service.*.bak`.

---

## Muammo bo'lsa

```bash
bash tools/status.sh          # umumiy holat

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'journalctl -u hotel-backend -n 40 --no-pager'

ssh -i ~/.ssh/hotel_vps root@<SERVER_IP> \
  'systemctl restart hotel-backend'
```

**Bazaga to'g'ridan-to'g'ri ulanish** (tunnel ochiq bo'lsa):
`postgresql://<user>:<parol>@localhost:5433/imron_pms` — login va parol
serverdagi `backend/.env` da (repo ochiq, bu yerda yozilmaydi).

> Lokal `.env` tunnel orqali SHU bazaga ulanadi. Testlarni faqat alohida
> test bazasida ishga tushiring (`zakas042/README.md`, "Testlar").
> Serverda test ishga tushirilmaydi (`tools/test.sh` 2026-09-26 da olib tashlandi).

---

## Xavfsizlik eslatmasi

- Server SSH paroli va seed parollari egasi tomonidan almashtirilishi kerak.
- Repo ochiq: git tarixida (commit 2fa1330) server IP va domen bor;
  `backend/public/uploads/cleaning/` dagi 2 ta foto hali repoda kuzatiladi
  (endi `.gitignore` da, lekin indeksdan olib tashlash va tarixni
  tozalash — egasining qarori).
