# Imron Hotel PMS — loyiha logikasi

**Bu hujjat loyihaning amaldagi logikasining yagona referensi.**

Har bir fakt kod, `schema.prisma` yoki jonli tizimda tasdiqlangan
(2026-09-26 auditi). Tasdiqlanmagan narsalar "noaniq" deb belgilangan.

**Beds24 integratsiyasi 2026-09-26 da olib tashlandi** — tizimda
tashqi channel manager yo'q. Qanday ishlagani va qanday olib
tashlangani: [BEDS24.md](BEDS24.md) (arxiv).

Qolgan ishlar: [ISH_REJASI.md](ISH_REJASI.md)

---

## 1. Loyiha nima qiladi

Mehmonxona boshqaruv tizimi (PMS). Bir vaqtda to'rtta ish:

1. **Sayt** — mehmon xona qidiradi va bron qiladi
2. **Shaxmatka** — xodim bandlik jadvalini ko'radi va boshqaradi
3. **Admin panel** — bron, narx, mavjudlik, tozalik, moliya, hisobot, STOP
4. **Telegram botlar** — egasi, tozalik guruhi, oshxona

Asosiy talab: **overbooking bo'lmasligi shart**. Bir xonaga
kesishuvchi ikki bron hech qanday yo'l bilan tushmasligi kerak.

**PMS bazasi yagona haqiqat manbai.** Booking.com va boshqa OTA'lar
tizimga ulanmagan: ulardan kelgan bronni qabulxona qo'lda kiritadi
(manba "Booking.com" va h.k. — komissiya xarajatga avtomatik yoziladi),
OTA'dagi sotuvni esa OTA kabinetida yopadi.

---

## 2. Arxitektura

```
   Sayt (mehmon)        Qabulxona / egasi
         ↓                     ↓
      PMS Backend  ←→  PostgreSQL   ← yagona haqiqat manbai
       (Express)        + Redis        (BullMQ davriy vazifalar, Pub/Sub)
            ↕  WebSocket         ↘
   Sayt · Shaxmatka · Admin panel   Telegram botlar (3 ta)
```

Tashqi tizimga bog'liqlik yo'q: Redis o'chsa ham bron, check-in va
to'lov ishlaydi (davriy vazifalar Redis qaytgach davom etadi).

**Texnologiyalar:** Node.js 22+, Express, TypeScript, Prisma,
PostgreSQL 16 (`btree_gist` kerak), Redis 7, BullMQ, grammy
(Telegram), Zod (validatsiya), JWT.

**Joylashuv:** butun infratuzilma Contabo VPS'da. Kompyuterda
faqat kod. Ulanish SSH tunnel orqali.

### Qatlamlar

