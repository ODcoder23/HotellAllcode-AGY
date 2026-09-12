# 04 — Webhook handler spetsifikatsiyasi

> **Manba:** `TZ-ASL.md` **10-band** (webhook qadamlari), **4-band**
> (OTA → Beds24 → PMS oqimi), **9-band** (duplicate himoyasi),
> **1-band** (qaysi ma'lumotlar keladi).
> Mijoz qarori: **Q3** (bron xonaga avtomatik biriktiriladi).


**Bu fayl javob beradi:**

- Beds24'dan bron kelganda nima bo'ladi?
- Bir xil webhook ikki marta kelsa?
- Mapping yo'q bo'lsa bron nima bo'ladi?
- Webhook ishlamay qolsa zaxira bormi?

---

## 1. Endpoint

```
POST /api/webhooks/beds24
```

Beds24 tomonida: **Settings → Properties → Access → Booking webhooks**
orqali yoqiladi va shu URL kiritiladi.

Beds24 webhook body'sida **to'liq bron ma'lumoti** JSON holida keladi —
ko'p holatlarda qo'shimcha `GET` so'rov qilish shart emas. Bu kredit
ham tejaydi ([03 §3](03-BEDS24-API-INTEGRATSIYA.md)).

---

## 2. Qadamlar (TZ 10-band)

TZ aynan shu ketma-ketlikni talab qiladi: *validate → eventni saqlash →
duplicate tekshirish → queuega yuborish → database update →
Shaxmatkani update qilish.*

```
┌─ HTTP so'rov (sinxron, tez — Beds24 kutmasligi kerak) ─────────┐
│                                                                 │
│ 1. VALIDATE                                                     │
│    - signature/secret tekshiruvi (agar Beds24 bersa)            │
│    - aks holda: IP whitelist + maxfiy URL token                 │
│    - payload sxemasi (majburiy maydonlar bormi)                 │
│    - xato → 401/400, lekin rawPayload baribir saqlanadi         │
│                                                                 │
│ 2. EVENTNI SAQLASH                                              │
│    - WebhookEvent.status = RECEIVED                             │
│    - rawPayload to'liq (sanitizatsiyadan keyin — [10](10-SECURITY-VA-SYNCLOG.md))       │
│    - payloadHash = SHA-256(rawPayload)                          │
│                                                                 │
│ 3. DUPLICATE TEKSHIRISH  (TZ 9-band)                            │
│    - unique(channelId, eventType, externalId, payloadHash)      │
│    - mavjud bo'lsa → IGNORED_DUPLICATE, 200 OK, tugadi          │
│                                                                 │
│ 4. QUEUEGA YUBORISH                                             │
│    - beds24-webhook navbatiga job                               │
│    - WebhookEvent.status = QUEUED                               │
│                                                                 │
│ 5. 200 OK DARHOL QAYTARILADI  ← Beds24 kutdirilmaydi           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─ Worker (asinxron) ────────────────────────────────────────────┐
│                                                                 │
│ 6. DATABASE UPDATE                                              │
│    a. externalReservationId bo'yicha mavjud bron qidiriladi     │
│    b. Topilmasa → mapping orqali xona aniqlanadi (§4)           │
│       → yangi Reservation + Guest yaratiladi                    │
│    c. Topilsa → mavjud bron yangilanadi                         │
│    d. Availability qayta hisoblanadi                            │
│    e. WebhookEvent.status = PROCESSED                           │
│                                                                 │
│ 7. SHAXMATKANI UPDATE QILISH                                    │
│    - WebSocket event ([09](09-REALTIME-WEBSOCKET.md))                                  │
│    - Admin sahifani yangilamasdan ko'radi (TZ 4-band)           │
└─────────────────────────────────────────────────────────────────┘
```

**Nega 200 darhol qaytariladi:** Beds24 javobni kutadi va kechiksa
qayta yuboradi. Og'ir ishni HTTP so'rov ichida bajarish — takroriy
webhook va timeout sababi. Shuning uchun saqlash + navbat, xolos.

---

## 3. Duplicate himoyasi (TZ 9-band) — ikki qatlam

TZ: *"Bir bron webhook/API orqali ikki marta kelib qolsa, duplicate
reservation yaratilmasin."*

### 1-qatlam: WebhookEvent

```prisma
@@unique([channelId, eventType, externalId, payloadHash])
```

> ⚠️ **Muhim tuzatish.** Bu constraint ichida `createdAt` **bo'lmasligi
> shart**. `createdAt = now()` har safar boshqacha qiymat beradi, ya'ni
> u constraint tarkibida bo'lsa — kombinatsiya hech qachon takrorlanmaydi
> va dedup **umuman ishlamaydi**. Oldingi versiyada shu xato bor edi.

`payloadHash` nima uchun kerak: bir xil `bookingId` uchun **turli
mazmunli** webhook kelishi normal holat (bron yangilandi). Hash
ularni ajratadi — bir xil mazmun takrorlansa duplicate, boshqacha
bo'lsa yangi o'zgarish.

### 2-qatlam: Reservation

```prisma
@@unique([channelId, externalReservationId])
```

Hatto mantiq xato qilsa ham, DB darajasida ikkinchi bron **jismonan
yaratilmaydi**. Worker bu xatoni ushlab, amalni "update" sifatida
qayta bajaradi.

---

## 4. Yangi bron yaratish — xona avtomatik biriktiriladi (Q3)

Mijoz qarori: **avtomatik bo'lishi kerak**, admin aralashmaydi.

```
Webhook: yangi bron, roomId=12345, arrival=2026-09-15, departure=2026-09-20
        ↓
1. ChannelMapping: externalRoomTypeId=12345 → roomTypeId="standard"
        ↓
   Mapping yo'q?  → NEEDS_MANUAL_ACTION, bron yaratilmaydi ([06 §4](06-XONA-MAPPING.md))
        ↓
2. Bo'sh xona tanlanadi ([06 §5](06-XONA-MAPPING.md)): 101 band, 102 bo'sh → "102"
        ↓
3. Guest yaratiladi/topiladi (telefon yoki email bo'yicha)
        ↓
4. Reservation yaratiladi:
     roomId = "102"
     source = BOOKING_COM (referer'dan aniqlanadi)
     channelId = beds24
     externalReservationId = <Beds24 bookingId>
     status = toPmsStatus(...)        ([08 §2](08-RESERVATION-STATUS-VA-TOLOV.md))
     checkedInAt / checkedOutAt       (TZ 1-band)
        ↓
5. To'lov ma'lumoti bo'lsa → Payment yaratiladi ([08 §7](08-RESERVATION-STATUS-VA-TOLOV.md))
        ↓
6. Availability qayta hisoblanadi
        ↓
7. WebSocket → Shaxmatkada DARHOL ko'rinadi (TZ 4, 20-band)
```

### Bo'sh xona topilmasa

Beds24 bizda bo'lmagan xonani sotgan — real overbooking signali:

```
→ WebhookEvent.status = NEEDS_MANUAL_ACTION
→ rawPayload TO'LIQ saqlanadi (ma'lumot yo'qolmaydi)
→ Admin'ga darhol ogohlantirish (WebSocket)
→ Admin qo'lda hal qiladi
```

Bron **avtomatik rad etilmaydi** — u real mehmon, OTA'da tasdiqlangan.
Tafsilot: [06 §5](06-XONA-MAPPING.md).

---

## 5. Event turlari (TZ 1-band talablari asosida)

| Event | Ta'sir |
|---|---|
| `booking.new` / `reservation.created` | Yangi `Reservation` (§4) |
| `booking.modified` / `reservation.updated` | Sana, xona, mehmon soni, narx yangilanadi |
| `booking.cancelled` | `status = CANCELLED`, xona va availability bo'shaydi |
| `payment.updated` | `Payment` yaratiladi/yangilanadi ([08 §7](08-RESERVATION-STATUS-VA-TOLOV.md)) |
| `room.status.changed` | Beds24'da xona holati o'zgarsa (kamdan-kam) |
| `availability.changed` | Faqat `SOURCE_OF_TRUTH_AVAILABILITY=beds24` bo'lsa |
| `rate.changed` | Faqat `SOURCE_OF_TRUTH_RATES=beds24` bo'lsa ([07 §7](07-AVAILABILITY-VA-RATES-SYNC.md)) |

Beds24 event nomlari hisob sozlamasiga qarab farq qilishi mumkin —
**FAZA 6** da real webhook qabul qilinib aniq nomlar qayd etiladi.
Noma'lum event turi kelsa: saqlanadi, `IGNORED` sifatida belgilanadi,
xato chiqarilmaydi (kelajakda kerak bo'lishi mumkin).

---

## 6. Echo loop himoyasi

PMS yuborgan bron webhook bo'lib qaytadi — himoyasiz bo'lsa cheksiz
halqa hosil bo'ladi. Worker ikki narsani tekshiradi: **`payloadHash`**
DB'dagi holat bilan bir xil bo'lsa hech narsa yozilmaydi
(`SyncLog.status = SKIPPED`), va **`referer: "PMS"`** belgisi qaytsa
bu o'z aks-sadomiz ekani ma'lum bo'ladi.

→ To'liq mexanizm va nima uchun ikki qatlam kerakligi:
[12 §3](12-PMS-DAN-BEDS24-GA-SYNC.md)

---

## 7. Xato holati va retry

```
Worker xato berdi
   ↓
WebhookEvent.status = FAILED, errorMessage saqlanadi, attempts++
   ↓
beds24-retry navbatiga (exponential backoff — [05 §3](05-SYNC-QUEUE-BULLMQ.md))
   ↓
5 urinishdan keyin ham bo'lmasa:
   → FAILED holatida qoladi
   → rawPayload saqlanib turadi — qo'lda qayta ishlash mumkin
   → Admin panelda ko'rinadi
```

**Ma'lumot hech qachon yo'qolmaydi** — `rawPayload` har doim saqlanadi,
hatto validatsiya xato bo'lsa ham. Bu audit uchun ham, qayta ishlash
uchun ham manba bo'lib qoladi.

### Qo'lda qayta ishlash

```
POST /api/admin/webhooks/:id/reprocess
```

Admin mapping'ni to'g'irlagandan keyin `NEEDS_MANUAL_ACTION`
holatidagi event'ni qayta yuboradi. Amal `AuditLog` ga yoziladi
(TZ 18-band).

---

## 8. Polling fallback (TZ 10-band)

TZ: *"Webhook ishlamasa polling/sync fallback mexanizmi bo'lsin."*

```
BullMQ repeatable job — har 15 daqiqada:

GET /bookings?modifiedFrom=<SyncState.lastSuccessfulAt>
        ↓
Har bron uchun: webhook worker mantig'i AYNAN ishlatiladi
  (kod takrorlanmaydi — bitta processBooking() funksiyasi)
        ↓
Yangi/o'zgargan bo'lsa → Reservation yangilanadi
Bir xil bo'lsa → payloadHash bo'yicha o'tkazib yuboriladi
        ↓
SyncState.lastSuccessfulAt = now()
```

- `modifiedFrom` orqali **faqat o'zgarganlar** so'raladi — kredit
  tejaladi ([03 §3](03-BEDS24-API-INTEGRATSIYA.md)).
- Bu **asosiy oqim emas**, faqat "tutib olish" mexanizmi. Asosiy
  oqim — real-time webhook.
- Webhook butunlay ishlamay qolsa ham, 15 daqiqa ichida barcha
  o'zgarishlar PMS'ga tushadi.

---

## 8.1. Amalga oshirilgan holat (FAZA 14 — bajarildi)

Kod: `backend/src/services/reconciliation.ts` (`pollBookings`),
jadval: `backend/src/queues/scheduler.ts`.

**Kod takrorlanmadi.** Polling har bronni `applyReservation` orqali
o'tkazadi — webhook worker'i ham aynan shuni chaqiradi. Shuning
uchun dedup, xona biriktirish, to'lov sinxronizatsiyasi va echo
himoyasi ikkala yo'lda bir xil ishlaydi. Buning uchun
`applyReservation` private'dan eksportga chiqarildi.

**`SyncState` vaqtni eslab qoladi** (`bookings_pull` kaliti).
Vaqt so'rov YUBORILGAN paytda olinadi, javob kelganda emas — aks
holda so'rov davomida o'zgargan bron ikki yurish orasiga tushib
qolardi. Ustiga 2 daqiqa orqaga suriladi: chegarada turgan bron
o'tkazib yuborilmasligi uchun.

**Faqat muvaffaqiyatli yurishdan keyin belgilanadi.** Xato bo'lsa
keyingi safar o'sha oraliq qayta so'raladi — ma'lumot yo'qolmaydi.

**Jadval:** har `POLL_INTERVAL_MINUTES` (default 15) daqiqada.
Qo'lda: `POST /api/admin/maintenance/poll`.

**Tekshirilgan:** mock'ga bron webhook YUBORMASDAN qo'shildi
(`/control/add-booking-silently`) — PMS bilmadi; polling ishga
tushgach bron PMS'ga tushdi. Ikkinchi polling dublikat yaratmadi.

---

## 9. Webhook validatsiyasi (TZ 10, 18-band)

TZ 10-band birinchi qadam sifatida "validate" ni, 18-band esa
"webhook validation" ni talab qiladi.

```
1-variant (afzal):  Beds24 signature/secret bersa — HMAC tekshiruvi
2-variant (zaxira): IP whitelist + URL ichida maxfiy token
                    POST /api/webhooks/beds24/<uzun-tasodifiy-token>
```

Qaysi biri ishlatilishi **FAZA 6** da aniqlanadi — Beds24 hisobi
sozlamalari ko'rilgandan keyin. Ikkala holatda ham:

- Endpoint `express-rate-limit` bilan himoyalanadi (TZ 18-band)
- Validatsiyadan o'tmagan so'rov ham `WebhookEvent` ga yoziladi
  (`status = FAILED`) — hujum urinishlarini ko'rish uchun
- Tokenlar hech qachon log qilinmaydi ([10 §2](10-SECURITY-VA-SYNCLOG.md))
