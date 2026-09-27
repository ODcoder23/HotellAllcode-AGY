# Channel Manager (Beds24) — TZ, mantiq va ish tartibi

**Yangilandi:** 2026-09-27 (kechqurun — 0–8-bosqichlar bajarildi).
Channel manager — **Beds24 API v2**. Bu faylda: integratsiya qanday
ishlaydi (mantiq), TZ ↔ kod solishtiruvi, ishlar tartibi (bajarilganlari
belgilangan) va buyurtmachi TZ'sining asl matni.

Bog'liq: [BEDS24.md](BEDS24.md) (qoidalar, ulash, API faktlari) ·
[ISH_REJASI.md](ISH_REJASI.md) · [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
[SERVER.md](SERVER.md)

Belgilar: **[qaror]** — avval egasining qarori kerak. **[tashqi]** — kod
tashqarisida (server, Beds24 kabineti). Hajm: **S** — bir necha soat,
**M** — ~1 kun, **L** — bir necha kun.

1. [Holat qisqacha](#1-holat-qisqacha)
2. [Integratsiya mantig'i](#2-integratsiya-mantigi)
3. [TZ ↔ kod](#3-tz--kod)
4. [Ishlar — bajarish tartibi](#4-ishlar--bajarish-tartibi)
5. [Egasiga savollar](#5-egasiga-savollar)
6. [Ilova: TZ asl matni](#6-ilova-tz-asl-matni)

---

## 1. Holat qisqacha

- TZ'ning 19 bandidan 17 tasi kodda bajarilgan va testlangan (ikkala
  AUTH rejimida). Qolgani:
  - **13-band (ko'p provider)** — interfeys va registry bor, lekin biznes
    kodida `"beds24"` qattiq yozilgan joylar qolgan. 10-bosqich,
    **[qaror]**: ikkinchi channel manager rejada bo'lsagina.
  - **10-band, Closed/Open** — STOP egasi qarori (Q19) bilan olib
    tashlangan; kun Beds24 panelida yopiladi. **[qaror]**
- 8-band (availability) boshqa yo'l bilan bajariladi — 3-bo'limdagi izoh.
- Kod `agy` repoda. **Server yo'q** (2026-09-27 da o'chirilgan) — deploy
  va real Beds24 hisobini ulash — 9-bosqich, **[tashqi]**.

## 2. Integratsiya mantig'i

### 2.1 Asosiy qoidalar

- **Beds24 ustuvor (Q9).** OTA bronining sanasi, narxi, mehmon soni,
  mehmon ma'lumoti va bekor qilinishi OTA'da o'zgaradi — PMS'da qulf
  (`409 CHANNEL_OWNED`). PMS'da qolgani: kirish/chiqish, to'lov, izoh,
  nonushta, shu turdagi xonaga ko'chirish.
- **Mapping majburiy.** Bog'lanmagan xona sinxronlanmaydi, taxminiy
  bog'lash yo'q. Bog'lanish ulangan obyektga tegishli (`externalPropertyId`).
- **Valyuta (Q15).** Tizim so'mda, Beds24 obyekti USD. PMS narxi Beds24'ga
  `so'm / kurs = $` bo'lib ketadi. Beds24 broni dollarda qoladi, tagida
  so'm — bron kelgan kundagi Markaziy bank kursi bilan.
- **Ruxsatlar.** `channel.write` — FOUNDER, ADMIN (ulash, obyekt, bog'lash,
  qo'lda amallar, "Beds24'dan yangilash"). `channel.read` — + MANAGER.
  Narx va cheklov — `rate.write`.
- **Kod tuzilishi.** Biznes qatlami kanalni `ChannelAdapter` interfeysi
  orqali ko'radi ([types.ts](zakas042/backend/src/services/channel/types.ts),
  [registry.ts](zakas042/backend/src/services/channel/registry.ts)).
  Beds24 tafsilotlari — [services/beds24/](zakas042/backend/src/services/beds24/).

### 2.2 Beds24 → PMS (qabul qilish)

```
OTA → Beds24 → POST /api/webhooks/beds24/<WEBHOOK_URL_TOKEN>
  → token tekshiruvi (noto'g'ri — 404, bazaga yozilmaydi)
  → WebhookEvent saqlanadi, SHA-256 hash bilan takror aniqlanadi → darhol 200
  → navbat (BullMQ) → applyReservation()
       1. channelId + externalReservationId bo'yicha mavjud bron
       2. yo'q — qo'lda kiritilgan shu OTA broni (OTA raqami / sanalar) → bog'lanadi
       3. yo'q — mapping → bo'sh xona → yangi bron
       4. bor — yangilanadi (sana, xona, mehmon soni, narx, status, mehmon)
  → availability keshi → WebSocket (Shaxmatka) → Telegram
```

- `black` (Beds24'da yopilgan xona) → PMS'da kunlar yopiladi
  (`ChannelBlock`). `inquiry` → e'tiborsiz.
- **Mehmon ma'lumoti (TZ 7):** OTA bronida Beds24'dagidek; boshqa odam
  kelsa va eski mehmonning boshqa bronlari bo'lsa — bron boshqa mehmonga
  bog'lanadi. PMS bronida faqat bo'sh maydonlar to'ldiriladi.
- **Polling (zaxira):** har `POLL_INTERVAL_MINUTES` (5) daqiqada,
  `modifiedFrom` bilan. Birinchi yurish (va obyekt almashganda) to'liq,
  mapping bo'lmaguncha kutadi. Webhook ham, polling ham bitta
  `applyReservation` dan o'tadi.
- **Bitta bron:** Shaxmatka → "Beds24'dan yangilash" → `getBooking()` →
  `applyReservation` (yuborilmagan PMS o'zgarishi ustiga yozilmaydi).
- Mapping yo'q yoki bo'sh xona yo'q → `NEEDS_MANUAL_ACTION`, admin tuzatib
  "Qayta ishlash" bosadi. Bo'sh xona yo'qligi — egasiga Telegram.
- Kod: [routes/webhooks.ts](zakas042/backend/src/routes/webhooks.ts),
  [webhook.ts](zakas042/backend/src/services/webhook.ts),
  [webhookProcessor.ts](zakas042/backend/src/services/webhookProcessor.ts),
  [reconciliation.ts](zakas042/backend/src/services/reconciliation.ts).

### 2.3 PMS → Beds24 (yuborish)

```
Shaxmatka amali (yaratish, sana, xona, check-in/out, bekor, kelmadi)
  → syncStatus = PENDING → navbat (2 soniya oyna) → pushReservation()
       - Beds24 ulanmagan              → PENDING qoladi
       - tugagan/bekor, Beds24'da yo'q → NOT_APPLICABLE
       - qo'lda kiritilgan OTA broni   → yuborilmaydi (import bog'laydi)
       - mapping yo'q                  → NOT_APPLICABLE
       - yangi bron                    → checkAvailability, referer "PMS"
       - OTA broni                     → faqat xona/unit va check-in/out belgisi (flagText)
  → SYNCED | FAILED (qayta uriniladi) | REJECTED (Beds24 rad etdi, qayta yuborilmaydi)
```

- **Catch-up** (`CATCH_UP_INTERVAL_MINUTES`, 15): FAILED va eski PENDING
  qayta yuboriladi, navbatga tushmay qolgan webhook'lar ishlanadi.
- Echo himoyasi: Beds24 API orqali yozilgan bron uchun webhook yubormaydi;
  kelgan ma'lumot PMS holati bilan bir xil bo'lsa hech narsa yozilmaydi.
- Kod: [reservationSync.ts](zakas042/backend/src/services/reservationSync.ts),
  [beds24/adapter.ts](zakas042/backend/src/services/beds24/adapter.ts) (`pushReservation`).

### 2.4 Narx, cheklovlar, yopiq kunlar, bo'sh joy

- **Narx va cheklovlar PMS → Beds24:** admin Narxlar bo'limida narx
  (so'm) va cheklov (kamida / ko'pi bilan kecha, kirish / chiqish taqiqi)
  qo'yadi → 3 soniya debounce → bitta `POST /inventory/rooms/calendar`
  (`price1`, `minStay`, `maxStay`, `override`). Faqat yuborilmagan
  (`syncedAt = null`) kunlar. Cheklov maydoni `null` — PMS boshqarmaydi,
  yuborilmaydi (Beds24'dagisi buzilmaydi).
- **Yopiq kun himoyasi:** kirish/chiqish taqiqi Beds24'da `override`
  maydoni, kunni butunlay yopish (`blackout`) ham shu yerda. Yuborishdan
  oldin joriy qiymat o'qiladi — `blackout`/`exception` kuniga taqiq
  yozilmaydi.
- **Beds24 → PMS:** soatlik, 365 kun, faqat tur darajasidagi bog'lanish —
  narx ham, cheklovlar ham. Yuborilmagan PMS qiymati ustiga yozilmaydi.
- **Xona yopish:** PMS'dagi ta'mir ↔ Beds24 `black` bron (ikki tomonga).
- **Bo'sh joy:** PMS `numAvail` yozmaydi — Beds24 uni bronlar va `black`
  dan o'zi hisoblaydi. Har kuni 04:00 da 30 kunlik farq (drift)
  tekshiruvi — faqat jurnalga yoziladi.
- Kod: [rates.ts](zakas042/backend/src/services/rates.ts),
  [routes/rates.ts](zakas042/backend/src/routes/rates.ts),
  [channelBlocks.ts](zakas042/backend/src/services/channelBlocks.ts),
  [availability.ts](zakas042/backend/src/services/availability.ts).

### 2.5 Ulanish, jurnal, xavfsizlik

- **Ulash:** provider (Beds24) + invite code yoki refresh token +
  ixtiyoriy Property ID. Avval `ENCRYPTION_KEY` tekshiriladi (invite code
  bir martalik). Tokenlar AES-256-GCM bilan shifrlanadi, javobga chiqmaydi.
- **Obyekt:** hisobdagi obyektlar ro'yxati, boshqasiga o'tish — eski
  obyekt bog'lanishlari nofaol, qaytib o'tilganda tiklanadi, bronlar
  yangi obyektdan to'liq o'qiladi.
- **SyncLog:** har bir Beds24 muloqoti. Jurnal sahifasi TZ 16-band
  ustunlari bilan: Vaqt, Provider, Amal, Yo'nalish, Xona/tarif, Sana,
  Qiymat, Holat, Xato.
- **Sahifalar:** `/admin/connection.html`, `/admin/mapping.html`,
  `/admin/sync-log.html`, admin panel → Channel manager va Narxlar.

## 3. TZ ↔ kod

Holat 2026-09-27 kechqurun.

| # | Talab | Holat | Izoh |
|---|---|---|---|
| 1 | OTA'lar faqat Channel Manager orqali | ✅ | OTA bilan to'g'ridan-to'g'ri kod yo'q |
| 2 | READ + WRITE | ✅ | bronlar, narx, cheklov, yopiq kunlar ikki tomonga |
| 3 | Mehmon, xona, sana, narx, valyuta, status, kanal qabul qilish | ✅ | `adapter.ts` `toExternalReservation` |
| 4 | Webhook | ✅ | `POST /api/webhooks/beds24/:token`, darhol 200, navbat |
| 5 | Yangi bron admin panelda real-time | ✅ | WebSocket + Telegram |
| 6 | Bekor qilish → CANCELLED | ✅ | test bor |
| 7 | O'zgartirish, dublikatsiz | ✅ | sana, xona, mehmon soni, status, narx va mehmon ma'lumoti |
| 8 | Availability yuborish | ✅* | bron va `black` orqali — pastdagi izoh |
| 9 | Narx yuborish | ✅ | so'm → $ kurs bilan; teskari tortish ham bor |
| 10 | Min/Max stay, Closed, CTA, CTD | ✅ / **[qaror]** | minStay, maxStay, CTA, CTD — ha; Closed/Open — Beds24 panelida (STOP olib tashlangan) |
| 11 | Room mapping bazada | ✅ | tur va unit darajasi, `externalPropertyId` bilan |
| 12 | Settings → Channel Manager, Connected ✓, xavfsiz saqlash | ✅ | provider, invite code / refresh token, obyekt tanlash |
| 13 | Faqat Beds24'ga bog'lanmaslik | ⚠️ | interfeys + registry bor; biznes kodida `"beds24"` qolgan (10-bosqich) |
| 14 | ChannelManagerService metodlari | ✅ | moslik jadvali — [BEDS24.md](BEDS24.md) 5-bo'lim |
| 15 | Webhook asosiy, polling zaxira | ✅ | polling 5 daqiqa, catch-up 15 |
| 16 | Sync log, admin panelda xato | ✅ | Provider, amal, xona, sana, qiymat, holat, xato |
| 17 | `provider + external_booking_id` unique | ✅ | `@@unique([channelId, externalReservationId])` + webhook hash |
| 18, 19 | Data flow, "bridge" | ✅ | |

**\* TZ muallifiga izoh (8-band).** Beds24'da bo'sh joy soni (availability)
kanalning o'zida bronlardan hisoblanadi. Shuning uchun PMS "Availability =
4" ni alohida yubormaydi: bron (yoki xona yopilishi) Beds24'ga yetishi
bilan Beds24'dagi son o'zi 5 dan 4 ga tushadi va OTA'larga tarqaladi —
TZ'dagi natija aynan shu. Sonni ham alohida yozish bitta bronni ikki
marta ayirardi. PMS va Beds24 sonlari har kuni solishtiriladi (farq
jurnalga yoziladi). Bo'sh joyni o'zi hisoblamaydigan boshqa channel
manager uchun `pushAvailability()` interfeysda tayyor.

## 4. Ishlar — bajarish tartibi

Har bosqichdan keyin testlar ikkala AUTH rejimida o'tadi (retsept:
[zakas042/README.md](zakas042/README.md) "Testlar").

### Bosqich 0 — Commit · S · ✅

- [x] Beds24 qaytarilishi commit qilindi va `agy` (private) repoga push
      qilindi (`b77e75d`).

### Bosqich 1 — O'zgargan bronda mehmon ma'lumoti (TZ 7) · S · ✅

- [x] OTA bronida ism, telefon, email, davlat Beds24'dagidek; boshqa odam
      bo'lsa bron boshqa mehmonga bog'lanadi; PMS bronida faqat bo'sh
      maydonlar to'ldiriladi. Beds24'dan kelgan "." familiya ismga
      qo'shilmaydi (`5e60e30`).

### Bosqich 2 — Polling oralig'i (TZ 15) · S · ✅

- [x] `POLL_INTERVAL_MINUTES` 15 → 5, alohida `CATCH_UP_INTERVAL_MINUTES`
      (15) (`b05d608`).

### Bosqich 3 — Sync log (TZ 16) · S · ✅

- [x] Jurnalda Provider, xona/tarif, sana, qiymat; narx jurnalida sana
      oralig'i, narxlar, valyuta (`ba9c713`).

### Bosqich 4 — Restrictions (TZ 10) · L · ✅ (Closed/Open — [qaror])

- [x] Beds24 API v2 maydonlari aniqlandi: `minStay`, `maxStay`,
      `override` ([BEDS24.md](BEDS24.md) 6-bo'lim).
- [x] `RatePlan`: `minStay Int?`, `maxStay`, `closedArrival`,
      `closedDeparture` (migratsiya `20260927200000_rate_restrictions`).
- [x] Narx bilan bitta so'rovda yuboriladi; `blackout` kuni himoyalangan;
      Beds24'dan tortiladi; `PUT /api/rate-plans/restrictions`; Narxlar
      bo'limida forma va katakda belgilar (`e48753d`).
- [ ] **[qaror]** Closed/Open (STOP).
- [ ] **[qaror]** Sayt va qabulxona broni cheklovlarni tekshirsinmi.

### Bosqich 5 — Adapter interfeysi (TZ 14) · M · ✅

- [x] `connect`, `disconnect`, `connectionStatus`, `getBooking` interfeysda;
      Shaxmatkada "Beds24'dan yangilash" (`2fbea84`).

### Bosqich 6 — Ulanish sahifasi (TZ 12) · S · ✅

- [x] Provider, kalit turi (invite code / refresh token), obyekt
      ro'yxati va tanlash (`f2227f1`).

### Bosqich 7 — Mapping'da obyekt (TZ 11) · M · ✅

- [x] `ChannelMapping.externalPropertyId` (migratsiya
      `20260927210000_mapping_property`); obyekt almashganda bog'lanishlar
      nofaol/tiklanadi, bronlar to'liq qayta o'qiladi (`f2227f1`).

### Bosqich 8 — Availability izohi va hujjatlar (TZ 8) · S · ✅

- [x] TZ muallifiga izoh (3-bo'lim), `pushAvailability` izohi,
      [BEDS24.md](BEDS24.md), [PROJECT_LOGIC.md](PROJECT_LOGIC.md),
      [SERVER.md](SERVER.md) yangilandi.

### Bosqich 9 — Ishga tushirish · [tashqi] [qaror]

Batafsil: [SERVER.md](SERVER.md), [BEDS24.md](BEDS24.md) 4-bo'lim,
[ISH_REJASI.md](ISH_REJASI.md) 0-bo'lim.

- [ ] Server va deploy: zaxira → migratsiyalar (jumladan
      `20260927200000_rate_restrictions`, `20260927210000_mapping_property`).
- [ ] `.env`: `ENCRYPTION_KEY`, `WEBHOOK_URL_TOKEN`, `POLL_INTERVAL_MINUTES`,
      `CATCH_UP_INTERVAL_MINUTES`.
- [ ] Egasidan invite code — bookings va inventory uchun **yozish** ruxsati
      bilan.
- [ ] Ulash → obyektni tekshirish → xonalarni bog'lash → import natijasini
      Bronlar bo'limida tekshirish.
- [ ] Beds24 panelida webhook URL:
      `https://<domen>/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>`.
- [ ] Jonli sinov: Beds24 panelida bron → PMS'da; PMS'da bron → Beds24'da;
      PMS narxi va cheklovi → Beds24 kalendarida.

### Bosqich 10 — Ko'p provider (TZ 13) · L · [qaror]

Faqat ikkinchi channel manager rejada bo'lsa.

- [ ] Qattiq yozilgan `"beds24"` → registry (`DEFAULT_CHANNEL` /
      `adapter.code`): `lib/syncLog.ts`, `queues/workers.ts`,
      `routes/channel.ts`, `routes/reservations.ts`,
      `services/channelBlocks.ts`, `services/mapping.ts`,
      `services/rates.ts`, `services/reconciliation.ts`,
      `services/report.ts`, `services/reservationSync.ts`,
      `services/webhook.ts`, `services/webhookProcessor.ts`.
- [ ] `getBeds24Channel`, `activeConnection` → `services/channel/` da
      `getChannelRecord(code)`, `activeConnection(code)`.
- [ ] Webhook: `/api/webhooks/:provider/:token` — eski
      `/api/webhooks/beds24/:token` ishlashda davom etadi.
- [ ] Umumiy `ChannelError` (`Beds24AuthError`, `Beds24ApiError`,
      `RateLimitError` o'rniga).
- [ ] UI: "Beds24" yozuvlari provider nomi bilan (API allaqachon beradi).

**Tayyor:** yangi provider qo'shish = yangi adapter fayli + registry'da
bitta qator.

## 5. Egasiga savollar

1. **[qaror]** Closed/Open (STOP) qaytadimi yoki kun Beds24 panelida
   yopilaversinmi? (Bosqich 4)
2. **[qaror]** Sayt va qabulxona ham cheklovlarga (kamida / ko'pi bilan
   kecha, kirish / chiqish taqiqi) amal qilsinmi? (Bosqich 4)
3. **[qaror]** Server, deploy va real hisobni ulash qachon? (Bosqich 9)
4. **[qaror]** Ikkinchi channel manager rejadami? (Bosqich 10)

---

## 6. Ilova: TZ asl matni

Buyurtmachi TZ'si, 2026-09-18. Matn o'zgartirilmagan — faqat markdown
formatiga keltirilgan (vertikal strelkali oqimlar bir qatorga yozilgan).

```
Booking.com
     ↕
 Expedia
     ↕
  Boshqa OTA
     ↕
┌───────────────┐
│ Beds24 /      │
│ Channel API   │
└───────┬───────┘
        ↕
┌────────────────────┐
│ BIZNING BACKEND    │
│ Channel Manager    │
└─────────┬──────────┘
          ↕
    Bizning PMS
          ↕
     Admin Panel
```

### TEXNIK TOPSHIRIQ — Channel Manager API integratsiyasi

#### 1. Maqsad

Biz o’zimizning Hotel PMS/Admin Panel tizimimizni tayyor Channel Manager
platformasi API’si orqali OTA kanallarga ulaymiz.

Masalan:
- Beds24
- yoki shunga o’xshash Channel Manager

Biz Booking.com, Expedia va boshqa OTA’larni alohida API orqali
to’g’ridan-to’g’ri integratsiya qilmaymiz.

Asosiy ma’lumot almashinuvi Channel Manager API orqali amalga oshiriladi.

#### 2. Asosiy prinsip

Bizning tizim Channel Manager API bilan:

**MA’LUMOT QABUL QILADI** — Channel Manager → Bizning Backend. Masalan:
- yangi booking
- booking o’zgarishi
- booking cancellation
- guest ma’lumotlari
- check-in
- check-out
- room
- price
- availability
- channel
- booking status

**MA’LUMOT YUBORADI** — Bizning Backend → Channel Manager. Masalan:
- room availability
- room price
- booking status
- restrictions
- room mapping
- reservation updates

#### 3. Ma’lumot qabul qilish

Channel Manager’dan keladigan ma’lumotlar bizning backendda qabul qilinadi.

Misol:

```json
{
  "booking_id": "123456",
  "channel": "booking",
  "guest": {
    "first_name": "Ali",
    "last_name": "Aliyev",
    "phone": "+998901234567"
  },
  "room": "Standard Double",
  "check_in": "2026-09-20",
  "check_out": "2026-09-22",
  "guests": 2,
  "price": 120,
  "currency": "USD",
  "status": "confirmed"
}
```

Backend ushbu ma’lumotni qabul qilib database’ga yozadi.

#### 4. Webhook

Agar Channel Manager webhook qo’llab-quvvatlasa, webhook ishlatiladi.

Masalan: `POST /api/channel/webhook`

Channel Manager yangi booking olganda:
Channel Manager → POST webhook → Bizning Backend → Database → Admin Panel

Admin panelda booking real-time yoki imkon qadar tez ko’rinishi kerak.

#### 5. Booking qabul qilish

Masalan, Booking.com orqali mehmon xona bron qildi.

Jarayon: Guest → Booking.com → Channel Manager → Webhook / API → Bizning
Backend → Database → Admin Panel

Admin panelda **New Reservation** paydo bo’ladi.

#### 6. Booking cancellation

Mehmon bookingni bekor qilsa:
Booking.com → Channel Manager → Webhook → Bizning Backend → Reservation
status = CANCELLED

Database’dagi booking avtomatik cancelled bo’lishi kerak.

#### 7. Booking modification

Mehmon:
- check-in sanasini
- check-out sanasini
- guest sonini
- roomni
- boshqa booking ma’lumotlarini

o’zgartirsa, Channel Manager’dan kelgan yangi ma’lumot bizning booking
bilan update qilinadi.

`external_booking_id` orqali mavjud booking topiladi.

Yangi duplicate booking yaratilmasligi kerak.

#### 8. Bizning tizimdan Channel Manager’ga ma’lumot yuborish

Admin yoki PMS’da availability o’zgarsa:
Admin Panel → Our Backend → Channel Manager API → OTA Channels

Masalan:
- Oldin: Standard Double, Availability = 5
- 1 ta booking bo’ldi.
- Bizning PMS: Availability = 4
- Backend Channel Manager API orqali Availability = 4 yuboradi.

Channel Manager esa ulangan OTA’larga tarqatadi.

#### 9. Price synchronization

Bizning PMS’da: Standard Double, 20 September, Price = $60 bo’lsa, API
orqali Channel Manager’ga yuboriladi.

Our PMS → Channel Manager API → Booking.com / Expedia / Other OTA

#### 10. Availability synchronization

Quyidagi ma’lumotlarni Channel Manager API orqali yuborish kerak:
- Room availability
- Price
- Minimum stay
- Maximum stay
- Closed/Open
- Closed for arrival
- Closed for departure

Channel Manager imkoniyatiga qarab qo’llab-quvvatlanadigan parametrlar
implement qilinadi.

#### 11. Room Mapping

Bizning PMS’dagi roomlar Channel Manager’dagi roomlar bilan mapping
qilinadi.

```
OUR PMS                  CHANNEL MANAGER

Room 101 ─────────────→ Standard Double
Room 102 ─────────────→ Standard Double
Room 201 ─────────────→ Deluxe
```

Mapping database’da saqlanadi. Masalan:
- channel_id
- external_property_id
- external_room_id
- internal_room_id

#### 12. Channel Manager account

Admin panelda Channel Manager account ulash bo’limi bo’ladi.

Masalan: Settings → Channel Manager

Fields:
- Provider
- API Key
- API Secret / Token
- Property ID
- [Connect]

Ulanishdan keyin **Connected ✓** ko’rsatiladi.

API credentiallar xavfsiz saqlanishi kerak.

#### 13. Multiple Channel Manager Provider

Arxitektura faqat Beds24’ga bog’lanib qolmasligi kerak.

```
ChannelManagerProvider
        │
        ├── Beds24
        ├── Provider 2
        └── Provider 3
```

Keyinchalik boshqa Channel Manager API qo’shish oson bo’lishi kerak.

#### 14. API Service Architecture

Backendda alohida service bo’lishi kerak:

```
ChannelManagerService
│
├── connect()
├── getProperties()
├── getRooms()
├── getBookings()
├── getBooking()
├── updateAvailability()
├── updatePrices()
├── updateRestrictions()
├── updateBooking()
└── cancelBooking()
```

Aniq endpoint va parametrlar tanlangan Channel Manager API documentation
asosida implement qilinadi.

#### 15. Sync mexanizmi

Tizim ikki xil usuldan foydalanishi mumkin:

**Webhook** — Channel Manager ma’lumot o’zgarganda bizning backendga
yuboradi.

**Polling** — agar webhook mavjud bo’lmasa, backend ma’lum intervalda API
orqali ma’lumotni tekshiradi. Masalan:
Every 1–5 minutes → GET bookings → Compare/update database

Webhook mavjud bo’lsa, asosiy mexanizm sifatida webhook ishlatiladi.

#### 16. Sync Log

Har bir API operation log qilinadi:

```
Provider: Beds24
Action: UPDATE_AVAILABILITY
Room: Standard Double
Date: 20.09.2026
Value: 4
Status: SUCCESS
Time: 19:30:21
```

Xatolik:

```
Status: FAILED
Error: API authentication failed
```

Admin panelda error ko’rinishi kerak.

#### 17. Duplicate protection

Bir booking webhook orqali bir necha marta kelsa, duplicate booking
yaratilmasligi kerak.

Buning uchun `provider + external_booking_id` unique bo’lishi kerak.

Masalan: `beds24 + 123456` bir marta mavjud bo’lsa, keyingi request
bookingni yaratmaydi, balki update qiladi.

#### 18. Data flow

- Booking qabul qilish: OTA → Channel Manager → Webhook/API → Our Backend →
  Database → PMS → Admin Panel
- Availability yuborish: Admin/PMS → Our Backend → Channel Manager API → OTA
- Price yuborish: PMS → Backend → Channel Manager API → Booking / Expedia /
  Other OTA

#### 19. Muhim talab

Channel Manager bizning tizimimiz uchun “bridge” vazifasini bajaradi.

Bizning tizim:
- ma’lumotni qabul qiladi;
- database’ga saqlaydi;
- PMS/Admin Panel’da ko’rsatadi;
- kerakli o’zgarishlarni Channel Manager API’ga yuboradi.

Channel Manager esa OTA kanallar bilan ishlaydi.

Shuning uchun backend Channel Manager API’ning **READ + WRITE**
funksiyalarini qo’llab-quvvatlashi kerak.

Ya’ni faqat bookinglarni olib kelish emas, balki bizning tizimdan Channel
Manager’ga ma’lumot yuborish ham majburiy.