| Qatlam | Papka | Javobgarlik |
|---|---|---|
| Route | `src/routes/` | HTTP, validatsiya (Zod), auth |
| Servis | `src/services/` | Biznes mantiq, tranzaksiyalar |
| Navbat | `src/queues/` | BullMQ davriy vazifalar (`pms-maintenance`) |
| Realtime | `src/realtime/` | WebSocket push |
| Bot | `src/bot/` | Telegram (uch alohida bot, 10-bo'lim) |

**Qat'iy qoida:** servis qatlami Telegram'ni, HTTP'ni yoki
WebSocket'ni bilmaydi. U callback chaqiradi (`onTaskChanged`),
bot o'zini shunga ulaydi. Shu sabab bot o'chirilgan bo'lsa ham
tizim ishlayveradi.

### Frontend

Uchala sahifa backend ichida (`backend/public/app/`) va o'sha
serverdan beriladi — CORS va port muammosi yo'q.

| Fayl | Manzil | Texnologiya |
|---|---|---|
| `index.html` | `/` | Vanilla JS |
| `shaxmatka.html` | `/shaxmatka` | React 18 + Tailwind (UMD) |
| `admin-panel.html` | `/admin-panel` | Vanilla JS |

Shaxmatka kutubxonalari `public/app/vendor/` da — CDN'ga
bog'liqlik yo'q, internetsiz ishlaydi. Tailwind CSS oldindan
yasaladi: `npm run build:css`.

---

## 3. Ma'lumot modeli

17 model, 7 enum. Asosiylari:

```
Floor (F1,F2,F3) ──< Room (101..306) >── RoomType (9 tarif)
                       │                      │
                       │                      ├──< RatePlan (kun × tarif × narx)
                       │                      └──< Availability (kesh)
                       │
                       ├──< Reservation >── Guest
                       │       │
                       │       ├──< Payment
                       │       └──< Charge
                       │
                       ├──< RoomDayStatus (yopiq kunlar, STOP)
                       └──< CleaningTask
                               Reservation ──< Expense (OTA komissiyasi, CASCADE)
```

Beds24 jadvallari (`Channel*`, `SyncLog`, `WebhookEvent`,
`SyncState`) va bron/to'lovdagi valyuta, kurs va kanal ustunlari
`20260926200000_remove_beds24` migratsiyasi bilan o'chirilgan.
`pricePerNight` 4 xona kasr bilan saqlanadi (jami narx kechalarga
bo'linganda sent yo'qolmasin). `User.passwordChangedAt` — parol
almashgach eski token'lar bekor.

### Inventar (seed'da belgilangan)

**18 xona, 3 qavat, 9 tarif.** Tizim valyutasi — **faqat so'm**.
"Bugun" — mehmonxona kuni, Toshkent (UTC+5): `lib/hotelTime.ts`
(`hotelToday`), frontendda ham shu qoida.

| Tarif | Seed narxi (namunaviy) | Sig'im | Xonalar |
|---|---|---|---|
| `standard3` | 35 | 3 | 102 |
| `comfort3` | 40 | 3 | 101, 202, 302 |
| `semilux` | 45 | 3 | 105, 305 |
| `comfort4` | 50 | 4 | 103, 304 |
| `premium4` | 55 | 4 | 104, 203, 204, 303 |
| `deluxe4` | 60 | 4 | 106, 206, 306 |
| `famdeluxe` | 65 | 3 | 205 |
| `famlux201` | 75 | 4 | 201 |
| `famlux301` | 75 | 3 | 301 |

Seed narxlari faqat ishlab chiqish uchun. Serverda haqiqiy narxni admin
belgilaydi (Shaxmatka → Narxlar).

`Room.id` = xona raqami (`"101"`). Qavat ID: `F1`, `F2`, `F3`.

Manba: `prisma/seed.ts`.

---

## 4. Overbooking himoyasi — uch qatlam

Loyihaning eng muhim qoidasi. Uch mustaqil to'siq:

**1-qatlam — PostgreSQL constraint** (`reservation_no_overlap`):

```sql
EXCLUDE USING gist (
  "roomId" WITH =,
  daterange("checkIn", "checkOut", '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'))
```

Bu oxirgi himoya. Hech qanday kod yo'li uni chetlab o'tolmaydi.
Migratsiya: `20260912114500_overbooking_guard`.

**2-qatlam — `isRoomFree()`** tekshiruvi tranzaksiya ichida.
Tushunarli xato berish uchun (409 `ROOM_UNAVAILABLE`).

**3-qatlam — `Availability` keshi** saytda va admin paneldagi
"Mavjudlik" jadvalida (`GET /api/rooms/availability`) bo'sh xona sonini
ko'rsatadi. Formula sayt xona tanlashi bilan bir xil: faol va ta'mirda
bo'lmagan xonalar − bron − yopiq kunlar.

### Serializable tranzaksiya + qayta urinish

`serializableTx()` (`lib/tx.ts`) — 5 urinish, exponential
backoff. Muhim farq:

| Xato | Nima qilinadi |
|---|---|
| `40001` / `P2034` serializatsiya konflikti | **qayta urinish** |
| `23P01` overbooking constraint | **darhol rad etish** |

Ikkinchisiga hech qachon qayta urinilmaydi — u haqiqiy band xona.

### Underbooking himoyasi (teskari tomoni)

`pickRoom()` tranzaksiyadan tashqarida ishlaydi va parallel
so'rovlarga bir xil xonani berardi. `createPublicBooking` endi
band chiqqan xonani `skip` ro'yxatiga qo'shib navbatdagisini
tanlaydi (10 urinishgacha).

Tasdiqlangan: 2 bo'sh xonaga 6 parallel so'rov → **2 bron o'tadi**,
4 tasi 409 oladi.

---

## 5. Bron oqimi

### Manbalar

| Manba | Endpoint | Auth | Ovqat |
|---|---|---|---|
| Sayt | `POST /api/public/reservations` | yo'q | **har doim bor** |
| Qabulxona / admin | `POST /api/reservations` | JWT | xodim tanlaydi |

OTA (Booking.com, Ostrovok, Airbnb...) broni ham qabulxona orqali
kiritiladi — `source` tanlanadi, OTA komissiyasi (`OTA_COMMISSION_PERCENT`)
xarajatlarga avtomatik yoziladi.

### Bron summasi — yagona formula

[lib/money.ts](zakas042/backend/src/lib/money.ts) (`reservationMoney`).
Bron kartasi, to'lov chegarasi, sayt, "bronimni tekshirish", Telegram
bot, hisobot va OTA komissiyasi shu funksiyadan foydalanadi:

```
jami   = xona (kechalik narx × kecha, sentgacha)
       + nonushta (bronga ko'chirilgan narx × kishi × kecha, withMeal bo'lsa)
       + qo'shimcha xizmatlar
bekor qilingan / kelmagan: jami = jarima
qarz   = max(jami − to'langan, 0);  qaytarish = max(to'langan − jami, 0)
```

Hammasi sentda qo'shiladi (float xatosiz). Sayt narxi — oraliqdagi har
kecha o'z tarifi bilan (`stayPriceFromRates`); qabulxonadagi "tarifdan
past" tekshiruvi ham butun oraliq jami bilan solishtiradi.

### Sayt oqimi

```
Mehmon qidiradi → GET /api/public/availability
      ↓  (narx + nonushta bir summada ko'rsatiladi)
POST /api/public/reservations
      ↓  pickRoom() — eng mos bo'sh xona tanlanadi
createReservation() — Serializable tranzaksiya
      ↓  EXCLUDE constraint tekshiradi
PostgreSQL ← bron yoziladi (PENDING_PAYMENT)
      ↓
WebSocket → Shaxmatka darhol ko'radi
      ↓
Availability keshi qayta hisoblanadi → sayt yangi sonni ko'radi
```

To'lanmagan sayt broni `PENDING_PAYMENT_TIMEOUT_HOURS` (24) dan keyin
avtomatik bekor qilinadi (faqat `WEBSITE` manbali bron).

**Qoida:** saytdan kelgan bron **har doim ovqat bilan**
(`withMeal: true`). Qidiruv va bron bir xil summa qaytarishi
shart — aks holda mehmon boshqa narx ko'radi.

### Bron kodi

`IMR-XXXXX` — `crypto.randomInt` bilan, ketma-ket emas.
Chalkashadigan belgilar (0/O, 1/I) alifbodan chiqarilgan.
Mehmon `GET /api/public/reservations/:code` bilan ko'radi.

---

## 6. Statuslar

### Bron statuslari va o'tishlar

```
PENDING_PAYMENT → CONFIRMED | CANCELLED | NO_SHOW
CONFIRMED       → CHECKED_IN | CANCELLED | NO_SHOW
CHECKED_IN      → CHECKED_OUT
CHECKED_OUT     → (oxirgi)
CANCELLED       → (oxirgi)
NO_SHOW         → (oxirgi)
```

Boshqa har qanday o'tish rad etiladi (`ALLOWED_TRANSITIONS`,
`services/reservations.ts`). Masalan `CHECKED_OUT` bronni bekor
qilib bo'lmaydi.

