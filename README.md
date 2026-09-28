# Imron Hotel PMS

Mehmonxona boshqaruv tizimi: sayt (mehmonlar broni), bandlik jadvali
(Shaxmatka), xodimlar paneli, Telegram botlar (egasi, tozalik, oshxona) va
Beds24 orqali OTA kanallar (Booking.com, Ostrovok).

```
   Sayt (mehmon)      Qabulxona / egasi        Booking.com, Ostrovok
        |                    |                          |
        v                    v                          v
   PMS Backend  <->  PostgreSQL          <->   Beds24 (channel manager)
        |  WebSocket          \             webhook + polling / bron, narx, yopish
   Shaxmatka / Admin panel     Telegram botlar
```

## Hujjatlar

| Hujjat | Nima uchun |
|---|---|
| [PROJECT_LOGIC.md](PROJECT_LOGIC.md) | Tizim qanday ishlaydi: qoidalar, modellar, oqimlar, ruxsatlar. **Avval shuni o'qing** |
| [BEDS24.md](BEDS24.md) | Beds24 integratsiyasi: mantiq, valyuta, ulash, API faktlari, TZ ↔ kod |
| [SERVER.md](SERVER.md) | Serverda ishlash: joylash, xizmat, zaxira, domen |
| [ISH_REJASI.md](ISH_REJASI.md) | Ochiq ishlar va egasining qarorini kutayotgan savollar |
| [TZ-ASL.md](TZ-ASL.md) | Mijoz topshiriqlari (asl matn) va tasdiqlangan qarorlar Q1–Q20 |

Yangi hujjat fayli ochilmaydi — mavzu qaysi faylga tegishli bo'lsa o'sha
yangilanadi ([CLAUDE.md](CLAUDE.md), `zakas042/check-docs.sh` tekshiradi).

## Tuzilma

```
├── zakas042/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── routes/       HTTP, validatsiya (Zod), ruxsat
│   │   │   ├── services/     biznes mantiq: bron, narx, mavjudlik, tozalash, Beds24...
│   │   │   ├── queues/       BullMQ: Beds24 navbatlari va davriy vazifalar
│   │   │   ├── realtime/     WebSocket
│   │   │   ├── bot/          Telegram (3 bot)
│   │   │   ├── lib/          config, pul formulasi, mehmonxona vaqti, auth
│   │   │   └── *.test.ts     testlar (Vitest, ishlab turgan server + test bazasi)
│   │   ├── prisma/           sxema, migratsiyalar, seed (faqat test/lokal)
│   │   ├── public/app/       sayt, Shaxmatka, admin panel (backend o'zi beradi)
│   │   ├── public/admin/     Channel manager sahifalari (ulanish, bog'lash, jurnal)
│   │   └── scripts/          test bronlarini tozalash
│   ├── deploy/               server: o'rnatish, nginx, kunlik zaxira
│   ├── docker-compose.yml    server (api + postgres + redis)
│   └── check-docs.sh         hujjat havolalari va invariantlar (CI)
├── tools/                    deploy.sh, status.sh, tunnel.sh (serverga)
└── .github/workflows/ci.yml  tip tekshiruvi, migratsiyalar, testlar ikkala auth rejimida
```

## Lokal ishga tushirish

