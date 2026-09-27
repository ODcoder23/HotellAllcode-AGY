# Backend — mahalliy ishga tushirish

Bu fayl **mahalliy** (kompyuterda) ishga tushirish uchun.
Kundalik ish serverda olib boriladi — [`../SERVER.md`](../SERVER.md).

Loyiha logikasi: [`../PROJECT_LOGIC.md`](../PROJECT_LOGIC.md)

---

## Talablar

- Node.js 22+
- PostgreSQL 16+ (`btree_gist` kengaytmasi bilan — overbooking
  constraint'i shunga tayanadi)
- Redis 7+

`docker-compose.yml` — server uchun (portlar faqat `127.0.0.1`, sirlar
`.env` da): [`../SERVER.md`](../SERVER.md). Lokal ishlash — pastdagi tartib.

---

## Sozlash

```bash
cd backend
cp .env.example .env
```

`.env` da to'ldirish **shart** bo'lgan qiymatlar:

| O'zgaruvchi | Nima |
|---|---|
| `DATABASE_URL` | PostgreSQL manzili |
| `REDIS_URL` | Redis manzili |
| `JWT_SECRET` | Sessiya imzosi (32+ belgi) |

Kalit yasash:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`NODE_ENV=production` da server `AUTH_REQUIRED=false`,
`RATE_LIMIT_DISABLED=true` yoki qisqa `JWT_SECRET` bilan ISHGA TUSHMAYDI.

---

## Baza

```bash
npm install
npx prisma migrate deploy
npm run db:seed          # 18 xona, 9 tarif, 3285 narx, test foydalanuvchilar
```

**Seed mavjud ma'lumotni o'chiradi.** Himoya: baza nomida "test"
bo'lmasa va unda bron bor bo'lsa, seed to'xtaydi
(`SEED_ALLOW_WIPE=true` — ataylab, oldin `pg_dump`).

---

## Ishga tushirish

```bash
npm run dev              # backend :3000 (yoki .env dagi PORT)
```

Frontend backendning o'zidan beriladi (`backend/public/app/`),
alohida server kerak emas:

| Manzil | Nima |
|---|---|
| `/` | Sayt |
| `/shaxmatka` | Bandlik jadvali |
| `/admin-panel` | Xodimlar paneli |

Kirish (faqat mahalliy seed bazada): `founder@imron.local` / `admin12345`.
Bu parol ochiq repoda — serverda ishlatilmasin.

---

## Testlar

**Testlar bazani tozalaydi** — har test faylidan oldin seed chaqiriladi.
Lokal `.env` dagi `localhost:5433` tunnel orqali **jonli bazaga** olib
boradi. Himoya (`vitest.setup.ts`): baza nomida "test" bo'lmasa testlar
ishga tushmaydi. Baribir: tunnel ochiq bo'lsa `npm test` ishga tushirmang,
serverda test ishga tushirilmaydi.

### Alohida test bazasi (2026-09-26 da sinalgan)

Vaqtinchalik PostgreSQL klasteri va Redis alohida portlarda,
hammasi bitta papkada (keyin o'chiriladi). Windows + scoop misoli:

```bash
T=/tmp/pms-test; mkdir -p $T
initdb -D $T/pg -U postgres --auth=trust -E UTF8 --no-locale
pg_ctl -D $T/pg -o "-p 55433 -c listen_addresses=127.0.0.1" -l $T/pg.log start
createdb -h 127.0.0.1 -p 55433 -U postgres imron_test
redis-server --port 56380 --bind 127.0.0.1 --save "" &
```

`$T/test.env`:

```
DATABASE_URL=postgresql://postgres@127.0.0.1:55433/imron_test
REDIS_URL=redis://127.0.0.1:56380
PORT=3399
HOST=127.0.0.1
AUTH_REQUIRED=false
RATE_LIMIT_DISABLED=true
JWT_SECRET=<yangi 64 belgili kalit>
# barcha TELEGRAM_* BO'SH — aks holda mahalliy bot serverdagi bot bilan to'qnashadi

# Beds24 integratsiyasi (channel.test.ts): soxta Beds24 va Markaziy bankni
# test o'zi 56401-portda ko'taradi — server shu manzilga qarashi kerak
BEDS24_BASE_URL=http://127.0.0.1:56401/api/v2
FX_CBU_URL=http://127.0.0.1:56401/api/v2/cbu
ENCRYPTION_KEY=<openssl rand -hex 32>
WEBHOOK_URL_TOKEN=test-webhook-token-0123456789
PROPERTY_CACHE_TTL_MS=0
# Polling va catch-up jadvali o'chiq — testlar tugma bilan chaqiradi
POLL_INTERVAL_MINUTES=0
```

```bash
set -a; . $T/test.env; set +a                    # test jarayoni ham shu qiymatlarni olsin
npx prisma migrate deploy                        # "127.0.0.1:55433" chiqishini tekshiring
npx tsx --env-file=$T/test.env src/server.ts &
PMS_URL=http://127.0.0.1:3399 npx vitest run
```

**`127.0.0.1` yozing, `localhost` emas.** Node 18+ da `localhost` avval
IPv6 (`::1`) ga hal bo'ladi.

Ishlab chiqarishga yaqin rejim: `test.env` da `AUTH_REQUIRED=true` —
`vitest.setup.ts` ADMIN tokenini o'zi qo'shadi, `security.test.ts`
rollar chegarasini (401/403) tekshiradi. **Ikkala rejimda ham hamma test
o'tishi kerak** (2026-09-28: 13 fayl, 276 test — ikkala rejimda o'tdi).
GitHub Actions (`.github/workflows/ci.yml`) ham xuddi shuni ikkala rejimda
ishga tushiradi.

Tashqi xizmat kerak emas: testlar internetsiz ishlaydi.

---

## Buyruqlar

| Buyruq | Nima |
|---|---|
| `npm run dev` | Ishlab chiqish (tsx watch) |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | `dist/server.js` |
| `npm test` | Vitest (faqat test bazasida) |
| `npm run db:migrate` | Yangi migratsiya |
| `npm run db:deploy` | Migratsiyalarni qo'llash |
| `npm run db:seed` | Baza to'ldirish |
| `npm run db:studio` | Prisma Studio |
| `npm run build:css` | Shaxmatka Tailwind CSS |
| `npm run data:reset` | Test bronlarini tozalash (narx, maosh, sozlama qoladi). Avval quruq ishga tushadi, `-- --confirm=<baza>` bilan o'chiradi. OLDIN pg_dump — ../SERVER.md |
