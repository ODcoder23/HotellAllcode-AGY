# Imron Hotel PMS × Beds24

Mehmonxona boshqaruv tizimining Beds24 channel manager bilan
ikki tomonlama integratsiyasi.

```
Booking.com / Airbnb / Expedia
            ↕
         Beds24
            ↕  API v2 + Webhook
      PMS Backend  ←→  PostgreSQL
            ↕  WebSocket
   Shaxmatka / Admin / Website
```

---

## Ishga tushirish

### 1. Talablar

- Node.js 22+
- PostgreSQL 16+ (`btree_gist` kengaytmasi bilan)
- Redis 7+

Docker bilan: `docker compose up` — uchala xizmat ko'tariladi.

### 2. Sozlash

```bash
cd backend
cp .env.example .env
```

`.env` da to'ldirish **shart** bo'lgan qiymatlar:

| O'zgaruvchi | Nima |
|---|---|
| `DATABASE_URL` | PostgreSQL manzili |
| `REDIS_URL` | Redis manzili |
| `ENCRYPTION_KEY` | Beds24 token'larini shifrlash (32 bayt, base64) |
| `JWT_SECRET` | Sessiya imzosi |
| `WEBHOOK_URL_TOKEN` | Webhook URL'idagi maxfiy token |

Kalit yasash:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. Baza

```bash
npm install
npx prisma migrate deploy
npm run db:seed          # 12 xona, 3 tur, test foydalanuvchilar
```

### 4. Ishga tushirish

```bash
npm run dev              # backend :3000
```

Shaxmatka — `index (7).html` faylini brauzerda oching.

---

## Beds24'ga ulash

Mock server bilan sinash uchun (Beds24 hisobisiz):

```bash
cd mock-beds24 && npm install && npm run dev   # :4000
```

`.env` da `BEDS24_BASE_URL="http://localhost:4000"`.

**Haqiqiy Beds24'ga ulash** — to'liq qadamlar:
[`11-BOSQICHLAR-ROADMAP.md`](11-BOSQICHLAR-ROADMAP.md) → FAZA 15.

Qisqacha:

1. Beds24 panelida invite code yarating
   (Settings → Account → Access, scope: bookings + inventory + properties)
2. `npm run beds24:connect` — kod so'raladi, token shifrlanib DB'ga yoziladi
3. `.env`: `BEDS24_BASE_URL="https://api.beds24.com/v2"`
4. Beds24 panelida webhook URL: `https://<domen>/api/webhooks/beds24/<token>`
5. `/admin/mapping` sahifasida uch xona turini Beds24 turlariga bog'lang

---

## Production sozlamalari

Topshirishdan oldin `.env` da **majburiy**:

```env
AUTH_REQUIRED="true"          # JWT barcha /api/* da
RATE_LIMIT_DISABLED="false"   # cheklovlar yoqilgan
```

Tekshirish: `GET /health` → `security: { auth: true, rateLimit: true }`

**Seed parollarini o'zgartiring.** `admin@imron.local` / `admin12345`
faqat ishlab chiqish uchun.

HTTPS — Nginx + Let's Encrypt orqali, kodda emas.

---

## Testlar

```bash
npm test                 # 365 test
npm run typecheck        # tip tekshiruvi
./check-docs.sh          # hujjatlar yaxlitligi
```

Testlar ishlayotgan backend (`:3000`), mock (`:4000`), PostgreSQL va
Redis'ni talab qiladi.

---

## Hujjatlar

| Fayl | Nima haqida |
|---|---|
| [`TZ-ASL.md`](TZ-ASL.md) | Mijozning asl texnik topshirig'i — **ustuvor manba** |
| [`00-INDEX.md`](00-INDEX.md) | Navigatsiya: qaysi savol qaysi hujjatda |
| [`01`](01-ARXITEKTURA-VA-QOIDALAR.md) | Arxitektura, qatlamlar, o'zgarmas qoidalar |
| [`02`](02-DATABASE-SXEMA.md) | Ma'lumotlar bazasi, overbooking constraint'i |
| [`03`](03-BEDS24-API-INTEGRATSIYA.md) | Beds24 API, kredit tizimi |
| [`04`](04-WEBHOOK-HANDLER.md) | Webhook qabul qilish, polling fallback |
| [`05`](05-SYNC-QUEUE-BULLMQ.md) | Navbatlar, retry, o'lik xat |
| [`06`](06-XONA-MAPPING.md) | Xona mapping — eng muhim qism |
| [`07`](07-AVAILABILITY-VA-RATES-SYNC.md) | Bandlik va narx sinxronizatsiyasi |
| [`08`](08-RESERVATION-STATUS-VA-TOLOV.md) | Statuslar, to'lov hisob-kitobi |
| [`09`](09-REALTIME-WEBSOCKET.md) | Real-time yangilanish |
| [`10`](10-SECURITY-VA-SYNCLOG.md) | Xavfsizlik, RBAC, audit |
| [`11`](11-BOSQICHLAR-ROADMAP.md) | Bosqichlar va **topshirish qadamlari** |
| [`12`](12-PMS-DAN-BEDS24-GA-SYNC.md) | PMS → Beds24: sakkiz amal |
| [`13`](13-WEBSITE-INTEGRATSIYA.md) | Website uchun ommaviy API |

---

## Tuzilma

```
backend/          Node + Express + Prisma
  src/
    lib/          umumiy: xato, shifrlash, JWT, rate limit
    routes/       HTTP endpoint'lar
    services/     biznes mantiq
      beds24/     kanal adapteri (almashtiriladigan)
      channel/    interfeys va registr
    queues/       BullMQ worker'lari
    realtime/     WebSocket
  prisma/         schema va migratsiyalar

mock-beds24/      Beds24 taqlidi — hisobsiz sinash uchun
index (7).html    Shaxmatka (mavjud frontend)
```

---

## Muhim xususiyatlar

**Overbooking imkonsiz.** PostgreSQL `EXCLUDE USING gist` constraint'i
bilan kafolatlanadi — dastur mantig'i xato qilsa ham baza rad etadi.
30 parallel so'rovdan faqat bittasi o'tadi.

**Beds24 o'chsa PMS ishlaydi.** Bron, check-in, narx, to'lov —
hammasi davom etadi. Sync navbatda kutadi va Beds24 qaytganda
avtomatik yuboriladi.

**Kanal almashtiriladi.** `ChannelAdapter` interfeysi va registr —
yangi kanal qo'shish uchun bitta fayl o'zgaradi.

**Kredit tejash.** Beds24'da 5 daqiqada 100 kredit cheklovi bor.
Sakkiz chora qo'llanadi: token kesh, webhook (polling emas),
o'zgarmagan kunlarni yubormaslik, oraliqqa yig'ish, debounce va
boshqalar.