### Xona statuslari

`AVAILABLE`, `RESERVED`, `OCCUPIED`, `DIRTY`, `OUT_OF_ORDER`,
`OUT_OF_SERVICE`.

`Room.status` — xonaning **joriy jismoniy holati**. Yagona qoida —
`services/roomStatus.ts` (`recalcRoomStatus`), ustuvorlik:

1. `CHECKED_IN` bron bor → `OCCUPIED` (chiqish bosilmaguncha)
2. `OCCUPIED` yoki `DIRTY` edi, mehmon yo'q → `DIRTY` (faqat tozalash
   tasdig'i yoki menejer ochadi)
3. Bugunni qamragan `CONFIRMED`/`PENDING_PAYMENT` → `RESERVED`
4. Aks holda `AVAILABLE`

`OUT_OF_ORDER` / `OUT_OF_SERVICE` qo'lda qo'yiladi va qayta hisoblanmaydi.
3–4 "bugun"ga bog'liq, shuning uchun `room_status` davriy vazifasi har
soat :01 da hamma xonani qayta hisoblaydi (kun almashganda).

---

## 7. Biznes qoidalari (kodda majburlanadi)

| Qoida | Xatti-harakat | Joyi |
|---|---|---|
| To'lov qarzdan oshmaydi | 400 xato, qarz va kiritilgan summa ko'rsatiladi | `addPayment()` |
| Qaytarish to'langandan oshmaydi | Balans manfiyga tushmaydi | `addPayment()` |
| Status o'tishlari | Faqat ruxsat etilgan yo'nalish | `ALLOWED_TRANSITIONS` |
| Tarifdan past narx | Chegirma sababi talab qilinadi (`priceReason`) | `assertPriceOk()` |
| Pul chegaralari (so'm) | kecha 50 mln, to'lov 500 mln, nonushta 10 mln, maosh va xarajat 1 mlrd; tiyingacha | `lib/moneySchema.ts` |
| Bekor qilish jarimasi | Standart 0 (egasi qarori Q16); `CANCEL_FEE_NIGHTS` bilan yoqiladi | `cancellationFeeFor()` |
| Nonushta keyin yoqilsa | Joriy narx bronga ko'chiriladi | `updateReservation()` |
| Check-in | Faqat kirish kuni (kelajakdagi bron emas), oldingi mehmon chiqmaguncha yo'q, ta'mirdagi xonaga yo'q | `checkIn()` |
| Kelmadi | Kirish kuni kelmaguncha belgilanmaydi | `markNoShow()` |
| Parallel to'lov | Bron qatori `FOR UPDATE` bilan qulflanadi — ikki kassir qarzdan oshirib yozolmaydi | `addPayment()`, `reversePayment()` |
| Bekor qilingan bron | Qo'shimcha xizmat qo'shib bo'lmaydi | `addCharge()` |
| Mehmon ismi | Bir xil telefonda ism yangilanadi | `findOrCreateGuest()` |
| Telefon majburiy | Telefonsiz bron har safar yangi mehmon yozuvi yaratardi | `phoneSchema` |
| O'tmish bronlari | 30 kungacha ruxsat, undan oldin rad | `createReservation()` |
| Iflos xona | Tozalanmaguncha check-in yo'q | `checkIn()` |
| To'lov egasi | Kim qabul qilgani yoziladi (`Payment.userId`) | `addPayment()` |
| Bir yildan uzoq bron | Rad etiladi | `validateRange()` |
| Spam himoyasi | Bir telefonga 24 soatda 3 ta to'lanmagan bron | `checkSpam()` |

### Sozlanadigan qiymatlar (`BUSINESS_DEFAULTS`)

| Sozlama | Standart |
|---|---|
| Nonushta narxi | 25 000 so'm / kishi / kecha — admin panel → Oshxona |
| Bepul bekor qilish | 24 soat |
| Bekor qilish jarimasi | 0 kecha (o'chiq) |
| OTA komissiyasi | 15% |
| Audit jurnali saqlash | 365 kun |
| Tozalash me'yori | 30 daqiqa |
| Kechikish eslatmasi | 30 daqiqa |
| Chiqish soati | 12:00 (Toshkent) |

Bazadagi `Settings` jadvalidan o'zgartiriladi.

**Nonushta narxi** admin panel → Oshxona → "Nonushta narxi"
(`PUT /api/admin/meal-price`, `settings.write`). Sayt va yangi bronlar
darhol yangi narxda. "Faol bronlarga ham qo'llash" belgilansa to'lov
kutilayotgan, tasdiqlangan va xonadagi mehmonlarning summasi ham qayta
hisoblanadi (Shaxmatka WebSocket orqali yangilanadi). Chiqib ketgan va
bekor qilingan bronlar tarix — o'zgarmaydi.

---

## 8. Ruxsatlar (RBAC)

To'rt rol. Matritsa `services/auth.ts` da, backend har so'rovda
tekshiradi.

| Huquq | FOUNDER | ADMIN | MANAGER | STAFF |
|---|:---:|:---:|:---:|:---:|
| `report.read` (umumiy hisobot) | ✓ | | | |
| `user.manage` | ✓ | | | |
| `employee.read` / `employee.write` | ✓ | ✓ | | |
| `settings.write` (sozlamalar, STOP, tozalash, navbat) | ✓ | ✓ | | |
| `reservation.write` / `.cancel` | ✓ | ✓ | ✓ | |
| `rate.write` | ✓ | ✓ | ✓ | |
| `room.block` (yopish, iflos xonani qo'lda ochish) | ✓ | ✓ | ✓ | |
| `audit.read` (audit jurnali) | ✓ | ✓ | ✓ | |
| `checkin.write` | ✓ | ✓ | ✓ | ✓ |
| `payment.write` | ✓ | ✓ | ✓ | ✓ |
| `reservation.read` | ✓ | ✓ | ✓ | ✓ |

**Muhim:** moliya va foydalanuvchi boshqaruvi faqat FOUNDER'da.
ADMIN texnik ishlarni qiladi, biznes raqamlarini ko'rmaydi.

Frontend `display:none` qiladi, lekin bu faqat ko'rinish —
haqiqiy himoya backendda.

### Autentifikatsiya

JWT (HS256), 12 soat. `POST /api/auth/login` → token → `Authorization:
Bearer`. Parollar bcrypt (cost 10). Shaxmatka va admin panel
**bir xil tokenni** ishlatadi.

Har so'rovda foydalanuvchi bazadan tekshiriladi (10 soniyalik kesh):
o'chirilgan hisob darhol chiqariladi, rol o'zgarishi darhol kuchga
kiradi, parol almashgandan oldin berilgan token bekor
(`passwordChangedAt`). WebSocket ulanishi ham shu tekshiruvdan o'tadi.

Parol: o'zi — `POST /api/auth/password` (joriy parol shart, yangi token
qaytadi; admin panel → avatar); egasi boshqaniki — `PATCH
/api/auth/users/:id` (`password`). Ikkalasi audit jurnaliga yoziladi.

`AUTH_REQUIRED` standart — `true`. `false` (faqat dev) bo'lganda
tekshiruvlar o'chiriladi. Production'da `assertProductionSafe()` bunday
ishga tushirishni bloklaydi.

---

## 9. Tashqi kanallar (OTA)

Tashqi channel manager yo'q (Beds24 2026-09-26 da olib tashlangan —
[BEDS24.md](BEDS24.md)). Booking.com va boshqa OTA bronlari:

- qabulxona Shaxmatka/admin panelda bron yaratadi, manbani tanlaydi;
- OTA komissiyasi (`OTA_COMMISSION_PERCENT`, standart 15%) davr bo'yicha
  xarajatlarga avtomatik yoziladi (`recalcCommissions`, advisory lock);
- OTA'dagi sotuvni (bo'sh joy, STOP) OTA kabinetida boshqarish kerak —
  PMS'dagi STOP va xona yopish faqat sayt va qabulxonaga ta'sir qiladi.

