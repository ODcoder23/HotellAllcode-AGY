# Beds24 integratsiyasi — OLIB TASHLANGAN (arxiv) + egasi uchun KUZATUV

## 0. 2026-09-27: Channel manager egasi uchun qaytdi — faqat kuzatuv

Egasi qarori: integratsiya (avtomatik import, PMS → Beds24 yozish,
"Beds24 ustuvor" qoidasi, `CHANNEL_OWNED` qulfi, dollar to'lovlar)
**qaytmaydi** — pastdagi 2026-09-26 holati o'z kuchida. Lekin olib
tashlangan ekranlar **faqat FOUNDER** uchun qaytdi, egasi Beds24 holatini
tekshirib, o'rganib turishi uchun:

| Qaytdi (faqat egasi) | Qanday ishlaydi |
|---|---|
| Channel manager (3-tugma): Ulangan kanallar, Sinxronizatsiya, Bronlar jurnali | Beds24'dan `GET` bilan o'qiydi, PMS bilan solishtiradi |
| "Ulanishni tekshirish", "Hoziroq tekshirish", "Farqni tekshirish", "Narx va bo'sh joyni o'qish" | faqat o'qish; natija `SyncLog` ga |
| Webhook `/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>` | jurnalga yoziladi va Beds24 bron nusxasi yangilanadi; PMS broni yaratilmaydi |
| Mapping (tur va unit), avtomatik unit bog'lash | faqat solishtirish uchun |
| Dollar kursi (Markaziy bank / qo'lda) | faqat ko'rsatish; pul so'mda qoladi |
| Hisobot → "Kanal (Beds24)" | PMS'da yo'q bronlar, farqlar |
| Narxlar: kurs, $ va Beds24 holati nuqtalari, "Beds24: tur …" | "yuborildi/kutmoqda" o'rniga "mos / farq / Beds24'da yopiq" |
| Shaxmatka: $ summa, OTA bron raqami, Beds24'dagi mos bron | "qayta yuborish" o'rniga "Beds24'dan qayta o'qish" |
| `/admin/connection.html`, `/admin/mapping.html`, `/admin/sync-log.html` | faqat egasi token'i bilan |

**Qaytmadi (qoidaga zid):** PMS → Beds24 yozish (bron, narx, bo'sh joy,
`black` yopish), Beds24 bronini PMS'ga avtomatik import, `CHANNEL_OWNED`
qulfi, $ to'lov, `SOURCE_OF_TRUTH_*`, dead-letter/qayta ishlash,
`cleaning/:id/reassign`, `db:reset`, `tools/test.sh`, bir martalik skriptlar.

**Ulash:** Beds24 → Settings → Marketplace → API → invite code (faqat
**read** ruxsatlari yetadi: bookings, inventory, properties) → admin
panel → Channel manager → Ulash. Serverda `.env` ga `ENCRYPTION_KEY`
(`openssl rand -hex 32`) qo'shilgan bo'lishi kerak. Eski token
2026-09-26 da o'chirilgan — yangi kod kerak.

**Eski jurnal (17 983 `SyncLog` yozuvi):** jadvallar eski shaklda
qaytgan; kerak bo'lsa serverdagi `*remove-beds24*.dump` zaxirasidan
`pg_restore --data-only -t SyncLog -t Channel ...` bilan tiklanadi
(avval zaxira, keyin egasining roziligi).

---

**Holat (2026-09-26):** egasi qarori bilan Beds24 integratsiyasi PMS'dan
to'liq olib tashlandi — kod, endpoint'lar, navbatlar, davriy vazifalar,
jadvallar, server sozlamalari va mock. PMS endi hech qanday tashqi
channel manager bilan gaplashmaydi; Booking.com va boshqa OTA bronlarini
qabulxona qo'lda kiritadi (manba tanlanadi, komissiya avtomatik).

Pastda: (1) integratsiya qanday ishlagani, (2) olib tashlashdan oldingi
jonli tahlil, (3) nima olib tashlandi va qanday, (4) keyin nima
tekshirildi, (5) Beds24 tomonida egasi qilishi kerak bo'lgan ishlar.
Eski batafsil hujjat o'zgartirilmagan holda oxirida — "Ilova".

---

## 1. Qanday ishlagan (qisqa)

```
Booking.com ──> Beds24 ──(GET /bookings, 15 daq polling; webhook sozlanmagan)──> PMS
                  ^
                  └──(POST /bookings, POST /inventory/rooms/calendar)──────────── PMS
```

| Yo'nalish | Nima | Qanday |
|---|---|---|
| Beds24 → PMS | Bronlar | `GET /bookings` har 15 daqiqa (`cron_poll_beds24`, `SyncState.bookings_pull`), webhook `/api/webhooks/beds24/:token` → `WebhookEvent` → `beds24-webhook` navbati. `origin=CHANNEL`, USD, `exchangeRate`, `externalReference`, to'lovlar `invoiceItems` dan |
| Beds24 → PMS | Narx | `GET /inventory/rooms/calendar` har soat (`cron_pull_rates`), SoT = beds24 bo'lsa PMS narxini almashtirardi |
| Beds24 → PMS | Yopiq kunlar | `status=black` → `ChannelBlock` + `RoomDayStatus` ("Beds24:") |
| PMS → Beds24 | Bronlar | `beds24-reservation-sync` navbati → `POST /bookings` (`checkAvailability`), rad etilsa `FAILED` va har 15 daqiqada qayta (`cron_catch_up`) |
| PMS → Beds24 | Narx / bo'sh joy | `beds24-rate-sync`, `beds24-availability-sync` → kalendar (so'm ÷ CBU kursi = $) |
| Nazorat | Farq | `cron_drift_check` kunlik 04:00; `beds24-retry` dead-letter |
| Kurs | CBU | `cron_fx_refresh` har 3 soat (`FX_RATE_USD` sozlamasi) |

Token: refresh token (AES bilan shifrlangan, `ChannelConnection`) →
24 soatlik access token. Kredit: 5 daqiqada ~100.

---

## 2. Olib tashlashdan oldingi jonli tahlil (2026-09-26, faqat o'qish)

Serverdagi baza, Redis va jurnal o'qildi; Beds24'ga bitta `GET /bookings`
yuborildi (token o'chirilishidan oldin, PMS'da yo'q bronlarni aniqlash uchun).

| Nima | Topilgan holat |
|---|---|
| Ulanish | Real hisob, `SOURCE_OF_TRUTH_* = beds24`, 2 ta xona mapping (Room 1 → 101, Room 2 → 102) |
| `SyncLog` | 17 983 yozuv (2026-09-18 dan), asosan `FAILED`: `push_availability` va `job_dead_lettered` kuniga ~860 (mapping yo'q turlar), `poll_bookings` |
| Hozirgi trafik | Har 15 daqiqada: `GET /properties`, `GET /bookings` va sayt sinov broni (102, 26–30.09) uchun `POST /bookings` — Beds24 har safar "no availability" bilan rad etardi. **Beds24 tarixini aynan shu to'ldirardi** |
| PMS → Beds24 yuborilgan | 4 ta muvaffaqiyatli `push_reservation` — 101 dagi 2 ta sinov broni (yaratildi va bekor qilindi) |
| Webhook | 0 ta hodisa — Beds24'da webhook URL hech qachon sozlanmagan |
| Redis | 5 ta Beds24 davriy vazifasi, `beds24-availability-sync` da 6 813 ta yiqilgan job |
| Beds24'dagi faol bronlar | 4 ta, **hech biri PMS'da yo'q**: 3 ta "direct" (sinovga o'xshaydi, 24–27.09) va **1 ta haqiqiy Booking.com broni: Room 1 (=101), 30.09–03.10, 3 kishi** |

**Birinchi chora (kod o'zgarmasdan):** Redis'dan 5 ta Beds24 davriy
vazifasi olib tashlandi, 5 ta Beds24 navbati pauza qilindi — shu
daqiqadan Beds24'ga so'rov ketmadi.

---

## 3. Nima olib tashlandi

**Kod (zakas042/backend):** `services/beds24/*`, `services/channel/*`,
`webhook*`, `reservationSync`, `mapping`, `reconciliation`,
`channelBlocks`, `exchangeRate`, `fxSync`, `rates` (sync qismi),
`lib/encryption`, `lib/syncLog`, `lib/channelOwnership`,
`queues/workers`, `queues/deadLetter`; route'lar `/api/webhooks/beds24/*`,
`/api/admin/{connection,mapping,sync-log,webhook-events,fx,maintenance/poll|drift|pull-rates|catch-up|sync-blocks}`,
`/api/reservations/fx-rate`; `public/admin/*.html`; admin paneldagi
"Channel manager" tizimi, "Dollar kursi", hisobotdagi kanal kartasi,
Narxlar sahifasidagi sync belgilari; Shaxmatkadagi dollar/kanal
belgilari; skriptlar `beds24:connect|mock|verify`; mock server
(`zakas042/mock-beds24`); Beds24 testlari.

**Baza (migratsiya `20260926200000_remove_beds24`):** jadvallar
`Channel`, `ChannelConnection` (shifrlangan token), `ChannelMapping`,
`SyncLog`, `SyncState`, `WebhookEvent`, `ChannelBlock`; ustunlar
`Reservation.{origin, currency, exchangeRate, externalReference,
externalReservationId, channelId, syncStatus, lastSyncedAt}`,
`Payment.{channelId, externalPaymentId, originalAmount, originalCurrency,
exchangeRate}`, `RatePlan.{channelPrice, source, syncedAt, syncError}`,
`Availability.{syncedAt, syncedCount}`; 5 ta enum; sozlamalar
`SOURCE_OF_TRUTH_*`, `FX_RATE_*`. Dollar bron bo'lsa oldin so'mga
o'giriladi (kurs bo'lmasa migratsiya to'xtaydi).

**Ma'lumot (`npm run beds24:purge`, migratsiyadan OLDIN):** Beds24'dan
kelgan bronlar (serverda 0 ta edi), "Beds24:" yopiq kunlar (0),
kanal jadvallari (17 983 SyncLog va b.), 2 ta audit yozuvi,
availability keshi (qayta hisoblanadi), Redis'dagi `beds24-*` navbatlar.
PMS'da yaratilgan 3 ta bron saqlandi.

**Server:** `.env` dan `ENCRYPTION_KEY`, `BEDS24_*`, `WEBHOOK_*`,
`SOURCE_OF_TRUTH_*`, `POLL_INTERVAL_MINUTES`, `PROPERTY_CACHE_TTL_MS`;
`hotel-mock` xizmati va `/opt/hotel-pms/mock-beds24`; `restart.sh`
mock'siz.

### Qanday bajarildi

1. Zaxira: `pg_dump` (+ `pg_restore -l` tekshiruvi), `.env`, eski kod + mock (tar).
2. **Mashq:** zaxira vaqtinchalik `imron_pms_rehearsal` bazasiga tiklandi,
   unda purge + `migrate deploy` + `migrate diff` (farq yo'q) — keyin o'chirildi.
3. Backend va mock to'xtatildi, yana bir zaxira (`-final.dump`).
4. Kod almashtirildi (serverdagi eski fayllar o'chirilib), `prisma generate`.
5. Purge (hisobot → tasdiq), `prisma migrate deploy`, sxema farqi yo'q, `npm run build`.
6. `.env` tozalandi, backend ishga tushirildi.
7. Keyin: `NODE_ENV=production` (systemd drop-in), `HOST=127.0.0.1`.

Zaxiralar: `/opt/hotel-pms/backups/*remove-beds24-2026-09-26-2049*` (SERVER.md, "Zaxira").

---

## 4. Olib tashlashdan keyin tekshirildi

- `/health` 200 (DB, Redis, auth, rate limit); sayt, Shaxmatka, admin panel 200
  (nginx orqali ham); brauzerda konsol xatosi yo'q.
- Olib tashlangan manzillar 404: `/admin/*.html`, `/api/admin/{fx,mapping,sync-log,connection}`,
  `POST /api/webhooks/beds24/*`. Tokensiz `/api/rooms` → 401.
- Bazada kanal jadvallari va ustunlari 0; 3 bron, 18 xona, narxlar, xodimlar, foydalanuvchilar joyida.
- Redis: `bull:beds24*` kalitlari 0; davriy vazifalar faqat PMS'niki.
- Jurnalda Beds24 so'rovi yo'q.
- Mahalliy test bazasida 13 fayl / 226 test — `AUTH_REQUIRED` ikkala rejimida.

---

## 5. Beds24 tomonida qolganlar — EGASI qiladi

PMS Beds24'ga endi hech narsa yozmaydi va undan o'qimaydi. Lekin Beds24
hisobi va uning OTA ulanishlari o'z holicha ishlayveradi:

1. **Booking.com hali Beds24'ga ulangan.** Beds24'ga kelgan yangi bron
   PMS'ga TUSHMAYDI. Ikki marta sotmaslik uchun Booking.com'ni Beds24'dan
   uzing (yoki Booking.com extranet'ida sotuvni yoping) va bundan keyin
   Booking.com bronlarini PMS'ga qo'lda kiriting.
2. **Haqiqiy Booking.com broni: 101, 30.09–03.10, 3 kishi, $225.** PMS'da
   101 shu kechalar (30.09, 01.10, 02.10) uchun YOPIB qo'yildi
   (sabab: "Booking.com broni…"). Mehmon ma'lumotini Beds24/Booking.com'dan
   olib PMS'ga bron qilib kiriting, keyin yopishni oching.
3. Beds24'dagi 3 ta "direct" sinov bronini (24–27.09) Beds24'da bekor
   qiling — PMS ularga tegmaydi.
4. Beds24 API token'ini o'chiring: Beds24 → Settings → Marketplace → API
   (token PMS bazasidan o'chirilgan, 30 kun ishlatilmasa o'zi ham o'ladi).
5. Webhook sozlanmagan edi — hech narsa qilish shart emas.
6. **Sayt sinov broni** (102, 26–30.09, CONFIRMED) PMS'da turibdi —
   haqiqiy bo'lmasa bekor qiling (u 102 ni band qilib turibdi).

---

# Ilova: eski batafsil hujjat (2026-09-26 holati, o'zgartirilmagan)

> Quyidagi havolalardagi fayllar endi repoda yo'q; eski kod serverdagi
> `backups/code-pre-remove-beds24-*.tgz` da. "Ulash tartibi" va
> buyruqlar tarix uchun qoldirilgan — ular endi ishlamaydi.

### 1. Arxitektura

```
 Booking.com                ETG / Ostrovok
      \                         /
       \   bron, o'zgarish,    /
        \  bekor qilish       /
         v                   v
 ┌─────────────────────────────────────────┐
 │  Beds24 — MARKAZIY TIZIM (ustuvor)      │
 │  xona/tarif mapping, kalendar, bronlar  │
 └───────────────────┬─────────────────────┘
                     │  token orqali
 ┌───────────────────┴─────────────────────┐
 │  Beds24 API v2                          │
 │  GET/POST bookings, inventory           │
 │  + webhook (bron o'zgarganda)           │
 └───────────────────┬─────────────────────┘
                     │
 ┌───────────────────┴─────────────────────┐
 │  Shaxmatka backend (PMS)                │
 │  API bilan gaplashadi, ma'lumot saqlaydi│
 │  PostgreSQL + Redis (BullMQ)            │
 └───────────────────┬─────────────────────┘
                     │  WebSocket
 ┌───────────────────┴─────────────────────┐
 │  Shaxmatka · Admin panel · Sayt         │
 │  xonalar, kunlar, bronlar — SHU YERDAN  │
 │  BOSHQARILADI                           │
 └─────────────────────────────────────────┘
```

OTA'lar Beds24'ga ulanadi, PMS esa **faqat Beds24'ga** ulanadi.
PMS hech bir OTA bilan to'g'ridan-to'g'ri gaplashmaydi (TZ 1, 12-band).

Bron uch joydan tug'iladi:

| Manba | Qayerda yaratiladi | Beds24'ga qanday yetadi |
|---|---|---|
| OTA (Booking.com, ETG/Ostrovok) | OTA'da | OTA o'zi yuboradi; PMS webhook + polling bilan oladi |
| Sayt | PMS (`/api/public/reservations`) | PMS navbat orqali yaratadi |
| Admin / qabulxona | Shaxmatka | PMS navbat orqali yaratadi |

---

### 2. Asosiy qoida: Beds24 ustuvor (mijoz qarori Q9)

Egasi 2026-09-25 da: **"Beds24 tanlovi doim ustuvor"**. Ma'nosi:
Beds24'dagi qiymat haqiqat. Shaxmatka — Beds24'ni boshqarish
oynasi. Admin Shaxmatkada o'zgartirsa, o'zgarish Beds24'ga yoziladi.
Ikki joy farq qilsa, Beds24 qiymati g'olib.

| Ma'lumot | Kim yozadi | Farq bo'lsa | Qanday sinxronlanadi |
|---|---|---|---|
| OTA broni (sana, narx, mehmon, bekor qilish) | faqat OTA | Beds24 | webhook + 15 daqiqalik polling |
| Sayt / admin broni | PMS -> Beds24 | Beds24 (joy yo'q bo'lsa rad etadi) | navbat, `checkAvailability` bilan |
| Bo'sh joy soni (`numAvail`) | Beds24 o'zi, bronlardan | Beds24 | PMS son YOZMAYDI; kunlik drift tekshiruvi faqat ogohlantiradi |
| Narx (`price1`, `minStay`) | admin (Shaxmatka) yoki Beds24 paneli | Beds24 | PMS -> Beds24 darhol; Beds24 -> PMS soatlik `pullRates` |
| Check-in / check-out | PMS (qabulxona) | PMS (Beds24'da bunday status yo'q) | Beds24'ga bayroq (`flagText`) sifatida |
| Xona yopish (ta'mir) | PMS yoki Beds24 (`black`) | Beds24 | `ChannelBlock`: PMS yopishi -> Beds24 `black` bron; Beds24 `black` -> PMS kunlari (2-bo'lim, "Xona yopish") |

Kodda: `SOURCE_OF_TRUTH_RATES` va `SOURCE_OF_TRUTH_AVAILABILITY`
standart qiymati `beds24` ([services/settings.ts](zakas042/backend/src/services/settings.ts)).
`pms` qiymati qoldirilgan — test va favqulodda holat uchun.

#### OTA bronini PMS o'zgartirmaydi

Booking.com broni OTA'niki. PMS uni Beds24'da o'zgartirsa, Beds24
xonani bo'shatadi, Booking.com'da esa bron turaveradi. Natija
overbooking. Shuning uchun:

| Amal | OTA broni | Sayt / admin broni |
|---|---|---|
| Check-in / check-out | ✓ (Beds24'ga bayroq) | ✓ |
| Kelmadi (no-show) | ✓ ("No-show" bayrog'i, statusni OTA hal qiladi) | ✓ (`cancelled` + `noShow`) |
| Xonani shu tur ichida almashtirish | ✓ (Beds24'da unit o'zgaradi) | ✓ |
| Boshqa xona turiga ko'chirish | ✗ 409 `CHANNEL_OWNED` | ✓ |
| Sanani o'zgartirish | ✗ 409 | ✓ |
| Narx, mehmon soni | ✗ 409 | ✓ |
| Bekor qilish | ✗ 409 — OTA extranet'ida | ✓ |
| To'lov, izoh, ovqat | ✓ (faqat PMS'da) | ✓ |

Egalik `Reservation.origin` maydonidan olinadi (B2 migratsiyasi,
2026-09-25), manba nomidan taxmin qilinmaydi:

| `origin` | `source` | Kimniki | Beds24'ga |
|---|---|---|---|
| `PMS` (sayt, qabulxona, admin) | istalgan | PMS | hamma maydon (`full`) |
| `CHANNEL` | `DIRECT` (Beds24 panelida yaratilgan) | PMS | hamma maydon |
| `CHANNEL` | `BOOKING_COM`, `AIRBNB`, `EXPEDIA`, `OSTROVOK`, `OTHER` | OTA | faqat xona/unit va bayroq (`ota`) |

`OTHER` + `CHANNEL` — Beds24 bergan, lekin bizga noma'lum kanal kodi
(keyin ulanadigan OTA). Xavfsiz tomon: OTA'niki. Xodim PMS'da qo'lda
"Booking.com" manbali bron yaratsa ham u PMS broni (`origin = PMS`).

#### STOP — sotuvni vaqtincha to'xtatish (Q17, 2026-09-26)

Tizim nazoratidagi STOP to'xtatilgan xonalarning kelgusi 366 kunlik
bo'sh kunlarini `RoomDayStatus` da "STOP:" sababi bilan yopadi — pastdagi
xona yopish zanjiri ularni Beds24'ga `black` bron qilib yuboradi (OTA'da
yopiq). Bron bor kunlar yopilmaydi. Stopdan chiqarilganda faqat "STOP:"
kunlari ochiladi va `black` bronlar bekor qilinadi.

#### Xona yopish (`ChannelBlock`, B2)

Availability SoT = beds24 bo'lganda PMS `numAvail` yozmaydi. Shuning
uchun ta'mirga yopilgan xona Beds24'ga faqat `black` bron bo'lib yetadi
([channelBlocks.ts](zakas042/backend/src/services/channelBlocks.ts)):

| Qayerda yopildi | Nima bo'ladi | Kim ochadi |
|---|---|---|
| PMS (Shaxmatka / admin) | ketma-ket kunlar bitta `black` bron: aniq unit, `referer: PMS`, `checkAvailability` siz | PMS; Beds24 panelida bekor qilinsa — PMS ham ochiladi (Q9) |
| Beds24 paneli | PMS'da o'sha xonaning kunlari yopiladi (`blockReason: "Beds24: ..."`), bron yaratilmaydi | faqat Beds24 — PMS'da ochish 409 `CHANNEL_OWNED` |

Diff asosida ishlaydi: PMS'dagi yopiq kunlar oraliqlarga yig'iladi va
Beds24'dagi `black` bronlar bilan solishtiriladi (yangisi yaratiladi,
keragi qolmagani bekor qilinadi). Xona qulfi (`pg_advisory_xact_lock`)
va yozuvni band qilish ikki jarayonning bir oraliqni ikki marta
yaratishiga yo'l qo'ymaydi. Yiqilgan yuborish FAILED bo'lib qoladi —
catch-up (15 daqiqa) yoki `POST /api/admin/maintenance/sync-blocks`
qayta yuboradi. Unit bog'lanmagan xonada Beds24 yopishi admin
ogohlantirishiga tushadi.

Qoidalar joyi: [channelOwnership.ts](zakas042/backend/src/lib/channelOwnership.ts)
(bitta qoida), [reservations.ts](zakas042/backend/src/services/reservations.ts)
(`assertChannelAllows`), [adapter.ts](zakas042/backend/src/services/beds24/adapter.ts)
(`detectMode`, `pushReservation`). Shaxmatka shu qoidani serverdan
oladi (`channelOwned`): OTA bronida "Bekor qilish" va "Sanalarni
o'zgartirish" tugmalari yo'q, xona faqat shu tur ichida almashadi.

---

### 3. Real hisob (2026-09-25 da o'rganildi)

Hisob ma'lumotlari (ID, email) repoga yozilmaydi — repo ochiq.

| Narsa | Holat |
|---|---|
| Obyekt | 1 ta, nomi va manzili hali to'ldirilmagan (egasi to'ldiradi) |
| Valyuta | **USD** — egasi tasdiqladi, to'g'ri. PMS moslashadi (B3) |
| Xona turlari | 2 ta, har birida 1 unit — **faqat sinov uchun**, rasmiy ishga tushmagan |
| Kanallar | Booking.com ulangan (bitta sinov broni bor). ETG/Ostrovok rejada |
| Narxlar | Admin qo'yadi. Hozir ~1,5 oy oldinga bor, keyin xonalar yopiq |
| Webhook | Versiya `one`, URL bo'sh — ulash kuni sozlanadi |
| Token | refresh token; scope: bookings (o'qish/yozish, personal, financial), inventory (o'qish/yozish), properties (o'qish) |

---

### 4. Real API faktlari

Hammasi real hisobda `GET` bilan yoki rasmiy spetsifikatsiyada
(`https://beds24.com/api/v2/apiV2.yaml`) tekshirilgan.

#### Ulanish va token

- Bazaviy URL: `https://beds24.com/api/v2` (`https://api.beds24.com/v2`
  ham ishlaydi).
- `GET /authentication/token` (header `refreshToken`) -> access token,
  24 soat.
- **Refresh token almashadi.** Javobda ba'zan yangi `refreshToken`
  keladi va eskisi o'sha zahoti `Token not valid` bo'ladi. Yangisi
  saqlanmasa ulanish butunlay uziladi. Kod endi yangisini darhol
  shifrlab saqlaydi va parallel yangilashlarni bittaga birlashtiradi
  ([auth.ts](zakas042/backend/src/services/beds24/auth.ts)).
- Refresh token 30 kun ishlatilmasa o'ladi. Soatlik narx tortish va
  15 daqiqalik polling uni tirik tutadi.
- **Scope yetishmasa ham `401 Token not valid`** qaytadi — muddati
  o'tgan tokendan farqi yo'q. Yangi token bilan ham 401 kelsa, sabab
  scope ([client.ts](zakas042/backend/src/services/beds24/client.ts) xabari).
- `GET /authentication/details` — token scope'lari
  (`npm run beds24:verify` tekshiradi).

#### Kredit

- 5 daqiqada ~100 kredit. Har javobda `X-Five-Min-Limit-Remaining`,
  `X-Five-Min-Limit-Resets-In`, `X-Request-Cost`.
- O'lchangan narx: `/properties` (hamma include bilan) 1.5, oddiy
  GET ~1. Yozish narxi o'lchanmagan (yozish taqiqlangan edi).

#### Obyekt va xonalar

- `GET /properties` xona turlarini **faqat `includeAllRooms=true`
  bilan** beradi. Ilgari mapping sahifasi shu sababdan bo'sh qolardi.
- Valyuta obyekt darajasida (`currency`).
- Xona turi = `roomId`, jismoniy xona = `unit`. **Unit id har xona
  turida 1 dan boshlanadi** — ikki turli xonada ham `unitId: 1`.
  Unit faqat `roomId` bilan birga noyob. Ilgari mapping faqat unit
  bo'yicha qidirardi va bron boshqa turdagi xonaga tushishi mumkin edi.

#### Bronlar

- `GET /bookings` status berilmasa `confirmed, request, new, black,
  inquiry` qaytaradi. **Bekor qilinganlar kelmaydi.** Polling endi
  barcha statuslarni so'raydi.
- Filtr berilmasa faqat kelajakdagi bronlar.
- Javob sahifalanadi (`pages.nextPageExists`, `?page=2`).
- `invoiceItems` faqat `includeInvoiceItems=true` bilan.
- `status`: `confirmed | request | new | cancelled | black | inquiry`.
- `subStatus`: `actionRequired | allotment | cancelledByGuest |
  cancelledByHost | noShow | waitlist | walkin | none | nonPayment`.
  **`arrived` / `departed` yo'q.**
- Manba: `channel` ("booking", "direct"), `apiSource` ("Booking.com"),
  `apiReference` (OTA bron raqami). `referer` erkin matn.
- Mamlakat kodi `country2` da, `country` ko'pincha bo'sh.
- `POST /bookings` massiv qabul qiladi, javob 201:
  `[{success, new|modified, errors, warnings, info}]`.
- `actions.checkAvailability: true` — joy bo'lmasa bron
  **saqlanmaydi**. PMS yangi bronni shu bilan yuboradi.
- `actions.allowWebhooks` berilmasa API orqali yozilgan bron webhook
  **yubormaydi** — PMS'ning o'z yozuvi aks-sado bo'lib qaytmaydi.
- `flagText` (32 belgigacha) + `flagColor` — check-in/out belgisi.

#### Kalendar

- `GET /inventory/rooms/calendar` `include*` bayroqlarisiz **bo'sh**
  `calendar: []` qaytaradi: `includeNumAvail`, `includePrices`,
  `includeMinStay`.
- Kunlar oraliqqa siqiladi: `{from, to, numAvail, price1}`.
- `roomId` berilmasa obyektning barcha xonalari bitta so'rovda.
- `numAvail` — bronlardan keyingi SOF son (overbooking'da manfiy).
- Narxi yo'q kunlar yopiq (real hisobda `numAvail: 0`).

#### Webhook

- Obyekt sozlamasi: `version` = `one` | `twoNoPersonalData` |
  `twoWithPersonalData`, `url`, `customHeader`.
  PMS uchun: **`twoWithPersonalData`**.
- Payload: `{timeStamp, booking, infoItems, invoiceItems, messages,
  retries}`. `event` maydoni yo'q — nima bo'lgani bron holatidan
  aniqlanadi. To'lovlar bron ichida emas, yuqori darajada.
- **Imzo (HMAC) yo'q.** Himoya: URL'dagi maxfiy token
  (`WEBHOOK_AUTH_MODE=ip_token`).
- **Narx o'zgarishi uchun webhook yo'q.** Narx davriy tortiladi.

---

### 5. Maydonlar xaritasi

| Beds24 | PMS | Izoh |
|---|---|---|
| `id` | `Reservation.externalReservationId` | `@@unique([channelId, externalReservationId])` |
| `roomId` | `ChannelMapping.externalRoomTypeId` -> `RoomType` | tur darajasi |
| `roomId` + `unitId` | `ChannelMapping(roomId, externalUnitId)` -> `Room` | xona darajasi, `POST /api/admin/mapping/auto-units` |
| `arrival` / `departure` | `checkIn` / `checkOut` | `[)` oraliq |
| `numAdult` / `numChild` | `adults` / `children` | |
| `price` (jami) | `pricePerNight` = price / kechalar (4 xona) | faqat valyuta mos kelsa; jami sentgacha qayta tiklanadi ($100/3 -> 33.3333 -> $100.00) |
| obyekt `currency` | `Reservation.currency` | |
| `firstName` + `lastName` | `Guest.fullName` | |
| `phone` / `mobile`, `email`, `country2` | `Guest` | |
| `notes` + `comments` | `notes` | boshiga `[Booking.com #raqam]` |
| `channel` / `apiSource` | `source` | booking -> BOOKING_COM, ostrovok* / etg -> OSTROVOK, direct -> DIRECT, boshqa -> OTHER |
| — | `origin = CHANNEL` | Beds24'dan kelgan har bron (egalik qoidasi) |
| `apiReference` | `externalReference` (+ `notes` boshida) | Shaxmatka bron oynasida ko'rinadi |
| `status: black` | `ChannelBlock` + `RoomDayStatus` | bron emas, xona yopilishi |
| `invoiceItems[type=payment]` | `Payment` (`externalPaymentId = b24item:<id>`) | |
| `flagText` | CHECKED_IN / CHECKED_OUT / NO_SHOW | |

#### Status xaritasi

Beds24 -> PMS:

| Beds24 | PMS |
|---|---|
| `confirmed`, `new` | CONFIRMED |
| `confirmed` + bayroq "Checked-in" | CHECKED_IN |
| `confirmed` + bayroq "Checked-out" | CHECKED_OUT |
| `confirmed` + `noShow` yoki bayroq "No-show" | NO_SHOW |
| `request` | PENDING_PAYMENT |
| `cancelled` | CANCELLED |
| `cancelled` + `noShow` | NO_SHOW |
| `black` | bron emas — xona yopilishi, `ChannelBlock` (PMS kunlari yopiladi) |
| `inquiry` | bron emas — o'tkazib yuboriladi |

PMS -> Beds24 (sayt / admin broni):

| PMS | Beds24 |
|---|---|
| PENDING_PAYMENT | `request` |
| CONFIRMED | `confirmed` |
| CHECKED_IN | `confirmed` + bayroq "Checked-in" |
| CHECKED_OUT | `confirmed` + bayroq "Checked-out" |
| CANCELLED | `cancelled` |
| NO_SHOW | `cancelled` + `noShow` |

OTA bronida status yuborilmaydi, faqat bayroq (2-bo'lim).

Beds24 "confirmed" desa PMS'dagi CHECKED_IN / CHECKED_OUT saqlanadi.
Beds24 bekor qilsa-yu mehmon xonada bo'lsa, PMS holati saqlanadi va
admin ogohlantiriladi (`mergeIncomingStatus`,
[statusMap.ts](zakas042/backend/src/services/beds24/statusMap.ts)).

---

### 6. Valyuta

**Tizim so'mda, Beds24 dollarda** (egasi qarori Q15, 2026-09-25 —
Q13 "hammasi USD" bekor qilindi): sayt, Shaxmatka, hisobotlar, Telegram
botlar, nonushta, maosh va xarajatlar — so'mda. Beds24 obyekti USD:
undan kelgan bron dollarda qoladi, tagida so'm. Yagona formula —
[lib/money.ts](zakas042/backend/src/lib/money.ts) (`toBase`, `paymentBase`).

- Kurs: Markaziy bank (cbu.uz), avtomatik, har 3 soatda
  ([exchangeRate.ts](zakas042/backend/src/services/exchangeRate.ts),
  [fxSync.ts](zakas042/backend/src/services/fxSync.ts)). Admin panelda
  qo'lda qo'yiladi va Markaziy bankka qaytariladi.
- Beds24 broni: `Reservation.currency = USD`, `exchangeRate` — bron
  kelgan kundagi kurs (qotadi, hisobot o'zgarmaydi). Bank javob bermasa
  bron baribir yaratiladi, kurs keyin to'ldiriladi.
- Dollar bronda so'mda to'lov: bugungi kurs bilan $ ga o'giriladi,
  asl so'm (`Payment.originalAmount`) va kurs saqlanadi.
- Narx Beds24'ga: so'm / bugungi kurs = $ (`RatePlan.channelPrice`).
  Tortishda o'sha $ qaytsa — o'zgarish emas. Kurs o'zgarsa kelajak
  kunlar qayta yuboriladi. Kurs noma'lum — narx yuborilmaydi.
- PMS broni (so'm) Beds24'ga faqat XONA summasi bilan, dollarga
  o'girib yuboriladi — aks-sado so'm narxni o'zgartirmaydi.
- Zod chegaralari so'mda: kechalik narx 50 mln, to'lov 500 mln,
  nonushta 10 mln, maosh 1 mlrd ([moneySchema.ts](zakas042/backend/src/lib/moneySchema.ts)).

---

### 7. Davriy vazifalar

| Vazifa | Davr | Kredit |
|---|---|---|
| Bronlarni tortish (polling, hamma statuslar) | 15 daqiqa | ~1 / sahifa |
| Narxni tortish (`pullRates`, 365 kun, hamma xona) | soatlik | ~2 |
| Qolib ketgan sync (catch-up) + STOP ufqi (`enforceSalesStop`) + xona yopilishlari (`syncAllRoomBlocks`) | 15 daqiqa | yuborilganicha |
| Drift (PMS va Beds24 bo'sh joyi) | kunlik 04:00 | 1 / tur |

Qo'lda: `POST /api/admin/maintenance/{poll,pull-rates,drift,catch-up,sync-blocks}`.

---

### 8. Mock va real API

`zakas042/mock-beds24` 2026-09-25 da real xatti-harakatga keltirildi
(42 test, bazasiz ishlaydi):

| Xatti-harakat | Mock |
|---|---|
| Refresh token almashishi | `MOCK_REFRESH_ROTATION=always` (standart) / `never` |
| Valyuta | `MOCK_CURRENCY` (standart `USD`, PMS bilan bir xil) |
| `black` bron | band qiladi, `simulate-black` / `add-booking-silently {status: "black"}` |
| `includeAllRooms`, `include*` bayroqlari, bekor qilinganlar filtri | real kabi |
| Sahifalash | `MOCK_PAGE_SIZE` (standart 100) |
| Unitlar | har turda 1 dan, nomi xona raqami |
| `checkAvailability`, `allowWebhooks`, subStatus tekshiruvi | real kabi |
| Webhook | v2 formati, `event` yo'q, `MOCK_WEBHOOK_HEADER` |
| Narx webhook'i | yo'q (`simulate-rate-change` faqat kalendarni o'zgartiradi) |

Mock bilmaydigan narsa — real hisobda sinaladi (9-bo'lim, T1–T8).

---

### 9. Ulash tartibi (FAQAT egasining ruxsati bilan)

#### Beds24 panelida (egasi)

1. Obyekt ma'lumotlarini to'ldirish (nom, manzil, telefon).
2. Valyuta: USD qoladi (qaror). PMS so'mda, narx kurs bilan o'giriladi (Q15).
3. Xona turlari: 9 ta tarif, `qty` = PMS'dagi xonalar soni. Unit
   nomlari = PMS xona raqamlari ("101", "202", ...). Shunda xonalar
   avtomatik bog'lanadi.
4. Narxlar kamida 365 kun oldinga (narxsiz kun yopiq).
5. Webhook: Settings -> Properties -> Access -> Booking Webhook:
   `twoWithPersonalData`, URL
   `https://<domen>/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>`.
6. ETG/Ostrovok kanalini ulash (Beds24 Channel Manager).

#### Server

```bash
# .env
BEDS24_BASE_URL="https://beds24.com/api/v2"
SOURCE_OF_TRUTH_RATES="beds24"
SOURCE_OF_TRUTH_AVAILABILITY="beds24"

# refresh token buyruq qatoriga yozilmaydi
BEDS24_REFRESH_TOKEN=... npm run beds24:connect -- --refresh-token <property-id>
npm run beds24:verify
```

Keyin `/admin/mapping` da 9 tarifni bog'lash,
`POST /api/admin/mapping/auto-units` bilan xonalarni bog'lash,
`GET /api/admin/mapping/health` -> `isComplete: true`.

**Refresh token'ni boshqa joyda ishlatmang** — u almashsa serverdagi
nusxa o'ladi.

#### Real hisobda birinchi sinovlar

Uzoq kelajakdagi sana va sinov xonasida, har biridan keyin qaytarib:

| # | Sinov | Nima aniqlanadi |
|---|---|---|
| T1 | Sayt broni -> Beds24 | `checkAvailability` ishlaydi, `unitId` to'g'ri |
| T2 | Band sanaga ikkinchi bron | Beds24 rad etadi, PMS'da ⚠ va admin xabari |
| T3 | `request` status | Beds24'da joy band qiladimi (PENDING_PAYMENT uchun) |
| T4 | Check-in / check-out | bayroq Beds24 kalendarida ko'rinadi |
| T5 | Beds24 panelida narx o'zgartirish | `pull-rates` PMS'ga olib keladi |
| T6 | Booking.com sinov broni | webhook keladi, xona, manba, OTA raqami to'g'ri |
| T7 | Booking.com'da bekor qilish | PMS'da CANCELLED, xona bo'shaydi |
| T8 | Kredit sarfi 1 kun | `X-Five-Min-Limit-Remaining` me'yorda |
| T9 | PMS'da sinov xonasini 1 kunga yopish | Beds24'da `black` bron, to'g'ri unit; ochganda bekor bo'ladi |
| T10 | Beds24 panelida xonani yopish | PMS kunlari yopiladi, PMS'da ochib bo'lmaydi |

---

### 10. Xavfsizlik

- Token faqat backendda, AES-256 bilan shifrlangan
  (`ChannelConnection`), frontendga chiqmaydi.
- Loglarda token yo'q (`sanitizeForLog`).
- Repoga token, hisob ID, email yozilmaydi — repo ochiq.
- Webhook URL'idagi token maxfiy. Sizib chiqsa `WEBHOOK_URL_TOKEN`
  almashtiriladi va Beds24'dagi URL yangilanadi.

---

### 11. Real hisob tahlili (2026-09-26, faqat o'qish)

Real hisobdan GET bilan o'qildi: bronlar (`includeInvoiceItems`,
`includeInfoItems`, `includeGuests`, `includeBookingGroup`),
kalendar va obyekt sozlamalari. Hech narsa yozilmadi.

**Ishlayotgani tasdiqlandi.** Saytdagi sinov bronlari Beds24'ga
Room 1 ga (PMS 101) yetib bordi, bekor qilish ham yetib bordi.
Beds24'da xona band kunga ikkinchi bron rad etildi (T2).

**Tuzatildi:**

| Nima | Muammo | Yechim |
|---|---|---|
| `minStay` | PMS'da sozlanmaydi (standart 1), narx bilan birga yuborilardi. Room 1 dagi "kamida 3 kecha" 1 ga tushib ketardi | Faqat narx yuboriladi, cheklovlar Beds24'da boshqariladi |
| `apiMessage` | Booking.com mehmon xabari (maxsus iltimoslar, to'lov turi) olinmasdi | Izohga qo'shiladi |
| `arrivalTime` | Kelish vaqti olinmasdi | Izohga "Kelish vaqti: …" |

**Ochiq qolganlar (egasining qarori kerak):**

| # | Nima | Holat |
|---|---|---|
| 1 | PMS'da Beds24 bronlari yo'q | PMS bronlari o'chirilgach, Beds24'dagi haqiqiy bronlar qayta tortilmadi (polling faqat o'zgarganlarni oladi). Sayt shu kunlarni sotishi mumkin |
| 2 | Webhook | Beds24'dan webhook kelmayapti — yangi OTA bron 15 daqiqagacha kechikadi |
| 3 | Chiqish vaqti | Beds24 obyektida chiqish 10:00, PMS `CHECKOUT_HOUR` 12 |
| 4 | Narx modeli | Beds24'da narx xona bo'yicha, PMS'da kategoriya bo'yicha. Xona bog'lanishida Beds24 narxi PMS'ga tortilmaydi (`pullRates` faqat kategoriya bog'lanishini ko'radi) |
| 5 | `minStay` saytda | PMS saytida minimal kecha tekshirilmaydi (Beds24 qoidasi faqat OTA uchun ishlaydi) |
| 6 | Sig'im | Beds24: Room 1 maks. 3, Room 2 maks. 2 kishi — PMS kategoriyasi bilan solishtirish kerak |
| 7 | Qo'shimcha to'lovlar | `invoiceItems` dan faqat `payment` olinadi; `charge` (qo'shimcha xizmat) olinmaydi. Hozir faqat xona narxi bor |
| 8 | Mehmonlar ro'yxati | `guests` (bir necha mehmon) olinmaydi, faqat asosiy mehmon |

`commission`, `deposit`, `tax` real bronlarda 0 — Booking.com komissiyasi
API'da kelmaydi.