Talablar: Node.js 22+, PostgreSQL 16+ (`btree_gist` — overbooking
constraint'i shunga tayanadi), Redis 7+.

```bash
cd zakas042/backend
cp .env.example .env         # DATABASE_URL, REDIS_URL, JWT_SECRET (32+ belgi)
npm install
npx prisma migrate deploy
npm run db:seed              # 18 xona, 9 tarif, namunaviy narx va test foydalanuvchilar
npm run dev                  # http://localhost:3000
```

| Manzil | Nima |
|---|---|
| `/` | Sayt |
| `/shaxmatka` | Bandlik jadvali |
| `/admin-panel` | Xodimlar paneli |

Lokal seed bazada kirish: `founder@imron.local` / `admin12345` — bu parol
ochiq, serverda yo'q (serverda `bootstrap` bitta egasi hisobini yaratadi).

- **Telegram tokenlarini lokal `.env` ga yozmang**: jonli botlar serverda
  ishlaydi, bir token ikki joyda so'ralsa Telegram 409 beradi va serverdagi
  bot to'xtaydi.
- `NODE_ENV=production` da server `AUTH_REQUIRED=false`,
  `RATE_LIMIT_DISABLED=true` yoki qisqa `JWT_SECRET` bilan ishga tushmaydi.
- **Seed bazani tozalaydi.** Nomida "test" bo'lmagan va bron bor bazada
  to'xtaydi (`SEED_ALLOW_WIPE=true` — ataylab).

## Testlar

Testlar ishlab turgan serverga HTTP so'rov yuboradi va **har fayl oldidan
bazani qayta seed qiladi**. Shuning uchun faqat alohida, vaqtinchalik
bazada: `vitest.setup.ts` nomida "test" bo'lmagan bazada ishga tushmaydi.
Tashqi internet kerak emas — Beds24 va Markaziy bank soxta serverini
`channel.test.ts` o'zi ko'taradi.

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
AUTH_REQUIRED=true
RATE_LIMIT_DISABLED=true
JWT_SECRET=<64 belgili kalit>
ENCRYPTION_KEY=<openssl rand -hex 32>
WEBHOOK_URL_TOKEN=test-webhook-token-0123456789
BEDS24_BASE_URL=http://127.0.0.1:56401/api/v2
FX_CBU_URL=http://127.0.0.1:56401/api/v2/cbu
PROPERTY_CACHE_TTL_MS=0
POLL_INTERVAL_MINUTES=0
TELEGRAM_BOT_TOKEN=
TELEGRAM_CLEANING_BOT_TOKEN=
TELEGRAM_KITCHEN_BOT_TOKEN=
```

```bash
cd zakas042/backend
set -a; . $T/test.env; set +a
npx prisma migrate deploy                    # manzilda 127.0.0.1:55433 ekanini tekshiring
npx tsx --env-file=$T/test.env src/server.ts &
PMS_URL=http://127.0.0.1:3399 npx vitest run
```

- **Ikkala rejimda o'tishi shart**: `AUTH_REQUIRED=true` va `false` (CI
  ham ikkalasini ishga tushiradi). `true` da `vitest.setup.ts` ADMIN
  tokenini o'zi qo'shadi.
- `localhost` emas, `127.0.0.1` yozing — Node `localhost` ni avval IPv6
  ga hal qiladi.
- Server `:3399` da qolib ketsa keyingi ishga tushirish eski kodni
  sinaydi: `/health` → `security.auth` ni tekshiring, ish tugagach
  server, Postgres va Redis'ni to'xtating.
- Tip tekshiruvi bazaga tegmaydi: `npm run typecheck`.

## Serverga joylash

`bash tools/deploy.sh` — avval baza zaxirasi, keyin kod, `docker compose
up -d --build`, migratsiyalar, `/health`. Holat: `bash tools/status.sh`.
Batafsil: [SERVER.md](SERVER.md).

## Buyruqlar (`zakas042/backend`)

| Buyruq | Nima |
|---|---|
| `npm run dev` | Ishlab chiqish (tsx watch) |
| `npm run build` / `npm start` | TypeScript → `dist/`, ishga tushirish |
| `npm run typecheck` | Tip tekshiruvi (testlar bilan) |
| `npm test` | Vitest — faqat test bazasida (yuqorida) |
| `npm run db:migrate` / `db:deploy` | Yangi migratsiya / migratsiyalarni qo'llash |
| `npm run db:seed` | Test/lokal baza to'ldirish |
| `npm run build:css` | Shaxmatka Tailwind CSS (yangi class qo'shilganda) |
| `npm run data:reset` | Test bronlarini tozalash: avval quruq, `-- --confirm=<baza>` bilan o'chiradi. Oldin `pg_dump` |

## Shaxmatka kutubxonalari

`public/app/vendor/` da mahalliy nusxa (CDN'siz, internet uzilsa ham
ochiladi): React 18.3.1, ReactDOM 18.3.1, Babel standalone 7.26.4 (JSX
brauzerda kompilyatsiya qilinadi), Tailwind 3.4.17 dan yasalgan CSS.

- Tailwind CSS oldindan yasalgan — faqat `shaxmatka.html` dagi class'lar
  kiradi. Yangi class qo'shilsa `npm run build:css`. Dinamik class to'liq
  matn bo'lishi kerak (`ok ? "bg-green-500" : "bg-red-500"`, `bg-${color}-500` emas).
- Versiyani ko'tarish: unpkg'dan `react@X/umd/react.production.min.js`,
  `react-dom@X/umd/react-dom.production.min.js`,
  `@babel/standalone@Y/babel.min.js`. React va ReactDOM versiyasi bir xil
  bo'lishi shart.