---

## 10. Tozalash tizimi

### Oqim

```
Mehmon chiqdi (check-out) yoki admin panelda "+ Yangi so'rov"
      ↓
CleaningTask (NEW) yaratiladi
      ↓
Telegram GURUHIGA xabar + [🙋 Men olaman]
      ↓
Farosh bosdi → IN_PROGRESS, kim olgani yoziladi
      ↓
[🧹 Tozaladim] → PENDING   ← xona HALI SOTILMAYDI
      ↓
Admin panel → Tozalik → [✓ Tasdiqlash]
      ↓
DONE → xona DIRTY bo'lsa AVAILABLE ga o'tadi
```

### Qoidalar

| Qoida | Sabab |
|---|---|
| Topshiriq hech kimga biriktirilmaydi | Guruhda kim bo'sh bo'lsa oladi |
| Birinchi bosgan oladi | `updateMany` + `status: NEW` — bitta SQL amali |
| Faqat olgan odam tugata oladi | Hisobot to'g'ri bo'lsin |
| Admin tasdiqlashi shart | Tozalash sifati tekshirilsin |
| Vaqt cheklovi yo'q (24 soat) | Mehmonxona kechayu kunduz ishlaydi |
| Bir xona = bir ochiq topshiriq | Takroriy xabar bo'lmasin |

