# Channel Manager (Beds24) — TZ, mantiq va ish tartibi

**Yangilandi:** 2026-09-27. Channel manager — **Beds24 API v2**. Bu faylda:
integratsiya hozir qanday ishlaydi (mantiq), TZ ↔ kod solishtiruvi,
qilinadigan ishlar (bajarish tartibida) va buyurtmachi TZ'sining asl matni.

Bog'liq: [BEDS24.md](BEDS24.md) (qoidalar, ulash) ·
[ISH_REJASI.md](ISH_REJASI.md) · [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
[SERVER.md](SERVER.md)

Belgilar: **[qaror]** — avval egasining qarori kerak. **[tashqi]** — kod
tashqarisida (server, Beds24 kabineti). Hajm: **S** — bir necha soat,
**M** — ~1 kun, **L** — bir necha kun.

1. [Holat qisqacha](#1-holat-qisqacha)
2. [Integratsiya mantig'i (hozirgi kod)](#2-integratsiya-mantigi-hozirgi-kod)
3. [TZ ↔ kod](#3-tz--kod)
4. [Qilinadigan ishlar — bajarish tartibi](#4-qilinadigan-ishlar--bajarish-tartibi)
5. [Egasiga savollar](#5-egasiga-savollar)
6. [Ilova: TZ asl matni](#6-ilova-tz-asl-matni)

---

## 1. Holat qisqacha

- TZ'ning asosiy qismi bajarilgan: bronlar ikki tomonga (webhook + polling,
  PMS → Beds24), bekor qilish, o'zgartirish, dublikat himoyasi, narx (ikki
  tomonga), xona yopilishi, mapping, sinxron jurnali, shifrlangan ulanish.
- Ochiq: **restrictions yo'q** (minStay, maxStay, Closed, CTA, CTD — 10-band);
  bron o'zgarganda **mehmon ma'lumoti yangilanmaydi** (7-band); arxitektura
  **Beds24 nomiga qattiq bog'langan** (13-band).
- **Ikki tomonlama kod hali commit qilinmagan.** Commit `0e960f0` va
  GitHub'da — faqat kuzatuv (o'qish) rejimi, u TZ 2, 8, 9, 19-bandlarga
  javob bermaydi.
- Server yo'q (2026-09-27 da o'chirilgan) — kod deploy qilinmagan, real
  Beds24 hisobi ulanmagan.

## 2. Integratsiya mantig'i (hozirgi kod)

### 2.1 Asosiy qoidalar

- **Beds24 ustuvor (Q9).** OTA bronining sanasi, narxi, mehmon soni va
  bekor qilinishi OTA'da o'zgaradi — PMS'da qulf (`409 CHANNEL_OWNED`).
  PMS'da qolgani: kirish/chiqish, to'lov, izoh, nonushta, shu turdagi
  xonaga ko'chirish.
- **Mapping majburiy.** Bog'lanmagan xona sinxronlanmaydi, taxminiy
  bog'lash yo'q.
- **Valyuta (Q15).** Tizim so'mda, Beds24 obyekti USD. PMS narxi Beds24'ga
  `so'm / kurs = $` bo'lib ketadi. Beds24 broni dollarda qoladi, tagida
  so'm — bron kelgan kundagi Markaziy bank kursi bilan.
- **Ruxsatlar.** `channel.write` — FOUNDER, ADMIN (ulash, bog'lash, qo'lda
  amallar). `channel.read` — + MANAGER (holat, jurnal).
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
       4. bor — yangilanadi (sana, xona, mehmon soni, narx, status)
  → availability keshi → WebSocket (Shaxmatka) → Telegram
```

- `black` (Beds24'da yopilgan xona) → PMS'da kunlar yopiladi
  (`ChannelBlock`). `inquiry` → e'tiborsiz.
- **Polling (zaxira):** har `POLL_INTERVAL_MINUTES` daqiqada (hozir 15),
  `modifiedFrom` bilan. Birinchi yurish to'liq (`departureFrom = bugun`) va
  mapping bo'lmaguncha kutadi. Webhook ham, polling ham bitta
  `applyReservation` dan o'tadi.
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

- **Catch-up** (polling bilan bir oraliqda): FAILED va eski PENDING qayta
  yuboriladi, navbatga tushmay qolgan webhook'lar ishlanadi.
- Echo himoyasi: Beds24 API orqali yozilgan bron uchun webhook yubormaydi;
  kelgan ma'lumot PMS holati bilan bir xil bo'lsa hech narsa yozilmaydi.
- Kod: [reservationSync.ts](zakas042/backend/src/services/reservationSync.ts),
  [beds24/adapter.ts](zakas042/backend/src/services/beds24/adapter.ts) (`pushReservation`).

### 2.4 Narx, yopiq kunlar, bo'sh joy

- **Narx PMS → Beds24:** admin so'mda qo'yadi → 3 soniya debounce →
  `so'm / kurs` → `POST /inventory/rooms/calendar` (`price1`). Faqat
  yuborilmagan (`syncedAt = null`) kunlar ketadi. **Faqat narx** — minStay
  va boshqa cheklovlar yuborilmaydi.
- **Narx Beds24 → PMS:** soatlik, 365 kun oldinga, faqat tur darajasidagi
  bog'lanish. Yuborilmagan PMS narxi ustiga yozilmaydi.
- **Xona yopish:** PMS'dagi ta'mir ↔ Beds24 `black` bron (ikki tomonga).
- **Bo'sh joy:** PMS `numAvail` yozmaydi — Beds24 uni bronlar va `black`
  dan o'zi hisoblaydi. Har kuni 04:00 da 30 kunlik farq (drift) tekshiruvi —
  faqat jurnalga yoziladi.
- Kod: [rates.ts](zakas042/backend/src/services/rates.ts),
  [channelBlocks.ts](zakas042/backend/src/services/channelBlocks.ts),
  [availability.ts](zakas042/backend/src/services/availability.ts).

### 2.5 Ulanish, jurnal, xavfsizlik

- **Ulash:** invite code (yoki refresh token) + ixtiyoriy Property ID.
  Avval `ENCRYPTION_KEY` tekshiriladi (invite code bir martalik). Tokenlar
  AES-256-GCM bilan shifrlanadi va hech qachon javobga chiqmaydi.
- **SyncLog:** har bir Beds24 muloqoti — action, yo'nalish, request,
  response, status, xato, davomiylik, vaqt. Log yozilmasa asosiy amal
  yiqilmaydi.
- **Sahifalar:** `/admin/connection.html`, `/admin/mapping.html`,
  `/admin/sync-log.html`, admin panel → Channel manager.

## 3. TZ ↔ kod

Holat 2026-09-27 dagi (commit qilinmagan) kod bo'yicha.

| # | Talab | Holat | Izoh |
|---|---|---|---|
| 1 | OTA'lar faqat Channel Manager orqali | ✅ | OTA bilan to'g'ridan-to'g'ri kod yo'q |
| 2 | READ + WRITE | ✅ | bronlar, narx, yopiq kunlar ikki tomonga |
| 3 | Mehmon, xona, sana, narx, valyuta, status, kanal qabul qilish | ✅ | `adapter.ts` `toExternalReservation` |
| 4 | Webhook | ✅ | `POST /api/webhooks/beds24/:token`, darhol 200, navbat |
| 5 | Yangi bron admin panelda real-time | ✅ | WebSocket + Telegram |
| 6 | Bekor qilish → CANCELLED | ✅ | test bor |
| 7 | O'zgartirish, dublikatsiz | ⚠️ | sana, xona, mehmon soni, status, narx — ha; **ism, telefon, email — yo'q** |
| 8 | Availability yuborish | ⚠️ | bron va `black` orqali (Beds24 o'zi hisoblaydi); `pushAvailability()` chaqirilmaydi |
| 9 | Narx yuborish | ✅ | so'm → $ kurs bilan; teskari tortish ham bor |
| 10 | Min/Max stay, Closed, CTA, CTD | ❌ | faqat narx; Closed faqat xona darajasida (`black`), STOP olib tashlangan |
| 11 | Room mapping bazada | ✅ | tur va unit darajasi; `external_property_id` mapping'da emas, ulanishda |
| 12 | Settings → Channel Manager, Connected ✓, xavfsiz saqlash | ✅ | Provider tanlash va refresh token maydoni UI'da yo'q |
| 13 | Faqat Beds24'ga bog'lanmaslik | ⚠️ | interfeys + registry bor, lekin 12 faylda `"beds24"` qattiq yozilgan |
| 14 | ChannelManagerService metodlari | ⚠️ | `getBooking`, `updateRestrictions` yo'q; `connect` interfeysdan tashqarida |
| 15 | Webhook asosiy, polling zaxira | ✅ | polling 15 daqiqa (TZ misoli 1–5) |
| 16 | Sync log, admin panelda xato | ✅ | xona, sana, qiymat ustun sifatida ko'rinmaydi |
| 17 | `provider + external_booking_id` unique | ✅ | `@@unique([channelId, externalReservationId])` + webhook hash |
| 18, 19 | Data flow, "bridge" | ✅ | |

14-band metodlari:

| TZ | Kodda |
|---|---|
| `connect()` | `beds24/auth.ts` `connect()` — interfeysda emas |
| `getProperties()`, `getRooms()` | `getRoomTypes()` (ikkalasi birga) |
| `getBookings()` | `pullReservations(since)`, `pullActiveReservations()` |
| `getBooking()` | **yo'q** (adapter ichida yashirin `detectMode`) |
| `updateAvailability()` | `pushAvailability()` — bor, lekin chaqirilmaydi |
| `updatePrices()` | `pushRates()` |
| `updateRestrictions()` | **yo'q** |
| `updateBooking()`, `cancelBooking()` | `pushReservation()` (status bilan) |

## 4. Qilinadigan ishlar — bajarish tartibi

Har bosqichdan keyin: testlar ikkala AUTH rejimida o'tadi (retsept:
[zakas042/README.md](zakas042/README.md) "Testlar"), yangi xatti-harakat
uchun test qo'shiladi, [BEDS24.md](BEDS24.md) va shu faylning 3-bo'limi
yangilanadi.

Tartib: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**, 10-bosqich — faqat
ikkinchi provider rejada bo'lsa.

### Bosqich 0 — Commit · S

- [ ] Beds24 qaytarilishini (migratsiya `20260927120000_beds24_restore`
      bilan) commit qilish va **`agy`** (private) repoga push qilish.
      `origin` — ochiq repo, unga emas.

**Tayyor:** `agy` dagi kod ikki tomonlama integratsiyani o'z ichiga oladi,
CI yashil.

### Bosqich 1 — O'zgargan bronda mehmon ma'lumoti (TZ 7) · S

- [ ] [webhookProcessor.ts](zakas042/backend/src/services/webhookProcessor.ts)
      `applyReservation`, mavjud bronni yangilash qismi: Beds24'dan kelgan
      ism, telefon, email, davlat qo'llanadi.
- [ ] Telefon/email boshqa odamniki bo'lsa — bron `findOrCreateGuest`
      orqali boshqa `Guest`ga bog'lanadi. O'sha odam bo'lsa — ism
      yangilanadi, bo'sh maydonlar to'ldiriladi. (Bitta `Guest` bir necha
      bronda ishlatiladi — boshqa bronlar buzilmasin.)
- [ ] Test: OTA'da mehmon ismi/telefoni o'zgardi → PMS'da yangilandi,
      yangi bron yaratilmadi.

**Tayyor:** 7-banddagi hamma maydon (sana, mehmon soni, xona, mehmon
ma'lumoti, status) Beds24'dan kelganda yangilanadi.

### Bosqich 2 — Polling oralig'i (TZ 15) · S

- [ ] `POLL_INTERVAL_MINUTES` standarti 15 → 5
      ([config.ts](zakas042/backend/src/lib/config.ts),
      [.env.example](zakas042/backend/.env.example)).
- [ ] Catch-up uchun alohida oraliq (masalan `CATCH_UP_INTERVAL_MINUTES`,
      15 qolishi mumkin) — hozir polling bilan bir xil
      ([scheduler.ts](zakas042/backend/src/queues/scheduler.ts)).
- [ ] Beds24 kredit sarfini tekshirish (kredit 5 daqiqalik oynada, ulanish
      sahifasida ko'rinadi).

**Tayyor:** webhook kelmasa ham bron 5 daqiqa ichida PMS'da.

### Bosqich 3 — Sync log (TZ 16) · S

- [ ] [sync-log.html](zakas042/backend/public/admin/sync-log.html) va admin
      panel → Sinxronizatsiya: **Provider, Xona/tarif, Sana(lar), Qiymat**
      ustunlari (hozir `request` JSON ichida, ko'rinmaydi).
- [ ] Amal nomlari jadvalda ham odam tilida (filtrdagi kabi:
      "Narx → Beds24").
- [ ] Ixtiyoriy: filtr uchun `SyncLog` ga `externalRoomTypeId`, `dateFrom`,
      `dateTo` ustunlari.

**Tayyor:** har qator TZ misolidagi maydonlarni ko'rsatadi (Provider,
Action, Room, Date, Value, Status, Time, Error), FAILED qizil, xato matni
ko'rinadi.

### Bosqich 4 — Restrictions (TZ 10) · L

- [ ] Beds24 API v2 hujjatidan `/inventory/rooms/calendar` (GET va POST)
      dagi minStay, maxStay, yopiq kun, kirish taqiqi, chiqish taqiqi
      maydonlarining **aniq nomi va qiymatlari**. Natija
      [BEDS24.md](BEDS24.md) ga.
- [ ] Sxema + migratsiya, `RatePlan`
      ([schema.prisma](zakas042/backend/prisma/schema.prisma)):
      `minStay Int?` (hozir `@default(1)`; `null` = PMS boshqarmaydi, shunda
      Beds24 panelidagi cheklov 1 ga tushib ketmaydi), `maxStay Int?`,
      `closed Boolean?`, `closedArrival Boolean?`, `closedDeparture Boolean?`.
- [ ] [types.ts](zakas042/backend/src/services/channel/types.ts):
      `RatesPush.days` va `ExternalRateDay` ga yangi maydonlar; interfeysga
      `updateRestrictions()` (yoki `pushRates` kengaytiriladi).
- [ ] [adapter.ts](zakas042/backend/src/services/beds24/adapter.ts):
      `pushRates` maydonlarni yozadi, `groupConsecutive` kaliti hamma
      maydonni o'z ichiga oladi; `getRates` ularni o'qiydi.
- [ ] [rates.ts](zakas042/backend/src/services/rates.ts): `pushRates` —
      faqat `null` bo'lmagan cheklov yuboriladi; `pullRates` — Beds24
      cheklovlari PMS'ga (yuborilmagan PMS qiymati ustiga yozilmaydi).
- [ ] [routes/rates.ts](zakas042/backend/src/routes/rates.ts): qabul qilish
      va tekshirish (`1 ≤ minStay ≤ maxStay ≤ 365`).
- [ ] Admin panel → Narxlar: kun yoki oraliq uchun cheklov kiritish, holat
      belgisi (yuborildi / xato).
- [ ] **[qaror]** Closed/Open — bu STOP'ning o'zi, STOP egasi qarori (Q19)
      bilan olib tashlangan. Egasi rozi bo'lsagina qo'shiladi.
- [ ] **[qaror]** Sayt ([publicBooking.ts](zakas042/backend/src/services/publicBooking.ts))
      va qabulxona broni ham cheklovlarga amal qilsinmi — aks holda sayt
      OTA sotmaydigan kunni sotadi.
- [ ] Test: [channel.test.ts](zakas042/backend/src/channel.test.ts) dagi
      soxta Beds24 kalendari yangi maydonlarni saqlaydi; push, pull, `null`
      yuborilmasligi.

**Tayyor:** admin minStay = 2 qo'ysa Beds24 kalendarida 2; Beds24 panelida
maxStay o'zgarsa bir soat ichida PMS'da; PMS boshqarmaydigan cheklov
Beds24'da buzilmaydi.

### Bosqich 5 — Adapter interfeysi (TZ 14) · M

- [ ] `getBooking(externalId)` interfeysga (adapter'da `detectMode` ichida
      allaqachon bor) + bron oynasida "Beds24'dan qayta olish" tugmasi
      (`channel.write`).
- [ ] `connect()`, `disconnect()`, `getConnectionStatus()` interfeysga;
      [routes/channel.ts](zakas042/backend/src/routes/channel.ts)
      `beds24/auth.ts` ni to'g'ridan-to'g'ri chaqirmaydi.
- [ ] Metodlar moslik jadvali (3-bo'lim) [BEDS24.md](BEDS24.md) ga.

**Tayyor:** 14-banddagi har bir metodga interfeysda mos metod bor.

### Bosqich 6 — Ulanish sahifasi (TZ 12) · S

- [ ] [connection.html](zakas042/backend/public/admin/connection.html):
      Provider tanlash (`listChannels()` dan; hozir faqat Beds24).
- [ ] "Refresh token" maydoni — backend qabul qiladi, UI'da yo'q (invite
      code allaqachon ishlatilgan bo'lsa kerak).
- [ ] Ulashdan keyin hisobdagi obyektlar ro'yxati va tanlash — hozir
      Property ID berilmasa birinchi obyekt jimgina olinadi.

**Tayyor:** sahifada TZ'dagi maydonlar bor (Provider, kalit/token,
Property ID, Connect) va "ulangan" belgisi ko'rinadi.

### Bosqich 7 — Mapping'da obyekt (TZ 11) · M

- [ ] `ChannelMapping.externalPropertyId` + migratsiya (mavjud qatorlar
      joriy ulanishdagi obyekt bilan to'ldiriladi).
- [ ] Boshqa obyektga ulanganda mos kelmagan mapping'lar o'chiriladi
      (`isActive = false`) va ogohlantirish chiqadi.

**Tayyor:** mapping'da TZ'dagi to'rt maydon bor (channel_id,
external_property_id, external_room_id, internal_room_id); boshqa obyektga
qayta ulash eski bog'lanishlarni noto'g'ri qoldirmaydi.

### Bosqich 8 — Availability izohi va hujjatlar (TZ 8) · S

- [ ] TZ muallifiga yozma izoh: 8-band bron va `black` yuborish orqali
      bajariladi — Beds24 bo'sh joyni o'zi hisoblaydi; `numAvail` yuborilsa
      bir bron ikki marta ayirilardi; har kuni drift tekshiruvi solishtiradi.
- [ ] `pushAvailability` interfeysda qoladi (boshqa provider uchun), Beds24
      adapterida "ishlatilmaydi — sabab" izohi.
- [ ] [BEDS24.md](BEDS24.md), [PROJECT_LOGIC.md](PROJECT_LOGIC.md), shu
      faylning 1 va 3-bo'limlari yangilanadi.

### Bosqich 9 — Ishga tushirish · [tashqi] [qaror]

Batafsil: [SERVER.md](SERVER.md), [BEDS24.md](BEDS24.md) 4-bo'lim,
[ISH_REJASI.md](ISH_REJASI.md) 0-bo'lim.

- [ ] Server va deploy: zaxira → migratsiyalar.
- [ ] `.env`: `ENCRYPTION_KEY`, `WEBHOOK_URL_TOKEN`, `POLL_INTERVAL_MINUTES`.
- [ ] Egasidan invite code — bookings va inventory uchun **yozish** ruxsati
      bilan.
- [ ] Ulash → xonalarni bog'lash → import natijasini Bronlar bo'limida
      tekshirish.
- [ ] Beds24 panelida webhook URL:
      `https://<domen>/api/webhooks/beds24/<WEBHOOK_URL_TOKEN>`.
- [ ] Jonli sinov: Beds24 panelida bron → PMS'da; PMS'da bron → Beds24'da;
      PMS narxi → Beds24 kalendarida; cheklov → Beds24 kalendarida.

**Tayyor:** TZ 18-banddagi uchala oqim real hisobda ishlaydi.

### Bosqich 10 — Ko'p provider (TZ 13) · L · [qaror]

Faqat ikkinchi channel manager rejada bo'lsa.

- [ ] 12 faylda qattiq yozilgan `"beds24"` → registry (`DEFAULT_CHANNEL` /
      `adapter.code`): `lib/syncLog.ts`, `queues/workers.ts`,
      `routes/channel.ts`, `routes/reservations.ts`,
      `services/channelBlocks.ts`, `services/mapping.ts`,
      `services/rates.ts`, `services/reconciliation.ts`,
      `services/report.ts`, `services/reservationSync.ts`,
      `services/webhook.ts`, `services/webhookProcessor.ts`.
- [ ] `getBeds24Channel`, `activeConnection` → `services/channel/` da
      `getChannelRecord(code)`, `activeConnection(code)`.
- [ ] Webhook: `/api/webhooks/:provider/:token` — eski
      `/api/webhooks/beds24/:token` ishlashda davom etadi (Beds24 panelidagi
      URL o'zgarmasin).
- [ ] Umumiy `ChannelError` (`Beds24AuthError`, `Beds24ApiError`,
      `RateLimitError` va `routes/channel.ts` dagi `beds24()` o'rami o'rniga).
- [ ] UI: "Beds24" yozuvlari API'dan keladigan provider nomi bilan.

**Tayyor:** yangi provider qo'shish = yangi adapter fayli + registry'da
bitta qator.

## 5. Egasiga savollar

1. **[qaror]** Closed/Open (STOP) qaytadimi? (Bosqich 4)
2. **[qaror]** Cheklovlar (minStay va boshqalar) qayerda boshqariladi — PMS
   admin panelida, Beds24 panelida yoki ikkalasida? Ikkalasida bo'lsa,
   hozirgi qoida bo'yicha Beds24 ustuvor.
3. **[qaror]** Sayt va qabulxona ham cheklovlarga amal qilsinmi? (Bosqich 4)
4. **[qaror]** Server, deploy va real hisobni ulash qachon? (Bosqich 9)
5. **[qaror]** Ikkinchi channel manager rejadami? (Bosqich 10)

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
