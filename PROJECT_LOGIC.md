# Imron Hotel PMS — loyiha logikasi

**Bu hujjat loyihaning amaldagi logikasining yagona referensi.**

Har bir fakt kod, `schema.prisma` yoki jonli tizimda tasdiqlangan
(oxirgi tekshiruv 2026-09-28). Tasdiqlanmagan narsalar "noaniq" deb
belgilangan (17-bo'lim). Kod o'zgarsa bu hujjat shu commit'da yangilanadi.

**Beds24 — ikki tomonlama integratsiya** (2026-09-27, egasi qarori
Q19: 2026-09-26 da olib tashlangan integratsiya avvalgidek qaytdi, STOP
olib tashlandi). Qoidalar, valyuta, ruxsatlar va ulash:
[BEDS24.md](BEDS24.md).

Qolgan ishlar: [ISH_REJASI.md](ISH_REJASI.md)

---

## 1. Loyiha nima qiladi

Mehmonxona boshqaruv tizimi (PMS). Bir vaqtda to'rtta ish:

1. **Sayt** — mehmon xona qidiradi va bron qiladi
2. **Shaxmatka** — xodim bandlik jadvalini ko'radi va boshqaradi
3. **Admin panel** — bron, narx, mavjudlik, tozalik, moliya, hisobot, Channel manager (Beds24)
4. **Telegram botlar** — egasi, tozalik guruhi, oshxona

Asosiy talab: **overbooking bo'lmasligi shart**. Bir xonaga
kesishuvchi ikki bron hech qanday yo'l bilan tushmasligi kerak.

**Beds24 ustuvor (Q9).** Booking.com va boshqa OTA'lar Beds24 orqali
ulangan: OTA broni PMS'ga o'zi tushadi (sanasi, narxi, bekor qilinishi
OTA'da), PMS bronlari, narxlari va yopiq kunlari Beds24'ga yuboriladi.
PMS bazasi — mehmonxona ichki ishining (to'lov, kirish/chiqish, tozalik,
moliya) haqiqat manbai. OTA komissiyasi xarajatga avtomatik yoziladi.

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

Beds24 — tashqi channel manager (webhook + polling kiradi, bron/narx/
yopish chiqadi). Beds24 yoki Redis o'chsa ham bron, check-in va to'lov
ishlaydi: yuborilmagan bron `PENDING` qoladi, catch-up keyin yuboradi.

**Texnologiyalar:** Node.js 22+, Express, TypeScript, Prisma,
PostgreSQL 16 (`btree_gist` kerak), Redis 7, BullMQ, grammy
(Telegram), Zod (validatsiya), JWT.

**Joylashuv:** VPS, Docker Compose (api + PostgreSQL + Redis), tashqaridan
faqat nginx orqali HTTPS — [SERVER.md](SERVER.md). Kompyuterda faqat kod.

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

24 model, 12 enum. Asosiylari:

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
                       ├──< RoomDayStatus (yopiq kunlar: ta'mir, Beds24 `black`)
                       └──< CleaningTask
                               Reservation ──< Expense (OTA komissiyasi, CASCADE)
```

Beds24 jadvallari: `Channel`, `ChannelConnection` (token shifrlangan),
`ChannelMapping` (Beds24 tur/unit ↔ PMS tarif/xona), `ChannelBlock`
(yopish ↔ `black` bron), `SyncLog`, `SyncState`, `WebhookEvent`. Bronda:
`origin` (PMS / CHANNEL), `externalReservationId`, `externalReference`
(OTA raqami), `currency` + `exchangeRate` (bron kelgan kun kursi),
`syncStatus` (PENDING, SYNCING, SYNCED, FAILED, REJECTED, NOT_APPLICABLE)
va `syncError`. To'lovda — asl summa va valyuta (`originalAmount`,
`originalCurrency`, `exchangeRate`). `RatePlan` da `syncedAt`,
`syncError`, `channelPrice` ($), `source` (pms / beds24).
`pricePerNight` 4 xona kasr bilan saqlanadi (jami narx kechalarga
bo'linganda sent yo'qolmasin). `User.passwordChangedAt` — parol
almashgach eski token'lar bekor.

### Inventar (seed'da belgilangan)

**18 xona, 3 qavat, 9 tarif.** Tizim valyutasi — **so'm**; Beds24'dan
kelgan bron — USD (tagida so'm, bron kelgan kun kursi, Q15/Q19).
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
| Beds24 (OTA) | webhook `/api/webhooks/beds24/<token>` + polling | URL token | Beds24 tur bog'lanishidagi belgi |

OTA broni (Booking.com, Ostrovok...) Beds24 orqali o'zi keladi
(`origin = CHANNEL`). Qabulxona qo'lda kiritsa ham dublikat bo'lmaydi —
import uni OTA raqami yoki sanalar bo'yicha bog'laydi. OTA komissiyasi
(`OTA_COMMISSION_PERCENT`) xarajatlarga avtomatik yoziladi.

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

Hammasi sentda qo'shiladi (float xatosiz). Summalar bron valyutasida;
so'mga `toBase` (bron kursi) bilan, to'lov — `paymentBase` (asl so'm
bo'lsa o'sha) bilan o'giriladi. Sayt narxi — oraliqdagi har
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

**To'lov (Q20, 2026-09-28):** sayt mehmoni to'lovni **kelganda** qiladi —
sayt ham shuni aytadi. Bron `PENDING_PAYMENT` bo'lib turadi, qabulxona
mehmon bilan bog'lanib tasdiqlaydi yoki kelganda to'lov oladi. Avtomatik
bekor qilish standart **o'chiq**: muddat biznes sozlamasi
`WEBSITE_UNPAID_CANCEL_HOURS` (admin panel → Sozlamalar); 0 dan katta
bo'lsa shuncha soatda tasdiqlanmagan sayt broni bekor bo'ladi (faqat
`WEBSITE` manbali, mehmonga xabar bormaydi). Oldindan to'lov — Beds24
(OTA) mehmonlari, uni OTA boshqaradi.

**Qoida:** saytdan kelgan bron **har doim ovqat bilan**
(`withMeal: true`). Qidiruv va bron bir xil summa qaytarishi
shart — aks holda mehmon boshqa narx ko'radi. API `withMeal: false`
ni rad etadi (400), jimgina e'tiborsiz qoldirmaydi.

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
| Bekor qilingan bron | Qo'shimcha xizmat qo'shib bo'lmaydi (bron qatori qulf ostida tekshiriladi) | `addCharge()` |
| Xona / sana o'zgartirish | Audit jurnaliga eski va yangi qiymat bilan; o'zgarmagan sana rad etiladi | `changeRoom()`, `changeDates()` |
| Mehmon ismi | Bir xil telefonda ism yangilanadi | `findOrCreateGuest()` |
| Telefon majburiy | Telefonsiz bron har safar yangi mehmon yozuvi yaratardi | `phoneSchema` |
| O'tmish bronlari | 30 kungacha ruxsat, undan oldin rad | `createReservation()` |
| Iflos xona | Tozalanmaguncha check-in yo'q | `checkIn()` |
| To'lov egasi | Kim qabul qilgani yoziladi (`Payment.userId`) | `addPayment()` |
| Bir yildan uzoq bron | Rad etiladi | `validateRange()` |
| Spam himoyasi | Bir telefonga 3 ta faol (tugamagan) to'lanmagan sayt broni, vaqt oynasisiz; raqam raqamlari bo'yicha (oxirgi 9 ta) solishtiriladi. Bir IP'dan soatiga 5 ta bron | `checkSpam()`, `publicWriteLimiter` |

### Sozlanadigan qiymatlar (`BUSINESS_DEFAULTS`)

| Sozlama | Standart |
|---|---|
| Nonushta narxi | 25 000 so'm / kishi / kecha — admin panel → Oshxona |
| Bepul bekor qilish | 24 soat |
| Bekor qilish jarimasi | 0 kecha (o'chiq, Q16) |
| To'lanmagan sayt bronini bekor qilish | 0 soat (o'chiq, Q20) |
| OTA komissiyasi | 15% |
| Audit jurnali saqlash | 365 kun |
| Chiqishda tozalash topshirig'i | yoqilgan |
| Tozalash me'yori | 30 daqiqa |
| Kechikish eslatmasi | 30 daqiqa |
| Chiqish soati | 12:00 (Toshkent) |

Bazadagi `Settings` jadvalida; admin panel → **Sozlamalar** (egasi, admin;
`GET/PUT /api/admin/business-settings`). Har o'zgarish audit jurnaliga
eski va yangi qiymat bilan yoziladi. Nonushta narxi — Oshxona bo'limida
(faol bronlar summasini ham qayta hisoblaydi).

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
| `settings.write` (sozlamalar, tozalash, navbat) | ✓ | ✓ | | |
| `reservation.write` / `.cancel` | ✓ | ✓ | ✓ | |
| `rate.write` | ✓ | ✓ | ✓ | |
| `room.block` (xona va qavat yopish, iflos xonani qo'lda ochish) | ✓ | ✓ | ✓ | |
| `audit.read` (Audit jurnali, Tizim holati) | ✓ | ✓ | ✓ | |
| `checkin.write` | ✓ | ✓ | ✓ | ✓ |
| `payment.write` (to'lov qabul qilish) | ✓ | ✓ | ✓ | ✓ |
| `payment.refund` (qaytarish, manfiy to'lov) | ✓ | ✓ | ✓ | |
| `reservation.read` | ✓ | ✓ | ✓ | ✓ |
| `channel.write` (Beds24 ulash, bog'lash, qo'lda amallar, kurs, bronni qayta yuborish) | ✓ | ✓ | | |
| `channel.read` (Channel manager: holat, jurnal, bronlar) | ✓ | ✓ | ✓ | |

Dollar bron summasi (`$` va so'm) — bron ichida, `reservation.read`
bilan hamma xodimga (Q19).

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

## 9. Tashqi kanallar — Beds24

Batafsil: [BEDS24.md](BEDS24.md). Qisqasi:

| Yo'nalish | Nima | Qanday |
|---|---|---|
| Beds24 → PMS | bronlar (OTA, Beds24 paneli) | webhook (darhol) + polling (`POLL_INTERVAL_MINUTES`, 5) |
| Beds24 → PMS | `black` — xona yopilishi | PMS'da yopiladi, PMS ocholmaydi |
| Beds24 → PMS | narx (tur darajasida bog'langan tarif) | soatlik; yuborilmagan PMS narxi ustiga yozilmaydi |
| PMS → Beds24 | qabulxona/sayt broni, o'zgarishi, kirish/chiqish belgisi | `beds24-reservation-sync`, `checkAvailability` |
| PMS → Beds24 | xona yopish/ochish | `black` bron (`beds24-availability-sync`) |
| PMS → Beds24 | tarif narxi | so'm / bugungi kurs = $ (`beds24-rate-sync`) |

- **OTA qulfi (Q9):** OTA bronining sanasi, narxi, mehmon soni, bekor
  qilinishi, boshqa turga ko'chirilishi — `409 CHANNEL_OWNED`
  (`lib/channelOwnership.ts`). Kirish/chiqish, to'lov, izoh, shu turdagi
  xonaga ko'chirish — ruxsat.
- **Rad etilgan bron** (Beds24'da joy yo'q) — `REJECTED`, avtomatik
  qayta yuborilmaydi; egasiga Telegram. Bog'lanmagan xona —
  `NOT_APPLICABLE` (xato emas).
- **Bo'sh joy soni** PMS'dan yozilmaydi — Beds24 bronlar va `black` dan
  hisoblaydi. Farq har kuni 04:00 da tekshiriladi va faqat qayd etiladi.
- **Kurs:** Markaziy bank (3 soat) yoki qo'lda; Beds24 bronida kelgan
  kundagi kurs qotadi, so'mdagi to'lov shu kurs bilan o'giriladi.
- **Channel manager:** admin panel (egasi, admin — boshqaradi; menejer —
  ko'radi), `/admin/connection.html`, `/admin/mapping.html`,
  `/admin/sync-log.html`. Shaxmatka bron oynasida Beds24 holati va
  "Qayta yuborish".

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
`Employee` yozuvi shart emas. Xodimga Telegram ID bog'langan bo'lsa
(admin panel → Ishchilar, farrosh botga `/id` yozib biladi) topshiriq
xodim yozuviga ham yoziladi — hisobotda xodimning ismi chiqadi.

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

**Qoida (Q20):** nonushta tunashdan keyingi ertalab. D kuni nonushta —
D dan oldingi kechani mehmonxonada o'tkazganlarga: `checkIn < D <= checkOut`.
Kelgan kuni nonushta yo'q, ketadigan kuni bor. Nonushtalar soni kecha
soniga teng — bron summasi (narx × kishi × kecha) bilan mos.

Kim sanaladi (`withMeal = true`): xonada (`CHECKED_IN`); kirishi hali
belgilanmagan (`CONFIRMED`, `PENDING_PAYMENT` — ertangi hisobotda bugun
keladiganlar); shu kuni chiqib ketgan (`CHECKED_OUT`, chiqish vaqti D
kuni). Muddatidan oldin ketgan mehmon keyingi kunlarga sanalmaydi.

Holatlar: xonada, shu kuni ketadi, kirish belgilanmagan. Kattalar va
bolalar alohida. Admin panel → Oshxona bo'limida jonli; oshxona botiga
07:30 (bugun) va 20:00 (ertaga) o'zi ketadi, panelda qo'lda yuborish
tugmasi ham bor.

---

## 12. Real-time (WebSocket)

`ws://<host>/ws` — HTTP server ustiga o'rnatilgan, alohida port
kerak emas.

Hodisalar: bron yaratildi/o'zgardi/bekor qilindi, xona holati,
availability o'zgardi, tozalash topshirig'i. Beds24 ogohlantirishlari
(`sync.failed`, `webhook.needs_attention`, `rate.sync.updated`) — admin
panelning Channel manager bo'limiga.

Redis Pub/Sub orqali — bir necha server nusxasi bo'lsa ham
hamma mijozga yetadi.

---

## 13. Navbatlar (BullMQ)

Beds24 navbatlari (TZ 11-band): `beds24-reservation-sync`,
`beds24-availability-sync`, `beds24-rate-sync`, `beds24-webhook`,
`beds24-retry` (yiqilgan vazifalar) — [BEDS24.md](BEDS24.md) 5-bo'lim.
Davriy vazifalar — `pms-maintenance` (concurrency 1). Jadval Toshkent
vaqtida (`tz: Asia/Tashkent`), `upsertJobScheduler` — restartda dublikat
bo'lmaydi. Olib tashlangan jadvallar (STOP, kuzatuv) ishga tushishda
Redis'dan o'chiriladi (`OBSOLETE_SCHEDULERS`).

### Davriy vazifalar

| Vazifa | Davr |
|---|---|
| To'lanmagan sayt bronlarini bekor qilish (Sozlamalar'da muddat 0 dan katta bo'lsa) | har soat boshida |
| Beds24 polling | `POLL_INTERVAL_MINUTES` (5; 0 — Beds24 jadvallari o'chiq) |
| Beds24 catch-up | `CATCH_UP_INTERVAL_MINUTES` (15) |
| Beds24 narxini tortish | har soat |
| Beds24 bo'sh joy farqi (faqat qayd) | 04:00 |
| Dollar kursi (Markaziy bank) | 3 soat |
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
| Tarmoq | API konteyneri faqat `127.0.0.1:<API_PORT>` da (nginx orqali), Postgres va Redis faqat Docker ichki tarmog'ida |
| CORS | Faqat `CORS_ORIGINS` ro'yxatidagi domenlar |
| Rate limit | IP bo'yicha (`express-rate-limit`) |
| XSS | Admin panelda `esc()`, Shaxmatka React (JSX o'zi escape qiladi) |
| SQL injection | Prisma + Zod validatsiya |
| Bot spam | Honeypot maydoni saytdagi formada |
| Loglar | `sanitizeForLog()` token/parol/karta raqamini `[REDACTED]` qiladi |
| Audit | `AuditLog` — kim, nima, qachon, qaysi IP |
| Tozalash rasmlari | `/uploads` login'siz ochilmaydi: API imzoli havola beradi (12 soat) yoki Bearer token (`lib/uploadAccess.ts`) |

### Production tekshiruvi

`assertProductionSafe()` (`lib/config.ts`) xavfsiz bo'lmagan sozlama
bilan serverni **ishga tushirmaydi**:

- har muhitda: `AUTH_REQUIRED` yoqilgan, lekin `JWT_SECRET` yo'q
- `NODE_ENV=production` da: `AUTH_REQUIRED=false`,
  `RATE_LIMIT_DISABLED=true`, `JWT_SECRET` 32 belgidan qisqa

Serverda `NODE_ENV=production` — `docker-compose.yml` majburan qo'yadi.

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
| `/api/admin/*` | JWT + huquq | Sozlama, tozalik, oshxona, xodim, xarajat, hisobot, audit, bot ruxsatlari, Channel manager (ulanish, mapping, jurnal, kurs) |
| `/api/webhooks/beds24/<token>` | URL token | Beds24 webhook (token noto'g'ri — 404) |

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

**Server:** API `127.0.0.1:<API_PORT>` (serverdagi registrdan, `.env`),
tashqaridan faqat nginx (HTTPS). PostgreSQL va Redis konteyner ichida,
hostga ham chiqmaydi. Brauzerda to'g'ridan-to'g'ri: `bash tools/tunnel.sh`
→ `http://localhost:3100`. Batafsil: [SERVER.md](SERVER.md).

**Lokal va testlar:** [README.md](README.md).

### Muhim tuzoqlar

**`localhost` IPv6 ga hal bo'ladi.** Node 18+ da `localhost` avval `::1`
ga hal bo'ladi. Test va skriptlarda **`127.0.0.1`** yozish shart.

**Testlar bazani tozalaydi.** `vitest.setup.ts` har test faylidan oldin
`prisma/seed.ts` chaqiradi — barcha bronlar va narxlar o'chadi. Himoya:
baza nomida "test" bo'lmasa testlar ishga tushmaydi, seed esa bronli
"test"siz bazani tozalamaydi. Testlar faqat alohida bazada.

**Bot bir vaqtda bitta joyda.** Bir token bilan lokal va server birga
ishga tushsa Telegram `409 Conflict` beradi — lokal `.env` da Telegram
tokenlari bo'sh.

---

## 17. Noaniq joylar

Kod bilan tasdiqlab bo'lmagan yoki qarama-qarshi ma'lumotlar:

**Narxlar taxminiy.** `seed.ts` dagi 9 tarif narxi hujjatlarda
"sig'im va tarif darajasiga qarab qo'yilgan" deb belgilangan.
Egasi 2026-09-25 da aytdi: narxni admin qo'yadi.

**Valyuta** — so'm; Beds24 bronlari USD, bron kelgan kun kursi bilan
(Q15, Q19 — 2026-09-27 da qaytdi).

**Sig'im.** Sayt qidiruvi va bron `maxAdults` bo'yicha tekshiradi;
bolalar sig'imga qanday kirishi aniq belgilanmagan.

**Cheklovlar (`minStay`, `maxStay`, kirish/chiqish taqiqi).** `RatePlan`
da saqlanadi va Beds24 orqali OTA'larga ketadi (TZ 10-band), lekin sayt
va qabulxona bronida tekshirilmaydi.

**Bolalar porsiyasi.** Nonushta narxi bola va kattalar uchun
bir xil. Bola uchun arzonroq bo'lishi kerakmi — hal qilinmagan.

**Qaytim (sdacha).** Mehmon ortiqcha bersa, kassir faqat qarz summasini
yozadi, qaytim qo'lda beriladi — tizim buni ko'rmaydi.