Kim bosgani Telegram ismi bilan yoziladi (`claimedByName`) —
`Employee` yozuvi shart emas.

### Uch alohida bot

| Bot | Auditoriya | Ko'radi |
|---|---|---|
| `bot/index.ts` | Egasi, menejer | Moliya, bronlar, dashboard |
| `bot/cleaning-bot.ts` | Farroshlar guruhi | Faqat tozalash topshiriqlari |
| `bot/kitchen-bot.ts` | Oshpazlar / Oshxona | Nonushta porsiyalari, xonalar ro'yxati |

**Nega alohida:** farosh mehmonxona moliyasini ko'rmasligi, oshpaz esa faqat oshxona porsiyalarini ko'rishi kerak. Bitta token sizib ketsa ham boshqa auditoriyalar himoyalangan qoladi.

Bot ishga tushmasa (token bo'sh) jim o'chadi — backend ishlayveradi.

---

## 11. Oshxona

`services/kitchen.ts` bugun va ertaga nechta porsiya kerakligini
hisoblaydi.

Kim hisoblanadi: `CHECKED_IN` (hozir xonada) + `CONFIRMED`
(bugun keladigan), faqat `withMeal = true`.

Kattalar va bolalar alohida ko'rsatiladi. Admin panel → Oshxona
bo'limida jonli ko'rinadi.

---

## 12. Real-time (WebSocket)

`ws://<host>/ws` — HTTP server ustiga o'rnatilgan, alohida port
kerak emas.

Hodisalar: bron yaratildi/o'zgardi/bekor qilindi, xona holati,
availability o'zgardi, tozalash topshirig'i.

Redis Pub/Sub orqali — bir necha server nusxasi bo'lsa ham
hamma mijozga yetadi.

---

## 13. Navbatlar (BullMQ)

Bitta navbat — `pms-maintenance` (davriy vazifalar, concurrency 1).
Jadval Toshkent vaqtida (`tz: Asia/Tashkent`), `upsertJobScheduler` —
restartda dublikat bo'lmaydi. Eski Beds24 jadvallari ishga tushishda
Redis'dan o'chiriladi (`OBSOLETE_SCHEDULERS`).

### Davriy vazifalar

| Vazifa | Davr |
|---|---|
| To'lanmagan sayt bronlarini bekor qilish | har soat boshida |
| STOP ufqini surish | 15 daqiqa |
| Tozalash tekshiruvi (yuborish, eslatma, chiqish kuni) | 10 daqiqa |
| Xona holatini qayta hisoblash (`room_status`) | har soat :01 |
| Audit jurnalini tozalash | yakshanba 03:30 |
| Oshxona hisoboti (bugun / ertaga) | 07:30, 20:00 |

**Qoida:** Redis o'chsa PMS ishlashda davom etadi, davriy vazifalar
Redis qaytgach davom etadi. `/health` "degraded" qaytaradi, "down" emas.

---

## 14. Xavfsizlik

| Himoya | Qanday |
|---|---|
| Parollar | bcrypt (cost 10) |
| Token | JWT HS256, 12 soat; har so'rovda foydalanuvchi bazadan tekshiriladi |
| Parol almashishi | Eski token'lar bekor (`passwordChangedAt`) |
| Admin endpoint'lari | Hammasi `requireAuth` + huquq |
| HTTP sarlavhalar | `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin` |
| Tarmoq | Backend `127.0.0.1:3100` (nginx orqali), Postgres va Redis loopback'da |
| CORS | Faqat `CORS_ORIGINS` ro'yxatidagi domenlar |
| Rate limit | IP bo'yicha (`express-rate-limit`) |
| XSS | Admin panelda `esc()`, Shaxmatka React (JSX o'zi escape qiladi) |
| SQL injection | Prisma + Zod validatsiya |
| Bot spam | Honeypot maydoni saytdagi formada |
| Loglar | `sanitizeForLog()` token/parol/karta raqamini `[REDACTED]` qiladi |
| Audit | `AuditLog` — kim, nima, qachon, qaysi IP |

### Production tekshiruvi

`assertProductionSafe()` (`lib/config.ts`) xavfsiz bo'lmagan sozlama
bilan serverni **ishga tushirmaydi**:

- har muhitda: `AUTH_REQUIRED` yoqilgan, lekin `JWT_SECRET` yo'q
- `NODE_ENV=production` da: `AUTH_REQUIRED=false`,
  `RATE_LIMIT_DISABLED=true`, `JWT_SECRET` 32 belgidan qisqa

Serverda `NODE_ENV=production` (2026-09-26 dan, systemd drop-in).

---

## 15. API kontrakti

~80 endpoint. Asosiy guruhlar:

| Prefiks | Auth | Nima |
|---|---|---|
| `/api/public/*` | yo'q | Sayt: tarif ro'yxati, qidiruv, bron, bron holati |
| `/api/auth/*` | qisman | Login, `/me`, parol, foydalanuvchilar |
| `/api/rooms/*` | JWT | Xonalar, turlar, bo'sh xonalar, mavjudlik jadvali, yopish |
| `/api/reservations/*` | JWT | Bron CRUD, status, to'lov |
| `/api/rate-plans` | JWT | Narxlar |
| `/api/admin/*` | JWT + huquq | Sozlama, STOP, tozalik, oshxona, xodim, xarajat, hisobot, audit, bot ruxsatlari |

### Xato javoblari

Barcha xatolar bir xil shaklda:

```json
{ "error": "O'zbekcha tushunarli xabar", "code": "VALIDATION" }
```

Kodlar: `VALIDATION` (400), `UNAUTHORIZED` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404), `ROOM_UNAVAILABLE` (409),
`CONCURRENT_CONFLICT` (409), `DUPLICATE_RESERVATION` (409),
`BAD_JSON` (400), `INTERNAL` (500).

---

## 16. Muhit

### Portlar

| Xizmat | Server | Tunnel orqali |
|---|---|---|
| Backend | 3100 | `localhost:3100` |
| PostgreSQL | 5433 | `localhost:5433` |
| Redis | 6380 | `localhost:6380` |

Server portlari `127.0.0.1` ga bog'langan — internetdan kirib
bo'lmaydi. SSH tunnel yagona yo'l: `bash tools/tunnel.sh`.

### Muhim tuzoqlar

**`localhost` IPv6 ga hal bo'ladi.** Node 18+ da `localhost`
avval `::1` ga hal bo'ladi, SSH tunnel esa IPv4'da tinglaydi.
Test va skriptlarda **`127.0.0.1`** yozish shart.

**Testlar bazani tozalaydi.** `vitest.setup.ts` har test
faylidan oldin `prisma/seed.ts` chaqiradi — barcha bronlar va
narxlar o'chadi. Himoya: baza nomida "test" bo'lmasa testlar ishga
tushmaydi, seed esa bronli "test"siz bazani tozalamaydi. Testlar
faqat alohida bazada (`zakas042/README.md`, "Testlar").

**Bot bir vaqtda bitta joyda.** Mahalliy va server birga ishga
tushsa Telegram `409 Conflict` beradi.

**PostgreSQL 5433.** Mahalliy PostgreSQL 16 xizmati 5432 ni
egallagan; Docker konteyneri 5433 ga chiqariladi.

### Buyruqlar

```bash
npm run dev            # ishlab chiqish (tsx watch)
npm run build          # TypeScript → dist/
npm start              # dist/server.js
npm test               # vitest
npm run db:migrate     # migratsiya
npm run db:seed        # baza to'ldirish (faqat test/bo'sh bazada)
npm run build:css      # Shaxmatka Tailwind CSS
```

---

## 17. Noaniq joylar

Kod bilan tasdiqlab bo'lmagan yoki qarama-qarshi ma'lumotlar:

**Narxlar taxminiy.** `seed.ts` dagi 9 tarif narxi hujjatlarda
"sig'im va tarif darajasiga qarab qo'yilgan" deb belgilangan.
Egasi 2026-09-25 da aytdi: narxni admin qo'yadi.

**Valyuta — faqat so'm** (2026-09-26, Beds24 bilan birga dollar ham
olib tashlandi).

**Sig'im.** Sayt qidiruvi va bron `maxAdults` bo'yicha tekshiradi;
bolalar sig'imga qanday kirishi aniq belgilanmagan.

**Minimal kecha (`minStay`).** `RatePlan.minStay` saqlanadi, lekin
sayt va qabulxona bronida tekshirilmaydi.

**Bolalar porsiyasi.** Nonushta narxi bola va kattalar uchun
bir xil. Bola uchun arzonroq bo'lishi kerakmi — hal qilinmagan.

**Qaytim (sdacha).** Mehmon ortiqcha bersa, kassir faqat qarz summasini
yozadi, qaytim qo'lda beriladi — tizim buni ko'rmaydi.
